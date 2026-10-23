/**
 * review：開いている PR を読んでレビューし、コードが PR にコメントする。
 * Actions が止まっている間の、.github/workflows/claude-review.yml の代わり（README「review（PR のレビュー）」）。
 * 選ぶのも、worktree を作るのも、コメントを送るのもコード。モデルは読んで返事を書くだけ（allowPush: false、頼みの文でも書き込みを禁じる）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fillTemplate, readPrompt, runAgent, type AgentContext } from './agent.ts';
import type { Args } from './args.ts';
import { BASE_BRANCH, REVIEW_MAX_TURNS, REVIEW_TIMEOUT_MIN, SKIP_LABELS_REVIEW, reviewWorktreeName, worktreeRoot } from './config.ts';
import { redact, usd, type Budget, type ItemRecord } from './report.ts';
import { byOldest, type PrInfo, type Skipped } from './select.ts';
import { addDetachedWorktree, checkoutDetached, commentPr, fetchOrigin, headSha, isCleanWorktree, listOpenPrsWithComments, run } from './shell.ts';

// ───────────────────────── 印 ─────────────────────────

const MARKER_RE = /<!-- api-agent-review head=([0-9a-f]{40}) -->/g;

/** コメントの末尾に付ける印。40桁の sha でなければ止める */
export function reviewMarker(sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`先頭の commit の sha が40桁でない：${sha}`);
  return `<!-- api-agent-review head=${sha} -->`;
}

/** コメントの本文から、レビュー済みの先頭の commit（sha）を全部読み取る（40桁の小文字16進だけ） */
export function reviewedHeads(commentBodies: string[]): Set<string> {
  const found = new Set<string>();
  for (const body of commentBodies) for (const m of (body ?? '').matchAll(MARKER_RE)) found.add(m[1]!);
  return found;
}

// ───────────────────────── 選び方 ─────────────────────────

export type ReviewPr = PrInfo & { comments?: { body: string }[] };

export interface ReviewPlan {
  picked: ReviewPr[];
  skipped: Skipped[];
}

/** 開いている PR から、レビューするものを古い順に選ぶ。飛ばしたわけも返す */
export function planReviews(prs: ReviewPr[], opts: { only?: number; includeDrafts?: boolean; force?: boolean } = {}): ReviewPlan {
  const picked: ReviewPr[] = [];
  const skipped: Skipped[] = [];
  const pool = opts.only === undefined ? prs : prs.filter((p) => p.number === opts.only);
  if (opts.only !== undefined && pool.length === 0) skipped.push({ number: opts.only, reason: '開いている PR に無い' });
  for (const pr of [...pool].sort(byOldest)) {
    const label = pr.labels.map((l) => l.name).find((n) => SKIP_LABELS_REVIEW.includes(n));
    if (pr.isCrossRepository) skipped.push({ number: pr.number, reason: 'フォークからの PR' });
    else if (label) skipped.push({ number: pr.number, reason: `ラベル ${label}` });
    else if (pr.isDraft && !opts.includeDrafts && opts.only === undefined) skipped.push({ number: pr.number, reason: '下書き（--include-drafts か --pr N で見る）' });
    else if (!opts.force && reviewedHeads((pr.comments ?? []).map((c) => c.body)).has(pr.headRefOid)) {
      skipped.push({ number: pr.number, reason: `先頭 ${pr.headRefOid.slice(0, 8)} はレビュー済み（--force で見直す）` });
    } else picked.push(pr);
  }
  return { picked, skipped };
}

// ───────────────────────── コメント ─────────────────────────

/** GitHub のコメントの上限は 65536 字。余裕を見て切る */
export const MAX_COMMENT_CHARS = 60000;

/** PR へ送るコメントの本文：エージェントの最後の文（秘密を伏せる）＋ 費用の行 ＋ 印 */
export function buildReviewComment(resultText: string, sha: string, costUsd: number, env: NodeJS.ProcessEnv = process.env): string {
  let body = redact(resultText.trim(), env);
  if (body.length > MAX_COMMENT_CHARS) body = body.slice(0, MAX_COMMENT_CHARS) + '\n\n（長すぎるので、ここで切った）';
  return [body, '', '---', `API の Sonnet 5.5（api-agent）がレビューしました。費用 ${usd(costUsd)}・先頭 ${sha.slice(0, 8)}`, reviewMarker(sha), ''].join('\n');
}

/** .github/ を変える PR か（変えたファイルの一覧から） */
export const touchesWorkflows = (files: string[]): boolean => files.some((f) => f.startsWith('.github/'));

const WORKFLOW_NOTE = [
  '6. この PR は `.github/` を変えている。ワークフローの安全も見る',
  '   - きっかけ（`on:`）：フォークや外の人が動かせる `pull_request_target`・`issue_comment` などで、信用できない入力を使っていないか',
  '   - 権限（`permissions:`）：必要より広くないか。書き込みは必要なところだけか',
  '   - 秘密（`secrets.*`）：ログに出ない・フォークの PR に渡らないか。本文やブランチ名などを `run:` にそのまま埋めていないか（スクリプトの注入）',
  '   - self-hosted runner：信用できない PR のコードを自分の PC で動かしていないか',
  '',
].join('\n');

export function reviewPrompt(pr: ReviewPr, wt: string, workflowChange: boolean): string {
  return fillTemplate(readPrompt('review'), {
    PR_NUMBER: String(pr.number),
    PR_TITLE: pr.title,
    PR_URL: pr.url ?? '',
    HEAD_BRANCH: pr.headRefName,
    HEAD_SHA: pr.headRefOid,
    BASE: pr.baseRefName || BASE_BRANCH,
    WORKTREE: wt,
    WORKFLOW_NOTE: workflowChange ? WORKFLOW_NOTE : '',
  });
}

// ───────────────────────── 実行 ─────────────────────────

export async function runReview(args: Args, budget: Budget, ctx: AgentContext): Promise<void> {
  const { log, repoRoot, mainRoot } = ctx;
  if (!args.dryRun) await fetchOrigin(repoRoot);
  const prs = await listOpenPrsWithComments(repoRoot);
  const plan = planReviews(prs, { only: args.pr, includeDrafts: args.includeDrafts, force: args.force });
  console.log(`\n■ レビュー：開いている PR ${prs.length} 件・選んだ ${plan.picked.length} 件・飛ばした ${plan.skipped.length} 件`);
  for (const s of plan.skipped) log.skipped.push({ kind: 'review', ...s });
  for (const s of plan.skipped) console.log(`  - 飛ばす #${s.number}：${s.reason}`);
  plan.picked.forEach((p, k) => console.log(`  ${k + 1}. #${p.number} ${p.title}（先頭 ${p.headRefOid.slice(0, 8)}${p.isDraft ? '・下書き' : ''}）`));

  if (args.dryRun) {
    log.note(`選んだ PR（--dry-run なので扱っていない）：${plan.picked.map((p) => `#${p.number}`).join(' → ') || '0 件'}`);
    return;
  }
  for (const pr of plan.picked) {
    if (!budget.canStartItem()) {
      log.stopReason = `1回の上限（${usd(budget.maxUsd)}）に届いたので、PR #${pr.number} から先は見なかった`;
      return;
    }
    const rec: ItemRecord = { kind: 'review', number: pr.number, title: pr.title, outcome: '', url: pr.url, costUsd: 0, notes: [] };
    log.items.push(rec);
    console.log(`\n▶ PR #${pr.number} ${pr.title}`);
    try {
      await reviewOne(pr, rec, args, budget, ctx, mainRoot);
    } catch (e) {
      rec.outcome = rec.outcome || '止めた（コードの失敗）';
      rec.notes.push(redact(e instanceof Error ? e.message : String(e)));
    }
    console.log(`  → ${rec.outcome}（${usd(rec.costUsd)}）`);
    log.write(budget);
  }
}

async function reviewOne(pr: ReviewPr, rec: ItemRecord, args: Args, budget: Budget, ctx: AgentContext, mainRoot: string): Promise<void> {
  const { log, repoRoot } = ctx;
  const wt = path.join(worktreeRoot(mainRoot), reviewWorktreeName(pr.number));
  if (fs.existsSync(wt)) {
    if (!(await isCleanWorktree(wt))) {
      rec.outcome = '飛ばした（前の実行の worktree に変更が残っている）';
      rec.notes.push(`${wt} を持ち主が見る`);
      return;
    }
    await checkoutDetached(wt, pr.headRefOid);
  } else {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await addDetachedWorktree(repoRoot, wt, pr.headRefOid);
  }
  rec.notes.push(`worktree：${wt}（先頭 ${pr.headRefOid.slice(0, 8)} を、切り離した HEAD で開いた）`);

  const cap = budget.capForCall(0);
  if (cap === 0) {
    rec.outcome = '飛ばした（上限の残りが無い）';
    return;
  }
  const res = await runAgent(
    {
      kind: 'review',
      label: `review-pr${pr.number}`,
      prompt: reviewPrompt(pr, wt, await changesWorkflows(pr, wt)),
      cwd: wt,
      maxUsd: cap,
      maxTurns: REVIEW_MAX_TURNS,
      timeoutMin: REVIEW_TIMEOUT_MIN,
      effort: args.effort,
      allowPush: false,
    },
    ctx,
  );
  budget.add(res.costUsd);
  rec.costUsd = res.costUsd;
  rec.notes.push(...res.errors.map((e) => `エージェント：${e}`));
  if (!res.ok || res.resultText.trim() === '') {
    rec.outcome = `止めた（レビューが済まなかった：${res.subtype}・${res.turns} 往復）`;
    return;
  }
  if ((await headSha(wt)) !== pr.headRefOid || !(await isCleanWorktree(wt))) {
    rec.outcome = '止めた（worktree が動いたので、コメントしない）';
    return;
  }
  const body = buildReviewComment(res.resultText, pr.headRefOid, res.costUsd);
  await commentPr(pr.number, body, path.join(log.dir, `comment-review-pr-${pr.number}.md`), repoRoot);
  rec.outcome = `コメントした（${res.subtype}・${res.turns} 往復・先頭 ${pr.headRefOid.slice(0, 8)}）`;
}

async function changesWorkflows(pr: ReviewPr, wt: string): Promise<boolean> {
  const r = await run('git', ['diff', '--name-only', `origin/${pr.baseRefName}...HEAD`], { cwd: wt });
  return r.code === 0 && touchesWorkflows(r.stdout.split(/\r?\n/).filter(Boolean));
}
