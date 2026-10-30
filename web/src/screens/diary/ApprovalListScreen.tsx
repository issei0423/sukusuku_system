/*
 * 承認待ち一覧画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)「申請日・クラス・作成者とともに一覧表示」、
 *      詳細設計書.md「日誌の画面（作り直し）」(2-13 (1))
 *
 * 列は「申請者」（作成者ではなく、申請した職員）。並びは申請日時の古い順（サーバとモックが並べて返す）。
 * 自分が申請したものは承認できないため、「ほかの管理者へ」と示す（承認画面でも承認のボタンを押せない）。
 *
 * 経過の列は、申請からの日数。設定の日数（approval.warn_days。既定 3 日）を越えたものは、色に加えて「滞留」の文字を添える
 * （色だけに頼らない）。滞留を見つけるための表示であって、期限の判定ではない
 * （画面詳細図「承認待ち一覧画面」(3-4) 項目5、基本設計書「設定マスタ」(5-9)）。判定はサーバ・モックが行う。
 */
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api, childName, className, staffName } from '../../api/client';
import { Loading, ErrorBox, Empty, Tag } from '../../components/ui';
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
              <tr><th scope="col">申請日時</th><th scope="col">記録日</th><th scope="col">種別</th><th scope="col">クラス</th><th scope="col">対象</th><th scope="col">申請者</th><th scope="col">経過</th><th scope="col">操作</th></tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.diary_id}>
                  <td className="nowrap">{formatMDHM(d.applied_at ?? d.updated_at)}</td>
                  <td className="nowrap">{formatMD(d.diary_date)}</td>
                  <td className="nowrap">{DIARY_RECORD_TYPE[d.record_type]}</td>
                  <td className="nowrap">{className(d.class_id)}</td>
                  <td>
                    {d.child_id ? childName(d.child_id) : '―'}
                    {/* 承認すると保護者へ共有される個人日誌（server/api_diary_share.go） */}
                    {d.record_type === '1' && d.share_to_guardian && <> <Tag label="保護者へ共有" /></>}
                  </td>
                  <td className="nowrap">
                    {staffName(d.applied_staff_id)}
                    {d.applied_staff_id === user!.staff_id && <> <Tag label="ほかの管理者へ" /></>}
                  </td>
                  <td className="nowrap">
                    {d.elapsed_days} 日
                    {d.stale && <> <Tag label="滞留" className="tag-returned" /></>}
                  </td>
                  <td className="nowrap">
                    <Link className="btn btn-sm btn-primary" to={`/staff/admin/approval/${d.diary_id}`}>
                      {d.applied_staff_id === user!.staff_id ? '開く' : '承認へ'}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {data && data.length > 0 && (
        <section className="card card-sub">
          <div className="muted">
            経過は、申請した日からの日数です。{data[0].warn_days} 日を超えたものに「滞留」を付けています。
            期限ではなく、見落としに気づくための表示です。
          </div>
        </section>
      )}
    </div>
  );
}
