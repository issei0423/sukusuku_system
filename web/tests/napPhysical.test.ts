/*
 * 身体測定の測定回と上書きの確認、午睡の記録の体温の桁（GitHub Issue #165 の 1・2・4）
 * 典拠：基本設計書.md「身体測定の記録」(4-8)「選択中の測定日と同一の年月に登録済みの園児には入力済みマークを付す」・
 *      「測定回の単位は年月とする」・「同一園児・同一測定日に未削除の記録があれば、上書き確認を表示する」・
 *      「確認の種類ごとに、対応する承諾だけを受け付ける」、
 *      「入力項目の制約値」(4-9)「体温 30.0〜43.0℃、小数第1位まで」・メッセージ一覧「測定日の形式不正」
 *
 * Go サーバ側（server/api_physical_test.go・api_nap_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

/** 先月の day 日。いつ回しても過去の日付になり、デモの記録（起動日へずれる）と重ならない園児で使う */
function lastMonthDay(day: number): string {
  const [y, m] = today().split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 2, 1));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${first.getUTCFullYear()}-${p(first.getUTCMonth() + 1)}-${p(day)}`;
}

const rowsOf = (childId: string) => db.physicalRecords.filter((r) => r.child_id === childId && !r.is_deleted);
const ids = (list: { child_id: string }[]) => list.map((c) => c.child_id);

describe('身体測定の測定回は年月（GitHub Issue #165 の 1）', () => {
  it('同じ年月の別の日を選んでも入力済みとして数え、ほかの月では未実施として数える', async () => {
    await api.save(teacher, { child_id: 'C007', measured_on: lastMonthDay(3), height_cm: 80.1, weight_kg: 10.2 });

    const same = await api.classStatus(teacher, 1, lastMonthDay(10));
    expect(ids(same.done)).toContain('C007');
    expect(ids(same.pending)).not.toContain('C007');

    const other = await api.classStatus(teacher, 1, today());
    expect(ids(other.done)).not.toContain('C007');
    expect(ids(other.pending)).toContain('C007');
  });

  it('削除した記録は数えない', async () => {
    await api.save(teacher, { child_id: 'C012', measured_on: lastMonthDay(6), height_cm: 75, weight_kg: 9 });
    await api.remove(admin, rowsOf('C012')[0].physical_record_id);
    expect(ids((await api.classStatus(teacher, 1, lastMonthDay(10))).done)).not.toContain('C012');
  });

  it('崩れた測定日は断る（実施状況・登録とも）', async () => {
    await expect(api.classStatus(teacher, 1, '2026-1-5')).rejects.toThrow('測定日の形式が正しくありません');
    for (const v of ['2026-1-5', '2026/01/05', '2026-02-30']) {
      await expect(api.save(teacher, { child_id: 'C011', measured_on: v, height_cm: 80, weight_kg: 10 }))
        .rejects.toThrow('測定日の形式が正しくありません');
    }
    expect(rowsOf('C011')).toHaveLength(0);
  });
});

describe('身体測定の上書きと、同じ月の別の記録は、確かめてから登録する（GitHub Issue #165 の 2）', () => {
  it('同じ測定日へ確かめずに送ると上書きせず、上書きを承諾したときだけ書き換える。記録した職員は初回登録者のまま', async () => {
    const day = lastMonthDay(5);
    await api.save(teacher, { child_id: 'C008', measured_on: day, height_cm: 82.5, weight_kg: 10.8 });

    await expect(api.save(admin, { child_id: 'C008', measured_on: day, height_cm: 90, weight_kg: 10.8 }))
      .rejects.toThrow('この測定日の記録は登録済みです');
    // 同じ月の別の記録の承諾は、上書きの承諾にならない（確認の種類ごとに、対応する承諾だけを受け付ける）
    await expect(api.save(admin, {
      child_id: 'C008', measured_on: day, height_cm: 90, weight_kg: 10.8, confirm_same_month: true,
    })).rejects.toThrow('この測定日の記録は登録済みです');
    expect(rowsOf('C008')[0].height_cm).toBe(82.5);

    await api.save(admin, { child_id: 'C008', measured_on: day, height_cm: 90, weight_kg: 10.8, confirm_overwrite: true });
    expect(rowsOf('C008')).toHaveLength(1);
    expect(rowsOf('C008')[0].height_cm).toBe(90);
    expect(rowsOf('C008')[0].staff_id).toBe('S003');
  });

  it('同じ月の別の日へ確かめずに送ると2件目を作らず、同じ月の別の記録として承諾したときだけ登録する', async () => {
    await api.save(teacher, { child_id: 'C010', measured_on: lastMonthDay(5), height_cm: 82.5, weight_kg: 10.8 });

    await expect(api.save(teacher, { child_id: 'C010', measured_on: lastMonthDay(4), height_cm: 82.3, weight_kg: 10.7 }))
      .rejects.toThrow('登録済みです');
    await expect(api.save(teacher, {
      child_id: 'C010', measured_on: lastMonthDay(4), height_cm: 82.3, weight_kg: 10.7, confirm_overwrite: true,
    })).rejects.toThrow('登録済みです');
    expect(rowsOf('C010')).toHaveLength(1);

    await api.save(teacher, {
      child_id: 'C010', measured_on: lastMonthDay(4), height_cm: 82.3, weight_kg: 10.7, confirm_same_month: true,
    });
    expect(rowsOf('C010')).toHaveLength(2);

    // ほかの月なら確かめずに登録できる
    await api.save(teacher, { child_id: 'C010', measured_on: today(), height_cm: 83, weight_kg: 11 });
    expect(rowsOf('C010')).toHaveLength(3);
  });
});

describe('午睡の記録の体温は小数第1位まで（GitHub Issue #165 の 4）', () => {
  const input = (childId: string, temperature: number | null) => ({
    child_id: childId, body_position: '1' as const, breathing: '1' as const, complexion: '1' as const, temperature,
  });

  it('小数第2位までの体温は断る。小数第1位まで・範囲の外・体温なしは記録できる（範囲の外は確かめるだけで妨げない）', async () => {
    const s = await api.startSession(teacher, 1, today());
    const count = () => db.napRecords.filter((r) => r.nap_session_id === s.nap_session_id && r.child_id === 'C006').length;
    const before = count();
    for (const v of [36.55, 36.05, 37.123]) {
      await expect(api.record(teacher, s.nap_session_id, input('C006', v))).rejects.toThrow('小数第1位');
    }
    expect(count()).toBe(before);

    for (const v of [36.5, 37, 25.0, null]) await api.record(teacher, s.nap_session_id, input('C006', v));
    expect(count()).toBe(before + 4);
  });

  it('ほかのクラスの園児は、管理者でもその実施へ記録できない（異常時の記録と同じ。GitHub Issue #158）', async () => {
    const s = await api.startSession(teacher, 1, today());
    await expect(api.record(admin, s.nap_session_id, input('C013', null))).rejects.toThrow('この園児のクラスの午睡チェックではありません');
    expect(db.napRecords.some((r) => r.nap_session_id === s.nap_session_id && r.child_id === 'C013')).toBe(false);
  });
});
