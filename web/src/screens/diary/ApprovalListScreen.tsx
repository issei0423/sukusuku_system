/*
 * 承認待ち一覧画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)「申請日・クラス・作成者とともに一覧表示」
 */
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api, childName, className, staffName } from '../../api/client';
import { Loading, ErrorBox, Empty } from '../../components/ui';
import { DIARY_RECORD_TYPE } from '../../api/codes';
import { formatMD, formatMDHM } from '../../api/util';

export default function ApprovalListScreen() {
  const { user } = useSession();
  // 申請・承認・差し戻しがあったら、開いたままでも読み直す（live.ts）
  const { data, error, loading } = useAsync(() => api.pendingDiaries(user!), [user?.account_id],
    { live: onLive('diary') });

  return (
    <div>
      <div className="page-head">
        <h1>承認待ち</h1>
        <div className="spacer" />
        {data && <span className="muted">{data.length} 件</span>}
      </div>

      <section className="card">
        {loading && <Loading />}
        {error && <ErrorBox text={error} />}
        {data && data.length === 0 && <Empty text="承認待ちの日誌はありません。" />}
        {data && data.length > 0 && (
          <table className="list">
            <thead>
              <tr><th scope="col">申請</th><th scope="col">記録日</th><th scope="col">種別</th><th scope="col">クラス</th><th scope="col">対象</th><th scope="col">作成者</th><th scope="col">操作</th></tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.diary_id}>
                  <td className="nowrap">{formatMDHM(d.updated_at)}</td>
                  <td className="nowrap">{formatMD(d.diary_date)}</td>
                  <td className="nowrap">{DIARY_RECORD_TYPE[d.record_type]}</td>
                  <td className="nowrap">{className(d.class_id)}</td>
                  <td>{d.child_id ? childName(d.child_id) : '―'}</td>
                  <td className="nowrap">{staffName(d.created_staff_id)}</td>
                  <td className="nowrap">
                    <Link className="btn btn-sm btn-primary" to={`/staff/admin/approval/${d.diary_id}`}>承認へ</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
