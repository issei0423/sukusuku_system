/*
 * 演習用：手元のサーバでデモをするときの入口（デモ手順書.md「4」）。
 *
 *   npm run demo        サーバを立て、iPad・iPhone で開く URL の QR コードを出す
 *   npm run demo:qr     QR コードだけを出し直す（サーバは立ててある。IP が変わったとき）
 *
 * 持ち主が 2026-11-13 に「保育士と保護者のローカルホストポート番号手打ちはちょっとだから、毎回 QR コードだすようにして」と頼んだ。
 *
 * - サーバは ../server/sukusuku-demo.exe（デモ手順書「3」で go build したもの）を、画面は ../web/dist（npm run build:demo）を使う
 * - DB は demo-YYYYMMDD.db（日本時間の日付）。同じ日に立て直したら同じ DB を使う（データは残る）。
 *   新しく作り直したいときは --db 新しい名前.db
 * - QR コードはブラウザの画面（一時フォルダの HTML）と、このターミナルの両方に出す。インターネットは使わない
 * - このターミナルを閉じる・Ctrl+C を押すと、サーバも止まる
 */
import { spawn, exec } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { demoTargets } from './demoTargets.mjs';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.resolve(webDir, '..', 'server');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const qrOnly = args.includes('--qr-only');
const port = Number(opt('--port') ?? 8080);
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()).replaceAll('-', '');
const db = opt('--db') ?? `demo-${today}.db`;

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/staff-top`);
      if (res.ok) return true;
    } catch { /* まだ立ち上がっていない */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function showQr() {
  const t = demoTargets(networkInterfaces(), port);
  const cards = [];
  const say = [];
  const add = async (title, color, url, note) => {
    cards.push(`<section style="border:8px solid ${color}"><h2>${title}</h2>
      ${await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })}
      <p class="url">${url}</p><p class="note">${note}</p></section>`);
    say.push(`\n■ ${title}\n${url}\n${await QRCode.toString(url, { type: 'terminal', small: true })}`);
  };
  if (t.staff) await add('保育士（iPad）', '#2e7d32', t.staff.url, 'PC のホットスポットの Wi-Fi に入ってから、カメラで読む');
  if (t.guardian) await add('保護者（iPhone）', '#1565c0', t.guardian.url, 'USB でつないだまま、カメラで読む');
  const missing = [];
  if (!t.staff) missing.push('ホットスポット（192.168.137.1）が見つからない。PC のモバイル ホットスポットをオンにしてから npm run demo:qr');
  if (!t.guardian) missing.push('iPhone の USB（172.20.10.x）が見つからない。iPhone を USB でつなぎ、インターネット共有をオンにしてから npm run demo:qr');
  const others = t.others.map((o) => `<li>${o.name}：${o.ip}（保育士 ${o.staffUrl}・保護者 ${o.guardianUrl}）</li>`).join('');

  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>すくすく デモの入口</title>
<style>body{font-family:sans-serif;margin:24px;background:#fff;color:#111}
main{display:flex;gap:24px;flex-wrap:wrap}section{box-sizing:border-box;padding:16px;border-radius:12px;width:min(440px,calc(50vw - 40px));min-width:300px}
section svg{width:100%;height:auto;display:block}h2{margin:0 0 8px;font-size:28px}.url{font-size:20px;font-family:monospace}
.note{color:#444}.warn{color:#b00020;font-weight:bold}</style></head><body>
<h1>すくすく デモの入口</h1><p>ログイン画面で左上 → 右上の順に押すと、西田 拓也で入ります。</p>
<main>${cards.join('')}</main>
${missing.map((m) => `<p class="warn">${m}</p>`).join('')}
${others ? `<details><summary>そのほかの IP</summary><ul>${others}</ul></details>` : ''}
</body></html>`;
  const file = path.join(tmpdir(), 'sukusuku-demo-qr.html');
  writeFileSync(file, html, 'utf8');
  console.log(say.join('\n'));
  for (const m of missing) console.log(`\n！ ${m}`);
  console.log(`\nQR コードの画面：${file}`);
  if (process.platform === 'win32') exec(`start "" "${file}"`);
}

if (qrOnly) {
  if (!(await waitForServer())) console.log(`！ http://localhost:${port} が応答しない。先に npm run demo でサーバを立てる`);
  await showQr();
} else {
  const exe = path.join(serverDir, process.platform === 'win32' ? 'sukusuku-demo.exe' : 'sukusuku-demo');
  if (!existsSync(exe)) {
    console.error(`サーバの exe が無い：${exe}\nデモ手順書.md「3」のとおり、server で go build -o sukusuku-demo.exe . を回す`);
    process.exit(1);
  }
  if (!existsSync(path.join(webDir, 'dist', 'index.html'))) {
    console.error('画面のビルド（web/dist）が無い。npm run build:demo を回す');
    process.exit(1);
  }
  const files = `files-${db.replace(/\.db$/, '')}`;
  console.log(`サーバを立てます（DB：${db}）。このターミナルを閉じるとサーバも止まります。`);
  const server = spawn(exe, ['-addr', `:${port}`, '-db', db, '-web', path.join(webDir, 'dist'), '-files', files],
    { cwd: serverDir, stdio: 'inherit' });
  server.on('exit', (code) => { console.log(`サーバが止まりました（${code}）`); process.exit(code ?? 0); });
  process.on('SIGINT', () => server.kill());
  if (await waitForServer()) await showQr();
  else console.log(`！ 30 秒待っても http://localhost:${port} が応答しない。上のサーバの表示を見る`);
}
