package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
)

/*
 * 日誌システム（作成・承認・編集ロック）
 * 典拠：基本設計書.md「日誌の作成から保護者への共有」(4-5)・「編集ロックの解除」(4-5)
 *      図/画面詳細図.md「日誌作成・編集画面」(3-2)・「日誌承認画面（管理者）」(3-3)
 */

type diaryInput struct {
	DiaryID    *int64  `json:"diary_id"`
	RecordType string  `json:"record_type"`
	ChildID    *string `json:"child_id"`
	ClassID    *int64  `json:"class_id"`
	DiaryDate  string  `json:"diary_date"`
	Body       string  `json:"body"`
	LockToken  string  `json:"lock_token"`
	// "1" 下書き / "2" 申請
	Status string `json:"status"`
}

func (a *app) handleSaveDiary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var in diaryInput
	if !readJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Body) == "" {
		writeErr(w, http.StatusBadRequest, "本文を入力してください")
		return
	}
	if in.Status != "1" && in.Status != "2" {
		writeErr(w, http.StatusBadRequest, "保存する状態の指定が正しくありません")
		return
	}
	// 個人日誌・ヒヤリハットは対象園児が要る
	if in.RecordType == "1" || in.RecordType == "4" {
		if in.ChildID == nil || *in.ChildID == "" {
			writeErr(w, http.StatusBadRequest, "対象の園児を選んでください")
			return
		}
		if !a.canSeeChild(u, *in.ChildID) {
			writeForbidden(w, "この園児の日誌を作成する権限がありません")
			return
		}
	} else {
		in.ChildID = nil
	}

	if in.DiaryID != nil {
		a.updateDiary(w, u, in)
		return
	}

	res, err := a.db.Exec(`INSERT INTO t_diary
		(record_type, child_id, class_id, diary_date, body, status, created_staff_id,
		 is_shared_to_guardian, is_deleted, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
		in.RecordType, in.ChildID, in.ClassID, in.DiaryDate, in.Body, in.Status, u.staff(), now(), now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
		return
	}
	id, _ := res.LastInsertId()

	after := "下書き作成"
	if in.Status == "2" {
		after = "作成して申請"
	}
	a.log(u.AccountID, fnDiary, opCreate, "t_diary", i64(id), in.ChildID, nil, s(after))

	a.writeDiaryByID(w, id)
}

func (a *app) updateDiary(w http.ResponseWriter, u *SessionUser, in diaryInput) {
	var status string
	if err := a.db.QueryRow(`SELECT status FROM t_diary WHERE diary_id = ? AND is_deleted = 0`,
		*in.DiaryID).Scan(&status); err != nil {
		writeErr(w, http.StatusNotFound, "日誌が見つかりません")
		return
	}
	if status == "2" || status == "3" {
		writeErr(w, http.StatusBadRequest, "申請中または承認済みの日誌は編集できません")
		return
	}

	// 保存時にロックの識別子を照合する。一致しない場合は保存を拒否する（基本設計書 5-4）
	var token sql.NullString
	a.db.QueryRow(`SELECT lock_token FROM t_diary_lock WHERE diary_id = ?`, *in.DiaryID).Scan(&token)
	if token.Valid && token.String != in.LockToken {
		writeErr(w, http.StatusConflict, "編集ロックが解除されました。内容を再読み込みしてください")
		return
	}

	// 再申請したら差し戻し理由を消す
	reasonExpr := "returned_reason"
	if in.Status == "2" {
		reasonExpr = "NULL"
	}
	_, err := a.db.Exec(`UPDATE t_diary
		SET record_type = ?, child_id = ?, class_id = ?, diary_date = ?, body = ?, status = ?,
		    returned_reason = `+reasonExpr+`, updated_at = ?
		WHERE diary_id = ?`,
		in.RecordType, in.ChildID, in.ClassID, in.DiaryDate, in.Body, in.Status, now(), *in.DiaryID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
		return
	}

	after := "下書き保存"
	if in.Status == "2" {
		after = "申請"
	}
	a.log(u.AccountID, fnDiary, opUpdate, "t_diary", in.DiaryID, in.ChildID, s(status), s(after))

	a.writeDiaryByID(w, *in.DiaryID)
}

func (a *app) writeDiaryByID(w http.ResponseWriter, id int64) {
	row := a.db.QueryRow(`SELECT `+diaryColumns+` FROM t_diary WHERE diary_id = ?`, id)
	d, err := a.scanDiary(row)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌を読み直せませんでした")
		return
	}
	a.enrich(&d)
	writeJSON(w, http.StatusOK, d)
}

// ---- 承認（管理者のみ） ----

// handlePendingDiaries は承認待ちの一覧を返す
func (a *app) handlePendingDiaries(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	out, err := a.queryDiaries(`SELECT ` + diaryColumns + ` FROM t_diary
		WHERE is_deleted = 0 AND status = '2' ORDER BY updated_at`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "承認待ちを取得できませんでした")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

/*
handleApproveDiary は承認する。

保護者への共有の指定を、承認と同じ操作で受け取る。
承認後に別画面で指定させると共有し忘れが起きるため（画面詳細図 3-3）。
*/
func (a *app) handleApproveDiary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	var req struct {
		ShareToGuardian bool `json:"share_to_guardian"`
	}
	if !readJSON(w, r, &req) {
		return
	}

	var (
		status  string
		childID sql.NullString
	)
	if err := a.db.QueryRow(`SELECT status, child_id FROM t_diary WHERE diary_id = ? AND is_deleted = 0`,
		id).Scan(&status, &childID); err != nil {
		writeErr(w, http.StatusNotFound, "日誌が見つかりません")
		return
	}
	if status != "2" {
		writeErr(w, http.StatusBadRequest, "申請中の日誌のみ承認できます")
		return
	}

	var sharedAt any
	if req.ShareToGuardian {
		sharedAt = now()
	}
	if _, err := a.db.Exec(`UPDATE t_diary
		SET status = '3', approved_staff_id = ?, approved_at = ?, returned_reason = NULL,
		    is_shared_to_guardian = ?, shared_at = ?, updated_at = ?
		WHERE diary_id = ?`,
		u.staff(), now(), req.ShareToGuardian, sharedAt, now(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "承認に失敗しました")
		return
	}

	after := "承認済み・共有しない"
	if req.ShareToGuardian {
		after = "承認済み・保護者へ共有"
	}
	a.log(u.AccountID, fnDiary, opApprove, "t_diary", i64(id), nullStr(childID), s("申請中"), s(after))

	// 共有する場合、対象園児に紐づく保護者との個人チャットへ送る（基本設計書 4-5）
	if req.ShareToGuardian && childID.Valid {
		a.shareDiaryToGuardian(u, id, childID.String)
	}
	a.writeDiaryByID(w, id)
}

// shareDiaryToGuardian は個人チャットへ日誌の共有として流す（t_chat_message.source_type = 2）
func (a *app) shareDiaryToGuardian(u *SessionUser, diaryID int64, childID string) {
	var roomID int64
	err := a.db.QueryRow(`SELECT chat_room_id FROM m_chat_room
		WHERE room_type = '4' AND room_name = ?`, a.childName(childID)+"の保護者").Scan(&roomID)
	if err != nil {
		// 【要確認】個人チャットが無い場合の共有先が定義されていない（GitHub Issue #61 と同じ論点）
		return
	}
	a.db.Exec(`INSERT INTO t_chat_message
		(chat_room_id, sender_account_id, body, source_type, source_id, sent_at, is_deleted)
		VALUES (?, ?, '日誌を共有しました。', '2', ?, ?, 0)`,
		roomID, u.AccountID, diaryID, now())
}

// handleReturnDiary は差し戻す。理由の入力を必須とする（画面詳細図 3-3）
func (a *app) handleReturnDiary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		writeErr(w, http.StatusBadRequest, "差し戻す理由を入力してください")
		return
	}

	var (
		status  string
		childID sql.NullString
	)
	if err := a.db.QueryRow(`SELECT status, child_id FROM t_diary WHERE diary_id = ? AND is_deleted = 0`,
		id).Scan(&status, &childID); err != nil {
		writeErr(w, http.StatusNotFound, "日誌が見つかりません")
		return
	}
	if status != "2" {
		writeErr(w, http.StatusBadRequest, "申請中の日誌のみ差し戻せます")
		return
	}

	if _, err := a.db.Exec(`UPDATE t_diary
		SET status = '4', returned_reason = ?, approved_staff_id = ?, updated_at = ?
		WHERE diary_id = ?`, req.Reason, u.staff(), now(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "差し戻しに失敗しました")
		return
	}
	a.log(u.AccountID, fnDiary, opApprove, "t_diary", i64(id), nullStr(childID),
		s("申請中"), s("差し戻し："+req.Reason))

	a.writeDiaryByID(w, id)
}

// ---- 編集ロック（基本設計書「編集ロックの解除」(4-5)、5-4） ----

/*
handleAcquireLock は編集ロックを取得する。

取得のたびにトークンを発行し、保存時に照合する。
他の職員が保持していて無操作の時間内なら、その職員名を返して画面に出す（画面詳細図 3-2）。
*/
func (a *app) handleAcquireLock(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	idleMinutes := a.settingInt("ui.diary_lock_minutes", 15)

	var (
		heldStaff  sql.NullString
		lastActive sql.NullString
	)
	a.db.QueryRow(`SELECT locked_staff_id, last_active_at FROM t_diary_lock WHERE diary_id = ?`, id).
		Scan(&heldStaff, &lastActive)

	if heldStaff.Valid && heldStaff.String != u.staff() && lastActive.Valid {
		if plusMinutes(lastActive.String, idleMinutes) > now() {
			writeJSON(w, http.StatusOK, map[string]string{"held_by": a.staffName(heldStaff.String)})
			return
		}
	}

	token := "lock-" + strconv.FormatInt(id, 10) + "-" + randomToken(9)
	if _, err := a.db.Exec(`INSERT INTO t_diary_lock (diary_id, lock_token, locked_staff_id, locked_at, last_active_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(diary_id) DO UPDATE SET
		  lock_token = excluded.lock_token,
		  locked_staff_id = excluded.locked_staff_id,
		  locked_at = excluded.locked_at,
		  last_active_at = excluded.last_active_at`,
		id, token, u.staff(), now(), now()); err != nil {
		writeErr(w, http.StatusInternalServerError, "編集ロックを取得できませんでした")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

// handleReleaseLock はロックを解除する。
//
// 管理者が強制解除するとレコードを削除する。
// 保存時にトークンが一致せず、他者の更新が無くても保存が拒否される（基本設計書 5-4）。
func (a *app) handleReleaseLock(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	force := r.URL.Query().Get("force") == "true"

	var held sql.NullString
	if err := a.db.QueryRow(`SELECT locked_staff_id FROM t_diary_lock WHERE diary_id = ?`, id).Scan(&held); err != nil {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	if force && !u.isAdmin() {
		writeForbidden(w, "ロックの強制解除は管理者のみが行えます")
		return
	}
	if !force && held.String != u.staff() {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}

	a.db.Exec(`DELETE FROM t_diary_lock WHERE diary_id = ?`, id)
	if force {
		a.log(u.AccountID, fnDiary, opUpdate, "t_diary_lock", i64(id), nil, s("ロックあり"), s("管理者が強制解除"))
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) handleLockOf(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	id, _ := pathInt64(r, "id")
	var token, staffID, lockedAt, lastActive string
	err := a.db.QueryRow(`SELECT lock_token, locked_staff_id, locked_at, last_active_at
	                        FROM t_diary_lock WHERE diary_id = ?`, id).
		Scan(&token, &staffID, &lockedAt, &lastActive)
	if err != nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"diary_id":        id,
		"lock_token":      token,
		"locked_staff_id": staffID,
		"locked_at":       lockedAt,
		"last_active_at":  lastActive,
		"staff_name":      a.staffName(staffID),
	})
}
