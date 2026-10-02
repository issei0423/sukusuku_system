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
}

// handleChatRooms は参加しているチャンネルを返す。
//
// 職員は left_at が入っていても参照できる。保護者は入った時点で参照できなくなる（基本設計書 5-5）。
func (a *app) handleChatRooms(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	q := `SELECT r.chat_room_id, r.room_type, r.class_id, r.room_name, r.is_archived, r.thread_status
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
		)
		if rows.Scan(&room.ChatRoomID, &room.RoomType, &classID, &room.RoomName,
			&room.IsArchived, &thread) != nil {
			continue
		}
		room.ClassID = nullInt(classID)
		room.ThreadStatus = nullStr(thread)

		canPost := true
		if room.RoomType == "1" {
			canPost = u.isAdmin()
		}
		if u.isGuardian() {
			canPost = room.RoomType == "4"
		}
		views = append(views, ChatRoomView{Room: room, CanPost: canPost})
	}
	rows.Close()

	// 未読の数え上げはカーソルを閉じたあとに行う（接続を1本に絞っているため。db.go）
	for i := range views {
		views[i].Unread = a.unreadCount(u.AccountID, views[i].Room.ChatRoomID)
	}
	writeJSON(w, http.StatusOK, views)
}

func (a *app) unreadCount(accountID, roomID int64) int {
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message m
		WHERE m.chat_room_id = ? AND m.is_deleted = 0 AND m.sender_account_id <> ?
		  AND NOT EXISTS (SELECT 1 FROM t_chat_read x
		                   WHERE x.chat_message_id = m.chat_message_id AND x.account_id = ?)`,
		roomID, accountID, accountID).Scan(&n)
	return n
}

// isMember はそのチャンネルを参照できるかを判定する
func (a *app) isMember(u *SessionUser, roomID int64) bool {
	var leftAt sql.NullString
	err := a.db.QueryRow(`SELECT left_at FROM t_chat_member WHERE chat_room_id = ? AND account_id = ?`,
		roomID, u.AccountID).Scan(&leftAt)
	if err != nil {
		return false
	}
	// 保護者は left_at が入った時点で参照できなくなる（基本設計書 5-5）
	if u.isGuardian() && leftAt.Valid {
		return false
	}
	return true
}

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
	// 既読は人数で示す。保護者側には表示しない（基本設計書 5-5）
	ReadCount int `json:"read_count"`
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

	rows, err := a.db.Query(`SELECT chat_message_id, chat_room_id, sender_account_id, body,
		source_type, source_id, sent_at, edited_at, is_deleted, deleted_at, deleted_account_id
		FROM t_chat_message WHERE chat_room_id = ? ORDER BY sent_at, chat_message_id`, roomID)
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
			&m.SourceType, &sourceID, &m.SentAt, &editedAt, &m.IsDeleted, &deletedAt, &delAcc) != nil {
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
	for i := range out {
		out[i].SenderName = a.accountName(out[i].SenderAccountID)
		// 既読は保護者側には表示しない。そもそも返さない（基本設計書 5-5）
		if u.isStaff() {
			var n int
			a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_read WHERE chat_message_id = ?`,
				out[i].ChatMessageID).Scan(&n)
			out[i].ReadCount = n
		}
	}
	writeJSON(w, http.StatusOK, out)
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
	a.db.Exec(`INSERT OR IGNORE INTO t_chat_read (chat_message_id, account_id, read_at)
		SELECT chat_message_id, ?, ? FROM t_chat_message
		 WHERE chat_room_id = ? AND is_deleted = 0 AND sender_account_id <> ?`,
		u.AccountID, now(), roomID, u.AccountID)
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
	a.log(u.AccountID, fnChat, opCreate, "t_chat_message", i64(id), nil, nil, s("送信"))
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
	var sender int64
	var body string
	if err := a.db.QueryRow(`SELECT sender_account_id, body FROM t_chat_message WHERE chat_message_id = ?`,
		id).Scan(&sender, &body); err != nil {
		writeErr(w, http.StatusNotFound, "メッセージが見つかりません")
		return
	}
	if sender != u.AccountID && !u.isAdmin() {
		writeForbidden(w, "自分が送信したメッセージのみ取り消せます")
		return
	}
	if _, err := a.db.Exec(`UPDATE t_chat_message
		SET is_deleted = 1, body = '', deleted_at = ?, deleted_account_id = ?
		WHERE chat_message_id = ?`, now(), u.AccountID, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "取消に失敗しました")
		return
	}
	a.log(u.AccountID, fnChat, opDelete, "t_chat_message", i64(id), nil, s(body), s("取消"))
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

	var sender int64
	var before string
	var isDeleted bool
	if err := a.db.QueryRow(`SELECT sender_account_id, body, is_deleted FROM t_chat_message
		WHERE chat_message_id = ?`, id).Scan(&sender, &before, &isDeleted); err != nil {
		writeErr(w, http.StatusNotFound, "メッセージが見つかりません")
		return
	}
	if sender != u.AccountID {
		writeForbidden(w, "自分が送信したメッセージのみ編集できます")
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
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type memberView struct {
	AccountID int64  `json:"account_id"`
	Name      string `json:"name"`
}

func (a *app) handleChatMembers(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireUser(w, r); !ok {
		return
	}
	roomID, _ := pathInt64(r, "id")
	rows, err := a.db.Query(`SELECT account_id FROM t_chat_member
		WHERE chat_room_id = ? AND left_at IS NULL ORDER BY account_id`, roomID)
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
		out = append(out, memberView{AccountID: id, Name: a.accountName(id)})
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- グループ編成（基本設計書「画面の一覧」(3-2)） ----

func (a *app) handleChatGroups(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT chat_room_id, room_type, class_id, room_name, is_archived, thread_status
	                           FROM m_chat_room WHERE room_type = '3' ORDER BY chat_room_id`)
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
	res, err := a.db.Exec(`INSERT INTO m_chat_room (room_type, room_name, is_archived)
		VALUES ('3', ?, 0)`, req.Name)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "グループを作成できませんでした")
		return
	}
	roomID, _ := res.LastInsertId()

	seen := map[int64]bool{u.AccountID: true}
	for _, id := range req.AccountIDs {
		seen[id] = true
	}
	for id := range seen {
		a.db.Exec(`INSERT OR IGNORE INTO t_chat_member (chat_room_id, account_id, joined_at)
			VALUES (?, ?, ?)`, roomID, id, now())
	}
	a.log(u.AccountID, fnChat, opCreate, "m_chat_room", i64(roomID), nil, nil,
		s("グループ「"+req.Name+"」を作成"))
	writeJSON(w, http.StatusOK, map[string]int64{"chat_room_id": roomID})
}

// handleUpdateGroupMembers はメンバーを編成する。
// 退出は left_at を入れて所属期間を残す。過去ログの参照範囲の判定に用いるため（基本設計書 5-5）。
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
	target := map[int64]bool{}
	for _, id := range req.AccountIDs {
		target[id] = true
	}

	rows, err := a.db.Query(`SELECT account_id FROM t_chat_member
		WHERE chat_room_id = ? AND left_at IS NULL`, roomID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "メンバーを取得できませんでした")
		return
	}
	current := []int64{}
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			current = append(current, id)
		}
	}
	rows.Close()

	// 外れた人は left_at を入れる。レコードは消さない
	for _, id := range current {
		if !target[id] {
			a.db.Exec(`UPDATE t_chat_member SET left_at = ? WHERE chat_room_id = ? AND account_id = ?`,
				now(), roomID, id)
		}
	}
	// 加わった人は入れ直す
	for id := range target {
		a.db.Exec(`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at, left_at)
			VALUES (?, ?, ?, NULL)
			ON CONFLICT(chat_room_id, account_id) DO UPDATE SET left_at = NULL, joined_at = excluded.joined_at`,
			roomID, id, now())
	}
	a.log(u.AccountID, fnChat, opUpdate, "t_chat_member", i64(roomID), nil, nil, s("メンバーを編成"))
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
func (a *app) handleRetractedWithoutRecord(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT m.chat_message_id, IFNULL(r.room_name, '―'), m.sent_at,
		m.deleted_at, m.sender_account_id
		FROM t_chat_message m
		LEFT JOIN m_chat_room r ON r.chat_room_id = m.chat_room_id
		WHERE m.is_deleted = 1
		  AND m.chat_message_id NOT IN (SELECT chat_message_id FROM t_misdelivery_record)
		ORDER BY m.sent_at DESC`)
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
	if req.OccurredAt == "" {
		req.OccurredAt = now()
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
