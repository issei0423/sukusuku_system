/*
 * 日誌の編集ロック（GitHub Issue #166 の 1〜3）
 * 典拠：基本設計書.md「同時編集の検出」(4-2)「識別子が一致しない場合は、他者の更新の有無にかかわらず保存を拒否する
 *      （管理者による強制解除を検出するため）」「開いてから他者による更新があった場合、上書きせず」、
 *      「日誌の作成から保護者への共有」(4-5)「保存時のロック識別子が、現在有効なロックと一致するかを照合する」、
 *      「編集ロックの解除」(4-5)「解除された編集者の保存は、他者の更新の有無にかかわらず拒否する」
 *      「編集画面で一定時間（マスタ値）操作がない場合、自動で解除する」、5-4 last_active_at「無操作の判定に用いる」
 *
 * Go サーバ（server/api_diary_lock_test.go）と同じ観点で確かめる。片方だけを直すと食い違う。
 * mockDb は同じファイルのテストで使い回すため、日誌 1 を申請する（編集できなくなる）テストを最後に置く。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import type { DiaryInput } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { now, plusMinutes, today } from '../src/api/util';

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

const RELEASED = '編集ロックが解除されました。内容を再読み込みしてください';

// 日誌 1 は高梨（さくら組）の下書き。野原 太郎（C001）の個人日誌
const diary1 = (token: string | undefined, body: string): DiaryInput => ({
  diary_id: 1, record_type: '1', child_id: 'C001', class_id: 1, diary_date: today(), body, lock_token: token,
});
const bodyOf1 = () => db.diaries.find((d) => d.diary_id === 1)!.body;
const lockOf1 = () => db.diaryLocks.find((l) => l.diary_id === 1);

it('承認済みの日誌には編集ロックを取得できない', async () => {
  await expect(api.acquireLock(teacher, 5)).rejects.toThrow();
  expect(db.diaryLocks.some((l) => l.diary_id === 5)).toBe(false);
});

async function tokenOf(u: SessionUser, diaryId: number): Promise<string> {
  const r = await api.acquireLock(u, diaryId);
  if (!('token' in r)) throw new Error(`ロックを取れませんでした（${r.heldBy}さんが編集中）`);
  return r.token;
}

// 無操作の時間（既定 15 分）より前に、最後の操作があったことにする
const stale = () => { lockOf1()!.last_active_at = plusMinutes(now(), -20); };

describe('強制解除された編集者の保存（GitHub Issue #166 の 1）', () => {
  it('管理者が強制解除したあとは、古い識別子でも識別子なしでも保存できない', async () => {
    const t1 = await tokenOf(teacher, 1);
    await api.releaseLock(admin, 1, true);

    await expect(api.saveDiary(teacher, diary1(t1, '解除されたあとの保存'), '1')).rejects.toThrow(RELEASED);
    await expect(api.saveDiary(teacher, diary1(t1, '解除されたあとの申請'), '2')).rejects.toThrow(RELEASED);
    await expect(api.saveDiary(teacher, diary1(undefined, '識別子なしの保存'), '1')).rejects.toThrow(RELEASED);
    expect(bodyOf1()).not.toMatch(/解除されたあと|識別子なし/);

    // 開き直せば（ロックを取り直せば）保存できる
    const t2 = await tokenOf(teacher, 1);
    await expect(api.saveDiary(teacher, diary1(t2, '開き直してからの保存'), '1')).resolves.toMatchObject({ body: '開き直してからの保存' });
    await api.releaseLock(teacher, 1, false, t2);
  });
});

describe('ロックの識別子（GitHub Issue #166 の 2）', () => {
  it('ロックの状態には誰が編集中かだけを返し、識別子は返さない', async () => {
    const t1 = await tokenOf(teacher, 1);
    const l = await api.lockOf(admin, 1);
    expect(l).toMatchObject({ staff_name: '高梨 倫太朗', locked_staff_id: 'S003' });
    expect(JSON.stringify(l)).not.toContain(t1);
    expect(l).not.toHaveProperty('lock_token');

    // ほかの人が持つ識別子を使っても、本人でなければ保存できない
    await expect(api.saveDiary(admin, diary1(t1, '園長の上書き'), '1')).rejects.toThrow(RELEASED);
    expect(bodyOf1()).not.toBe('園長の上書き');
    await api.releaseLock(teacher, 1, false, t1);
  });
});

describe('確認画面にいる間の、ほかの職員の直し（GitHub Issue #166 の 1 の手順 B）', () => {
  it('ロックを持っている間はほかの職員が保存できず、外れたあとに直されたら古い識別子の申請は断る', async () => {
    const t1 = await tokenOf(teacher, 1);
    await expect(api.acquireLock(admin, 1)).resolves.toEqual({ heldBy: '高梨 倫太朗' });
    await expect(api.saveDiary(admin, diary1(undefined, '園長が直して保存した版'), '1')).rejects.toThrow(RELEASED);

    await api.releaseLock(teacher, 1, false, t1);
    const t2 = await tokenOf(admin, 1);
    await api.saveDiary(admin, diary1(t2, '園長が直して保存した版'), '1');
    await api.releaseLock(admin, 1, false, t2);

    await expect(api.saveDiary(teacher, diary1(t1, '高梨の版'), '2')).rejects.toThrow(RELEASED);
    expect(bodyOf1()).toBe('園長が直して保存した版');
    expect(db.diaries.find((d) => d.diary_id === 1)!.status).toBe('1');
  });
});

describe('編集を続けている間のロック（GitHub Issue #166 の 3）', () => {
  it('操作を知らせている間は、取った時刻から無操作の時間を過ぎてもほかの職員に移らない', async () => {
    const t1 = await tokenOf(teacher, 1);
    stale();
    await api.touchLock(teacher, 1, t1);
    expect(lockOf1()!.last_active_at).toBe(now());
    await expect(api.acquireLock(admin, 1)).resolves.toEqual({ heldBy: '高梨 倫太朗' });

    // 操作の知らせも、本人の識別子でなければ受け付けない
    await expect(api.touchLock(admin, 1, t1)).rejects.toThrow(RELEASED);
    await expect(api.touchLock(teacher, 1, 'lock-1-wrong')).rejects.toThrow(RELEASED);

    // 下書き保存も操作として数える
    stale();
    await api.saveDiary(teacher, diary1(t1, '書き続けた本文'), '1');
    expect(lockOf1()).toMatchObject({ lock_token: t1, last_active_at: now() });

    // 操作が無いまま無操作の時間を過ぎると、ほかの職員が引き取れ、元の編集者の知らせと保存は断る
    stale();
    const t2 = await tokenOf(admin, 1);
    await expect(api.touchLock(teacher, 1, t1)).rejects.toThrow(RELEASED);
    await expect(api.saveDiary(teacher, diary1(t1, '引き取られたあとの保存'), '1')).rejects.toThrow(RELEASED);
    await expect(api.saveDiary(admin, diary1(t2, '引き取った人の保存'), '1')).resolves.toBeTruthy();
    await api.releaseLock(admin, 1, false, t2);
  });
});

describe('ロックの解除は識別子で行う', () => {
  it('同じ人が取り直したあとに、古い識別子の解除が届いても外さない', async () => {
    const t1 = await tokenOf(teacher, 1);
    const t2 = await tokenOf(teacher, 1);
    await api.releaseLock(teacher, 1, false, t1);
    expect(lockOf1()?.lock_token).toBe(t2);
    // 識別子を添えない解除も外さない
    await api.releaseLock(teacher, 1);
    expect(lockOf1()?.lock_token).toBe(t2);
    await expect(api.saveDiary(teacher, diary1(t2, '取り直した識別子での保存'), '1')).resolves.toBeTruthy();

    await api.releaseLock(teacher, 1, false, t2);
    expect(lockOf1()).toBeUndefined();
  });
});

describe('申請とロック（最後に置く。日誌 1 が申請中になる）', () => {
  it('申請するとロックを外す（申請中の日誌は編集できないため）', async () => {
    const t1 = await tokenOf(teacher, 1);
    await api.saveDiary(teacher, diary1(t1, '申請する本文'), '2');
    expect(lockOf1()).toBeUndefined();
  });
});
