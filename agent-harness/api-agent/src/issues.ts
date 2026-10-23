/**
 * (a) 開いている Issue を古い順に、1件ずつ worktree を作ってエージェントに直させ、PR にする。
 * 選ぶ・worktree を作る・結果を集めるのはコード。直す・閉じる・PR を出すのはエージェント。
 */
import fs from 'node:fs';
import path from 'node:path';
import { finalLine, fillTemplate, readPrompt, runAgent, type AgentContext } from './agent.ts';
import type { Args } from './args.ts';
import { BASE_BRANCH, MAX_TURNS, QUERY_TIMEOUT_MIN, SCRIPTS_DIR, issueBranch, issueWorktreeName, worktreeRoot } from './config.ts';
import { redact, usd, type Budget, type ItemRecord } from './report.ts';
import { selectIssues } from './select.ts';
import {
  addIssueWorktree,
  fetchOrigin,
  issueState,
  listOpenIssues,
  listOpenPrs,
  localCiCommand,
  prsFromBranch,
  revParse,
  slash,
  viewIssue,
  type IssueDetail,
} from './shell.ts';

export async function runIssues(args: Args, budget: Budget, ctx: AgentContext): Promise<void> {
  const { log, repoRoot, mainRoot } = ctx;
  const [issues, prs] = await Promise.all([listOpenIssues(repoRoot), listOpenPrs(repoRoot)]);
  const sel = selectIssues(issues, prs, { only: args.issue });
  for (const s of sel.skipped) log.skipped.push({ kind: 'issue', ...s });

  console.log(`\n■ Issue：開いている ${issues.length} 件・選んだ ${sel.picked.length} 件・飛ばした ${sel.skipped.length} 件`);
  for (const s of sel.skipped) console.log(`  - 飛ばす #${s.number}：${s.reason}`);
  sel.picked.forEach((i, k) => console.log(`  ${k + 1}. #${i.number} ${i.title}`));

  const root = worktreeRoot(mainRoot);
  if (args.dryRun) {
    log.note(`選んだ Issue（--dry-run なので扱っていない）：${sel.picked.length ? sel.picked.map((i) => `#${i.number}`).join(' → ') : '0 件'}`);
    for (const issue of sel.picked) {
      const detail = await viewIssue(issue.number, repoRoot);
      const wt = path.join(root, issueWorktreeName(issue.number));
      console.log(`\n───── Issue #${issue.number} に渡す頼みの文（--dry-run。worktree は作らない：${wt}）─────`);
      console.log(redact(issuePrompt(detail, wt, path.join(log.dir, `ci-issue-${issue.number}`), path.join(log.dir, `scratch-issue-${issue.number}`))));
    }
    return;
  }

  if (sel.picked.length > 0) await fetchOrigin(repoRoot);
  for (const issue of sel.picked) {
    if (!budget.canStartItem()) {
      log.stopReason = `1回の上限（${usd(budget.maxUsd)}）に届いたので、Issue #${issue.number} から先は扱わなかった`;
      break;
    }
    const rec: ItemRecord = { kind: 'issue', number: issue.number, title: issue.title, outcome: '', url: issue.url, costUsd: 0, notes: [] };
    log.items.push(rec);
    console.log(`\n▶ Issue #${issue.number} ${issue.title}`);
    try {
      await handleIssue(issue.number, rec, root, args, budget, ctx);
    } catch (e) {
      rec.outcome = '止めた（コードの失敗）';
      rec.notes.push(redact(e instanceof Error ? e.message : String(e)));
    }
    console.log(`  → ${rec.outcome}（${usd(rec.costUsd)}）`);
    log.write(budget);
  }
}

async function handleIssue(n: number, rec: ItemRecord, root: string, args: Args, budget: Budget, ctx: AgentContext): Promise<void> {
  const { repoRoot } = ctx;
  const branch = issueBranch(n);
  const wt = path.join(root, issueWorktreeName(n));
  if (fs.existsSync(wt)) {
    rec.outcome = '飛ばした（前の実行の worktree が残っている）';
    rec.notes.push(`${wt} を持ち主が見て、要らなければ消す`);
    return;
  }
  if ((await revParse(`refs/heads/${branch}`, repoRoot)) || (await revParse(`refs/remotes/origin/${branch}`, repoRoot))) {
    rec.outcome = `飛ばした（ブランチ ${branch} が残っている）`;
    return;
  }
  const cap = budget.capForCall(0);
  if (cap === 0) {
    rec.outcome = '飛ばした（上限の残りが無い）';
    return;
  }
  fs.mkdirSync(root, { recursive: true });
  await addIssueWorktree(repoRoot, wt, branch);
  rec.notes.push(`worktree：${wt}（ブランチ ${branch}）`);

  const detail = await viewIssue(n, repoRoot);
  const scratch = path.join(ctx.log.dir, `scratch-issue-${n}`);
  fs.mkdirSync(scratch, { recursive: true });
  const res = await runAgent(
    {
      kind: 'issue',
      label: `issue#${n}`,
      prompt: issuePrompt(detail, wt, path.join(ctx.log.dir, `ci-issue-${n}`), scratch),
      cwd: wt,
      maxUsd: cap,
      maxTurns: MAX_TURNS.issue,
      timeoutMin: QUERY_TIMEOUT_MIN.issue,
      effort: args.effort,
      allowPush: true,
      allowGhWrite: true,
    },
    ctx,
  );
  budget.add(res.costUsd);
  rec.costUsd += res.costUsd;
  if (res.errors.length) rec.notes.push(...res.errors.map((e) => `エージェント：${e}`));

  // 結果はコードが GitHub を見て決める（モデルの言葉だけを信じない）
  const opened = await prsFromBranch(branch, repoRoot);
  const state = await issueState(n, repoRoot);
  const said = finalLine(res.resultText, '結果');
  if (said) rec.notes.push(`エージェントの最後の行：結果: ${said}`);
  if (opened[0]) {
    rec.outcome = opened[0].isDraft ? `下書きの PR #${opened[0].number}（止まった）` : `PR #${opened[0].number}`;
    rec.url = opened[0].url;
  } else if (state === 'CLOSED') {
    rec.outcome = '閉じた（本線で直っていた）';
  } else {
    rec.outcome = `止めた（PR は出ていない。${res.subtype}）`;
  }
}

export function issuePrompt(d: IssueDetail, wt: string, ciLogDir: string, scratch: string): string {
  const comments = d.comments.length
    ? d.comments.map((c) => `#### ${c.author?.login ?? '（不明）'}（${c.createdAt}）\n\n${c.body}`).join('\n\n')
    : '（コメントは無い）';
  return fillTemplate(readPrompt('issue'), {
    ISSUE_NUMBER: String(d.number),
    ISSUE_TITLE: d.title,
    ISSUE_URL: d.url,
    ISSUE_BODY: d.body || '（本文は無い）',
    ISSUE_COMMENTS: comments,
    WORKTREE: slash(wt),
    BRANCH: issueBranch(d.number),
    BASE: BASE_BRANCH,
    LOCAL_CI: localCiCommand(wt, ciLogDir),
    CI_LOG_DIR: slash(ciLogDir),
    SCRATCH: slash(scratch),
    HEAVY: slash(path.join(SCRIPTS_DIR, 'heavy.sh')),
  });
}
