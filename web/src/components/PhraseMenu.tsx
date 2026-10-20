/*
 * 定型文の候補（部品）
 * 典拠：詳細設計書「共通の部品」(2-0 (1)) の PhraseMenu・「定型文」(4-5 (4))、図/画面詳細図「定型文の候補」(1-3 (5))、
 *      基本設計書「定型文（m_phrase）」(5-9)
 *
 * 「定型文」を押すと、その欄の使う場所（1:園から 2:活動のひとこと 3:クラスのようす）の候補を出す。
 * 選ぶと入力欄の末尾へ足す（置き換えない）。打つたびに候補を出す形にはしない。文字を打たなくても届けられる。
 */
import { useState } from 'react';
import { api } from '../api/client';
import type { Phrase } from '../api/shapes';
import { useSession } from '../session';
import { Modal } from './ui';

export default function PhraseMenu({ scope, disabled, onPick }: {
  scope: Phrase['phrase_scope']; disabled?: boolean; onPick: (body: string) => void;
}) {
  const { user } = useSession();
  const [list, setList] = useState<Phrase[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const show = () => {
    setOpen(true); setError(null);
    if (list === null) api.contactPhrases(user!, scope).then(setList).catch((e: Error) => setError(e.message));
  };
  return (
    <>
      <button type="button" className="contact-pick" onClick={show} disabled={disabled}>定型文</button>
      {/* 【仮置き】窓の題・説明・定型文が無いときの文（web/仮置き値.md） */}
      {open && (
        <Modal title="定型文を選ぶ" onClose={() => setOpen(false)}>
          <p className="muted">選ぶと、入力欄の終わりに足します。</p>
          {error && <p className="contact-error" role="alert">{error}</p>}
          {list === null && !error && <p>読み込んでいます…</p>}
          {list !== null && list.length === 0 && <p className="empty">定型文はまだありません。設定で園が登録します。</p>}
          <div className="phrase-list">
            {(list ?? []).map((p) => (
              <button key={p.phrase_id} type="button" onClick={() => { onPick(p.body); setOpen(false); }}>{p.body}</button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
