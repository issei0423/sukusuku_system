/**
 * api-agent の決まった値。値を変えるときはここだけを直す。
 * 【仮置き】と書いた値は、持ち主が決めたものではなく、作った Claude が置いたもの（README「仮置きの値」）。
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** モデル。持ち主の頼み「sonet5.5 のエージェント」（2026-10-23） */
export const MODEL = 'claude-sonnet-5-5';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
/** Sonnet 5.5 のエージェントのコーディングは medium から始めるのが推し（claude-api スキル「Claude Sonnet 5.5」） */
export const DEFAULT_EFFORT: Effort = 'medium';

/** 本線。AGENTS.md「ブランチと PR」 */
export const BASE_BRANCH = 'mockup-go-react';
/** エージェントが push してはいけないブランチ（本線・旧版・設計書） */
export const PROTECTED_BRANCHES = ['mockup-go-react', 'mockup', 'docs', 'main', 'master'];

/** 1回の実行の上限（米ドル）【仮置き】 */
export const DEFAULT_MAX_USD = 10;
/** 1件（Issue 1つ・PR 1つ）の上限（米ドル）【仮置き】 */
export const DEFAULT_PER_ITEM_USD = 3;
/** 残りがこれを下回ったら、新しくモデルを呼ばない【仮置き】 */
export const MIN_CALL_USD = 0.05;

/** 1回の query() の往復の上限【仮置き】 */
export const MAX_TURNS = { issue: 200, conflict: 80, ci: 120 } as const;
/** 1回の query() の時間の上限（分）【仮置き】 */
export const QUERY_TIMEOUT_MIN = { issue: 120, conflict: 45, ci: 90 } as const;
/** review の 1件の往復の上限・時間の上限（分）【仮置き】 */
export const REVIEW_MAX_TURNS = 80;
export const REVIEW_TIMEOUT_MIN = 30;
/** task コマンドの既定：往復の上限・時間の上限（分）【仮置き】 */
export const TASK_MAX_TURNS = 200;
export const TASK_TIMEOUT_MIN = 60;
/** 手元の CI 1回の時間の上限（分）。鍵の待ちを含む【仮置き】 */
export const LOCAL_CI_TIMEOUT_MIN = 120;
/** マージの直前に本線が進んでいたときに、取り込みからやり直す回数（持ち主の頼みの「2回まで」） */
export const MAINLINE_RETRIES = 2;

/**
 * issues が拾う Issue のラベル。.github/workflows/claude-implement.yml と同じ合図（ラベル claude）。
 * `--issue N` で番号を指したときは、このラベルが無くても扱う
 */
export const ISSUE_PICK_LABEL = 'claude';

/** マージ係の合図（.github/scripts/merge-queue.sh の LABEL・STOP_LABEL と同じ名前） */
export const MERGE_LABEL = 'マージ';
export const MERGE_STOP_LABEL = 'マージ止め';
/** 手元の CI の結果を付ける commit status の context（チームの人が PR の画面で見る） */
export const STATUS_CONTEXT = '手元の CI（持ち主の PC）';
/** commit status の description の上限（GitHub の上限 140 字） */
export const STATUS_DESCRIPTION_MAX = 140;
/** 本線の先頭で手元の CI が赤のときに立てる Issue の題 */
export const mainRedIssueTitle = (sha: string) => `本線の先頭で手元の CI が落ちた（${sha.slice(0, 7)}）`;

/** 飛ばすラベル */
export const SKIP_LABELS_ISSUE = ['agent-skip', 'tracking'];
export const SKIP_LABELS_PR = ['agent-skip', 'do-not-merge'];
/** review で飛ばすラベル */
export const SKIP_LABELS_REVIEW = ['agent-skip'];
/** 題にこれがある PR はマージしない */
export const NO_MERGE_TITLE_MARK = '（マージしない）';

/** エージェントに使わせる道具。サブエージェント・Web・MCP は渡さない（src/safety.ts でも断る） */
export const AGENT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];

/** api-agent のフォルダ（agent-harness/api-agent） */
export const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROMPTS_DIR = path.join(AGENT_DIR, 'prompts');
export const SCRIPTS_DIR = path.join(AGENT_DIR, 'scripts');
export const RUNS_DIR = path.join(AGENT_DIR, 'runs');

/** worktree の根。既定はメインの作業ツリーの隣の sukusuku-worktrees */
export function worktreeRoot(mainRoot: string): string {
  const fromEnv = process.env.SUKUSUKU_AGENT_WORKTREES?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(path.dirname(mainRoot), 'sukusuku-worktrees');
}

export const issueBranch = (n: number) => `agent/issue-${n}`;
export const issueWorktreeName = (n: number) => `agent-issue-${n}`;
export const prWorktreeName = (n: number) => `agent-pr-${n}`;
export const reviewWorktreeName = (n: number) => `agent-review-${n}`;
/** queue の終わりに、本線の先頭で手元の CI を回す worktree */
export const MAIN_WORKTREE_NAME = 'agent-main';

export const HOME_DIR = os.homedir();
export const TMP_DIR = os.tmpdir();
