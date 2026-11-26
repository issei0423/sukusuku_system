/*
 * 保護者ホームの「きょう」（園児1人の区画）
 * 典拠：詳細設計書「保護者ホーム（「きょう」）」(2-5)、基本設計書「保護者ホームの『きょう』」(3-5)、図/画面詳細図「保護者ホーム」(2-7)
 *
 * 上から：日付と園児名（顔写真は出さない）→ きょうのようす（時刻の順の並び）→ 園から → 家庭から → 入口の行
 * （連絡帳を開く・成長の記録・園とのやりとり。children に渡された行も並べる）→ 下に固定した「家庭からを書く」。
 * 午睡の確認の回数や間隔・既読の状態・判定の言葉は出さない。
 *
 * 【仮置き】見た目は紙の連絡帳に寄せた（web/仮置き値.md「保護者の画面の見た目」）。きょうのようすは、
 * 午睡の行（その日のいちばん新しい組）と新しい3件を、時刻の順に並べる。設計は「午睡を先頭に」としていたが、
 * 時刻の順に並べるほうが、1日の流れとして読める（午睡の行の内容と、新しい3件の選び方は変えていない）。
 * 時刻のある項目だけで並べ、時刻の無い項目（園から・家庭から）は並べない。
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { GuardianToday } from '../../api/shapes';
import { formatHM, formatMD, jstMs } from '../../api/util';
import { TEXT } from '../../messages';
import { dayLabel, latestSleepRow } from './contactText';
import ContactPhotoImage from './ContactPhotoImage';
import { EditIcon, ForwardIcon } from '../../components/icons';
import { useStickyInset } from '../../stickyInset';

interface Row { key: string; at: string; text: string; isNap: boolean; photoId: number | null }

export default function TodayCard({ today: t, ageText, newCount, switcher, children }: {
  today: GuardianToday;
  /** 「2歳3か月」。園児名の下に、クラスと並べて出す */
  ageText: string;
  /** 「新しく n 件」。この画面を開く前からの新しいものと、開いている間に届いたものを足した数 */
  newCount: number;
  /** お子さまが2人以上のときの名前のタブ。日付の下に置く */
  switcher?: ReactNode;
  /** 入口の行の続き（チャット・お知らせ・園からの配布物）。同じ区画の中で、下に固定したボタンまで同じ列に並べる */
  children?: ReactNode;
}) {
  // 下に止めた「家庭からを書く」の高さを --guardian-cta-h として渡す。Tab で下へ進んだ入口の行が、止めたボタンの下に隠れないようにする
  // （WCAG 2.4.11、GitHub Issue #212。使う CSS は styles/guardian.css）
  const ctaRef = useStickyInset(':root', '--guardian-cta-h');
  const contactPath = `/guardian/contact/${encodeURIComponent(t.child_id)}`;
  const nap = latestSleepRow(t.nap, true);
  const rows: Row[] = [
    ...(nap && t.nap ? [{ key: 'nap', at: nap.at, text: nap.text, isNap: true, photoId: null }] : []),
    ...t.latest.map((item) => ({
      key: `${item.kind}-${item.recorded_at}-${item.text}`,
      at: item.recorded_at,
      text: item.kind === 'class_note' ? `クラスのようす：${item.text}` : item.text,
      isNap: false,
      photoId: item.contact_photo_id,
    })),
  ].sort((a, b) => jstMs(a.at) - jstMs(b.at));
  const writeHome = !t.home && t.can_write_home;
  return (
    <section className="contact-today-card" aria-label={`${t.child_name}さんのきょう`}>
      <header className="guardian-day-head">
        {/* 画面でいちばん目立たせるのは日付だけ。件数は区画の頭に出さず、「連絡帳を開く」の行の字で示す（見直し m7a-16） */}
        <h1 className="guardian-date"><span>{dayLabel(t.contact_date)}</span></h1>
        {switcher}
        <div className="guardian-child-line">
          <h2>{t.child_name}<span className="guardian-san">さん</span></h2>
          <p>{t.class_name}<span aria-hidden="true">　</span>{ageText}</p>
        </div>
        {t.grace_ends_on && <p className="muted">{formatMD(t.grace_ends_on)}まで読むことができます</p>}
      </header>

      <div className="guardian-day-body">
        <div className="guardian-day-main">
          <div className="contact-today-block">
            <h3>きょうのようす</h3>
            {rows.length === 0 && <p className="empty">{TEXT.noRecordToday}</p>}
            {rows.length > 0 && (
              <ol className="contact-latest guardian-timeline">
                {rows.map((r) => (
                  <li key={r.key} className={r.isNap ? 'contact-nap' : undefined}>
                    <time dateTime={r.at}>{formatHM(r.at)}</time>
                    <span className="guardian-time-text">
                      {r.text}
                      {/* 写真は 56px の小さな絵（詳細設計書「保護者ホーム」(2-5 (2))） */}
                      {r.photoId !== null && (
                        <span className="contact-latest-photo">
                          <ContactPhotoImage photoId={r.photoId} label={`${formatHM(r.at)} の写真`} size="thumb" />
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {/* 保護者ホームの「きょう」は、園の記録で書き換わっても読み上げへ伝えない（詳細設計書 (2-0) の (6)「読まないもの」、GitHub Issue #209） */}
            {nap && <p className="muted contact-nap-note">{TEXT.napAlwaysNote}</p>}
          </div>

          {t.facility && (
            <div className="contact-today-block">
              <h3>園から</h3>
              <p className="guardian-ruled">{t.facility.excerpt}</p>
              <Link to={contactPath}>続きを読む</Link>
            </div>
          )}

          <div className="contact-today-block">
            <h3>家庭から</h3>
            {t.home ? (
              <>
                <p>{formatHM(t.home.submitted_at)} 送りました</p>
                <p className={t.home.confirmed_at ? 'contact-confirmed' : 'contact-call'}>
                  {t.home.confirmed_at ? `園が確認しました（${formatHM(t.home.confirmed_at)}）` : TEXT.callIfUrgent}
                </p>
              </>
            ) : (
              <p className="muted">{TEXT.noHomeYet}</p>
            )}
          </div>
        </div>

        <div className="contact-today-links">
          <Link className="guardian-panel-link" to={contactPath}>
            <span>連絡帳を開く{newCount > 0 && <>{' '}<span className="guardian-link-note">新しく {newCount} 件</span></>}</span><ForwardIcon />
          </Link>
          {/* 成長の記録（詳細設計書「保護者ホーム（「きょう」）」(2-5) の入口。きょう届いたものがあれば添える） */}
          <Link className="guardian-panel-link" to={`/guardian/growth/${encodeURIComponent(t.child_id)}`}>
            {/* 数の無い新着は、行の字と小さい点（文は赤の丸に入れない。見直し m7a-16） */}
            <span>成長の記録{t.growth_new && <>{' '}<span className="guardian-link-note"><span className="badge-dot" aria-hidden="true" />新しい記録があります</span></>}</span>
            <ForwardIcon />
          </Link>
          {t.personal_room_id !== null && (
            <Link className="guardian-panel-link" to="/guardian/chat">
              <span>{t.child_name}の園とのやりとり{t.unread_chat > 0 && <>{' '}<span className="guardian-link-note">未読 {t.unread_chat}</span></>}</span><ForwardIcon />
            </Link>
          )}
          {children}
        </div>
      </div>

      {/* 朝にまず押すのはこれ。親指の届く下に止め、画面に塗りのボタンはこの1つだけにする（見直し 2026-10-31 の r2b-06） */}
      {writeHome && (
        <div className="guardian-cta" ref={ctaRef}>
          <Link className="btn btn-primary contact-wide-button" to={contactPath}><EditIcon />家庭からを書く</Link>
        </div>
      )}
    </section>
  );
}

