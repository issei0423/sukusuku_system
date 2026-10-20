/*
 * 午睡チェックの記録の修正（POST /api/nap/records/{id}/correct）の文言と、操作ログ・帳票の形
 * 典拠：基本設計書.md「記録の修正と改ざん防止」「帳票の出力」(4-8)・「入力項目の制約値」(4-12)・「操作ログ（t_operation_log）」(5-9)、
 *      詳細設計書.md「訂正・取り消しのまとめ」(3-5)、図/画面詳細図.md「午睡記録検索画面」(5-3) の項目10・12
 *
 * 規則はサーバ（server/api_nap_correct.go）とモック（api/mock.ts の correctNapRecord）の両方にある。ここは両方が同じ文言・
 * 同じ形を使うための置き場（サーバの値は api_nap_correct.go の msgNapCorrect*・napRecordFields・napCorrectionText と同じ）。
 */
import { BODY_POSITION, BREATHING, COMPLEXION } from './codes';
import type { NapRecord } from './types';

/** 修正の文言。【仮置き】設計の「メッセージ一覧」(4-12) に無いため置いた（web/仮置き値.md「午睡チェックの記録の修正」） */
export const NAP_CORRECT_MSG = {
  target: '午睡の記録の指定が正しくありません',
  reason: '修正の理由を入力してください',
  reasonLong: '修正の理由は500文字以内で入力してください',
  notFound: '午睡の記録が見つかりません',
  forbidden: 'この園児の午睡の記録を修正する権限がありません',
  pastDay: '実施の日を過ぎた記録は、管理者が修正します',
  abnormal: '異常時の記録がある子の午睡チェックの記録は、管理者が修正します',
  noChange: 'いまの記録と同じ値です。直す項目を変えてください',
} as const;

/**
 * 修正の要求。直す項目のうち変えるものだけを送る（図/インタフェース一覧.md）。送らない項目はいまの値のまま。
 * 体温は null で消せる（【仮置き】web/仮置き値.md）。理由は必須（1〜500文字）
 */
export interface NapRecordCorrectInput {
  body_position?: NapRecord['body_position'];
  breathing?: NapRecord['breathing'];
  complexion?: NapRecord['complexion'];
  temperature?: number | null;
  reason: string;
}

/** 【仮置き】帳票の一覧の「修正あり」の列に入れる印（server/api_nap_correct.go の napReportCorrectedMark） */
export const NAP_CORRECTED_MARK = '修正あり';

/** 操作ログの修正前・修正後に入れる項目（区分値は表示名、体温は数値か null）。サーバの napRecordFields と同じ項目名・同じ順 */
export function napRecordFields(r: Pick<NapRecord, 'body_position' | 'breathing' | 'complexion' | 'temperature'>): [string, unknown][] {
  return [
    ['体位', BODY_POSITION[r.body_position]],
    ['呼吸', BREATHING[r.breathing]],
    ['顔色', COMPLEXION[r.complexion]],
    ['体温', r.temperature],
  ];
}

/** 修正前・修正後の列に出す項目の順（操作ログの項目名と同じ） */
const CORRECTION_KEYS = ['体位', '呼吸', '顔色', '体温'];

function parseFields(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 修正前・修正後の値を「体位=うつ伏せ、体温=36.8」の形にする（体温は小数第1位、無いのは「なし」。理由は入れない）。
 * 【仮置き】帳票の「修正の履歴」の修正前・修正後の書き方（web/仮置き値.md）。サーバの napCorrectionText と同じ
 */
export function napCorrectionText(json: string | null): string {
  const m = parseFields(json);
  if (!m) return json ?? '';
  return CORRECTION_KEYS.filter((k) => k in m).map((k) => {
    const v = m[k];
    if (v === null) return `${k}=なし`;
    if (typeof v === 'number') return `${k}=${v.toFixed(1)}`;
    return `${k}=${String(v)}`;
  }).join('、');
}

/** 修正後の値に添えた理由（サーバの napCorrectionReason と同じ） */
export function napCorrectionReason(json: string | null): string {
  const v = parseFields(json)?.['理由'];
  return typeof v === 'string' ? v : '';
}
