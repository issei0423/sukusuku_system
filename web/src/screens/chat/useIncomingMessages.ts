/*
 * 相手から届いた新しいメッセージを数える（読み上げへ伝える欄 IncomingLog.tsx に渡す）
 * 典拠：詳細設計書「全画面に共通する部品と決まり」(2-0) の (6)「読み上げの範囲」の①（決めたこと D-57）、
 *      WCAG 4.1.3 ステータスメッセージ、GitHub Issue #209
 */
import { useEffect, useRef, useState } from 'react';
import { accountName } from '../../api/client';
import { SENDER_KIND } from '../../api/codes';
import type { ChatMessage } from '../../api/types';

/** 欄に残す件数。古いものは消す（消したことは読まれない）。【仮置き】（web/仮置き値.md） */
const KEEP = 20;

/**
 * 開いているチャンネルに相手から新しく届いたメッセージを、届いた順に返す。
 * 自分が送ったもの・取り消されたもの・開いたときに並んでいたもの・編集・リアクションは含めない。
 * 読み込み中の表示を出す読み込み（チャンネルを替えたとき）が済むまでは、前のチャンネルの一覧を新しいものと取り違えないよう待つ。
 * 済んだ時点の一覧を「開いたときに並んでいたもの」とし、そのあと増えたものだけを数える
 */
export function useIncomingMessages(list: ChatMessage[] | null | undefined, loading: boolean,
  roomId: number | null, me: number): ChatMessage[] {
  const seen = useRef<{ room: number | null; ids: Set<number> | null; loaded: boolean }>({ room: null, ids: null, loaded: false });
  const [entries, setEntries] = useState<{ room: number | null; items: ChatMessage[] }>({ room: null, items: [] });
  useEffect(() => {
    const s = seen.current;
    if (s.room !== roomId) {
      s.room = roomId;
      s.ids = null;
      s.loaded = false;
    }
    if (loading) { s.loaded = true; return; }
    if (roomId === null || !list || !s.loaded || list.some((m) => m.chat_room_id !== roomId)) return;
    if (s.ids === null) {
      s.ids = new Set(list.map((m) => m.chat_message_id));
      return;
    }
    const ids = s.ids;
    const fresh = list.filter((m) => !ids.has(m.chat_message_id));
    fresh.forEach((m) => ids.add(m.chat_message_id));
    const incoming = fresh.filter((m) => m.sender_account_id !== me && !m.is_deleted);
    if (incoming.length === 0) return;
    setEntries((e) => ({ room: roomId, items: [...(e.room === roomId ? e.items : []), ...incoming].slice(-KEEP) }));
  }, [list, loading, roomId, me]);
  return entries.room === roomId ? entries.items : [];
}

/** 読み上げる文。「高梨 倫太朗（職員）から：本文」【仮置き】（web/仮置き値.md） */
export function incomingText(m: ChatMessage): string {
  const who = m.sender_name ?? accountName(m.sender_account_id);
  const kind = m.sender_role ? `（${SENDER_KIND[m.sender_role]}）` : '';
  return `${who}${kind}から：${m.body}`;
}
