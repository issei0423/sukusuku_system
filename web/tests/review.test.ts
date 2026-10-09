/*
 * PR #92 の評価で見つけた指摘のテスト（GitHub Issue #95〜#100・#102）
 * 典拠：要件定義書「対象権限列の読み方」(4-2 冒頭)・「園児と保護者の紐づけ」(4-1-2)
 *      基本設計書「午睡チェックの実施」(4-7)・「チャット」(5-5)
 *
 * ここで確かめる規則は、Go サーバ（server/）にも同じものがある。片方だけを直すと食い違う。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today, addDays } from '../src/api/util';

const admin: SessionUser = {
  account_id: 1, email: 'takahashi@hoiku.example.jp', role: '1', display_name: '高橋 美咲',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'yamada@hoiku.example.jp', role: '2', display_name: '山田 花子',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
// ひまわり組（class_id 2）の担任
const otherTeacher: SessionUser = {
  account_id: 5, email: 'tanaka@hoiku.example.jp', role: '2', display_name: '田中 陽子',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
  is_temp_password: false, terms_agreed: true,
};
// 山田 太郎（C001）の保護者。個人チャットは chat_room_id 6
const guardian: SessionUser = {
  account_id: 6, email: 'yamada.k@example.jp', role: '3', display_name: '山田 健一',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
// 鈴木 花子（C002）の保護者。山田 太郎の個人チャットには参加していない
const otherGuardian: SessionUser = {
  account_id: 7, email: 'suzuki.m@example.jp', role: '3', display_name: '鈴木 美和',
  staff_id: null, guardian_id: 'G002', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

describe('チャットのメンバー一覧（GitHub Issue #95）', () => {
  it('参加していないチャンネルのメンバーは取得できない', async () => {
    await expect(api.members(6, otherGuardian)).rejects.toThrow('このチャンネルを参照する権限がありません');
    await expect(api.members(6, otherTeacher)).rejects.toThrow('このチャンネルを参照する権限がありません');
  });

  it('参加している人と管理者は取得できる', async () => {
    expect((await api.members(6, guardian)).length).toBeGreaterThan(0);
    expect((await api.members(6, teacher)).length).toBeGreaterThan(0);
    expect((await api.members(6, admin)).length).toBeGreaterThan(0);
  });
});

describe('午睡チェック（GitHub Issue #96・#97）', () => {
  it('一般の保育士は、担当ではないクラスの午睡チェックを開始・参照できない', async () => {
    await expect(api.startSession(teacher, 2, today())).rejects.toThrow('開始する権限がありません');
    await expect(api.activeSession(2, today(), teacher)).rejects.toThrow('参照する権限がありません');
    await expect(api.classState(teacher, 2, null)).rejects.toThrow('参照する権限がありません');
    // 管理者は全クラスを扱える
    await expect(api.activeSession(2, today(), admin)).resolves.toBeDefined();
  });

  it('過去の日付では開始できず、実施の行も増えない', async () => {
    const before = db.napSessions.length;
    await expect(api.startSession(teacher, 1, addDays(today(), -1))).rejects.toThrow('当日のぶんだけ開始できます');
    expect(db.napSessions.length).toBe(before);
  });

  it('終了した実施へは記録できない', async () => {
    const s = await api.startSession(otherTeacher, 2, today());
    const child = db.classChildren.find((cc) => cc.class_id === 2)!.child_id;
    const input = { child_id: child, body_position: '1', breathing: '1', complexion: '1', temperature: null } as const;
    await expect(api.record(otherTeacher, s.nap_session_id, input)).resolves.toBeTruthy();

    await api.endSession(otherTeacher, s.nap_session_id);
    const count = db.napRecords.length;
    await expect(api.record(otherTeacher, s.nap_session_id, input)).rejects.toThrow('この午睡チェックは終了しています');
    expect(db.napRecords.length).toBe(count);
  });
});

describe('メッセージの取消とリアクション（GitHub Issue #98・#100）', () => {
  it('取り消したメッセージは、もう一度取り消せない。操作ログも増えない', async () => {
    const m = await api.send(teacher, 6, '取り消すメッセージ');
    await api.retract(teacher, m.chat_message_id);
    const deletedAt = db.chatMessages.find((x) => x.chat_message_id === m.chat_message_id)!.deleted_at;
    const logs = db.operationLogs.filter((l) => l.target_table === 't_chat_message' && l.target_id === m.chat_message_id).length;

    await expect(api.retract(teacher, m.chat_message_id)).rejects.toThrow('すでに取り消されています');
    expect(db.chatMessages.find((x) => x.chat_message_id === m.chat_message_id)!.deleted_at).toBe(deletedAt);
    expect(db.operationLogs.filter((l) => l.target_table === 't_chat_message' && l.target_id === m.chat_message_id).length)
      .toBe(logs);
  });

  it('後から登録した保護者は、登録より前のメッセージにリアクションを付けられない', async () => {
    const old = db.chatMessages.find((m) => m.chat_room_id === 6 && !m.is_deleted)!;
    const code = await api.issueOneInvitationCode(admin, 'C001', 30);
    const late = await api.signUpGuardian({
      code, email: 'late.review@example.jp', password: 'pass12345', guardian_name: '山田 節子', relationship: '祖母',
    });
    await expect(api.toggleReaction(late, old.chat_message_id, '1')).rejects.toThrow('メッセージが見つかりません');
    // 先に登録していた保護者は付けられる
    await expect(api.toggleReaction(guardian, old.chat_message_id, '1')).resolves.toBeUndefined();
    await api.toggleReaction(guardian, old.chat_message_id, '1');
  });

  it('登録と同じ秒に送られたメッセージは、後から登録した保護者に見せない', async () => {
    // 送信と登録を続けて行う。時刻は秒の単位のため、同じ秒に入ることがある（GitHub Issue #102）
    await api.send(teacher, 6, '登録の直前のメッセージ');
    const code = await api.issueOneInvitationCode(admin, 'C001', 30);
    const late = await api.signUpGuardian({
      code, email: 'late.same@example.jp', password: 'pass12345', guardian_name: '山田 茂', relationship: '祖父',
    });
    expect(await api.messages(late, 6)).toHaveLength(0);
  });

  it('配布物を取り下げても、誤送信対応の「対応の記録がない取消メッセージ」には出ない', async () => {
    const before = (await api.retractedWithoutRecord()).length;
    const posted = await api.postHandout(admin, {
      handout_type: '1', title: '試験用の園だより', target_month: today().slice(0, 7), class_id: null,
      file_name: 'test.pdf', file_type: 'application/pdf', file_size: 1024,
    });
    await api.withdrawHandout(admin, posted.handout_id);
    expect((await api.retractedWithoutRecord()).length).toBe(before);
  });
});

describe('招待コードの有効日数（GitHub Issue #100）', () => {
  it('1〜365 日の外は発行できない', async () => {
    const before = db.invitationCodes.length;
    await expect(api.issueOneInvitationCode(admin, 'C001', 0)).rejects.toThrow('有効期限は 1〜365 日');
    await expect(api.issueOneInvitationCode(admin, 'C001', -5)).rejects.toThrow('有効期限は 1〜365 日');
    await expect(api.issueOneInvitationCode(admin, 'C001', 366)).rejects.toThrow('有効期限は 1〜365 日');
    await expect(api.issueInvitationCodes(admin, 3, 1, 0)).rejects.toThrow('有効期限は 1〜365 日');
    expect(db.invitationCodes.length).toBe(before);
  });

  it('範囲の中なら発行でき、期限は発行日より後になる', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C001', 1);
    const row = db.invitationCodes.find((c) => c.code === code)!;
    expect(row.expires_on > today()).toBe(true);
  });
});
