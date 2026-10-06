/*
 * 保護者ホーム
 * 典拠：基本設計書.md「画面の一覧」(3-2)「自児の情報とチャットへの導線」
 *
 * 記録の閲覧はチャット画面の中で行い、専用の閲覧画面を持たない（同「画面体系図」(3-3)）。
 * ここに置くのは自児の基本情報と、共有された記録への導線までとする。
 */
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Tag } from '../../components/ui';
import { formatAge, formatMD, today } from '../../api/util';
import { DIARY_RECORD_TYPE, HANDOUT_TYPE } from '../../api/codes';

export default function GuardianHome() {
  const { user } = useSession();
  const { data, error, loading } = useAsync(() => api.guardianHome(user!), [user?.account_id]);
  // 園からの配布物。園だより・献立表など、あとから見返すもの
  const handouts = useAsync(() => api.handouts(user!), [user?.account_id]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox text={error} />;
  if (!data) return null;

  if (data.length === 0) {
    return <Empty text="お子さまの紐づけがありません。園へお問い合わせください。" />;
  }

  return (
    <div className="stack">
      {data.map((h) => (
        <div key={h.child.child_id}>
          <section className="card">
            <h2>{h.child.child_name}</h2>
            <div className="muted">
              {h.className} ／ {formatAge(h.child.birth_date, today())}
            </div>
          </section>

          <section className="card">
            <div className="row">
              <h2>チャット</h2>
              <div className="spacer" />
              {h.unread > 0 && <span className="tag tag-applied">未読 {h.unread}</span>}
            </div>
            <Link className="btn btn-primary btn-block" to="/guardian/chat">チャットを開く</Link>
            <div className="muted" style={{ marginTop: 8 }}>
              園からのお知らせ、クラスの連絡、担任の先生とのやりとりはチャットで行います。
            </div>
          </section>

          <section className="card">
            <h2>共有された記録</h2>
            {h.sharedDiaries.length === 0
              ? <Empty text="共有された記録はまだありません。" />
              : (
                <div className="stack">
                  {h.sharedDiaries.slice(0, 5).map((d) => (
                    <Link key={d.diary_id} className="btn btn-block" to={`/guardian/diary/${d.diary_id}`}
                      style={{ justifyContent: 'space-between' }}>
                      <span>{formatMD(d.diary_date)} {DIARY_RECORD_TYPE[d.record_type]}</span>
                      <span>開く</span>
                    </Link>
                  ))}
                </div>
              )}
          </section>

        </div>
      ))}

      {/*
        園からの配布物は、園児ごとではなく1つにまとめて置く。園全体向けのものが中心であり、
        きょうだいがいても同じものを二度並べないため。新しいものを3件だけ出し、残りは一覧で見せる
      */}
      <section className="card">
        <h2>園からの配布物</h2>
        {handouts.loading && <Loading />}
        {handouts.error && <ErrorBox text={handouts.error} />}
        {handouts.data?.length === 0 && <Empty text="配布物はまだありません。" />}
        {handouts.data && handouts.data.length > 0 && (
          <div className="stack">
            {handouts.data.slice(0, 3).map((h) => (
              <Link key={h.handout_id} className="btn btn-block handout-row" to="/guardian/handouts">
                <span className="handout-title">
                  <Tag label={HANDOUT_TYPE[h.handout_type] ?? 'その他'} className="tag-applied" />
                  <span>{h.title}</span>
                </span>
              </Link>
            ))}
            <Link className="btn btn-block" to="/guardian/handouts">園だより・献立表をすべて見る</Link>
          </div>
        )}
      </section>

      {/* 緊急の連絡は電話で行う。通知の到達性には限界がある（利用規約 第4条） */}
      <section className="card card-sub">
        <div className="muted">
          急なご連絡は、チャットではなくお電話でお願いします。
          チャットの通知は、端末の設定や通信の状況により届かない場合があります。
        </div>
      </section>
    </div>
  );
}
