/*
 * 午睡記録検索画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)「日付・園児名・クラスでの検索と履歴の閲覧」
 *
 * 記録の修正と改ざん防止（同「記録の修正と改ざん防止」(4-7)）に従い、この画面からは記録を消せない。
 * チェック時刻と保存時刻の両方を出し、後から入れた記録が分かるようにする（基本設計書 5-6）。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Pager } from '../../components/ui';
import { BODY_POSITION, BREATHING, COMPLEXION } from '../../api/codes';
import { formatMD, formatHM, today, addDays } from '../../api/util';

export default function NapSearchScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);

  const [from, setFrom] = useState(addDays(today(), -7));
  const [to, setTo] = useState(today());
  const [classId, setClassId] = useState<number | ''>(user!.role === '2' ? (user!.class_id ?? '') : '');
  const [childNameQ, setChildNameQ] = useState('');
  const [page, setPage] = useState(1);
  const [applied, setApplied] = useState(0);

  const { data, error, loading } = useAsync(
    () => api.searchRecords(user!, { from, to, classId, childName: childNameQ, page }),
    [user?.account_id, page, applied],
  );

  const search = () => { setPage(1); setApplied((n) => n + 1); };

  return (
    <div>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/nap">&lt; 午睡チェックへ</Link>
        <h1>午睡記録の検索</h1>
      </div>

      <section className="card">
        <div className="filterbar">
          <Field label="期間（開始）"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="期間（終了）"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="クラス">
            <select value={classId} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : '')}
              disabled={user!.role === '2'}>
              {user!.role !== '2' && <option value="">すべて</option>}
              {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
            </select>
          </Field>
          <Field label="園児名">
            <input type="search" value={childNameQ} onChange={(e) => setChildNameQ(e.target.value)} />
          </Field>
          <button onClick={search}>絞り込む</button>
        </div>
      </section>

      <section className="card">
        {loading && <Loading />}
        {error && <ErrorBox text={error} />}
        {data?.rows.length === 0 && <Empty text="該当する記録はありません。" />}
        {data && data.rows.length > 0 && (
          <>
            <table className="list">
              <thead>
                <tr>
                  <th>日付</th><th>チェック時刻</th><th>園児</th><th>クラス</th>
                  <th>体位</th><th>呼吸</th><th>顔色</th><th>体温</th><th>記録者</th><th>保存時刻</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.nap_record_id}>
                    <td className="nowrap">{formatMD(r.session_date)}</td>
                    <td className="nowrap">{formatHM(r.checked_at)}</td>
                    <td className="nowrap">{r.child_name}</td>
                    <td className="nowrap">{r.class_name}</td>
                    <td className="nowrap">
                      {/* うつ伏せは目を引く色で示す。判定ではなく、見落とさないための表示 */}
                      <span className={r.body_position === '2' ? 'tag tag-returned' : ''}>
                        {BODY_POSITION[r.body_position]}
                      </span>
                    </td>
                    <td className="nowrap">{BREATHING[r.breathing]}</td>
                    <td className="nowrap">{COMPLEXION[r.complexion]}</td>
                    <td className="num nowrap">{r.temperature ?? '―'}</td>
                    <td className="nowrap">{r.staff_name}</td>
                    <td className="nowrap weak">{formatHM(r.saved_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={data.page} perPage={data.per_page} total={data.total} onChange={setPage} />
          </>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          午睡の記録は削除できません。誤りは修正の履歴として残ります
          （基本設計書「記録の修正と改ざん防止」(4-7)）。
          チェック時刻と保存時刻が離れている行は、後からまとめて入力された記録です。
        </div>
      </section>
    </div>
  );
}
