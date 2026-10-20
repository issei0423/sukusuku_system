/*
 * きょうのようすを時刻の順（朝から）に並べる
 * 典拠：詳細設計書「共通の部品」(2-0 (1)) の TodayTimeline・「きょうのようすと園から」(2-6 (5))・「きょうのようすを足す・直す」(2-3 (4))、
 *      図/画面詳細図「連絡帳画面」(8-3)・「連絡帳（園児）画面」(8-2) 項目6・7
 *
 * 午睡は「13:05 おひるね中」「14:40 おきた（1時間35分）」と、常に添える文を出す。
 * 体温・午睡の長さに判定の言葉や色を付けない。訂正したものには「訂正しました（15:20）」。
 * 前に開いたあとに記録・訂正されたものには「新」を添える（lastReadAt と比べる）。
 * 職員の画面で使うとき（viewer="staff"）は、記録した職員の名前と、保護者に出さない設定の印を添え、
 * 直せる人には行ごとに「直す・取り消す」を出す（onFix）。
 */
import type { ContactEvent, ContactPage, NapSleep } from '../../api/shapes';
import { settingText } from '../../api/client';
import { formatHM, today } from '../../api/util';
import { TEXT } from '../../messages';
import { eventText, sleepLines } from './contactText';
import ContactPhotoImage from './ContactPhotoImage';

const EVENT_ITEM: Record<string, string> = { '1': 'meal', '2': 'toilet', '3': 'temperature', '4': 'comment', '5': 'photo' };

export type TimelineFix = { kind: 'event'; event: ContactEvent } | { kind: 'sleep'; sleep: NapSleep };

interface Item {
  key: string; at: string; text: string; heading?: string; corrected: string | null; staff?: string; nap?: boolean;
  hidden?: boolean; fix?: TimelineFix;
  /** 写真の出来事なら写真の ID（時刻と絵を出す。押すと画面いっぱいに出す。詳細設計書 (2-6 (5))） */
  photoId?: number;
}

export default function TodayTimeline({ page, viewer, lastReadAt, onFix }: {
  page: ContactPage;
  viewer: 'guardian' | 'staff';
  /** この画面を開く前に読んだ時刻。無ければ「新」を付けない */
  lastReadAt?: string | null;
  /** 職員の画面で、直せる人のときだけ渡す。行に「直す・取り消す」を出す */
  onFix?: (target: TimelineFix) => void;
}) {
  const isToday = page.contact_date === today();
  // 保護者に出さない設定の種類（職員の画面だけ印を付ける。基本設計書「出す項目と選択肢の設定」(4-5)）
  const shown = viewer === 'staff'
    ? settingText('contact.show_items', 'nap,meal,toilet,temperature,comment,photo,class').split(',').map((v) => v.trim())
    : null;
  const hidden = (item: string) => !!shown && !shown.includes(item);
  const items: Item[] = [
    ...page.events.map((e): Item => ({ key: `e${e.contact_event_id}`, at: e.recorded_at,
      // 写真は「写真」と添えた文（あれば）
      text: e.event_type === '5' && e.body ? `${eventText(e)}　${e.body}` : eventText(e), corrected: e.corrected_at,
      staff: viewer === 'staff' ? e.staff_name : undefined, hidden: hidden(EVENT_ITEM[e.event_type]), fix: { kind: 'event', event: e },
      photoId: e.event_type === '5' && e.contact_photo_id !== null ? e.contact_photo_id : undefined })),
    ...page.class_notes.map((c): Item => ({ key: `c${c.contact_class_id}`, at: c.recorded_at, text: c.body, heading: 'クラスのようす',
      corrected: c.corrected_at, hidden: hidden('class') })),
    ...page.sleeps.flatMap((s) => sleepLines(s, isToday, viewer).map((l, i): Item => ({ key: `s${s.nap_sleep_id}-${i}`, at: l.at, text: l.text,
      corrected: s.corrected_at, nap: true, hidden: hidden('nap'), fix: i === 0 ? { kind: 'sleep', sleep: s } : undefined }))),
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
              {it.hidden && <span className="tag tag-plain contact-hidden">保護者には出していません</span>}
              {it.photoId !== undefined && (
                <span className="contact-timeline-photo">
                  <ContactPhotoImage photoId={it.photoId} label={`${formatHM(it.at)} の写真`} size="timeline" />
                </span>
              )}
            </span>
            {isNew(it) && <span className="tag tag-applied contact-new">新</span>}
            {onFix && it.fix && (
              <button type="button" className="btn-sm contact-fix-button" onClick={() => onFix(it.fix!)}
                aria-label={`${formatHM(it.at)} ${it.text} を直す・取り消す`}>直す・取り消す</button>
            )}
          </li>
        ))}
      </ol>
      {page.sleeps.length > 0 && <p className="muted contact-nap-note">{TEXT.napAlwaysNote}</p>}
    </>
  );
}
