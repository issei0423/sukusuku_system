/*
 * 異常時記録画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)「発見時刻・状況・とった対応の記録。ヒヤリハットの起票の導線を置く」
 *      基本設計書.md「異常時の記録」(4-7)、5-6 t_nap_abnormal
 *
 * diary_id が空なら「記録したがヒヤリハットを起票していない」状態として一覧で示す。
 * 起票したヒヤリハットが下書きのまま（申請していない）なら、そうと分かるように示す（diary_draft。GitHub Issue #142 の 5）。
 * 申請すると表示が変わるよう、日誌の知らせ（diary）でも読み直す。
 *
 * 記録は、選んだ園児のクラスの、実施中の午睡チェックにつなぐ。記録の操作で午睡チェックを開始しない
 * （基本設計書「午睡チェックの実施」(4-7)。GitHub Issue #158）。
 * 【仮置き】実施中の午睡チェックが無いときは記録できない（web/仮置き値.md）。
 *
 * 保護者への連絡（画面詳細図「異常時記録画面」(5-2) 項目13）は任意で、未記入のまま記録してよい。
 * 連絡の要否はシステムが判断しない。午睡中の異常は電話で伝え（段4）、連絡帳・個人チャットは電話のあとに
 * 経過を書く手段である（PR #216 の版の項目13。基本設計書「異常時の記録」(4-8)）。
 *
 * 記録の一覧の、直せる行にだけ「修正」を出し、同じ画面の中で発見時刻・状況・とった対応を直す。直した行には「修正あり」を出す
 * （画面詳細図「異常時記録画面」(5-2) の項目17、基本設計書「記録の修正と改ざん防止」(4-8)）。
 * 直せるかの判定と担保はサーバ（POST /api/nap/abnormals/{id}/correct）。保存した記録は削除できない。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api, visibleChildren } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Radios } from '../../components/ui';
import { notify } from '../../components/feedback';
import { formatMDHM, now, today } from '../../api/util';
import { GUARDIAN_NOTICE, GUARDIAN_NOTICE_METHOD, GUARDIAN_NOTICE_METHOD_ORDER } from '../../api/codes';
import type { GuardianNotice, GuardianNoticeMethod } from '../../api/types';
import type { NapAbnormalRow } from '../../api/shapes';
import { BackIcon, SaveIcon } from '../../components/icons';

export default function NapAbnormalScreen() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [tick, setTick] = useState(0);

  // ほかの職員の記録・起票があったら、開いたままでも読み直す（live.ts）
  const list = useAsync(() => api.abnormals(user!), [user?.account_id, tick], { live: onLive('nap', 'diary') });
  const children = visibleChildren(user!);

  /*
   * 午睡チェック画面の園児カードから移ったときは、その園児を選んだ状態で開く（画面詳細図 5-2 項目2
   * 「初期値：午睡チェック画面で選んでいた園児」。GitHub Issue #142）。状況の初期値は空のまま（同 項目5）。
   * 午睡チェックで記録した内容は、書くときの手がかりとして添えるだけにする
   */
  const from = (useLocation().state ?? null) as { childId?: string; observed?: string } | null;
  const [childId, setChildId] = useState(
    from?.childId && children.some((c) => c.child_id === from.childId) ? from.childId : '');
  const [observed, setObserved] = useState(from?.observed ?? null);
  const [foundAt, setFoundAt] = useState(now().slice(0, 16));
  const [situation, setSituation] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 保護者への連絡。null は未記入
  const [notice, setNotice] = useState<GuardianNotice | null>(null);
  const [noticedAt, setNoticedAt] = useState('');
  const [method, setMethod] = useState<GuardianNoticeMethod | ''>('');
  const [person, setPerson] = useState('');
  const noticeIncomplete = notice === '1' && (!noticedAt || !method || !person.trim());
  // いま修正を開いている記録（一度に1件）。閉じたら、その行の「修正」へ戻る
  const [editingId, setEditingId] = useState<number | null>(null);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      // 園児のクラスの、実施中の午睡チェックを探す。無ければ記録しない（午睡チェックを勝手に開始しない）
      const classId = await api.classOf(user!, childId);
      const session = classId != null ? await api.activeSession(classId, today(), user!) : null;
      if (!session) {
        setError('この園児のクラスで実施中の午睡チェックがありません。午睡チェック画面で開始してから記録してください');
        return;
      }
      await api.recordAbnormal(user!, session.nap_session_id, {
        child_id: childId, found_at: `${foundAt}:00`, situation, response,
        guardian_notice: notice ?? '', guardian_noticed_at: noticedAt ? `${noticedAt}:00` : '',
        guardian_notice_method: method, guardian_notice_person: person,
      });
      setChildId(''); setSituation(''); setResponse(''); setObserved(null);
      setTick((n) => n + 1);
      setNotice(null); setNoticedAt(''); setMethod(''); setPerson('');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const raise = async (abnormalId: number) => {
    try {
      const d = await api.raiseIncidentDiary(user!, abnormalId);
      navigate(`/staff/diary/${d.diary_id}`);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/nap"><BackIcon />午睡チェックへ</Link>
        <h1>異常時の記録</h1>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      <section className="card">
        <h2>新しく記録する</h2>
        <div className="stack">
          <div className="row">
            <Field label="園児" required style={{ flex: 1 }}>
              <select value={childId} onChange={(e) => { setChildId(e.target.value); setObserved(null); }}>
                <option value="">選んでください</option>
                {children.map((c) => <option key={c.child_id} value={c.child_id}>{c.child_name}</option>)}
              </select>
            </Field>
            <Field label="発見時刻" required>
              {/* 未来の日時は選べない（基本設計書「入力項目の制約値」(4-9)。GitHub Issue #158） */}
              <input type="datetime-local" value={foundAt} max={now().slice(0, 16)}
                onChange={(e) => setFoundAt(e.target.value)} />
            </Field>
          </div>
          {observed && <div className="muted">{observed}</div>}
          <Field label="発見時の状況" required>
            <textarea value={situation} onChange={(e) => setSituation(e.target.value)} maxLength={1000}
              placeholder="体位・呼吸・顔色・体温など、見たままを書いてください" />
          </Field>
          <Field label="とった対応" required>
            <textarea value={response} onChange={(e) => setResponse(e.target.value)} maxLength={1000}
              placeholder="誰が何をしたかを書いてください。保護者への連絡は下の欄に残せます" />
          </Field>
          <Field label="保護者への連絡">
            <Radios name="guardianNotice" value={notice}
              options={[{ value: '1', label: GUARDIAN_NOTICE['1'] }, { value: '2', label: GUARDIAN_NOTICE['2'] }]}
              onChange={setNotice} />
          </Field>
          {/*
            * 連絡帳・個人チャットは、電話（段4）に代わる手段ではなく、電話のあとに経過を書く手段として示す。
            * 【仮置き】説明の文と「未記入に戻す」は設計が文を定めていない（web/仮置き値.md）
            */}
          <div className="muted">
            午睡中の異常は、電話で保護者へ伝えてください。連絡帳・個人チャットは、電話のあとに経過を書くときに使います。
            連絡が要るかどうかを、システムは判断しません。
            {notice !== null && (
              <> <button type="button" className="btn-quiet btn-sm" onClick={() => setNotice(null)}>未記入に戻す</button></>
            )}
          </div>
          {notice === '1' && (
            <div className="row">
              <Field label="連絡した日時" required>
                {/*
                  * 未来の日時は選べない（基本設計書「入力項目の制約値」(4-12)）。【仮置き】初期値は空。
                  * 【仮置き】発見時刻より前も選べない（サーバとモックも断る。web/仮置き値.md）
                  */}
                <input type="datetime-local" value={noticedAt} min={foundAt || undefined} max={now().slice(0, 16)}
                  onChange={(e) => setNoticedAt(e.target.value)} />
              </Field>
              <Field label="手段" required>
                {/* 並びは電話を先頭に、連絡帳・個人チャットを電話のあとに経過を書く手段として後ろに置く */}
                <select value={method} onChange={(e) => setMethod(e.target.value as GuardianNoticeMethod | '')}>
                  <option value="">手段を選んでください</option>
                  {GUARDIAN_NOTICE_METHOD_ORDER.map((m) => (
                    <option key={m} value={m}>{GUARDIAN_NOTICE_METHOD[m]}</option>
                  ))}
                </select>
              </Field>
              <Field label="相手" required style={{ flex: 1 }}>
                <input type="text" value={person} maxLength={50} placeholder="例：母（勤務先）"
                  onChange={(e) => setPerson(e.target.value)} />
              </Field>
            </div>
          )}
          {/* システムは判断をしない。記録の内容から重大性を判定しない */}
          <div className="muted">
            この記録は事実を残すためのものです。システムは記録の内容から重大性の判定を行いません。
            <br />
            管理者への通知は、端末や通信の状況により届かないことがあります。記録とあわせて、声をかけて応援を呼んでください。
          </div>
          <div className="row-end">
            {/* 発見時刻は必須（画面詳細図 5-2 項目3）。空のまま送ると崩れた値になる（GitHub Issue #158） */}
            <button className="btn-primary" onClick={save}
              disabled={busy || !childId || !foundAt || !situation.trim() || !response.trim() || noticeIncomplete}>
              <SaveIcon />記録する
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>記録の一覧</h2>
        {list.loading && <Loading />}
        {list.error && <ErrorBox text={list.error} />}
        {list.data?.length === 0 && <Empty text="異常時の記録はありません。" />}
        {list.data && list.data.length > 0 && (
          <table className="list list-dense nap-abnormal-list">
            <thead>
              <tr>
                <th scope="col">発見時刻</th><th scope="col">園児</th><th scope="col">状況</th><th scope="col">対応</th>
                <th scope="col">記録者</th><th scope="col">ヒヤリハット</th><th scope="col">修正</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((a) => (
                <AbnormalRow key={a.nap_abnormal_id} a={a} editing={editingId === a.nap_abnormal_id}
                  onEdit={() => setEditingId(a.nap_abnormal_id)}
                  onRaise={() => raise(a.nap_abnormal_id)}
                  onClose={(changed) => { setEditingId(null); if (changed) list.refresh(); }} />
              ))}
            </tbody>
          </table>
        )}
        {/* 記録は削除させず、誤りは修正の履歴で残す（基本設計書「記録の修正と改ざん防止」(4-8)） */}
        <p className="muted">
          異常時の記録は削除できません。誤りは修正の履歴として残ります。
          {/* 【仮置き】一般に、直せる記録の範囲を知らせる（web/仮置き値.md「異常時の記録の修正」。画面詳細図「異常時記録画面」(5-2) の項目17） */}
          {user!.role === '2' && (
            <>
              <br />
              修正できるのは、自分のクラスの子の、その日の記録です。前の日までの記録は、管理者が修正します。
            </>
          )}
        </p>
      </section>
    </div>
  );
}

/**
 * 記録の一覧の1行。最後の列に、直した記録の「修正あり」と、直せる行にだけ「修正」を出す（画面詳細図「異常時記録画面」(5-2) の項目17）。
 * 「修正」を押すと、その行のすぐ下に修正の欄を開く（同じ画面の中で直す）。閉じたら、この行の「修正」へ戻す
 */
function AbnormalRow({ a, editing, onEdit, onRaise, onClose }: {
  a: NapAbnormalRow; editing: boolean; onEdit: () => void; onRaise: () => void; onClose: (changed: boolean) => void;
}) {
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
        <td className="nowrap">{formatMDHM(a.found_at)}</td>
        <td className="nowrap">{a.child_name}</td>
        <td>{a.situation}</td>
        <td>
          {a.response}
          {/* 保護者への連絡。未記入なら何も出さない。【仮置き】項目11 の列には無いため対応の下に添える（web/仮置き値.md） */}
          {a.guardian_notice && (
            <div className="muted">
              保護者への連絡：{GUARDIAN_NOTICE[a.guardian_notice]}
              {a.guardian_notice === '1' && a.guardian_noticed_at && a.guardian_notice_method && (
                <>（{formatMDHM(a.guardian_noticed_at)}・{GUARDIAN_NOTICE_METHOD[a.guardian_notice_method]}・{a.guardian_notice_person}）</>
              )}
            </div>
          )}
        </td>
        <td className="nowrap">{a.staff_name}</td>
        <td className="nowrap">
          {/* 【仮置き】ヒヤリハットが下書きのまま（申請していない）なら「起票済み（下書き・開く）」（web/仮置き値.md。GitHub Issue #142 の 5）。
              行ごとにくり返すのでテキストボタン。名前に「開く」があるので進む印は添えない（印のぶん iPad 縦向きで表が横にはみ出す） */}
          {a.diary_id
            ? <Link className="btn btn-sm btn-quiet" to={`/staff/diary/${a.diary_id}`}>{a.diary_draft ? '起票済み（下書き・開く）' : '起票済み（開く）'}</Link>
            : <button className="btn-sm btn-tonal" onClick={onRaise}>起票する</button>}
        </td>
        <td className="nowrap">
          <div className="row">
            {a.corrected_at && <span className="tag tag-plain">修正あり</span>}
            {a.can_correct && !editing && (
              <button ref={editButton} type="button" className="btn-sm btn-quiet" onClick={onEdit}
                aria-label={`${a.child_name}の${formatMDHM(a.found_at)}の異常時の記録を修正`}>
                修正
              </button>
            )}
          </div>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={7}><AbnormalCorrectForm a={a} onClose={onClose} /></td>
        </tr>
      )}
    </>
  );
}

/**
 * 異常時の記録の修正の欄（画面詳細図「異常時記録画面」(5-2) の項目17）。発見時刻・状況・とった対応を書き換え、理由（必須・
 * 500文字以内）を入れる。保存時刻・記録した職員は変えない。発見時刻は、未来と保存時刻より後を受け付けない。
 * 行を書き換え、修正前の値と理由は操作ログへ残る（基本設計書「記録の修正と改ざん防止」(4-8)）。削除はできない。
 * 規則（直せる人・理由・発見時刻の前後）の担保はサーバ（POST /api/nap/abnormals/{id}/correct）。画面は断られた文言をそのまま出す
 */
function AbnormalCorrectForm({ a, onClose }: { a: NapAbnormalRow; onClose: (changed: boolean) => void }) {
  const { user } = useSession();
  const [foundAt, setFoundAt] = useState(a.found_at.slice(0, 16));
  const [situation, setSituation] = useState(a.situation);
  const [response, setResponse] = useState(a.response);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 開いたら、最初の項目（発見時刻）へ移る
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  // 発見時刻は、いまと保存した時刻のうち早いほうまで（保存時刻が無い古い記録は、発見時刻を保存時刻とみなす。サーバと同じ）
  const recorded = (a.recorded_at ?? a.found_at).slice(0, 16);
  const nowMinute = now().slice(0, 16);
  const latest = recorded < nowMinute ? recorded : nowMinute;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      // 発見時刻は、書き換えたときだけ送る（秒を持つ記録を、触っていないのに直したことにしないため）
      await api.correctNapAbnormal(user!, a.nap_abnormal_id, {
        ...(foundAt !== a.found_at.slice(0, 16) ? { found_at: `${foundAt}:00` } : {}),
        situation, response, reason,
      });
      notify('異常時の記録を修正しました。修正前の値と理由は、修正の履歴に残ります');
      onClose(true);
    } catch (ex) {
      setErr((ex as Error).message);
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label={`${a.child_name}の${formatMDHM(a.found_at)}の異常時の記録の修正`}>
      <Field label="発見時刻" required>
        <input ref={first} type="datetime-local" value={foundAt} max={latest} onChange={(e) => setFoundAt(e.target.value)} />
      </Field>
      <Field label="発見時の状況" required>
        <textarea rows={2} maxLength={1000} value={situation} onChange={(e) => setSituation(e.target.value)} />
      </Field>
      <Field label="とった対応" required>
        <textarea rows={2} maxLength={1000} value={response} onChange={(e) => setResponse(e.target.value)} />
      </Field>
      <Field label="修正の理由" required>
        <textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {/* 【仮置き】修正の欄の説明（web/仮置き値.md「異常時の記録の修正」） */}
      <p className="muted">
        保存した時刻と記録した職員は変わりません。発見時刻は、記録を保存した時刻より後にはできません。
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
