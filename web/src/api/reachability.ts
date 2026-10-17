/*
 * サーバに届くか（詳細設計書「画面の受け取り」(6-4)・「つながっているかの3つの状態の決め方」(6-6)）
 *
 * api/http.ts の request() が、通信の失敗・502・503（AI が下書きを返さなかったものを除く）・504・15秒の時間切れで
 * 「届かない」に、サーバからの応答で「届く」にする。届かない間は5秒ごとに GET /api/me を試み、応答があれば戻す。
 * 表示は live.ts の useConnectionState が SSE の接続の状態と合わせて決める（LiveIndicator・ConnectionBanner）。
 * モックはサーバにつながないため、ずっと「届く」のまま。
 */
import { useSyncExternalStore } from 'react';

/** 届かない間に /api/me を試みる間隔（詳細設計書 (6-6)。基本設計書の初期値） */
const PROBE_INTERVAL_MS = 5_000;
/** 1回の試みの上限（api/http.ts の要求と同じ。決めたこと D-19） */
const PROBE_TIMEOUT_MS = 15_000;

let reachable = true;
const watchers = new Set<() => void>();

export function setReachable(value: boolean): void {
  if (reachable === value) return;
  reachable = value;
  watchers.forEach((w) => w());
}

export function isReachable(): boolean {
  return reachable;
}

/** 届くかを描画に使う。変わるたびに描き直す */
export function useReachable(): boolean {
  return useSyncExternalStore(
    (cb) => { watchers.add(cb); return () => { watchers.delete(cb); }; },
    isReachable,
    () => true,
  );
}

let probe: ReturnType<typeof setInterval> | null = null;

/** 届かない間の試みを始める。返す関数で止める。live.ts の startLive がログイン中に1か所で呼ぶ */
export function startReachabilityProbe(): () => void {
  if (probe !== null) return () => {};
  probe = setInterval(async () => {
    if (reachable) return;
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      // 401（未ログイン）もサーバからの応答。502・503・504 は間の仕組みの応答で、まだ届いていない
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) setReachable(true);
    } catch {
      // 次の試みを待つ
    }
  }, PROBE_INTERVAL_MS);
  return () => {
    if (probe !== null) clearInterval(probe);
    probe = null;
  };
}
