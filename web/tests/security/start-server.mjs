/*
 * セキュリティレビュー・ハーネスの相手（Go サーバ）を、使い捨てのデータベースで起動する。
 *
 * Playwright の webServer から呼ばれる。ハーネス自身がサーバを立てるので、
 * 手元で動かしている開発サーバや、まちがって本番へ向けて攻撃してしまうことがない。
 *
 * 方針は レスポンシブレビューのハーネス（tests/responsive）と同じ。
 *   - 専用のポートを使う。すでに誰かが使っていたら、流用せず失敗する
 *   - データベースは一時フォルダに新しく作る（デモデータから始まる）
 *   - 静的ファイルは web/public を配信する。画面のビルドは要らないが、
 *     配信ディレクトリの外（server/ など）を読めないことの確認に使う
 *
 * 起動したサーバは、Playwright がこのプロセスを終わらせるときに一緒に終わる。
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..', '..'); // web/
const repoDir = path.resolve(webDir, '..'); // リポジトリの根
const serverDir = path.join(repoDir, 'server');
const reportDir = path.join(webDir, 'security-report');

/* 【仮置き】専用ポート。レスポンシブレビューの 5186 と衝突しない番号を選んでいる */
const port = Number(process.env.SECURITY_PORT ?? 8199);
const host = '127.0.0.1';
const base = `http://${host}:${port}`;

/** @param {string} message */
function fail(message) {
  console.error(`[security] ${message}`);
  process.exit(1);
}

// ポートが空いているかを確かめる。使われていたら流用せず止める
async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (/** @type {NodeJS.ErrnoException} */ err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`${host}:${port} はすでに使われています。別のサーバを止めるか、SECURITY_PORT を変えてください`));
        return;
      }
      reject(err);
    });
    probe.once('listening', () => probe.close(resolve));
    probe.listen(port, host);
  }).catch((err) => fail(err.message));
}

async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // 規約の本文はセッションを要さない（server/session.go）。準備完了の合図に使う
      const res = await fetch(`${base}/api/terms`);
      if (res.ok) return;
    } catch {
      // まだ待ち受けていない
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`サーバが ${timeoutMs / 1000} 秒たっても応答しません`);
}

await assertPortFree();

// 一時フォルダに、ビルドしたサーバとデータベースを置く
const workDir = mkdtempSync(path.join(tmpdir(), 'sukusuku-security-'));
mkdirSync(reportDir, { recursive: true });
const logPath = path.join(reportDir, 'server.log');
const binary = path.join(workDir, process.platform === 'win32' ? 'sukusuku-security.exe' : 'sukusuku-security');
const dbPath = path.join(workDir, process.env.SECURITY_DB ?? 'security.db');

try {
  execFileSync('go', ['build', '-o', binary, '.'], { cwd: serverDir, stdio: ['ignore', 'inherit', 'inherit'] });
} catch {
  fail('サーバをビルドできませんでした。server/ で go build が通るか確かめてください');
}

const logFd = openSync(logPath, 'a');
const child = spawn(binary, ['-addr', `${host}:${port}`, '-db', dbPath, '-web', path.join(webDir, 'public')], {
  cwd: serverDir,
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    child.kill();
  } catch {
    // すでに終わっている
  }
  process.exit(code);
}

child.on('exit', (code) => {
  if (!stopping) {
    console.error(`[security] サーバが終了しました（終了コード ${code}）。${logPath} を見てください`);
    stop(1);
  }
});
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('SIGHUP', () => stop(0));
process.on('exit', () => child.kill());

await waitForReady();

// Playwright はこの出力を待たないが、手で動かしたときに何が起きたか分かるようにしておく
console.log(`[security] ${base} でサーバを起動しました（データベース: ${dbPath}、ログ: ${logPath}）`);
