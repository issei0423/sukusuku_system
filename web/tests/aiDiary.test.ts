/*
 * 保育日誌の下書き（purpose: diary）のモック
 * 典拠：詳細設計書「保育日誌の下書き」(8-12)・「日誌の画面（作り直し）」(2-13 (7))・「テストの観点」(9-1) の「AI に氏名が送られない」「AI の失敗」・
 *      「2か所の規則をそろえる」(9-2)、基本設計書「文章の下書き（AI）」(4-11)・「外部の AI へ送る情報」(6-3)
 *
 * Go の同じ観点は server/api_ai_diary_test.go にある（同じ行・同じ期待値）。モックは外部へつながない。渡す文を mockAi.lastSent で確かめる。
 * web のテストの時計は今日の 18:00。mockDb はこのファイルのテストで使い回すので、書き換えたものは戻す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from '../src/api/client';
import { mockAi, aiDiarySystemFor, AI_SYSTEM, normalizeAiHeadings } from '../src/api/mock';
import * as db from '../src/api/mockDb';
import { today, addDays } from '../src/api/util';
import { MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';
import type { AiDiaryDraftInput } from '../src/api/shapes';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const otherTeacher = user(5, '2', { staff_id: 'S005', class_id: 2, class_name: 'ひまわり組' });
// ひまわり組の担任の担当を外したフリーの職員（server/api_diary_free_test.go と同じ作り）
const freeStaff = user(5, '2', { staff_id: 'S005', class_id: null, class_name: null });
const taroGuardian = user(6, '3', { guardian_id: 'G001' });

const setSetting = (key: string, value: string) => { db.settings.find((s) => s.setting_key === key)!.setting_value = value; };

beforeEach(() => {
  setSetting('ai.enabled', '1');
  setSetting('ai.daily_limit', '300');
  Object.assign(mockAi, { mode: 'ok', keyPresent: true, keyRejected: false, lastSent: null, calls: 0 });
});
afterEach(() => {
  setSetting('ai.enabled', '0');
  setSetting('contact.show_items', 'nap,meal,toilet,temperature,comment,photo,class');
  Object.assign(mockAi, { mode: 'ok', keyPresent: true, keyRejected: false });
});

type Rejected = Error & { kind?: string };
async function rejection(p: Promise<unknown>): Promise<Rejected> {
  try { await p; } catch (e) { return e as Rejected; }
  throw new Error('拒まれなかった');
}

/** 個人日誌（C001・さくら組）を既定とした要求。値が undefined の項目は外す（server/api_ai_diary_test.go の diaryDraftBody） */
const body = (extra: Record<string, unknown> = {}): AiDiaryDraftInput => {
  const m: Record<string, unknown> = { purpose: 'diary', record_type: '1', child_id: 'C001', class_id: 1, date: today(), headings: ['【今日の様子】', '【食事】'], ...extra };
  for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
  return m as unknown as AiDiaryDraftInput;
};

/** C001 の今日の記録（送ってよいもの・送らないもの）を入れ、あとで消す（server/api_ai_test.go の insertTodayRecords と同じ） */
function insertTodayRecords(): () => void {
  const d = today();
  const base = { child_id: 'C001', class_id: 1, contact_date: d, meal_kind: null, meal_amount: null, toilet_label: null, temperature: null,
    body: null, contact_photo_id: null, keep_in_growth: false, staff_id: 'S003', corrected_at: null, is_deleted: false } as const;
  const ids: number[] = [];
  const ev = (id: number, extra: Partial<(typeof db.contactEvents)[number]>) => {
    ids.push(id);
    db.contactEvents.push({ ...base, contact_event_id: id, event_type: '4', recorded_at: `${d}T00:10:00`, created_at: `${d}T00:10:00`, updated_at: `${d}T00:10:00`, ...extra });
  };
  ev(91001, { event_type: '1', meal_kind: '1', meal_amount: '1' });
  ev(91002, { event_type: '2', toilet_label: 'うんち', recorded_at: `${d}T00:11:00` });
  ev(91003, { event_type: '3', temperature: 37.8, recorded_at: `${d}T00:12:00` });
  ev(91004, { event_type: '4', body: '西田太郎くんは、あおちゃんと砂場で型抜きをくり返していました。', recorded_at: `${d}T00:13:00` });
  ev(91005, { event_type: '4', body: '取り消した文', recorded_at: `${d}T00:14:00`, is_deleted: true });
  db.napSleeps.push({ nap_sleep_id: 91006, nap_session_id: 1, child_id: 'C001', slept_at: `${d}T00:20:00`, woke_at: `${d}T00:50:00`, sleep_temperature: 36.9,
    slept_staff_id: 'S003', woke_staff_id: 'S003', corrected_at: null, is_deleted: false, created_at: `${d}T00:20:00`, updated_at: `${d}T00:50:00` });
  db.contactClasses.push({ contact_class_id: 91007, class_id: 1, contact_date: d, body: 'たっくんとゆいちゃんがしゃぼん玉を追いかけました。', contact_photo_id: null,
    source_diary_id: null, staff_id: 'S003', recorded_at: `${d}T00:30:00`, corrected_at: null, is_deleted: false, created_at: `${d}T00:30:00`, updated_at: `${d}T00:30:00` });
  return () => {
    for (const id of ids) db.contactEvents.splice(db.contactEvents.findIndex((e) => e.contact_event_id === id), 1);
    db.napSleeps.splice(db.napSleeps.findIndex((s) => s.nap_sleep_id === 91006), 1);
    db.contactClasses.splice(db.contactClasses.findIndex((c) => c.contact_class_id === 91007), 1);
  };
}

/** C001 だけが在籍するクラス 90（全員が使える条件を満たす）を作り、今日と365日先のクラスのようすを入れる（server/api_ai_diary_test.go の setupClass90） */
function setupClass90(): () => void {
  db.classes.push({ class_id: 90, fiscal_year: db.FISCAL_YEAR, class_name: 'テスト組', age_class: 1 } as (typeof db.classes)[number]);
  db.classChildren.push({ class_id: 90, child_id: 'C001' });
  const ids = [91101, 91102];
  [today(), addDays(today(), 365)].forEach((d, i) => db.contactClasses.push({
    contact_class_id: ids[i], class_id: 90, contact_date: d, body: 'たっくんとゆいちゃんが園庭を歩きました。', contact_photo_id: null,
    source_diary_id: null, staff_id: 'S003', recorded_at: `${today()}T00:30:00`, corrected_at: null, is_deleted: false,
    created_at: `${today()}T00:30:00`, updated_at: `${today()}T00:30:00`,
  }));
  return () => {
    for (const id of ids) db.contactClasses.splice(db.contactClasses.findIndex((c) => c.contact_class_id === id), 1);
    db.classChildren.splice(db.classChildren.findIndex((c) => c.class_id === 90), 1);
    db.classes.splice(db.classes.findIndex((c) => c.class_id === 90), 1);
  };
}

const lastLog = () => db.operationLogs.find((l) => l.operation_type === '6')!;
const sections = () => JSON.parse(mockAi.lastSent!.user) as { 見出し: string[]; クラスのようす: string[]; 先生のメモ?: string };

describe('保育日誌の下書き（server/api_ai_diary_test.go と同じ観点）', () => {
  it('個人日誌：送った中身は見出し・クラスのようす・メモだけ。氏名・体温・食事・午睡・ひとことは送らず、「〇〇ちゃん」は呼び名に戻る', async () => {
    const undo = insertTodayRecords();
    try {
      const memo = '美咲ちゃんとも遊んだ。電話は 090-1234-5678。西田拓也さんと久保田先生に伝えた';
      const res = await api.aiDrafts(teacher, body({ memo }));
      const sent = mockAi.lastSent!;
      const birth = db.children.find((c) => c.child_id === 'C001')!.birth_date;
      for (const ng of ['西田', '太郎', 'たっくん', 'にしだ', 'たろう', '伊藤', 'あおちゃん', '小林', 'ゆいちゃん', '村田', '美咲',
        birth, '37.8', '36.9', '拓也', '久保田', 'うんち', '090', '1234', 'さくら組', '鈴木', '取り消した文', '給食', 'ぜんぶ', '型抜き', 'おひるね', '00:50']) {
        expect(sent.user, ng).not.toContain(ng);
        expect(sent.system, ng).not.toContain(ng);
      }
      const facts = sections();
      expect(facts.見出し).toEqual(['今日の様子', '食事']);
      expect(facts.クラスのようす).toContain('〇〇ちゃんとおともだちがしゃぼん玉を追いかけました。');
      expect(facts.先生のメモ).toBe('おともだちとも遊んだ。電話は （伏せました）。保護者の方と先生に伝えた');
      expect(sent.system).toBe(AI_SYSTEM.diary);
      expect(sent.system).toBe(aiDiarySystemFor(false));
      expect(sent.system).toContain('保護者には届きません');
      expect(sent.system).not.toContain('やわらかい丁寧語');
      // 「【見出し】」と文を空行でつなぎ、宛先の名前は呼び名に戻る。最初の見出しにだけ材料が入り、ほかは見出しだけ
      expect(res.drafts).toHaveLength(1);
      expect(res.drafts[0].startsWith('【今日の様子】\nたっくんと')).toBe(true);
      expect(res.drafts[0].endsWith('\n\n【食事】')).toBe(true);
      expect(res.drafts[0]).not.toContain('〇〇');
      expect(res.replaced_other_names).toBe(true);
      // 操作ログ：日誌（1）・6・t_diary・個人日誌は園児。文は残さない
      const l = lastLog();
      expect([l.function_type, l.operation_type, l.target_table, l.target_child_id, l.after_value]).toEqual(['1', '6', 't_diary', 'C001', '{"用途":"保育日誌","結果":"成功"}']);
      expect(db.operationLogs.some((x) => `${x.before_value}${x.after_value}`.includes('しゃぼん玉'))).toBe(false);
    } finally {
      undo();
    }
  });

  it('共有を選んだ個人日誌は保護者へ送る文の共通の決まりを当てる。出さない設定のクラスのようすは送らない。共有は個人日誌だけ（要決定事項の推し B）', async () => {
    const undo = insertTodayRecords();
    const undo90 = setupClass90();
    try {
      await api.aiDrafts(teacher, body({ share_to_guardian: true }));
      const sent = mockAi.lastSent!;
      expect(sent.system).toBe(aiDiarySystemFor(true));
      expect(sent.system).toContain('保護者に向けた、やわらかい丁寧語');
      expect(sent.system).not.toContain('保護者には届きません');
      expect(sections().クラスのようす.length).toBeGreaterThan(0);

      setSetting('contact.show_items', 'meal,nap');
      await api.aiDrafts(teacher, body({ share_to_guardian: true }));
      expect(sections().クラスのようす).toEqual([]);
      await api.aiDrafts(teacher, body());
      expect(sections().クラスのようす.length).toBeGreaterThan(0);
      expect(mockAi.lastSent!.system).toBe(AI_SYSTEM.diary);

      await api.aiDrafts(admin, body({ record_type: '2', child_id: undefined, class_id: 90, share_to_guardian: true }));
      expect(mockAi.lastSent!.system).toBe(AI_SYSTEM.diary);
    } finally {
      undo90();
      undo();
    }
  });

  it('クラス日誌：クラスの全園児が宛先。全員が「おともだち」で名前は戻さない。見出しが空なら【記録】。週案月案は365日先まで', async () => {
    const undo = setupClass90();
    try {
      const klass = (extra: Record<string, unknown> = {}) => body({ record_type: '2', child_id: undefined, class_id: 90, headings: [], ...extra });
      const res = await api.aiDrafts(admin, klass());
      expect(sections().見出し).toEqual(['記録']);
      expect(sections().クラスのようす).toEqual(['おともだちとおともだちが園庭を歩きました。']);
      expect(res.drafts[0]).toBe('【記録】\nおともだちとおともだちが園庭を歩きました。');
      expect(lastLog().target_child_id).toBeNull();
      await expect(api.aiDrafts(admin, klass({ record_type: '3', date: addDays(today(), 365) }))).resolves.toBeTruthy();
      expect((await rejection(api.aiDrafts(admin, klass({ record_type: '3', date: addDays(today(), 366) })))).message).toBe(MSG.badRequest);
      expect((await rejection(api.aiDrafts(admin, klass({ date: addDays(today(), 1) })))).message).toBe(MSG.badRequest);
      expect(mockAi.calls).toBe(2);
    } finally {
      undo();
    }
  });

  it('要求の検査と使えない条件（呼ぶ前に止め、操作ログにも残さない）。ヒヤリハットは 403', async () => {
    const undo = setupClass90();
    const before = db.operationLogs.filter((l) => l.operation_type === '6').length;
    try {
      const many = Array.from({ length: 21 }, (_, i) => `見出し${i}`);
      const cases: [string, SessionUser, AiDiaryDraftInput, string, string?][] = [
        ['記録種別が無い', teacher, body({ record_type: undefined }), MSG.badRequest],
        ['記録種別が違う', teacher, body({ record_type: '9' }), MSG.badRequest],
        ['個人日誌に園児が無い', teacher, body({ child_id: undefined }), MSG.badRequest],
        ['クラス日誌に園児がある', admin, body({ record_type: '2', class_id: 90 }), MSG.badRequest],
        ['クラスが無い', teacher, body({ class_id: undefined }), MSG.badRequest],
        ['日付の形が崩れている', teacher, body({ date: '2026/11/26' }), MSG.badRequest],
        ['個人日誌の記録日が未来', teacher, body({ date: addDays(today(), 1) }), MSG.badRequest],
        ['見出しが21個', teacher, body({ headings: many }), MSG.badRequest],
        ['見出しが51文字', teacher, body({ headings: ['あ'.repeat(51)] }), MSG.badRequest],
        ['見出しが空', teacher, body({ headings: ['【】'] }), MSG.badRequest],
        ['メモが500文字を超える', teacher, body({ memo: 'あ'.repeat(501) }), MSG.aiMemoTooLong],
        ['ヒヤリハットには使えない', teacher, body({ record_type: '4' }), MSG.aiUnavailableForTarget],
        ['ほかのクラスの担任（個人日誌）', otherTeacher, body(), MSG.aiUnavailableForTarget],
        ['担当クラスの無い一般（フリー）は書けない', freeStaff, body({ record_type: '2', child_id: undefined, class_id: 90 }), MSG.aiUnavailableForTarget],
        ['断った子・未同意の子', admin, body({ child_id: 'C002' }), MSG.aiUnavailableForTarget],
        ['園児がそのクラスに在籍していない', admin, body({ class_id: 90, child_id: 'C004' }), MSG.aiUnavailableForTarget],
        ['クラスの全園児が条件を満たさない（さくら組）', teacher, body({ record_type: '2', child_id: undefined }), MSG.aiUnavailableForTarget],
        ['メモに AI を使えない子の名前', teacher, body({ memo: '遠藤さんとボール遊び' }), MSG.aiExcludedName, 'ai_excluded_name'],
      ];
      for (const [name, who, input, msg, kind] of cases) {
        const e = await rejection(api.aiDrafts(who, input));
        expect([name, e.message, e.kind]).toEqual([name, msg, kind]);
      }
      await expect(api.aiDrafts(taroGuardian, body())).rejects.toThrow();
      expect(mockAi.calls).toBe(0);
      expect(db.operationLogs.filter((l) => l.operation_type === '6').length).toBe(before);
      setSetting('ai.enabled', '0');
      expect((await rejection(api.aiDrafts(teacher, body()))).message).toBe(MSG.aiUnavailableForTarget);
    } finally {
      undo();
    }
  });

  it('見出しは0〜20個・1つ50文字。【】は外して送る。同じ見出しは1つに。名前は置き換える', async () => {
    const cases: [string, string[] | undefined, string][] = [
      ['空は【記録】1つ', [], '記録'],
      ['【】を外す・前後の空白を外す', ['【今日の様子】', ' 食事 '], '今日の様子|食事'],
      ['同じ見出しは最初の1つだけ', ['【食事】', '食事', '【午睡】'], '食事|午睡'],
      ['名前を置き換える', ['たっくんの様子', 'あおちゃんとの遊び'], '〇〇ちゃんの様子|おともだちとの遊び'],
    ];
    for (const [name, headings, want] of cases) {
      await api.aiDrafts(teacher, body({ headings }));
      expect([name, sections().見出し.join('|')]).toEqual([name, want]);
    }
    const twenty = Array.from({ length: 20 }, (_, i) => `【${'あ'.repeat(49)}${String.fromCharCode(65 + i)}】`);
    await api.aiDrafts(teacher, body({ headings: twenty }));
    expect(sections().見出し).toHaveLength(20);
    // 整える関数そのものも同じ
    expect(normalizeAiHeadings(['【記録】'])).toEqual(['記録']);
    expect(normalizeAiHeadings(['【】'])).toBeNull();
    expect(normalizeAiHeadings(Array.from({ length: 21 }, (_, i) => `x${i}`))).toBeNull();
  });

  it('失敗：503 と操作ログの「失敗」。本文の上限（2,000文字）を超える下書きは使わない。上限は園全体で1つ', async () => {
    const undo = insertTodayRecords();
    try {
      for (const mode of ['fail', 'refuse'] as const) {
        mockAi.mode = mode;
        const e = await rejection(api.aiDrafts(teacher, body()));
        expect([e.message, e.kind]).toEqual([MSG.aiFailed, 'ai_unavailable']);
        expect(lastLog().after_value).toBe('{"用途":"保育日誌","結果":"失敗"}');
      }
      mockAi.mode = 'ok';
      // クラスのようすが長く、下書きが本文の上限を超える
      const long = db.contactClasses.find((c) => c.contact_class_id === 91007)!;
      const keep = long.body;
      long.body = 'あ'.repeat(2000);
      const e = await rejection(api.aiDrafts(teacher, body()));
      expect([e.message, e.kind]).toEqual([MSG.aiFailed, 'ai_unavailable']);
      long.body = keep;

      // 上限：園からのひとことで1回使うと、日誌の下書きで残りは1回
      const used = db.operationLogs.filter((l) => l.operation_type === '6' && l.operated_at.startsWith(today()) && (l.after_value ?? '').includes('成功')).length;
      setSetting('ai.daily_limit', String(used + 2));
      await api.aiDrafts(teacher, { purpose: 'facility_note', child_id: 'C001', date: today() });
      await api.aiDrafts(teacher, body());
      const limit = await rejection(api.aiDrafts(teacher, body()));
      expect([limit.message, limit.kind]).toEqual([MSG.aiLimit, 'ai_limit']);
      mockAi.mode = 'limit';
      expect((await rejection(api.aiDrafts(teacher, body()))).kind).toBe('ai_limit');
    } finally {
      undo();
    }
  });
});
