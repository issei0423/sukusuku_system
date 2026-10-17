/*
 * 保護者に見せる範囲（GitHub Issue #157）
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1) ※3「自児のみ、かつ共有されたものに限る」・
 *      「権限チェックの実装方針」(6-2)、「日誌システム」(4-5)「共有を選べるのは個人日誌だけとする」、
 *      図/画面詳細図.md「共有日誌閲覧画面」(2-8)
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

  it('日誌の一覧も、保護者には承認済み・共有した自児の個人日誌だけを返す', async () => {
    const rows = (await api.listDiaries(guardian)).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const d of rows) {
      expect(d.record_type).toBe('1');
      expect(d.status).toBe('3');
      expect(d.is_shared_to_guardian).toBe(true);
      expect(d.child_id).toBe('C001');
    }
  });
});

describe('共有を選べるのは個人日誌だけ（GitHub Issue #61・#157）', () => {
  it('ヒヤリハット・クラス日誌を共有つきで承認しようとすると断り、承認もしない', async () => {
    const incident = await api.saveDiary(teacher, {
      record_type: '4', child_id: 'C001', class_id: 1, diary_date: today(), body: '【状況】園内限定の記録',
    }, '2');
    for (const id of [incident.diary_id, 2]) { // 2 はさくら組のクラス日誌（申請中）
      await expect(api.approveDiary(admin, id, true)).rejects.toThrow('個人日誌だけです');
      const d = db.diaries.find((x) => x.diary_id === id)!;
      expect(d.status).toBe('2');
      expect(d.is_shared_to_guardian).toBe(false);
    }
    expect(db.chatMessages.some((m) => m.source_type === '2' && m.source_id === incident.diary_id)).toBe(false);

    // 共有しない承認は通る
    await expect(api.approveDiary(admin, incident.diary_id, false)).resolves.toBeTruthy();

    // すでに共有の印が付いてしまったヒヤリハットも、保護者には見せない
    db.diaries.find((x) => x.diary_id === incident.diary_id)!.is_shared_to_guardian = true;
    await expect(api.getDiary(guardian, incident.diary_id)).rejects.toThrow();
    const home = await api.guardianHome(guardian);
    expect(home.flatMap((h) => h.sharedDiaries).some((d) => d.diary_id === incident.diary_id)).toBe(false);
    expect((await api.listDiaries(guardian)).rows.some((d) => d.diary_id === incident.diary_id)).toBe(false);
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

  it('身体測定は、保護者には連携済の記録だけを返す。職員には全件', async () => {
    const mine = await api.recordsOf(guardian, 'C001');
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => r.share_status === '2')).toBe(true);
    expect(await api.recordsOf(teacher, 'C001')).toHaveLength(3);
  });
});

describe('保護者が見られない日誌は「この記録は共有されていません」と示す（画面詳細図 2-8）', () => {
  it('自児の未共有・他児・無い日誌を同じ文言にし、職員にはこれまでどおり権限の文言を返す', async () => {
    for (const id of [1, 4, 99999]) { // 自児の下書き・他児の共有済み・無い日誌
      await expect(api.getDiary(guardian, id)).rejects.toThrow('この記録は共有されていません');
    }
    await expect(api.getDiary(otherTeacher, 1)).rejects.toThrow('この日誌を参照する権限がありません');
    await expect(api.getDiary(guardian, 5)).resolves.toBeTruthy();
  });
});
