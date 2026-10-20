/*
 * 段2を書いて送る欄（園からのひとこと・活動のひとこと）
 * 典拠：詳細設計書「園からのひとことを送る」(2-3 (3))・「きょうのようすを足す・直す」(2-3 (4))・「押したときの処理の型」(2-0 (2))、
 *      図/画面詳細図「宛先の表示」(1-3 (1))・「他児の名前の注意」(1-3 (3))・「定型文の候補」(1-3 (5))
 *
 * 入力の順番は「選ぶ → 定型文 → AI の下書き → 手で直す」。AI の下書き（AiDraftPanel）は使えるときだけ出る任意の層で、
 * 無くても届けられる（詳細設計書「画面」(8-9)）。下書きは入力欄に入るだけで、送るのはこの欄の「送る」。
 * 「送る」のすぐ上に宛先を大きく示す（この表示が確認を兼ね、別の確認のダイアログは挟まない）。
 * サーバが他児の名前に当たったときだけ「他児の名前の注意」を開き、「このまま送る」で承諾を付けて送り直す（決めたこと D-4）。
 * 押したらサーバの応答を待つ（楽観的更新をしない）。送れなかったら入力を残し、近くに何が違うかを出す。
 * 書きかけは保存しない。書きかけのままログアウトしようとしたら、消えることを確かめる。
 */
import { useId, useRef, useState } from 'react';
import type { ContactRecipient, NameMatch, Phrase } from '../../api/shapes';
import { useReachable } from '../../api/reachability';
import { useUnsavedInput } from '../../unsavedInput';
import { TEXT } from '../../messages';
import RecipientBadge from '../../components/RecipientBadge';
import NameCheckDialog from '../../components/NameCheckDialog';
import PhraseMenu from '../../components/PhraseMenu';
import AiDraftPanel from '../../components/AiDraftPanel';
import type { AiField } from '../../api/shapes';

type SendError = Error & { kind?: string; names?: string[]; matches?: NameMatch[] };

export default function Composer({ label, max, scope, recipient, className, initial = '', submitLabel, onSend, onCancel, ai }: {
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
  /** AI の下書きを出す欄（今日のページだけ）。allowDraft は「AI で下書き」（園からのひとこと）を出すか */
  ai?: { childId: string; date: string; field: AiField; allowDraft: boolean };
}) {
  const id = useId();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [check, setCheck] = useState<{ names: string[]; matches: NameMatch[]; text: string } | null>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  // 送れたら AI の下書きの表示を初めからにする（下書きの注意や候補を、次の文に持ち越さない）
  const [sentCount, setSentCount] = useState(0);
  const reachable = useReachable();
  useUnsavedInput(text.trim() !== '' && text !== initial);
  const left = max - [...text].length;

  const send = async (acknowledged: string[]) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await onSend(text.trim(), acknowledged);
      setText(''); setCheck(null); setFailed(false); setSentCount((n) => n + 1);
    } catch (e) {
      const err = e as SendError;
      if (err.kind === 'other_child_names' && err.names) {
        setCheck({ names: err.names, matches: err.matches ?? [], text: text.trim() });
      } else {
        setCheck(null);
        setError(err.message);
        setFailed(true);
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
      <textarea id={id} value={text} maxLength={max} onChange={(e) => setText(e.target.value)} disabled={busy} />
      <div className="contact-composer-tools">
        <PhraseMenu scope={scope} disabled={busy} onPick={(body) => setText((t) => (t ? `${t}${body}` : body).slice(0, max))} />
        <span className="muted contact-count" aria-live="polite">残り {left} 文字</span>
      </div>
      {ai && (
        <AiDraftPanel key={sentCount} childId={ai.childId} date={ai.date} field={ai.field} max={max} allowDraft={ai.allowDraft}
          text={text} disabled={busy}
          onUse={(value, mode) => setText((t) => [...(mode === 'append' ? `${t}${value}` : value)].slice(0, max).join(''))} />
      )}
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
