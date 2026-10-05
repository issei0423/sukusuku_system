package main

import (
	"database/sql"
	"net/http"
	"strings"
)

/*
 * 発達チェックの保存
 * 典拠：基本設計書.md「発達チェックの実施」(4-8)・「発達チェック・身体測定」(5-7)
 *      図/画面詳細図.md「発達チェック入力画面」(6-1)
 *
 * 「未入力」はレコードが存在しない状態で表す。
 * 「未確認」は result = '3' として明示的に保持する。
 * 両者は別の状態であり、チェック漏れの対象になるのは未入力のみ（基本設計書 5-7）。
 */

type saveCheckRequest struct {
	ChildID   string `json:"child_id"`
	CheckedOn string `json:"checked_on"`
	Results   []struct {
		DevelopmentItemID int64 `json:"development_item_id"`
		// null は未入力。レコードを作らない
		Result *string `json:"result"`
	} `json:"results"`
	Note string `json:"note"`
	// "1" 下書き / "2" 確定
	Status string `json:"status"`
}

func (a *app) handleSaveDevelopmentCheck(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var req saveCheckRequest
	if !readJSON(w, r, &req) {
		return
	}
	if !a.canSeeChild(u, req.ChildID) {
		writeForbidden(w, "この園児を記録する権限がありません")
		return
	}
	if req.Status != "1" && req.Status != "2" {
		writeErr(w, http.StatusBadRequest, "保存する状態の指定が正しくありません")
		return
	}
	if req.CheckedOn == "" {
		req.CheckedOn = today()
	}

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "保存に失敗しました")
		return
	}
	defer tx.Rollback()

	var note any
	if strings.TrimSpace(req.Note) != "" {
		note = req.Note
	}

	var checkID int64
	err = tx.QueryRow(`SELECT development_check_id FROM t_development_check
		WHERE child_id = ? AND checked_on = ?`, req.ChildID, req.CheckedOn).Scan(&checkID)

	isNew := err == sql.ErrNoRows
	switch {
	case isNew:
		res, e := tx.Exec(`INSERT INTO t_development_check
			(child_id, checked_on, status, staff_id, share_status, note)
			VALUES (?, ?, ?, ?, '1', ?)`, req.ChildID, req.CheckedOn, req.Status, u.staff(), note)
		if e != nil {
			writeErr(w, http.StatusInternalServerError, "保存に失敗しました")
			return
		}
		checkID, _ = res.LastInsertId()
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "保存に失敗しました")
		return
	default:
		if _, e := tx.Exec(`UPDATE t_development_check SET status = ?, staff_id = ?, note = ?
			WHERE development_check_id = ?`, req.Status, u.staff(), note, checkID); e != nil {
			writeErr(w, http.StatusInternalServerError, "保存に失敗しました")
			return
		}
	}

	// 既存の結果を入れ替える
	tx.Exec(`DELETE FROM t_development_result WHERE development_check_id = ?`, checkID)
	for _, x := range req.Results {
		// 未入力はレコードを作らない
		if x.Result == nil || *x.Result == "" {
			continue
		}
		if _, e := tx.Exec(`INSERT INTO t_development_result
			(development_check_id, development_item_id, result) VALUES (?, ?, ?)`,
			checkID, x.DevelopmentItemID, *x.Result); e != nil {
			writeErr(w, http.StatusInternalServerError, "保存に失敗しました")
			return
		}
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "保存に失敗しました")
		return
	}

	op := opUpdate
	if isNew {
		op = opCreate
	}
	after := "下書き保存"
	if req.Status == "2" {
		after = "確定"
	}
	a.log(u.AccountID, fnDev, op, "t_development_check", i64(checkID), s(req.ChildID), nil, s(after))

	if req.Status == "2" {
		a.advanceDevelopmentSchedule(u, checkID, req.ChildID, req.CheckedOn)
	}

	row := a.db.QueryRow(`SELECT `+checkColumns+` FROM t_development_check WHERE development_check_id = ?`, checkID)
	c, _ := a.scanCheck(row)
	writeJSON(w, http.StatusOK, c)
}

/*
advanceDevelopmentSchedule は、確定した実施が予定を満たしたときに次回の予定日を作る。

次回の予定日は、実施日にマスタの推奨頻度（m_development_frequency）の日数を足した日とする。
すでに実施日より先の予定があるとき（園児単位で手動上書きした予定を含む）は、それを残す。

【仮置き】次回の予定日をいつ・何から計算し直すかは基本設計書が定めていない（web/仮置き値.md）。
画面側のモック（web/src/api/mock.ts の saveCheck）と同じ規則にしてある。
*/
func (a *app) advanceDevelopmentSchedule(u *SessionUser, checkID int64, childID, checkedOn string) {
	var (
		scheduleID  sql.NullInt64
		scheduledOn sql.NullString
	)
	a.db.QueryRow(`SELECT development_schedule_id, scheduled_on FROM t_development_schedule
		WHERE child_id = ? ORDER BY scheduled_on DESC LIMIT 1`, childID).Scan(&scheduleID, &scheduledOn)
	if scheduledOn.Valid && scheduledOn.String > checkedOn {
		return
	}
	if scheduleID.Valid {
		a.db.Exec(`UPDATE t_development_check SET development_schedule_id = ?
			WHERE development_check_id = ?`, scheduleID.Int64, checkID)
	}

	var birth string
	if a.db.QueryRow(`SELECT birth_date FROM m_child WHERE child_id = ?`, childID).Scan(&birth) != nil {
		return
	}
	var interval int
	if a.db.QueryRow(`SELECT interval_days FROM m_development_frequency
		WHERE ? BETWEEN age_month_from AND age_month_to LIMIT 1`, ageInMonths(birth, checkedOn)).Scan(&interval) != nil {
		// 推奨頻度がマスタに無い月齢では、予定日を提案しない
		return
	}
	next := addDays(checkedOn, interval)
	a.db.Exec(`INSERT INTO t_development_schedule (child_id, scheduled_on, is_manual_override, created_staff_id)
		VALUES (?, ?, 0, ?)`, childID, next, u.staff())
	a.log(u.AccountID, fnDev, opCreate, "t_development_schedule", nil, s(childID), nil,
		s("次回予定日="+next+"（実施日から算出）"))
}
