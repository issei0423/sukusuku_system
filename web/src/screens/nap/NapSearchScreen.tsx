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
import { notify } from '../../components/feedback';
import { BODY_POSITION, BREATHING, COMPLEXION } from '../../api/codes';
import { formatMD, formatHM, formatMDHM, today, addDays } from '../../api/util';

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

  const [rangeError, setRangeError] = useState<string | null>(null);
  const search = () => {
    if (from && to && from > to) { setRangeError('期間の開始は、終了より後の日にできません'); return; }
    setRangeError(null); setPage(1); setApplied((n) => n + 1);
  };

  /*
   * 同じ期間の異常時の記録。チェックの記録と別の画面にあると、同じ時刻の出来事を
   * 2つの画面を行き来して突き合わせることになる（GitHub Issue #117）。
   * 絞り込みを押した時点の期間・園児名で並べる。
   */
  const abnormals = useAsync(async () => {
    const all = await api.abnormals(user!);
    return all
      .filter((a) => a.found_at.slice(0, 10) >= from && a.found_at.slice(0, 10) <= to)
      .filter((a) => !childNameQ.trim() || a.child_name.includes(childNameQ.trim()))
      .sort((a, b) => b.found_at.localeCompare(a.found_at));
  }, [user?.account_id, applied]);

  const [exportError, setExportError] = useState<string | null>(null);
  const exportCsv = async () => {
    if (!data) return;
    // 出力したことを先に操作ログへ残す。残せなかったときは出力しない
    try {
      await api.recordExport(user!, 'nap_record', from, to, data.rows.length);
    } catch (e) {
      setExportError((e as Error).message);
      return;
    }
    setExportError(null);
    const header = ['日付', 'チェック時刻', '園児', 'クラス', '体位', '呼吸', '顔色', '体温', '記録者', '保存時刻'];
    const lines = data.rows.map((r) => [
      r.session_date, r.checked_at, r.child_name, r.class_name,
      BODY_POSITION[r.body_position], BREATHING[r.breathing], COMPLEXION[r.complexion],
      r.temperature ?? '', r.staff_name, r.saved_at,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([`\uFEFF${[header.join(','), ...lines].join('\n')}`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `午睡記録_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    notify('午睡記録を CSV で出力しました。出力したことは操作ログに残ります');
  };

  return (
    <div>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/nap">&lt; 午睡チェックへ</Link>
        <h1>午睡記録の検索</h1>
        <div className="spacer" />
        <button onClick={exportCsv} disabled={!data || data.rows.length === 0}>CSV出力</button>
      </div>

      {exportError && <section className="card"><ErrorBox text={exportError} /></section>}

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
        {rangeError && <ErrorBox text={rangeError} />}
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
                  <th scope="col">日付</th><th scope="col">チェック時刻</th><th scope="col">園児</th><th scope="col">クラス</th>
                  <th scope="col">体位</th><th scope="col">呼吸</th><th scope="col">顔色</th><th scope="col">体温</th><th scope="col">記録者</th><th scope="col">保存時刻</th>
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

      <section className="card">
        <div className="page-head" style={{ marginBottom: 12 }}>
          <h2>同じ期間の異常時の記録</h2>
          <div className="spacer" />
          <Link className="btn btn-sm" to="/staff/nap/abnormal">異常時の記録へ</Link>
        </div>
        {abnormals.loading && <Loading />}
        {abnormals.error && <ErrorBox text={abnormals.error} />}
        {abnormals.data?.length === 0 && <Empty text="この期間の異常時の記録はありません。" />}
        {abnormals.data && abnormals.data.length > 0 && (
          <table className="list">
            <thead>
              <tr><th>発見時刻</th><th>園児</th><th>状況</th><th>対応</th><th>記録者</th><th>ヒヤリハット</th></tr>
            </thead>
            <tbody>
              {abnormals.data.map((a) => (
                <tr key={a.nap_abnormal_id}>
                  <td className="nowrap">{formatMDHM(a.found_at)}</td>
                  <td className="nowrap">{a.child_name}</td>
                  <td>{a.situation}</td>
                  <td>{a.response}</td>
                  <td className="nowrap">{a.staff_name}</td>
                  <td className="nowrap">{a.diary_id ? '起票済み' : '未起票'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          CSV 出力は、いま表示しているページの行を出します。出力したことは操作ログに残ります。
          <br />
          午睡の記録は削除できません。誤りは修正の履歴として残ります
          （基本設計書「記録の修正と改ざん防止」(4-7)）。
          チェック時刻と保存時刻が離れている行は、後からまとめて入力された記録です。
        </div>
      </section>
    </div>
  );
}
