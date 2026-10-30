/*
 * 管理側の操作のテスト
 * 典拠：基本設計書.md「編集ロックの解除」(4-5)・「操作ログ」(5-8)・5-3（紐づけとアカウントの停止）
 *      管理側のペルソナのデモで見つけた指摘（GitHub Issue #106〜#129）
 *
 * ここで確かめる規則は、Go サーバ（server/）にも同じものがある。片方だけを直すと食い違う。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const admin2: SessionUser = {
  account_id: 2, email: 'endo@hoiku.example.jp', role: '1', display_name: '遠藤 直人',
  staff_id: 'S002', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

describe('日誌の承認', () => {
  it('自分が申請した日誌は承認できず、ほかの管理者は承認できる', async () => {
    const d = await api.saveDiary(admin, {
      record_type: '2', child_id: null, class_id: 3, diary_date: today(), body: '室内でふれあい遊び。',
    }, '2');

    await expect(api.approveDiary(admin, d.diary_id, d.updated_at)).rejects.toThrow('自分が申請した日誌は承認できません');
    expect(db.diaries.find((x) => x.diary_id === d.diary_id)?.status).toBe('2');

    const approved = await api.approveDiary(admin2, d.diary_id, d.updated_at);
    expect(approved.status).toBe('3');
    expect(approved.approved_staff_id).toBe('S002');
  });

  it('自分が申請した日誌でも、差し戻すことはできる', async () => {
    const d = await api.saveDiary(admin, {
      record_type: '2', child_id: null, class_id: 3, diary_date: today(), body: '散歩。',
    }, '2');
    const returned = await api.returnDiary(admin, d.diary_id, '書き直します');
    expect(returned.status).toBe('4');
  });
});

describe('編集ロック', () => {
  it('ログアウトすると、保持している編集ロックが外れる', async () => {
    await api.login('nishida@hoiku.example.jp', 'pass1234', 'staff');
    await api.acquireLock(admin, 1);
    expect(db.diaryLocks.some((l) => l.diary_id === 1 && l.locked_staff_id === 'S001')).toBe(true);

    await api.logout();
    expect(db.diaryLocks.some((l) => l.locked_staff_id === 'S001')).toBe(false);
    // ほかの職員のロックは残る（日誌3は S004 が保持している）
    expect(db.diaryLocks.some((l) => l.diary_id === 3 && l.locked_staff_id === 'S004')).toBe(true);
  });

  it('管理者の強制解除は操作ログに残り、どの日誌かが分かる', async () => {
    await api.releaseLock(admin, 3, true);
    expect(db.diaryLocks.some((l) => l.diary_id === 3)).toBe(false);

    const logs = await api.operationLogs(admin, {});
    const row = logs.rows.find((l) => l.target_table === 't_diary_lock' && l.target_id === 3);
    expect(row?.after_value).toBe('管理者が強制解除');
    expect(row?.target_label).toContain('ヒヤリハット');
    expect(row?.target_label).toContain('鈴木 健');
  });
});

describe('職員アカウント', () => {
  it('発行後に、氏名・ロール・担当クラスを変えられる', async () => {
    await api.updateStaffAccount(admin, 'S005', { staff_name: '久保田 和也', role: '2', class_id: 3 });
    const rows = await api.staffAccounts(admin);
    expect(rows.find((r) => r.staff.staff_id === 'S005')?.className).toBe('もも組');

    // 当年度の割り当てだけが付け替わる。重ねて持たない
    const current = db.classStaff.filter((cs) => cs.staff_id === 'S005'
      && db.classes.some((c) => c.class_id === cs.class_id && c.fiscal_year === db.FISCAL_YEAR));
    expect(current).toEqual([{ class_id: 3, staff_id: 'S005' }]);

    await api.updateStaffAccount(admin, 'S005', { staff_name: '久保田 和也', role: '2', class_id: 2 });
  });

  it('過年度の担当クラスの割り当ては残す', async () => {
    // S003 は 2025 年度のさくら組（class_id 11）の担任だった
    await api.updateStaffAccount(admin, 'S003', { staff_name: '鈴木 浩之', role: '2', class_id: 1 });
    expect(db.classStaff.some((cs) => cs.staff_id === 'S003' && cs.class_id === 11)).toBe(true);
  });

  it('自分のロールは変えられない。一般の職員は変更できない', async () => {
    await expect(api.updateStaffAccount(admin, 'S001', { staff_name: '西田 拓也', role: '2', class_id: null }))
      .rejects.toThrow('自分のロールは変更できません');
    await expect(api.updateStaffAccount(teacher, 'S005', { staff_name: '久保田 和也', role: '1', class_id: 2 }))
      .rejects.toThrow('管理者のみ');
  });

  it('停止・再開の操作ログから、誰のアカウントかが分かる', async () => {
    await api.setAccountStatus(admin, 5, '2');
    const logs = await api.operationLogs(admin, {});
    const row = logs.rows.find((l) => l.target_table === 'm_account' && l.target_id === 5 && l.after_value === '停止');
    expect(row?.target_label).toBe('久保田 和也');
    await api.setAccountStatus(admin, 5, '1');
  });
});

describe('保護者アカウントと紐づけ', () => {
  /*
   * 保護者アカウントを管理者が手で停止・再開する操作は設けない（基本設計書「アカウントの停止と再開」(4-3)、
   * 図/画面詳細図「保護者アカウント管理画面」(7-8) 項目5「置かない」。GitHub Issue #272 の 1）。職員の停止・再開は使える
   */
  it('保護者のアカウントは、手で停止も再開もできない', async () => {
    // 村田 真一（アカウント9）は有効、鈴木 浩之（アカウント8・G003）は紐づけが終了して停止している
    await expect(api.setAccountStatus(admin, 9, '2')).rejects.toThrow('手で停止・再開できません');
    await expect(api.setAccountStatus(admin, 8, '1')).rejects.toThrow('手で停止・再開できません');
    expect(db.accounts.find((a) => a.account_id === 9)?.status).toBe('1');
    expect(db.accounts.find((a) => a.account_id === 8)?.status).toBe('2');
  });

  it('解除した紐づけを戻すと、停止していたアカウントも再開される', async () => {
    await api.restoreGuardianLink(admin, 'G003', 'C003');
    const link = db.guardianChildren.find((x) => x.guardian_id === 'G003' && x.child_id === 'C003');
    expect(link?.link_status).toBe('1');
    expect(link?.ended_at).toBeNull();
    expect(db.accounts.find((a) => a.account_id === 8)?.status).toBe('1');

    // 操作ログから、どの保護者の紐づけかが分かる
    const logs = await api.operationLogs(admin, {});
    const row = logs.rows.find((l) => l.target_table === 't_guardian_child' && l.before_value === '終了');
    expect(row?.target_label).toBe('鈴木 浩之');
    expect(row?.child_name).toBe('鈴木 健');
  });

  /*
   * 紐づけを戻したら、その園児の個人チャット・クラスグループ・園全体の参加が戻る（基本設計書「保護者と園児の紐づけを戻す」(4-3)。
   * GitHub Issue #272 の 2）。デモデータの鈴木 浩之は、紐づけが終わっているうえ、園全体のほかに参加の行が無い
   */
  it('参加の行が無かった保護者も、紐づけを戻すと個人チャット・クラスグループ・園全体に入っている', async () => {
    const joined = () => db.chatMembers.filter((m) => m.account_id === 8 && m.left_at === null).map((m) => m.chat_room_id);
    const personal = db.chatRooms.find((r) => r.room_type === '4' && r.child_id === 'C003')!.chat_room_id;
    const classGroup = db.chatRooms.find((r) => r.room_type === '2' && r.class_id === 1)!.chat_room_id;
    // 前の it（紐づけを戻す）で戻っている。ここでは、戻したあとの状態を確かめる
    expect(joined()).toEqual(expect.arrayContaining([1, personal, classGroup]));
    const guardian: SessionUser = {
      account_id: 8, email: 'suzuki.h@example.jp', role: '3', display_name: '鈴木 浩之',
      staff_id: null, guardian_id: 'G003', class_id: null, class_name: null,
      is_temp_password: false, terms_agreed: true,
    };
    const rooms = await api.rooms(guardian);
    expect(rooms.map((r) => r.room.chat_room_id)).toEqual(expect.arrayContaining([1, personal, classGroup]));
    await expect(api.send(guardian, personal, 'ありがとうございます。')).resolves.toBeDefined();
  });

  it('紐づけを解除した操作ログにも、保護者の名前が残る', async () => {
    await api.endGuardianLink(admin, 'G003', 'C003');
    const logs = await api.operationLogs(admin, {});
    const row = logs.rows.find((l) => l.target_table === 't_guardian_child' && l.before_value === '有効');
    expect(row?.target_label).toBe('鈴木 浩之');
    expect(db.accounts.find((a) => a.account_id === 8)?.status).toBe('2');
  });

  /*
   * 有効な紐づけが無くなったことによる停止は、システムが行った変更として、操作者を「システム」で残す
   * （基本設計書「操作ログの記録」(4-2)・「操作ログ（t_operation_log）」(5-9)。GitHub Issue #312 の 3）。
   * 解除の行は、解除した管理者の操作のまま残る
   */
  it('最後の紐づけの解除による停止は、操作者「システム」の行で残り、解除の行は管理者のまま', async () => {
    await api.restoreGuardianLink(admin, 'G003', 'C003');
    await api.endGuardianLink(admin, 'G003', 'C003');
    const logs = (await api.operationLogs(admin, {})).rows.filter((l) => l.target_id === 8 && l.target_child_id === 'C003');
    const ended = logs.find((l) => l.target_table === 't_guardian_child' && l.before_value === '有効');
    expect(ended?.account_name).toBe('西田 拓也');
    expect(ended?.after_value).toBe('終了');
    const stop = logs.find((l) => l.target_table === 'm_account' && l.after_value?.startsWith('停止'));
    expect(stop?.account_name).toBe('システム');
    expect(stop?.account_id).toBeNull();
    expect(stop?.operator_type).toBe('2');
    expect(stop?.target_label).toBe('鈴木 浩之');
  });

  it('ほかに有効な紐づけが残る解除では、停止の行は出ない', async () => {
    const stops = () => db.operationLogs.filter((l) => l.operator_type === '2').length;
    const before = stops();
    // G001 は C001 の1本だけなので、もう1本つないでから解除する
    db.guardianChildren.push({
      guardian_id: 'G001', child_id: 'C006', relationship: '父', link_status: '1', linked_at: '2026-09-01T10:00:00', ended_at: null,
    });
    await api.endGuardianLink(admin, 'G001', 'C006');
    expect(db.accounts.find((a) => a.account_id === 6)?.status).toBe('1');
    expect(stops()).toBe(before);
  });
});

describe('出力の記録', () => {
  it('操作ログの CSV 出力は、操作ログに「出力」として残る', async () => {
    await api.recordExport(admin, 'operation_log', '2026-09-01', '2026-09-30', 12);
    const logs = await api.operationLogs(admin, {});
    const row = logs.rows.find((l) => l.target_table === 't_operation_log');
    expect(row?.operation_type).toBe('5');
    expect(row?.after_value).toContain('2026-09-01〜2026-09-30');
    expect(row?.after_value).toContain('12 件');
  });

  it('操作ログの出力は管理者に限る', async () => {
    await expect(api.recordExport(teacher, 'operation_log', '2026-09-01', '2026-09-30', 1)).rejects.toThrow('管理者のみ');
  });

  it('午睡記録の出力は、画面からの申告では記録しない（帳票を作るサーバが記録する）', async () => {
    // 出力していない「午睡記録をCSV出力」を書けると、監査の記録が信用できなくなる（server/api_audit.go の handleRecordExport と同じ）。
    // 型からは外したので、古い画面が送ってきた場合を、型を外して確かめる
    const napRecord = 'nap_record' as unknown as Parameters<typeof api.recordExport>[1];
    const napExports = () => db.operationLogs.filter((l) => l.target_table === 't_nap_record' && l.operation_type === '5').length;
    const before = napExports();
    for (const user of [teacher, admin]) {
      await expect(api.recordExport(user, napRecord, '2026-09-01', '2026-09-30', 8)).rejects.toThrow('出力の種別が正しくありません');
    }
    expect(napExports()).toBe(before);
  });
});

describe('園児情報の登録', () => {
  const base = {
    child_id: 'C900', child_name: '試験 花', child_name_kana: 'しけん はな', birth_date: '2025-10-20',
    sex: '2' as const, normal_temperature: 36.7, photo_consent_level: '2' as const, class_id: 3,
    allergies: [], medical_histories: [],
  };

  it('よみが空なら登録できない', async () => {
    await expect(api.saveChild(admin, { ...base, child_name_kana: ' ' }, 'create')).rejects.toThrow('よみを入力してください');
  });

  it('アレルギーは、対象だけでは登録できない', async () => {
    await expect(api.saveChild(admin, {
      ...base, allergies: [{ target_food: '卵', symptom: '', response: '' }],
    }, 'create')).rejects.toThrow('アレルギー「卵」の症状と対応を入力してください');
    expect(db.children.some((c) => c.child_id === 'C900')).toBe(false);
  });

  it('園児IDがすでに使われているかを、登録の前に確かめられる', async () => {
    expect(await api.childIdExists(admin, 'C001')).toBe(true);
    expect(await api.childIdExists(admin, 'C900')).toBe(false);
  });

  it('対象・症状・対応が揃っていれば登録できる', async () => {
    await api.saveChild(admin, {
      ...base, allergies: [{ target_food: '卵', symptom: '発疹', response: '除去食' }],
    }, 'create');
    expect(db.allergies.some((a) => a.child_id === 'C900' && a.target_food === '卵')).toBe(true);
  });
});

describe('CSV一括登録', () => {
  it('1行に誤りが複数あれば、まとめて示す', async () => {
    const { rows } = await api.parseChildCsv('C801,,,2025/13/40,3,ばら組,36.5');
    expect(rows[0].error).toContain('氏名が空です');
    expect(rows[0].error).toContain('氏名かなが空です');
    expect(rows[0].error).toContain('生年月日の形式が正しくありません');
    expect(rows[0].error).toContain('性別は');
    expect(rows[0].error).toContain('クラス名が見つかりません');
  });

  it('範囲の外の平熱は、取り込みを妨げずに確認を促す', async () => {
    const { rows } = await api.parseChildCsv('C802,藤井 蒼,ふじい あお,2025-09-09,1,もも組,46.5');
    expect(rows[0].error).toBeNull();
    expect(rows[0].warning).toContain('想定の範囲');
  });

  it('数値でない平熱と、ファイル内での園児IDの重複は誤りとする', async () => {
    const { rows } = await api.parseChildCsv([
      'C803,原 つむぎ,はら つむぎ,2025-12-01,2,もも組,平熱',
      'C804,西村 凛,にしむら りん,2025-08-08,2,もも組,36.4',
      'C804,西村 蓮,にしむら れん,2025-08-08,1,もも組,36.4',
    ].join('\n'));
    expect(rows[0].error).toBe('平熱は数値（小数第1位まで。例：36.5）で入力してください');
    expect(rows[1].error).toBeNull();
    expect(rows[2].error).toBe('同じ園児IDがこのファイル内で重複しています');
  });
});
