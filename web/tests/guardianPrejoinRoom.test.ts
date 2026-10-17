import { expect, it } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: '', role: '1', display_name: '', staff_id: 'S001', guardian_id: null,
  class_id: null, class_name: null, is_temp_password: false, terms_agreed: true,
};

it('最初の保護者が参加する前の投稿は全保護者が読めて未読になり、参加後の投稿は後から来た保護者に見せない', async () => {
  await api.saveChild(admin, {
    child_id: 'C904', child_name: '試験 花', child_name_kana: 'しけん はな', birth_date: '2025-01-01', sex: '2',
    normal_temperature: null, photo_consent_level: '2', class_id: 2, allergies: [], medical_histories: [],
  }, 'create');
  const room = db.chatRooms.find((r) => r.child_id === 'C904')!;
  const id = room.chat_room_id;
  const addMessage = (sender_account_id: number, body: string, sent_at: string) => db.chatMessages.push({
    chat_message_id: Math.max(...db.chatMessages.map((x) => x.chat_message_id)) + 1,
    chat_room_id: id, sender_account_id, body, sent_at, source_type: '1', source_id: null, edited_at: null,
    is_deleted: false, deleted_at: null, deleted_account_id: null,
  });
  addMessage(5, '保護者登録前', '2026-01-01T10:00:00');
  const first = await api.signUpGuardian({
    code: await api.issueOneInvitationCode(admin, 'C904', 30), email: 'room-first@example.jp', password: 'pass12345',
    guardian_name: '試験 一人目', relationship: '母', terms_agreed: true, terms_version: db.CURRENT_TERMS_VERSION,
  });
  db.chatMembers.find((m) => m.chat_room_id === id && m.account_id === first.account_id)!.joined_at = '2026-01-02T10:00:00';
  addMessage(5, '最初の保護者が参加した後の園の投稿', '2026-01-03T10:00:00');
  addMessage(first.account_id, '最初の保護者の投稿', '2026-01-03T11:00:00');
  const second = await api.signUpGuardian({
    code: await api.issueOneInvitationCode(admin, 'C904', 30), email: 'room-second@example.jp', password: 'pass12345',
    guardian_name: '試験 二人目', relationship: '父', terms_agreed: true, terms_version: db.CURRENT_TERMS_VERSION,
  });
  db.chatMembers.find((m) => m.chat_room_id === id && m.account_id === second.account_id)!.joined_at = '2026-01-05T10:00:00';
  expect((await api.messages(first, id)).map((m) => m.body)).toEqual([
    '保護者登録前', '最初の保護者が参加した後の園の投稿', '最初の保護者の投稿',
  ]);
  expect((await api.rooms(first)).find((r) => r.room.chat_room_id === id)?.unread).toBe(2);
  db.chatMembers.find((m) => m.chat_room_id === id && m.account_id === first.account_id)!.left_at = '2026-01-04T10:00:00';
  expect((await api.messages(second, id)).map((m) => m.body)).toEqual(['保護者登録前']);
  expect((await api.rooms(second)).find((r) => r.room.chat_room_id === id)?.unread).toBe(1);
  await api.markRead(second, id);
  expect((await api.rooms(second)).find((r) => r.room.chat_room_id === id)?.unread).toBe(0);
});
