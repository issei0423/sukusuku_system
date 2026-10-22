/*
 * 定型文の候補（部品）
 * 典拠：詳細設計書「共通の部品」(2-0 (1)) の PhraseMenu・「定型文」(4-5 (4))、図/画面詳細図「定型文の候補」(1-3 (5))、
 *      基本設計書「定型文（m_phrase）」(5-9)
 *
 * 「定型文」を押すと、その欄の使う場所（1:園から 2:活動のひとこと 3:クラスのようす）の候補を出す。
 * 選ぶと入力欄の末尾へ足す（置き換えない）。打つたびに候補を出す形にはしない。文字を打たなくても届けられる。
 */
import { useEffect, useRef, useState } from 'react';
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
  /*
   * 候補は窓を開いたあとに読み込むので、開いた時点では窓の部品（Modal）が「閉じる」にフォーカスを入れる。
   * 読み込めたら最初の候補へ移す（WCAG 2.4.3 フォーカス順序、GitHub Issue #213）。2回目からは候補が先にあり、Modal が最初の候補に入れる。
   * 読み込む間に利用者が窓の中でほかへ移していたら動かさない
   */
  const listRef = useRef<HTMLDivElement>(null);
  const focusFirst = useRef(false);
  useEffect(() => {
    if (!open || !list || !focusFirst.current) return;
    focusFirst.current = false;
    const first = listRef.current?.querySelector<HTMLButtonElement>('button');
    const dialog = listRef.current?.closest<HTMLElement>('[role="dialog"]');
    const active = document.activeElement;
    const untouched = !active || active === document.body || active === dialog || !!dialog?.querySelector('.modal-foot')?.contains(active);
    if (first && untouched) first.focus();
  }, [open, list]);
  const show = () => {
    setOpen(true); setError(null);
    if (list === null) {
      focusFirst.current = true;
      api.contactPhrases(user!, scope).then(setList).catch((e: Error) => setError(e.message));
    }
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
          <div ref={listRef} className="phrase-list">
            {(list ?? []).map((p) => (
              <button key={p.phrase_id} type="button" onClick={() => { onPick(p.body); setOpen(false); }}>{p.body}</button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
