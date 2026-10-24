// queue（マージ係の代わり）の判定：持ち主のラベルだけを拾う・並び・持ち主でない人のラベル・止める理由・持ち主の確かめ（src/queue.ts）
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MERGE_LABEL, MERGE_STOP_LABEL, mainRedIssueTitle } from '../src/config.ts';
import {
  hasFinalStatus,
  isRedStatus,
  lastLabeled,
  mainCiDirName,
  mainCopyPlan,
  mainRedIssueBody,
  needMainCiAtStart,
  ownerCheck,
  planQueue,
  precheck,
  recheckBeforeMerge,
  rejectComment,
  stopComment,
  stopForResult,
  workflowFiles,
  type LabelEvent,
  type PrFacts,
} from '../src/queue.ts';
import type { PrInfo } from '../src/select.ts';

const OWNER = 'issei0423';

const pr = (number: number, over: Partial<PrInfo> = {}): PrInfo => ({
  number,
  title: `PR ${number}`,
  createdAt: '2026-10-01T00:00:00Z',
  isDraft: false,
  labels: [{ name: MERGE_LABEL }],
  baseRefName: 'mockup-go-react',
  headRefName: `fix/${number}`,
  headRefOid: 'a'.repeat(40),
  isCrossRepository: false,
  body: '',
  ...over,
});

const labeled = (actor: string, at: string, label = MERGE_LABEL): LabelEvent => ({ event: 'labeled', created_at: at, label: { name: label }, actor: { login: actor } });
const unlabeled = (actor: string, at: string, label = MERGE_LABEL): LabelEvent => ({ event: 'unlabeled', created_at: at, label: { name: label }, actor: { login: actor } });

describe('lastLabeled', () => {
  it('「マージ」の labeled のうち、いちばん新しいもの。ほかのラベル・unlabeled・ほかのイベントは見ない', () => {
    const ev: LabelEvent[] = [
      labeled(OWNER, '2026-10-20T01:00:00Z'),
      labeled('rongdu209-ai', '2026-10-20T02:00:00Z'),
      unlabeled(OWNER, '2026-10-20T03:00:00Z'),
      labeled('someone', '2026-10-20T04:00:00Z', 'bug'),
      { event: 'commented', created_at: '2026-10-20T05:00:00Z', actor: { login: OWNER } },
    ];
    assert.deepEqual(lastLabeled(ev), { actor: 'rongdu209-ai', at: '2026-10-20T02:00:00Z' });
  });
  it('並びが時刻の順でなくても、時刻で決める。同じ時刻なら後ろのもの', () => {
    assert.deepEqual(lastLabeled([labeled(OWNER, '2026-10-20T05:00:00Z'), labeled('x', '2026-10-20T01:00:00Z')])?.actor, OWNER);
    assert.deepEqual(lastLabeled([labeled('x', '2026-10-20T05:00:00Z'), labeled(OWNER, '2026-10-20T05:00:00Z')])?.actor, OWNER);
  });
  it('記録が無い・actor が無い', () => {
    assert.equal(lastLabeled([]), undefined);
    assert.deepEqual(lastLabeled([{ event: 'labeled', created_at: '2026-10-20T05:00:00Z', label: { name: MERGE_LABEL }, actor: null }]), { actor: undefined, at: '2026-10-20T05:00:00Z' });
  });
});

describe('planQueue', () => {
  it('持ち主が最後に付けた PR だけを拾い、付けた時刻の順（同じなら番号の小さい順）に並べる', () => {
    const prs = [pr(30), pr(10), pr(20), pr(40)];
    const events = new Map<number, LabelEvent[] | Error>([
      [30, [labeled(OWNER, '2026-10-20T01:00:00Z')]],
      [10, [labeled(OWNER, '2026-10-20T03:00:00Z')]],
      [20, [labeled(OWNER, '2026-10-20T01:00:00Z')]],
      [40, [labeled(OWNER, '2026-10-19T23:00:00Z')]],
    ]);
    const plan = planQueue(prs, events, OWNER);
    assert.deepEqual(
      plan.ordered.map((e) => e.pr.number),
      [40, 20, 30, 10],
      'PR を作った順や番号の順ではなく、ラベルを付けた順',
    );
    assert.deepEqual(plan.rejected, []);
  });

  it('持ち主でない人が最後に付けた「マージ」は rejected（前に持ち主が付けていても、付け直したのが他人なら外す）', () => {
    const prs = [pr(1), pr(2), pr(3)];
    const events = new Map<number, LabelEvent[] | Error>([
      [1, [labeled('rongdu209-ai', '2026-10-20T01:00:00Z')]],
      [2, [labeled(OWNER, '2026-10-20T01:00:00Z'), unlabeled('x', '2026-10-20T02:00:00Z'), labeled('x', '2026-10-20T03:00:00Z')]],
      [3, []],
    ]);
    const plan = planQueue(prs, events, OWNER);
    assert.deepEqual(plan.ordered, []);
    assert.deepEqual(
      plan.rejected.map((r) => [r.pr.number, r.actor]),
      [
        [1, 'rongdu209-ai'],
        [2, 'x'],
        [3, undefined],
      ],
    );
  });

  it('持ち主の名前は大文字小文字を区別しない', () => {
    const plan = planQueue([pr(5)], new Map([[5, [labeled('Issei0423', '2026-10-20T01:00:00Z')]]]), OWNER);
    assert.deepEqual(
      plan.ordered.map((e) => e.pr.number),
      [5],
    );
  });

  it('イベントを読めなかった PR は、外さずに unreadable。ラベルの無い PR・exclude は見ない', () => {
    const prs = [pr(7), pr(8, { labels: [{ name: 'bug' }] }), pr(9)];
    const events = new Map<number, LabelEvent[] | Error>([
      [7, new Error('HTTP 502')],
      [8, [labeled(OWNER, '2026-10-20T01:00:00Z')]],
      [9, [labeled(OWNER, '2026-10-20T01:00:00Z')]],
    ]);
    const plan = planQueue(prs, events, OWNER, { exclude: [9] });
    assert.deepEqual(
      plan.unreadable.map((u) => [u.pr.number, u.reason]),
      [[7, 'HTTP 502']],
    );
    assert.deepEqual(plan.ordered, []);
    assert.deepEqual(plan.rejected, []);
  });

  it('0 件', () => {
    assert.deepEqual(planQueue([], new Map(), OWNER), { ordered: [], rejected: [], unreadable: [] });
  });
});

describe('precheck（取り込みの前に分かる、止める・待つ）', () => {
  const facts = (over: Partial<PrInfo> = {}, f: Partial<PrFacts> = {}): PrFacts => ({ pr: pr(50, over), files: ['web/src/App.tsx'], changesRequestedBy: [], ...f });

  it('何も無ければ入れる候補', () => {
    assert.deepEqual(precheck(facts()), { verdict: 'go', retarget: false });
  });
  it('フォーク・下書きは止める（理由と直し方は merge-queue.sh の文面）', () => {
    const fork = precheck(facts({ isCrossRepository: true }));
    assert.equal(fork.verdict, 'stop');
    assert.ok(fork.verdict === 'stop' && fork.reason === 'フォークからの PR です。');
    const draft = precheck(facts({ isDraft: true }));
    assert.ok(draft.verdict === 'stop' && draft.reason === '下書きです。' && draft.fix.includes(`「${MERGE_STOP_LABEL}」を外し、「${MERGE_LABEL}」を付け直して`));
  });
  it('.github/ を変える PR は止める（名前を変えた元の名前も見る）', () => {
    const r = precheck(facts({}, { files: ['web/a.ts', '.github/workflows/ci.yml', '.github/scripts/merge-queue.sh', '.github/workflows/ci.yml'] }));
    assert.ok(r.verdict === 'stop');
    assert.ok(r.verdict === 'stop' && r.reason === '`.github/` を変えています（.github/scripts/merge-queue.sh,.github/workflows/ci.yml）。', r.verdict === 'stop' ? r.reason : '');
    assert.deepEqual(workflowFiles(['x/.github/y', '.githubx/a', '.github/a']), ['.github/a']);
  });
  it('変更を求めるレビューがあれば止める', () => {
    const r = precheck(facts({}, { changesRequestedBy: ['reviewer-a', 'reviewer-b'] }));
    assert.ok(r.verdict === 'stop' && r.reason === '変更を求めるレビューがあります（reviewer-a,reviewer-b）。');
  });
  it('base が本線でない PR は待つ（ラベルはそのまま）。土台がマージ済みなら向け直して扱う', () => {
    assert.equal(precheck(facts({ baseRefName: 'feat/base' }, { baseState: 'open' })).verdict, 'wait');
    assert.equal(precheck(facts({ baseRefName: 'feat/base' }, { baseState: 'none' })).verdict, 'wait');
    assert.equal(precheck(facts({ baseRefName: 'feat/base' })).verdict, 'wait');
    assert.deepEqual(precheck(facts({ baseRefName: 'feat/base' }, { baseState: 'merged' })), { verdict: 'go', retarget: true });
  });
  it('理由が重なるときは merge-queue.sh の順（フォーク → 下書き → base → .github/ → レビュー）の前のもの', () => {
    const all = facts({ isCrossRepository: true, isDraft: true, baseRefName: 'feat/base' }, { files: ['.github/x'], changesRequestedBy: ['r'] });
    assert.ok(precheck(all).verdict === 'stop' && (precheck(all) as { reason: string }).reason === 'フォークからの PR です。');
    const draftWait = facts({ isDraft: true, baseRefName: 'feat/base' }, { baseState: 'open' });
    assert.equal(precheck(draftWait).verdict, 'stop', '下書きは base より先');
    const waitGh = facts({ baseRefName: 'feat/base' }, { baseState: 'open', files: ['.github/x'] });
    assert.equal(precheck(waitGh).verdict, 'wait', 'base は .github/ より先');
    const ghReview = facts({}, { files: ['.github/x'], changesRequestedBy: ['r'] });
    assert.ok((precheck(ghReview) as { reason: string }).reason.startsWith('`.github/`'));
  });
});

describe('stopForResult（1本ごとの流れの結果から）', () => {
  const never = () => false;
  it('ぶつかりを解けない：モデルを呼ばなかった・呼んでも解けなかった', () => {
    const a = stopForResult(12, { kind: 'conflict', files: ['web/a.ts'], tried: false }, never)!;
    assert.ok(a.reason.includes('本線（mockup-go-react）とぶつかります（web/a.ts）'));
    assert.ok(a.reason.includes('モデルを呼ばずに回したので、解いていません'));
    assert.ok(a.fix.includes('「#12 のぶつかりを解いて」'));
    const b = stopForResult(12, { kind: 'conflict', files: ['web/a.ts'], tried: true, said: '設計の判断が要る' }, never)!;
    assert.ok(b.reason.includes('api-agent のモデルでも解けませんでした（設計の判断が要る）'));
  });
  it('手元の CI が赤：落ちたジョブと、合わせた本線・回した commit を書く。本線の先頭が緑と分かっていれば、組み合わせで落ちたと書く', () => {
    const r = { kind: 'ci' as const, failed: '結合 FAIL・a11y FAIL', summary: '13 のうち 11 が ok', tested: 'b'.repeat(40), base: 'c'.repeat(40), tried: false };
    const s = stopForResult(3, r, never)!;
    assert.ok(s.reason.startsWith(`本線 ccccccc と合わせた形 bbbbbbb で、手元の CI（持ち主の PC）が赤でした（結合 FAIL・a11y FAIL）。`), s.reason);
    assert.ok(!s.reason.includes('本線の先頭だけなら緑'));
    assert.ok(s.reason.includes('モデルを呼ばずに回したので、見立てていません'));
    const g = stopForResult(3, { ...r, tried: true, said: '直せない 設計が要る' }, (b) => b === 'c'.repeat(40))!;
    assert.ok(g.reason.includes('本線の先頭だけなら緑なので、この PR と本線の組み合わせで落ちています。'));
    assert.ok(g.reason.includes('api-agent のモデルの見立て：直せない 設計が要る'));
  });
  it('押す木が .github/ を変えている：止める', () => {
    assert.ok(stopForResult(4, { kind: 'workflow', files: ['.github/workflows/ci.yml'] }, never)!.reason.includes('`.github/` を変えています'));
  });
  it('マージした・それ以外（上限・push・gh pr merge・本線が進み続けた）は止めない（ラベルはそのまま）', () => {
    assert.equal(stopForResult(5, { kind: 'merged', head: 'a'.repeat(40) }, never), undefined);
    assert.equal(stopForResult(5, { kind: 'other' }, never), undefined);
  });
});

describe('recheckBeforeMerge（押す直前の見直し。merge-queue.sh の finish）', () => {
  const ok = { labels: [{ name: MERGE_LABEL }], isDraft: false, changesRequestedBy: [] as string[], events: [labeled(OWNER, '2026-10-20T01:00:00Z')] };
  it('変わっていなければ入れる', () => {
    assert.equal(recheckBeforeMerge(ok, OWNER), undefined);
  });
  it('手元の CI のあいだにラベルが外された・持ち主でない人が付け直した・下書きになった・変更を求めるレビューが付いた、なら入れない', () => {
    assert.ok(recheckBeforeMerge({ ...ok, labels: [{ name: 'bug' }] }, OWNER)!.includes('外された'));
    assert.ok(recheckBeforeMerge({ ...ok, events: [...ok.events, labeled('x', '2026-10-20T02:00:00Z')] }, OWNER)!.includes('持ち主でなくなった（x）'));
    assert.ok(recheckBeforeMerge({ ...ok, events: [] }, OWNER)!.includes('記録が無い'));
    assert.ok(recheckBeforeMerge({ ...ok, isDraft: true }, OWNER)!.includes('下書き'));
    assert.ok(recheckBeforeMerge({ ...ok, changesRequestedBy: ['r'] }, OWNER)!.includes('変更を求めるレビュー'));
  });
});

describe('コメントの文面', () => {
  it('持ち主でない人のラベルを外したとき（merge-queue.sh の reject と同じ文面）', () => {
    assert.equal(
      rejectComment(OWNER, 'rongdu209-ai'),
      'ラベル「マージ」は、持ち主（issei0423）が付けたものだけを受け付けます。rongdu209-ai が付けたので外しました。マージしてほしいときは、持ち主に頼んでください。',
    );
    assert.ok(rejectComment(OWNER, undefined).includes('持ち主でない人 が付けたので外しました'));
  });
  it('止めたとき（理由・直し方・記録の名前）', () => {
    const c = stopComment('下書きです。', '直してください。', '20261024-120000-queue');
    assert.equal(c.split('\n')[0], 'マージ係（持ち主の PC の api-agent）が、この PR を入れずに止めました。');
    assert.ok(c.includes('- 理由：下書きです。'));
    assert.ok(c.includes('- 直し方：直してください。'));
    assert.ok(c.includes('runs/20261024-120000-queue.md'));
  });
  it('本線の先頭が赤のときの Issue の題', () => {
    assert.equal(mainRedIssueTitle('0123456789abcdef0123456789abcdef01234567'), '本線の先頭で手元の CI が落ちた（0123456）');
  });
});

describe('本線の先頭の status', () => {
  it('success・failure・error は「ある」。pending（前の実行が途中で止まった）と無いものは「無い」', () => {
    assert.deepEqual(
      [undefined, 'pending', 'success', 'failure', 'error'].map(hasFinalStatus),
      [false, false, true, true, true],
    );
    assert.deepEqual(
      [undefined, 'pending', 'success', 'failure', 'error'].map(isRedStatus),
      [false, false, false, true, true],
    );
  });
});

describe('queue の始めに本線の先頭で手元の CI を回すか', () => {
  it('status が無い・pending なら回す。success・failure・error なら回さない', () => {
    assert.deepEqual(
      [undefined, 'pending', 'success', 'failure', 'error'].map((s) => needMainCiAtStart(s, false)),
      [true, true, false, false, false],
    );
  });
  it('--recheck-main なら、status があっても回し直す（時々落ちるテストで赤になったときの抜け道）', () => {
    assert.deepEqual(
      [undefined, 'pending', 'success', 'failure', 'error'].map((s) => needMainCiAtStart(s, true)),
      [true, true, true, true, true],
    );
  });
  it('ログの置き場は、始めと終わりで分ける。Issue の本文はその置き場と --recheck-main を書く', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    assert.equal(mainCiDirName(sha, 'start'), 'ci-main-0123456-start');
    assert.equal(mainCiDirName(sha, 'end'), 'ci-main-0123456-end');
    const body = mainRedIssueBody(sha, '11 のうち 10 が ok', '結合 FAIL', '20261024-120000-queue/ci-main-0123456-start');
    assert.ok(body.includes('runs/20261024-120000-queue/ci-main-0123456-start/'));
    assert.ok(body.includes('結合 FAIL'));
    assert.ok(body.includes('--recheck-main'));
  });
});

describe('mainCopyPlan（マージのあと、本線の先頭に success を写すか）', () => {
  const tree = (c: string) => c.repeat(40);
  const green = { ok: true, steps: [{ name: 'go-vet', status: 'ok' }, { name: 'a11y', status: 'ok' }] };
  const base = { prNumber: 12, tipSha: 'a'.repeat(40), tipTree: tree('1'), testedSha: 'b'.repeat(40), testedTree: tree('1'), ci: green };
  it('本線の先頭の木が、手元の CI で通した木と同じなら写す（重い CI を回し直さない）', () => {
    const p = mainCopyPlan(base);
    assert.equal(p.copy, true);
    assert.ok(p.copy && p.description === '通った・2 のジョブ（PR #12 で回した bbbbbbb と同じ木）', p.copy ? p.description : '');
  });
  it('木が違う（ほかの commit が先に入った）なら写さない（終わりに本線で回す）', () => {
    const p = mainCopyPlan({ ...base, tipTree: tree('2') });
    assert.equal(p.copy, false);
    assert.ok(!p.copy && p.reason.includes('木と違う'));
  });
  it('通した CI が無い（--trust-gh-checks で省いた）・赤・木が読めないなら写さない', () => {
    assert.equal(mainCopyPlan({ ...base, ci: undefined }).copy, false);
    assert.equal(mainCopyPlan({ ...base, ci: { ...green, ok: false } }).copy, false);
    assert.equal(mainCopyPlan({ ...base, tipTree: '' }).copy, false);
  });
});

describe('ownerCheck（merge・queue は持ち主のアカウントでだけ）', () => {
  it('持ち主なら通す（大文字小文字は区別しない）', () => {
    assert.equal(ownerCheck('queue', OWNER, OWNER), undefined);
    assert.equal(ownerCheck('merge', 'ISSEI0423', OWNER), undefined);
  });
  it('持ち主でなければ、日本語のわけを返す（だれのアカウントか・--dry-run なら動く）', () => {
    const m = ownerCheck('queue', 'rongdu209-ai', OWNER)!;
    assert.ok(m.includes('queue はリポジトリの持ち主（issei0423）の gh のアカウントでしか動かしません。いまのアカウントは rongdu209-ai です。'), m);
    assert.ok(m.includes('--dry-run'));
  });
  it('アカウントや持ち主が分からないときも止める', () => {
    assert.ok(ownerCheck('merge', undefined, OWNER)!.includes('いまの gh のアカウントが分からない'));
    assert.ok(ownerCheck('merge', OWNER, undefined)!.includes('リポジトリの持ち主が読めなかった'));
    assert.ok(ownerCheck('merge', '', OWNER));
  });
});
