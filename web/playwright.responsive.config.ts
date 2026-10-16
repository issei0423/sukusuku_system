import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/responsive',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results/responsive',
  fullyParallel: true,
  workers: 3,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [
    ['list'],
    ['./tests/responsive/reporter.ts'],
    ['html', { outputFolder: 'responsive-report/html', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:5186',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:mock -- --host 127.0.0.1 --port 5186 --strictPort',
    url: 'http://127.0.0.1:5186/tests/responsive/harness.html',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'ipad-portrait', use: { browserName: 'webkit', viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true } },
    { name: 'ipad-landscape', use: { browserName: 'webkit', viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    // 職員の想定端末は iPad。スマホでは保護者・共通画面を確認する。
    { name: 'phone', grep: /\[(guardian|public)\]/, use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
