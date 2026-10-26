/*
 * シート 01・08 の下ごしらえ（T6）。データはすべてケースの中で作る（README.md「夜中の注意」）。
 *
 *   - 管理者の API のセッションで、園児・招待コード・職員を作る（画面と同じ経路。図/インタフェース一覧「経路の一覧」(1)）
 *   - 保護者は新規登録画面で登録し、職員は職員用トップで初回ログイン（パスワードの変更・規約の同意）まで進める
 *   - 画面で作れない状態（期限切れ・設定の値）は、そのサーバの使い捨てのデータベースを SQL で書き換える
 *     （テスト仕様書「テストデータの準備」(2.1)）
 *
 * 期待する結果はここに書かない（spec に書く）。共有のファイル（harness.ts など）は変えない。
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { ACCOUNTS, expect, passwordOf, serverInfo, type AccountKey } from './harness';

/**
 * ケースで作るアカウントのパスワード。文字はシートにも spec にも書かない（テスト仕様書の決まり「パスワードの文字はシートにも spec にも書かない」）。
 * 印（ケースNo など）から毎回同じ値を作るので、同じ回の中で、登録したあとにログインし直せる。
 * 英小文字と数字だけ（基本設計書「パスワードの要件」(6-3)：8文字以上、文字種の組み合わせは求めない）。長さの境界を試すときは length を渡す
 */
export function casePassword(tag: string, length = 16): string {
  let out = '';
  for (let i = 0; out.length < length; i++) out += createHash('sha256').update(`acceptance:${tag}:${i}`).digest('hex');
  return out.slice(0, length);
}

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

/** いまのサーバのデータベースに SQL を流す（書き換え）。画面で作れない状態だけに使う */
export function sqlRun(statement: string, ...params: (string | number | null)[]): void {
  const info = serverInfo();
  if (!info) throw new Error('サーバがまだ立っていません');
  const db = new DatabaseSync(info.dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(statement).run(...params);
  } finally {
    db.close();
  }
}

/** いまのサーバのデータベースを読む（確かめに使う） */
export function sqlAll(statement: string, ...params: (string | number | null)[]): Record<string, unknown>[] {
  const info = serverInfo();
  if (!info) throw new Error('サーバがまだ立っていません');
  const db = new DatabaseSync(info.dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(statement).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

// ---- API のセッション ----

/**
 * API を呼ぶ文脈。既定で同じサイトの Origin を付ける（CSRF の検証で止まらないように。基本設計書「CSRF対策の方式」(6-3)）。
 * withOrigin: false で付けない（CSRF のケース）
 */
export async function newApi(pw: RequestFactory, options: { withOrigin?: boolean; headers?: Record<string, string> } = {}): Promise<APIRequestContext> {
  const base = origin();
  const headers: Record<string, string> = { ...(options.withOrigin === false ? {} : { Origin: base }), ...(options.headers ?? {}) };
  return pw.request.newContext({ baseURL: base, extraHTTPHeaders: headers });
}

/** API でログインする。通らなければ止まる */
export async function apiLogin(api: APIRequestContext, email: string, password: string, entrance: 'staff' | 'guardian'): Promise<Record<string, unknown>> {
  const res = await api.post('/api/login', { data: { email, password, entrance } });
  if (res.status() !== 200) throw new Error(`下ごしらえ：${email} で API にログインできません（${res.status()} ${await res.text()}）`);
  return (await res.json()) as Record<string, unknown>;
}

/** デモのアカウントで API にログインした文脈 */
export async function apiAs(pw: RequestFactory, who: AccountKey, options: { withOrigin?: boolean } = {}): Promise<APIRequestContext> {
  const api = await newApi(pw, options);
  const account = ACCOUNTS[who];
  await apiLogin(api, account.email, passwordOf(who), account.entrance);
  return api;
}

/** 管理者（デモの西田）の API の文脈 */
export function adminApi(pw: RequestFactory): Promise<APIRequestContext> {
  return apiAs(pw, 'admin');
}

async function ok<T>(label: string, resP: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await resP;
  if (!res.ok()) throw new Error(`下ごしらえ：${label} に失敗しました（${res.status()} ${await res.text()}）`);
  return (await res.json()) as T;
}

// ---- 園児・招待コード・職員 ----

const classIds = new Map<string, Map<string, number>>();

/** クラス名からクラスID（いまの年度） */
export async function classIdOf(api: APIRequestContext, name: string): Promise<number> {
  const key = serverInfo()?.dbPath ?? '';
  let map = classIds.get(key);
  if (!map) {
    const list = await ok<{ class_id: number; fiscal_year: number; class_name: string }[]>('クラスの一覧', api.get('/api/classes'));
    map = new Map();
    const latest = Math.max(...list.map((c) => c.fiscal_year));
    for (const c of list) if (c.fiscal_year === latest) map.set(c.class_name, c.class_id);
    classIds.set(key, map);
  }
  const id = map.get(name);
  if (id === undefined) throw new Error(`下ごしらえ：クラス「${name}」がありません`);
  return id;
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

/** 園児を登録する（園児情報入力画面と同じ経路 POST /api/children） */
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
      photo_consent_level: '2',
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

/** 規約のいまの版（GET /api/terms） */
export async function currentTermsVersion(api: APIRequestContext): Promise<string> {
  const res = await api.get('/api/terms');
  const body = (await res.json()) as unknown;
  const text = JSON.stringify(body);
  const m = /"terms_version"\s*:\s*"([^"]+)"/.exec(text);
  if (!m) throw new Error('下ごしらえ：規約の版を読めません');
  return m[1];
}

// ---- 画面の操作 ----

/** 別の窓（2つ目のブラウザ）。ハーネスの文脈と同じく、127.0.0.1 の外へは出さない */
export async function newWindow(browser: Browser, options: { viewport?: { width: number; height: number }; storageState?: Parameters<Browser['newContext']>[0] extends infer O ? O extends { storageState?: infer S } ? S : never : never } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: origin(),
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: options.viewport ?? { width: 1024, height: 768 },
    serviceWorkers: 'block',
    ...(options.storageState ? { storageState: options.storageState } : {}),
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
  /** 既定は「母」。null なら選ばない */
  relationship?: string | null;
  phone?: string;
}

/** 新規登録画面で、コードを確かめ、規約に同意し、アカウント情報を入れたところまで進める（押さない） */
export async function fillSignup(page: Page, spec: GuardianSpec): Promise<void> {
  await page.goto('/signup');
  await page.getByRole('textbox', { name: /招待コード/ }).fill(spec.code);
  await page.getByRole('button', { name: 'コードを確認する' }).click();
  await expect(page.getByRole('checkbox', { name: /利用規約に同意/ })).toBeEnabled();
  await checkAllConsents(page);
  await page.getByLabel(/保護者の氏名/).fill(spec.name);
  if (spec.relationship !== null) await page.getByLabel(/続柄/).selectOption({ label: spec.relationship ?? '母' });
  await page.getByLabel(/メールアドレス/).fill(spec.email);
  await page.getByRole('textbox', { name: /^パスワード\s*必須$/ }).fill(spec.password);
  await page.getByLabel(/パスワード（確認）/).fill(spec.password);
  const phone = page.getByLabel(/連絡先1/);
  if (await phone.count()) await phone.first().fill(spec.phone ?? '090-0000-0000');
}

/** 新規登録画面で登録を終え、保護者ホームが開くまで待つ */
export async function signupScreen(page: Page, spec: GuardianSpec): Promise<void> {
  await fillSignup(page, spec);
  await page.getByRole('button', { name: '登録する' }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/guardian'), { timeout: 15_000 });
}

export interface MadeGuardian {
  childId: string;
  childName: string;
  email: string;
  password: string;
  code: string;
}

/**
 * 前提G：管理者が園児を登録して招待コードを発行し、保護者が新規登録画面で登録する。
 * 終わったとき、page は保護者でログインしている（保護者ホーム）
 */
export async function makeGuardian(page: Page, api: APIRequestContext, caseNo: string, options: { className?: string; birth?: string; childSuffix?: string } = {}): Promise<MadeGuardian> {
  const digits = caseNo.replace(/[^0-9I]/g, '');
  const childId = `C${digits}${options.childSuffix ?? ''}`;
  const childName = `受入 ${caseNo}${options.childSuffix ?? ''}`;
  await createChild(api, { id: childId, name: childName, className: options.className, birth: options.birth });
  const code = await issueCode(api, childId);
  const email = `g${digits.toLowerCase()}@example.jp`;
  const password = casePassword(`guardian:${caseNo}${options.childSuffix ?? ''}`);
  await signupScreen(page, { code, name: `受入 保護者 ${caseNo}`, email, password });
  return { childId, childName, email, password, code };
}

export interface MadeStaff {
  staffId: string;
  name: string;
  email: string;
  tempPassword: string;
  password: string;
}

/** 前提S：管理者が職員を発行する（一時パスワードを控える） */
export async function makeStaffIssued(api: APIRequestContext, caseNo: string, options: { className?: string | null; suffix?: string } = {}): Promise<MadeStaff> {
  const digits = caseNo.replace(/[^0-9I]/g, '') + (options.suffix ?? '');
  const spec: StaffSpec = { id: `S${digits}`, name: `受入 職員 ${caseNo}${options.suffix ?? ''}`, email: `s${digits.toLowerCase()}@hoiku.example.jp`, className: options.className };
  const tempPassword = await issueStaff(api, spec);
  return { staffId: spec.id, name: spec.name, email: spec.email, tempPassword, password: casePassword(`staff:${caseNo}${options.suffix ?? ''}`) };
}

/** 職員の初回ログイン：一時パスワードでログイン → パスワードを変える → 規約に同意 → 職員ダッシュボード */
export async function staffFirstLogin(page: Page, staff: MadeStaff): Promise<void> {
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

/** 前提S+：発行して、初回ログインまで済ませる。終わったとき、page は職員ダッシュボード */
export async function makeStaff(page: Page, api: APIRequestContext, caseNo: string, options: { className?: string | null; suffix?: string } = {}): Promise<MadeStaff> {
  const staff = await makeStaffIssued(api, caseNo, options);
  await staffFirstLogin(page, staff);
  return staff;
}

/** 管理者の API で、保護者アカウントの一覧（ログインIDで探す） */
export async function guardianAccountsByEmail(api: APIRequestContext, email: string): Promise<{ account: { account_id: number; email: string; status: string } }[]> {
  const list = await ok<{ account: { account_id: number; email: string; status: string } }[]>('保護者アカウントの一覧', api.get('/api/admin/guardian-accounts'));
  return list.filter((g) => g.account.email.toLowerCase() === email.toLowerCase());
}

/** 写真に使う PNG（いまの画面を撮ったもの。外のファイルを持ち込まない） */
export async function pngOf(page: Page): Promise<Buffer> {
  return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 64, height: 64 } });
}

/** 日本時間の「YYYY/MM/DD」と「M月D日」 */
export function jstParts(ymd: string): { slash: string; md: string } {
  const [y, m, d] = ymd.split('-');
  return { slash: `${y}/${m}/${d}`, md: `${Number(m)}月${Number(d)}日` };
}
