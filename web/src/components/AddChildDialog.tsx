/*
 * 保護者のメニューの「お子さまの追加」（ダイアログ）
 * 典拠：詳細設計書「お子さまの追加」(2-15 (2))・経路 (4-15 (1))・決めたこと D-47・D-48、
 *      図/画面詳細図「お子さまの追加（保護者のメニュー）」(1-3 (7))、基本設計書「お子さまの追加（園児の追加紐づけ）」(4-3)
 *
 * ① 招待コードを入れて「コードを確認する」（POST /api/invitation/verify。ログインしている保護者には園児名が返る）
 * ② 「〇〇さんを追加します。」と続柄（初期値は最初に登録したときの続柄。「その他」は文字で20文字まで）、「やめる」「追加する」
 * ③ 「追加する」で POST /api/guardian/children。成功したら「〇〇さんを追加しました。」を出して閉じる（保護者ホームの読み直しは呼び出し側）
 * 誤り（コードが無効・使用済み・期限切れ・すでに追加した園児）は、ダイアログの中に出す。検査の担保はサーバ（server/api_guardian.go）
 */
import { useState } from 'react';
import { api } from '../api/client';
import type { SessionUser } from '../api/types';
import { ADD_CHILD_TEXT, MSG } from '../messages';
import { notify } from './feedback';
import { Field, Modal } from './ui';

/** 続柄の上限の文字数（詳細設計書「お子さまの追加」(4-15 (1))。server/api_guardian.go の relationshipMax） */
const RELATIONSHIP_MAX = 20;
const OTHER = 'その他';

/**
 * 最初に登録したときの続柄を、選択肢と「その他」の文字に分ける。【仮置き】選択肢に無い続柄は「その他」の文字に入れ、
 * 続柄が無ければ未選択にする（web/仮置き値.md）
 */
function splitRelationship(value: string): { choice: string; other: string } {
  if (!value) return { choice: '', other: '' };
  if (ADD_CHILD_TEXT.relationships.includes(value)) return { choice: value, other: '' };
  return { choice: OTHER, other: value };
}

export default function AddChildDialog({ user, onAdded, onClose }: {
  user: SessionUser;
  /** 追加できたあと。ダイアログを閉じ、保護者ホームを読み直させる */
  onAdded: (childId: string) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState('');
  // 確かめた園児の名前。コードを入れ直したら確かめ直す
  const [childName, setChildName] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const [other, setOther] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.verifyInvitationCode(code, user);
      const initial = splitRelationship(r.relationship ?? '');
      setChoice(initial.choice);
      setOther(initial.other);
      setChildName(r.child_name ?? '');
    } catch (err) {
      setChildName(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 送る続柄。【仮置き】「その他」で文字が空なら「その他」とする（新規登録と同じ値。web/仮置き値.md）
  const relationship = choice === OTHER ? (other.trim() || OTHER) : choice;

  const add = async () => {
    if (busy || childName === null) return;
    // 送る前に画面でも確かめる。検査の担保はサーバ側が行う
    if (!relationship || [...relationship].length > RELATIONSHIP_MAX) { setError(MSG.relationshipRequired); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.addChild(user, code, relationship);
      notify(ADD_CHILD_TEXT.added(childName));
      onAdded(r.child_id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const footer = childName === null
    ? <button type="button" onClick={onClose}>閉じる</button>
    : (
      <>
        <button type="button" onClick={onClose}>{ADD_CHILD_TEXT.cancel}</button>
        <button type="button" className="btn-primary" onClick={() => void add()} disabled={busy}>{ADD_CHILD_TEXT.submit}</button>
      </>
    );

  return (
    <Modal title={ADD_CHILD_TEXT.title} onClose={onClose} footer={footer}>
      {/* ① コードを入れる。新規登録画面と同じ形（大文字小文字を区別せず、ハイフンは省いてよい） */}
      <form className="stack" onSubmit={(e) => void verify(e)}>
        <Field label={ADD_CHILD_TEXT.codeLabel} required>
          <input type="text" value={code} autoComplete="off" autoCapitalize="characters" placeholder="ABCD-1234-EFGH"
            onChange={(e) => { setCode(e.target.value); setChildName(null); setError(null); }} />
        </Field>
        <button type="submit" disabled={busy || !code.trim()}>{ADD_CHILD_TEXT.verify}</button>
      </form>

      {/* ② 園児を確かめる */}
      {childName !== null && (
        <div className="stack">
          <p><strong>{ADD_CHILD_TEXT.confirm(childName)}</strong></p>
          <Field label={ADD_CHILD_TEXT.relationshipLabel} required>
            <select value={choice} onChange={(e) => { setChoice(e.target.value); setError(null); }}>
              {choice === '' && <option value="">{ADD_CHILD_TEXT.choose}</option>}
              {ADD_CHILD_TEXT.relationships.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          {choice === OTHER && (
            <>
              <Field label={ADD_CHILD_TEXT.otherLabel}>
                <input type="text" value={other} maxLength={RELATIONSHIP_MAX} onChange={(e) => setOther(e.target.value)} />
              </Field>
              <div className="muted" aria-live="polite">{ADD_CHILD_TEXT.otherHint} 残り {RELATIONSHIP_MAX - [...other].length} 文字</div>
            </>
          )}
        </div>
      )}

      {error && <p className="contact-error" role="alert">{error}</p>}
    </Modal>
  );
}
