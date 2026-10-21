/*
 * アクセシビリティの自動検査（a11y-axe.spec.ts）で、分かっていてまだ直していない違反の一覧。
 * ここにある組み合わせ（規則 × 場面）は、影響が critical・serious でもテストを落とさない。
 * 一覧に入れるのは、直す先が決まっているものだけ。Issue か PR の番号を必ず添える。
 * 直したら行を消す。消し忘れは a11y-report/summary.md の「既知だが今回は出なかったもの」に出る。
 */
export interface KnownA11yViolation {
  /** axe の規則 id（例：color-contrast） */
  rule: string;
  /** 場面の id（scenarios.ts）。'*' はすべての場面 */
  scenes: string[] | '*';
  /** 直すことを追っている Issue・PR の番号 */
  issue: number;
  /** いま直さない理由 */
  note: string;
}

/** 場面ごとの違反のまとめ。a11y-axe.spec.ts が添付し、a11y-reporter.ts が一覧にする */
export interface A11yViolationSummary {
  rule: string;
  impact: string;
  count: number;
  help: string;
  helpUrl: string;
  targets: string[];
  /** 既知の一覧に入っていれば、その Issue・PR の番号 */
  knownIssue?: number;
}

export const knownA11yViolations: KnownA11yViolation[] = [
  {
    // 園児登録・園児編集の「呼び名」の入力欄（PR #198 で足す）。Field の子が入力欄と説明の2つあるため、
    // Field が入力欄に label を結び付けず、読み上げの名前が無い（WCAG 1.3.1・4.1.2）。直すのは #198 の中（PR にコメントした）。
    // #198 がマージされる前の本線では出ないので、そのあいだは a11y-report/summary.md の「既知だが今回は出なかったもの」に出る
    rule: 'label',
    scenes: ['child-new', 'child-edit'],
    issue: 198,
    note: '園児登録・園児編集の「呼び名」の入力欄に label が結び付いていない。PR #198 の中で直す',
  },
];

export function findKnownA11yViolation(rule: string, scene: string): KnownA11yViolation | undefined {
  return knownA11yViolations.find((known) => known.rule === rule && (known.scenes === '*' || known.scenes.includes(scene)));
}
