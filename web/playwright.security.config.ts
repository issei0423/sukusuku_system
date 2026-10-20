/*
 * セキュリティレビュー・ハーネス（tests/security）の設定
 *
 * レスポンシブレビュー（playwright.responsive.config.ts）と同じ流儀。
 * ハーネス自身が Go サーバを使い捨てのデータベースで起動する（webServer）。
 * 起動済みのサーバは流用しない（reuseExistingServer: false）。専用のポートが埋まっていれば失敗する。
 *
 * 使い方は tests/security/README.md を見ること。
 */
import { defineConfig } from '@playwright/test';

/* 【仮置き】専用ポート。start-server.mjs・http.ts と同じ既定 */
const port = Number(process.env.SECURITY_PORT ?? 8199);

export default defineConfig({
  testDir: './tests/security',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results/security',
  // サーバ側の状態（セッション、ロック）を1つずつ確かめるため、順番に1つだけ回す
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['./tests/security/reporter.ts']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'ja-JP',
    // 日付は JST で扱う（server/model.go の jst。AGENTS.md「いちばん大事な決まり」）
    timezoneId: 'Asia/Tokyo',
  },
  webServer: {
    command: 'node tests/security/start-server.mjs',
    // 規約の本文はセッションを要さない（server/session.go）。起動の合図に使う
    url: `http://127.0.0.1:${port}/api/terms`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
