import { test, expect } from '@playwright/test';
import { scenarios, REVIEW_TIME } from './scenarios';
import { auditLayout } from './audit';
import { ready, performAction } from './steps';

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
    // ブラウザの文字の大きさの設定（Chrome の「大」は 20、「特大」は 24）を変えて回す。rem で書いた文字が追従するかを見るため。Chromium だけ
    const fontSize = Number(process.env.RESPONSIVE_FONT_SIZE ?? 0);
    if (fontSize > 0) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: fontSize, fixed: Math.round(fontSize * 13 / 16) } });
    }
    await page.goto(`/tests/responsive/harness.html?scene=${scenario.id}`);
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-review-route', scenario.path);
    await expect(page.locator('#root')).not.toBeEmpty();
    await performAction(page, scenario, Boolean(hasTouch));
    await ready(page);
    const audit = await page.evaluate(auditLayout);
    await testInfo.attach('layout-audit', { body: JSON.stringify({ scenario, ...audit }, null, 2), contentType: 'application/json' });
    // fullPage の撮影は Chromium の文字の大きさの設定を既定に戻してしまうので、設定を変えたときは画面の範囲だけ撮る
    await testInfo.attach('viewport', { body: await page.screenshot({ animations: 'disabled', fullPage: fontSize === 0 }), contentType: 'image/png' });

    // main が内部スクロールする構成なので、fullPage だけでは最終行は写らない。
    if (await page.getByRole('dialog').count() === 0) {
      const scrolled = await page.evaluate((wholePage) => {
        const main = document.querySelector('main');
        if (main && main.scrollHeight > main.clientHeight + 2) { main.scrollTop = main.scrollHeight; return true; }
        const doc = document.scrollingElement;
        if (wholePage && doc && doc.scrollHeight > doc.clientHeight + 2) { doc.scrollTop = doc.scrollHeight; return true; }
        return false;
      }, fontSize > 0);
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
