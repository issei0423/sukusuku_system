/*
 * 文章の下書き（AI）と設定画面の AI の区画（モック）
 * 典拠：詳細設計書「AI」(8)：「経路」(8-2)・「使える条件」(8-3)・「送る項目」(8-4)・「置き換えの手順」(8-5)・「テストでの差し替え」(8-11)、
 *      「設定」(4-10)・「テストの観点」(9-1) の「AI 無しで動く」「AI に氏名が送られない」「AI の失敗」・「2か所の規則をそろえる」(9-2)
 *
 * Go の同じ観点は server/api_ai_test.go・server/ai_test.go・server/api_settings_test.go にある。
 * anonymizeCases・restoreCases・aiAvailabilityCases は Go の同じ名前の表と同じ行にする。
 * モックは外部へつながない。渡す文を mockAi.lastSent で確かめる。web のテストの時計は今日の 18:00。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from '../src/api/client';
import { anonymize, restoreName, aiAvailableFor, mockAi, AI_SYSTEM } from '../src/api/mock';
import type { NameChild } from '../src/api/mock';
import * as db from '../src/api/mockDb';
import { today, addDays } from '../src/api/util';
import { MSG, aiTextTooLong } from '../src/messages';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const otherTeacher = user(5, '2', { staff_id: 'S005', class_id: 2, class_name: 'ひまわり組' });
const taroGuardian = user(6, '3', { guardian_id: 'G001' });

/** server/namecheck_test.go の nameCheckChildren と同じ作り物の園児 */
const children: NameChild[] = [
  { id: 'A', name: '野原 太郎', kana: 'のはら たろう', nickname: 'たっくん' },
  { id: 'B', name: '伊藤 葵', kana: 'いとう あおい', nickname: 'あおちゃん' },
  { id: 'C', name: '小林 結衣', kana: 'こばやし ゆい', nickname: 'ゆいちゃん' },
  { id: 'D', name: '井上 空', kana: 'いのうえ そら', nickname: '' },
  { id: 'E', name: '前田 詩', kana: 'まえだ うた', nickname: '' },
  { id: 'F', name: '林 悠真', kana: 'はやし ゆうま', nickname: '' },
  { id: 'G', name: '山田 ゆい', kana: 'やまだ ゆい', nickname: '' },
  { id: 'H', name: '野原 あい', kana: 'のはら あい', nickname: '' },
];

/** server/ai_test.go の anonymizeCases と同じ行（宛先が空ならクラスあて） */
const anonymizeCases: [name: string, recipient: string, text: string, want: string, replaced: boolean][] = [
  ['宛先の呼び名を〇〇ちゃんに', 'A', 'たっくんが砂場で遊びました。', '〇〇ちゃんが砂場で遊びました。', false],
  ['宛先の名と後ろの敬称をまとめて〇〇ちゃんに', 'A', '太郎くんは最後まで走りました。', '〇〇ちゃんは最後まで走りました。', false],
  ['宛先の氏名（空白あり）と敬称', 'A', '野原 太郎さんへ。', '〇〇ちゃんへ。', false],
  ['ほかの子の呼び名をおともだちに', 'A', 'あおちゃんとしゃぼん玉をしました。', 'おともだちとしゃぼん玉をしました。', true],
  ['ほかの子のよみ（カタカナ）と敬称', 'A', 'アオイちゃんと遊びました。', 'おともだちと遊びました。', true],
  ['1文字の名はふだんの言葉では替えない', 'A', '空が青い日でした。', '空が青い日でした。', false],
  ['1文字の名に敬称が続けば替える', 'A', '空くんと遊びました。', 'おともだちと遊びました。', true],
  ['宛先と同じ名の子を数えない', 'C', 'ゆいちゃんが笑っていました。', '〇〇ちゃんが笑っていました。', false],
  ['同じ姓のきょうだいの氏名は、宛先の姓より長いのでおともだち', 'A', '野原あいに伝えました。', 'おともだちに伝えました。', true],
  ['クラスあては全員をおともだちに', '', 'たっくんとあおちゃんが遊びました。', 'おともだちとおともだちが遊びました。', true],
  ['携帯電話の番号を伏せる', 'A', '090-1234-5678 にお電話ください。', '（伏せました） にお電話ください。', false],
  ['区切りの無い番号を伏せる', 'A', '09012345678まで', '（伏せました）まで', false],
  ['固定電話（10桁）を伏せる', 'A', '098（123）4567へ', '（伏せました）へ', false],
  ['メールアドレスを伏せる', 'A', 'nohara.i@example.jp へ送ってください。', '（伏せました） へ送ってください。', false],
  ['0で始まらない数は伏せない', 'A', '12345678901', '12345678901', false],
  ['12桁の数は伏せない', 'A', '090123456789', '090123456789', false],
  ['時刻は伏せない', 'A', '11:40に給食、09:30に散歩。', '11:40に給食、09:30に散歩。', false],
  ['名前が無ければそのまま', 'A', '園庭で砂場あそびをしました。', '園庭で砂場あそびをしました。', false],
];

/** server/ai_test.go の restoreCases と同じ行 */
const restoreCases: [name: string, recipient: string, text: string, want: string][] = [
  ['呼び名があれば呼び名に戻す', 'A', '〇〇ちゃんは給食をぜんぶ食べました。', 'たっくんは給食をぜんぶ食べました。'],
  ['呼び名が無ければ名にちゃんを付ける', 'D', '〇〇ちゃんは砂場で遊びました。', '空ちゃんは砂場で遊びました。'],
  ['〇〇だけが残っていても戻す', 'A', '〇〇は笑っていました。', 'たっくんは笑っていました。'],
  ['おともだちは戻さない', 'A', 'おともだちと〇〇ちゃんが遊びました。', 'おともだちとたっくんが遊びました。'],
];

describe('送る前の置き換え（server/namecheck.go の anonymize と同じ表）', () => {
  it.each(anonymizeCases)('%s', (_name, recipient, text, want, replaced) => {
    expect(anonymize(text, children.filter((c) => c.id === recipient), children)).toEqual({ text: want, replacedOthers: replaced });
  });
  it.each(restoreCases)('戻し方：%s', (_name, recipient, text, want) => {
    expect(restoreName(text, children.find((c) => c.id === recipient)!)).toBe(want);
  });
});

/* ---- 使える条件（8-3）。デモデータを書き換えて確かめ、元に戻す ---- */

const setSetting = (key: string, value: string) => {
  const row = db.settings.find((s) => s.setting_key === key)!;
  row.setting_value = value;
};
const link = (g: string, c: string) => db.guardianChildren.find((x) => x.guardian_id === g && x.child_id === c);

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

type Case = {
  name: string; who: SessionUser; target: { child_id: string } | { class_id: number }; want: boolean;
  setup?: () => void; undo?: () => void;
};
/** server/api_ai_test.go の aiAvailabilityCases と同じ行 */
const aiAvailabilityCases: Case[] = [
  { name: '園が有効にし、キーがあり、担任が、同意した保護者の子に', who: teacher, target: { child_id: 'C001' }, want: true },
  { name: '園が有効にしていない', who: teacher, target: { child_id: 'C001' }, want: false,
    setup: () => setSetting('ai.enabled', '0'), undo: () => setSetting('ai.enabled', '1') },
  { name: 'サーバにキーが無い', who: teacher, target: { child_id: 'C001' }, want: false,
    setup: () => { mockAi.keyPresent = false; }, undo: () => { mockAi.keyPresent = true; } },
  { name: 'キーが無効と分かった', who: teacher, target: { child_id: 'C001' }, want: false,
    setup: () => { mockAi.keyRejected = true; }, undo: () => { mockAi.keyRejected = false; } },
  { name: 'ほかのクラスの担任', who: otherTeacher, target: { child_id: 'C001' }, want: false },
  { name: '管理者', who: admin, target: { child_id: 'C001' }, want: true },
  { name: '保護者', who: taroGuardian, target: { child_id: 'C001' }, want: false },
  { name: '保護者がまだ1人も登録していない子', who: teacher, target: { child_id: 'C006' }, want: false },
  { name: '保護者が外部の AI を書いた版にまだ同意していない子', who: teacher, target: { child_id: 'C002' }, want: false },
  { name: '保護者が断った子', who: teacher, target: { child_id: 'C001' }, want: false,
    setup: () => { link('G001', 'C001')!.ai_opt_out = true; }, undo: () => { link('G001', 'C001')!.ai_opt_out = false; } },
  { name: '紐づく保護者の1人でも断れば使わない', who: teacher, target: { child_id: 'C001' }, want: false,
    setup: () => { db.guardianChildren.push({ guardian_id: 'G004', child_id: 'C001', relationship: '母', link_status: '1', linked_at: '2026-04-01T09:00:00', ended_at: null, ai_opt_out: true }); },
    undo: () => { db.guardianChildren.splice(db.guardianChildren.indexOf(link('G004', 'C001')!), 1); } },
  { name: '紐づく保護者の全員が同意して断っていなければ使える', who: teacher, target: { child_id: 'C001' }, want: true,
    setup: () => { db.guardianChildren.push({ guardian_id: 'G004', child_id: 'C001', relationship: '母', link_status: '1', linked_at: '2026-04-01T09:00:00', ended_at: null, ai_opt_out: false }); },
    undo: () => { db.guardianChildren.splice(db.guardianChildren.indexOf(link('G004', 'C001')!), 1); } },
  { name: '終了した紐づけの断りは数えない', who: teacher, target: { child_id: 'C001' }, want: true,
    setup: () => { db.guardianChildren.push({ guardian_id: 'G003', child_id: 'C001', relationship: '母', link_status: '2', linked_at: '2026-04-01T09:00:00', ended_at: '2026-05-01T09:00:00', ai_opt_out: true }); },
    undo: () => { db.guardianChildren.splice(db.guardianChildren.indexOf(link('G003', 'C001')!), 1); } },
  { name: 'クラスあて：在籍園児に条件を満たさない子がいる', who: teacher, target: { class_id: 1 }, want: false },
  { name: 'クラスあて：在籍園児の全員が条件を満たす', who: admin, target: { class_id: 90 }, want: true,
    setup: () => {
      db.classes.push({ class_id: 90, fiscal_year: db.FISCAL_YEAR, class_name: 'テスト組', age_class: 1 } as (typeof db.classes)[number]);
      db.classChildren.push({ class_id: 90, child_id: 'C001' });
    },
    undo: () => {
      db.classChildren.splice(db.classChildren.findIndex((c) => c.class_id === 90), 1);
      db.classes.splice(db.classes.findIndex((c) => c.class_id === 90), 1);
    } },
];

describe('使える条件 aiAvailableFor（server/api_ai_test.go と同じ表）', () => {
  it.each(aiAvailabilityCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    c.setup?.();
    try {
      expect(aiAvailableFor(c.who, c.target)).toBe(c.want);
    } finally {
      c.undo?.();
    }
  });
});

/* ---- 下書き（POST /api/ai/drafts にあたる） ---- */

type Rejected = Error & { kind?: string; field?: string };
async function rejection(p: Promise<unknown>): Promise<Rejected> {
  try { await p; } catch (e) { return e as Rejected; }
  throw new Error('拒まれなかった');
}

/** C001 の今日の記録（送ってよいもの・送らないもの）を入れ、あとで消す */
function insertTodayRecords(): () => void {
  const d = today();
  const base = { child_id: 'C001', class_id: 1, contact_date: d, meal_kind: null, meal_amount: null, toilet_label: null, temperature: null,
    body: null, contact_photo_id: null, keep_in_growth: false, staff_id: 'S003', corrected_at: null, is_deleted: false } as const;
  const ids: number[] = [];
  const ev = (id: number, extra: Partial<(typeof db.contactEvents)[number]>) => {
    ids.push(id);
    db.contactEvents.push({ ...base, contact_event_id: id, event_type: '4', recorded_at: `${d}T00:10:00`, created_at: `${d}T00:10:00`, updated_at: `${d}T00:10:00`, ...extra });
  };
  ev(90001, { event_type: '2', toilet_label: 'うんち', recorded_at: `${d}T00:11:00` });
  ev(90002, { event_type: '3', temperature: 37.8, recorded_at: `${d}T00:12:00` });
  ev(90003, { event_type: '4', body: '野原太郎くんは、あおちゃんと砂場で型抜きをくり返していました。', recorded_at: `${d}T00:13:00` });
  ev(90004, { event_type: '4', body: '取り消した文', recorded_at: `${d}T00:14:00`, is_deleted: true });
  db.napSleeps.push({ nap_sleep_id: 90005, nap_session_id: 1, child_id: 'C001', slept_at: `${d}T00:20:00`, woke_at: `${d}T00:50:00`, sleep_temperature: 36.9,
    slept_staff_id: 'S003', woke_staff_id: 'S003', corrected_at: null, is_deleted: false, created_at: `${d}T00:20:00`, updated_at: `${d}T00:50:00` });
  db.contactClasses.push({ contact_class_id: 90006, class_id: 1, contact_date: d, body: 'たっくんとゆいちゃんがしゃぼん玉を追いかけました。', contact_photo_id: null,
    source_diary_id: null, staff_id: 'S003', recorded_at: `${d}T00:30:00`, corrected_at: null, is_deleted: false, created_at: `${d}T00:30:00`, updated_at: `${d}T00:30:00` });
  return () => {
    for (const id of ids) db.contactEvents.splice(db.contactEvents.findIndex((e) => e.contact_event_id === id), 1);
    db.napSleeps.splice(db.napSleeps.findIndex((s) => s.nap_sleep_id === 90005), 1);
    db.contactClasses.splice(db.contactClasses.findIndex((c) => c.contact_class_id === 90006), 1);
  };
}

describe('AI に氏名が送られない（9-1）', () => {
  it('渡す文に、氏名・よみ・呼び名・生年月日・体温・排せつ・家庭から・電話番号・メールアドレスが無い。「〇〇ちゃん」は呼び名に戻る', async () => {
    const undo = insertTodayRecords();
    try {
      // メモには AI を使える子（宮城 美咲）の名前を書く
      const memo = '美咲ちゃんとしゃぼん玉を追いかけた。電話は 090-1234-5678、メールは nohara.i@example.jp';
      const res = await api.aiDrafts(teacher, { purpose: 'facility_note', child_id: 'C001', date: today(), memo });
      const sent = mockAi.lastSent!;
      const birth = db.children.find((c) => c.child_id === 'C001')!.birth_date;
      for (const ng of ['野原', '太郎', 'たっくん', 'のはら', 'たろう', '伊藤', 'あおちゃん', 'あおい', '小林', 'ゆいちゃん', '宮城', '美咲',
        birth, '37.8', '36.9', 'うんち', 'おしっこ', '090', '1234', '@', 'example', 'さくら組', '高梨', '取り消した文', '卵']) {
        expect(sent.user, ng).not.toContain(ng);
        expect(sent.system, ng).not.toContain(ng);
      }
      const facts = JSON.parse(sent.user);
      expect(facts.年齢).toMatch(/^\d+歳$/);
      expect(facts.先生のメモ).toBe('おともだちとしゃぼん玉を追いかけた。電話は （伏せました）、メールは （伏せました）');
      const mine = facts.きょうの記録.filter((r: { 時刻: string }) => r.時刻 < '01:00');
      expect(mine).toEqual([
        { 時刻: '00:13', こと: 'ひとこと', 文: '〇〇ちゃんは、おともだちと砂場で型抜きをくり返していました。' },
        { 時刻: '00:20', こと: 'おひるね', おきた: '00:50' },
        { 時刻: '00:30', こと: 'クラスのようす', 文: '〇〇ちゃんとおともだちがしゃぼん玉を追いかけました。' },
      ]);
      expect(sent.system).toBe(AI_SYSTEM.facility_note);
      expect(res.drafts).toHaveLength(1);
      expect(res.drafts[0]).toMatch(/^たっくんの、きょうのようす/);
      expect(res.drafts[0]).not.toContain('〇〇');
      expect(res.replaced_other_names).toBe(true);
      // 操作ログには用途と成否だけ。文は残さない
      const last = db.operationLogs.find((l) => l.operation_type === '6')!;
      expect([last.function_type, last.target_table, last.target_child_id, last.after_value])
        .toEqual(['8', 't_contact_facility', 'C001', '{"用途":"園からのひとこと","結果":"成功"}']);
      expect(db.operationLogs.some((l) => `${l.before_value}${l.after_value}`.includes('しゃぼん玉'))).toBe(false);
    } finally {
      undo();
    }
  });

  it('保護者に出さない種類（contact.show_items で外したもの）は送らない（決めたこと D-26）', async () => {
    const undo = insertTodayRecords();
    try {
      setSetting('contact.show_items', 'toilet,temperature,photo');
      await api.aiDrafts(teacher, { purpose: 'facility_note', child_id: 'C001', date: today() });
      expect(JSON.parse(mockAi.lastSent!.user).きょうの記録).toEqual([]);
    } finally {
      undo();
    }
  });
});

describe('下書きの検査と失敗（8-2・8-7）', () => {
  const base = { purpose: 'facility_note' as const, child_id: 'C001', date: today() };
  it('止めるもの（400・403・429）は AI を呼ばず、操作ログにも残さない', async () => {
    const before = db.operationLogs.filter((l) => l.operation_type === '6').length;
    const cases: [string, SessionUser, Parameters<typeof api.aiDrafts>[1], string, string?][] = [
      ['日付が今日でない', teacher, { ...base, date: addDays(today(), -1) }, MSG.badRequest],
      ['言い換えで文が空', teacher, { ...base, purpose: 'rephrase', text: '  ' }, MSG.badRequest],
      ['園からの下書きをクラスあてに', teacher, { purpose: 'facility_note', class_id: 1, date: today() }, MSG.badRequest],
      ['メモが500文字を超える', teacher, { ...base, memo: 'あ'.repeat(501) }, MSG.aiMemoTooLong],
      ['ひとことの言い換えで200文字を超える', teacher, { ...base, purpose: 'rephrase', field: 'comment', text: 'あ'.repeat(201) }, aiTextTooLong(200)],
      ['ほかのクラスの担任', otherTeacher, base, MSG.aiUnavailableForTarget],
      ['断った子・未同意の子', teacher, { ...base, child_id: 'C002' }, MSG.aiUnavailableForTarget],
      ['メモに AI を使えない子の名前', teacher, { ...base, memo: '上園さんとボール遊び' }, MSG.aiExcludedName, 'ai_excluded_name'],
      ['言い換える文に AI を使えない子の名前', teacher, { ...base, purpose: 'rephrase', text: 'あおちゃんと遊びました。' }, MSG.aiExcludedName, 'ai_excluded_name'],
    ];
    for (const [name, who, input, msg, kind] of cases) {
      const e = await rejection(api.aiDrafts(who, input));
      expect([name, e.message, e.kind]).toEqual([name, msg, kind]);
    }
    await expect(api.aiDrafts(taroGuardian, base)).rejects.toThrow();
    expect(mockAi.calls).toBe(0);
    expect(db.operationLogs.filter((l) => l.operation_type === '6').length).toBe(before);
  });

  it('その日の上限で 429（ボタンは出したまま）、失敗で 503 と操作ログの「失敗」', async () => {
    setSetting('ai.daily_limit', '1');
    const already = db.operationLogs.filter((l) => l.operation_type === '6' && l.operated_at.startsWith(today()) && (l.after_value ?? '').includes('成功')).length;
    if (already === 0) await api.aiDrafts(teacher, base);
    const e = await rejection(api.aiDrafts(teacher, base));
    expect([e.message, e.kind]).toEqual([MSG.aiLimit, 'ai_limit']);
    expect((await api.aiStatus(teacher, { child_id: 'C001' })).available).toBe(true);

    setSetting('ai.daily_limit', '300');
    for (const mode of ['fail', 'refuse'] as const) {
      mockAi.mode = mode;
      const f = await rejection(api.aiDrafts(teacher, base));
      expect([f.message, f.kind]).toEqual([MSG.aiFailed, 'ai_unavailable']);
      expect(db.operationLogs.find((l) => l.operation_type === '6')!.after_value).toBe('{"用途":"園からのひとこと","結果":"失敗"}');
    }
    mockAi.mode = 'limit';
    expect((await rejection(api.aiDrafts(teacher, base))).kind).toBe('ai_limit');
  });

  it('AI 無しで動く：キーが無い・有効にしていないとき status は偽で、園からは送れる', async () => {
    mockAi.keyPresent = false;
    expect((await api.aiStatus(teacher, { child_id: 'C001' })).available).toBe(false);
    mockAi.keyPresent = true;
    setSetting('ai.enabled', '0');
    expect((await api.aiStatus(teacher, { child_id: 'C001' })).available).toBe(false);
    await expect(api.aiDrafts(teacher, base)).rejects.toThrow(MSG.aiUnavailableForTarget);
    for (const f of db.contactFacilities) if (f.child_id === 'C004' && f.contact_date === today()) f.is_deleted = true;
    await expect(api.sendFacility(teacher, 'C004', '今日も一日ありがとうございました。')).resolves.toMatchObject({ body: '今日も一日ありがとうございました。' });
  });

  it('言い換え・続きは候補3つ。宛先の名前は戻り、続きは書きかけの文と合わせて欄の上限以内', async () => {
    const r = await api.aiDrafts(teacher, { purpose: 'rephrase', child_id: 'C001', date: today(), field: 'comment', text: 'たっくんは砂場で遊んでいました。おうちでも聞いてみてください。' });
    expect(r.drafts).toHaveLength(3);
    expect(JSON.parse(mockAi.lastSent!.user)).toEqual({ 先生の文: '〇〇ちゃんは砂場で遊んでいました。おうちでも聞いてみてください。' });
    expect(r.drafts[1]).toBe('たっくんは砂場で遊んでいました。');
    expect(db.operationLogs.find((l) => l.operation_type === '6')!.target_table).toBe('t_contact_event');
    const text = 'あ'.repeat(195);
    const c = await api.aiDrafts(teacher, { purpose: 'continue', child_id: 'C001', date: today(), field: 'comment', text });
    expect(c.drafts).toHaveLength(3);
    for (const d of c.drafts) expect([...text].length + [...d].length).toBeLessThanOrEqual(200);
    expect(mockAi.lastSent!.system).toBe(AI_SYSTEM.continue);
  });
});

describe('設定画面の AI の区画（詳細設計書「設定」(4-10)。server/api_settings_test.go と同じ観点）', () => {
  it('管理者だけ。キーそのものは返さず、AI の2つのキーだけを読み書きする。誤りがあれば何も書かない', async () => {
    setSetting('ai.enabled', '0');
    await expect(api.settings(teacher)).rejects.toThrow('この操作は管理者のみが行えます');
    const v = await api.settings(admin);
    expect(v.settings.map((s) => [s.setting_key, s.setting_value, s.group, s.editable])).toEqual([
      ['ai.daily_limit', '300', 'ai', true], ['ai.enabled', '0', 'ai', true],
    ]);
    expect([v.ai_key_present, v.ai_key_rejected, v.push_available]).toEqual([true, false, false]);

    await expect(api.saveSettings(teacher, { 'ai.enabled': '1' }, v.read_at)).rejects.toThrow('この操作は管理者のみが行えます');
    const cases: [Record<string, string>, string, string?][] = [
      [{ 'paging.diary_per_page': '20' }, MSG.settingNotEditable, 'paging.diary_per_page'],
      [{ 'ai.enabled': 'yes' }, MSG.badChoice, 'ai.enabled'],
      [{ 'ai.daily_limit': '0' }, MSG.settingAiDailyLimit, 'ai.daily_limit'],
      [{ 'ai.daily_limit': '10001' }, MSG.settingAiDailyLimit, 'ai.daily_limit'],
      [{ 'ai.daily_limit': '5.5' }, MSG.settingAiDailyLimit, 'ai.daily_limit'],
      [{}, MSG.badRequest],
    ];
    for (const [changes, msg, field] of cases) {
      const e = await rejection(api.saveSettings(admin, changes, v.read_at));
      expect([e.message, e.field]).toEqual([msg, field]);
    }
    await rejection(api.saveSettings(admin, { 'ai.enabled': '1', 'ai.daily_limit': '0' }, v.read_at));
    expect(db.settings.find((s) => s.setting_key === 'ai.enabled')!.setting_value).toBe('0');

    const saved = await api.saveSettings(admin, { 'ai.enabled': '1', 'ai.daily_limit': '50' }, v.read_at);
    expect(saved.settings.map((s) => s.setting_value)).toEqual(['50', '1']);
    const logs = db.operationLogs.filter((l) => l.function_type === '9' && l.target_table === 'm_setting').slice(0, 2).reverse();
    expect(logs.map((l) => `${l.before_value}→${l.after_value}`)).toEqual([
      '{"ai.daily_limit":"300"}→{"ai.daily_limit":"50"}', '{"ai.enabled":"0"}→{"ai.enabled":"1"}',
    ]);

    // ほかの管理者が、読んだあとに変えていたら 409
    db.settings.find((s) => s.setting_key === 'ai.enabled')!.updated_at = `${today()}T23:59:59`;
    const e = await rejection(api.saveSettings(admin, { 'ai.enabled': '0' }, `${today()}T23:59:58`));
    expect([e.message, e.kind]).toEqual([MSG.settingConflict, 'version_conflict']);
    setSetting('ai.daily_limit', '300');
  });
});
