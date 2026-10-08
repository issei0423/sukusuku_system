/*
 * リアクション
 * 典拠：要件定義書「チャットツール」(4-3)（メッセージに絵文字で反応する。全ロール）
 *
 * 付いているリアクションを人数つきで並べ、その横に付けるためのボタンを置く。
 * 同じ種別をもう一度押すと外れる。使える絵文字は仮置き（web/仮置き値.md）。
 *
 * 保護者のチャット画面は、付けるためのボタンを常には出さない（showAdd=false）。
 * メッセージを長押しして開く操作の一覧から付ける（GuardianChatScreen.tsx）。
 */
import { useState } from 'react';
import { REACTION } from '../api/codes';
import type { ReactionSummary } from '../api/types';

export default function Reactions({ reactions, onToggle, showAdd = true }: {
  reactions: ReactionSummary[]; onToggle: (reactionType: string) => void;
  /** 付けるためのボタンを出すか。保護者の画面は長押しの操作の一覧から付けるので出さない */
  showAdd?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!showAdd && reactions.length === 0) return null;
  return (
    <div className="reactions">
      {reactions.map((r) => (
        <button key={r.reaction_type} type="button"
          className={`reaction${r.mine ? ' mine' : ''}`}
          aria-label={`${REACTION[r.reaction_type]?.label ?? 'リアクション'} ${r.count}件${r.mine ? '（自分も付けています）' : ''}`}
          onClick={() => onToggle(r.reaction_type)}>
          <span aria-hidden="true">{REACTION[r.reaction_type]?.emoji ?? '?'}</span> {r.count}
        </button>
      ))}
      {showAdd && (
        <button type="button" className="reaction add" aria-expanded={open}
          onClick={() => setOpen((v) => !v)}>
          {open ? '閉じる' : 'リアクション'}
        </button>
      )}
      {showAdd && open && Object.entries(REACTION).map(([type, def]) => (
        <button key={type} type="button" className="reaction pick" aria-label={def.label} title={def.label}
          onClick={() => { onToggle(type); setOpen(false); }}>
          <span aria-hidden="true">{def.emoji}</span>
        </button>
      ))}
    </div>
  );
}
