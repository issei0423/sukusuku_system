/*
 * 受け入れテストの相手（Go サーバ）を、使い捨てのデータベースと添付の置き場で立てる。
 *
 * 手本はセキュリティレビューのハーネス（tests/security/start-server.mjs）。違うのは次のところ。
 *   - 画面を見るので、npm run build で作った web/dist を配信する（-web）
 *   - 立てる口を関数で出す。ハーネス（harness.ts）は describe ごとに、この口でサーバを立て直す
 *     （ログインの失敗の数はサーバのメモリにだけあるため。server/attempts.go）
 *   - 子プロセスの環境から ANTHROPIC_API_KEY を除く（AI の下書きは無効のまま。外部へ送らない）
 *
 * 決まり
 *   - 待ち受けは 127.0.0.1 だけ。ポートは ACCEPTANCE_PORT（既定 8190）。埋まっていれば流用せずに止まる
 *   - データベースと添付（-db・-files）は、OS の一時フォルダの中に毎回新しく作る（デモデータから始まる）
 *   - サーバのログは acceptance-report/server.log に足していく
 *
 * 手で立てて画面を見るとき（web/ で）:
 *   node tests/acceptance/start-server.mjs          … ビルドしてから立てる。Ctrl+C で止まる
 *   ACCEPTANCE_SKIP_BUILD=1 node tests/acceptance/start-server.mjs   … web/dist があればビルドを飛ばす
 */
import { execFileSync, execSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DIST_DIR,
  HARNESS_ERROR_MARK,
  HOST,
  REPORT_DIR,
  SERVER_DIR,
  WEB_DIR,
  acceptancePort,
  assertLocalBaseURL,
  baseURLFor,
} from './paths.mjs';

const LOG_PATH = path.join(REPORT_DIR, 'server.log');

/** @param {string} message */
function harnessError(message) {
  return new Error(`${HARNESS_ERROR_MARK} ${message}`);
}

/** @param {string} message */
function log(message) {
  console.error(`[acceptance] ${message}`);
}

/** 使い捨ての置き場（OS の一時フォルダの中）。消さずに残す。後から DB とログを見られるように */
export function makeWorkDir() {
  return mkdtempSync(path.join(tmpdir(), 'sukusuku-acceptance-'));
}

/**
 * 画面をビルドして web/dist を作る。ACCEPTANCE_SKIP_BUILD=1 で、web/dist があれば飛ばす（手直しを繰り返すとき）
 */
export function buildWeb() {
  const index = path.join(DIST_DIR, 'index.html');
  if (process.env.ACCEPTANCE_SKIP_BUILD === '1' && existsSync(index)) {
    log('ACCEPTANCE_SKIP_BUILD=1 のため、画面のビルドを飛ばします（いまの web/dist を使います）');
    return;
  }
  log('画面をビルドしています（npm run build）…');
  try {
    // npm は Windows では npm.cmd なので、シェルを通して呼ぶ
    execSync('npm run build', { cwd: WEB_DIR, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    throw harnessError('画面をビルドできませんでした。web/ で npm run build が通るか確かめてください');
  }
  if (!existsSync(index)) throw harnessError(`ビルドのあとに ${index} がありません`);
}

/**
 * サーバをビルドする。できた実行ファイルのパスを返す
 * @param {string} workDir
 */
export function buildServer(workDir) {
  const binary = path.join(workDir, process.platform === 'win32' ? 'sukusuku-acceptance.exe' : 'sukusuku-acceptance');
  log('サーバをビルドしています（go build）…');
  try {
    execFileSync('go', ['build', '-o', binary, '.'], { cwd: SERVER_DIR, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    throw harnessError('サーバをビルドできませんでした。server/ で go build が通るか確かめてください');
  }
  return binary;
}

/**
 * ポートが空くまで待つ。前のサーバを止めた直後は、少しのあいだ埋まっていることがある
 * @param {number} port
 * @param {number} timeoutMs
 */
async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const free = await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once('error', (/** @type {NodeJS.ErrnoException} */ err) => {
        if (err.code === 'EADDRINUSE') resolve(false);
        else reject(err);
      });
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, HOST);
    });
    if (free) return;
    if (Date.now() >= deadline) {
      throw harnessError(`${HOST}:${port} はすでに使われています。別のサーバを止めるか、ACCEPTANCE_PORT を変えてください（流用はしません）`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * @param {string} base
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 */
async function waitForReady(base, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw harnessError(`サーバが起動中に終わりました（終了コード ${child.exitCode}）。${LOG_PATH} を見てください`);
    try {
      // 規約の本文はセッションを要さない（server/session.go）。準備完了の合図に使う
      const res = await fetch(`${base}/api/terms`);
      if (res.ok) return;
    } catch {
      // まだ待ち受けていない
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw harnessError(`サーバが ${timeoutMs / 1000} 秒たっても応答しません。${LOG_PATH} を見てください`);
}

/** サーバの子プロセスへ渡す環境。外部の AI の鍵は渡さない（テスト仕様書の決まり「外へ出さない」） */
export function serverEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/**
 * @typedef {object} RunningServer
 * @property {string} baseURL
 * @property {string} dbPath
 * @property {string} filesDir
 * @property {string} label
 * @property {() => Promise<void>} stop
 */

/**
 * 使い捨てのデータベースでサーバを立てる。応答するまで待ってから返す
 * @param {{ binary: string, workDir: string, port?: number, label?: string }} options
 * @returns {Promise<RunningServer>}
 */
export async function startServer({ binary, workDir, port = acceptancePort(), label = '' }) {
  const baseURL = baseURLFor(port);
  assertLocalBaseURL(baseURL);
  if (!existsSync(path.join(DIST_DIR, 'index.html'))) throw harnessError('web/dist がありません。先に npm run build を回してください');
  await waitForPortFree(port, 10_000);

  const runDir = mkdtempSync(path.join(workDir, 'srv-'));
  const dbPath = path.join(runDir, 'acceptance.db');
  const filesDir = path.join(runDir, 'files');
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(REPORT_DIR, { recursive: true });
  const startedAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
  appendFileSync(LOG_PATH, `\n===== ${startedAt} JST ${label} ${baseURL} db=${dbPath}\n`);
  const logFd = openSync(LOG_PATH, 'a');

  const child = spawn(binary, ['-addr', `${HOST}:${port}`, '-db', dbPath, '-files', filesDir, '-web', DIST_DIR], {
    cwd: runDir,
    env: serverEnv(),
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  closeSync(logFd);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // 呼んだ側のプロセスが終わるときは、サーバも道連れにする（残さない）
  const killOnExit = () => child.kill();
  process.once('exit', killOnExit);

  try {
    await waitForReady(baseURL, child, 60_000);
  } catch (err) {
    child.kill();
    process.off('exit', killOnExit);
    throw err;
  }

  return {
    baseURL,
    dbPath,
    filesDir,
    label,
    async stop() {
      process.off('exit', killOnExit);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      }
    },
  };
}

// ---- 手で立てるとき（node tests/acceptance/start-server.mjs） ----
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    buildWeb();
    const workDir = makeWorkDir();
    const binary = buildServer(workDir);
    const server = await startServer({ binary, workDir, label: '手で立てた' });
    log(`${server.baseURL} でサーバを立てました（データベース: ${server.dbPath}、ログ: ${LOG_PATH}）。Ctrl+C で止まります`);
    const stop = () => {
      void server.stop().then(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('SIGHUP', stop);
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
