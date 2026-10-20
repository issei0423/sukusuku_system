/*
 * 保護者に見せる範囲（GitHub Issue #157）
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1)・「権限チェックの実装方針」(6-2)、
 *      「日誌システム（園内の記録）」(4-6)、詳細設計書.md「日誌」(4-13)
 *
 * Go サーバ側（server/api_guardian_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 * 業務の規則を2か所に持っているため、片方だけを直すと食い違う（MOCKUP.md）。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
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
// 金城 陸（C005）の保護者。C005 には既往歴がある
const kinjoGuardian: SessionUser = {
  account_id: 10, email: 'kinjo.s@example.jp', role: '3', display_name: '金城 宗一郎',
  staff_id: null, guardian_id: 'G005', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

describe('職員の編集画面・タイムラインの経路は、保護者に使わせない', () => {
  it('過去の記録・タイムラインは、保護者と担当外の職員には返さず、担任には返す', async () => {
    // 日誌 1 は C001 の下書き
    await expect(api.pastDiariesOf(guardian, 'C001')).rejects.toThrow();
    await expect(api.timelineOf(guardian, 'C001')).rejects.toThrow();
    await expect(api.pastDiariesOf(otherTeacher, 'C001')).rejects.toThrow('権限がありません');
    await expect(api.timelineOf(otherTeacher, 'C001')).rejects.toThrow('権限がありません');

    expect((await api.pastDiariesOf(teacher, 'C001')).some((d) => d.diary_id === 1)).toBe(true);
    expect((await api.timelineOf(teacher, 'C001')).some((d) => d.diary_id === 1)).toBe(true);
  });

});

/*
 * 日誌は園内の記録で、保護者へ返す経路を持たない（詳細設計書「日誌」(4-13)「保護者が呼んだら 403
 * 『この日誌を参照する権限がありません』」・(10)）。サーバ側は api_guardian_test.go の TestGuardianCannotUseDiaryRoutes
 */
describe('日誌は保護者に見せない', () => {
  it('一覧・1件・添付・園児の日誌・タイムライン・取り下げのどれも、同じ文言で断る', async () => {
    const forbidden = 'この日誌を参照する権限がありません';
    await expect(api.listDiaries(guardian)).rejects.toThrow(forbidden);
    await expect(api.listDiaries(guardian, { status: '3' })).rejects.toThrow(forbidden);
    // 承認済みの自児の個人日誌（日誌 5。以前の版で保護者へ共有した日誌）・自児の下書き・他児の日誌・無い日誌
    for (const id of [5, 1, 4, 99999]) {
      await expect(api.getDiary(guardian, id)).rejects.toThrow(forbidden);
      await expect(api.attachmentsOf(guardian, id)).rejects.toThrow(forbidden);
    }
    await expect(api.pastDiariesOf(guardian, 'C001')).rejects.toThrow(forbidden);
    await expect(api.timelineOf(guardian, 'C001')).rejects.toThrow(forbidden);
    await expect(api.withdrawDiary(guardian, 2, '')).rejects.toThrow(forbidden);
    // 職員にはこれまでどおり（参照範囲の外は同じ文言）
    await expect(api.getDiary(otherTeacher, 1)).rejects.toThrow(forbidden);
    await expect(api.getDiary(teacher, 5)).resolves.toBeTruthy();
  });

  it('どの記録種別を承認しても、保護者へは何も届かない（チャットも保護者ホームも変わらない）', async () => {
    const before = db.chatMessages.length;
    const personal = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C001', class_id: 1, diary_date: today(), body: '園内で確かめる個人日誌',
    }, '2');
    const incident = await api.saveDiary(teacher, {
      record_type: '4', child_id: 'C001', class_id: 1, diary_date: today(), body: '【状況】園内限定の記録',
    }, '2');
    for (const id of [personal.diary_id, incident.diary_id, 2]) { // 2 はさくら組のクラス日誌（申請中）
      expect((await api.approveDiary(admin, id)).status).toBe('3');
    }
    expect(db.chatMessages.length).toBe(before);
    const home = await api.guardianHome(guardian);
    expect(home.every((h) => !('sharedDiaries' in h))).toBe(true);
    expect(JSON.stringify(home)).not.toContain('園内で確かめる個人日誌');
  });
});

describe('園児情報・既往歴・アレルギーは保護者に見せない。身体測定は連携済だけ（基本設計書 6-1）', () => {
  it('自児でも、園児情報・既往歴・アレルギーは返さない。職員には返す', async () => {
    await expect(api.getChild(kinjoGuardian, 'C005')).rejects.toThrow();
    await expect(api.medicalHistoriesOf(kinjoGuardian, 'C005')).rejects.toThrow();
    await expect(api.allergiesOf(kinjoGuardian, 'C005')).rejects.toThrow();

    await expect(api.getChild(teacher, 'C005')).resolves.toBeTruthy();
    expect(await api.medicalHistoriesOf(teacher, 'C005')).toHaveLength(1);
    await expect(api.allergiesOf(teacher, 'C005')).resolves.toBeTruthy();
    // 担当外の職員には返さない
    await expect(api.medicalHistoriesOf(otherTeacher, 'C005')).rejects.toThrow('権限がありません');
    await expect(api.allergiesOf(otherTeacher, 'C005')).rejects.toThrow('権限がありません');
  });

  it('身体測定の経路は、保護者には断る（成長の記録で読む）。職員には全件', async () => {
    await expect(api.recordsOf(guardian, 'C001')).rejects.toThrow('この園児の成長の記録は開けません。');
    expect(await api.recordsOf(teacher, 'C001')).toHaveLength(3);
  });
});

