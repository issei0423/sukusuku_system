package main

import (
	"database/sql"
	"net/http"
	"strconv"
)

/*
 * 操作ログの参照（管理者のみ）
 * 典拠：基本設計書.md「監査への対応」(6-4)・「操作ログ」(5-8)
 *
 * 追記のみとし、更新・削除の手段を設けない。この画面からもログは編集できない。
 */

type operationLogRow struct {
	OperationLogID int64   `json:"operation_log_id"`
	AccountID      int64   `json:"account_id"`
	OperatedAt     string  `json:"operated_at"`
	FunctionType   string  `json:"function_type"`
	OperationType  string  `json:"operation_type"`
	TargetTable    string  `json:"target_table"`
	TargetID       *int64  `json:"target_id"`
	TargetChildID  *string `json:"target_child_id"`
	BeforeValue    *string `json:"before_value"`
	AfterValue     *string `json:"after_value"`
	AccountName    string  `json:"account_name"`
	ChildName      string  `json:"child_name"`
	// 操作の相手。園児に紐づかない操作（アカウントの停止、クラス日誌の承認など）は、
	// 対象園児の列だけでは誰・何に対する操作かが分からない（GitHub Issue #114）
	TargetLabel string `json:"target_label"`
}

// targetLabel は、対象テーブルと対象レコードから、人が読める相手の名前を組み立てる。
// 記録の時点の値ではなく、参照した時点の名前を返す。
func (a *app) targetLabel(table string, targetID *int64) string {
	if targetID == nil {
		return ""
	}
	switch table {
	case "m_account", "t_guardian_child":
		return a.accountName(*targetID)
	case "t_diary", "t_diary_lock":
		var (
			recordType, date string
			classID          sql.NullInt64
			childID          sql.NullString
		)
		if a.db.QueryRow(`SELECT record_type, diary_date, class_id, child_id FROM t_diary WHERE diary_id = ?`,
			*targetID).Scan(&recordType, &date, &classID, &childID) != nil {
			return ""
		}
		label := diaryRecordTypeLabel(recordType)
		if childID.Valid {
			label += " " + a.childName(childID.String)
		} else if classID.Valid {
			label += " " + a.className(classID.Int64)
		}
		return label + " " + date
	}
	return ""
}

func diaryRecordTypeLabel(v string) string {
	switch v {
	case "1":
		return "個人日誌"
	case "2":
		return "クラス日誌"
	case "3":
		return "週案・月案"
	case "4":
		return "ヒヤリハット"
	}
	return "日誌"
}

/*
handleRecordExport は、画面側で組み立てた出力（CSV）を操作ログへ記録する。

操作ログと午睡記録の CSV は画面側で作るため、サーバは出力そのものを見ていない。
出力したことを残すために、画面から呼ばせる（GitHub Issue #115・#117）。
出力は目的を問わず操作ログへ記録する（基本設計書「発達チェック・身体測定」(4-8) と同じ扱い）。
*/
func (a *app) handleRecordExport(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var req struct {
		Kind  string `json:"kind"` // "operation_log"・"nap_record"・"allergy_list"・"invitation_sheet"
		From  string `json:"from"`
		To    string `json:"to"`
		Count int    `json:"count"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	period := "期間 " + req.From + "〜" + req.To + "・" + strconv.Itoa(req.Count) + " 件"
	switch req.Kind {
	case "operation_log":
		if !u.isAdmin() {
			writeForbidden(w, "操作ログの出力は管理者のみが行えます")
			return
		}
		a.log(u.AccountID, fnAccount, opExport, "t_operation_log", nil, nil, nil, s("操作ログをCSV出力（"+period+"）"))
	case "nap_record":
		a.log(u.AccountID, fnNap, opExport, "t_nap_record", nil, nil, nil, s("午睡記録をCSV出力（"+period+"）"))
	case "allergy_list":
		// 要配慮個人情報の一覧。印刷できるのは管理者・一般（保護者は上の requireStaff で断る）。
		// 担任でない職員も、受け入れや合同保育で子を見る場面で配膳に使うため
		// （基本設計書「権限と利用可能機能」(6-1)「アレルギー一覧の印刷｜一般 ○※2・管理者 ○」、
		// 図/画面詳細図.md「アレルギー一覧画面」(7-4) の項目2。設計の直しは PR #216 の直-16・直-24）。
		// 出力したことは、誰が印刷しても操作ログに残す
		a.log(u.AccountID, fnChild, opExport, "m_allergy", nil, nil, nil,
			s("アレルギー一覧を印刷（"+strconv.Itoa(req.Count)+" 名）"))
	case "invitation_sheet":
		if !u.isAdmin() {
			writeForbidden(w, "招待コードの出力は管理者のみが行えます")
			return
		}
		a.log(u.AccountID, fnAccount, opExport, "t_invitation_code", nil, nil, nil,
			s("招待コードを配布用に出力（"+strconv.Itoa(req.Count)+" 枚）"))
	default:
		writeErr(w, http.StatusBadRequest, "出力の種別が正しくありません")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) handleOperationLogs(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	q := `SELECT operation_log_id, account_id, operated_at, function_type, operation_type,
		target_table, target_id, target_child_id, before_value, after_value
		FROM t_operation_log WHERE 1 = 1`
	args := []any{}
	if v := r.URL.Query().Get("from"); v != "" {
		q += ` AND substr(operated_at, 1, 10) >= ?`
		args = append(args, v)
	}
	if v := r.URL.Query().Get("to"); v != "" {
		q += ` AND substr(operated_at, 1, 10) <= ?`
		args = append(args, v)
	}
	if v, has := queryInt64(r, "account_id"); has {
		q += ` AND account_id = ?`
		args = append(args, v)
	}
	if v := r.URL.Query().Get("function_type"); v != "" {
		q += ` AND function_type = ?`
		args = append(args, v)
	}
	if v := r.URL.Query().Get("child_id"); v != "" {
		q += ` AND target_child_id = ?`
		args = append(args, v)
	}
	q += ` ORDER BY operated_at DESC, operation_log_id DESC`

	rows, err := a.db.Query(q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "操作ログを取得できませんでした")
		return
	}
	out := []operationLogRow{}
	for rows.Next() {
		var (
			x       operationLogRow
			target  sql.NullInt64
			childID sql.NullString
			before  sql.NullString
			after   sql.NullString
		)
		if rows.Scan(&x.OperationLogID, &x.AccountID, &x.OperatedAt, &x.FunctionType, &x.OperationType,
			&x.TargetTable, &target, &childID, &before, &after) == nil {
			x.TargetID = nullInt(target)
			x.TargetChildID = nullStr(childID)
			x.BeforeValue = nullStr(before)
			x.AfterValue = nullStr(after)
			out = append(out, x)
		}
	}
	rows.Close()

	for i := range out {
		out[i].AccountName = a.accountName(out[i].AccountID)
		out[i].ChildName = "―"
		if out[i].TargetChildID != nil {
			out[i].ChildName = a.childName(*out[i].TargetChildID)
		}
		out[i].TargetLabel = a.targetLabel(out[i].TargetTable, out[i].TargetID)
	}
	writeJSON(w, http.StatusOK,
		page(out, queryInt(r, "page", 1), a.settingInt("paging.operation_log_per_page", 100)))
}
