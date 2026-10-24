/**
 * queue：マージ係（.github/workflows/merge.yml ＋ .github/scripts/merge-queue.sh）の代わりを、持ち主の PC で回す。
 * GitHub の runner の Actions が課金で動かないあいだ、持ち主が PR に付けたラベル「マージ」を、付けた順に 1 本ずつ入れる。
 * 持ち主の操作は今までと同じ（PR に「マージ」のラベル）。止める理由・コメントの文面・ラベルの扱いは merge-queue.sh に合わせた。
 *
 * - 拾う：開いている PR のうち、ラベル「マージ」を最後に付けた（labeled の）actor がリポジトリの持ち主のもの。並びはその時刻の順（同じなら番号の小さい順）
 * - 外す：持ち主でない人が付けた「マージ」は外してコメントする（merge-queue.sh の reject）
 * - 止める（「マージ」を外し「マージ止め」を付け、理由と直し方をコメント。列は次へ）：フォーク・下書き・.github/ を変える・変更を求めるレビュー・
 *   ぶつかりを解けない・手元の CI が赤
 * - 待つ（ラベルはそのまま）：base が本線でない PR。土台がマージ済みなら、merge と同じく向け直して扱う
 * - 1本ごとの中身は merge の流れ（src/merge.ts の handlePr）をそのまま使う
 * - 終わりに、本線の先頭に「手元の CI（持ち主の PC）」の status が無ければ、本線の先頭で手元の CI を回して付ける。赤なら Issue を立てる
 *
 * 判定（planQueue・precheck・文面）は GitHub を読まない純粋な関数にしてある（test/queue.test.ts）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentContext } from './agent.ts';
import type { Args } from './args.ts';
import {
  BASE_BRANCH,
  LOCAL_CI_TIMEOUT_MIN,
  MAIN_WORKTREE_NAME,
  MERGE_LABEL,
  MERGE_STOP_LABEL,
  STATUS_CONTEXT,
  mainRedIssueTitle,
  worktreeRoot,
} from './config.ts';
import { handlePr, MAX_PASSES, type PrFlowResult } from './merge.ts';
import { redact, usd, type Budget, type ItemRecord } from './report.ts';
import type { BaseState, PrInfo } from './select.ts';
import {
  addDetachedWorktree,
  baseStateOf,
  changesRequestedBy,
  checkoutDetached,
  ciSummary,
  commentPr,
  commitStatusOf,
  createIssue,
  editPrLabels,
  fetchOrigin,
  isCleanWorktree,
  issueEvents,
  listLabeledPrs,
  listOpenIssues,
  mainHeadSha,
  postCommitStatus,
  prFiles,
  repoInfo,
  runLocalCi,
  viewPr,
  type RepoInfo,
} from './shell.ts';
import { failedJobs, statusDescription } from './status.ts';

const short = (sha: string) => sha.slice(0, 7);

// ───────────────────────── 持ち主の確かめ ─────────────────────────

/**
 * merge・queue は持ち主の gh のアカウントでしか動かさない。いまのアカウント（me）と持ち主（owner）を比べ、
 * 動かしてはいけないなら日本語のわけを返す（よければ undefined）。GitHub のログインは大文字小文字を区別しない
 */
export function ownerCheck(command: string, me: string | undefined, owner: string | undefined): string | undefined {
  const tail = 'GitHub を読むだけの --dry-run なら、だれのアカウントでも動かせます。';
  if (!owner) return `${command} を止めた：リポジトリの持ち主が読めなかった（gh repo view）。${tail}`;
  if (!me) return `${command} を止めた：いまの gh のアカウントが分からない（gh auth status を確かめてください）。${command} はリポジトリの持ち主（${owner}）のアカウントでしか動かしません。${tail}`;
  if (me.toLowerCase() !== owner.toLowerCase()) {
    return [
      `${command} を止めた：${command} はリポジトリの持ち主（${owner}）の gh のアカウントでしか動かしません。いまのアカウントは ${me} です。`,
      'マージするかを決めるのは持ち主だけです（AGENTS.md「ブランチと PR」）。マージしてほしい PR は、持ち主に頼んでください。',
      tail,
    ].join('\n');
  }
  return undefined;
}

// ───────────────────────── 拾う・並べる ─────────────────────────

export interface LabelEvent {
  event: string;
  created_at: string;
  label?: { name?: string } | null;
  actor?: { login?: string } | null;
}

export interface LabelMark {
  /** 付けた人（記録に無ければ undefined） */
  actor: string | undefined;
  at: string;
}

/** ラベル label を最後に付けた labeled のイベント。無ければ undefined。時刻が同じなら、後ろに並んだもの */
export function lastLabeled(events: LabelEvent[], label: string = MERGE_LABEL): LabelMark | undefined {
  let best: { mark: LabelMark; t: number } | undefined;
  for (const e of events) {
    if (e.event !== 'labeled' || e.label?.name !== label) continue;
    const t = Date.parse(e.created_at);
    if (Number.isNaN(t)) continue;
    if (!best || t >= best.t) best = { mark: { actor: e.actor?.login || undefined, at: e.created_at }, t };
  }
  return best?.mark;
}

const sameLogin = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

export interface QueueEntry {
  pr: PrInfo;
  /** 持ち主がラベルを最後に付けた時刻 */
  at: string;
}

export interface QueuePlan {
  /** 持ち主が付けた順（同じ時刻なら番号の小さい順） */
  ordered: QueueEntry[];
  /** 持ち主でない人が最後に付けた（外してコメントする） */
  rejected: { pr: PrInfo; actor: string | undefined }[];
  /** イベントを読めなかった（外さずに、次の実行で見直す） */
  unreadable: { pr: PrInfo; reason: string }[];
}

/** ラベル「マージ」の付いた PR を、持ち主が付けたものだけ、付けた順に並べる */
export function planQueue(prs: PrInfo[], events: Map<number, LabelEvent[] | Error>, owner: string, opts: { exclude?: number[] } = {}): QueuePlan {
  const ordered: QueueEntry[] = [];
  const rejected: QueuePlan['rejected'] = [];
  const unreadable: QueuePlan['unreadable'] = [];
  for (const pr of prs) {
    if (!pr.labels.some((l) => l.name === MERGE_LABEL)) continue;
    if (opts.exclude?.includes(pr.number)) continue;
    const ev = events.get(pr.number);
    if (ev === undefined || ev instanceof Error) {
      unreadable.push({ pr, reason: ev instanceof Error ? ev.message : 'イベントを読んでいない' });
      continue;
    }
    const mark = lastLabeled(ev);
    if (mark && sameLogin(mark.actor, owner)) ordered.push({ pr, at: mark.at });
    else rejected.push({ pr, actor: mark?.actor });
  }
  ordered.sort((a, b) => {
    const t = Date.parse(a.at) - Date.parse(b.at);
    return t !== 0 ? t : a.pr.number - b.pr.number;
  });
  rejected.sort((a, b) => a.pr.number - b.pr.number);
  return { ordered, rejected, unreadable };
}

// ───────────────────────── 止める・待つ（取り込みの前に分かるもの） ─────────────────────────

export interface PrFacts {
  pr: PrInfo;
  /** PR が変えたファイル（名前を変えたものは元の名前も） */
  files: string[];
  /** 最新のレビューで「変更を求める」にしている人 */
  changesRequestedBy: string[];
  /** base が本線でないときの、土台のブランチの PR の状態 */
  baseState?: BaseState;
}

export type Precheck =
  | { verdict: 'go'; retarget: boolean }
  | { verdict: 'stop'; reason: string; fix: string }
  | { verdict: 'wait'; reason: string };

const RELABEL = `「${MERGE_STOP_LABEL}」を外し、「${MERGE_LABEL}」を付け直してください。`;

/** 止める理由と直し方（merge-queue.sh の evaluate・finish の文面に合わせた） */
export const STOP_TEXT = {
  fork: { reason: 'フォークからの PR です。', fix: 'マージ係はフォークからの PR を入れません。持ち主が中身を見て、手で merge commit で押してください。' },
  draft: { reason: '下書きです。', fix: `Ready for review にしてから、${RELABEL}` },
  workflow: (files: string[]) => ({
    reason: `\`.github/\` を変えています（${files.join(',')}）。`,
    fix: 'ワークフローを変える PR はマージ係が入れません。持ち主が中身を見て手で merge commit で押してください。押したあとの続きは、次の queue（持ち主の PC）が拾います。',
  }),
  review: (who: string[]) => ({
    reason: `変更を求めるレビューがあります（${who.join(',')}）。`,
    fix: `レビューに応えて直し、レビューした人に承認してもらうか、取り下げてもらってください。直したら${RELABEL}`,
  }),
  conflict: (n: number, files: string[], tried: boolean, said?: string) => ({
    reason:
      `本線（${BASE_BRANCH}）とぶつかります（${files.join(',')}）。` +
      (tried ? `api-agent のモデルでも解けませんでした${said ? `（${said}）` : ''}。` : 'モデルを呼ばずに回したので、解いていません。'),
    fix: `手元の Claude に「#${n} のぶつかりを解いて」と頼んでください（#234 の解き方）。解いて push してから、${RELABEL}`,
  }),
  ci: (r: { failed: string; tested: string; base: string; tried: boolean; said?: string }, mainGreen: boolean) => ({
    reason:
      `本線 ${short(r.base)} と合わせた形 ${short(r.tested)} で、手元の CI（持ち主の PC）が赤でした（${r.failed || '落ちたものの名前が無い'}）。` +
      (mainGreen ? '本線の先頭だけなら緑なので、この PR と本線の組み合わせで落ちています。' : '') +
      (r.tried ? `api-agent のモデルの見立て：${r.said || '（見立てが無い）'}。` : 'モデルを呼ばずに回したので、見立てていません。'),
    fix: `本線を取り込んで手元でテストを回し、直して push してください。直したら${RELABEL}`,
  }),
};

/** 持ち主でない人の「マージ」を外したときのコメント（merge-queue.sh の reject と同じ文面） */
export function rejectComment(owner: string, actor: string | undefined): string {
  return `ラベル「${MERGE_LABEL}」は、持ち主（${owner}）が付けたものだけを受け付けます。${actor || '持ち主でない人'} が付けたので外しました。マージしてほしいときは、持ち主に頼んでください。`;
}

/** 止めたときのコメント（merge-queue.sh の stop_pr と同じ形。run の URL の代わりに、持ち主の PC の記録の名前） */
export function stopComment(reason: string, fix: string, runName: string): string {
  return ['マージ係（持ち主の PC の api-agent）が、この PR を入れずに止めました。', '', `- 理由：${reason}`, `- 直し方：${fix}`, '', `（持ち主の PC の記録：runs/${runName}.md）`].join('\n');
}

/** 取り込みの前に分かる、止める・待つ（merge-queue.sh の evaluate の順：フォーク → 下書き → base → .github/ → レビュー） */
export function precheck(f: PrFacts): Precheck {
  const { pr } = f;
  if (pr.isCrossRepository) return { verdict: 'stop', ...STOP_TEXT.fork };
  if (pr.isDraft) return { verdict: 'stop', ...STOP_TEXT.draft };
  let retarget = false;
  if (pr.baseRefName !== BASE_BRANCH) {
    if (f.baseState !== 'merged') return { verdict: 'wait', reason: `base が ${pr.baseRefName}（積み重ね）。土台が入って base が ${BASE_BRANCH} へ向くまで待つ` };
    retarget = true;
  }
  const wf = workflowFiles(f.files);
  if (wf.length) return { verdict: 'stop', ...STOP_TEXT.workflow(wf) };
  if (f.changesRequestedBy.length) return { verdict: 'stop', ...STOP_TEXT.review(f.changesRequestedBy) };
  return { verdict: 'go', retarget };
}

export function workflowFiles(files: string[]): string[] {
  return [...new Set(files.filter((f) => f.startsWith('.github/')))].sort();
}

/** 1本ごとの流れの結果から、止める理由と直し方を決める（止めないなら undefined：ラベルはそのまま） */
export function stopForResult(n: number, r: PrFlowResult, mainGreen: (base: string) => boolean): { reason: string; fix: string } | undefined {
  switch (r.kind) {
    case 'conflict':
      return STOP_TEXT.conflict(n, r.files, r.tried, r.said);
    case 'ci':
      return STOP_TEXT.ci(r, mainGreen(r.base));
    case 'workflow':
      return STOP_TEXT.workflow(r.files);
    default:
      return undefined;
  }
}

/**
 * 押す直前の見直し（merge-queue.sh の finish の (12)）。手元の CI のあいだに、ラベル「マージ」が外された・持ち主でない人が付け直した・
 * 下書きになった・変更を求めるレビューが付いた、なら入れない（わけを返す）。ラベルは変えず、次の queue の precheck で扱う
 */
export function recheckBeforeMerge(
  now: { labels: { name: string }[]; isDraft: boolean; changesRequestedBy: string[]; events: LabelEvent[] },
  owner: string,
): string | undefined {
  if (!now.labels.some((l) => l.name === MERGE_LABEL)) return `手元の CI のあいだに、ラベル「${MERGE_LABEL}」が外された`;
  const mark = lastLabeled(now.events);
  if (!mark || !sameLogin(mark.actor, owner)) return `ラベル「${MERGE_LABEL}」を最後に付けたのが、持ち主でなくなった（${mark?.actor || '記録が無い'}）`;
  if (now.isDraft) return '手元の CI のあいだに下書きになった。次の queue で止める';
  if (now.changesRequestedBy.length) return `手元の CI のあいだに、変更を求めるレビューが付いた（${now.changesRequestedBy.join(',')}）。次の queue で止める`;
  return undefined;
}

// ───────────────────────── 本線の先頭 ─────────────────────────

/** status があるか（success・failure・error）。pending は、前の実行が途中で止まったものとして「無い」と見る */
export const hasFinalStatus = (state: string | undefined) => state === 'success' || state === 'failure' || state === 'error';
export const isRedStatus = (state: string | undefined) => state === 'failure' || state === 'error';

export function mainRedIssueBody(sha: string, summary: string, failed: string, runName: string): string {
  return [
    `本線（${BASE_BRANCH}）の先頭 \`${sha}\` で、持ち主の PC の手元の CI（\`agent-harness/api-agent/scripts/local-ci.sh\`）が落ちました。`,
    '',
    `- 落ちたもの：${failed || '（名前が無い）'}`,
    `- 結果：${summary}`,
    `- ログ：持ち主の PC の \`runs/${runName}/ci-main-${short(sha)}/\`（持ち主にしか見えない）`,
    '',
    'マージ係（持ち主の PC の api-agent の queue）は、本線の先頭の手元の CI が赤のあいだ、列を止めます（merge-queue.sh と同じ）。',
    '本線を直す PR を出してください。直す PR は持ち主が手で merge commit で押し、そのあと次の queue が続きを拾います。',
    '',
    '（api-agent の queue が立てた Issue）',
  ].join('\n');
}

// ───────────────────────── 実行 ─────────────────────────

export interface QueueOptions {
  /** モデルを呼ぶか（API キーがあり、--no-model でないとき） */
  useModel: boolean;
}

export async function runQueue(args: Args, budget: Budget, ctx: AgentContext, opts: QueueOptions): Promise<void> {
  const { log, repoRoot } = ctx;
  const dry = args.dryRun;
  if (!dry) await fetchOrigin(repoRoot);
  const repo = await repoInfo(repoRoot);
  console.log(`\n■ マージ係（queue）：${repo.nameWithOwner}・持ち主 ${repo.owner}・${opts.useModel ? 'ぶつかり・CI の落ちはモデルに見立てさせる' : 'モデルを呼ばない（ぶつかり・CI の落ちは止める）'}`);
  log.note(opts.useModel ? 'モデル：ぶつかり・CI の落ちで呼ぶ' : 'モデル：呼ばない（API キーが無いか --no-model。ぶつかり・CI の落ちは「マージ止め」にする）');

  // 本線の先頭の手元の CI が赤なら、列を止める（merge-queue.sh の pick と同じ）
  const startMain = await mainHeadSha(repo.nameWithOwner, repoRoot);
  const startState = await commitStatusOf(repo.nameWithOwner, startMain, STATUS_CONTEXT, repoRoot);
  console.log(`  本線 ${BASE_BRANCH} の先頭 ${short(startMain)}：「${STATUS_CONTEXT}」の status は ${startState ?? '無い'}`);
  if (isRedStatus(startState)) {
    log.stopReason = `列を止めた：本線の先頭 ${short(startMain)} の手元の CI が赤。本線を直してから（直す PR は手で merge commit で押す）、もう一度 queue を回す`;
    console.log(`  ${log.stopReason}`);
    return;
  }
  const mainGreen = (base: string) => base === startMain && startState === 'success';

  const handled = new Set<number>();
  passes: for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (!dry && pass > 1) await fetchOrigin(repoRoot);
    const prs = await listLabeledPrs(MERGE_LABEL, repoRoot);
    const events = new Map<number, LabelEvent[] | Error>(
      await Promise.all(
        prs.map(async (p): Promise<[number, LabelEvent[] | Error]> => {
          try {
            return [p.number, await issueEvents(repo.nameWithOwner, p.number, repoRoot)];
          } catch (e) {
            return [p.number, e instanceof Error ? e : new Error(String(e))];
          }
        }),
      ),
    );
    const plan = planQueue(prs, events, repo.owner, { exclude: [...handled] });
    console.log(
      pass === 1
        ? `\n■ ラベル「${MERGE_LABEL}」の付いた PR ${prs.length} 件：持ち主が付けた ${plan.ordered.length} 件・持ち主でない人が付けた ${plan.rejected.length} 件`
        : `\n■ ${pass} 周め（土台が入って、積み重ねの PR が扱えるようになったか見直した）：${plan.ordered.length} 件`,
    );
    plan.ordered.forEach((e, k) => console.log(`  ${k + 1}. #${e.pr.number} ${e.pr.title}（持ち主が付けた：${e.at}）`));

    for (const u of plan.unreadable) {
      const text = `#${u.pr.number}：ラベルのイベントを読めなかったので、今回は見ない（${redact(u.reason).slice(0, 200)}）`;
      console.log(`  ! ${text}`);
      log.note(text);
    }
    for (const r of plan.rejected) {
      handled.add(r.pr.number);
      await rejectPr(r.pr, r.actor, repo, dry, ctx);
    }

    let merged = 0;
    let waiting = 0;
    for (const entry of plan.ordered) {
      const pr = entry.pr;
      if (opts.useModel && !dry && !budget.canStartItem()) {
        log.stopReason = `1回の上限（${usd(budget.maxUsd)}）に届いたので、PR #${pr.number} から先は扱わなかった（ラベルはそのまま）`;
        break passes;
      }
      let facts: PrFacts;
      try {
        facts = {
          pr,
          files: await prFiles(repo.nameWithOwner, pr.number, repoRoot),
          changesRequestedBy: await changesRequestedBy(pr.number, repoRoot),
          baseState: pr.baseRefName !== BASE_BRANCH ? await baseStateOf(pr.baseRefName, repoRoot) : undefined,
        };
      } catch (e) {
        handled.add(pr.number);
        const text = `#${pr.number}：変えたファイル・レビュー・土台を読めなかったので、今回は見ない（ラベルはそのまま。${redact(e instanceof Error ? e.message : String(e)).slice(0, 200)}）`;
        console.log(`  ! ${text}`);
        log.note(text);
        continue;
      }
      const pc = precheck(facts);
      if (pc.verdict === 'wait') {
        waiting++;
        console.log(`  - #${pr.number} → 待つ：${pc.reason}`);
        if (pass === 1) log.skipped.push({ kind: 'pr', number: pr.number, reason: `待つ：${pc.reason}（ラベルはそのまま）` });
        continue;
      }
      handled.add(pr.number);
      if (pc.verdict === 'stop') {
        console.log(`  - #${pr.number} → 止める：${pc.reason}`);
        await stopPr(pr, pc.reason, pc.fix, dry, ctx);
        continue;
      }
      if (dry) {
        const text = `#${pr.number} → 入れる候補：${pc.retarget ? `base を ${pr.baseRefName} から ${BASE_BRANCH} へ向け直し、` : ''}worktree で本線を取り込み、手元の CI を回して、緑なら merge commit で入れる見込み`;
        console.log(`  - ${text}`);
        log.note(text);
        continue;
      }

      const rec: ItemRecord = { kind: 'pr', number: pr.number, title: pr.title, outcome: '', url: pr.url, costUsd: 0, notes: [] };
      log.items.push(rec);
      console.log(`\n▶ PR #${pr.number} ${pr.title}`);
      let res: PrFlowResult = { kind: 'other' };
      try {
        res = await handlePr({ pr, retarget: pc.retarget }, rec, args, budget, ctx, {
          useModel: opts.useModel,
          statusRepo: repo.nameWithOwner,
          blockWorkflow: true,
          mergedBy: 'マージ係（持ち主の PC の api-agent の queue）が入れた',
          beforeMerge: async () => {
            const now = await viewPr(pr.number, repoRoot);
            if (now.state !== 'OPEN') return `もう開いていない（${now.state}）`;
            return recheckBeforeMerge(
              {
                labels: now.labels,
                isDraft: now.isDraft,
                changesRequestedBy: await changesRequestedBy(pr.number, repoRoot),
                events: await issueEvents(repo.nameWithOwner, pr.number, repoRoot),
              },
              repo.owner,
            );
          },
        });
      } catch (e) {
        rec.outcome = rec.outcome || '止めた（コードの失敗）';
        rec.notes.push(redact(e instanceof Error ? e.message : String(e)));
      }
      if (res.kind === 'merged') merged++;
      const stop = stopForResult(pr.number, res, mainGreen);
      if (stop) await stopPr(pr, stop.reason, stop.fix, false, ctx, rec);
      else if (res.kind === 'other') rec.notes.push(`ラベル「${MERGE_LABEL}」はそのまま（次の queue で試し直す）`);
      console.log(`  → ${rec.outcome}（${usd(rec.costUsd)}）`);
      log.write(opts.useModel ? budget : undefined);
    }
    if (dry) break; // 読むだけなので、2周めで変わることは無い
    if (merged === 0 || waiting === 0) break;
  }
  finishQueue(log, handled);
  await checkMainTip(repo, dry, ctx);
}

/** 2周め以降に扱った PR は「飛ばしたもの」から外す */
function finishQueue(log: AgentContext['log'], handled: Set<number>): void {
  const keep = log.skipped.filter((s) => !(s.kind === 'pr' && handled.has(s.number)));
  log.skipped.splice(0, log.skipped.length, ...keep);
}

async function rejectPr(pr: PrInfo, actor: string | undefined, repo: RepoInfo, dry: boolean, ctx: AgentContext): Promise<void> {
  const { log, repoRoot } = ctx;
  const text = `#${pr.number}：ラベル「${MERGE_LABEL}」を最後に付けたのが持ち主でない（${actor || '記録が無い'}）ので外す`;
  console.log(`  - ${text}${dry ? '（--dry-run なので外さない）' : ''}`);
  if (dry) {
    log.note(`${text}（--dry-run なので外していない）`);
    return;
  }
  const rec: ItemRecord = { kind: 'pr', number: pr.number, title: pr.title, outcome: '', url: pr.url, costUsd: 0, notes: [] };
  log.items.push(rec);
  try {
    await editPrLabels(pr.number, { remove: [MERGE_LABEL] }, repoRoot);
    await commentPr(pr.number, rejectComment(repo.owner, actor), path.join(log.dir, `comment-reject-pr-${pr.number}.md`), repoRoot);
    rec.outcome = `「${MERGE_LABEL}」を外した（持ち主でない ${actor || '記録が無い人'} が付けた）`;
  } catch (e) {
    rec.outcome = `「${MERGE_LABEL}」を外せなかった`;
    rec.notes.push(redact(e instanceof Error ? e.message : String(e)));
  }
}

/** 止める：「マージ」を外し「マージ止め」を付け、理由と直し方をコメントする（merge-queue.sh の stop_pr） */
async function stopPr(pr: PrInfo, reason: string, fix: string, dry: boolean, ctx: AgentContext, rec?: ItemRecord): Promise<void> {
  const { log, repoRoot } = ctx;
  const body = stopComment(reason, fix, log.name);
  if (dry) {
    log.note(`#${pr.number} を止める見込み（--dry-run なのでラベルもコメントも変えていない）：${reason}`);
    console.log(body.split('\n').map((l) => `      | ${l}`).join('\n'));
    return;
  }
  const r = rec ?? { kind: 'pr' as const, number: pr.number, title: pr.title, outcome: `止めた（${reason}）`, url: pr.url, costUsd: 0, notes: [] };
  if (!rec) log.items.push(r);
  try {
    await editPrLabels(pr.number, { remove: [MERGE_LABEL], add: [MERGE_STOP_LABEL] }, repoRoot);
    await commentPr(pr.number, body, path.join(log.dir, `comment-stop-pr-${pr.number}.md`), repoRoot);
    r.notes.push(`「${MERGE_LABEL}」を外し「${MERGE_STOP_LABEL}」を付けて、理由と直し方をコメントした`);
  } catch (e) {
    r.notes.push(`「${MERGE_STOP_LABEL}」にできなかった：${redact(e instanceof Error ? e.message : String(e))}`);
  }
}

/** 終わりに、本線の先頭に手元の CI の status が無ければ、本線の先頭で手元の CI を回して付ける。赤なら Issue を立てる */
async function checkMainTip(repo: RepoInfo, dry: boolean, ctx: AgentContext): Promise<void> {
  const { log, repoRoot, mainRoot } = ctx;
  const sha = await mainHeadSha(repo.nameWithOwner, repoRoot);
  const state = await commitStatusOf(repo.nameWithOwner, sha, STATUS_CONTEXT, repoRoot);
  if (hasFinalStatus(state)) {
    console.log(`\n■ 本線の先頭 ${short(sha)}：「${STATUS_CONTEXT}」の status は ${state}。回さない`);
    return;
  }
  const title = mainRedIssueTitle(sha);
  const why = state === 'pending' ? '途中（pending）のまま' : '無い';
  if (dry) {
    const text = `本線の先頭 ${short(sha)} に「${STATUS_CONTEXT}」の status が${why}ので、終わりに手元の CI を回して付ける見込み（赤なら Issue「${title}」を立てる。同じ題の開いた Issue があれば立てない）`;
    console.log(`\n■ ${text}`);
    log.note(text);
    return;
  }
  console.log(`\n■ 本線の先頭 ${short(sha)} に status が${why}ので、手元の CI を回す`);
  const rec: ItemRecord = { kind: 'main', number: 0, title: `本線の先頭 ${short(sha)} の手元の CI`, outcome: '', costUsd: 0, notes: [] };
  log.items.push(rec);
  try {
    await fetchOrigin(repoRoot);
    const wt = path.join(worktreeRoot(mainRoot), MAIN_WORKTREE_NAME);
    if (fs.existsSync(wt)) {
      if (!(await isCleanWorktree(wt))) {
        rec.outcome = '回さなかった（本線用の worktree に変更が残っている）';
        rec.notes.push(`${wt} を持ち主が見る`);
        return;
      }
      await checkoutDetached(wt, sha);
    } else {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      await addDetachedWorktree(repoRoot, wt, sha);
    }
    const where = `本線の先頭 ${short(sha)}`;
    const post = async (st: 'pending' | 'success' | 'failure', desc: string) => {
      const err = await postCommitStatus(repo.nameWithOwner, sha, st, STATUS_CONTEXT, desc, repoRoot);
      if (err) rec.notes.push(`commit status（${st}）を付けられなかった：${err}`);
    };
    await post('pending', statusDescription('pending', undefined, where));
    const ci = await runLocalCi(wt, path.join(log.dir, `ci-main-${short(sha)}`), LOCAL_CI_TIMEOUT_MIN * 60_000);
    await post(ci.ok ? 'success' : 'failure', statusDescription(ci.ok ? 'success' : 'failure', ci, where));
    rec.notes.push(`手元の CI：${ciSummary(ci)}`);
    if (ci.ok) {
      rec.outcome = '通った（status を付けた）';
      return;
    }
    rec.outcome = '落ちた（status を付けた）';
    const open = await listOpenIssues(repoRoot);
    const same = open.find((i) => i.title === title);
    if (same) {
      rec.notes.push(`同じ題の開いた Issue #${same.number} があるので、立てなかった`);
      return;
    }
    const url = await createIssue(title, mainRedIssueBody(sha, ciSummary(ci), failedJobs(ci), log.name), path.join(log.dir, `issue-main-${short(sha)}.md`), repoRoot);
    rec.url = url;
    rec.notes.push(`Issue を立てた：${url}`);
  } catch (e) {
    rec.outcome = rec.outcome || '止めた（コードの失敗）';
    rec.notes.push(redact(e instanceof Error ? e.message : String(e)));
  }
}
