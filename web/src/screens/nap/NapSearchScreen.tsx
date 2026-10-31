/*
 * 午睡記録検索画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)「日付・園児名・クラスでの検索と履歴の閲覧」
 *
 * 記録の修正と改ざん防止（同「記録の修正と改ざん防止」(4-7)）に従い、この画面からは記録を消せない。
 * チェック時刻と保存時刻の両方を出し、後から入れた記録が分かるようにする（基本設計書 5-6）。
 * 園児ごとの入眠（ねた）と起床（おきた）、きょうは対象外とその理由を同じ一覧の行として並べ、ねたの行に入眠時の体温を出す
 * （画面詳細図「午睡記録検索画面」(5-3) の項目6・9、基本設計書「帳票の出力」(4-8)）。
 * 確認の行は、直せる行にだけ「修正」を出し、同じ画面の中で直す。直した行には「修正あり」を出す（同 (5-3) の項目12、
 * 基本設計書「記録の修正と改ざん防止」(4-8)）。直せるかの判定と担保はサーバ（POST /api/nap/records/{id}/correct）。
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Pager } from '../../components/ui';
import { notify } from '../../components/feedback';
import { downloadCsvText } from '../../csv';
import { BODY_POSITION, BREATHING, COMPLEXION } from '../../api/codes';
import type { NapSearchRow } from '../../api/shapes';
import type { BodyPosition, Breathing, Complexion } from '../../api/types';
import { rowLabel, rowTemperature } from './napReport';
import { formatMD, formatHM, formatMDHM, today, addDays } from '../../api/util';
import { BackIcon, DownloadIcon, SearchIcon } from '../../components/icons';

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

  const { data, error, loading, refresh } = useAsync(
    () => api.searchRecords(user!, { ...applied, page }),
    [user?.account_id, page, applied],
  );

  // いま修正を開いている記録（一度に1件）。閉じたら、その行の「修正」へ戻る
  const [editingId, setEditingId] = useState<number | null>(null);

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
        <Link className="btn btn-quiet btn-sm" to="/staff/nap"><BackIcon />午睡チェックへ</Link>
        <h1>午睡記録の検索</h1>
        <div className="spacer" />
        {canExport && <button onClick={exportCsv} disabled={exporting}><DownloadIcon />CSV出力</button>}
      </div>

      {exportError && <section className="card"><ErrorBox text={exportError} /></section>}

      <section className="card">
        <div className="filterbar">
          <Field label="期間（開始）"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="期間（終了）"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="クラス">
            {/* 担任は自分のクラスだけ。変えられない値なので、押せない入力欄の灰の箱にせず文字で見せる（.select-fixed。r2c-05） */}
            <select value={classId} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : '')}
              disabled={user!.role === '2'} className={user!.role === '2' ? 'select-fixed' : undefined}>
              {user!.role !== '2' && <option value="">すべて</option>}
              {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
            </select>
          </Field>
          <Field label="園児名">
            <input type="search" value={childNameQ} onChange={(e) => setChildNameQ(e.target.value)} />
          </Field>
          <button onClick={search}><SearchIcon />絞り込む</button>
        </div>
        {rangeError && <ErrorBox text={rangeError} />}
      </section>

      <section className="card">
        {loading && <Loading />}
        {error && <ErrorBox text={error} />}
        {data?.rows.length === 0 && <Empty text="該当する記録はありません。" />}
        {data && data.rows.length > 0 && (
          <>
            <table className="list list-dense">
              <thead>
                <tr>
                  <th scope="col">日付</th><th scope="col">チェック時刻</th><th scope="col">園児</th><th scope="col">クラス</th>
                  <th scope="col">体位</th><th scope="col">呼吸</th><th scope="col">顔色</th><th scope="col">体温</th><th scope="col">記録者</th><th scope="col">保存時刻</th>
                  <th scope="col">修正</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <SearchRow
                    key={`${r.kind}-${r.nap_record_id ?? r.nap_sleep_id ?? r.nap_exclusion_id}`} r={r}
                    editing={r.kind === 'check' && r.nap_record_id === editingId}
                    onEdit={() => setEditingId(r.nap_record_id)}
                    onClose={(changed) => { setEditingId(null); if (changed) refresh(); }}
                  />
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
          <table className="list list-dense">
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
                  {/* 【仮置き】ヒヤリハットが下書きのまま（申請していない）なら「起票済み（下書き）」（web/仮置き値.md。GitHub Issue #142 の 5） */}
                  <td className="nowrap">{!a.diary_id ? '未起票' : a.diary_draft ? '起票済み（下書き）' : '起票済み'}</td>
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
          {/* 【仮置き】一般に、直せる記録の範囲を知らせる（web/仮置き値.md「午睡チェックの記録の修正」。基本設計書「記録の修正と改ざん防止」(4-8)） */}
          {user!.role === '2' && (
            <>
              <br />
              修正できるのは、自分のクラスの子の、その日の記録です。前の日までの記録と、異常時の記録がある子の記録は、管理者が修正します。
            </>
          )}
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
 * ねた・おきた・対象外は押した時刻をサーバが記録しており、チェックした時刻と保存時刻を分けて持たない。
 * 確認の行の最後の列に、直した記録の「修正あり」と、直せる行にだけ「修正」を出す（画面詳細図「午睡記録検索画面」(5-3) の項目6・12）。
 * 「修正」を押すと、その行のすぐ下に修正の欄を開く（同じ画面の中で直す）
 */
function SearchRow({ r, editing, onEdit, onClose }: {
  r: NapSearchRow; editing: boolean; onEdit: () => void; onClose: (changed: boolean) => void;
}) {
  const temperature = rowTemperature(r);
  // 修正の欄を閉じたら、この行の「修正」へ戻す（キーボードで操作しているときに、どこにいたかを見失わないように）
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  return (
    <>
    <tr>
      <td className="nowrap">{formatMD(r.session_date)}</td>
      <td className="nowrap">{formatHM(r.checked_at)}</td>
      <td className="nowrap">{r.child_name}</td>
      <td className="nowrap">{r.class_name}</td>
      {r.kind === 'check' ? (
        <>
          <td className="nowrap">
            {/* うつ伏せは目を引く色で示す。判定ではなく、見落とさないための表示 */}
            <span className={r.body_position === '2' ? 'tag tag-alert' : ''}>
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
      <td className="nowrap">
        <div className="row">
          {r.kind === 'check' && r.corrected_at && <span className="tag tag-plain">修正あり</span>}
          {r.kind === 'check' && r.can_correct && !editing && (
            <button ref={editButton} type="button" className="btn-sm btn-quiet" onClick={onEdit}
              aria-label={`${r.child_name}の${formatHM(r.checked_at)}の記録を修正`}>
              修正
            </button>
          )}
        </div>
      </td>
    </tr>
    {editing && r.nap_record_id !== null && (
      <tr>
        <td colSpan={11}><CorrectForm r={r} recordId={r.nap_record_id} onClose={onClose} /></td>
      </tr>
    )}
    </>
  );
}

/**
 * 午睡チェックの記録の修正の欄（画面詳細図「午睡記録検索画面」(5-3) の項目12）。体位・呼吸・顔色・体温を書き換え、理由（必須・
 * 500文字以内）を入れる。チェックした時刻・保存時刻・記録した職員は変えない。行を書き換え、修正前の値と理由は操作ログへ
 * 残る（基本設計書「記録の修正と改ざん防止」(4-8)）。削除はできない。
 * 規則（直せる人・理由・値）の担保はサーバ（POST /api/nap/records/{id}/correct）。画面は断られた文言をそのまま出す
 */
function CorrectForm({ r, recordId, onClose }: {
  r: NapSearchRow; recordId: number; onClose: (changed: boolean) => void;
}) {
  const { user } = useSession();
  const [bodyPosition, setBodyPosition] = useState<BodyPosition>(r.body_position ?? '1');
  const [breathing, setBreathing] = useState<Breathing>(r.breathing ?? '1');
  const [complexion, setComplexion] = useState<Complexion>(r.complexion ?? '1');
  const [temperature, setTemperature] = useState(r.temperature === null ? '' : r.temperature.toFixed(1));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 開いたら、最初の項目（体位）へ移る
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => { first.current?.focus(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = temperature.trim();
    const temp = t === '' ? null : Number(t);
    if (temp !== null && Number.isNaN(temp)) { setErr('体温は小数第1位までで入力してください'); return; }
    setSaving(true);
    try {
      await api.correctNapRecord(user!, recordId, { body_position: bodyPosition, breathing, complexion, temperature: temp, reason });
      notify('午睡の記録を修正しました。修正前の値と理由は、修正の履歴に残ります');
      onClose(true);
    } catch (ex) {
      setErr((ex as Error).message);
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label={`${r.child_name}の${formatMDHM(r.checked_at)}の記録の修正`}>
      <div className="filterbar">
        <Field label="体位">
          <select ref={first} value={bodyPosition} onChange={(e) => setBodyPosition(e.target.value as BodyPosition)}>
            {Object.entries(BODY_POSITION).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="呼吸">
          <select value={breathing} onChange={(e) => setBreathing(e.target.value as Breathing)}>
            {Object.entries(BREATHING).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="顔色">
          <select value={complexion} onChange={(e) => setComplexion(e.target.value as Complexion)}>
            {Object.entries(COMPLEXION).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="体温（℃）">
          <input type="number" step="0.1" inputMode="decimal" value={temperature}
            onChange={(e) => setTemperature(e.target.value)} />
        </Field>
      </div>
      <Field label="修正の理由" required>
        <textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {/* 【仮置き】修正の欄の説明（web/仮置き値.md「午睡チェックの記録の修正」） */}
      <p className="muted">
        チェックした時刻・保存時刻・記録した職員は変わりません。体温を消すときは空にします。
        修正前の値と理由は、修正の履歴に残ります。
      </p>
      {err && <ErrorBox text={err} />}
      <div className="row">
        <button type="submit" className="btn-primary" disabled={saving}>修正する</button>
        <button type="button" className="btn-quiet" onClick={() => onClose(false)}>やめる</button>
      </div>
    </form>
  );
}
