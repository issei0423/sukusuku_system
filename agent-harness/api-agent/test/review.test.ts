// review の選び方・印・コメントの組み立て（src/review.ts）
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildReviewComment, planReviews, reviewedHeads, reviewMarker, reviewPrompt, touchesWorkflows, workflowVerdict, type ReviewPr } from '../src/review.ts';

const sha = (c: string) => c.repeat(40);
const ME = 'bot-me';
const mine = (body: string) => ({ body, author: { login: ME } });

const pr = (number: number, createdAt: string, over: Partial<ReviewPr> = {}): ReviewPr => ({
  number,
  title: `PR ${number}`,
  createdAt,
  isDraft: false,
  labels: [],
  baseRefName: 'mockup-go-react',
  headRefName: `fix/${number}`,
  headRefOid: sha('a'),
  isCrossRepository: false,
  body: '',
  comments: [],
  ...over,
});

describe('印', () => {
  it('作り方（40桁の sha だけ）', () => {
    assert.equal(reviewMarker(sha('a')), `<!-- api-agent-review head=${sha('a')} -->`);
    assert.throws(() => reviewMarker('abc123'));
    assert.throws(() => reviewMarker(sha('A')));
    assert.throws(() => reviewMarker(sha('g')));
  });

  it('読み取り：40桁の小文字16進だけ。複数あれば全部', () => {
    const got = reviewedHeads(
      [
        `本文\n${reviewMarker(sha('a'))}`,
        '<!-- api-agent-review head=abc -->',
        `<!-- api-agent-review head=${'b'.repeat(41)} -->`,
        `<!-- api-agent-review head=${'C'.repeat(40)} -->`,
        `<!--api-agent-review head=${sha('d')}-->`,
        reviewMarker(sha('e')),
      ].map(mine),
      ME,
    );
    assert.deepEqual([...got].sort(), [sha('a'), sha('e')]);
  });
});

describe('印の書き手', () => {
  it('他人の印は数えない。自分の印は数える（ログインは大文字小文字を区別しない）', () => {
    const comments = [
      { body: reviewMarker(sha('a')), author: { login: 'someone-else' } },
      { body: reviewMarker(sha('b')), author: { login: 'Bot-Me' } },
      { body: reviewMarker(sha('c')), author: null },
      { body: reviewMarker(sha('d')) },
    ];
    assert.deepEqual([...reviewedHeads(comments, ME)], [sha('b')]);
  });

  it('アカウントが取れないときは、自分の印も信じない', () => {
    assert.equal(reviewedHeads([mine(reviewMarker(sha('a')))], undefined).size, 0);
    assert.equal(reviewedHeads([mine(reviewMarker(sha('a')))], '').size, 0);
  });

  it('planReviews：他人の印だけの PR は見る。自分の印があれば飛ばす。アカウント不明なら見る', () => {
    const other = pr(1, '2026-10-01T00:00:00Z', { comments: [{ body: reviewMarker(sha('a')), author: { login: 'attacker' } }] });
    const own = pr(2, '2026-10-02T00:00:00Z', { comments: [mine(reviewMarker(sha('a')))] });
    assert.deepEqual(planReviews([other, own], { me: ME }).picked.map((p) => p.number), [1]);
    assert.deepEqual(planReviews([other, own]).picked.map((p) => p.number), [1, 2]);
  });
});

describe('planReviews', () => {
  it('古い順（同じ日時なら番号）', () => {
    const plan = planReviews([pr(30, '2026-10-20T00:00:00Z'), pr(10, '2026-10-01T00:00:00Z'), pr(20, '2026-10-01T00:00:00Z')]);
    assert.deepEqual(plan.picked.map((p) => p.number), [10, 20, 30]);
  });

  it('下書き・フォーク・agent-skip を飛ばし、わけを返す', () => {
    const plan = planReviews([
      pr(1, '2026-10-01T00:00:00Z', { isDraft: true }),
      pr(2, '2026-10-02T00:00:00Z', { isCrossRepository: true }),
      pr(3, '2026-10-03T00:00:00Z', { labels: [{ name: 'agent-skip' }] }),
      pr(4, '2026-10-04T00:00:00Z'),
    ]);
    assert.deepEqual(plan.picked.map((p) => p.number), [4]);
    assert.deepEqual(plan.skipped.map((s) => s.number), [1, 2, 3]);
    assert.match(plan.skipped[0]!.reason, /下書き/);
    assert.match(plan.skipped[1]!.reason, /フォーク/);
    assert.match(plan.skipped[2]!.reason, /agent-skip/);
  });

  it('--include-drafts と --pr N は下書きも見る。フォークと agent-skip は見ない', () => {
    const prs = [pr(1, '2026-10-01T00:00:00Z', { isDraft: true }), pr(2, '2026-10-02T00:00:00Z', { isDraft: true, isCrossRepository: true })];
    assert.deepEqual(planReviews(prs, { includeDrafts: true }).picked.map((p) => p.number), [1]);
    assert.deepEqual(planReviews(prs, { only: 1 }).picked.map((p) => p.number), [1]);
    assert.deepEqual(planReviews(prs, { only: 2, includeDrafts: true }).picked, []);
  });

  it('--pr N：その PR だけ。開いていなければ飛ばしたに書く', () => {
    const prs = [pr(1, '2026-10-01T00:00:00Z'), pr(2, '2026-10-02T00:00:00Z')];
    assert.deepEqual(planReviews(prs, { only: 2 }).picked.map((p) => p.number), [2]);
    const none = planReviews(prs, { only: 9 });
    assert.deepEqual(none.picked, []);
    assert.deepEqual(none.skipped, [{ number: 9, reason: '開いている PR に無い' }]);
  });

  it('印のある先頭は飛ばす。先頭が進んだら見る。--force なら見直す', () => {
    const marked = pr(1, '2026-10-01T00:00:00Z', { comments: [mine(`指摘なし\n${reviewMarker(sha('a'))}`)] });
    const moved = pr(2, '2026-10-02T00:00:00Z', { headRefOid: sha('b'), comments: [mine(reviewMarker(sha('a')))] });
    const plan = planReviews([marked, moved], { me: ME });
    assert.deepEqual(plan.picked.map((p) => p.number), [2]);
    assert.match(plan.skipped[0]!.reason, /レビュー済み/);
    assert.deepEqual(planReviews([marked, moved], { force: true, me: ME }).picked.map((p) => p.number), [1, 2]);
  });

  it('コメントの無い PR（comments が undefined）も選ぶ', () => {
    assert.equal(planReviews([pr(1, '2026-10-01T00:00:00Z', { comments: undefined })]).picked.length, 1);
  });
});

describe('buildReviewComment', () => {
  it('末尾に費用の行と印が付く', () => {
    const body = buildReviewComment('**判断：マージしてよい**\n問題なし。', sha('a'), 0.4567, {});
    const lines = body.trimEnd().split('\n');
    assert.equal(lines[0], '**判断：マージしてよい**');
    assert.equal(lines.at(-2), 'API の Sonnet 5.5（api-agent）がレビューしました。費用 $0.46・先頭 aaaaaaaa');
    assert.equal(lines.at(-1), reviewMarker(sha('a')));
    assert.ok(reviewedHeads([mine(body)], ME).has(sha('a')));
  });

  it('redact が効く（キーらしい文字と、環境変数の秘密の値）', () => {
    const body = buildReviewComment('見つけた：sk-ant-api03-abcdefghijklmnop と my-very-secret-value-123', sha('a'), 1, {
      ANTHROPIC_API_KEY: 'my-very-secret-value-123',
    });
    assert.ok(!body.includes('sk-ant-api03'));
    assert.ok(!body.includes('my-very-secret-value-123'));
    assert.ok(body.includes('[伏せた]'));
  });

  it('長すぎる本文は切っても、印は残る', () => {
    const body = buildReviewComment('あ'.repeat(70000), sha('a'), 1, {});
    assert.ok(body.length < 65536);
    assert.ok(reviewedHeads([mine(body)], ME).has(sha('a')));
  });

  it('sha が40桁でなければ止める', () => {
    assert.throws(() => buildReviewComment('x', 'abc', 1, {}));
  });
});

describe('頼みの文', () => {
  it('観点・書き方・返事の形が入る。.github/ を変えるときだけワークフローの観点が足される', () => {
    const p = pr(5, '2026-10-01T00:00:00Z', { url: 'https://example.test/pull/5' });
    const plain = reviewPrompt(p, 'C:/wt/agent-review-5', false);
    for (const word of ['バグ', 'セキュリティ', '読みやすさ', '保育士', '未確認', '仮置き', 'git diff origin/mockup-go-react...HEAD', 'gh pr view 5', '判断：']) {
      assert.ok(plain.includes(word), word);
    }
    assert.ok(!plain.includes('self-hosted'));
    assert.ok(!/\{\{/.test(plain));
    assert.ok(reviewPrompt(p, 'C:/wt/agent-review-5', true).includes('self-hosted runner'));
  });

  it('git diff が失敗したら、ワークフローの観点を足し、失敗を知らせる', () => {
    assert.deepEqual(workflowVerdict({ code: 128, stdout: '' }), { workflow: true, failed: true });
    assert.deepEqual(workflowVerdict({ code: 0, stdout: 'server/a.go\n' }), { workflow: false, failed: false });
    assert.deepEqual(workflowVerdict({ code: 0, stdout: 'web/a.ts\r\n.github/workflows/ci.yml\r\n' }), { workflow: true, failed: false });
  });

  it('.github/ を変える PR の見分け', () => {
    assert.equal(touchesWorkflows(['web/a.ts', '.github/workflows/ci.yml']), true);
    assert.equal(touchesWorkflows(['web/.github-like.ts', 'server/a.go']), false);
  });
});
