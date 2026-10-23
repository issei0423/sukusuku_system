/*
 * 午睡チェックの終了と異常時の記録（GitHub Issue #158）
 * 典拠：基本設計書.md「午睡チェック」(4-7)「午睡チェックの開始・参照・記録は、一般（保育士）は自クラスに限る」・
 *      「終了した実施へは記録できない」、「権限と利用可能機能」(6-1)「異常時の記録 一般 ※1」、
 *      「入力項目の制約値」(4-9)「未来日は認めない」
 *
 * Go サーバ側（server/api_nap_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { addDays, today } from '../src/api/util';
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
const otherTeacher: SessionUser = {
  account_id: 5, email: 'kubota@hoiku.example.jp', role: '2', display_name: '久保田 和也',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
  is_temp_password: false, terms_agreed: true,
};

const abnormal = (childId: string, foundAt: string) =>
  ({ child_id: childId, found_at: foundAt, situation: '顔色がやや紅潮', response: '別室で休ませた' });

describe('午睡チェックの終了は、自クラスの実施中の実施に限る', () => {
  it('ほかのクラスの職員は終了できない。無い実施・終了した実施は終了できず、終了の記録を書き換えない', async () => {
    const s = await api.startSession(teacher, 1, today());
    await expect(api.endSession(otherTeacher, s.nap_session_id)).rejects.toThrow('終了する権限がありません');
    expect(db.napSessions.find((x) => x.nap_session_id === s.nap_session_id)!.ended_at).toBeNull();

    const logs = db.operationLogs.length;
    await expect(api.endSession(otherTeacher, 99999)).rejects.toThrow('見つかりません');
    expect(db.operationLogs.length).toBe(logs);

    await api.endSession(teacher, s.nap_session_id);
    const ended = { ...db.napSessions.find((x) => x.nap_session_id === s.nap_session_id)! };
    expect(ended.ended_staff_id).toBe('S003');
    for (const u of [teacher, admin]) {
      await expect(api.endSession(u, s.nap_session_id)).rejects.toThrow('すでに終了しています');
    }
    const after = db.napSessions.find((x) => x.nap_session_id === s.nap_session_id)!;
    expect(after.ended_at).toBe(ended.ended_at);
    expect(after.ended_staff_id).toBe('S003');
  });
});

describe('異常時の記録は、その園児のクラスの、実施中の午睡チェックにつなぐ', () => {
  it('ほかのクラス・園児と違うクラス・終了した実施・無い実施へは記録できない', async () => {
    const s = await api.startSession(teacher, 1, today());
    const valid = `${today()}T00:00:00`;
    const before = db.napAbnormals.length;

    await expect(api.recordAbnormal(otherTeacher, s.nap_session_id, abnormal('C013', valid))).rejects.toThrow('権限がありません');
    await expect(api.recordAbnormal(otherTeacher, s.nap_session_id, abnormal('C001', valid))).rejects.toThrow('権限がありません');
    await expect(api.recordAbnormal(admin, s.nap_session_id, abnormal('C013', valid))).rejects.toThrow('園児のクラスの午睡チェックではありません');
    await expect(api.recordAbnormal(teacher, 2, abnormal('C001', valid))).rejects.toThrow('終了しています');
    await expect(api.recordAbnormal(teacher, 99999, abnormal('C001', valid))).rejects.toThrow('見つかりません');

    for (const v of ['2999-01-01T10:00:00', `${addDays(today(), 1)}T00:00:00`, 'abc', '2026-10-1T10:00:00', today()]) {
      await expect(api.recordAbnormal(teacher, s.nap_session_id, abnormal('C001', v))).rejects.toThrow('発見時刻');
    }
    expect(db.napAbnormals.length).toBe(before);

    await api.recordAbnormal(teacher, s.nap_session_id, abnormal('C001', valid));
    await api.recordAbnormal(teacher, s.nap_session_id, abnormal('C002', ''));
    await api.recordAbnormal(admin, s.nap_session_id, abnormal('C003', valid));
    expect(db.napAbnormals.length).toBe(before + 3);
    // 発見時刻を空にすると今の時刻を入れる
    expect(db.napAbnormals.find((a) => a.child_id === 'C002' && a.nap_session_id === s.nap_session_id)!.found_at)
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe('ヒヤリハットの起票は、その園児を参照できる職員に限る', () => {
  it('ほかのクラスの記録からは起票できず、中身も返さない', async () => {
    // 2 はさくら組・久保田 陸（C005）の記録。未起票
    const err = await api.raiseIncidentDiary(otherTeacher, 2).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('体温37.4度');
    expect(db.napAbnormals.find((a) => a.nap_abnormal_id === 2)!.diary_id).toBeNull();

    const d = await api.raiseIncidentDiary(teacher, 2);
    expect(d.created_staff_id).toBe('S003');
  });

  it('崩れた発見時刻の記録でも起票でき、記録日はその実施の日にする', async () => {
    db.napAbnormals.push({
      nap_abnormal_id: 990001, nap_session_id: 2, child_id: 'C001', found_at: 'abc',
      situation: '状況', response: '対応', staff_id: 'S003', diary_id: null,
    });
    const d = await api.raiseIncidentDiary(teacher, 990001);
    expect(d.diary_date).toBe(db.napSessions.find((s) => s.nap_session_id === 2)!.session_date);
  });
});
