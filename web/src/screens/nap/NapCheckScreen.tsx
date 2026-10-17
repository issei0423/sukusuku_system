/*
 * 午睡チェック画面
 * 典拠：図/画面詳細図.md「午睡チェック画面」(5-1)
 *
 * タイマーを画面の上部に固定する。スクロールしても視界から外さない。
 * 平熱は比較の材料として並べて表示するのみであり、発熱の判定は行わない。
 * うつ伏せを選んだときの警告は注意喚起であって判定ではない。記録自体は妨げない。
 * 記録は園児ごとの行で直接行う。体温は実測したときだけ選ぶ。
 * この画面は開いたまま運用し、実施中は自動ログアウトの対象外とする。
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Modal } from '../../components/ui';
import { ConfirmDialog } from '../../components/feedback';
import { BODY_POSITION, BREATHING, COMPLEXION } from '../../api/codes';
import { formatHM, formatTemperature, today, now, napTimerBase, plusMinutes } from '../../api/util';
import type { BodyPosition, Breathing, Complexion } from '../../api/types';
import type { NapChildState } from '../../api/shapes';

/** 園児の行に「保存しました」を出しておく時間（仮置き値.md「午睡チェックの動き」） */
const SAVED_NOTICE_MS = 5000;

export default function NapCheckScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);
  const [classId, setClassId] = useState<number>(user!.class_id ?? classesForUser[0]?.class_id ?? 1);
  const [tick, setTick] = useState(0);

  // 選べるクラスが無い（担当クラスの無い一般の職員）ときは、問い合わせない。
  // ほかのクラスを指定することになり、権限の誤りが返る（GitHub Issue #96・#127）
  const hasClass = classesForUser.length > 0;
  const session = useAsync(async () => (hasClass ? api.activeSession(classId, today(), user!) : null), [classId, tick]);
  const state = useAsync(
    async () => (hasClass ? api.classState(user!, classId, session.data?.nap_session_id ?? null) : []),
    [classId, session.data?.nap_session_id, tick],
  );

  const [error, setError] = useState<string | null>(null);
  // 未記録の園児が残っているときに、終了の前に確かめる（画面詳細図「午睡チェック画面」(5-1)）
  const [ending, setEnding] = useState(false);

  const start = async () => {
    setError(null);
    try { await api.startSession(user!, classId, today()); setTick((n) => n + 1); }
    catch (e) { setError((e as Error).message); }
  };
  const end = async () => {
    if (!session.data) return;
    setEnding(false);
    setError(null);
    try { endedByUser.current = true; await api.endSession(user!, session.data.nap_session_id); setTick((n) => n + 1); }
    catch (e) {
      // 自動で解除された・ほかの職員が終了した実施は、もう終了できない（GitHub Issue #158）。読み直して今の状態を出す
      endedByUser.current = false;
      setError((e as Error).message);
      setTick((n) => n + 1);
    }
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

  // 選べるクラスが無い（担当クラスの無い一般の職員）。ほかのクラスの実施を表示しない（GitHub Issue #127）
  if (classesForUser.length === 0) {
    return (
      <div>
        <div className="page-head"><h1>午睡チェック</h1></div>
        <section className="card">
          <div className="empty">担当クラスが割り当てられていないため、午睡チェックを行えません。</div>
        </section>
      </div>
    );
  }

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
            <button onClick={() => (recorded < rows.length ? setEnding(true) : end())}>午睡チェックを終了</button>
          </div>
          {ending && (
            <ConfirmDialog title="記録していない園児がいます" confirmLabel="このまま終了する" danger
              onConfirm={end} onCancel={() => setEnding(false)}>
              <p>{rows.length - recorded} 名の記録がありません。このまま午睡チェックを終了しますか。</p>
              <p className="muted">終了したあとは、この実施へ記録を足せません。</p>
            </ConfirmDialog>
          )}

          {state.loading && <Loading />}
          {state.error && <ErrorBox text={state.error} />}

          <div className="nap-grid">
            {rows.map((r) => (
              <NapRecordRow key={r.child.child_id} row={r} sessionId={s.nap_session_id}
                due={isDue(r.latest?.checked_at ?? null)} onSaved={() => setTick((n) => n + 1)} />
            ))}
          </div>
        </>
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

/** 園児の行から直接記録する。選択肢に前回値を入れず、毎回の目視確認を促す。 */
function NapRecordRow({ row, sessionId, due, onSaved }: {
  row: NapChildState; sessionId: number; due: boolean; onSaved: () => void;
}) {
  const { user } = useSession();
  const TEMP_MIN = 30.0;
  const TEMP_MAX = 43.0;
  const [position, setPosition] = useState<BodyPosition | null>(null);
  const [breathing, setBreathing] = useState<Breathing | null>(null);
  const [complexion, setComplexion] = useState<Complexion | null>(null);
  const [temperature, setTemperature] = useState<number | null>(null);
  const [temperatureOpen, setTemperatureOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const id = row.child.child_id;
  const name = row.child.child_name;

  // 「保存しました」は確認の画面を出さない記録の、唯一の手応え。保存後の読み直しで前回の記録が
  // 新しくなっても消さず、一定時間たつか、次の入力を始めたときに消す（仮置き値.md）
  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), SAVED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [justSaved]);
  const startInput = <T,>(set: (value: T) => void) => (value: T) => { setJustSaved(false); set(value); };

  // 体温が範囲の外のときは、1度確かめてから記録する。記録は妨げない（園児の平熱と同じ範囲）
  const [confirmedTemp, setConfirmedTemp] = useState<number | null>(null);
  const save = async () => {
    if (busy || !position || !breathing || !complexion) return;
    if (temperature !== null && (temperature < TEMP_MIN || temperature > TEMP_MAX) && confirmedTemp !== temperature) {
      setConfirmedTemp(temperature);
      setError(`体温が ${TEMP_MIN.toFixed(1)}〜${TEMP_MAX.toFixed(1)}℃ の外です。入力に誤りがなければ、もう一度「この子を記録」を押してください。`);
      return;
    }
    setBusy(true); setError(null); setJustSaved(false);
    try {
      await api.record(user!, sessionId, {
        child_id: id, body_position: position, breathing, complexion, temperature,
      });
      setPosition(null); setBreathing(null); setComplexion(null); setTemperature(null); setConfirmedTemp(null);
      setJustSaved(true);
      onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className={`nap-card nap-record-row${!row.latest || due ? ' unrecorded' : ''}`} aria-label={`${name}の午睡チェック`}>
      <div className="nap-row-head">
        <strong className="name">{name}</strong>
        <span className={`nap-row-status${!row.latest || due ? ' due' : ''}`} role="status">
          {justSaved ? '保存しました' : !row.latest ? '未記録' : due ? 'チェック時刻を過ぎています' : '確認済み'}
        </span>
        <span className="last">{row.latest ? `前回 ${formatHM(row.latest.checked_at)} ${BODY_POSITION[row.latest.body_position]}` : '前回の記録なし'}</span>
        <span className="last">平熱 {formatTemperature(row.child.normal_temperature)}℃</span>
      </div>

      <div className="nap-inline-fields">
        <NapChoices label="体位" name={`position-${id}`} options={BODY_POSITION} value={position} onChange={startInput(setPosition)} />
        <NapChoices label="呼吸" name={`breathing-${id}`} options={BREATHING} value={breathing} onChange={startInput(setBreathing)} />
        <NapChoices label="顔色" name={`complexion-${id}`} options={COMPLEXION} value={complexion} onChange={startInput(setComplexion)} />
      </div>

      {position === '2' && <Alert>うつ伏せです。仰向けに直してください。</Alert>}
      {breathing === '2' && <Alert>呼吸が確認できません。ただちに応援を呼び、異常時の記録を残してください。</Alert>}
      {error && <Alert>{error}</Alert>}

      <div className="nap-row-actions">
        <button type="button" className="nap-temperature-button" onClick={() => setTemperatureOpen(true)}
          aria-label={`${name}の体温を選ぶ`}>
          体温 {temperature === null ? '未測定' : `${temperature.toFixed(1)}℃`}
        </button>
        {temperature !== null && <button type="button" className="btn-quiet btn-sm" onClick={() => setTemperature(null)}>体温を消す</button>}
        <div className="spacer" />
        <button type="button" className="btn-primary" onClick={save}
          disabled={busy || !position || !breathing || !complexion}>
          {busy ? '保存中…' : 'この子を記録'}
        </button>
      </div>

      {temperatureOpen && <TemperaturePicker name={name} onClose={() => setTemperatureOpen(false)}
        onSelect={(value) => { setTemperature(value); setTemperatureOpen(false); }} />}
    </section>
  );
}

function NapChoices<T extends string>({ label, name, options, value, onChange }: {
  label: string; name: string; options: Record<T, string>; value: T | null; onChange: (next: T) => void;
}) {
  return (
    <fieldset className="nap-choice-field">
      <legend>{label}</legend>
      <div className="nap-choice-options">
        {(Object.entries(options) as [T, string][]).map(([code, text]) => (
          <label className="nap-choice" key={code}>
            <input type="radio" name={name} value={code} checked={value === code} onChange={() => onChange(code)} />
            <span>{text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** 実測したときだけ開く体温パネル。よく使う範囲はキーボードなしで2タップ。 */
function TemperaturePicker({ name, onClose, onSelect }: {
  name: string; onClose: () => void; onSelect: (value: number) => void;
}) {
  const [whole, setWhole] = useState<number | null>(null);
  const [manual, setManual] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  return (
    <Modal title={`${name}の体温`} onClose={onClose} footer={<button onClick={onClose}>閉じる</button>}>
      <div className="nap-temperature-picker">
        <p className="muted">体温計で測った値を選んでください。測っていない場合は閉じます。</p>
        <div className="nap-temp-heading">{whole === null ? '整数部分を選ぶ' : `${whole}℃ の小数部分を選ぶ`}</div>
        <div className={`nap-temp-grid${whole === null ? ' whole' : ''}`}>
          {whole === null
            ? [35, 36, 37, 38, 39, 40].map((n) => <button key={n} onClick={() => setWhole(n)}>{n}℃</button>)
            : Array.from({ length: 10 }, (_, n) => <button key={n} onClick={() => onSelect(whole + n / 10)}>.{n}</button>)}
        </div>
        {whole !== null && <button className="btn-quiet btn-sm" onClick={() => setWhole(null)}>整数部分を選び直す</button>}
        <div className="nap-temp-manual">
          {manualOpen ? <>
            <label htmlFor={`temperature-manual-${name}`}>範囲外の体温</label>
            <input id={`temperature-manual-${name}`} type="number" inputMode="decimal" step="0.1" value={manual}
              onChange={(e) => setManual(e.target.value)} placeholder="例：34.9" />
            <button onClick={() => { const value = Number(manual); if (manual && Number.isFinite(value)) onSelect(value); }}
              disabled={!manual || !Number.isFinite(Number(manual))}>設定</button>
          </> : <button className="btn-quiet btn-sm" onClick={() => setManualOpen(true)}>範囲外の値を入力</button>}
        </div>
      </div>
    </Modal>
  );
}
