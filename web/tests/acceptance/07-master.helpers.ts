/*
 * シート 07（園児マスター・アカウント・運用）の下ごしらえ（T12b）。データはすべてケースの中で作る（README.md「夜中の注意」）。
 *
 *   - 管理者の API のセッションで、園児・招待コード・職員を作る（画面と同じ経路。図/インタフェース一覧「経路の一覧」(1)）
 *   - 保護者は新規登録画面で登録し、職員は職員用トップで初回ログイン（パスワードの変更・規約の同意）まで進める
 *   - 画面で作れない状態（ロック・過年度のクラスグループ・設定の値）は、そのサーバの使い捨てのデータベースを SQL で書き換える
 *     （テスト仕様書「テストデータの準備」(2.1)。シート07「確かめに使う SQL」の (W1)〜(W3)）
 *
 * 期待する結果はここに書かない（spec に書く）。共有のファイル（harness.ts など）は変えない。
 * 下ごしらえの関数の多くは、シート01 の 01-common.helpers.ts（ブランチ test/acceptance-common）と同じ形にした。
 */
import { DatabaseSync } from 'node:sqlite';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { ACCOUNTS, expect, passwordOf, serverInfo, type AccountKey } from './harness';

/** Playwright の playwright フィクスチャのうち、ここで使うところ */
export interface RequestFactory {
  request: { newContext(options?: Record<string, unknown>): Promise<APIRequestContext> };
}

/** いまのサーバの起点（http://127.0.0.1:<ポート>） */
export function origin(): string {
  const info = serverInfo();
  if (!info) throw new Error('サーバがまだ立っていません（テストの中で呼んでください）');
  return new URL(info.baseURL).origin;
}

// ---- データベース（そのサーバの使い捨てのもの） ----

type SqlParam = string | number | null;

function openDb(): DatabaseSync {
  const info = serverInfo();
  if (!info) throw new Error('サーバがまだ立っていません');
  const db = new DatabaseSync(info.dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** いまのサーバのデータベースに SQL を流す（書き換え）。画面で作れない状態だけに使う。入った行の rowid を返す */
export function sqlRun(statement: string, ...params: SqlParam[]): number {
  const db = openDb();
  try {
    const r = db.prepare(statement).run(...params);
    return Number(r.lastInsertRowid);
  } finally {
    db.close();
  }
}

/** いまのサーバのデータベースを読む（確かめに使う） */
export function sqlAll(statement: string, ...params: SqlParam[]): Record<string, unknown>[] {
  const db = openDb();
  try {
    return db.prepare(statement).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** 1行目の1列目 */
export function sqlValue(statement: string, ...params: SqlParam[]): unknown {
  const rows = sqlAll(statement, ...params);
  if (rows.length === 0) return undefined;
  return Object.values(rows[0])[0];
}

/** 【ログ境】操作ログのいまの最大 ID（シート07「前提の記号」） */
export function logBorder(): number {
  return Number(sqlValue('SELECT COALESCE(MAX(operation_log_id), 0) FROM t_operation_log') ?? 0);
}

export interface LogRow {
  operation_log_id: number;
  operator_type: string;
  account_id: number | null;
  operated_at: string;
  function_type: string;
  operation_type: string;
  target_table: string;
  target_id: number | null;
  target_child_id: string | null;
  before_value: string | null;
  after_value: string | null;
}

/** (R12) 【ログ境】より後の操作ログ */
export function logsAfter(border: number): LogRow[] {
  return sqlAll(
    `SELECT operation_log_id, operator_type, account_id, operated_at, function_type, operation_type,
            target_table, target_id, target_child_id, before_value, after_value
       FROM t_operation_log WHERE operation_log_id > ? ORDER BY operation_log_id`,
    border,
  ) as unknown as LogRow[];
}

/** アカウントID（ログインIDから） */
export function accountIdOf(email: string): number {
  const v = sqlValue('SELECT account_id FROM m_account WHERE lower(email) = lower(?)', email);
  if (v === undefined) throw new Error(`下ごしらえ：${email} のアカウントがありません`);
  return Number(v);
}

/** 書く前に列の形を読む：その表のその列の、空でない値を1つ */
export function sampleValue(table: string, column: string): string | null {
  const v = sqlValue(`SELECT ${column} FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> '' LIMIT 1`);
  return v === undefined || v === null ? null : String(v);
}

/** JST の日時を、見本の値と同じ形（"YYYY-MM-DDTHH:mm:ss" か "YYYY-MM-DD HH:mm:ss"）で書く */
export function jstDateTime(date: Date, sample: string | null): string {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date); // "YYYY-MM-DD HH:mm:ss"
  if (sample && /^\d{4}-\d{2}-\d{2}T/.test(sample)) return s.replace(' ', 'T');
  return s;
}

/** JST の YYYY-MM-DD に日数を足す */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

// ---- API（画面と同じ送信元から） ----

export interface ApiResult {
  status: number;
  json: unknown;
  text: string;
}

/** ログイン済みの画面から、同じ送信元で API を呼ぶ */
export async function pageApi(page: Page, method: string, url: string, body?: unknown): Promise<ApiResult> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const init: RequestInit = { method, credentials: 'same-origin' };
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // JSON でない応答
      }
      return { status: res.status, json, text };
    },
    { method, url, body },
  );
}

/**
 * API を呼ぶ文脈。同じサイトの Origin を付ける（CSRF の検証で止まらないように。基本設計書「CSRF対策の方式」(6-3)）
 */
export async function newApi(pw: RequestFactory): Promise<APIRequestContext> {
  const base = origin();
  return pw.request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: base } });
}

/** API でログインする。通らなければ止まる */
export async function apiLogin(api: APIRequestContext, email: string, password: string, entrance: 'staff' | 'guardian'): Promise<void> {
  const res = await api.post('/api/login', { data: { email, password, entrance } });
  if (res.status() !== 200) throw new Error(`下ごしらえ：${email} で API にログインできません（${res.status()} ${await res.text()}）`);
}

/** デモのアカウントで API にログインした文脈 */
export async function apiAs(pw: RequestFactory, who: AccountKey): Promise<APIRequestContext> {
  const api = await newApi(pw);
  const account = ACCOUNTS[who];
  await apiLogin(api, account.email, passwordOf(who), account.entrance);
  return api;
}

export async function ok<T>(label: string, resP: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await resP;
  if (!res.ok()) throw new Error(`下ごしらえ：${label} に失敗しました（${res.status()} ${await res.text()}）`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ---- 園児・招待コード・職員 ----

/** クラス名からクラスID（いまの年度。年度が最も新しいもの） */
export async function classIdOf(api: APIRequestContext, name: string, fiscalYear?: number): Promise<number> {
  const list = await ok<{ class_id: number; fiscal_year: number; class_name: string }[]>('クラスの一覧', api.get('/api/classes'));
  const year = fiscalYear ?? Math.max(...list.map((c) => c.fiscal_year));
  const hit = list.find((c) => c.fiscal_year === year && c.class_name === name);
  if (!hit) throw new Error(`下ごしらえ：${year}年度のクラス「${name}」がありません`);
  return hit.class_id;
}

export interface ChildSpec {
  id: string;
  name: string;
  className?: string;
  birth?: string;
  kana?: string;
  allergies?: { target_food: string; symptom: string; response: string }[];
  medicalHistories?: string[];
}

/** 前提C：園児を登録する（園児情報入力画面と同じ経路 POST /api/children） */
export async function createChild(api: APIRequestContext, spec: ChildSpec): Promise<void> {
  const classId = await classIdOf(api, spec.className ?? 'さくら組');
  await ok('園児の登録', api.post('/api/children', {
    data: {
      child_id: spec.id,
      child_name: spec.name,
      child_name_kana: spec.kana ?? 'うけいれ',
      nickname: '',
      birth_date: spec.birth ?? '2024-04-01',
      sex: '9',
      normal_temperature: null,
      photo_consent_level: '1',
      class_id: classId,
      allergies: spec.allergies ?? [],
      medical_histories: spec.medicalHistories ?? [],
      mode: 'create',
    },
  }));
}

/** 招待コードを1枚発行する（招待コード管理画面の「1枚発行」と同じ経路）。コードを返す */
export async function issueCode(api: APIRequestContext, childId: string, validDays = 7): Promise<string> {
  const body = await ok<{ code: string }>('招待コードの発行', api.post('/api/admin/invitations', { data: { child_id: childId, valid_days: validDays } }));
  return body.code;
}

/** 前提R：その園児のきょうの出来事を記録する（連絡帳（クラス）画面と同じ経路 POST /api/contact/events） */
export async function recordEvent(api: APIRequestContext, childId: string, kind: 'toilet' | 'temperature', value = 'おしっこ'): Promise<void> {
  const item = kind === 'toilet' ? { child_id: childId, event_type: '2', toilet_label: value } : { child_id: childId, event_type: '3', temperature: Number(value) };
  await ok('出来事の記録', api.post('/api/contact/events', { data: { items: [item] } }));
}

export interface StaffSpec {
  id: string;
  name: string;
  email: string;
  className?: string | null;
}

/** 職員アカウントを発行する（職員アカウント管理画面の「＋ アカウントを発行」と同じ経路）。一時パスワードを返す */
export async function issueStaff(api: APIRequestContext, spec: StaffSpec): Promise<string> {
  const classId = spec.className === null ? null : await classIdOf(api, spec.className ?? 'さくら組');
  const body = await ok<{ password: string }>('職員アカウントの発行', api.post('/api/admin/staff-accounts', {
    data: { staff_id: spec.id, staff_name: spec.name, email: spec.email, role: '2', class_id: classId },
  }));
  return body.password;
}

// ---- 画面の操作 ----

/** 別の窓（2つ目のブラウザ）。ハーネスの文脈と同じく、127.0.0.1 の外へは出さない */
export async function newWindow(browser: Browser, viewport?: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: origin(),
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: viewport ?? { width: 1024, height: 768 },
    serviceWorkers: 'block',
  });
  await context.route((url) => url.hostname !== '127.0.0.1' && url.protocol !== 'data:' && url.protocol !== 'blob:', (route) => route.abort('blockedbyclient'));
  const page = await context.newPage();
  return { context, page };
}

/** 入口でログインID・パスワードを入れて「ログイン」を押す（移るかどうかは呼んだ側が確かめる） */
export async function submitLogin(page: Page, entrance: 'staff' | 'guardian', email: string, password: string): Promise<void> {
  await page.goto(entrance === 'staff' ? '/staff-top' : '/');
  await page.getByLabel('ログインID', { exact: true }).fill(email);
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
}

/** ログインして、入口から移るまで待つ */
export async function loginWith(page: Page, entrance: 'staff' | 'guardian', email: string, password: string): Promise<string> {
  await submitLogin(page, entrance, email, password);
  const top = entrance === 'staff' ? '/staff-top' : '/';
  await page.waitForURL((url) => url.pathname !== top, { timeout: 15_000 });
  return new URL(page.url()).pathname;
}

/** ログインに失敗させ、出た誤りの文（role=alert）を返す */
export async function loginError(page: Page, entrance: 'staff' | 'guardian', email: string, password: string): Promise<string> {
  await submitLogin(page, entrance, email, password);
  const alert = page.getByRole('alert').first();
  await alert.waitFor({ timeout: 10_000 });
  return (await alert.textContent())?.trim() ?? '';
}

/** 職員のヘッダの「ログアウト」 */
export async function logoutStaff(page: Page): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByLabel('ログインID', { exact: true })).toBeVisible();
}

/** 保護者のメニューの「ログアウト」 */
export async function logoutGuardian(page: Page): Promise<void> {
  await page.getByRole('banner').getByRole('button', { name: /メニュー/ }).click();
  await page.getByRole('dialog', { name: 'メニュー' }).getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByLabel('ログインID', { exact: true })).toBeVisible();
}

/** 画面の規約の同意のチェック（「…に同意します」）をすべて入れる */
export async function checkAllConsents(page: Page): Promise<void> {
  const boxes = page.getByRole('checkbox', { name: /同意します/ });
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).check();
}

export interface GuardianSpec {
  code: string;
  name: string;
  email: string;
  password: string;
  relationship?: string;
  phone?: string;
}

/** 新規登録画面で登録を終え、保護者ホームが開くまで待つ */
export async function signupScreen(page: Page, spec: GuardianSpec): Promise<void> {
  await page.goto('/signup');
  await page.getByRole('textbox', { name: /招待コード/ }).fill(spec.code);
  await page.getByRole('button', { name: 'コードを確認する' }).click();
  await expect(page.getByRole('checkbox', { name: /利用規約に同意/ })).toBeEnabled();
  await checkAllConsents(page);
  await page.getByLabel(/保護者の氏名/).fill(spec.name);
  await page.getByLabel(/続柄/).selectOption({ label: spec.relationship ?? '母' });
  await page.getByLabel(/メールアドレス/).fill(spec.email);
  await page.getByRole('textbox', { name: /^パスワード\s*必須$/ }).fill(spec.password);
  await page.getByLabel(/パスワード（確認）/).fill(spec.password);
  const phone = page.getByLabel(/連絡先1/);
  if (await phone.count()) await phone.first().fill(spec.phone ?? '090-0000-0007');
  await page.getByRole('button', { name: '登録する' }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/guardian'), { timeout: 15_000 });
}

/** ケースNo から ID の数字の部分（07-004 → 07004、07-I013 → 07I013） */
export function digitsOf(caseNo: string): string {
  return caseNo.replace(/[^0-9I]/g, '');
}

/** ケースごとのパスワード（ハーネスが決める値。シートには書かない） */
export function casePassword(key: string): string {
  return `ukeire-${key.toLowerCase()}-pw`;
}

export interface MadeChild {
  childId: string;
  childName: string;
}

/** 前提C（NNN）：園児ID U07NNN、氏名「受入 07-NNN」 */
export async function makeChild(api: APIRequestContext, caseNo: string, options: { suffix?: string; className?: string; kana?: string; name?: string; allergies?: ChildSpec['allergies']; medicalHistories?: string[] } = {}): Promise<MadeChild> {
  const childId = `U${digitsOf(caseNo)}${options.suffix ?? ''}`;
  const childName = options.name ?? `受入 ${caseNo}${options.suffix ?? ''}`;
  await createChild(api, { id: childId, name: childName, className: options.className, kana: options.kana, allergies: options.allergies, medicalHistories: options.medicalHistories });
  return { childId, childName };
}

export interface MadeGuardian extends MadeChild {
  email: string;
  password: string;
  guardianName: string;
}

/**
 * 前提G（NNN）：前提C のあと招待コードを発行し、保護者が新規登録画面で登録してログアウトする。
 * page は保護者の画面を開くための窓（ログアウトした状態で返す）
 */
export async function makeGuardian(page: Page, api: APIRequestContext, caseNo: string, options: { suffix?: string; className?: string; child?: MadeChild; relationship?: string; guardianSuffix?: string } = {}): Promise<MadeGuardian> {
  const child = options.child ?? (await makeChild(api, caseNo, { suffix: options.suffix, className: options.className }));
  const code = await issueCode(api, child.childId);
  const key = `${digitsOf(caseNo)}${options.suffix ?? ''}${options.guardianSuffix ?? ''}`.toLowerCase();
  const email = `g${key}@example.jp`;
  const password = casePassword(`g${key}`);
  const guardianName = `受入 保護者 ${caseNo}${options.suffix ?? ''}${options.guardianSuffix ?? ''}`;
  await signupScreen(page, { code, name: guardianName, email, password, relationship: options.relationship });
  await logoutGuardian(page);
  return { ...child, email, password, guardianName };
}

export interface MadeStaff {
  staffId: string;
  name: string;
  email: string;
  tempPassword: string;
  password: string;
}

/** 前提S（NNN）：職員ID S07NNN、氏名「受入 職員 07-NNN」、ログインID s07NNN@hoiku.example.jp */
export async function makeStaffIssued(api: APIRequestContext, caseNo: string, options: { className?: string | null; suffix?: string; name?: string } = {}): Promise<MadeStaff> {
  const key = digitsOf(caseNo) + (options.suffix ?? '');
  const spec: StaffSpec = { id: `S${key}`, name: options.name ?? `受入 職員 ${caseNo}${options.suffix ?? ''}`, email: `s${key.toLowerCase()}@hoiku.example.jp`, className: options.className };
  const tempPassword = await issueStaff(api, spec);
  return { staffId: spec.id, name: spec.name, email: spec.email, tempPassword, password: casePassword(`s${key}`) };
}

/** 職員の初回ログイン：一時パスワードでログイン → パスワードを変える → 規約に同意 → 職員ダッシュボード */
export async function staffFirstLogin(page: Page, staff: { email: string; tempPassword: string; password: string }): Promise<void> {
  await loginWith(page, 'staff', staff.email, staff.tempPassword);
  await page.getByLabel(/現在のパスワード/).fill(staff.tempPassword);
  await page.getByRole('textbox', { name: /^新しいパスワード\s*必須$/ }).fill(staff.password);
  await page.getByLabel(/新しいパスワード（確認）/).fill(staff.password);
  await page.getByRole('button', { name: '変更する' }).click();
  await expect(page.getByRole('button', { name: '同意して進む' })).toBeVisible();
  await checkAllConsents(page);
  await page.getByRole('button', { name: '同意して進む' }).click();
  await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
}

/** 前提S+（NNN）：発行して初回ログインまで済ませ、ログアウトする */
export async function makeStaffReady(page: Page, api: APIRequestContext, caseNo: string, options: { className?: string | null; suffix?: string } = {}): Promise<MadeStaff> {
  const staff = await makeStaffIssued(api, caseNo, options);
  await staffFirstLogin(page, staff);
  await logoutStaff(page);
  return staff;
}

/** 職員のサイドナビ（職員メニュー） */
export function sideNav(page: Page) {
  return page.getByRole('navigation', { name: '職員メニュー' });
}

/** 画面の本文 */
export function mainOf(page: Page) {
  return page.getByRole('main');
}

/** 開いたダイアログ（最後のもの） */
export function lastDialog(page: Page) {
  return page.getByRole('dialog').last();
}

/** ブラウザのダイアログ（alert・confirm）の文を集める。confirm は受け入れる */
export function collectNativeDialogs(page: Page, accept = true): string[] {
  const seen: string[] = [];
  page.on('dialog', (d) => {
    seen.push(d.message());
    void (accept ? d.accept() : d.dismiss()).catch(() => {});
  });
  return seen;
}

/** window.print を止めて、呼ばれた回数を数える（印刷のケース。シート07「期待する結果の読み方」） */
export async function stubPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __printCount: number }).__printCount = 0;
    window.print = () => {
      (window as unknown as { __printCount: number }).__printCount += 1;
    };
  });
}

export async function printCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __printCount?: number }).__printCount ?? 0);
}

/** alert が出たかを数える仕掛け（XSS のケース） */
export async function watchAlerts(page: Page): Promise<string[]> {
  const seen: string[] = [];
  page.on('dialog', (d) => {
    if (d.type() === 'alert') seen.push(d.message());
    void d.dismiss().catch(() => {});
  });
  return seen;
}

/** 今年度（4月はじまり。JST の今日から） */
export function fiscalYearOf(ymd: string): number {
  const [y, m] = ymd.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}

/** 正規表現の文字をそのまま当てる */
export function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 一覧の表の、見出しを除いた行 */
export function dataRows(page: Page, scope?: import('@playwright/test').Locator) {
  return (scope ?? page.getByRole('main')).getByRole('table').first().getByRole('rowgroup').nth(1).getByRole('row');
}

/** 一覧の表の、見出しの列名 */
export async function columnNames(page: Page, scope?: import('@playwright/test').Locator): Promise<string[]> {
  const names = await (scope ?? page.getByRole('main')).getByRole('table').first().getByRole('columnheader').allInnerTexts();
  return names.map((n) => n.trim());
}

/** YYYY-MM-DD → YYYY/MM/DD */
export function slash(ymd: string): string {
  return ymd.replace(/-/g, '/');
}

/** 今年度の在籍の園児の数（クラスを指定するときはそのクラス）。(R1a) */
export function enrolledCount(className?: string): number {
  const where = className ? 'AND cl.class_name = ?' : '';
  const params: SqlParam[] = className ? [className] : [];
  return Number(
    sqlValue(
      `SELECT COUNT(DISTINCT c.child_id) FROM m_child c
         JOIN t_class_child cc ON cc.child_id = c.child_id
         JOIN m_class cl ON cl.class_id = cc.class_id
        WHERE c.is_deleted = 0 AND c.enrollment_status = '1'
          AND cl.fiscal_year = (SELECT MAX(fiscal_year) FROM m_class) ${where}`,
      ...params,
    ) ?? 0,
  );
}

/** その表に列があるか（実装の列の過不足を確かめてから SQL を書く。シート07「前提の記号」【SQL】） */
export function hasColumn(table: string, column: string): boolean {
  return sqlAll(`PRAGMA table_info(${table})`).some((c) => c.name === column);
}

// ---- Shift_JIS（07-019。CSV のファイルの文字コード） ----

let sjisMap: Map<string, number[]> | null = null;

/** 文を Shift_JIS のバイト列にする（Node の TextDecoder('shift_jis') の逆引き。外のライブラリを使わない） */
export function toShiftJis(text: string): Buffer {
  if (!sjisMap) {
    const map = new Map<string, number[]>();
    const dec = new TextDecoder('shift_jis');
    for (let b = 0xa1; b <= 0xdf; b++) {
      const c = dec.decode(new Uint8Array([b]));
      if (c.length === 1 && c !== '�' && !map.has(c)) map.set(c, [b]);
    }
    const leads: number[] = [];
    for (let l = 0x81; l <= 0x9f; l++) leads.push(l);
    for (let l = 0xe0; l <= 0xef; l++) leads.push(l);
    for (const l of leads) {
      for (let t = 0x40; t <= 0xfc; t++) {
        if (t === 0x7f) continue;
        const c = dec.decode(new Uint8Array([l, t]));
        if (c.length === 1 && c !== '�' && !map.has(c)) map.set(c, [l, t]);
      }
    }
    sjisMap = map;
  }
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const bytes = sjisMap.get(ch);
    if (!bytes) throw new Error(`Shift_JIS にできない文字です: ${ch}`);
    out.push(...bytes);
  }
  return Buffer.from(out);
}
