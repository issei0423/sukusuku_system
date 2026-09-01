/*
 * 業務の流れのテスト
 * 典拠：基本設計書.md「日誌の作成から保護者への共有」(4-5)、「保護者アカウントの自己登録」(4-3)、
 *      「異常時の記録」(4-7)、5-2（招待コードは1枚＝1アカウント）
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'takahashi@hoiku.example.jp', role: '1', display_name: '高橋 美咲',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'yamada@hoiku.example.jp', role: '2', display_name: '山田 花子',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

describe('ログイン', () => {
  it('職員用の入口から保護者はログインできず、正しい入口を案内する', async () => {
    await expect(api.login('yamada.k@example.jp', 'pass1234', 'staff'))
      .rejects.toThrow(/wrong_entrance/);
  });

  it('保護者用の入口から職員はログインできない', async () => {
    await expect(api.login('yamada@hoiku.example.jp', 'pass1234', 'guardian'))
      .rejects.toThrow(/wrong_entrance/);
  });

  it('停止中のアカウントはログインできない', async () => {
    await expect(api.login('sato.n@example.jp', 'pass1234', 'guardian'))
      .rejects.toThrow(/suspended/);
  });

  it('一時パスワード中のアカウントは is_temp_password が真で返る', async () => {
    const u = await api.login('sato@hoiku.example.jp', 'temp0901', 'staff');
    expect(u.is_temp_password).toBe(true);
  });

  it('最新版の規約に同意していないアカウントは terms_agreed が偽で返る', async () => {
    const u = await api.login('suzuki.m@example.jp', 'pass1234', 'guardian');
    expect(u.terms_agreed).toBe(false);
  });

  it('職員のログインでは所属クラスが付く（共有端末での取り違えを防ぐため）', async () => {
    const u = await api.login('yamada@hoiku.example.jp', 'pass1234', 'staff');
    expect(u.class_name).toBe('さくら組');
  });
});

describe('日誌の作成から保護者への共有', () => {
  it('承認と共有の指定は別。共有しない承認では個人チャットへ流さない', async () => {
    const d = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C001', class_id: 1,
      diary_date: '2026-09-02', body: '共有しない日誌',
    }, '2');
    const before = db.chatMessages.length;
    const approved = await api.approveDiary(admin, d.diary_id, false);

    expect(approved.status).toBe('3');
    expect(approved.is_shared_to_guardian).toBe(false);
    expect(approved.shared_at).toBeNull();
    expect(db.chatMessages.length).toBe(before);
  });

  it('共有する承認では個人チャットへ日誌の共有として流す', async () => {
    const d = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C001', class_id: 1,
      diary_date: '2026-09-03', body: '共有する日誌',
    }, '2');
    await api.approveDiary(admin, d.diary_id, true);

    const msg = db.chatMessages.find((m) => m.source_type === '2' && m.source_id === d.diary_id);
    expect(msg).toBeDefined();
  });

  it('差し戻しは理由の入力を必須とする', async () => {
    const d = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C001', class_id: 1,
      diary_date: '2026-09-04', body: '差し戻される日誌',
    }, '2');
    await expect(api.returnDiary(admin, d.diary_id, '  ')).rejects.toThrow('理由');

    const returned = await api.returnDiary(admin, d.diary_id, '記録が不足しています');
    expect(returned.status).toBe('4');
    expect(returned.returned_reason).toBe('記録が不足しています');
  });

  it('申請中でない日誌は承認できない', async () => {
    const d = await api.saveDiary(teacher, {
      record_type: '2', child_id: null, class_id: 1,
      diary_date: '2026-09-05', body: '下書きのまま',
    }, '1');
    await expect(api.approveDiary(admin, d.diary_id, false)).rejects.toThrow('申請中');
  });
});
