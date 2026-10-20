package main

import (
	"database/sql"
	"net/http"
	"regexp"
	"strings"
)

/*
 * 園からの配布物
 * 典拠：基本設計書.md「配布物の掲載と閲覧」(4-6)・「配布物（t_handout）」(5-5)
 *      図/画面詳細図.md「配布物管理画面」・「配布物一覧画面（保護者）」
 *
 * 園だより・献立表など、保護者があとから見返すものを、種類と月で並べて置く。
 * チャットは流れを追うものであり、毎月読み返すものを探す場所には向かない。
 * 掲載したことはチャットで知らせ、現物はここから開く。
 *
 * 【モックアップの範囲】ファイルの実体は保存しない。名前・形式・大きさだけを持つ（web/仮置き値.md）。
 */

// Handout は配布物（t_handout）
type Handout struct {
	HandoutID     int64  `json:"handout_id"`
	HandoutType   string `json:"handout_type"`
	Title         string `json:"title"`
	TargetMonth   string `json:"target_month"`
	ClassID       *int64 `json:"class_id"`
	FileName      string `json:"file_name"`
	FileType      string `json:"file_type"`
	FileSize      int64  `json:"file_size"`
	PostedStaffID string `json:"posted_staff_id"`
	PostedAt      string `json:"posted_at"`
	IsDeleted     bool   `json:"is_deleted"`
	// 画面が使う導出値
	ClassName       string `json:"class_name"`
	PostedStaffName string `json:"posted_staff_name"`
}

var handoutTypes = []string{"1", "2", "3", "4", "5"}

var monthPattern = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)

/*
handoutClassIDs は、その利用者が見られるクラス向けの配布物のクラスを返す。

園全体向けは全員が見られる。クラス向けは、一般は自クラス、保護者は自児が
いま在籍するクラスのものだけを見られる。過年度のクラスのものは見せない
（クラスグループの過去ログと同じ考え方。要件定義書「過去ログの参照範囲」(4-3 (c))）。
管理者は all が真で返る。
*/
func (a *app) handoutClassIDs(u *SessionUser) (ids []int64, all bool) {
	if u.isAdmin() {
		return nil, true
	}
	if u.isStaff() {
		if u.ClassID != nil {
			return []int64{*u.ClassID}, false
		}
		return []int64{}, false
	}
	ids = []int64{}
	if u.GuardianID == nil {
		return ids, false
	}
	rows, err := a.db.Query(`SELECT DISTINCT cc.class_id FROM t_class_child cc
		JOIN m_class c ON c.class_id = cc.class_id AND c.fiscal_year = ?
		JOIN t_guardian_child gc ON gc.child_id = cc.child_id
		WHERE gc.guardian_id = ? AND gc.link_status = '1'`, fiscalYear, *u.GuardianID)
	if err != nil {
		return ids, false
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	return ids, false
}

// handleHandouts は見られる配布物を、対象の月の新しい順に返す
func (a *app) handleHandouts(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	q := `SELECT handout_id, handout_type, title, target_month, class_id, file_name, file_type, file_size,
		posted_staff_id, posted_at, is_deleted FROM t_handout WHERE is_deleted = 0`
	args := []any{}
	if v := r.URL.Query().Get("type"); v != "" {
		q += ` AND handout_type = ?`
		args = append(args, v)
	}
	if v := r.URL.Query().Get("month"); v != "" {
		q += ` AND target_month = ?`
		args = append(args, v)
	}
	if ids, all := a.handoutClassIDs(u); !all {
		q += ` AND (class_id IS NULL`
		if len(ids) > 0 {
			q += ` OR class_id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + `)`
			for _, id := range ids {
				args = append(args, id)
			}
		}
		q += `)`
	}
	q += ` ORDER BY target_month DESC, posted_at DESC, handout_id DESC`

	rows, err := a.db.Query(q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "配布物を取得できませんでした")
		return
	}
	out := []Handout{}
	for rows.Next() {
		var (
			h       Handout
			classID sql.NullInt64
		)
		if rows.Scan(&h.HandoutID, &h.HandoutType, &h.Title, &h.TargetMonth, &classID, &h.FileName,
			&h.FileType, &h.FileSize, &h.PostedStaffID, &h.PostedAt, &h.IsDeleted) == nil {
			h.ClassID = nullInt(classID)
			out = append(out, h)
		}
	}
	rows.Close()

	// 名前の解決はカーソルを閉じたあとに行う（接続を1本に絞っているため。db.go）
	for i := range out {
		out[i].ClassName = "園全体"
		if out[i].ClassID != nil {
			out[i].ClassName = a.className(*out[i].ClassID)
		}
		out[i].PostedStaffName = a.staffName(out[i].PostedStaffID)
	}
	writeJSON(w, http.StatusOK, out)
}

/*
handlePostHandout は配布物を掲載する。管理者のみ。

園全体への発信は園としての意思表示であり、園チャットへ投稿できるのが管理者だけであるのと同じ扱いにする。
掲載したことは、園全体向けなら園チャット、クラス向けならそのクラスグループへ知らせる。
通知の経路をチャットに一本化しておくため。
*/
func (a *app) handlePostHandout(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		HandoutType string `json:"handout_type"`
		Title       string `json:"title"`
		TargetMonth string `json:"target_month"`
		ClassID     *int64 `json:"class_id"`
		FileName    string `json:"file_name"`
		FileType    string `json:"file_type"`
		FileSize    int64  `json:"file_size"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	req.Title = strings.TrimSpace(req.Title)
	switch {
	case !oneOf(req.HandoutType, handoutTypes...):
		writeErr(w, http.StatusBadRequest, "種類を選んでください")
		return
	case req.Title == "":
		writeErr(w, http.StatusBadRequest, "題名を入力してください")
		return
	case len([]rune(req.Title)) > 50:
		writeErr(w, http.StatusBadRequest, "題名は50文字以内で入力してください")
		return
	case !monthPattern.MatchString(req.TargetMonth):
		writeErr(w, http.StatusBadRequest, "対象の月を選んでください")
		return
	case strings.TrimSpace(req.FileName) == "":
		writeErr(w, http.StatusBadRequest, "ファイルを選んでください")
		return
	}
	allowed := strings.Split(a.settingText("handout.allowed_types", "application/pdf,image/jpeg,image/png"), ",")
	if !oneOf(req.FileType, allowed...) {
		writeErr(w, http.StatusBadRequest, "掲載できるのは PDF・JPEG・PNG のファイルです")
		return
	}
	maxMB := a.settingInt("attachment.max_size_mb", 10)
	if req.FileSize <= 0 || req.FileSize > int64(maxMB)*1024*1024 {
		writeErr(w, http.StatusBadRequest, "ファイルは"+itoa64(int64(maxMB))+"MB までです")
		return
	}
	if req.ClassID != nil {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM m_class WHERE class_id = ? AND fiscal_year = ?`,
			*req.ClassID, fiscalYear).Scan(&n)
		if n == 0 {
			writeErr(w, http.StatusBadRequest, "対象のクラスが見つかりません")
			return
		}
	}

	// 配布物の行と、掲載の知らせの行は、ひとまとまりで書く。片方だけが残る状態を作らない
	// （GitHub Issue #99）。接続は1本のため、トランザクションの中では tx だけを使う
	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "掲載に失敗しました")
		return
	}
	defer tx.Rollback()

	res, err := tx.Exec(`INSERT INTO t_handout
		(handout_type, title, target_month, class_id, file_name, file_path, file_type, file_size,
		 posted_staff_id, posted_at, is_deleted)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		req.HandoutType, req.Title, req.TargetMonth, req.ClassID, req.FileName, "handouts/"+req.FileName,
		req.FileType, req.FileSize, u.staff(), now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "掲載に失敗しました")
		return
	}
	id, _ := res.LastInsertId()

	// 掲載したことをチャットで知らせる。園全体向けは園チャット、クラス向けはそのクラスグループ
	var roomID sql.NullInt64
	if req.ClassID == nil {
		tx.QueryRow(`SELECT chat_room_id FROM m_chat_room WHERE room_type = '1' ORDER BY chat_room_id LIMIT 1`).Scan(&roomID)
	} else {
		tx.QueryRow(`SELECT chat_room_id FROM m_chat_room WHERE room_type = '2' AND class_id = ?
			ORDER BY chat_room_id LIMIT 1`, *req.ClassID).Scan(&roomID)
	}
	if roomID.Valid {
		if _, err := tx.Exec(`INSERT INTO t_chat_message
			(chat_room_id, sender_account_id, body, source_type, source_id, sent_at, is_deleted)
			VALUES (?, ?, ?, '4', ?, ?, 0)`,
			roomID.Int64, u.AccountID, "「"+req.Title+"」を掲載しました。", id, now()); err != nil {
			writeErr(w, http.StatusInternalServerError, "掲載に失敗しました")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "掲載に失敗しました")
		return
	}
	a.log(u.AccountID, fnChat, opCreate, "t_handout", i64(id), nil, nil, s("配布物を掲載（"+req.Title+"）"))
	// 見られる人の配布物の一覧と、掲載の知らせを流したチャンネルを読み直させる（events.go）
	a.notifyHandout(id, req.ClassID)
	if roomID.Valid {
		a.notifyRoomPost(roomID.Int64)
	}
	writeJSON(w, http.StatusOK, map[string]int64{"handout_id": id})
}

// handleWithdrawHandout は配布物を取り下げる。論理削除とし、一覧から消す。掲載の知らせも取り消す。管理者のみ
func (a *app) handleWithdrawHandout(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "配布物の指定が正しくありません")
		return
	}
	var (
		title   string
		classID sql.NullInt64
	)
	if err := a.db.QueryRow(`SELECT title, class_id FROM t_handout WHERE handout_id = ? AND is_deleted = 0`, id).
		Scan(&title, &classID); err != nil {
		writeErr(w, http.StatusNotFound, "配布物が見つかりません")
		return
	}
	// 掲載の知らせ。取り下げると知らせも取り消すため、そのメッセージを見られる人にも知らせる（events.go）
	var noticeID, noticeRoom sql.NullInt64
	a.db.QueryRow(`SELECT chat_message_id, chat_room_id FROM t_chat_message
		WHERE source_type = '4' AND source_id = ? AND is_deleted = 0
		ORDER BY chat_message_id LIMIT 1`, id).Scan(&noticeID, &noticeRoom)
	// 配布物の取り下げと、掲載の知らせの取り消しは、ひとまとまりで書く（GitHub Issue #99）
	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "取り下げに失敗しました")
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE t_handout SET is_deleted = 1, deleted_at = ?, deleted_staff_id = ?
		WHERE handout_id = ?`, now(), u.staff(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "取り下げに失敗しました")
		return
	}
	// 掲載の知らせも取り消す。知らせだけが残ると、開いても見つからない配布物へ案内し続けることになる
	if _, err := tx.Exec(`UPDATE t_chat_message SET is_deleted = 1, body = '', deleted_at = ?, deleted_account_id = ?
		WHERE source_type = '4' AND source_id = ? AND is_deleted = 0`, now(), u.AccountID, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "取り下げに失敗しました")
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "取り下げに失敗しました")
		return
	}
	a.log(u.AccountID, fnChat, opDelete, "t_handout", i64(id), nil, s(title), s("取り下げ"))
	a.notifyHandout(id, nullInt(classID))
	if noticeID.Valid && noticeRoom.Valid {
		a.notifyMessage(noticeRoom.Int64, noticeID.Int64)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
