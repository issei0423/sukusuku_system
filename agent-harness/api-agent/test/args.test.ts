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
      includeDrafts: false,
      force: false,
      noModel: false,
      recheckMain: false,
      effort: DEFAULT_EFFORT,
    });
    assert.equal(DEFAULT_EFFORT, 'medium');
  });

  it('review の既定と、--pr・--include-drafts・--force の組み合わせ', () => {
    const d = parseArgs(['review']);
    assert.equal(d.command, 'review');
    assert.equal(d.pr, undefined);
    assert.equal(d.includeDrafts, false);
    assert.equal(d.force, false);
    assert.equal(d.maxUsd, DEFAULT_MAX_USD);
    assert.equal(d.perItemUsd, DEFAULT_PER_ITEM_USD);
    const a = parseArgs(['review', '--pr', '7', '--include-drafts', '--force', '--max-usd', '4', '--per-item-usd=1.5', '--dry-run']);
    assert.equal(a.pr, 7);
    assert.equal(a.includeDrafts, true);
    assert.equal(a.force, true);
    assert.equal(a.maxUsd, 4);
    assert.equal(a.perItemUsd, 1.5);
    assert.equal(a.dryRun, true);
    const f = parseArgs(['review', '--force']);
    assert.equal(f.force, true);
    assert.equal(f.includeDrafts, false);
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

  it('queue の既定と --no-model', () => {
    const q = parseArgs(['queue']);
    assert.equal(q.command, 'queue');
    assert.equal(q.noModel, false);
    assert.equal(q.dryRun, false);
    const a = parseArgs(['queue', '--no-model', '--dry-run', '--max-usd', '2', '--effort', 'low']);
    assert.equal(a.noModel, true);
    assert.equal(a.dryRun, true);
    assert.equal(a.maxUsd, 2);
    assert.equal(a.effort, 'low');
    assert.equal(a.recheckMain, false);
    assert.equal(parseArgs(['queue', '--recheck-main']).recheckMain, true);
    assert.equal(parseArgs(['queue', '--recheck-main', '--dry-run']).dryRun, true);
  });

  it('all は両方のオプションが使える', () => {
    const a = parseArgs(['all', '--issue', '1', '--pr', '2', '--trust-gh-checks']);
    assert.equal(a.command, 'all');
    assert.equal(a.issue, 1);
    assert.equal(a.pr, 2);
  });

  const bad: [string, string[]][] = [
    ['review に --issue', ['review', '--issue', '3']],
    ['review に --trust-gh-checks', ['review', '--trust-gh-checks']],
    ['issues に --force', ['issues', '--force']],
    ['all に --force', ['all', '--force']],
    ['merge に --include-drafts', ['merge', '--include-drafts']],
    ['--force に値', ['review', '--force=yes']],
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
    ['merge に --no-model', ['merge', '--no-model']],
    ['issues に --no-model', ['issues', '--no-model']],
    ['all に --no-model', ['all', '--no-model']],
    ['--no-model に値', ['queue', '--no-model=1']],
    ['queue に --pr', ['queue', '--pr', '3']],
    ['queue に --issue', ['queue', '--issue', '3']],
    ['queue に --trust-gh-checks', ['queue', '--trust-gh-checks']],
    ['queue に --force', ['queue', '--force']],
    ['merge に --recheck-main', ['merge', '--recheck-main']],
    ['all に --recheck-main', ['all', '--recheck-main']],
    ['--recheck-main に値', ['queue', '--recheck-main=yes']],
  ];
  for (const [name, argv] of bad) {
    it(`止める：${name}（${argv.join(' ')}）`, () => {
      assert.throws(() => parseArgs(argv), ArgError);
    });
  }
});
