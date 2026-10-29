/*
 * 連絡帳とダッシュボードの細部（モック。GitHub Issue #268）
 * 典拠：詳細設計書「足す表」(5-2) の決めたこと D-40（版は書くたびに必ず進める）・「誰が直したかの表示」(4-7 (4))（D-28）・
 *      図/画面詳細図「職員ダッシュボード」(2-6) 項目2・8・「連絡帳画面（保護者）」(8-3) 項目4・「保護者ホーム」(2-7)
 *
 * Go の同じ観点は server/api_contact_detail_test.go・api_contact_month_test.go にある。
 * web のテストの時計は今日の 18:00（tests/setup-clock.ts）で止まるため、同じ秒の送り直しがそのまま起きる。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { addDays, today } from '../src/api/util';
import { MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const taroGuardian = user(6, '3', { guardian_id: 'G001' });
const adminName = () => db.staff.find((s) => s.staff_id === 'S001')!.staff_name;

describe('版は書くたびに必ず進む（同じ秒のうちの送り直しでも。D-40）', () => {
  it('保護者が版Aのあと版Bで送り直したら、版Aでの「確認しました」は通らない', async () => {
    // mockDb は同じファイルのテストで使い回すため、今日の C001 の家庭からを外してから始める
    for (let i = db.contactHomes.length - 1; i >= 0; i--) {
      if (db.contactHomes[i].child_id === 'C001' && db.contactHomes[i].contact_date === today()) db.contactHomes.splice(i, 1);
    }
    const a = await api.saveHome(taroGuardian, 'C001', { temperature: 36.5, message: '版A', updated_at: null });
    const b = await api.saveHome(taroGuardian, 'C001', { temperature: 38.9, message: '版B', updated_at: a.updated_at });
    expect(b.updated_at).not.toBe(a.updated_at);
    await expect(api.confirmHome(teacher, a.contact_home_id, a.updated_at)).rejects.toThrow(MSG.confirmConflict);
    const confirmed = await api.confirmHome(teacher, a.contact_home_id, b.updated_at);
    expect(confirmed.confirmed_at).not.toBeNull();
    expect(confirmed.updated_at).not.toBe(b.updated_at);
  });

  it('訂正のたびに版が変わり、読み直していない版での訂正は通らない', async () => {
    const [meal] = (await api.recordEvents(teacher, [{ child_id: 'C002', event_type: '1', meal_kind: '2', meal_amount: '1', meal_round: 2 }])).events;
    const one = await api.correctEvent(teacher, meal.contact_event_id, { meal_amount: '3', updated_at: meal.updated_at! });
    expect(one.updated_at).not.toBe(meal.updated_at);
    await expect(api.correctEvent(teacher, meal.contact_event_id, { meal_amount: '2', updated_at: meal.updated_at! })).rejects.toThrow(MSG.fixConflict);
    const two = await api.correctEvent(teacher, meal.contact_event_id, { meal_amount: '2', updated_at: one.updated_at! });
    expect(two.updated_at).not.toBe(one.updated_at);
  });
});

describe('職員の画面には直した職員と時刻を出す（last_change。保護者には出さない。D-28）', () => {
  it('記録した職員とは別の人が直しても、記録した職員はそのまま、直した職員が付く', async () => {
    const [toilet] = (await api.recordEvents(teacher, [{ child_id: 'C001', event_type: '2', toilet_label: 'おしっこ' }])).events;
    const pageOf = async (who: SessionUser) => (await api.contactPage(who, 'C001')).events.find((e) => e.contact_event_id === toilet.contact_event_id)!;
    expect((await pageOf(teacher)).last_change ?? null).toBeNull();

    await api.correctEvent(admin, toilet.contact_event_id, { toilet_label: 'うんち', updated_at: toilet.updated_at! });
    const staffView = await pageOf(teacher);
    expect(staffView.staff_name).toBe('鈴木 浩之');
    expect(staffView.last_change?.staff_name).toBe(adminName());
    expect(staffView.last_change?.at).toBe(staffView.corrected_at);

    const guardianView = await pageOf(taroGuardian);
    expect(guardianView.last_change).toBeUndefined();
    expect(guardianView.staff_name).toBeUndefined();
  });

  it('「成長の記録に残す」の付け外しは、直したことに数えない', async () => {
    const [toilet] = (await api.recordEvents(teacher, [{ child_id: 'C002', event_type: '2', toilet_label: 'おしっこ' }])).events;
    const fixed = await api.correctEvent(admin, toilet.contact_event_id, { toilet_label: 'うんち', updated_at: toilet.updated_at! });
    await api.keepInGrowth(teacher, toilet.contact_event_id, true, fixed.updated_at!);
    const view = (await api.contactPage(teacher, 'C002')).events.find((e) => e.contact_event_id === toilet.contact_event_id)!;
    expect(view.last_change?.staff_name).toBe(adminName());
  });
});

describe('保護者ホームの写真の行には、添えた文を出す', () => {
  it('文があれば文、なければ「写真」', async () => {
    // 写真の出来事を直接足す（写真の送信は contactPhoto.test.ts が見る。ここは行の文だけ）
    const at = `${today()}T17:30:00`;
    const row = {
      contact_event_id: 90001, child_id: 'C001', class_id: 1, contact_date: today(), event_type: '5', recorded_at: at,
      meal_kind: null, meal_amount: null, toilet_label: null, temperature: null, body: '砂場でお山を作りました',
      contact_photo_id: 1, keep_in_growth: false, staff_id: 'S003', corrected_at: null, is_deleted: false, created_at: at, updated_at: at,
    };
    db.contactEvents.push(row as never);
    try {
      const photoText = async () => {
        const rows = await api.guardianHome(taroGuardian);
        return rows.find((r) => r.child.child_id === 'C001')!.today!.latest.find((i) => i.kind === 'photo')?.text;
      };
      expect(await photoText()).toBe('砂場でお山を作りました');
      row.body = null;
      expect(await photoText()).toBe('写真');
    } finally {
      db.contactEvents.splice(db.contactEvents.findIndex((e) => e.contact_event_id === 90001), 1);
    }
  });
});

describe('連絡帳の月の一覧', () => {
  it('日ごとに「家庭から」「園から」の有無と、きょうのようすの件数を出す。今日より後の日は出さない', async () => {
    await api.recordEvents(teacher, [{ child_id: 'C004', event_type: '2', toilet_label: 'おしっこ' }]);
    const month = await api.contactMonth(teacher, 'C004');
    expect(month.month).toBe(today().slice(0, 7));
    expect(month.to_month).toBe(today().slice(0, 7));
    expect(month.days.at(-1)!.date).toBe(today());
    const t = month.days.find((d) => d.date === today())!;
    expect(t.has_records).toBe(true);
    expect(t.record_count).toBeGreaterThan(0);
    // 職員の応答には「新しい」を付けない
    expect(t.unread).toBeUndefined();
  });

  it('保護者の応答は「新しい」を付け、開くと消える。ほかの家庭・今月より先は断る', async () => {
    const day = today();
    await api.recordEvents(teacher, [{ child_id: 'C001', event_type: '2', toilet_label: 'うんち' }]);
    expect((await api.contactMonth(taroGuardian, 'C001')).days.find((d) => d.date === day)!.unread).toBe(true);
    await api.markContactRead(taroGuardian, 'C001', day);
    // 開いた時刻は止まった時計の今と同じなので、記録のあとに開いたことになる（新しいものは無い）
    expect((await api.contactMonth(taroGuardian, 'C001')).days.find((d) => d.date === day)!.unread).toBeUndefined();
    await expect(api.contactMonth(taroGuardian, 'C004')).rejects.toThrow(MSG.contactForbidden);
    const next = addDays(day, 40).slice(0, 7);
    await expect(api.contactMonth(taroGuardian, 'C001', next)).rejects.toThrow(MSG.contactBadDate);
    await expect(api.contactMonth(taroGuardian, 'C001', '2026-13')).rejects.toThrow(MSG.contactBadDate);
  });

  it('前の月へ移れる範囲は、記録のある最初の月から今月まで（見ている月がそれより前なら、その月から）', async () => {
    const month = await api.contactMonth(taroGuardian, 'C001');
    expect(month.from_month <= month.to_month).toBe(true);
    const earlier = await api.contactMonth(taroGuardian, 'C001', '2020-01');
    expect(earlier.days.length).toBe(31);
    expect(earlier.from_month).toBe('2020-01');
  });
});

describe('職員ダッシュボード：差し戻された日誌は一般にのみ、承認待ちの「うち自分の申請」は管理者にのみ', () => {
  it('管理者には差し戻された日誌を数えない（自分が書いて差し戻されたものがあっても）', async () => {
    const d = db.diaries.find((x) => !x.is_deleted && x.status === '4');
    expect(d).toBeTruthy();
    const saved = d!.created_staff_id;
    d!.created_staff_id = 'S001';
    try {
      expect((await api.staffSummary(admin)).returned).toBe(0);
    } finally {
      d!.created_staff_id = saved;
    }
  });

  it('承認待ちのうち自分が申請したものの数を、管理者にだけ返す', async () => {
    const d = db.diaries.find((x) => !x.is_deleted && x.status === '2');
    expect(d).toBeTruthy();
    const saved = d!.applied_staff_id;
    d!.applied_staff_id = 'S003';
    const before = (await api.staffSummary(admin)).pendingOwn;
    d!.applied_staff_id = 'S001';
    try {
      const s = await api.staffSummary(admin);
      expect(s.pendingOwn).toBe(before + 1);
      expect(s.pendingOwn).toBeLessThanOrEqual(s.pending);
      expect((await api.staffSummary(teacher)).pendingOwn).toBe(0);
    } finally {
      d!.applied_staff_id = saved;
    }
  });
});
