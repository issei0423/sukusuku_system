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
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Tag } from '../../components/ui';
import { formatYMD, formatAge, today } from '../../api/util';

export default function DevListScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);
  // 管理者は園全体の抜けを見る。最初から全クラスを出す（GitHub Issue #125）
  const isAdmin = user!.role === '1';
  const [classId, setClassId] = useState<number | 'all'>(
    isAdmin ? 'all' : (user!.class_id ?? classesForUser[0]?.class_id ?? 1));

  // ほかの職員の入力・確定、予定日の変更があったら、開いたままでも読み直す（live.ts）
  const { data, error, loading } = useAsync(async () => {
    if (classId !== 'all') return (await api.list(user!, classId)).map((r) => ({ ...r, className: '' }));
    const perClass = await Promise.all(classesForUser.map(async (c) =>
      (await api.list(user!, c.class_id)).map((r) => ({ ...r, className: c.class_name }))));
    return perClass.flat();
  }, [classId], { live: onLive('development') });
  const showClass = classId === 'all';
  const overdue = data?.filter((r) => r.overdue) ?? [];
  // 予定日が近い園児。設定の日数（dev.notice_days_before。既定 7 日）以内。判定はサーバ・モックが行う
  const near = data?.filter((r) => r.near) ?? [];

  return (
    <div>
      <div className="page-head">
        <h1>発達チェック</h1>
        <Field label="クラス">
          <select value={classId}
            onChange={(e) => setClassId(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            {isAdmin && <option value="all">すべて</option>}
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

      {/* 予定日が近い園児の知らせ。「過ぎた」の知らせの下に置く（画面詳細図「発達チェック一覧画面」(6-1) 項目13）。
          近いだけで、まだ漏れではないので、警告の帯でなく知らせの帯（.alert-soft。札の「予定日が近い」の青と同じ扱い。r2c-02） */}
      {near.length > 0 && (
        <section className="card">
          <div className="alert alert-soft">
            <span>(!)</span>
            <span>
              予定日が近い園児が {near.length} 名います：
              {near.map((r) => r.child.child_name).join('、')}
            </span>
          </div>
        </section>
      )}

      <section className="card">
        {loading && <Loading />}
        {error && <ErrorBox text={error} />}
        {data?.length === 0 && <Empty text="対象の園児がいません。" />}
        {data && data.length > 0 && (
          <table className="list list-dense">
            <thead>
              <tr>
                <th scope="col">園児</th>{showClass && <th scope="col">クラス</th>}
                {/* 何の時点の月齢かを書く。画面によって基準が違い、食い違って見えるため（GitHub Issue #124） */}
                <th scope="col">月齢<span className="weak">（予定日の時点）</span></th>
                <th scope="col">前回の実施日</th><th scope="col">次回の予定日</th><th scope="col">状態</th><th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.child.child_id}>
                  <td className="nowrap">{r.child.child_name}</td>
                  {showClass && <td className="nowrap">{r.className}</td>}
                  {/* 月齢は基準日を予定日として算出する。現在日ではない（基本設計書 4-8） */}
                  <td className="nowrap">{formatAge(r.child.birth_date, r.scheduledOn ?? today())}</td>
                  <td className="nowrap">{r.lastCheckedOn ? formatYMD(r.lastCheckedOn) : '―'}</td>
                  <td className="nowrap">{r.scheduledOn ? formatYMD(r.scheduledOn) : '―'}</td>
                  <td className="nowrap">
                    {r.overdue
                      ? <Tag label="未実施" className="tag-alert" />
                      : r.near
                        ? <Tag label="予定日が近い" className="tag-applied" />
                        : <Tag label="予定どおり" className="tag-plain" />}
                    {/* 未入力はチェック漏れの対象。未確認は含めない（基本設計書 5-7） */}
                    {/* 未実施・未入力（チェック漏れ）は警告色の札（.tag-alert）。差し戻しの色は日誌の差し戻しだけ（r2c-02） */}
                    {r.unfilled > 0 && <> <Tag label={`未入力 ${r.unfilled} 件`} className="tag-alert" /></>}
                  </td>
                  <td className="nowrap">
                    {/* 行ごとにくり返す操作なので塗らず、トーナルにする（r2c-03） */}
                    <Link className="btn btn-sm btn-tonal" to={`/staff/growth/dev/${r.child.child_id}`}>入力</Link>
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
          記録の中の「未確認」は入力済みの結果であり、未実施には含みません。
          {/* 「未確認」は結果として保持する状態で、漏れではない（基本設計書「発達チェック・身体測定」(5-7)） */}
          {/* 下書きの保存していない項目も未入力に数える（要件定義書「チェック漏れの強調」(4-5-2)。GitHub Issue #143） */}
          「未入力」は、いちばん新しい記録（下書きを含む）に、結果を入れていない項目が残っている状態を指します。
          入力画面の「未入力の項目」と同じ数です。
          <br />
          月齢は、次回の予定日の時点で表示しています（予定日が無いときは今日の時点）。
          その時点の月齢でチェック項目が決まるためです。園児一覧の月齢は今日の時点です。
          <br />
          本機能は発達の判定・診断を行うものではありません。
        </div>
      </section>
    </div>
  );
}
