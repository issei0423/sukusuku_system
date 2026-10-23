/*
 * キーボードだけで主な操作を通せるかを確かめる（WCAG 2.1.1 キーボード・2.4.3 フォーカス順序・2.4.7 フォーカスの可視）。
 * 使うキーは Tab・Enter・Space・Esc と文字の入力だけ。マウス・タップは使わない。
 * 基準は WCAG 2.2 AA を目安にする。【仮置き】設計書に適合の水準の定めが無い（web/仮置き値.md）
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { scenarios, REVIEW_TIME } from './scenarios';
import { ready } from './steps';

/** いまフォーカスのある要素に、見える印（outline）が付いているか。radio は隣の文字に印を付けている */
async function focusMark(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { visible: false, what: '（どこにもフォーカスが無い）' };
    const marked = (node: Element | null) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
    };
    const what = `${el.tagName.toLowerCase()}「${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}」`;
    return { visible: el.matches(':focus-visible') && [el, el.nextElementSibling].some(marked), what };
  });
}

async function expectFocusVisible(page: Page) {
  const mark = await focusMark(page);
  expect(mark.visible, `フォーカスの印が見えない：${mark.what}`).toBe(true);
}

/**
 * Tab を押して target までフォーカスを進める。途中で止まった要素にも、フォーカスの印が見えることを確かめる
 */
async function tabTo(page: Page, target: Locator, limit = 300) {
  const unmarked: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press('Tab');
    const mark = await focusMark(page);
    if (!mark.visible) unmarked.push(mark.what);
    if (await target.evaluate((el) => el === document.activeElement)) {
      expect(unmarked, 'フォーカスの印が見えない要素').toEqual([]);
      return;
    }
  }
  throw new Error(`Tab を ${limit} 回押しても届かなかった：${target.toString()}`);
}

async function open(page: Page, sceneId: string) {
  const scenario = scenarios.find((s) => s.id === sceneId);
  if (!scenario) throw new Error(`不明な場面：${sceneId}`);
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.abort());
  await page.clock.setFixedTime(new Date(REVIEW_TIME));
  await page.goto(`/tests/responsive/harness.html?scene=${scenario.id}`);
  await ready(page);
  await expect(page.locator('html')).toHaveAttribute('data-review-route', scenario.path);
}

for (const { tag, scene, email, home } of [
  { tag: 'staff', scene: 'staff-login', email: 'suzuki@hoiku.example.jp', home: '/staff' },
  { tag: 'guardian', scene: 'guardian-login', email: 'nishida.t@example.jp', home: '/guardian' },
]) {
  test(`[${tag}] keyboard-login — ${scene} からキーボードだけでログインする`, async ({ page }) => {
    await open(page, scene);
    await tabTo(page, page.getByRole('textbox', { name: 'ログインID' }));
    await page.keyboard.type(email);
    await tabTo(page, page.getByLabel('パスワード', { exact: true }));
    await page.keyboard.type('pass1234');
    const remember = page.getByRole('checkbox', { name: 'ログイン状態を保持する' });
    await tabTo(page, remember);
    await page.keyboard.press('Space');
    await expect(remember).toBeChecked();
    await tabTo(page, page.getByRole('button', { name: 'ログイン', exact: true }));
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-review-route', home);
    await ready(page);
  });
}

test('[staff] keyboard-nap-temperature — 体温パネルを Enter で開き、Esc で閉じるとフォーカスが元へ戻る', async ({ page }) => {
  await open(page, 'nap');
  const row = page.getByRole('region', { name: '伊藤 葵の午睡チェック' });
  // 名前は、見えている文字「体温 未測定」に氏名を添えたもの。値を選ぶと名前も変わるので、頭で探す（Issue #207）
  const button = row.getByRole('button', { name: /^伊藤 葵の体温/ });
  const dialog = page.getByRole('dialog', { name: '伊藤 葵の体温' });
  await expect(button).toHaveAccessibleName('伊藤 葵の体温 未測定');
  await tabTo(page, button);

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.contains(document.activeElement)), 'パネルを開いたらフォーカスがパネルの中へ入る').toBe(true);
  await expectFocusVisible(page);
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate((el) => el.contains(document.activeElement)), 'Tab でパネルの外へ出ない').toBe(true);
  await expectFocusVisible(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  await expectFocusVisible(page);

  // Space で開き、Enter と Space で 36.5℃ を選ぶ。選ぶと閉じて、フォーカスが元へ戻る
  await page.keyboard.press('Space');
  await expect(dialog).toBeVisible();
  await tabTo(page, dialog.getByRole('button', { name: '36℃', exact: true }), 20);
  await page.keyboard.press('Enter');
  await tabTo(page, dialog.getByRole('button', { name: '.5', exact: true }), 20);
  await page.keyboard.press('Space');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toContainText('36.5℃');
  await expect(button).toHaveAccessibleName('伊藤 葵の体温 36.5℃');
});

test('[staff] keyboard-nap-timer — Shift+Tab で上へ戻っても、フォーカスした部品が上に止めたタイマーの下に隠れない', async ({ page }) => {
  // WCAG 2.4.11 フォーカスの非隠蔽（最低限）。GitHub Issue #212
  await open(page, 'nap');
  await tabTo(page, page.locator('.nap-record-row').last().getByRole('button', { name: /の体温 / }));
  const hidden: string[] = [];
  let steps = 0;
  for (; steps < 120; steps += 1) {
    await page.keyboard.press('Shift+Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const timer = document.querySelector('.nap-timer');
      if (!el || !timer || !el.closest('.main')) return null;
      // radio は隠してあり、押す場所は包む label
      const target = el.matches('input[type="radio"]') ? el.closest('label') ?? el : el;
      const box = target.getBoundingClientRect();
      const bar = timer.getBoundingClientRect();
      return {
        what: `${el.tagName.toLowerCase()}「${(el.getAttribute('aria-label') ?? target.textContent ?? '').trim().slice(0, 30)}」`,
        covered: box.top < bar.bottom && box.bottom > bar.top,
      };
    });
    if (!focus) break;
    if (focus.covered) hidden.push(focus.what);
  }
  expect(steps, '園児の行をさかのぼって、画面の上の部品まで戻った').toBeGreaterThan(40);
  expect(hidden, 'タイマーの下に隠れた部品').toEqual([]);
});

test('[staff] keyboard-nap-record — 「この子を記録」を押したあと、フォーカスが次の園児の行の最初の選択肢へ移る', async ({ page }) => {
  // 押したボタンは記録のあと無効になる。フォーカスを body に落とさない（WCAG 2.4.3 フォーカス順序、GitHub Issue #213）
  await open(page, 'nap');
  const rows = page.locator('.nap-record-row');
  const row = rows.first();
  const record = row.getByRole('button', { name: 'この子を記録' });
  for (const group of ['体位', '呼吸', '顔色']) {
    const first = row.getByRole('group', { name: group }).getByRole('radio').first();
    await tabTo(page, first, 20);
    await page.keyboard.press('Space');
    await expect(first).toBeChecked();
  }
  await tabTo(page, record, 5);
  await page.keyboard.press('Enter');
  await expect(row.getByRole('status')).toHaveText('保存しました');
  await expect(record).toBeDisabled();
  await expect(rows.nth(1).getByRole('group', { name: '体位' }).getByRole('radio').first()).toBeFocused();
  await expectFocusVisible(page);

  // 最後の園児の行では、記録した行の最初の選択肢へ戻す
  const last = rows.last();
  const lastRecord = last.getByRole('button', { name: 'この子を記録' });
  for (const group of ['体位', '呼吸', '顔色']) {
    const first = last.getByRole('group', { name: group }).getByRole('radio').first();
    await tabTo(page, first, 80);
    await page.keyboard.press('Space');
  }
  await tabTo(page, lastRecord, 5);
  await page.keyboard.press('Enter');
  await expect(last.getByRole('status')).toHaveText('保存しました');
  await expect(last.getByRole('group', { name: '体位' }).getByRole('radio').first()).toBeFocused();
  await expectFocusVisible(page);
});

test('[guardian] keyboard-guardian-menu — 保護者のメニューを開いて閉じると、フォーカスが元へ戻る', async ({ page }) => {
  await open(page, 'guardian-home');
  const menuButton = page.getByRole('button', { name: 'メニューを開く' });
  const menu = page.getByRole('dialog', { name: 'メニュー' });
  const close = menu.getByRole('button', { name: 'メニューを閉じる' });
  await tabTo(page, menuButton);

  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(close).toBeFocused();
  await expectFocusVisible(page);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(menuButton).toBeFocused();
  await expectFocusVisible(page);

  // Space で開き、メニューの中を Tab で一回りしてから、閉じるボタンを Enter で押す
  await page.keyboard.press('Space');
  await expect(menu).toBeVisible();
  await expect(close).toBeFocused();
  await tabTo(page, menu.getByRole('button', { name: 'ログアウト' }), 20);
  await tabTo(page, close, 5);
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(menuButton).toBeFocused();
});
