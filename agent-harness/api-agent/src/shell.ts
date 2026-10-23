/**
 * コードがする決まった手順（gh・git・手元の CI）。モデルは通らない。
 * シェルを通さず execFile で呼ぶ（引数に空白や引用符があっても崩れないため）。
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_BRANCH, PROTECTED_BRANCHES, SCRIPTS_DIR } from './config.ts';
import type { BaseState, IssueInfo, PrInfo } from './select.ts';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    readonly cmd: string,
    readonly result: RunResult,
  ) {
    super(`${cmd} が失敗した（${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 800)}`);
  }
}

/** gh を、問いを出さず色を付けずに動かす */
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '', PAGER: '' };

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 0, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const raw = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
        const code = !raw ? 0 : typeof raw.code === 'number' ? raw.code : 1;
        resolve({ code, stdout: stdout ?? '', stderr: (stderr ?? '') + (raw && typeof raw.code !== 'number' ? `\n${raw.message}` : '') });
      },
    );
  });
}

async function ok(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new CommandError(`${cmd} ${args.slice(0, 3).join(' ')}`, r);
  return r.stdout;
}

// ───────────────────────── gh ─────────────────────────

const gh = (args: string[], cwd: string) => ok('gh', args, { cwd, env: { ...process.env, ...GH_ENV } });
const ghJson = async <T>(args: string[], cwd: string): Promise<T> => JSON.parse(await gh(args, cwd)) as T;

const PR_FIELDS = 'number,title,createdAt,url,isDraft,labels,baseRefName,headRefName,headRefOid,isCrossRepository,body,closingIssuesReferences,statusCheckRollup';

export const listOpenIssues = (cwd: string) =>
  ghJson<IssueInfo[]>(['issue', 'list', '--state', 'open', '--limit', '300', '--json', 'number,title,createdAt,url,labels'], cwd);

export const listOpenPrs = (cwd: string) => ghJson<PrInfo[]>(['pr', 'list', '--state', 'open', '--limit', '300', '--json', PR_FIELDS], cwd);

export const viewPr = (n: number, cwd: string) => ghJson<PrInfo & { state: string }>(['pr', 'view', String(n), '--json', `${PR_FIELDS},state`], cwd);

export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  comments: { author?: { login?: string }; body: string; createdAt: string }[];
}

export const viewIssue = (n: number, cwd: string) =>
  ghJson<IssueDetail>(['issue', 'view', String(n), '--json', 'number,title,body,url,state,comments'], cwd);

/** review 用：開いている PR とコメント（印を探すため） */
export const listOpenPrsWithComments = (cwd: string) =>
  ghJson<(PrInfo & { comments: { body: string }[] })[]>(['pr', 'list', '--state', 'open', '--limit', '300', '--json', `${PR_FIELDS},comments`], cwd);

/** 土台のブランチの PR の状態 */
export async function baseStateOf(branch: string, cwd: string): Promise<BaseState> {
  const list = await ghJson<{ number: number; state: string }[]>(
    ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '20', '--json', 'number,state'],
    cwd,
  );
  if (list.some((p) => p.state === 'MERGED')) return 'merged';
  if (list.some((p) => p.state === 'OPEN')) return 'open';
  return 'none';
}

/** エージェントのブランチから出た PR（開いているもの） */
export const prsFromBranch = (branch: string, cwd: string) =>
  ghJson<{ number: number; url: string; isDraft: boolean }[]>(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url,isDraft'], cwd);

export const issueState = async (n: number, cwd: string) =>
  (await ghJson<{ state: string }>(['issue', 'view', String(n), '--json', 'state'], cwd)).state;

export async function retargetToBase(n: number, cwd: string): Promise<void> {
  await gh(['pr', 'edit', String(n), '--base', BASE_BRANCH], cwd);
}

/** マージ（コードだけがする）。merge commit・head の一致を確かめて押す。squash・rebase・--admin・--delete-branch は使わない */
export async function mergePr(n: number, headSha: string, cwd: string): Promise<RunResult> {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error(`head の sha が40桁でない：${headSha}`);
  return run('gh', ['pr', 'merge', String(n), '--merge', '--match-head-commit', headSha], { cwd, env: { ...process.env, ...GH_ENV } });
}

export async function commentPr(n: number, body: string, bodyFile: string, cwd: string): Promise<void> {
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  fs.writeFileSync(bodyFile, body, 'utf8');
  await gh(['pr', 'comment', String(n), '--body-file', bodyFile], cwd);
}

// ───────────────────────── git ─────────────────────────

const git = (args: string[], cwd: string) => ok('git', args, { cwd });

export async function repoPaths(fromDir: string): Promise<{ repoRoot: string; mainRoot: string }> {
  const repoRoot = (await git(['rev-parse', '--show-toplevel'], fromDir)).trim();
  const common = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], fromDir)).trim();
  return { repoRoot: path.resolve(repoRoot), mainRoot: path.resolve(path.dirname(common)) };
}

export const fetchOrigin = (repoRoot: string) => git(['fetch', 'origin'], repoRoot);

export async function revParse(ref: string, cwd: string): Promise<string | undefined> {
  const r = await run('git', ['rev-parse', '--verify', '--quiet', ref], { cwd });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export const headSha = async (wt: string) => (await git(['rev-parse', 'HEAD'], wt)).trim();

export function currentBranchSync(wt: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt, encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return undefined;
  }
}

export async function isCleanWorktree(wt: string): Promise<boolean> {
  return (await git(['status', '--porcelain'], wt)).trim() === '';
}

/** Issue 用：本線から新しいブランチで worktree を作る（追跡は付けない。push は名前を書いてする） */
export async function addIssueWorktree(repoRoot: string, dir: string, branch: string): Promise<void> {
  if (PROTECTED_BRANCHES.includes(branch)) throw new Error(`本線の名前でブランチは作らない：${branch}`);
  await git(['worktree', 'add', '--no-track', '-b', branch, dir, `origin/${BASE_BRANCH}`], repoRoot);
}

/** PR 用：PR のブランチの先を、切り離した HEAD で開く（ほかの worktree が同じブランチを開いていても作れる） */
export async function addPrWorktree(repoRoot: string, dir: string, headRef: string): Promise<void> {
  await git(['worktree', 'add', '--detach', dir, `origin/${headRef}`], repoRoot);
}

/** 前の実行の worktree を使い直す（きれいなときだけ。HEAD を PR の先へ動かす） */
export async function resetPrWorktree(dir: string, headRef: string): Promise<void> {
  await git(['checkout', '--detach', `origin/${headRef}`], dir);
}

/** review 用：PR の先頭の commit（sha）を、切り離した HEAD で開く */
export async function addDetachedWorktree(repoRoot: string, dir: string, sha: string): Promise<void> {
  await git(['worktree', 'add', '--detach', dir, sha], repoRoot);
}

/** review 用：前の実行の worktree を使い直す（きれいなときだけ） */
export async function checkoutDetached(dir: string, sha: string): Promise<void> {
  await git(['checkout', '--detach', sha], dir);
}

export type MergeOutcome = 'uptodate' | 'merged' | 'conflict';

export async function mergeMainline(wt: string): Promise<{ outcome: MergeOutcome; conflicts: string[]; output: string }> {
  const before = await headSha(wt);
  const r = await run(
    'git',
    ['merge', '--no-ff', '-m', `本線（${BASE_BRANCH}）を取り込んだ（api-agent が、マージの前に本線と合わせるため）`, `origin/${BASE_BRANCH}`],
    { cwd: wt },
  );
  if (r.code === 0) {
    const after = await headSha(wt);
    return { outcome: after === before ? 'uptodate' : 'merged', conflicts: [], output: r.stdout };
  }
  const conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], wt)).split(/\r?\n/).filter(Boolean);
  if (conflicts.length === 0) throw new CommandError('git merge', r);
  return { outcome: 'conflict', conflicts, output: r.stdout + r.stderr };
}

/** 取り込みが済んだか（ぶつかりが残っておらず、MERGE_HEAD も無い） */
export async function mergeFinished(wt: string): Promise<boolean> {
  const unresolved = (await git(['diff', '--name-only', '--diff-filter=U'], wt)).trim();
  const mergeHead = await revParse('MERGE_HEAD', wt);
  return unresolved === '' && mergeHead === undefined;
}

export const abortMerge = (wt: string) => run('git', ['merge', '--abort'], { cwd: wt });

export async function commitsAhead(wt: string, ref: string): Promise<number> {
  return Number((await git(['rev-list', '--count', `${ref}..HEAD`], wt)).trim());
}

/** PR のブランチへ push（force しない。本線へは送らない） */
export async function pushHead(wt: string, headRef: string): Promise<RunResult> {
  if (PROTECTED_BRANCHES.includes(headRef)) throw new Error(`本線（${headRef}）へは push しない`);
  return run('git', ['push', 'origin', `HEAD:refs/heads/${headRef}`], { cwd: wt });
}

// ───────────────────────── 手元の CI ─────────────────────────

export interface CiStep {
  name: string;
  status: string;
}

export interface CiResult {
  ok: boolean;
  head?: string;
  steps: CiStep[];
  logDir: string;
}

/** Windows で bash を探す。WSL の bash（System32）を取らないように、Git の隣の bash を先に見る */
export function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash';
  for (const v of [process.env.SUKUSUKU_BASH, process.env.CLAUDE_CODE_GIT_BASH_PATH]) if (v && fs.existsSync(v)) return v;
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim(); // …/Git/mingw64/libexec/git-core
    const cand = path.resolve(exec, '..', '..', '..', 'bin', 'bash.exe');
    if (fs.existsSync(cand)) return cand;
  } catch {
    /* 下へ */
  }
  return 'bash';
}

/** スラッシュの形にする（bash に渡すパス） */
export const slash = (p: string) => p.replace(/\\/g, '/');

/** 頼みの文に書く、手元の CI のコマンド */
export function localCiCommand(wt: string, logDir: string): string {
  return `bash "${slash(path.join(SCRIPTS_DIR, 'heavy.sh'))}" bash "${slash(path.join(SCRIPTS_DIR, 'local-ci.sh'))}" "${slash(wt)}" "${slash(logDir)}"`;
}

/** result.txt を読む。最後の `done=yes` が無ければ（途中で止まった）通ったことにしない */
export function parseCiResult(text: string, logDir: string): CiResult {
  const steps: CiStep[] = [];
  let head: string | undefined;
  let done = false;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([\w-]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'head') head = m[2];
    else if (m[1] === 'done') done = m[2] === 'yes';
    else steps.push({ name: m[1]!, status: m[2]! });
  }
  if (!done && steps.length > 0) steps.push({ name: 'local-ci', status: 'FAIL(途中で止まった)' });
  return { ok: done && steps.length > 0 && steps.every((s) => s.status === 'ok'), head, steps, logDir };
}

/** 手元の CI を、重いコマンドの鍵を通して回す。ANTHROPIC_API_KEY は渡さない（サーバの AI の下書きが本物の API を呼ばないように） */
export function runLocalCi(wt: string, logDir: string, timeoutMs: number): Promise<CiResult> {
  fs.mkdirSync(logDir, { recursive: true });
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve) => {
    const outFd = fs.openSync(path.join(logDir, 'local-ci.out'), 'w');
    const errFd = fs.openSync(path.join(logDir, 'local-ci.err'), 'w');
    const child = spawn(resolveBash(), [slash(path.join(SCRIPTS_DIR, 'heavy.sh')), 'bash', slash(path.join(SCRIPTS_DIR, 'local-ci.sh')), slash(wt), slash(logDir)], {
      env,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      const file = path.join(logDir, 'result.txt');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const res = parseCiResult(text, logDir);
      if (res.steps.length === 0) res.steps.push({ name: 'local-ci', status: 'FAIL(回らなかった。local-ci.err を見る)' });
      resolve(res);
    });
  });
}

export function ciSummary(ci: CiResult): string {
  const okCount = ci.steps.filter((s) => s.status === 'ok').length;
  const failed = ci.steps.filter((s) => s.status !== 'ok').map((s) => `${s.name}=${s.status}`);
  return `${ci.steps.length} のうち ${okCount} が ok${failed.length ? `（落ちた：${failed.join('、')}）` : ''}`;
}
