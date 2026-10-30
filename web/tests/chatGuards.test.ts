/*
 * チャットの送る時点と見る範囲の守りのテスト
 *   GitHub Issue #299（他児の名前の注意）・#308（猶予中の保護者）・#301（登録と同じ秒）・#312 の 1（管理者のチャンネル一覧）
 *   ・#270 の 1（発達チェックの保護者へのひとこと）・#310（符号位置で数える）
 * 典拠：基本設計書「送る時点の守り」(4-2)・「メッセージの送受信」(4-7)・「メッセージの編集」(4-7)・「メッセージ一覧」(4-12)、
 *      詳細設計書「チャット画面（職員・保護者）」(2-9 (5))・「検査の共通の規則」(4-1 (5))・「発達チェックの保存」(4-12 (2))、
 *      要件定義書「過去ログの参照範囲」(4-4 (c))
 *
 * ここで確かめる規則は、Go サーバ（server/api_chat.go・api_dev_write.go）にも同じものがある。
 * server/api_chat_guards_test.go が同じ観点を確かめている。片方だけを直すと食い違う。
 *
 * デモデータのチャンネル：1 園全体、2 職員、3 さくら組、5 運動会実行委員（目的別）、6 西田 太郎（C001）の個人チャット。
 * アカウント：1 管理者、3 さくら組の担任、5 ひまわり組の担任、6 西田 太郎の保護者（G001）、9・10 別の保護者
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const staff = (accountId: number, role: '1' | '2', staffId: string, name: string, classId: number | null): SessionUser => ({
  account_id: accountId, email: `${staffId}@example.jp`, role, display_name: name,
  staff_id: staffId, guardian_id: null, class_id: classId, class_name: null, is_temp_password: false, terms_agreed: true,
});
const guardianOf = (accountId: number, guardianId: string): SessionUser => ({
  account_id: accountId, email: `${guardianId}@example.jp`, role: '3', display_name: guardianId,
  staff_id: null, guardian_id: guardianId, class_id: null, class_name: null, is_temp_password: false, terms_agreed: true,
});
const admin = staff(1, '1', 'S001', '西田 拓也', null);
const teacher = staff(3, '2', 'S003', '鈴木 浩之', 1);
const otherTeacher = staff(5, '2', 'S005', '久保田 和也', 2);
const guardian = guardianOf(6, 'G001');

const OTHER = '今日は村田 美咲さんと遊びました';
const NAME = '村田 美咲';
const GRACE = '卒園・退園したお子さまのやりとりは、読むことだけができます。';
const countOf = (room: number, body: string) => db.chatMessages.filter((m) => m.chat_room_id === room && m.body === body).length;

describe('保護者の参加するチャンネルへ職員が送るときは、他児の名前の注意を通る（Issue #299）', () => {
  it('個人チャット：宛先以外の在籍園児の名前に当たると止まり、承諾を付けると送れる', async () => {
    await expect(api.send(teacher, 6, OTHER)).rejects.toMatchObject({ kind: 'other_child_names', names: [NAME] });
    expect(countOf(6, OTHER)).toBe(0);
    await api.send(teacher, 6, OTHER, [NAME]);
    expect(countOf(6, OTHER)).toBe(1);
    // 宛先の園児の名前では止まらない
    await api.send(teacher, 6, '今日の西田 太郎さんは元気でした');
  });

  it('クラスグループ・園チャットは在籍園児の全員が相手。職員だけのチャンネルと保護者の送信は照合しない', async () => {
    await expect(api.send(teacher, 3, '今日は西田 太郎さんが')).rejects.toMatchObject({ kind: 'other_child_names' });
    await expect(api.send(admin, 1, OTHER)).rejects.toMatchObject({ kind: 'other_child_names' });
    await api.send(admin, 1, OTHER, [NAME]);
    await api.send(admin, 2, OTHER);
    await api.send(admin, 5, OTHER);
    await api.send(guardian, 6, `${OTHER}（保護者から）`);
  });

  it('編集を保存するときも通る。保護者の編集は通らない', async () => {
    const sent = await api.send(teacher, 6, '編集の前');
    await expect(api.edit(teacher, sent.chat_message_id, OTHER)).rejects.toMatchObject({ kind: 'other_child_names', names: [NAME] });
    expect(db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!.body).toBe('編集の前');
    await api.edit(teacher, sent.chat_message_id, OTHER, [NAME]);
    expect(db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!.body).toBe(OTHER);
    const mine = await api.send(guardian, 6, '保護者から');
    await api.edit(guardian, mine.chat_message_id, OTHER);
  });
});

describe('文字数は符号位置で数える（Issue #310）', () => {
  it('4バイトの字を含む 1,000 文字は送れ、1,001 文字は送る・直すとも断る', async () => {
    const exactly = '𠮷'.repeat(1000);
    const over = '𠮷'.repeat(1001);
    await api.send(teacher, 6, exactly);
    await expect(api.send(teacher, 6, over)).rejects.toThrow('1,000文字以内');
    const sent = await api.send(teacher, 6, '編集の前2');
    await expect(api.edit(teacher, sent.chat_message_id, over)).rejects.toThrow('1,000文字以内');
    expect(db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!.body).toBe('編集の前2');
    await api.edit(teacher, sent.chat_message_id, exactly);
    expect([...db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!.body]).toHaveLength(1000);
  });
});

describe('登録と同じ秒のやりとりは、最初でない保護者に見せない（Issue #301）', () => {
  it('最初の保護者は (最初の参加の日時, アカウントID) の順で決める', async () => {
    const room = Math.max(...db.chatRooms.map((r) => r.chat_room_id)) + 1;
    db.chatRooms.push({ chat_room_id: room, room_type: '4', class_id: 1, room_name: '同じ秒の部屋', is_archived: false, thread_status: '2', child_id: null } as typeof db.chatRooms[number]);
    const at = '2026-10-01T10:00:05';
    [[3, '2026-10-01T09:00:00'], [9, at], [10, at]].forEach(([acc, joined]) =>
      db.chatMembers.push({ chat_room_id: room, account_id: acc as number, joined_at: joined as string, left_at: null }));
    let id = Math.max(...db.chatMessages.map((m) => m.chat_message_id)) + 1;
    [[3, '入園の前の案内', '2026-10-01T10:00:00'], [9, '先の保護者の相談', at], [3, '先の保護者への返事', at], [3, '登録のあと', '2026-10-01T10:00:06']]
      .forEach(([sender, body, sentAt]) => db.chatMessages.push({
        chat_message_id: id++, chat_room_id: room, sender_account_id: sender as number, body: body as string, source_type: '1',
        source_id: null, sent_at: sentAt as string, edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null,
      }));
    const bodies = async (acc: number, g: string) => (await api.messages(guardianOf(acc, g), room)).map((m) => m.body);
    expect(await bodies(9, 'G004')).toHaveLength(4);
    expect((await bodies(10, 'G005')).join('|')).toBe('入園の前の案内|登録のあと');
    const unread = async (acc: number, g: string) => (await api.rooms(guardianOf(acc, g))).find((r) => r.room.chat_room_id === room)!.unread;
    expect([await unread(9, 'G004'), await unread(10, 'G005')]).toEqual([3, 2]);
    // アカウントID の大小ではなく、最初の参加の日時が先なら先
    const b = db.chatMembers.find((m) => m.chat_room_id === room && m.account_id === 10)!;
    b.joined_at = '2026-10-01T10:00:04';
    b.first_joined_at = '2026-10-01T10:00:04';
    expect(await bodies(10, 'G005')).toHaveLength(4);
  });
});

describe('管理者には、参加していないグループも読み取りだけで見せる（Issue #312 の 1）', () => {
  it('閲覧のみ・未読なし。個人チャットは参加の行があるものだけ。ほかの職員・保護者には出ない', async () => {
    const room = Math.max(...db.chatRooms.map((r) => r.chat_room_id)) + 1;
    db.chatRooms.push({ chat_room_id: room, room_type: '2', class_id: 1, room_name: '2025年度さくら組', is_archived: true, thread_status: null, child_id: null } as typeof db.chatRooms[number]);
    [3, 6].forEach((acc) => db.chatMembers.push({ chat_room_id: room, account_id: acc, joined_at: '2025-04-01T08:00:00', left_at: '2026-03-31T23:59:59' }));
    db.chatMessages.push({
      chat_message_id: Math.max(...db.chatMessages.map((m) => m.chat_message_id)) + 1, chat_room_id: room, sender_account_id: 3,
      body: '過年度のお知らせ', source_type: '1', source_id: null, sent_at: '2026-03-10T10:00:00', edited_at: null,
      is_deleted: false, deleted_at: null, deleted_account_id: null,
    });
    const personal = room + 1;
    db.chatRooms.push({ chat_room_id: personal, room_type: '4', class_id: 1, room_name: '参加していない個人チャット', is_archived: false, thread_status: '2', child_id: null } as typeof db.chatRooms[number]);

    const v = (await api.rooms(admin)).find((r) => r.room.chat_room_id === room)!;
    expect(v).toMatchObject({ left: true, canPost: false, unread: 0 });
    expect((await api.rooms(admin)).some((r) => r.room.chat_room_id === personal)).toBe(false);
    expect((await api.messages(admin, room)).map((m) => m.body)).toEqual(['過年度のお知らせ']);
    await expect(api.messages(admin, personal)).rejects.toThrow('権限がありません');
    await expect(api.send(admin, room, '管理者の投稿')).rejects.toThrow();

    expect((await api.rooms(otherTeacher)).some((r) => r.room.chat_room_id === room)).toBe(false);
    await expect(api.messages(otherTeacher, room)).rejects.toThrow('権限がありません');
    expect((await api.rooms(guardian)).some((r) => r.room.chat_room_id === room)).toBe(false);
    await expect(api.messages(guardian, room)).rejects.toThrow();
    expect((await api.rooms(teacher)).find((r) => r.room.chat_room_id === room)).toMatchObject({ left: true, canPost: false });
  });
});

describe('発達チェックを確定するときの保護者へのひとことは、他児の名前の注意を通る（Issue #270 の 1）', () => {
  it('下書きは通らず、確定は止まり、承諾を付けると確定する', async () => {
    const msg = '今日は村田 美咲さんと手をつないで歩きました';
    await api.saveCheck(teacher, 'C001', today(), [], '', '1', msg);
    await expect(api.saveCheck(teacher, 'C001', today(), [], '', '2', msg)).rejects.toMatchObject({ kind: 'other_child_names', names: [NAME] });
    expect(db.developmentChecks.find((c) => c.child_id === 'C001' && c.checked_on === today())!.status).toBe('1');
    await api.saveCheck(teacher, 'C001', today(), [], '', '2', msg, [NAME]);
    expect(db.developmentChecks.find((c) => c.child_id === 'C001' && c.checked_on === today())!.status).toBe('2');
  });
});

describe('猶予中（紐づけが 3）の保護者は、読めるが書けない（Issue #308）', () => {
  it('個人チャット・園チャット・クラスグループへの送信と編集を断り、読める。canPost は偽', async () => {
    const sent = await api.send(guardian, 6, '猶予の前に送った');
    await api.send(teacher, 6, '園からの返事');
    const link = db.guardianChildren.find((g) => g.guardian_id === 'G001' && g.child_id === 'C001')!;
    const before = { ...link };
    link.link_status = '3';
    link.grace_ends_on = '2099-01-01';
    try {
      const count = db.chatMessages.filter((m) => m.chat_room_id === 6).length;
      for (const room of [6, 1, 3]) await expect(api.send(guardian, room, '猶予のあとに送る')).rejects.toThrow(GRACE);
      await expect(api.edit(guardian, sent.chat_message_id, '猶予のあとに直す')).rejects.toThrow(GRACE);
      expect(db.chatMessages.filter((m) => m.chat_room_id === 6)).toHaveLength(count);
      expect(db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!.body).toBe('猶予の前に送った');
      expect((await api.messages(guardian, 6)).length).toBeGreaterThanOrEqual(2);
      expect((await api.rooms(guardian)).find((r) => r.room.chat_room_id === 6)!.canPost).toBe(false);
    } finally {
      Object.assign(link, before);
    }
    await api.send(guardian, 6, '有効に戻したら送れる');
  });

  // 個人チャットは園児単位で判定する。保護者単位にすると、在園中のきょうだいの個人チャットにも書けなくなる
  // （server/api_chat_guards_test.go の TestChatGraceSiblingStillWrites と同じケース）
  it('有効な紐づけが残っている保護者は、猶予中の子とは別の子（きょうだい）の個人チャットへ書ける', async () => {
    // G001 に、有効な紐づけの子（C002 遠藤 花子。個人チャットは 7）をもう1人足し、C001 だけ猶予中にする
    const sibling = { guardian_id: 'G001', child_id: 'C002', relationship: '父', link_status: '1' as const,
      linked_at: '2026-01-01T10:00:00', ended_at: null };
    const member = { chat_room_id: 7, account_id: guardian.account_id, joined_at: '2026-01-01T10:00:00', left_at: null };
    db.guardianChildren.push(sibling);
    db.chatMembers.push(member);
    const link = db.guardianChildren.find((g) => g.guardian_id === 'G001' && g.child_id === 'C001')!;
    const before = { ...link };
    link.link_status = '3';
    link.grace_ends_on = '2099-01-01';
    try {
      await expect(api.send(guardian, 6, '猶予中の子')).rejects.toThrow(GRACE);
      expect(countOf(6, '猶予中の子')).toBe(0);
      await api.send(guardian, 7, '有効な子');
      expect(countOf(7, '有効な子')).toBe(1);
      expect((await api.rooms(guardian)).find((r) => r.room.chat_room_id === 7)!.canPost).toBe(true);
    } finally {
      Object.assign(link, before);
      db.guardianChildren.splice(db.guardianChildren.indexOf(sibling), 1);
      db.chatMembers.splice(db.chatMembers.indexOf(member), 1);
    }
  });
});
