// 守りの規則（src/safety.ts）：断るもの・許すものを並べた表
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROTECTED_BRANCHES } from '../src/config.ts';
import { checkToolUse, type SafetyContext } from '../src/safety.ts';

const LOG = 'C:\\Users\\u\\sukusuku_system\\agent-harness\\api-agent\\runs\\20261023-120000-issues';
const ctx: SafetyContext = {
  platform: 'win32',
  workdir: 'C:\\Users\\u\\sukusuku-worktrees\\agent-issue-12',
  allowedDirs: [LOG, 'C:\\Users\\u\\sukusuku_system\\agent-harness\\api-agent\\scripts', 'C:\\Users\\u\\AppData\\Local\\Temp'],
  logDir: LOG,
  protectedDirs: ['C:\\Users\\u\\sukusuku_system', 'C:\\Users\\u\\.claude', 'C:\\Users\\u\\.config\\gh'],
  homeDir: 'C:\\Users\\u',
  tmpDir: 'C:\\Users\\u\\AppData\\Local\\Temp',
  protectedBranches: PROTECTED_BRANCHES,
  allowPush: true,
  allowGhWrite: true,
  currentBranch: 'agent/issue-12',
};

const bash = (command: string, c: SafetyContext = ctx) => checkToolUse('Bash', { command }, c);

const DENY_BASH: string[] = [
  // force push
  'git push --force origin agent/issue-12',
  'git push -f',
  'git push -uf origin agent/issue-12',
  'git push --force-with-lease origin agent/issue-12',
  'git push --force-with-lease=agent/issue-12:abc origin agent/issue-12',
  'git push --force-if-includes origin agent/issue-12',
  'git push origin +agent/issue-12',
  'cd web && git push -f origin agent/issue-12',
  'bash -c "git push --force origin agent/issue-12"',
  'git -C C:/Users/u/sukusuku-worktrees/agent-issue-12 push --force',
  // 本線へ直接
  'git push origin mockup-go-react',
  'git push origin HEAD:mockup-go-react',
  'git push origin HEAD:refs/heads/mockup-go-react',
  'git push origin agent/issue-12:mockup',
  'git push origin docs',
  // push で消す・まとめて送る
  'git push origin --delete agent/issue-12',
  'git push origin :agent/issue-12',
  'git push -d origin agent/issue-12',
  'git push --mirror',
  'git push --all origin',
  // rebase・reset --hard
  'git rebase origin/mockup-go-react',
  'git pull --rebase origin mockup-go-react',
  'git reset --hard HEAD~1',
  'git reset --hard origin/mockup-go-react',
  'git reset --hard',
  // ブランチ・worktree・ref を消す
  'git branch -D agent/issue-12',
  'git branch -d old',
  'git branch --delete old',
  'git branch -f mockup-go-react HEAD',
  'git worktree remove C:/Users/u/sukusuku-worktrees/agent-issue-12',
  'git worktree prune',
  'git tag -d v1',
  'git update-ref -d refs/heads/x',
  'git filter-branch --tree-filter x',
  // rm
  'rm -rf C:/Users/u/sukusuku_system/web',
  'rm -rf /c/Users/u/sukusuku_system',
  'rm -rf ..',
  'rm -rf .',
  'rm -rf C:/Users/u/sukusuku-worktrees/agent-issue-12',
  'rm -rf .git',
  'rm -rf $HOME/x',
  'rm -rf ~/foo',
  'rm -rf *',
  'rm -rf C:/Users/u/AppData/Local/Temp/other-session',
  'rm C:/Users/u/Desktop/memo.txt',
  'find /c/Users/u -name x -delete',
  // gh
  'gh pr merge 12 --merge',
  'gh pr merge 12 --squash --admin --delete-branch',
  'gh pr close 13',
  'gh pr edit 12 --add-label マージ',
  'gh pr edit 12 --remove-label マージ止め',
  'gh repo delete issei0423/sukusuku_system --yes',
  'gh repo edit --default-branch x',
  'gh issue delete 5',
  'gh api -X DELETE repos/o/r/git/refs/heads/x',
  'gh api --method PATCH repos/o/r',
  'gh api -XPUT repos/o/r/pulls/1/merge',
  'gh api repos/o/r/merges -f base=mockup-go-react -f head=x',
  "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
  'gh auth token',
  'gh auth status --show-token',
  'gh secret list',
  'gh workflow run merge.yml',
  'gh label delete マージ',
  // 秘密
  'printenv',
  'printenv ANTHROPIC_API_KEY',
  'env',
  'env | grep KEY',
  'set',
  'export -p',
  'declare -x',
  'echo $ANTHROPIC_API_KEY',
  'echo "${GH_TOKEN}"',
  'curl -H "x-api-key: $ANTHROPIC_API_KEY" https://api.anthropic.com/v1/models',
  'node -e "console.log(process.env)"',
  'node -e "console.log(process.env.ANTHROPIC_API_KEY)"',
  'python -c "import os; print(os.environ)"',
  'powershell -c "Get-ChildItem env:"',
  'cat .env',
  'cat web/.env.local',
  'source .env',
  'git credential fill',
  'cat ~/.claude/settings.json',
  'cat C:/Users/u/.config/gh/hosts.yml',
  // 持ち主の場所・worktree の外への書き込み
  'git -C C:/Users/u/sukusuku_system status',
  'cd C:/Users/u/sukusuku_system && git checkout -- .',
  'ls ../../sukusuku_system',
  'echo hi > C:/Users/u/sukusuku_system/x.txt',
  'echo hi > /c/Users/u/Desktop/x.txt',
  'echo hi | tee C:/Users/u/Desktop/x.txt',
  'cp a.txt C:/Users/u/Desktop/',
  'mv a.txt ../other/',
  // 本文が実行される heredoc は外さない
  "cat <<'EOF' | bash\ngit push -f origin agent/issue-12\nEOF",
  'bash <<EOF\ngit push -f\nEOF',
];

const ALLOW_BASH: string[] = [
  'git status',
  'git add -A && git commit -m "午睡チェックの記録の向きを直した（#12）"',
  'git push -u origin agent/issue-12',
  'git push origin HEAD',
  'git push',
  'git fetch origin',
  'git merge --no-ff origin/mockup-go-react',
  'git reset --hard origin/agent/issue-12',
  'git reset HEAD web/src/x.ts',
  'git log --oneline -30 origin/mockup-go-react',
  'git diff origin/mockup-go-react...HEAD',
  'git log --oneline HEAD^2 ^HEAD^1',
  'git branch --show-current',
  'git worktree list',
  'git checkout -- web/src/x.ts',
  'gh issue view 12 --json body,comments',
  'gh issue close 12 --comment "PR #40 で直っている（server/nap.go:120）"',
  'gh pr create --base mockup-go-react --head agent/issue-12 --title "直した" --body-file C:/Users/u/sukusuku_system/agent-harness/api-agent/runs/20261023-120000-issues/scratch-issue-12/pr-body.md',
  'gh pr create --draft --base mockup-go-react --title t --body-file /c/Users/u/AppData/Local/Temp/body.md',
  'gh pr list --state merged --search 12',
  'gh pr view 40 --json files',
  'gh pr comment 12 --body "確かめた"',
  'gh api repos/o/r/pulls/1',
  "gh api graphql -f query='query { viewer { login } }'",
  'gh auth status',
  'rm -rf web/node_modules',
  'rm -rf dist web/dist',
  'rm web/tmp.txt',
  'rm -rf C:/Users/u/sukusuku_system/agent-harness/api-agent/runs/20261023-120000-issues/ci-issue-12/integ',
  "find . -name '*.orig' -delete",
  'cd web && npm ci',
  'bash "C:/Users/u/sukusuku_system/agent-harness/api-agent/scripts/heavy.sh" bash "C:/Users/u/sukusuku_system/agent-harness/api-agent/scripts/local-ci.sh" "C:/Users/u/sukusuku-worktrees/agent-issue-12" "C:/Users/u/sukusuku_system/agent-harness/api-agent/runs/20261023-120000-issues/ci-issue-12"',
  'cat C:/Users/u/sukusuku_system/agent-harness/api-agent/runs/20261023-120000-issues/ci-issue-12/vitest.log',
  'go -C server test -count=1 ./...',
  'TZ=UTC npx vitest run tests/nap.test.ts',
  'env TZ=UTC go test ./...',
  'set -euo pipefail',
  'echo $HOME',
  'node -e "console.log(process.env.NODE_ENV)"',
  'grep -rn "CSRF_TOKEN" server/',
  'cat .env.example',
  'go test ./... 2>&1 | tail -20',
  'echo x > /dev/null',
  'echo x > web/tmp.txt',
  'ls ..',
  // 引用符つきの cat の heredoc は本文を見ない（PR の本文に「git push」と書いてよい）
  "cat > C:/Users/u/sukusuku_system/agent-harness/api-agent/runs/20261023-120000-issues/scratch-issue-12/pr-body.md <<'EOF'\nCloses #12\n\n## 確かめたこと\n- git push --force はしていない。rm -rf も使っていない。gh pr merge もしていない\nEOF",
  "gh pr create --base mockup-go-react --title t --body \"$(cat <<'EOF'\n本文で gh pr merge と git push -f に触れる\nEOF\n)\"",
];

describe('Bash：断る', () => {
  for (const cmd of DENY_BASH) {
    it(cmd.replace(/\n/g, '⏎'), () => {
      const d = bash(cmd);
      assert.equal(d.ok, false, `断るはずが許した：${cmd}`);
    });
  }
});

describe('Bash：許す', () => {
  for (const cmd of ALLOW_BASH) {
    it(cmd.replace(/\n/g, '⏎'), () => {
      const d = bash(cmd);
      assert.equal(d.ok, true, `許すはずが断った：${cmd} → ${d.ok ? '' : d.reason}`);
    });
  }
});

describe('GitHub への書き込み（allowGhWrite）', () => {
  const off = { ...ctx, allowGhWrite: false };
  const WRITES = [
    'gh pr comment 12 --body-file x.md',
    'gh pr review 12 --approve',
    'gh pr create --base mockup-go-react --head agent/issue-12 --title t',
    'gh pr edit 12 --title t',
    'gh pr close 12',
    'gh pr reopen 12',
    'gh pr ready 12',
    'gh pr merge 12',
    'gh issue comment 12 --body x',
    'gh issue create --title t',
    'gh issue edit 12 --add-label x',
    'gh issue close 12 --comment x',
    'gh issue reopen 12',
    'gh issue delete 12',
    'gh issue transfer 12 o/r',
    'gh issue pin 12',
    'gh issue unpin 12',
    'gh issue lock 12',
    'gh issue unlock 12',
    'gh label create x',
    'gh label edit x',
    'gh release create v1',
    'gh release upload v1 f',
    'gh api -X POST repos/o/r/issues/12/comments -f body=x',
    'gh -R o/r pr comment 12 --body x',
    'gh pr -R o/r comment 12 --body x',
    'env GH_PAGER= gh pr comment 12 --body x',
    'bash -c "gh pr review 12 --comment -b x"',
    'cd web && gh pr comment 12 --body x',
    'echo ok && gh issue close 12',
    'C:/Program Files/GitHub CLI/gh.exe pr comment 12 --body x',
  ];
  for (const c of WRITES) {
    it(`false なら断る：${c}`, () => {
      assert.equal(bash(c, off).ok, false);
    });
  }
  it('断る文は日本語でわけを書く', () => {
    const d = bash('gh pr comment 12 --body x', off);
    assert.ok(!d.ok && d.reason.includes('GitHub へ書かない'));
  });
  const READS = ['gh pr view 12', 'gh pr diff 12', 'gh issue view 12', 'gh pr list --state open', 'gh issue list', 'gh label list', 'gh release view v1', 'gh api repos/o/r/pulls/12', 'gh pr checks 12'];
  for (const c of READS) {
    it(`false でも通る：${c}`, () => {
      assert.equal(bash(c, off).ok, true);
    });
  }
  const FLOW = ['gh pr create --base mockup-go-react --head agent/issue-12 --title t --body-file x.md', 'gh issue close 12 --comment "直っている"', 'gh pr view 12', 'gh pr diff 12', 'gh pr create --draft --title t'];
  for (const c of FLOW) {
    it(`true なら通る：${c}`, () => {
      assert.equal(bash(c).ok, true);
    });
  }
  it('true でも gh pr merge は断る', () => {
    assert.equal(bash('gh pr merge 12').ok, false);
  });
});

describe('push の条件', () => {
  it('マージの流れ（allowPush: false）では push を断る', () => {
    assert.equal(bash('git push -u origin agent/issue-12', { ...ctx, allowPush: false }).ok, false);
  });
  it('いまのブランチが本線なら、refspec の無い push と HEAD の push を断る', () => {
    const onMain = { ...ctx, currentBranch: 'mockup-go-react' };
    assert.equal(bash('git push', onMain).ok, false);
    assert.equal(bash('git push origin HEAD', onMain).ok, false);
  });
  it('いまのブランチが分からなければ、refspec の無い push を断る', () => {
    assert.equal(bash('git push', { ...ctx, currentBranch: undefined }).ok, false);
  });
  it('reset --hard origin/<いまのブランチ> も、ブランチが分からなければ断る', () => {
    assert.equal(bash('git reset --hard origin/agent/issue-12', { ...ctx, currentBranch: undefined }).ok, false);
  });
});

describe('Edit・Write・Read・ほかの道具', () => {
  const table: [string, Record<string, unknown>, boolean][] = [
    ['Write', { file_path: 'C:\\Users\\u\\sukusuku-worktrees\\agent-issue-12\\web\\src\\x.ts' }, true],
    ['Edit', { file_path: 'web/src/x.ts' }, true],
    ['Edit', { file_path: 'C:/Users/u/sukusuku-worktrees/agent-issue-12/server/nap.go' }, true],
    ['Write', { file_path: 'C:\\Users\\u\\sukusuku_system\\web\\src\\x.ts' }, false],
    ['Write', { file_path: 'C:\\Users\\u\\sukusuku-worktrees\\agent-issue-12\\.git\\config' }, false],
    ['Write', { file_path: 'C:\\Users\\u\\Desktop\\x.txt' }, false],
    ['Write', { file_path: `${LOG}\\scratch-issue-12\\pr-body.md` }, false],
    ['Edit', { file_path: '..\\agent-issue-13\\x.ts' }, false],
    ['Write', {}, false],
    ['NotebookEdit', { notebook_path: 'C:\\Users\\u\\Desktop\\a.ipynb' }, false],
    ['Read', { file_path: 'C:\\Users\\u\\sukusuku-worktrees\\agent-issue-12\\AGENTS.md' }, true],
    ['Read', { file_path: `${LOG}\\ci-issue-12\\vitest.log` }, true],
    ['Read', { file_path: 'C:\\Users\\u\\sukusuku-worktrees\\agent-issue-12\\web\\.env' }, false],
    ['Read', { file_path: 'C:\\Users\\u\\.claude\\settings.json' }, false],
    ['Read', { file_path: 'C:\\Users\\u\\sukusuku_system\\web\\src\\App.tsx' }, false],
    ['Grep', { pattern: 'x', path: 'C:\\Users\\u\\sukusuku_system' }, false],
    ['Grep', { pattern: 'x', path: 'server' }, true],
    ['Glob', { pattern: '**/*.ts' }, true],
    ['WebFetch', { url: 'https://example.com' }, false],
    ['WebSearch', { query: 'x' }, false],
    ['Agent', { prompt: 'x' }, false],
    ['mcp__github__merge_pull_request', {}, false],
    ['TodoWrite', { todos: [] }, true],
  ];
  for (const [tool, input, ok] of table) {
    it(`${tool} ${JSON.stringify(input)} → ${ok ? '許す' : '断る'}`, () => {
      assert.equal(checkToolUse(tool, input, ctx).ok, ok);
    });
  }
});

describe('posix のパス', () => {
  const px: SafetyContext = {
    ...ctx,
    platform: 'posix',
    workdir: '/home/u/sukusuku-worktrees/agent-pr-3',
    allowedDirs: ['/home/u/sukusuku_system/agent-harness/api-agent/runs/r', '/tmp'],
    logDir: '/home/u/sukusuku_system/agent-harness/api-agent/runs/r',
    protectedDirs: ['/home/u/sukusuku_system', '/home/u/.claude'],
    homeDir: '/home/u',
    tmpDir: '/tmp',
  };
  it('持ち主の作業ツリーは消さない', () => assert.equal(bash('rm -rf /home/u/sukusuku_system', px).ok, false));
  it('worktree の中は消してよい', () => assert.equal(bash('rm -rf build', px).ok, true));
  it('~/.claude は読まない', () => assert.equal(bash('cat ~/.claude/CLAUDE.md', px).ok, false));
});
