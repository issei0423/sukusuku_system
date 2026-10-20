/*
 * 午睡記録検索画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)「日付・園児名・クラスでの検索と履歴の閲覧」
 *
 * 記録の修正と改ざん防止（同「記録の修正と改ざん防止」(4-7)）に従い、この画面からは記録を消せない。
 * チェック時刻と保存時刻の両方を出し、後から入れた記録が分かるようにする（基本設計書 5-6）。
 * 園児ごとの入眠（ねた）と起床（おきた）、きょうは対象外とその理由を同じ一覧の行として並べ、ねたの行に入眠時の体温を出す
 * （画面詳細図「午睡記録検索画面」(5-3) の項目6・9、基本設計書「帳票の出力」(4-8)）。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Pager } from '../../components/ui';
import { notify } from '../../components/feedback';
import { downloadCsvText } from '../../csv';
import { BODY_POSITION, BREATHING, COMPLEXION } from '../../api/codes';
import type { NapSearchRow } from '../../api/shapes';
import { rowLabel, rowTemperature } from './napReport';
import { formatMD, formatHM, formatMDHM, today, addDays } from '../../api/util';

export default function NapSearchScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);

  // 期間の初期値は直近1か月（開始＝当日の30日前、終了＝当日）。画面詳細図「午睡記録検索画面」(5-3) の項目1、
  // 基本設計書「入力項目の制約値」(4-12) の検索の期間（第1.x版は直近1週間）
  const [from, setFrom] = useState(addDays(today(), -30));
  const [to, setTo] = useState(today());
  const [classId, setClassId] = useState<number | ''>(user!.role === '2' ? (user!.class_id ?? '') : '');
  const [childNameQ, setChildNameQ] = useState('');
  const [page, setPage] = useState(1);

  /*
   * 「絞り込む」を押した時点の条件。一覧・ページの切り替え・同じ期間の異常時の記録・CSV 出力の
   * ファイル名と操作ログは、すべてこの条件で作る。入力欄を変えただけでは使わない。
   * 出力の中身と、ファイル名・操作ログの期間を食い違わせないため（基本設計書「操作ログ」(5-8)、GitHub Issue #165）
   */
  const [applied, setApplied] = useState({ from, to, classId, childName: childNameQ });

  const { data, error, loading } = useAsync(
    () => api.searchRecords(user!, { ...applied, page }),
    [user?.account_id, page, applied],
  );

  const [rangeError, setRangeError] = useState<string | null>(null);
  const search = () => {
    if (from && to && from > to) { setRangeError('期間の開始は、終了より後の日にできません'); return; }
    setRangeError(null); setPage(1); setApplied({ from, to, classId, childName: childNameQ });
  };

  /*
   * 同じ期間の異常時の記録。チェックの記録と別の画面にあると、同じ時刻の出来事を
   * 2つの画面を行き来して突き合わせることになる（GitHub Issue #117）。
   * 絞り込みを押した時点の期間・園児名で並べる。
   */
  const abnormals = useAsync(async () => {
    const all = await api.abnormals(user!);
    const name = applied.childName.trim();
    return all
      .filter((a) => (!applied.from || a.found_at.slice(0, 10) >= applied.from)
        && (!applied.to || a.found_at.slice(0, 10) <= applied.to))
      .filter((a) => !name || a.child_name.includes(name))
      .sort((a, b) => b.found_at.localeCompare(a.found_at));
  }, [user?.account_id, applied]);

  /*
   * 帳票（CSV）は管理者だけが出せる。一般（保育士）にはボタンを出さない（画面詳細図「午睡記録検索画面」(5-3) の
   * 項目9・10「出力できるのは管理者のみ」）。権限の担保はサーバ（GET /api/nap/report の requireAdmin）で行う。
   * 帳票はサーバで作る。「絞り込む」を押した時点の期間・クラスで、その期間の全件を出す（いまのページの行だけではない）。
   * 出力したことと、期間・件数はサーバが操作ログへ記録する（基本設計書「帳票の出力」(4-8)）
   */
  const canExport = user!.role === '1';
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    const { from: outFrom, to: outTo, classId: outClass } = applied;
    setExporting(true);
    try {
      const text = await api.napReport(user!, { from: outFrom, to: outTo, classId: outClass, format: 'csv' });
      setExportError(null);
      downloadCsvText(`午睡記録_${outFrom}_${outTo}.csv`, text);
      notify('午睡記録を CSV で出力しました。出力したことは操作ログに残ります');
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/nap">&lt; 午睡チェックへ</Link>
        <h1>午睡記録の検索</h1>
        <div className="spacer" />
        {canExport && <button onClick={exportCsv} disabled={exporting}>CSV出力</button>}
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
                {data.rows.map((r) => <SearchRow key={`${r.kind}-${r.nap_record_id ?? r.nap_sleep_id ?? r.nap_exclusion_id}`} r={r} />)}
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
          {/*
            【仮置き】帳票の範囲・並び・起票したものの出し方の説明（web/仮置き値.md「午睡の帳票」）。一般には出さない。
            並びは画面の一覧（新しい順）と違うため、戸惑わないように書く（server/api_nap_report.go の sortNapReportLines）
          */}
          {canExport && (
            <>
              CSV 出力は、絞り込んだ期間とクラスの記録（ねた・おきた・きょうは対象外を含む）と、同じ期間の異常時の記録を、
              ページに分けずにすべて出します。園児名では絞りません。
              CSV は、日付・クラス・園児ごとに時刻の古い順に並べます（この画面の一覧は新しい順です）。
              ヒヤリハットを起票した記録は、ヒヤリハットに書いた状況・対応を出します。出力したことは操作ログに残ります。
              <br />
            </>
          )}
          {/* 記録は削除させず、誤りは修正の履歴で残す（基本設計書「記録の修正と改ざん防止」(4-7)） */}
          午睡の記録は削除できません。誤りは修正の履歴として残ります。
          チェック時刻と保存時刻が離れている行は、後からまとめて入力された記録です。
        </div>
      </section>
    </div>
  );
}

/**
 * 一覧の1行。確認の行は体位・呼吸・顔色・体温・保存時刻を出す。
 * ねた・おきた・きょうは対象外の行は、押した時刻と、体位・呼吸・顔色の3列をまとめた「入眠（ねた）」「起床（おきた）」
 * 「きょうは対象外（欠席）」などを出し、ねたの行の体温の列に入眠時の体温を出す（画面詳細図「午睡記録検索画面」(5-3) の項目6）。
 * 名前は帳票の体位の列と同じ。
 * 【仮置き】3列をまとめて名前を出す形と、ねた・おきた・対象外の保存時刻を「―」にすること（web/仮置き値.md）。
 * ねた・おきた・対象外は押した時刻をサーバが記録しており、チェックした時刻と保存時刻を分けて持たない
 */
function SearchRow({ r }: { r: NapSearchRow }) {
  const temperature = rowTemperature(r);
  return (
    <tr>
      <td className="nowrap">{formatMD(r.session_date)}</td>
      <td className="nowrap">{formatHM(r.checked_at)}</td>
      <td className="nowrap">{r.child_name}</td>
      <td className="nowrap">{r.class_name}</td>
      {r.kind === 'check' ? (
        <>
          <td className="nowrap">
            {/* うつ伏せは目を引く色で示す。判定ではなく、見落とさないための表示 */}
            <span className={r.body_position === '2' ? 'tag tag-returned' : ''}>
              {r.body_position ? BODY_POSITION[r.body_position] : '―'}
            </span>
          </td>
          <td className="nowrap">{r.breathing ? BREATHING[r.breathing] : '―'}</td>
          <td className="nowrap">{r.complexion ? COMPLEXION[r.complexion] : '―'}</td>
        </>
      ) : (
        <td className="nowrap" colSpan={3}>{rowLabel(r)}</td>
      )}
      <td className="num nowrap">{temperature ?? '―'}</td>
      <td className="nowrap">{r.staff_name}</td>
      <td className="nowrap weak">{r.saved_at ? formatHM(r.saved_at) : '―'}</td>
    </tr>
  );
}
