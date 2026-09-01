package main

import (
	"database/sql"
	"net/http"
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
	}
	writeJSON(w, http.StatusOK,
		page(out, queryInt(r, "page", 1), a.settingInt("paging.operation_log_per_page", 100)))
}
