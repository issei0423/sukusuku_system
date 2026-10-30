/*
 * 保護者のクラスグループの参加を「いまのクラス」に追従させる（照合 c2b-E2）
 * 典拠：基本設計書「権限と参照範囲の判定」(4-2) の表「グループ｜保護者が読める範囲＝現在所属しているグループのみ」、
 *      詳細設計書「判定の関数」(4-1 (2))「『いまのクラス』（担任の判定・クラスグループ・午睡の一覧）」
 *
 * Go サーバ（server/api_class_group_follow_test.go）と同じ観点で確かめる。片方だけを直すと食い違う。
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
const classGroupOf = (classId: number) =>
  db.chatRooms.find((r) => r.room_type === '2' && r.class_id === classId && !r.is_archived)!.chat_room_id;
const memberOf = (roomId: number, accountId: number) =>
  db.chatMembers.find((m) => m.chat_room_id === roomId && m.account_id === accountId);

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
