/*
 * シート 03 チャットツール（配布物を含む）の手助け。03-chat.spec.ts だけが使う。
 *
 *   - 2つ目・3つ目の窓（職員と保護者、職員どうし）を browser.newContext() で開く。harness.ts の既定の窓と同じく、127.0.0.1 の外へは出さない
 *   - 下ごしらえ：API（画面と同じ経路。図/インタフェース一覧「チャットツール」(1) ほか）で、園児・招待コード・保護者・メッセージを作る
 *   - 確かめ：使い捨てのデータベースを SQL で読む（テスト仕様書「テスト時のデータベースの状態」(2.2)）
 *
 * 期待する結果はここに書かない（spec に書く）。ここは操作と前提だけ。共有のファイル（harness.ts など）は変えない。
 */
import { DatabaseSync } from 'node:sqlite';
import type { APIRequestContext, APIResponse, Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { ACCOUNTS, PHONE, TABLET, expect, login, passwordOf, serverInfo, type AccountKey } from './harness';
import { HARNESS_ERROR_MARK, HOST } from './paths.mjs';

// ---- 待ち ----

/**
 * 相手の窓が再読み込みなしで変わるのを待つ上限（sheet-03.md「このシートに共通の前提」）。
 * 目標の3秒（要件定義書「性能・可用性」(7-2 No.5)）に余裕を見た値。性能は計らない
 */
export const LIVE_TIMEOUT = 10_000;

// ---- サーバとデータベース ----

/** いまのサーバの起点（http://127.0.0.1:<ポート>） */
export function origin(): string {
  const info = serverInfo();
  if (!info) throw new Error('サーバがまだ立っていません（テストの中で呼んでください）');
  return new URL(info.baseURL).origin;
}

function openDb(): DatabaseSync {
  const info = serverInfo();
  if (!info) throw new Error('サーバがまだ立っていません');
  const db = new DatabaseSync(info.dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** いまのサーバのデータベースを読む（確かめだけに使う） */
export function sqlAll(statement: string, ...params: (string | number | null)[]): Record<string, unknown>[] {
  const db = openDb();
  try {
    return db.prepare(statement).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** 1つの数を読む（SELECT COUNT(*) AS n …） */
export function sqlCount(statement: string, ...params: (string | number | null)[]): number {
  const row = sqlAll(statement, ...params)[0];
  return Number(row ? Object.values(row)[0] : 0);
}

/** 画面で作れない前提だけに使う書き換え（ケースの「入力データ・前提」に書いた SQL） */
export function sqlRun(statement: string, ...params: (string | number | null)[]): void {
  const db = openDb();
  try {
    db.prepare(statement).run(...params);
  } finally {
    db.close();
  }
}

/** 本文が同じで、取り消していないメッセージの数（二重送信の確かめ。テスト仕様書 2.2 の SQL の例） */
export function messageCount(body: string): number {
  return sqlCount('SELECT COUNT(*) AS n FROM t_chat_message WHERE body = ? AND is_deleted = 0', body);
}

// ---- 窓 ----

const opened: { context: BrowserContext; blocked: string[] }[] = [];

/** 新しい窓（Cookie を分けた別のブラウザの文脈）を開く。職員はタブレット、保護者はスマートフォンの大きさ */
export async function newWindow(browser: Browser, testInfo: TestInfo, device: 'tablet' | 'phone'): Promise<Page> {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: device === 'phone' ? PHONE : TABLET,
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
  return context.newPage();
}

/** 新しい窓を開き、デモのアカウントでログインする */
export async function openAs(browser: Browser, testInfo: TestInfo, who: AccountKey): Promise<Page> {
  const page = await newWindow(browser, testInfo, ACCOUNTS[who].entrance === 'guardian' ? 'phone' : 'tablet');
  await login(page, who);
  return page;
}

/** このテストで開いた窓を閉じる（afterEach で呼ぶ）。127.0.0.1 の外へ出ようとしていたら、ハーネスの誤りとして止める */
export async function closeWindows() {
  const all = opened.splice(0);
  const blocked = all.flatMap((o) => o.blocked);
  for (const o of all) await o.context.close().catch(() => {});
  if (blocked.length > 0) throw new Error(`${HARNESS_ERROR_MARK} 127.0.0.1 以外への要求を止めました: ${[...new Set(blocked)].join(', ')}`);
}

/** 画面に出た確認のダイアログ（window.alert など）を集める。XSS のケースで、出なかったことを確かめる */
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

// ---- API（画面と同じ送信元から） ----

export interface ApiResult {
  status: number;
  json: unknown;
  text: string;
}

/** ログイン済みの画面から、同じ送信元で API を呼ぶ（Cookie と Origin はブラウザが付ける） */
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

/** API の文脈（下ごしらえ用）。同じサイトの Origin を付ける（基本設計書「CSRF対策の方式」(6-3)） */
export interface RequestFactory {
  request: { newContext(options?: Record<string, unknown>): Promise<APIRequestContext> };
}

const apiContexts: APIRequestContext[] = [];

export async function newApi(pw: RequestFactory): Promise<APIRequestContext> {
  const base = origin();
  const ctx = await pw.request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: base } });
  apiContexts.push(ctx);
  return ctx;
}

/** 下ごしらえの API の文脈を閉じる（afterEach で呼ぶ） */
export async function closeApis() {
  for (const c of apiContexts.splice(0)) await c.dispose().catch(() => {});
}

async function okJson<T>(label: string, resP: Promise<APIResponse>): Promise<T> {
  const res = await resP;
  if (!res.ok()) throw new Error(`下ごしらえ：${label} に失敗しました（${res.status()} ${await res.text()}）`);
  return (await res.json()) as T;
}

/** API でログインした文脈 */
export async function apiLoginAs(pw: RequestFactory, email: string, password: string, entrance: 'staff' | 'guardian'): Promise<APIRequestContext> {
  const ctx = await newApi(pw);
  const res = await ctx.post('/api/login', { data: { email, password, entrance } });
  if (res.status() !== 200) throw new Error(`下ごしらえ：${email} で API にログインできません（${res.status()} ${await res.text()}）`);
  return ctx;
}

/** デモのアカウントで API にログインした文脈 */
export function apiAs(pw: RequestFactory, who: AccountKey): Promise<APIRequestContext> {
  const a = ACCOUNTS[who];
  return apiLoginAs(pw, a.email, passwordOf(who), a.entrance);
}

// ---- チャンネル ----

export interface RoomView {
  room: { chat_room_id: number; room_type: string; class_id: number | null; child_id: string | null; room_name: string; is_archived: boolean };
  [key: string]: unknown;
}

/** 見えるチャンネルの一覧（GET /api/chat/rooms） */
export async function rooms(ctx: APIRequestContext): Promise<RoomView[]> {
  return okJson<RoomView[]>('チャンネルの一覧', ctx.get('/api/chat/rooms'));
}

/**
 * チャンネルの ID をデータベースから引く（m_chat_room。room_type は 1:園 2:クラスグループ 3:目的別グループ 4:個人 5:職員。
 * 個人チャットは child_id。基本設計書「チャット」(5-6)）
 */
export async function roomId(kind: { type: '1' | '2' | '3' | '4' | '5'; nameIncludes?: string; childId?: string }): Promise<number> {
  const rows = sqlAll('SELECT chat_room_id, child_id, room_name FROM m_chat_room WHERE room_type = ? ORDER BY chat_room_id', kind.type);
  const r = rows.find(
    (x) => (kind.childId === undefined || x.child_id === kind.childId) && (kind.nameIncludes === undefined || String(x.room_name).includes(kind.nameIncludes)),
  );
  if (!r) throw new Error(`下ごしらえ：チャンネル（種別 ${kind.type}・${kind.nameIncludes ?? kind.childId ?? ''}）が見つかりません`);
  return Number(r.chat_room_id);
}

export interface Msg {
  chat_message_id: number;
  body: string;
  [key: string]: unknown;
}

/** メッセージを送る（下ごしらえ。POST /api/chat/rooms/{id}/messages）。他児の名前の注意は承諾して通す */
export async function post(ctx: APIRequestContext, room: number, body: string, extra: Record<string, unknown> = {}): Promise<Msg> {
  let res = await ctx.post(`/api/chat/rooms/${room}/messages`, { data: { body, ...extra } });
  if (res.status() === 409) {
    const j = (await res.json()) as { kind?: string; names?: string[] };
    if (j.kind === 'other_child_names') res = await ctx.post(`/api/chat/rooms/${room}/messages`, { data: { body, ...extra, acknowledged_names: j.names } });
  }
  if (!res.ok()) throw new Error(`下ごしらえ：送信に失敗しました（${res.status()} ${await res.text()}）`);
  return (await res.json()) as Msg;
}

/** メッセージの一覧（GET /api/chat/rooms/{id}/messages）。返る形は配列か、配列を持つ物 */
export async function messages(ctx: APIRequestContext, room: number): Promise<Msg[]> {
  const j = await okJson<unknown>('メッセージの一覧', ctx.get(`/api/chat/rooms/${room}/messages`));
  return asMessageArray(j);
}

export function asMessageArray(j: unknown): Msg[] {
  if (Array.isArray(j)) return j as Msg[];
  if (j && typeof j === 'object') {
    for (const v of Object.values(j as Record<string, unknown>)) if (Array.isArray(v)) return v as Msg[];
  }
  return [];
}

/** 開いて既読にする（POST /api/chat/rooms/{id}/read） */
export async function markRead(ctx: APIRequestContext, room: number): Promise<void> {
  await okJson('既読', ctx.post(`/api/chat/rooms/${room}/read`, { data: {} }));
}

/** 取り消す（POST /api/chat/messages/{id}/retract） */
export async function retract(ctx: APIRequestContext, id: number): Promise<void> {
  await okJson('取消', ctx.post(`/api/chat/messages/${id}/retract`, { data: {} }));
}

// ---- 園児・招待コード・保護者 ----

/** クラス名からクラスID（いまの年度） */
export async function classIdOf(ctx: APIRequestContext, name: string): Promise<number> {
  const list = await okJson<{ class_id: number; fiscal_year: number; class_name: string }[]>('クラスの一覧', ctx.get('/api/classes'));
  const latest = Math.max(...list.map((c) => c.fiscal_year));
  const c = list.find((x) => x.fiscal_year === latest && x.class_name === name);
  if (!c) throw new Error(`下ごしらえ：クラス「${name}」がありません`);
  return c.class_id;
}

/**
 * ケースで作る園児（sheet-03.md「このシートに共通の前提」）。氏名とよみは、ケースの送る文に当たらないものにした
 * （他児の名前の照合は姓だけでも当たる。詳細設計書「他児の名前の照合」(4-5 (2))）
 */
export const KAKUU = { id: 'C03K01', name: '架空 一花', kana: 'かくう いちか' } as const;

/** 園児を登録する（園児情報入力画面と同じ経路 POST /api/children）。写真の利用同意は 1:園内記録として保持 */
export async function createChild(admin: APIRequestContext, spec: { id: string; name: string; kana: string; className: string; consent?: '1' | '2' | '3' }): Promise<void> {
  const classId = await classIdOf(admin, spec.className);
  await okJson('園児の登録', admin.post('/api/children', {
    data: {
      child_id: spec.id,
      child_name: spec.name,
      child_name_kana: spec.kana,
      nickname: '',
      birth_date: '2024-04-01',
      sex: '9',
      normal_temperature: null,
      photo_consent_level: spec.consent ?? '1',
      class_id: classId,
      allergies: [],
      medical_histories: [],
      mode: 'create',
    },
  }));
}

/** 招待コードを1枚発行する（招待コード管理画面の「1枚発行」と同じ経路）。コードを返す */
export async function issueCode(admin: APIRequestContext, childId: string): Promise<string> {
  const body = await okJson<{ code: string }>('招待コードの発行', admin.post('/api/admin/invitations', { data: { child_id: childId, valid_days: 7 } }));
  return body.code;
}

/** 規約のいまの版（GET /api/terms） */
async function termsVersion(ctx: APIRequestContext): Promise<string> {
  const text = JSON.stringify(await okJson<unknown>('規約', ctx.get('/api/terms')));
  const m = /"terms_version"\s*:\s*"([^"]+)"/.exec(text);
  if (!m) throw new Error('下ごしらえ：規約の版を読めません');
  return m[1];
}

export interface NewGuardian {
  email: string;
  password: string;
  name: string;
}

/**
 * 保護者を新規登録する（新規登録画面と同じ経路 POST /api/signup）。新規登録の画面そのものの確かめはシート01
 * パスワードは使い捨てのデータベースだけで使う試験用の値
 */
export async function signUp(pw: RequestFactory, code: string, key: string): Promise<NewGuardian> {
  const anon = await newApi(pw);
  const g: NewGuardian = { email: `t03-${key}@example.jp`, password: `ukeire-03-${key}-pw`, name: `受入 保護者 ${key}` };
  await okJson(`保護者 ${key} の新規登録`, anon.post('/api/signup', {
    data: { code, email: g.email, password: g.password, guardian_name: g.name, relationship: '母', terms_agreed: true, terms_version: await termsVersion(anon), phone_number1: '090-0000-0303' },
  }));
  return g;
}

/** 新しく登録した保護者で、窓を開いてログインする */
export async function openAsNew(browser: Browser, testInfo: TestInfo, g: NewGuardian): Promise<Page> {
  const page = await newWindow(browser, testInfo, 'phone');
  await page.goto('/');
  await page.getByLabel('ログインID', { exact: true }).fill(g.email);
  await page.getByLabel('パスワード', { exact: true }).fill(g.password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await page.waitForURL((u) => u.pathname !== '/', { timeout: 15_000 });
  return page;
}

// ---- ファイル ----

/** 人の写っていない絵を作る（色の帯）。JPEG か PNG */
export async function makePicture(page: Page, type: 'jpeg' | 'png'): Promise<Buffer> {
  const p = await page.context().newPage();
  await p.setViewportSize({ width: 320, height: 200 });
  await p.setContent('<div style="width:320px;height:200px;background:linear-gradient(135deg,#8cf,#fc8)"></div>');
  const buf = await p.screenshot({ type, ...(type === 'jpeg' ? { quality: 80 } : {}) });
  await p.close();
  return buf;
}

/** 1×1 の GIF（形式の外を試す） */
export const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

/** 試験用の PDF。頭（%PDF-）を付け、size バイトになるまで埋める（sheet-03.md 03-I023・03-I024） */
export function makePdf(size = 600): Buffer {
  const head = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');
  if (size <= head.length) return head;
  const buf = Buffer.alloc(size, 0x20);
  head.copy(buf, 0);
  return buf;
}

/** 最小の .docx に見えるファイル（Word の形。中身は試験用） */
export const DOCX = Buffer.from('PK\u0003\u0004受入テスト docx', 'latin1');

/** 「〇」で埋めて、符号位置で n 文字にする */
export function fill(prefix: string, n: number): string {
  const len = [...prefix].length;
  return prefix + '〇'.repeat(Math.max(0, n - len));
}

/** 正規表現の中で文字どおりに当てる */
export function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- データベースから引く（下ごしらえと確かめ） ----

export function childIdOf(name: string): string {
  const row = sqlAll('SELECT child_id FROM m_child WHERE child_name = ?', name)[0];
  if (!row) throw new Error(`下ごしらえ：園児「${name}」がいません`);
  return String(row.child_id);
}

export function childNameOf(id: string): string {
  const row = sqlAll('SELECT child_name FROM m_child WHERE child_id = ?', id)[0];
  if (!row) throw new Error(`下ごしらえ：園児 ${id} がいません`);
  return String(row.child_name);
}

/** そのログインIDの保護者の、紐づけが有効な園児との続柄 */
export function relationshipOf(email: string, childId: string): string {
  const row = sqlAll(
    `SELECT gc.relationship FROM t_guardian_child gc
       JOIN m_guardian g ON g.guardian_id = gc.guardian_id
       JOIN m_account a ON a.account_id = g.account_id
      WHERE a.email = ? AND gc.child_id = ? AND gc.link_status = '1'`,
    email,
    childId,
  )[0];
  return row ? String(row.relationship) : '';
}

/** 本文が同じメッセージの ID（いちばん新しいもの） */
export function messageIdOf(body: string): number {
  const row = sqlAll('SELECT chat_message_id FROM t_chat_message WHERE body = ? ORDER BY chat_message_id DESC LIMIT 1', body)[0];
  if (!row) throw new Error(`メッセージ「${body}」がデータベースにありません`);
  return Number(row.chat_message_id);
}

/** そのメッセージを開いた保護者の数（t_chat_read。ロール 3:保護者） */
export function guardianReads(messageId: number): number {
  return sqlCount(
    `SELECT COUNT(*) AS n FROM t_chat_read r JOIN m_account a ON a.account_id = r.account_id WHERE r.chat_message_id = ? AND a.role = '3'`,
    messageId,
  );
}

/** 保護者が開いたことがデータベースに入るまで待つ（既読の数を確かめる前に） */
export async function waitGuardianRead(messageId: number, n = 1) {
  await expect.poll(() => guardianReads(messageId), { timeout: LIVE_TIMEOUT, message: '保護者が開いた記録（t_chat_read）が入るのを待つ' }).toBeGreaterThanOrEqual(n);
}

// ---- 画面：チャット ----

/** チャット画面（職員）を開く。サイドナビの「チャット」と同じ（図/画面遷移図「チャットツール」(5)） */
export async function staffChat(page: Page) {
  await page.getByRole('navigation').getByRole('link', { name: 'チャット', exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', { name: 'チャット', level: 1 })).toBeVisible();
}

/** チャンネル一覧のボタン（表示名で始まるもの）。未読の数などが後ろに付くので、頭で当てる */
export function channelButton(page: Page, name: string): import('@playwright/test').Locator {
  return page.getByRole('main').getByRole('button', { name: new RegExp(`^${esc(name)}`) });
}

/** チャンネルを選ぶ（職員・保護者とも、同じ画面の中で入れ替わる） */
export async function openChannel(page: Page, name: string) {
  await channelButton(page, name).first().click();
}

/** チャット画面（保護者）のチャンネル一覧を開く（保護者のメニュー・ホームの「チャット・お知らせ」と同じ行き先） */
export async function guardianChat(page: Page) {
  await page.goto('/guardian/chat');
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
}

/**
 * 保護者の個人チャットを開く。表記は設計では「〇〇（園児名）の園とのやりとり」（図/画面詳細図「チャット画面（保護者・スマートフォン）」(4-2) 項目1）。
 * 表記が違う画面でも、ほかのケースの確かめを進めるため、個人チャットが1つだけなら前の版の表記（「担任の先生とのやりとり」）で開く。
 * 表記そのものは 03-002・03-005 が確かめる
 */
export async function openGuardianPersonal(page: Page, childName: string) {
  const designed = channelButton(page, `${childName}の園とのやりとり`);
  if ((await designed.count()) > 0) {
    await designed.first().click();
    return;
  }
  test_note(`保護者の個人チャットの表記が「${childName}の園とのやりとり」ではないため、前の版の表記で開いた（表記は 03-002 で確かめる）`);
  await channelButton(page, '担任の先生とのやりとり').first().click();
}

let noteSink: ((text: string) => void) | null = null;
/** 備考に残したいことを、テストの注記に足す（spec が setNoteSink で渡す） */
export function setNoteSink(sink: (text: string) => void) {
  noteSink = sink;
}
function test_note(text: string) {
  noteSink?.(text);
}

export function composer(page: Page) {
  return page.getByRole('main').getByRole('textbox', { name: 'メッセージを入力' });
}

export function sendButton(page: Page) {
  return page.getByRole('main').getByRole('button', { name: '送信', exact: true });
}

/** 本文を入れて「送信」を押す */
export async function sendUi(page: Page, body: string) {
  await composer(page).fill(body);
  await sendButton(page).click();
}

/** 一覧のメッセージの本文 */
export function msgText(page: Page, body: string) {
  return page.getByRole('main').getByText(body, { exact: true });
}

/**
 * メッセージの操作の一覧を開く。設計では「操作」ボタン、または右クリック（タブレットでは長押し）で同じ一覧を開ける
 * （図/画面詳細図「チャット画面（職員・タブレット／PC）」(4-1) 項目15）。ここでは右クリックで開く（「操作」ボタンは 03-022 で確かめる）
 */
export async function openOps(page: Page, body: string) {
  await msgText(page, body).last().click({ button: 'right' });
}

/** 操作の一覧のボタン */
export function opButton(page: Page, name: string) {
  return page.getByRole('main').getByRole('button', { name, exact: true });
}

/** 他児の名前の注意（ダイアログ）。図/画面詳細図「共通のダイアログと部品」(1-3) (3) */
export function nameCheckDialog(page: Page) {
  return page.getByRole('dialog').filter({ hasText: 'ほかのお子さんの名前' });
}

/** 画面の下端などに出る結果の文（role=status か alert） */
export function notice(page: Page, text: string | RegExp) {
  return page.locator('[role="status"], [role="alert"]').filter({ hasText: text }).first();
}

/** 本文を含み、指定のボタンを持つ、いちばん近い祖先（メッセージの吹き出し） */
export function bubbleWithButton(page: Page, body: string, button: string) {
  return page
    .getByRole('main')
    .getByText(body, { exact: true })
    .last()
    .locator(`xpath=ancestor::*[.//button[normalize-space()="${button}"]][1]`);
}

// ---- 画面：園児情報（前提を作る） ----

/**
 * 園児情報入力画面で、写真の利用同意を変える（管理者の窓で呼ぶ）。選択肢の表示名は画面の言葉で、label の正規表現で選ぶ。
 * 画面の流れは連絡帳のシートの手助け（02-contact.helpers.ts の setConsent）と同じ
 */
export async function setConsentUi(adminPage: Page, childId: string, label: RegExp) {
  await adminPage.goto(`/staff/children/${childId}/edit`);
  const select = adminPage.getByRole('combobox', { name: /写真の利用同意/ });
  await expect(select).toBeVisible();
  const options = await select.locator('option').allTextContents();
  const pick = options.find((o) => label.test(o));
  if (!pick) throw new Error(`下ごしらえ：写真の利用同意の選択肢に ${label} がありません（${options.join('・')}）`);
  await select.selectOption({ label: pick });
  await adminPage.getByRole('button', { name: '確認へ進む' }).click();
  await adminPage.getByRole('button', { name: '更新する' }).click();
  await expect(adminPage.getByRole('button', { name: '更新する' })).toHaveCount(0);
}

// ---- 画面：配布物 ----

export interface HandoutInput {
  type?: string;
  title: string;
  month?: string;
  target?: string;
  file: { name: string; mimeType: string; buffer: Buffer };
}

/** 配布物管理画面を開く（チャット画面（職員）の「園からの配布物」から。図/画面遷移図「チャットツール」(5)） */
export async function staffHandouts(page: Page) {
  await staffChat(page);
  await page.getByRole('main').getByRole('link', { name: '園からの配布物' }).or(page.getByRole('main').getByRole('button', { name: '園からの配布物' })).first().click();
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
}

/** 掲載の入力（ダイアログ）を開いて入れる。押す前で止める（返すのはダイアログ）。file が無ければファイルを選ばない */
export async function fillHandout(page: Page, h: Omit<HandoutInput, 'file'> & { file?: HandoutInput['file'] }) {
  await page.getByRole('main').getByRole('button', { name: '配布物を掲載する' }).click();
  const d = page.getByRole('dialog').last();
  await expect(d).toBeVisible();
  if (h.type) await d.getByRole('combobox', { name: /^種類/ }).selectOption({ label: h.type });
  await d.getByRole('group', { name: /^題名/ }).getByRole('textbox').fill(h.title);
  if (h.month !== undefined) await d.getByRole('textbox', { name: /^対象の月/ }).fill(h.month);
  if (h.target) await d.getByRole('combobox', { name: /^対象(\s|$)/ }).selectOption({ label: h.target });
  if (h.file) {
    const chooser = page.waitForEvent('filechooser');
    await d.getByRole('group', { name: /^ファイル/ }).getByRole('button').first().click();
    await (await chooser).setFiles(h.file);
  }
  return d;
}

/** 配布物の題名の数（取り下げていないもの） */
export function handoutCount(title: string): number {
  return sqlCount('SELECT COUNT(*) AS n FROM t_handout WHERE title = ? AND is_deleted = 0', title);
}

/** 配布物を開いたときに読み込まれたもの（別の窓か、同じ画面の中か）。開けたかを返す */
export async function openedHandout(page: Page, open: () => Promise<void>): Promise<{ url: string | null; ok: boolean }> {
  const popup = page.waitForEvent('popup', { timeout: 8_000 }).catch(() => null);
  const resp = page
    .waitForResponse((r) => r.request().method() === 'GET' && /handout/i.test(r.url()) && !/\/api\/handouts(\?|$)/.test(r.url()), { timeout: 8_000 })
    .catch(() => null);
  await open();
  const [p, r] = await Promise.all([popup, resp]);
  if (p) {
    await p.waitForLoadState().catch(() => {});
    const url = p.url();
    await p.close().catch(() => {});
    return { url, ok: !url.startsWith('about:') };
  }
  if (r) return { url: r.url(), ok: r.ok() };
  // 同じ画面の中（ダイアログ）に中身を出す作りなら、その中の画像・文書の要素を見る
  const shown = page.getByRole('dialog').last().locator('img[src], iframe[src], object[data], embed[src]');
  if ((await shown.count()) > 0) return { url: await shown.first().evaluate((el) => el.getAttribute('src') ?? el.getAttribute('data')), ok: true };
  return { url: null, ok: false };
}

/** 「添付」を押してファイルを選べるか（ファイルの選択が開くか）。開いたら選ばずに閉じる */
export async function attachWorks(page: Page, attach: import('@playwright/test').Locator): Promise<boolean> {
  const chooser = page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null);
  await attach.click();
  const c = await chooser;
  if (!c) return (await page.locator('input[type="file"]').count()) > 0;
  await c.setFiles([]).catch(() => {});
  return true;
}

/** 配布物を掲載する（掲載の入力に入れて「掲載する」を押し、ダイアログが閉じるまで） */
export async function postHandout(page: Page, h: HandoutInput) {
  await staffHandouts(page);
  const d = await fillHandout(page, h);
  await d.getByRole('button', { name: '掲載する', exact: true }).click();
  await expect(d).toBeHidden();
}

/** 配布物一覧画面（保護者）を開く（チャット画面（保護者）の「園からの配布物」から） */
export async function guardianHandouts(page: Page) {
  await guardianChat(page);
  await page.getByRole('main').getByRole('link', { name: '園からの配布物' }).or(page.getByRole('main').getByRole('button', { name: '園からの配布物' })).first().click();
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
}

/** 前の月（YYYY-MM） */
export function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 「YYYY年M月」 */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${y}年${m}月`;
}

// ---- 画面：グループ編成 ----

/** グループ編成画面を開く（チャット画面（職員）の「グループ編成」から） */
export async function staffGroups(page: Page) {
  await staffChat(page);
  await page.getByRole('main').getByRole('link', { name: 'グループ編成' }).or(page.getByRole('main').getByRole('button', { name: 'グループ編成' })).first().click();
  await expect(page.getByRole('main').getByRole('heading', { name: 'グループ編成', level: 1 })).toBeVisible();
}

/** 「＋ グループを作る」の入力に入れる。押す前で止める（返すのはダイアログ） */
export async function fillGroup(page: Page, name: string, members: string[]) {
  await page.getByRole('main').getByRole('button', { name: /グループを作る/ }).click();
  const d = page.getByRole('dialog').last();
  await expect(d).toBeVisible();
  await d.getByRole('textbox', { name: /^グループ名/ }).fill(name);
  for (const m of members) {
    const cb = d.getByRole('checkbox', { name: new RegExp(`^${esc(m)}`) });
    if ((await cb.count()) > 0) await cb.first().check();
  }
  return d;
}

/** グループを作る（作るボタンは「作る」か「保存する」。図/画面詳細図「グループ編成画面」(4-3) 項目1・8） */
export function groupSubmit(dialog: import('@playwright/test').Locator) {
  return dialog.getByRole('button', { name: /^(作る|保存する)$/ });
}

export async function createGroup(page: Page, name: string, members: string[]) {
  await staffGroups(page);
  const d = await fillGroup(page, name, members);
  await groupSubmit(d).click();
  await expect(d).toBeHidden();
}

// ---- 画面：誤送信対応記録 ----

/** 誤送信対応記録画面を開く（サイドナビの「管理（管理者）」の「誤送信対応」から。図/画面遷移図「チャットツール」(5)） */
export async function staffMisdelivery(page: Page) {
  await page.getByRole('navigation').getByRole('link', { name: /誤送信対応/ }).click();
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
}

/**
 * 誤送信の対応の入力に、設計に無い「既読の有無」の選択があるときは選ぶ（既読の有無は、設計ではシステムが入れる。
 * 図/画面詳細図「誤送信対応記録画面（管理者）」(4-4) 項目5。それ自体は 03-031 で確かめる）。選んだら true
 */
export async function answerReadRadioIfAsked(dialog: import('@playwright/test').Locator, read: boolean): Promise<boolean> {
  const radio = dialog.getByRole('radio', { name: read ? /既読が付いていた/ : /既読は付いていなかった/ });
  if ((await radio.count()) === 0) return false;
  await radio.first().check();
  test_note(`誤送信の対応の入力に「既読の有無」の選択があったため「${read ? '既読が付いていた' : '既読は付いていなかった'}」を選んで進めた（設計ではシステムが入れる）`);
  return true;
}

/** 「対応の記録がない取り消し」の行（「対応を記録する」を持つ行） */
export function pendingRows(page: Page) {
  return page.getByRole('main').getByRole('row').filter({ has: page.getByRole('button', { name: /対応を記録/ }) });
}

// ---- 要求の書き換え（入力の上限を画面が止めるときに、サーバの検査を確かめる） ----

/**
 * 次に送る要求（url に当たる最初の1つ）の本文の文字列 from を to に置き換えて送る。
 * 画面が入力欄で上限を止める（それ以上打てない）とき、上限＋1の値がサーバで拒まれるかを確かめるために使う
 */
export async function rewriteNextRequest(page: Page, url: RegExp, from: string, to: string): Promise<{ done: () => boolean }> {
  let rewritten = false;
  await page.route(url, async (route) => {
    const req = route.request();
    const buf = req.postDataBuffer();
    if (rewritten || req.method() === 'GET' || !buf) return route.continue();
    const src = Buffer.from(from, 'utf8');
    const i = buf.indexOf(src);
    if (i < 0) return route.continue();
    rewritten = true;
    const next = Buffer.concat([buf.subarray(0, i), Buffer.from(to, 'utf8'), buf.subarray(i + src.length)]);
    return route.continue({ postData: next });
  });
  return { done: () => rewritten };
}
