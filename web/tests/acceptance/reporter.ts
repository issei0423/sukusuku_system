/*
 * 受け入れテストのレポーター。成績書（テスト仕様書 兼 成績書）の「結果・確認日・実施者・証跡」の材料を書く。
 *
 *   acceptance-report/results.json … ケースNoごとの結果（機械が読む形。成績書へ写す係が使う）
 *   acceptance-report/shots/       … 証跡。harness.ts の evidence() と、落ちたときの自動の1枚が書く
 *
 * ケースNoは、テスト名の頭から取る（test('01-001 …')。paths.mjs の CASE_NO）。
 *
 * 結果の決め方（テスト仕様書の決まり「列の形」の 結果：OK・NG・未実施）
 *   OK     … 通った
 *   NG     … 確認事項のとおりにならなかった（期待で落ちた・時間切れ）
 *   未実施 … 回していない（test.skip、同じ describe の前のケースが落ちて飛ばされた、途中で止めた、
 *             ハーネス自身の不具合で確かめられなかった＝エラーに [acceptance:harness] が付いたもの）。理由を reason に書く
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestError, TestResult } from '@playwright/test/reporter';
import { DEFAULT_TESTER, HARNESS_ERROR_MARK, REPORT_DIR, REPO_DIR, WEB_DIR, caseNoOf } from './paths.mjs';

type Verdict = 'OK' | 'NG' | '未実施';

interface CaseRecord {
  /** ケースNo（01-001・02-I001） */
  caseNo: string;
  /** テスト名からケースNoを除いたもの */
  title: string;
  /** spec のファイル（web/ から見た位置） */
  file: string;
  /** describe の並び */
  describe: string[];
  result: Verdict;
  /** 実施日時（JST。2026-10-26T03:12:05+09:00） */
  executedAt: string | null;
  /** 確認日（JST の実施日。2026-10-26） */
  date: string | null;
  tester: string;
  /** 証跡のファイル名（shots/ の中）。無ければ null */
  evidence: string | null;
  /** 証跡の注記（「落ちた時点の画面」など） */
  evidenceNote: string | null;
  /** NG のときのエラーの要約 */
  error: string | null;
  /** 未実施の理由 */
  reason: string | null;
  durationMs: number | null;
  /** 試験した本線の commit（下の commits.main と同じ） */
  mainCommit: string | null;
  /** ハーネス（このブランチ）の commit */
  harnessCommit: string | null;
}

// 色付けの制御文字（ESC [ … m）。正規表現に制御文字を直に書かないため、文字コードから組み立てる
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

/** JST の日時の文字列（+09:00 付き） */
function jst(date: Date): { at: string; day: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return { at: `${day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`, day };
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** git diff --quiet が差分なしで 0 を返すか */
function gitSame(args: string[]): boolean | null {
  try {
    execFileSync('git', args, { cwd: REPO_DIR, stdio: 'ignore' });
    return true;
  } catch (err) {
    return (err as { status?: number }).status === 1 ? false : null;
  }
}

function summarize(message: string | undefined): string {
  const text = (message ?? '').replace(ANSI, '').trim();
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  const head = lines.slice(0, 6).join('\n');
  return head.length > 600 ? `${head.slice(0, 600)}…` : head;
}

function errorText(result: TestResult): string {
  return result.errors.map((e: TestError) => e.message ?? String(e.value ?? '')).join('\n');
}

export default class AcceptanceReporter implements Reporter {
  private root: Suite | null = null;
  private runErrors: string[] = [];
  private commits = {
    mainRef: process.env.ACCEPTANCE_MAIN_REF ?? 'origin/mockup-go-react',
    main: null as string | null,
    appSameAsMain: null as boolean | null,
    harness: null as string | null,
    harnessDirty: null as boolean | null,
    branch: null as string | null,
  };
  private tester = process.env.ACCEPTANCE_TESTER ?? DEFAULT_TESTER;

  printsToStdio() {
    return false;
  }

  onBegin(_config: FullConfig, suite: Suite) {
    this.root = suite;
    mkdirSync(REPORT_DIR, { recursive: true });
    const c = this.commits;
    c.harness = git(['rev-parse', 'HEAD']);
    c.branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    c.main = git(['merge-base', 'HEAD', c.mainRef]);
    // 試験した画面とサーバ（server/・web/src/）が本線の commit と同じか。手元の書き換えも差分に数える
    c.appSameAsMain = c.main ? gitSame(['diff', '--quiet', c.main, '--', 'server', 'web/src']) : null;
    const dirty = git(['status', '--porcelain', '--', 'web/tests/acceptance', 'web/playwright.acceptance.config.ts']);
    c.harnessDirty = dirty === null ? null : dirty !== '';
  }

  onError(error: TestError) {
    this.runErrors.push(summarize(error.message ?? String(error.value ?? '')));
  }

  private record(test: TestCase): CaseRecord | null {
    const caseNo = caseNoOf(test.title);
    if (!caseNo) return null;
    const result = test.results.at(-1);
    const file = path.relative(WEB_DIR, test.location.file).split(path.sep).join('/');
    const describe = test.titlePath().slice(3, -1); // ['', プロジェクト, ファイル, describe…, テスト名]
    // 実行中に足した印は TestResult に入る（版によっては TestCase にも入る。両方を見る）
    const notes = [...(result?.annotations ?? []), ...test.annotations];
    const evidence = notes.find((a) => a.type === 'evidence')?.description ?? null;
    const evidenceNote = notes.find((a) => a.type === 'evidence-note')?.description ?? null;
    const when = result ? jst(result.startTime) : null;
    const base: CaseRecord = {
      caseNo,
      title: test.title.slice(caseNo.length).trim(),
      file,
      describe,
      result: '未実施',
      executedAt: when?.at ?? null,
      date: when?.day ?? null,
      tester: this.tester,
      evidence,
      evidenceNote,
      error: null,
      reason: null,
      durationMs: result?.duration ?? null,
      mainCommit: this.commits.main,
      harnessCommit: this.commits.harness,
    };
    if (!result) return { ...base, reason: '実行されなかった（途中で止めた、など）' };

    const skipNote = notes.find((a) => a.type === 'skip' || a.type === 'fixme')?.description;
    switch (result.status) {
      case 'passed':
        return { ...base, result: 'OK' };
      case 'skipped':
        return { ...base, executedAt: null, date: null, reason: skipNote ?? '回していない（同じ describe の前のケースが落ちて飛ばされた、など）' };
      case 'interrupted':
        return { ...base, reason: '途中で止めた' };
      default: {
        const text = errorText(result);
        if (text.includes(HARNESS_ERROR_MARK)) {
          return { ...base, reason: `ハーネスの不具合で確かめられなかった：${summarize(text)}` };
        }
        return { ...base, result: 'NG', error: summarize(text) || (result.status === 'timedOut' ? '時間切れ' : '落ちた') };
      }
    }
  }

  onEnd(result: FullResult) {
    const tests = this.root?.allTests() ?? [];
    const cases: CaseRecord[] = [];
    const warnings: string[] = [];
    const seen = new Map<string, string>();
    for (const test of tests) {
      const rec = this.record(test);
      if (!rec) {
        warnings.push(`ケースNoで始まらないテスト（results.json に載せていない）: ${test.title}（${path.basename(test.location.file)}）`);
        continue;
      }
      const prev = seen.get(rec.caseNo);
      if (prev) warnings.push(`ケースNoが重なっている: ${rec.caseNo}（${prev} と ${rec.file}）`);
      seen.set(rec.caseNo, rec.file);
      cases.push(rec);
    }
    cases.sort((a, b) => a.caseNo.localeCompare(b.caseNo));
    const counts: Record<Verdict, number> = { OK: 0, NG: 0, 未実施: 0 };
    for (const c of cases) counts[c.result]++;

    mkdirSync(REPORT_DIR, { recursive: true });
    const out = path.join(REPORT_DIR, 'results.json');
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          generatedAt: jst(new Date()).at,
          status: result.status,
          tester: this.tester,
          commits: this.commits,
          counts,
          warnings,
          runErrors: this.runErrors,
          cases,
        },
        null,
        2,
      )}\n`,
    );
    console.error(`[acceptance] ${out} を書きました（OK ${counts.OK} / NG ${counts.NG} / 未実施 ${counts['未実施']}）`);
    for (const w of warnings) console.error(`[acceptance] 注意: ${w}`);
    if (this.commits.appSameAsMain === false) {
      console.error(`[acceptance] 注意: server/・web/src/ が本線（${this.commits.mainRef} との分岐点）と違います。試験した版を確かめてください`);
    }
  }
}
