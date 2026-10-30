/*
 * 公開先（デプロイ環境）のスモークテスト。読むだけ（playwright.deployed.config.ts の頭の決まり）。
 *
 * - ログインを失敗させない（公開先の送信元ごと・アカウントごとの失敗の数に乗せない。server/attempts.go）
 * - 保存・申請・既読を付ける操作をしない。チャットは開くと既読が付くことがあるので開かない
 * - ログアウトしない（その職員の日誌の編集ロックを外すため。デモの「他の職員が編集中」は村田 真一が持つ）
 *
 * アカウントは server/seed.sql のデモアカウント（パスワードは公開のデモ用）。seed の名前を変えたら、ここも変える。
 * 公開先の DB が古い seed のまま残ると、ここが落ちる（2026-10-30 の件。PR #332）。
 */
import { test, expect, type Page } from '@playwright/test';

type Entrance = 'staff' | 'guardian';
/** ログインのあとの着地 */
type Landing =
  | { path: string; heading: string }
  | { stopped: string };

interface DemoAccount {
  email: string;
  password: string;
  entrance: Entrance;
  landing: Landing;
  note: string;
}

const DASHBOARD = { path: '/staff', heading: 'ダッシュボード' };
const GUARDIAN_HOME = { path: '/guardian', heading: 'こんにちは' };

const ACCOUNTS: DemoAccount[] = [
  { email: 'nishida@hoiku.example.jp', password: 'pass1234', entrance: 'staff', landing: DASHBOARD, note: '管理者' },
  { email: 'endo@hoiku.example.jp', password: 'pass1234', entrance: 'staff', landing: DASHBOARD, note: '管理者' },
  { email: 'suzuki@hoiku.example.jp', password: 'pass1234', entrance: 'staff', landing: DASHBOARD, note: '職員' },
  { email: 'murata@hoiku.example.jp', password: 'temp0901', entrance: 'staff', landing: { path: '/password-change', heading: 'パスワードの変更' }, note: '一時パスワード' },
  { email: 'kubota@hoiku.example.jp', password: 'pass1234', entrance: 'staff', landing: DASHBOARD, note: '職員' },
  { email: 'nishida.t@example.jp', password: 'pass1234', entrance: 'guardian', landing: GUARDIAN_HOME, note: '保護者' },
  { email: 'endo.n@example.jp', password: 'pass1234', entrance: 'guardian', landing: { path: '/terms-agree', heading: '利用規約への同意' }, note: '規約の改定後に未同意' },
  { email: 'suzuki.h@example.jp', password: 'pass1234', entrance: 'guardian', landing: { stopped: 'このアカウントは停止されています' }, note: '停止中の保護者' },
  { email: 'murata.s@example.jp', password: 'pass1234', entrance: 'guardian', landing: GUARDIAN_HOME, note: '保護者' },
  { email: 'kubota.k@example.jp', password: 'pass1234', entrance: 'guardian', landing: GUARDIAN_HOME, note: '保護者' },
];

/** 画面の中の例外と、API の 5xx を集める。テストの終わりに空であることを確かめる */
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`画面の例外：${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  return problems;
}

async function login(page: Page, a: DemoAccount): Promise<void> {
  await page.goto(a.entrance === 'staff' ? '/staff-top' : '/');
  await page.getByLabel('ログインID', { exact: true }).fill(a.email);
  await page.getByLabel('パスワード', { exact: true }).fill(a.password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
}

test.describe('公開の守り', () => {
  test('画面は毎回確かめ、/assets/ は持たせる。無いファイルは 404。未ログインの API は 401', async ({ request }) => {
    const top = await request.get('/');
    expect(top.status()).toBe(200);
    expect(top.headers()['cache-control'] ?? '').toContain('no-cache');

    const asset = (await top.text()).match(/\/assets\/[^"']+\.js/)?.[0];
    expect(asset, 'index.html が /assets/ の JavaScript を読んでいない').toBeTruthy();
    const js = await request.get(asset!);
    expect(js.status()).toBe(200);
    expect(js.headers()['cache-control'] ?? '').toContain('immutable');
    expect((await request.get('/assets/no-such-file-0000.js')).status()).toBe(404);

    expect((await request.get('/api/terms')).status()).toBe(200);
    expect((await request.get('/api/me')).status()).toBe(401);
  });
});

test.describe('デモアカウントでログインできる（全員）', () => {
  for (const a of ACCOUNTS) {
    test(`${a.email}（${a.note}）`, async ({ page }) => {
      const problems = watchProblems(page);
      await login(page, a);
      if ('stopped' in a.landing) {
        // 停止中の保護者は、パスワードが合っていても入れず、入口に残る（失敗の数には乗らない。server/api_auth.go）
        await expect(page.getByRole('alert').filter({ hasText: a.landing.stopped })).toBeVisible();
        expect(new URL(page.url()).pathname).toBe('/');
      } else {
        await page.waitForURL((url) => url.pathname === (a.landing as { path: string }).path);
        await expect(page.getByRole('heading', { level: 1, name: a.landing.heading })).toBeVisible();
      }
      expect(problems).toEqual([]);
    });
  }
});

test.describe('主な画面が開く（読むだけ）', () => {
  const admin = ACCOUNTS[0];
  const guardian = ACCOUNTS[5];

  test('管理者：日誌・連絡帳・午睡・成長・園児・承認待ち・設定', async ({ page }) => {
    const problems = watchProblems(page);
    await login(page, admin);
    await page.waitForURL((url) => url.pathname === '/staff');
    for (const path of ['/staff/diary', '/staff/contact', '/staff/nap', '/staff/growth', '/staff/children', '/staff/admin/approval', '/staff/admin/settings']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first(), `${path} の見出し`).toBeVisible();
      await expect(page.getByText('読み込んでいます')).toHaveCount(0);
    }
    expect(problems).toEqual([]);
  });

  test('保護者：配布物・日誌', async ({ page }) => {
    const problems = watchProblems(page);
    await login(page, guardian);
    await page.waitForURL((url) => url.pathname === '/guardian');
    for (const path of ['/guardian/handouts', '/guardian/diaries']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first(), `${path} の見出し`).toBeVisible();
      await expect(page.getByText('読み込んでいます')).toHaveCount(0);
    }
    expect(problems).toEqual([]);
  });
});
