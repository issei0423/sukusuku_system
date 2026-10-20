/*
 * アクセシビリティの検査の一覧を web/a11y-report/ に書き出す。
 * - results.json … 場面 × 端末ごとの違反（axe の生の結果は Playwright のレポートの添付にある）
 * - summary.md  … 場面・規則・影響・件数の表と、規則ごとの合計
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestResult, FullResult, FullConfig, Suite, TestError } from '@playwright/test/reporter';
import { knownA11yViolations, type A11yViolationSummary } from './a11y-known';

interface Entry {
  project: string;
  title: string;
  status: string;
  error?: string;
  scene?: { id: string; name: string; path: string };
  violations: A11yViolationSummary[];
  incomplete: { rule: string; impact: string; count: number; targets?: string[]; reasons?: string[] }[];
}
const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor', 'unknown'];
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export default class A11yReporter implements Reporter {
  private entries: Entry[] = [];
  private out = path.resolve('a11y-report');
  private expected = 0;
  private runErrors: string[] = [];
  onBegin(_config: FullConfig, suite: Suite) {
    this.expected = suite.allTests().length;
    mkdirSync(this.out, { recursive: true });
  }
  onError(error: TestError) { this.runErrors.push(error.message ?? String(error.value)); }
  onTestEnd(test: TestCase, result: TestResult) {
    const entry: Entry = {
      project: test.parent.project()?.name ?? '', title: test.title, status: result.status,
      error: result.error?.message, violations: [], incomplete: [],
    };
    const attachment = result.attachments.find((a) => a.name === 'axe-results');
    if (attachment) {
      const data = JSON.parse((attachment.body ?? readFileSync(attachment.path!)).toString()) as {
        scenario: Entry['scene']; violations: A11yViolationSummary[]; incomplete: Entry['incomplete'];
      };
      entry.scene = data.scenario;
      entry.violations = data.violations;
      entry.incomplete = data.incomplete;
    }
    this.entries.push(entry);
  }
  onEnd(result: FullResult) {
    // 一覧だけを出したとき（--list）は、前の結果を消さない
    if (this.entries.length === 0 && this.runErrors.length === 0) return;
    mkdirSync(this.out, { recursive: true });
    this.entries.sort((a, b) => a.title.localeCompare(b.title) || a.project.localeCompare(b.project));
    const axeEntries = this.entries.filter((e) => e.scene);
    const failed = this.entries.filter((e) => e.status !== 'passed' && e.status !== 'skipped');

    // 規則ごとの合計（同じ場面を2つの端末で見たときは、場面を1つと数える）
    const byRule = new Map<string, { impact: string; nodes: number; scenes: Set<string>; known: Set<number>; help: string }>();
    for (const e of axeEntries) for (const v of e.violations) {
      const row = byRule.get(v.rule) ?? { impact: v.impact, nodes: 0, scenes: new Set(), known: new Set(), help: v.help };
      row.nodes += v.count;
      row.scenes.add(e.scene!.id);
      if (v.knownIssue !== undefined) row.known.add(v.knownIssue);
      byRule.set(v.rule, row);
    }
    // axe が自動では決めきれず、人が見るもの（背景が重なっているときのコントラストなど）
    const incomplete = new Map<string, { impact: string; nodes: number; scenes: Set<string> }>();
    for (const e of axeEntries) for (const v of e.incomplete) {
      const row = incomplete.get(v.rule) ?? { impact: v.impact, nodes: 0, scenes: new Set() };
      row.nodes += v.count;
      row.scenes.add(e.scene!.id);
      incomplete.set(v.rule, row);
    }
    const seen = new Set(axeEntries.flatMap((e) => e.violations.map((v) => `${v.rule}:${e.scene!.id}`)));
    const staleKnown = knownA11yViolations.filter((k) => axeEntries.length > 0 && !axeEntries.some((e) =>
      (k.scenes === '*' || k.scenes.includes(e.scene!.id)) && seen.has(`${k.rule}:${e.scene!.id}`)));

    writeFileSync(path.join(this.out, 'results.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), status: result.status, expected: this.expected, ran: this.entries.length,
      failed: failed.length, runErrors: this.runErrors, entries: this.entries,
    }, null, 2));

    const rules = [...byRule.entries()].sort((a, b) =>
      IMPACT_ORDER.indexOf(a[1].impact) - IMPACT_ORDER.indexOf(b[1].impact) || a[0].localeCompare(b[0]));
    const lines = [
      '# アクセシビリティの自動検査（axe）',
      '',
      `- 実行：${new Date().toISOString()}・状態 ${result.status}・${this.entries.length} / ${this.expected} 件・落ちた ${failed.length} 件`,
      '- 基準：WCAG 2.2 AA を目安（【仮置き】設計書に適合の水準の定めが無い）。タグ wcag2a・wcag2aa・wcag21a・wcag21aa・wcag22aa',
      '- 影響が critical・serious で、既知の一覧（tests/responsive/a11y-known.ts）に無いものがあると落ちる',
      '',
      '## 規則ごとの合計',
      '',
      '| 規則 | 影響 | 場面の数 | 件数（要素） | 既知 | 説明 |',
      '| :-- | :-- | --: | --: | :-- | :-- |',
      ...rules.map(([rule, r]) => `| ${rule} | ${r.impact} | ${r.scenes.size} | ${r.nodes} | ${[...r.known].map((n) => `#${n}`).join(' ') || '—'} | ${cell(r.help)} |`),
      ...(rules.length ? [] : ['| （違反なし） | | | | | |']),
      '',
      '## 場面ごと',
      '',
      '| 場面 | 端末 | 規則 | 影響 | 件数 | 既知 |',
      '| :-- | :-- | :-- | :-- | --: | :-- |',
      ...axeEntries.flatMap((e) => e.violations.map((v) =>
        `| ${e.scene!.id}（${cell(e.scene!.name)}） | ${e.project} | ${v.rule} | ${v.impact} | ${v.count} | ${v.knownIssue !== undefined ? `#${v.knownIssue}` : '—'} |`)),
      ...(axeEntries.some((e) => e.violations.length) ? [] : ['| （違反なし） | | | | | |']),
      '',
      '## 人が確かめるもの（axe が決めきれなかったもの。テストは落とさない）',
      '',
      '| 規則 | 影響 | 件数（要素） | 場面 |',
      '| :-- | :-- | --: | :-- |',
      ...[...incomplete.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([rule, r]) =>
        `| ${rule} | ${r.impact} | ${r.nodes} | ${[...r.scenes].sort().join('・')} |`),
      ...(incomplete.size ? [] : ['| （なし） | | | |']),
      '',
      '## 既知だが今回は出なかったもの（直っていれば a11y-known.ts から消す）',
      '',
      ...(staleKnown.length ? staleKnown.map((k) => `- ${k.rule}（${k.scenes === '*' ? 'すべての場面' : k.scenes.join('・')}）#${k.issue}`) : ['- なし']),
      '',
      '## 落ちたテスト',
      '',
      ...(failed.length ? failed.map((e) => `- ${e.project}：${cell(e.title)}`) : ['- なし']),
      ...this.runErrors.map((error) => `- 実行のエラー：${cell(error)}`),
      '',
    ];
    writeFileSync(path.join(this.out, 'summary.md'), lines.join('\n'));
    const blocking = rules.filter(([, r]) => r.impact === 'critical' || r.impact === 'serious');
    console.log(`\nアクセシビリティの検査: ${path.join(this.out, 'summary.md')}\n規則 ${rules.length} 種（うち critical・serious ${blocking.length} 種）・落ちた ${failed.length} 件`);
  }
}
