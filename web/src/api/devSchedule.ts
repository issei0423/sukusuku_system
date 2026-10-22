/*
 * 発達チェックの推奨スケジュールの作り方（モックの側）
 * 典拠：基本設計書.md「推奨スケジュールの作り方」(4-9)（docs と第3.0版の作り直し（design-v3-connect）で同じ文面）
 *
 *   最初の予定日：園児を登録した日（画面・CSV）を基準日とし、基準日の月齢の推奨頻度の日数を足した日
 *   健診の節目を優先：基準日と上の日のあいだに乳幼児健診の節目（1歳6か月・3歳・5歳の応当日）があれば、節目の日を予定日にする
 *
 * 推奨頻度は m_development_frequency、節目の月齢は設定 dev.milestone_months（既定 18,36,60）から読む
 * （基本設計書「推奨スケジュールの作り方に使う値」(5-8)）。読むのは api/mock.ts の側で、ここは日付の計算だけを持つ。
 * サーバ側は server/dev_schedule.go の scheduleRule.next と monthAnniversary（GitHub Issue #164 の 3）
 */
import { addDays, ageInMonths, lastDayOfMonth } from './util';

/** 乳幼児健診の節目の既定（基本設計書「設定マスタ（m_setting）」(5-9) の dev.milestone_months） */
export const DEFAULT_MILESTONE_MONTHS = '18,36,60';

/**
 * 生年月日から months か月の応当日。応当日が存在しない月（1月31日生まれの2月など）は、その月の末日とする。
 * 月齢の算出（ageInMonths）と同じ考え方で、この日に月齢がちょうど months になる（要件定義書「月齢の算出規則」(7-1 No.6)）
 */
export function monthAnniversary(birthDate: string, months: number): string {
  const [y, m, d] = birthDate.split('-').map(Number);
  if (!y || !m || !d) return '';
  const total = (m - 1) + months;
  const ty = y + Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const day = Math.min(d, lastDayOfMonth(ty, tm));
  return `${String(ty).padStart(4, '0')}-${String(tm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 節目の月齢を小さい順に並べる。数として読めない値があれば、既定値へ戻して警告を出す
 * （基本設計書「設定マスタ（m_setting）」(5-9)「既定値へフォールバックしたうえで警告ログを出力する」。サーバ側は parseMilestones）
 */
export function parseMilestones(values: string[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (!/^[1-9][0-9]{0,8}$/.test(v)) {
      console.warn(`[設定マスタ] dev.milestone_months の値 ${v} を月齢として解釈できません。既定値 ${DEFAULT_MILESTONE_MONTHS} を用います`);
      return [18, 36, 60];
    }
    out.push(Number(v));
  }
  return out.sort((a, b) => a - b);
}

/**
 * 基準日（baseDate）から予定日を作る。推奨頻度がマスタに無い月齢では作らない（null）。
 *
 * 【仮置き】節目の「あいだ」は、基準日の翌日から、推奨頻度で数えた日の前日まで（web/仮置き値.md「健診の節目の『あいだ』」）。
 * 基準日ちょうどが節目のときは、節目を予定日にしない。その日を予定日にすると、翌日から「過ぎた」になるため。
 * 節目が2つ入るときは、早いほうを取る。
 */
export function recommendedScheduleDate(
  birthDate: string, baseDate: string,
  frequencies: { age_month_from: number; age_month_to: number; interval_days: number }[],
  milestones: number[],
): string | null {
  const age = ageInMonths(birthDate, baseDate);
  const freq = [...frequencies].sort((a, b) => a.age_month_from - b.age_month_from)
    .find((f) => age >= f.age_month_from && age <= f.age_month_to);
  if (!freq) return null;
  const next = addDays(baseDate, freq.interval_days);
  for (const m of [...milestones].sort((a, b) => a - b)) {
    const d = monthAnniversary(birthDate, m);
    if (d && d > baseDate && d < next) return d;
  }
  return next;
}
