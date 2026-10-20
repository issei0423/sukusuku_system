/*
 * 連絡帳の表示の言葉（詳細設計書「きょうのようすと園から」(2-6 (5))・「午睡・ひとこと・園からの列」(2-2 (6))）
 *
 * 判定の言葉・色を付けない（体温・午睡の長さに良し悪しを言わない。要件定義書「判断を行わないことの担保」(7-1 No.5)）。
 */
import type { ContactEvent, NapSleep } from '../../api/shapes';
import { formatHM, jstMs } from '../../api/util';
import { MEAL_AMOUNT_TEXT, MEAL_KIND_TEXT } from '../../messages';

/** 「1時間35分」「45分」 */
export function durationText(from: string, to: string): string {
  const minutes = Math.max(0, Math.floor((jstMs(to) - jstMs(from)) / 60_000));
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h}時間${minutes % 60}分` : `${minutes}分`;
}

/**
 * おきたの前の組を言葉にする。実施中なら「13:05 おひるね中」、おきたが無いまま実施が終わっていれば「13:05 ねた」
 * （職員には「（おきたが未記録）」を添える）。おきたを推測で入れない（詳細設計書「午睡の園児」(3-4)）
 */
function asleepText(s: NapSleep, isToday: boolean, viewer: 'guardian' | 'staff'): string {
  if (isToday && !s.session_ended) return `${formatHM(s.slept_at)} おひるね中`;
  return `${formatHM(s.slept_at)} ねた${viewer === 'staff' ? '（おきたが未記録）' : ''}`;
}

/** 午睡の1組を、時刻の順の行にする（ねた・おきた） */
export function sleepLines(s: NapSleep, isToday: boolean, viewer: 'guardian' | 'staff' = 'guardian'): { at: string; text: string }[] {
  if (!s.woke_at) return [{ at: s.slept_at, text: asleepText(s, isToday, viewer) }];
  return [
    { at: s.slept_at, text: `${formatHM(s.slept_at)} ねた` },
    { at: s.woke_at, text: `${formatHM(s.woke_at)} おきた（${durationText(s.slept_at, s.woke_at)}）` },
  ];
}

/** その日のいちばん新しい組を1行で（保護者ホーム・連絡帳（クラス）画面） */
export function latestSleepText(s: NapSleep | null | undefined, isToday: boolean, viewer: 'guardian' | 'staff' = 'guardian'): string | null {
  if (!s) return null;
  if (!s.woke_at) return asleepText(s, isToday, viewer);
  return `${formatHM(s.woke_at)} おきた（${durationText(s.slept_at, s.woke_at)}）`;
}

/** きょうのようすの出来事を言葉にする（時刻は別に出す） */
export function eventText(e: ContactEvent): string {
  switch (e.event_type) {
    case '1': return `${MEAL_KIND_TEXT[e.meal_kind ?? '1']} ${MEAL_AMOUNT_TEXT[e.meal_amount ?? '1']}`;
    case '2': return e.toilet_label ?? '';
    case '3': return e.temperature === null ? '' : `${e.temperature.toFixed(1)}℃`;
    case '5': return '写真';
    default: return e.body ?? '';
  }
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 「10月17日（金）」 */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${m}月${d}日（${WEEKDAYS[w]}）`;
}

/** 家庭からの中身を短い行に並べる（職員のセル・保護者の送った内容） */
export function homeLines(h: {
  temperature: number | null; night_sleep_from: string | null; night_sleep_to: string | null;
  breakfast: string | null; mood_label: string | null; pickup_type: string | null; pickup_person: string | null;
  pickup_time: string | null; message: string | null;
}): { label: string; text: string; mark?: boolean }[] {
  const out: { label: string; text: string; mark?: boolean }[] = [];
  if (h.temperature !== null) out.push({ label: '体温', text: `${h.temperature.toFixed(1)}℃` });
  if (h.night_sleep_from || h.night_sleep_to) out.push({ label: '夜の睡眠', text: `${h.night_sleep_from ?? '―'}〜${h.night_sleep_to ?? '―'}` });
  if (h.breakfast) out.push({ label: '朝ごはん', text: MEAL_AMOUNT_TEXT[h.breakfast as '1'] ?? '' });
  if (h.mood_label) out.push({ label: 'きげん', text: h.mood_label });
  if (h.pickup_type === '2') out.push({ label: 'お迎え', text: `変更あり ${h.pickup_person ?? ''} ${h.pickup_time ?? ''}`, mark: true });
  else if (h.pickup_type === '1') out.push({ label: 'お迎え', text: 'いつもどおり' });
  if (h.message) out.push({ label: '連絡事項', text: h.message, mark: true });
  return out;
}
