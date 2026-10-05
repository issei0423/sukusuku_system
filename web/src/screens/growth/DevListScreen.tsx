/*
 * 発達チェック一覧画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)
 *      「クラス単位で園児と次回予定日・未実施を表示。チェック漏れを強調する」
 *
 * チェック漏れの対象になるのは未入力のみ。「未確認」は結果として保持された状態であり、
 * 漏れではない（基本設計書 5-7）。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Tag } from '../../components/ui';
import { formatYMD, formatAge, today } from '../../api/util';

export default function DevListScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);
  const [classId, setClassId] = useState<number>(user!.class_id ?? classesForUser[0]?.class_id ?? 1);

  const { data, error, loading } = useAsync(() => api.list(user!, classId), [classId]);
  const overdue = data?.filter((r) => r.overdue) ?? [];

  return (
    <div>
      <div className="page-head">
        <h1>発達チェック</h1>
        <Field label="クラス">
          <select value={classId} onChange={(e) => setClassId(Number(e.target.value))}>
            {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
          </select>
        </Field>
        <div className="spacer" />
        <Link className="btn btn-sm" to="/staff/growth/physical">身体記録へ</Link>
        {user!.role === '1' && <Link className="btn btn-sm" to="/staff/growth/schedule">スケジュール設定</Link>}
        {/*
          共有範囲の設定も管理者だけの操作であり、スケジュール設定と並べて置く
          （図/画面遷移図.md「発達チェック・身体測定」(6)）
        */}
        {user!.role === '1' && <Link className="btn btn-sm" to="/staff/growth/share">共有範囲の設定</Link>}
      </div>

      {/* チェック漏れを強調する */}
      {overdue.length > 0 && (
        <section className="card" style={{ borderColor: 'var(--c-alert)' }}>
          <div className="alert">
            <span>(!)</span>
            <span>
              予定日を過ぎて未実施の園児が {overdue.length} 名います：
              {overdue.map((r) => r.child.child_name).join('、')}
            </span>
          </div>
        </section>
      )}

      <section className="card">
        {loading && <Loading />}
        {error && <ErrorBox text={error} />}
        {data?.length === 0 && <Empty text="対象の園児がいません。" />}
        {data && data.length > 0 && (
          <table className="list">
            <thead>
              <tr><th>園児</th><th>月齢</th><th>前回の実施日</th><th>次回の予定日</th><th>状態</th><th></th></tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.child.child_id}>
                  <td className="nowrap">{r.child.child_name}</td>
                  {/* 月齢は基準日を予定日として算出する。現在日ではない（基本設計書 4-8） */}
                  <td className="nowrap">{formatAge(r.child.birth_date, r.scheduledOn ?? today())}</td>
                  <td className="nowrap">{r.lastCheckedOn ? formatYMD(r.lastCheckedOn) : '―'}</td>
                  <td className="nowrap">{r.scheduledOn ? formatYMD(r.scheduledOn) : '―'}</td>
                  <td className="nowrap">
                    {r.overdue
                      ? <Tag label="未実施" className="tag-returned" />
                      : <Tag label="予定どおり" className="tag-plain" />}
                    {/* 未入力はチェック漏れの対象。未確認は含めない（基本設計書 5-7） */}
                    {r.unfilled > 0 && <> <Tag label={`未入力 ${r.unfilled} 件`} className="tag-returned" /></>}
                  </td>
                  <td className="nowrap">
                    <Link className="btn btn-sm btn-primary" to={`/staff/growth/dev/${r.child.child_id}`}>入力</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          「未実施」は、予定日を過ぎても記録が1件も入っていない状態を指します。
          記録の中の「未確認」は入力済みの結果であり、未実施には含みません（基本設計書 5-7）。
          「未入力」は、前回の確定した記録に結果を入れていない項目が残っている状態を指します。
          <br />
          本機能は発達の判定・診断を行うものではありません。
        </div>
      </section>
    </div>
  );
}
