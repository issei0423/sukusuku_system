/*
 * 画面詳細図の項目表との突き合わせで見つけた、検査の抜けのテスト
 * 典拠：図/画面詳細図.md「モックアップ実装との差異」(11)、基本設計書「入力項目の制約値」(4-9)
 *
 * ここで確かめる規則は、Go サーバ（server/）にも同じものがある。片方だけを直すと食い違う。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today, addDays } from '../src/api/util';

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

describe('文字数の上限', () => {
  it('日誌の本文は 2,000 文字まで', async () => {
    const input = { record_type: '2' as const, child_id: null, class_id: 1, diary_date: today(), body: 'あ'.repeat(2001) };
    await expect(api.saveDiary(teacher, input, '1')).rejects.toThrow('本文は2,000文字以内');
    await expect(api.saveDiary(teacher, { ...input, body: 'あ'.repeat(2000) }, '1')).resolves.toBeTruthy();
  });

  it('チャットの新規送信は、編集と同じ 1,000 文字まで', async () => {
    await expect(api.send(teacher, 6, 'あ'.repeat(1001))).rejects.toThrow('本文は1,000文字以内');
    await expect(api.send(teacher, 6, 'あ'.repeat(1000))).resolves.toBeTruthy();
  });

  it('グループ名は 50 文字まで', async () => {
    await expect(api.createGroup(teacher, 'あ'.repeat(51), [])).rejects.toThrow('グループ名は50文字以内');
  });

  it('絵文字のように2つの符号で表す文字も、1文字と数える', async () => {
    await expect(api.createGroup(teacher, '🌸'.repeat(50), [])).resolves.toBeTruthy();
  });
});

describe('よみ（ひらがな）', () => {
  it('CSV の取込で、ひらがな以外のよみは誤りにする', async () => {
    const { rows } = await api.parseChildCsv('C811,藤井 蒼,フジイ アオ,2025-09-09,1,もも組,36.5');
    expect(rows[0].error).toContain('氏名かなは、ひらがなで入力してください');
  });

  it('姓と名のあいだの空白と、長音は受け取る', async () => {
    const { rows } = await api.parseChildCsv('C812,佐藤 ルー,さとう るー,2025-09-09,1,もも組,36.5');
    expect(rows[0].error).toBeNull();
  });
});

describe('発達チェックの予定日', () => {
  it('手で決める予定日に、過ぎた日は入れられない', async () => {
    await expect(api.setSchedule(admin, 'C001', addDays(today(), -1), true))
      .rejects.toThrow('過ぎた日は指定できません');
    await expect(api.setSchedule(admin, 'C001', today(), true)).resolves.toBeUndefined();
  });

  it('「提案に戻す」は、提案が過ぎた日でも通る', async () => {
    await expect(api.setSchedule(admin, 'C001', addDays(today(), -1), false)).resolves.toBeUndefined();
  });
});

describe('出力の記録', () => {
  /*
   * アレルギー一覧の印刷は管理者・一般ができ、保護者はできない。誰が印刷しても操作ログに残る
   * （基本設計書「権限と利用可能機能」(6-1)、画面詳細図「アレルギー一覧画面」(7-4) の項目2。
   * 設計の直し PR #216 の直-16・直-24 で「管理者のみ」から改めた。サーバ側は server/api_audit_test.go）
   */
  it('アレルギー一覧の印刷は管理者・一般ができ、保護者はできない。操作ログに残る', async () => {
    for (const staff of [teacher, admin]) {
      const before = db.operationLogs.length;
      await api.recordExport(staff, 'allergy_list', '', '', 4);
      expect(db.operationLogs.length).toBe(before + 1);
      expect(db.operationLogs[0].account_id).toBe(staff.account_id);
      expect(db.operationLogs[0].after_value).toBe('アレルギー一覧を印刷（4 名）');
      expect(db.operationLogs[0].operation_type).toBe('5');
    }

    const guardian: SessionUser = {
      account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
      staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
      is_temp_password: false, terms_agreed: true,
    };
    const before = db.operationLogs.length;
    await expect(api.recordExport(guardian, 'allergy_list', '', '', 4)).rejects.toThrow('職員のみ');
    expect(db.operationLogs.length).toBe(before);
  });

  it('招待コードの配布用の出力も、操作ログに残る', async () => {
    await expect(api.recordExport(teacher, 'invitation_sheet', '', '', 5)).rejects.toThrow('管理者のみ');
    await api.recordExport(admin, 'invitation_sheet', '', '', 5);
    expect(db.operationLogs[0].after_value).toBe('招待コードを配布用に出力（5 枚）');
  });
});
