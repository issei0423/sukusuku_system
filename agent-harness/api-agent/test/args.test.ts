// 引数の読み取り（src/args.ts）
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArgError, parseArgs } from '../src/args.ts';
import { DEFAULT_EFFORT, DEFAULT_MAX_USD, DEFAULT_PER_ITEM_USD } from '../src/config.ts';

describe('parseArgs', () => {
  it('何も無ければ help', () => {
    assert.equal(parseArgs([]).command, 'help');
    assert.equal(parseArgs(['--help']).command, 'help');
    assert.equal(parseArgs(['merge', '-h']).command, 'help');
  });

  it('既定の値', () => {
    const a = parseArgs(['issues']);
    assert.deepEqual(a, {
      command: 'issues',
      maxUsd: DEFAULT_MAX_USD,
      perItemUsd: DEFAULT_PER_ITEM_USD,
      dryRun: false,
      trustGhChecks: false,
      effort: DEFAULT_EFFORT,
    });
    assert.equal(DEFAULT_EFFORT, 'medium');
  });

  it('issues のオプション（空白でも = でも）', () => {
    const a = parseArgs(['issues', '--issue', '12', '--max-usd=5', '--per-item-usd', '1.5', '--dry-run', '--effort', 'high']);
    assert.equal(a.issue, 12);
    assert.equal(a.maxUsd, 5);
    assert.equal(a.perItemUsd, 1.5);
    assert.equal(a.dryRun, true);
    assert.equal(a.effort, 'high');
  });

  it('merge のオプション', () => {
    const a = parseArgs(['merge', '--pr=34', '--trust-gh-checks']);
    assert.equal(a.command, 'merge');
    assert.equal(a.pr, 34);
    assert.equal(a.trustGhChecks, true);
  });

  it('all は両方のオプションが使える', () => {
    const a = parseArgs(['all', '--issue', '1', '--pr', '2', '--trust-gh-checks']);
    assert.equal(a.command, 'all');
    assert.equal(a.issue, 1);
    assert.equal(a.pr, 2);
  });

  const bad: [string, string[]][] = [
    ['知らないコマンド', ['deploy']],
    ['知らないオプション', ['issues', '--force']],
    ['値が無い', ['issues', '--issue']],
    ['整数でない', ['issues', '--issue', '1.5']],
    ['0 の Issue', ['issues', '--issue', '0']],
    ['負の上限', ['merge', '--max-usd', '-1']],
    ['0 の上限', ['merge', '--max-usd', '0']],
    ['数でない上限', ['merge', '--per-item-usd', 'abc']],
    ['知らない effort', ['issues', '--effort', 'ultra']],
    ['merge に --issue', ['merge', '--issue', '3']],
    ['issues に --pr', ['issues', '--pr', '3']],
    ['issues に --trust-gh-checks', ['issues', '--trust-gh-checks']],
    ['--dry-run に値', ['issues', '--dry-run=yes']],
  ];
  for (const [name, argv] of bad) {
    it(`止める：${name}（${argv.join(' ')}）`, () => {
      assert.throws(() => parseArgs(argv), ArgError);
    });
  }
});
