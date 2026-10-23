/**
 * 入口：npm run agent -- <issues|merge|all> [オプション]（README.md）
 */
import { AuthError, requireApiKey, type AgentContext } from './agent.ts';
import { ArgError, parseArgs, USAGE, type Args } from './args.ts';
import { AGENT_DIR, MODEL, RUNS_DIR } from './config.ts';
import { runIssues } from './issues.ts';
import { runMerge } from './merge.ts';
import { dryRunText, readTaskPrompt, runTask, validateTask } from './task.ts';
import { Budget, RunLog, usd } from './report.ts';
import { repoPaths } from './shell.ts';

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
  if (!args.dryRun) {
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
