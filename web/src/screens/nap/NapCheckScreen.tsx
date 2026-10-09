/*
 * 午睡チェック画面
 * 典拠：図/画面詳細図.md「午睡チェック画面」(5-1)
 *
 * タイマーを画面の上部に固定する。スクロールしても視界から外さない。
 * 平熱は比較の材料として並べて表示するのみであり、発熱の判定は行わない。
 * うつ伏せを選んだときの警告は注意喚起であって判定ではない。記録自体は妨げない。
 * 記録は園児カードから1件ずつ行い、確認画面を挟まない。
 * この画面は開いたまま運用し、実施中は自動ログアウトの対象外とする。
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses, childName } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Modal, Radios } from '../../components/ui';
import { BODY_POSITION, BREATHING, COMPLEXION } from '../../api/codes';
import { formatHM, today, now, napTimerBase, plusMinutes } from '../../api/util';
import type { BodyPosition, Breathing, Complexion } from '../../api/types';

export default function NapCheckScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);
  const [classId, setClassId] = useState<number>(user!.class_id ?? classesForUser[0]?.class_id ?? 1);
  const [tick, setTick] = useState(0);

  const session = useAsync(() => api.activeSession(classId, today()), [classId, tick]);
  const state = useAsync(
    () => api.classState(user!, classId, session.data?.nap_session_id ?? null),
    [classId, session.data?.nap_session_id, tick],
  );

  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    try { await api.startSession(user!, classId, today()); setTick((n) => n + 1); }
    catch (e) { setError((e as Error).message); }
  };
  const end = async () => {
    if (!session.data) return;
    setError(null);
    try { endedByUser.current = true; await api.endSession(user!, session.data.nap_session_id); setTick((n) => n + 1); }
    catch (e) { setError((e as Error).message); }
  };

  const s = session.data;
  const rows = state.data ?? [];
  const recorded = rows.filter((r) => r.latest).length;
  const intervalMinutes = api.intervalMinutesFor(classId);

  /*
   * 実施中は1分ごとに読み直す。午睡の時間帯を過ぎて自動で解除されたことを、
   * 開いたままの画面でも拾うため（基本設計書「午睡チェックの実施」(4-7)）。
   * あわせて、確認の時刻を過ぎた園児のカードの表示を進める。
   */
  const activeId = s?.nap_session_id ?? null;
  useEffect(() => {
    if (activeId === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [activeId]);

  // 終了の操作をしていないのに実施中でなくなったら、自動で解除されたと知らせる
  const wasActive = useRef(false);
  const endedByUser = useRef(false);
  const [autoClosed, setAutoClosed] = useState(false);
  useEffect(() => {
    if (session.loading) return;
    if (s) { wasActive.current = true; endedByUser.current = false; setAutoClosed(false); return; }
    if (wasActive.current && !endedByUser.current) setAutoClosed(true);
    wasActive.current = false;
  }, [s, session.loading]);

  // 確認の時刻を過ぎたか。未記録の園児は開始時刻から数える
  const isDue = (latestAt: string | null) =>
    !!s && plusMinutes(latestAt ?? s.started_at, intervalMinutes) <= now();

  return (
    <div>
      {s && <NapTimer startedAt={s.started_at} intervalMinutes={intervalMinutes} rows={rows} />}

      <div className="page-head">
        <h1>午睡チェック</h1>
        <Field label="クラス">
          <select value={classId} onChange={(e) => setClassId(Number(e.target.value))} disabled={!!s}>
            {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
          </select>
        </Field>
        <div className="spacer" />
        {/*
          過去の記録を見返す導線はこの画面が持つ。サイドナビには置かない。
          実施中の画面から離れる操作を誘わないため（図/画面遷移図.md「午睡チェック」(5)）
        */}
        <Link className="btn btn-sm" to="/staff/nap/search">記録を検索</Link>
        <span className="muted">記録者：{user!.display_name}</span>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      {session.loading && <Loading />}

      {!session.loading && !s && (
        <section className="card">
          {autoClosed
            ? <Alert>午睡の時間帯を過ぎたため、午睡チェックを自動で終了しました。続けるときは、もう一度開始してください。</Alert>
            : <Empty text="午睡チェックはまだ開始していません。" />}
          <div className="row-end">
            <button className="btn-primary" onClick={start}>午睡チェックを開始する</button>
          </div>
          <div className="muted" style={{ marginTop: 12 }}>
            開始すると、この画面は開いたままの運用になります。実施中は自動ログアウトの対象外です
            （基本設計書「画面遷移」(3-4)）。
          </div>
        </section>
      )}

      {s && (
        <>
          <div className="page-head">
            <span>記録済み {recorded} / {rows.length} 名</span>
            <div className="spacer" />
            <Link className="btn" to="/staff/nap/abnormal">異常を記録する</Link>
            <button onClick={end}>午睡チェックを終了</button>
          </div>

          {state.loading && <Loading />}
          {state.error && <ErrorBox text={state.error} />}

          <div className="nap-grid">
            {rows.map((r) => (
              <div key={r.child.child_id}
                className={`nap-card${!r.latest || isDue(r.latest.checked_at) ? ' unrecorded' : ''}`}>
                <div className="name">{r.child.child_name}</div>
                {/* 平熱は比較の材料として並べて表示するのみ。発熱の判定は行わない */}
                <div className="last">平熱 {r.child.normal_temperature ?? '―'}</div>
                <div className="last">
                  {r.latest
                    ? `${isDue(r.latest.checked_at) ? '(!) ' : ''}${formatHM(r.latest.checked_at)} ${BODY_POSITION[r.latest.body_position]}`
                    : '(!) 未記録'}
                </div>
                <button className="btn-primary btn-sm" onClick={() => setTarget(r.child.child_id)}>記録</button>
              </div>
            ))}
          </div>
        </>
      )}

      {target && s && (
        <RecordDialog
          childId={target}
          sessionId={s.nap_session_id}
          normalTemperature={rows.find((r) => r.child.child_id === target)?.child.normal_temperature ?? null}
          onClose={() => setTarget(null)}
          onSaved={() => { setTarget(null); setTick((n) => n + 1); }}
        />
      )}
    </div>
  );
}

/**
 * タイマー。次のチェックまでの残り時間を上部に固定して示す（画面詳細図 5-1）
 * 間隔は年齢別のマスタ値を用いる（基本設計書 5-8）
 */
function NapTimer({ startedAt, intervalMinutes, rows }: {
  startedAt: string; intervalMinutes: number; rows: { latest: { checked_at: string } | null }[];
}) {
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const startMs = new Date(startedAt).getTime();
  const elapsed = Math.max(0, Math.floor((nowMs - startMs) / 1000));

  /*
   * いちばん長く確認していない園児を起点に、次のチェックまでを数える。
   * 1人を記録しただけでは次の間隔へ進まない。全員を確認し終えてはじめて進む。
   */
  const baseMs = new Date(napTimerBase(startedAt, rows.map((r) => r.latest?.checked_at ?? null))).getTime();
  const dueMs = baseMs + intervalMinutes * 60_000;
  const remain = Math.floor((dueMs - nowMs) / 1000);
  const over = remain < 0;
  // 確認の時刻を過ぎている園児の数。未記録の園児は開始時刻から数える
  const dueCount = rows.filter((r) =>
    new Date(r.latest?.checked_at ?? startedAt).getTime() + intervalMinutes * 60_000 <= nowMs).length;

  // 1時間を超えるときは時も出す。分だけで表すと「66:57」のように読み取りにくくなるため
  const mmss = (sec: number) => {
    const a = Math.abs(sec);
    const p = (n: number) => String(n).padStart(2, '0');
    const h = Math.floor(a / 3600);
    return h > 0
      ? `${h}:${p(Math.floor((a % 3600) / 60))}:${p(a % 60)}`
      : `${p(Math.floor(a / 60))}:${p(a % 60)}`;
  };
  const hmm = (sec: number) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;

  return (
    <div className={`nap-timer${over ? ' over' : ''}`}>
      <div>
        <div className="muted" role="status" aria-live="polite">
          {over ? `チェックの時刻を過ぎています（未確認 ${dueCount} 名）` : '次のチェックまで'}
        </div>
        <div className="big">{over ? `+${mmss(remain)}` : mmss(remain)}</div>
      </div>
      <div>
        <div className="muted">開始</div>
        <div>{formatHM(startedAt)}</div>
      </div>
      <div>
        <div className="muted">経過</div>
        <div>{hmm(elapsed)}</div>
      </div>
      <div>
        <div className="muted">チェック間隔</div>
        <div>{intervalMinutes} 分</div>
      </div>
    </div>
  );
}

/** 記録のダイアログ。同じ画面の中で開き、確認画面を挟まない（画面詳細図 5-1） */
function RecordDialog({ childId, sessionId, normalTemperature, onClose, onSaved }: {
  childId: string; sessionId: number; normalTemperature: number | null;
  onClose: () => void; onSaved: () => void;
}) {
  const { user } = useSession();
  const [position, setPosition] = useState<BodyPosition | null>(null);
  /*
   * 体位・呼吸・顔色は、どれも選ばれていない状態から始める。
   * 午睡チェックは保育士が見て確かめた事実の記録であり、見ていない値を先に入れない。
   */
  const [breathing, setBreathing] = useState<Breathing | null>(null);
  const [complexion, setComplexion] = useState<Complexion | null>(null);
  const [temperature, setTemperature] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!position || !breathing || !complexion) return;
    setBusy(true); setError(null);
    try {
      await api.record(user!, sessionId, {
        child_id: childId, body_position: position, breathing, complexion,
        temperature: temperature ? Number(temperature) : null,
      });
      onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal title={`${childName(childId)}　${formatHM(now())}`} onClose={onClose}
      footer={<>
        <button onClick={onClose} disabled={busy}>やめる</button>
        <button className="btn-primary" onClick={save} disabled={busy || !position || !breathing || !complexion}>記録する</button>
      </>}>
      <div className="stack">
        {error && <Alert>{error}</Alert>}

        <Field label="体位" required>
          <Radios name="position" value={position}
            options={(Object.keys(BODY_POSITION) as BodyPosition[]).map((k) => ({ value: k, label: BODY_POSITION[k] }))}
            onChange={setPosition} />
        </Field>

        {/* うつ伏せの警告は注意喚起であって判定ではない。記録自体は妨げない */}
        {position === '2' && <Alert>うつ伏せです。仰向けに直してください。</Alert>}

        <Field label="呼吸" required>
          <Radios name="breathing" value={breathing}
            options={(Object.keys(BREATHING) as Breathing[]).map((k) => ({ value: k, label: BREATHING[k] }))}
            onChange={setBreathing} />
        </Field>
        {breathing === '2' && (
          <Alert>呼吸が確認できません。ただちに応援を呼び、異常時の記録を残してください。</Alert>
        )}

        <Field label="顔色" required>
          <Radios name="complexion" value={complexion}
            options={(Object.keys(COMPLEXION) as Complexion[]).map((k) => ({ value: k, label: COMPLEXION[k] }))}
            onChange={setComplexion} />
        </Field>

        <Field label="体温">
          <div className="row">
            <input type="number" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)}
              style={{ maxWidth: 140 }} />
            <span>℃</span>
            {/* 平熱は並べて表示するのみ。差の判定は行わない */}
            <span className="muted">（平熱 {normalTemperature ?? '―'}）</span>
          </div>
        </Field>
      </div>
    </Modal>
  );
}
