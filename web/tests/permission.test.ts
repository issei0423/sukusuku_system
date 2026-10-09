/*
 * 権限と参照範囲のテスト
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1)・「権限チェックの実装方針」(6-2)
 *      要件定義書「対象権限列の読み方」(4-2 冒頭)
 *
 * 権限の判定はサーバ側（api/client.ts）が担う。画面側の出し分けは操作性のためであり、
 * 権限の担保ではない。ここではサーバ側の判定を直接検証する。
 */
import { describe, it, expect } from 'vitest';
import { api, canSeeChild, visibleChildren, selectableClasses } from '../src/api/client';
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
const guardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const endedGuardian: SessionUser = {
  account_id: 8, email: 'takanashi.r@example.jp', role: '3', display_name: '高梨 倫太朗',
  staff_id: null, guardian_id: 'G003', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

describe('園児の参照範囲', () => {
  it('管理者は全園児を参照できる', () => {
    expect(canSeeChild(admin, 'C001')).toBe(true);
    expect(canSeeChild(admin, 'C013')).toBe(true);
    expect(visibleChildren(admin).length).toBeGreaterThan(12);
  });

  it('一般（保育士）は自クラスの園児のみ参照できる', () => {
    expect(canSeeChild(teacher, 'C001')).toBe(true);   // さくら組
    expect(canSeeChild(teacher, 'C013')).toBe(false);  // ひまわり組
    expect(visibleChildren(teacher).every((c) => c.child_id <= 'C012')).toBe(true);
  });

  it('一般は他クラスを選べない', () => {
    expect(selectableClasses(teacher).map((c) => c.class_name)).toEqual(['さくら組']);
    expect(selectableClasses(otherTeacher).map((c) => c.class_name)).toEqual(['ひまわり組']);
    expect(selectableClasses(admin).length).toBe(3);
  });

  it('保護者は有効な紐づけのある自児のみ参照できる', () => {
    expect(canSeeChild(guardian, 'C001')).toBe(true);
    expect(canSeeChild(guardian, 'C002')).toBe(false);
  });

  it('紐づけが終了した保護者は、その園児を参照できない', () => {
    // G003 と C003 の紐づけは link_status='2'（終了）
    expect(canSeeChild(endedGuardian, 'C003')).toBe(false);
  });
});

describe('管理者に限る操作', () => {
  it('一般は園児情報を登録できない', async () => {
    await expect(api.saveChild(teacher, {
      child_id: 'C900', child_name: 'テスト', child_name_kana: 'てすと',
      birth_date: '2025-01-01', sex: '1', normal_temperature: null,
      photo_consent_level: '2', class_id: 1, allergies: [], medical_histories: [],
    }, 'create')).rejects.toThrow('管理者のみ');
  });

  it('一般は日誌を承認できない', async () => {
    await expect(api.approveDiary(teacher, 2, true)).rejects.toThrow('管理者のみ');
  });

  it('一般は操作ログを参照できない', async () => {
    await expect(api.operationLogs(teacher, {})).rejects.toThrow('管理者のみ');
  });

  it('一般は招待コードを発行できない', async () => {
    await expect(api.issueInvitationCodes(teacher, 1, 2, 30)).rejects.toThrow('管理者のみ');
  });

  it('一般はPDF出力できない', async () => {
    await expect(api.exportPdf(teacher, 'C001', 'internal')).rejects.toThrow('管理者のみ');
  });
});

describe('参照範囲を越える記録の作成', () => {
  it('一般は他クラスの園児の日誌を作成できない', async () => {
    await expect(api.saveDiary(teacher, {
      record_type: '1', child_id: 'C013', class_id: 2,
      diary_date: '2026-09-01', body: 'テスト',
    }, '1')).rejects.toThrow('権限がありません');
  });

  it('保護者は身体測定を記録できない', async () => {
    await expect(api.save(guardian, {
      child_id: 'C001', measured_on: '2026-09-01', height_cm: 80, weight_kg: 10,
    })).rejects.toThrow('職員のみ');
  });
});
