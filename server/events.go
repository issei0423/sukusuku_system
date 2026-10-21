package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

/*
 * 相手の操作を、開いている画面へすぐに知らせる（Server-Sent Events）
 * 典拠：ナレッジ/決定事項.md 2026-10-15「相手の画面への反映は、SSE（Server-Sent Events）で即時にする」、
 *      設計方針（作り直しの案）「開いている画面：SSE」(5-1)
 *
 * 画面を開いている間、GET /api/events の接続を1本つないだままにする。
 * 書き込みの API は、変化を見てよい人に「変わった」とだけ送る。画面はそれを受けて、既存の API で読み直す。
 *
 * 知らせに中身を入れないのは、見せてよい項目の判定を既存の API に任せるため。知らせの側で
 * 項目を選び直すと、判定が2か所に分かれて食い違う。送るのは種類と、読み直しに要る最小限の ID だけにする。
 *
 * 誰に送るかも、その情報を返す既存の API と同じ関数（isParticipant・canSeeDiary・canSeeChild・canUseClass・
 * handoutClassIDs など）で決める。判定するのは、いまつないでいる人についてだけである。
 *
 * 知らせは届かないことがある（接続が切れていた、送り先が詰まっていた）。画面は、つながっている間も
 * 間隔を延ばした読み直しを保険として残し、つなぎ直したときはすべてを読み直す（web/src/live.ts）。
 *
 * 知らせとつないでいる画面はサーバのメモリにだけ持つ。サーバを1台で動かす前提である
 * （ナレッジ/決定事項.md 2026-10-15）。Go の標準の機能だけで作り、部品は足さない。
 *
 * 画面側のモック（web/src/api/mock.ts の publish）も、同じ書き込みのあとに同じ知らせを、同じ範囲の人へ出す。
 * 送る範囲を変えるときは両方を直す。
 */

// liveEvent はつないでいる画面へ送る知らせ。種類と ID だけを入れ、記録の中身は入れない
type liveEvent struct {
	Type string `json:"type"`
	// どのチャンネルが変わったか（chat）。開いているチャンネルのメッセージだけを読み直すために使う
	RoomID int64 `json:"room_id,omitempty"`
	// どの日誌が変わったか（diary）
	DiaryID int64 `json:"diary_id,omitempty"`
	// どの配布物が変わったか（handout）
	HandoutID int64 `json:"handout_id,omitempty"`
	// どのクラスの午睡チェックか（nap）。開いている午睡チェック画面のクラスだけを読み直すために使う
	ClassID int64 `json:"class_id,omitempty"`
	// どの園児の記録か（nap・development・physical）
	ChildID string `json:"child_id,omitempty"`
}

// 知らせの種類。画面側（web/src/live.ts の LiveEventType）と同じ並び
const (
	// チャンネルの中身が変わった（送信・編集・取消・リアクション・既読・未対応／対応済み・メンバー）
	evChat = "chat"
	// 日誌が変わった（作成・保存・申請・取り下げ・承認・差し戻し・承認の取り消し、ヒヤリハットの起票）
	evDiary = "diary"
	// 配布物が掲載された・取り下げられた
	evHandout = "handout"
	// 午睡チェックが始まった・終わった、園児の記録・異常時の記録・ヒヤリハットの起票
	evNap = "nap"
	// 発達チェックが保存・確定された、次回の予定日が変わった
	evDevelopment = "development"
	// 身体測定の記録が登録・上書き・削除された
	evPhysical = "physical"
	// 連絡帳（家庭から・確認しました・きょうのようす・ねた・おきた・園から）が変わった（詳細設計書「知らせの種類と送り先」(6-2)）
	evContact = "contact"
)

/*
 * 【仮置き】間隔と数は設計に定めが無い（web/仮置き値.md「開いたままの画面の読み直し（自動更新）」）
 */
const (
	// 空の知らせ（コメント行）を送る間隔。間に入る仕組み（Caddy・Azure の負荷分散など）に、
	// 無通信の接続として切られないようにする。あわせて、セッションの期限切れをこの間隔で見つけて閉じる
	liveHeartbeat = 30 * time.Second
	// 切れたときに、つなぎ直すまでの待ち（EventSource の retry）
	liveRetryMs = 3000
	// 送り先ごとに溜めておける知らせの数。溢れたらその接続を閉じる。画面はつなぎ直したときに
	// すべてを読み直すため、取りこぼしにはならない
	liveBuffer = 16
)

// liveClient は、つないでいる画面1つ（タブ1つ）
type liveClient struct {
	accountID int64
	sessionID string
	events    chan liveEvent
	done      chan struct{}
	once      sync.Once
}

func (c *liveClient) close() { c.once.Do(func() { close(c.done) }) }

// liveHub は、つないでいる画面への知らせを配る。メモリ上にだけ持つ（サーバ1台の前提）
type liveHub struct {
	mu        sync.Mutex
	clients   map[*liveClient]struct{}
	heartbeat time.Duration
}

func newLiveHub() *liveHub {
	return &liveHub{clients: make(map[*liveClient]struct{}), heartbeat: liveHeartbeat}
}

func (h *liveHub) join(accountID int64, sessionID string) *liveClient {
	c := &liveClient{
		accountID: accountID,
		sessionID: sessionID,
		events:    make(chan liveEvent, liveBuffer),
		done:      make(chan struct{}),
	}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	return c
}

func (h *liveHub) leave(c *liveClient) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
	c.close()
}

// accounts は、いまつないでいるアカウント（重複なし）
func (h *liveHub) accounts() []int64 {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	seen := make(map[int64]bool, len(h.clients))
	out := make([]int64, 0, len(h.clients))
	for c := range h.clients {
		if !seen[c.accountID] {
			seen[c.accountID] = true
			out = append(out, c.accountID)
		}
	}
	return out
}

// send は、to のアカウントがつないでいる画面すべてへ知らせを送る。待たない
func (h *liveHub) send(ev liveEvent, to []int64) {
	if h == nil || len(to) == 0 {
		return
	}
	want := make(map[int64]bool, len(to))
	for _, id := range to {
		want[id] = true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if !want[c.accountID] {
			continue
		}
		select {
		case c.events <- ev:
		default:
			// 溜まりすぎている。閉じれば画面はつなぎ直し、そのときにすべてを読み直す
			c.close()
		}
	}
}

/*
closeSessions は、そのセッションでつないでいる画面をすべて閉じる。

セッションが終わったとき（ログアウト・停止・紐づけの解除・パスワードの変更・一時パスワードの再発行）に、
セッションの置き場（session.go の onEnd）から呼ばれる。終わったセッションに知らせを届け続けない。
*/
func (h *liveHub) closeSessions(ids []string) {
	if h == nil || len(ids) == 0 {
		return
	}
	ended := make(map[string]bool, len(ids))
	for _, id := range ids {
		ended[id] = true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if ended[c.sessionID] {
			c.close()
		}
	}
}

// canReceiveLive は、知らせを受け取れる利用者か。停止中・手続きの途中（一時パスワード・規約の再同意）の人は、
// ほかの API を使えない（session.go の requireUser）ため、知らせも送らない
func (u *SessionUser) canReceiveLive() bool {
	return !u.isSuspended() && !u.IsTempPassword && u.TermsAgreed
}

// liveSessionAlive は、つないだときのセッションがまだ使えるかを返す。期限切れ・停止などに気づいて閉じるために使う。
// 判定は session.go の sessionAccount（自動ログアウトと午睡チェックの実施中の例外を含む）。ストアだけで見ると、
// 実施中の職員の接続を閉じてしまう。/api/events は操作に数えない（countsAsOperation）ので、ここで期限は延ばさない
func (a *app) liveSessionAlive(r *http.Request, accountID int64) bool {
	id, ok := a.sessionAccount(r)
	if !ok || id != accountID {
		return false
	}
	u, err := a.loadSessionUser(id)
	return err == nil && u.canReceiveLive()
}

/*
handleEvents は知らせの受け取り口（GET /api/events）。

ログインしていなければ 401、手続きの途中なら 403 を返す（requireUser。ほかの API と同じ）。
ログアウト・停止などでセッションが終わったときは、その場で閉じる（closeSessions）。
セッションの期限が切れたときは、空の知らせを送る機会に気づいて閉じる。
*/
func (a *app) handleEvents(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}

	rc := http.NewResponseController(w)
	// http.Server に WriteTimeout を足しても、この受け取り口だけは時間で切らない。
	// いまは設定していない（main.go）。対応していない書き手（テストの記録器など）では何もしない
	_ = rc.SetWriteDeadline(time.Time{})

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	// 間に入る仕組みに溜め込ませない（nginx が見るヘッダ。Caddy は text/event-stream を見て溜めない）
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	c := a.live.join(u.AccountID, sessionID(r))
	defer a.live.leave(c)
	// 確かめてから送り先に加えるまでの間に、ログアウトされていたら閉じる
	if !a.liveSessionAlive(r, u.AccountID) {
		return
	}

	// 最初にすぐ書き出す。画面は応答を受け取った時点で「つながった」とみなし、1回読み直す
	fmt.Fprintf(w, "retry: %d\n: connected\n\n", liveRetryMs)
	if rc.Flush() != nil {
		return
	}

	ticker := time.NewTicker(a.live.heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-c.done:
			return
		case ev := <-c.events:
			b, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", b)
			if rc.Flush() != nil {
				return
			}
		case <-ticker.C:
			// 期限切れのあとも、つないだままにはしない
			if !a.liveSessionAlive(r, u.AccountID) {
				return
			}
			fmt.Fprint(w, "event: ping\ndata:\n\n")
			if rc.Flush() != nil {
				return
			}
		}
	}
}

/*
notify は、いまつないでいる人のうち、see が真を返す人へ知らせを送る。

see には、その情報を返す既存の API と同じ判定を渡す。迷うときは狭いほうに倒す。
停止中・手続きの途中の人には送らない（canReceiveLive）。
行を読んでいる途中やトランザクションの中では呼ばない（接続を1本に絞っているため。db.go）。
*/
func (a *app) notify(ev liveEvent, see func(u *SessionUser) bool) {
	ids := a.live.accounts()
	if len(ids) == 0 {
		return
	}
	to := make([]int64, 0, len(ids))
	for _, id := range ids {
		u, err := a.loadSessionUser(id)
		if err != nil || !u.canReceiveLive() {
			continue
		}
		if see(u) {
			to = append(to, id)
		}
	}
	a.live.send(ev, to)
}

// ---- 誰に送るか（チャットツール。基本設計書「チャット」(5-5)） ----

// notifyRoomPost は、新しいメッセージを、いまの参加者へ送る。外れた人は外れたあとの投稿を読めない
// （api_chat.go の afterLeftClause。保護者は外れた時点でチャンネルごと読めない）
func (a *app) notifyRoomPost(roomID int64) {
	a.notify(liveEvent{Type: evChat, RoomID: roomID}, func(u *SessionUser) bool {
		return a.isParticipant(u, roomID)
	})
}

// notifyRoomMembers は、チャンネルの一覧に出る人（外れた職員を含む）へ送る。目的別グループの作成・編成のとき
func (a *app) notifyRoomMembers(roomID int64) {
	a.notify(liveEvent{Type: evChat, RoomID: roomID}, func(u *SessionUser) bool {
		return a.isMember(u, roomID)
	})
}

// notifyMessage は、そのメッセージを見られる人へ送る（編集・取消・リアクション）。
// handleChatMessages と同じ判定：後から加わった保護者には加わる前の（保護者がまだいなかった間を除く）、外れた人には外れたあとのメッセージを見せない
func (a *app) notifyMessage(roomID, messageID int64) {
	a.notify(liveEvent{Type: evChat, RoomID: roomID}, func(u *SessionUser) bool {
		return a.isMember(u, roomID) && a.messageVisibleTo(u, messageID)
	})
}

// messageVisibleTo は、そのメッセージがその利用者のメッセージの一覧に出るかを返す（handleChatMessages と同じ条件）。
// チャンネルへの参加は別に確かめること
func (a *app) messageVisibleTo(u *SessionUser, messageID int64) bool {
	q := `SELECT COUNT(*) FROM t_chat_message m WHERE m.chat_message_id = ?` + afterLeftClause
	args := []any{messageID, u.AccountID}
	if u.isGuardian() {
		q += beforeJoinedClause
		args = append(args, u.AccountID)
	}
	var n int
	a.db.QueryRow(q, args...).Scan(&n)
	return n > 0
}

// notifyThreadStatus は、未対応／対応済みの切り替えを、そのチャンネルの職員へだけ送る。
// 未対応／対応済みは保護者の画面には出ない（要件定義書「チャットツール」(4-3)）
func (a *app) notifyThreadStatus(roomID int64) {
	a.notify(liveEvent{Type: evChat, RoomID: roomID}, func(u *SessionUser) bool {
		return u.isStaff() && a.isMember(u, roomID)
	})
}

/*
notifyRead は、新しく既読にしたことを送る。

既読にした本人のほかのタブ（未読の件数が変わる）と、既読の人数が変わるときはそのチャンネルの職員へ送る。
既読の人数は職員の画面にだけ出し、数えるのはチャンネルの種別で決まるロールの既読だけである
（api_chat.go の readCountRoles。保護者が参加するチャンネルでは保護者の既読だけを数える）。
*/
func (a *app) notifyRead(roomID int64, reader *SessionUser) {
	var roomType string
	a.db.QueryRow(`SELECT room_type FROM m_chat_room WHERE chat_room_id = ?`, roomID).Scan(&roomType)
	counted := strings.Contains(readCountRoles(roomType), "'"+reader.Role+"'")
	a.notify(liveEvent{Type: evChat, RoomID: roomID}, func(u *SessionUser) bool {
		if u.AccountID == reader.AccountID {
			return true
		}
		return counted && u.isStaff() && a.isMember(u, roomID)
	})
}

// ---- 誰に送るか（日誌システム。基本設計書「日誌システム」(4-5)） ----

// notifyDiary は、その日誌を参照できる職員へ送る（handleGetDiary と同じ判定。canSeeDiary）。
// 日誌は園内の記録で、保護者へは送らない（詳細設計書「PR #196 からの変更」(6-1)・「日誌」(4-13)）
func (a *app) notifyDiary(diaryID int64) {
	a.notify(liveEvent{Type: evDiary, DiaryID: diaryID}, func(u *SessionUser) bool {
		return u.isStaff() && a.canSeeDiary(u, diaryID)
	})
}

// ---- 誰に送るか（配布物。基本設計書「配布物の掲載と閲覧」(4-6)） ----

// notifyHandout は、その配布物を見られる人へ送る（handleHandouts と同じ判定）。classID が nil なら園全体向け
func (a *app) notifyHandout(handoutID int64, classID *int64) {
	a.notify(liveEvent{Type: evHandout, HandoutID: handoutID}, func(u *SessionUser) bool {
		if classID == nil {
			return true
		}
		ids, all := a.handoutClassIDs(u)
		if all {
			return true
		}
		for _, id := range ids {
			if id == *classID {
				return true
			}
		}
		return false
	})
}

// ---- 誰に送るか（午睡チェック。基本設計書「午睡チェック」(4-7)） ----

/*
notifyNapSession は、午睡チェックの開始・終了を送る。

職員は、そのクラスを扱える人（午睡チェック画面・ダッシュボードの「実施中の午睡チェック」と同じ。canUseClass）。
保護者へは送らない（詳細設計書「PR #196 からの変更」(6-1)）。保護者に届ける「ねた・おきた」は contact で送る（notifyContactChild）。
*/
func (a *app) notifyNapSession(classID int64) {
	a.notify(liveEvent{Type: evNap, ClassID: classID}, func(u *SessionUser) bool {
		return u.isStaff() && a.canUseClass(u, classID)
	})
}

/*
notifyNapChild は、園児1人の午睡の記録を送る。

職員は、その園児を参照できる人（canSeeChild）。保護者へは送らない（詳細設計書「PR #196 からの変更」(6-1)）。
5分ごとの確認・入眠時の体温・対象外・異常時の記録は監査の層で、保護者へは届けない。
「ねた」「おきた」は、あわせて notifyContactChild で保護者へも届ける。
*/
func (a *app) notifyNapChild(classID int64, childID string) {
	a.notify(liveEvent{Type: evNap, ClassID: classID, ChildID: childID}, func(u *SessionUser) bool {
		return u.isStaff() && a.canSeeChild(u, childID)
	})
}

/*
notifyContactChild は、園児1人の連絡帳が変わったことを送る（詳細設計書「知らせの種類と送り先」(6-2)）。

送る相手は、読み直す経路と同じ判定（contactAccess の Read）で決める。職員は担任のクラス・管理者・フリー、
保護者は紐づけが有効か猶予中の家庭だけ。保護者には、その記録の種類が contact.show_items で外されていれば送らない
（知らせが届くこと自体が情報になるため。基本設計書「SSE の知らせの範囲の判定」(6-2)）。
item は home・nap・meal・toilet・temperature・comment・photo・facility。
「ねた」「おきた」は notifyNapChild（職員だけ）とあわせて呼ぶ。モックは web/src/api/mock.ts の publishContactChild。
*/
func (a *app) notifyContactChild(childID, item string) {
	guardianSees := a.guardianSeesItem(item)
	a.notify(liveEvent{Type: evContact, ChildID: childID}, func(u *SessionUser) bool {
		if !a.contactAccess(u, childID).Read {
			return false
		}
		return u.isStaff() || guardianSees
	})
}

// classChildIDs は、そのクラスの園児（t_class_child）
func (a *app) classChildIDs(classID int64) ([]string, error) {
	rows, err := a.db.Query(`SELECT child_id FROM t_class_child WHERE class_id = ?`, classID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out, rows.Err()
}

// ---- 誰に送るか（発達チェック・身体測定。基本設計書「発達チェック・身体測定」(4-8)） ----

// notifyDevelopment は、発達チェックの変化を、その園児を参照できる職員へ送る。
// 発達チェックの API は職員だけが使える（requireStaff）ため、保護者には送らない
//
// 保護者へは確定したとき（finalized）だけ、成長の記録を読める家庭（contactAccess の Read）へ送る。
// 確定した記録が保護者の成長の記録に届くため（詳細設計書「知らせ」(6-2) の development の行、「成長の記録に届くもの」(3-7)）
func (a *app) notifyDevelopment(childID string, finalized bool) {
	a.notify(liveEvent{Type: evDevelopment, ChildID: childID}, func(u *SessionUser) bool {
		if u.isGuardian() {
			return finalized && a.contactAccess(u, childID).Read
		}
		return u.isStaff() && a.canSeeChild(u, childID)
	})
}

// notifyPhysical は、身体測定の記録の変化を、その園児を参照できる人へ送る。
// 保護者へは身体測定を共有するとき（shared。設定 growth.share_physical）だけ、成長の記録を読める家庭へ送る
// （詳細設計書「知らせ」(6-2) の physical の行・「身体測定・共有範囲の経路」(4-12 (4))）
func (a *app) notifyPhysical(childID string, shared bool) {
	a.notify(liveEvent{Type: evPhysical, ChildID: childID}, func(u *SessionUser) bool {
		if u.isGuardian() {
			return shared && a.contactAccess(u, childID).Read
		}
		return a.canSeeChild(u, childID)
	})
}

// sharePhysical は、身体測定を保護者の成長の記録に出すか（設定 growth.share_physical。詳細設計書 (4-12 (4))）
func (a *app) sharePhysical() bool {
	return a.settingText("growth.share_physical", "1") == "1"
}
