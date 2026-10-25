/*
 * シート 05 発達チェック・身体測定・成長の記録の手助け（05-growth.spec.ts だけが使う。T10b）。
 *
 * - 前提の園児（【児A】【児B】【児D】【児E】【児F】）・家庭（【家庭A】【家庭B】）・【フリー】・【定型文】を作る。
 *   園児・招待コード・職員・定型文は、管理者の API のセッションで画面と同じ経路から作る
 *   （図/インタフェース一覧「経路の一覧」(1) の POST /api/children・/api/admin/invitations・/api/admin/staff-accounts・/api/phrases）。
 *   保護者は新規登録画面で登録し、職員は職員用トップで初回ログイン（パスワードの変更・規約の同意）まで進める
 * - データベース：確かめに使う SQL（読むだけ）と、シートの【SQL】の書き換え（W1・W2）
 * - 日付：月齢（応当日基準。要件定義書「月齢の算出規則」(7-1)）・日付の足し算
 *
 * 期待する結果は spec に書く（設計書から）。部品は、設計書の表示名で探す。
 * 共有のファイル（harness.ts など）は変えない。手本は 04-nap.helpers.ts・01-common.helpers.ts（ほかの係のブランチ）。
 */
import { DatabaseSync } from 'node:sqlite';
import type { APIRequestContext, APIResponse, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { ACCOUNTS, PHONE, TABLET, expect, jstToday, login, passwordOf, serverInfo, type AccountKey } from './harness';

// ---- サーバ・データベース ----

export function origin(): string {
  const info = serverInfo();
  if (!info) throw new Error('[acceptance:harness] サーバがまだ立っていません（テストの中で呼んでください）');
  return new URL(info.baseURL).origin;
}

function openDb(): DatabaseSync {
  const info = serverInfo();
  if (!info) throw new Error('[acceptance:harness] サーバが立っていません（データベースの場所が分からない）');
  const db = new DatabaseSync(info.dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** 読むだけの SQL */
export function sqlAll<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T[] {
  const db = openDb();
  try {
    return db.prepare(query).all(...params) as T[];
  } finally {
    db.close();
  }
}

export function sqlOne<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T | undefined {
  return sqlAll<T>(query, ...params)[0];
}

/** 書き換え（シートの【SQL】の印のケースだけで使う）。変わった行の数を返す */
export function sqlRun(query: string, ...params: (string | number | null)[]): { changes: number; lastId: number } {
  const db = openDb();
  try {
    const r = db.prepare(query).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  } finally {
    db.close();
  }
}

export function staffIdOf(name: string): string {
  const row = sqlOne<{ staff_id: string }>('SELECT staff_id FROM m_staff WHERE staff_name = ?', name);
  if (!row) throw new Error(`[acceptance:harness] 職員 ${name} がデータベースにありません`);
  return row.staff_id;
}

export function setting(key: string): string | undefined {
  return sqlOne<{ setting_value: string }>('SELECT setting_value FROM m_setting WHERE setting_key = ?', key)?.setting_value;
}

/**
 * 園児の予定（古い順）。列は SELECT * で読む（設計書の override_reason の列がデータベースに無いことがある。
 * 無いときは override_reason が undefined になり、理由を確かめるケースが NG になる）
 */
export function schedulesOf(childId: string) {
  return sqlAll<{ development_schedule_id: number; scheduled_on: string; is_manual_override: number | string; override_reason?: string | null; created_staff_id: string }>(
    'SELECT * FROM t_development_schedule WHERE child_id = ? ORDER BY development_schedule_id',
    childId,
  );
}
export function latestSchedule(childId: string) {
  const list = schedulesOf(childId);
  return list[list.length - 1];
}

/** 園児の発達チェック（古い順） */
export function checksOf(childId: string) {
  return sqlAll<{ development_check_id: number; development_schedule_id: number | null; checked_on: string; status: string; staff_id: string; note: string | null; guardian_message: string | null; finalized_at: string | null }>(
    'SELECT development_check_id, development_schedule_id, checked_on, status, staff_id, note, guardian_message, finalized_at FROM t_development_check WHERE child_id = ? ORDER BY development_check_id',
    childId,
  );
}

/** チェックの結果（項目名つき）。未入力は行が無い */
export function resultsOf(checkId: number) {
  return sqlAll<{ development_item_id: number; item_name: string; result: string }>(
    `SELECT r.development_item_id, i.item_name, r.result
       FROM t_development_result r JOIN m_development_item i ON i.development_item_id = r.development_item_id
      WHERE r.development_check_id = ? ORDER BY i.display_order`,
    checkId,
  );
}

/** 身体測定（測定日の順） */
export function physicalOf(childId: string) {
  return sqlAll<{ physical_record_id: number; measured_on: string; height_cm: number; weight_kg: number; staff_id: string; is_deleted: number; created_at: string; updated_at: string }>(
    'SELECT physical_record_id, measured_on, height_cm, weight_kg, staff_id, is_deleted, created_at, updated_at FROM t_physical_record WHERE child_id = ? ORDER BY measured_on, physical_record_id',
    childId,
  );
}

export function opLogsSince(id: number) {
  return sqlAll<{ operation_log_id: number; function_type: string; operation_type: string; target_table: string; target_id: number | null; target_child_id: string | null; before_value: string | null; after_value: string | null }>(
    'SELECT operation_log_id, function_type, operation_type, target_table, target_id, target_child_id, before_value, after_value FROM t_operation_log WHERE operation_log_id > ? ORDER BY operation_log_id',
    id,
  );
}
export function lastOpLogId(): number {
  return sqlOne<{ m: number | null }>('SELECT MAX(operation_log_id) AS m FROM t_operation_log')?.m ?? 0;
}

// ---- 日付（JST） ----

function parse(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.split('-').map(Number);
  return [y, m, d];
}
function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 日付に日数を足す */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = parse(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 日付に月数を足す（その日が無い月は末日。要件定義書「月齢の算出規則」(7-1) の月末生まれの扱い） */
export function addMonths(ymd: string, months: number): string {
  const [y, m, d] = parse(ymd);
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** 応当日基準の月齢（基準日の時点で、生年月日の応当日を何回迎えたか） */
export function ageInMonths(birth: string, on: string): number {
  let n = 0;
  while (addMonths(birth, n + 1) <= on) n += 1;
  return n;
}

/** 「M月D日」 */
export function md(ymd: string): string {
  const [, m, d] = parse(ymd);
  return `${m}月${d}日`;
}
/** 「10/26」「10月26日」「2026/10/26」「2026-10-26」のどれにも当たる正規表現 */
export function dateRe(ymd: string): RegExp {
  const [y, m, d] = parse(ymd);
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return new RegExp(`(${y}[-/年]0?${m}[-/月]0?${d}|${y}-${mm}-${dd}|(^|[^0-9])0?${m}月0?${d}日|(^|[^0-9/])0?${m}/0?${d}($|[^0-9]))`);
}

// ---- API（管理者のセッションで前提を作る） ----

export interface RequestFactory {
  request: { newContext(options?: Record<string, unknown>): Promise<APIRequestContext> };
}

export async function apiAs(pw: RequestFactory, who: AccountKey): Promise<APIRequestContext> {
  const base = origin();
  const api = await pw.request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: base } });
  const account = ACCOUNTS[who];
  const res = await api.post('/api/login', { data: { email: account.email, password: passwordOf(who), entrance: account.entrance } });
  if (res.status() !== 200) throw new Error(`[acceptance:harness] 下ごしらえ：${account.label}で API にログインできません（${res.status()} ${await res.text()}）`);
  return api;
}

async function ok<T>(label: string, resP: Promise<APIResponse>): Promise<T> {
  const res = await resP;
  if (!res.ok()) throw new Error(`[acceptance:harness] 下ごしらえ：${label} に失敗しました（${res.status()} ${await res.text()}）`);
  return (await res.json()) as T;
}

export async function classIdOf(api: APIRequestContext, name: string): Promise<number> {
  const list = await ok<{ class_id: number; fiscal_year: number; class_name: string }[]>('クラスの一覧', api.get('/api/classes'));
  const latest = Math.max(...list.map((c) => c.fiscal_year));
  const c = list.find((x) => x.fiscal_year === latest && x.class_name === name);
  if (!c) throw new Error(`[acceptance:harness] クラス「${name}」がありません`);
  return c.class_id;
}

/** シートの前提の園児（sheet-05.md「前提の園児」） */
export interface ChildSpec {
  key: 'A' | 'B' | 'D' | 'E' | 'F';
  id: string;
  name: string;
  kana: string;
  nickname: string;
  sex: '1' | '2' | '9';
  birth: string;
  className: string;
}

export function childSpecs(today = jstToday()): Record<ChildSpec['key'], ChildSpec> {
  return {
    A: { key: 'A', id: 'C05A', name: '受入 あさひ', kana: 'うけいれ あさひ', nickname: 'あさひくん', sex: '1', birth: '2024-05-20', className: 'ひまわり組' },
    B: { key: 'B', id: 'C05B', name: '月末 しずく', kana: 'つきずえ しずく', nickname: 'しずくちゃん', sex: '2', birth: '2025-08-31', className: 'さくら組' },
    D: { key: 'D', id: 'C05D', name: '節目 みのり', kana: 'ふしめ みのり', nickname: 'みのりちゃん', sex: '2', birth: addMonths(today, -17), className: 'さくら組' },
    E: { key: 'E', id: 'C05E', name: '比較 そら', kana: 'ひかく そら', nickname: 'そらくん', sex: '1', birth: addMonths(today, -20), className: 'さくら組' },
    F: { key: 'F', id: 'C05F', name: '受入 ゆい', kana: 'うけいれ ゆい', nickname: 'ゆいちゃん', sex: '9', birth: addMonths(today, -4), className: 'もも組' },
  };
}

/** 園児を登録する（園児情報入力画面と同じ経路 POST /api/children）。写真の利用同意は画面の初期値（園内記録として保持） */
export async function createChild(api: APIRequestContext, spec: ChildSpec): Promise<void> {
  const classId = await classIdOf(api, spec.className);
  await ok(`園児「${spec.name}」の登録`, api.post('/api/children', {
    data: {
      child_id: spec.id,
      child_name: spec.name,
      child_name_kana: spec.kana,
      nickname: spec.nickname,
      birth_date: spec.birth,
      sex: spec.sex,
      normal_temperature: null,
      photo_consent_level: '1',
      class_id: classId,
      allergies: [],
      medical_histories: [],
      mode: 'create',
    },
  }));
}

export async function createChildren(pw: RequestFactory, keys: ChildSpec['key'][]): Promise<Record<ChildSpec['key'], ChildSpec>> {
  const specs = childSpecs();
  const api = await apiAs(pw, 'admin');
  try {
    for (const k of keys) await createChild(api, specs[k]);
  } finally {
    await api.dispose();
  }
  return specs;
}

/** 招待コードを1枚発行する（招待コード管理画面の「1枚発行」と同じ経路） */
export async function issueCode(api: APIRequestContext, childId: string): Promise<string> {
  const body = await ok<{ code: string }>('招待コードの発行', api.post('/api/admin/invitations', { data: { child_id: childId, valid_days: 30 } }));
  return body.code;
}

/**
 * 定型文を足す（設定画面の「定型文・雛形」と同じ経路 POST /api/phrases。使う場所 1＝園から）。
 * 経路が無いとき（404）は、設定画面にも定型文の区画が無いため、定型文の表（m_phrase）へ SQL で足す（画面で作れない前提）。
 * どちらで足したかを返す
 */
export async function addPhrase(api: APIRequestContext, body: string): Promise<'api' | 'sql'> {
  const res = await api.post('/api/phrases', { data: { phrase_scope: '1', body } });
  if (res.ok()) return 'api';
  if (res.status() !== 404) throw new Error(`[acceptance:harness] 下ごしらえ：定型文を足す に失敗しました（${res.status()} ${await res.text()}）`);
  const cols = columns('m_phrase');
  const order = (sqlOne<{ m: number | null }>("SELECT MAX(display_order) AS m FROM m_phrase WHERE phrase_scope = '1'")?.m ?? 0) + 1;
  const now = `${jstToday()}T09:00:00`;
  insert('m_phrase', cols, { phrase_scope: '1', body, display_order: order, updated_staff_id: staffIdOf('西田 拓也'), is_deleted: 0, created_at: now, updated_at: now });
  return 'sql';
}

// ---- 窓 ----

export async function newWindow(browser: Browser, kind: 'staff' | 'guardian'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: origin(),
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: kind === 'staff' ? TABLET : PHONE,
    serviceWorkers: 'block',
    permissions: [],
  });
  await context.route((url) => url.hostname !== '127.0.0.1' && !['data:', 'blob:', 'about:'].includes(url.protocol), (route) => route.abort('blockedbyclient'));
  const page = await context.newPage();
  return { context, page };
}

export async function loginIn(browser: Browser, who: AccountKey) {
  const w = await newWindow(browser, ACCOUNTS[who].entrance);
  await login(w.page, who);
  return w;
}

export async function loginWith(page: Page, entrance: 'staff' | 'guardian', email: string, password: string): Promise<void> {
  await page.goto(entrance === 'staff' ? '/staff-top' : '/');
  await page.getByLabel('ログインID', { exact: true }).fill(email);
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  const top = entrance === 'staff' ? '/staff-top' : '/';
  await page.waitForURL((url) => url.pathname !== top, { timeout: 15_000 });
}

export async function checkAllConsents(page: Page): Promise<void> {
  const boxes = page.getByRole('checkbox', { name: /同意します/ });
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).check();
}

export interface Family {
  email: string;
  password: string;
  childId: string;
  childName: string;
}

/**
 * 【家庭A】【家庭B】：管理者が招待コードを1枚発行し、保護者が新規登録画面で登録する。
 * 終わったとき page は保護者でログインしている（保護者ホーム）。パスワードはここで作り、シートに書かない
 */
export async function makeFamily(page: Page, pw: RequestFactory, child: ChildSpec, who: { label: 'A' | 'B'; relationship: string; phone: string }): Promise<Family> {
  const api = await apiAs(pw, 'admin');
  let code: string;
  try {
    code = await issueCode(api, child.id);
  } finally {
    await api.dispose();
  }
  const email = `ukeire05${who.label.toLowerCase()}@example.jp`;
  const password = `ukeire-05${who.label.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto('/signup');
  await page.getByRole('textbox', { name: /招待コード/ }).fill(code);
  await page.getByRole('button', { name: 'コードを確認する' }).click();
  await expect(page.getByRole('checkbox', { name: /利用規約に同意/ })).toBeEnabled();
  await checkAllConsents(page);
  await page.getByLabel(/保護者の氏名/).fill(`受入 保護者${who.label}`);
  await page.getByLabel(/続柄/).selectOption({ label: who.relationship });
  await page.getByLabel(/メールアドレス/).fill(email);
  await page.getByRole('textbox', { name: /^パスワード\s*必須$/ }).fill(password);
  await page.getByLabel(/パスワード（確認）/).fill(password);
  const phone = page.getByLabel(/連絡先1/);
  if (await phone.count()) await phone.first().fill(who.phone);
  await page.getByRole('button', { name: '登録する' }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/guardian'), { timeout: 15_000 });
  return { email, password, childId: child.id, childName: child.name };
}

/** 【フリー】担当クラスの無い一般の職員を発行し、初回ログイン（パスワードの変更・規約の同意）まで済ませる */
export async function makeFreeStaff(page: Page, pw: RequestFactory): Promise<{ email: string; password: string; name: string }> {
  const api = await apiAs(pw, 'admin');
  let temp: string;
  const name = '受入 フリー05';
  const email = 'free05@hoiku.example.jp';
  try {
    const body = await ok<{ password: string }>('職員アカウントの発行', api.post('/api/admin/staff-accounts', {
      data: { staff_id: 'S05F', staff_name: name, email, role: '2', class_id: null },
    }));
    temp = body.password;
  } finally {
    await api.dispose();
  }
  const password = `ukeire-05f-${Math.random().toString(36).slice(2, 8)}`;
  await loginWith(page, 'staff', email, temp);
  await page.getByLabel(/現在のパスワード/).fill(temp);
  await page.getByRole('textbox', { name: /^新しいパスワード\s*必須$/ }).fill(password);
  await page.getByLabel(/新しいパスワード（確認）/).fill(password);
  await page.getByRole('button', { name: '変更する' }).click();
  await expect(page.getByRole('button', { name: '同意して進む' })).toBeVisible();
  await checkAllConsents(page);
  await page.getByRole('button', { name: '同意して進む' }).click();
  await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
  return { email, password, name };
}

// ---- 【SQL】の書き換え ----

/** (W1) 05-008：児D の最新の予定の予定日を昨日にする。書く前に scheduled_on の形（YYYY-MM-DD）を確かめる */
export function w1MoveScheduleToYesterday(childId: string): void {
  const s = latestSchedule(childId);
  if (!s) throw new Error('[acceptance:harness] W1：児D の予定がありません');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.scheduled_on)) throw new Error(`[acceptance:harness] W1：scheduled_on の形が想定と違います（${s.scheduled_on}）`);
  const n = sqlRun('UPDATE t_development_schedule SET scheduled_on = ? WHERE development_schedule_id = ?', addDays(jstToday(), -1), s.development_schedule_id).changes;
  if (n !== 1) throw new Error('[acceptance:harness] W1：予定を書き換えられませんでした');
}

/** 区分（月齢 m を含むもの） */
export function categoryFor(months: number) {
  return sqlOne<{ development_category_id: number; category_name: string; age_month_from: number; age_month_to: number }>(
    'SELECT development_category_id, category_name, age_month_from, age_month_to FROM m_development_category WHERE age_month_from <= ? AND age_month_to >= ? ORDER BY age_month_from DESC LIMIT 1',
    months,
    months,
  );
}

/** 区分の有効な項目（設計書の is_active の列がデータベースに無いときは、その区分の全部の項目） */
export function activeItems(categoryId: number) {
  const active = columns('m_development_item').has('is_active') ? ' AND is_active = 1' : '';
  return sqlAll<{ development_item_id: number; item_name: string }>(
    `SELECT development_item_id, item_name FROM m_development_item WHERE development_category_id = ?${active} ORDER BY display_order`,
    categoryId,
  );
}

/**
 * (W2) 05-019：児E に、前の回の確定した記録を作る（実施日＝今日の30日前、全項目「確認できた」）。
 * 列の形は既存の行（デモデータの確定した行）に合わせる。ほかに NOT NULL の列があれば既存の行と同じ形で入れる
 */
export function w2PreviousCheck(child: ChildSpec): { checkedOn: string; months: number; items: string[] } {
  const checkedOn = addDays(jstToday(), -30);
  const months = ageInMonths(child.birth, checkedOn);
  const cat = categoryFor(months);
  if (!cat) throw new Error(`[acceptance:harness] W2：月齢 ${months} の区分がありません`);
  const items = activeItems(cat.development_category_id);
  const admin = staffIdOf('西田 拓也');
  const sample = sqlOne<{ finalized_at: string | null }>("SELECT finalized_at FROM t_development_check WHERE status = '2' AND finalized_at IS NOT NULL LIMIT 1");
  const finalizedAt = sample?.finalized_at && sample.finalized_at.includes('T') ? `${checkedOn}T10:00:00` : `${checkedOn} 10:00:00`;
  const schedCols = columns('t_development_schedule');
  const checkCols = columns('t_development_check');
  const resultCols = columns('t_development_result');
  const now = `${jstToday()}T09:00:00`;
  const sched = insert('t_development_schedule', schedCols, {
    child_id: child.id, scheduled_on: checkedOn, is_manual_override: 0, override_reason: null, created_staff_id: admin, created_at: now, updated_at: now,
  });
  const check = insert('t_development_check', checkCols, {
    child_id: child.id, development_schedule_id: sched, checked_on: checkedOn, status: '2', staff_id: admin, note: '05-019 前回の所見', guardian_message: null, finalized_at: finalizedAt, created_at: now, updated_at: now,
  });
  for (const it of items) {
    insert('t_development_result', resultCols, { development_check_id: check, development_item_id: it.development_item_id, result: '1', note: null, created_at: now, updated_at: now });
  }
  return { checkedOn, months, items: items.map((i) => i.item_name) };
}

function columns(table: string): Set<string> {
  return new Set(sqlAll<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
}

function insert(table: string, cols: Set<string>, values: Record<string, string | number | null>): number {
  const keys = Object.keys(values).filter((k) => cols.has(k));
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  return sqlRun(sql, ...keys.map((k) => values[k])).lastId;
}

// ---- 画面の共通 ----

export const main = (page: Page) => page.getByRole('main');

/** ボタンを押し、経路への書き込み（GET 以外）の応答を待つ */
export async function clickAndWait(page: Page, target: Locator, path: string | RegExp): Promise<APIResponse | import('@playwright/test').Response> {
  const [res] = await Promise.all([
    page.waitForResponse((r) => (typeof path === 'string' ? r.url().includes(path) : path.test(r.url())) && r.request().method() !== 'GET', { timeout: 15_000 }),
    target.click(),
  ]);
  return res;
}

/** 文字の中に判定の言葉があるか（sheet-05.md「期待する結果の読み方」）。見つかった言葉を返す */
export const DEV_JUDGEMENT_WORDS = ['遅れ', '遅い', '早い', '進んでいる', '正常', '異常', '要注意', '要観察', '問題', '心配', '障害', 'できない'];
export const BODY_JUDGEMENT_WORDS = ['やせ', '肥満', '標準', '普通', '低身長', '高身長', '小さい', '大きい', '低い', '高い', '異常値'];
/** 免責表示・範囲外の確認の文は数えない */
const EXEMPT = [
  /本グラフは発育把握の目安であり、発育の判定・診断を行うものではありません。?/g,
  /本表示は記録の比較であり、発達の判定・診断を行うものではありません。?/g,
  /入力値が通常の範囲外です。測定値に誤りがないか確認してください。?/g,
];
export function judgementWords(text: string, words: string[]): string[] {
  let t = text;
  for (const re of EXEMPT) t = t.replace(re, '');
  return words.filter((w) => t.includes(w));
}

// ---- 表示の形 ----

/** 「2026/10/26」 */
export function slash(ymd: string): string {
  return ymd.replaceAll('-', '/');
}
/** 月齢の表示（「1歳6か月」か「18か月」のどちらでも当たる） */
export function monthsRe(n: number): RegExp {
  return new RegExp(`(${Math.floor(n / 12)}歳${n % 12}か月|(^|[^0-9歳])${n}\\s*か月)`);
}

// ---- 職員の画面 ----

export async function openDevList(page: Page) {
  await page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '発達・身体', exact: true }).click();
  await expect(page.getByRole('heading', { name: '発達チェック', level: 1 })).toBeVisible();
}
export const devRow = (page: Page, child: string) => main(page).getByRole('row').filter({ hasText: child });
/** 一覧の、その園児の列の文字（列の見出しが column で始まるもの。無ければ空）。表が描き終わるのを待ってから読む */
export async function devCell(page: Page, child: string, column: string): Promise<string> {
  await expect(devRow(page, child).first()).toBeVisible();
  const headers = (await main(page).getByRole('columnheader').allInnerTexts()).map((t) => t.trim());
  const idx = headers.findIndex((h) => h.startsWith(column));
  if (idx < 0) return '';
  return (await devRow(page, child).getByRole('cell').nth(idx).innerText()).trim();
}

/** 発達チェック一覧の「入力」から入力画面を開く */
export async function openDevInput(page: Page, child: string) {
  await page.goto('/staff/growth');
  await expect(page.getByRole('heading', { name: '発達チェック', level: 1 })).toBeVisible();
  const cls = main(page).getByRole('combobox', { name: 'クラス' });
  if (await cls.locator('option', { hasText: 'すべて' }).count()) await cls.selectOption({ label: 'すべて' });
  const row = devRow(page, child);
  await row.getByRole('link', { name: '入力' }).or(row.getByRole('button', { name: '入力' })).first().click();
  await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: child })).toBeVisible();
  await expect(main(page).getByRole('radiogroup').first()).toBeVisible();
}

export const itemGroups = (page: Page) => main(page).getByRole('radiogroup');
/** 入力画面のチェック項目の名前（上から） */
export async function itemNames(page: Page): Promise<string[]> {
  const groups = itemGroups(page);
  const n = await groups.count();
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    names.push(await groups.nth(i).evaluate((el) => {
      const label = el.getAttribute('aria-label');
      if (label) return label;
      const by = el.getAttribute('aria-labelledby');
      return by ? (document.getElementById(by)?.textContent ?? '').trim() : '';
    }));
  }
  return names;
}
export async function setResult(page: Page, index: number, label: '確認できた' | '一部' | '未確認') {
  const g = itemGroups(page).nth(index);
  await g.getByRole('radio', { name: label, exact: true }).check();
  await expect(g.getByRole('radio', { name: label, exact: true })).toBeChecked();
}
export async function setAll(page: Page, label: '確認できた' | '一部' | '未確認') {
  const n = await itemGroups(page).count();
  for (let i = 0; i < n; i++) await setResult(page, i, label);
}
export const implDate = (page: Page) => main(page).getByRole('textbox', { name: '実施日' });
export const noteBox = (page: Page) => main(page).getByRole('textbox', { name: /^所見/ });
export const messageBox = (page: Page) => main(page).getByRole('textbox', { name: /保護者へのひとこと/ });
export const draftButton = (page: Page) => main(page).getByRole('button', { name: '下書き保存', exact: true });
export const finalizeButton = (page: Page) => main(page).getByRole('button', { name: '確定する', exact: true });
export const unenteredDialog = (page: Page) => page.getByRole('dialog', { name: /未入力の項目があります/ });
export const nameCheckDialog = (page: Page) => page.getByRole('dialog', { name: /ほかのお子さんの名前/ });
/** 区分の表示（「発達過程区分：」のあとの文字） */
export async function categoryLabel(page: Page): Promise<string> {
  const text = (await main(page).innerText()).replace(/\s+/g, ' ');
  const m = /発達過程区分[：:]\s*(.+?)(（|\(|$)/.exec(text);
  return m ? m[1].trim() : '';
}

/** 画面の下端に出る結果の文（role=status） */
export const toast = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text }).first();

/** 実施日を入れる（日付の欄） */
export async function setImplDate(page: Page, ymd: string) {
  await implDate(page).fill(ymd);
  await implDate(page).blur();
  await expect(implDate(page)).toHaveValue(ymd);
}

/** 下書き保存（応答を待つ） */
export async function saveDraft(page: Page) {
  return clickAndWait(page, draftButton(page), '/api/development/checks');
}

/**
 * 確定する。未入力の確認が出たら「このまま確定する」、他児の名前の注意が出たら「このまま送る」。
 * opts で止めると、そのダイアログを出したまま返す
 */
export async function finalize(page: Page, opts: { acceptUnentered?: boolean; acceptNames?: boolean } = {}): Promise<'done' | 'unentered' | 'names' | 'none'> {
  await finalizeButton(page).click();
  const u = unenteredDialog(page);
  const n = nameCheckDialog(page);
  const done = toast(page, /確定しました/);
  await expect(u.or(n).or(done)).toBeVisible({ timeout: 15_000 }).catch(() => {});
  if (await u.isVisible()) {
    if (opts.acceptUnentered === false) return 'unentered';
    await u.getByRole('button', { name: 'このまま確定する' }).click();
    await expect(n.or(done)).toBeVisible({ timeout: 15_000 }).catch(() => {});
  }
  if (await n.isVisible()) {
    if (opts.acceptNames === false) return 'names';
    await n.getByRole('button', { name: 'このまま送る' }).click();
    await expect(done).toBeVisible({ timeout: 15_000 }).catch(() => {});
  }
  return (await done.isVisible()) ? 'done' : 'none';
}

// 身体記録画面

export async function openPhysical(page: Page, className?: string) {
  await page.goto('/staff/growth/physical');
  await expect(page.getByRole('heading', { name: '身体記録', level: 1 })).toBeVisible();
  if (className) await main(page).getByRole('combobox', { name: 'クラス' }).selectOption({ label: className });
}
export const physChild = (page: Page, child: string) => main(page).getByRole('button', { name: new RegExp(`^\\[.?\\]\\s*${child}`) });
export async function selectPhysChild(page: Page, child: string) {
  await physChild(page, child).click();
  await expect(main(page).getByRole('heading', { level: 2 }).filter({ hasText: child })).toBeVisible();
  // 右側（前回値・過去の記録・グラフ）の読み込みを待つ（知らせの接続が開いたままなので networkidle は使えない）
  await page.waitForTimeout(700);
}
export const physDate = (page: Page) => main(page).getByRole('textbox', { name: '測定日' });
export const heightBox = (page: Page) => main(page).getByRole('spinbutton', { name: /身長/ });
export const weightBox = (page: Page) => main(page).getByRole('spinbutton', { name: /体重/ });
export const registerButton = (page: Page) => main(page).getByRole('button', { name: /^(登録する|このまま登録する)$/ });
export const overwriteDialog = (page: Page) => page.getByRole('dialog', { name: /上書き/ });
export const historyRow = (page: Page, ymd: string) => main(page).getByRole('row').filter({ hasText: slash(ymd) });

/** 測定日を入れる（日付の欄） */
export async function setPhysDate(page: Page, ymd: string) {
  await physDate(page).fill(ymd);
  await physDate(page).blur();
  await expect(physDate(page)).toHaveValue(ymd);
  await page.waitForTimeout(700); // 実施状況・入力済みマークの読み直しを待つ
}

/**
 * 身体測定を1件登録する。範囲外の確かめが出たら「このまま登録する」、上書きの確かめが出たら「上書きする」。
 * 確かめを止める（false）と、その時点で返す。保存されたかは SQL で見る
 */
export async function registerPhysical(page: Page, child: string, ymd: string, height: string, weight: string, opts: { acceptRange?: boolean; acceptOverwrite?: boolean } = {}): Promise<{ range: boolean; overwrite: boolean; other: string[] }> {
  await setPhysDate(page, ymd);
  await selectPhysChild(page, child);
  await fillMeasure(page, height, weight);
  await registerButton(page).click();
  return answerPhysicalChecks(page, opts);
}

/**
 * 身長・体重を入れる。園児を選んだあと右側が遅れて読み直され、入れた値が消えることがあるので、
 * 入ったことを確かめ、消えていれば入れ直す（3回まで）
 */
export async function fillMeasure(page: Page, height: string, weight: string) {
  for (let i = 0; i < 3; i++) {
    await heightBox(page).fill(height);
    await weightBox(page).fill(weight);
    await page.waitForTimeout(400);
    if ((await heightBox(page).inputValue()) === height && (await weightBox(page).inputValue()) === weight) return;
  }
}

/**
 * 「登録する」を押したあとに出る確かめに答える。範囲外（「このまま登録する」）・上書き（「上書きの確認」）と、
 * 設計書に無い確かめ（「同じ月の記録があります」など。続ける側を押し、見出しを other に残す）
 */
export async function answerPhysicalChecks(page: Page, opts: { acceptRange?: boolean; acceptOverwrite?: boolean } = {}): Promise<{ range: boolean; overwrite: boolean; other: string[] }> {
  const seen = { range: false, overwrite: false, other: [] as string[] };
  for (let i = 0; i < 4; i++) {
    const again = main(page).getByRole('button', { name: 'このまま登録する' });
    const dlg = page.getByRole('dialog');
    const done = toast(page, /登録しました/);
    await expect(again.or(dlg).or(done)).toBeVisible({ timeout: 8_000 }).catch(() => {});
    if (await dlg.isVisible()) {
      const title = ((await dlg.getByRole('heading').first().textContent().catch(() => '')) ?? '').trim();
      if (/上書き/.test(title)) {
        seen.overwrite = true;
        if (opts.acceptOverwrite === false) {
          await dlg.getByRole('button', { name: 'やめる' }).click();
          await expect(dlg).toBeHidden();
          return seen;
        }
        await dlg.getByRole('button', { name: /上書きする/ }).click();
      } else {
        seen.other.push(title);
        await dlg.getByRole('button').filter({ hasNotText: /やめる|閉じる|戻る|キャンセル/ }).last().click();
      }
      await expect(dlg).toBeHidden().catch(() => {});
      continue;
    }
    if (await again.isVisible()) {
      seen.range = true;
      if (opts.acceptRange === false) return seen;
      await again.click();
      continue;
    }
    break;
  }
  await expect(toast(page, /登録しました/)).toBeVisible({ timeout: 8_000 }).catch(() => {});
  return seen;
}

/** 身体記録画面の右側の見出し（選んだ園児。「成長グラフ」「過去の記録」でないもの） */
export const childHeading = (page: Page) => main(page).getByRole('heading', { level: 2 }).filter({ hasNotText: /^(成長グラフ|過去の記録)$/ }).first();

/** main の文字を行で読み、re に当たる最初の行（無ければ空） */
export async function lineOf(page: Page, re: RegExp): Promise<string> {
  const lines = (await main(page).innerText()).split('\n').map((l) => l.trim());
  return lines.find((l) => re.test(l)) ?? '';
}
/** 身体記録画面の「未実施：…」の行 */
export async function unrecordedLine(page: Page): Promise<string> {
  const t = await main(page).getByText(/^未実施[：:]/).first().innerText().catch(() => '');
  return t || lineOf(page, /^未実施[：:]/);
}
/** 発達チェック一覧の、予定日を過ぎた園児の知らせの行 */
export async function overdueNotice(page: Page): Promise<string> {
  return lineOf(page, /予定日を過ぎ/);
}
/** 発達チェック一覧の、予定日が近い園児の知らせの行（状態の列の「予定日が近い」は数えない） */
export async function soonNotice(page: Page): Promise<string> {
  const lines = (await main(page).innerText()).split('\n').map((l) => l.trim());
  return lines.find((l) => /予定日が近い/.test(l) && l !== '予定日が近い' && /名/.test(l)) ?? '';
}

// 保護者の画面

/** 保護者ホームの園児の区画の「成長の記録」を押し、成長の記録画面を開く */
export async function openGrowthFromHome(page: Page, child: string) {
  await page.goto('/guardian');
  const region = page.getByRole('region', { name: new RegExp(`${child}さんのきょう`) });
  await expect(region).toBeVisible();
  await region.getByRole('link', { name: /成長の記録/ }).click();
  await expect(page.getByRole('heading', { name: `${child}の成長の記録`, level: 1 })).toBeVisible();
}
export const homeRegion = (page: Page, child: string) => page.getByRole('region', { name: new RegExp(`${child}さんのきょう`) });
export const growthBody = (page: Page) => page.getByRole('region', { name: '身長・体重' });
export const achievements = (page: Page) => page.getByRole('region', { name: 'できたこと' });
export const achievementItems = (page: Page) => achievements(page).getByRole('listitem').filter({ has: page.locator('time') });
export const GROWTH_DISCLAIMER = '本グラフは発育把握の目安であり、発育の判定・診断を行うものではありません。';
export const COMPARE_DISCLAIMER = '本表示は記録の比較であり、発達の判定・診断を行うものではありません。';

/** 職員ダッシュボードの、見出しが label で始まる行の文字（無ければ空） */
export async function dashboardRow(page: Page, label: RegExp): Promise<string> {
  await page.goto('/staff');
  await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
  const row = main(page).getByRole('row').filter({ hasText: label }).first();
  if (!(await row.count())) return '';
  return (await row.innerText()).replace(/\s+/g, ' ');
}
/** 文の中の「〇〇 n 名」の n（無ければ 0。「ありません」も 0） */
export function countIn(text: string, label: string): number {
  const m = new RegExp(`${label}[^0-9]{0,6}(\\d+)\\s*名`).exec(text);
  return m ? Number(m[1]) : 0;
}
