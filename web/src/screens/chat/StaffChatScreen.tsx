/*
 * チャット画面（職員・タブレット／PC）
 * 典拠：図/画面詳細図.md「チャット画面（職員・タブレット／PC）」(4-1)
 *
 * チャンネルの切替は画面遷移ではない。メッセージ領域が入れ替わるだけ。
 * 未読はチャンネル一覧に件数で示す。既読はメッセージ側に人数で示す。
 * 園全体は一般には投稿欄を表示しない（閲覧のみ）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAsync, useFollowLatest, AUTO_REFRESH_MS } from '../../hooks';
import { onLive, onRoom } from '../../live';
import { useSession } from '../../session';
import { api, accountName } from '../../api/client';
import { Loading, ErrorBox, Empty, Alert, Tag } from '../../components/ui';
import { ConfirmDialog, notify } from '../../components/feedback';
import Reactions from '../../components/Reactions';
import { useSecondaryAction, keepInViewport } from '../../secondaryAction';
import type { MenuAt, SecondaryActionHandlers } from '../../secondaryAction';
import { CHAT_ROOM_TYPE, THREAD_STATUS, REACTION, GUARDIAN_ROOM_TYPES, SENDER_KIND } from '../../api/codes';
import { formatHM, formatMD } from '../../api/util';
import type { ChatMessage } from '../../api/types';

export default function StaffChatScreen() {
  const { user } = useSession();
  // 右クリック・長押しの判定（secondaryAction.ts）。保護者のチャット画面と同じ扱い
  const secondary = useSecondaryAction();
  // 操作の一覧を開いているメッセージ。同時に開くのは1件だけ
  const [menuId, setMenuId] = useState<number | null>(null);
  /*
   * チャンネルの一覧（未読の件数・未対応の印）とメッセージは、開いたままでも読み直す。
   * 保護者からの送信・リアクション・既読が、すぐに表れるようにするため。知らせ（live.ts）を受けて読み直し、
   * 知らせが切れている間は数秒ごとに読み直す。一覧はどのチャンネルの知らせでも、メッセージは開いているチャンネルの
   * 知らせで読み直す。読み直しでは読み込み中の表示を出さず、入力中の文字・開いている操作の一覧・編集中の本文は残す
   */
  const rooms = useAsync(() => api.rooms(user!), [user?.account_id],
    { refreshMs: AUTO_REFRESH_MS, live: onLive('chat') });
  const [roomId, setRoomId] = useState<number | null>(null);
  /*
   * 書きかけの本文は、チャンネルごとに持つ。画面全体で1つだけ持つと、チャンネルを切り替えても
   * 入力欄に残り、ある家庭へ書いた園児の体調などを、そのまま別の家庭へ送れてしまう
   * （基本設計書「誤送信への対応」(4-6) が最も重く扱う事故。GitHub Issue #172）。
   * 消さずにチャンネルごとに残すのは、切り替えて確かめてから戻って送る、という使い方を妨げないため
   */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const text = roomId !== null ? drafts[roomId] ?? '' : '';
  const setText = (value: string) => {
    if (roomId !== null) setDrafts((d) => ({ ...d, [roomId]: value }));
  };
  const [error, setError] = useState<string | null>(null);
  // 取消（自分のメッセージ）・削除（管理者が他者のメッセージを）を確かめている対象
  const [retracting, setRetracting] = useState<ChatMessage | null>(null);
  const [retractBusy, setRetractBusy] = useState(false);
  // ダッシュボードの「未対応の個人チャット」から来たときは、そのチャンネルを開いた状態で始める
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (roomId !== null || !rooms.data || rooms.data.length === 0) return;
    const wanted = Number(searchParams.get('room'));
    const hit = rooms.data.find((r) => r.room.chat_room_id === wanted);
    setRoomId((hit ?? rooms.data[0]).room.chat_room_id);
  }, [rooms.data]);

  const messages = useAsync(
    async () => (roomId ? api.messages(user!, roomId) : []),
    [roomId],
    { refreshMs: AUTO_REFRESH_MS, live: onRoom(roomId) },
  );
  /*
   * 外れたチャンネル（left）は閲覧のみ。外れるまでの過去ログだけが返り、投稿・リアクション・編集・取消・
   * 未対応の切り替えはできない。いまの参加者も返らないので、メンバーは問い合わせない
   * （図/画面詳細図.md「グループ編成画面」(4-3) No.8、GitHub Issue #161・#162）
   */
  const leftRoom = rooms.data?.find((r) => r.room.chat_room_id === roomId)?.left ?? false;
  const members = useAsync(async () => (roomId && !leftRoom ? api.members(roomId, user!) : []), [roomId, leftRoom]);

  /*
   * 開いたチャンネルは既読にする。開いている間に届いたメッセージも、届いたときに既読にする
   * （見ている画面に出たものを、未読として数え続けないため）。タブが隠れている間は読み直しが
   * 止まるので、見ていないあいだに届いたものは既読にならない
   */
  const shownRoom = messages.data?.[0]?.chat_room_id ?? null;
  const lastMessageId = messages.data?.at(-1)?.chat_message_id ?? null;
  useEffect(() => {
    if (roomId) api.markRead(user!, roomId).then(() => rooms.refresh(), () => {});
  }, [roomId, lastMessageId]);

  // 開いたチャンネルは、いちばん下（最新）から見せる（GitHub Issue #172）。いちばん下を読んでいるときに届いた
  // メッセージは、見える位置まで送る。上へ戻って読んでいるときは動かさない
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useFollowLatest(scrollRef, shownRoom, lastMessageId);

  const current = rooms.data?.find((r) => r.room.chat_room_id === roomId);
  // 保護者が参加するチャンネルか。既読の人数は保護者の既読だけを数え、吹き出しに職員・保護者の印を添える
  const guardianRoom = !!current && GUARDIAN_ROOM_TYPES.includes(current.room.room_type);

  /*
   * 園チャット（room_type=1）だけは、管理者同士なら互いのメッセージを編集できる
   * （基本設計書「メッセージの編集」(4-6)）。園全体への発信は園としての意思表示であり、
   * 発信者個人のものではないため。他のチャンネルは送信者本人だけが編集できる
   */
  const schoolWideAdmin = current?.room.room_type === '1' && user!.role === '1';

  // チャンネルを切り替えたら、前のチャンネルの知らせと操作の一覧を持ち越さない
  const selectRoom = (id: number) => {
    setRoomId(id);
    setError(null);
    setMenuId(null);
  };

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
    } catch (e) { setError((e as Error).message); }
  };

  /*
   * 取消・削除は、確かめてから行う。元に戻せず、取り消すと誤送信への対応の記録が要るため
   * （GitHub Issue #141・#107）。取り消せなかったとき（別の画面で先に取り消されていたなど）は知らせる（#171）
   */
  const retract = async () => {
    if (!retracting) return;
    setRetractBusy(true);
    setError(null);
    try {
      await api.retract(user!, retracting.chat_message_id);
      notify(retracting.sender_account_id === user!.account_id ? 'メッセージを取り消しました' : 'メッセージを削除しました');
      messages.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetractBusy(false);
      setRetracting(null);
    }
  };

  /*
   * 個人チャットのスレッドを「未対応／対応済み」に切り替える（要件定義書「チャットツール」(4-3)）。
   * 保護者から新しく受信すると、サーバ側で自動的に未対応へ戻る
   */
  const setThread = async (status: '1' | '2') => {
    if (!roomId) return;
    setError(null);
    try { await api.setThreadStatus(user!, roomId, status); rooms.refresh(); }
    catch (e) { setError((e as Error).message); }
  };

  const react = async (messageId: number, type: string) => {
    setError(null);
    try { await api.toggleReaction(user!, messageId, type); messages.refresh(); }
    catch (e) { setError((e as Error).message); }
  };

  // チャンネルを開いたままでも一覧は最初の取得のものを使い続けるため、読み込み中の判定は初回だけにする
  if (rooms.loading && !rooms.data) return <Loading />;
  if (rooms.error) return <ErrorBox text={rooms.error} />;

  // 外れた個人チャットは数えない。返信も状態の切り替えもできないため（server/api_dashboard.go と同じ）
  const unhandled = rooms.data?.filter((r) => r.room.room_type === '4' && r.room.thread_status === '1' && !r.left).length ?? 0;
  const staffMembers = members.data?.filter((m) => m.role !== '3') ?? [];
  const guardianMembers = members.data?.filter((m) => m.role === '3') ?? [];

  // 外れたチャンネルは最後にまとめる。担任を付け替えたあとの前のクラスなどが、いまのチャンネルに混ざらないようにする
  const grouped = [
    { label: '園・職員', types: ['1', '5'], left: false },
    { label: 'クラス・グループ', types: ['2', '3'], left: false },
    { label: '保護者との個人チャット', types: ['4'], left: false },
    { label: '外れたチャンネル（閲覧のみ）', types: ['1', '2', '3', '4', '5'], left: true },
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
              const list = rooms.data!.filter((r) => g.types.includes(r.room.room_type) && r.left === g.left);
              if (list.length === 0) return null;
              return (
                <div key={g.label}>
                  <div className="channel-group">{g.label}</div>
                  {list.map((r) => (
                    <button key={r.room.chat_room_id}
                      className={`channel${r.room.chat_room_id === roomId ? ' current' : ''}`}
                      onClick={() => selectRoom(r.room.chat_room_id)}>
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
            {current?.room.room_type === '4' && !current.left && (
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
          <div className="chat-scroll" ref={scrollRef}>
            {messages.loading && <Loading />}
            {messages.error && <ErrorBox text={messages.error} />}
            {messages.data?.length === 0 && <Empty text="まだメッセージはありません。" />}
            {/* 右クリックと長押しは、見ただけでは気づけない。先頭で知らせる（GitHub Issue #103） */}
            {(messages.data?.length ?? 0) > 0 && !current?.left && (
              <p id="staff-message-hint" className="message-hint">
                メッセージを右クリック（タブレットでは長押し）すると、リアクション・編集・取消ができます。
              </p>
            )}
            {messages.data?.map((m) => (
              <MessageRow key={m.chat_message_id} message={m} mine={m.sender_account_id === user!.account_id}
                canEdit={m.sender_account_id === user!.account_id || schoolWideAdmin}
                canDelete={user!.role === '1' && m.sender_account_id !== user!.account_id}
                showRole={guardianRoom}
                readOnly={!!current?.left}
                menuOpen={menuId === m.chat_message_id}
                bindPress={secondary}
                onMenu={(open) => setMenuId((cur) => (open ? m.chat_message_id : cur === m.chat_message_id ? null : cur))}
                onReact={(type) => react(m.chat_message_id, type)}
                onRetract={() => setRetracting(m)}
                onEdit={async (body) => { await api.edit(user!, m.chat_message_id, body); messages.refresh(); }} />
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
            {/* 【仮置き】停止中の保護者は再開後に過去の投稿を読める。web/仮置き値.md */}
            {current?.canPost && current.guardianCount === 0 && current.room.room_type === '4' && (
              <Alert soft>現在、この家庭で読める保護者はいません。停止中の保護者が再開すると、この投稿を読めます。</Alert>
            )}
            {current?.canPost && current.guardianCount === 0 && current.room.room_type !== '4' && (
              <div className="muted">このチャンネルは職員だけが読みます。</div>
            )}
            {current?.canPost ? (
              <>
                <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000}
                  placeholder="メッセージを入力" style={{ minHeight: 70 }} />
                <div className="row-end">
                  <button onClick={() => alert('添付はモックでは未実装です')}>添付</button>
                  <button className="btn-primary" onClick={send} disabled={!text.trim()}>送信</button>
                </div>
              </>
            ) : (
              <div className="muted">
                {current?.left
                  ? 'このチャンネルからは外れているため、閲覧のみです。外れるまでのやりとりだけを表示しています。'
                  : current?.room.room_type === '1'
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
            {current?.left && <div className="muted">外れたチャンネルの、いまのメンバーは表示しません。</div>}
            {/* 職員と保護者を分けて並べる。保護者が入っているかをひと目で分かるようにするため */}
            {!current?.left && <div className="member-group">職員 {staffMembers.length} 名</div>}
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

      {retracting && (
        <RetractDialog message={retracting} mine={retracting.sender_account_id === user!.account_id}
          isAdmin={user!.role === '1'} guardianRoom={guardianRoom} busy={retractBusy}
          onConfirm={retract} onCancel={() => setRetracting(null)} />
      )}
    </div>
  );
}

/*
 * 取消・削除を確かめるダイアログ。
 * 管理者が他者のメッセージを消すのは「誤送信への対応」の削除である（基本設計書「誤送信への対応」(4-6) 1
 * 「管理者がチャット画面で対象のメッセージを削除する」、要件定義書「チャットツール」(4-3)「メッセージの削除」）。
 * そのとき既読が付いていたかを示す（同 (4-6) 2「当該メッセージが既読になっていたかを表示する」）。
 * 誤送信対応の記録は管理者が行う（図/画面詳細図.md「誤送信対応記録画面」(4-4)）。一般の職員には、
 * 誤って送ったときは管理者へ知らせるよう添える（GitHub Issue #141 の 3）
 */
function RetractDialog({ message, mine, isAdmin, guardianRoom, busy, onConfirm, onCancel }: {
  message: ChatMessage; mine: boolean; isAdmin: boolean; guardianRoom: boolean; busy: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  const readCount = message.read_count ?? 0;
  /*
   * 保護者が送ったものは、誤送信対応の対象にしない（server/api_chat.go の handleRetractedWithoutRecord）。
   * 管理者が保護者の発言を消すときは誤送信への対応ではなく、既読（保護者が開いたか）も判断の材料にならないため出さない
   */
  const fromGuardian = message.sender_role === '3';
  const title = mine ? 'メッセージを取り消します'
    : fromGuardian ? '保護者のメッセージを削除します' : 'メッセージを削除します（誤送信への対応）';
  return (
    <ConfirmDialog title={title}
      confirmLabel={mine ? '取り消す' : '削除する'} danger busy={busy} onConfirm={onConfirm} onCancel={onCancel}>
      <div className="stack">
        <p>
          {formatMD(message.sent_at.slice(0, 10))} {formatHM(message.sent_at)} のメッセージを{mine ? '取り消します' : '削除します'}。
          元に戻せません。相手の画面には「このメッセージは取り消されました」と出ます。
        </p>
        {!fromGuardian && (
          <p>
            <strong>{guardianRoom ? `既読（保護者）：${readCount} 名` : `既読：${readCount} 名`}</strong>
            {readCount > 0 && '。すでに読まれているため、内容が伝わったことは取り消せません'}
          </p>
        )}
        {!fromGuardian && (isAdmin ? (
          <p>削除したあと、<Link to="/staff/admin/misdelivery">誤送信対応の記録</Link>で、既読の有無ととった対応を記録してください。</p>
        ) : (
          <p>誤って別の家庭やチャンネルへ送ったときは、管理者へ知らせてください。誤送信対応の記録は管理者が残します。</p>
        ))}
      </div>
    </ConfirmDialog>
  );
}

/** 1件のメッセージ。既読は人数で示す（画面詳細図 4-1） */
function MessageRow({ message, mine, canEdit, canDelete, showRole, readOnly, onRetract, onEdit, onReact, menuOpen, onMenu, bindPress }: {
  message: ChatMessage; mine: boolean; canEdit: boolean;
  /** 管理者が他者のメッセージを削除できるか（誤送信への対応。基本設計書「誤送信への対応」(4-6)） */
  canDelete: boolean;
  /** 送信者が職員か保護者かを添えるか。保護者が参加するチャンネルで添える（GitHub Issue #141） */
  showRole: boolean;
  /** 外れたチャンネルの過去ログ。操作の一覧（リアクション・編集・取消）を出さない */
  readOnly: boolean;
  onRetract: () => void; onEdit: (body: string) => Promise<void>; onReact: (reactionType: string) => void;
  menuOpen: boolean; onMenu: (open: boolean) => void;
  /** 右クリック・長押しで一覧を開く扱い（secondaryAction.ts）。画面に1つ置いたものを受け取る */
  bindPress: (open: (el: HTMLElement, at?: MenuAt) => void) => SecondaryActionHandlers;
}) {
  /*
   * 既読の人数はメッセージと一緒に受け取る（read_count）。1件ずつ問い合わせると往復が増えるうえ、
   * メッセージを読み直しても人数が古いまま残るため。Go サーバ（api_chat.go）は read_count だけを
   * 返し、api.readCount は 0 を返すので、これまでの1件ずつの問い合わせでは常に「既読 0」だった
   */
  const readCount = message.read_count ?? 0;
  const sender = message.sender_name ?? accountName(message.sender_account_id);
  const roleMark = showRole && message.sender_role
    ? <span className="sender-role">{SENDER_KIND[message.sender_role]}</span> : null;
  /*
   * リアクション・編集・取消は、メッセージを右クリック（タブレットでは長押し）して開く一覧に置く。
   * 各メッセージの下へ常に並べると、やりとりが続いたときに本文が読みにくくなる（GitHub Issue #103）。
   * キーボードと読み上げからは、メッセージの「操作」ボタンで同じ一覧を開ける。
   */
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 一覧を出す向き。メッセージが画面の中央より下にあれば上へ出し、画面の外へ出ないようにする
  const [above, setAbove] = useState(false);
  // PC の右クリックで開いたときの位置（カーソルの所）。長押し・キーボードでは無い
  const [at, setAt] = useState<MenuAt | undefined>(undefined);

  // 吹き出しの位置から、一覧を上下どちらへ出すかを決めて開く。PC の右クリックではカーソルの位置に出す
  const openMenu = (bubble: HTMLElement | null, cursor?: MenuAt) => {
    const r = bubble?.getBoundingClientRect();
    setAbove(!!r && r.top + r.height / 2 > window.innerHeight / 2);
    setAt(cursor);
    onMenu(true);
  };
  // カーソルの位置に出したときは、画面の外へはみ出さないよう寄せる
  useLayoutEffect(() => {
    if (menuOpen && at) keepInViewport(menuRef.current?.parentElement ?? null, at);
  }, [menuOpen, at]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector('button')?.focus({ preventScroll: true });
    const onDown = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) onMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onMenu(false);
      bubbleRef.current?.focus({ preventScroll: true });
    };
    // カーソルの位置に出した一覧は、画面を送るとメッセージから離れるので閉じる
    const onScroll = () => { if (at) onMenu(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [menuOpen, at]);
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

  // 一覧を閉じたら、開いた吹き出しへ戻す。キーボードで画面の先頭からやり直さずに済むように（GitHub Issue #172）
  const closeMenu = () => {
    bubbleRef.current?.focus({ preventScroll: true });
    onMenu(false);
  };

  if (message.is_deleted) {
    // ほかのメッセージと同じく日付まで出す。日をまたぐといつのものか分からないため（GitHub Issue #141 の 5）
    return (
      <div className={`msg${mine ? ' mine' : ''}`}>
        <div className="meta">{sender}{roleMark} {formatMD(message.sent_at.slice(0, 10))} {formatHM(message.sent_at)}</div>
        <div className="bubble retracted">このメッセージは取り消されました</div>
      </div>
    );
  }

  return (
    <div className={`msg${mine ? ' mine' : ''}`}>
      <div className="meta">
        {sender}{roleMark} {formatMD(message.sent_at.slice(0, 10))} {formatHM(message.sent_at)}
        {message.edited_at && <span className="weak">（編集済み）</span>}
      </div>
      <div ref={bubbleRef} className={`bubble${editing || readOnly ? '' : ' has-menu'}`}
        aria-describedby={editing || readOnly ? undefined : 'staff-message-hint'}
        aria-expanded={editing || readOnly ? undefined : menuOpen}
        aria-controls={menuOpen ? `message-actions-${message.chat_message_id}` : undefined}
        {...(editing || readOnly ? {} : bindPress(openMenu))}>
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
      {/*
        リアクションは編集の影響を受けない（基本設計書「メッセージの編集」(4-6)）。
        付いているものだけを並べる。付けるためのボタンは、操作の一覧の中に置く
      */}
      <Reactions reactions={message.reactions ?? []} onToggle={onReact} showAdd={false} />
      {/*
        既読は自分の発言にだけ出す。保護者が参加するチャンネルでは、保護者の既読だけを数える
        （要件定義書「チャットツール」(4-3)「既読確認」。server/api_chat.go の readCountRoles。GitHub Issue #171）
      */}
      {mine && !editing && (
        <div className="read" title={showRole ? '保護者のうち、読んだ人数' : undefined}>既読 {readCount}</div>
      )}

      {menuOpen && !editing && (
        <div className={`msg-menu-wrap${at ? ' at-cursor' : ''}`}
          style={at ? { left: at.x, top: at.y } : above ? { bottom: '100%' } : { top: '100%' }}>
          <div ref={menuRef} id={`message-actions-${message.chat_message_id}`} className="msg-menu"
            role="group" aria-label="メッセージの操作">
            <div className="msg-menu-row">
              {Object.entries(REACTION).map(([type, def]) => (
                <button key={type} type="button" className="reaction pick"
                  aria-label={def.label} title={def.label}
                  onClick={() => { onReact(type); closeMenu(); }}>
                  <span aria-hidden="true">{def.emoji}</span>
                </button>
              ))}
            </div>
            <div className="msg-menu-row">
              {/*
                編集は送信者本人。園チャットに限り管理者同士でもできる。取消は自分の発言だけ（画面詳細図 4-1 No.14・15）。
                管理者には、他者の発言の「削除」を出す。誤送信への対応で、管理者がチャット画面から削除する
                （基本設計書「誤送信への対応」(4-6)、要件定義書「チャットツール」(4-3)「メッセージの削除｜他者が送信した
                メッセージを削除する｜管理者」。GitHub Issue #171）。どちらも確かめてから行う
              */}
              {canEdit && (
                <button type="button" className="btn-sm"
                  onClick={() => { setDraft(message.body); setEditing(true); onMenu(false); }}>編集</button>
              )}
              {mine && (
                <button type="button" className="btn-sm"
                  onClick={() => { closeMenu(); onRetract(); }}>取消</button>
              )}
              {canDelete && (
                <button type="button" className="btn-sm"
                  onClick={() => { closeMenu(); onRetract(); }}>削除</button>
              )}
              <button type="button" className="btn-sm btn-quiet" onClick={closeMenu}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
