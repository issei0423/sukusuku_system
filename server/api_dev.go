package main

import (
	"database/sql"
	"net/http"
)

/*
 * 発達チェック（参照）
 * 典拠：基本設計書.md「発達チェックの実施」(4-8)・「発達チェック・身体測定」(5-7)
 *      図/画面詳細図.md「発達チェック入力画面」(6-1)
 *
 * システムは発達の遅速の判定・診断を行わない。記録・可視化・気づきの支援に徹する。
 */

// DevelopmentCategory は発達過程区分（m_development_category）。
// マスタ化して指針改定に追従する（基本設計書 5-7）
type DevelopmentCategory struct {
	DevelopmentCategoryID int64  `json:"development_category_id"`
	AgeMonthFrom          int    `json:"age_month_from"`
	AgeMonthTo            int    `json:"age_month_to"`
	CategoryName          string `json:"category_name"`
	DisplayOrder          int    `json:"display_order"`
}

type DevelopmentItem struct {
	DevelopmentItemID     int64  `json:"development_item_id"`
	DevelopmentCategoryID int64  `json:"development_category_id"`
	ItemName              string `json:"item_name"`
	Domain                string `json:"domain"`
	DisplayOrder          int    `json:"display_order"`
}

type DevelopmentResultRecord struct {
	DevelopmentResultID int64   `json:"development_result_id"`
	DevelopmentCheckID  int64   `json:"development_check_id"`
	DevelopmentItemID   int64   `json:"development_item_id"`
	Result              string  `json:"result"`
	Note                *string `json:"note"`
}

type DevelopmentCheck struct {
	DevelopmentCheckID    int64  `json:"development_check_id"`
	ChildID               string `json:"child_id"`
	DevelopmentScheduleID *int64 `json:"development_schedule_id"`
	CheckedOn             string `json:"checked_on"`
	Status                string `json:"status"`
	StaffID               string `json:"staff_id"`
	ShareStatus           string `json:"share_status"`
	// 【設計の穴】所見の列は基本設計書 5-7 の定義に無い（GitHub Issue #58）。
	// ここでは t_development_check に note 列を足して保持している。設計の決定ではない。
	Note *string `json:"note"`
	// 保護者へのひとことと、最初に確定した日時（詳細設計書「発達チェックの保存」(4-12 (2))）。職員の経路だけが返す
	GuardianMessage *string `json:"guardian_message"`
	FinalizedAt     *string `json:"finalized_at"`
	// 確定したあとでひとことを書き換えた時刻（詳細設計書「職員の画面から成長の記録へ届けるもの」(2-12 (2))、決めたこと D-51）
	GuardianMessageCorrectedAt *string `json:"guardian_message_corrected_at"`
}

// categoryFor は月齢から発達過程区分を引く。区分はマスタから読む（画面詳細図 6-1）
func (a *app) categoryFor(ageMonths int) *DevelopmentCategory {
	var c DevelopmentCategory
	err := a.db.QueryRow(`SELECT development_category_id, age_month_from, age_month_to,
		category_name, display_order FROM m_development_category
		WHERE ? BETWEEN age_month_from AND age_month_to ORDER BY display_order LIMIT 1`, ageMonths).
		Scan(&c.DevelopmentCategoryID, &c.AgeMonthFrom, &c.AgeMonthTo, &c.CategoryName, &c.DisplayOrder)
	if err != nil {
		return nil
	}
	return &c
}

// handleDevelopmentItems は月齢に対応する区分とチェック項目を返す
func (a *app) handleDevelopmentItems(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	ageMonths := queryInt(r, "age_months", 0)
	cat := a.categoryFor(ageMonths)
	if cat == nil {
		writeJSON(w, http.StatusOK, map[string]any{"category": nil, "items": []DevelopmentItem{}})
		return
	}
	rows, err := a.db.Query(`SELECT development_item_id, development_category_id, item_name, domain, display_order
		FROM m_development_item WHERE development_category_id = ? ORDER BY display_order`,
		cat.DevelopmentCategoryID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "チェック項目を取得できませんでした")
		return
	}
	defer rows.Close()
	items := []DevelopmentItem{}
	for rows.Next() {
		var it DevelopmentItem
		if rows.Scan(&it.DevelopmentItemID, &it.DevelopmentCategoryID, &it.ItemName,
			&it.Domain, &it.DisplayOrder) == nil {
			items = append(items, it)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"category": cat, "items": items})
}

func (a *app) resultsOf(checkID int64) []DevelopmentResultRecord {
	rows, err := a.db.Query(`SELECT development_result_id, development_check_id, development_item_id, result, note
		FROM t_development_result WHERE development_check_id = ? ORDER BY development_result_id`, checkID)
	if err != nil {
		return []DevelopmentResultRecord{}
	}
	defer rows.Close()
	out := []DevelopmentResultRecord{}
	for rows.Next() {
		var (
			x    DevelopmentResultRecord
			note sql.NullString
		)
		if rows.Scan(&x.DevelopmentResultID, &x.DevelopmentCheckID, &x.DevelopmentItemID, &x.Result, &note) == nil {
			x.Note = nullStr(note)
			out = append(out, x)
		}
	}
	return out
}

func (a *app) scanCheck(row interface{ Scan(...any) error }) (DevelopmentCheck, error) {
	var (
		c        DevelopmentCheck
		schedule sql.NullInt64
		note     sql.NullString
	)
	err := row.Scan(&c.DevelopmentCheckID, &c.ChildID, &schedule, &c.CheckedOn,
		&c.Status, &c.StaffID, &c.ShareStatus, &note, &c.GuardianMessage, &c.FinalizedAt, &c.GuardianMessageCorrectedAt)
	c.DevelopmentScheduleID = nullInt(schedule)
	c.Note = nullStr(note)
	return c, err
}

const checkColumns = `development_check_id, child_id, development_schedule_id, checked_on,
	status, staff_id, share_status, note, guardian_message, finalized_at, guardian_message_corrected_at`

// handlePreviousCheck は前回の確定済みの記録を返す。並べて表示するために使う（画面詳細図 6-1）
func (a *app) handlePreviousCheck(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canSeeChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	before := r.URL.Query().Get("before")
	if before == "" {
		before = today()
	}
	row := a.db.QueryRow(`SELECT `+checkColumns+` FROM t_development_check
		WHERE child_id = ? AND status = '2' AND checked_on < ?
		ORDER BY checked_on DESC LIMIT 1`, childID, before)
	c, err := a.scanCheck(row)
	if err != nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"check": c, "results": a.resultsOf(c.DevelopmentCheckID)})
}

// handleDraftCheck は当日の下書きを読み直す
func (a *app) handleDraftCheck(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canSeeChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	checkedOn := r.URL.Query().Get("checked_on")
	if checkedOn == "" {
		checkedOn = today()
	}
	row := a.db.QueryRow(`SELECT `+checkColumns+` FROM t_development_check
		WHERE child_id = ? AND checked_on = ?`, childID, checkedOn)
	c, err := a.scanCheck(row)
	if err != nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"check": c, "results": a.resultsOf(c.DevelopmentCheckID), "confirmedAt": a.confirmedAt(c),
	})
}

/*
confirmedAt は、確定した記録を最後に確定した日時を返す。下書きと、記録が見つからないときは nil。

確定したあとに開き直したとき、確定済みであることと、いつ・誰が確定したかを入力画面に出すために使う
（GitHub Issue #143）。誰が確定したかは記録の staff_id（確定した記録は確定でしか保存できないため、最後に確定した職員）。
【仮置き】確定の日時を持つ列は基本設計書「発達チェック・身体測定」(5-7) の定義に無いため、列は足さず、
操作ログ（基本設計書「操作ログ」(5-8)）の「確定」から引く（web/仮置き値.md）。
操作ログの無い記録（デモデータ）は nil になる。画面側のモック（web/src/api/mock.ts の draftFor）と同じ規則
*/
func (a *app) confirmedAt(c DevelopmentCheck) *string {
	if c.Status != "2" {
		return nil
	}
	var at sql.NullString
	a.db.QueryRow(`SELECT operated_at FROM t_operation_log
		WHERE target_table = 't_development_check' AND target_id = ? AND after_value = '確定'
		ORDER BY operated_at DESC, operation_log_id DESC LIMIT 1`, c.DevelopmentCheckID).Scan(&at)
	return nullStr(at)
}

/*
handleDevelopmentList は発達チェック一覧画面のためのデータを返す。

チェック漏れの対象になるのは未入力のみ。
「未確認」は結果として保持された状態であり、漏れではない（基本設計書 5-7）。
*/
func (a *app) handleDevelopmentList(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	classID, _ := queryInt64(r, "class_id")

	children, err := a.visibleChildren(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "園児を取得できませんでした")
		return
	}
	inClass := map[string]bool{}
	rows, err := a.db.Query(`SELECT child_id FROM t_class_child WHERE class_id = ?`, classID)
	if err == nil {
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				inClass[id] = true
			}
		}
		rows.Close()
	}

	type listRow struct {
		Child         Child   `json:"child"`
		AgeMonths     int     `json:"ageMonths"`
		ScheduledOn   *string `json:"scheduledOn"`
		LastCheckedOn *string `json:"lastCheckedOn"`
		Overdue       bool    `json:"overdue"`
		// いちばん新しい記録（下書きを含む）に残っている未入力の項目数。未入力はチェック漏れの対象（基本設計書 5-7）
		Unfilled int `json:"unfilled"`
	}
	out := []listRow{}
	for _, c := range children {
		if !inClass[c.ChildID] {
			continue
		}
		out = append(out, listRow{Child: c})
	}

	for i := range out {
		childID := out[i].Child.ChildID

		var scheduled sql.NullString
		a.db.QueryRow(`SELECT scheduled_on FROM t_development_schedule
			WHERE child_id = ? ORDER BY scheduled_on DESC LIMIT 1`, childID).Scan(&scheduled)
		out[i].ScheduledOn = nullStr(scheduled)

		// 前回の実施日と「未実施」の判定は、確定した記録で見る。下書きは実施にならない
		var last sql.NullString
		a.db.QueryRow(`SELECT checked_on FROM t_development_check
			WHERE child_id = ? AND status = '2' ORDER BY checked_on DESC LIMIT 1`, childID).Scan(&last)
		out[i].LastCheckedOn = nullStr(last)

		/*
		 * 未入力は、いちばん新しい記録（下書きを含む）について、その実施日の月齢に対応する項目のうち、
		 * 結果のレコードが無いものを数える。入力画面の「未入力の項目」と同じ数になる。
		 * 典拠：要件定義書「チェック漏れの強調」(4-5-2)「下書き保存された記録は、保存されていない項目を未入力として扱う」。
		 * 確定した記録だけで数えていたため、下書きを保存しても一覧の件数が変わらず、入力画面と食い違っていた（GitHub Issue #143）
		 */
		var (
			latestOn sql.NullString
			latestID sql.NullInt64
		)
		a.db.QueryRow(`SELECT checked_on, development_check_id FROM t_development_check
			WHERE child_id = ? ORDER BY checked_on DESC LIMIT 1`, childID).Scan(&latestOn, &latestID)
		if latestOn.Valid {
			if cat := a.categoryFor(ageInMonths(out[i].Child.BirthDate, latestOn.String)); cat != nil {
				var total, filled int
				a.db.QueryRow(`SELECT COUNT(*) FROM m_development_item
					WHERE development_category_id = ?`, cat.DevelopmentCategoryID).Scan(&total)
				a.db.QueryRow(`SELECT COUNT(*) FROM t_development_result r
					JOIN m_development_item i ON i.development_item_id = r.development_item_id
					WHERE r.development_check_id = ? AND i.development_category_id = ?`,
					latestID.Int64, cat.DevelopmentCategoryID).Scan(&filled)
				if total > filled {
					out[i].Unfilled = total - filled
				}
			}
		}

		// 月齢の基準日は予定日。現在日ではない（基本設計書「月齢の算出」(4-8)）
		base := today()
		if scheduled.Valid {
			base = scheduled.String
		}
		out[i].AgeMonths = ageInMonths(out[i].Child.BirthDate, base)

		// 予定日を過ぎているのに、その予定日以降の確定した記録が無ければ未実施。
		// 予定日の当日はまだ未実施にしない（基本設計書「発達チェックの実施」(4-8)「実施予定日を過ぎて未入力の
		// 項目・園児をチェック漏れとして強調表示」。GitHub Issue #164）。判定は devOverdue と同じ
		out[i].Overdue = devOverdue(nullStr(scheduled), nullStr(last))
	}
	writeJSON(w, http.StatusOK, out)
}

/*
devOverdue は、発達チェックが「未実施」かを返す。

園児の最新の予定日（scheduledOn）を過ぎていて、その予定日以降に確定した実施（lastCheckedOn）が無ければ未実施とする。
予定日の当日は、まだ未実施にしない（基本設計書「発達チェックの実施」(4-8)「実施予定日を過ぎて」）。
発達チェック一覧（handleDevelopmentList）と職員ダッシュボード（handleStaffSummary）が同じ判定を使い、
件数を食い違わせない（GitHub Issue #164）。画面側のモック（web/src/api/mock.ts の isDevOverdue）と同じ規則
*/
func devOverdue(scheduledOn, lastCheckedOn *string) bool {
	if scheduledOn == nil || *scheduledOn >= today() {
		return false
	}
	return lastCheckedOn == nil || *lastCheckedOn < *scheduledOn
}

// ---- スケジュール設定（管理者のみ） ----

/*
handleDevelopmentSchedules は園児単位の予定を返す。

チェック頻度は年齢・月齢に応じてシステムが提案するが、マスタデータで園が調整できる。
さらに園児単位の手動上書きに対応する（要件定義書「発達チェック」(4-5)）。
*/
func (a *app) handleDevelopmentSchedules(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	classID, _ := queryInt64(r, "class_id")

	// 【仮置き】並びは園児のよみ順（visibleChildren の順）。発達チェック一覧と同じ（web/仮置き値.md「一覧の並び順」）。
	// モック（web/src/api/mock.ts の schedules）も同じ並びにした（GitHub Issue #177 の 7）
	children, err := a.visibleChildren(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "園児を取得できませんでした")
		return
	}
	inClass := map[string]bool{}
	rows, err := a.db.Query(`SELECT child_id FROM t_class_child WHERE class_id = ?`, classID)
	if err == nil {
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				inClass[id] = true
			}
		}
		rows.Close()
	}

	type schedRow struct {
		Child            Child   `json:"child"`
		AgeMonths        int     `json:"ageMonths"`
		Suggested        string  `json:"suggested"`
		IntervalDays     *int    `json:"intervalDays"`
		ScheduledOn      *string `json:"scheduledOn"`
		IsManualOverride bool    `json:"isManualOverride"`
	}
	out := []schedRow{}
	for _, c := range children {
		if inClass[c.ChildID] {
			out = append(out, schedRow{Child: c})
		}
	}

	rule := a.loadScheduleRule()
	for i := range out {
		childID := out[i].Child.ChildID
		out[i].AgeMonths = ageInMonths(out[i].Child.BirthDate, today())

		var interval sql.NullInt64
		a.db.QueryRow(`SELECT interval_days FROM m_development_frequency
			WHERE ? BETWEEN age_month_from AND age_month_to LIMIT 1`, out[i].AgeMonths).Scan(&interval)
		if interval.Valid {
			n := int(interval.Int64)
			out[i].IntervalDays = &n
		}

		var scheduled sql.NullString
		var manual sql.NullBool
		a.db.QueryRow(`SELECT scheduled_on, is_manual_override FROM t_development_schedule
			WHERE child_id = ? ORDER BY scheduled_on DESC LIMIT 1`, childID).Scan(&scheduled, &manual)
		out[i].ScheduledOn = nullStr(scheduled)
		out[i].IsManualOverride = manual.Valid && manual.Bool

		/*
		 * システムが提案する予定日。予定の無い園児に一括で当てる日と同じ規則で作る（dev_schedule.go の
		 * handleApplyRecommendedSchedules・scheduleRule.next）。基準日は最後に確定した実施日、無ければ今日。
		 * その月齢の推奨頻度の日数を足し、あいだに健診の節目があれば節目の日にする（基本設計書「推奨スケジュールの作り方」(4-9)）。
		 * 推奨頻度がマスタに無い月齢では、これまでどおり今日を出す（GitHub Issue #164 の 3）
		 */
		var last sql.NullString
		a.db.QueryRow(`SELECT checked_on FROM t_development_check
			WHERE child_id = ? AND status = '2' ORDER BY checked_on DESC LIMIT 1`, childID).Scan(&last)
		base := today()
		if last.Valid {
			base = last.String
		}
		if d, ok := rule.next(out[i].Child.BirthDate, base); ok {
			out[i].Suggested = d
		} else {
			out[i].Suggested = today()
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) handleSetSchedule(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		ChildID     string `json:"child_id"`
		ScheduledOn string `json:"scheduled_on"`
		Manual      bool   `json:"manual"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	// 予定日は 'YYYY-MM-DD' の形の、実在する日付に限る。崩れた日付は一覧の判定と月齢の計算を狂わせる
	// （GitHub Issue #164）
	if !isISODate(req.ScheduledOn) {
		writeErr(w, http.StatusBadRequest, "次回の予定日の形式が正しくありません")
		return
	}
	// 手で決める予定日に、過ぎた日は入れさせない（画面詳細図「スケジュール設定画面」(6-3)）。
	// 「提案に戻す」は、予定日を過ぎた園児では提案そのものが過去の日になるため、対象にしない
	if req.Manual && req.ScheduledOn < today() {
		writeErr(w, http.StatusBadRequest, "次回の予定日に、過ぎた日は指定できません")
		return
	}
	var id sql.NullInt64
	a.db.QueryRow(`SELECT development_schedule_id FROM t_development_schedule
		WHERE child_id = ? ORDER BY scheduled_on DESC LIMIT 1`, req.ChildID).Scan(&id)

	var err error
	if id.Valid {
		_, err = a.db.Exec(`UPDATE t_development_schedule SET scheduled_on = ?, is_manual_override = ?
			WHERE development_schedule_id = ?`, req.ScheduledOn, req.Manual, id.Int64)
	} else {
		_, err = a.db.Exec(`INSERT INTO t_development_schedule
			(child_id, scheduled_on, is_manual_override, created_staff_id) VALUES (?, ?, ?, ?)`,
			req.ChildID, req.ScheduledOn, req.Manual, u.staff())
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "スケジュールの設定に失敗しました")
		return
	}
	suffix := ""
	if req.Manual {
		suffix = "（手動上書き）"
	}
	a.log(u.AccountID, fnDev, opUpdate, "t_development_schedule", nil, s(req.ChildID), nil,
		s("次回予定日="+req.ScheduledOn+suffix))
	// 発達チェック一覧の予定日と、ダッシュボードの「未実施」が変わりうる（events.go）
	a.notifyDevelopment(req.ChildID, false)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- 共有範囲設定（管理者のみ） ----
//
// 保護者への共有範囲は項目単位の粒度でフラグ管理する（要件定義書「発達チェック」(4-5)）。
// 共有しない設定にした項目は保護者へ渡す記録から落ちる。記録そのものは園内に残る。

func (a *app) handleShareSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT i.development_item_id, i.development_category_id, i.item_name,
		i.domain, i.display_order, c.category_name,
		IFNULL(s.is_shareable, 1)
		FROM m_development_item i
		JOIN m_development_category c ON c.development_category_id = i.development_category_id
		LEFT JOIN m_share_setting s ON s.development_item_id = i.development_item_id
		ORDER BY c.display_order, i.display_order`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "共有範囲を取得できませんでした")
		return
	}
	defer rows.Close()

	type row struct {
		Item         DevelopmentItem `json:"item"`
		CategoryName string          `json:"categoryName"`
		IsShareable  bool            `json:"isShareable"`
	}
	out := []row{}
	for rows.Next() {
		var x row
		if rows.Scan(&x.Item.DevelopmentItemID, &x.Item.DevelopmentCategoryID, &x.Item.ItemName,
			&x.Item.Domain, &x.Item.DisplayOrder, &x.CategoryName, &x.IsShareable) == nil {
			out = append(out, x)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) handleSetShareable(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		DevelopmentItemID int64 `json:"development_item_id"`
		IsShareable       bool  `json:"is_shareable"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if _, err := a.db.Exec(`INSERT INTO m_share_setting
		(development_item_id, is_shareable, updated_staff_id, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(development_item_id) DO UPDATE SET
		  is_shareable = excluded.is_shareable,
		  updated_staff_id = excluded.updated_staff_id,
		  updated_at = excluded.updated_at`,
		req.DevelopmentItemID, req.IsShareable, u.staff(), now()); err != nil {
		writeErr(w, http.StatusInternalServerError, "共有範囲の設定に失敗しました")
		return
	}
	after := "共有しない"
	if req.IsShareable {
		after = "共有する"
	}
	a.log(u.AccountID, fnDev, opUpdate, "m_share_setting", i64(req.DevelopmentItemID), nil, nil, s(after))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
