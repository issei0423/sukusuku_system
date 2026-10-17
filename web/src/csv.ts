/*
 * CSV 出力の組み立て
 * 典拠：基本設計書.md「操作ログ」(5-8)「操作ログと午睡記録の CSV 出力は、操作ログへ「出力」として記録する。
 *      出力は画面側で作る」
 *
 * CSV を出す画面（操作ログ参照画面・午睡記録検索画面）は、必ずここを通して作る。
 *
 * 【仮置き】セルの無害化は設計に定めが無い（web/仮置き値.md、GitHub Issue #153）。
 * 出力した CSV は Excel などの表計算ソフトで開かれる。先頭が = + - @ のセルは式として扱われうる。
 * 保護者が自己登録で入れた氏名は、操作ログの操作者としてそのまま出る。要配慮個人情報を扱う端末で
 * 式を動かさないよう、先頭が式の始まりになる文字（= + - @ タブ・改行）のセルには ' を前に付け、
 * 文字列として開かせる。
 */

/** 先頭にあると、表計算ソフトが式の始まりとして扱いうる文字 */
const FORMULA_START = /^[=+\-@\t\r\n]/;

/** 1つのセル。式の始まりになる文字で始まるものは ' を前に付け、" で囲んで中の " を二重にする */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** 見出しと行から CSV の本文を作る。1行1レコード */
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

/** CSV をファイルとして保存させる。Excel で開いても文字化けしないよう、先頭に BOM を付ける */
export function downloadCsv(fileName: string, header: string[], rows: unknown[][]): void {
  const blob = new Blob([`﻿${toCsv(header, rows)}`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
