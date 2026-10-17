package main

import (
	"database/sql"
	"log"
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
	// 保護者へのひとこと（所見とは別の欄。確定した時点で成長の記録に届く。詳細設計書「発達チェックの保存」(4-12 (2))）。
	// 空なら null で保存する
	GuardianMessage *string `json:"guardian_message"`
	// 他児の名前の照合で承諾した名前（4-5 (2)）。照合は PR #201 の namecheck.go と合わせるときに足す（いまは受け取るだけ）
	AcknowledgedNames []string `json:"acknowledged_names"`
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
	// その園児を書ける職員（contactAccess の Write）。フリーの職員は書けない（詳細設計書「発達チェックの保存」(4-12 (2))、
	// 基本設計書「権限チェックの実装方針」(6-2)）。画面側のモック（web/src/api/mock.ts の saveCheck）と同じ規則
	if !a.contactAccess(u, req.ChildID).Write {
		writeForbidden(w, "この園児を記録する権限がありません")
		return
	}
	if req.Status != "1" && req.Status != "2" {
		writeErr(w, http.StatusBadRequest, "保存する状態の指定が正しくありません")
		return
	}
	if tooLong(req.Note, 1000) {
		writeErr(w, http.StatusBadRequest, "所見は1,000文字以内で入力してください")
		return
	}
	if req.CheckedOn == "" {
		req.CheckedOn = today()
	}
	// 実施日は、形の崩れた値と未来日を断る（基本設計書「入力項目の制約値」(4-9)「記録日・測定日　未来日は認めない
	// （当日まで）」、図/画面詳細図.md「発達チェック入力画面」(6-2) 項目3「実施日　制限：未来日は選べない」）。
	// 崩れた日付で確定すると、月齢の計算でサーバの処理が落ち、そのクラスの一覧が開けなくなっていた
	// （GitHub Issue #164）。画面側のモック（web/src/api/mock.ts の saveCheck）と同じ規則
	if !isISODate(req.CheckedOn) {
		writeErr(w, http.StatusBadRequest, "実施日の形式が正しくありません")
		return
	}
	if req.CheckedOn > today() {
		writeErr(w, http.StatusBadRequest, "実施日に未来日は指定できません")
		return
	}
	// 保護者へのひとことは前後の空白を除いて500文字以内。空なら null（詳細設計書 (4-12 (2))）
	var guardianMessage any
	if req.GuardianMessage != nil {
		if m := strings.TrimSpace(*req.GuardianMessage); m != "" {
			if tooLong(m, 500) {
				writeErr(w, http.StatusBadRequest, msgGuardianMessageTooLong)
				return
			}
			guardianMessage = m
		}
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

	var (
		checkID   int64
		curStatus string
	)
	err = tx.QueryRow(`SELECT development_check_id, status FROM t_development_check
		WHERE child_id = ? AND checked_on = ?`, req.ChildID, req.CheckedOn).Scan(&checkID, &curStatus)

	/*
	 * 確定した記録は、下書きに戻さない。確定のまま直すこと（もう一度「確定する」）はできる。
	 * 下書きに戻すと、確定で作った次回の予定日だけが残り、一覧の「予定どおり」とダッシュボードの
	 * 「未実施」が食い違う（GitHub Issue #164）。
	 * 【仮置き】確定を取り消す操作は設けない（web/仮置き値.md）。画面側のモックも同じ規則
	 */
	if err == nil && curStatus == "2" && req.Status == "1" {
		writeErr(w, http.StatusBadRequest, "確定した発達チェックは下書きに戻せません。直すときは「確定する」で保存してください")
		return
	}

	isNew := err == sql.ErrNoRows
	switch {
	case isNew:
		res, e := tx.Exec(`INSERT INTO t_development_check
			(child_id, checked_on, status, staff_id, share_status, note, guardian_message, finalized_at)
			VALUES (?, ?, ?, ?, '1', ?, ?, CASE WHEN ? = '2' THEN ? END)`, req.ChildID, req.CheckedOn, req.Status, u.staff(), note,
			guardianMessage, req.Status, now())
		if e != nil {
			writeErr(w, http.StatusInternalServerError, "保存に失敗しました")
			return
		}
		checkID, _ = res.LastInsertId()
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "保存に失敗しました")
		return
	default:
		// 確定した日時は初めて確定したときだけ入れ、確定し直しても動かさない（「できたこと」の日付が動かないように。
		// 詳細設計書「成長の記録に届くもの」(3-7)、決めたこと D-31）
		if _, e := tx.Exec(`UPDATE t_development_check SET status = ?, staff_id = ?, note = ?, guardian_message = ?,
			finalized_at = CASE WHEN ? = '2' AND finalized_at IS NULL THEN ? ELSE finalized_at END
			WHERE development_check_id = ?`, req.Status, u.staff(), note, guardianMessage, req.Status, now(), checkID); e != nil {
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
	// 発達チェック一覧（未入力の数・最後の実施日）とダッシュボードの「未実施」が変わりうる。
	// 下書きでも未入力の数が変わる（events.go）
	a.notifyDevelopment(req.ChildID, req.Status == "2")

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
		if _, err := a.db.Exec(`UPDATE t_development_check SET development_schedule_id = ?
			WHERE development_check_id = ?`, scheduleID.Int64, checkID); err != nil {
			log.Printf("発達チェックと予定の紐づけに失敗しました（check=%d）: %v", checkID, err)
		}
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
	// 作れなかったときは、操作ログに「次回予定日＝…」と残さない。記録と実際を食い違わせない
	// （GitHub Issue #99）。チェックの保存そのものは済んでいるため、業務処理は止めない
	if _, err := a.db.Exec(`INSERT INTO t_development_schedule (child_id, scheduled_on, is_manual_override, created_staff_id)
		VALUES (?, ?, 0, ?)`, childID, next, u.staff()); err != nil {
		log.Printf("次回の予定日を作れませんでした（child=%s）: %v", childID, err)
		return
	}
	a.log(u.AccountID, fnDev, opCreate, "t_development_schedule", nil, s(childID), nil,
		s("次回予定日="+next+"（実施日から算出）"))
}
