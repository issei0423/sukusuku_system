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
import { onNapClass } from '../../live';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Modal } from '../../components/ui';
import { ConfirmDialog } from '../../components/feedback';
import { BODY_POSITION, BREATHING, COMPLEXION } from '../../api/codes';
import { formatHM, formatTemperature, today, napTimerBase, jstMs, isOneDecimal } from '../../api/util';
import type { BodyPosition, Breathing, Complexion, NapRecord } from '../../api/types';
import type { NapChildState } from '../../api/shapes';
import SleepControls from './SleepControls';
import { focusAfter, focusableIn, focusedNow } from '../../focusAfter';
import { useNapSound } from '../../napSound';

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
  /*
   * 同じクラスのほかの職員（別のタブレット）の開始・記録・終了は、知らせ（live.ts）を受けて開いたままで読み直す。
   * 読み直しでは読み込み中の表示を出さず、園児の行の入力中の値は残す（保存のあとの読み直しと同じ）
   */
  /*
   * 読み込み中の表示（と、その間の「午睡チェックを開始する」の非表示）は、このクラスを初めて読むときだけにする。
   * 開始・終了のあとの読み直し（tick）でも出すと、終了のあとに「午睡チェックを開始する」が一度出てから消えて出し直され、
   * 移したフォーカスが body に落ちる（WCAG 2.4.3、GitHub Issue #265）。読み終えたクラスは覚えておく
   */
  const loadedClass = useRef<number | null>(null);
  const session = useAsync(async () => {
    if (!hasClass) return null;
    const active = await api.activeSession(classId, today(), user!);
    loadedClass.current = classId;
    return active;
  }, [classId, tick], { live: onNapClass(classId) });
  const sessionLoading = session.loading && loadedClass.current !== classId;
  const state = useAsync(
    async () => (hasClass ? api.classState(user!, classId, session.data?.nap_session_id ?? null) : []),
    [classId, session.data?.nap_session_id, tick],
    { live: onNapClass(classId) },
  );

  const [error, setError] = useState<string | null>(null);
  // 未記録の園児が残っているときに、終了の前に確かめる（画面詳細図「午睡チェック画面」(5-1)）
  const [ending, setEnding] = useState(false);

  /*
   * 開始すると、読み直しで「午睡チェックを開始する」が消えて実施中の画面に替わり、フォーカスが body に落ちていた
   * （WCAG 2.4.3、GitHub Issue #213）。代わりに出る見出しの並び（記録済みの数・「異常を記録する」・「午睡チェックを終了」）の、
   * 押せる最初の部品へ移す（同じ並びの押せるもの。src/focusAfter.ts）。開始できなかったときはボタンもフォーカスも残る
   */
  const sessionHead = useRef<HTMLDivElement>(null);
  const start = async () => {
    const pressed = focusedNow();
    setError(null);
    try {
      await api.startSession(user!, classId, today());
      setTick((n) => n + 1);
      focusAfter(pressed, () => focusableIn(sessionHead.current)[0] ?? null);
    } catch (e) { setError((e as Error).message); }
  };
  /*
   * 終了すると、読み直しで「午睡チェックを終了」が消え、フォーカスが body に落ちていた（WCAG 2.4.3、GitHub Issue #213）。
   * 代わりに出る「午睡チェックを開始する」へ移す（src/focusAfter.ts）。確認の窓から終了したときは、窓の部品が同じ先へ移す（returnTo）。
   * 終了できずに実施が残ったときは、ボタンもフォーカスも残る
   */
  const startButton = useRef<HTMLButtonElement>(null);
  const end = async () => {
    if (!session.data) return;
    const pressed = focusedNow();
    setEnding(false);
    setError(null);
    try { endedByUser.current = true; await api.endSession(user!, session.data.nap_session_id); setTick((n) => n + 1); }
    catch (e) {
      // 自動で解除された・ほかの職員が終了した実施は、もう終了できない（GitHub Issue #158）。読み直して今の状態を出す
      endedByUser.current = false;
      setError((e as Error).message);
      setTick((n) => n + 1);
    }
    focusAfter(pressed, () => startButton.current);
  };

  // 担当クラスの無い一般（フリー）は閲覧のみ。記録の操作は出さない（基本設計書「権限と利用可能機能」(6-1) ※1）
  const readOnly = user!.role === '2' && !user!.class_id;
  const s = session.data;
  const allRows = state.data ?? [];
  // 「きょうは対象外」の子は、タイマーと未記録の数から外す（詳細設計書「タイマー」(2-4 (3))）
  const rows = allRows.filter((r) => !r.exclusion);
  const recorded = rows.filter((r) => r.latest).length;
  // 「ねた」のまま「おきた」が無い子（終了の前に確かめる。詳細設計書 (2-4 (2))）
  const stillSleeping = allRows.filter((r) => r.sleeps.some((x) => !x.woke_at)).map((r) => r.child.child_name);
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

  /*
   * 画面の時計。1秒ごとに進め、確認の時刻になった行をその時刻で警告色にする（60秒ごとの読み直しを待たない）。
   * タイマーの表示・読み上げ・通知音も同じ時計で動かす（図/画面詳細図.md「午睡チェック画面」(5-1) 項目3・7・20）
   */
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (activeId === null) return;
    // 画面を開いた時刻のままで判定しないよう、実施が決まったときにすぐ合わせる（PR #322 の review）
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activeId]);

  // 確認の時刻を過ぎたか。未記録の園児は開始時刻から数える
  const isDue = (latestAt: string | null) =>
    !!s && jstMs(latestAt ?? s.started_at) + intervalMinutes * 60_000 <= nowMs;

  /*
   * この実施で異常時の記録がある園児を、カードで強調して示す。ほかの職員が画面を見ても、
   * 異常があったことが分かるようにする（基本設計書「異常時の記録」(4-7) 処理内容 2「クラス全体の午睡状況の確認で
   * 強調表示する」、図/画面詳細図.md「異常時記録画面」(5-2) 項目7。GitHub Issue #142）。
   * 【仮置き】強調の形（カードの印と枠）は設計が定めていない（web/仮置き値.md）
   */
  const abnormals = useAsync(async () => (activeId !== null ? api.abnormals(user!) : []), [activeId, tick],
    { live: onNapClass(classId) });
  const abnormalAt = new Map<string, { found: string; recorded: string }>();
  for (const a of abnormals.data ?? []) {
    if (a.nap_session_id !== activeId) continue;
    const seen = abnormalAt.get(a.child_id);
    if (!seen || (a.recorded_at ?? a.found_at) > seen.recorded) abnormalAt.set(a.child_id, { found: a.found_at, recorded: a.recorded_at ?? a.found_at });
  }

  // 選べるクラスが無い（クラスを持たない管理者など）。ほかのクラスの実施を表示しない。
  // 担当クラスの無い一般（フリー）は全クラスを選べ、閲覧のみ（GitHub Issue #127・#279）
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
      {s && <NapTimer startedAt={s.started_at} intervalMinutes={intervalMinutes} rows={rows} nowMs={nowMs}
        ready={!!state.data && !state.loading} />}

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

      {sessionLoading && <Loading />}

      {!sessionLoading && !s && (
        <section className="card">
          {autoClosed
            ? <Alert>午睡の時間帯を過ぎたため、午睡チェックを自動で終了しました。続けるときは、もう一度開始してください。</Alert>
            : <Empty text="午睡チェックはまだ開始していません。" />}
          {readOnly ? (
            <div className="muted" style={{ marginTop: 12 }}>全クラスを閲覧のみで見られます。午睡チェックの開始・記録はできません。</div>
          ) : (<>
          <div className="row-end">
            <button ref={startButton} className="btn-primary" onClick={start}>午睡チェックを開始する</button>
          </div>
          <div className="muted" style={{ marginTop: 12 }}>
            開始すると、この画面は開いたままの運用になります。実施中は自動ログアウトの対象外です。
            {/* 実施中は自動ログアウトの対象外（基本設計書「画面遷移」(3-4)） */}
          </div>
          </>)}
        </section>
      )}

      {s && (
        <>
          <div ref={sessionHead} className="page-head">
            <span>記録済み {recorded} / {rows.length} 名</span>
            <div className="spacer" />
            {!readOnly && <Link className="btn" to="/staff/nap/abnormal">異常を記録する</Link>}
            {!readOnly && <button onClick={() => (recorded < rows.length || stillSleeping.length > 0 ? setEnding(true) : end())}>午睡チェックを終了</button>}
          </div>
          {ending && (
            /* 終了すると、読み直しで「午睡チェックを終了」が消える。代わりに出る「午睡チェックを開始する」へ移す（GitHub Issue #213） */
            <ConfirmDialog title={recorded < rows.length ? '記録していない園児がいます' : '「おきた」が記録されていない園児がいます'}
              confirmLabel="このまま終了する" danger onConfirm={end} onCancel={() => setEnding(false)} returnTo={() => startButton.current}>
              {recorded < rows.length && <p>{rows.length - recorded} 名の記録がありません。このまま午睡チェックを終了しますか。</p>}
              {stillSleeping.length > 0 && <p>「おきた」が記録されていない園児がいます（{stillSleeping.join('、')}）。このまま終了しますか。</p>}
              <p className="muted">終了したあとは、この実施へ記録を足せません。</p>
            </ConfirmDialog>
          )}

          {state.loading && <Loading />}
          {state.error && <ErrorBox text={state.error} />}

          <div className="nap-grid">
            {allRows.map((r) => (
              <NapRecordRow key={r.child.child_id} row={r} sessionId={s.nap_session_id}
                due={isDue(r.latest?.checked_at ?? null)} abnormal={abnormalAt.get(r.child.child_id) ?? null}
                onSaved={() => setTick((n) => n + 1)} readOnly={readOnly} />
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
function NapTimer({ startedAt, intervalMinutes, rows, nowMs, ready }: {
  startedAt: string; intervalMinutes: number; rows: { latest: { checked_at: string } | null }[];
  /** 画面の時計（1秒ごと。親が持つ。園児の行の警告色と同じ時刻で動かす） */
  nowMs: number;
  /** 園児の行を読み込み終えたか。読み込む前の空の一覧を起点にして、開いたときに読まないようにする */
  ready: boolean;
}) {
  /*
   * 開始時刻・記録の時刻は日本時間の文字列で届く。端末の現地時刻として読むと、日本時間以外の端末で
   * 時差のぶんだけずれるため、jstMs で日本時間として読む（MOCKUP.md「日本標準時（JST）に固定している」、
   * 図/画面詳細図.md「端末の時計から日本時間を求めている」。GitHub Issue #165）
   */
  const startMs = jstMs(startedAt);
  const elapsed = Math.max(0, Math.floor((nowMs - startMs) / 1000));

  /*
   * いちばん長く確認していない園児を起点に、次のチェックまでを数える。
   * 1人を記録しただけでは次の間隔へ進まない。全員を確認し終えてはじめて進む。
   */
  const baseMs = jstMs(napTimerBase(startedAt, rows.map((r) => r.latest?.checked_at ?? null)));
  const dueMs = baseMs + intervalMinutes * 60_000;
  const remain = Math.floor((dueMs - nowMs) / 1000);
  const over = remain < 0;
  // 確認の時刻を過ぎている園児の数。未記録の園児は開始時刻から数える
  const dueCount = rows.filter((r) =>
    jstMs(r.latest?.checked_at ?? startedAt) + intervalMinutes * 60_000 <= nowMs).length;
  const overText = `チェックの時刻を過ぎています（未確認 ${dueCount} 名）`;

  /*
   * 読み上げへは、確認の時刻を過ぎた子が増えたときだけ、そのときの「未確認 n 名」をまとめて1回伝える
   * （詳細設計書「全画面に共通する部品と決まり」(2-0) の (6) の③、GitHub Issue #209）。
   * 記録して数が減ったとき・時刻の前に戻ったときは伝えない（数を読み続けると、記録している途中の読み上げが途切れる）。
   * 見えている文は今までどおり毎秒の数を出す。開いたときは、そのときの数を起点にして読まない。
   *
   * 通知音も、読み上げと同じ契機（確認の時刻を過ぎた子が増えたとき）に1回鳴らす（GitHub Issue #298。
   * 基本設計書「午睡チェックの実施」(4-8) の処理 4「通知音を伴って知らせる」）。鳴らす回数・止め方は設計が定めていない：
   * 【仮置き】3つの音を1回。自分で止まり、止める操作は置かない。時刻を過ぎたままの間は鳴らし直さない（web/仮置き値.md）
   */
  const sound = useNapSound(true);
  const playAlarm = sound.play;
  const [said, setSaid] = useState<{ text: string; seq: number } | null>(null);
  const lastDue = useRef<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    const before = lastDue.current;
    lastDue.current = dueCount;
    if (before !== null && dueCount > before) {
      setSaid((s) => ({ text: overText, seq: (s?.seq ?? 0) + 1 }));
      playAlarm();
    }
  }, [dueCount, ready, overText, playAlarm]);

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

  /*
   * 上に止めたタイマーの高さを、スクロールする枠（.main）へ --nap-timer-h として渡す。
   * 枠はその高さぶんを scroll-padding-top に取り、キーボードで上へ戻ったとき（Shift+Tab）に、
   * フォーカスした部品がタイマーの下へ隠れないようにする（WCAG 2.4.11 フォーカスの非隠蔽、GitHub Issue #212）。
   * タイマーは幅によって折り返し、高さが変わるので、決めた値でなく測った値を使う
   */
  const timerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = timerRef.current;
    const main = timer?.closest<HTMLElement>('.main');
    if (!timer || !main || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      main.style.setProperty('--nap-timer-h', `${timer.getBoundingClientRect().height}px`);
    });
    observer.observe(timer);
    return () => { observer.disconnect(); main.style.removeProperty('--nap-timer-h'); };
  }, []);

  return (
    <div ref={timerRef} className={`nap-timer${over ? ' over' : ''}`}>
      <div>
        <div className="muted">{over ? overText : '次のチェックまで'}</div>
        <div className="sr-only" role="status">{said && <span key={said.seq}>{said.text}</span>}</div>
        <div className="big">{over ? `+${mmss(remain)}` : mmss(remain)}</div>
        {/* 音を出せる状態でないとき。触れば出せるようになる。音と色だけに頼らず、文でも伝える。【仮置き】文言（web/仮置き値.md） */}
        {(!sound.supported || sound.ready === false) && (
          <div className="nap-sound-notice">
            {sound.supported
              ? '通知音が出る状態になっていません。画面を一度さわってください。'
              : 'この端末では通知音を出せません。巡回の時刻を、画面のタイマーで確かめてください。'}
          </div>
        )}
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
function NapRecordRow({ row, sessionId, due, abnormal, onSaved, readOnly }: {
  row: NapChildState; sessionId: number; due: boolean; abnormal: { found: string; recorded: string } | null; onSaved: () => void;
  /** 閲覧のみ（担当クラスの無い一般＝フリー）。記録の操作を出さない */
  readOnly?: boolean;
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
  // 対象外の子は、5分ごとの確認の欄を薄くする（詳細設計書「行の状態ごとの表示」(2-4 (2))）
  const excluded = !!row.exclusion;

  // 「保存しました」は確認の画面を出さない記録の、唯一の手応え。保存後の読み直しで前回の記録が
  // 新しくなっても消さず、一定時間たつか、次の入力を始めたときに消す（仮置き値.md）
  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), SAVED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [justSaved]);
  const startInput = <T,>(set: (value: T) => void) => (value: T) => { setJustSaved(false); set(value); };

  /*
   * 「この子を記録」は、記録すると選択が空に戻って無効になり、押したボタンからフォーカスが外れて body に落ちる。
   * 押したときにボタンにフォーカスがあった（キーボードで押したときなど）ら、次の園児の行の最初の選択肢へ移す。
   * 巡回の順に次の子へ進めるようにするため。最後の行では、記録した行の最初の選択肢へ戻す
   * （WCAG 2.4.3 フォーカス順序、GitHub Issue #213。共通の決まり：フォーカスを残すか、決めた場所へ移す）
   */
  const rowRef = useRef<HTMLElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  // 保存を終えて描き直したあとに、フォーカスを移す先。ボタンは保存している間は無効で、フォーカスを受け取れないため
  const focusAfterSave = useRef<'next-row' | 'button' | null>(null);
  useEffect(() => {
    if (busy || !focusAfterSave.current) return;
    const where = focusAfterSave.current;
    focusAfterSave.current = null;
    if (where === 'button') { saveRef.current?.focus(); return; }
    const current = rowRef.current;
    if (!current) return;
    const next = current.nextElementSibling;
    const target = next instanceof HTMLElement && next.matches('.nap-record-row') ? next : current;
    target.querySelector<HTMLInputElement>('input[type="radio"]')?.focus();
  }, [busy]);

  // 体温が範囲の外のときは、1度確かめてから記録する。記録は妨げない（園児の平熱と同じ範囲）
  const [confirmedTemp, setConfirmedTemp] = useState<number | null>(null);
  const save = async () => {
    if (busy || !position || !breathing || !complexion) return;
    if (temperature !== null && (temperature < TEMP_MIN || temperature > TEMP_MAX) && confirmedTemp !== temperature) {
      setConfirmedTemp(temperature);
      setError(`体温が ${TEMP_MIN.toFixed(1)}〜${TEMP_MAX.toFixed(1)}℃ の外です。入力に誤りがなければ、もう一度「この子を記録」を押してください。`);
      return;
    }
    // 保存している間もボタンは無効になるので、押した時点で調べておく
    const pressedWithFocus = document.activeElement === saveRef.current;
    setBusy(true); setError(null); setJustSaved(false);
    try {
      await api.record(user!, sessionId, {
        child_id: id, body_position: position, breathing, complexion, temperature,
      });
      setPosition(null); setBreathing(null); setComplexion(null); setTemperature(null); setConfirmedTemp(null);
      setJustSaved(true);
      onSaved();
      if (pressedWithFocus) focusAfterSave.current = 'next-row';
    } catch (e) {
      setError((e as Error).message);
      // 記録できなかったときは選択が残り、ボタンはまた押せるようになる。フォーカスをボタンへ戻す
      if (pressedWithFocus) focusAfterSave.current = 'button';
    } finally { setBusy(false); }
  };

  const temperatureText = `体温 ${temperature === null ? '未測定' : `${temperature.toFixed(1)}℃`}`;

  /*
   * 直近の記録で「呼吸 確認できず」としたのに、そのあとの異常時の記録が無いときは、その園児を選んだ状態で
   * 異常時記録画面へ移る導線を出す（図/画面詳細図.md「異常時記録画面」(5-2) 項目2「初期値：午睡チェック画面で選んでいた園児」、
   * 「午睡チェック画面」(5-1) 項目10。GitHub Issue #142）。発見時刻は分までで入るため、分の単位で比べる。
   * 【仮置き】導線を出す条件は設計が定めていない。発見時刻と保存時刻は別に扱う（web/仮置き値.md）。
   */
  const latest = row.latest;
  const needsAbnormal = !!latest && latest.breathing === '2'
    && !(abnormal && abnormal.recorded.slice(0, 16) >= latest.checked_at.slice(0, 16));

  return (
    <section ref={rowRef} className={`nap-card nap-record-row${!excluded && due ? ' is-due' : ''}${abnormal ? ' has-abnormal' : ''}${excluded ? ' is-excluded' : ''}`}
      aria-label={`${name}の午睡チェック`}>
      <div className="nap-row-head">
        <strong className="name">{name}</strong>
        {/*
          行の状態の文（「確認済み」「チェック時刻を過ぎています」など）は読み上げへ伝えない。時刻を過ぎると全員の行が同時に変わり、
          続けて何度も読むため（詳細設計書 (2-0) の (6) の③、GitHub Issue #209）。過ぎたことはタイマーの欄で読む。
          自分で記録した結果の「保存しました」だけを、行の見えない role="status" の欄で読む。結果の表示（notify()）は出さない：
          画面の下に重なり、続けて記録する次の行の体位・顔色・体温のボタンを隠すため（iPad 横 1180×820・縦 820×1180・744×1133・1440×900 で確かめた）。
          欄は前から置いておき（入れたときに読まれるように）、「保存しました」を出す間だけ中身を入れる。見えている文は二重に読まれないよう、その間は読み上げから外す
        */}
        <span className={`nap-row-status${!excluded && due ? ' due' : ''}`} aria-hidden={justSaved || undefined}>
          {justSaved ? '保存しました' : excluded ? 'きょうは対象外' : !row.latest ? (due ? '未記録（チェック時刻を過ぎています）' : '未記録') : due ? 'チェック時刻を過ぎています' : '確認済み'}
        </span>
        <span className="sr-only" role="status">{justSaved ? '保存しました' : ''}</span>
        <span className="last">{row.latest ? `前回 ${formatHM(row.latest.checked_at)} ${BODY_POSITION[row.latest.body_position]}` : '前回の記録なし'}</span>
        {latest && <LatestObservation record={latest} />}
        <span className="last">平熱 {formatTemperature(row.child.normal_temperature)}℃</span>
        {abnormal && <span className="tag tag-returned">異常時の記録あり {formatHM(abnormal.found)}</span>}
      </div>
      {!readOnly && (<>
      {/* ねた・おきた（保護者に届く）。5分ごとの確認と同じ行に置く */}
      <SleepControls row={row} sessionId={sessionId} onSaved={onSaved} />

      {needsAbnormal && latest && (
        <div className="row">
          <Alert>前回の記録で呼吸が確認できていません。異常時の記録を残してください。</Alert>
          <Link className="btn btn-sm" to="/staff/nap/abnormal"
            state={{ childId: id, observed: `${formatHM(latest.checked_at)} の午睡チェック：${observationText(latest)}` }}>
            異常時の記録を残す
          </Link>
        </div>
      )}

      <div className="nap-inline-fields">
        <NapChoices label="体位" name={`position-${id}`} options={BODY_POSITION} value={position} onChange={startInput(setPosition)} />
        <NapChoices label="呼吸" name={`breathing-${id}`} options={BREATHING} value={breathing} onChange={startInput(setBreathing)} />
        <NapChoices label="顔色" name={`complexion-${id}`} options={COMPLEXION} value={complexion} onChange={startInput(setComplexion)} />
      </div>

      {/*
        うつ伏せ：注意喚起であって判定ではなく、記録は妨げない。文は図/画面詳細図.md「午睡チェック画面」(5-1) の項目14
        「注意喚起」、詳細設計書.md「共通」(4-1) の「(6) 本書で足す文言」のとおり（第2.3版・第1.3版。PR #216、未マージ）。
        呼吸「確認できず」：記録より先に子どもへの対応と応援の要請を促し、異常時の記録はそのあとでよいと伝える。
        救命の手順そのものは書かない（同 (5-1) の項目10「呼吸」、利用手引き.md「午睡チェック（最も重要な運用）」(2-5)、
        要件定義書.md「午睡チェック」(4-5)「救急要請…の要否はシステムが判断せず、園の手順に従う」）。
        【仮置き】呼吸の文の言い回しは設計が定めていない（web/仮置き値.md）
      */}
      {position === '2' && <Alert>うつ伏せです。このまま記録し、仰向けに直したら、直したあとの向きをもう一度記録してください。</Alert>}
      {breathing === '2' && <Alert>呼吸が確認できません。ただちに、子どもへの対応と応援の要請を行ってください。異常時の記録は、そのあとでかまいません。</Alert>}
      {error && <Alert>{error}</Alert>}

      <div className="nap-row-actions">
        {/*
          読み上げの名前は「（氏名）の体温 未測定」「（氏名）の体温 36.5℃」。見えている文字をそのまま名前に含め、
          氏名を前に添える。見えている文字を名前に入れないと、いまの値が読み上げに入らず、
          見えている文字で音声操作もできない（WCAG 2.5.3 ラベルの中の名前、GitHub Issue #207）。
          氏名を .sr-only の要素で添えると、Chromium は要素の境目に空白を足し「（氏名）の 体温」になるため、
          見えている文字と同じ文字列から aria-label を作る
        */}
        <button type="button" className="nap-temperature-button" onClick={() => setTemperatureOpen(true)}
          aria-label={`${name}の${temperatureText}`}>
          {temperatureText}
        </button>
        {temperature !== null && <button type="button" className="btn-quiet btn-sm" onClick={() => setTemperature(null)}>体温を消す</button>}
        <div className="spacer" />
        <button ref={saveRef} type="button" className="btn-primary" onClick={save}
          disabled={busy || !position || !breathing || !complexion}>
          {busy ? '保存中…' : 'この子を記録'}
        </button>
      </div>

      {temperatureOpen && <TemperaturePicker name={name} onClose={() => setTemperatureOpen(false)}
        onSelect={(value) => { setTemperature(value); setTemperatureOpen(false); }} />}
      </>)}
    </section>
  );
}

/**
 * 直近の記録のうち、体位のほかに見ておくべきもの（呼吸が確認できない・顔色が通常でない・体温）を並べる。
 * あとから画面を見たほかの職員にも、記録した内容が分かるようにする（GitHub Issue #142）。
 * 保育士が選んだ値をそのまま示すだけで、システムは判定しない（平熱との比較もしない）。
 * 【仮置き】画面詳細図 5-1 項目7 はカードに時刻と体位を出すとだけ定めている（web/仮置き値.md）
 */
function LatestObservation({ record }: { record: NapRecord }) {
  return (
    <>
      {record.breathing === '2' && <span className="tag tag-returned">呼吸 {BREATHING[record.breathing]}</span>}
      {record.complexion !== '1' && <span className="tag tag-returned">顔色 {COMPLEXION[record.complexion]}</span>}
      {record.temperature !== null && <span className="last">体温 {formatTemperature(record.temperature)}℃</span>}
    </>
  );
}

/** 異常時記録画面へ添える、直近の記録の内容（体位・呼吸・顔色・体温） */
function observationText(record: NapRecord): string {
  const parts = [
    `体位 ${BODY_POSITION[record.body_position]}`, `呼吸 ${BREATHING[record.breathing]}`, `顔色 ${COMPLEXION[record.complexion]}`,
  ];
  if (record.temperature !== null) parts.push(`体温 ${formatTemperature(record.temperature)}℃`);
  return parts.join('・');
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
  /*
   * 手で入れる体温は小数第1位まで（基本設計書「入力項目の制約値」(4-9)、図/画面詳細図.md「午睡チェック画面」(5-1) 項目12）。
   * 表示だけを丸めて、記録には入れたままの桁が残るのを防ぐ（GitHub Issue #165）
   */
  const manualValue = Number(manual);
  const manualProblem = !manual ? null
    : !Number.isFinite(manualValue) ? '数値で入力してください'
      : !isOneDecimal(manualValue) ? '体温は小数第1位まで（例：34.9）で入力してください' : null;
  return (
    <Modal title={`${name}の体温`} onClose={onClose} footer={<button onClick={onClose}>閉じる</button>}>
      <div className="nap-temperature-picker">
        <p className="muted">体温計で測った値を選んでください。測っていない場合は閉じます。</p>
        <div className="nap-temp-heading">{whole === null ? '整数部分を選ぶ' : `${whole}℃ の小数部分を選ぶ`}</div>
        <div className={`nap-temp-grid${whole === null ? ' whole' : ''}`}>
          {whole === null
            ? [35, 36, 37, 38, 39, 40].map((n) => <button key={n} onClick={() => setWhole(n)}>{n}℃</button>)
            : Array.from({ length: 10 }, (_, n) => <button key={n} onClick={() => onSelect((whole * 10 + n) / 10)}>.{n}</button>)}
        </div>
        {whole !== null && <button className="btn-quiet btn-sm" onClick={() => setWhole(null)}>整数部分を選び直す</button>}
        <div className="nap-temp-manual">
          {manualOpen ? <>
            <label htmlFor={`temperature-manual-${name}`}>範囲外の体温</label>
            <input id={`temperature-manual-${name}`} type="number" inputMode="decimal" step="0.1" value={manual}
              onChange={(e) => setManual(e.target.value)} placeholder="例：34.9" />
            <button onClick={() => { if (manual && !manualProblem) onSelect(Math.round(manualValue * 10) / 10); }}
              disabled={!manual || !!manualProblem}>設定</button>
            {manualProblem && <div className="muted" role="alert">{manualProblem}</div>}
          </> : <button className="btn-quiet btn-sm" onClick={() => setManualOpen(true)}>範囲外の値を入力</button>}
        </div>
      </div>
    </Modal>
  );
}
