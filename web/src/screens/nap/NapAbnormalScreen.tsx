/*
 * 異常時記録画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)「発見時刻・状況・とった対応の記録。ヒヤリハットの起票の導線を置く」
 *      基本設計書.md「異常時の記録」(4-7)、5-6 t_nap_abnormal
 *
 * diary_id が空なら「記録したがヒヤリハットを起票していない」状態として一覧で示す。
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses, visibleChildren } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert } from '../../components/ui';
import { formatMDHM, now, today } from '../../api/util';

export default function NapAbnormalScreen() {
  const { user } = useSession();
  const navigate = useNavigate();
  const classesForUser = selectableClasses(user!);
  const [tick, setTick] = useState(0);

  const list = useAsync(() => api.abnormals(user!), [user?.account_id, tick]);
  const children = visibleChildren(user!);

  const [classId] = useState<number>(user!.class_id ?? classesForUser[0]?.class_id ?? 1);
  const session = useAsync(() => api.activeSession(classId, today()), [classId, tick]);

  const [childId, setChildId] = useState('');
  const [foundAt, setFoundAt] = useState(now().slice(0, 16));
  const [situation, setSituation] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const sessionId = session.data?.nap_session_id
        ?? (await api.startSession(user!, classId, today())).nap_session_id;
      await api.recordAbnormal(user!, sessionId, {
        child_id: childId, found_at: `${foundAt}:00`, situation, response,
      });
      setChildId(''); setSituation(''); setResponse('');
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
              <select value={childId} onChange={(e) => setChildId(e.target.value)}>
                <option value="">選んでください</option>
                {children.map((c) => <option key={c.child_id} value={c.child_id}>{c.child_name}</option>)}
              </select>
            </Field>
            <Field label="発見時刻" required>
              <input type="datetime-local" value={foundAt} onChange={(e) => setFoundAt(e.target.value)} />
            </Field>
          </div>
          <Field label="発見時の状況" required>
            <textarea value={situation} onChange={(e) => setSituation(e.target.value)}
              placeholder="体位・呼吸・顔色・体温など、見たままを書いてください" />
          </Field>
          <Field label="とった対応" required>
            <textarea value={response} onChange={(e) => setResponse(e.target.value)}
              placeholder="誰が何をしたか、保護者へどう連絡したかを書いてください" />
          </Field>
          {/* システムは判断をしない。記録の内容から重大性を判定しない */}
          <div className="muted">
            この記録は事実を残すためのものです。システムは記録の内容から重大性の判定を行いません。
          </div>
          <div className="row-end">
            <button className="btn-primary" onClick={save}
              disabled={busy || !childId || !situation.trim() || !response.trim()}>
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
              <tr><th>発見時刻</th><th>園児</th><th>状況</th><th>対応</th><th>記録者</th><th>ヒヤリハット</th></tr>
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
