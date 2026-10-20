/*
 * 成長の記録画面（保護者）の「できたこと」
 * 典拠：詳細設計書「成長の記録画面（保護者）」(2-11 (3))、図/画面詳細図「成長の記録画面（保護者・スマートフォン）」(6-6) の項目7・9
 *
 * 新しい順に、発達チェック（確定した日・確かめられた項目の名前・「先生から」の保護者へのひとこと）と、
 * 連絡帳から残したもの（日付・写真・添えた文、またはひとことの文）を混ぜて並べる。
 * 評価の言葉は足さない。並べるのはサーバが返した事実だけ（システムは判定・診断を行わない）。
 */
import type { GrowthEntry } from '../../api/shapes';
import { monthDay } from './growthText';

export default function GrowthTimeline({ entries }: { entries: GrowthEntry[] }) {
  return (
    <ol className="growth-timeline">
      {entries.map((e) => (
        <li key={`${e.kind}-${e.at}-${e.body ?? ''}`} className="growth-entry">
          <p className="growth-entry-head">
            <time dateTime={e.date}>{monthDay(e.date)}</time>
            {e.kind === 'development' && <span> 発達チェック</span>}
            {e.is_today && <span className="growth-today">きょう</span>}
          </p>
          {e.kind === 'development' && e.items && e.items.length > 0 && (
            <ul className="growth-items">
              {e.items.map((name) => <li key={name}>{name}</li>)}
            </ul>
          )}
          {e.kind === 'development' && e.message && (
            <div className="growth-message">
              <h4>先生から</h4>
              <p>{e.message}</p>
            </div>
          )}
          {e.kind === 'contact' && (
            <p className="growth-contact">
              {/* 【仮置き】写真は枠に「写真」とだけ出す。絵と PhotoViewer は連絡帳の写真を作る段で足す（詳細設計書 (2-11 (1))、web/仮置き値.md） */}
              {e.contact_photo_id != null && <span className="growth-photo-mark">写真</span>}
              {e.body}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
