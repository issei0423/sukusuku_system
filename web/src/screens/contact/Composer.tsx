/*
 * 段2を書いて送る欄（園からのひとこと・活動のひとこと）
 * 典拠：詳細設計書「園からのひとことを送る」(2-3 (3))・「きょうのようすを足す・直す」(2-3 (4))・「押したときの処理の型」(2-0 (2))、
 *      図/画面詳細図「宛先の表示」(1-3 (1))・「他児の名前の注意」(1-3 (3))・「定型文の候補」(1-3 (5))
 *
 * 入力の順番は「選ぶ → 定型文 → 手で直す」（AI の下書きは次の段。無くても届けられる）。
 * 「送る」のすぐ上に宛先を大きく示す（この表示が確認を兼ね、別の確認のダイアログは挟まない）。
 * サーバが他児の名前に当たったときだけ「他児の名前の注意」を開き、「このまま送る」で承諾を付けて送り直す（決めたこと D-4）。
 * 押したらサーバの応答を待つ（楽観的更新をしない）。送れなかったら入力を残し、近くに何が違うかを出す。
 * 書きかけは保存しない。書きかけのままログアウトしようとしたら、消えることを確かめる。
 */
import { useId, useRef, useState } from 'react';
import type { ContactRecipient, NameMatch, Phrase } from '../../api/shapes';
import { useReachable } from '../../api/reachability';
import { useUnsavedInput } from '../../unsavedInput';
import { focusAfter, focusedNow } from '../../focusAfter';
import { TEXT } from '../../messages';
import RecipientBadge from '../../components/RecipientBadge';
import NameCheckDialog from '../../components/NameCheckDialog';
import PhraseMenu from '../../components/PhraseMenu';

type SendError = Error & { kind?: string; names?: string[]; matches?: NameMatch[] };

export default function Composer({ label, max, scope, recipient, className, initial = '', submitLabel, onSend, onCancel, focusAfterSend }: {
  label: string;
  max: number;
  scope: Phrase['phrase_scope'];
  recipient: ContactRecipient | undefined;
  className: string | null;
  initial?: string;
  submitLabel: string;
  /** 送る。承諾した名前を受け取る。送れなかったら投げる（入力は残る） */
  onSend: (body: string, acknowledged: string[]) => Promise<void>;
  onCancel?: () => void;
  /**
   * 送ったあとのフォーカスの移し先。送ったあとにこの欄ごと消えるとき（園から）に、呼んだ側が決める（送った文の「直す」など）。
   * 渡さなければ、空になった入力欄へ戻す（活動のひとこと）
   */
  focusAfterSend?: () => HTMLElement | null;
}) {
  const id = useId();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [check, setCheck] = useState<{ names: string[]; matches: NameMatch[]; text: string } | null>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const reachable = useReachable();
  useUnsavedInput(text.trim() !== '' && text !== initial);
  const left = max - [...text].length;

  /*
   * 「送る」「このまま送る」は送っている間に押せなくなり、押したボタンからフォーカスが外れる（「このまま送る」は窓ごと消える）。
   * 応答のあとに決めた場所へ移す（src/focusAfter.ts、WCAG 2.4.3、GitHub Issue #213）：
   * 送れた → focusAfterSend の場所か、空になった入力欄。送れなかった → 入力が残るので「送る」。
   * 他児の名前の注意が開くときは、注意の窓がフォーカスを受け取るので動かさない
   */
  const send = async (acknowledged: string[]) => {
    if (busy) return;
    const pressed = focusedNow();
    setBusy(true); setError(null);
    try {
      await onSend(text.trim(), acknowledged);
      setText(''); setCheck(null); setFailed(false);
      focusAfter(pressed, focusAfterSend ?? (() => input.current));
    } catch (e) {
      const err = e as SendError;
      if (err.kind === 'other_child_names' && err.names) {
        setCheck({ names: err.names, matches: err.matches ?? [], text: text.trim() });
      } else {
        setCheck(null);
        setError(err.message);
        setFailed(true);
        focusAfter(pressed, () => sendButton.current);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="contact-composer">
      <label className="contact-field" htmlFor={id}>
        <span>{label}</span>
      </label>
      <textarea ref={input} id={id} value={text} maxLength={max} onChange={(e) => setText(e.target.value)} disabled={busy} />
      <div className="contact-composer-tools">
        <PhraseMenu scope={scope} disabled={busy} onPick={(body) => setText((t) => (t ? `${t}${body}` : body).slice(0, max))} />
        <span className="muted contact-count" aria-live="polite">残り {left} 文字</span>
      </div>
      {recipient && <RecipientBadge recipient={recipient} className={className} />}
      {error && <p className="contact-error" role="alert">{error}</p>}
      <div className="contact-composer-actions">
        <button ref={sendButton} type="button" className="btn-primary" onClick={() => send([])} disabled={busy || text.trim() === ''} aria-busy={busy}>
          {busy ? TEXT.sending : failed && !reachable ? TEXT.resend : submitLabel}
        </button>
        {onCancel && <button type="button" onClick={onCancel} disabled={busy}>やめる</button>}
      </div>
      {check && (
        /*
         * 「直す」（Esc も同じ）で閉じたら、開いた元の「送る」へフォーカスを戻す。
         * 注意の窓は送ったあとの応答で開くため、開いた時点では送っている間に押せなくなった「送る」から
         * フォーカスが外れており、窓の部品（Modal）が覚える戻り先が無い（GitHub Issue #105 のモーダルのフォーカス、WCAG 2.4.3）
         */
        <NameCheckDialog names={check.names} matches={check.matches} text={check.text} busy={busy}
          onFix={() => { setCheck(null); sendButton.current?.focus(); }} onSend={() => send(check.names)} />
      )}
    </div>
  );
}
