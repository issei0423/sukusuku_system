/*
 * 相手の操作を、開いている画面へすぐに届ける（Server-Sent Events）
 * 典拠：ナレッジ/決定事項.md 2026-10-15「相手の画面への反映は、SSE（Server-Sent Events）で即時にする」、
 *      設計方針（作り直しの案）「開いている画面：SSE」(5-1)、server/events.go
 *
 * ログインしている間、/api/events への接続をタブごとに1本つないだままにし、開いている画面すべてで共有する。
 * サーバは、変化を見てよい人へ「変わった」とだけ送ってくる（種類と ID だけ。中身は入っていない）。
 * 画面は知らせを受けたら、関係する読み込み（hooks.ts の useAsync）を既存の API で読み直す。
 *
 * 知らせは届かないことがある。保険として、つながっている間も LIVE_REFRESH_MS（30秒）ごとに読み直し、
 * 切れている間は AUTO_REFRESH_MS（5秒）ごとに読み直す。つないだ・つなぎ直したときは、すべてを読み直す。
 *
 * モック（npm run dev:mock・テスト）ではサーバにつながない。モックは書き込みのあとに、ブラウザの中で
 * 同じ知らせを出す（api/mock.ts の publish）。接続は無いため、つながっていない扱いのまま読み直しを続ける。
 */
import { useSyncExternalStore } from 'react';

/** 知らせの種類。サーバ（server/events.go の ev*）と同じ並び */
export type LiveEventType = 'chat' | 'diary' | 'handout' | 'nap' | 'development' | 'physical';

export interface LiveEvent {
  type: LiveEventType;
  /** chat：どのチャンネルが変わったか */
  room_id?: number;
  /** diary：どの日誌が変わったか */
  diary_id?: number;
  /** handout：どの配布物が変わったか */
  handout_id?: number;
  /** nap：どのクラスの午睡チェックか */
  class_id?: number;
  /** nap・development・physical：どの園児の記録か */
  child_id?: string;
}

/**
 * 受け取り口へ配るもの。resync は「知らせを取りこぼしたかもしれないので、全部読み直す」合図。
 * つながったとき・つなぎ直したとき・サーバに断られたときに出す
 */
export type LiveSignal = LiveEvent | { type: 'resync' };

/**
 * つながっている間の読み直しの間隔。知らせが届かなかったとき（取りこぼし）の保険。
 * 【仮置き】設計方針（作り直しの案）「開いている画面：SSE」(5-1) の案の値（web/仮置き値.md）
 */
export const LIVE_REFRESH_MS = 30_000;

/**
 * EventSource があきらめたとき（サーバが 401・502 などを返したとき）に、こちらでつなぎ直すまでの待ち。
 * 倍々に延ばし、上限で止める。通信が切れただけのときは EventSource が自分でつなぎ直す。
 * 【仮置き】設計に定めが無い（web/仮置き値.md）
 */
export const RECONNECT_MIN_MS = 3_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * 接続の状態。
 *   off        … 接続を使っていない（ログインしていない・モック）
 *   connecting … つないでいる途中・切れてつなぎ直しを待っている
 *   open       … つながっている
 */
export type LiveStatus = 'off' | 'connecting' | 'open';

/** EventSource.CLOSED。テストの偽物にも同じ値を持たせる */
const CLOSED = 2;

const listeners = new Set<(s: LiveSignal) => void>();
const watchers = new Set<() => void>();
let status: LiveStatus = 'off';

function setStatus(v: LiveStatus) {
  if (status === v) return;
  status = v;
  watchers.forEach((w) => w());
}

/** 開いている画面へ知らせを配る。サーバからの知らせと、モックの書き込みの知らせ（api/mock.ts）がここを通る */
export function emitLive(s: LiveSignal): void {
  listeners.forEach((l) => l(s));
}

/** 知らせを受け取る。返す関数で受け取りをやめる */
export function subscribeLive(listener: (s: LiveSignal) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** いまの接続の状態 */
export function liveStatus(): LiveStatus {
  return status;
}

/** いまつながっているか */
export function isLiveConnected(): boolean {
  return status === 'open';
}

/** 接続の状態を描画に使う。つながる・切れるたびに描き直す */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (cb) => { watchers.add(cb); return () => { watchers.delete(cb); }; },
    () => status,
    () => 'off',
  );
}

/** つながっているかを描画に使う */
export function useLiveConnected(): boolean {
  return useLiveStatus() === 'open';
}

/**
 * サーバにつなぐ。返す関数で切る。api/http.ts の connectLive が呼ぶ。
 *
 * 再接続は EventSource に任せる（サーバが retry で待ちを渡す）。ただし、サーバが 200 以外を返すと
 * EventSource はあきらめる（サーバの再起動中に間の仕組みが 502 を返したとき、セッションが消えて 401 に
 * なったときなど）。そのときは、画面に1回読み直させてから（401 なら画面が入口へ戻る。api/procedure.ts の
 * onSessionEnded）、待ってから新しくつなぎ直す。
 */
export function startLive(url = '/api/events'): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = RECONNECT_MIN_MS;
  let stopped = false;

  const open = () => {
    const es = new EventSource(url);
    source = es;
    es.onopen = () => {
      delay = RECONNECT_MIN_MS;
      setStatus('open');
      // つながるまで（切れていた間）に起きた変化は、知らせが届いていない。1回読み直させる
      emitLive({ type: 'resync' });
    };
    es.onmessage = (m: MessageEvent<string>) => {
      let e: LiveEvent;
      try { e = JSON.parse(m.data) as LiveEvent; } catch { return; }
      if (e && typeof e.type === 'string') emitLive(e);
    };
    es.onerror = () => {
      if (stopped) return;
      setStatus('connecting');
      if (es.readyState !== CLOSED) return;
      // サーバに断られた。セッションが切られていれば、読み直しで分かる（401 → 入口へ戻る）
      es.close();
      source = null;
      emitLive({ type: 'resync' });
      timer = setTimeout(() => {
        timer = null;
        if (!stopped) open();
      }, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    };
  };

  setStatus('connecting');
  open();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    source?.close();
    source = null;
    setStatus('off');
  };
}

/** 知らせの種類で絞る。useAsync の live に渡す */
export function onLive(...types: LiveEventType[]): (e: LiveEvent) => boolean {
  return (e) => types.includes(e.type);
}

/** そのチャンネルの知らせだけを通す。チャンネルを開いていなければ何も通さない */
export function onRoom(roomId: number | null): (e: LiveEvent) => boolean {
  return (e) => e.type === 'chat' && roomId !== null && e.room_id === roomId;
}

/** そのクラスの午睡チェックの知らせだけを通す */
export function onNapClass(classId: number): (e: LiveEvent) => boolean {
  return (e) => e.type === 'nap' && e.class_id === classId;
}
