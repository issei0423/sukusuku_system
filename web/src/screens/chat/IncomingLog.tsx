/*
 * 相手から届いた新しいメッセージを、読み上げへ伝える欄（role="log"）
 * 典拠：詳細設計書「全画面に共通する部品と決まり」(2-0) の (6)「読み上げの範囲」の①（決めたこと D-57）、
 *      WCAG 4.1.3 ステータスメッセージ、GitHub Issue #209
 *
 * 開いているチャンネルに、相手（職員の画面では保護者・ほかの職員、保護者の画面では園）から届いたものだけを足す
 * （数え方は useIncomingMessages.ts）。自分が送ったもの（自分の操作の結果は role="status" で読む）は足さない。
 * 見えているメッセージの一覧そのものを role="log" にすると、自分が送ったものも一覧に足されて読まれ、
 * 「メッセージを送信しました」と重なる。そのため、一覧のすぐ後ろに見えない log の欄を置き、相手から届いたものだけを入れる。
 * 【仮置き】欄の置き場・欄の名前「届いたメッセージ」（web/仮置き値.md）
 */
import type { ChatMessage } from '../../api/types';
import { incomingText } from './useIncomingMessages';

export default function IncomingLog({ entries }: { entries: ChatMessage[] }) {
  return (
    <div className="sr-only" role="log" aria-label="届いたメッセージ">
      {entries.map((m) => <p key={m.chat_message_id}>{incomingText(m)}</p>)}
    </div>
  );
}
