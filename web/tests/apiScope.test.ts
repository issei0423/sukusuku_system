/*
 * API を直接呼んだときの権限の抜け（GitHub Issue #153）
 * 典拠：基本設計書.md「権限チェックの実装方針」(6-2)「画面を経由せず直接リクエストを送っても拒否されること」
 *
 * Go サーバ側（server/api_scope_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 * 業務の規則を2か所に持っているため、片方だけを直すと食い違う（MOCKUP.md）。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import type { DiaryInput } from '../src/api/client';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const otherTeacher: SessionUser = {
  account_id: 5, email: 'kinjo@hoiku.example.jp', role: '2', display_name: '金城 宗一郎',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
  is_temp_password: false, terms_agreed: true,
};
// 野原 太郎（C001・さくら組）の保護者
const guardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
// 上園 花子（C002）の保護者。規約に同意したあとの状態として持つ
const childGuardian: SessionUser = {
  account_id: 7, email: 'uezono.k@example.jp', role: '3', display_name: '上園 謙心',
  staff_id: null, guardian_id: 'G002', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

describe('手続きを終えるまで、ほかの API を使わせない（基本設計書「画面遷移」(3-4)）', () => {
  it('一時パスワードのままでは、手続き以外の API を理由つきで拒否し、変更すると使える', async () => {
    const temp = await api.login('miyagi@hoiku.example.jp', 'temp0901', 'staff');
    expect(temp.is_temp_password).toBe(true);

    const denied = { kind: 'password_change_required' };
    await expect(api.listChildren(temp)).rejects.toMatchObject(denied);
    await expect(api.getChild(temp, 'C001')).rejects.toMatchObject(denied);
    await expect(api.staffSummary(temp)).rejects.toMatchObject(denied);
    await expect(api.saveDiary(temp, {
      record_type: '2', child_id: null, class_id: 1, diary_date: today(), body: '作れてはならない',
    }, '1')).rejects.toMatchObject(denied);
    // 文言はそのまま利用者に見せられる。ログインの失敗のように JSON で包まない
    await expect(api.listChildren(temp)).rejects.toThrow('パスワードを変更してください');

    // 手続きそのものの API は通る
    await expect(api.currentTerms()).resolves.toBeTruthy();
    await api.changePassword(temp.account_id, 'temp0901', 'newpass1234');
    const after = await api.reloadSession(temp.account_id);
    expect(after.is_temp_password).toBe(false);
    expect((await api.listChildren(after)).length).toBeGreaterThan(0);
  });

  it('規約に同意するまでは、手続き以外の API を理由つきで拒否し、同意すると使える', async () => {
    const u = await api.login('uezono.k@example.jp', 'pass1234', 'guardian');
    expect(u.terms_agreed).toBe(false);

    const denied = { kind: 'terms_agreement_required' };
    await expect(api.guardianHome(u)).rejects.toMatchObject(denied);
    await expect(api.rooms(u)).rejects.toMatchObject(denied);
    await expect(api.getDiary(u, 4)).rejects.toMatchObject(denied);

    await api.agreeTerms(u.account_id);
    const after = await api.reloadSession(u.account_id);
    expect(after.terms_agreed).toBe(true);
    expect(await api.guardianHome(after)).toHaveLength(1);
  });

  it('両方が要るときは、パスワードの変更を先に求める', async () => {
    const both: SessionUser = { ...teacher, is_temp_password: true, terms_agreed: false };
    await expect(api.listChildren(both)).rejects.toMatchObject({ kind: 'password_change_required' });
  });
});

describe('日誌の添付（基本設計書「日誌の作成から保護者への共有」(4-5)「承認済みであっても参照範囲は広がらない」）', () => {
  // 日誌 4 は上園 花子（C002・さくら組）の個人日誌。承認済み・保護者へ共有、添付2件
  const diaryId = 4;

  it('日誌本体を見られない人には、添付も返さない', async () => {
    await expect(api.attachmentsOf(otherTeacher, diaryId)).rejects.toThrow('この日誌を参照する権限がありません');
    await expect(api.attachmentsOf(guardian, diaryId)).rejects.toThrow('この日誌を参照する権限がありません');
    await expect(api.getDiary(otherTeacher, diaryId)).rejects.toThrow('この日誌を参照する権限がありません');
  });

  it('日誌本体を見られる人には返す', async () => {
    for (const u of [admin, teacher, childGuardian]) {
      expect(await api.attachmentsOf(u, diaryId)).toHaveLength(2);
    }
  });

  it('保護者へ共有していない日誌は、自児の保護者にも本体・添付を見せない', async () => {
    const d = db.diaries.find((x) => x.diary_id === diaryId)!;
    d.is_shared_to_guardian = false;
    try {
      await expect(api.attachmentsOf(childGuardian, diaryId)).rejects.toThrow('この日誌を参照する権限がありません');
      await expect(api.getDiary(childGuardian, diaryId)).rejects.toThrow('この日誌を参照する権限がありません');
    } finally {
      d.is_shared_to_guardian = true;
    }
  });
});

describe('クラス日誌・週案のクラス（要件定義書「参照範囲の全体規定」(4-1-5)）', () => {
  const classDiary = (classId: number | null, recordType: '2' | '3' = '2'): DiaryInput => ({
    record_type: recordType, child_id: null, class_id: classId, diary_date: today(), body: 'クラスの様子',
  });

  it('一般は、他クラスのクラス日誌・週案を作成できない（下書きも申請も）', async () => {
    const before = db.diaries.length;
    await expect(api.saveDiary(teacher, classDiary(2), '1')).rejects.toThrow('このクラスの日誌を作成する権限がありません');
    await expect(api.saveDiary(teacher, classDiary(2), '2')).rejects.toThrow('このクラスの日誌を作成する権限がありません');
    await expect(api.saveDiary(teacher, classDiary(2, '3'), '1')).rejects.toThrow('このクラスの日誌を作成する権限がありません');
    expect(db.diaries.length).toBe(before);
  });

  it('一般は、クラスを指定しないクラス日誌を作れない', async () => {
    await expect(api.saveDiary(teacher, classDiary(null), '1')).rejects.toThrow('対象のクラスを選んでください');
  });

  it('自クラスなら作成でき、管理者はどのクラスでも作成できる', async () => {
    await expect(api.saveDiary(teacher, classDiary(1), '1')).resolves.toMatchObject({ class_id: 1 });
    await expect(api.saveDiary(otherTeacher, classDiary(2, '3'), '1')).resolves.toMatchObject({ class_id: 2 });
    await expect(api.saveDiary(admin, classDiary(2), '1')).resolves.toMatchObject({ class_id: 2 });
    await expect(api.saveDiary(admin, classDiary(null, '3'), '1')).resolves.toMatchObject({ class_id: null });
  });

  it('更新で他クラスへ移すことも、他クラスの日誌を書き換えることもできない', async () => {
    const own = await api.saveDiary(teacher, classDiary(1), '1');
    const others = await api.saveDiary(otherTeacher, classDiary(2), '1');

    await expect(api.saveDiary(teacher, { ...classDiary(2), diary_id: own.diary_id }, '1'))
      .rejects.toThrow('このクラスの日誌を作成する権限がありません');
    await expect(api.saveDiary(teacher, { ...classDiary(1), diary_id: others.diary_id, body: '書き換え' }, '1'))
      .rejects.toThrow('この日誌を編集する権限がありません');
    expect(db.diaries.find((d) => d.diary_id === others.diary_id)).toMatchObject({ class_id: 2, body: 'クラスの様子' });

    await expect(api.saveDiary(teacher, { ...classDiary(1), diary_id: own.diary_id, body: '書き直し' }, '1'))
      .resolves.toMatchObject({ body: '書き直し' });
  });
});

describe('園児の所属クラス（基本設計書「権限チェックの実装方針」(6-2)）', () => {
  it('参照できない園児の所属クラスは返さない', async () => {
    await expect(api.classOf(guardian, 'C013')).rejects.toThrow('この園児を参照する権限がありません');
    await expect(api.classOf(teacher, 'C013')).rejects.toThrow('この園児を参照する権限がありません');
  });

  it('参照できる園児なら返す', async () => {
    await expect(api.classOf(guardian, 'C001')).resolves.toBe(1);
    await expect(api.classOf(teacher, 'C001')).resolves.toBe(1);
    await expect(api.classOf(admin, 'C013')).resolves.toBe(2);
  });
});

describe('既存の日誌の更新と編集ロック（GitHub Issue #153 の追記）', () => {
  // 日誌 1 は高梨（さくら組）の下書き。野原 太郎（C001）の個人日誌
  const rewrite = (patch: Partial<DiaryInput>): DiaryInput => ({
    diary_id: 1, record_type: '2', child_id: null, class_id: 2, diary_date: today(), body: '書き換え', ...patch,
  });
  const expectUnchanged = () => expect(db.diaries.find((d) => d.diary_id === 1))
    .toMatchObject({ record_type: '1', child_id: 'C001', class_id: 1, status: '1' });

  it('担当外の職員は、他クラスの下書きを自クラスの日誌として書き換えて申請できない', async () => {
    await expect(api.saveDiary(otherTeacher, rewrite({}), '2')).rejects.toThrow('この日誌を編集する権限がありません');
    expectUnchanged();
  });

  it('見える日誌でも、種類や園児・クラスを変えて範囲の外へ持ち出せない', async () => {
    await expect(api.saveDiary(teacher, rewrite({}), '1')).rejects.toThrow('このクラスの日誌を作成する権限がありません');
    await expect(api.saveDiary(teacher, rewrite({ record_type: '1', child_id: 'C013' }), '1'))
      .rejects.toThrow('この園児の日誌を作成する権限がありません');
    await expect(api.saveDiary(teacher, rewrite({ record_type: '4', child_id: 'C013', class_id: 1 }), '1'))
      .rejects.toThrow('この園児の日誌を作成する権限がありません');
    expectUnchanged();
  });

  it('担当外の日誌のロックは取れず、誰が編集中かも見えない', async () => {
    await expect(api.acquireLock(otherTeacher, 1)).rejects.toThrow('この日誌を編集する権限がありません');
    await expect(api.acquireLock(otherTeacher, 4)).rejects.toThrow('この日誌を編集する権限がありません');
    // 日誌 2（さくら組のクラス日誌）は宮城 蓮がロックを持っている
    await expect(api.lockOf(otherTeacher, 2)).rejects.toThrow('この日誌を参照する権限がありません');
    expect(db.diaryLocks.some((l) => l.locked_staff_id === 'S005')).toBe(false);
  });

  it('担任はロックを取れ、誰が編集中かも見える', async () => {
    await expect(api.acquireLock(teacher, 1)).resolves.toHaveProperty('token');
    await expect(api.lockOf(teacher, 2)).resolves.toMatchObject({ staff_name: '宮城 蓮' });
  });
});
