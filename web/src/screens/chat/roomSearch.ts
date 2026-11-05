/*
 * 職員のチャット画面の「保護者との個人チャット」を、園児の名前で絞り込む
 * 典拠：図/画面詳細図.md「チャット画面（職員・タブレット／PC）」(4-1) 項目24「個人チャットの絞り込み」
 *      （クラスと園児名（よみでも）で、チャンネル一覧の個人チャットを絞り込む）のうち、園児名の文字の入力
 *
 * 画面の中だけで絞る。サーバ・モックの規則（参加・参照範囲）は変えない。一覧に出ているチャンネルの中から選ぶだけである。
 * 【仮置き】一致のしかた（web/仮置き値.md「個人チャットの絞り込み」）：
 *   - 部分一致。空白（半角・全角）を無視し、英字の大文字・小文字を問わない（全角・半角も NFKC でそろえる）
 *   - 照らすのは、一覧に出している名前（「〇〇の園とのやりとり」）のうち園児名の部分。
 *     「の園とのやりとり」まで照らすと、「園」「の」で全部の行が当たってしまうため
 *   - よみ（ふりがな）は照らさない。チャンネルの一覧のデータに、よみが無いため
 */
import type { ChatRoom } from '../../api/types';

/** 照らす前にそろえる。全角・半角（NFKC）、空白を除く、英字を小文字に */
export function normalizeRoomQuery(s: string): string {
  return s.normalize('NFKC').replace(/\s/g, '').toLowerCase();
}

/** 個人チャットの園児名。部屋の名前は「園児名の保護者」（詳細設計書「園児の登録と個人チャット」(4-9)） */
export function childNameOfRoom(room: Pick<ChatRoom, 'room_name'>): string {
  return room.room_name.replace(/の保護者$/, '');
}

/** 入れた文字に当たる個人チャットか。空（空白だけを含む）なら、すべて当たる */
export function matchesRoomQuery(room: Pick<ChatRoom, 'room_name'>, query: string): boolean {
  const q = normalizeRoomQuery(query);
  return q === '' || normalizeRoomQuery(childNameOfRoom(room)).includes(q);
}
