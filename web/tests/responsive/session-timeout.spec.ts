import { test, expect, type Page } from '@playwright/test';

/*
 * 自動ログアウトの予告と「続ける」を、本物のブラウザ（WebKit・Chromium）で確かめる（GitHub Issue #210）
 * 典拠：基本設計書.md「ログイン」(4-3)、WCAG 2.2 達成基準 2.2.1 タイミング調整可能（レベル A）
 *
 * vitest（tests/sessionTimeoutDialog.test.tsx）は jsdom のフォーカスで確かめている。ここでは実際のブラウザで、
 * 書きかけの日誌の本文から予告の窓へフォーカスが移り、「続ける」で本文へ戻り、書きかけが残ることを見る。
 *
 * ハーネス（harness.tsx）はモックで動く。期限はモック（src/api/mock.ts の sessionStatus）が決め、
 * 画面を開いたときの読み込み（16:00）を最後の操作として、16:30 に切れる。
 * 時計は page.clock.setFixedTime で止め（タイマーは本物のまま動く）、予告の部品が期限を尋ねるきっかけは、
 * タブを前に戻したとき（visibilitychange）を使う。部品はそのとき待たずに尋ねる。
 */
const OPENED = new Date('2026-09-01T16:00:00+09:00');
const BEFORE_DEADLINE = new Date('2026-09-01T16:28:30+09:00');

async function ready(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-review-ready', 'true');
  await expect(page.getByText('読み込んでいます…', { exact: true })).toHaveCount(0);
}

test('[staff] session-timeout — 切れる2分前に予告し、「続ける」で書きかけの本文へ戻る', async ({ page, hasTouch }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    runtimeErrors.push(`レビュー中に HTTP API が呼ばれました: ${route.request().url()}`);
    await route.abort();
  });

  await page.clock.setFixedTime(OPENED);
  await page.goto('/tests/responsive/harness.html?scene=diary-new');
  await ready(page);

  const body = page.getByRole('textbox', { name: /^本文/ });
  await body.fill('午前中は園庭で遊びました。砂場で友達と道を作り、');
  await body.focus();

  // 切れる 90 秒前。タブを前に戻したことにして、期限を尋ねさせる
  await page.clock.setFixedTime(BEFORE_DEADLINE);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  const dialog = page.getByRole('alertdialog', { name: 'まもなくログアウトします' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('16:30 ごろに自動でログアウトします');
  const keep = dialog.getByRole('button', { name: '続ける' });
  await expect(keep).toBeFocused();

  // Tab・Shift+Tab で窓の外へ出ない
  await page.keyboard.press('Tab');
  await expect(keep).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(keep).toBeFocused();

  // 窓は画面の幅に収まり、「続ける」は押しやすい大きさ（44 × 44 CSS px 以上）
  const viewport = page.viewportSize()!;
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  const target = (await keep.boundingBox())!;
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);

  if (hasTouch) await keep.tap();
  else await keep.click();
  await expect(dialog).toHaveCount(0);
  await expect(body).toBeFocused();
  await expect(body).toHaveValue('午前中は園庭で遊びました。砂場で友達と道を作り、');

  expect(runtimeErrors, 'ブラウザ実行エラー').toEqual([]);
});
