/*
 * 園児の取消・操作ログの変更前後・アカウントと招待コードの操作（GitHub Issue #166 の 4〜6、#167 の 1・3・4）
 * 典拠：基本設計書.md「園児情報の取消（誤登録の削除）」(4-4)、「メッセージ一覧」(4-9)「取消の不可」、
 *      「共通の処理」(4-2)「変更前後の値」、「操作ログ（t_operation_log）」(5-8)、
 *      「入力項目の制約値」(4-9)、「設定マスタ（m_setting）」(5-8)、図/画面詳細図.md「招待コード管理画面」(7-7)
 *
 * Go サーバ（server/api_admin_checks_test.go）と同じ観点で確かめる。片方だけを直すと食い違う。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import type { ChildInput } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { fromNowMinutes } from '../src/api/util';

const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

const newChild = (childId: string): ChildInput => ({
  child_id: childId, child_name: '誤登録 太郎', child_name_kana: 'ごとうろく たろう', birth_date: '2024-05-01',
  sex: '1', normal_temperature: 36.5, photo_consent_level: '2', class_id: 1, allergies: [], medical_histories: [],
});

const logsOfChild = (childId: string) => db.operationLogs.filter((l) => l.target_child_id === childId);
const parse = (v: string | null) => JSON.parse(v ?? 'null') as Record<string, unknown>;

describe('園児の取消（GitHub Issue #166 の 4）', () => {
  it('記録のある園児は取り消せない', async () => {
    // 野原 太郎（C001）は日誌・身体測定・午睡・個人チャットの記録がある
    await expect(api.removeChild(admin, 'C001'))
      .rejects.toThrow('記録が登録されている園児は取り消せません。在籍状態を変更してください。');
    expect(db.children.find((c) => c.child_id === 'C001')!.is_deleted).toBe(false);
  });

  it('記録の無い誤登録は取り消せ、2 回目は「見つかりません」で操作ログも 1 行だけ', async () => {
    await api.saveChild(admin, newChild('C901'), 'create');
    await api.removeChild(admin, 'C901');
    await expect(api.removeChild(admin, 'C901')).rejects.toThrow('園児が見つかりません');
    expect(logsOfChild('C901').filter((l) => l.operation_type === '4')).toHaveLength(1);
  });

  it('取り消した園児には招待コードを発行できず、取り消す前のコードでも登録できない', async () => {
    await api.saveChild(admin, newChild('C902'), 'create');
    const code = await api.issueOneInvitationCode(admin, 'C902', 30);
    await api.removeChild(admin, 'C902');

    await expect(api.issueOneInvitationCode(admin, 'C902', 30)).rejects.toThrow('在籍していない園児');
    await expect(api.issueOneInvitationCode(admin, 'C999', 30)).rejects.toThrow('園児が見つかりません');
    await expect(api.verifyInvitationCode(code)).rejects.toThrow('招待コードが確認できません');
    await expect(api.signUpGuardian({
      code, email: 'gotoroku@example.jp', password: 'gotoroku-5678', guardian_name: '誤登録 花子', relationship: '母',
      terms_agreed: true, terms_version: db.CURRENT_TERMS_VERSION, // 規約への同意（GitHub Issue #170）
    })).rejects.toThrow('招待コードが確認できません');
    expect(db.accounts.some((a) => a.email === 'gotoroku@example.jp')).toBe(false);
  });
});

describe('操作ログの変更前後（GitHub Issue #166 の 5）', () => {
  it('園児の編集は、変更のあった項目だけを {"項目名": 値} で残す', async () => {
    // 上園 花子（C002・さくら組・平熱 36.8・写真の利用同意 2）のクラス・平熱・写真の利用同意・アレルギーを変える
    const c = db.children.find((x) => x.child_id === 'C002')!;
    await api.saveChild(admin, {
      child_id: 'C002', child_name: c.child_name, child_name_kana: c.child_name_kana, birth_date: c.birth_date,
      sex: c.sex, normal_temperature: 37.2, photo_consent_level: '3', class_id: 2,
      allergies: [{ target_food: 'えび', symptom: 'じんましん', response: '除去食' }],
      medical_histories: db.medicalHistories.filter((m) => m.child_id === 'C002').map((m) => m.content),
    }, 'edit');
    const row = logsOfChild('C002').find((l) => l.target_table === 'm_child' && l.operation_type === '2')!;
    const before = parse(row.before_value);
    const after = parse(row.after_value);
    expect(before).toMatchObject({ クラス: 'さくら組', 平熱: 36.8 });
    expect(after).toMatchObject({ クラス: 'ひまわり組', 平熱: 37.2 });
    expect(before.写真の利用同意).not.toBe(after.写真の利用同意);
    expect(row.after_value).toContain('えび');
    // 変わっていない項目は入れない
    for (const key of ['氏名', 'よみ', '生年月日', '性別']) expect(after).not.toHaveProperty(key);
  });

  it('職員アカウントの発行は、ロールと担当クラスを残す', async () => {
    await api.createStaffAccount(admin, {
      staff_id: 'S010', staff_name: '新任 主任', email: 'shinnin@hoiku.example.jp', role: '1', class_id: 3,
    });
    const row = db.operationLogs.find((l) => l.target_table === 'm_account' && l.operation_type === '1')!;
    expect(parse(row.after_value)).toMatchObject({ ロール: '管理者', 担当クラス: 'もも組', ログインID: 'shinnin@hoiku.example.jp' });
  });

  it('CSV で登録した園児は、1 名ずつ対象園児つきで残す', async () => {
    const text = '園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱\n'
      + 'C101,一括 一郎,いっかつ いちろう,2024-04-01,1,さくら組,36.5\n'
      + 'C102,一括 二郎,いっかつ じろう,2024-05-01,1,ひまわり組,\n';
    await api.importChildCsv(admin, [], text);
    for (const id of ['C101', 'C102']) {
      const rows = logsOfChild(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].operation_type).toBe('1');
      expect(rows[0].after_value).toContain('CSV一括登録');
    }
  });
});

describe('ロックの解除と招待コードの失効（GitHub Issue #166 の 6）', () => {
  it('相手が無い・状態が変わらない操作は断り、操作ログに残さない', async () => {
    const before = db.operationLogs.length;
    await expect(api.unlock(admin, 9999)).rejects.toThrow('アカウントが見つかりません');
    // 金城（account 5）はロックされていない
    await expect(api.unlock(admin, 5)).rejects.toThrow('ロックされていません');
    // 招待コード 4 はデモデータで失効済み、2 は使用済み、9999 は無い
    await expect(api.revokeInvitationCode(admin, 4)).rejects.toThrow('すでに失効');
    await expect(api.revokeInvitationCode(admin, 2)).rejects.toThrow('使用済み');
    await expect(api.revokeInvitationCode(admin, 9999)).rejects.toThrow('見つかりません');
    expect(db.operationLogs.length).toBe(before);

    // ロックされているアカウントは解除でき、操作ログに残る
    const a = db.accounts.find((x) => x.account_id === 5)!;
    a.failed_login_count = 5;
    a.locked_until = fromNowMinutes(30);
    await api.unlock(admin, 5);
    expect(db.operationLogs.length).toBe(before + 1);
  });
});

describe('職員アカウントの発行の入力（GitHub Issue #167 の 1）', () => {
  const input = (staffId: string, name: string, email: string, role = '2', classId: number | null = null) => ({
    staff_id: staffId, staff_name: name, email, role: role as '1' | '2', class_id: classId,
  });

  it.each([
    ['ログインIDがメールアドレスの形でない', input('S020', '形式 確認', 'abc2'), '形式'],
    ['大文字・小文字だけが違うログインID', input('S021', '重複 確認', 'NOHARA@hoiku.example.jp'), 'すでに使われています'],
    ['すべて空', input('', '', ''), '入力してください'],
    ['氏名が 51 文字', input('S022', 'あ'.repeat(51), 'long-name@hoiku.example.jp'), '50文字以内'],
    ['職員IDが 21 文字', input('S'.repeat(21), '長い 職員ID', 'long-id@hoiku.example.jp'), '20文字以内'],
    ['ロールが無い', input('S023', 'ロール 無し', 'no-role@hoiku.example.jp', ''), 'ロール'],
    ['無い担当クラス', input('S024', 'クラス 無し', 'no-class@hoiku.example.jp', '2', 999), '担当クラス'],
  ])('%s は発行しない', async (_name, value, message) => {
    const staffCount = db.staff.length;
    await expect(api.createStaffAccount(admin, value)).rejects.toThrow(message);
    expect(db.staff.length).toBe(staffCount);
  });

  it('前後の空白は除いて登録し、空白なしのログインIDでログインできる', async () => {
    const temp = await api.createStaffAccount(admin, input(' S030 ', ' 空白 確認 ', ' sp@hoiku.example.jp ', '2', 1));
    const s = db.staff.find((x) => x.staff_id === 'S030')!;
    expect(s.staff_name).toBe('空白 確認');
    expect(db.accounts.find((a) => a.account_id === s.account_id)!.email).toBe('sp@hoiku.example.jp');
    await expect(api.login('sp@hoiku.example.jp', temp, 'staff')).resolves.toMatchObject({ staff_id: 'S030' });
    await api.logout();
  });
});

describe('招待コードの一括発行の枚数（GitHub Issue #167 の 3）', () => {
  it('園児1名あたりは 5 枚まで', async () => {
    await expect(api.issueInvitationCodes(admin, 2, 6, 30)).rejects.toThrow('1〜5枚');
    await expect(api.issueInvitationCodes(admin, 2, 5, 30)).resolves.toBeTruthy();
  });
});

describe('設定マスタの初期値（GitHub Issue #167 の 4）', () => {
  it('身体測定を行う月は 4・8・12 月（年3回。基本設計書「設定マスタ（m_setting）」(5-8)）', () => {
    expect(db.settings.find((s) => s.setting_key === 'physical.measure_months')?.setting_value).toBe('4,8,12');
  });
});
