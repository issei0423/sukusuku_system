/*
 * 保護者ホームの「きょう」（園児1人の区画）
 * 典拠：詳細設計書「保護者ホーム（「きょう」）」(2-5)、基本設計書「保護者ホームの『きょう』」(3-5)、図/画面詳細図「保護者ホーム」(2-7)
 *
 * 上から：見出し（園児名・クラス・日付。顔写真は出さない）→ 家庭から → きょうのようす（午睡を先頭に、新しい3件）→
 * 園から → 入口（連絡帳を開く・園とのやりとり）。午睡の確認の回数や間隔・既読の状態・判定の言葉は出さない。
 */
import { Link } from 'react-router-dom';
import type { GuardianToday } from '../../api/shapes';
import { formatHM, formatMD } from '../../api/util';
import { TEXT } from '../../messages';
import { dayLabel, latestSleepText } from './contactText';
import ContactPhotoImage from './ContactPhotoImage';
import { EditIcon, ForwardIcon } from '../../components/icons';

export default function TodayCard({ today: t, newCount }: {
  today: GuardianToday;
  /** 「新しく n 件」。この画面を開く前からの新しいものと、開いている間に届いたものを足した数 */
  newCount: number;
}) {
  const contactPath = `/guardian/contact/${encodeURIComponent(t.child_id)}`;
  const nap = latestSleepText(t.nap, true);
  const nothing = !t.home && !nap && t.latest.length === 0 && !t.facility;
  return (
    <section className="guardian-home-panel contact-today-card" aria-label={`${t.child_name}さんのきょう`}>
      <div className="guardian-panel-heading">
        <div>
          <span className="guardian-eyebrow">{t.class_name}・{dayLabel(t.contact_date)}</span>
          <h2 className="contact-today-name">{t.child_name}さんのきょう</h2>
        </div>
        {newCount > 0 && <span className="badge">新しく {newCount} 件</span>}
      </div>
      {t.grace_ends_on && <p className="muted">{formatMD(t.grace_ends_on)}まで読むことができます</p>}

      <div className="contact-today-block">
        <h3>家庭から</h3>
        {t.home ? (
          <>
            <p>{formatHM(t.home.submitted_at)} 送りました</p>
            <p className={t.home.confirmed_at ? 'contact-confirmed' : 'contact-call'}>
              {t.home.confirmed_at ? `園が確認しました（${formatHM(t.home.confirmed_at)}）` : TEXT.callIfUrgent}
            </p>
          </>
        ) : t.can_write_home ? (
          <Link className="btn btn-primary contact-wide-button" to={contactPath}><EditIcon />家庭からを書く</Link>
        ) : (
          <p className="muted">{TEXT.noHomeYet}</p>
        )}
      </div>

      <div className="contact-today-block">
        <h3>きょうのようす</h3>
        {nothing && <p className="empty">{TEXT.noRecordToday}</p>}
        {nap && (
          <>
            {/* 保護者ホームの「きょう」は、園の記録で書き換わっても読み上げへ伝えない（詳細設計書 (2-0) の (6)「読まないもの」、GitHub Issue #209） */}
            <p className="contact-nap">{nap}</p>
            <p className="muted contact-nap-note">{TEXT.napAlwaysNote}</p>
          </>
        )}
        {t.latest.length > 0 && (
          <ul className="contact-latest">
            {t.latest.map((item) => (
              <li key={`${item.kind}-${item.recorded_at}-${item.text}`}>
                <time dateTime={item.recorded_at}>{formatHM(item.recorded_at)}</time> {item.kind === 'class_note' ? `クラスのようす：${item.text}` : item.text}
                {/* 写真は 56px の小さな絵（詳細設計書「保護者ホーム」(2-5 (2))） */}
                {item.contact_photo_id !== null && (
                  <span className="contact-latest-photo">
                    <ContactPhotoImage photoId={item.contact_photo_id} label={`${formatHM(item.recorded_at)} の写真`} size="thumb" />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {t.facility && (
        <div className="contact-today-block">
          <h3>園から</h3>
          <p>{t.facility.excerpt}</p>
          <Link to={contactPath}>続きを読む</Link>
        </div>
      )}

      <div className="contact-today-links">
        <Link className="guardian-panel-link" to={contactPath}><span>連絡帳を開く</span><ForwardIcon /></Link>
        {/* 成長の記録（詳細設計書「保護者ホーム（「きょう」）」(2-5) の入口。きょう届いたものがあれば添える） */}
        <Link className="guardian-panel-link" to={`/guardian/growth/${encodeURIComponent(t.child_id)}`}>
          <span>成長の記録{t.growth_new && <span className="badge growth-new">新しい記録があります</span>}</span>
          <ForwardIcon />
        </Link>
        {t.personal_room_id !== null && (
          <Link className="guardian-panel-link" to="/guardian/chat">
            <span>{t.child_name}の園とのやりとり{t.unread_chat > 0 ? `（未読 ${t.unread_chat}）` : ''}</span><ForwardIcon />
          </Link>
        )}
      </div>
    </section>
  );
}
