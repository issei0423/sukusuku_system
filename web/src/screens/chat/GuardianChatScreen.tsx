/*
 * チャット画面（保護者・スマートフォン）
 * 典拠：図/画面詳細図.md「チャット画面（保護者・スマートフォン）」(4-2)
 *
 * 保護者は個人チャットのみ送受信する。園全体・グループには投稿欄を表示しない。
 * 既読は保護者側には表示しない（基本設計書 5-5）。
 *
 * シングルカラムだが、一覧と各チャンネルは1画面の中で入れ替える（画面遷移ではない）。
 * 2026/09/07 に「分けない」と決着した（基本設計書「画面の一覧」(3-2)）。
 * 分けても表示項目は増えず、画面数と図の分量だけが増えるため。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, accountName } from '../../api/client';
import { Loading, ErrorBox, Empty } from '../../components/ui';
import { formatHM, formatMD } from '../../api/util';

export default function GuardianChatScreen() {
  const { user } = useSession();
  const rooms = useAsync(() => api.rooms(user!), [user?.account_id]);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /*
   * 編集は送信者本人のみ。回数と期限の制限は設けず、既読が付いたあとも編集できる
   * （基本設計書「メッセージの編集」(4-6)）
   */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const messages = useAsync(async () => (roomId ? api.messages(user!, roomId) : []), [roomId, tick]);

  useEffect(() => {
    if (roomId) api.markRead(user!, roomId).then(() => rooms.reload());
  }, [roomId, tick]);

  if (rooms.loading) return <Loading />;
  if (rooms.error) return <ErrorBox text={rooms.error} />;

  const current = rooms.data?.find((r) => r.room.chat_room_id === roomId);

  const send = async () => {
    if (!roomId || !text.trim()) return;
    setError(null);
    try {
      await api.send(user!, roomId, text);
      setText('');
      setTick((n) => n + 1);
    } catch (e) { setError((e as Error).message); }
  };

  const saveEdit = async (messageId: number) => {
    setError(null);
    try {
      await api.edit(user!, messageId, draft);
      setEditingId(null);
      setTick((n) => n + 1);
    } catch (e) { setError((e as Error).message); }
  };

  // 一覧
  if (!current) {
    return (
      <div className="guardian-chat-list">
        <div className="guardian-page-intro">
          <span className="guardian-eyebrow">園とのやりとり</span>
          <h1>チャット・お知らせ</h1>
          <p>連絡先を選んで、メッセージを確認できます。</p>
        </div>
        <div className="guardian-room-list">
          {rooms.data?.map((r) => (
            <button key={r.room.chat_room_id} className="guardian-room-link"
              onClick={() => setRoomId(r.room.chat_room_id)}>
              <span>{labelFor(r.room.room_type, r.room.room_name)}</span>
              <span className="guardian-room-trailing">
                {r.unread > 0 && <span className="guardian-unread">{r.unread}</span>}
                <span aria-hidden="true">→</span>
              </span>
            </button>
          ))}
        </div>
        <div className="guardian-contact-note">
          急なご連絡はお電話でお願いします。通知が届かない場合があります。
        </div>
      </div>
    );
  }

  // スレッド
  return (
    <div className="guardian-chat-thread">
      <div className="page-head guardian-thread-heading">
        <button className="btn-quiet btn-sm" onClick={() => setRoomId(null)}>&lt; もどる</button>
        <h1>{labelFor(current.room.room_type, current.room.room_name)}</h1>
      </div>

      <div className="guardian-message-list">
        {messages.loading && <Loading />}
        {messages.error && <ErrorBox text={messages.error} />}
        {messages.data?.length === 0 && <Empty text="まだメッセージはありません。" />}
        {messages.data?.map((m) => {
          const mine = m.sender_account_id === user!.account_id;
          if (m.is_deleted) {
            return (
              <div key={m.chat_message_id} className="msg">
                <div className="bubble retracted">このメッセージは取り消されました</div>
              </div>
            );
          }
          return (
            <div key={m.chat_message_id} className={`msg${mine ? ' mine' : ''}`}>
              <div className="meta">
                {/*
                  送信者名はメッセージが持つものを使う。保護者にはアカウントの名簿を
                  返さないため、account_id からは引けない（api/types.ts の sender_name）
                */}
                {mine ? '私' : m.sender_name ?? accountName(m.sender_account_id)} {formatMD(m.sent_at.slice(0, 10))} {formatHM(m.sent_at)}
                {/* 編集済みの印は送信者・受信者の双方に出す（基本設計書「メッセージの編集」(4-6)） */}
                {m.edited_at && <span className="weak">（編集済み）</span>}
              </div>
              <div className="bubble">
                {editingId === m.chat_message_id ? (
                  <>
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                      maxLength={1000} rows={4} style={{ width: '100%', boxSizing: 'border-box' }} />
                    <div className="row-end" style={{ marginTop: 4 }}>
                      <button className="btn-sm" onClick={() => setEditingId(null)}>やめる</button>
                      <button className="btn-sm btn-primary" onClick={() => saveEdit(m.chat_message_id)}
                        disabled={!draft.trim()}>保存</button>
                    </div>
                  </>
                ) : (
                  m.body
                )}
                {/*
                  記録の共有は本文ではなくリンクとして出す。編集できるのは添え書きの本文だけで、
                  リンク先の記録は変わらないため、編集中もリンクは出したままにする（基本設計書 4-6）
                */}
                {m.source_type === '2' && m.source_id && (
                  <Link className="shared-card" to={`/guardian/diary/${m.source_id}`}>
                    {formatMD(m.sent_at.slice(0, 10))} の記録を開く
                  </Link>
                )}
              </div>
              {/* 既読は保護者側には表示しない（基本設計書 5-5） */}
              {/* 編集は送信者本人のみ（同 4-6）。既読が付いたあとも編集できる */}
              {mine && editingId !== m.chat_message_id && (
                <div className="row-end">
                  <button className="btn-sm btn-quiet"
                    onClick={() => { setDraft(m.body); setEditingId(m.chat_message_id); }}>編集</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="guardian-message-compose">
        {error && <ErrorBox text={error} />}
        {current.canPost ? (
          <div className="row">
            <input type="text" value={text} onChange={(e) => setText(e.target.value)}
              placeholder="メッセージを入力" style={{ flex: 1 }} />
            <button className="btn-primary" onClick={send} disabled={!text.trim()}>送信</button>
          </div>
        ) : (
          <div className="muted">こちらは園からのお知らせです。返信はできません。</div>
        )}
      </div>
    </div>
  );
}

function labelFor(type: string, name: string): string {
  if (type === '1') return '園からのお知らせ';
  if (type === '4') return '担任の先生とのやりとり';
  return name;
}
