/**
 * 入口：npm run agent -- <issues|merge|queue|review|all|task> [オプション]（README.md）
 *
 * 終了コード：0 済んだ・1 コードの失敗・2 引数が違う・3 API キーが無い・4 持ち主でないアカウントで merge・queue・all を回した・130 Ctrl+C
 */
import { AuthError, hasApiKey, requireApiKey, type AgentContext } from './agent.ts';
import { ArgError, parseArgs, USAGE, type Args } from './args.ts';
import { AGENT_DIR, MODEL, RUNS_DIR } from './config.ts';
import { runIssues } from './issues.ts';
import { runMerge } from './merge.ts';
import { ownerCheck, runQueue } from './queue.ts';
import { runReview } from './review.ts';
import { dryRunText, readTaskPrompt, runTask, validateTask } from './task.ts';
import { Budget, RunLog, usd } from './report.ts';
import { ghLogin, repoInfo, repoPaths } from './shell.ts';

/** 持ち主でないアカウントで merge・queue・all を回したときの終了コード（ほかの終了コードと重ならない数） */
const EXIT_NOT_OWNER = 4;

async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof ArgError) {
      console.error(`引数が違う：${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (args.command === 'help') {
    console.log(USAGE);
    return 0;
  }
  // merge・queue（と merge を含む all）は、持ち主の gh のアカウントでしか動かさない。--dry-run はだれでも
  if (!args.dryRun && (args.command === 'merge' || args.command === 'queue' || args.command === 'all')) {
    const owner = await repoInfo(AGENT_DIR).then(
      (r) => r.owner,
      () => undefined,
    );
    const msg = ownerCheck(args.command, await ghLogin(AGENT_DIR), owner);
    if (msg) {
      console.error(msg);
      return EXIT_NOT_OWNER;
    }
  }
  // queue は API キーが無くても、モデルを呼ばずに動く
  const useModel = args.command === 'queue' ? !args.noModel && hasApiKey() : true;
  if (!args.dryRun && args.command !== 'queue') {
    try {
      requireApiKey();
    } catch (e) {
      if (e instanceof AuthError) {
        console.error(e.message);
        return 3;
      }
      throw e;
    }
  }

  const { repoRoot, mainRoot } = await repoPaths(AGENT_DIR);
  if (args.command === 'task') {
    const problems = validateTask(args.task!, { mainRoot, repoRoot });
    if (problems.length) {
      console.error(`task を断る：\n${problems.map((p) => `- ${p}`).join('\n')}`);
      return 2;
    }
    if (args.dryRun) {
      try {
        console.log(dryRunText(args, readTaskPrompt(args.task!.promptFile)));
        return 0;
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        return 2;
      }
    }
  }
  const budget = new Budget(args.maxUsd, args.perItemUsd);
  const log = new RunLog(RUNS_DIR, `npm run agent -- ${argv.join(' ')}`, args.command, [
    `モデル：${MODEL}（effort ${args.effort}）`,
    `リポジトリ：${repoRoot}`,
    args.dryRun ? '--dry-run（API は呼ばず、GitHub は読むだけ）' : `上限：1回 ${usd(args.maxUsd)}・1件 ${usd(args.perItemUsd)}`,
    ...(args.command === 'queue' ? [useModel ? 'queue：ぶつかり・CI の落ちでモデルを呼ぶ' : `queue：モデルを呼ばない（${args.noModel ? '--no-model' : 'API キーが無い'}）`] : []),
  ]);
  const ctx: AgentContext = { log, repoRoot, mainRoot };

  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log.stopReason = 'Ctrl+C で止めた';
    console.error('\n止めます（もう一度 Ctrl+C ですぐ終わる）。いまの件の区切りで記録を書きます。');
  });

  let code = 0;
  try {
    if (args.command === 'issues' || args.command === 'all') await runIssues(args, budget, ctx);
    if (args.command === 'task') await runTask(args, budget, ctx);
    if (args.command === 'review') await runReview(args, budget, ctx);
    if (args.command === 'queue') await runQueue(args, budget, ctx, { useModel });
    if ((args.command === 'merge' || args.command === 'all') && !interrupted) await runMerge(args, budget, ctx);
  } catch (e) {
    log.stopReason = `コードの失敗：${e instanceof Error ? e.message : String(e)}`;
    code = 1;
  }
  const summary = log.write(args.dryRun ? undefined : budget);
  console.log(`\n${'═'.repeat(60)}\n${summary}`);
  console.log(`記録：${log.summaryPath}`);
  return code;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
