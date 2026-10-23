// PR・Issue の選び方と並べ方（src/select.ts）。gh の JSON の形を作って渡す
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checksAllSuccess, closingIssues, duplicateClosers, planPrs, selectIssues, type IssueInfo, type PrInfo } from '../src/select.ts';

const issue = (number: number, createdAt: string, labels: string[] = []): IssueInfo => ({
  number,
  title: `Issue ${number}`,
  createdAt,
  labels: labels.map((name) => ({ name })),
});

const pr = (number: number, createdAt: string, over: Partial<PrInfo> = {}): PrInfo => ({
  number,
  title: `PR ${number}`,
  createdAt,
  isDraft: false,
  labels: [],
  baseRefName: 'mockup-go-react',
  headRefName: `fix/${number}`,
  headRefOid: 'a'.repeat(40),
  isCrossRepository: false,
  body: '',
  ...over,
});

describe('closingIssues', () => {
  it('本文の Closes・Fixes・Resolves と、GitHub の closingIssuesReferences を合わせる', () => {
    assert.deepEqual(closingIssues({ body: 'Closes #12\nfixes #3、resolved: #7。#99 は関係ない', closingIssuesReferences: [{ number: 12 }, { number: 40 }] }), [3, 7, 12, 40]);
  });
  it('Close の語が無い #n は数えない', () => {
    assert.deepEqual(closingIssues({ body: '#12 の続き。Refs #5' }), []);
  });
});

describe('selectIssues', () => {
  const issues = [
    issue(30, '2026-10-20T00:00:00Z'),
    issue(10, '2026-10-01T00:00:00Z'),
    issue(20, '2026-10-01T00:00:00Z'), // 同じ日時なら番号の小さい順
    issue(40, '2026-10-02T00:00:00Z', ['agent-skip']),
    issue(50, '2026-10-03T00:00:00Z', ['tracking', 'bug']),
    issue(60, '2026-10-04T00:00:00Z'),
  ];
  const prs = [pr(100, '2026-10-05T00:00:00Z', { body: 'Closes #60' }), pr(101, '2026-10-06T00:00:00Z', { closingIssuesReferences: [{ number: 30 }] })];

  it('古い順に並べ、ラベルと、開いている PR が閉じる予定のものを飛ばす', () => {
    const s = selectIssues(issues, prs);
    assert.deepEqual(
      s.picked.map((i) => i.number),
      [10, 20],
    );
    assert.deepEqual(
      s.skipped.map((x) => [x.number, x.reason]),
      [
        [40, 'ラベル agent-skip'],
        [50, 'ラベル tracking'],
        [60, '開いている PR #100 が閉じる予定'],
        [30, '開いている PR #101 が閉じる予定'],
      ],
    );
  });

  it('--issue で1件だけ。開いていなければ飛ばしたものに書く', () => {
    assert.deepEqual(
      selectIssues(issues, prs, { only: 20 }).picked.map((i) => i.number),
      [20],
    );
    const none = selectIssues(issues, prs, { only: 999 });
    assert.equal(none.picked.length, 0);
    assert.deepEqual(none.skipped, [{ number: 999, reason: '開いている Issue に無い' }]);
  });

  it('0 件', () => {
    assert.deepEqual(selectIssues([], []), { picked: [], skipped: [] });
  });
});

describe('planPrs', () => {
  const prs = [
    pr(5, '2026-10-10T00:00:00Z'),
    pr(3, '2026-10-01T00:00:00Z'),
    pr(4, '2026-10-02T00:00:00Z', { isDraft: true }),
    pr(6, '2026-10-03T00:00:00Z', { title: 'ためし（マージしない）' }),
    pr(7, '2026-10-04T00:00:00Z', { labels: [{ name: 'do-not-merge' }] }),
    pr(8, '2026-10-05T00:00:00Z', { isCrossRepository: true }),
    pr(9, '2026-10-06T00:00:00Z', { baseRefName: 'fix/base-merged' }),
    pr(11, '2026-10-07T00:00:00Z', { baseRefName: 'fix/base-open' }),
    pr(12, '2026-10-08T00:00:00Z', { baseRefName: 'feat/no-pr' }),
    pr(13, '2026-10-09T00:00:00Z', { labels: [{ name: 'agent-skip' }] }),
  ];
  const bases = { 'fix/base-merged': 'merged', 'fix/base-open': 'open', 'feat/no-pr': 'none' } as const;

  it('古い順に並べ、飛ばすものを飛ばし、土台がマージ済みの積み重ねは向け直す', () => {
    const plan = planPrs(prs, bases);
    assert.deepEqual(
      plan.picked.map((p) => [p.pr.number, p.retarget]),
      [
        [3, false],
        [9, true],
        [5, false],
      ],
    );
    assert.deepEqual(
      plan.skipped.map((s) => [s.number, s.reason]),
      [
        [4, '下書き'],
        [6, '題に（マージしない）'],
        [7, 'ラベル do-not-merge'],
        [8, 'フォークからの PR'],
        [11, '積み重ね：土台（fix/base-open）の PR がまだ開いている'],
        [12, '積み重ね：土台（feat/no-pr）が本線でなく、その PR も無い'],
        [13, 'ラベル agent-skip'],
      ],
    );
  });

  it('--pr で1件だけ。exclude は扱い済み', () => {
    assert.deepEqual(
      planPrs(prs, bases, { only: 9 }).picked.map((p) => p.pr.number),
      [9],
    );
    assert.deepEqual(
      planPrs(prs, bases, { exclude: [3] }).picked.map((p) => p.pr.number),
      [9, 5],
    );
    assert.deepEqual(planPrs(prs, bases, { only: 77 }).skipped, [{ number: 77, reason: '開いている PR に無い' }]);
  });

  it('同じ Issue を閉じる PR が2本あれば、報告に出す（閉じない）', () => {
    const dup = [pr(20, '2026-10-01T00:00:00Z', { body: 'Closes #8' }), pr(21, '2026-10-02T00:00:00Z', { closingIssuesReferences: [{ number: 8 }] }), pr(22, '2026-10-03T00:00:00Z', { body: 'Fixes #9' })];
    assert.deepEqual(duplicateClosers(dup), [{ issue: 8, prs: [20, 21] }]);
    assert.deepEqual(planPrs(dup, {}).duplicates, [{ issue: 8, prs: [20, 21] }]);
    assert.equal(planPrs(dup, {}).picked.length, 3);
  });

  it('0 件', () => {
    assert.deepEqual(planPrs([], {}), { picked: [], skipped: [], duplicates: [] });
  });
});

describe('checksAllSuccess', () => {
  it('1つ以上あって、全部が成功（CheckRun・StatusContext）', () => {
    assert.equal(checksAllSuccess([{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { conclusion: 'SKIPPED' }, { state: 'SUCCESS' }]), true);
  });
  it('失敗・動いている途中・何も無いときは false', () => {
    assert.equal(checksAllSuccess([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), false);
    assert.equal(checksAllSuccess([{ conclusion: null, status: 'IN_PROGRESS' }]), false);
    assert.equal(checksAllSuccess([{ state: 'PENDING' }]), false);
    assert.equal(checksAllSuccess([]), false);
    assert.equal(checksAllSuccess(undefined), false);
  });
});
