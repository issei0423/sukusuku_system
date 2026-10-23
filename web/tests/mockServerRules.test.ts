/*
 * Go サーバとモックで、規則と結果をそろえる（GitHub Issue #177）
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1)・「権限チェックの実装方針」(6-2)、
 *      要件定義書.md「対象権限列の読み方」(4-2 冒頭)、基本設計書.md「操作ログ（t_operation_log）」(5-8)
 *
 * Go サーバ側（server/api_mock_rules_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 * 業務の規則を2か所に持っているため、片方だけを直すと食い違う（MOCKUP.md）。
 * サーバに対する同じ操作は web/tests/integration.test.ts（api/http.ts 経由）でも確かめる。
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
const otherTeacher: SessionUser = {
  account_id: 5, email: 'kubota@hoiku.example.jp', role: '2', display_name: '久保田 和也',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
  is_temp_password: false, terms_agreed: true,
};
// 西田 太郎（C001・さくら組）の保護者
const guardian: SessionUser = {
  account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

const kana = (childId: string) => db.children.find((c) => c.child_id === childId)!.child_name_kana;
const isSortedByKana = (ids: string[]) =>
  ids.every((id, i) => i === 0 || kana(ids[i - 1]).localeCompare(kana(id), 'ja') <= 0);

/*
 * Issue #177 の 1・2・5 は、土台の PR（#168・#180・#184・#187）でモックがサーバとそろった。
 * Issue に書かれた再現手順のとおりに、モックがサーバと同じ結果を返すことを確かめておく
 */
describe('Issue #177 の再現手順で、モックがサーバと同じ結果を返す（1・2・5）', () => {
  const inputOf = (diaryId: number, lockToken?: string) => {
    const d = db.diaries.find((x) => x.diary_id === diaryId)!;
    return {
      diary_id: d.diary_id, record_type: d.record_type, child_id: d.child_id, class_id: d.class_id,
      diary_date: d.diary_date, body: d.body, lock_token: lockToken,
    };
  };

  it('1：一般は他クラスのクラス日誌を開けず、保護者には日誌を返さない', async () => {
    // 日誌 6 はひまわり組のクラス日誌（申請中）。日誌 1 は 西田 太郎 の下書き、日誌 2 はさくら組のクラス日誌（申請中）
    await expect(api.getDiary(teacher, 6)).rejects.toThrow('この日誌を参照する権限がありません');
    // 日誌は園内の記録。保護者にはどの状態の日誌も返さない（詳細設計書「日誌」(4-13)）
    for (const id of [1, 2, 6]) await expect(api.getDiary(guardian, id)).rejects.toThrow('この日誌を参照する権限がありません');
  });

  it('2：申請中・承認済みの日誌は、下書きとして保存し直せない', async () => {
    // 日誌 4 は承認済み、日誌 7 は申請中（どちらもさくら組）
    for (const id of [4, 7]) {
      await expect(api.saveDiary(teacher, inputOf(id), '1')).rejects.toThrow('申請中または承認済みの日誌は編集できません');
    }
    expect(db.diaries.find((d) => d.diary_id === 4)!.status).toBe('3');
    expect(db.diaries.find((d) => d.diary_id === 7)!.status).toBe('2');
  });

  it('5：管理者が強制解除して自分がロックを持ったあと、元の職員の保存は設計の文言で断る', async () => {
    const mine = await api.acquireLock(teacher, 1);
    if (!('token' in mine)) throw new Error('ロックを取れませんでした');
    await api.releaseLock(admin, 1, true);
    expect(await api.acquireLock(admin, 1)).toHaveProperty('token');
    await expect(api.saveDiary(teacher, inputOf(1, mine.token), '1'))
      .rejects.toThrow('編集ロックが解除されました。内容を再読み込みしてください');
  });
});

describe('職員・管理者だけの API を、保護者と担当外の職員に使わせない（Issue #177 の 3）', () => {
  it('前回の発達チェックと当日の下書きは、その園児を参照できる職員に限る', async () => {
    // 西田 太郎（C001・さくら組）には、確定した前回の記録がある
    await expect(api.previousCheck(guardian, 'C001', today())).rejects.toThrow('職員のみが行えます');
    await expect(api.draftFor(guardian, 'C001', today())).rejects.toThrow('職員のみが行えます');
    await expect(api.previousCheck(otherTeacher, 'C001', today())).rejects.toThrow('権限がありません');
    await expect(api.draftFor(otherTeacher, 'C001', today())).rejects.toThrow('権限がありません');

    expect(await api.previousCheck(teacher, 'C001', today())).not.toBeNull();
    await expect(api.draftFor(teacher, 'C001', today())).resolves.not.toThrow();
  });

  it('アレルギー一覧は職員に限る。一般にも、自クラスに限らず全園児を返す（基本設計書 6-1 ○※2）', async () => {
    await expect(api.allAllergies(guardian)).rejects.toThrow('職員のみが行えます');
    // 久保田（ひまわり組）にも、さくら組の 西田 太郎 の「卵」が出る
    const rows = await api.allAllergies(otherTeacher);
    expect(rows.find((r) => r.child.child_id === 'C001')?.allergies.map((a) => a.target_food)).toEqual(['卵']);
  });

  it('異常時の記録の一覧は職員に限る（基本設計書 6-1「異常時の記録｜保護者 ×」）', async () => {
    await expect(api.abnormals(guardian)).rejects.toThrow('職員のみが行えます');
    expect((await api.abnormals(teacher)).length).toBeGreaterThan(0);
  });

  it('取り消して対応を記録していないメッセージは、管理者に限る（基本設計書 6-1「誤送信への対応の記録」）', async () => {
    await expect(api.retractedWithoutRecord(teacher)).rejects.toThrow('管理者のみ');
    await expect(api.retractedWithoutRecord(guardian)).rejects.toThrow('管理者のみ');
    await expect(api.retractedWithoutRecord(admin)).resolves.toBeInstanceOf(Array);
  });

  it('発達チェックの一覧・スケジュール・午睡記録の検索・身体測定の実施状況・職員ダッシュボードは、保護者に返さない', async () => {
    await expect(api.list(guardian, 1)).rejects.toThrow('職員のみが行えます');
    await expect(api.schedules(guardian, 1)).rejects.toThrow('職員のみが行えます');
    await expect(api.searchRecords(guardian, {})).rejects.toThrow('職員のみが行えます');
    await expect(api.classStatus(guardian, 1, today())).rejects.toThrow('職員のみが行えます');
    await expect(api.staffSummary(guardian)).rejects.toThrow('職員のみが行えます');

    // 職員はこれまでどおり使える
    expect((await api.list(teacher, 1)).length).toBeGreaterThan(0);
    expect((await api.schedules(teacher, 1)).length).toBeGreaterThan(0);
    expect((await api.searchRecords(teacher, {})).total).toBeGreaterThan(0);
    expect((await api.classStatus(teacher, 1, today())).target.length).toBeGreaterThan(0);
    await expect(api.staffSummary(teacher)).resolves.toHaveProperty('returned');
  });
});

describe('発達チェックを初めて保存したときの操作ログは「作成」（Issue #177 の 6）', () => {
  it('当日の記録が無い園児の下書き保存は「作成」、同じ記録の保存し直しは「変更」として残す', async () => {
    // 鈴木 健（C003・さくら組）。デモデータに当日の記録は無い
    expect(db.developmentChecks.some((c) => c.child_id === 'C003' && c.checked_on === today())).toBe(false);
    const latestLog = () => db.operationLogs.find((l) => l.target_table === 't_development_check' && l.target_child_id === 'C003')!;

    await api.saveCheck(teacher, 'C003', today(), [], '', '1');
    expect(latestLog().operation_type).toBe('1');

    await api.saveCheck(teacher, 'C003', today(), [], '', '1');
    expect(latestLog().operation_type).toBe('2');
  });
});

describe('一覧の並び順を Go サーバとそろえる（Issue #177 の 7。web/仮置き値.md「一覧の並び順」）', () => {
  it('アレルギー一覧は園児のよみ順', async () => {
    const ids = (await api.allAllergies(admin)).map((r) => r.child.child_id);
    // 井上 空 → 西田 太郎 → 橋本 莉子 → 村田 美咲
    expect(ids).toEqual(['C013', 'C001', 'C020', 'C004']);
  });

  it('異常時の記録は発見時刻の新しい順。同じ時刻なら、あとで記録したものを先にする', async () => {
    // 同じ発見時刻の記録を 2 件足す（記録の操作は実施中の午睡チェックを要るため、ここでは直接入れる）
    const base = { nap_session_id: 2, situation: '並び順の確認', response: '並び順の確認', staff_id: 'S003', diary_id: null };
    db.napAbnormals.push(
      { ...base, nap_abnormal_id: 900001, child_id: 'C001', found_at: '2026-08-29T13:00:00' },
      { ...base, nap_abnormal_id: 900002, child_id: 'C002', found_at: '2026-08-29T13:00:00' },
    );
    const rows = await api.abnormals(admin);
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1], rows[i]];
      expect(a.found_at > b.found_at || (a.found_at === b.found_at && a.nap_abnormal_id > b.nap_abnormal_id)).toBe(true);
    }
    const tie = rows.filter((r) => r.nap_abnormal_id >= 900001).map((r) => r.nap_abnormal_id);
    expect(tie).toEqual([900002, 900001]);
  });

  it('スケジュール設定は園児のよみ順（発達チェック一覧と同じ）', async () => {
    for (const classId of [1, 2]) {
      const ids = (await api.schedules(admin, classId)).map((r) => r.child.child_id);
      expect(ids.length).toBeGreaterThan(1);
      expect(isSortedByKana(ids)).toBe(true);
      expect(ids).toEqual((await api.list(admin, classId)).map((r) => r.child.child_id));
    }
  });

  it('招待コードは園児のよみ順にまとめ、同じ園児の中は発行の古い順', async () => {
    const ids = (await api.invitationCodes(admin, {})).map((r) => r.invitation_code_id).filter((id) => id <= 7);
    // 遠藤 花子（3・4）→ 久保田 陸（7）→ 鈴木 健（5）→ 西田 太郎（1・2）→ 村田 美咲（6）
    expect(ids).toEqual([3, 4, 7, 5, 1, 2, 6]);
  });

  it('取り消して対応を記録していないメッセージは、送信の新しい順。同じ時刻なら、あとで送ったものを先にする', async () => {
    // デモデータには対応を記録していない取消が無いため、職員の取消を足す（古いもの・番号の小さいものをあとに入れる）
    const retracted = (id: number, sentAt: string) => ({
      chat_message_id: id, chat_room_id: 1, sender_account_id: 3, body: '並び順の確認', source_type: '1' as const,
      source_id: null, sent_at: sentAt, edited_at: null, is_deleted: true, deleted_at: sentAt, deleted_account_id: 3,
    });
    db.chatMessages.push(retracted(900011, '2026-08-29T10:00:00'), retracted(900010, '2026-08-28T10:00:00'));
    db.chatMessages.push(retracted(900012, '2026-08-30T10:00:00'));
    db.chatMessages.push(retracted(900014, '2026-08-27T10:00:00'), retracted(900013, '2026-08-27T10:00:00'));
    db.chatMessages.push(retracted(900015, '2026-08-27T10:00:00'));
    const ids = (await api.retractedWithoutRecord(admin)).map((r) => r.chat_message_id).filter((id) => id >= 900010);
    expect(ids).toEqual([900012, 900011, 900010, 900015, 900014, 900013]);
  });
});
