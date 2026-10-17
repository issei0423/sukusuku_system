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
 */
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, visibleChildren } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert } from '../../components/ui';
import { formatMDHM, now, today } from '../../api/util';

export default function NapAbnormalScreen() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [tick, setTick] = useState(0);

  const list = useAsync(() => api.abnormals(user!), [user?.account_id, tick]);
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
      });
      setChildId(''); setSituation(''); setResponse(''); setObserved(null);
      setTick((n) => n + 1);
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
              placeholder="誰が何をしたか、保護者へどう連絡したかを書いてください" />
          </Field>
          {/* システムは判断をしない。記録の内容から重大性を判定しない */}
          <div className="muted">
            この記録は事実を残すためのものです。システムは記録の内容から重大性の判定を行いません。
            <br />
            管理者への通知は、端末や通信の状況により届かないことがあります。記録とあわせて、声をかけて応援を呼んでください。
          </div>
          <div className="row-end">
            {/* 発見時刻は必須（画面詳細図 5-2 項目3）。空のまま送ると崩れた値になる（GitHub Issue #158） */}
            <button className="btn-primary" onClick={save}
              disabled={busy || !childId || !foundAt || !situation.trim() || !response.trim()}>
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
                  <td>{a.response}</td>
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
