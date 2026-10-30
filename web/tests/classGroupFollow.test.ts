/*
 * 保護者のクラスグループの参加を「いまのクラス」に追従させる（照合 c2b-E2）
 * 典拠：基本設計書「権限と参照範囲の判定」(4-2) の表「グループ｜保護者が読める範囲＝現在所属しているグループのみ」、
 *      詳細設計書「判定の関数」(4-1 (2))「『いまのクラス』（担任の判定・クラスグループ・午睡の一覧）」
 *
 * Go サーバ（server/api_class_group_follow_test.go）と同じ観点で確かめる。片方だけを直すと食い違う。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import type { ChildInput } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { now } from '../src/api/util';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const guardianOf = (accountId: number, guardianId: string): SessionUser => ({
  account_id: accountId, email: `${guardianId}@example.jp`, role: '3', display_name: guardianId,
  staff_id: null, guardian_id: guardianId, class_id: null, class_name: null, is_temp_password: false, terms_agreed: true,
});

const classGroupOf = (classId: number) =>
  db.chatRooms.find((r) => r.room_type === '2' && r.class_id === classId && !r.is_archived)!.chat_room_id;
const memberOf = (roomId: number, accountId: number) =>
  db.chatMembers.find((m) => m.chat_room_id === roomId && m.account_id === accountId);

/** 園児情報の編集で、その園児のクラスだけを替える（ほかの項目はいまの値のまま送る） */
async function moveChildClass(childId: string, classId: number): Promise<void> {
  const c = db.children.find((x) => x.child_id === childId)!;
  const input: ChildInput = {
    child_id: c.child_id, child_name: c.child_name, child_name_kana: c.child_name_kana, nickname: c.nickname,
    birth_date: c.birth_date, sex: c.sex, normal_temperature: c.normal_temperature, photo_consent_level: c.photo_consent_level,
    class_id: classId,
    allergies: db.allergies.filter((a) => a.child_id === childId)
      .map((a) => ({ target_food: a.target_food, symptom: a.symptom, response: a.response })),
    medical_histories: db.medicalHistories.filter((m) => m.child_id === childId).map((m) => m.content),
  };
  await api.saveChild(admin, input, 'edit');
}

describe('新規登録では、いまの年度のクラスのクラスグループにだけ入る', () => {
  it('過年度のクラスグループ（閲覧のみのアーカイブ）には入らない', async () => {
    await api.saveChild(admin, {
      child_id: 'C901', child_name: '試験 花', child_name_kana: 'しけん はな', birth_date: '2024-05-01', sex: '2',
      normal_temperature: null, photo_consent_level: '2', class_id: 2, allergies: [], medical_histories: [],
    }, 'create');
    // 前の年度は 2025 年度のさくら組（11）にいたことにし、その年度のクラスグループをアーカイブとして置く。
    // 過年度の在籍の行は、今年度の行より前に作られている
    const pastRoom = Math.max(...db.chatRooms.map((r) => r.chat_room_id)) + 1;
    db.chatRooms.push({ chat_room_id: pastRoom, room_type: '2', class_id: 11, room_name: 'さくら組', is_archived: true, thread_status: null });
    db.classChildren.unshift({ class_id: 11, child_id: 'C901' });

    const code = await api.issueOneInvitationCode(admin, 'C901', 14);
    const guardian = await api.signUpGuardian({
      code, email: 'follow901@example.jp', password: 'Momo2026!abc', guardian_name: '試験 保護者', relationship: '母',
      terms_agreed: true, terms_version: db.CURRENT_TERMS_VERSION,
    });
    expect(memberOf(classGroupOf(2), guardian.account_id)?.left_at).toBeNull();
    expect(memberOf(pastRoom, guardian.account_id)).toBeUndefined();
  });
});

describe('年度の途中でクラスを替えたら、保護者のクラスグループの参加を、いまのクラスへ移す', () => {
  it('前のクラスに、ほかに有効な紐づけの子がいなければ、前のクラスのグループから外れて新しいクラスのグループに入る', async () => {
    // 村田 美咲（C004）をさくら組からひまわり組へ。保護者は村田 真一（アカウント9・G004）だけ
    const sakura = classGroupOf(1);
    const himawari = classGroupOf(2);
    expect(memberOf(sakura, 9)?.left_at).toBeNull();
    const at = now();
    await moveChildClass('C004', 2);

    expect(memberOf(sakura, 9)?.left_at).not.toBeNull();
    expect(memberOf(himawari, 9)?.left_at).toBeNull();
    expect(memberOf(himawari, 9)!.joined_at >= at).toBe(true);
    const rooms = (await api.rooms(guardianOf(9, 'G004'))).map((r) => r.room.chat_room_id);
    expect(rooms).toContain(himawari);
    expect(rooms).not.toContain(sakura);
  });

  it('前のクラスに、ほかに有効な紐づけの子がいれば、前のクラスのグループに残る', async () => {
    // 西田 拓也（アカウント6・G001）に、さくら組の遠藤 花子（C002）を有効な紐づけでつなぎ、C002 だけをひまわり組へ。
    // 西田 太郎（C001）はさくら組に残る
    db.guardianChildren.push({
      guardian_id: 'G001', child_id: 'C002', relationship: '父', link_status: '1', linked_at: '2026-01-01T10:00:00', ended_at: null,
    });
    await moveChildClass('C002', 2);

    expect(memberOf(classGroupOf(1), 6)?.left_at).toBeNull();
    expect(memberOf(classGroupOf(2), 6)?.left_at).toBeNull();
  });
});
