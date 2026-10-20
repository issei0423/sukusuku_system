/*
 * 相手の操作がすぐに出る状態かを、職員のヘッダに小さく示す
 * 典拠：詳細設計書「つながっているかの表示」(2-8)・「つながっているかの3つの状態の決め方」(6-6)、
 *      基本設計書「つながっているかの表示」(3-5)、src/live.ts
 *
 * 3つの状態を出す。つながっている間は「すぐに反映」、知らせが切れている間は「自動で読み直しています」、
 * サーバに届かないときは「サーバにつながりません」。画面の上端の帯（ConnectionBanner）は別に出す。
 * 接続を使っていないとき（ログイン前・モック）は何も出さない。
 *
 * 色だけに頼らないよう、文言でも示す。狭い画面では文言を読み上げ用にだけ残し、点だけを見せる。
 * 【仮置き】点にかざしたときの説明の文と色は設計に定めが無い（web/仮置き値.md「開いたままの画面の読み直し（自動更新）」）。
 */
import { useConnectionState, useLiveStatus } from '../live';
import { TEXT } from '../messages';

/** 【仮置き】点にかざしたときの説明（web/仮置き値.md） */
const LIVE_TITLE = {
  connected: 'ほかの人の操作が、すぐに画面に出ます',
  disconnected: 'サーバとのつながりが切れているため、数秒ごとに読み直しています',
  unreachable: 'サーバに届きません。押した操作は保存されていません',
} as const;

export default function LiveIndicator() {
  const status = useLiveStatus();
  const state = useConnectionState();
  if (status === 'off') return null;
  const text = state === 'connected' ? TEXT.liveOpen : state === 'unreachable' ? TEXT.unreachable : TEXT.liveFallback;
  return (
    <span className={`live-indicator ${state === 'connected' ? 'is-open' : 'is-fallback'}`} role="status" title={LIVE_TITLE[state]}>
      <span className="live-dot" aria-hidden="true" />
      <span className="live-text">{text}</span>
    </span>
  );
}
