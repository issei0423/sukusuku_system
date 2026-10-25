/**
 * 手元の CI の結果を、commit status（context「手元の CI（持ち主の PC）」）でチームの人に見せる。
 * 付けるのはコードだけ。モデルには付けさせない（src/safety.ts が gh api の書き込みを断る。変えない）。
 * target_url は付けない（ログは持ち主の PC にしか無い）。テストは test/status.test.ts。
 */
import { STATUS_DESCRIPTION_MAX } from './config.ts';
import type { CiResult } from './shell.ts';

export type StatusState = 'pending' | 'success' | 'failure';

/** scripts/local-ci.sh の確かめの名前 → 画面に出す名前（.github/workflows/ci.yml のジョブの名前に寄せる） */
const JOB_NAMES: Record<string, string> = {
  'go-vet': 'go vet',
  'go-test': 'go test',
  'npm-ci': 'npm ci',
  build: 'build',
  'responsive-check': 'responsive の型検査',
  'security-check': 'security の型検査',
  lint: 'lint',
  vitest: 'vitest',
  integration: '結合',
  security: 'security',
  a11y: 'a11y',
  'local-ci': '手元の CI（途中で止まった）',
};

export const jobName = (step: string): string => JOB_NAMES[step] ?? step;

/** 落ちたジョブを「結合 FAIL・a11y FAIL」の形で（落ちたものが無ければ空） */
export function failedJobs(ci: Pick<CiResult, 'steps'>): string {
  return ci.steps
    .filter((s) => s.status !== 'ok')
    .map((s) => `${jobName(s.name)} FAIL`)
    .join('・');
}

/** 字数（コードポイントで数える） */
const len = (s: string) => [...s].length;

/** max 字に収める（越えたら末尾を … にする） */
export function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/**
 * commit status の description（140 字以内）。where は「本線 abc1234 と合わせた形」「本線の先頭」など、どの形で回したか。
 * 長いときは、where を残して前（落ちたジョブの並び）を切る。
 */
export function statusDescription(state: StatusState, ci: Pick<CiResult, 'steps'> | undefined, where: string): string {
  const suffix = where ? `（${where}）` : '';
  let head: string;
  if (state === 'pending') head = '回している';
  else if (state === 'success') head = `通った・${ci ? ci.steps.filter((s) => s.status === 'ok').length : 0} のジョブ`;
  else head = (ci && failedJobs(ci)) || '落ちた';
  const room = STATUS_DESCRIPTION_MAX - len(suffix);
  if (room < 8) return clip(head + suffix, STATUS_DESCRIPTION_MAX);
  return clip(head, room) + suffix;
}

/** status を1つ付ける。失敗したらわけを返す（成功なら undefined） */
export type PostStatus = (sha: string, state: StatusState, description: string) => Promise<string | undefined>;

/**
 * PR 1本の、手元の CI の status の付け方。
 * - 回した commit が GitHub にある（PR のブランチに入っている）なら、その commit に付ける
 * - 本線を取り込んだ commit がまだ手元にしか無い（push していない）なら、GitHub はその commit に status を付けられないので、
 *   いまの PR の先頭（head）に付ける。description に「未 push」と書く。通って push したら、push した commit にも success を付ける
 * 付けられなかったときは notes に書いて進む（マージの流れは止めない）
 */
export class PrCiStatus {
  private target: string | undefined;
  private passedUnpushed: { sha: string; description: string } | undefined;

  constructor(
    private readonly post: PostStatus,
    private readonly notes: string[],
  ) {}

  /** 回し始め。tested は回す commit、onGitHub はそれが PR のブランチにあるか、prHead はいまの PR の先頭 */
  async start(tested: string, onGitHub: boolean, prHead: string, where: string): Promise<void> {
    this.target = onGitHub ? tested : prHead;
    this.passedUnpushed = undefined;
    await this.send(this.target, 'pending', statusDescription('pending', undefined, onGitHub ? where : `${where}・未 push`));
  }

  /** 回し終わり。onGitHub・tested は start と同じもの */
  async end(tested: string, onGitHub: boolean, ci: CiResult, where: string): Promise<void> {
    if (!this.target) return;
    const state: StatusState = ci.ok ? 'success' : 'failure';
    const desc = statusDescription(state, ci, onGitHub ? where : `${where}・未 push`);
    await this.send(this.target, state, desc);
    if (ci.ok && !onGitHub) this.passedUnpushed = { sha: tested, description: statusDescription('success', ci, where) };
  }

  /** push のあと。通った commit を push したなら、その commit にも success を付ける */
  async afterPush(pushed: string): Promise<void> {
    if (this.passedUnpushed && this.passedUnpushed.sha === pushed) {
      await this.send(pushed, 'success', this.passedUnpushed.description);
      this.passedUnpushed = undefined;
    }
  }

  private async send(sha: string, state: StatusState, description: string): Promise<void> {
    const err = await this.post(sha, state, description);
    if (err) this.notes.push(`commit status（${state}・${sha.slice(0, 7)}）を付けられなかった：${err}`);
  }
}
