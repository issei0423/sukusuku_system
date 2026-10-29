/*
 * シート 04 午睡チェックの手助け（04-nap.spec.ts だけが使う）。
 *
 * - 画面の操作：午睡チェック画面を開く・実施を始め直す・園児の行で選ぶ・体温を入れる
 * - データベース：確かめに使う SQL（読むだけ）と、シートの【SQL】の書き換え（W1・W2）・【時間帯】の設定
 *   （設定画面に午睡の値の欄が無く、設定の API も午睡のキーを受けないため。sheet-04.md「前提の記号」）
 *
 * 期待する結果は設計書から書く。部品は、設計書の表示名で探す。表示名が設計書と違うものは、
 * ケースの中で設計書の名前でも確かめ（違えば NG）、手助けの中では両方の名前で探して、ほかのケースを止めない。
 */
import { DatabaseSync } from 'node:sqlite';
import type { Browser, BrowserContext, Locator, Page, Response } from '@playwright/test';
import { ACCOUNTS, PHONE, TABLET, expect, login, serverInfo, type AccountKey } from './harness';

/** 2分以上待つケースは、ACCEPTANCE_LONG=1 のときだけ回す（試しの回では未実施にする） */
export const LONG = process.env.ACCEPTANCE_LONG === '1';
export const LONG_REASON = '2分以上待つケースのため、この回では回していない（全体の回で ACCEPTANCE_LONG=1 を付けて回す）';

/** 【次の版】で、画面に機能が無かったときの未実施の理由 */
export function notImplemented(what: string): string {
  return `実装対象の外（詳細設計書「午睡チェック画面」(2-4) の (5) で次の版。画面に機能が無い：${what}）`;
}

// ---- データベース ----

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

/** 書き換え（シートの【SQL】・【時間帯】の印のケースだけで使う） */
export function sqlRun(query: string, ...params: (string | number | null)[]): number {
  const db = openDb();
  try {
    return Number(db.prepare(query).run(...params).changes);
  } finally {
    db.close();
  }
}

/** 設定マスタの値を書き換える（設定画面に午睡の欄が無いため。sheet-04.md【時間帯】） */
export function setSetting(key: string, value: string) {
  const changed = sqlRun('UPDATE m_setting SET setting_value = ? WHERE setting_key = ?', value, key);
  if (changed !== 1) throw new Error(`[acceptance:harness] 設定 ${key} を書き換えられませんでした`);
}

export function childId(name: string): string {
  const row = sqlOne<{ child_id: string }>('SELECT child_id FROM m_child WHERE child_name = ? AND is_deleted = 0', name);
  if (!row) throw new Error(`[acceptance:harness] 園児 ${name} がデータベースにありません`);
  return row.child_id;
}

export function staffId(name: string): string {
  const row = sqlOne<{ staff_id: string }>('SELECT staff_id FROM m_staff WHERE staff_name = ?', name);
  if (!row) throw new Error(`[acceptance:harness] 職員 ${name} がデータベースにありません`);
  return row.staff_id;
}

/** そのクラスの、いちばん新しい実施（終わっていないもの） */
export function openSession(className: string) {
  return sqlOne<{ nap_session_id: number; session_date: string; started_staff_id: string; started_at: string; ended_at: string | null }>(
    `SELECT s.nap_session_id, s.session_date, s.started_staff_id, s.started_at, s.ended_at
       FROM t_nap_session s JOIN m_class c ON c.class_id = s.class_id
      WHERE c.class_name = ? AND c.fiscal_year = (SELECT MAX(fiscal_year) FROM m_class) AND s.ended_at IS NULL
      ORDER BY s.nap_session_id DESC LIMIT 1`,
    className,
  );
}

export function sessionsOf(className: string, date: string) {
  return sqlAll<{ nap_session_id: number; started_staff_id: string; started_at: string; ended_staff_id: string | null; ended_at: string | null; is_auto_closed: number }>(
    `SELECT s.nap_session_id, s.started_staff_id, s.started_at, s.ended_staff_id, s.ended_at, s.is_auto_closed
       FROM t_nap_session s JOIN m_class c ON c.class_id = s.class_id
      WHERE c.class_name = ? AND c.fiscal_year = (SELECT MAX(fiscal_year) FROM m_class) AND s.session_date = ?
      ORDER BY s.nap_session_id`,
    className,
    date,
  );
}

// ---- 時刻（サーバも JST で時刻を打つ） ----

const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
/** JST の「時:分」（2桁ずつ） */
export function jstHM(d = new Date()): string {
  return hm.format(d);
}
/** いまから見て、許す「時:分」（いまと、1分前と1分後） */
export function hmNear(d = new Date()): string[] {
  return [-60_000, 0, 60_000].map((ms) => jstHM(new Date(d.getTime() + ms)));
}
/** 「09:05」と「9:05」の両方に当たる正規表現の部分 */
export function hmPattern(hhmm: string): string {
  const [h, m] = hhmm.split(':');
  return `0?${Number(h)}:${m}`;
}
export function anyHm(list: string[]): RegExp {
  return new RegExp(`(${list.map(hmPattern).join('|')})`);
}
/** 分を足した JST の「時:分」 */
export function addMinutesHM(d: Date, minutes: number): string {
  return jstHM(new Date(d.getTime() + minutes * 60_000));
}
/** JST の「YYYY-MM-DDTHH:MM:SS」（データベースの時刻の書き方。書く前に読んで同じ形か確かめる） */
export function jstIso(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d).replace(' ', 'T');
}
export function jstMinutesOfDay(d = new Date()): number {
  const [h, m] = jstHM(d).split(':').map(Number);
  return h * 60 + m;
}

// ---- 窓 ----

/** 2つ目の窓（ブラウザの文脈）。ハーネスと同じく、127.0.0.1 以外への要求は止める */
export async function newWindow(browser: Browser, kind: 'staff' | 'guardian' = 'staff', extra: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const info = serverInfo();
  if (!info) throw new Error('[acceptance:harness] サーバが立っていません');
  const context = await browser.newContext({
    baseURL: info.baseURL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: kind === 'staff' ? TABLET : PHONE,
    serviceWorkers: 'block',
    permissions: [],
    ...extra,
  });
  await context.route((url) => url.hostname !== '127.0.0.1' && !['data:', 'blob:', 'about:'].includes(url.protocol), (route) => route.abort('blockedbyclient'));
  const page = await context.newPage();
  return { context, page };
}

export async function loginIn(browser: Browser, who: AccountKey, extra: Parameters<Browser['newContext']>[0] = {}) {
  const kind = ACCOUNTS[who].entrance;
  const w = await newWindow(browser, kind, extra);
  await login(w.page, who);
  return w;
}

/** 【知らせ止め】その窓の知らせ（GET /api/events）を止める。相手の操作が知らせで画面に出る前に押すため */
export async function stopEvents(page: Page) {
  await page.route('**/api/events**', (route) => route.abort('blockedbyclient'));
}

/** 窓に、音を出す口（HTMLMediaElement.play・AudioContext）が呼ばれた数を数える仕掛けを入れる（画面を開く前に呼ぶ） */
export async function countSounds(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __sounds: number };
    w.__sounds = 0;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      w.__sounds += 1;
      return play.call(this).catch(() => undefined);
    };
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (Ctx) {
      const start = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (this: OscillatorNode, ...args: [number?]) {
        w.__sounds += 1;
        return start.apply(this, args);
      };
      const bufStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...args: [number?, number?, number?]) {
        w.__sounds += 1;
        return bufStart.apply(this, args);
      };
    }
  });
}
export async function soundCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __sounds?: number }).__sounds ?? 0);
}

// ---- 午睡チェック画面 ----

export const napMain = (page: Page) => page.getByRole('main');
export const startButton = (page: Page) => page.getByRole('button', { name: '午睡チェックを開始する' });
export const endButton = (page: Page) => page.getByRole('button', { name: '午睡チェックを終了' });
export const classSelect = (page: Page) => napMain(page).getByRole('combobox', { name: 'クラス' });

/** サイドナビの「午睡チェック」から午睡チェック画面を開き、開始か終了のボタンが出るまで待つ */
export async function openNap(page: Page) {
  await page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '午睡チェック', exact: true }).click();
  await expect(page.getByRole('heading', { name: '午睡チェック', level: 1 })).toBeVisible();
  await expect(startButton(page).or(endButton(page))).toBeVisible();
}

export async function selectedClass(page: Page): Promise<string> {
  return ((await classSelect(page).locator('option:checked').textContent()) ?? '').trim();
}

/** 実施中なら終える（確かめが出たら「このまま終了する」）。開始のボタンが出るまで待つ */
export async function endIfRunning(page: Page) {
  if (await endButton(page).isVisible()) {
    await endButton(page).click();
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', { name: /このまま終了/ });
    await expect(confirm.or(startButton(page))).toBeVisible();
    if (await confirm.isVisible()) await confirm.click();
  }
  await expect(startButton(page)).toBeVisible();
}

/** クラスを選ぶ。選べない（実施中で止まっている）ときは、その実施を終えてから選ぶ */
export async function chooseClass(page: Page, className: string) {
  if ((await selectedClass(page)) === className) return;
  if (await classSelect(page).isDisabled()) await endIfRunning(page);
  await classSelect(page).selectOption({ label: className });
  await expect.poll(() => selectedClass(page)).toBe(className);
  await expect(startButton(page).or(endButton(page))).toBeVisible();
}

/**
 * 【実施中（クラス・職員）】そのクラスの実施を始め直す（デモの今日の実施が実施中なら終えてから開始する）。
 * 開始の直前の時刻を返す（T0）
 */
export async function freshSession(page: Page, className?: string): Promise<Date> {
  await openNap(page);
  if (className) await chooseClass(page, className);
  await endIfRunning(page);
  const t0 = new Date();
  await startButton(page).click();
  await expect(endButton(page)).toBeVisible();
  return t0;
}

/** 園児の行（画面では園児ごとの区画） */
export const napRow = (page: Page, child: string) => page.getByRole('region', { name: `${child}の午睡チェック` });

/** 行の上で、体位・呼吸・顔色を選ぶ（ラベルの文字を押す） */
export async function choose(row: Locator, group: '体位' | '呼吸' | '顔色', label: string) {
  await row.getByRole('group', { name: group }).getByText(label, { exact: true }).click();
  await expect(row.getByRole('radio', { name: label, exact: true })).toBeChecked();
}

/** 行の「記録する」（画面の表示名が設計書と違っても探せるように、両方の名前で探す。名前は 04-007 で確かめる） */
export const recordButton = (row: Locator) => row.getByRole('button', { name: /^(記録する|この子を記録)$/ });

/** 体温を入れる。一覧（35〜40℃）にあれば一覧から、無ければ「範囲外の値を入力」から */
export async function enterTemperature(page: Page, row: Locator, child: string, value: string) {
  await row.getByRole('button', { name: new RegExp(`${child}の体温`) }).click();
  const dialog = page.getByRole('dialog', { name: `${child}の体温` });
  await expect(dialog).toBeVisible();
  const [i, f = '0'] = value.split('.');
  const integer = dialog.getByRole('button', { name: `${i}℃`, exact: true });
  if (f.length === 1 && (await integer.count()) > 0) {
    await integer.click();
    await dialog.getByRole('button', { name: `.${f}`, exact: true }).click();
  } else {
    await dialog.getByRole('button', { name: '範囲外の値を入力' }).click();
    await dialog.getByRole('spinbutton').fill(value);
    await dialog.getByRole('button', { name: '設定' }).click();
  }
}

/** ボタンを押し、午睡の経路（/api/nap/…）への書き込みの応答を待つ */
export async function clickAndWaitNap(page: Page, target: Locator, path = '/api/nap/'): Promise<Response> {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(path) && r.request().method() !== 'GET', { timeout: 15_000 }),
    target.click(),
  ]);
  return res;
}

/** 5分ごとの確認を1件記録する（体位・呼吸・顔色・体温を選んで「記録する」）。サーバの応答を返す */
export async function recordCheck(page: Page, child: string, opts: { pos?: string; breath?: string; face?: string; temp?: string } = {}) {
  const row = napRow(page, child);
  await choose(row, '体位', opts.pos ?? '仰向け');
  await choose(row, '呼吸', opts.breath ?? 'あり');
  await choose(row, '顔色', opts.face ?? '通常');
  if (opts.temp) await enterTemperature(page, row, child, opts.temp);
  return clickAndWaitNap(page, recordButton(row));
}

/** 「ねた」を押す */
export async function pressSleep(page: Page, child: string) {
  return clickAndWaitNap(page, page.getByRole('button', { name: `${child}のねた`, exact: true }));
}

/** 「きょうは対象外」→ 理由 */
export async function exclude(page: Page, child: string, reason: '欠席' | '午睡なし') {
  await page.getByRole('button', { name: new RegExp(`^${child}を?きょうは対象外`) }).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`${child}`) });
  return clickAndWaitNap(page, dialog.getByRole('button', { name: reason, exact: true }));
}

/** 上部の「次の確認」の欄（タイマー）。画面の本文の、最初の園児の区画より前の文字 */
export async function headerText(page: Page): Promise<string> {
  const main = napMain(page);
  const all = (await main.innerText()).replace(/\s+/g, ' ');
  const firstRow = await page.getByRole('region').first().innerText().catch(() => '');
  const cut = firstRow ? all.indexOf(firstRow.replace(/\s+/g, ' ').slice(0, 10)) : -1;
  return cut > 0 ? all.slice(0, cut) : all;
}

// ---- 異常時記録画面 ----

export const abnormalForm = (page: Page) => page.getByRole('main');

/** 異常時記録画面で1件記録する（発見時刻は初期値のまま） */
export async function recordAbnormal(page: Page, child: string, situation: string, response: string, notice?: 'した' | 'しない') {
  const main = abnormalForm(page);
  await main.getByRole('combobox', { name: /園児/ }).selectOption({ label: child });
  await main.getByRole('textbox', { name: /発見時の状況/ }).fill(situation);
  await main.getByRole('textbox', { name: /とった対応/ }).fill(response);
  if (notice) await main.getByRole('radiogroup', { name: '保護者への連絡' }).getByText(notice, { exact: true }).click();
  return clickAndWaitNap(page, main.getByRole('button', { name: '記録する', exact: true }));
}

/** 異常時記録画面の「記録の一覧」の、文を含む行 */
export const abnormalRow = (page: Page, text: string) => page.getByRole('main').getByRole('row').filter({ hasText: text });

// ---- 午睡記録検索画面 ----

export async function openSearch(page: Page) {
  await page.goto('/staff/nap');
  await page.getByRole('main').getByRole('link', { name: '記録を検索' }).click();
  await expect(page.getByRole('main').getByRole('button', { name: '絞り込む' })).toBeVisible();
}

export async function searchBy(page: Page, opts: { from?: string; to?: string; className?: string; child?: string }) {
  const main = page.getByRole('main');
  if (opts.from) await main.getByRole('textbox', { name: /期間（開始）|開始/ }).first().fill(opts.from);
  if (opts.to) await main.getByRole('textbox', { name: /期間（終了）|終了/ }).first().fill(opts.to);
  if (opts.className) await main.getByRole('combobox', { name: 'クラス' }).selectOption({ label: opts.className });
  if (opts.child !== undefined) await main.getByRole('searchbox', { name: '園児名' }).fill(opts.child);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/nap/') && r.request().method() === 'GET', { timeout: 15_000 }).catch(() => null),
    main.getByRole('button', { name: '絞り込む' }).click(),
  ]);
}

/** JST の日付（YYYY-MM-DD）を、日数だけずらす */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
