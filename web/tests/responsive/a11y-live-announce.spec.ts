/*
 * 相手の操作で画面が書き換わったとき、読み上げへ伝わるもの（ライブリージョンの中身の変わり方）を見る
 * 典拠：詳細設計書「全画面に共通する部品と決まり」(2-0) の (6)「読み上げの範囲」（決めたこと D-57）、
 *      WCAG 4.1.3 ステータスメッセージ、GitHub Issue #209
 *
 * 読み上げへ伝えるのは3つだけ：①チャットで相手から届いたもの（role="log"）②連絡帳で「家庭から」が増えたとき
 * ③午睡チェックで確認の時刻を過ぎた子を「未確認 n 名」とまとめて1回。
 * 画面の中のライブリージョン（aria-live・role="status"・role="log"・role="alert"）の中身が変わるたびに書き留め、
 * 相手の操作のあとに書き留めたものが、決めた文の1回だけであることを確かめる（読み上げソフトでは聞いていない）。
 * 相手の操作は、画面と同じモック（src/api/client.ts）をページの中から呼んで起こす。chromium（desktop）だけで回す。
 */
import { test, expect, type Page } from '@playwright/test';
import { REVIEW_TIME } from './scenarios';

test.skip(({ browserName }) => browserName !== 'chromium', '読み上げの範囲は chromium（desktop）で確かめる');

async function ready(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-review-ready', 'true');
  await expect(page.getByText('読み込んでいます…', { exact: true })).toHaveCount(0);
}

async function open(page: Page, scene: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    errors.push(`HTTP API が呼ばれました: ${route.request().url()}`);
    await route.abort();
  });
  await page.clock.setFixedTime(new Date(REVIEW_TIME));
  await page.goto(`/tests/responsive/harness.html?scene=${scene}`);
  await ready(page);
  return errors;
}

/** ライブリージョンの中身が変わるたびに、その中身を書き留める（読み上げへ伝わる見込みのもの） */
async function watchLive(page: Page) {
  await page.evaluate(() => {
    const sel = '[aria-live]:not([aria-live="off"]), [role="status"], [role="log"], [role="alert"]';
    const said: string[] = [];
    const last = new Map<Element, string>();
    document.querySelectorAll(sel).forEach((el) => last.set(el, el.textContent ?? ''));
    new MutationObserver((records) => {
      for (const r of records) {
        const at = r.target instanceof Element ? r.target : r.target.parentElement;
        const region = at?.closest(sel);
        if (!region) continue;
        const text = region.textContent ?? '';
        if (last.get(region) === text) continue;
        last.set(region, text);
        if (text.trim()) said.push(text.trim());
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    Reflect.set(window, '__liveSaid', said);
  });
  return () => page.evaluate(() => [...(Reflect.get(window, '__liveSaid') as string[])]);
}

/** 画面と同じモックを、ページの中から呼ぶ（相手の操作を起こす） */
async function asOther(page: Page, call: 'saveHome' | 'send', args: unknown[]) {
  await page.evaluate(async ({ call, args }) => {
    const path = '/src/api/client.ts';
    const { api } = await import(/* @vite-ignore */ path);
    await api[call](...args);
  }, { call, args });
}

const guardian = { account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠', staff_id: null, guardian_id: 'G001', class_id: null, class_name: null, is_temp_password: false, terms_agreed: true };

test.describe('[staff] 相手の操作で読み上げへ伝えるもの', () => {
  test('② 連絡帳（クラス）画面：保護者が家庭からを送ると、「家庭からが1件届きました（〇〇さん）」を1回だけ伝える', async ({ page }) => {
    const errors = await open(page, 'contact-class');
    const said = await watchLive(page);
    await asOther(page, 'saveHome', [guardian, 'C001', {
      temperature: 36.6, night_sleep_from: null, night_sleep_to: null, breakfast: '1', mood_label: 'ごきげん',
      pickup_type: '1', pickup_person: null, pickup_time: null, message: null, updated_at: null,
    }]);
    await expect(page.locator('[data-home-arrival]')).toHaveText('家庭からが1件届きました（野原 太郎さん）');
    await ready(page);
    expect(await said()).toEqual(['家庭からが1件届きました（野原 太郎さん）']);
    expect(errors, 'ブラウザ実行エラー').toEqual([]);
  });

  test('③ 午睡チェック画面：確認の時刻を過ぎた子が増えると、タイマーの欄で「未確認 n 名」をまとめて1回だけ伝え、行の状態の文は伝えない。自分で記録したときはその行の「保存しました」だけ', async ({ page }) => {
    const errors = await open(page, 'nap');
    const rowSaid = () => page.locator('.nap-grid [role="status"], .nap-grid [aria-live]').evaluateAll((els) => els.map((e) => e.textContent ?? '').filter((t) => t !== ''));
    expect(await rowSaid(), '行の状態の文（「確認済み」など）は読み上げの欄に入れない').toEqual([]);
    const before = Number(/未確認 (\d+) 名/.exec(await page.locator('.nap-timer').innerText())?.[1] ?? 0);
    const confirmed = page.locator('.nap-row-status', { hasText: '確認済み' });
    expect(await confirmed.count(), '13:30 には「確認済み」の行がある').toBeGreaterThan(0);
    const said = await watchLive(page);
    // 13:20〜13:23 に確認した子（さくら組は10分ごと）も、13:34 にはそろって時刻を過ぎる
    await page.clock.setFixedTime(new Date('2026-09-01T13:34:00+09:00'));
    await expect(page.locator('.nap-timer')).not.toContainText(`未確認 ${before} 名`);
    const after = Number(/未確認 (\d+) 名/.exec(await page.locator('.nap-timer').innerText())?.[1] ?? 0);
    expect(after, '時刻を過ぎた子が増えた').toBeGreaterThan(before);
    const timerText = `チェックの時刻を過ぎています（未確認 ${after} 名）`;
    await expect(page.locator('.nap-timer [role="status"]')).toHaveText(timerText);

    // 1人を記録する。画面が読み直され、ほかの行の文が「確認済み」から「チェック時刻を過ぎています」に変わるが、それは伝えない。
    // 伝えるのは記録した行の「保存しました」だけ。結果の表示（notify）は出さない（次の行のボタンを隠すため）。
    // 数が減ってもタイマーの欄は読み直さない
    const row = page.getByRole('region', { name: '伊藤 葵の午睡チェック' });
    for (const label of ['仰向け', 'あり', '通常']) await row.getByText(label, { exact: true }).click();
    await row.getByRole('button', { name: 'この子を記録' }).click();
    await expect(row.locator('[role="status"]')).toHaveText('保存しました');
    await ready(page);
    await expect(confirmed, '「確認済み」だった行が「チェック時刻を過ぎています」に変わった').toHaveCount(0);
    await expect(page.locator('.toast')).toHaveCount(0);
    expect(await said()).toEqual([timerText, '保存しました']);
    expect(errors, 'ブラウザ実行エラー').toEqual([]);
  });

  test('① チャット画面（職員）：保護者から届いたものだけを role="log" で伝え、自分が送ったものは伝えない', async ({ page }) => {
    const errors = await open(page, 'staff-chat');
    // 職員のチャット一覧は、個人チャットを「〇〇の園とのやりとり」と出す（#198。StaffChatScreen の roomLabel、詳細設計書「チャット」(2-9)）
    await page.locator('button.channel', { hasText: '野原 太郎の園とのやりとり' }).click();
    await ready(page);
    const said = await watchLive(page);
    await asOther(page, 'send', [guardian, 6, '熱は下がりました。']);
    await expect(page.getByRole('log')).toHaveText('野原 一誠（保護者）から：熱は下がりました。');
    await page.getByPlaceholder('メッセージを入力').fill('承知しました。');
    await page.getByRole('button', { name: '送信' }).click();
    await expect(page.locator('.bubble', { hasText: '承知しました。' })).toBeVisible();
    await ready(page);
    expect(await said()).toEqual(['野原 一誠（保護者）から：熱は下がりました。']);
    expect(errors, 'ブラウザ実行エラー').toEqual([]);
  });
});
