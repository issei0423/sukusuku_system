/*
 * 午睡チェック表（帳票・CSV）の中身。モック（api/mock.ts の napReport）が使う
 * 典拠：基本設計書.md「帳票の出力」(4-8)、図/画面詳細図.md「午睡記録検索画面」(5-3) の項目6・9・10・11
 *
 * 帳票はサーバで作る（server/api_nap_report.go）。モックはサーバの代わりに同じ規則・同じ中身で作るため、
 * 見出し・行の形・並び・セルの無害化をここに持つ。画面はこのファイルで帳票を組み立てない
 * （出力の範囲と記録を画面の実装に頼らない。基本設計書「帳票の出力」(4-8)）。
 */
import { toCsv } from '../csv';

/** 帳票の見出し。画面詳細図「午睡記録検索画面」(5-3) の項目6の並びに「修正あり」を添える（server/api_nap_report.go の napReportHeader） */
export const NAP_REPORT_HEADER = ['日付', 'チェック時刻', '園児', 'クラス', '体位', '呼吸', '顔色', '体温', '記録者', '保存時刻', '修正あり'];

/** 同じ期間の異常時の記録の見出し。同 (5-3) の項目11の並び */
export const NAP_ABNORMAL_HEADER = ['発見時刻', '園児', '状況', '対応', '記録者', 'ヒヤリハット'];

export const NAP_ABNORMAL_TITLE = '同じ期間の異常時の記録';

/** ねた・おきたの行に出す名前。画面詳細図「午睡記録検索画面」(5-3) の項目6「入眠（ねた）と起床（おきた）」 */
export const SLEEP_ROW_LABEL = { sleep: '入眠（ねた）', wake: '起床（おきた）' } as const;

/** きょうは対象外の理由（t_nap_exclusion.reason。1:欠席 2:午睡なし） */
export const EXCLUSION_REASON_LABEL = { '1': '欠席', '2': '午睡なし' } as const;

/** 帳票の文言。サーバ（server/api_nap_report.go の msgNapReport*・requireAdmin）と同じ */
export const NAP_REPORT_MSG = {
  adminOnly: 'この操作は管理者のみが行えます',
  // 【仮置き】PDF は作らない。PDF のライブラリと日本語の字体を入れるかが決まっていない（web/仮置き値.md「午睡の帳票」）
  pdf: 'PDF の帳票はまだ出力できません。CSV で出力してください',
  format: '帳票の形式が正しくありません',
  period: '期間の開始と終了を、日付で指定してください',
  range: '期間の開始は、終了より後の日にできません',
} as const;

/** 帳票を求める条件（GET /api/nap/report のクエリ）。クラスが空ならすべてのクラス */
export interface NapReportFilter {
  from: string;
  to: string;
  classId?: number | '';
  format: 'csv' | 'pdf';
}

/** 帳票の行の種類。午睡記録検索の check・sleep・wake に、きょうは対象外（exclusion）を足す */
export type NapReportLineKind = 'check' | 'sleep' | 'wake' | 'exclusion';

/** 帳票の1行。並べ替えの鍵と、出すセル */
export interface NapReportLine {
  kind: NapReportLineKind;
  id: number;
  at: string;
  cells: string[];
}

/** 同じ期間の異常時の記録の1行 */
export interface NapReportAbnormal {
  id: number;
  foundAt: string;
  cells: string[];
}

/** 体温を小数第1位まで出す。記録が無ければ空（server/api_nap_report.go の napReportTemperature） */
export function reportTemperature(v: number | null): string {
  return v === null ? '' : v.toFixed(1);
}

/**
 * 行を時刻の新しい順に並べる（午睡記録検索と同じ）。
 * 【仮置き】同じ時刻は、おきた・確認・ねた・対象外の順、同じ種類は番号の小さい順（web/仮置き値.md「一覧の並び順」）
 */
export function sortReportLines(lines: NapReportLine[]): NapReportLine[] {
  const rank: Record<NapReportLineKind, number> = { wake: 0, check: 1, sleep: 2, exclusion: 3 };
  return [...lines].sort((a, b) => b.at.localeCompare(a.at) || rank[a.kind] - rank[b.kind] || a.id - b.id);
}

/** 異常時の記録を発見時刻の新しい順に並べる。同じ時刻はあとで記録したもの（番号の大きいもの）を先にする */
export function sortReportAbnormals(rows: NapReportAbnormal[]): NapReportAbnormal[] {
  return [...rows].sort((a, b) => b.foundAt.localeCompare(a.foundAt) || b.id - a.id);
}

/**
 * 帳票の本文（BOM は付けない。保存する画面が付ける）。1行目は見出し、続けて一覧の行。
 * 異常時の記録があれば、1行あけて「同じ期間の異常時の記録」の見出しと行を続ける。
 * 【仮置き】1つのファイルに2つの表を続ける形（web/仮置き値.md「午睡の帳票」）。
 * セルは web/src/csv.ts で無害化する（式の始まりになる文字に ' を付ける。GitHub Issue #153）
 */
export function napReportCsv(lines: NapReportLine[], abnormals: NapReportAbnormal[]): string {
  const rows: string[][] = lines.map((l) => l.cells);
  if (abnormals.length > 0) {
    rows.push([], [NAP_ABNORMAL_TITLE], NAP_ABNORMAL_HEADER, ...abnormals.map((a) => a.cells));
  }
  return toCsv(NAP_REPORT_HEADER, rows);
}
