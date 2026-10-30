/*
 * 園児マスターの直し（GitHub Issue #279）
 * 典拠：基本設計書「園児情報の登録・編集」(4-4)・「CSV一括登録」(4-4)・「園児情報の取消（誤登録の削除）」(4-4)・
 *      「権限と利用可能機能」(6-1) ※1、図/画面詳細図「園児一覧画面」(7-1)・「CSV一括登録画面」(7-3)・「アレルギー一覧画面」(7-4)
 *
 * Go サーバ（server/api_child_master_test.go）と同じ観点で確かめる。片方だけを直すと食い違う。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import type { ChildInput } from '../src/api/client';
import * as db from '../src/api/mockDb';
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
// フリー（担当クラスの無い一般）
const free: SessionUser = { ...teacher, account_id: 5, email: 'kubota@hoiku.example.jp', staff_id: 'S005', display_name: '久保田 和也', class_id: null, class_name: null };

const head = '園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱\n';
const newChild = (childId: string): ChildInput => ({
  child_id: childId, child_name: `誤登録 ${childId}`, child_name_kana: 'ごとうろく', birth_date: '2024-05-01',
  sex: '1', normal_temperature: 36.5, photo_consent_level: '1', class_id: 1, allergies: [], medical_histories: [],
});

describe('CSV の取込（GitHub Issue #279）', () => {
  it('性別は「男」「女」「未回答」の文字も数字も受ける。空欄と別の文字は受けない', async () => {
    const text = head + [
      'C931,文字 男,もじ おとこ,2025-06-01,男,さくら組,',
      'C932,文字 女,もじ おんな,2025-06-01,女,さくら組,',
      'C933,文字 未,もじ み,2025-06-01,未回答,さくら組,',
      'C934,数字 男,すうじ おとこ,2025-06-01,1,さくら組,',
      'C935,空欄,くうらん,2025-06-01,,さくら組,',
      'C936,別の字,べつのじ,2025-06-01,不明,さくら組,',
    ].join('\n');
    const r = await api.parseChildCsv(text);
    expect(r.rows.map((x) => x.error !== null)).toEqual([false, false, false, false, true, true]);
  });

  it('取り込んだ園児は性別を数字にそろえ、写真の利用同意は園内記録のみ（1）で入る', async () => {
    const text = head + [
      'C941,取込 男,とりこみ おとこ,2025-06-01,男,さくら組,',
      'C942,取込 女,とりこみ おんな,2025-06-01,女,ひまわり組,',
      'C943,取込 未,とりこみ み,2025-06-01,未回答,もも組,',
      'C944,取込 数,とりこみ すう,2025-06-01,2,さくら組,36.5',
    ].join('\n');
    const parsed = await api.parseChildCsv(text);
    await api.importChildCsv(admin, parsed.rows, text);
    for (const [id, sex] of [['C941', '1'], ['C942', '2'], ['C943', '9'], ['C944', '2']]) {
      const c = db.children.find((x) => x.child_id === id)!;
      expect(c.sex, `${id} の性別`).toBe(sex);
      expect(c.photo_consent_level, `${id} の写真の利用同意`).toBe('1');
    }
  });
});

describe('アレルギー一覧（GitHub Issue #279）', () => {
  it('担任でない職員にも全園児を返すが、返すのは氏名・クラス・アレルギーだけ', async () => {
    const rows = await api.allAllergies(teacher);
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows);
    for (const banned of ['birth_date', 'normal_temperature', 'photo_consent_level', '"sex"', 'child_name_kana', 'enrollment_status']) {
      expect(text, banned).not.toContain(banned);
    }
    for (const r of rows) {
      expect(r.child.child_id).toBeTruthy();
      expect(r.child.child_name).toBeTruthy();
      expect(r.className).toBeTruthy();
      expect(r.allergies.length).toBeGreaterThan(0);
    }
  });
});

describe('園児の取消（GitHub Issue #279）', () => {
  it('保護者が紐づく園児は、記録が無くても取り消せない。取り消せる園児の一覧にも出ない', async () => {
    await api.saveChild(admin, newChild('C951'), 'create');
    await api.saveChild(admin, newChild('C952'), 'create');
    db.guardianChildren.push({ ...db.guardianChildren[0], child_id: 'C951', link_status: '1' });
    await expect(api.removeChild(admin, 'C951'))
      .rejects.toThrow('記録または保護者が紐づいている園児は取り消せません。在籍状態を変更してください。');
    expect(db.children.find((c) => c.child_id === 'C951')!.is_deleted).toBe(false);
    const ids = await api.removableChildren(admin);
    expect(ids).toContain('C952');
    expect(ids).not.toContain('C951');
    expect(ids).not.toContain('C001');
    // 管理者だけの経路の断りは、Go（server/session.go の requireAdmin）と同じ文にする
    await expect(api.removableChildren(teacher)).rejects.toThrow('この操作は管理者のみが行えます');
    await expect(api.removeChild(teacher, 'C952')).rejects.toThrow('この操作は管理者のみが行えます');
    expect(db.children.find((c) => c.child_id === 'C952')!.is_deleted).toBe(false);
  });

  it('取り消すと、未使用の招待コードを失効させる', async () => {
    db.invitationCodes.push({ ...db.invitationCodes[0], invitation_code_id: 9901, code: 'CODE-J3-1', child_id: 'C952', status: '1' });
    await api.removeChild(admin, 'C952');
    expect(db.invitationCodes.find((i) => i.code === 'CODE-J3-1')!.status).toBe('3');
  });
});

describe('園児一覧の在籍状態（GitHub Issue #279）', () => {
  it('「退園した園児も出す」は管理者だけ。退園した園児は一覧の下にまとめる', async () => {
    db.children.find((c) => c.child_id === 'C001')!.enrollment_status = '2';
    expect((await api.listChildren(admin)).some((c) => c.child_id === 'C001')).toBe(false);
    const withLeft = await api.listChildren(admin, { includeWithdrawn: true });
    expect(withLeft[withLeft.length - 1].child_id).toBe('C001');
    expect((await api.listChildren(teacher, { includeWithdrawn: true })).some((c) => c.child_id === 'C001')).toBe(false);
    db.children.find((c) => c.child_id === 'C001')!.enrollment_status = '1';
  });
});

describe('フリー（担当クラスの無い一般）の閲覧（GitHub Issue #279）', () => {
  it('全クラスの園児を読めるが、既往歴は読めない（安全側）', async () => {
    const list = await api.listChildren(free);
    const classes = new Set(list.map((c) => db.classChildren.find((cc) => cc.child_id === c.child_id)?.class_id));
    expect(classes.size).toBeGreaterThanOrEqual(3);
    await expect(api.getChild(free, 'C001')).resolves.toBeTruthy();
    await expect(api.allergiesOf(free, 'C001')).resolves.toBeTruthy();
    await expect(api.classOf(free, 'C001')).resolves.toBeTruthy();
    await expect(api.medicalHistoriesOf(free, 'C001')).rejects.toThrow('この園児を参照する権限がありません');
  });

  it('午睡チェックの実施を全クラスで読めるが、開始はできない', async () => {
    await expect(api.classState(free, 1, null)).resolves.toBeTruthy();
    await expect(api.startSession(free, 1, '2026-10-29')).rejects.toThrow('このクラスの午睡チェックを開始する権限がありません');
  });
});
