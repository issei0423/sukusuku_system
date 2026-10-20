/*
 * アクセシビリティの自動検査（axe）。scenarios.ts の全場面に axe を掛ける。
 * 基準は WCAG 2.2 AA を目安にする。【仮置き】設計書に適合の水準の定めが無い（web/仮置き値.md）
 *
 * - 影響が critical・serious の違反が、既知の一覧（a11y-known.ts）に無ければ落とす
 * - moderate・minor は落とさずに一覧（a11y-report/summary.md）へ出す
 * - axe が自動で判定できる範囲だけを見る。読み上げの聞こえ方や、操作の分かりやすさは人が確かめる
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { scenarios, REVIEW_TIME } from './scenarios';
import { ready, performAction } from './steps';
import { findKnownA11yViolation, type A11yViolationSummary } from './a11y-known';

/** WCAG 2.0・2.1・2.2 の A と AA。axe の規則に付いているタグで選ぶ */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BLOCKING_IMPACTS = new Set(['critical', 'serious']);

for (const scenario of scenarios) {
  const group = scenario.role === 'admin' || scenario.role === 'teacher' ? 'staff' : scenario.role;
  test(`[${group}] ${scenario.id} — ${scenario.name}`, async ({ page }, testInfo) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    // HTTP API を誤って使っていれば、実データへ届く前に止める（review.spec.ts と同じ）
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      runtimeErrors.push(`検査中に HTTP API が呼ばれました: ${route.request().url()}`);
      await route.abort();
    });
    await page.clock.setFixedTime(new Date(REVIEW_TIME));
    await page.goto(`/tests/responsive/harness.html?scene=${scenario.id}`);
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-review-route', scenario.path);
    await expect(page.locator('#root')).not.toBeEmpty();
    await performAction(page, scenario, false);
    await ready(page);

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    const violations: A11yViolationSummary[] = results.violations.map((v) => ({
      rule: v.id,
      impact: v.impact ?? 'unknown',
      count: v.nodes.length,
      help: v.help,
      helpUrl: v.helpUrl,
      targets: v.nodes.map((node) => node.target.join(' ')),
      knownIssue: findKnownA11yViolation(v.id, scenario.id)?.issue,
    }));
    await testInfo.attach('axe-results', {
      contentType: 'application/json',
      body: JSON.stringify({
        scenario: { id: scenario.id, name: scenario.name, path: scenario.path, role: scenario.role, action: scenario.action },
        axeVersion: results.testEngine.version,
        tags: WCAG_TAGS,
        violations,
        // 自動では決めきれず、人が見るもの（背景が画像のときのコントラストなど）
        incomplete: results.incomplete.map((v) => ({
          rule: v.id, impact: v.impact ?? 'unknown', count: v.nodes.length,
          targets: v.nodes.map((node) => node.target.join(' ')),
          reasons: [...new Set(v.nodes.flatMap((node) => [...node.any, ...node.all, ...node.none].map((check) => check.message)))],
        })),
        raw: results.violations,
      }, null, 2),
    });

    expect(runtimeErrors, 'ブラウザ実行エラー').toEqual([]);
    const blocking = violations.filter((v) => BLOCKING_IMPACTS.has(v.impact) && v.knownIssue === undefined);
    expect(blocking.map(({ rule, impact, count, help, targets }) => ({ rule, impact, count, help, targets })),
      '影響が critical・serious の違反（既知の一覧 a11y-known.ts に無いもの）').toEqual([]);
  });
}
