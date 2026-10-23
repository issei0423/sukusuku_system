/**
 * 引数の読み取り。`npm run agent -- <コマンド> [オプション]`
 */
import { DEFAULT_EFFORT, DEFAULT_MAX_USD, DEFAULT_PER_ITEM_USD, EFFORTS, type Effort } from './config.ts';

export type Command = 'issues' | 'merge' | 'all' | 'help';

export interface Args {
  command: Command;
  issue?: number;
  pr?: number;
  maxUsd: number;
  perItemUsd: number;
  dryRun: boolean;
  trustGhChecks: boolean;
  effort: Effort;
}

export class ArgError extends Error {}

export const USAGE = `使い方（agent-harness/api-agent の中で）:
  npm run agent -- issues [--issue N] [--max-usd X] [--per-item-usd Y] [--effort E] [--dry-run]
  npm run agent -- merge  [--pr N] [--max-usd X] [--per-item-usd Y] [--effort E] [--trust-gh-checks] [--dry-run]
  npm run agent -- all    （issues のあと merge。両方のオプションが使える）

  --issue N          この Issue だけを扱う
  --pr N             この PR だけを扱う
  --max-usd X        1回の実行の上限（米ドル、既定 ${DEFAULT_MAX_USD}【仮置き】）
  --per-item-usd Y   1件の上限（米ドル、既定 ${DEFAULT_PER_ITEM_USD}【仮置き】）
  --effort E         ${EFFORTS.join('|')}（既定 ${DEFAULT_EFFORT}）
  --trust-gh-checks  PR の GitHub の CI が全部 success で、取り込みも直しも要らないときは、手元の CI を省く
  --dry-run          API を呼ばず、GitHub は読むだけ。選んだもの・並び・モデルに渡す頼みの文を出す`;

const COMMANDS: Command[] = ['issues', 'merge', 'all', 'help'];

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'help',
    maxUsd: DEFAULT_MAX_USD,
    perItemUsd: DEFAULT_PER_ITEM_USD,
    dryRun: false,
    trustGhChecks: false,
    effort: DEFAULT_EFFORT,
  };
  const rest = [...argv];
  const first = rest.shift();
  if (first === undefined || first === '-h' || first === '--help') return args;
  if (!COMMANDS.includes(first as Command)) throw new ArgError(`知らないコマンド：${first}`);
  args.command = first as Command;

  while (rest.length > 0) {
    const raw = rest.shift()!;
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      const v = inline ?? rest.shift();
      if (v === undefined || v === '') throw new ArgError(`${flag} に値が要る`);
      return v;
    };
    switch (flag) {
      case '--issue':
        args.issue = positiveInt(flag, value());
        break;
      case '--pr':
        args.pr = positiveInt(flag, value());
        break;
      case '--max-usd':
        args.maxUsd = positiveNumber(flag, value());
        break;
      case '--per-item-usd':
        args.perItemUsd = positiveNumber(flag, value());
        break;
      case '--effort': {
        const v = value();
        if (!EFFORTS.includes(v as Effort)) throw new ArgError(`--effort は ${EFFORTS.join('・')} のどれか（${v}）`);
        args.effort = v as Effort;
        break;
      }
      case '--dry-run':
        noValue(flag, inline);
        args.dryRun = true;
        break;
      case '--trust-gh-checks':
        noValue(flag, inline);
        args.trustGhChecks = true;
        break;
      case '-h':
      case '--help':
        args.command = 'help';
        return args;
      default:
        throw new ArgError(`知らないオプション：${raw}`);
    }
  }

  if (args.issue !== undefined && args.command === 'merge') throw new ArgError('--issue は issues か all で使う');
  if (args.pr !== undefined && args.command === 'issues') throw new ArgError('--pr は merge か all で使う');
  if (args.trustGhChecks && args.command === 'issues') throw new ArgError('--trust-gh-checks は merge か all で使う');
  return args;
}

function positiveInt(flag: string, v: string): number {
  if (!/^\d+$/.test(v) || Number(v) <= 0) throw new ArgError(`${flag} は 1 以上の整数（${v}）`);
  return Number(v);
}

function positiveNumber(flag: string, v: string): number {
  const n = Number(v);
  if (!/^\d+(\.\d+)?$/.test(v) || !Number.isFinite(n) || n <= 0) throw new ArgError(`${flag} は 0 より大きい数（${v}）`);
  return n;
}

function noValue(flag: string, inline: string | undefined): void {
  if (inline !== undefined) throw new ArgError(`${flag} に値は付けない`);
}
