/*
 * 受け入れテストの並びを、サーバを立てずに確かめる（npm run test:acceptance:check の後半）。
 *
 * playwright test --list でテストの一覧だけを集め（ビルドもサーバの起動もしない）、次を見る。
 *   - spec のファイル名が「シート番号2桁-名前.spec.ts」（01-common.spec.ts）
 *   - テスト名がケースNoで始まる（01-001・01-I001 と空白）
 *   - ケースNoのシート番号が、ファイル名のシート番号と同じ
 *   - ケースNoが重ならない
 * 1つでも外れたら、終了コード 1 で止まる。
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { WEB_DIR, caseNoOf } from './paths.mjs';

/** @typedef {{ title: string, file: string, line: number }} Spec */
/** @typedef {{ title: string, file?: string, specs?: Spec[], suites?: Suite[] }} Suite */

/** @returns {{ suites?: Suite[], errors?: { message?: string }[] }} */
function listTests() {
  let out = '';
  try {
    out = execSync('npx playwright test -c playwright.acceptance.config.ts --list --reporter=json', {
      cwd: WEB_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const e = /** @type {{ stdout?: string }} */ (err);
    out = e.stdout ?? '';
    if (out.trim() === '') {
      console.error('[acceptance:check] テストの一覧を集められませんでした（上のエラーを見てください）');
      process.exit(1);
    }
  }
  return JSON.parse(out);
}

/**
 * @param {Suite[]} suites
 * @param {Spec[]} into
 */
function collect(suites, into) {
  for (const s of suites) {
    for (const spec of s.specs ?? []) into.push(spec);
    collect(s.suites ?? [], into);
  }
  return into;
}

const report = listTests();
const problems = [];
for (const e of report.errors ?? []) problems.push(`読み込みのエラー: ${e.message ?? ''}`);

const specs = collect(report.suites ?? [], []);
/** @type {Map<string, string>} */
const seen = new Map();
for (const spec of specs) {
  const where = `${spec.file}:${spec.line}`;
  const sheet = /^(\d{2})-[^/\\]+\.spec\.ts$/.exec(path.basename(spec.file))?.[1];
  if (!sheet) problems.push(`ファイル名が「シート番号2桁-名前.spec.ts」ではありません: ${spec.file}`);
  const caseNo = caseNoOf(spec.title);
  if (!caseNo) {
    problems.push(`テスト名がケースNo（01-001 や 01-I001 と空白）で始まりません: ${where}「${spec.title}」`);
    continue;
  }
  if (sheet && !caseNo.startsWith(`${sheet}-`)) problems.push(`ケースNo ${caseNo} のシート番号が、ファイル名（${sheet}）と違います: ${where}`);
  const prev = seen.get(caseNo);
  if (prev) problems.push(`ケースNo ${caseNo} が重なっています: ${prev} と ${where}`);
  seen.set(caseNo, where);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`[acceptance:check] ${p}`);
  process.exit(1);
}
console.error(`[acceptance:check] ${specs.length} 件のケースの並びを確かめました（ケースNo・ファイル名・重なり）`);
