/*
 * 午睡記録検索画面の一覧に出す、ねた・おきたの行の名前と体温
 * 典拠：図/画面詳細図.md「午睡記録検索画面」(5-3) の項目6、基本設計書.md「帳票の出力」(4-8)
 *
 * 帳票（CSV）は画面で組み立てない。サーバで作り（server/api_nap_report.go の GET /api/nap/report。
 * モックは api/napReport.ts と api/mock.ts の napReport）、画面は受け取った本文を保存するだけにする。
 * 出力の範囲と、操作ログに残す期間・件数を、画面の実装に頼らないため（基本設計書「帳票の出力」(4-8)）。
 */
import type { NapSearchRow } from '../../api/shapes';

/** ねた・おきたの行に出す名前。帳票と同じ名前（api/napReport.ts） */
export { SLEEP_ROW_LABEL } from '../../api/napReport';

/** 一覧の1行に体温の列として出す値。確認の行は確認の体温、ねたの行は入眠時の体温、おきたの行は出さない */
export function rowTemperature(r: NapSearchRow): number | null {
  if (r.kind === 'check') return r.temperature;
  if (r.kind === 'sleep') return r.sleep_temperature;
  return null;
}
