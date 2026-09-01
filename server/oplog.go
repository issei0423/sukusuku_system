package main

import "log"

/*
 * 操作ログ（t_operation_log）
 * 典拠：基本設計書.md「操作ログ」(5-8)・「監査への対応」(6-4)
 *
 * 追記のみとし、更新・削除の手段を設けない。
 * 記録する操作はサーバ側で決める。画面側から呼ばせない。
 */

const (
	fnDiary    = "1"
	fnChat     = "2"
	fnNap      = "3"
	fnDev      = "4"
	fnPhysical = "5"
	fnChild    = "6"
	fnAccount  = "7"

	opCreate  = "1"
	opUpdate  = "2"
	opApprove = "3"
	opDelete  = "4"
	opExport  = "5"
)

func (a *app) log(accountID int64, functionType, operationType, table string,
	targetID *int64, childID *string, before, after *string) {
	_, err := a.db.Exec(`INSERT INTO t_operation_log
		(account_id, operated_at, function_type, operation_type, target_table, target_id,
		 target_child_id, before_value, after_value)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		accountID, now(), functionType, operationType, table, targetID, childID, before, after)
	if err != nil {
		// ログの書き込み失敗は業務処理を止めないが、黙って捨てない
		log.Printf("操作ログの記録に失敗しました（%s/%s %s）: %v", functionType, operationType, table, err)
	}
}

func i64(v int64) *int64 { return &v }
func s(v string) *string { return &v }
