/*
 * きょうのようすの記録（食事・排せつ・体温）と、訂正・取り消し（モック）
 * 典拠：詳細設計書「きょうのようす」(4-4 (1))・「訂正・取り消し」(4-7)・「午睡」(4-6 (4))・「テストの観点」(9-1)・
 *      「2か所の規則をそろえる」(9-2)、基本設計書「取り消し・訂正」(4-2)
 *
 * Go の同じ観点は server/api_contact_events_test.go にある。訂正できる人の表（fixCases）は同じ行にする。
 * web のテストの時計は今日の 18:00（SUKUSUKU_TEST_CLOCK で変えられる）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { api, connectLive } from '../src/api/client';
import { canFixContact } from '../src/api/mock';
import { subscribeLive } from '../src/live';
import type { LiveSignal } from '../src/live';
import * as db from '../src/api/mockDb';
import { addDays, now, today } from '../src/api/util';
import { MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';
import type { ContactEventInput } from '../src/api/shapes';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});

// デモデータの人物（mockDb.ts。server/seed.sql と同じ）
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const otherTeacher = user(5, '2', { staff_id: 'S005', class_id: 2, class_name: 'ひまわり組' });
const taroGuardian = user(6, '3', { guardian_id: 'G001' });
const misakiGuardian = user(9, '3', { guardian_id: 'G004' });

const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach((s) => s()); });
function watch(viewer: SessionUser): LiveSignal[] {
  const got: LiveSignal[] = [];
  stops.push(connectLive(viewer.account_id));
  stops.push(subscribeLive((s) => got.push(s)));
  return got;
}

const toilet = (child: string, label = 'おしっこ', recorded_at?: string): ContactEventInput =>
  ({ child_id: child, event_type: '2', toilet_label: label, ...(recorded_at ? { recorded_at } : {}) });
const temperature = (child: string, value: number): ContactEventInput => ({ child_id: child, event_type: '3', temperature: value });
const snack = (child: string, round: 1 | 2 = 1): ContactEventInput =>
  ({ child_id: child, event_type: '1', meal_kind: '2', meal_amount: '1', meal_round: round });
/** mockDb は同じファイルのテストで使い回すため、その子の今日のおやつの記録を外しておく */
function clearSnacks(child: string): void {
  for (const e of db.contactEvents) if (e.child_id === child && e.contact_date === today() && e.meal_kind === '2') e.is_deleted = true;
}

describe('きょうのようすを記録する（詳細設計書 (4-4 (1))）', () => {
  it('検査に当たれば止め、1件でも誤りがあれば何も保存しない', async () => {
    const many = Array.from({ length: 51 }, () => toilet('C001'));
    const cases: [ContactEventInput[], string][] = [
      [[], MSG.badRequest],
      [many, MSG.badRequest],
      [[{ child_id: 'C001', event_type: '1', meal_kind: '1' }], MSG.badChoice],
      [[{ child_id: 'C001', event_type: '1', meal_kind: '1', meal_amount: '1', meal_round: 3 as 1 }], MSG.badChoice],
      [[toilet('C001', 'おもらし')], MSG.badChoice],
      [[temperature('C001', 36.55)], MSG.temperatureFormat],
      [[toilet('C001', 'おしっこ', `${addDays(today(), 1)}T00:00:00`)], MSG.eventTimeRange],
      [[toilet('C001', 'おしっこ', `${addDays(today(), -1)}T23:59:00`)], MSG.eventTimeRange],
      [[{ child_id: 'C001', event_type: '5' }], MSG.badChoice],
    ];
    for (const [items, message] of cases) {
      await expect(api.recordEvents(teacher, items)).rejects.toThrow(message);
    }
    await expect(api.recordEvents(otherTeacher, [toilet('C001')])).rejects.toThrow(MSG.contactForbidden);
    await expect(api.recordEvents(taroGuardian, [toilet('C001')])).rejects.toThrow();
    await expect(api.recordEvents(teacher, [toilet('C999')])).rejects.toThrow(MSG.contactForbidden);
    const before = db.contactEvents.length;
    await expect(api.recordEvents(teacher, [toilet('C001', 'うんち'), temperature('C002', 36.55)])).rejects.toThrow();
    expect(db.contactEvents.length).toBe(before);
  });

  it('記録した時点で保護者のページに入る。範囲の外の体温も保存する（判定しない）。保護者には職員の名前・版を返さない', async () => {
    const at = `${today()}T00:00:00`;
    const got = await api.recordEvents(teacher, [toilet('C001', 'うんち', at), temperature('C001', 29.5), temperature('C001', 43.5)]);
    expect(got.events).toHaveLength(3);
    expect(got.events[0].recorded_at).toBe(at);
    expect(got.events[0].staff_name).toBe('鈴木 浩之');
    const page = await api.contactPage(taroGuardian, 'C001');
    const ids = got.events.map((e) => e.contact_event_id);
    const mine = page.events.filter((e) => ids.includes(e.contact_event_id));
    expect(mine.map((e) => e.temperature ?? e.toilet_label)).toEqual(['うんち', 29.5, 43.5]);
    expect(JSON.stringify(page)).not.toMatch(/staff_name|updated_at|鈴木/);
  });

  it('食事の回：その回の記録がある子は飛ばす（全員ぜんぶで上書きしない）。おやつの2回目は入る', async () => {
    clearSnacks('C003'); clearSnacks('C004');
    expect((await api.recordEvents(teacher, [snack('C003')])).events).toHaveLength(1);
    const bulk = await api.recordEvents(teacher, [snack('C003'), snack('C004')]);
    expect(bulk.events.map((e) => e.child_id)).toEqual(['C004']);
    expect(bulk.skipped).toEqual(['C003']);
    expect((await api.recordEvents(teacher, [snack('C003', 2)])).events).toHaveLength(1);
    const twice = await api.recordEvents(teacher, [snack('C003', 2)]);
    expect([twice.events.length, twice.skipped]).toEqual([0, ['C003']]);
  });

  it('知らせは記録した園児の家庭にだけ届き、ほかの家庭には届かない。全員ぜんぶでも園児ごとに1回', async () => {
    const misaki = watch(misakiGuardian);
    await api.recordEvents(teacher, [toilet('C001'), temperature('C001', 36.6)]);
    expect(misaki).toEqual([]);
    stops.splice(0).forEach((s) => s());
    const taro = watch(taroGuardian);
    await api.recordEvents(teacher, [toilet('C001'), temperature('C001', 36.6)]);
    expect(taro).toEqual([{ type: 'contact', child_id: 'C001' }]);
    taro.splice(0);
    await api.recordEvents(teacher, [snack('C005'), snack('C004')]);
    expect(taro).toEqual([]);
  });

  it('保護者に排せつを出さない設定の園では、排せつの知らせもページにも出さない', async () => {
    const setting = db.settings.find((s) => s.setting_key === 'contact.show_items')!;
    const original = setting.setting_value;
    setting.setting_value = 'nap,meal,temperature,comment,photo,class';
    try {
      const taro = watch(taroGuardian);
      await api.recordEvents(teacher, [toilet('C001')]);
      expect(taro).toEqual([]);
      expect((await api.contactPage(taroGuardian, 'C001')).events.some((e) => e.event_type === '2')).toBe(false);
    } finally {
      setting.setting_value = original;
    }
  });
});

/** server/api_contact_events_test.go の fixCases と同じ行（記録は管理者が付けたもの） */
const fixCases: [name: string, who: SessionUser, pastDay: boolean, free: boolean, ok: boolean][] = [
  ['記録した職員でなくても、その日はクラスの担任が直せる', teacher, false, false, true],
  ['管理者はその日に直せる', admin, false, false, true],
  ['管理者は翌日以降も直せる', admin, true, false, true],
  ['担任でも翌日以降は直せない', teacher, true, false, false],
  ['ほかのクラスの担任は読めない（無い記録と同じ）', otherTeacher, false, false, false],
  ['フリーの職員は読めるが直せない', otherTeacher, false, true, false],
  ['保護者は直せない', taroGuardian, false, false, false],
];

describe('訂正・取り消しできる人（基本設計書「取り消し・訂正」(4-2)、詳細設計書 (3-5)）', () => {
  it.each(fixCases)('%s', async (_name, who, pastDay, free, ok) => {
    clearSnacks('C001');
    const { events: [e] } = await api.recordEvents(admin, [snack('C001')]);
    const row = db.contactEvents.find((x) => x.contact_event_id === e.contact_event_id)!;
    if (pastDay) { row.contact_date = addDays(today(), -1); row.recorded_at = `${row.contact_date}T15:00:00`; }
    const staff = free ? db.classStaff.splice(db.classStaff.findIndex((s) => s.staff_id === 'S005'), 1) : [];
    try {
      expect(canFixContact(who, 'C001', row.contact_date)).toBe(ok);
      const correct = api.correctEvent(who, e.contact_event_id, { meal_amount: '3', updated_at: e.updated_at! });
      if (ok) {
        await expect(correct).resolves.toBeTruthy();
        await expect(api.cancelEvent(who, e.contact_event_id)).resolves.toEqual({ ok: true, read_family_count: expect.any(Number) });
      } else {
        await expect(correct).rejects.toThrow();
        await expect(api.cancelEvent(who, e.contact_event_id)).rejects.toThrow();
        if (who === teacher || free) await expect(correct).rejects.toThrow(MSG.fixForbidden);
      }
    } finally {
      db.classStaff.push(...staff);
    }
  });
});

describe('訂正・取り消し（詳細設計書 (4-7)）', () => {
  it('訂正すると保護者に訂正の印が出る。取り消すと保護者のページから消え、もう直せない。読んだ版が古ければ拒む', async () => {
    clearSnacks('C001');
    const { events: [meal, wc, temp] } = await api.recordEvents(teacher, [snack('C001'), toilet('C001'), temperature('C001', 36.6)]);
    await expect(api.correctEvent(teacher, meal.contact_event_id, { meal_amount: '3', updated_at: '2000-01-01T00:00:00' })).rejects.toThrow(MSG.fixConflict);
    await expect(api.correctEvent(teacher, meal.contact_event_id, { meal_amount: '9' as '1', updated_at: meal.updated_at! })).rejects.toThrow(MSG.badChoice);
    await expect(api.correctEvent(teacher, meal.contact_event_id, { updated_at: meal.updated_at! })).rejects.toThrow(MSG.badChoice);
    await expect(api.correctEvent(teacher, temp.contact_event_id, { temperature: 36.66, updated_at: temp.updated_at! })).rejects.toThrow(MSG.temperatureFormat);
    await expect(api.correctEvent(teacher, wc.contact_event_id, { recorded_at: `${addDays(today(), 1)}T08:00:00`, updated_at: wc.updated_at! }))
      .rejects.toThrow(MSG.eventTimeRange);

    const fixed = await api.correctEvent(teacher, meal.contact_event_id, { meal_amount: '3', updated_at: meal.updated_at! });
    expect([fixed.meal_amount, fixed.corrected_at !== null]).toEqual(['3', true]);
    const log = db.operationLogs.find((l) => l.target_table === 't_contact_event' && l.target_id === meal.contact_event_id && l.operation_type === '2')!;
    expect([log.before_value, log.after_value]).toEqual(['{"meal_amount":"1"}', '{"meal_amount":"3"}']);
    const shown = (await api.contactPage(taroGuardian, 'C001')).events.find((e) => e.contact_event_id === meal.contact_event_id)!;
    expect(shown.corrected_at).not.toBeNull();

    // 取り消しの確認に出す数：記録のあとにそのページを開いた家庭
    expect(await api.eventReaders(teacher, temp.contact_event_id)).toEqual({ family_count: 0, guardian_count: 0 });
    await api.markContactRead(taroGuardian, 'C001', today());
    expect(await api.eventReaders(teacher, temp.contact_event_id)).toEqual({ family_count: 1, guardian_count: 1 });
    await expect(api.eventReaders(otherTeacher, temp.contact_event_id)).rejects.toThrow(MSG.contactForbidden);
    expect(await api.cancelEvent(teacher, temp.contact_event_id)).toEqual({ ok: true, read_family_count: 1 });
    const page = await api.contactPage(taroGuardian, 'C001');
    expect(page.events.some((e) => e.contact_event_id === temp.contact_event_id)).toBe(false);
    const home = (await api.guardianHome(taroGuardian))[0].today;
    expect(home.latest.some((i) => i.kind === 'temperature' && i.recorded_at === temp.recorded_at && i.text === '36.6℃')).toBe(false);
    await expect(api.cancelEvent(teacher, temp.contact_event_id)).rejects.toThrow(MSG.contactForbidden);
    expect(db.operationLogs.find((l) => l.target_id === temp.contact_event_id && l.operation_type === '4')?.before_value).toContain('"temperature":36.6');
    // 時刻を後から付けた記録は、保存した時刻より前に開いた家庭を「読んでいる」に数えない
    const { events: [back] } = await api.recordEvents(teacher, [toilet('C001', 'おしっこ', `${today()}T00:00:00`)]);
    const read = db.contactReads.find((r) => r.child_id === 'C001' && r.account_id === 6 && r.contact_date === today())!;
    read.read_at = `${today()}T00:00:01`;
    expect((await api.eventReaders(teacher, back.contact_event_id)).family_count).toBe(0);
  });

  it('職員のページは書けるかを返し、出来事に読んだ版を添える。保護者には返さない', async () => {
    const staff = await api.contactPage(teacher, 'C001');
    expect(staff.can_write).toBe(true);
    expect((await api.contactPage(admin, 'C013')).can_write).toBe(true);
    const guardian = await api.contactPage(taroGuardian, 'C001');
    expect(guardian.can_write).toBeUndefined();
    expect(staff.events.every((e) => typeof e.updated_at === 'string')).toBe(true);
  });
});

describe('ねた・おきたの訂正・取り消し（詳細設計書 (4-6 (4))）', () => {
  it('実施の後も、人が「おきた」を入れられる。ねたより前のおきた・先の時刻は拒む。翌日以降は管理者だけ', async () => {
    const active = await api.activeSession(1, today(), admin);
    if (active) await api.endSession(admin, active.nap_session_id);
    const s = await api.startSession(teacher, 1, today());
    const slept = await api.sleep(teacher, s.nap_session_id, 'C001');
    await api.endSession(teacher, s.nap_session_id);
    const row = db.napSleeps.find((x) => x.nap_sleep_id === slept.nap_sleep_id)!;
    const start = `${today()}T00:00:00`;
    row.slept_at = start; row.updated_at = start;
    const taro = watch(taroGuardian);

    await expect(api.correctSleep(otherTeacher, row.nap_sleep_id, { woke_at: now(), updated_at: start })).rejects.toThrow(MSG.contactForbidden);
    await expect(api.correctSleep(teacher, row.nap_sleep_id, { woke_at: start, updated_at: start })).rejects.toThrow(MSG.wakeBeforeSleep);
    await expect(api.correctSleep(teacher, row.nap_sleep_id, { woke_at: `${addDays(today(), 1)}T00:00:00`, updated_at: start })).rejects.toThrow(MSG.eventTimeRange);
    await expect(api.correctSleep(teacher, row.nap_sleep_id, { woke_at: now(), updated_at: '2000-01-01T00:00:00' })).rejects.toThrow(MSG.fixConflict);

    const woke = now();
    const fixed = await api.correctSleep(teacher, row.nap_sleep_id, { woke_at: woke, updated_at: start });
    expect([fixed.woke_at, fixed.corrected_at !== null, row.woke_staff_id]).toEqual([woke, true, 'S003']);
    expect(taro).toEqual([{ type: 'contact', child_id: 'C001' }]);
    const page = await api.contactPage(taroGuardian, 'C001');
    expect(page.sleeps.find((x) => x.nap_sleep_id === row.nap_sleep_id)?.woke_at).toBe(woke);

    const session = db.napSessions.find((x) => x.nap_session_id === s.nap_session_id)!;
    session.session_date = addDays(today(), -1);
    try {
      await expect(api.cancelSleep(teacher, row.nap_sleep_id)).rejects.toThrow(MSG.fixForbidden);
    } finally {
      session.session_date = today();
    }
    expect((await api.cancelSleep(admin, row.nap_sleep_id)).ok).toBe(true);
    expect((await api.contactPage(taroGuardian, 'C001')).sleeps.some((x) => x.nap_sleep_id === row.nap_sleep_id)).toBe(false);
  });
});
