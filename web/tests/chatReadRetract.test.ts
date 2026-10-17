/*
 * チャットの既読・届く人数・取消・グループ編成の一覧（GitHub Issue #171・#172・#141）
 * 典拠：基本設計書「既読確認」(4-6)・「誤送信への対応」(4-6)・「チャット」(5-5)
 *      要件定義書「チャットツール」(4-3)「既読確認」「メッセージの削除」
 *      図/画面詳細図.md「チャット画面（職員）」(4-1) No.19・「グループ編成画面」(4-3)・「誤送信対応記録画面」(4-4)
 *
 * ここで確かめる規則は、Go サーバ（server/api_chat.go）にも同じものがある。
 * server/api_chat_read_retract_test.go が同じ観点を確かめている。片方だけを直すと食い違う。
 *
 * デモデータのチャンネル：1 園全体、2 職員、3 さくら組、5 運動会実行委員（目的別）、6〜9 さくら組の個人チャット。
 * アカウント：1・2 管理者、3・4 さくら組の担任、5 ひまわり組の担任、6〜10 保護者（8 は停止中）
 */
import { describe, it, expect, vi } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: '1' | '2' | '3', email: string, extra: Partial<SessionUser> = {}): SessionUser => ({
  account_id, email, role, display_name: email, staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', 'nohara@hoiku.example.jp', { staff_id: 'S001' });
const uezono = user(2, '1', 'uezono@hoiku.example.jp', { staff_id: 'S002' });
const teacher = user(3, '2', 'takanashi@hoiku.example.jp', { staff_id: 'S003', class_id: 1 });
const kinjo = user(5, '2', 'kinjo@hoiku.example.jp', { staff_id: 'S005', class_id: 2 });
const nohara = user(6, '3', 'nohara.i@example.jp', { guardian_id: 'G001' });
const miyagi = user(9, '3', 'miyagi.r@example.jp', { guardian_id: 'G004' });

const messagesOf = async (viewer: SessionUser, roomId: number) =>
  new Map((await api.messages(viewer, roomId)).map((m) => [m.chat_message_id, m]));
const guardianCounts = async (viewer: SessionUser) =>
  new Map((await api.rooms(viewer)).map((r) => [r.room.chat_room_id, r.guardianCount]));
const memberIds = async (viewer: SessionUser, roomId: number) =>
  (await api.members(roomId, viewer)).map((m) => m.account_id);

describe('後から登録した保護者は、見えない登録前のメッセージを既読にしない（GitHub Issue #171 の 1）', () => {
  it('開いても、登録より前のメッセージは既読にならない。登録のあとに届いたものは既読になる', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C002', 14);
    const haha = await api.signUpGuardian({
      code, email: 'uezono.haha@example.jp', password: 'uezono-5678', guardian_name: '上園 母', relationship: '母',
    });
    expect(await api.messages(haha, 7)).toHaveLength(0);
    // 保護者のチャット画面は、チャンネルを開くとこれを呼ぶ
    await api.markRead(haha, 7);
    expect(db.chatReads.some((r) => r.chat_message_id === 7 && r.account_id === haha.account_id)).toBe(false);
    expect((await messagesOf(teacher, 7)).get(7)?.read_count).toBe(0);

    // 登録と同じ秒に送られたものは見せない側へ倒すため、時計を進めてから送る
    vi.advanceTimersByTime(5_000);
    const sent = await api.send(teacher, 7, 'ご登録ありがとうございます。');
    await api.markRead(haha, 7);
    expect((await messagesOf(teacher, 7)).get(sent.chat_message_id)?.read_count).toBe(1);
  });
});

describe('「保護者 n 名にも届きます」の n とメンバー欄に、停止した保護者を入れない（GitHub Issue #171 の 2・#141 の 4）', () => {
  it('停止中の保護者は数えず、紐づけを終えて停止した保護者も減る。戻すとまた数える', async () => {
    // 同じファイルの前のテストで保護者が増えていることがあるため、件数は始めの値からの増減で見る
    // アカウント 8（高梨 倫太朗）は紐づけを終えて停止しているが、園全体の参加の行は残っている
    expect(db.chatMembers.some((m) => m.chat_room_id === 1 && m.account_id === 8 && m.left_at === null)).toBe(true);
    expect(await memberIds(teacher, 1)).not.toContain(8);
    const before = await guardianCounts(teacher);
    const guardiansListed = (await api.members(1, teacher)).filter((m) => m.role === '3').length;
    expect(before.get(1)).toBe(guardiansListed);

    await api.endGuardianLink(admin, 'G005', 'C005');
    const counts = await guardianCounts(teacher);
    expect(counts.get(1)).toBe(before.get(1)! - 1);
    expect(counts.get(3)).toBe(before.get(3)! - 1);
    expect(counts.get(9)).toBe(0);
    for (const room of [1, 3, 9]) expect(await memberIds(teacher, room)).not.toContain(10);

    await api.restoreGuardianLink(admin, 'G005', 'C005');
    const restored = await guardianCounts(teacher);
    expect(restored.get(1)).toBe(before.get(1));
    expect(restored.get(9)).toBe(1);
  });
});

describe('既読の人数（GitHub Issue #171 の 5）', () => {
  it('保護者が参加するチャンネルでは、保護者の既読だけを数える', async () => {
    // さくら組の「9時に園庭でお願いします。」（ID 3）は、職員 3 名が読み、保護者は誰も読んでいない
    expect((await messagesOf(teacher, 3)).get(3)?.read_count).toBe(0);
    await api.markRead(nohara, 3);
    expect((await messagesOf(teacher, 3)).get(3)?.read_count).toBe(1);
  });

  it('職員だけのチャンネルでは、職員の既読を数える', async () => {
    await api.markRead(teacher, 2);
    expect((await messagesOf(uezono, 2)).get(8)?.read_count).toBe(1);
  });
});

describe('送信者が職員か保護者かを返す（GitHub Issue #141 の 1）', () => {
  it('職員の画面にも保護者の画面にも、送信者のロールを添える', async () => {
    for (const viewer of [teacher, nohara]) {
      const got = await messagesOf(viewer, 6);
      expect(got.get(4)?.sender_role).toBe('2');
      expect(got.get(5)?.sender_role).toBe('3');
    }
  });
});

describe('保護者が自分で取り消したメッセージは、誤送信対応の対象に並べない（GitHub Issue #171 の 4）', () => {
  it('保護者の取消は並ばず、職員の取消は並ぶ', async () => {
    const byGuardian = await api.send(miyagi, 8, '明日はお休みします（打ちまちがい）');
    await api.retract(miyagi, byGuardian.chat_message_id);
    const byStaff = await api.send(teacher, 8, '（誤送信）野原 太郎くんの発熱の記録');
    await api.retract(teacher, byStaff.chat_message_id);

    const pending = (await api.retractedWithoutRecord()).map((r) => r.chat_message_id);
    expect(pending).not.toContain(byGuardian.chat_message_id);
    expect(pending).toContain(byStaff.chat_message_id);
  });
});

describe('グループ編成画面に並べるグループ（GitHub Issue #172 の 4）', () => {
  it('一般の職員には、いま参加しているグループだけを返す。管理者にはすべて返す', async () => {
    const created = await api.createGroup(teacher, 'G 遠足下見（高梨・宮城）', [4]);
    const ids = async (viewer: SessionUser) => (await api.groups(viewer)).map((g) => g.chat_room_id);

    expect(await ids(kinjo)).toContain(5);
    expect(await ids(kinjo)).not.toContain(created.chat_room_id);
    expect(await ids(admin)).toEqual(expect.arrayContaining([5, created.chat_room_id]));

    // 外されたグループは、編成できないので出さない
    await api.updateGroupMembers(admin, 5, [1, 3]);
    expect(await ids(kinjo)).not.toContain(5);
  });
});
