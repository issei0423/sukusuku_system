/*
 * シート 02 連絡帳の手助け。02-contact.spec.ts だけが使う。
 *
 *   - 2つ目・3つ目の窓（保護者・管理者）を browser.newContext() で開く。harness.ts の既定の窓と同じく、127.0.0.1 以外への要求は止める
 *   - 前提を作る口：園児の登録、写真の利用同意の切り替え、保護者へ出す項目の切り替え（設定画面に連絡帳の区画が無いため API で）
 *   - 画面の中から同じ送信元で API を呼ぶ口（fetch。Cookie と Origin はブラウザが付ける）
 *
 * 期待する結果はここに書かない（spec に書く）。ここは操作と前提だけ。
 */
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { expect, login, PHONE, TABLET, type AccountKey } from './harness';
import { HARNESS_ERROR_MARK, HOST } from './paths.mjs';

// ---- 窓 ----

const opened: { context: BrowserContext; blocked: string[] }[] = [];

/** 新しい窓（別のブラウザの文脈）を開き、そのアカウントでログインする。職員はタブレット、保護者はスマートフォンの大きさ */
export async function openWindow(browser: Browser, testInfo: TestInfo, who: AccountKey, device?: 'tablet' | 'phone'): Promise<Page> {
  const phone = device ? device === 'phone' : who.startsWith('guardian');
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
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

// ---- API（画面と同じ送信元から） ----

export interface ApiResult {
  status: number;
  json: unknown;
  text: string;
}

/** ログイン済みの画面から、同じ送信元で API を呼ぶ */
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

/** 写真を multipart で送る（詳細設計書「`POST /api/contact/photos`（写真）」(4-4 (2)) の項目） */
export async function postPhoto(page: Page, fields: Record<string, string>, file: { name: string; type: string; base64: string }): Promise<ApiResult> {
  return page.evaluate(
    async ({ fields, file }) => {
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: file.type }), file.name);
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      const res = await fetch('/api/contact/photos', { method: 'POST', body: form, credentials: 'same-origin' });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        // JSON でない応答
      }
      return { status: res.status, json, text };
    },
    { fields, file },
  );
}

/**
 * 保護者へ出すきょうのようすの項目（contact.show_items）を変える。管理者の窓で呼ぶ。
 * 設定画面に連絡帳の区画が無いため（2026-10-26 に画面で確かめた）、設定の経路（詳細設計書「`POST /api/settings`」(4-10 (2))）で変える
 */
export async function setShowItems(adminPage: Page, items: string[]): Promise<{ ok: boolean; text: string }> {
  const view = await api(adminPage, 'GET', '/api/settings');
  expect(view.status, `設定を読めません: ${view.text}`).toBe(200);
  const readAt = (view.json as { read_at: string }).read_at;
  const res = await api(adminPage, 'POST', '/api/settings', { changes: { 'contact.show_items': items.join(',') }, read_at: readAt });
  return { ok: res.status === 200, text: res.text };
}

/** 保護者へ出す項目を変えられないときの未実施の理由 */
export const SHOW_ITEMS_UNAVAILABLE =
  '前提を作れない：設定画面に連絡帳の区画が無く、設定の経路（POST /api/settings）も contact.show_items を「この設定は画面から変えられません。」で断る（詳細設計書「設定ごとの検査」(4-10 (3)) では連絡帳の区画で変えられる）';

/** 既定の保護者へ出す項目（seed.sql の m_setting） */
export const ALL_SHOW_ITEMS = ['nap', 'meal', 'toilet', 'temperature', 'comment', 'photo', 'class'];

// ---- 園児の前提（管理者の画面で作る） ----

export type ConsentLabel = '園内記録のみ' | '自児保護者へ共有まで' | '他保護者にも見える場まで';

/** 園児情報の編集で、写真の利用同意を変える（管理者の窓で呼ぶ） */
export async function setConsent(adminPage: Page, childId: string, consent: ConsentLabel) {
  await adminPage.goto(`/staff/children/${childId}/edit`);
  await adminPage.getByRole('combobox', { name: '写真の利用同意 必須' }).selectOption({ label: consent });
  await adminPage.getByRole('button', { name: '確認へ進む' }).click();
  await expect(adminPage.getByRole('heading', { name: 'この内容で更新します' })).toBeVisible();
  await adminPage.getByRole('button', { name: '更新する' }).click();
  await expect(adminPage.getByRole('heading', { name: '園児', exact: true })).toBeVisible();
}

/** 【葵】の前提の園児。登録したら園児IDを返す。すでにいればその園児IDを返す */
export const KENSA = { name: '検査 葵', kana: 'けんさ あおい', nickname: 'あおいちゃん' } as const;

export async function ensureKensaAoi(adminPage: Page): Promise<string> {
  await adminPage.goto('/staff/children');
  // 一覧を読み終えてから数える（読み込み中に数えると、いるのに登録し直してしまう）
  await expect(adminPage.getByRole('row', { name: /^西田 太郎/ })).toBeVisible();
  const row = adminPage.getByRole('row', { name: new RegExp(KENSA.name) });
  if ((await row.count()) > 0) {
    const href = await row.getByRole('link', { name: '編集' }).getAttribute('href');
    return /children\/([^/]+)\/edit/.exec(href ?? '')?.[1] ?? '';
  }
  await adminPage.getByRole('link', { name: '新規登録' }).click();
  const id = await adminPage.getByRole('textbox', { name: '園児ID 必須' }).inputValue();
  await adminPage.getByRole('textbox', { name: '氏名 必須' }).fill(KENSA.name);
  await adminPage.getByRole('textbox', { name: 'よみ 必須' }).fill(KENSA.kana);
  await adminPage.getByRole('group', { name: '呼び名' }).getByRole('textbox').fill(KENSA.nickname);
  await adminPage.getByRole('textbox', { name: '生年月日 必須' }).fill('2025-05-01');
  await adminPage.getByRole('combobox', { name: 'クラス 必須' }).selectOption({ label: 'さくら組' });
  await adminPage.getByRole('combobox', { name: '写真の利用同意 必須' }).selectOption({ label: '他保護者にも見える場まで' });
  await adminPage.getByRole('button', { name: '確認へ進む' }).click();
  await adminPage.getByRole('button', { name: '登録する' }).click();
  await expect(adminPage.getByRole('row', { name: new RegExp(KENSA.name) })).toBeVisible();
  return id;
}

// ---- 午睡 ----

/** 【実施中】さくら組の午睡チェックが実施中でなければ開始する（職員の窓で呼ぶ）。開始できなければ false */
export async function ensureNapRunning(staffPage: Page): Promise<boolean> {
  await staffPage.goto('/staff/nap');
  await expect(staffPage.getByRole('heading', { name: '午睡チェック', level: 1 })).toBeVisible();
  const end = staffPage.getByRole('button', { name: '午睡チェックを終了' });
  if (await end.isVisible().catch(() => false)) return true;
  const start = staffPage.getByRole('button', { name: /午睡チェックを開始/ });
  if (!(await start.isVisible().catch(() => false))) return false;
  await start.click();
  return end.isVisible({ timeout: 10_000 }).catch(() => false);
}

// ---- 写真 ----

/** 人の写っていない絵を作る（色の帯）。JPEG か PNG */
export async function makePicture(page: Page, type: 'jpeg' | 'png'): Promise<Buffer> {
  const p = await page.context().newPage();
  await p.setViewportSize({ width: 480, height: 320 });
  await p.setContent('<div style="width:480px;height:320px;background:linear-gradient(135deg,#8cf,#fc8)"></div>');
  const buf = await p.screenshot({ type, ...(type === 'jpeg' ? { quality: 80 } : {}) });
  await p.close();
  return buf;
}

/** 1×1 の GIF（形式の外を試す） */
export const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

/** 連絡帳（クラス）画面の「写真を送る」を開き、写真を選び、写っている子の窓を開くところまで */
export async function openPhotoPicker(staffPage: Page, picture: Buffer, name = 'plain.jpg', mimeType = 'image/jpeg') {
  await staffPage.getByRole('button', { name: '写真を送る' }).click();
  const dialog = staffPage.getByRole('dialog', { name: '写真を送る' });
  await dialog.locator('input[type=file]').setInputFiles({ name, mimeType, buffer: picture });
  await expect(dialog.getByRole('img', { name: '選んだ写真' })).toBeVisible();
  await dialog.getByRole('button', { name: '写っている子を選ぶ' }).click();
  const picker = staffPage.getByRole('dialog', { name: '写っている子を選ぶ' });
  await expect(picker).toBeVisible();
  return { dialog, picker };
}

// ---- 数を読む ----

/** 職員ダッシュボードの「届ける」の行の数（「ありません」は 0）。label は行の見出し、kind は「未確認」「更新」など（無ければ最初の数） */
export async function dashboardCount(staffPage: Page, label: string, kind?: string): Promise<number> {
  await staffPage.goto('/staff');
  const row = staffPage.getByRole('row', { name: new RegExp(`^${label}`) });
  await expect(row).toBeVisible();
  const text = (await row.getByRole('cell').nth(1).innerText()).replace(/\s+/g, ' ');
  if (text.includes('ありません')) return 0;
  const m = kind ? new RegExp(`${kind}\\s*(\\d+)`).exec(text) : /(\d+)/.exec(text);
  return m ? Number(m[1]) : 0;
}

/** JST の前の日（YYYY-MM-DD） */
export function jstYesterday(today: string): string {
  const d = new Date(`${today}T12:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() - 1);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(d);
}
