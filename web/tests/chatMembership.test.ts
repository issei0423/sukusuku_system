/*
 * チャットの参加者のテスト（GitHub Issue #161・#162）
 * 典拠：要件定義書「チャットツール」(4-3) 機能一覧「グループの作成・メンバー編成」・(a)「グループの種別」・(c)「過去ログの参照範囲」
 *      基本設計書「チャット」(5-5)「チャンネルの使い分け」・職員チャットの規定、「メッセージの送受信」(4-6)
 *      図/画面詳細図.md「グループ編成画面」(4-3) No.6・No.8
 *
 * ここで確かめる規則は、Go サーバ（server/chat_membership.go・api_chat.go）にも同じものがある。
 * server/api_chat_membership_test.go が同じ観点を確かめている。片方だけを直すと食い違う。
 *
 * デモデータのチャンネル：1 園全体、2 職員、3 さくら組、4 ひまわり組、5 運動会実行委員（目的別）、
 * 6〜9 さくら組の個人チャット。アカウント：1・2 管理者、3・4 さくら組の担任、5 ひまわり組の担任、6〜10 保護者
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
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
const kubota: SessionUser = {
  account_id: 5, email: 'kubota@hoiku.example.jp', role: '2', display_name: '久保田 和也',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
  is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

it('保護者には参加中の園・クラスのメンバー一覧も返さない', async () => {
  await expect(api.members(1, guardian)).rejects.toThrow('権限がありません');
  await expect(api.members(3, guardian)).rejects.toThrow('権限がありません');
  expect((await api.members(3, teacher)).length).toBeGreaterThan(0);
});

/**
 * いま参加している（left_at の無い）デモデータのチャンネル（1〜9）を番号順に返す。
 * 同じファイルの中では状態が続くため、テストの途中で作ったグループは数えない
 */
const currentRooms = (accountId: number) => db.chatMembers
  .filter((m) => m.account_id === accountId && m.left_at === null && m.chat_room_id <= 9)
  .map((m) => m.chat_room_id)
  .sort((a, b) => a - b);

const staffUser = (accountId: number): SessionUser => {
  const s = db.staff.find((x) => x.account_id === accountId)!;
  const a = db.accounts.find((x) => x.account_id === accountId)!;
  return {
    account_id: accountId, email: a.email, role: a.role, display_name: s.staff_name,
    staff_id: s.staff_id, guardian_id: null, class_id: null, class_name: null,
    is_temp_password: false, terms_agreed: true,
  };
};

describe('グループ編成の API で編成できるのは目的別グループだけ（GitHub Issue #161 の 1）', () => {
  it('ほかのクラスの個人チャットに自分を足せない', async () => {
    await expect(api.updateGroupMembers(kubota, 6, [1, 3, 4, 6, 5])).rejects.toThrow('目的別グループだけ');
    await expect(api.messages(kubota, 6)).rejects.toThrow('参照する権限がありません');
  });

  it('管理者でも、個人チャットから家庭を外せない', async () => {
    await expect(api.updateGroupMembers(admin, 9, [1])).rejects.toThrow('目的別グループだけ');
    expect(currentRooms(10)).toEqual([1, 3, 9]);
  });

  it('職員チャットに保護者を入れられない', async () => {
    await expect(api.updateGroupMembers(kubota, 2, [1, 2, 3, 4, 5, 6])).rejects.toThrow('目的別グループだけ');
    await expect(api.messages(guardian, 2)).rejects.toThrow('参照する権限がありません');
  });

  it('目的別グループに保護者を入れられない（作るときも、編成するときも）', async () => {
    const before = db.chatRooms.filter((r) => r.room_type === '3').length;
    await expect(api.createGroup(teacher, 'T3 遠足の打ち合わせ', [9])).rejects.toThrow('保護者は入れられません');
    expect(db.chatRooms.filter((r) => r.room_type === '3').length).toBe(before);
    await expect(api.updateGroupMembers(admin, 5, [1, 3, 5, 6])).rejects.toThrow('保護者は入れられません');
    expect(currentRooms(6)).toEqual([1, 3, 6]);
  });

  it('一般は、参加していない目的別グループを編成できない。管理者はできる', async () => {
    const room = await api.createGroup(admin, '園長と主任', [2]);
    await expect(api.updateGroupMembers(teacher, room.chat_room_id, [1, 2, 3])).rejects.toThrow('参加していないグループは編成できません');
    await api.updateGroupMembers(admin, room.chat_room_id, [1, 2, 3]);
    // 加わった一般は、そのグループを編成できる
    await api.updateGroupMembers(teacher, room.chat_room_id, [1, 3]);
  });

  it('停止している職員は加えられない', async () => {
    await api.setAccountStatus(admin, 4, '2');
    await expect(api.updateGroupMembers(admin, 5, [1, 3, 5, 4])).rejects.toThrow('停止している職員は加えられません');
    await api.setAccountStatus(admin, 4, '1');
  });
});

describe('外した職員は、外したあとの投稿を読めず、書けない（GitHub Issue #161 の 2）', () => {
  it('外す前の過去ログは読めて、外したあとの投稿は読めない。投稿・反応・編集・取消はできない', async () => {
    // 外す前の投稿。外したのと同じ秒に入らないよう、日時を過去に置く
    const k0 = {
      chat_message_id: 90_001, chat_room_id: 5, sender_account_id: 5, body: 'K0 久保田の外される前の投稿',
      source_type: '1' as const, source_id: null, sent_at: '2026-01-05T10:00:00',
      edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null,
    };
    db.chatMessages.push(k0);
    const unreadBefore = (await api.staffSummary(kubota)).unreadChat;

    await api.updateGroupMembers(admin, 5, [1, 3]);
    await api.send(admin, 5, 'L1 久保田さんを外したあとの打ち合わせ');

    const bodies = (await api.messages(kubota, 5)).map((m) => m.body);
    expect(bodies).not.toContain('L1 久保田さんを外したあとの打ち合わせ');
    expect(bodies).toContain('K0 久保田の外される前の投稿');
    expect(bodies).toContain('種目案を今週中にまとめましょう。');

    const view = (await api.rooms(kubota)).find((r) => r.room.chat_room_id === 5);
    expect(view).toBeDefined();
    expect(view!.canPost).toBe(false);
    expect(view!.left).toBe(true);
    expect(view!.unread).toBe(1); // デモデータの「種目案を…」だけ
    expect((await api.staffSummary(kubota)).unreadChat).toBe(unreadBefore);

    await expect(api.send(kubota, 5, 'L2 外された久保田からの投稿')).rejects.toThrow('外れている');
    await expect(api.toggleReaction(kubota, k0.chat_message_id, '1')).rejects.toThrow('外れている');
    await expect(api.edit(kubota, k0.chat_message_id, '書き換え')).rejects.toThrow('外れている');
    await expect(api.retract(kubota, k0.chat_message_id)).rejects.toThrow('外れている');
    await expect(api.members(5, kubota)).rejects.toThrow('参照する権限がありません');

    // 既読にするのは読める範囲だけ
    await api.markRead(kubota, 5);
    const l1 = db.chatMessages.find((m) => m.body === 'L1 久保田さんを外したあとの打ち合わせ')!;
    expect(db.chatReads.some((r) => r.chat_message_id === l1.chat_message_id && r.account_id === 5)).toBe(false);

    // 入れ直すと、また読み書きできる
    await api.updateGroupMembers(admin, 5, [1, 3, 5]);
    await api.send(kubota, 5, 'L4 戻りました');
    const back = (await api.rooms(kubota)).find((r) => r.room.chat_room_id === 5)!;
    expect(back.canPost).toBe(true);
    expect(back.left).toBe(false);
  });
});

describe('職員アカウントの発行・付け替え・停止がチャットの参加者に反映される（GitHub Issue #162）', () => {
  it('管理者は、保護者との個人チャットにも参加している', () => {
    expect(currentRooms(2)).toEqual([1, 2, 3, 4, 6, 7, 8, 9]);
  });

  it('発行した職員は、園全体・職員・担当クラスとその個人チャットに入る', async () => {
    await api.createStaffAccount(admin, {
      staff_id: 'S010', staff_name: '新任 一郎', email: 'shinnin@hoiku.example.jp', role: '2', class_id: 1,
    });
    const id = db.staff.find((s) => s.staff_id === 'S010')!.account_id;
    expect(currentRooms(id)).toEqual([1, 2, 3, 6, 7, 8, 9]);

    // 担当クラスを割り当てない一般は、園全体と職員だけ
    await api.createStaffAccount(admin, {
      staff_id: 'S011', staff_name: '新任 二郎', email: 'shinnin2@hoiku.example.jp', role: '2', class_id: null,
    });
    expect(currentRooms(db.staff.find((s) => s.staff_id === 'S011')!.account_id)).toEqual([1, 2]);
  });

  it('担任を付け替えると、前のクラスから外れ、新しいクラスに入る', async () => {
    await api.updateStaffAccount(admin, 'S005', { staff_name: '久保田 和也', role: '2', class_id: 1 });
    // 目的別グループ（5）は手で編成するものなので、付け替えでは動かさない
    expect(currentRooms(5)).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
    await expect(api.send(kubota, 8, '新しい担任の久保田です。', ['久保田 陸'])).resolves.toBeTruthy();
    await expect(api.send(kubota, 4, '前のクラスへ')).rejects.toThrow('外れている');
    const old = (await api.rooms(kubota)).find((r) => r.room.chat_room_id === 4);
    expect(old?.left).toBe(true);
    expect(old?.canPost).toBe(false);

    await api.updateStaffAccount(admin, 'S003', { staff_name: '鈴木 浩之', role: '2', class_id: 2 });
    expect(currentRooms(3)).toEqual([1, 2, 4, 5]);
    await expect(api.send(teacher, 8, '外れた家庭へ')).rejects.toThrow('外れている');
    // 未対応の個人チャットは、外れた担任のダッシュボードに数えない
    expect((await api.staffSummary(teacher)).unhandledChat).toBe(0);
  });

  it('一般を管理者にすると全クラスと個人チャットに入り、戻すと担当クラスだけになる', async () => {
    await api.updateStaffAccount(admin, 'S003', { staff_name: '鈴木 浩之', role: '1', class_id: 2 });
    expect(currentRooms(3)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await api.updateStaffAccount(admin, 'S003', { staff_name: '鈴木 浩之', role: '2', class_id: 1 });
    expect(currentRooms(3)).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
  });

  it('停止すると職員チャットなどから外れ、再開すると戻る', async () => {
    await api.setAccountStatus(admin, 4, '2');
    expect((await api.members(2, admin)).some((m) => m.account_id === 4)).toBe(false);
    expect(currentRooms(4)).toEqual([]);
    await api.setAccountStatus(admin, 4, '1');
    expect(currentRooms(4)).toEqual([1, 2, 3, 6, 7, 8, 9]);
    // 再開した職員も、ふつうに投稿できる
    await expect(api.send(staffUser(4), 2, '戻りました')).resolves.toBeTruthy();
  });
});
