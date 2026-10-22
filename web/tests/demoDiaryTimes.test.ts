/*
 * デモデータの日誌の時刻を、起動した時刻で丸める（GitHub Issue #139）
 * 朝（08:00）に起動したとき、今日の日誌の申請・承認・差し戻しの時刻が起動した時刻より後にならない。
 * 外さずに丸めるので、承認待ちの一覧は残る。前の日の日誌と、起動より前の時刻は動かさない。
 *
 * Go サーバ（server/seed_shift_test.go の TestCapFutureDemoDiaryTimes）にも同じものがある。片方だけを直すと食い違う。
 */
import { describe, it, expect } from 'vitest';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';

describe('デモデータの日誌の時刻（GitHub Issue #139）', () => {
  it('朝に起動すると、今日の未来の時刻を起動した時刻に丸め、順を保つ', () => {
    const d = today();
    const find = (id: number) => {
      const row = db.diaries.find((x) => x.diary_id === id);
      if (!row) throw new Error(`diary ${id} が無い`);
      return row;
    };
    // デモデータの夕方の時刻に戻す（モジュールを読んだときに今の時刻で丸め済みのため）
    Object.assign(find(6), { applied_at: `${d}T17:00:00`, created_at: `${d}T17:00:00`, updated_at: `${d}T17:00:00` });
    Object.assign(find(7), { applied_at: `${d}T17:20:00`, created_at: `${d}T17:20:00`, updated_at: `${d}T17:20:00` });
    // 差し戻し（差し戻しの時刻は updated_at）。作成は起動より前
    Object.assign(find(1), { status: '4', returned_reason: '直してください', created_at: `${d}T07:30:00`, updated_at: `${d}T09:00:00` });
    // 承認済み。申請は起動より前、承認は起動より後
    Object.assign(find(5), {
      diary_date: d, created_at: `${d}T07:40:00`, applied_at: `${d}T07:45:00`, approved_at: `${d}T18:06:00`, updated_at: `${d}T18:06:00`,
    });
    const before4 = { ...find(4) };

    const at = `${d}T08:00:00`;
    db.capFutureDemoDiaryTimes(d, at);

    // 承認待ちは消さずに残り、申請の時刻は起動した時刻になる
    expect(db.diaries.filter((x) => x.status === '2' && !x.is_deleted && x.diary_date === d)).toHaveLength(2);
    for (const id of [6, 7]) {
      expect(find(id)).toMatchObject({ applied_at: at, created_at: at, updated_at: at });
    }
    // 差し戻しの時刻は丸め、起動より前の作成の時刻は動かさない
    expect(find(1)).toMatchObject({ created_at: `${d}T07:30:00`, updated_at: at });
    // 申請 ≦ 承認 の順が保たれる
    const r5 = find(5);
    expect(r5).toMatchObject({ applied_at: `${d}T07:45:00`, approved_at: at, updated_at: at });
    expect(r5.created_at <= (r5.applied_at ?? '')).toBe(true);
    expect((r5.applied_at ?? '') <= (r5.approved_at ?? '')).toBe(true);
    // 今日の日誌に、起動した時刻より後の時刻は残らない
    const future = (v: string | null) => v !== null && v.slice(0, 10) === d && v > at;
    expect(db.diaries.filter((x) => [x.created_at, x.applied_at, x.approved_at, x.updated_at].some(future))).toEqual([]);
    // 前の日の日誌は動かさない
    expect(find(4)).toEqual(before4);
  });
});
