import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { LIVE_REFRESH_MS, subscribeLive, useLiveConnected } from './live';
import type { LiveEvent } from './live';

/**
 * 開いたままの画面で、ほかの人の操作（保護者からのチャット、職員の返信・承認など）を拾うために
 * 裏で読み直す間隔。
 *
 * 相手の操作は、サーバからの知らせ（live.ts。SSE）を受けてすぐに読み直す。この間隔の読み直しは、
 * 知らせが切れている間の保険である（ナレッジ/決定事項.md 2026-10-15「5秒ごとの読み直しは、接続が
 * 切れたときの保険として残す」）。つながっている間は LIVE_REFRESH_MS（30秒）まで延ばす。
 *
 * 【仮置き】5秒は設計に定めが無い（web/仮置き値.md）。チャットの返事を待つ間に気にならない長さとして置いた。
 */
export const AUTO_REFRESH_MS = 5_000;

export interface AsyncOptions {
  /**
   * 指定すると、この間隔で裏で読み直す（AUTO_REFRESH_MS を渡す）。
   * タブが隠れている間は止め、戻ったときに待たずに1回読む。
   * live も指定していて、サーバからの知らせがつながっている間は、LIVE_REFRESH_MS まで延ばす。
   */
  refreshMs?: number;
  /**
   * サーバからの知らせ（live.ts）のうち、この読み込みに関係するものを選ぶ（onLive・onRoom・onNapClass）。
   * 選んだ知らせが届いたら、読み込み中の表示を出さずに読み直す（refresh と同じ）。
   * つないだ・つなぎ直したときも、取りこぼしに備えて1回読み直す。
   * タブが隠れている間に届いた知らせでは読み直さず、戻ったときに1回読む。
   */
  live?: (e: LiveEvent) => boolean;
}

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** 読み込み中の表示を出して読み直す。条件を変えたときなど、いまの表示が古いと分かっているときに使う */
  reload: () => void;
  /**
   * 読み込み中の表示を出さずに読み直す。自分の操作のあとや、相手の操作を拾うときに使う。
   * 中身が変わっていなければ描き直さない。失敗しても、いまの表示をそのまま残す。
   * 読み込みの途中で呼ばれたら、終わったあとにもう1回読む（操作の結果を取りこぼさないため）
   */
  refresh: () => void;
}

/** 比べるための写し。写せないもの（循環する参照など）は、毎回「変わった」とみなす */
function snapshot(v: unknown): string | undefined {
  try { return JSON.stringify(v); } catch { return undefined; }
}

/** 非同期の読み込みを扱う。Go サーバへ差し替えても画面側は変わらない */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], options: AsyncOptions = {}): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // 裏の読み直しは、最後に描いたときの条件（チャンネルなど）で読む
  const latestFn = useRef(fn);
  useEffect(() => { latestFn.current = fn; });

  // 読み込み中の表示を出す読み込みのたびに進める。条件が変わる前に出した問い合わせの応答を捨てるため
  const generation = useRef(0);
  const foregroundBusy = useRef(false);
  const backgroundBusy = useRef(false);
  const queued = useRef(false);
  /*
   * 画面に出ている間だけ裏で読み直す。知らせ（live.ts）で積んだ読み直しが、画面を閉じたあとに走らないようにする。
   * 閉じた画面のための問い合わせは無駄であり、モックでは問い合わせのたびに午睡の自動解除などが走る
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // 最後に画面へ渡した値の写し。モック（api/mock.ts）は保持している実物をそのまま返すことがあり、
  // 渡した値そのものと比べると、書き換わっていても「同じ」に見えるため、写しで比べる
  const shown = useRef<string | undefined>(undefined);
  // いま出している失敗の文言。消すものが無いときに setError を呼ぶと、同じ値でも1回描き直されるため
  const shownError = useRef<string | null>(null);
  const showError = useCallback((v: string | null) => {
    shownError.current = v;
    setError(v);
  }, []);

  const background = useCallback((whenBusy: 'queue' | 'skip') => {
    if (!mounted.current) return;
    if (foregroundBusy.current || backgroundBusy.current) {
      if (whenBusy === 'queue') queued.current = true;
      return;
    }
    const gen = generation.current;
    backgroundBusy.current = true;
    latestFn.current()
      .then(
        (v) => {
          if (gen !== generation.current) return;
          const next = snapshot(v);
          // 変わっていなければ描き直さない。読み直しのたびに画面がちらつかないようにする
          if (next === undefined || next !== shown.current) {
            shown.current = next;
            setData(v);
          }
          // 最初の読み込みに失敗していた画面も、読み直しに成功したら元に戻す
          if (shownError.current !== null) showError(null);
        },
        // 裏の読み直しの失敗は画面に出さない。いまの表示を残し、次の回にまた読む
        () => {},
      )
      .finally(() => {
        backgroundBusy.current = false;
        if (queued.current) {
          queued.current = false;
          background('queue');
        }
      });
  }, [showError]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const refresh = useCallback(() => background('queue'), [background]);

  useEffect(() => {
    const gen = ++generation.current;
    foregroundBusy.current = true;
    setLoading(true);
    showError(null);
    const done = () => {
      foregroundBusy.current = false;
      setLoading(false);
      if (queued.current) {
        queued.current = false;
        background('queue');
      }
    };
    fn().then(
      (v) => {
        if (gen !== generation.current) return;
        shown.current = snapshot(v);
        setData(v);
        done();
      },
      (e: Error) => {
        if (gen !== generation.current) return;
        showError(e.message);
        done();
      },
    );
    return () => { generation.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  /*
   * サーバからの知らせを受けて読み直す。選び方（live）は描くたびに作り直されるため、最新のものを参照する。
   * 読み直しの途中で届いたら、終わったあとにもう1回読む（途中の応答が知らせより前の状態かもしれないため）
   */
  const liveFilter = useRef(options.live);
  useEffect(() => { liveFilter.current = options.live; });
  const subscribed = options.live !== undefined;
  useEffect(() => {
    if (!subscribed) return undefined;
    // 隠れている間に届いた知らせ。戻ったときに1回読む
    let missed = false;
    const unsubscribe = subscribeLive((s) => {
      if (s.type !== 'resync' && !liveFilter.current?.(s)) return;
      // 見ていない画面では読み直さない。チャットでは、読み直すと届いたメッセージが既読になってしまう
      if (typeof document !== 'undefined' && document.hidden) { missed = true; return; }
      background('queue');
    });
    const onVisibility = () => {
      if (document.hidden || !missed) return;
      missed = false;
      // 間隔の読み直し（useAutoRefresh）も戻ったときに1回読む。重ねて読まないよう、読んでいる途中なら任せる
      background('skip');
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unsubscribe();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [subscribed, background]);

  // 知らせがつながっている間は、間隔の読み直しを保険に回し、間隔を延ばす
  const liveConnected = useLiveConnected();
  const refreshMs = options.refreshMs !== undefined && subscribed && liveConnected
    ? Math.max(options.refreshMs, LIVE_REFRESH_MS)
    : options.refreshMs;
  useAutoRefresh(() => background('skip'), refreshMs);

  return { data, error, loading, reload, refresh };
}

/**
 * 一定の間隔で callback を呼ぶ。タブが隠れている間は止め、戻ったときに待たずに1回呼ぶ。
 * ms を渡さなければ何もしない。
 *
 * 隠れている間に止めるのは、見ていない画面のために問い合わせを続けないため。
 * 戻ったときに待たないのは、開き直した直後に古い表示を見せないため。
 */
export function useAutoRefresh(callback: () => void, ms: number | undefined): void {
  const latest = useRef(callback);
  useEffect(() => { latest.current = callback; });

  useEffect(() => {
    if (!ms || typeof document === 'undefined') return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => latest.current(), ms);
    };
    const stop = () => {
      if (timer !== null) { clearInterval(timer); timer = null; }
    };
    const onVisibility = () => {
      if (document.hidden) { stop(); return; }
      latest.current();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms]);
}

/** いちばん下とみなす余り。指やホイールで少し戻しただけなら、いちばん下にいるものとして扱う */
const FOLLOW_SLACK_PX = 48;

/** 縦に送れる、いちばん近い祖先（自分を含む）。見つからなければ null */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el; node; node = node.parentElement) {
    const y = getComputedStyle(node).overflowY;
    if (y === 'auto' || y === 'scroll') return node;
  }
  return null;
}

/**
 * チャンネルを開いたときは、いちばん下（最新）から見せる。
 * 開いたあとに新しいメッセージが届いたときは、いちばん下を読んでいた人だけを、いちばん下へ送る。
 * 上へ戻って読んでいる人の位置は動かさない。
 *
 * scope は表示している一覧が何のものか（チャンネル）。scope が変わったとき（チャンネルを開いた・
 * 切り替えたとき）は、そのチャンネルのメッセージが出たところで、いちばん下へ置く。
 * チャットのメッセージは直近から遡って見せる（基本設計書「一覧表示とページング」(3-7)、図/画面詳細図.md 4-1 No.4）。
 * 古いものから出すと、最新と、開いている間に届いたものが画面の外に残る（GitHub Issue #172）。
 * latest は一覧の最後のメッセージ。scope と latest が変わったときだけ見る。
 */
export function useFollowLatest(target: RefObject<HTMLElement | null>, scope: unknown, latest: unknown): void {
  const prev = useRef<{ scope: unknown; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollParent(target.current);
    if (!el) { prev.current = null; return; }
    const p = prev.current;
    // チャンネルのメッセージが初めて出た（開いた・切り替えた）。空のチャンネル（scope が無い）では何もしない
    const opened = scope !== null && scope !== undefined && (!p || p.scope !== scope);
    // 描き直す前の高さで、いちばん下にいたかを判定する。下に足されても scrollTop は変わらない
    const atBottom = !!p && p.scope === scope && p.height - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    if (opened || atBottom) {
      el.scrollTop = el.scrollHeight;
    }
    prev.current = { scope, height: el.scrollHeight };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, latest]);
}
