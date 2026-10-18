/*
 * 午睡記録の帳票（CSV）の中身
 * 典拠：図/画面詳細図.md「午睡記録検索画面」(5-3) の項目6・9・10・11、基本設計書.md「帳票の出力」(4-8)
 *
 * 帳票に含めるもの：チェックした時刻と保存時刻、体位・呼吸・顔色・体温、記録した職員、入眠（ねた）と起床（おきた）、
 * 入眠時の体温（ねたの行）、異常時の記録。ヒヤリハットを起票した異常時の記録は、ヒヤリハット側の状況・とった対応を出し、
 * 起票済みの印を付けて二重に数えない（要件定義書「日誌システム」(4-3) の「集計・監査時はヒヤリハット側を正」）。
 *
 * 「修正あり」の印と、きょうは対象外と理由は、まだ載せていない（記録の修正と対象外の一覧は別の作業）。
 */
import type { NapAbnormalRow, NapSearchRow } from '../../api/shapes';
import { BODY_POSITION, BREATHING, COMPLEXION } from '../../api/codes';

/** 一覧の見出し。画面詳細図「午睡記録検索画面」(5-3) の項目6の並び */
export const NAP_REPORT_HEADER = ['日付', 'チェック時刻', '園児', 'クラス', '体位', '呼吸', '顔色', '体温', '記録者', '保存時刻'];

/** 同じ期間の異常時の記録の見出し。同 (5-3) の項目11の並び */
export const NAP_ABNORMAL_HEADER = ['発見時刻', '園児', '状況', '対応', '記録者', 'ヒヤリハット'];

/** ねた・おきたの行に出す名前。画面詳細図「午睡記録検索画面」(5-3) の項目6「入眠（ねた）と起床（おきた）」 */
export const SLEEP_ROW_LABEL = { sleep: '入眠（ねた）', wake: '起床（おきた）' } as const;

/** 一覧の1行に体温の列として出す値。確認の行は確認の体温、ねたの行は入眠時の体温、おきたの行は出さない */
export function rowTemperature(r: NapSearchRow): number | null {
  if (r.kind === 'check') return r.temperature;
  if (r.kind === 'sleep') return r.sleep_temperature;
  return null;
}

/**
 * 帳票に出す異常時の記録の状況・とった対応。起票した記録はヒヤリハット側を出す。
 * 日誌が見つからない記録（incident_* が null）は、記録そのものを出す
 */
export function abnormalForReport(a: NapAbnormalRow): { situation: string; response: string; raised: boolean } {
  const raised = a.diary_id !== null;
  if (raised && a.incident_situation !== null && a.incident_response !== null) {
    return { situation: a.incident_situation, response: a.incident_response, raised };
  }
  return { situation: a.situation, response: a.response, raised };
}

/**
 * CSV の行。一覧の行のあとに1行あけ、「同じ期間の異常時の記録」の見出しと行を続ける。
 * 【仮置き】ねた・おきたの行は、体位の列に「入眠（ねた）」「起床（おきた）」を入れ、呼吸・顔色・保存時刻を空にする。
 * 画面は体位・呼吸・顔色の3列をまとめて名前を出す。CSV では列をまとめられないため、先頭の列に入れた（web/仮置き値.md）。
 * 【仮置き】異常時の記録を同じファイルの下に続ける形（web/仮置き値.md）。画面の2つの一覧と同じ並びにした
 */
export function napReportRows(rows: NapSearchRow[], abnormals: NapAbnormalRow[]): unknown[][] {
  const out: unknown[][] = rows.map((r) => {
    if (r.kind === 'check') {
      return [
        r.session_date, r.checked_at, r.child_name, r.class_name,
        r.body_position ? BODY_POSITION[r.body_position] : '',
        r.breathing ? BREATHING[r.breathing] : '',
        r.complexion ? COMPLEXION[r.complexion] : '',
        r.temperature ?? '', r.staff_name, r.saved_at ?? '',
      ];
    }
    return [
      r.session_date, r.checked_at, r.child_name, r.class_name,
      SLEEP_ROW_LABEL[r.kind], '', '', rowTemperature(r) ?? '', r.staff_name, '',
    ];
  });
  if (abnormals.length === 0) return out;
  out.push([], ['同じ期間の異常時の記録'], NAP_ABNORMAL_HEADER);
  for (const a of abnormals) {
    const v = abnormalForReport(a);
    out.push([a.found_at, a.child_name, v.situation, v.response, a.staff_name, v.raised ? '起票済み' : '未起票']);
  }
  return out;
}
