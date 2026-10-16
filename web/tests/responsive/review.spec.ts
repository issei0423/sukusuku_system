import { test, expect, type Page, type Locator } from '@playwright/test';
import { scenarios, REVIEW_TIME, type Scenario } from './scenarios';
import { auditLayout } from './audit';

async function ready(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-review-ready', 'true');
  await expect(page.getByText('読み込んでいます…', { exact: true })).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (img) => img.decode().catch(() => undefined)));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function performAction(page: Page, scenario: Scenario, touch: boolean) {
  const press = async (target: Locator) => touch ? target.tap() : target.click();
  if (!scenario.action) return;
  if (scenario.action === 'guardian-menu') {
    await press(page.locator('.guardian-menu-button'));
    await expect(page.getByRole('button', { name: 'メニューを閉じる', exact: true })).toBeVisible();
    return;
  }
  const row = page.getByRole('region', { name: '伊藤 葵の午睡チェック' });
  await expect(row).toBeVisible();
  if (scenario.action.startsWith('temperature')) {
    await press(row.getByRole('button', { name: '伊藤 葵の体温を選ぶ' }));
    const dialog = page.getByRole('dialog', { name: '伊藤 葵の体温' });
    await expect(dialog).toBeVisible();
    // 体温パネルを開くだけでソフトウェアキーボードを呼ばない。
    await expect(dialog.locator('input')).toHaveCount(0);
    if (scenario.action === 'temperature-decimal') await press(dialog.getByRole('button', { name: '36℃', exact: true }));
    return;
  }
  if (scenario.action === 'nap-warning') {
    await press(row.getByText('うつ伏せ', { exact: true }));
    await press(row.getByText('確認できず', { exact: true }));
    await expect(row.getByRole('alert')).toHaveCount(2);
    return;
  }
  const record = row.getByRole('button', { name: 'この子を記録' });
  await expect(record).toBeDisabled();
  for (const name of ['仰向け', 'あり', '通常']) await press(row.getByText(name, { exact: true }));
  await expect(record).toBeEnabled();
  await press(record);
  await ready(page);
  await expect(row).toContainText('前回 13:30');
  await expect(row.locator('input:checked')).toHaveCount(0);
  await expect(record).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

for (const scenario of scenarios) {
  const group = scenario.role === 'admin' || scenario.role === 'teacher' ? 'staff' : scenario.role;
  test(`[${group}] ${scenario.id} — ${scenario.name}`, async ({ page, hasTouch }, testInfo) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    // HTTP API を誤って使用していれば、実データへ到達する前に停止する。
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      runtimeErrors.push(`レビュー中に HTTP API が呼ばれました: ${route.request().url()}`);
      await route.abort();
    });
    await page.clock.setFixedTime(new Date(REVIEW_TIME));
    await page.goto(`/tests/responsive/harness.html?scene=${scenario.id}`);
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-review-route', scenario.path);
    await expect(page.locator('#root')).not.toBeEmpty();
    await performAction(page, scenario, Boolean(hasTouch));
    await ready(page);
    const audit = await page.evaluate(auditLayout);
    await testInfo.attach('layout-audit', { body: JSON.stringify({ scenario, ...audit }, null, 2), contentType: 'application/json' });
    await testInfo.attach('viewport', { body: await page.screenshot({ animations: 'disabled', fullPage: true }), contentType: 'image/png' });

    // main が内部スクロールする構成なので、fullPage だけでは最終行は写らない。
    if (await page.getByRole('dialog').count() === 0) {
      const scrolled = await page.evaluate(() => {
        const main = document.querySelector('main');
        if (main && main.scrollHeight > main.clientHeight + 2) { main.scrollTop = main.scrollHeight; return true; }
        return false;
      });
      if (scrolled) {
        await testInfo.attach('bottom', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
      }
    }
    expect(runtimeErrors, 'ブラウザ実行エラー').toEqual([]);
    // 通常は指摘を集めて最後までレビューする。CI では構造的なはみ出しを失敗にできる。
    if (process.env.RESPONSIVE_STRICT === '1') {
      expect(audit.findings.filter((f) => f.severity === 'error'), '横方向のはみ出し・操作領域の欠け').toEqual([]);
    }
  });
}
