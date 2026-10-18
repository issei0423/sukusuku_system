/*
 * 相手の操作がすぐに出る状態かを、職員のヘッダに小さく示す
 * 典拠：ナレッジ/決定事項.md 2026-10-15「相手の画面への反映は、SSE で即時にする。5秒ごとの読み直しは、
 *      接続が切れたときの保険として残す」、src/live.ts
 *
 * つながっている間は「すぐに反映」、切れている間（つなぎ直すまで）は「自動で読み直しています」と出す。
 * 切れていても画面は数秒ごとに読み直しているため、操作を止める必要は無いことを伝える。
 * 接続を使っていないとき（ログイン前・モック）は何も出さない。
 *
 * 【仮置き】出す場所・文言・色は設計に定めが無い（web/仮置き値.md「開いたままの画面の読み直し（自動更新）」）。
 * 色だけに頼らないよう、文言でも示す。縦向きの狭い幅（900px 以下）でも文言を見せ、点の色だけにしない
 * （WCAG 1.4.1 色の使用。GitHub Issue #211。タブレットのタッチでは title が出ないため）。
 * 入りきらない幅では、文言を区切りの位置で2行に折り返す（styles/app.css）。読み上げる文は折り返しても変わらない。
 */
import { Fragment } from 'react';
import { useLiveStatus } from '../live';

/**
 * 【仮置き】ヘッダに出す文言（web/仮置き値.md）。
 * 配列の切れ目が、狭い幅で2行に折り返す位置（<wbr>）。つなげた文が、見せる文・読み上げる文になる
 */
const LIVE_TEXT = {
  open: ['すぐに反映'],
  fallback: ['自動で', '読み直しています'],
  /** 点にかざしたときの説明 */
  openTitle: 'ほかの人の操作が、すぐに画面に出ます',
  fallbackTitle: 'サーバとのつながりが切れているため、数秒ごとに読み直しています',
} as const;

export default function LiveIndicator() {
  const status = useLiveStatus();
  if (status === 'off') return null;
  const open = status === 'open';
  const phrases = open ? LIVE_TEXT.open : LIVE_TEXT.fallback;
  return (
    <span className={`live-indicator ${open ? 'is-open' : 'is-fallback'}`} role="status"
      title={open ? LIVE_TEXT.openTitle : LIVE_TEXT.fallbackTitle}>
      <span className="live-dot" aria-hidden="true" />
      <span className="live-text">
        {phrases.map((p, i) => <Fragment key={p}>{i > 0 && <wbr />}{p}</Fragment>)}
      </span>
    </span>
  );
}
