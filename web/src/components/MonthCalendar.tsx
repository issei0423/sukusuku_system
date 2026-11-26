/*
 * 月のカレンダー（日曜〜土曜の7列の格子）
 * 典拠：設計書に定め無し。配布物の形に合わせた【仮置き】（web/仮置き値.md「行事カレンダーの動き」）
 *
 * 前の月・次の月・今月へ移れる。予定のある日には件数の印を出し、今日と選んだ日は形でも分ける（色だけにしない）。
 * 月の移動の形は、連絡帳の月の一覧（screens/contact/MonthList.tsx）に合わせた。
 * 日のボタンは 44px 以上。スマートフォン（375px）でも横にはみ出さない（styles/screens.css の .cal-*）。
 */
import { PrevIcon, ForwardIcon } from './icons';
import { lastDayOfMonth } from '../api/util';
import { dayLabel } from '../screens/contact/contactText';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 「2026-10」の前の月・次の月 */
const shiftMonth = (month: string, delta: number): string => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (month: string): string => `${month.slice(0, 4)}年${Number(month.slice(5))}月`;

/** 月の格子。週ごとの7日（月の外の日は null） */
function weeksOf(month: string): (string | null)[][] {
  const [y, m] = month.split('-').map(Number);
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = lastDayOfMonth(y, m);
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export default function MonthCalendar({ month, selected, today, counts, onMonthChange, onSelect }: {
  /** 表示する月 'YYYY-MM' */
  month: string;
  /** 選んでいる日 'YYYY-MM-DD'。選んでいなければ null */
  selected: string | null;
  /** 今日 'YYYY-MM-DD' */
  today: string;
  /** 日ごとの予定の件数（無い日は 0 とみなす） */
  counts: Record<string, number>;
  onMonthChange: (month: string) => void;
  onSelect: (date: string) => void;
}) {
  const weeks = weeksOf(month);
  const thisMonth = today.slice(0, 7);
  return (
    <div className="cal">
      <nav className="contact-date" aria-label="月の移動">
        <button type="button" onClick={() => onMonthChange(shiftMonth(month, -1))} aria-label="前の月へ"><PrevIcon />前の月</button>
        <strong className="cal-title" aria-live="polite">{monthLabel(month)}</strong>
        <button type="button" onClick={() => onMonthChange(shiftMonth(month, 1))} aria-label="次の月へ">次の月<ForwardIcon /></button>
      </nav>
      <div className="cal-today-row">
        <button type="button" className="btn-sm" onClick={() => onMonthChange(thisMonth)}
          disabled={month === thisMonth} aria-label="今月へ戻る">今月へ戻る</button>
      </div>
      <table className="cal-grid" aria-label={`${monthLabel(month)}のカレンダー`}>
        <thead>
          <tr>
            {WEEKDAYS.map((w) => <th key={w} scope="col">{w}</th>)}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, wi) => (
            <tr key={wi}>
              {week.map((date, di) => {
                if (!date) return <td key={di} className="cal-blank" aria-hidden="true" />;
                const n = counts[date] ?? 0;
                const isToday = date === today;
                const isSelected = date === selected;
                const label = `${dayLabel(date)}${isToday ? '、今日' : ''}${n > 0 ? `、予定${n}件` : '、予定なし'}`;
                return (
                  <td key={di}>
                    <button type="button" className={`cal-day${isToday ? ' is-today' : ''}`}
                      aria-label={label} aria-pressed={isSelected} aria-current={isToday ? 'date' : undefined}
                      onClick={() => onSelect(date)}>
                      <span className="cal-num">{Number(date.slice(8))}</span>
                      {n > 0 && <span className="cal-count" aria-hidden="true">{n}</span>}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
