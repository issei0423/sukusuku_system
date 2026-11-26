/*
 * 行事カレンダーの画面で使う文言の組み立て
 * 典拠：設計書に定め無し。配布物の形に合わせた【仮置き】（web/仮置き値.md「行事カレンダーの動き」）
 */
import type { CalendarEvent } from '../../api/types';

/** 題名・内容の長さの上限。【仮置き】サーバ（server/api_event.go）・モック（api/mock.ts）と同じ値 */
export const EVENT_TITLE_MAX = 50;
export const EVENT_NOTE_MAX = 500;

/** 時刻の表示。両方なければ「終日」、開始だけなら「09:00 から」 */
export function eventTimeText(e: Pick<CalendarEvent, 'start_time' | 'end_time'>): string {
  if (!e.start_time) return '終日';
  return e.end_time ? `${e.start_time}〜${e.end_time}` : `${e.start_time} から`;
}

/** 対象の表示。園全体は class_name が空 */
export function eventTargetText(e: Pick<CalendarEvent, 'class_name'>): string {
  return e.class_name ?? '園全体';
}

/** 日ごとの予定の件数 */
export function countByDate(events: CalendarEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.event_date] = (counts[e.event_date] ?? 0) + 1;
  return counts;
}
