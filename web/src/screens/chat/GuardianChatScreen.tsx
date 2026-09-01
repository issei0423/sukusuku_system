/*
 * チャット画面（保護者・スマートフォン）
 * 典拠：図/画面詳細図.md「チャット画面（保護者・スマートフォン）」(4-2)
 *
 * 保護者は個人チャットのみ送受信する。園全体・グループには投稿欄を表示しない。
 * 既読は保護者側には表示しない（基本設計書 5-5）。
 *
 * 【要確認】シングルカラムのため、一覧と各チャンネルが実際の画面遷移になる可能性がある。
 * 「画面の一覧」(3-2) は保護者・職員を通じてチャット画面の1画面として定義しているため、
 * 分けるなら同書の改訂が必要（図/画面遷移図.md「要確認事項」(8) No.2）。
 * モックでは1画面の中で一覧とスレッドを切り替える実装とし、遷移は起こしていない。
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

  // 一覧
  if (!current) {
    return (
      <div>
        <h1 style={{ marginBottom: 12 }}>チャット</h1>
        <div className="stack">
          {rooms.data?.map((r) => (
            <button key={r.room.chat_room_id} className="btn-block"
              style={{ justifyContent: 'space-between' }}
              onClick={() => setRoomId(r.room.chat_room_id)}>
              <span>{labelFor(r.room.room_type, r.room.room_name)}</span>
              {r.unread > 0 && <span className="tag tag-applied">{r.unread}</span>}
            </button>
          ))}
        </div>
        <div className="muted" style={{ marginTop: 16 }}>
          急なご連絡はお電話でお願いします。通知が届かない場合があります。
        </div>
      </div>
    );
  }

  // スレッド
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div className="page-head">
        <button className="btn-quiet btn-sm" onClick={() => setRoomId(null)}>&lt; もどる</button>
        <h1>{labelFor(current.room.room_type, current.room.room_name)}</h1>
      </div>

      <div style={{ flex: 1 }}>
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
                {mine ? '私' : accountName(m.sender_account_id)} {formatMD(m.sent_at.slice(0, 10))} {formatHM(m.sent_at)}
              </div>
              <div className="bubble">
                {m.body}
                {m.source_type === '2' && m.source_id && (
                  <Link className="shared-card" to={`/guardian/diary/${m.source_id}`}>
                    {formatMD(m.sent_at.slice(0, 10))} の記録を開く
                  </Link>
                )}
              </div>
              {/* 既読は保護者側には表示しない（基本設計書 5-5） */}
            </div>
          );
        })}
      </div>

      <div style={{ position: 'sticky', bottom: 0, background: 'var(--c-surface)', paddingTop: 8 }}>
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
