/*
 * 日誌の申請・承認・一覧の流れ（GitHub Issue #174・#139）
 * 典拠：基本設計書.md「日誌の作成から保護者への共有」(4-5)・「日誌（t_diary）」(5-4)・「入力項目の制約値」(4-9)
 *      図/画面詳細図.md「職員ダッシュボード」(2-6)・「日誌一覧画面」(3-1)・「日誌作成・編集画面」(3-2)
 *
 * ここで確かめる規則は、Go サーバ（server/api_diary_flow_test.go）にも同じものがある。片方だけを直すと食い違う。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../src/api/client';
import type { DiaryInput } from '../src/api/client';
import * as http from '../src/api/http';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { addDays, now, today } from '../src/api/util';

const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const admin2: SessionUser = {
  account_id: 2, email: 'uezono@hoiku.example.jp', role: '1', display_name: '上園 謙心',
  staff_id: 'S002', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

/** 個人日誌の入力。C004 はさくら組（class_id=1）の園児 */
const personal = (patch: Partial<DiaryInput> = {}): DiaryInput => ({
  record_type: '1', child_id: 'C004', class_id: 1, diary_date: today(), body: '個人日誌の本文', ...patch,
});

const statusOf = (id: number) => db.diaries.find((d) => d.diary_id === id)?.status;

describe('自分が申請した日誌は承認できない（基本設計書「日誌の作成から保護者への共有」(4-5)。#174 の 1）', () => {
  it('担任の下書きを書き直して申請した管理者は承認できず、日誌を開くと申請した職員が分かる', async () => {
    // 日誌 1 は高梨（S003）が書いた野原 太郎（C001）の下書き。園長が本文を書き直して申請する
    await api.saveDiary(admin, personal({ diary_id: 1, child_id: 'C001', body: '園長が書き直した本文です。' }), '2');
    const before = db.chatMessages.length;

    await expect(api.approveDiary(admin, 1, true)).rejects.toThrow('自分が申請した日誌は承認できません');
    expect(statusOf(1)).toBe('2');
    expect(db.chatMessages.length).toBe(before);
    expect((await api.getDiary(admin, 1)).applied_staff_id).toBe('S001');
  });

  it('差し戻され、作成者が直して申請し直したものは、最後に申請した人で判定する', async () => {
    await api.returnDiary(admin2, 1, '作成者が直してください');
    await api.saveDiary(teacher, personal({ diary_id: 1, child_id: 'C001', body: '高梨が直した本文です。' }), '2');
    expect((await api.getDiary(admin, 1)).applied_staff_id).toBe('S003');
    await expect(api.approveDiary(admin, 1, false)).resolves.toMatchObject({ status: '3' });
  });

  it('ほかの管理者が書き直して申請したものは、別の管理者が承認できる', async () => {
    // 日誌 7 は宮城（S004）が書いた申請中の個人日誌。差し戻して、上園が書き直して申請する
    await api.returnDiary(admin, 7, '書き直します');
    await api.saveDiary(admin2, personal({ diary_id: 7, body: '上園が書き直した本文です。' }), '2');
    await expect(api.approveDiary(admin2, 7, false)).rejects.toThrow('自分が申請した日誌は承認できません');
    await expect(api.approveDiary(admin, 7, false)).resolves.toMatchObject({ status: '3' });
  });
});

describe('対象のクラスは必須（図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目5。#174 の 2）', () => {
  it('クラスを指定しない日誌は、一般も管理者も作れない', async () => {
    const before = db.diaries.length;
    const cases: [SessionUser, DiaryInput, '1' | '2'][] = [
      [teacher, personal({ class_id: null }), '1'],
      [admin, personal({ class_id: null }), '2'],
      [admin, { record_type: '2', child_id: null, class_id: null, diary_date: today(), body: 'クラスなし' }, '1'],
      [admin, { record_type: '3', child_id: null, class_id: null, diary_date: today(), body: 'クラスなし' }, '1'],
      [admin, personal({ record_type: '4', class_id: null }), '1'],
    ];
    for (const [user, input, status] of cases) {
      await expect(api.saveDiary(user, input, status)).rejects.toThrow('対象のクラスを選んでください');
    }
    expect(db.diaries.length).toBe(before);
  });

  it('既存の日誌のクラスを外すこともできない', async () => {
    const d = await api.saveDiary(teacher, personal(), '1');
    await expect(api.saveDiary(teacher, personal({ diary_id: d.diary_id, class_id: null }), '1'))
      .rejects.toThrow('対象のクラスを選んでください');
    expect(db.diaries.find((x) => x.diary_id === d.diary_id)?.class_id).toBe(1);
  });

  it('個人日誌のクラスは、対象の園児が在籍するクラスに限る', async () => {
    await expect(api.saveDiary(admin, personal({ class_id: 2 }), '1')).rejects.toThrow('在籍するクラス');
    await expect(api.saveDiary(admin, personal({ body: '園長の記録' }), '1')).resolves.toMatchObject({ class_id: 1 });
  });
});

describe('記録日は当日まで（基本設計書「入力項目の制約値」(4-9)。#174 の 5）', () => {
  it('未来日と形の崩れた日付は、下書きも申請も断る', async () => {
    const tomorrow = addDays(today(), 1);
    const cases: [string, string][] = [
      [tomorrow, '記録日に未来日は指定できません'],
      ['', '記録日の形式が正しくありません'],
      ['2026-10-1', '記録日の形式が正しくありません'],
      ['2026-02-30', '記録日の形式が正しくありません'],
    ];
    for (const [date, message] of cases) {
      for (const status of ['1', '2'] as const) {
        await expect(api.saveDiary(teacher, personal({ diary_date: date }), status)).rejects.toThrow(message);
      }
    }
    const d = await api.saveDiary(teacher, personal({ body: '今日の記録' }), '1');
    await expect(api.saveDiary(teacher, personal({ diary_id: d.diary_id, diary_date: tomorrow }), '1'))
      .rejects.toThrow('記録日に未来日は指定できません');
    expect(db.diaries.some((x) => !x.is_deleted && x.diary_date > today())).toBe(false);
  });
});

describe('差し戻す理由は承認されるまで残す（基本設計書「日誌（t_diary）」(5-4)。#174 の 4）', () => {
  it('下書き保存・再申請では消さず、次の差し戻しで上書きし、承認で消す', async () => {
    const reason = '食事と午睡の様子を書き足してください';
    const d = await api.saveDiary(teacher, personal(), '2');
    await api.returnDiary(admin, d.diary_id, reason);

    await api.saveDiary(teacher, personal({ diary_id: d.diary_id, body: '書き足しました（下書き）' }), '1');
    expect((await api.getDiary(admin, d.diary_id)).returned_reason).toBe(reason);
    await api.saveDiary(teacher, personal({ diary_id: d.diary_id, body: '書き足しました' }), '2');
    expect((await api.getDiary(admin, d.diary_id)).returned_reason).toBe(reason);

    await api.returnDiary(admin, d.diary_id, 'もう少し');
    expect((await api.getDiary(admin, d.diary_id)).returned_reason).toBe('もう少し');
    await api.saveDiary(teacher, personal({ diary_id: d.diary_id, body: '直しました' }), '2');
    await api.approveDiary(admin, d.diary_id, false);
    expect((await api.getDiary(admin, d.diary_id)).returned_reason).toBeNull();
  });
});

describe('申請中・承認済みの日誌は保存できない（サーバの updateDiary と同じ）', () => {
  it('申請中（日誌 2）・承認済み（日誌 4）の日誌は、書き換えも申請もできない', async () => {
    await expect(api.saveDiary(teacher, {
      diary_id: 2, record_type: '2', child_id: null, class_id: 1, diary_date: today(), body: '書き換え',
    }, '1')).rejects.toThrow('申請中または承認済みの日誌は編集できません');
    await expect(api.saveDiary(teacher, personal({ diary_id: 4, child_id: 'C002', body: '書き換え' }), '2'))
      .rejects.toThrow('申請中または承認済みの日誌は編集できません');
    expect(db.diaries.find((x) => x.diary_id === 4)?.body).not.toBe('書き換え');
  });
});

describe('ダッシュボードの「差し戻された日誌」と日誌一覧（図/画面詳細図.md「職員ダッシュボード」(2-6) 項目2。#174 の 3）', () => {
  it('自分が書いたものに絞ると、期間とクラスによらず、ダッシュボードで数えた日誌が出る', async () => {
    // 40 日前の記録（一覧の期間の既定＝直近 31 日の外）を申請し、差し戻される
    const old = await api.saveDiary(teacher, personal({ diary_date: addDays(today(), -40), body: '40日前の記録' }), '2');
    await api.returnDiary(admin, old.diary_id, '書き足してください');
    // 以前の版で、クラスを指定せずに保存された個人日誌（差し戻し）
    const legacyId = 99_001;
    db.diaries.unshift({
      diary_id: legacyId, record_type: '1', child_id: 'C004', class_id: null, diary_date: today(), body: 'クラスなしの記録',
      status: '4', created_staff_id: 'S003', approved_staff_id: 'S001', approved_at: null,
      is_shared_to_guardian: false, shared_at: null, nap_abnormal_id: null, returned_reason: '直してください',
      is_deleted: false, created_at: now(), updated_at: now(),
    });

    const { returned } = await api.staffSummary(teacher);
    const mine = await api.listDiaries(teacher, { status: '4', mine: true });
    const ids = mine.rows.map((d) => d.diary_id);
    expect(mine.total).toBe(returned);
    expect(ids).toEqual(expect.arrayContaining([old.diary_id, legacyId]));
    expect(ids).not.toContain(3); // 宮城のヒヤリハット（差し戻し）は自分が書いたものではない

    // クラスで絞っても、クラスの空いた個人日誌は園児の在籍クラスで拾う
    const sakura = (await api.listDiaries(teacher, { status: '4', mine: true, classId: 1 })).rows.map((d) => d.diary_id);
    expect(sakura).toEqual(expect.arrayContaining([old.diary_id, legacyId]));
    const himawari = (await api.listDiaries(admin, { status: '4', classId: 2 })).rows.map((d) => d.diary_id);
    expect(himawari).not.toContain(old.diary_id);
    expect(himawari).not.toContain(legacyId);

    // 自分が書いたもので絞らなければ、見える範囲の差し戻しがすべて出る
    expect((await api.listDiaries(teacher, { status: '4' })).rows.map((d) => d.diary_id)).toContain(3);
  });
});

describe('この園児の過去の記録（#139 の 1・#174 の 6）', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('いま開いている日誌そのものは出さない', async () => {
    expect((await api.pastDiariesOf(teacher, 'C001')).map((d) => d.diary_id)).toContain(1);
    const past = (await api.pastDiariesOf(teacher, 'C001', 1)).map((d) => d.diary_id);
    expect(past).not.toContain(1);
    expect(past).toContain(5);
  });

  it('Go サーバへつなぐときも、除く日誌と「自分が書いたもの」の指定を送る', async () => {
    const fetch = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await http.api.pastDiariesOf(teacher, 'C001', 1);
    await http.api.listDiaries(teacher, { status: '4', mine: true });
    const urls = fetch.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls[0]).toBe('/api/children/C001/diaries?exclude=1');
    expect(urls[1]).toContain('mine=1');
    expect(urls[1]).toContain('status=4');
  });
});
