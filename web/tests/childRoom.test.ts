import { expect, it } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = { account_id: 1, email: '', role: '1', display_name: '', staff_id: 'S001', guardian_id: null, class_id: null, class_name: null, is_temp_password: false, terms_agreed: true };

it('園児の登録で保護者のいない個人チャットを作り、担任と管理者が参加する', async () => {
  await api.saveChild(admin, { child_id: 'C901', child_name: '試験 花', child_name_kana: 'しけん はな', birth_date: '2025-01-01', sex: '2', normal_temperature: null, photo_consent_level: '2', class_id: 2, allergies: [], medical_histories: [] }, 'create');
  const room = db.chatRooms.find((r) => r.child_id === 'C901');
  expect(room).toMatchObject({ room_type: '4', class_id: 2, thread_status: '2' });
  const ids = db.chatMembers.filter((m) => m.chat_room_id === room?.chat_room_id && m.left_at === null).map((m) => m.account_id).sort();
  expect(ids).toEqual([1, 2, 5]);
  expect((await api.rooms(admin)).some((r) => r.room.chat_room_id === room?.chat_room_id)).toBe(true);
});

it('CSV登録でも個人チャットを作り、取消時にアーカイブする', async () => {
  const text = '園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱\nC902,試験 次郎,しけん じろう,2025-01-01,1,ひまわり組,36.5\n';
  const parsed = await api.parseChildCsv(text);
  expect(await api.importChildCsv(admin, parsed.rows, text)).toBe(1);
  const room = db.chatRooms.find((r) => r.child_id === 'C902');
  expect(room?.room_type).toBe('4');
  await api.removeChild(admin, 'C902');
  expect(room?.is_archived).toBe(true);
});

it('存在しないクラスを指定した登録は園児を残さない', async () => {
  await expect(api.saveChild(admin, { child_id: 'C903', child_name: '試験 三郎', child_name_kana: 'しけん さぶろう',
    birth_date: '2025-01-01', sex: '1', normal_temperature: null, photo_consent_level: '2',
    class_id: 999, allergies: [], medical_histories: [] }, 'create')).rejects.toThrow('登録できませんでした');
  expect(db.children.some((c) => c.child_id === 'C903')).toBe(false);
});
