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
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, accountName } from '../../api/client';
import { REACTION } from '../../api/codes';
import { Loading, ErrorBox, Empty } from '../../components/ui';
import Reactions from '../../components/Reactions';
import { formatHM, formatMD } from '../../api/util';

/*
 * メッセージを長押しして操作の一覧を開くまでの時間と、長押しとみなす指のずれの上限。
 * 設計に定めが無く、仮に置いた値（web/仮置き値.md）
 */
const LONG_PRESS_MS = 800;
const LONG_PRESS_MOVE_PX = 10;

export default function GuardianChatScreen() {
  const { user } = useSession();
  const rooms = useAsync(() => api.rooms(user!), [user?.account_id]);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  /*
   * 編集は送信者本人のみ。回数と期限の制限は設けず、既読が付いたあとも編集できる
   * （基本設計書「メッセージの編集」(4-6)）
   */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  /*
   * リアクション・編集・取消は、メッセージを長押しして開く操作の一覧に置く。
   * 各メッセージの下へ常に並べると、やりとりが続いたときに本文が読みにくくなるため。
   * 長押しができない操作（キーボード、マウスの右クリック）からも同じ一覧を開ける。
   */
  const [menuId, setMenuId] = useState<number | null>(null);
  /*
   * 一覧を出す位置。メッセージが画面の中央より上にあれば下へ、下にあれば上へ出す。
   * 画面の端のメッセージでも一覧が画面の外へ出ないようにするため。
   * メッセージの並びは押し広げず、重ねて出す（開いたときに画面が動かない）
   */
  const [menuPlace, setMenuPlace] = useState<{ above: boolean; offset: number }>({ above: false, offset: 0 });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pressTimer = useRef<number | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  /*
   * 長押しで一覧を開いた直後に指を離すと、その位置が「押された」ことになる。
   * 一覧を見える位置へ送ると画面が動くため、指の下に来たリアクションのボタンや本文中のリンクが
   * 意図せず押されてしまう。長押しで開いた直後の1回だけ、どこに当たっても無視する
   */
  const suppressClick = useRef(false);

  const messages = useAsync(async () => (roomId ? api.messages(user!, roomId) : []), [roomId, tick]);

  useEffect(() => {
    if (roomId) api.markRead(user!, roomId).then(() => rooms.reload());
  }, [roomId, tick]);

  // 一覧の外を押すか Esc で閉じる。開いたら最初の操作へ移る
  useEffect(() => {
    if (menuId === null) return;
    menuRef.current?.querySelector('button')?.focus({ preventScroll: true });
    const onDown = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuId(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuId(null);
        document.querySelector<HTMLButtonElement>(`[data-message-menu="${menuId}"]`)?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuId]);

  useEffect(() => {
    const swallow = (e: Event) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // 次に押し始めたら、無視する指定を解く（指を離しても「押された」ことにならなかった場合に残さない）
    const reset = () => { suppressClick.current = false; };
    document.addEventListener('click', swallow, true);
    document.addEventListener('pointerdown', reset, true);
    return () => {
      document.removeEventListener('click', swallow, true);
      document.removeEventListener('pointerdown', reset, true);
      if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    };
  }, []);
  useEffect(() => { setMenuId(null); }, [roomId]);

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
      setStatus('メッセージを送信しました');
    } catch (e) { setError((e as Error).message); }
  };

  const saveEdit = async (messageId: number) => {
    setError(null);
    try {
      await api.edit(user!, messageId, draft);
      setEditingId(null);
      setTick((n) => n + 1);
      setStatus('メッセージを更新しました');
    } catch (e) { setError((e as Error).message); }
  };

  // 取消は送信者本人ができる。保護者にも認めている（基本設計書の権限一覧「メッセージの編集・送信取消」）
  const retract = async (messageId: number) => {
    setError(null);
    try { await api.retract(user!, messageId); setTick((n) => n + 1); setStatus('メッセージを取り消しました'); }
    catch (e) { setError((e as Error).message); }
  };

  const react = async (messageId: number, type: string) => {
    setError(null);
    try { await api.toggleReaction(user!, messageId, type); setTick((n) => n + 1); setStatus('リアクションを更新しました'); }
    catch (e) { setError((e as Error).message); }
  };

  const cancelPress = () => {
    if (pressTimer.current !== null) { clearTimeout(pressTimer.current); pressTimer.current = null; }
    pressStart.current = null;
  };

  // 吹き出しの位置から、一覧を上下どちらへ出すかを決めて開く
  const openMenu = (messageId: number, bubble: HTMLElement) => {
    const r = bubble.getBoundingClientRect();
    const above = r.top + r.height / 2 > window.innerHeight / 2;
    const msg = bubble.parentElement;
    const gap = 4;
    setMenuPlace({
      above,
      offset: above
        ? (msg ? msg.offsetHeight - bubble.offsetTop : 0) + gap
        // 下へ出すときは、付いているリアクションの印を隠さないよう、その下に置く
        : (msg ? msg.offsetHeight : bubble.offsetTop + bubble.offsetHeight) + gap,
    });
    setMenuId(messageId);
  };

  // 吹き出しに付ける。押したまま LONG_PRESS_MS が過ぎたら、そのメッセージの操作の一覧を開く
  const pressHandlers = (messageId: number) => ({
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      cancelPress();
      pressStart.current = { x: e.clientX, y: e.clientY };
      const bubble = e.currentTarget as HTMLElement;
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = null;
        suppressClick.current = true;
        openMenu(messageId, bubble);
      }, LONG_PRESS_MS);
    },
    // 画面を送ろうとして指が動いたときは、長押しとみなさない
    onPointerMove: (e: PointerEvent) => {
      const s = pressStart.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > LONG_PRESS_MOVE_PX) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onPointerLeave: cancelPress,
    // 右クリックと、端末が長押しで出す既定のメニューの代わりに開く
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      cancelPress();
      openMenu(messageId, e.currentTarget as HTMLElement);
    },
  });

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
        {(messages.data?.length ?? 0) > 0 && (
          <p id="guardian-message-hint" className="guardian-message-hint">
            メッセージの「操作」ボタンか長押しで、リアクションを付けられます。自分のメッセージは編集・取消もできます。
          </p>
        )}
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
          const editing = editingId === m.chat_message_id;
          const menuOpen = menuId === m.chat_message_id;
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
              {/* 編集中は本文の入力欄を普通に触れるよう、長押しを受け付けない */}
              <div className={`bubble${editing ? '' : ' pressable'}`}
                {...(editing ? {} : pressHandlers(m.chat_message_id))}>
                {editing ? (
                  <>
                    <textarea aria-label="メッセージの編集" value={draft} onChange={(e) => setDraft(e.target.value)}
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
                {/* 配布物の掲載の知らせ（source_type=4）。現物は配布物の一覧から開く */}
                {m.source_type === '4' && (
                  <Link className="shared-card" to="/guardian/handouts">園からの配布物を開く</Link>
                )}
              </div>
              {!editing && (
                <button type="button" className="message-actions-trigger" data-message-menu={m.chat_message_id}
                  aria-label={`${mine ? '自分' : m.sender_name ?? '相手'}のメッセージの操作`} aria-expanded={menuOpen}
                  aria-controls={menuOpen ? `message-actions-${m.chat_message_id}` : undefined}
                  onClick={(e) => {
                    if (menuOpen) { setMenuId(null); return; }
                    const bubble = e.currentTarget.closest('.msg')?.querySelector<HTMLElement>('.bubble');
                    if (bubble) openMenu(m.chat_message_id, bubble);
                  }}>操作</button>
              )}
              {/* 既読は保護者側には表示しない（基本設計書 5-5） */}
              {/* 編集は送信者本人のみ（同 4-6）。既読が付いたあとも編集できる */}
              {/* 付いているリアクションは常に出す。付ける・編集・取消は長押しの一覧から */}
              <Reactions reactions={m.reactions ?? []} showAdd={false}
                onToggle={(type) => react(m.chat_message_id, type)} />
              {menuOpen && !editing && (
                <div className={`msg-menu-wrap${menuPlace.above ? ' above' : ''}`}
                  style={menuPlace.above ? { bottom: menuPlace.offset } : { top: menuPlace.offset }}>
                  <div ref={menuRef} id={`message-actions-${m.chat_message_id}`} className="msg-menu" role="group" aria-label="メッセージの操作"
                    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setMenuId(null); }}>
                    <div className="msg-menu-row">
                      {Object.entries(REACTION).map(([type, def]) => (
                        <button key={type} type="button" className="reaction pick"
                          aria-label={def.label} title={def.label}
                          onClick={() => { setMenuId(null); react(m.chat_message_id, type); }}>
                          <span aria-hidden="true">{def.emoji}</span>
                        </button>
                      ))}
                    </div>
                    <div className="msg-menu-row">
                      {mine && (
                        <>
                          <button type="button" className="btn-sm"
                            onClick={() => { setMenuId(null); setDraft(m.body); setEditingId(m.chat_message_id); }}>編集</button>
                          <button type="button" className="btn-sm"
                            onClick={() => { setMenuId(null); retract(m.chat_message_id); }}>取消</button>
                        </>
                      )}
                      <button type="button" className="btn-sm btn-quiet"
                        onClick={() => setMenuId(null)}>閉じる</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="guardian-message-compose">
        <div className="sr-only" role="status">{status}</div>
        {error && <ErrorBox text={error} />}
        {current.canPost ? (
          <div className="row">
            <input type="text" aria-label="メッセージを入力" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)}
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
