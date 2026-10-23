/**
 * エージェント（モデル）が道具を使う前に、断るかどうかを決める規則。**断る規則はこのファイルだけに置く。**
 *
 * - agent.ts の PreToolUse フックが checkToolUse() を呼び、ok でなければ断る（permissionDecision: 'deny'）。
 *   フックは権限の判定のいちばん初めに走り、どの permissionMode でも効く（Agent SDK の文書「Configure permissions」）。
 * - SDK_DENY_RULES は、SDK の disallowedTools に渡す二重目の守り。フックが漏らしたときのため。
 * - 規則は「迷ったら断る」。断ったわけはモデルへ返り、モデルは別のやり方を取るか止まる。
 * - コマンドの読み取りは、シェルを完全には解かない。引用符を外し、区切り（&& || ; | & 改行 $( ` ( )）で分け、
 *   どの位置にあっても git・gh・rm などの語を見つけたら、そこからを調べる（echo の中の語でも断る）。
 */
import path from 'node:path';

export type Decision = { ok: true } | { ok: false; reason: string };

export interface SafetyContext {
  /** パスの読み方。win32 では C:\ と /c/（Git Bash）を同じに読み、大文字小文字を区別しない */
  platform: 'win32' | 'posix';
  /** エージェントの作業用の worktree。Edit・Write はこの中だけ */
  workdir: string;
  /** Bash で読み書きしてよい、worktree のほかの場所（ログの置き場・scripts・OS の一時フォルダ） */
  allowedDirs: string[];
  /** Edit・Write で書いてよい、workdir のほかの場所（task の --allow-dir）。allowedDirs にも入れる */
  writeDirs?: string[];
  /** ログの置き場。worktree のほかで、消してよいのはこの中だけ */
  logDir: string;
  /** 触らない場所（持ち主のメインの作業ツリー・~/.claude・gh の設定など）。allowedDirs の中は除く */
  protectedDirs: string[];
  homeDir: string;
  tmpDir: string;
  /** push してはいけないブランチ */
  protectedBranches: string[];
  /** この仕事で、エージェントが push してよいか（Issue の直しは可、マージの流れはコードが push する） */
  allowPush: boolean;
  /** worktree でいま開いているブランチ（push・reset の判定に使う。分からなければ undefined） */
  currentBranch?: string;
}

const OK: Decision = { ok: true };
const deny = (reason: string): Decision => ({ ok: false, reason });

/** SDK の disallowedTools に渡す（二重目）。書き方は「Configure permissions」の `Bash(rm *)` の形 */
export const SDK_DENY_RULES = [
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch',
  'Bash(gh pr merge *)',
  'Bash(git rebase *)',
  'Bash(git push --force *)',
  'Bash(git push -f *)',
  'Bash(git push --force-with-lease *)',
  'Bash(git branch -D *)',
  'Bash(git branch -d *)',
  'Bash(git worktree remove *)',
  'Bash(gh repo delete *)',
  'Bash(gh issue delete *)',
  'Bash(printenv *)',
];

// ───────────────────────── 道具ごとの入口 ─────────────────────────

const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DENIED_TOOLS = new Set(['Agent', 'Task', 'WebFetch', 'WebSearch']);

export function checkToolUse(toolName: string, input: unknown, ctx: SafetyContext): Decision {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (DENIED_TOOLS.has(toolName) || toolName.startsWith('mcp__')) {
    return deny(`道具 ${toolName} は、この仕事では使わない`);
  }
  if (toolName === 'Bash') {
    return checkBash(String(inp.command ?? ''), ctx);
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return checkWritePath(String(inp.file_path ?? inp.notebook_path ?? ''), ctx);
  }
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
    const p = inp.file_path ?? inp.path;
    return p === undefined ? OK : checkReadPath(String(p), ctx);
  }
  return OK;
}

/** Edit・Write：worktree の中だけ。.git の中は不可 */
export function checkWritePath(file: string, ctx: SafetyContext): Decision {
  if (!file) return deny('書き込み先のパスが無い');
  const r = resolvePath(file, ctx.workdir, ctx);
  if (!r) return deny(`書き込み先が決まらない（${file}）`);
  const extra = (ctx.writeDirs ?? []).find((d) => isInside(r, d, ctx));
  if (!isInside(r, ctx.workdir, ctx) && !extra) return deny(`worktree（${ctx.workdir}）の外へは書かない：${file}`);
  if (isInside(r, joinPath(ctx, extra ?? ctx.workdir, '.git'), ctx)) return deny('.git の中は書き換えない');
  return OK;
}

/** Read・Glob・Grep：秘密のファイルと、持ち主の場所は読まない */
export function checkReadPath(file: string, ctx: SafetyContext): Decision {
  if (isSecretFileWord(file)) return deny(`秘密のファイルは読まない：${file}`);
  const r = resolvePath(file, ctx.workdir, ctx);
  if (!r) return OK;
  if (isProtected(r, ctx)) return deny(`持ち主の場所は読まない：${file}`);
  return OK;
}

// ───────────────────────── Bash ─────────────────────────

/** 秘密の名前（大文字の環境変数）。例：ANTHROPIC_API_KEY・GH_TOKEN・GITHUB_TOKEN */
const SECRET_NAME = String.raw`[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*\b`;
const SECRET_REFS: RegExp[] = [
  new RegExp(String.raw`\$\{?` + SECRET_NAME), // $ANTHROPIC_API_KEY・${GH_TOKEN}
  new RegExp('%' + SECRET_NAME + '%'), // cmd の %X_KEY%
  new RegExp(String.raw`\$env:` + SECRET_NAME, 'i'), // PowerShell
  new RegExp(String.raw`(?:process\.env|os\.environ|getenv|ENV)\s*(?:\??\.|\[|\()\s*["']?` + SECRET_NAME),
];
const ENV_DUMPS: RegExp[] = [
  /\bprintenv\b/,
  /process\.env\b(?!\s*(?:\??\.|\[))/, // process.env をまるごと
  /os\.environ\b(?!\s*(?:\[|\.get\b))/,
  /\b(?:Get-ChildItem|gci|ls|dir)\s+env:/i,
  /\/proc\/\S*\/environ/,
  /GetEnvironmentVariables/i,
];

export function checkBash(command: string, ctx: SafetyContext): Decision {
  if (!command.trim()) return OK;
  for (const re of SECRET_REFS) {
    if (re.test(command)) return deny('秘密（キー・トークン）の入った環境変数を、コマンドで扱わない');
  }
  const code = stripQuotedCatHeredocs(command);
  for (const re of ENV_DUMPS) {
    if (re.test(code)) return deny('環境変数をまるごと表示しない（秘密が入っている）');
  }
  let cwd = ctx.workdir;
  for (const words of splitSegments(code)) {
    const first = cmdName(words[0] ?? '');
    if ((first === 'cd' || first === 'pushd') && words[1]) {
      const r = resolvePath(words[1], cwd, ctx);
      if (r) cwd = r;
    }
    const d = checkSegment(words, cwd, ctx);
    if (!d.ok) return d;
  }
  return OK;
}

/**
 * `cat > file <<'EOF'`・`"$(cat <<'EOF'`…`)"` の本文を外す。本文はファイルや PR の本文に入る文字で、
 * 実行されない（区切りが引用符つきなので、$ も展開されない）。PR の本文に「git push」と書いても断らないため。
 * 引用符の無い区切り（<<EOF）や、cat 以外（bash <<'EOF' など、本文が実行される）は外さない。
 */
export function stripQuotedCatHeredocs(command: string): string {
  const lines = command.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const m = /\bcat\s+[^<\n]*?<<-?\s*(['"])([A-Za-z_][\w-]*)\1/.exec(line) ?? /\bcat\s*<<-?\s*(['"])([A-Za-z_][\w-]*)\1/.exec(line);
    if (!m) continue;
    if (/\|\s*(?:\S*[\\/])?(?:ba|z|da|k)?sh\b|\|\s*(?:python\d*|node|pwsh|powershell|cmd|eval|source|xargs)\b/i.test(line)) continue;
    const tag = m[2]!;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== tag) j++;
    if (j < lines.length) i = j; // 本文と終わりの行を飛ばす
  }
  return out.join('\n');
}

/** コマンドを区切りで分け、語に割る。引用符は外す（bash -c "…" の中も見るため） */
export function splitSegments(command: string): string[][] {
  const flat = command.replace(/\\\r?\n/g, ' ');
  return flat
    .split(/&&|\|\||\$\(|[;|&\n\r`()]/)
    .map((seg) => seg.replace(/["']/g, ' ').split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

function checkSegment(words: string[], cwd: string, ctx: SafetyContext): Decision {
  // 持ち主の場所を指す語・秘密のファイル
  for (const w of words) {
    for (const cand of pathCandidates(w)) {
      if (isSecretFileWord(cand)) return deny(`秘密のファイルは扱わない：${cand}`);
      if (!looksLikePath(cand)) continue;
      const r = resolvePath(cand, cwd, ctx);
      if (r && isProtected(r, ctx)) return deny(`持ち主の場所には触らない：${cand}`);
    }
  }
  // リダイレクトの書き込み先
  for (let i = 0; i < words.length; i++) {
    const m = /^(?:\d*)>>?(.*)$/.exec(words[i]!);
    if (!m) continue;
    const target = m[1] || words[i + 1];
    if (!target || target.startsWith('&')) continue;
    const d = checkBashWriteTarget(target, cwd, ctx);
    if (!d.ok) return d;
  }
  // 語ごとのコマンド
  for (let i = 0; i < words.length; i++) {
    const name = cmdName(words[i]!);
    const rest = words.slice(i + 1);
    let d: Decision = OK;
    switch (name) {
      case 'git':
        d = checkGit(rest, cwd, ctx);
        break;
      case 'gh':
        d = checkGh(rest);
        break;
      case 'rm':
      case 'rmdir':
      case 'unlink':
      case 'shred':
      case 'del':
      case 'rd':
      case 'remove-item':
      case 'ri':
        d = checkRemove(rest, cwd, ctx);
        break;
      case 'find':
        d = checkFind(rest, cwd, ctx);
        break;
      case 'mv':
      case 'move-item':
        d = checkTargets(positional(rest), cwd, ctx);
        break;
      case 'cp':
      case 'install':
      case 'copy-item': {
        const pos = positional(rest);
        d = pos.length > 1 ? checkTargets(pos.slice(-1), cwd, ctx) : OK;
        break;
      }
      case 'tee':
        d = checkTargets(positional(rest), cwd, ctx);
        break;
      case 'env':
        if (i === 0 && isEnvDump(rest)) d = deny('環境変数をまるごと表示しない（秘密が入っている）');
        break;
      case 'set':
      case 'export':
      case 'declare':
      case 'typeset':
        if (i === 0 && isVarDump(name, rest)) d = deny('環境変数をまるごと表示しない（秘密が入っている）');
        break;
    }
    if (!d.ok) return d;
  }
  return OK;
}

// ───────────────────────── git ─────────────────────────

function checkGit(rest: string[], cwd: string, ctx: SafetyContext): Decision {
  let i = 0;
  while (i < rest.length && rest[i]!.startsWith('-')) {
    const o = rest[i]!;
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(o) ? 2 : 1;
  }
  const sub = rest[i];
  const args = rest.slice(i + 1);
  switch (sub) {
    case 'push':
      return checkGitPush(args, ctx);
    case 'rebase':
      return deny('git rebase は使わない（本線は merge で取り込む）');
    case 'pull':
      if (args.some((a) => a === '--rebase' || (a.startsWith('--rebase=') && a !== '--rebase=false') || shortHas(a, 'r'))) {
        return deny('git pull --rebase は使わない');
      }
      return OK;
    case 'reset':
      return args.includes('--hard') ? checkHardReset(args, ctx) : OK;
    case 'branch':
      if (args.some((a) => a === '--delete' || shortHas(a, 'd') || shortHas(a, 'D'))) return deny('ブランチは消さない');
      if (args.some((a) => a === '--force' || shortHas(a, 'f'))) return deny('git branch --force は使わない');
      if (args.some((a) => a === '--move' || shortHas(a, 'm') || shortHas(a, 'M')) && args.some((a) => isProtectedBranch(a, ctx))) {
        return deny('本線の名前は動かさない');
      }
      return OK;
    case 'worktree':
      if (args[0] === 'remove' || args[0] === 'prune' || args[0] === 'move') return deny(`git worktree ${args[0]} は使わない`);
      return OK;
    case 'tag':
      return args.some((a) => a === '--delete' || shortHas(a, 'd')) ? deny('タグは消さない') : OK;
    case 'update-ref':
      if (args.some((a) => a === '-d' || a === '--delete')) return deny('ref は消さない');
      return args.some((a) => isProtectedBranch(a.replace(/^refs\/heads\//, ''), ctx)) ? deny('本線の ref は書き換えない') : OK;
    case 'checkout':
    case 'switch':
      if (args.some((a) => a === '-B' || a === '-C' || a === '--force-create') && args.some((a) => isProtectedBranch(a, ctx))) {
        return deny('本線の名前でブランチを作り直さない');
      }
      return OK;
    case 'credential':
      return deny('git credential は使わない（秘密）');
    case 'config':
      return args.some((a) => /credential|token|password/i.test(a)) ? deny('秘密の設定は扱わない') : OK;
    case 'filter-branch':
    case 'filter-repo':
    case 'replace':
      return deny(`git ${sub} は使わない（履歴を書き換える）`);
    case 'reflog':
      return args[0] === 'expire' || args[0] === 'delete' ? deny('reflog は消さない') : OK;
    case 'prune':
    case 'gc':
      return deny(`git ${sub} は使わない`);
    default:
      return OK;
  }
}

function checkGitPush(args: string[], ctx: SafetyContext): Decision {
  if (!ctx.allowPush) return deny('この仕事では push しない（push はコードがする）');
  const pos: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === '--force' || a === '--force-if-includes' || a.startsWith('--force-with-lease')) {
      return deny('force push はしない');
    }
    if (['--delete', '--mirror', '--all', '--branches', '--prune'].includes(a)) return deny(`git push ${a} は使わない`);
    if (/^-[A-Za-z]+$/.test(a)) {
      if (a.includes('f')) return deny('force push はしない');
      if (a.includes('d')) return deny('push でブランチを消さない');
      if (a === '-o') k++;
      continue;
    }
    if (['--push-option', '--repo', '--receive-pack', '--exec'].includes(a)) {
      k++;
      continue;
    }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const refspecs = pos.slice(1);
  if (refspecs.length === 0) return checkPushTarget(ctx.currentBranch, ctx);
  for (const spec of refspecs) {
    if (spec.startsWith('+')) return deny('force push（+ の refspec）はしない');
    if (spec.startsWith(':')) return deny('push でブランチを消さない');
    const colon = spec.indexOf(':');
    const src = colon >= 0 ? spec.slice(0, colon) : spec;
    let dst = colon >= 0 ? spec.slice(colon + 1) : spec;
    if (colon < 0 && (src === 'HEAD' || src === '@')) dst = ctx.currentBranch ?? '';
    const d = checkPushTarget(dst.replace(/^refs\/heads\//, ''), ctx);
    if (!d.ok) return d;
  }
  return OK;
}

function checkPushTarget(branch: string | undefined, ctx: SafetyContext): Decision {
  if (!branch || branch === 'HEAD') return deny('push 先のブランチが分からない。`git push -u origin <ブランチ名>` と書く');
  if (isProtectedBranch(branch, ctx)) return deny(`本線（${branch}）へ直接 push しない`);
  return OK;
}

/** reset --hard は、自分のブランチを origin に合わせるものだけ */
function checkHardReset(args: string[], ctx: SafetyContext): Decision {
  const pos = positional(args);
  const cur = ctx.currentBranch;
  if (cur && cur !== 'HEAD' && !isProtectedBranch(cur, ctx) && pos.length === 1 && pos[0] === `origin/${cur}`) return OK;
  return deny('git reset --hard は、`git reset --hard origin/<いまのブランチ>` のほかは使わない');
}

// ───────────────────────── gh ─────────────────────────

function checkGh(rest: string[]): Decision {
  const g = rest[0];
  const s = rest[1];
  const args = rest.slice(2);
  if (g === 'pr' && s === 'merge') return deny('マージはエージェントではなくコードがする');
  if (g === 'pr' && s === 'close') return deny('PR は閉じない（同じ Issue の PR が2本あっても、報告に書くだけ）');
  if ((g === 'pr' || g === 'issue') && s === 'edit' && hasMergeLabel(args)) {
    return deny('「マージ」のラベルはマージと同じ扱い（AGENTS.md）。付け外ししない');
  }
  if (g === 'repo' && ['delete', 'edit', 'rename', 'archive', 'unarchive'].includes(s ?? '')) return deny(`gh repo ${s} は使わない`);
  if (g === 'issue' && (s === 'delete' || s === 'transfer')) return deny(`gh issue ${s} は使わない`);
  if (g === 'label' && (s === 'delete' || s === 'edit')) return deny(`gh label ${s} は使わない`);
  if (g === 'release' && (s === 'delete' || s === 'delete-asset')) return deny('リリースは消さない');
  if ((g === 'run' || g === 'cache') && s === 'delete') return deny(`gh ${g} delete は使わない`);
  if ((g === 'ssh-key' || g === 'gpg-key') && s === 'delete') return deny('鍵は消さない');
  if (g === 'secret' || g === 'variable') return deny(`gh ${g} は使わない（秘密・共有の設定）`);
  if (g === 'workflow' && ['run', 'enable', 'disable'].includes(s ?? '')) return deny(`gh workflow ${s} は使わない`);
  if (g === 'auth') {
    if (s === 'status' && !args.some((a) => a === '--show-token' || a === '-t')) return OK;
    return deny('gh auth は使わない（トークン）');
  }
  if (g === 'api') return checkGhApi(rest.slice(1));
  return OK;
}

function hasMergeLabel(args: string[]): boolean {
  const labelFlag = args.some((a) => /^--(add|remove)-label/.test(a));
  return labelFlag && args.some((a) => a.includes('マージ'));
}

/** gh api は読むだけ（GET と、mutation の無い graphql） */
function checkGhApi(args: string[]): Decision {
  let method: string | undefined;
  let hasFields = false;
  let endpoint: string | undefined;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === '-X' || a === '--method') {
      method = args[++k];
      continue;
    }
    if (/^-X./.test(a)) {
      method = a.slice(2);
      continue;
    }
    if (a.startsWith('--method=')) {
      method = a.slice('--method='.length);
      continue;
    }
    if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a)) {
      hasFields = true;
      k++;
      continue;
    }
    if (/^--(raw-)?field=/.test(a) || /^-[fF]./.test(a)) {
      hasFields = true;
      continue;
    }
    if (['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'].includes(a)) {
      k++;
      continue;
    }
    if (a.startsWith('-')) continue;
    endpoint ??= a;
  }
  if (endpoint === 'graphql') {
    return /mutation/i.test(args.join(' ')) ? deny('gh api graphql の mutation は使わない') : OK;
  }
  const m = (method ?? (hasFields ? 'POST' : 'GET')).toUpperCase();
  if (m !== 'GET') return deny(`gh api の ${m} は使わない（書き込みは gh pr create・gh issue comment などで）`);
  return OK;
}

// ───────────────────────── 消す・書く ─────────────────────────

function checkRemove(rest: string[], cwd: string, ctx: SafetyContext): Decision {
  const targets = rest.filter((a) => !a.startsWith('-') && !/^\d*[<>]/.test(a));
  for (const t of targets) {
    const r = resolvePath(t, cwd, ctx);
    if (!r) return deny(`消す先が決まらない（${t}）。変数や ~ を使わずに書く`);
    if (samePath(r, ctx.workdir, ctx)) return deny('worktree そのものは消さない');
    if (isInside(r, joinPath(ctx, ctx.workdir, '.git'), ctx)) return deny('.git は消さない');
    if (isInside(r, ctx.workdir, ctx)) {
      const parent = pathApi(ctx).dirname(r);
      if (samePath(parent, ctx.workdir, ctx) && /[*?]/.test(pathApi(ctx).basename(r))) {
        return deny('worktree の直下をまとめて消さない');
      }
      continue;
    }
    if (isInside(r, ctx.logDir, ctx) && !samePath(r, ctx.logDir, ctx)) continue;
    return deny(`worktree とログの置き場の外は消さない：${t}`);
  }
  return OK;
}

function checkFind(rest: string[], cwd: string, ctx: SafetyContext): Decision {
  const deletes = rest.includes('-delete') || rest.some((a, k) => (a === '-exec' || a === '-execdir') && cmdName(rest[k + 1] ?? '') === 'rm');
  if (!deletes) return OK;
  const starts: string[] = [];
  for (const a of rest) {
    if (a.startsWith('-') || a === '!' || a === '(') break;
    starts.push(a);
  }
  // 探し始めの場所は消す先ではないので、worktree・ログの置き場そのものでもよい
  for (const s of starts.length ? starts : ['.']) {
    const r = resolvePath(s, cwd, ctx);
    if (!r) return deny(`消す先が決まらない（${s}）`);
    if (!isInside(r, ctx.workdir, ctx) && !isInside(r, ctx.logDir, ctx)) return deny(`worktree とログの置き場の外は消さない：${s}`);
  }
  return OK;
}

/** mv・cp・tee の先：worktree・allowedDirs の中だけ */
function checkTargets(targets: string[], cwd: string, ctx: SafetyContext): Decision {
  for (const t of targets) {
    const d = checkBashWriteTarget(t, cwd, ctx);
    if (!d.ok) return d;
  }
  return OK;
}

function checkBashWriteTarget(target: string, cwd: string, ctx: SafetyContext): Decision {
  if (/^\/dev\/(null|stdout|stderr)$/.test(target) || /^nul$/i.test(target)) return OK;
  const r = resolvePath(target, cwd, ctx);
  if (!r) return deny(`書き込み先が決まらない（${target}）`);
  if (isInside(r, joinPath(ctx, ctx.workdir, '.git'), ctx)) return deny('.git の中は書き換えない');
  if (isInside(r, ctx.workdir, ctx) || ctx.allowedDirs.some((d) => isInside(r, d, ctx))) return OK;
  return deny(`worktree とログの置き場の外へは書かない：${target}`);
}

function isEnvDump(rest: string[]): boolean {
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (a === '-u' || a === '--unset' || a === '-C' || a === '--chdir' || a === '-S') {
      k++;
      continue;
    }
    if (a.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue;
    return false; // 続きのコマンドがある（env X=1 cmd）
  }
  return true;
}

function isVarDump(name: string, rest: string[]): boolean {
  const names = rest.filter((a) => !a.startsWith('-') && !a.startsWith('+'));
  if (name === 'set') return rest.length === 0;
  return names.length === 0;
}

// ───────────────────────── パス ─────────────────────────

function pathApi(ctx: SafetyContext): path.PlatformPath {
  return ctx.platform === 'win32' ? path.win32 : path.posix;
}

function joinPath(ctx: SafetyContext, ...parts: string[]): string {
  return pathApi(ctx).join(...parts);
}

/** シェルの語を絶対パスにする。$ や ` を含んで決まらないときは undefined */
export function resolvePath(word: string, cwd: string, ctx: SafetyContext): string | undefined {
  if (/[$`]/.test(word)) return undefined;
  let s = word;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = ctx.homeDir + s.slice(1);
  else if (s.startsWith('~')) return undefined;
  if (ctx.platform === 'win32') {
    s = s.replace(/\\/g, '/');
    if (/^\/[a-zA-Z](\/|$)/.test(s)) s = `${s[1]}:/${s.slice(3)}`; // Git Bash の /c/Users → c:/Users
    else if (s === '/tmp' || s.startsWith('/tmp/')) s = ctx.tmpDir.replace(/\\/g, '/') + s.slice(4);
  }
  return pathApi(ctx).resolve(cwd, s);
}

function norm(p: string, ctx: SafetyContext): string {
  let s = pathApi(ctx).resolve(p);
  if (ctx.platform === 'win32') s = s.toLowerCase();
  return s.replace(/[\\/]+$/, '');
}

export function isInside(child: string, parent: string, ctx: SafetyContext): boolean {
  const c = norm(child, ctx);
  const p = norm(parent, ctx);
  const sep = ctx.platform === 'win32' ? '\\' : '/';
  return c === p || c.startsWith(p + sep);
}

function samePath(a: string, b: string, ctx: SafetyContext): boolean {
  return norm(a, ctx) === norm(b, ctx);
}

function isProtected(abs: string, ctx: SafetyContext): boolean {
  if (isInside(abs, ctx.workdir, ctx)) return false;
  if (ctx.allowedDirs.some((d) => isInside(abs, d, ctx))) return false;
  return ctx.protectedDirs.some((d) => isInside(abs, d, ctx));
}

function looksLikePath(w: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(w) || w.startsWith('/') || w.startsWith('~') || w.startsWith('\\\\') || /(^|[\\/])\.\.([\\/]|$)/.test(w);
}

/** `--body-file=/c/x` のような語は、= の後ろもパスとして見る */
function pathCandidates(w: string): string[] {
  const eq = w.indexOf('=');
  return eq > 0 ? [w, w.slice(eq + 1)] : [w];
}

/** 秘密の入ったファイルの名前（.env・認証の写しなど）。.env.example などの見本は除く */
export function isSecretFileWord(w: string): boolean {
  const base = w.replace(/\\/g, '/').split('/').pop() ?? '';
  if (/^\.env(\..+)?$/i.test(base) && !/\.(example|sample|template|dist)$/i.test(base)) return true;
  if (/^(\.credentials\.json|\.git-credentials|\.netrc|_netrc)$/i.test(base)) return true;
  return /^id_(rsa|ed25519|ecdsa|dsa)$/i.test(base);
}

function isProtectedBranch(name: string, ctx: SafetyContext): boolean {
  return ctx.protectedBranches.includes(name.replace(/^origin\//, ''));
}

function cmdName(tok: string): string {
  const base = tok.replace(/\\/g, '/').split('/').pop() ?? tok;
  return base.replace(/\.exe$/i, '').toLowerCase();
}

/** `-uf` のような短いオプションのまとまりに、その文字があるか */
function shortHas(a: string, ch: string): boolean {
  return /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(ch);
}

function positional(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('-'));
}
