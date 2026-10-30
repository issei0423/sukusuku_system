/*
 * 日誌ときょうのようす（連絡帳）のつながり、日誌一覧の絞り込み（GitHub Issue #278 の 2・4）
 * 典拠：基本設計書「きょうのようすから個人日誌の下書きへ」(4-6)・「取り消し・訂正」(4-5)、
 *      詳細設計書「日誌の画面（作り直し）」(2-13 (4)(5))・「日誌」(4-13 (6)(7)(8))
 * Go サーバ（server/api_diary_contact_test.go）と同じ規則。片方だけを直すと食い違う
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { addDays, now, plusMinutes, today } from '../src/api/util';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'nohara@example.jp', role: '3', display_name: '野原 一郎',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

let seq = 9000;
function addMeal(date: string, at: string, kind: '1' | '2', amount: '1' | '2' | '3' | '4', v: Partial<(typeof db.contactEvents)[number]> = {}) {
  db.contactEvents.push({
    contact_event_id: ++seq, child_id: 'C004', class_id: 1, contact_date: date, recorded_at: at, event_type: '1',
    meal_kind: kind, meal_amount: amount, toilet_label: null, temperature: null, body: null, contact_photo_id: null,
    keep_in_growth: false, staff_id: 'S003', corrected_at: null, is_deleted: false, created_at: at, updated_at: at, ...v,
  });
}
function addNap(date: string, slept: string, woke: string | null, v: Record<string, unknown> = {}) {
  const sid = ++seq;
  db.napSessions.push({ nap_session_id: sid, class_id: 1, session_date: date, started_staff_id: 'S003', started_at: slept,
    ended_staff_id: null, ended_at: null, is_auto_closed: false });
  db.napSleeps.push({ nap_sleep_id: sid, nap_session_id: sid, child_id: 'C004', slept_at: slept, woke_at: woke, sleep_temperature: null,
    slept_staff_id: 'S003', woke_staff_id: null, corrected_at: null, is_deleted: false, created_at: slept, updated_at: slept, ...v } as never);
}

describe('きょうのようすから入れる行（詳細設計書「日誌」(4-13 (8))）', () => {
  it('午睡と食事を時刻の順に、取り消した記録は入れずに返す', async () => {
    const day = '2026-01-05';
    addMeal(day, `${day}T11:40:00`, '1', '3');
    addMeal(day, `${day}T15:10:00`, '2', '1');
    addMeal(day, `${day}T15:20:00`, '2', '4', { is_deleted: true, updated_at: `${day}T15:30:00` });
    addNap(day, `${day}T13:05:00`, `${day}T14:40:00`);
    addNap(day, `${day}T16:00:00`, null);
    const { lines } = await api.diaryLines(teacher, 'C004', day);
    expect(lines).toEqual([
      '11:40 給食 少し',
      '13:05〜14:40 午睡（1時間35分）',
      '15:10 おやつ ぜんぶ',
      '16:00 午睡（おきたは記録されていません）',
    ]);
    expect((await api.diaryLines(teacher, 'C004', '2026-01-06')).lines).toEqual([]);
  });

  it('日付の形が崩れた・未来は断り、保護者と担当外の職員には見せない', async () => {
    await expect(api.diaryLines(teacher, 'C004', '2026-1-5')).rejects.toThrow('日付の形式が正しくありません。');
    await expect(api.diaryLines(teacher, 'C004', addDays(today(), 1))).rejects.toThrow('日付の形式が正しくありません。');
    await expect(api.diaryLines(guardian, 'C004')).rejects.toThrow('この日誌を参照する権限がありません');
    const other = db.classChildren.find((cc) => cc.class_id !== 1)!.child_id;
    await expect(api.diaryLines(teacher, other)).rejects.toThrow('この園児の連絡帳は開けません。');
  });
});

describe('取り込んだあとの訂正・取り消しの表示（詳細設計書「日誌」(4-13 (6))）', () => {
  it('日誌を作ったあとの訂正・取り消しだけを、記録の時刻の順に返す。本文は書き換えない', async () => {
    const day = today();
    const later = plusMinutes(now(), 5);
    addMeal(day, `${day}T10:00:00`, '2', '4', { is_deleted: true, updated_at: '2000-01-01T00:00:00' });
    addMeal(day, `${day}T10:10:00`, '2', '2', { corrected_at: '2000-01-01T00:00:00', updated_at: '2000-01-01T00:00:00' });
    addMeal(day, `${day}T11:40:00`, '1', '1', { corrected_at: later, updated_at: later });
    addNap(day, `${day}T13:05:00`, `${day}T14:40:00`, { is_deleted: true, updated_at: later });
    addMeal(addDays(day, -1), `${addDays(day, -1)}T11:40:00`, '1', '1', { corrected_at: later, updated_at: later });

    const d = await api.saveDiary(teacher, { record_type: '1', child_id: 'C004', class_id: 1, diary_date: day, body: '個人日誌' }, '1');
    const got = await api.getDiary(teacher, d.diary_id);
    expect(got.contact_changes).toEqual([
      { kind: 'meal', recorded_at: `${day}T11:40:00`, meal_kind: '1', change: 'correct', changed_at: later },
      { kind: 'nap', recorded_at: `${day}T13:05:00`, change: 'cancel', changed_at: later },
    ]);
    expect(got.body).toBe('個人日誌');

    const cls = await api.saveDiary(teacher, { record_type: '2', child_id: null, class_id: 1, diary_date: day, body: 'クラス日誌' }, '1');
    expect((await api.getDiary(teacher, cls.diary_id)).contact_changes ?? []).toEqual([]);
  });
});

describe('日誌一覧の園児名・キーワードの絞り込み（図/画面詳細図「日誌一覧画面」(3-1) 項目10・11）', () => {
  it('園児名は名前・よみ・空白なし、キーワードは本文に当たる', async () => {
    const day = today();
    const a = await api.saveDiary(teacher, { record_type: '1', child_id: 'C004', class_id: 1, diary_date: day, body: 'あおぞら公園へ行った' }, '1');
    const b = await api.saveDiary(teacher, { record_type: '1', child_id: 'C001', class_id: 1, diary_date: day, body: '室内で製作をした' }, '1');
    const ids = async (f: Parameters<typeof api.listDiaries>[1]) => (await api.listDiaries(teacher, f)).rows.map((r) => r.diary_id);
    expect(await ids({ keyword: 'あおぞら' })).toContain(a.diary_id);
    expect(await ids({ keyword: 'あおぞら' })).not.toContain(b.diary_id);
    expect(await ids({ keyword: '存在しない語' })).toEqual([]);
    const c = db.children.find((x) => x.child_id === 'C004')!;
    for (const q of [c.child_name, c.child_name.replace(/[ 　]/g, ''), c.child_name_kana ?? '']) {
      if (!q) continue;
      const got = await ids({ child: q });
      expect(got).toContain(a.diary_id);
      expect(got).not.toContain(b.diary_id);
    }
  });
});
