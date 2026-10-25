// 手元の CI の commit status：description の作り方と、付ける commit の選び方（src/status.ts）
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STATUS_CONTEXT, STATUS_DESCRIPTION_MAX } from '../src/config.ts';
import type { CiResult } from '../src/shell.ts';
import { clip, failedJobs, jobName, PrCiStatus, statusDescription, type StatusState } from '../src/status.ts';

const ci = (steps: [string, string][], ok?: boolean): CiResult => ({
  ok: ok ?? steps.every(([, s]) => s === 'ok'),
  steps: steps.map(([name, status]) => ({ name, status })),
  logDir: '/tmp/x',
});
const chars = (s: string) => [...s].length;
const sha = (c: string) => c.repeat(40);

describe('落ちたジョブの名前', () => {
  it('ci.yml のジョブの名前に寄せる（例「結合 FAIL・a11y FAIL」）', () => {
    const r = ci([
      ['go-vet', 'ok'],
      ['integration', 'FAIL'],
      ['a11y', 'FAIL'],
      ['vitest', 'ok'],
    ]);
    assert.equal(failedJobs(r), '結合 FAIL・a11y FAIL');
  });
  it('FAIL(build) のような細かい状態も「FAIL」にまとめる。知らない名前はそのまま', () => {
    assert.equal(failedJobs(ci([['integration', 'FAIL(build)'], ['new-job', 'FAIL']])), '結合 FAIL・new-job FAIL');
    assert.equal(jobName('local-ci'), '手元の CI（途中で止まった）');
    assert.equal(failedJobs(ci([['go-test', 'ok']])), '');
  });
  it('context の名前', () => {
    assert.equal(STATUS_CONTEXT, '手元の CI（持ち主の PC）');
  });
});

describe('statusDescription', () => {
  const where = '本線 abc1234 と合わせた def5678';
  it('pending・success・failure', () => {
    assert.equal(statusDescription('pending', undefined, where), `回している（${where}）`);
    assert.equal(statusDescription('success', ci([['go-vet', 'ok'], ['go-test', 'ok']]), where), `通った・2 のジョブ（${where}）`);
    assert.equal(statusDescription('failure', ci([['integration', 'FAIL'], ['a11y', 'FAIL']]), where), `結合 FAIL・a11y FAIL（${where}）`);
    assert.equal(statusDescription('failure', undefined, ''), '落ちた');
  });
  it('140 字を越えない。どの形で回したか（後ろ）を残して、落ちたジョブの並びを切る', () => {
    const many = ci(Array.from({ length: 40 }, (_, k): [string, string] => [`とても長いジョブの名前-${k}`, 'FAIL']));
    const d = statusDescription('failure', many, where);
    assert.equal(STATUS_DESCRIPTION_MAX, 140);
    assert.ok(chars(d) <= 140, `${chars(d)} 字`);
    assert.ok(d.endsWith(`…（${where}）`), d);
    for (const st of ['pending', 'success', 'failure'] as StatusState[]) {
      assert.ok(chars(statusDescription(st, many, 'あ'.repeat(300))) <= 140, '後ろが長すぎても 140 字に収める');
    }
  });
  it('clip', () => {
    assert.equal(clip('あいうえお', 5), 'あいうえお');
    assert.equal(clip('あいうえおか', 5), 'あいうえ…');
  });
});

describe('PrCiStatus：付ける commit', () => {
  const recorder = () => {
    const calls: [string, StatusState, string][] = [];
    const post = async (s: string, st: StatusState, d: string) => {
      calls.push([s, st, d]);
      return undefined;
    };
    return { calls, post };
  };
  const green = ci([['go-vet', 'ok']]);
  const red = ci([['integration', 'FAIL']]);

  it('回した commit が PR のブランチにあるなら、その commit に pending → success', async () => {
    const { calls, post } = recorder();
    const s = new PrCiStatus(post, []);
    await s.start(sha('a'), true, sha('a'), '本線 1111111 と合わせた aaaaaaa');
    await s.end(sha('a'), true, green, '本線 1111111 と合わせた aaaaaaa');
    await s.afterPush(sha('a'));
    assert.deepEqual(
      calls.map(([c, st]) => [c, st]),
      [
        [sha('a'), 'pending'],
        [sha('a'), 'success'],
      ],
    );
  });

  it('本線を取り込んだ commit がまだ手元だけなら、PR の先頭に付け（未 push と書く）、通って push したら push した commit にも success', async () => {
    const { calls, post } = recorder();
    const s = new PrCiStatus(post, []);
    await s.start(sha('b'), false, sha('a'), 'W');
    await s.end(sha('b'), false, green, 'W');
    await s.afterPush(sha('b'));
    assert.deepEqual(
      calls.map(([c, st]) => [c, st]),
      [
        [sha('a'), 'pending'],
        [sha('a'), 'success'],
        [sha('b'), 'success'],
      ],
    );
    assert.ok(calls[0]![2].includes('未 push'));
    assert.ok(!calls[2]![2].includes('未 push'), 'push した commit には「未 push」と書かない');
  });

  it('落ちたら、付けた先に failure。push は無いので、ほかには付けない', async () => {
    const { calls, post } = recorder();
    const s = new PrCiStatus(post, []);
    await s.start(sha('b'), false, sha('a'), 'W');
    await s.end(sha('b'), false, red, 'W');
    await s.afterPush(sha('c'));
    assert.deepEqual(
      calls.map(([c, st, d]) => [c, st, d.startsWith('結合 FAIL')]),
      [
        [sha('a'), 'pending', false],
        [sha('a'), 'failure', true],
      ],
    );
  });

  it('付けられなかったときは notes に書いて進む（止めない）', async () => {
    const notes: string[] = [];
    const s = new PrCiStatus(async () => 'HTTP 422', notes);
    await s.start(sha('a'), true, sha('a'), 'W');
    assert.equal(notes.length, 1);
    assert.ok(notes[0]!.includes('HTTP 422'));
  });
});
