/*
 * 担当クラスの無い一般（フリー）の日誌（受け入れテスト 06-045）
 * 典拠：基本設計書「権限と利用可能機能」(6-1) ※1「担当クラスの無い職員（フリー）は全クラスを閲覧のみ（記録の作成・編集・確認はできない）」、
 *      同「権限と参照範囲の判定」(4-2)、図/画面詳細図「職員（タブレット／PC）」(1-1) の注記「全クラスを閲覧のみ…記録の作成・編集のボタンは出さない」
 *
 * Go サーバ（server/api_diary_free_test.go）と同じ観点で確かめる。片方だけを直すと食い違う。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

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
// フリー（担当クラスの無い一般）。ひまわり組の担任（久保田）の割り当てを外した形
const free: SessionUser = { ...teacher, account_id: 5, email: 'kubota@hoiku.example.jp', staff_id: 'S005', display_name: '久保田 和也', class_id: null, class_name: null };

const WRITE_FORBIDDEN = 'この日誌を編集する権限がありません';

describe('フリーの職員は、全クラスの日誌を読める', () => {
  it('日誌一覧に全クラスの日誌が出る（さくら組の下書き・ヒヤリハット、ひまわり組のクラス日誌）', async () => {
    const list = await api.listDiaries(free, { from: '', to: '' });
    const ids = new Set(list.rows.map((d) => d.diary_id));
    for (const id of [1, 2, 3, 6]) expect(ids.has(id), `日誌 ${id}`).toBe(true);
    // クラスで絞ることもできる（ひまわり組）
    const himawari = await api.listDiaries(free, { classId: 2, from: '', to: '' });
    expect(himawari.rows.map((d) => d.diary_id)).toContain(6);
    expect(himawari.rows.some((d) => d.class_id === 1)).toBe(false);
  });

  it('日誌本体・添付・誰が編集中か・その園児の過去の記録を読める', async () => {
    await expect(api.getDiary(free, 1)).resolves.toMatchObject({ diary_id: 1 });
    await expect(api.getDiary(free, 6)).resolves.toMatchObject({ diary_id: 6 });
    await expect(api.attachmentsOf(free, 4)).resolves.toHaveLength(2);
    // 日誌 3 は村田 真一がロックを持っている（画面に「〇〇さんが編集中です。」を出すため）
    await expect(api.lockOf(free, 3)).resolves.toMatchObject({ staff_name: '村田 真一' });
    await expect(api.pastDiariesOf(free, 'C001')).resolves.not.toHaveLength(0);
  });

  it('読める範囲は、在籍中の園児と今年度のクラス（canReadChild・canReadClass と同じ）', async () => {
    const past = { ...db.diaries.find((d) => d.diary_id === 2)!, diary_id: 9_000_001, class_id: 11 }; // 2025年度のさくら組
    db.diaries.push(past);
    const child = db.children.find((c) => c.child_id === 'C002')!; // 日誌 4 の園児
    child.enrollment_status = '2';
    try {
      await expect(api.getDiary(free, past.diary_id)).rejects.toThrow('この日誌を参照する権限がありません');
      await expect(api.getDiary(free, 4)).rejects.toThrow('この日誌を参照する権限がありません');
      await expect(api.pastDiariesOf(free, 'C002')).rejects.toThrow('この園児を参照する権限がありません');
      // 管理者には今までどおり出る
      await expect(api.getDiary(admin, past.diary_id)).resolves.toBeTruthy();
      await expect(api.getDiary(admin, 4)).resolves.toBeTruthy();
    } finally {
      child.enrollment_status = '1';
      db.diaries.splice(db.diaries.indexOf(past), 1);
    }
  });
});

describe('フリーの職員は、日誌を書けない', () => {
  it('作れない', async () => {
    const before = db.diaries.length;
    await expect(api.saveDiary(free, { record_type: '1', child_id: 'C001', class_id: 1, diary_date: today(), body: 'フリーが書いた' }, '1'))
      .rejects.toThrow('権限がありません');
    await expect(api.saveDiary(free, { record_type: '2', child_id: null, class_id: 2, diary_date: today(), body: 'フリーが書いた' }, '2'))
      .rejects.toThrow('権限がありません');
    expect(db.diaries.length).toBe(before);
    // デモの日誌 6 は久保田が担任のときに書いたもの。足されていないことは本文で見る
    expect(db.diaries.some((d) => d.body === 'フリーが書いた')).toBe(false);
  });

  it('編集ロックを取れない', async () => {
    await expect(api.acquireLock(free, 1)).rejects.toThrow(WRITE_FORBIDDEN);
    expect(db.diaryLocks.some((l) => l.locked_staff_id === 'S005')).toBe(false);
  });

  it('書き換えられない（担任のロックの識別子を添えても）', async () => {
    const r = await api.acquireLock(teacher, 1);
    if (!('token' in r)) throw new Error('担任がロックを取れませんでした');
    const before = db.diaries.find((d) => d.diary_id === 1)!.body;
    try {
      await expect(api.saveDiary(free, {
        diary_id: 1, record_type: '1', child_id: 'C001', class_id: 1, diary_date: today(), body: 'フリーが書き換え', lock_token: r.token,
      }, '2')).rejects.toThrow('権限がありません');
      expect(db.diaries.find((d) => d.diary_id === 1)!.body).toBe(before);
      expect(db.diaries.find((d) => d.diary_id === 1)!.status).toBe('1');
    } finally {
      await api.releaseLock(teacher, 1, false, r.token);
    }
  });

  it('自分の申請でも取り下げられない（担任だったときの申請）', async () => {
    const d = db.diaries.find((x) => x.diary_id === 2)!;
    const applicant = d.applied_staff_id;
    d.applied_staff_id = 'S005';
    try {
      await expect(api.withdrawDiary(free, 2, d.updated_at)).rejects.toThrow(WRITE_FORBIDDEN);
      expect(d.status).toBe('2');
    } finally {
      d.applied_staff_id = applicant;
    }
  });
});
