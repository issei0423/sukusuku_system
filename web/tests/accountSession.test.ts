/*
 * アカウントとログイン中の利用（GitHub Issue #159）・保護者の新規登録（GitHub Issue #163）
 * 典拠：基本設計書.md「共通基盤：ログインとアカウント」(4-3)・「認証情報の保持方式」(6-3)・
 *      「パスワードの要件」(6-3)・「入力項目の制約値とメッセージ一覧」(4-9)・「チャット」(5-5)
 *
 * Go サーバ側（server/api_account_session_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 * 業務の規則を2か所に持っているため、片方だけを直すと食い違う（MOCKUP.md）。
 *
 * モックはセッションを持たない（引数の利用者がセッションの代わり）。そのため「ほかの端末のセッションを切る」は
 * 確かめられない。停止中・紐づけの無いアカウントの利用者を、呼ばれるたびに断ることを確かめる。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, onSessionEnded } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { now, plusMinutes, today } from '../src/api/util';
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
const himawariTeacher: SessionUser = {
  account_id: 5, email: 'kinjo@hoiku.example.jp', role: '2', display_name: '金城 宗一郎',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
  is_temp_password: false, terms_agreed: true,
};
// 野原 太郎（C001・さくら組）の保護者
const noharaGuardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
// 宮城 美咲（C004・さくら組）の保護者
const miyagiGuardian: SessionUser = {
  account_id: 9, email: 'miyagi.r@example.jp', role: '3', display_name: '宮城 蓮',
  staff_id: null, guardian_id: 'G004', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

const roomIds = async (u: SessionUser) => (await api.rooms(u)).map((v) => v.room.chat_room_id);

afterEach(() => { vi.restoreAllMocks(); });

describe('停止・紐づけの解除のあとは、ログインしていた利用者を通さない（GitHub Issue #159 の 1）', () => {
  it('停止した職員は、読むことも書くこともできず、画面へ「セッションが終わった」と知らせる', async () => {
    const ended = vi.fn();
    const stop = onSessionEnded(ended);
    await expect(api.listChildren(teacher)).resolves.not.toHaveLength(0);

    await api.setAccountStatus(admin, 3, '2');
    await expect(api.listChildren(teacher)).rejects.toThrow('ログインしていません');
    await expect(api.send(teacher, 2, '退職後の投稿')).rejects.toThrow('ログインしていません');
    expect(ended).toHaveBeenCalled();
    stop();

    // ほかの職員には影響しない
    await expect(api.listChildren(himawariTeacher)).resolves.not.toHaveLength(0);
    await api.setAccountStatus(admin, 3, '1');
  });

  it('有効な紐づけがゼロになった保護者は、個人チャットを読み書きできない', async () => {
    await api.endGuardianLink(admin, 'G001', 'C001');
    await expect(api.rooms(noharaGuardian)).rejects.toThrow('ログインしていません');
    await expect(api.messages(noharaGuardian, 6)).rejects.toThrow('ログインしていません');
    await expect(api.send(noharaGuardian, 6, '解除後の投稿')).rejects.toThrow('ログインしていません');
    await api.restoreGuardianLink(admin, 'G001', 'C001');
  });

  it('きょうだいの紐づけが残る保護者は、解除した園児の個人チャットだけを参照できなくなり、戻すと戻る', async () => {
    // 宮城 美咲（C004）の保護者に、きょうだいとして伊藤 葵（C006、同じさくら組）を足す
    db.guardianChildren.push({
      guardian_id: 'G004', child_id: 'C006', relationship: '父', link_status: '1',
      linked_at: '2026-04-01T09:00:00', ended_at: null,
    });
    const personalRoom = 8; // 宮城 美咲の保護者
    const classRoom = 3;    // さくら組
    expect(await roomIds(miyagiGuardian)).toEqual(expect.arrayContaining([personalRoom, classRoom]));

    await api.endGuardianLink(admin, 'G004', 'C004');
    const rooms = await roomIds(miyagiGuardian);
    expect(rooms).not.toContain(personalRoom);
    expect(rooms).toContain(classRoom);
    await expect(api.messages(miyagiGuardian, personalRoom)).rejects.toThrow();
    await expect(api.send(miyagiGuardian, personalRoom, '解除後の投稿')).rejects.toThrow();

    await api.restoreGuardianLink(admin, 'G004', 'C004');
    expect(await roomIds(miyagiGuardian)).toContain(personalRoom);
    await expect(api.messages(miyagiGuardian, personalRoom)).resolves.toBeTruthy();
  });
});

describe('一時パスワードの有効期限（GitHub Issue #159 の 2）', () => {
  const miyagi = () => db.accounts.find((a) => a.account_id === 4)!;

  it('デモの一時パスワードは、起動した日から見て期限内にずらしてある', () => {
    expect(miyagi().temp_password_expires_at! > now()).toBe(true);
  });

  it('期限の切れた一時パスワードでは、正しくてもログインできない。誤ったパスワードでは期限切れを明かさない', async () => {
    const before = miyagi().temp_password_expires_at;
    miyagi().temp_password_expires_at = plusMinutes(now(), -1);
    await expect(api.login('miyagi@hoiku.example.jp', 'temp0901', 'staff')).rejects.toThrow(/temp_expired/);
    await expect(api.login('miyagi@hoiku.example.jp', 'wrong-pass', 'staff')).rejects.toThrow(/credential/);
    miyagi().temp_password_expires_at = before;
    miyagi().failed_login_count = 0;
  });
});

describe('保護者ホームは保護者だけが使える（GitHub Issue #159 の 3）', () => {
  it('職員が呼ぶと断る', async () => {
    await expect(api.guardianHome(admin)).rejects.toThrow(/保護者/);
    await expect(api.guardianHome(miyagiGuardian)).resolves.toBeTruthy();
  });
});

describe('パスワードの長さとよく使われるパスワード（GitHub Issue #159 の 4）', () => {
  it('文字数で 8〜128 文字。よく使われるパスワードは拒否する', async () => {
    await expect(api.changePassword(5, 'pass1234', 'あいう')).rejects.toThrow('8文字以上');
    await expect(api.changePassword(5, 'pass1234', 'password')).rejects.toThrow('よく使われる');
    await expect(api.changePassword(5, 'pass1234', 'Password1')).rejects.toThrow('よく使われる');
    await expect(api.changePassword(5, 'pass1234', 'a'.repeat(129))).rejects.toThrow('128文字以内');
    await api.changePassword(5, 'pass1234', 'ひ'.repeat(25));
    await api.changePassword(5, 'ひ'.repeat(25), 'pass1234');
  });

  it('新規登録でも同じ規則にする', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C008', 30);
    const input = { code, email: 'rule@example.jp', guardian_name: '小林 次郎', relationship: '父' };
    await expect(api.signUpGuardian({ ...input, password: 'password' })).rejects.toThrow('よく使われる');
    await expect(api.signUpGuardian({ ...input, password: 'あいう' })).rejects.toThrow('8文字以上');
    await expect(api.signUpGuardian({ ...input, password: 'a'.repeat(129) })).rejects.toThrow('128文字以内');
  });
});

describe('停止中であることは、正しいパスワードのときだけ示す（GitHub Issue #159 の 5）', () => {
  it('誤ったパスワードでは、ほかの失敗と同じ応答にする', async () => {
    await expect(api.login('takanashi.r@example.jp', 'wrong-password', 'guardian')).rejects.toThrow(/credential/);
    await expect(api.login('takanashi.r@example.jp', 'pass1234', 'guardian')).rejects.toThrow(/suspended/);
  });
});

describe('個人チャットは園児ID で結ぶ（GitHub Issue #163 の 1）', () => {
  it('同じ氏名の別の園児の保護者は、その家庭の個人チャットに入らない。日誌の共有も流れない', async () => {
    await api.saveChild(admin, {
      child_id: 'C023', child_name: '野原 太郎', child_name_kana: 'のはら たろう', birth_date: '2024-05-01',
      sex: '1', normal_temperature: null, photo_consent_level: '2', class_id: 2, allergies: [], medical_histories: [],
    }, 'create');
    const code = await api.issueOneInvitationCode(admin, 'C023', 30);
    const hanako = await api.signUpGuardian({
      code, email: 'other.nohara@example.jp', password: 'hanako-5678', guardian_name: '野原 花子', relationship: '母',
    });
    expect(await roomIds(hanako)).not.toContain(6);
    await expect(api.messages(hanako, 6)).rejects.toThrow();
    await expect(api.send(hanako, 6, '明日はお休みします')).rejects.toThrow();

    const before = db.chatMessages.filter((m) => m.chat_room_id === 6).length;
    const d = await api.saveDiary(himawariTeacher, {
      record_type: '1', child_id: 'C023', class_id: 2, diary_date: today(), body: 'ひまわり組の太郎くんの記録',
    }, '2');
    await api.approveDiary(admin, d.diary_id, true);
    expect(db.chatMessages.filter((m) => m.chat_room_id === 6)).toHaveLength(before);
  });

  it('元の家庭（C001）の新しい保護者は、これまでどおり C001 の個人チャットへ入る', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C001', 30);
    const mama = await api.signUpGuardian({
      code, email: 'nohara.m@example.jp', password: 'mama-5678-x', guardian_name: '野原 みさえ', relationship: '母',
    });
    expect(await roomIds(mama)).toContain(6);
  });
});

describe('招待コード 1 枚は 1 アカウント（GitHub Issue #163 の 2）', () => {
  it('同じコードで同時に登録しても、1 件だけが通る', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C010', 30);
    const results = await Promise.allSettled([0, 1, 2, 3, 4].map((i) => api.signUpGuardian({
      code, email: `dup${i}@example.jp`, password: 'dup-pass-5678', guardian_name: '吉田 次郎', relationship: '父',
    })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.guardianChildren.filter((gc) => gc.child_id === 'C010' && gc.link_status === '1')).toHaveLength(1);
  });
});

describe('サーバにセッションを切られたら、画面へ知らせる（api/http.ts）', () => {
  it('ログインしたまま 401 を受けたら、セッションが終わったことを知らせる', async () => {
    const http = await import('../src/api/http');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'ログインしていません' }), { status: 401 })));
    const ended = vi.fn();
    const stop = onSessionEnded(ended);
    await expect(http.api.listChildren(teacher)).rejects.toThrow('ログインしていません');
    expect(ended).toHaveBeenCalledTimes(1);
    stop();
    vi.unstubAllGlobals();
  });

  it('ログインの失敗（401）では知らせない。まだログインしていないため', async () => {
    const http = await import('../src/api/http');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ kind: 'credential', remaining: 4, message: 'ログインIDまたはパスワードが違います' }), { status: 401 })));
    const ended = vi.fn();
    const stop = onSessionEnded(ended);
    await expect(http.api.login('nobody@example.jp', 'x', 'staff')).rejects.toThrow(/credential/);
    expect(ended).not.toHaveBeenCalled();
    stop();
    vi.unstubAllGlobals();
  });
});
