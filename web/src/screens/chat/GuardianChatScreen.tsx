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
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync, useFollowLatest, AUTO_REFRESH_MS } from '../../hooks';
import { onLive, onRoom } from '../../live';
import { useSession } from '../../session';
import { api, accountName } from '../../api/client';
import { REACTION, SENDER_KIND } from '../../api/codes';
import { Loading, ErrorBox, Empty } from '../../components/ui';
import { ConfirmDialog } from '../../components/feedback';
import Reactions from '../../components/Reactions';
import { useSecondaryAction, keepInViewport, closeOnUserScroll, MENU_OPENED_TEXT } from '../../secondaryAction';
import type { MenuAt } from '../../secondaryAction';
import { formatHM, formatMD } from '../../api/util';
import type { ChatMessage } from '../../api/types';
import { useUnsavedInput } from '../../unsavedInput';
import IncomingLog from './IncomingLog';
import { useIncomingMessages } from './useIncomingMessages';
import { focusAfter, focusedNow } from '../../focusAfter';
import { ForwardIcon, BackIcon, SendIcon, UndoIcon } from '../../components/icons';

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
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
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
   * PC では右クリックで、右クリックした位置に開く。キーボードでは吹き出しを選んで Enter で開く。
   * 「操作」ボタンは置かない（secondaryAction.ts）。
   */
  const [menuId, setMenuId] = useState<number | null>(null);
  /*
   * 一覧を出す位置。メッセージが画面の中央より上にあれば下へ、下にあれば上へ出す。
   * 画面の端のメッセージでも一覧が画面の外へ出ないようにするため。
   * メッセージの並びは押し広げず、重ねて出す（開いたときに画面が動かない）
   */
  const [menuPlace, setMenuPlace] = useState<{ above: boolean; offset: number; at?: MenuAt }>({ above: false, offset: 0 });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const atCursor = menuPlace.at !== undefined;
  // PC の右クリックで開いたときは、カーソルの位置に出し、画面の外へはみ出さないよう寄せる
  useLayoutEffect(() => {
    if (menuId !== null && menuPlace.at) keepInViewport(menuRef.current?.parentElement ?? null, menuPlace.at);
  }, [menuId, menuPlace]);
  /*
   * 右クリック・長押しの判定（secondaryAction.ts）。長押しで開いた直後に指を離したときのクリックを
   * 無視する扱いも、ここに含まれる（一覧を見える位置へ送ると画面が動き、指の下にボタンが来るため）
   */
  const secondary = useSecondaryAction();

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
  const input = useRef<HTMLInputElement | null>(null);
  // PC の幅では列の内側でなくページ全体を送るので、送れる親が無ければ文書を送る
  useFollowLatest(listRef, shownRoom, lastMessageId, { fallbackToDocument: true });

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
        document.querySelector<HTMLElement>(`[data-message-bubble="${menuId}"]`)?.focus();
      }
    };
    // カーソルの位置に出した一覧は、人が画面を送るとメッセージから離れるので閉じる（新着での自動の送りでは閉じない）
    const offScroll = atCursor ? closeOnUserScroll(() => setMenuId(null)) : () => {};
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      offScroll();
    };
  }, [menuId, atCursor]);

  useEffect(() => { setMenuId(null); setError(null); }, [roomId]);

  // 読み込み中の表示は最初の1回だけ。読み直しのたびに画面を入れ替えると、入力中の文字や読んでいた位置が失われる
  if (rooms.loading && !rooms.data) return <Loading />;
  if (rooms.error) return <ErrorBox text={rooms.error} />;

  const current = rooms.data?.find((r) => r.room.chat_room_id === roomId);

  /*
   * 送れると欄が空になって「送信」が押せなくなり、押したボタンからフォーカスが外れて body に落ちる。
   * 空になった入力欄へ移す（連絡帳の「送る」と同じ。src/focusAfter.ts、WCAG 2.4.3、GitHub Issue #213）。
   * 送れなかったときは文が残り、「送信」も押せるままなので動かさない
   */
  // 送っている間は「送信」を押せなくし、続けて押しても2件にしない（職員のチャットと同じ。GitHub Issue #303）
  const send = async () => {
    if (!roomId || !text.trim() || sending.current) return;
    sending.current = true;
    setBusy(true);
    const pressed = focusedNow();
    // 送った先のチャンネルの書きかけだけを消す。送っている間に書き足されたら消さない
    const target = roomId;
    const body = text;
    setError(null);
    try {
      await api.send(user!, target, body);
      setDrafts((d) => (d[target] === body ? { ...d, [target]: '' } : d));
      messages.refresh();
      setStatus('メッセージを送信しました');
      focusAfter(pressed, () => input.current);
    } catch (e) { setError((e as Error).message); } finally { sending.current = false; setBusy(false); }
  };

  // 操作の一覧を閉じたら、開いた吹き出しへ戻す。キーボードで画面の先頭からやり直さずに済むように（GitHub Issue #172）
  const focusTrigger = (messageId: number) =>
    document.querySelector<HTMLElement>(`[data-message-bubble="${messageId}"]`)?.focus({ preventScroll: true });
  const closeMenu = (messageId: number) => {
    focusTrigger(messageId);
    setMenuId(null);
  };

  /*
   * 保存する・やめると編集の欄とボタンが消え、押したボタンからフォーカスが外れて body に落ちる。吹き出しへ戻す
   * （一覧を閉じたときと同じ先。src/focusAfter.ts、WCAG 2.4.3、GitHub Issue #213）。
   * 吹き出しは編集の欄が消えてからフォーカスを受け取れる（tabIndex が付く）ので、それまで待つ
   */
  const bubbleWhenReady = (messageId: number) => () => {
    const bubble = document.querySelector<HTMLElement>(`[data-message-bubble="${messageId}"]`);
    return bubble && bubble.tabIndex >= 0 ? bubble : null;
  };
  const cancelEdit = (messageId: number) => {
    const pressed = focusedNow();
    setEditingId(null);
    focusAfter(pressed, bubbleWhenReady(messageId));
  };
  const saveEdit = async (messageId: number) => {
    const pressed = focusedNow();
    setError(null);
    try {
      await api.edit(user!, messageId, draft);
      setEditingId(null);
      messages.refresh();
      setStatus('メッセージを更新しました');
      focusAfter(pressed, bubbleWhenReady(messageId));
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

  // 吹き出しの位置から、一覧を上下どちらへ出すかを決めて開く。PC の右クリックではカーソルの位置（at）に出す
  const openMenu = (messageId: number, bubble: HTMLElement, at?: MenuAt) => {
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
      at,
    });
    setMenuId(messageId);
  };

  // 吹き出しに付ける。右クリックか長押しで、そのメッセージの操作の一覧を開く
  const pressHandlers = (messageId: number) => secondary((bubble, at) => openMenu(messageId, bubble, at));

  // 一覧
  if (!current) {
    return (
      <div className="guardian-chat-list">
        <div className="guardian-page-intro">
          <span className="guardian-eyebrow">園とのやりとり</span>
          <h1>チャット・お知らせ</h1>
          <p>連絡先を選んで、メッセージを確認できます。</p>
          {/* 園だより・献立表など、あとから見返すもの。職員のチャット画面の「園からの配布物」と同じ置き方 */}
          <Link className="btn btn-sm guardian-handout-button" to="/guardian/handouts">園からの配布物</Link>
        </div>
        <div className="guardian-room-list">
          {rooms.data?.map((r) => (
            <button key={r.room.chat_room_id} className="guardian-room-link"
              onClick={() => setRoomId(r.room.chat_room_id)}>
              <span>{labelFor(r.room.room_type, r.room.room_name)}</span>
              <span className="guardian-room-trailing">
                {r.unread > 0 && <span className="guardian-unread">{r.unread}</span>}
                <ForwardIcon />
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
        <button className="btn-quiet btn-sm" onClick={() => setRoomId(null)}><BackIcon />もどる</button>
        <h1>{labelFor(current.room.room_type, current.room.room_name)}</h1>
      </div>

      <div className="guardian-message-list" ref={listRef}>
        {(messages.data?.length ?? 0) > 0 && (
          <p id="guardian-message-hint" className="guardian-message-hint">
            メッセージを長押し（パソコンでは右クリック）すると、リアクションを付けられます。自分のメッセージは編集・取消もできます。
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
              <div className={`bubble${editing ? '' : ' pressable'}`} data-message-bubble={m.chat_message_id}
                aria-describedby="guardian-message-hint"
                aria-controls={menuOpen ? `message-actions-${m.chat_message_id}` : undefined}
                {...(editing ? {} : pressHandlers(m.chat_message_id))}>
                {editing ? (
                  <>
                    {/* 文字数は符号位置で数える（maxLength は UTF-16 で数えるので付けない）。上限を超えたら保存できない。GitHub Issue #310 */}
                    <textarea aria-label="メッセージの編集" value={draft} onChange={(e) => setDraft(e.target.value)}
                      rows={4} style={{ width: '100%', boxSizing: 'border-box' }} />
                    {[...draft].length > 1000 && <div className="weak" role="alert">本文は1,000文字以内で入力してください</div>}
                    <div className="row-end" style={{ marginTop: 4 }}>
                      <button className="btn-sm" onClick={() => cancelEdit(m.chat_message_id)}>やめる</button>
                      <button className="btn-sm btn-primary" onClick={() => saveEdit(m.chat_message_id)}
                        disabled={!draft.trim() || [...draft].length > 1000}>保存</button>
                    </div>
                  </>
                ) : (
                  m.body
                )}
                {/*
                  配布物の掲載の知らせ（source_type=4）。現物は配布物の一覧から開く。編集できるのは添え書きの本文だけで、
                  リンク先は変わらないため、編集中もリンクは出したままにする（基本設計書 4-6）。
                  日誌の共有の知らせ（source_type=2）のカードは出さない。日誌は園内の記録で、保護者は開けない
                  （詳細設計書「日誌の画面（作り直し）」(2-13 (1))。以前の知らせは取り消し済みにしてある）
                */}
                {m.source_type === '4' && (
                  <Link className="shared-card" to="/guardian/handouts">園からの配布物を開く</Link>
                )}
              </div>
              {/* 既読は保護者側には表示しない（基本設計書 5-5） */}
              {/* 編集は送信者本人のみ（同 4-6）。既読が付いたあとも編集できる */}
              {/* 付いているリアクションは常に出す。付ける・編集・取消は長押しの一覧から */}
              <Reactions reactions={m.reactions ?? []} showAdd={false}
                onToggle={(type) => react(m.chat_message_id, type)} />
              {menuOpen && !editing && (
                <div className={`msg-menu-wrap${menuPlace.at ? ' at-cursor' : menuPlace.above ? ' above' : ''}`}
                  style={menuPlace.at ? { left: menuPlace.at.x, top: menuPlace.at.y }
                    : menuPlace.above ? { bottom: menuPlace.offset } : { top: menuPlace.offset }}>
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
                          {/* 猶予期間中は読むだけ（canPost が偽）。編集は送った本文を書き換えるので出さない（GitHub Issue #308） */}
                          {current.canPost && (
                            <button type="button" className="btn-sm"
                              onClick={() => { setMenuId(null); setDraft(m.body); setEditingId(m.chat_message_id); }}>編集</button>
                          )}
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
        {/* 操作の一覧を開いたことを読み上げへ伝える（secondaryAction.ts） */}
        <div className="sr-only" role="status">{menuId !== null ? MENU_OPENED_TEXT : ''}</div>
        {error && <ErrorBox text={error} />}
        {current.canPost ? (
          <>
            <div className="row">
              {/* 文字数は符号位置で数える（maxLength は UTF-16 で数えるので付けない）。上限を超えたら送れない。GitHub Issue #310 */}
              <input ref={input} type="text" aria-label="メッセージを入力" value={text} onChange={(e) => setText(e.target.value)}
                placeholder="メッセージを入力" style={{ flex: 1 }} />
              <button className="btn-primary" onClick={send} disabled={busy || !text.trim() || [...text].length > 1000} aria-busy={busy}><SendIcon />送信</button>
            </div>
            {[...text].length > 1000 && <div className="weak" role="alert">本文は1,000文字以内で入力してください</div>}
          </>
        ) : (
          <div className="muted">{noPostNotice(current.room.room_type)}</div>
        )}
      </div>

      {retracting && (
        <ConfirmDialog title="メッセージを取り消します" confirmLabel="取り消す" confirmIcon={<UndoIcon />} danger
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
  // 保護者が個人チャットへ書けないのは、卒園・退園した猶予期間のとき（外れた保護者はチャンネルごと読めない。
  // 図/画面詳細図.md「チャット画面（保護者）」(4-2)、詳細設計書「チャット画面（職員・保護者）」(2-9 (6))。GitHub Issue #308）
  if (type === '4') return '卒園・退園したお子さまのやりとりは、読むことだけができます。';
  return 'このチャンネルには投稿できません。';
}

function labelFor(type: string, name: string): string {
  if (type === '1') return '園からのお知らせ';
  if (type === '4') return '担任の先生とのやりとり';
  return name;
}
