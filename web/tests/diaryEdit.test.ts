/*
 * 日誌の写真（添付）の保存（GitHub Issue #175 の 2）
 * 典拠：基本設計書.md「日誌の作成から保護者への共有」(4-5)「保育士が雛形を選び、本文・定型文・写真を入力する」、
 *      「雛形・添付」(5-4)「t_diary_attachment｜1〜3枚」、「設定マスタ」(5-8) attachment.max_count_diary・
 *      attachment.allowed_types、図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目10・「日誌確認画面」(3-3) 項目3
 *
 * 実体は持たず、ファイルの名前と形式だけを持つ（web/仮置き値.md 7「添付ファイルの実体」）。
 * ここで確かめる規則は、Go サーバ（server/api_diary_attach_test.go）にも同じものがある。片方だけを直すと食い違う。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import type { DiaryInput } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

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

const jpeg = (...names: string[]) => names.map((file_path) => ({ file_path, file_type: 'image/jpeg' }));

/** 個人日誌の入力。C004 はさくら組（class_id=1）の園児 */
const personal = (patch: Partial<DiaryInput> = {}): DiaryInput => ({
  record_type: '1', child_id: 'C004', class_id: 1, diary_date: today(), body: '個人日誌の本文', ...patch,
});

async function lockOf(user: SessionUser, diaryId: number): Promise<string> {
  const lock = await api.acquireLock(user, diaryId);
  if (!('token' in lock)) throw new Error(`ロックを取れませんでした（${lock.heldBy}さんが編集中）`);
  return lock.token;
}

const photosOf = async (user: SessionUser, diaryId: number) =>
  (await api.attachmentsOf(user, diaryId)).map((a) => a.file_path);

describe('日誌の写真を保存する（#175 の 2）', () => {
  it('下書き保存・申請のどちらでも、画面で足した写真が日誌に付き、承認する管理者にも同じ写真が見える', async () => {
    const d = await api.saveDiary(teacher, personal({ attachments: jpeg('demo/photo-a', 'demo/photo-b') }), '1');
    expect(await photosOf(teacher, d.diary_id)).toEqual(['demo/photo-a', 'demo/photo-b']);
    expect((await api.attachmentsOf(teacher, d.diary_id)).every((a) => a.file_type === 'image/jpeg')).toBe(true);

    // 開き直して 1 枚を消し、2 枚を足して申請する。写真は画面の並びで置き換わる
    await api.saveDiary(teacher, personal({
      diary_id: d.diary_id, lock_token: await lockOf(teacher, d.diary_id),
      attachments: jpeg('demo/photo-b', 'demo/photo-c', 'demo/photo-d'),
    }), '2');
    expect(await photosOf(teacher, d.diary_id)).toEqual(['demo/photo-b', 'demo/photo-c', 'demo/photo-d']);
    expect(await photosOf(admin, d.diary_id)).toEqual(['demo/photo-b', 'demo/photo-c', 'demo/photo-d']);
  });

  it('写真の並びを送らない保存は付いている写真を消さず、空の並びを送ったらすべて外す', async () => {
    const d = await api.saveDiary(teacher, personal({ attachments: jpeg('demo/photo-a') }), '1');
    const token = await lockOf(teacher, d.diary_id);
    await api.saveDiary(teacher, personal({ diary_id: d.diary_id, lock_token: token, body: '本文を直した' }), '1');
    expect(await photosOf(teacher, d.diary_id)).toEqual(['demo/photo-a']);

    await api.saveDiary(teacher, personal({ diary_id: d.diary_id, lock_token: token, attachments: [] }), '1');
    expect(await photosOf(teacher, d.diary_id)).toEqual([]);
  });

  it('写真は 3 枚まで、形式は JPEG・PNG。断ったときは日誌も写真も書かない', async () => {
    const diaries = db.diaries.length;
    const photos = db.diaryAttachments.length;
    await expect(api.saveDiary(teacher, personal({ attachments: jpeg('p1', 'p2', 'p3', 'p4') }), '1'))
      .rejects.toThrow('写真は3枚までです');
    await expect(api.saveDiary(teacher, personal({
      attachments: [{ file_path: 'demo/a.pdf', file_type: 'application/pdf' }],
    }), '1')).rejects.toThrow(/JPEG・PNG/);
    await expect(api.saveDiary(teacher, personal({
      attachments: [{ file_path: ' ', file_type: 'image/png' }],
    }), '1')).rejects.toThrow(/写真のファイル/);
    expect(db.diaries.length).toBe(diaries);
    expect(db.diaryAttachments.length).toBe(photos);

    // 既存の日誌でも同じ。断ったときは本文も写真も変えない
    const before = db.diaries.find((x) => x.diary_id === 1)!.body;
    const token = await lockOf(teacher, 1);
    await expect(api.saveDiary(teacher, personal({
      diary_id: 1, child_id: 'C001', body: '書き換えた本文', lock_token: token,
      attachments: jpeg('p1', 'p2', 'p3', 'p4'),
    }), '1')).rejects.toThrow('写真は3枚までです');
    expect(db.diaries.find((x) => x.diary_id === 1)!.body).toBe(before);
    await api.releaseLock(teacher, 1, false, token);
  });
});
