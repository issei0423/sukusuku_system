import { defineConfig } from '@playwright/test';

/*
 * アクセシビリティの自動検査（axe とキーボード操作）。
 * レスポンシブレビュー（playwright.responsive.config.ts）と同じ場面・同じハーネスを使う。
 * 基準は WCAG 2.2 AA を目安にする。【仮置き】設計書に適合の水準の定めが無い（web/仮置き値.md）
 */
export default defineConfig({
  testDir: './tests/responsive',
  testMatch: 'a11y-*.spec.ts',
  outputDir: './test-results/a11y',
  fullyParallel: true,
  workers: 3,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [
    ['list'],
    ['./tests/responsive/a11y-reporter.ts'],
    ['html', { outputFolder: 'a11y-report/html', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:5187',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:mock -- --host 127.0.0.1 --port 5187 --strictPort',
    url: 'http://127.0.0.1:5187/tests/responsive/harness.html',
    reuseExistingServer: false,
  },
  projects: [
    // 職員の想定端末は iPad（横）。職員の画面と共通の画面を見る。
    { name: 'staff', grep: /\[(staff|public)\]/, use: { browserName: 'chromium', viewport: { width: 1024, height: 768 } } },
    // 保護者の想定端末はスマートフォン。保護者の画面と共通の画面を見る。
    { name: 'phone', grep: /\[(guardian|public)\]/, use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } },
  ],
});
