// レスポンシブレビュー（review.spec.ts）とアクセシビリティの検査（a11y-*.spec.ts）が共に使う手順。
import { expect, type Page, type Locator } from '@playwright/test';
import type { Scenario } from './scenarios';

/** モック API の読み込みが静まり、フォントと画像がそろうまで待つ */
export async function ready(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-review-ready', 'true');
  await expect(page.getByText('読み込んでいます…', { exact: true })).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (img) => img.decode().catch(() => undefined)));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

/** 場面に決めてある操作（体温パネル・注意表示・保存・保護者メニュー）をして、その状態にする */
export async function performAction(page: Page, scenario: Scenario, touch: boolean) {
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
    await press(row.getByRole('button', { name: '伊藤 葵の体温 未測定', exact: true }));
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
  const record = row.getByRole('button', { name: /を記録する$/ });
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
