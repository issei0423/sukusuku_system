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
import { useAsync, useFollowLatest, AUTO_REFRESH_MS } from '../../hooks';
import { onLive, onRoom } from '../../live';
import { useSession } from '../../session';
import { api, accountName } from '../../api/client';
import { REACTION, SENDER_KIND } from '../../api/codes';
import { Loading, ErrorBox, Empty } from '../../components/ui';
import { ConfirmDialog } from '../../components/feedback';
import Reactions from '../../components/Reactions';
import { formatHM, formatMD } from '../../api/util';
import type { ChatMessage } from '../../api/types';
import { useUnsavedInput } from '../../unsavedInput';
import IncomingLog from './IncomingLog';
import { useIncomingMessages } from './useIncomingMessages';

/*
 * メッセージを長押しして操作の一覧を開くまでの時間と、長押しとみなす指のずれの上限。
 * 設計に定めが無く、仮に置いた値（web/仮置き値.md）
 */
const LONG_PRESS_MS = 800;
const LONG_PRESS_MOVE_PX = 10;

export default function GuardianChatScreen() {
  const { user } = useSession();
  /*
   * 連絡先の一覧（未読の件数）とメッセージは、開いたままでも読み直す。
   * 園からの返信・リアクションが、すぐに表れるようにするため。知らせ（live.ts）を受けて読み直し、
   * 知らせが切れている間は数秒ごとに読み直す。一覧はどのチャンネルの知らせでも、メッセージは開いているチャンネルの
   * 知らせで読み直す。読み直しでは読み込み中の表示を出さず、入力中の文字・開いている操作の一覧・編集中の本文は残す
   */
  const rooms = useAsync(() => api.rooms(user!), [user?.account_id],
    { refreshMs: AUTO_REFRESH_MS, live: onLive('chat') });
  const [roomId, setRoomId] = useState<number | null>(null);
  /*
   * 書きかけの本文は、チャンネルごとに持つ。きょうだいが在籍する保護者には個人チャットが園児の数だけ並ぶ
   * （基本設計書「チャット」(5-5)）。画面全体で1つだけ持つと、ある子のことを書きかけたまま別の子の
   * やりとりへ移り、そのまま送れてしまう（職員の画面と同じ扱い。GitHub Issue #172）
   */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const text = roomId !== null ? drafts[roomId] ?? '' : '';
  const setText = (value: string) => {
    if (roomId !== null) setDrafts((d) => ({ ...d, [roomId]: value }));
  };
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  // 取消を確かめているメッセージ。元に戻せないため、1回押すだけで取り消さない（GitHub Issue #141 の 2）
  const [retracting, setRetracting] = useState<ChatMessage | null>(null);
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

  const messages = useAsync(async () => (roomId ? api.messages(user!, roomId) : []), [roomId],
    { refreshMs: AUTO_REFRESH_MS, live: onRoom(roomId) });
  // 園から届いた新しいメッセージだけを読み上げへ伝える（詳細設計書 (2-0) の (6) の①、GitHub Issue #209）
  const incoming = useIncomingMessages(messages.data, messages.loading, roomId, user!.account_id);

  // 開いたチャンネルは既読にする。開いている間に届いたメッセージも、届いたときに既読にする
  const shownRoom = messages.data?.[0]?.chat_room_id ?? null;
  const lastMessageId = messages.data?.at(-1)?.chat_message_id ?? null;
  useEffect(() => {
    if (roomId) api.markRead(user!, roomId).then(() => rooms.refresh(), () => {});
  }, [roomId, lastMessageId]);

  /*
   * 書きかけのメッセージと、保存していない編集は、ログアウトの前に確かめる。
   * 確かめずにログアウトすると、書いた文が黙って消える（基本設計書「ログアウト」(4-3)。GitHub Issue #170）
   * 書きかけはチャンネルごとに持つので（GitHub Issue #172）、いま開いていないチャンネルの書きかけも数える
   */
  const editingOriginal = messages.data?.find((m) => m.chat_message_id === editingId)?.body;
  const hasDraft = Object.values(drafts).some((d) => d.trim() !== '');
  useUnsavedInput(hasDraft || (editingId !== null && draft !== editingOriginal));

  // 開いたチャンネルは、いちばん下（最新）から見せる（GitHub Issue #172）。いちばん下を読んでいるときに届いた
  // メッセージは、見える位置まで送る。上へ戻って読んでいるときは動かさない
  const listRef = useRef<HTMLDivElement | null>(null);
  useFollowLatest(listRef, shownRoom, lastMessageId);

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
  useEffect(() => { setMenuId(null); setError(null); }, [roomId]);

  // 読み込み中の表示は最初の1回だけ。読み直しのたびに画面を入れ替えると、入力中の文字や読んでいた位置が失われる
  if (rooms.loading && !rooms.data) return <Loading />;
  if (rooms.error) return <ErrorBox text={rooms.error} />;

  const current = rooms.data?.find((r) => r.room.chat_room_id === roomId);

  const send = async () => {
    if (!roomId || !text.trim()) return;
    // 送った先のチャンネルの書きかけだけを消す。送っている間に書き足されたら消さない
    const target = roomId;
    const body = text;
    setError(null);
    try {
      await api.send(user!, target, body);
      setDrafts((d) => (d[target] === body ? { ...d, [target]: '' } : d));
      messages.refresh();
      setStatus('メッセージを送信しました');
    } catch (e) { setError((e as Error).message); }
  };

  // 操作の一覧を閉じたら、開いた「操作」ボタンへ戻す。キーボードで画面の先頭からやり直さずに済むように（GitHub Issue #172）
  const focusTrigger = (messageId: number) =>
    document.querySelector<HTMLButtonElement>(`[data-message-menu="${messageId}"]`)?.focus({ preventScroll: true });
  const closeMenu = (messageId: number) => {
    focusTrigger(messageId);
    setMenuId(null);
  };

  const saveEdit = async (messageId: number) => {
    setError(null);
    try {
      await api.edit(user!, messageId, draft);
      setEditingId(null);
      messages.refresh();
      setStatus('メッセージを更新しました');
    } catch (e) { setError((e as Error).message); }
  };

  // 取消は送信者本人ができる。保護者にも認めている（基本設計書の権限一覧「メッセージの編集・送信取消」）
  const retract = async (messageId: number) => {
    setError(null);
    try { await api.retract(user!, messageId); messages.refresh(); setStatus('メッセージを取り消しました'); }
    catch (e) { setError((e as Error).message); }
    finally { setRetracting(null); }
  };

  const react = async (messageId: number, type: string) => {
    setError(null);
    try { await api.toggleReaction(user!, messageId, type); messages.refresh(); setStatus('リアクションを更新しました'); }
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

      <div className="guardian-message-list" ref={listRef}>
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
          /*
            送信者名はメッセージが持つものを使う。保護者にはアカウントの名簿を
            返さないため、account_id からは引けない（api/types.ts の sender_name）。
            相手のものには職員か保護者かを添える。園の職員と自分の家族に同じ氏名の人がいても、
            園からの連絡だと分かるようにする（GitHub Issue #141 の 1）
          */
          const meta = (
            <>
              {mine ? '私' : m.sender_name ?? accountName(m.sender_account_id)}
              {!mine && m.sender_role && <span className="sender-role">{SENDER_KIND[m.sender_role]}</span>}
              {' '}{formatMD(m.sent_at.slice(0, 10))} {formatHM(m.sent_at)}
            </>
          );
          if (m.is_deleted) {
            // 職員の画面と同じく、誰の・いつのものかを残し、自分のものは自分の側に寄せる（GitHub Issue #171 の 6）
            return (
              <div key={m.chat_message_id} className={`msg${mine ? ' mine' : ''}`}>
                <div className="meta">{meta}</div>
                <div className="bubble retracted">このメッセージは取り消されました</div>
              </div>
            );
          }
          const editing = editingId === m.chat_message_id;
          const menuOpen = menuId === m.chat_message_id;
          return (
            <div key={m.chat_message_id} className={`msg${mine ? ' mine' : ''}`}>
              <div className="meta">
                {meta}
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
                          onClick={() => { closeMenu(m.chat_message_id); react(m.chat_message_id, type); }}>
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
                            onClick={() => { closeMenu(m.chat_message_id); setRetracting(m); }}>取消</button>
                        </>
                      )}
                      <button type="button" className="btn-sm btn-quiet"
                        onClick={() => closeMenu(m.chat_message_id)}>閉じる</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <IncomingLog entries={incoming} />

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
          <div className="muted">{noPostNotice(current.room.room_type)}</div>
        )}
      </div>

      {retracting && (
        <ConfirmDialog title="メッセージを取り消します" confirmLabel="取り消す" danger
          onConfirm={() => retract(retracting.chat_message_id)} onCancel={() => setRetracting(null)}>
          <p>
            {formatMD(retracting.sent_at.slice(0, 10))} {formatHM(retracting.sent_at)} のメッセージを取り消します。
            元に戻せません。園の画面には「このメッセージは取り消されました」と出ます。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/*
 * 投稿欄の代わりに出す、投稿できない旨（図/画面詳細図.md「チャット画面（保護者・スマートフォン）」(4-2) 項目15）。
 * 設計が文言を決めているのは園からのお知らせ（園全体）だけ。クラスのチャンネルにも同じ文言を出していたため、
 * 園からのお知らせと読み違える（GitHub Issue #178 の 5）。
 * 【仮置き】クラスのチャンネルとそのほかの文言、連絡先の案内（web/仮置き値.md）
 */
function noPostNotice(type: string): string {
  if (type === '1') return 'こちらは園からのお知らせです。返信はできません。';
  if (type === '2') return 'こちらはクラスのお知らせです。返信はできません。ご連絡は「担任の先生とのやりとり」からお願いします。';
  return 'このチャンネルには投稿できません。';
}

function labelFor(type: string, name: string): string {
  if (type === '1') return '園からのお知らせ';
  if (type === '4') return '担任の先生とのやりとり';
  return name;
}
