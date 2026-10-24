/**
 * (b) 開いている PR を古い順に、本線を取り込み、手元の CI で確かめてマージする。流れはコードが決める。
 * モデルを呼ぶのは、ぶつかりを解くときと、CI の落ちを見立てて直すときだけ。
 * 1本ごとの流れ（handlePr）は queue（src/queue.ts、マージ係の代わり）も使う。
 */
import fs from 'node:fs';
import path from 'node:path';
import { finalLine, fillTemplate, readPrompt, runAgent, type AgentContext, type AgentOutcome } from './agent.ts';
import type { Args } from './args.ts';
import { BASE_BRANCH, LOCAL_CI_TIMEOUT_MIN, MAINLINE_RETRIES, MAX_TURNS, MODEL, QUERY_TIMEOUT_MIN, SCRIPTS_DIR, STATUS_CONTEXT, prWorktreeName, worktreeRoot } from './config.ts';
import { redact, usd, type Budget, type ItemRecord } from './report.ts';
import { checksAllSuccess, planPrs, type BaseState, type PrInfo, type PrPlanItem } from './select.ts';
import {
  abortMerge,
  addPrWorktree,
  baseStateOf,
  ciSummary,
  commentPr,
  commitsAhead,
  fetchOrigin,
  headSha,
  isCleanWorktree,
  listOpenPrs,
  mergeFinished,
  mergeMainline,
  mergePr,
  postCommitStatus,
  pushHead,
  repoInfo,
  resetPrWorktree,
  retargetToBase,
  revParse,
  run,
  runLocalCi,
  slash,
  type CiResult,
  type RunResult,
} from './shell.ts';
import { failedJobs, PrCiStatus } from './status.ts';

export const MAX_PASSES = 3;

/** 1本ごとの流れの選び方（merge と queue で違うところ） */
export interface PrFlowOptions {
  /** モデルを呼ぶか。false なら、ぶつかり・CI の落ちでモデルを呼ばずに止める（queue でキーが無い・--no-model のとき） */
  useModel: boolean;
  /** 手元の CI の結果を commit status で付ける先（owner/name）。無ければ付けない */
  statusRepo?: string;
  /** 押す木が `.github/` を変えていたら入れない（queue。モデルがぶつかりや CI の直しでワークフローを変えたときの守り） */
  blockWorkflow?: boolean;
  /** マージしたあとのコメントの1行め */
  mergedBy?: string;
  /**
   * 押す直前に見直す（queue。手元の CI のあいだにラベルが外された・下書きになったなど）。入れないなら、わけを返す。
   * 入れないときは kind 'other'（ラベルはそのまま）。merge-queue.sh の finish と同じ
   */
  beforeMerge?: () => Promise<string | undefined>;
}

/** 1本ごとの流れの結果（queue が「マージ止め」にするかを決める）。どれも rec.outcome に日本語の結果を書いてある */
export type PrFlowResult =
  /** ci：押した木（head）で回して通った手元の CI（--trust-gh-checks で省いたときは無い） */
  | { kind: 'merged'; head: string; ci?: CiResult }
  /** ぶつかりを解けなかった（tried：モデルに解かせたか） */
  | { kind: 'conflict'; files: string[]; tried: boolean; said?: string }
  /** 手元の CI が赤のまま（tested：回した commit、base：合わせた本線） */
  | { kind: 'ci'; failed: string; summary: string; tested: string; base: string; tried: boolean; said?: string }
  /** 押す木が .github/ を変えている（blockWorkflow のときだけ） */
  | { kind: 'workflow'; files: string[] }
  /** それ以外（上限・push・gh pr merge・本線が進み続けた・前の worktree など）。PR のせいとは限らないので、queue はラベルを変えない */
  | { kind: 'other' };

export async function runMerge(args: Args, budget: Budget, ctx: AgentContext): Promise<void> {
  const { log, repoRoot } = ctx;
  const handled = new Set<number>();
  const statusRepo = args.dryRun ? undefined : (await repoInfo(repoRoot)).nameWithOwner;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (!args.dryRun) await fetchOrigin(repoRoot);
    const prs = await listOpenPrs(repoRoot);
    const bases = [...new Set(prs.filter((p) => p.baseRefName !== BASE_BRANCH).map((p) => p.baseRefName))];
    const baseStates: Record<string, BaseState> = Object.fromEntries(await Promise.all(bases.map(async (b) => [b, await baseStateOf(b, repoRoot)])));
    const plan = planPrs(prs, baseStates, { only: args.pr, exclude: [...handled] });

    if (pass === 1) {
      console.log(`\n■ PR：開いている ${prs.length} 件・選んだ ${plan.picked.length} 件・飛ばした ${plan.skipped.length} 件`);
      for (const d of plan.duplicates) {
        const text = `同じ Issue #${d.issue} を閉じる PR が ${d.prs.length} 本ある：${d.prs.map((n) => `#${n}`).join('・')}（閉じずに、持ち主が選ぶ）`;
        console.log(`  ! ${text}`);
        log.note(text);
      }
      for (const s of plan.skipped) log.skipped.push({ kind: 'pr', ...s });
      for (const s of plan.skipped) console.log(`  - 飛ばす #${s.number}：${s.reason}`);
    } else {
      console.log(`\n■ PR（${pass} 周め。土台が入って、積み重ねの PR が扱えるようになったか見直した）：選んだ ${plan.picked.length} 件`);
    }
    plan.picked.forEach((it, k) => console.log(`  ${k + 1}. #${it.pr.number} ${it.pr.title}${it.retarget ? `（base を ${it.pr.baseRefName} → ${BASE_BRANCH} へ向け直す）` : ''}`));

    if (args.dryRun) {
      const order = plan.picked.map((it) => `#${it.pr.number}${it.retarget ? '（base を向け直す）' : ''}`);
      log.note(`選んだ PR（--dry-run なので扱っていない）：${order.length ? order.join(' → ') : '0 件'}`);
      printDryRunPrompts(plan.picked, ctx);
      return;
    }

    let merged = 0;
    for (const item of plan.picked) {
      if (!budget.canStartItem()) {
        log.stopReason = `1回の上限（${usd(budget.maxUsd)}）に届いたので、PR #${item.pr.number} から先は扱わなかった`;
        finish(log, handled);
        return;
      }
      handled.add(item.pr.number);
      const rec: ItemRecord = { kind: 'pr', number: item.pr.number, title: item.pr.title, outcome: '', url: item.pr.url, costUsd: 0, notes: [] };
      log.items.push(rec);
      console.log(`\n▶ PR #${item.pr.number} ${item.pr.title}`);
      try {
        await handlePr(item, rec, args, budget, ctx, { useModel: true, statusRepo });
      } catch (e) {
        rec.outcome = rec.outcome || '止めた（コードの失敗）';
        rec.notes.push(redact(e instanceof Error ? e.message : String(e)));
      }
      if (rec.outcome === 'マージした') merged++;
      console.log(`  → ${rec.outcome}（${usd(rec.costUsd)}）`);
      log.write(budget);
    }
    const waiting = plan.skipped.some((s) => s.reason.includes('PR がまだ開いている'));
    if (merged === 0 || !waiting) break;
  }
  finish(log, handled);
}

/** 2周め以降に扱った PR は「飛ばしたもの」から外す */
function finish(log: AgentContext['log'], handled: Set<number>): void {
  const keep = log.skipped.filter((s) => !(s.kind === 'pr' && handled.has(s.number)));
  log.skipped.splice(0, log.skipped.length, ...keep);
}

/**
 * PR 1本：worktree・本線の取り込み・手元の CI・push・`gh pr merge --merge --match-head-commit`。
 * squash・rebase・--admin・--delete-branch は使わない。
 */
export async function handlePr(item: PrPlanItem, rec: ItemRecord, args: Args, budget: Budget, ctx: AgentContext, opts: PrFlowOptions): Promise<PrFlowResult> {
  const { log, repoRoot, mainRoot } = ctx;
  const pr = item.pr;
  const n = pr.number;
  const wt = path.join(worktreeRoot(mainRoot), prWorktreeName(n));
  let itemSpent = 0;
  const statusRepo = opts.statusRepo;
  const status = statusRepo
    ? new PrCiStatus((sha, state, desc) => postCommitStatus(statusRepo, sha, state, STATUS_CONTEXT, desc, repoRoot), rec.notes)
    : undefined;

  const callAgent = async (kind: 'conflict' | 'ci', label: string, prompt: string): Promise<AgentOutcome | undefined> => {
    const cap = budget.capForCall(itemSpent);
    if (cap === 0) return undefined;
    const res = await runAgent(
      { kind, label, prompt, cwd: wt, maxUsd: cap, maxTurns: MAX_TURNS[kind], timeoutMin: QUERY_TIMEOUT_MIN[kind], effort: args.effort, allowPush: false, allowGhWrite: false },
      ctx,
    );
    budget.add(res.costUsd);
    itemSpent += res.costUsd;
    rec.costUsd = itemSpent;
    if (res.errors.length) rec.notes.push(...res.errors.map((e) => `エージェント（${label}）：${e}`));
    return res;
  };

  if (item.retarget) {
    await retargetToBase(n, repoRoot);
    rec.notes.push(`土台の PR が入っていたので、base を ${pr.baseRefName} から ${BASE_BRANCH} へ向け直した`);
  }

  // worktree（前の実行のものがきれいなら使い直す）
  if (fs.existsSync(wt)) {
    if (!(await isCleanWorktree(wt))) {
      rec.outcome = '飛ばした（前の実行の worktree に変更が残っている）';
      rec.notes.push(`${wt} を持ち主が見る`);
      return { kind: 'other' };
    }
    await resetPrWorktree(wt, pr.headRefName);
  } else {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    await addPrWorktree(repoRoot, wt, pr.headRefName);
  }
  rec.notes.push(`worktree：${wt}（PR のブランチ ${pr.headRefName} の先を、切り離した HEAD で開いた）`);

  let ciNote = '';
  let lastCi: CiResult | undefined;
  for (let attempt = 0; attempt <= MAINLINE_RETRIES; attempt++) {
    const mainBefore = await revParse(`origin/${BASE_BRANCH}`, repoRoot);

    // 2. 本線を取り込む
    const m = await mergeMainline(wt);
    if (m.outcome === 'conflict') {
      console.log(`  ぶつかった：${m.conflicts.join('、')}`);
      if (!opts.useModel) {
        await abortMerge(wt);
        rec.outcome = '止めた（ぶつかった。モデルを呼ばずに回しているので、解かない）';
        rec.notes.push(`ぶつかったファイル：${m.conflicts.join('、')}`);
        return { kind: 'conflict', files: m.conflicts, tried: false };
      }
      const res = await callAgent('conflict', `pr#${n}-conflict-${attempt}`, conflictPrompt(pr, wt, m.conflicts));
      if (!res) {
        await abortMerge(wt);
        rec.outcome = '止めた（ぶつかったが、上限の残りが無い）';
        return { kind: 'other' };
      }
      if (!(await mergeFinished(wt)) || !(await isCleanWorktree(wt))) {
        await abortMerge(wt);
        rec.outcome = '止めた（ぶつかりを解けなかった。取り込みはやめた）';
        rec.notes.push(`ぶつかったファイル：${m.conflicts.join('、')}`);
        const said = finalLine(res.resultText, '結果');
        if (said) rec.notes.push(`エージェント：結果: ${said}`);
        return { kind: 'conflict', files: m.conflicts, tried: true, said };
      }
      rec.notes.push(`本線を取り込んで、ぶつかり（${m.conflicts.join('、')}）をエージェントが解いた`);
    } else if (m.outcome === 'merged') {
      rec.notes.push('本線を取り込んだ（ぶつかりなし）');
    }

    // 3. 手元の CI
    const ahead = await commitsAhead(wt, `origin/${pr.headRefName}`);
    const sameHead = (await headSha(wt)) === pr.headRefOid;
    if (args.trustGhChecks && ahead === 0 && sameHead && checksAllSuccess(pr.statusCheckRollup)) {
      ciNote = 'GitHub の CI がすべて success で、取り込みも直しも要らなかったので、手元の CI は省いた（--trust-gh-checks）';
      lastCi = undefined;
    } else {
      const ci = await ciWithFix(pr, wt, attempt, rec, callAgent, ctx, opts.useModel, status, mainBefore ?? '');
      if (!ci.ok) return ci.result;
      lastCi = ci.result;
      ciNote = `手元の CI（scripts/local-ci.sh・本線と合わせた形・head ${ci.result.head?.slice(0, 7) ?? '?'}）：${ciSummary(ci.result)}`;
    }
    rec.notes.push(ciNote);

    // 4. commit が増えたら push（force しない）
    if (!(await isCleanWorktree(wt))) {
      rec.outcome = '止めた（worktree に commit していない変更が残った）';
      return { kind: 'other' };
    }
    if (opts.blockWorkflow) {
      // 押す木（本線を取り込んだ形）が .github/ を変えていないか。モデルがぶつかりや CI の直しでワークフローを変えたときも入れない
      const d = await run('git', ['diff', '--name-only', '--no-renames', `origin/${BASE_BRANCH}...HEAD`], { cwd: wt });
      if (d.code !== 0) {
        rec.outcome = '止めた（押す木が .github/ を変えているかを、git diff で確かめられなかった）';
        rec.notes.push(redact((d.stderr || d.stdout).trim().slice(0, 300)));
        return { kind: 'other' };
      }
      const wf = d.stdout.split(/\r?\n/).filter((f) => f.startsWith('.github/'));
      if (wf.length) {
        rec.outcome = '止めた（押す木が .github/ を変えている）';
        rec.notes.push(`.github/ の変更：${wf.join('、')}`);
        return { kind: 'workflow', files: wf };
      }
    }
    const toPush = await commitsAhead(wt, `origin/${pr.headRefName}`);
    if (toPush > 0) {
      const p = await pushHead(wt, pr.headRefName);
      if (p.code !== 0) {
        rec.outcome = '止めた（push できなかった。PR のブランチが先へ進んだかもしれない）';
        rec.notes.push(redact(p.stderr.trim().slice(0, 400)));
        return { kind: 'other' };
      }
      rec.notes.push(`${toPush} 個の commit を ${pr.headRefName} へ push した`);
      await status?.afterPush(await headSha(wt));
    }

    // 5. マージの直前に、本線が進んでいないかを見る
    await fetchOrigin(repoRoot);
    const mainNow = await revParse(`origin/${BASE_BRANCH}`, repoRoot);
    if (mainNow !== mainBefore) {
      if (attempt < MAINLINE_RETRIES) {
        rec.notes.push('マージの直前に本線が進んでいたので、取り込みからやり直す');
        continue;
      }
      rec.outcome = `止めた（本線が進み続けた。${MAINLINE_RETRIES} 回やり直した）`;
      return { kind: 'other' };
    }

    // 6. マージ（merge commit・head の一致を確かめて）
    const head = await headSha(wt);
    if ((await revParse(`origin/${pr.headRefName}`, repoRoot)) !== head) {
      rec.outcome = '止めた（PR のブランチの先が、確かめたものと違う）';
      return { kind: 'other' };
    }
    if (opts.beforeMerge) {
      const why = await opts.beforeMerge();
      if (why) {
        rec.outcome = `入れなかった（${why}）`;
        return { kind: 'other' };
      }
    }
    const r = await mergeWithRetry(n, head, repoRoot);
    if (r.code !== 0) {
      rec.outcome = '止めた（gh pr merge が通らなかった）';
      rec.notes.push(redact((r.stderr || r.stdout).trim().slice(0, 500)));
      return { kind: 'other' };
    }
    rec.outcome = 'マージした';
    try {
      await commentPr(n, mergeComment(head, rec, ciNote, itemSpent, opts.mergedBy), path.join(log.dir, `comment-pr-${n}.md`), repoRoot);
    } catch (e) {
      rec.notes.push(`コメントを書けなかった：${redact(e instanceof Error ? e.message : String(e))}`);
    }
    // 押した木で通した CI だけを返す（回した commit と押した head が同じとき）
    return { kind: 'merged', head, ci: lastCi && lastCi.head === head ? lastCi : undefined };
  }
  // ここへは来ない（ループの最後の回は、マージするか return する）
  return { kind: 'other' };
}

type CallAgent = (kind: 'conflict' | 'ci', label: string, prompt: string) => Promise<AgentOutcome | undefined>;

/** 手元の CI を1回回す。status があれば、回し始めに pending、終わりに success か failure を付ける */
async function runCiWithStatus(wt: string, logDir: string, pr: PrInfo, status: PrCiStatus | undefined, base: string): Promise<CiResult> {
  const timeout = LOCAL_CI_TIMEOUT_MIN * 60_000;
  const tested = await headSha(wt);
  const onGitHub = (await commitsAhead(wt, `origin/${pr.headRefName}`)) === 0;
  const prHead = (await revParse(`origin/${pr.headRefName}`, wt)) ?? pr.headRefOid;
  const where = `本線 ${base.slice(0, 7)} と合わせた ${tested.slice(0, 7)}`;
  await status?.start(tested, onGitHub, prHead, where);
  const ci = await runLocalCi(wt, logDir, timeout);
  await status?.end(tested, onGitHub, ci, where);
  return ci;
}

type CiOutcome = { ok: true; result: CiResult } | { ok: false; result: PrFlowResult };

/** CI を回し、落ちたらエージェントに見立てさせ、1回だけ回し直す（useModel が false なら見立てずに止める） */
async function ciWithFix(
  pr: PrInfo,
  wt: string,
  attempt: number,
  rec: ItemRecord,
  callAgent: CallAgent,
  ctx: AgentContext,
  useModel: boolean,
  status: PrCiStatus | undefined,
  base: string,
): Promise<CiOutcome> {
  console.log('  手元の CI を回す（鍵の順番待ちを含む）');
  const first = await runCiWithStatus(wt, path.join(ctx.log.dir, `ci-pr-${pr.number}-${attempt}a`), pr, status, base);
  if (first.ok) return { ok: true, result: first };
  rec.notes.push(`手元の CI が落ちた：${ciSummary(first)}`);
  console.log(`  CI が落ちた：${ciSummary(first)}`);
  const red = async (r: CiResult, tried: boolean, said?: string): Promise<CiOutcome> => ({
    ok: false,
    result: { kind: 'ci', failed: failedJobs(r), summary: ciSummary(r), tested: r.head ?? (await headSha(wt)), base, tried, said },
  });

  if (!useModel) {
    rec.outcome = '止めた（手元の CI が落ちた。モデルを呼ばずに回しているので、見立てない）';
    return red(first, false);
  }
  const res = await callAgent('ci', `pr#${pr.number}-ci-${attempt}`, ciPrompt(pr, wt, first));
  if (!res) {
    rec.outcome = '止めた（CI が落ちたが、上限の残りが無い）';
    return { ok: false, result: { kind: 'other' } };
  }
  const verdict = finalLine(res.resultText, '判定') ?? '';
  rec.notes.push(`エージェントの見立て：判定: ${verdict || '（最後の行が無い）'}`);
  if (!verdict.startsWith('回し直す') && !verdict.startsWith('直した')) {
    rec.outcome = `止めた（CI の落ちを直せなかった${verdict ? `：${verdict}` : ''}）`;
    return red(first, true, verdict || undefined);
  }
  if (!(await isCleanWorktree(wt))) {
    rec.outcome = '止めた（直したが commit していない変更が残った）';
    return red(first, true, verdict);
  }
  console.log(`  ${verdict.startsWith('直した') ? '直したので' : '時々落ちるテストと見立てたので'}、もう一度回す`);
  const second = await runCiWithStatus(wt, path.join(ctx.log.dir, `ci-pr-${pr.number}-${attempt}b`), pr, status, base);
  if (second.ok) return { ok: true, result: second };
  rec.outcome = `止めた（回し直しても CI が落ちた：${ciSummary(second)}）`;
  return red(second, true, verdict);
}

/** 押した直後は GitHub が head を受け取っていないことがあるので、少し待って何回か試す */
async function mergeWithRetry(n: number, head: string, cwd: string): Promise<RunResult> {
  let last: RunResult = { code: 1, stdout: '', stderr: '' };
  for (let i = 0; i < 4; i++) {
    last = await mergePr(n, head, cwd);
    if (last.code === 0) return last;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return last;
}

function mergeComment(head: string, rec: ItemRecord, ciNote: string, spent: number, mergedBy?: string): string {
  return [
    mergedBy ? `${mergedBy}（merge commit・head \`${head}\`）。` : `api-agent（${MODEL}）がマージした（merge commit・head \`${head}\`）。`,
    '',
    ...rec.notes.filter((t) => !t.startsWith('worktree：')).map((t) => `- ${t}`),
    `- 費用（SDK の見積もり）：${usd(spent)}`,
    '',
    ciNote ? '' : '（手元の CI の結果は残っていない）',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}

export function conflictPrompt(pr: PrInfo, wt: string, conflicts: string[]): string {
  return fillTemplate(readPrompt('merge-conflict'), {
    PR_NUMBER: String(pr.number),
    PR_TITLE: pr.title,
    PR_URL: pr.url ?? '',
    PR_BODY: pr.body || '（本文は無い）',
    HEAD_BRANCH: pr.headRefName,
    BASE: BASE_BRANCH,
    WORKTREE: slash(wt),
    CONFLICT_FILES: conflicts.map((f) => `- ${f}`).join('\n'),
    HEAVY: slash(path.join(SCRIPTS_DIR, 'heavy.sh')),
  });
}

export function ciPrompt(pr: PrInfo, wt: string, ci: CiResult): string {
  return fillTemplate(readPrompt('ci-failure'), {
    PR_NUMBER: String(pr.number),
    PR_TITLE: pr.title,
    PR_URL: pr.url ?? '',
    HEAD_BRANCH: pr.headRefName,
    BASE: BASE_BRANCH,
    WORKTREE: slash(wt),
    CI_RESULT: ci.steps.map((s) => `- ${s.name}=${s.status}`).join('\n'),
    CI_LOG_DIR: slash(ci.logDir),
    HEAVY: slash(path.join(SCRIPTS_DIR, 'heavy.sh')),
  });
}

function printDryRunPrompts(picked: PrPlanItem[], ctx: AgentContext): void {
  const first = picked[0];
  if (!first) return;
  const wt = path.join(worktreeRoot(ctx.mainRoot), prWorktreeName(first.pr.number));
  console.log(`\n───── ぶつかったときに渡す頼みの文（PR #${first.pr.number} の例。--dry-run なのでファイルは仮）─────`);
  console.log(redact(conflictPrompt(first.pr, wt, ['（ぶつかったファイルが、ここに入る）'])));
  const fake: CiResult = { ok: false, steps: [{ name: '（落ちたもの）', status: 'FAIL' }], logDir: path.join(ctx.log.dir, `ci-pr-${first.pr.number}-0a`) };
  console.log(`\n───── 手元の CI が落ちたときに渡す頼みの文（PR #${first.pr.number} の例）─────`);
  console.log(redact(ciPrompt(first.pr, wt, fake)));
  if (picked.length > 1) console.log(`\n（ほかの ${picked.length - 1} 件も、番号とブランチが変わるだけの同じ形）`);
}
