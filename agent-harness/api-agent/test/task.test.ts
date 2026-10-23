// task コマンド：引数・場所の検査・--out の置き場・書いてよいフォルダ（src/args.ts・src/task.ts・src/safety.ts）
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';
import { ArgError, parseArgs } from '../src/args.ts';
import { DEFAULT_EFFORT, DEFAULT_MAX_USD, DEFAULT_PER_ITEM_USD, PROTECTED_BRANCHES, TASK_MAX_TURNS, TASK_TIMEOUT_MIN } from '../src/config.ts';
import { checkToolUse, type SafetyContext } from '../src/safety.ts';
import { checkTaskPlaces, safeLabel, taskLabel } from '../src/task.ts';

const R = path.resolve;

describe('parseArgs task', () => {
  it('必須と既定の値', () => {
    const a = parseArgs(['task', '--prompt-file', 'p.md', '--cwd', 'w']);
    assert.equal(a.command, 'task');
    assert.deepEqual(a.task, {
      promptFile: R('p.md'),
      cwd: R('w'),
      allowDirs: [],
      label: undefined,
      out: undefined,
      maxTurns: TASK_MAX_TURNS,
      timeoutMin: TASK_TIMEOUT_MIN,
    });
    assert.equal(TASK_MAX_TURNS, 200);
    assert.equal(TASK_TIMEOUT_MIN, 60);
    assert.equal(a.maxUsd, DEFAULT_MAX_USD);
    assert.equal(a.perItemUsd, DEFAULT_PER_ITEM_USD);
    assert.equal(a.effort, DEFAULT_EFFORT);
    assert.equal(a.dryRun, false);
  });

  it('--prompt-file と --cwd が無ければ断る', () => {
    assert.throws(() => parseArgs(['task', '--cwd', 'w']), ArgError);
    assert.throws(() => parseArgs(['task', '--prompt-file', 'p.md']), ArgError);
    assert.throws(() => parseArgs(['task']), ArgError);
  });

  it('--allow-dir は何回でも・ほかのオプションも読む', () => {
    const a = parseArgs([
      'task', '--prompt-file=p.md', '--cwd=w', '--allow-dir', 'a', '--allow-dir=b', '--label', '日誌の区画', '--out', 'w/out.md',
      '--max-turns', '50', '--timeout-min', '1.5', '--max-usd', '4', '--per-item-usd', '2', '--effort', 'high', '--dry-run',
    ]);
    assert.deepEqual(a.task!.allowDirs, [R('a'), R('b')]);
    assert.equal(a.task!.label, '日誌の区画');
    assert.equal(a.task!.out, R('w/out.md'));
    assert.equal(a.task!.maxTurns, 50);
    assert.equal(a.task!.timeoutMin, 1.5);
    assert.equal(a.maxUsd, 4);
    assert.equal(a.perItemUsd, 2);
    assert.equal(a.effort, 'high');
    assert.equal(a.dryRun, true);
  });

  it('不正な値・task でないコマンドの task のオプション', () => {
    const base = ['task', '--prompt-file', 'p.md', '--cwd', 'w'];
    assert.throws(() => parseArgs([...base, '--max-turns', '0']), ArgError);
    assert.throws(() => parseArgs([...base, '--max-turns', '2.5']), ArgError);
    assert.throws(() => parseArgs([...base, '--timeout-min', '-1']), ArgError);
    assert.throws(() => parseArgs([...base, '--allow-dir']), ArgError);
    assert.throws(() => parseArgs([...base, '--effort', 'turbo']), ArgError);
    assert.throws(() => parseArgs([...base, '--issue', '3']), ArgError);
    assert.throws(() => parseArgs([...base, '--trust-gh-checks']), ArgError);
    assert.throws(() => parseArgs(['issues', '--cwd', 'w']), ArgError);
    assert.throws(() => parseArgs(['merge', '--prompt-file', 'p.md']), ArgError);
    assert.throws(() => parseArgs(['all', '--allow-dir', 'x']), ArgError);
  });

  it('issues・merge の結果は変わらない（task は付かない）', () => {
    assert.equal(parseArgs(['issues']).task, undefined);
    assert.equal('task' in parseArgs(['merge', '--pr', '3']), false);
  });
});

describe('checkTaskPlaces（Windows の書き方）', () => {
  const protectedDirs = ['C:\\Users\\u\\sukusuku_system', 'C:\\Users\\u\\sukusuku_system\\agent-harness\\api-agent', 'C:\\Users\\u\\.claude'];
  const check = (t: { cwd: string; allowDirs?: string[]; out?: string }) =>
    checkTaskPlaces({ cwd: t.cwd, allowDirs: t.allowDirs ?? [], out: t.out }, protectedDirs, 'win32');

  it('守りの外なら通る', () => {
    assert.deepEqual(check({ cwd: 'C:\\Users\\u\\sukusuku-worktrees\\qa-chat', allowDirs: ['C:\\Users\\u\\AppData\\Local\\Temp\\qa'] }), []);
  });

  it('--cwd が守りのフォルダの中なら断る（メインの作業ツリー・api-agent・~/.claude）', () => {
    assert.equal(check({ cwd: 'C:\\Users\\u\\sukusuku_system' }).length > 0, true);
    assert.equal(check({ cwd: 'c:/users/u/sukusuku_system/web' }).length > 0, true);
    assert.equal(check({ cwd: 'C:\\Users\\u\\sukusuku_system\\agent-harness\\api-agent\\runs' }).length > 0, true);
    assert.equal(check({ cwd: 'C:\\Users\\u\\.claude\\harness' }).length > 0, true);
  });

  it('--cwd が守りのフォルダを含む親でも断る', () => {
    assert.equal(check({ cwd: 'C:\\Users\\u' }).length > 0, true);
  });

  it('--allow-dir が守りのフォルダと重なるなら断る', () => {
    const p = check({ cwd: 'C:\\Users\\u\\wt', allowDirs: ['C:\\Users\\u\\.claude', 'C:\\Users\\u\\ok'] });
    assert.equal(p.length, 1);
    assert.match(p[0]!, /--allow-dir/);
    assert.equal(check({ cwd: 'C:\\Users\\u\\wt', allowDirs: ['C:\\Users\\u\\sukusuku_system\\web'] }).length > 0, true);
  });

  it('--out は --cwd か --allow-dir の中だけ', () => {
    const t = { cwd: 'C:\\Users\\u\\wt', allowDirs: ['C:\\Users\\u\\AppData\\Local\\Temp\\qa'] };
    assert.deepEqual(check({ ...t, out: 'C:\\Users\\u\\wt\\out\\r.md' }), []);
    assert.deepEqual(check({ ...t, out: 'C:\\Users\\u\\AppData\\Local\\Temp\\qa\\r.md' }), []);
    assert.equal(check({ ...t, out: 'C:\\Users\\u\\elsewhere\\r.md' }).length, 1);
    assert.equal(check({ ...t, out: 'C:\\Users\\u\\wt-other\\r.md' }).length, 1);
    assert.equal(check({ ...t, out: 'C:\\Users\\u\\wt\\..\\x.md' }).length, 1);
  });
});

describe('checkTaskPlaces（POSIX の書き方）', () => {
  it('守りの中・外', () => {
    const protectedDirs = ['/home/u/sukusuku_system', '/home/u/.claude'];
    assert.deepEqual(checkTaskPlaces({ cwd: '/home/u/wt', allowDirs: ['/tmp/qa'], out: '/tmp/qa/r.md' }, protectedDirs, 'posix'), []);
    assert.equal(checkTaskPlaces({ cwd: '/home/u/sukusuku_system/x', allowDirs: [] }, protectedDirs, 'posix').length > 0, true);
    assert.equal(checkTaskPlaces({ cwd: '/home/u/wt', allowDirs: ['/home/u/.claude/x'] }, protectedDirs, 'posix').length > 0, true);
  });
});

describe('task の書いてよいフォルダ（safety）', () => {
  const ctx: SafetyContext = {
    platform: 'win32',
    workdir: 'C:\\Users\\u\\wt',
    allowedDirs: ['C:\\Users\\u\\logs', 'C:\\Users\\u\\AppData\\Local\\Temp', 'C:\\Users\\u\\qa-out'],
    writeDirs: ['C:\\Users\\u\\qa-out'],
    logDir: 'C:\\Users\\u\\logs',
    protectedDirs: ['C:\\Users\\u\\sukusuku_system', 'C:\\Users\\u\\.claude'],
    homeDir: 'C:\\Users\\u',
    tmpDir: 'C:\\Users\\u\\AppData\\Local\\Temp',
    protectedBranches: PROTECTED_BRANCHES,
    allowPush: false,
    allowGhWrite: false,
    currentBranch: 'qa/x',
  };
  const write = (file: string, c = ctx) => checkToolUse('Write', { file_path: file }, c).ok;

  it('cwd と --allow-dir の中へは Write できる。それ以外は断る', () => {
    assert.equal(write('C:\\Users\\u\\wt\\a.md'), true);
    assert.equal(write('C:\\Users\\u\\qa-out\\r.md'), true);
    assert.equal(write('C:\\Users\\u\\qa-out\\.git\\config'), false);
    assert.equal(write('C:\\Users\\u\\other\\r.md'), false);
    assert.equal(write('C:\\Users\\u\\.claude\\x.md'), false);
  });

  it('writeDirs が無い（issues・merge）ときは今までどおり workdir だけ', () => {
    const c = { ...ctx, writeDirs: undefined };
    assert.equal(write('C:\\Users\\u\\qa-out\\r.md', c), false);
    assert.equal(write('C:\\Users\\u\\wt\\a.md', c), true);
  });

  it('push は断る（allowPush が false）', () => {
    assert.equal(checkToolUse('Bash', { command: 'git push origin qa/x' }, ctx).ok, false);
  });
});

describe('見出し', () => {
  it('既定はファイル名・記録のファイル名に使える形', () => {
    assert.equal(taskLabel({ promptFile: R('a/chat.md') }), 'chat.md');
    assert.equal(taskLabel({ promptFile: R('a/chat.md'), label: '日誌' }), '日誌');
    assert.equal(safeLabel('日誌の区画 / A:B'), 'task-日誌の区画-A-B');
    assert.equal(safeLabel('///'), 'task-x');
  });
});
