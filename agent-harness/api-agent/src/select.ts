/**
 * Issue・PR の選び方と並べ方（GitHub は読まない。gh の JSON を受け取るだけ。テストは test/select.test.ts）。
 */
import { BASE_BRANCH, ISSUE_PICK_LABEL, NO_MERGE_TITLE_MARK, SKIP_LABELS_ISSUE, SKIP_LABELS_PR } from './config.ts';

export interface GhLabel {
  name: string;
}

export interface IssueInfo {
  number: number;
  title: string;
  createdAt: string;
  url?: string;
  labels: GhLabel[];
}

export interface CheckInfo {
  /** CheckRun のとき */
  conclusion?: string | null;
  status?: string | null;
  /** StatusContext のとき */
  state?: string | null;
  name?: string;
  context?: string;
}

export interface PrInfo {
  number: number;
  title: string;
  createdAt: string;
  url?: string;
  isDraft: boolean;
  labels: GhLabel[];
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  body: string;
  closingIssuesReferences?: { number: number }[];
  statusCheckRollup?: CheckInfo[];
}

export interface Skipped {
  number: number;
  reason: string;
}

/** 古い順（作った日時、同じなら番号） */
export function byOldest<T extends { createdAt: string; number: number }>(a: T, b: T): number {
  const t = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return t !== 0 && !Number.isNaN(t) ? t : a.number - b.number;
}

const CLOSING_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)\b/gi;

/** PR が閉じる Issue の番号（本文の Closes #n・Fixes #n と、GitHub が持つ closingIssuesReferences） */
export function closingIssues(pr: Pick<PrInfo, 'body' | 'closingIssuesReferences'>): number[] {
  const found = new Set<number>();
  for (const m of (pr.body ?? '').matchAll(CLOSING_RE)) found.add(Number(m[1]));
  for (const r of pr.closingIssuesReferences ?? []) found.add(r.number);
  return [...found].sort((a, b) => a - b);
}

function labelHit(labels: GhLabel[], skip: string[]): string | undefined {
  return labels.map((l) => l.name).find((n) => skip.includes(n));
}

export interface IssueSelection {
  picked: IssueInfo[];
  skipped: Skipped[];
  /** ラベル claude（ISSUE_PICK_LABEL）が無いので見なかった Issue の番号（古い順）。数が多いので skipped とは分ける */
  unlabeled: number[];
}

/**
 * 開いている Issue から、エージェントに渡すものを古い順に選ぶ。
 * 拾うのはラベル claude の付いたものだけ（claude-implement.yml と同じ合図）。`--issue N`（only）で指したときはラベルが無くても扱う
 */
export function selectIssues(issues: IssueInfo[], openPrs: PrInfo[], opts: { only?: number } = {}): IssueSelection {
  const covered = new Map<number, number[]>();
  for (const pr of openPrs) {
    for (const n of closingIssues(pr)) covered.set(n, [...(covered.get(n) ?? []), pr.number]);
  }
  const picked: IssueInfo[] = [];
  const skipped: Skipped[] = [];
  const unlabeled: number[] = [];
  const pool = opts.only === undefined ? issues : issues.filter((i) => i.number === opts.only);
  if (opts.only !== undefined && pool.length === 0) skipped.push({ number: opts.only, reason: '開いている Issue に無い' });
  for (const issue of [...pool].sort(byOldest)) {
    if (opts.only === undefined && !issue.labels.some((l) => l.name === ISSUE_PICK_LABEL)) {
      unlabeled.push(issue.number);
      continue;
    }
    const label = labelHit(issue.labels, SKIP_LABELS_ISSUE);
    if (label) {
      skipped.push({ number: issue.number, reason: `ラベル ${label}` });
      continue;
    }
    const prs = covered.get(issue.number);
    if (prs) {
      skipped.push({ number: issue.number, reason: `開いている PR ${prs.map((n) => `#${n}`).join('・')} が閉じる予定` });
      continue;
    }
    picked.push(issue);
  }
  return { picked, skipped, unlabeled };
}

/** base の PR の状態（土台のブランチ名 → 状態）。none は、そのブランチの PR が無い */
export type BaseState = 'merged' | 'open' | 'none';

export interface PrPlanItem {
  pr: PrInfo;
  /** 土台の PR がマージ済みなので、base を本線へ向け直してから扱う */
  retarget: boolean;
}

export interface PrPlan {
  picked: PrPlanItem[];
  skipped: Skipped[];
  /** 同じ Issue を閉じる PR が2本以上（閉じずに報告する） */
  duplicates: { issue: number; prs: number[] }[];
}

/** 開いている PR から、マージを試すものを古い順に選ぶ */
export function planPrs(prs: PrInfo[], baseStates: Record<string, BaseState>, opts: { only?: number; exclude?: number[] } = {}): PrPlan {
  const picked: PrPlanItem[] = [];
  const skipped: Skipped[] = [];
  const pool = opts.only === undefined ? prs : prs.filter((p) => p.number === opts.only);
  if (opts.only !== undefined && pool.length === 0) skipped.push({ number: opts.only, reason: '開いている PR に無い' });
  for (const pr of [...pool].sort(byOldest)) {
    if (opts.exclude?.includes(pr.number)) continue;
    const reason = skipReason(pr, baseStates);
    if (reason) {
      skipped.push({ number: pr.number, reason });
      continue;
    }
    picked.push({ pr, retarget: pr.baseRefName !== BASE_BRANCH });
  }
  return { picked, skipped, duplicates: duplicateClosers(prs) };
}

function skipReason(pr: PrInfo, baseStates: Record<string, BaseState>): string | undefined {
  if (pr.isDraft) return '下書き';
  if (pr.title.includes(NO_MERGE_TITLE_MARK)) return `題に${NO_MERGE_TITLE_MARK}`;
  const label = labelHit(pr.labels, SKIP_LABELS_PR);
  if (label) return `ラベル ${label}`;
  if (pr.isCrossRepository) return 'フォークからの PR';
  if (pr.baseRefName !== BASE_BRANCH) {
    const st = baseStates[pr.baseRefName] ?? 'none';
    if (st === 'open') return `積み重ね：土台（${pr.baseRefName}）の PR がまだ開いている`;
    if (st === 'none') return `積み重ね：土台（${pr.baseRefName}）が本線でなく、その PR も無い`;
  }
  return undefined;
}

export function duplicateClosers(prs: PrInfo[]): { issue: number; prs: number[] }[] {
  const by = new Map<number, number[]>();
  for (const pr of prs) for (const n of closingIssues(pr)) by.set(n, [...(by.get(n) ?? []), pr.number]);
  return [...by.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([issue, list]) => ({ issue, prs: [...list].sort((a, b) => a - b) }))
    .sort((a, b) => a.issue - b.issue);
}

/** GitHub の CI（statusCheckRollup）が1つ以上あり、すべて成功か */
export function checksAllSuccess(checks: CheckInfo[] | undefined): boolean {
  if (!checks || checks.length === 0) return false;
  return checks.every((c) => {
    if (c.state !== undefined && c.state !== null && c.conclusion === undefined) return c.state === 'SUCCESS';
    return c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED';
  });
}
