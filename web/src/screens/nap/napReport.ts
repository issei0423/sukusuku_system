/*
 * 午睡記録検索画面の一覧に出す、ねた・おきた・きょうは対象外の行の名前と体温
 * 典拠：図/画面詳細図.md「午睡記録検索画面」(5-3) の項目6、基本設計書.md「帳票の出力」(4-8)
 *
 * 帳票（CSV）は画面で組み立てない。サーバで作り（server/api_nap_report.go の GET /api/nap/report。
 * モックは api/napReport.ts と api/mock.ts の napReport）、画面は受け取った本文を保存するだけにする。
 * 出力の範囲と、操作ログに残す期間・件数を、画面の実装に頼らないため（基本設計書「帳票の出力」(4-8)）。
 */
import type { NapSearchRow } from '../../api/shapes';
import { SLEEP_ROW_LABEL, exclusionRowLabel } from '../../api/napReport';

/** ねた・おきたの行に出す名前。帳票と同じ名前（api/napReport.ts） */
export { SLEEP_ROW_LABEL };

/**
 * 確認の行でない行（ねた・おきた・きょうは対象外）の、体位・呼吸・顔色の3列をまとめて出す名前。
 * 帳票の体位の列と同じ名前（「入眠（ねた）」「起床（おきた）」「きょうは対象外（欠席）」など）
 */
export function rowLabel(r: NapSearchRow): string {
  if (r.kind === 'sleep' || r.kind === 'wake') return SLEEP_ROW_LABEL[r.kind];
  if (r.kind === 'exclusion' && r.exclusion_reason) return exclusionRowLabel(r.exclusion_reason);
  return '';
}

/** 一覧の1行に体温の列として出す値。確認の行は確認の体温、ねたの行は入眠時の体温、おきた・対象外の行は出さない */
export function rowTemperature(r: NapSearchRow): number | null {
  if (r.kind === 'check') return r.temperature;
  if (r.kind === 'sleep') return r.sleep_temperature;
  return null;
}
