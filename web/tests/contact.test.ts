/*
 * 連絡帳の判定・1ページ・家庭から→確認しました・ねた・おきた（モック）
 * 典拠：詳細設計書「テストの観点」(9-1)・「2か所の規則をそろえる」(9-2)・「時計」(9-3)
 *
 * Go の同じ観点は server/api_contact_test.go・db_contact_test.go にある。判定の表（contactAccessCases）は同じ行にする。
 * web のテストの時計は今日の 18:00（SUKUSUKU_TEST_CLOCK で変えられる）。デモデータの今日の記録は 17:20 までに置いてある。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import { contactAccess, classContactAccess } from '../src/api/mock';
import * as db from '../src/api/mockDb';
import { now, today, addDays } from '../src/api/util';
import { MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';
import type { ContactHomeInput } from '../src/api/shapes';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});

// デモデータの人物（mockDb.ts。server/seed.sql と同じ）
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' }); // さくら組の担任 高梨
const otherTeacher = user(5, '2', { staff_id: 'S005', class_id: 2, class_name: 'ひまわり組' });
const taroGuardian = user(6, '3', { guardian_id: 'G001' }); // 野原 太郎（C001）の父
const misakiGuardian = user(9, '3', { guardian_id: 'G004' }); // 宮城 美咲（C004）の父
const endedGuardian = user(8, '3', { guardian_id: 'G003' }); // 高梨 健（C003）との紐づけを終えた

/** server/api_contact_test.go の contactAccessCases と同じ行 */
const contactAccessCases: [name: string, who: SessionUser, child: string, read: boolean, write: boolean][] = [
  ['管理者は全園児', admin, 'C001', true, true],
  ['管理者はほかのクラスの園児も', admin, 'C013', true, true],
  ['管理者でも無い園児は読めない', admin, 'C999', false, false],
  ['さくら組の担任は自クラスの園児', teacher, 'C001', true, true],
  ['さくら組の担任はひまわり組の園児を読めない', teacher, 'C013', false, false],
  ['ひまわり組の担任はさくら組の園児を読めない', otherTeacher, 'C001', false, false],
  ['保護者は有効な紐づけの自児', taroGuardian, 'C001', true, true],
  ['保護者はほかの家庭の園児を読めない', taroGuardian, 'C004', false, false],
  ['ほかの家庭の保護者は野原 太郎を読めない', misakiGuardian, 'C001', false, false],
  ['紐づけを終えた保護者は読めない', endedGuardian, 'C003', false, false],
];

const emptyHome: ContactHomeInput = {
  temperature: null, night_sleep_from: null, night_sleep_to: null, breakfast: null, mood_label: null,
  pickup_type: null, pickup_person: null, pickup_time: null, message: null, updated_at: null,
};

/** その日の実施を新しく始める（デモの実施中の午睡は時刻によって自動で終わるため、終えてから始める） */
async function freshSession(classId = 1): Promise<number> {
  const s = await api.activeSession(classId, today(), admin);
  if (s) await api.endSession(admin, s.nap_session_id);
  return (await api.startSession(classId === 1 ? teacher : otherTeacher, classId, today())).nap_session_id;
}

describe('判定の関数（詳細設計書「判定の関数」(4-1 (2))）', () => {
  it.each(contactAccessCases)('%s', (_name, who, child, read, write) => {
    expect(contactAccess(who, child)).toEqual({ read, write });
  });

  it('猶予中は読めるが書けない。フリーの職員は読めるが書けない', () => {
    const link = db.guardianChildren.find((g) => g.guardian_id === 'G005' && g.child_id === 'C005')!;
    const staff = db.classStaff.splice(db.classStaff.findIndex((s) => s.staff_id === 'S005'), 1);
    try {
      link.link_status = '3';
      expect(contactAccess(user(10, '3', { guardian_id: 'G005' }), 'C005')).toEqual({ read: true, write: false });
      const free = user(5, '2', { staff_id: 'S005', class_id: null });
      expect(contactAccess(free, 'C001')).toEqual({ read: true, write: false });
      expect(classContactAccess(free, 1)).toEqual({ read: true, write: false });
    } finally {
      link.link_status = '1';
      db.classStaff.push(...staff);
    }
  });
});

describe('デモデータ（詳細設計書「デモデータ」(5-5)）', () => {
  it('野原 太郎の今日は家庭から・ねた・園からを空け、ほかを入れる。起動した時刻より後の記録は入れない', async () => {
    const page = await api.contactPage(taroGuardian, 'C001');
    expect(page.home).toBeNull();
    expect(page.sleeps).toEqual([]);
    expect(page.facility).toBeNull();
    for (const e of page.events) expect(e.recorded_at <= now()).toBe(true);
    for (const c of page.class_notes) expect(c.recorded_at <= now()).toBe(true);
    if (now().slice(11) >= '11:40:00') expect(page.events.map((e) => e.event_type)).toEqual(['2', '4', '1']);
    // 昨日は家庭から（確認済み）・おひるね・園からがある
    const yesterday = await api.contactPage(taroGuardian, 'C001', addDays(today(), -1));
    expect(yesterday.home?.confirmed_at).toBeTruthy();
    expect(yesterday.sleeps[0]?.woke_at).toBeTruthy();
    expect(yesterday.facility?.body).toContain('しゃぼん玉');
  });

  it('さくら組の家庭からは、確認済み・未確認・更新が1つずつ（時刻が来ていれば）', async () => {
    const view = await api.contactClass(teacher, 1);
    const state = (id: string) => view.rows.find((r) => r.child.child_id === id)?.home_state;
    if (now().slice(11) >= '08:52:00') {
      expect([state('C004'), state('C005'), state('C002')]).toEqual(['confirmed', 'unconfirmed', 'revised']);
      expect(view.rows.find((r) => r.child.child_id === 'C003')?.exclusion?.reason ?? '1').toBe('1');
    }
    expect(view.family_count + view.unregistered_count).toBe(view.rows.length);
  });
});

describe('連絡帳の1ページ（詳細設計書 (4-3 (1))）', () => {
  it('ほかの家庭・無い園児は同じ文言で拒む。保護者の応答に段3（監査の層・職員の名前）が入らない', async () => {
    await expect(api.contactPage(misakiGuardian, 'C001')).rejects.toThrow(MSG.contactForbidden);
    await expect(api.contactPage(taroGuardian, 'C999')).rejects.toThrow(MSG.contactForbidden);
    await expect(api.contactPage(taroGuardian, 'C001', addDays(today(), 1))).rejects.toThrow(MSG.contactBadDate);
    await expect(api.contactClass(taroGuardian as never, 1)).rejects.toThrow();

    const sessionId = await freshSession();
    const slept = await api.sleep(teacher, sessionId, 'C001');
    db.napSleeps.find((s) => s.nap_sleep_id === slept.nap_sleep_id)!.sleep_temperature = 36.7;
    const page = await api.contactPage(taroGuardian, 'C001');
    const text = JSON.stringify(page);
    for (const hidden of ['sleep_temperature', 'nap_session_id', 'staff_name', 'guardian_name', 'confirmed_staff_name', 'source_diary_id', '36.7']) {
      expect(text).not.toContain(hidden);
    }
    expect(page.sleeps).toHaveLength(1);
    expect(page.can_write_home).toBe(true);
    expect('last_read_at' in page).toBe(true);
    const staffPage = await api.contactPage(teacher, 'C001');
    expect(staffPage.sleeps[0].sleep_temperature).toBe(36.7);
    expect('last_read_at' in staffPage).toBe(false);

    // 保護者に出さない設定にした種類は、開いた時点の設定で落とす
    const show = db.settings.find((x) => x.setting_key === 'contact.show_items')!;
    const original = show.setting_value;
    try {
      show.setting_value = 'meal,toilet,temperature,comment,photo,class';
      expect((await api.contactPage(taroGuardian, 'C001')).sleeps).toEqual([]);
    } finally {
      show.setting_value = original;
    }
    await api.endSession(teacher, sessionId);
  });
});

describe('家庭から→確認しました（詳細設計書「家庭から」(3-1)）', () => {
  it('検査で止め、送る→未確認→確認済み→送り直して更新。ダッシュボードの数が合う', async () => {
    const send = (input: Partial<ContactHomeInput>) => api.saveHome(taroGuardian, 'C001', { ...emptyHome, ...input });
    await expect(send({})).rejects.toThrow(MSG.homeEmpty);
    await expect(send({ message: '   ' })).rejects.toThrow(MSG.homeEmpty);
    await expect(send({ temperature: 36.55 })).rejects.toThrow(MSG.temperatureFormat);
    await expect(send({ night_sleep_from: '21:05' })).rejects.toThrow(MSG.badChoice);
    await expect(send({ mood_label: '元気' })).rejects.toThrow(MSG.badChoice);
    await expect(send({ pickup_type: '2', pickup_person: '祖母' })).rejects.toThrow(MSG.pickupRequired);
    await expect(send({ pickup_type: '2', pickup_person: 'あ'.repeat(51), pickup_time: '17:00' })).rejects.toThrow(MSG.pickupPersonTooLong);
    await expect(send({ message: 'あ'.repeat(501) })).rejects.toThrow(MSG.homeMessageTooLong);
    await expect(api.saveHome(teacher, 'C001', { ...emptyHome, breakfast: '1' })).rejects.toThrow(MSG.contactForbidden);
    await expect(api.saveHome(misakiGuardian, 'C001', { ...emptyHome, breakfast: '1' })).rejects.toThrow(MSG.contactForbidden);

    const before = await api.staffSummary(teacher);
    // 範囲の外の体温も保存する（判定しない）
    const home = await send({ temperature: 43.5, breakfast: '1', mood_label: 'ごきげん', pickup_type: '2', pickup_person: '祖母', pickup_time: '17:30' });
    expect(home.confirmed_at).toBeNull();
    expect(home.revised_at).toBeNull();
    expect('guardian_name' in home).toBe(false);
    const sent = await api.staffSummary(teacher);
    expect([sent.homeUnconfirmed, sent.homeRevised]).toEqual([before.homeUnconfirmed + 1, before.homeRevised]);

    // ほかのクラスの職員・保護者は押せない。読んだ版が古ければ拒む
    await expect(api.confirmHome(otherTeacher, home.contact_home_id, home.updated_at)).rejects.toThrow(MSG.contactForbidden);
    await expect(api.confirmHome(taroGuardian, home.contact_home_id, home.updated_at)).rejects.toThrow(MSG.contactForbidden);
    await expect(api.confirmHome(teacher, home.contact_home_id, '2000-01-01T00:00:00')).rejects.toThrow(MSG.confirmConflict);
    const confirmed = await api.confirmHome(teacher, home.contact_home_id, home.updated_at);
    expect(confirmed.confirmed_at).toBeTruthy();
    expect(confirmed.confirmed_staff_name).toBe('高梨 倫太朗');
    expect(confirmed.guardian_relationship).toBe('父');
    // 二重の確認は書き換えない
    const again = await api.confirmHome(teacher, home.contact_home_id, home.updated_at);
    expect(again.confirmed_at).toBe(confirmed.confirmed_at);
    // 保護者には「園が確認しました（時刻）」。職員の名前は出さない
    const page = await api.contactPage(taroGuardian, 'C001');
    expect(page.home?.confirmed_at).toBe(confirmed.confirmed_at);
    expect(JSON.stringify(page)).not.toContain('高梨');

    // 父母が同時に直したとき（読んだ版が古い）は拒む。送り直すと確認が外れて「更新」
    await expect(send({ breakfast: '2', updated_at: '2000-01-01T00:00:00' })).rejects.toThrow(MSG.homeConflict);
    const revised = await send({ breakfast: '2', pickup_type: '1', updated_at: confirmed.updated_at });
    expect(revised.confirmed_at).toBeNull();
    expect(revised.revised_at).toBeTruthy();
    expect(revised.pickup_time).toBeNull();
    const after = await api.staffSummary(teacher);
    expect([after.homeUnconfirmed, after.homeRevised]).toEqual([before.homeUnconfirmed, before.homeRevised + 1]);
    // 外れた確認（誰が・いつ）は操作ログの before_value に残る
    const logRow = db.operationLogs.find((l) => l.function_type === '8' && l.operation_type === '2' && l.target_id === home.contact_home_id && l.before_value);
    expect(logRow?.before_value).toContain('"confirmed_staff_id":"S003"');
  });

  it('猶予中の保護者は家庭からを送れない', async () => {
    const link = db.guardianChildren.find((g) => g.guardian_id === 'G004' && g.child_id === 'C004')!;
    link.link_status = '3';
    try {
      await expect(api.saveHome(misakiGuardian, 'C004', { ...emptyHome, breakfast: '1' })).rejects.toThrow(MSG.contactGraceReadOnly);
      await expect(api.contactPage(misakiGuardian, 'C004')).resolves.toBeTruthy();
    } finally {
      link.link_status = '1';
    }
  });
});

describe('ねた・おきた（詳細設計書「午睡の園児」(3-4)）', () => {
  it('ねた→保護者のページと保護者ホームの「きょう」に入る→おきた。二重・対象外・終了後は拒む', async () => {
    const sessionId = await freshSession();
    await expect(api.sleep(otherTeacher, sessionId, 'C001')).rejects.toThrow(MSG.contactForbidden);
    await expect(api.sleep(taroGuardian, sessionId, 'C001')).rejects.toThrow();
    await expect(api.sleep(teacher, sessionId, 'C013')).rejects.toThrow(MSG.contactForbidden);
    await expect(api.sleep(teacher, 99999, 'C001')).rejects.toThrow(MSG.napNotStarted);

    await api.markContactRead(taroGuardian, 'C001', today());
    const recordsBefore = db.napRecords.length;
    const slept = await api.sleep(teacher, sessionId, 'C001');
    expect(slept.woke_at).toBeNull();
    await expect(api.sleep(teacher, sessionId, 'C001')).rejects.toThrow(MSG.sleepTwice);
    // 5分ごとの確認は今までどおり同じ実施へ記録できる（監査の記録を弱めない）
    await api.record(teacher, sessionId, { child_id: 'C001', body_position: '1', breathing: '1', complexion: '1', temperature: null });
    expect(db.napRecords.length).toBe(recordsBefore + 1);

    const state = await api.classState(teacher, 1, sessionId);
    const row = state.find((r) => r.child.child_id === 'C001')!;
    expect(row.sleeps).toHaveLength(1);
    expect(row.latest).toBeTruthy();

    const home = (await api.guardianHome(taroGuardian))[0];
    expect(home.today.nap?.slept_at).toBe(slept.slept_at);
    expect(home.today.nap?.woke_at).toBeNull();
    expect(JSON.stringify(home.today)).not.toContain('sleep_temperature');

    await expect(api.wake(otherTeacher, slept.nap_sleep_id)).rejects.toThrow(MSG.contactForbidden);
    const woke = await api.wake(teacher, slept.nap_sleep_id);
    expect(woke.woke_at! > woke.slept_at).toBe(true);
    await expect(api.wake(teacher, slept.nap_sleep_id)).rejects.toThrow(MSG.wokeTwice);
    // おきたのあとは、もう一度ねたを記録できる
    await api.sleep(teacher, sessionId, 'C001');

    // 対象外の子には「ねた」を押せない
    db.napExclusions.push({ nap_exclusion_id: 900, nap_session_id: sessionId, child_id: 'C002', reason: '1', staff_id: 'S003', is_deleted: false, created_at: now() });
    await expect(api.sleep(teacher, sessionId, 'C002')).rejects.toThrow(MSG.sleepExcluded);
    // 実施が終わったあとは拒む
    await api.endSession(teacher, sessionId);
    await expect(api.sleep(teacher, sessionId, 'C004')).rejects.toThrow(MSG.sessionEnded);
    // おきたが無いまま終わった組は、おきたを推測で入れず「ねた（おきた時刻なし）」として返す
    const last = (await api.contactPage(taroGuardian, 'C001')).sleeps.at(-1)!;
    expect([last.woke_at, last.session_ended]).toEqual([null, true]);
    // 操作ログ（午睡・作成／変更）
    expect(db.operationLogs.filter((l) => l.target_table === 't_nap_sleep').length).toBeGreaterThanOrEqual(3);
  });
});

describe('保護者ホームの「きょう」（詳細設計書「ダッシュボード」(4-8 (1))）', () => {
  // server/api_contact_test.go の TestGuardianTodayGrace と同じ観点。紐づけが 1:有効・3:猶予中の自児ごとに1件。
  // 猶予中は家庭からを書けず、読める期限を添える（同「保護者ホーム（「きょう」）」(2-5 (2))）。日誌の共有の範囲は広げない
  it('猶予中の自児も保護者ホームの「きょう」に出す。紐づけを終えた子は出さない', async () => {
    const link = db.guardianChildren.find((g) => g.guardian_id === 'G001' && g.child_id === 'C001')!;
    const child = db.children.find((c) => c.child_id === 'C001')!;
    const saved = { link: { ...link }, enrollment: child.enrollment_status };
    const grace = addDays(today(), 20);
    try {
      child.enrollment_status = '2';
      Object.assign(link, { link_status: '3', grace_ends_on: grace });
      const rows = await api.guardianHome(taroGuardian);
      expect(rows.map((r) => r.child.child_id)).toEqual(['C001']);
      expect([rows[0].today.can_write_home, rows[0].today.grace_ends_on]).toEqual([false, grace]);
      expect(rows[0].sharedDiaries).toEqual([]);

      link.link_status = '2';
      expect(await api.guardianHome(taroGuardian)).toEqual([]);
    } finally {
      Object.assign(link, saved.link);
      child.enrollment_status = saved.enrollment;
    }
  });
});

describe('きょうは対象外（詳細設計書「午睡の園児」(3-4)）', () => {
  it('対象外の子は「ねた」を押せず、戻すと押せる。「ねた」のある子は対象外にできない。保護者には出さない', async () => {
    const sessionId = await freshSession();
    await expect(api.exclude(otherTeacher, sessionId, 'C006', '1')).rejects.toThrow(MSG.contactForbidden);
    await expect(api.exclude(teacher, sessionId, 'C006', '3' as never)).rejects.toThrow(MSG.badChoice);
    const x = await api.exclude(teacher, sessionId, 'C006', '1');
    expect(x.reason).toBe('1');
    await expect(api.exclude(teacher, sessionId, 'C006', '2')).rejects.toThrow(MSG.excludedTwice);
    await expect(api.sleep(teacher, sessionId, 'C006')).rejects.toThrow(MSG.sleepExcluded);
    const state = await api.classState(teacher, 1, sessionId);
    expect(state.find((r) => r.child.child_id === 'C006')?.exclusion?.reason).toBe('1');

    await api.cancelExclusion(teacher, x.nap_exclusion_id);
    await api.sleep(teacher, sessionId, 'C006');
    await expect(api.exclude(teacher, sessionId, 'C006', '1')).rejects.toThrow(MSG.excludeAfterSleep);
    expect(db.operationLogs.filter((l) => l.target_table === 't_nap_exclusion').map((l) => l.operation_type)).toEqual(expect.arrayContaining(['1', '4']));
    await api.endSession(teacher, sessionId);
  });

  // server/api_contact_test.go の TestNapSleepAndExclusionAtOnce と同じ観点。同じ園児に「ねた」と対象外の両方は成り立たず、
  // 負けた側は順に押したときと同じ文を返す（「ねた」が先なら対象外を、対象外が先なら「ねた」を拒む）
  it('ねたと対象外を同時に押しても、どちらか1つだけが通る', async () => {
    const sessionId = await freshSession();
    const count = (childId: string) => [
      db.napSleeps.filter((s) => s.nap_session_id === sessionId && s.child_id === childId && !s.is_deleted).length,
      db.napExclusions.filter((x) => x.nap_session_id === sessionId && x.child_id === childId && !x.is_deleted).length,
    ];

    const [slept, excluded] = await Promise.allSettled([api.sleep(teacher, sessionId, 'C007'), api.exclude(teacher, sessionId, 'C007', '1')]);
    expect(count('C007')).toEqual([1, 0]);
    expect(slept.status).toBe('fulfilled');
    expect(excluded.status === 'rejected' && (excluded.reason as Error).message).toBe(MSG.excludeAfterSleep);

    const [excluded2, slept2] = await Promise.allSettled([api.exclude(teacher, sessionId, 'C008', '1'), api.sleep(teacher, sessionId, 'C008')]);
    expect(count('C008')).toEqual([0, 1]);
    expect(excluded2.status).toBe('fulfilled');
    expect(slept2.status === 'rejected' && (slept2.reason as Error).message).toBe(MSG.sleepExcluded);
    await api.endSession(teacher, sessionId);
  });
});
