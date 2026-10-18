/*
 * 異常時記録画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)「発見時刻・状況・とった対応の記録。ヒヤリハットの起票の導線を置く」
 *      基本設計書.md「異常時の記録」(4-7)、5-6 t_nap_abnormal
 *
 * diary_id が空なら「記録したがヒヤリハットを起票していない」状態として一覧で示す。
 *
 * 記録は、選んだ園児のクラスの、実施中の午睡チェックにつなぐ。記録の操作で午睡チェックを開始しない
 * （基本設計書「午睡チェックの実施」(4-7)。GitHub Issue #158）。
 * 【仮置き】実施中の午睡チェックが無いときは記録できない（web/仮置き値.md）。
 *
 * 保護者への連絡（画面詳細図「異常時記録画面」(5-2) 項目13）は任意で、未記入のまま記録してよい。
 * 連絡の要否はシステムが判断しない。午睡中の異常は電話で伝え（段4）、連絡帳・個人チャットは電話のあとに
 * 経過を書く手段である（PR #216 の版の項目13。基本設計書「異常時の記録」(4-8)）。
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, visibleChildren } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Radios } from '../../components/ui';
import { formatMDHM, now, today } from '../../api/util';
import { GUARDIAN_NOTICE, GUARDIAN_NOTICE_METHOD, GUARDIAN_NOTICE_METHOD_ORDER } from '../../api/codes';
import type { GuardianNotice, GuardianNoticeMethod } from '../../api/types';

export default function NapAbnormalScreen() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [tick, setTick] = useState(0);

  const list = useAsync(() => api.abnormals(user!), [user?.account_id, tick]);
  const children = visibleChildren(user!);

  const [childId, setChildId] = useState('');
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
      setChildId(''); setSituation(''); setResponse('');
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
        <Link className="btn btn-quiet btn-sm" to="/staff/nap">&lt; 午睡チェックへ</Link>
        <h1>異常時の記録</h1>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      <section className="card">
        <h2>新しく記録する</h2>
        <div className="stack">
          <div className="row">
            <Field label="園児" required style={{ flex: 1 }}>
              <select value={childId} onChange={(e) => setChildId(e.target.value)}>
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
              記録する
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
          <table className="list">
            <thead>
              <tr><th scope="col">発見時刻</th><th scope="col">園児</th><th scope="col">状況</th><th scope="col">対応</th><th scope="col">記録者</th><th scope="col">ヒヤリハット</th></tr>
            </thead>
            <tbody>
              {list.data.map((a) => (
                <tr key={a.nap_abnormal_id}>
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
                    {a.diary_id
                      ? <Link className="btn btn-sm" to={`/staff/diary/${a.diary_id}`}>起票済み（開く）</Link>
                      : <button className="btn-sm btn-primary" onClick={() => raise(a.nap_abnormal_id)}>起票する</button>}
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
