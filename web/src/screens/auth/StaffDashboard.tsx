/*
 * 職員ダッシュボード
 * 典拠：図/画面詳細図.md「職員ダッシュボード」(2-4)
 *
 * 未対応の件数を最上部に置く。出勤直後に「何が残っているか」を1画面で把握させるため。
 * 承認待ちの区画は管理者にのみ表示する。
 */
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox } from '../../components/ui';
import { formatYMD, today } from '../../api/util';

export default function StaffDashboard() {
  const { user } = useSession();
  const { data, error, loading } = useAsync(() => api.staffSummary(user!), [user?.account_id]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox text={error} />;
  if (!data || !user) return null;

  const rows = [
    { label: '差し戻された日誌', count: data.returned, unit: '件', to: '/staff/diary?status=4' },
    { label: '未読のチャット', count: data.unreadChat, unit: '件', to: '/staff/chat' },
    { label: '発達チェックの未実施', count: data.devOverdue, unit: '名', to: '/staff/growth' },
    { label: 'ヒヤリハット未起票の異常時の記録', count: data.abnormalWithoutDiary, unit: '件', to: '/staff/nap/abnormal' },
  ].filter((r) => r.count > 0);

  return (
    <div>
      <div className="page-head">
        <h1>ダッシュボード</h1>
        <div className="spacer" />
        <span className="muted">今日 {formatYMD(today())}</span>
      </div>

      <div className="grid12">
        {/* 未対応 */}
        <section className="card col-7">
          <h2>未対応</h2>
          {rows.length === 0
            ? <div className="empty">未対応の項目はありません。</div>
            : (
              <table className="list">
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td className="num nowrap">{r.count} {r.unit}</td>
                      <td className="nowrap"><Link className="btn btn-sm" to={r.to}>開く</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </section>

        {/* よく使う。実施中の午睡チェックがあれば先頭に出す（画面詳細図 2-4） */}
        <section className="card col-5">
          <h2>よく使う</h2>
          <div className="stack">
            {data.activeNap && (
              <Link className="btn btn-primary btn-block" to="/staff/nap">
                午睡チェックが実施中です（開く）
              </Link>
            )}
            {!data.activeNap && <Link className="btn btn-block" to="/staff/nap">午睡チェックを開始</Link>}
            <Link className="btn btn-block" to="/staff/diary/new">日誌を書く</Link>
            <Link className="btn btn-block" to="/staff/growth/physical">身体測定を入力</Link>
            <Link className="btn btn-block" to="/staff/growth">発達チェックを入力</Link>
          </div>
        </section>

        {/* 承認待ちは管理者にのみ表示する */}
        {user.role === '1' && (
          <section className="card col-12">
            <div className="row">
              <h2>承認待ち</h2>
              <div className="spacer" />
              <span>{data.pending} 件</span>
              <Link className="btn btn-sm" to="/staff/admin/approval">一覧へ</Link>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
