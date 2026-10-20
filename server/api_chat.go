package main

import (
	"database/sql"
	"net/http"
	"strings"
)

/*
 * チャットツール
 * 典拠：基本設計書.md「チャットツール」(4-6)・「チャット」(5-5)
 *      図/画面詳細図.md「チャット画面（職員）」(4-1)・「チャット画面（保護者）」(4-2)
 */

// ChatRoom はチャットルーム（m_chat_room）
type ChatRoom struct {
	ChatRoomID   int64   `json:"chat_room_id"`
	RoomType     string  `json:"room_type"`
	ClassID      *int64  `json:"class_id"`
	RoomName     string  `json:"room_name"`
	IsArchived   bool    `json:"is_archived"`
	ThreadStatus *string `json:"thread_status"`
}

// ChatRoomView は画面が扱うチャンネル。未読件数と投稿可否を添える
type ChatRoomView struct {
	Room   ChatRoom `json:"room"`
	Unread int      `json:"unread"`
	// 園全体は一般には投稿欄を表示しない。保護者は個人チャットのみ送受信できる（画面詳細図 4-1・4-2）
	CanPost bool `json:"canPost"`
	// 参加している保護者の人数。投稿が保護者にも届くことを入力欄の近くで示すために使う
	GuardianCount int `json:"guardianCount"`
	// 外れたチャンネル。職員は、外れるまでの過去ログだけを読める（投稿はできない）
	// （図/画面詳細図.md「グループ編成画面」(4-3) No.8、基本設計書「チャット」(5-5)）
	Left bool `json:"left"`
}

// handleChatRooms は参加しているチャンネルを返す。
//
// 職員は left_at が入っていても参照できる。保護者は入った時点で参照できなくなる（基本設計書 5-5）。
// 外れたチャンネルは閲覧のみとし、外れるまでの過去ログだけを見せる（afterLeftClause。GitHub Issue #161）。
func (a *app) handleChatRooms(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	q := `SELECT r.chat_room_id, r.room_type, r.class_id, r.room_name, r.is_archived, r.thread_status,
	             m.left_at IS NOT NULL
	        FROM m_chat_room r
	        JOIN t_chat_member m ON m.chat_room_id = r.chat_room_id
	       WHERE m.account_id = ?`
	if !u.isStaff() {
		q += ` AND m.left_at IS NULL`
	}
	// 園全体 → 職員 → クラス → 目的別 → 個人 の順に並べる
	q += ` ORDER BY CASE r.room_type WHEN '1' THEN 0 WHEN '5' THEN 1 WHEN '2' THEN 2
	                                 WHEN '3' THEN 3 ELSE 4 END, r.chat_room_id`

	rows, err := a.db.Query(q, u.AccountID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "チャンネルを取得できませんでした")
		return
	}
	views := []ChatRoomView{}
	for rows.Next() {
		var (
			room    ChatRoom
			classID sql.NullInt64
			thread  sql.NullString
			left    bool
		)
		if rows.Scan(&room.ChatRoomID, &room.RoomType, &classID, &room.RoomName,
			&room.IsArchived, &thread, &left) != nil {
			continue
		}
		room.ClassID = nullInt(classID)
		// 旧いデモデータは状態を文言で持っていた。コード値（1:未対応 2:対応済み）へそろえる
		if thread.Valid && thread.String == "未対応" {
			thread.String = "1"
		}
		room.ThreadStatus = nullStr(thread)

		canPost := true
		if room.RoomType == "1" {
			canPost = u.isAdmin()
		}
		if u.isGuardian() {
			canPost = room.RoomType == "4"
		}
		// 外れたチャンネルへは投稿できない（図/画面詳細図.md「グループ編成画面」(4-3) No.8）
		if left {
			canPost = false
		}
		views = append(views, ChatRoomView{Room: room, CanPost: canPost, Left: left})
	}
	rows.Close()

	// 未読の数え上げはカーソルを閉じたあとに行う（接続を1本に絞っているため。db.go）
	for i := range views {
		views[i].Unread = a.unreadCount(u, views[i].Room.ChatRoomID)
		// 届く人数は、実際に読める保護者の数。停止中の保護者はログインできず読めないため数えない
		// （図/画面詳細図.md「チャット画面（職員）」(4-1) No.19、GitHub Issue #171）
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_member m
			JOIN m_account ac ON ac.account_id = m.account_id
			WHERE m.chat_room_id = ? AND m.left_at IS NULL`+activeGuardianWhere,
			views[i].Room.ChatRoomID).Scan(&views[i].GuardianCount)
	}
	writeJSON(w, http.StatusOK, views)
}

/*
activeGuardianWhere は、参加者（m_account を ac として引く）のうち、読める保護者に絞る条件。

停止中の保護者（紐づけを終えて有効な紐づけがゼロになった人など。基本設計書「クラスと紐づけ」(5-3)）は、
参加の行が残っていてもログインできず、読めない。「この投稿は、保護者 n 名にも届きます」の n と
メンバー欄には入れない（GitHub Issue #171・#141）。
【仮置き】参加の行（left_at）は動かさず、数えるときに除く。停止は紐づけの終了のほか、管理者のアカウント操作でも
起きるため、どの経路でも同じに扱えるようにする。再開すれば、そのまままた数える（web/仮置き値.md）。
*/
const activeGuardianWhere = ` AND ac.role = '3' AND ac.status = '1'`

/*
beforeJoinedClause は、保護者に見せないメッセージを除く条件。

後から登録した保護者には、登録より前の個人チャットのやりとりを見せない
（基本設計書「チャット」(5-5)）。先に登録していた保護者は、自分の書いたものが
後から加わる人に読まれることを知らないため。職員には適用しない。
メッセージの表を m として引く問い合わせに足し、引数にアカウントIDを1つ加える。

【仮置き】時刻は秒の単位で持つため、登録と同じ秒に送られたメッセージは、登録の前か後かを
区別できない。見せない側へ倒す（GitHub Issue #102）。見せる側へ倒すと、登録の直前に送られた
ものが読めてしまう。
*/
const beforeJoinedClause = ` AND NOT EXISTS (
	SELECT 1 FROM t_chat_member gm
	  JOIN m_chat_room gr ON gr.chat_room_id = gm.chat_room_id
	 WHERE gm.chat_room_id = m.chat_room_id AND gm.account_id = ?
	   AND gr.room_type = '4' AND m.sent_at <= gm.joined_at)`

/*
afterLeftClause は、チャンネルから外れた人に見せないメッセージを除く条件。

外れたあとの投稿は参照させない。読めるのは所属していた期間の過去ログだけである
（図/画面詳細図.md「グループ編成画面」(4-3) No.8「外した参加者は以後の投稿を参照できない」、
基本設計書「メッセージの送受信」(4-6)。GitHub Issue #161）。保護者は外れた時点でチャンネルごと
参照できなくなる（isMember）ため、実際に効くのは職員である。
メッセージの表を m として引く問い合わせに足し、引数にアカウントIDを1つ加える。

【仮置き】時刻は秒の単位で持つため、外れたのと同じ秒に送られたメッセージは、外れる前か後かを
区別できない。見せない側へ倒す（beforeJoinedClause と同じ考え方。web/仮置き値.md）。
*/
const afterLeftClause = ` AND NOT EXISTS (
	SELECT 1 FROM t_chat_member lm
	 WHERE lm.chat_room_id = m.chat_room_id AND lm.account_id = ?
	   AND lm.left_at IS NOT NULL AND m.sent_at >= lm.left_at)`

func (a *app) unreadCount(u *SessionUser, roomID int64) int {
	q := `SELECT COUNT(*) FROM t_chat_message m
		WHERE m.chat_room_id = ? AND m.is_deleted = 0 AND m.sender_account_id <> ?
		  AND NOT EXISTS (SELECT 1 FROM t_chat_read x
		                   WHERE x.chat_message_id = m.chat_message_id AND x.account_id = ?)` + afterLeftClause
	args := []any{roomID, u.AccountID, u.AccountID, u.AccountID}
	if u.isGuardian() {
		q += beforeJoinedClause
		args = append(args, u.AccountID)
	}
	var n int
	a.db.QueryRow(q, args...).Scan(&n)
	return n
}

// memberState は、そのチャンネルへの参加の状態を返す。
// joined は参加の行があるか、left は外れているか（left_at が入っているか）。
func (a *app) memberState(accountID, roomID int64) (joined, left bool) {
	var leftAt sql.NullString
	if err := a.db.QueryRow(`SELECT left_at FROM t_chat_member WHERE chat_room_id = ? AND account_id = ?`,
		roomID, accountID).Scan(&leftAt); err != nil {
		return false, false
	}
	return true, leftAt.Valid
}

// isMember はそのチャンネルを参照できるかを判定する。
// 職員は外れたあとも、所属していた期間の過去ログを参照できる（読む範囲は afterLeftClause で絞る）。
// 保護者は left_at が入った時点で参照できなくなる（基本設計書 5-5）
func (a *app) isMember(u *SessionUser, roomID int64) bool {
	joined, left := a.memberState(u.AccountID, roomID)
	if !joined {
		return false
	}
	return !(left && u.isGuardian())
}

/*
isParticipant は、いまそのチャンネルに参加しているか（外れていないか）を判定する。

投稿・編集・取消・リアクション・未対応の切り替え・メンバー一覧の取得は、いまの参加者に限る。
外れた職員は過去ログを読めるだけで、書くことはできない（基本設計書「メッセージの送受信」(4-6)
「閲覧のみの権限では拒否する」、図/画面詳細図.md 4-3 No.8。GitHub Issue #161）。
*/
func (a *app) isParticipant(u *SessionUser, roomID int64) bool {
	joined, left := a.memberState(u.AccountID, roomID)
	return joined && !left
}

// leftRoomMessage は、外れたチャンネルへ書こうとしたときの知らせ
const leftRoomMessage = "このチャンネルからは外れているため、閲覧のみです"

// ChatMessage はメッセージ（t_chat_message）
type ChatMessage struct {
	ChatMessageID    int64   `json:"chat_message_id"`
	ChatRoomID       int64   `json:"chat_room_id"`
	SenderAccountID  int64   `json:"sender_account_id"`
	Body             string  `json:"body"`
	SourceType       string  `json:"source_type"`
	SourceID         *int64  `json:"source_id"`
	SentAt           string  `json:"sent_at"`
	EditedAt         *string `json:"edited_at"`
	IsDeleted        bool    `json:"is_deleted"`
	DeletedAt        *string `json:"deleted_at"`
	DeletedAccountID *int64  `json:"deleted_account_id"`
	// 画面が使う導出値
	SenderName string `json:"sender_name"`
	/*
	 * 送信者のロール（m_account.role。1:管理者 2:一般 3:保護者）。職員か保護者かを吹き出しに添えるために返す。
	 * 職員と保護者に同じ氏名の人がいると、氏名だけでは誰の発言か分からない（GitHub Issue #141）
	 */
	SenderRole string `json:"sender_role"`
	// 既読は人数で示す。保護者側には表示しない（基本設計書 5-5）
	ReadCount int `json:"read_count"`
	// リアクションの集計。種別ごとの人数と、自分が付けているか
	Reactions []reactionSummary `json:"reactions"`
}

// reactionSummary はメッセージに付いたリアクションの集計（t_chat_reaction から導く）
type reactionSummary struct {
	ReactionType string `json:"reaction_type"`
	Count        int    `json:"count"`
	Mine         bool   `json:"mine"`
}

/*
reactionTypes はリアクションの種別。

【仮置き】要件定義書「チャットツール」(4-3) は「メッセージに絵文字で反応する」とだけ定め、
使える絵文字を定めていない。画面側（web/src/api/codes.ts の REACTION）と同じ並びにしてある。
*/
var reactionTypes = []string{"1", "2", "3", "4"}

func (a *app) reactionsOf(messageID, accountID int64) []reactionSummary {
	out := []reactionSummary{}
	rows, err := a.db.Query(`SELECT reaction_type, COUNT(*), SUM(CASE WHEN account_id = ? THEN 1 ELSE 0 END)
		FROM t_chat_reaction WHERE chat_message_id = ? GROUP BY reaction_type ORDER BY reaction_type`,
		accountID, messageID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var (
			x    reactionSummary
			mine int
		)
		if rows.Scan(&x.ReactionType, &x.Count, &mine) == nil {
			x.Mine = mine > 0
			out = append(out, x)
		}
	}
	return out
}

func (a *app) handleChatMessages(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	roomID, valid := pathInt64(r, "id")
	if !valid || !a.isMember(u, roomID) {
		writeForbidden(w, "このチャンネルを参照する権限がありません")
		return
	}

	// 既読の人数に数える人は、チャンネルの種別で決まる（readCountRoles）。読めなければ数え方を決められない
	var roomType string
	if err := a.db.QueryRow(`SELECT room_type FROM m_chat_room WHERE chat_room_id = ?`, roomID).
		Scan(&roomType); err != nil {
		writeErr(w, http.StatusInternalServerError, "メッセージを取得できませんでした")
		return
	}

	// 外れた職員には、外れたあとの投稿を返さない（GitHub Issue #161）。送信者のロールも一緒に引く
	q := `SELECT m.chat_message_id, m.chat_room_id, m.sender_account_id, m.body,
		m.source_type, m.source_id, m.sent_at, m.edited_at, m.is_deleted, m.deleted_at, m.deleted_account_id,
		IFNULL(sa.role, '')
		FROM t_chat_message m LEFT JOIN m_account sa ON sa.account_id = m.sender_account_id
		WHERE m.chat_room_id = ?` + afterLeftClause
	args := []any{roomID, u.AccountID}
	// 保護者には、自分が参加するより前の個人チャットのやりとりを返さない
	if u.isGuardian() {
		q += beforeJoinedClause
		args = append(args, u.AccountID)
	}
	rows, err := a.db.Query(q+` ORDER BY m.sent_at, m.chat_message_id`, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "メッセージを取得できませんでした")
		return
	}
	out := []ChatMessage{}
	for rows.Next() {
		var (
			m         ChatMessage
			sourceID  sql.NullInt64
			editedAt  sql.NullString
			deletedAt sql.NullString
			delAcc    sql.NullInt64
		)
		if rows.Scan(&m.ChatMessageID, &m.ChatRoomID, &m.SenderAccountID, &m.Body,
			&m.SourceType, &sourceID, &m.SentAt, &editedAt, &m.IsDeleted, &deletedAt, &delAcc, &m.SenderRole) != nil {
			continue
		}
		m.SourceID = nullInt(sourceID)
		m.EditedAt = nullStr(editedAt)
		m.DeletedAt = nullStr(deletedAt)
		m.DeletedAccountID = nullInt(delAcc)
		out = append(out, m)
	}
	rows.Close()

	// 送信者名と既読の数え上げはカーソルを閉じたあとに行う
	readers := readCountRoles(roomType)
	for i := range out {
		out[i].SenderName = a.accountName(out[i].SenderAccountID)
		// 既読は保護者側には表示しない。そもそも返さない（基本設計書 5-5）
		if u.isStaff() {
			var n int
			a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_read r JOIN m_account ac ON ac.account_id = r.account_id
				WHERE r.chat_message_id = ? AND ac.role IN (`+readers+`)`,
				out[i].ChatMessageID).Scan(&n)
			out[i].ReadCount = n
		}
		out[i].Reactions = a.reactionsOf(out[i].ChatMessageID, u.AccountID)
	}
	writeJSON(w, http.StatusOK, out)
}

/*
readCountRoles は、既読の人数に数える人のロール（SQL の IN の中身）を返す。

既読確認は、園が送ったものを保護者が開いたかを職員が確かめるためのもの（要件定義書「チャットツール」(4-3)
「既読確認」、基本設計書「既読確認」(4-6)「保護者がメッセージを開いた時点で既読を記録する」）。
保護者が参加するチャンネル（園全体・クラスグループ・個人チャット。基本設計書「チャット」(5-5)）では、
保護者の既読だけを数える。職員の既読を混ぜると、「保護者 n 名にも届きます」と並んだ「既読 3」が、
3 家庭が読んだと読めてしまう（GitHub Issue #171）。誤送信のときに既読が付いていたかを判断する材料
（同「誤送信への対応」(4-6)）も、保護者が読んだかである。
【仮置き】職員だけのチャンネル（職員チャット・目的別グループ）には保護者がいないため、職員の既読を数える。
設計は職員どうしの既読を定めていない（web/仮置き値.md）。
*/
func readCountRoles(roomType string) string {
	switch roomType {
	case "1", "2", "4":
		return `'3'`
	default:
		return `'1', '2'`
	}
}

/*
handleToggleReaction はリアクションを付ける・外す。同じ種別をもう一度選ぶと外れる。

全ロールが使える（要件定義書「チャットツール」(4-3)）。
既読を保護者側に表示しないため、「読みました」を一言で返す手段にもなる。
*/
func (a *app) handleToggleReaction(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "メッセージの指定が正しくありません")
		return
	}
	var req struct {
		ReactionType string `json:"reaction_type"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !oneOf(req.ReactionType, reactionTypes...) {
		writeErr(w, http.StatusBadRequest, "リアクションの指定が正しくありません")
		return
	}
	var (
		roomID    int64
		isDeleted bool
	)
	if err := a.db.QueryRow(`SELECT chat_room_id, is_deleted FROM t_chat_message WHERE chat_message_id = ?`,
		id).Scan(&roomID, &isDeleted); err != nil {
		writeErr(w, http.StatusNotFound, "メッセージが見つかりません")
		return
	}
	if !a.isMember(u, roomID) {
		writeForbidden(w, "このチャンネルを参照する権限がありません")
		return
	}
	// 外れたチャンネルの過去ログには反応できない。閲覧のみである（GitHub Issue #161）
	if !a.isParticipant(u, roomID) {
		writeForbidden(w, leftRoomMessage)
		return
	}
	// 後から登録した保護者には、登録より前のメッセージを見せない。見えないものには反応もできない
	// （GitHub Issue #100）。存在を知らせないよう、見つからないときと同じ応答にする
	if u.isGuardian() {
		var visible int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message m WHERE m.chat_message_id = ?`+beforeJoinedClause,
			id, u.AccountID).Scan(&visible)
		if visible == 0 {
			writeErr(w, http.StatusNotFound, "メッセージが見つかりません")
			return
		}
	}
	if isDeleted {
		writeErr(w, http.StatusConflict, "取り消したメッセージには反応できません")
		return
	}
	res, err := a.db.Exec(`DELETE FROM t_chat_reaction
		WHERE chat_message_id = ? AND account_id = ? AND reaction_type = ?`, id, u.AccountID, req.ReactionType)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "リアクションを保存できませんでした")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if _, err := a.db.Exec(`INSERT INTO t_chat_reaction (chat_message_id, account_id, reaction_type)
			VALUES (?, ?, ?)`, id, u.AccountID, req.ReactionType); err != nil {
			writeErr(w, http.StatusInternalServerError, "リアクションを保存できませんでした")
			return
		}
	}
	// そのメッセージを見られる人の画面へ知らせる（events.go）
	a.notifyMessage(roomID, id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

/*
handleSetThreadStatus は個人チャットのスレッドを「未対応／対応済み」に切り替える。

職員だけが切り替えられる。保護者から新しく受信したときは自動で未対応へ戻る
（要件定義書「チャットツール」(4-3)）。欠席・遅刻・お迎え時間の変更をチャットで受ける想定のため、
園の側で見落とさない仕組みはこの状態に頼っている。
*/
func (a *app) handleSetThreadStatus(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	roomID, valid := pathInt64(r, "id")
	if !valid || !a.isMember(u, roomID) {
		writeForbidden(w, "このチャンネルを参照する権限がありません")
		return
	}
	// 外れた個人チャット（前のクラスの家庭など）の状態は切り替えられない（GitHub Issue #161・#162）
	if !a.isParticipant(u, roomID) {
		writeForbidden(w, leftRoomMessage)
		return
	}
	var req struct {
		Status string `json:"status"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !oneOf(req.Status, "1", "2") {
		writeErr(w, http.StatusBadRequest, "状態の指定が正しくありません")
		return
	}
	var roomType string
	a.db.QueryRow(`SELECT room_type FROM m_chat_room WHERE chat_room_id = ?`, roomID).Scan(&roomType)
	if roomType != "4" {
		writeErr(w, http.StatusBadRequest, "未対応／対応済みを持つのは個人チャットだけです")
		return
	}
	if _, err := a.db.Exec(`UPDATE m_chat_room SET thread_status = ? WHERE chat_room_id = ?`,
		req.Status, roomID); err != nil {
		writeErr(w, http.StatusInternalServerError, "状態を切り替えられませんでした")
		return
	}
	after := "対応済み"
	if req.Status == "1" {
		after = "未対応"
	}
	a.log(u.AccountID, fnChat, opUpdate, "m_chat_room", i64(roomID), nil, nil, s(after))
	// 未対応／対応済みは職員の画面にだけ出る。保護者には送らない（events.go）
	a.notifyThreadStatus(roomID)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) handleMarkRead(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	roomID, valid := pathInt64(r, "id")
	if !valid || !a.isMember(u, roomID) {
		writeForbidden(w, "このチャンネルを参照する権限がありません")
		return
	}
	/*
	 * 既読にするのは読めるメッセージだけ。外れた職員の、外れたあとの投稿は含めない（GitHub Issue #161）。
	 * 後から登録した保護者の、登録より前の個人チャットのやりとりも含めない。見えていないものを既読にすると、
	 * 誤送信のときに既読が付いていたかの判断を誤らせる（基本設計書「既読確認」(4-6)「保護者がメッセージを
	 * 開いた時点で既読を記録する」・「チャット」(5-5)。GitHub Issue #171）。未読の数え方（unreadCount）と同じ範囲
	 */
	q := `INSERT OR IGNORE INTO t_chat_read (chat_message_id, account_id, read_at)
		SELECT m.chat_message_id, ?, ? FROM t_chat_message m
		 WHERE m.chat_room_id = ? AND m.is_deleted = 0 AND m.sender_account_id <> ?` + afterLeftClause
	args := []any{u.AccountID, now(), roomID, u.AccountID, u.AccountID}
	if u.isGuardian() {
		q += beforeJoinedClause
		args = append(args, u.AccountID)
	}
	res, err := a.db.Exec(q, args...)
	// 新しく既読にしたものがあれば知らせる（events.go）。何も増えなかったときは送らない。
	// 画面はチャンネルを開くたび・メッセージが届くたびに既読にするため
	if err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			a.notifyRead(roomID, u)
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) handleSendMessage(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	roomID, valid := pathInt64(r, "id")
	if !valid || !a.isMember(u, roomID) {
		writeForbidden(w, "このチャンネルを参照する権限がありません")
		return
	}
	// 外れたチャンネルへは投稿できない。閲覧のみの権限では拒否する
	// （基本設計書「メッセージの送受信」(4-6)、図/画面詳細図.md 4-3 No.8。GitHub Issue #161）
	if !a.isParticipant(u, roomID) {
		writeForbidden(w, leftRoomMessage)
		return
	}
	var req struct {
		Body string `json:"body"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		writeErr(w, http.StatusBadRequest, "メッセージを入力してください")
		return
	}
	// 編集と同じ上限（基本設計書「入力項目の制約値」(4-9)）
	if tooLong(req.Body, 1000) {
		writeErr(w, http.StatusBadRequest, "本文は1,000文字以内で入力してください")
		return
	}

	var roomType string
	a.db.QueryRow(`SELECT room_type FROM m_chat_room WHERE chat_room_id = ?`, roomID).Scan(&roomType)
	// 園全体は管理者のみが投稿できる。保護者は個人チャットのみ
	if roomType == "1" && !u.isAdmin() {
		writeForbidden(w, "園全体への投稿は管理者が行います")
		return
	}
	if u.isGuardian() && roomType != "4" {
		writeForbidden(w, "このチャンネルへは投稿できません")
		return
	}

	res, err := a.db.Exec(`INSERT INTO t_chat_message
		(chat_room_id, sender_account_id, body, source_type, sent_at, is_deleted)
		VALUES (?, ?, ?, '1', ?, 0)`, roomID, u.AccountID, req.Body, now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "送信に失敗しました")
		return
	}
	id, _ := res.LastInsertId()
	// 保護者から新しく受信した個人チャットは、自動で未対応へ戻す（要件定義書「チャットツール」(4-3)）
	if u.isGuardian() && roomType == "4" {
		a.db.Exec(`UPDATE m_chat_room SET thread_status = '1' WHERE chat_room_id = ?`, roomID)
	}
	a.log(u.AccountID, fnChat, opCreate, "t_chat_message", i64(id), nil, nil, s("送信"))
	// いまの参加者の画面へ知らせる（events.go）
	a.notifyRoomPost(roomID)
	writeJSON(w, http.StatusOK, map[string]int64{"chat_message_id": id})
}

// handleRetractMessage は取消。本文を残さず、取消の事実だけを残す
// （基本設計書「誤送信への対応」(4-6)）
func (a *app) handleRetractMessage(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "メッセージの指定が正しくありません")
		return
	}
	var sender, roomID int64
	var body string
	var isDeleted bool
	if err := a.db.QueryRow(`SELECT sender_account_id, chat_room_id, body, is_deleted FROM t_chat_message
		WHERE chat_message_id = ?`, id).Scan(&sender, &roomID, &body, &isDeleted); err != nil {
		writeErr(w, http.StatusNotFound, "メッセージが見つかりません")
		return
	}
	if sender != u.AccountID && !u.isAdmin() {
		writeForbidden(w, "自分が送信したメッセージのみ取り消せます")
		return
	}
	// 外れたチャンネルのメッセージは、送った本人でも取り消せない（閲覧のみ。GitHub Issue #161）。
	// 誤送信への対応は管理者が行う（基本設計書「誤送信への対応」(4-6)）ため、管理者は参加を問わない
	if !u.isAdmin() && !a.isParticipant(u, roomID) {
		writeForbidden(w, leftRoomMessage)
		return
	}
	// 取り消した日時と操作ログを上書き・重複させない（GitHub Issue #100）
	if isDeleted {
		writeErr(w, http.StatusConflict, "このメッセージはすでに取り消されています")
		return
	}
	if _, err := a.db.Exec(`UPDATE t_chat_message
		SET is_deleted = 1, body = '', deleted_at = ?, deleted_account_id = ?
		WHERE chat_message_id = ?`, now(), u.AccountID, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "取消に失敗しました")
		return
	}
	a.log(u.AccountID, fnChat, opDelete, "t_chat_message", i64(id), nil, s(body), s("取消"))
	a.notifyMessage(roomID, id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) handleEditMessage(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "メッセージの指定が正しくありません")
		return
	}
	var req struct {
		Body string `json:"body"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	// 空の本文は受け付けない。上限は新規送信と同じ（基本設計書「入力項目の制約値」(4-9)）
	if strings.TrimSpace(req.Body) == "" {
		writeErr(w, http.StatusBadRequest, "本文を入力してください")
		return
	}
	if len([]rune(req.Body)) > 1000 {
		writeErr(w, http.StatusBadRequest, "本文は1,000文字以内で入力してください")
		return
	}

	var sender, roomID int64
	var before string
	var isDeleted bool
	var roomType string
	if err := a.db.QueryRow(`SELECT m.sender_account_id, m.chat_room_id, m.body, m.is_deleted, r.room_type
		FROM t_chat_message m JOIN m_chat_room r ON r.chat_room_id = m.chat_room_id
		WHERE m.chat_message_id = ?`, id).Scan(&sender, &roomID, &before, &isDeleted, &roomType); err != nil {
		writeErr(w, http.StatusNotFound, "メッセージが見つかりません")
		return
	}
	/*
	 * 編集できるのは送信者本人。園チャット（room_type=1）だけは例外で、管理者同士なら互いに編集できる
	 * （基本設計書「メッセージの編集」(4-6)）。園全体への発信は園としての意思表示であり、
	 * 発信者個人のものではないため。園チャットへ投稿できるのは管理者だけなので、
	 * 送信者の権限を改めて調べる必要はない
	 */
	if sender != u.AccountID && !(roomType == "1" && u.isAdmin()) {
		writeForbidden(w, "自分が送信したメッセージのみ編集できます")
		return
	}
	// 外れたチャンネルのメッセージは、送った本人でも編集できない。編集はいまの参加者が読む本文を
	// 書き換えるため、投稿と同じく閲覧のみの権限では拒否する（GitHub Issue #161）
	if !a.isParticipant(u, roomID) {
		writeForbidden(w, leftRoomMessage)
		return
	}
	// 取り消し済みのものは編集できない（基本設計書「メッセージの編集」(4-6)）
	if isDeleted {
		writeErr(w, http.StatusConflict, "取り消したメッセージは編集できません")
		return
	}
	if _, err := a.db.Exec(`UPDATE t_chat_message SET body = ?, edited_at = ? WHERE chat_message_id = ?`,
		req.Body, now(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "編集に失敗しました")
		return
	}
	a.log(u.AccountID, fnChat, opUpdate, "t_chat_message", i64(id), nil, s(before), s(req.Body))
	a.notifyMessage(roomID, id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type memberView struct {
	AccountID int64  `json:"account_id"`
	Name      string `json:"name"`
	// 保護者が入っているチャンネルかを画面で示すために返す
	Role string `json:"role"`
	// 続柄。職員にだけ返す。お迎えに来る人が誰なのかを職員が確かめられるようにするため
	// （基本設計書「チャット」(5-5)）
	Relationship *string `json:"relationship"`
}

func (a *app) handleChatMembers(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	roomID, _ := pathInt64(r, "id")
	// 参加していないチャンネルのメンバーは返さない。ほかの家庭の保護者の氏名や続柄が読めてしまう
	// （GitHub Issue #95）。外れた人にも、いまの参加者は返さない（外れたあとのことは見せない。#161）。
	// 管理者は、グループ編成のために全チャンネルを参照できる
	// 要件定義書「チャットツール」(4-3)：メンバー一覧は管理者・一般のみ。
	// 保護者が参加中でも、ほかの家庭の氏名を返さない。
	if !u.isStaff() || (!u.isAdmin() && !a.isParticipant(u, roomID)) {
		writeForbidden(w, "このチャンネルを参照する権限がありません")
		return
	}
	// 停止中の保護者は、読めないため並べない（activeGuardianWhere と同じ考え方。GitHub Issue #171・#141）。
	// 停止中の職員は除かない。目的別グループの編成は、いまの参加者を初期値にして送るため（groupMemberError）
	rows, err := a.db.Query(`SELECT m.account_id FROM t_chat_member m
		JOIN m_account ac ON ac.account_id = m.account_id
		WHERE m.chat_room_id = ? AND m.left_at IS NULL AND NOT (ac.role = '3' AND ac.status <> '1')
		ORDER BY m.account_id`, roomID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "メンバーを取得できませんでした")
		return
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()

	out := []memberView{}
	for _, id := range ids {
		var role string
		a.db.QueryRow(`SELECT role FROM m_account WHERE account_id = ?`, id).Scan(&role)
		m := memberView{AccountID: id, Name: a.accountName(id), Role: role}
		if role == roleGuardian && u.isStaff() {
			m.Relationship = a.relationshipOf(id)
		}
		out = append(out, m)
	}
	writeJSON(w, http.StatusOK, out)
}

// relationshipOf は保護者アカウントの続柄を返す。有効な紐づけのものを、重複を除いて並べる
func (a *app) relationshipOf(accountID int64) *string {
	rows, err := a.db.Query(`SELECT DISTINCT gc.relationship FROM t_guardian_child gc
		JOIN m_guardian g ON g.guardian_id = gc.guardian_id
		WHERE g.account_id = ? AND gc.link_status = '1' ORDER BY gc.relationship`, accountID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	list := []string{}
	for rows.Next() {
		var rel string
		if rows.Scan(&rel) == nil && rel != "" {
			list = append(list, rel)
		}
	}
	if len(list) == 0 {
		return nil
	}
	return s(strings.Join(list, "・"))
}

// ---- グループ編成（基本設計書「画面の一覧」(3-2)） ----

// handleGroupCandidates は、目的別グループへ入れられる相手（有効な職員）を返す。
// グループの編成は一般（保育士）にも認めている（基本設計書の権限一覧「グループの作成・メンバー編成」）。
// 管理者向けのアカウント一覧（/api/admin/accounts）は一般には返さないため、候補を別に用意する。
// 目的別グループは職員だけのものなので、保護者は含めない（基本設計書「チャット」(5-5)）。
func (a *app) handleGroupCandidates(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT account_id, role FROM m_account
		WHERE role IN ('1', '2') AND status = '1' ORDER BY account_id`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "候補を取得できませんでした")
		return
	}
	type row struct {
		AccountID int64  `json:"account_id"`
		Name      string `json:"name"`
		Role      string `json:"role"`
	}
	out := []row{}
	for rows.Next() {
		var x row
		if rows.Scan(&x.AccountID, &x.Role) == nil {
			out = append(out, x)
		}
	}
	rows.Close()
	for i := range out {
		out[i].Name = a.accountName(out[i].AccountID)
	}
	writeJSON(w, http.StatusOK, out)
}

/*
handleChatGroups は、グループ編成画面に並べる目的別グループを返す。

管理者にはすべてのグループを返す（要件定義書「チャットツール」(4-3) (c)「管理者：すべてのグループ」）。
一般（保育士）には、いま参加しているグループだけを返す。編成できるのはそれだけであり（handleUpdateGroupMembers）、
参加していないグループのメンバーは返さない（handleChatMembers）ため、出しても名前だけが並んで何もできない
（図/画面詳細図.md「グループ編成画面」(4-3)「参照できないグループはチャンネル一覧に出さない」。GitHub Issue #172）。
外されたグループの過去ログは、チャット画面の「外れたチャンネル（閲覧のみ）」から読める。
*/
func (a *app) handleChatGroups(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	q := `SELECT r.chat_room_id, r.room_type, r.class_id, r.room_name, r.is_archived, r.thread_status
	        FROM m_chat_room r WHERE r.room_type = '3'`
	args := []any{}
	if !u.isAdmin() {
		q += ` AND EXISTS (SELECT 1 FROM t_chat_member m
		                    WHERE m.chat_room_id = r.chat_room_id AND m.account_id = ? AND m.left_at IS NULL)`
		args = append(args, u.AccountID)
	}
	rows, err := a.db.Query(q+` ORDER BY r.chat_room_id`, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "グループを取得できませんでした")
		return
	}
	defer rows.Close()
	out := []ChatRoom{}
	for rows.Next() {
		var (
			g       ChatRoom
			classID sql.NullInt64
			thread  sql.NullString
		)
		if rows.Scan(&g.ChatRoomID, &g.RoomType, &classID, &g.RoomName, &g.IsArchived, &thread) != nil {
			continue
		}
		g.ClassID = nullInt(classID)
		g.ThreadStatus = nullStr(thread)
		out = append(out, g)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var req struct {
		Name       string  `json:"name"`
		AccountIDs []int64 `json:"account_ids"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeErr(w, http.StatusBadRequest, "グループ名を入力してください")
		return
	}
	if tooLong(req.Name, 50) {
		writeErr(w, http.StatusBadRequest, "グループ名は50文字以内で入力してください")
		return
	}
	seen := map[int64]bool{u.AccountID: true}
	for _, id := range req.AccountIDs {
		seen[id] = true
	}
	// 入れられるのは有効な職員だけ。保護者は入れない（GitHub Issue #161）
	if msg := a.groupMemberError(seen, nil); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "グループを作成できませんでした")
		return
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT INTO m_chat_room (room_type, room_name, is_archived)
		VALUES ('3', ?, 0)`, req.Name)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "グループを作成できませんでした")
		return
	}
	roomID, _ := res.LastInsertId()
	for id := range seen {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO t_chat_member (chat_room_id, account_id, joined_at)
			VALUES (?, ?, ?)`, roomID, id, now()); err != nil {
			writeErr(w, http.StatusInternalServerError, "グループを作成できませんでした")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "グループを作成できませんでした")
		return
	}
	a.log(u.AccountID, fnChat, opCreate, "m_chat_room", i64(roomID), nil, nil,
		s("グループ「"+req.Name+"」を作成"))
	// 加えた人のチャンネルの一覧に出す（events.go）
	a.notifyRoomMembers(roomID)
	writeJSON(w, http.StatusOK, map[string]int64{"chat_room_id": roomID})
}

/*
groupMemberError は、目的別グループへ入れられない相手が含まれていれば、その理由を返す。

入れられるのは職員だけで、保護者は入れない（基本設計書「チャット」(5-5)「保護者は目的別グループへ
入れない」、図/画面詳細図.md「グループ編成画面」(4-3) No.6「候補に出すのは職員のみ」）。
新しく加えるのは有効な職員に限る。候補（handleGroupCandidates）と同じ範囲である。

【仮置き】すでに参加している職員は、停止していてもそのまま残せる（current に含めて渡す）。
停止は目的別グループの参加を変えない（手で編成するものであるため。chat_membership.go）。
画面は編成の初期値にいまの参加者を入れて送ってくるので、ここで断ると、停止した職員がいる
グループを誰も編成できなくなる。
*/
func (a *app) groupMemberError(ids map[int64]bool, current map[int64]bool) string {
	for id := range ids {
		var role, status string
		if err := a.db.QueryRow(`SELECT role, status FROM m_account WHERE account_id = ?`, id).
			Scan(&role, &status); err != nil {
			return "存在しないアカウントが含まれています"
		}
		if role != roleAdmin && role != roleGeneralStaff {
			return "目的別グループに入れられるのは職員だけです。保護者は入れられません"
		}
		if status != "1" && !current[id] {
			return "停止している職員は加えられません"
		}
	}
	return ""
}

/*
handleUpdateGroupMembers はメンバーを編成する。
退出は left_at を入れて所属期間を残す。過去ログの参照範囲の判定に用いるため（基本設計書 5-5）。

編成できるのは目的別グループだけである。クラス・個人・職員・園全体のチャンネルの参加者は、
担任の割り当てとアカウントから自動で決まり、手で編集しない（要件定義書「チャットツール」(4-3)
機能一覧「グループの作成・メンバー編成｜目的別グループのみ」・(a)、chat_membership.go）。

【仮置き】一般（保育士）は、いま参加している目的別グループだけを編成できる。参加していない
グループに自分を加えられると、所属したことのないグループの過去ログが読めてしまう
（要件定義書 4-3 (c)「所属したことのないグループは…参照できない」）。管理者はすべてのグループを
参照できる（同 (c)）ため、参加していなくても編成できる。GitHub Issue #161。
*/
func (a *app) handleUpdateGroupMembers(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	roomID, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "グループの指定が正しくありません")
		return
	}
	var req struct {
		AccountIDs []int64 `json:"account_ids"`
	}
	if !readJSON(w, r, &req) {
		return
	}

	var roomType string
	if err := a.db.QueryRow(`SELECT room_type FROM m_chat_room WHERE chat_room_id = ?`, roomID).
		Scan(&roomType); err != nil {
		writeErr(w, http.StatusNotFound, "グループが見つかりません")
		return
	}
	if roomType != "3" {
		writeErr(w, http.StatusBadRequest,
			"メンバーを編成できるのは目的別グループだけです。クラス・個人・職員・園全体のチャンネルの参加者は、担任の割り当てとアカウントから自動で決まります")
		return
	}
	if !u.isAdmin() && !a.isParticipant(u, roomID) {
		writeForbidden(w, "参加していないグループは編成できません")
		return
	}

	target := map[int64]bool{}
	for _, id := range req.AccountIDs {
		target[id] = true
	}
	ids, err := queryIDs(a.db, `SELECT account_id FROM t_chat_member
		WHERE chat_room_id = ? AND left_at IS NULL`, roomID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "メンバーを取得できませんでした")
		return
	}
	current := map[int64]bool{}
	for _, id := range ids {
		current[id] = true
	}
	if msg := a.groupMemberError(target, current); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "メンバーを編成できませんでした")
		return
	}
	defer tx.Rollback()
	// 外れた人は left_at を入れる。レコードは消さない
	for id := range current {
		if target[id] {
			continue
		}
		if _, err := tx.Exec(`UPDATE t_chat_member SET left_at = ? WHERE chat_room_id = ? AND account_id = ?`,
			now(), roomID, id); err != nil {
			writeErr(w, http.StatusInternalServerError, "メンバーを編成できませんでした")
			return
		}
	}
	// 加わった人は入れ直す。参加を続ける人の joined_at は動かさない
	for id := range target {
		if current[id] {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at, left_at)
			VALUES (?, ?, ?, NULL)
			ON CONFLICT(chat_room_id, account_id) DO UPDATE SET left_at = NULL, joined_at = excluded.joined_at`,
			roomID, id, now()); err != nil {
			writeErr(w, http.StatusInternalServerError, "メンバーを編成できませんでした")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "メンバーを編成できませんでした")
		return
	}
	a.log(u.AccountID, fnChat, opUpdate, "t_chat_member", i64(roomID), nil, nil, s("メンバーを編成"))
	// 加わった人・外れた人の一覧を読み直させる。外れた職員の一覧にも、閲覧のみとして残る（isMember。events.go）
	a.notifyRoomMembers(roomID)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- 誤送信への対応の記録（基本設計書「誤送信への対応」(4-6)、5-5） ----

func (a *app) handleMisdeliveryRecords(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT d.misdelivery_record_id, d.chat_message_id, d.occurred_at,
		d.was_read, d.response, d.staff_id, IFNULL(r.room_name, '―')
		FROM t_misdelivery_record d
		LEFT JOIN t_chat_message m ON m.chat_message_id = d.chat_message_id
		LEFT JOIN m_chat_room    r ON r.chat_room_id    = m.chat_room_id
		ORDER BY d.occurred_at DESC`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "誤送信対応の記録を取得できませんでした")
		return
	}
	type row struct {
		MisdeliveryRecordID int64  `json:"misdelivery_record_id"`
		ChatMessageID       int64  `json:"chat_message_id"`
		OccurredAt          string `json:"occurred_at"`
		WasRead             bool   `json:"was_read"`
		Response            string `json:"response"`
		StaffID             string `json:"staff_id"`
		RoomName            string `json:"room_name"`
		StaffName           string `json:"staff_name"`
	}
	out := []row{}
	for rows.Next() {
		var x row
		if rows.Scan(&x.MisdeliveryRecordID, &x.ChatMessageID, &x.OccurredAt,
			&x.WasRead, &x.Response, &x.StaffID, &x.RoomName) == nil {
			out = append(out, x)
		}
	}
	rows.Close()
	for i := range out {
		out[i].StaffName = a.staffName(out[i].StaffID)
	}
	writeJSON(w, http.StatusOK, out)
}

// handleRetractedWithoutRecord は取消済みで、まだ対応を記録していないメッセージを返す。
// 「取り消した」だけで終わらせず、既読の有無と対応を残させるため。
// 配布物の掲載の知らせ（source_type = 4）は対象にしない。配布物を取り下げると知らせも
// 取り消されるが、それは人が打ったメッセージの誤送信ではなく、取り下げとして操作ログに残る
// （基本設計書「誤送信への対応」(4-6)。GitHub Issue #98）。
// 【仮置き】保護者が送ったメッセージも対象にしない。誤送信への対応は、園が他児の記録などを誤って
// 別の保護者へ送ったときのもの（同 (4-6) の利用タイミング）であり、保護者の打ちまちがいの取消は当たらない。
// 対象にすると、園長が何か記録するまで一覧に残り続ける（GitHub Issue #171。web/仮置き値.md）
func (a *app) handleRetractedWithoutRecord(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	// 【仮置き】並びは送信の新しい順、同じ時刻はあとで送ったもの（メッセージの番号の大きいもの）を先にする
	// （web/仮置き値.md「一覧の並び順」）。モック（web/src/api/mock.ts の retractedWithoutRecord）も同じ並びにした
	// （GitHub Issue #177 の 7）
	rows, err := a.db.Query(`SELECT m.chat_message_id, IFNULL(r.room_name, '―'), m.sent_at,
		m.deleted_at, m.sender_account_id
		FROM t_chat_message m
		LEFT JOIN m_chat_room r ON r.chat_room_id = m.chat_room_id
		WHERE m.is_deleted = 1
		  AND m.source_type <> '4'
		  AND m.sender_account_id NOT IN (SELECT account_id FROM m_account WHERE role = '3')
		  AND m.chat_message_id NOT IN (SELECT chat_message_id FROM t_misdelivery_record)
		ORDER BY m.sent_at DESC, m.chat_message_id DESC`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "取消メッセージを取得できませんでした")
		return
	}
	type row struct {
		ChatMessageID int64   `json:"chat_message_id"`
		RoomName      string  `json:"room_name"`
		SentAt        string  `json:"sent_at"`
		DeletedAt     *string `json:"deleted_at"`
		SenderName    string  `json:"sender_name"`
		senderID      int64
	}
	out := []row{}
	for rows.Next() {
		var (
			x         row
			deletedAt sql.NullString
		)
		if rows.Scan(&x.ChatMessageID, &x.RoomName, &x.SentAt, &deletedAt, &x.senderID) == nil {
			x.DeletedAt = nullStr(deletedAt)
			out = append(out, x)
		}
	}
	rows.Close()
	for i := range out {
		out[i].SenderName = a.accountName(out[i].senderID)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) handleAddMisdeliveryRecord(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		ChatMessageID int64  `json:"chat_message_id"`
		OccurredAt    string `json:"occurred_at"`
		WasRead       bool   `json:"was_read"`
		Response      string `json:"response"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Response) == "" {
		writeErr(w, http.StatusBadRequest, "とった対応を入力してください")
		return
	}
	if tooLong(req.Response, 1000) {
		writeErr(w, http.StatusBadRequest, "とった対応は1,000文字以内で入力してください")
		return
	}
	// 発生日時は必須（図/画面詳細図.md「誤送信対応記録画面（管理者）」(4-4) 項目3）。
	// 空のときに記録した時刻を入れると、監査の記録が事実と違う時刻になるため断る（GitHub Issue #178 の 1）
	if req.OccurredAt == "" {
		writeErr(w, http.StatusBadRequest, "発生日時を入力してください")
		return
	}
	if !isISODateTime(req.OccurredAt) {
		writeErr(w, http.StatusBadRequest, "発生日時の形式が正しくありません")
		return
	}
	if _, err := a.db.Exec(`INSERT INTO t_misdelivery_record
		(chat_message_id, occurred_at, was_read, response, staff_id) VALUES (?, ?, ?, ?, ?)`,
		req.ChatMessageID, req.OccurredAt, req.WasRead, req.Response, u.staff()); err != nil {
		writeErr(w, http.StatusInternalServerError, "記録に失敗しました")
		return
	}
	a.log(u.AccountID, fnChat, opCreate, "t_misdelivery_record", i64(req.ChatMessageID), nil, nil,
		s("誤送信への対応を記録"))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
