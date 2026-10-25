/*
 * 受け入れテストの最初に1回だけ回す下ごしらえ（playwright.acceptance.config.ts の globalSetup）。
 *
 *   1. 相手が 127.0.0.1 かを確かめる（違えば止まる）
 *   2. 画面をビルドして web/dist を作る（npm run build）
 *   3. サーバをビルドする（go build）
 *
 * サーバはここでは立てない。describe ごとに使い捨てのデータベースで立てる（harness.ts）。
 * できた実行ファイルの場所は環境変数で各ワーカーへ渡す（globalSetup で置いた process.env はワーカーに引き継がれる）。
 */
import type { FullConfig } from '@playwright/test';
import { assertLocalBaseURL } from './paths.mjs';
import { buildServer, buildWeb, makeWorkDir } from './start-server.mjs';

export default function globalSetup(config: FullConfig) {
  for (const project of config.projects) assertLocalBaseURL(project.use.baseURL);
  buildWeb();
  const workDir = makeWorkDir();
  process.env.ACCEPTANCE_WORK_DIR = workDir;
  process.env.ACCEPTANCE_BINARY = buildServer(workDir);
  console.error(`[acceptance] 使い捨ての置き場: ${workDir}`);
}
