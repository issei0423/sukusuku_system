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
import { Loading, ErrorBox, Empty } from '../../components/ui';
import { formatAge, formatMD, today } from '../../api/util';
import { DIARY_RECORD_TYPE } from '../../api/codes';

export default function GuardianHome() {
  const { user } = useSession();
  const { data, error, loading } = useAsync(() => api.guardianHome(user!), [user?.account_id]);

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

          {/* 緊急の連絡は電話で行う。通知の到達性には限界がある（利用規約 第4条） */}
          <section className="guardian-contact-note">
            <div>
              急なご連絡は、チャットではなくお電話でお願いします。
              チャットの通知は、端末の設定や通信の状況により届かない場合があります。
            </div>
          </section>
        </div>
      ))}
    </div>
  );
}
