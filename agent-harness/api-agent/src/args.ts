/**
 * 引数の読み取り。`npm run agent -- <コマンド> [オプション]`
 */
import path from 'node:path';
import { DEFAULT_EFFORT, DEFAULT_MAX_USD, DEFAULT_PER_ITEM_USD, EFFORTS, TASK_MAX_TURNS, TASK_TIMEOUT_MIN, type Effort } from './config.ts';

export type Command = 'issues' | 'merge' | 'queue' | 'all' | 'task' | 'review' | 'help';

/** task コマンドだけの引数（パスは絶対パスにしてある） */
export interface TaskArgs {
  promptFile: string;
  cwd: string;
  allowDirs: string[];
  label?: string;
  out?: string;
  maxTurns: number;
  timeoutMin: number;
}

export interface Args {
  command: Command;
  issue?: number;
  pr?: number;
  maxUsd: number;
  perItemUsd: number;
  dryRun: boolean;
  trustGhChecks: boolean;
  /** review：下書きの PR も見る */
  includeDrafts: boolean;
  /** review：同じ先頭の commit をレビュー済みでも見直す */
  force: boolean;
  /** queue：API キーがあってもモデルを呼ばない（ぶつかり・CI の落ちは止める） */
  noModel: boolean;
  /** queue：本線の先頭の status があっても、始めに本線で手元の CI を回し直して付け直す（時々落ちるテストで赤になったときの抜け道） */
  recheckMain: boolean;
  effort: Effort;
  /** command が task のときだけ */
  task?: TaskArgs;
}

export class ArgError extends Error {}

export const USAGE = `使い方（agent-harness/api-agent の中で）:
  npm run agent -- issues [--issue N] [--max-usd X] [--per-item-usd Y] [--effort E] [--dry-run]
                        （ラベル「claude」の Issue だけを拾う。--issue N で指せばラベルが無くても扱う）
  npm run agent -- merge  [--pr N] [--max-usd X] [--per-item-usd Y] [--effort E] [--trust-gh-checks] [--dry-run]
                        （持ち主の gh のアカウントでだけ動く。--dry-run はだれでも）
  npm run agent -- queue  [--no-model] [--recheck-main] [--max-usd X] [--per-item-usd Y] [--effort E] [--dry-run]
                        （マージ係の代わり。持ち主がラベル「マージ」を付けた PR を、付けた順に入れる。持ち主の gh のアカウントでだけ動く）
  npm run agent -- review [--pr N] [--include-drafts] [--force] [--max-usd X] [--per-item-usd Y] [--effort E] [--dry-run]
                        （開いている PR を読んでレビューし、コメントする。all には入らない）
  npm run agent -- all    （issues のあと merge。両方のオプションが使える。merge を含むので、持ち主の gh のアカウントでだけ動く）
  npm run agent -- task --prompt-file F --cwd DIR [--allow-dir DIR]... [--label 名前] [--out FILE] [--max-turns N] [--timeout-min M]
                        [--max-usd X] [--per-item-usd Y] [--effort E] [--dry-run]   （任意の頼みの文を1つ走らせる）

  --issue N          この Issue だけを扱う（ラベル「claude」が無くても）
  --pr N             この PR だけを扱う
  --max-usd X        1回の実行の上限（米ドル、既定 ${DEFAULT_MAX_USD}【仮置き】）
  --per-item-usd Y   1件の上限（米ドル、既定 ${DEFAULT_PER_ITEM_USD}【仮置き】）
  --effort E         ${EFFORTS.join('|')}（既定 ${DEFAULT_EFFORT}）
  --trust-gh-checks  PR の GitHub の CI が全部 success で、取り込みも直しも要らないときは、手元の CI を省く
  --prompt-file F    （task）頼みの文のファイル（UTF-8）
  --cwd DIR          （task）エージェントの作業フォルダ。メインの作業ツリー・api-agent・~/.claude などの中は断る
  --allow-dir DIR    （task）書いてよいフォルダを足す（何回でも）。守りのフォルダと重なるなら断る
  --label 名前       （task）記録の見出し（既定はファイル名）
  --out FILE         （task）エージェントの最後の文をこのファイルにも書く（--cwd か --allow-dir の中だけ）
  --max-turns N      （task）往復の上限（既定 ${TASK_MAX_TURNS}）
  --timeout-min M    （task）時間の上限・分（既定 ${TASK_TIMEOUT_MIN}）
  --no-model         （queue）API キーがあってもモデルを呼ばない。キーが無いときも呼ばない（ぶつかり・CI の落ちは「マージ止め」にする）
  --recheck-main     （queue）本線の先頭の status があっても、始めに本線で手元の CI を回し直して付け直す（時々落ちるテストで赤になったとき）
  --include-drafts   （review）下書きの PR も見る（--pr N のときも見る）
  --force            （review）同じ先頭の commit をレビュー済みでも見直す
  --dry-run          API を呼ばず、GitHub は読むだけ。選んだもの・並び・モデルに渡す頼みの文を出す`;

const COMMANDS: Command[] = ['issues', 'merge', 'queue', 'all', 'task', 'review', 'help'];

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: 'help',
    maxUsd: DEFAULT_MAX_USD,
    perItemUsd: DEFAULT_PER_ITEM_USD,
    dryRun: false,
    trustGhChecks: false,
    includeDrafts: false,
    force: false,
    noModel: false,
    recheckMain: false,
    effort: DEFAULT_EFFORT,
  };
  const rest = [...argv];
  const t: Partial<TaskArgs> & { allowDirs: string[]; maxTurns: number; timeoutMin: number } = {
    allowDirs: [],
    maxTurns: TASK_MAX_TURNS,
    timeoutMin: TASK_TIMEOUT_MIN,
  };
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
      case '--prompt-file':
        onlyTask(flag, args.command);
        t.promptFile = path.resolve(value());
        break;
      case '--cwd':
        onlyTask(flag, args.command);
        t.cwd = path.resolve(value());
        break;
      case '--allow-dir':
        onlyTask(flag, args.command);
        t.allowDirs.push(path.resolve(value()));
        break;
      case '--label':
        onlyTask(flag, args.command);
        t.label = value();
        break;
      case '--out':
        onlyTask(flag, args.command);
        t.out = path.resolve(value());
        break;
      case '--max-turns':
        onlyTask(flag, args.command);
        t.maxTurns = positiveInt(flag, value());
        break;
      case '--timeout-min':
        onlyTask(flag, args.command);
        t.timeoutMin = positiveNumber(flag, value());
        break;
      case '--dry-run':
        noValue(flag, inline);
        args.dryRun = true;
        break;
      case '--trust-gh-checks':
        noValue(flag, inline);
        args.trustGhChecks = true;
        break;
      case '--include-drafts':
        onlyReview(flag, args.command);
        noValue(flag, inline);
        args.includeDrafts = true;
        break;
      case '--force':
        onlyReview(flag, args.command);
        noValue(flag, inline);
        args.force = true;
        break;
      case '--no-model':
        if (args.command !== 'queue') throw new ArgError(`${flag} は queue で使う`);
        noValue(flag, inline);
        args.noModel = true;
        break;
      case '--recheck-main':
        if (args.command !== 'queue') throw new ArgError(`${flag} は queue で使う`);
        noValue(flag, inline);
        args.recheckMain = true;
        break;
      case '-h':
      case '--help':
        args.command = 'help';
        return args;
      default:
        throw new ArgError(`知らないオプション：${raw}`);
    }
  }

  if (args.command === 'task') {
    if (!t.promptFile) throw new ArgError('task には --prompt-file が要る');
    if (!t.cwd) throw new ArgError('task には --cwd が要る');
    if (args.issue !== undefined || args.pr !== undefined || args.trustGhChecks) {
      throw new ArgError('task では --issue・--pr・--trust-gh-checks は使わない');
    }
    args.task = { promptFile: t.promptFile, cwd: t.cwd, allowDirs: t.allowDirs, label: t.label, out: t.out, maxTurns: t.maxTurns, timeoutMin: t.timeoutMin };
  }
  if (args.issue !== undefined && (args.command === 'merge' || args.command === 'review' || args.command === 'queue')) throw new ArgError('--issue は issues か all で使う');
  if (args.pr !== undefined && (args.command === 'issues' || args.command === 'queue')) throw new ArgError('--pr は merge・review・all で使う（queue はラベル「マージ」の付いた PR を見る）');
  if (args.trustGhChecks && (args.command === 'issues' || args.command === 'review' || args.command === 'queue')) throw new ArgError('--trust-gh-checks は merge か all で使う');
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

function onlyTask(flag: string, command: Command): void {
  if (command !== 'task') throw new ArgError(`${flag} は task で使う`);
}

function onlyReview(flag: string, command: Command): void {
  if (command !== 'review') throw new ArgError(`${flag} は review で使う`);
}

function noValue(flag: string, inline: string | undefined): void {
  if (inline !== undefined) throw new ArgError(`${flag} に値は付けない`);
}
