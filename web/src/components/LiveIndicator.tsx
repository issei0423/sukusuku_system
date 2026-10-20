/*
 * 相手の操作がすぐに出る状態かを、職員のヘッダに小さく示す
 * 典拠：詳細設計書「つながっているかの表示」(2-8)・「つながっているかの3つの状態の決め方」(6-6)、
 *      基本設計書「つながっているかの表示」(3-5)、src/live.ts
 *
 * 3つの状態を出す。つながっている間は「すぐに反映」、知らせが切れている間は「自動で読み直しています」、
 * サーバに届かないときは「サーバにつながりません」。画面の上端の帯（ConnectionBanner）は別に出す。
 * 接続を使っていないとき（ログイン前・モック）は何も出さない。
 *
 * 色だけに頼らないよう、文言でも示す。縦向きの狭い幅（900px 以下）でも文言を見せ、点の色だけにしない
 * （WCAG 1.4.1 色の使用。GitHub Issue #211。タブレットのタッチでは title が出ないため）。
 * 入りきらない幅では、文言を区切りの位置で2行に折り返す（styles/app.css）。読み上げる文は折り返しても変わらない。
 * 【仮置き】点にかざしたときの説明の文と色、折り返す位置は設計に定めが無い（web/仮置き値.md「開いたままの画面の読み直し（自動更新）」）。
 */
import { Fragment } from 'react';
import { useConnectionState, useLiveStatus, type ConnectionState } from '../live';
import { TEXT } from '../messages';

/** 【仮置き】点にかざしたときの説明（web/仮置き値.md） */
const LIVE_TITLE = {
  connected: 'ほかの人の操作が、すぐに画面に出ます',
  disconnected: 'サーバとのつながりが切れているため、数秒ごとに読み直しています',
  unreachable: 'サーバに届きません。押した操作は保存されていません',
} as const;

/** 文言を head のあとで2つに区切る。head で始まらなければ区切らない */
function splitAfter(text: string, head: string): readonly string[] {
  return text.startsWith(head) && text.length > head.length ? [head, text.slice(head.length)] : [text];
}

/**
 * 【仮置き】ヘッダに出す文言の区切り（web/仮置き値.md）。
 * 区切りの切れ目が、狭い幅で2行に折り返す位置（<wbr>）。つなげた文が TEXT の文言で、見せる文・読み上げる文になる
 */
const LIVE_PHRASES: Record<ConnectionState, readonly string[]> = {
  connected: [TEXT.liveOpen],
  disconnected: splitAfter(TEXT.liveFallback, '自動で'),
  unreachable: splitAfter(TEXT.unreachable, 'サーバに'),
};

export default function LiveIndicator() {
  const status = useLiveStatus();
  const state = useConnectionState();
  if (status === 'off') return null;
  const phrases = LIVE_PHRASES[state];
  return (
    <span className={`live-indicator ${state === 'connected' ? 'is-open' : 'is-fallback'}`} role="status" title={LIVE_TITLE[state]}>
      <span className="live-dot" aria-hidden="true" />
      <span className="live-text">
        {phrases.map((p, i) => <Fragment key={p}>{i > 0 && <wbr />}{p}</Fragment>)}
      </span>
    </span>
  );
}
