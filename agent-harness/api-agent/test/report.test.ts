// お金の上限・秘密を伏せる・CI の結果の読み取り・頼みの文・認証の env（src/report.ts・src/shell.ts・src/agent.ts）
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthError, buildAgentEnv, fillTemplate, finalLine, readPrompt, requireApiKey } from '../src/agent.ts';
import { Budget, redact } from '../src/report.ts';
import { parseCiResult } from '../src/shell.ts';

describe('Budget', () => {
  it('1件の上限と1回の残りの、小さいほうを渡す', () => {
    const b = new Budget(10, 3);
    assert.equal(b.capForCall(0), 3);
    assert.equal(b.capForCall(2.5), 0.5);
    b.add(8.5);
    assert.equal(b.capForCall(0), 1.5);
    assert.equal(b.canStartItem(), true);
  });
  it('残りが無ければ呼ばない・始めない', () => {
    const b = new Budget(1, 3);
    b.add(0.97);
    assert.equal(b.capForCall(0), 0);
    assert.equal(b.canStartItem(), false);
    assert.equal(b.capForCall(3), 0);
  });
  it('おかしな額は足さない', () => {
    const b = new Budget(5, 1);
    b.add(Number.NaN);
    b.add(-2);
    assert.equal(b.spent, 0);
  });
});

describe('redact', () => {
  it('キーらしい文字と、環境変数の秘密の値を伏せる', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-ABCDEFGHIJKLMNOP', GH_TOKEN: 'my-long-github-token-value', PATH: '/usr/bin:/bin:/usr/local/bin' };
    const out = redact('key=sk-ant-api03-ABCDEFGHIJKLMNOP gh=my-long-github-token-value ghp_abcdefghijklmnopqrstuvwxyz0123 path=/usr/bin:/bin:/usr/local/bin', env);
    assert.ok(!out.includes('ABCDEFGHIJKLMNOP'));
    assert.ok(!out.includes('my-long-github-token-value'));
    assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'));
    assert.ok(out.includes('/usr/bin:/bin:/usr/local/bin'), '秘密でない値は残す');
  });
});

describe('parseCiResult', () => {
  it('全部 ok で done=yes なら通った', () => {
    const r = parseCiResult('head=abc\ngo-vet=ok\ngo-test=ok\nvitest=ok\ndone=yes\n', 'x');
    assert.equal(r.ok, true);
    assert.equal(r.head, 'abc');
    assert.deepEqual(
      r.steps.map((s) => s.name),
      ['go-vet', 'go-test', 'vitest'],
    );
  });
  it('1つでも FAIL なら通らない', () => {
    assert.equal(parseCiResult('head=abc\ngo-vet=ok\nintegration=FAIL(server did not start)\ndone=yes', 'x').ok, false);
  });
  it('done=yes が無い（途中で止まった）なら、ok だけでも通らない', () => {
    const r = parseCiResult('head=abc\ngo-vet=ok\ngo-test=ok\n', 'x');
    assert.equal(r.ok, false);
    assert.equal(r.steps.at(-1)?.status, 'FAIL(途中で止まった)');
  });
  it('空なら通らない', () => {
    assert.equal(parseCiResult('', 'x').ok, false);
  });
});

describe('頼みの文', () => {
  it('{{名前}} を埋め、足りなければ止める', () => {
    assert.equal(fillTemplate('#{{N}} は {{T}}', { N: '3', T: '題 {{X}}' }), '#3 は 題 {{X}}');
    assert.throws(() => fillTemplate('{{N}} {{M}}', { N: '1' }));
  });
  it('3つの頼みの文の {{…}} が、コードの渡す名前で埋まる', () => {
    const issueVars = ['ISSUE_NUMBER', 'ISSUE_TITLE', 'ISSUE_URL', 'ISSUE_BODY', 'ISSUE_COMMENTS', 'WORKTREE', 'BRANCH', 'BASE', 'LOCAL_CI', 'CI_LOG_DIR', 'SCRATCH', 'HEAVY'];
    const conflictVars = ['PR_NUMBER', 'PR_TITLE', 'PR_URL', 'PR_BODY', 'HEAD_BRANCH', 'BASE', 'WORKTREE', 'CONFLICT_FILES', 'HEAVY'];
    const ciVars = ['PR_NUMBER', 'PR_TITLE', 'PR_URL', 'HEAD_BRANCH', 'BASE', 'WORKTREE', 'CI_RESULT', 'CI_LOG_DIR', 'HEAVY'];
    for (const [name, vars] of [
      ['issue', issueVars],
      ['merge-conflict', conflictVars],
      ['ci-failure', ciVars],
    ] as const) {
      const filled = fillTemplate(readPrompt(name), Object.fromEntries(vars.map((v) => [v, `<${v}>`])));
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(filled), `${name} に埋まらない {{…}} が残った`);
    }
  });
  it('最後の「結果:」「判定:」の行を読む', () => {
    assert.equal(finalLine('直した。\n\n結果: PR https://github.com/o/r/pull/9', '結果'), 'PR https://github.com/o/r/pull/9');
    assert.equal(finalLine('見立て…\n- `判定：回し直す`', '判定'), '回し直す');
    assert.equal(finalLine('判定: 直した\nそのあと\n判定: 直せない 設計の判断が要る', '判定'), '直せない 設計の判断が要る');
    assert.equal(finalLine('何も書いていない', '結果'), undefined);
  });
});

describe('認証', () => {
  it('ANTHROPIC_API_KEY が無い・空なら止める（キーの値は出さない）', () => {
    assert.throws(() => requireApiKey({}), AuthError);
    assert.throws(() => requireApiKey({ ANTHROPIC_API_KEY: '  ' }), AuthError);
    assert.doesNotThrow(() => requireApiKey({ ANTHROPIC_API_KEY: 'sk-ant-x' }));
  });
  it('API キーより先に効く認証と、持ち主の設定の置き場を外す', () => {
    const env = buildAgentEnv({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      ANTHROPIC_AUTH_TOKEN: 't',
      ANTHROPIC_BASE_URL: 'http://proxy',
      ANTHROPIC_PROFILE: 'p',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CONFIG_DIR: '/home/u/.claude',
    });
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-x');
    assert.equal(env.PATH, '/bin');
    for (const k of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK']) {
      assert.equal(env[k], undefined, k);
    }
    assert.notEqual(env.CLAUDE_CONFIG_DIR, '/home/u/.claude');
    assert.match(String(env.CLAUDE_CONFIG_DIR), /\.sukusuku-api-agent/);
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  });
});
