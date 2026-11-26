/*
 * 行事カレンダー画面（保護者・スマートフォン）。見るだけ
 * 典拠：設計書に定め無し。配布物の形に合わせた【仮置き】（web/仮置き値.md「行事カレンダーの動き」）
 *
 * 見られるのは、園全体の予定と、自児がいま在籍するクラスの予定だけ（サーバ側で絞る）。
 * 園が足した・直した・消したときは、開いたままでも読み直す（live.ts）。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Tag } from '../../components/ui';
import MonthCalendar from '../../components/MonthCalendar';
import { dayLabel } from '../contact/contactText';
import { today } from '../../api/util';
import { BackIcon } from '../../components/icons';
import { eventTimeText, eventTargetText, countByDate } from './calendarText';

export default function GuardianCalendarScreen() {
  const { user } = useSession();
  const [month, setMonth] = useState(today().slice(0, 7));
  const [selected, setSelected] = useState<string | null>(today());
  const { data, error, loading } = useAsync(() => api.calendarEvents(user!, month),
    [user?.account_id, month], { live: onLive('calendar') });

  const dayEvents = (data?.events ?? []).filter((e) => e.event_date === selected);
  const changeMonth = (m: string) => {
    setMonth(m);
    setSelected(m === today().slice(0, 7) ? today() : null);
  };

  return (
    <div className="guardian-home">
      <div className="guardian-page-intro">
        <Link className="btn btn-quiet btn-sm" to="/guardian"><BackIcon />ホームへ</Link>
        <span className="guardian-eyebrow" style={{ marginTop: 8 }}>園からのおしらせ</span>
        <h1>行事カレンダー</h1>
        <p>園の行事や予定を、月ごとに見られます。</p>
      </div>

      <section className="guardian-home-panel">
        {loading && !data && <Loading />}
        {error && <ErrorBox text={error} />}
        <MonthCalendar month={month} selected={selected} today={today()}
          counts={countByDate(data?.events ?? [])} onMonthChange={changeMonth} onSelect={setSelected} />
      </section>

      <section className="guardian-home-panel" aria-labelledby="cal-day-title">
        <div className="guardian-panel-heading"><h2 id="cal-day-title">{selected ? `${dayLabel(selected)}の予定` : '予定'}</h2></div>
        {!selected && <Empty text="日を選ぶと、その日の予定が出ます。" />}
        {selected && data && dayEvents.length === 0 && <Empty text="この日の予定はありません。" />}
        {dayEvents.length > 0 && (
          <ul className="cal-events">
            {dayEvents.map((e) => (
              <li key={e.event_id} className="cal-event">
                <div className="cal-event-head">
                  <span className="cal-event-time">{eventTimeText(e)}</span>
                  <Tag label={eventTargetText(e)} />
                </div>
                <span className="cal-event-title">{e.title}</span>
                {e.note && <p className="cal-event-note">{e.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
