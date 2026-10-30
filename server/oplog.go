package main

import (
	"bytes"
	"encoding/json"
	"log"
	"strings"
)

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
	fnContact  = "8"
	fnSetting  = "9"

	opCreate  = "1"
	opUpdate  = "2"
	opApprove = "3"
	opDelete  = "4"
	opExport  = "5"
	opAiDraft = "6"
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

/*
logSystem は、システムが行った変更を、操作者を「システム」（operator_type = '2'、account_id は空）として記録する
（基本設計書「操作ログの記録」(4-2)「有効な紐づけが無くなったことによる保護者アカウントの停止は、操作者を『システム』として記録する」、
「操作ログ（t_operation_log）」(5-9) operator_type）。
仮の「システム」アカウントを m_account に作る方式は採らない（同 (5-9)）。参照の画面は、種類が 2 の行の操作者を「システム」と出す。
*/
func (a *app) logSystem(functionType, operationType, table string,
	targetID *int64, childID *string, before, after *string) {
	_, err := a.db.Exec(`INSERT INTO t_operation_log
		(account_id, operated_at, function_type, operation_type, target_table, target_id,
		 target_child_id, before_value, after_value, operator_type)
		VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, '2')`,
		now(), functionType, operationType, table, targetID, childID, before, after)
	if err != nil {
		log.Printf("操作ログ（システム）の記録に失敗しました（%s/%s %s）: %v", functionType, operationType, table, err)
	}
}

// systemOperatorName は、操作者の種類が「システム」の行に出す操作者の名前
const systemOperatorName = "システム"

func i64(v int64) *int64 { return &v }
func s(v string) *string { return &v }

/*
 * 変更前後の値（基本設計書「操作ログ（t_operation_log）」(5-8)）
 *
 * 「変更前後の値は JSON 文字列で保持する。変更のあった項目だけを {"項目名": 値} の形で入れる」。
 * 項目は並べた順に書く（Go の map は順が決まらないため使わない）。画面側のモック（web/src/api/mock.ts の
 * changedFields）も同じ項目名・同じ順で書く。
 * 【仮置き】ほかの操作の記録（日誌の「申請」、アカウントの「停止」など）は、まだ文で残している（web/仮置き値.md）
 */

// field は、操作ログの変更前後に入れる 1 項目
type field struct {
	name  string
	value any
}

// jsonText は値を JSON にする。< > & を < などに置き換えない（操作ログの画面でそのまま読めるように）
func jsonText(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "null"
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

// fieldsJSON は、項目を並べた順に {"項目名": 値} の JSON 文字列にする
func fieldsJSON(fields []field) string {
	var b strings.Builder
	b.WriteByte('{')
	for i, f := range fields {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsonText(f.name))
		b.WriteByte(':')
		b.WriteString(jsonText(f.value))
	}
	b.WriteByte('}')
	return b.String()
}

// changedFields は、変わった項目だけを、変更前と変更後の JSON 文字列にする。
// before と after は、同じ項目を同じ順に並べて渡す
func changedFields(before, after []field) (string, string) {
	var b, a []field
	for i := range after {
		if i < len(before) && jsonText(before[i].value) == jsonText(after[i].value) {
			continue
		}
		if i < len(before) {
			b = append(b, before[i])
		}
		a = append(a, after[i])
	}
	return fieldsJSON(b), fieldsJSON(a)
}
