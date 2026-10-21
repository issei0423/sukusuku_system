/*
 * 自動ログアウトの予告と「続ける」（GitHub Issue #210。2026-10-19 に持ち主が任せて決めた範囲）
 * 典拠：基本設計書.md「システムの利用方法」(2-2)・「ログイン」(4-3)「自動ログアウトは職員の画面に限り、最後の操作から
 *      時間を数える。午睡チェックの実施中は対象外」、WCAG 2.2 達成基準 2.2.1 タイミング調整可能（レベル A）
 *
 * 職員の共通レイアウト（layouts/StaffLayout.tsx）にだけ置く。保護者には自動ログアウトが無いので置かない。
 * 書きかけの日誌や園からのひとことを、気づかないうちに失わないためのもの。切れたときに書きかけを端末に残すことはしない
 * （共有の端末で、次に使う人に見えないように）。
 *
 * 期限はサーバが決める（server/api_session.go。モックは api/mock.ts の sessionStatus）。この部品のタイマーは
 * 「次にいつ尋ねるか」を決めるだけで、予告を出すか・閉じるかは、そのとき尋ねた期限で決める。
 *   - 長くても RECHECK_MS ごとに尋ねる。残りが WARN_BEFORE_MS 以下と返ったら予告を出す
 *   - 同じブラウザのほかのタブで操作・延長していれば、尋ねた期限が延びているので出さない（古い予告を出さない）
 *   - 出している間も POLL_WHILE_OPEN_MS ごとに尋ね、延びていれば閉じる。切れる時刻を過ぎたら尋ねた要求が 401 になり、
 *     App.tsx が入口へ戻す（api/procedure.ts の onSessionEnded）
 *   - 午睡チェックの実施中（nap_exempt）は出さない
 *   - タブを前に戻したときは、待たずに尋ねる（隠れたタブのタイマーはブラウザが遅らせるため）
 * 尋ねる要求は裏の読み直しとして送る（asAutomatic）。サーバも経路で見て、尋ねるだけでは延ばさない。
 *
 * 窓（role="alertdialog"）
 *   - 開いたら「続ける」にフォーカスを移す。Tab は窓の外へ出さない（押せるのは「続ける」だけ）
 *   - 「続ける」で期限を延ばし（extendSession。操作に数える）、窓を閉じ、前にいた部品へフォーカスを戻す
 *   - Esc と、窓の外を押したときも「続ける」と同じにする。閉じるだけにすると、予告が消えたまま切れてしまうため
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useSession } from '../session';
import { api, asAutomatic } from '../api/client';
import { formatHM } from '../api/util';
import type { SessionStatus } from '../api/shapes';
import { Alert } from './ui';

/** 【仮置き】切れる何ミリ秒前に予告を出すか。2分（web/仮置き値.md）。WCAG 2.2.1 の「20秒以上の猶予」を満たす */
const WARN_BEFORE_MS = 2 * 60_000;
/** 【仮置き】予告を出している間に、期限を尋ね直す間隔。5秒（web/仮置き値.md） */
const POLL_WHILE_OPEN_MS = 5_000;
/** 【仮置き】予告を出していない間に、期限を尋ね直すいちばん長い間隔。1分（web/仮置き値.md） */
const RECHECK_MS = 60_000;
/** 続けて尋ねすぎないための、いちばん短い間隔 */
const MIN_WAIT_MS = 1_000;

/** 【仮置き】文言。設計に無い（web/仮置き値.md） */
const SESSION_TIMEOUT_TEXT = {
  title: 'まもなくログアウトします',
  body: (hm: string) =>
    `しばらく操作が無いため、${hm} ごろに自動でログアウトします。保存していない入力は消えます。続けるときは「続ける」を押してください。`,
  continue: '続ける',
  failed: '続けられませんでした。通信の状態を確かめて、もう一度「続ける」を押してください。',
};

export default function SessionTimeoutWarning() {
  const { user } = useSession();
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // 延ばしたあとの期限を、尋ねたときと同じ扱いで受け取る
  const applyRef = useRef<((st: SessionStatus) => void) | null>(null);
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; });

  const accountId = user?.account_id;
  useEffect(() => {
    if (accountId === undefined) return undefined;
    let alive = true;
    let shown = false;
    let asking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(ask, Math.max(MIN_WAIT_MS, ms));
    };
    const hide = () => {
      shown = false;
      setExpiresAt(null);
      setFailed(false);
    };
    const apply = (st: SessionStatus) => {
      if (!alive) return;
      // 保護者には自動ログアウトが無い。尋ね直さない
      if (!st.auto_logout) { hide(); clearTimeout(timer); return; }
      // 午睡チェックの実施中は切れない。期限が決まらないので、間を置いて尋ね直す
      if (st.nap_exempt || st.remaining_seconds === null || st.expires_at === null) { hide(); schedule(RECHECK_MS); return; }
      const remaining = st.remaining_seconds * 1000;
      if (remaining > WARN_BEFORE_MS) { hide(); schedule(Math.min(remaining - WARN_BEFORE_MS, RECHECK_MS)); return; }
      shown = true;
      setExpiresAt(st.expires_at);
      // 切れる時刻を過ぎたらすぐ尋ね、切れたことを受け取る（401 で入口へ戻る）
      schedule(Math.min(POLL_WHILE_OPEN_MS, remaining + MIN_WAIT_MS));
    };
    function ask() {
      const me = userRef.current;
      if (!alive || asking || !me) return;
      asking = true;
      asAutomatic(() => api.sessionStatus(me))
        .then(apply, () => { if (alive) schedule(shown ? POLL_WHILE_OPEN_MS : RECHECK_MS); })
        .finally(() => { asking = false; });
    }
    applyRef.current = apply;

    const onVisibility = () => { if (!document.hidden) ask(); };
    document.addEventListener('visibilitychange', onVisibility);
    ask();
    return () => {
      alive = false;
      clearTimeout(timer);
      applyRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [accountId]);

  const onContinue = () => {
    const me = userRef.current;
    if (busy || !me) return;
    setBusy(true);
    setFailed(false);
    // 「続ける」は利用者の操作。印を付けずに送り、期限を延ばす
    api.extendSession(me).then(
      (st) => { setBusy(false); applyRef.current?.(st); },
      () => { setBusy(false); setFailed(true); },
    );
  };

  if (expiresAt === null) return null;
  return <WarningDialog expiresAt={expiresAt} busy={busy} failed={failed} onContinue={onContinue} />;
}

function WarningDialog({ expiresAt, busy, failed, onContinue }: {
  expiresAt: string; busy: boolean; failed: boolean; onContinue: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const latest = useRef(onContinue);
  useEffect(() => { latest.current = onContinue; });

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    button.current?.focus();
    // ほかの窓を開いたまま予告が出たときも、Esc・Tab はこの窓が受ける（先に受け取り、下の窓へ渡さない）
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        latest.current();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        button.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // 前にいた部品へ戻す。その部品が消えていたら本文へ
      if (before && before.isConnected) before.focus();
      else document.querySelector<HTMLElement>('main')?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={() => latest.current()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId}
        onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-head" id={titleId}>{SESSION_TIMEOUT_TEXT.title}</h2>
        <div className="modal-body">
          {failed && <Alert>{SESSION_TIMEOUT_TEXT.failed}</Alert>}
          <p id={bodyId}>{SESSION_TIMEOUT_TEXT.body(formatHM(expiresAt))}</p>
        </div>
        <div className="modal-foot">
          {/* 押している間も「続ける」からフォーカスを外さないよう、disabled ではなく aria-disabled にする */}
          <button ref={button} type="button" className="btn-primary" aria-disabled={busy || undefined}
            onClick={() => latest.current()}>
            {SESSION_TIMEOUT_TEXT.continue}
          </button>
        </div>
      </div>
    </div>
  );
}
