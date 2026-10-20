/*
 * 保護者ホーム
 * 典拠：基本設計書.md「画面の一覧」(3-2)「自児の情報とチャットへの導線」、
 *      詳細設計書「保護者ホーム（「きょう」）」(2-5)、基本設計書「保護者ホームの『きょう』」(3-5)
 *
 * 園児ごとの「きょう」の区画（連絡帳の要約と未読。contact/TodayCard.tsx）を、園児の情報のすぐ下に置く。
 * 「ねた」「おきた」などは、園が記録した時点で知らせ（contact）を受けて読み直す。
 * 共有された記録（日誌）の区画は、日誌の作り直し（共有の道を外す。詳細設計書 (2-10 (3))）まで残す。
 */
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAsync, AUTO_REFRESH_MS } from '../../hooks';
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Tag } from '../../components/ui';
import { formatAge, formatMD, today } from '../../api/util';
import { DIARY_RECORD_TYPE, HANDOUT_TYPE } from '../../api/codes';
import TodayCard from '../contact/TodayCard';

export default function GuardianHome() {
  const { user } = useSession();
  /*
   * 開いたままでも、連絡帳（家庭からの確認・ねた・おきた・きょうのようす）・チャットの未読・発達と身体測定が
   * すぐに表れるよう、知らせ（live.ts）を受けて読み直す（詳細設計書「画面ごとの読み直し」(6-5)）。
   * 午睡（nap）・日誌（diary）の知らせは保護者へ届かない（詳細設計書「PR #196 からの変更」(6-1)）
   */
  const { data, error, loading } = useAsync(() => api.guardianHome(user!), [user?.account_id],
    { refreshMs: AUTO_REFRESH_MS, live: onLive('contact', 'chat', 'development', 'physical') });

  /*
   * 画面を開いたとき（表示した最初と、タブを前に出したとき）に、園児ごとに今日のページを開いた時刻を残す。
   * 知らせを受けた読み直しでは残さない（決めたこと D-23）。開く前からの新しいものの数を持っておき、
   * 開いている間に届いたものと足して「新しく n 件」に出す
   */
  const before = useRef<Record<string, number>>({});
  /** 開いた時刻を残したときに出していた応答。これより後の応答は、残したあとに届いたものだけを数える */
  const markedData = useRef<unknown>(null);
  const latestData = useRef(data);
  latestData.current = data;
  const newCount = (shown: unknown, childId: string, current: number) => {
    const base = before.current[childId];
    if (base === undefined) return current;
    return shown === markedData.current ? base : base + current;
  };
  const childIds = (data ?? []).map((h) => h.child.child_id).join(',');
  useEffect(() => {
    if (!user || !data) return;
    const mark = () => {
      const shown = latestData.current;
      if (!shown) return;
      for (const h of shown) {
        before.current[h.child.child_id] = newCount(shown, h.child.child_id, h.today.unread_contact);
        void api.markContactRead(user, h.child.child_id, today()).catch(() => undefined);
      }
      markedData.current = shown;
    };
    if (Object.keys(before.current).length === 0) mark();
    const onVisible = () => { if (document.visibilityState === 'visible') mark(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // 園児の顔ぶれが変わったときだけ付け直す（読み直しのたびに付け直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.account_id, childIds]);
  // 園からの配布物。園だより・献立表など、あとから見返すもの
  const handouts = useAsync(() => api.handouts(user!), [user?.account_id],
    { refreshMs: AUTO_REFRESH_MS, live: onLive('handout') });
  /*
   * ホームに出す「新しいもの」3件は、掲載した日時の新しい順に選ぶ（画面詳細図「保護者ホーム」(2-7) 項目7）。
   * 【仮置き】「新しい」が対象の月か掲載した日時かは設計に定めが無い（web/仮置き値.md）。
   * 対象の月の順にすると、過去の月の訂正版を今日掲載しても、掲載の知らせだけが届いてホームには出ない（GitHub Issue #170）。
   * 一覧（配布物一覧画面（保護者）(4-6)）は、これまでどおり対象の月ごとにまとめて新しい月を上に置く
   */
  const latestHandouts = [...(handouts.data ?? [])]
    .sort((a, b) => b.posted_at.localeCompare(a.posted_at)
      || b.target_month.localeCompare(a.target_month) || b.handout_id - a.handout_id)
    .slice(0, 3);

  if (loading) return <Loading />;
  if (error) return <ErrorBox text={error} />;
  if (!data) return null;

  if (data.length === 0) {
    return <Empty text="お子さまの紐づけがありません。園へお問い合わせください。" />;
  }

  return (
    <div className="guardian-home">
      <div className="guardian-home-intro">
        <span className="guardian-eyebrow">保護者ページ</span>
        <h1>こんにちは</h1>
        <p>園からの連絡と、お子さまの記録を確認できます。</p>
      </div>
      {data.map((h) => (
        <div className="guardian-child-section" key={h.child.child_id}>
          <section className="guardian-child-card" aria-label={`${h.child.child_name}さんの情報`}>
            <div className="guardian-child-card-text">
              <span className="guardian-eyebrow">お子さま</span>
              <h2>{h.child.child_name}</h2>
              <p>{h.className} <span aria-hidden="true">・</span> {formatAge(h.child.birth_date, today())}</p>
            </div>
            <img src="/crayon-smiles.png" alt="" />
          </section>

          {/* 園児1人の「きょう」（詳細設計書 (2-5)） */}
          <TodayCard today={h.today} newCount={newCount(data, h.child.child_id, h.today.unread_contact)} />

          <section className="guardian-home-panel guardian-chat-panel">
            <div className="guardian-panel-heading">
              <div>
                <span className="guardian-eyebrow">園とのやりとり</span>
                <h2>チャット・お知らせ</h2>
              </div>
              {h.unread > 0 && <span className="guardian-unread">未読 {h.unread}</span>}
            </div>
            <p>園からのお知らせや、担任の先生とのやりとりはこちらから。</p>
            <Link className="guardian-panel-link" to="/guardian/chat">
              <span>チャットを開く</span><span aria-hidden="true">→</span>
            </Link>
          </section>

          <section className="guardian-home-panel guardian-record-panel">
            <div className="guardian-panel-heading">
              <div>
                <span className="guardian-eyebrow">園でのようす</span>
                <h2>共有された記録</h2>
              </div>
            </div>
            {h.sharedDiaries.length === 0
              ? <Empty text="共有された記録はまだありません。" />
              : (
                <div className="guardian-record-list">
                  {h.sharedDiaries.slice(0, 5).map((d) => (
                    <Link key={d.diary_id} className="guardian-record-link" to={`/guardian/diary/${d.diary_id}`}>
                      <span>{formatMD(d.diary_date)} {DIARY_RECORD_TYPE[d.record_type]}</span>
                      <span aria-hidden="true">→</span>
                    </Link>
                  ))}
                </div>
              )}
          </section>

        </div>
      ))}

      {/*
        園からの配布物は、園児ごとではなく1つにまとめて置く。園全体向けのものが中心であり、
        きょうだいがいても同じものを二度並べないため。新しく掲載したものを3件だけ出し、残りは一覧で見せる
      */}
      <section className="guardian-home-panel guardian-handout-panel">
        <div className="guardian-panel-heading">
          <div>
            <span className="guardian-eyebrow">園からのおたより</span>
            <h2>園からの配布物</h2>
          </div>
        </div>
        {handouts.loading && <Loading />}
        {handouts.error && <ErrorBox text={handouts.error} />}
        {handouts.data?.length === 0 && <Empty text="配布物はまだありません。" />}
        {handouts.data && handouts.data.length > 0 && (
          <>
            <div className="guardian-record-list">
              {latestHandouts.map((h) => (
                <Link key={h.handout_id} className="guardian-record-link" to="/guardian/handouts">
                  <span className="handout-title">
                    <Tag label={HANDOUT_TYPE[h.handout_type] ?? 'その他'} className="tag-applied" />
                    <span>{h.title}</span>
                  </span>
                  <span aria-hidden="true">→</span>
                </Link>
              ))}
            </div>
            <Link className="guardian-panel-link guardian-handout-all" to="/guardian/handouts">
              <span>園だより・献立表をすべて見る</span><span aria-hidden="true">→</span>
            </Link>
          </>
        )}
      </section>

      {/* 緊急の連絡は電話で行う。通知の到達性には限界がある（利用規約 第4条） */}
      <section className="guardian-contact-note">
        <div>
          急なご連絡は、チャットではなくお電話でお願いします。
          チャットの通知は、端末の設定や通信の状況により届かない場合があります。
        </div>
      </section>
    </div>
  );
}
