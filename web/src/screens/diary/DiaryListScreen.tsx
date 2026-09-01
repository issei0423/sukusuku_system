/*
 * 日誌一覧画面
 * 典拠：図/画面詳細図.md「日誌一覧画面」(3-1)
 *
 * 状態を列として持つ（下書き／申請中／差し戻し／承認済）。差し戻しは他と区別できる色にする。
 * 一般（保育士）の既定の絞り込みは自クラス。他クラスは選べない。
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses, childName, className, staffName } from '../../api/client';
import { Loading, ErrorBox, Empty, Pager, Field, Tag } from '../../components/ui';
import { DIARY_RECORD_TYPE, DIARY_STATUS, DIARY_STATUS_CLASS } from '../../api/codes';
import { formatMD, today, addDays } from '../../api/util';
import type { DiaryRecordType, DiaryStatus } from '../../api/types';

export default function DiaryListScreen() {
  const { user } = useSession();
  const [params] = useSearchParams();
  const classesForUser = selectableClasses(user!);

  const [recordType, setRecordType] = useState<DiaryRecordType | ''>('');
  // 一般の既定は自クラス。管理者は「すべて」から始める
  const [classId, setClassId] = useState<number | ''>(user!.role === '2' ? (user!.class_id ?? '') : '');
  const [status, setStatus] = useState<DiaryStatus | ''>((params.get('status') as DiaryStatus) ?? '');
  const [from, setFrom] = useState(addDays(today(), -31));
  const [to, setTo] = useState(today());
  const [page, setPage] = useState(1);
  const [applied, setApplied] = useState(0);

  const { data, error, loading } = useAsync(
    () => api.listDiaries(user!, { recordType, classId, status, from, to, page }),
    [user?.account_id, page, applied],
  );

  const search = () => { setPage(1); setApplied((n) => n + 1); };

  return (
    <div>
      <div className="page-head">
        <h1>日誌</h1>
        <div className="spacer" />
        <Link className="btn btn-primary" to="/staff/diary/new">＋ 新しく書く</Link>
      </div>

      <section className="card">
        <div className="filterbar">
          <Field label="種別">
            <select value={recordType} onChange={(e) => setRecordType(e.target.value as DiaryRecordType | '')}>
              <option value="">すべて</option>
              {Object.entries(DIARY_RECORD_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="クラス">
            <select value={classId} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : '')}
              disabled={user!.role === '2'}>
              {user!.role !== '2' && <option value="">すべて</option>}
              {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
            </select>
          </Field>
          <Field label="状態">
            <select value={status} onChange={(e) => setStatus(e.target.value as DiaryStatus | '')}>
              <option value="">すべて</option>
              {Object.entries(DIARY_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="期間（開始）"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="期間（終了）"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <button onClick={search}>絞り込む</button>
        </div>
        {user!.role === '2' && (
          <div className="muted" style={{ marginTop: 8 }}>
            担当するクラスの日誌のみ表示しています。
          </div>
        )}
      </section>

      <section className="card">
        {loading && <Loading />}
        {error && <ErrorBox text={error} />}
        {data && data.rows.length === 0 && <Empty text="該当する日誌はありません。" />}
        {data && data.rows.length > 0 && (
          <>
            <table className="list">
              <thead>
                <tr>
                  <th>記録日</th><th>種別</th><th>対象</th><th>作成者</th><th>状態</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((d) => (
                  <tr key={d.diary_id}>
                    <td className="nowrap">{formatMD(d.diary_date)}</td>
                    <td className="nowrap">{DIARY_RECORD_TYPE[d.record_type]}</td>
                    <td>{d.child_id ? childName(d.child_id) : className(d.class_id)}</td>
                    <td className="nowrap">{staffName(d.created_staff_id)}</td>
                    <td className="nowrap"><Tag label={DIARY_STATUS[d.status]} className={DIARY_STATUS_CLASS[d.status]} /></td>
                    <td className="nowrap"><Link className="btn btn-sm" to={`/staff/diary/${d.diary_id}`}>開く</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={data.page} perPage={data.per_page} total={data.total} onChange={setPage} />
          </>
        )}
      </section>
    </div>
  );
}
