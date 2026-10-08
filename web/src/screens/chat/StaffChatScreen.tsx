/*
 * チャット画面（職員・タブレット／PC）
 * 典拠：図/画面詳細図.md「チャット画面（職員・タブレット／PC）」(4-1)
 *
 * チャンネルの切替は画面遷移ではない。メッセージ領域が入れ替わるだけ。
 * 未読はチャンネル一覧に件数で示す。既読はメッセージ側に人数で示す。
 * 園全体は一般には投稿欄を表示しない（閲覧のみ）。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, accountName } from '../../api/client';
import { Loading, ErrorBox, Empty, Alert, Tag } from '../../components/ui';
import Reactions from '../../components/Reactions';
import { CHAT_ROOM_TYPE, THREAD_STATUS } from '../../api/codes';
import { formatHM, formatMD } from '../../api/util';
import type { ChatMessage } from '../../api/types';

export default function StaffChatScreen() {
  const { user } = useSession();
  const rooms = useAsync(() => api.rooms(user!), [user?.account_id]);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (roomId === null && rooms.data && rooms.data.length > 0) setRoomId(rooms.data[0].room.chat_room_id);
  }, [rooms.data]);

  const messages = useAsync(
    async () => (roomId ? api.messages(user!, roomId) : []),
    [roomId, tick],
  );
  const members = useAsync(async () => (roomId ? api.members(roomId, user!) : []), [roomId]);

  // 開いたチャンネルは既読にする
  useEffect(() => {
    if (roomId) api.markRead(user!, roomId).then(() => rooms.reload());
  }, [roomId, tick]);

  const current = rooms.data?.find((r) => r.room.chat_room_id === roomId);

  /*
   * 園チャット（room_type=1）だけは、管理者同士なら互いのメッセージを編集できる
   * （基本設計書「メッセージの編集」(4-6)）。園全体への発信は園としての意思表示であり、
   * 発信者個人のものではないため。他のチャンネルは送信者本人だけが編集できる
   */
  const schoolWideAdmin = current?.room.room_type === '1' && user!.role === '1';

  const send = async () => {
    if (!roomId || !text.trim()) return;
    setError(null);
    try {
      await api.send(user!, roomId, text);
      setText('');
      setTick((n) => n + 1);
    } catch (e) { setError((e as Error).message); }
  };

  /*
   * 個人チャットのスレッドを「未対応／対応済み」に切り替える（要件定義書「チャットツール」(4-3)）。
   * 保護者から新しく受信すると、サーバ側で自動的に未対応へ戻る
   */
  const setThread = async (status: '1' | '2') => {
    if (!roomId) return;
    setError(null);
    try { await api.setThreadStatus(user!, roomId, status); rooms.reload(); }
    catch (e) { setError((e as Error).message); }
  };

  const react = async (messageId: number, type: string) => {
    setError(null);
    try { await api.toggleReaction(user!, messageId, type); setTick((n) => n + 1); }
    catch (e) { setError((e as Error).message); }
  };

  // チャンネルを開いたままでも一覧は最初の取得のものを使い続けるため、読み込み中の判定は初回だけにする
  if (rooms.loading && !rooms.data) return <Loading />;
  if (rooms.error) return <ErrorBox text={rooms.error} />;

  const unhandled = rooms.data?.filter((r) => r.room.room_type === '4' && r.room.thread_status === '1').length ?? 0;
  const staffMembers = members.data?.filter((m) => m.role !== '3') ?? [];
  const guardianMembers = members.data?.filter((m) => m.role === '3') ?? [];

  const grouped = [
    { label: '園・職員', types: ['1', '5'] },
    { label: 'クラス・グループ', types: ['2', '3'] },
    { label: '保護者との個人チャット', types: ['4'] },
  ];

  return (
    <div>
      <div className="page-head">
        <h1>チャット</h1>
        {unhandled > 0 && <Tag label={`未対応 ${unhandled} 件`} className="tag-returned" />}
        <div className="spacer" />
        {/* 園だより・献立表など、保護者があとから見返すものはこちらに掲載する */}
        <Link className="btn btn-sm" to="/staff/handouts">園からの配布物</Link>
        <Link className="btn btn-sm" to="/staff/chat/groups">グループ編成</Link>
      </div>

      <div className="chat3">
        {/* チャンネル一覧 */}
        <div className="chat-pane">
          <h2>チャンネル</h2>
          <div className="chat-scroll" style={{ padding: 0 }}>
            {grouped.map((g) => {
              const list = rooms.data!.filter((r) => g.types.includes(r.room.room_type));
              if (list.length === 0) return null;
              return (
                <div key={g.label}>
                  <div className="channel-group">{g.label}</div>
                  {list.map((r) => (
                    <button key={r.room.chat_room_id}
                      className={`channel${r.room.chat_room_id === roomId ? ' current' : ''}`}
                      onClick={() => setRoomId(r.room.chat_room_id)}>
                      <span>
                        {r.room.room_name}
                        {/* 保護者も読むチャンネルは、職員だけのチャンネルと見分けられるようにする */}
                        {r.room.room_type !== '4' && r.guardianCount > 0 && <span className="mark">保護者も参加</span>}
                        {r.room.room_type === '4' && r.room.thread_status === '1' && <span className="mark">未対応</span>}
                      </span>
                      {r.unread > 0 && <span className="unread">{r.unread}</span>}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* メッセージ */}
        <div className="chat-pane">
          <h2>
            {current ? current.room.room_name : 'チャンネルを選んでください'}
            {current && <span className="muted">（{CHAT_ROOM_TYPE[current.room.room_type]}）</span>}
            {/* 未対応スレッドの切り替えは個人チャットだけが持つ */}
            {current?.room.room_type === '4' && (
              <span style={{ float: 'right' }}>
                <Tag label={THREAD_STATUS[current.room.thread_status ?? '2'] ?? '対応済み'}
                  className={current.room.thread_status === '1' ? 'tag-returned' : 'tag-approved'} />
                {' '}
                {current.room.thread_status === '1'
                  ? <button className="btn-sm" onClick={() => setThread('2')}>対応済みにする</button>
                  : <button className="btn-sm" onClick={() => setThread('1')}>未対応に戻す</button>}
              </span>
            )}
          </h2>
          <div className="chat-scroll">
            {messages.loading && <Loading />}
            {messages.error && <ErrorBox text={messages.error} />}
            {messages.data?.length === 0 && <Empty text="まだメッセージはありません。" />}
            {messages.data?.map((m) => (
              <MessageRow key={m.chat_message_id} message={m} mine={m.sender_account_id === user!.account_id}
                canEdit={m.sender_account_id === user!.account_id || schoolWideAdmin}
                onReact={(type) => react(m.chat_message_id, type)}
                onRetract={async () => { await api.retract(user!, m.chat_message_id); setTick((n) => n + 1); }}
                onEdit={async (body) => { await api.edit(user!, m.chat_message_id, body); setTick((n) => n + 1); }} />
            ))}
          </div>
          <div className="chat-compose">
            {error && <ErrorBox text={error} />}
            {/*
              誰に届くかを入力欄のすぐ上に出す。メンバー一覧を見なくても、
              保護者が読むチャンネルだと送る前に気づけるようにする
            */}
            {current?.canPost && current.guardianCount > 0 && (
              <Alert soft>この投稿は、保護者 {current.guardianCount} 名にも届きます。</Alert>
            )}
            {current?.canPost && current.guardianCount === 0 && (
              <div className="muted">このチャンネルは職員だけが読みます。</div>
            )}
            {current?.canPost ? (
              <>
                <textarea value={text} onChange={(e) => setText(e.target.value)}
                  placeholder="メッセージを入力" style={{ minHeight: 70 }} />
                <div className="row-end">
                  <button onClick={() => alert('添付はモックでは未実装です')}>添付</button>
                  <button className="btn-primary" onClick={send} disabled={!text.trim()}>送信</button>
                </div>
              </>
            ) : (
              <div className="muted">
                {current?.room.room_type === '1'
                  ? 'このチャンネルは閲覧のみです。園全体への投稿は管理者が行います。'
                  : 'このチャンネルへは投稿できません。'}
              </div>
            )}
          </div>
        </div>

        {/* メンバー */}
        <div className="chat-pane">
          <h2>メンバー</h2>
          <div className="chat-scroll">
            {/* 職員と保護者を分けて並べる。保護者が入っているかをひと目で分かるようにするため */}
            <div className="member-group">職員 {staffMembers.length} 名</div>
            {staffMembers.map((m) => <div key={m.account_id}>{m.name}</div>)}
            {guardianMembers.length > 0 && (
              <>
                <div className="member-group">保護者 {guardianMembers.length} 名</div>
                {/* 続柄を添える。お迎えに来る人が誰なのかを職員が確かめられるようにするため */}
                {guardianMembers.map((m) => (
                  <div key={m.account_id}>{m.name}{m.relationship ? `（${m.relationship}）` : ''}</div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 1件のメッセージ。既読は人数で示す（画面詳細図 4-1） */
function MessageRow({ message, mine, canEdit, onRetract, onEdit, onReact }: {
  message: ChatMessage; mine: boolean; canEdit: boolean;
  onRetract: () => void; onEdit: (body: string) => Promise<void>; onReact: (reactionType: string) => void;
}) {
  const read = useAsync(() => api.readCount(message.chat_message_id), [message.chat_message_id]);
  /*
   * 編集は送信者本人のみ。園チャットに限り管理者同士でも編集できる
   * （基本設計書「メッセージの編集」(4-6)）。可否の判定は canEdit で受け取る。
   * 回数と期限の制限は設けず、既読が付いたあとも編集できる。
   * 編集前の本文はサーバ側で操作ログへ記録する。
   */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [editError, setEditError] = useState('');

  const save = async () => {
    setEditError('');
    try {
      await onEdit(draft);
      setEditing(false);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : '編集できませんでした');
    }
  };

  if (message.is_deleted) {
    return (
      <div className="msg">
        <div className="meta">{(message.sender_name ?? accountName(message.sender_account_id))} {formatHM(message.sent_at)}</div>
        <div className="bubble retracted">このメッセージは取り消されました</div>
      </div>
    );
  }

  return (
    <div className={`msg${mine ? ' mine' : ''}`}>
      <div className="meta">
        {(message.sender_name ?? accountName(message.sender_account_id))} {formatMD(message.sent_at.slice(0, 10))} {formatHM(message.sent_at)}
        {message.edited_at && <span className="weak">（編集済み）</span>}
      </div>
      <div className="bubble">
        {editing ? (
          <>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
              maxLength={1000} rows={4} style={{ width: '100%', boxSizing: 'border-box' }} />
            {editError && <div className="weak">{editError}</div>}
            <div className="row-end" style={{ marginTop: 4 }}>
              <button className="btn-sm" onClick={() => { setDraft(message.body); setEditing(false); }}>やめる</button>
              <button className="btn-sm btn-primary" onClick={save} disabled={!draft.trim()}>保存</button>
            </div>
          </>
        ) : (
          message.body
        )}
        {/*
          * 日誌の共有（source_type=2）は、本文ではなく記録へのリンクとして出す。
          * 編集できるのは添え書きの本文だけで、リンク先の記録は変わらない（基本設計書 4-6）。
          * そのため編集中もリンクは出したままにする
          */}
        {message.source_type === '2' && message.source_id && (
          <Link className="shared-card" to={`/staff/diary/${message.source_id}`}>
            日誌を開く
          </Link>
        )}
        {/* 配布物の掲載の知らせ（source_type=4）。現物は配布物の一覧から開く */}
        {message.source_type === '4' && (
          <Link className="shared-card" to="/staff/handouts">園からの配布物を開く</Link>
        )}
      </div>
      {/* リアクションは編集の影響を受けない（基本設計書「メッセージの編集」(4-6)） */}
      <Reactions reactions={message.reactions ?? []} onToggle={onReact} />
      {(mine || canEdit) && !editing && (
        <div className="read">
          {/* 既読と取消は自分の発言にだけ出す。園チャットの相互編集で直せるのは本文だけ */}
          {mine && <>既読 {read.data ?? 0}{' '}</>}
          {canEdit && (
            <button className="btn-sm btn-quiet" onClick={() => { setDraft(message.body); setEditing(true); }}>編集</button>
          )}
          {' '}
          {mine && <button className="btn-sm btn-quiet" onClick={onRetract}>取消</button>}
        </div>
      )}
    </div>
  );
}
