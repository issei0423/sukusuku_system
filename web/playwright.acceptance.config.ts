/*
 * 受け入れテスト（画面のブラックボックス試験。tests/acceptance）の設定
 *
 * テスト仕様書 兼 成績書（docs ブランチの テスト仕様書.md）のケースを、本物の画面と Go サーバで回す。
 *   - 最初に1回、画面（npm run build）とサーバ（go build）をビルドする（global-setup.ts）
 *   - サーバは describe ごとに、使い捨てのデータベースで立て直す（harness.ts）。手元の開発サーバは使わない
 *   - 相手は 127.0.0.1 だけ（ポートは ACCEPTANCE_PORT、既定 8190）。違えばここで止まる
 *   - 結果は acceptance-report/results.json と acceptance-report/shots/（reporter.ts）
 *
 * 使い方は tests/acceptance/README.md を見ること。
 */
import { defineConfig } from '@playwright/test';
import { TABLET, acceptancePort, assertLocalBaseURL, baseURLFor } from './tests/acceptance/paths.mjs';

const baseURL = baseURLFor(acceptancePort());
assertLocalBaseURL(baseURL);

export default defineConfig({
  testDir: './tests/acceptance',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results/acceptance',
  globalSetup: './tests/acceptance/global-setup.ts',
  // サーバは1つのポートで立て直すので、テストは順に1つずつ回す
  fullyParallel: false,
  workers: 1,
  // 結果は1回目のものを成績にする（やり直して通ったものを OK にしない）
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['./tests/acceptance/reporter.ts']],
  use: {
    baseURL,
    browserName: 'chromium',
    locale: 'ja-JP',
    // 日付は JST で扱う（server/model.go の jst。AGENTS.md「いちばん大事な決まり」）
    timezoneId: 'Asia/Tokyo',
    viewport: TABLET,
    colorScheme: 'light',
    // Web Push を購読しない（テスト仕様書の決まり「外へ出さない」）。通知の許可も与えない
    serviceWorkers: 'block',
    permissions: [],
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'acceptance' }],
});
