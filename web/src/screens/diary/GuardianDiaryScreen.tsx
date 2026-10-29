/*
 * 園からの日誌（保護者・スマートフォン）
 *
 * 保育士が申請するときに「保護者へ共有する」を選び、管理者が承認した、自児の個人日誌を読む。
 * 保育士の申請と管理者の承認の2つがそろったものだけが並ぶ（2026-10-29 に持ち主が決めた。server/api_diary_share.go）。
 * 並びは記録日の新しい順。
 */
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty } from '../../components/ui';
import { formatYMD } from '../../api/util';

export default function GuardianDiaryScreen() {
  const { user } = useSession();
  const { data, error, loading } = useAsync(() => api.guardianDiaries(user!), [user?.account_id]);
  // 園児が2人以上いるときだけ、どの子の日誌かを添える
  const several = new Set((data ?? []).map((d) => d.child_id)).size > 1;

  return (
    <div className="guardian-home">
      <div className="guardian-page-intro">
        <span className="guardian-eyebrow">園からのおたより</span>
        <h1>園からの日誌</h1>
        <p>担任が書き、園長が確かめた日誌です。</p>
      </div>

      {loading && <Loading />}
      {error && <ErrorBox text={error} />}
      {data?.length === 0 && <Empty text="共有された日誌はまだありません。" />}

      {data?.map((d) => (
        <section className="guardian-home-panel" key={d.diary_id}>
          <div className="guardian-panel-heading">
            <h2>{formatYMD(d.diary_date)}{several && `　${d.child_name}`}</h2>
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{d.body}</div>
        </section>
      ))}
    </div>
  );
}
