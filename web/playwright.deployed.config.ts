import { defineConfig } from '@playwright/test';

/*
 * 公開先（デプロイ環境）のスモークテスト（tests/deployed）。
 *
 * 受け入れテスト（playwright.acceptance.config.ts）は、データを書き換え、ログインをわざと失敗させてロックまで確かめるので、
 * 公開先へは向けない（assertLocalBaseURL）。こちらは読むだけ：デモアカウントで正しくログインし、画面が開くことと、
 * 公開の守り（未ログインの拒否・キャッシュの指定）を確かめる。ログインを失敗させない・保存しない・ログアウトしない
 * （ログアウトはその職員の日誌の編集ロックを外すため。server/api_auth.go の handleLogout）。
 *
 * 経緯：2026-10-30、公開先の DB が古い seed のまま残り、いまのデモアカウントでログインできなかった（PR #332）。
 * 手元・GitHub の CI は毎回新しい DB で回るので気づけなかった。反映のあとに公開先そのものを確かめる。
 *
 * 向け先は DEPLOYED_BASE_URL（既定は OCI の公開先）。証明書は IP あての自己署名なので、検証を外す。
 * 回し方：npm run test:deployed（.github/workflows/deployed-smoke.yml が反映の成功のあとに回す）
 */
const baseURL = process.env.DEPLOYED_BASE_URL?.trim() || 'https://217.142.235.206';

export default defineConfig({
  testDir: './tests/deployed',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results/deployed',
  fullyParallel: false,
  workers: 1,
  // 公開先は 1GB・1/8 OCPU の VM。混んだときの一度の遅れで赤にしない
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    browserName: 'chromium',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1024, height: 768 },
    colorScheme: 'light',
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'deployed' }],
});
