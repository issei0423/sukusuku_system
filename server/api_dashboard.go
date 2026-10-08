package main

import (
	"database/sql"
	"net/http"
)

/*
 * ダッシュボード・保護者ホーム
 * 典拠：図/画面詳細図.md「職員ダッシュボード」(2-4)、基本設計書.md「画面の一覧」(3-2)
 *
 * 未対応の件数を最上部に置く。出勤直後に「何が残っているか」を1画面で把握させるため。
 * 承認待ちの区画は管理者にのみ表示する。
 */

func (a *app) handleStaffSummary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}

	// 自分が書いて差し戻された日誌
	var returned int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_diary
		WHERE is_deleted = 0 AND status = '4' AND created_staff_id = ?`, u.staff()).Scan(&returned)

	// 未読のチャット
	var unreadChat int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message m
		WHERE m.is_deleted = 0 AND m.sender_account_id <> ?
		  AND m.chat_room_id IN (SELECT chat_room_id FROM t_chat_member WHERE account_id = ?)
		  AND NOT EXISTS (SELECT 1 FROM t_chat_read x
		                   WHERE x.chat_message_id = m.chat_message_id AND x.account_id = ?)`,
		u.AccountID, u.AccountID, u.AccountID).Scan(&unreadChat)

	// 承認待ちは管理者にのみ数える
	pending := 0
	if u.isAdmin() {
		a.db.QueryRow(`SELECT COUNT(*) FROM t_diary WHERE is_deleted = 0 AND status = '2'`).Scan(&pending)
	}

	children, err := a.visibleChildren(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "集計に失敗しました")
		return
	}
	visible := map[string]bool{}
	for _, c := range children {
		visible[c.ChildID] = true
	}

	// 発達チェックの未実施
	devOverdue := 0
	rows, err := a.db.Query(`SELECT s.child_id, s.scheduled_on,
		(SELECT MAX(checked_on) FROM t_development_check c
		  WHERE c.child_id = s.child_id AND c.status = '2')
		FROM t_development_schedule s WHERE s.scheduled_on <= ?`, today())
	if err == nil {
		for rows.Next() {
			var (
				childID   string
				scheduled string
				last      sql.NullString
			)
			if rows.Scan(&childID, &scheduled, &last) != nil {
				continue
			}
			if !visible[childID] {
				continue
			}
			if !last.Valid || last.String < scheduled {
				devOverdue++
			}
		}
		rows.Close()
	}

	// 異常時の記録のうち、ヒヤリハットを起票していないもの
	abnormalWithoutDiary := 0
	ar, err := a.db.Query(`SELECT child_id FROM t_nap_abnormal WHERE diary_id IS NULL`)
	if err == nil {
		for ar.Next() {
			var childID string
			if ar.Scan(&childID) == nil && visible[childID] {
				abnormalWithoutDiary++
			}
		}
		ar.Close()
	}

	// 実施中の午睡チェック
	var activeNap *NapSession
	classes, _ := a.selectableClasses(u)
	for _, c := range classes {
		if s, err := a.napSession(c.ClassID, today()); err == nil {
			activeNap = s
			break
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"returned":             returned,
		"unreadChat":           unreadChat,
		"devOverdue":           devOverdue,
		"pending":              pending,
		"abnormalWithoutDiary": abnormalWithoutDiary,
		"activeNap":            activeNap,
	})
}

// handleGuardianHome は自児の情報とチャットへの導線を返す。
// 記録の閲覧はチャット画面の中で行い、専用の閲覧画面を持たない（基本設計書「画面体系図」(3-3)）。
func (a *app) handleGuardianHome(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	children, err := a.visibleChildren(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "取得に失敗しました")
		return
	}

	var unread int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message m
		WHERE m.is_deleted = 0 AND m.sender_account_id <> ?
		  AND m.chat_room_id IN (SELECT chat_room_id FROM t_chat_member
		                          WHERE account_id = ? AND left_at IS NULL)
		  AND NOT EXISTS (SELECT 1 FROM t_chat_read x
		                   WHERE x.chat_message_id = m.chat_message_id AND x.account_id = ?)`+
		// 参加するより前の個人チャットのやりとりは、未読にも数えない（api_chat.go）
		beforeJoinedClause,
		u.AccountID, u.AccountID, u.AccountID, u.AccountID).Scan(&unread)

	type homeRow struct {
		Child         Child   `json:"child"`
		AgeMonths     int     `json:"ageMonths"`
		ClassName     string  `json:"className"`
		SharedDiaries []Diary `json:"sharedDiaries"`
		Unread        int     `json:"unread"`
	}
	out := []homeRow{}
	for _, c := range children {
		out = append(out, homeRow{Child: c, Unread: unread})
	}

	for i := range out {
		childID := out[i].Child.ChildID
		out[i].AgeMonths = ageInMonths(out[i].Child.BirthDate, today())

		var classID sql.NullInt64
		a.db.QueryRow(`SELECT cc.class_id FROM t_class_child cc
			JOIN m_class c ON c.class_id = cc.class_id AND c.fiscal_year = ?
			WHERE cc.child_id = ?`, fiscalYear, childID).Scan(&classID)
		out[i].ClassName = "―"
		if classID.Valid {
			out[i].ClassName = a.className(classID.Int64)
		}

		// 承認済みかつ共有指定のあるものだけが保護者に見える
		diaries, _ := a.queryDiaries(`SELECT `+diaryColumns+` FROM t_diary
			WHERE is_deleted = 0 AND child_id = ? AND status = '3' AND is_shared_to_guardian = 1
			ORDER BY diary_date DESC`, childID)
		if diaries == nil {
			diaries = []Diary{}
		}
		out[i].SharedDiaries = diaries
	}
	writeJSON(w, http.StatusOK, out)
}
