/*
 * 写真の同意を画面で先に確かめる（担保はサーバ。server/api_contact_photo.go・api/mock.ts の sendPhoto）
 * 典拠：基本設計書「写真の同意で止める規則」(4-2)、詳細設計書「写真を送る」(2-2 (7)) の②
 *
 * 写っている子が1人なら同意 2 以上、2人以上なら全員 3。満たさない子の格子に印を出し、「送る」を押せなくする。
 */
import type { PhotoConsentLevel } from '../api/types';

export interface PickerChild { child_id: string; child_name: string; photo_consent_level: PhotoConsentLevel }

/** 選んだもの。写っている子が0人なら noChildren を真にして、届ける子（target）を1人選ぶ */
export interface SubjectSelection { subjects: string[]; noChildren: boolean; target: string | null }

/** 同意が足りないときの印。同意 1 は「園内記録のみ」、2人以上の写真で同意 2 は「ほかの家庭には出せない」。足りていれば null */
export function consentMark(level: PhotoConsentLevel, subjectCount: number): string | null {
  if (level === '1') return '園内記録のみ';
  if (subjectCount >= 2 && level !== '3') return 'ほかの家庭には出せない';
  return null;
}

/** 選んだ写っている子のうち、同意が足りない子（選んだ順） */
export function consentFailures(candidates: PickerChild[], subjects: string[]): PickerChild[] {
  return subjects.map((id) => candidates.find((c) => c.child_id === id))
    .filter((c): c is PickerChild => !!c && consentMark(c.photo_consent_level, subjects.length) !== null);
}
