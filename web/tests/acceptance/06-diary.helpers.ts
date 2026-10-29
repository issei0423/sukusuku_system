/*
 * シート 06 日誌システムの手助け（06-diary.spec.ts だけが使う）。
 *
 * - 窓：2つ目・3つ目の窓（ブラウザの文脈）を開いてログインする。127.0.0.1 の外へは出さない
 * - 前提を作る口：日誌を作る・申請する・承認する・差し戻す（画面と同じ経路。図/インタフェース一覧「日誌システム（園内の記録）」）、
 *   【村田】【フリー】の初回ログイン、設定の値
 * - データベース：確かめに使う SQL（読むだけ）と、シートの【SQL】の書き換え（W1〜W4）
 *
 * 期待する結果はここに書かない（spec に書く）。共有のファイル（harness.ts など）は変えない。
 */
import { DatabaseSync } from 'node:sqlite';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { ACCOUNTS, PHONE, TABLET, expect, fillLogin, gotoTop, login, passwordOf, serverInfo, type AccountKey } from './harness';
import { HARNESS_ERROR_MARK, HOST } from './paths.mjs';

/** 2分以上待つケースは、ACCEPTANCE_LONG=1 のときだけ回す（試しの回では未実施にする） */
export const LONG = process.env.ACCEPTANCE_LONG === '1';
export const LONG_REASON = '2分以上待つケースのため、この回では回していない（全体の回で ACCEPTANCE_LONG=1 を付けて回す）';

/** 【12-1】画面に機能が無かったときの未実施の理由（rules.md の「次の版の機能」と同じ扱い） */
export function notIn121(what: string): string {
  return `実装対象の外（画面詳細図「モックアップでは実装しないもの」(12-1)。画面に機能が無い：${what}）`;
}

// ---- データベース（そのサーバの使い捨てのもの） ----

function openDb(): DatabaseSync {
  const info = serverInfo();
  if (!info) throw new Error(`${HARNESS_ERROR_MARK} サーバが立っていません（データベースの場所が分からない）`);
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

/** 書き換え（シートの【SQL】の印のケースだけで使う） */
export function sqlRun(query: string, ...params: (string | number | null)[]): number {
  const db = openDb();
  try {
    return Number(db.prepare(query).run(...params).changes);
  } finally {
    db.close();
  }
}

export function setSettingBySql(key: string, value: string) {
  const changed = sqlRun('UPDATE m_setting SET setting_value = ? WHERE setting_key = ?', value, key);
  if (changed !== 1) throw new Error(`${HARNESS_ERROR_MARK} 設定 ${key} を書き換えられませんでした`);
}

export function staffIdOf(name: string): string {
  const row = sqlOne<{ staff_id: string }>('SELECT staff_id FROM m_staff WHERE staff_name = ?', name);
  if (!row) throw new Error(`${HARNESS_ERROR_MARK} 職員 ${name} がデータベースにありません`);
  return row.staff_id;
}

export function childIdOf(name: string): string {
  const row = sqlOne<{ child_id: string }>('SELECT child_id FROM m_child WHERE child_name = ? AND is_deleted = 0', name);
  if (!row) throw new Error(`${HARNESS_ERROR_MARK} 園児 ${name} がデータベースにありません`);
  return row.child_id;
}

/** いまの年度のクラスID */
export function classIdOf(name: string): number {
  const row = sqlOne<{ class_id: number }>(
    'SELECT class_id FROM m_class WHERE class_name = ? AND fiscal_year = (SELECT MAX(fiscal_year) FROM m_class)',
    name,
  );
  if (!row) throw new Error(`${HARNESS_ERROR_MARK} クラス ${name} がデータベースにありません`);
  return Number(row.class_id);
}

/** そのクラスに在籍する園児（いまの年度）。名前の順ではなく、園児IDの順 */
export function childrenOf(className: string): { child_id: string; child_name: string }[] {
  return sqlAll<{ child_id: string; child_name: string }>(
    `SELECT c.child_id, c.child_name FROM m_child c
       JOIN t_class_child cc ON cc.child_id = c.child_id
       JOIN m_class cl ON cl.class_id = cc.class_id
      WHERE cl.class_name = ? AND cl.fiscal_year = (SELECT MAX(fiscal_year) FROM m_class) AND c.is_deleted = 0
      ORDER BY c.child_id`,
    className,
  );
}

export interface DiaryRow {
  diary_id: number;
  record_type: string;
  child_id: string | null;
  class_id: number;
  diary_date: string;
  body: string;
  status: string;
  created_staff_id: string;
  applied_staff_id: string | null;
  applied_at: string | null;
  approved_staff_id: string | null;
  approved_at: string | null;
  returned_reason: string | null;
  occurred_at: string | null;
  place: string | null;
  guardian_notice: string | null;
  guardian_noticed_at: string | null;
  guardian_notice_method: string | null;
  guardian_notice_person: string | null;
  is_deleted: number;
  created_at: string;
  updated_at: string;
}

/** 本文の文字で日誌を引く（シート「確かめに使う SQL」） */
export function diariesLike(text: string): DiaryRow[] {
  return sqlAll<DiaryRow>('SELECT * FROM t_diary WHERE body LIKE ? AND is_deleted = 0 ORDER BY diary_id', `%${text}%`);
}

export function diaryById(id: number): DiaryRow | undefined {
  return sqlOne<DiaryRow>('SELECT * FROM t_diary WHERE diary_id = ?', id);
}

export function lockOf(id: number) {
  return sqlAll<{ diary_id: number; lock_token: string; locked_staff_id: string; locked_at: string; last_active_at: string }>(
    'SELECT diary_id, lock_token, locked_staff_id, locked_at, last_active_at FROM t_diary_lock WHERE diary_id = ?',
    id,
  );
}

export interface LogRow {
  operation_log_id: number;
  operated_at: string;
  account_id: number | null;
  function_type: string;
  operation_type: string;
  target_table: string;
  target_id: number | null;
  target_child_id: string | null;
  before_value: string | null;
  after_value: string | null;
}

/** その日誌の操作ログ（機能種別 1：日誌） */
export function diaryLogs(id: number): LogRow[] {
  return sqlAll<LogRow>("SELECT * FROM t_operation_log WHERE function_type = '1' AND target_id = ? ORDER BY operation_log_id", id);
}

export function maxLogId(): number {
  return Number(sqlOne<{ m: number }>('SELECT COALESCE(MAX(operation_log_id), 0) AS m FROM t_operation_log')?.m ?? 0);
}

export function logsAfter(id: number): LogRow[] {
  return sqlAll<LogRow>('SELECT * FROM t_operation_log WHERE operation_log_id > ? ORDER BY operation_log_id', id);
}

// ---- 日付と時刻（サーバも JST で打つ） ----

/** JST の日付（YYYY-MM-DD）に日数を足す */
export function shiftDate(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(d);
}

const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
/** JST の「時:分」（2桁ずつ） */
export function jstHM(d = new Date()): string {
  return hmFmt.format(d);
}
/** 「09:05」と「9:05」の両方に当たる正規表現の部分 */
export function hmPattern(hhmm: string): string {
  const [h, m] = hhmm.split(':');
  return `0?${Number(h)}:${m}`;
}
/** JST の「YYYY-MM-DDTHH:MM」（datetime-local の値） */
export function jstLocal(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(' ', 'T');
}
/** いまより前の、いちばん近い5分刻みの時刻（さらに offset 分ずつ前へ）。datetime-local の値 */
export function past5min(offsetSteps = 1): Date {
  const now = Date.now();
  const step = 5 * 60_000;
  return new Date(Math.floor(now / step) * step - (offsetSteps - 1) * step - (now % step === 0 ? step : 0));
}
/** いまより後の、いちばん近い5分刻みの時刻 */
export function future5min(): Date {
  const step = 5 * 60_000;
  return new Date(Math.floor(Date.now() / step) * step + step);
}

/**
 * データベースの時刻の書き方に合わせて、分を足した時刻を作る（書く前に読んで同じ形で書く）。
 * 読んだ値が「YYYY-MM-DDTHH:MM:SS(+09:00)」か「YYYY-MM-DD HH:MM:SS」かを見て、同じ形で返す
 */
export function sameFormatShift(sample: string, base: Date, minutes: number): string {
  const d = new Date(base.getTime() + minutes * 60_000);
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d); // 2026-10-26 09:05:00
  const sep = sample.includes('T') ? 'T' : ' ';
  const tz = /([+-]\d\d:\d\d|Z)$/.exec(sample)?.[1] ?? '';
  const frac = /\.\d+/.exec(sample)?.[0] ?? '';
  return parts.replace(' ', sep) + frac + (tz === 'Z' ? '' : tz);
}

// ---- 窓 ----

const opened: { context: BrowserContext; blocked: string[] }[] = [];

/** 新しい窓（別のブラウザの文脈）。職員はタブレット、保護者はスマートフォンの大きさ */
export async function newWindow(browser: Browser, phone = false): Promise<{ context: BrowserContext; page: Page }> {
  const info = serverInfo();
  if (!info) throw new Error(`${HARNESS_ERROR_MARK} サーバが立っていません`);
  const context = await browser.newContext({
    baseURL: info.baseURL,
    viewport: phone ? PHONE : TABLET,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
    serviceWorkers: 'block',
    permissions: [],
  });
  const blocked: string[] = [];
  await context.route(
    (url) => !(url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:' || url.hostname === HOST),
    (route) => {
      blocked.push(route.request().url());
      return route.abort('blockedbyclient');
    },
  );
  opened.push({ context, blocked });
  const page = await context.newPage();
  return { context, page };
}

/** 新しい窓を開き、そのアカウントでログインする */
export async function openWindow(browser: Browser, who: AccountKey): Promise<Page> {
  const { page } = await newWindow(browser, ACCOUNTS[who].entrance === 'guardian');
  await login(page, who);
  return page;
}

/** このテストで開いた窓を閉じる（afterEach で呼ぶ）。127.0.0.1 以外へ出ようとしていたら、ハーネスの誤りとして止める */
export async function closeWindows() {
  const all = opened.splice(0);
  const blocked = all.flatMap((o) => o.blocked);
  for (const o of all) await o.context.close().catch(() => {});
  if (blocked.length > 0) throw new Error(`${HARNESS_ERROR_MARK} 127.0.0.1 以外への要求を止めました: ${[...new Set(blocked)].join(', ')}`);
}

/** 画面に出た確認のダイアログ（window.alert など）を数える。XSS のケースで、出なかったことを確かめる */
export function watchDialogs(...pages: Page[]): string[] {
  const seen: string[] = [];
  for (const p of pages) {
    p.on('dialog', (d) => {
      seen.push(`${d.type()}: ${d.message()}`);
      void d.dismiss().catch(() => {});
    });
  }
  return seen;
}

/**
 * 【知らせ見張り】その文脈で、知らせ（GET /api/events の SSE）で届いた種類を記録する仕掛けを入れる（画面を開く前に呼ぶ）。
 * 画面の動きは変えない（EventSource を包み、届いた種類を window.__events に足すだけ）
 */
export async function watchEvents(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __events: string[]; EventSource: typeof EventSource };
    w.__events = [];
    const Orig = w.EventSource;
    if (!Orig) return;
    const kinds = ['contact', 'chat', 'diary', 'nap', 'development', 'physical', 'handout', 'growth', 'ping', 'message'];
    class Watched extends Orig {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        for (const k of kinds) this.addEventListener(k, () => w.__events.push(k));
      }
    }
    w.EventSource = Watched as unknown as typeof EventSource;
  });
}

export async function eventsSeen(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __events?: string[] }).__events ?? []);
}

// ---- API（画面と同じ送信元から。Cookie と Origin はブラウザが付ける） ----

export interface ApiResult {
  status: number;
  json: unknown;
  text: string;
}

export async function api(page: Page, method: string, url: string, body?: unknown): Promise<ApiResult> {
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

// ---- 初回ログイン（【村田】【フリー】） ----

/** 一時パスワードの職員がパスワードを変え、規約の同意まで済ませる */
export async function finishFirstLogin(page: Page, tempPassword: string, newPassword: string) {
  await expect(page.getByRole('heading', { name: 'パスワードの変更' })).toBeVisible();
  await page.getByLabel(/現在のパスワード/).fill(tempPassword);
  await page.getByRole('textbox', { name: /^新しいパスワード\s*(必須)?$/ }).fill(newPassword);
  await page.getByLabel(/新しいパスワード（確認）/).fill(newPassword);
  await page.getByRole('button', { name: '変更する' }).click();
  await page.waitForURL((u) => !u.pathname.includes('password'), { timeout: 15_000 });
  if (/terms/.test(new URL(page.url()).pathname)) {
    const boxes = page.getByRole('checkbox', { name: /同意します/ });
    for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
    await page.getByRole('button', { name: /同意して進む|同意/ }).first().click();
    await page.waitForURL((u) => !u.pathname.includes('terms'), { timeout: 15_000 });
  }
  await expect(page.getByRole('navigation', { name: '職員メニュー' })).toBeVisible();
}

export const MURATA_NEW_PASSWORD = 'Accept-06-Murata-2026';

/** 【村田】一般M（一時パスワード中）でログインし、パスワードを変えてから使う。2回目からは新しいパスワードでログインする */
export async function loginMurata(page: Page) {
  await gotoTop(page, 'staff');
  const changed = sqlOne<{ is_temp_password: number }>('SELECT is_temp_password FROM m_account WHERE email = ?', ACCOUNTS.staffTempPassword.email);
  if (changed && Number(changed.is_temp_password) === 0) {
    await fillLogin(page, 'staffTempPassword', { password: MURATA_NEW_PASSWORD });
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '職員メニュー' })).toBeVisible();
    return;
  }
  await fillLogin(page, 'staffTempPassword');
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await finishFirstLogin(page, passwordOf('staffTempPassword'), MURATA_NEW_PASSWORD);
}

export async function openMurata(browser: Browser): Promise<Page> {
  const { page } = await newWindow(browser);
  await loginMurata(page);
  return page;
}

/**
 * 【フリー】担当クラスの無い一般の職員「受入テスト フリー」を、管理者の窓から発行する（職員アカウント管理画面の
 * 「＋ アカウントを発行」と同じ経路）。その職員で初回ログインを済ませた窓を返す
 */
export async function openFreeStaff(browser: Browser, adminPage: Page): Promise<Page> {
  const res = await api(adminPage, 'POST', '/api/admin/staff-accounts', {
    staff_id: 'S06045F',
    staff_name: '受入テスト フリー',
    email: 'free06045@hoiku.example.jp',
    role: '2',
    class_id: null,
  });
  if (res.status !== 200) throw new Error(`下ごしらえ：フリーの職員を発行できません（${res.status} ${res.text}）`);
  const temp = (res.json as { password?: string }).password;
  if (!temp) throw new Error(`下ごしらえ：発行の応答に一時パスワードがありません（${res.text}）`);
  const { page } = await newWindow(browser);
  await page.goto('/staff-top');
  await page.getByLabel('ログインID', { exact: true }).fill('free06045@hoiku.example.jp');
  await page.getByLabel('パスワード', { exact: true }).fill(temp);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await finishFirstLogin(page, temp, 'Accept-06-Free-2026');
  return page;
}

// ---- 日誌の前提（画面と同じ経路。図/インタフェース一覧「日誌システム（園内の記録）」） ----

export type RecordType = '1' | '2' | '3' | '4';
export const TYPE_LABEL: Record<RecordType, string> = { '1': '個人日誌', '2': 'クラス日誌', '3': '週案・月案', '4': 'ヒヤリハット' };

/** 園児のいまの年度のクラスID */
export function classOfChild(childId: string): number {
  const row = sqlOne<{ class_id: number }>(
    `SELECT cc.class_id FROM t_class_child cc JOIN m_class cl ON cl.class_id = cc.class_id
      WHERE cc.child_id = ? AND cl.fiscal_year = (SELECT MAX(fiscal_year) FROM m_class)`,
    childId,
  );
  if (!row) throw new Error(`${HARNESS_ERROR_MARK} 園児 ${childId} のクラスがありません`);
  return Number(row.class_id);
}

export interface Incident {
  occurred_at: string;
  place: string;
  situation: string;
  response: string;
  countermeasure?: string;
  guardian_notice?: '1' | '2';
  guardian_noticed_at?: string;
  guardian_notice_method?: '1' | '2' | '3' | '9';
  guardian_notice_person?: string;
}

export interface DiarySpec {
  type: RecordType;
  /** 個人日誌・ヒヤリハットの園児名 */
  child?: string;
  /** クラス日誌・週案月案のクラス名 */
  className?: string;
  date?: string;
  body: string;
  /** '1' 下書き（既定）・'2' 申請 */
  status?: '1' | '2';
  incident?: Incident;
}

function diaryPayload(spec: DiarySpec, today: string) {
  const childId = spec.child ? childIdOf(spec.child) : null;
  const classId = childId ? classOfChild(childId) : classIdOf(spec.className ?? 'さくら組');
  return {
    record_type: spec.type,
    ...(childId ? { child_id: childId } : {}),
    class_id: classId,
    diary_date: spec.date ?? today,
    body: spec.body,
    status: spec.status ?? '1',
    ...(spec.incident ? { incident: spec.incident } : {}),
  };
}

/** 日誌を作る（下書き保存か、作って申請）。その職員の窓から呼ぶ */
export async function createDiary(page: Page, spec: DiarySpec, today: string): Promise<number> {
  const res = await api(page, 'POST', '/api/diaries', diaryPayload(spec, today));
  if (res.status !== 200) throw new Error(`下ごしらえ：日誌を作れません（${res.status} ${res.text}）`);
  return Number((res.json as { diary_id: number }).diary_id);
}

/** 編集ロックを取る（POST /api/diaries/{id}/lock）。識別子を返す */
export async function takeLock(page: Page, id: number): Promise<string> {
  const res = await api(page, 'POST', `/api/diaries/${id}/lock`);
  const token = (res.json as { token?: string; lock_token?: string } | null)?.token ?? (res.json as { lock_token?: string } | null)?.lock_token;
  if (res.status !== 200 || !token) throw new Error(`下ごしらえ：編集ロックを取れません（${res.status} ${res.text}）`);
  return token;
}

/** 下書き・差し戻しの日誌を申請する（ロックを取ってから保存する。画面の「確認へ進む」→「申請する」と同じ経路） */
export async function applyDiary(page: Page, id: number): Promise<void> {
  const row = diaryById(id);
  if (!row) throw new Error(`${HARNESS_ERROR_MARK} 日誌 ${id} がありません`);
  const token = await takeLock(page, id);
  const res = await api(page, 'POST', '/api/diaries', {
    diary_id: id,
    record_type: row.record_type,
    ...(row.child_id ? { child_id: row.child_id } : {}),
    class_id: row.class_id,
    diary_date: row.diary_date,
    body: row.body,
    status: '2',
    lock_token: token,
  });
  if (res.status !== 200) throw new Error(`下ごしらえ：日誌 ${id} を申請できません（${res.status} ${res.text}）`);
}

export async function approveDiary(page: Page, id: number): Promise<void> {
  const res = await api(page, 'POST', `/api/diaries/${id}/approve`, {});
  if (res.status !== 200) throw new Error(`下ごしらえ：日誌 ${id} を承認できません（${res.status} ${res.text}）`);
}

export async function returnDiary(page: Page, id: number, reason: string): Promise<void> {
  const res = await api(page, 'POST', `/api/diaries/${id}/return`, { reason });
  if (res.status !== 200) throw new Error(`下ごしらえ：日誌 ${id} を差し戻せません（${res.status} ${res.text}）`);
}

export async function revokeDiary(page: Page, id: number, reason: string): Promise<void> {
  const row = diaryById(id);
  const res = await api(page, 'POST', `/api/diaries/${id}/revoke-approval`, { reason, updated_at: row?.updated_at });
  if (res.status !== 200) throw new Error(`下ごしらえ：日誌 ${id} の承認を取り消せません（${res.status} ${res.text}）`);
}

// ---- 日誌の画面 ----

export const mainOf = (page: Page) => page.getByRole('main');
export const bodyBox = (page: Page) => mainOf(page).getByRole('textbox', { name: /^本文/ });
export const saveButton = (page: Page) => mainOf(page).getByRole('button', { name: '下書き保存' });
export const confirmButton = (page: Page) => mainOf(page).getByRole('button', { name: '確認へ進む' });
export const applyButton = (page: Page) => mainOf(page).getByRole('button', { name: '申請する' });
export const childSelect = (page: Page) => mainOf(page).getByRole('combobox', { name: /^対象の園児/ });
export const classSelectOf = (page: Page) => mainOf(page).getByRole('combobox', { name: /^対象のクラス/ });
export const dateBox = (page: Page) => mainOf(page).getByRole('textbox', { name: /^記録日/ });
/** 他の職員が編集中の表示（設計書の文言「他の職員が編集しています。」と、画面の「〇〇さんが編集中です。」のどちらでも見つける。文言そのものは 06-019 で見る） */
export const lockNotice = (page: Page) => mainOf(page).getByText(/他の職員が編集しています|さんが編集中です/).first();
/** 画面の下端の完了・誤りの表示（role=status） */
export const toast = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text }).first();

/** サイドナビの「日誌」から日誌一覧画面を開く */
export async function gotoList(page: Page) {
  await page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '日誌', exact: true }).click();
  await expect(page.getByRole('heading', { name: '日誌', level: 1 })).toBeVisible();
  await expect(mainOf(page).getByRole('table').or(mainOf(page).getByText('該当する日誌はありません')).first()).toBeVisible();
}

/** 一覧の、その日誌の行の「開く」 */
export const listLink = (page: Page, id: number) => mainOf(page).locator(`a[href="/staff/diary/${id}"]`);
export const listRow = (page: Page, id: number) => mainOf(page).getByRole('row').filter({ has: page.locator(`a[href="/staff/diary/${id}"]`) });

/** 日誌一覧画面の「＋ 新しく書く」から、日誌作成・編集画面を新規で開く */
export async function newDiary(page: Page) {
  await gotoList(page);
  await mainOf(page).getByRole('link', { name: /新しく書く/ }).or(mainOf(page).getByRole('button', { name: /新しく書く/ })).first().click();
  await expect(page.getByRole('heading', { name: '日誌の作成', level: 1 })).toBeVisible();
}

/** その日誌を日誌作成・編集画面で開く（一覧の「開く」と同じ移り先） */
export async function openDiary(page: Page, id: number) {
  await page.goto(`/staff/diary/${id}`);
  await expect(page.getByRole('heading', { name: /日誌の(編集|作成)/, level: 1 }).or(mainOf(page).getByRole('alert')).first()).toBeVisible();
}

/** 本文の末尾に文を足す */
export async function appendBody(page: Page, text: string) {
  const box = bodyBox(page);
  const now = await box.inputValue();
  await box.fill(now ? `${now}\n${text}` : text);
}

export async function saveDraft(page: Page) {
  await saveButton(page).click();
}

/** 「確認へ進む」→ 日誌確認画面 →「申請する」→ 日誌一覧画面 */
export async function confirmAndApply(page: Page) {
  await confirmButton(page).click();
  await expect(page.getByRole('heading', { name: /申請します|日誌の確認/, level: 1 })).toBeVisible();
  await applyButton(page).click();
  await expect(page.getByRole('heading', { name: '日誌', level: 1 })).toBeVisible();
}

/** 承認待ち一覧画面の、その日誌の行の「承認へ」 */
export const pendingLink = (page: Page, id: number) => mainOf(page).locator(`a[href="/staff/admin/approval/${id}"]`);
export const pendingRow = (page: Page, id: number) => mainOf(page).getByRole('row').filter({ has: page.locator(`a[href$="/${id}"]`) });

export async function gotoPending(page: Page) {
  await page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '承認待ち' }).click();
  await expect(page.getByRole('heading', { name: '承認待ち', level: 1 })).toBeVisible();
}

export async function openApproval(page: Page, id: number) {
  await page.goto(`/staff/admin/approval/${id}`);
  await expect(page.getByRole('heading', { name: '日誌の承認', level: 1 }).or(mainOf(page).getByRole('alert')).first()).toBeVisible();
}

/** 職員ダッシュボードの行の数（「ありません」は 0）。label は行の見出し */
export async function dashRowCount(page: Page, label: string): Promise<number | null> {
  const row = mainOf(page).getByRole('row', { name: new RegExp(`^${label}`) });
  if ((await row.count()) === 0) return null;
  const text = (await row.first().getByRole('cell').nth(1).innerText()).replace(/\s+/g, ' ');
  if (text.includes('ありません')) return 0;
  const m = /(\d+)/.exec(text);
  return m ? Number(m[1]) : 0;
}

/** 管理者のダッシュボードの「承認待ち（の日誌）n 件」 */
export async function dashPendingCount(page: Page): Promise<number | null> {
  const row = await dashRowCount(page, '承認待ちの日誌');
  if (row !== null) return row;
  const text = (await mainOf(page).innerText()).replace(/\s+/g, ' ');
  const m = /承認待ち(?:の日誌)?\s*(\d+)\s*件/.exec(text);
  return m ? Number(m[1]) : null;
}

/** ヘッダの通知の件数 */
export async function headerCount(page: Page): Promise<number> {
  const btn = page.getByRole('banner').getByRole('button', { name: /通知/ });
  const name = (await btn.getAttribute('aria-label')) ?? (await btn.innerText());
  const m = /(\d+)/.exec(name);
  return m ? Number(m[1]) : 0;
}

/** 本文の改行の書き方（\r\n と \n）をそろえる */
export const nl = (s: string) => s.replace(/\r\n/g, '\n');

export type { Locator };
