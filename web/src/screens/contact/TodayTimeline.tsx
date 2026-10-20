/*
 * きょうのようすを時刻の順（朝から）に並べる
 * 典拠：詳細設計書「共通の部品」(2-0 (1)) の TodayTimeline・「きょうのようすと園から」(2-6 (5))、図/画面詳細図「連絡帳画面」(8-3)
 *
 * 午睡は「13:05 おひるね中」「14:40 おきた（1時間35分）」と、常に添える文を出す。
 * 体温・午睡の長さに判定の言葉や色を付けない。訂正したものには「訂正しました（15:20）」。
 * 前に開いたあとに記録・訂正されたものには「新」を添える（lastReadAt と比べる）。
 * 職員の画面で使うとき（viewer="staff"）は、記録した職員の名前を添える。
 */
import type { ContactPage } from '../../api/shapes';
import { formatHM, today } from '../../api/util';
import { TEXT } from '../../messages';
import { eventText, sleepLines } from './contactText';

interface Item { key: string; at: string; text: string; heading?: string; corrected: string | null; staff?: string; nap?: boolean }

export default function TodayTimeline({ page, viewer, lastReadAt }: {
  page: ContactPage;
  viewer: 'guardian' | 'staff';
  /** この画面を開く前に読んだ時刻。無ければ「新」を付けない */
  lastReadAt?: string | null;
}) {
  const isToday = page.contact_date === today();
  const items: Item[] = [
    ...page.events.map((e) => ({ key: `e${e.contact_event_id}`, at: e.recorded_at, text: eventText(e), corrected: e.corrected_at,
      staff: viewer === 'staff' ? e.staff_name : undefined })),
    ...page.class_notes.map((c) => ({ key: `c${c.contact_class_id}`, at: c.recorded_at, text: c.body, heading: 'クラスのようす', corrected: c.corrected_at })),
    ...page.sleeps.flatMap((s) => sleepLines(s, isToday, viewer).map((l, i) => ({ key: `s${s.nap_sleep_id}-${i}`, at: l.at, text: l.text, corrected: s.corrected_at, nap: true }))),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
  const isNew = (it: Item) => !!lastReadAt && (it.at > lastReadAt || (it.corrected !== null && it.corrected > lastReadAt));

  if (items.length === 0) {
    return <p className="empty">{isToday ? TEXT.noRecordToday : TEXT.noRecordDay}</p>;
  }
  return (
    <>
      <ol className="contact-timeline">
        {items.map((it) => (
          <li key={it.key} className={it.nap ? 'is-nap' : undefined}>
            {/* 午睡の行は時刻を文の中に持つ（「13:05 おひるね中」） */}
            {!it.nap && <time dateTime={it.at}>{formatHM(it.at)}</time>}
            <span className="contact-timeline-text">
              {it.heading && <strong className="contact-timeline-heading">{it.heading}</strong>}
              {it.text}
              {it.corrected && <span className="muted">　訂正しました（{formatHM(it.corrected)}）</span>}
              {it.staff && <span className="muted">　{it.staff}</span>}
            </span>
            {isNew(it) && <span className="tag tag-applied contact-new">新</span>}
          </li>
        ))}
      </ol>
      {page.sleeps.length > 0 && <p className="muted contact-nap-note">{TEXT.napAlwaysNote}</p>}
    </>
  );
}
