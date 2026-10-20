package main

import (
	"database/sql"
	"fmt"
)

/*
ensureGrowthSchema は、既存の DB に成長の記録の列を足す（詳細設計書「変える表」(5-3) の t_development_check）。

起動のたびに確かめ、足りないものだけを足す（何度呼んでも同じ結果になる）。新規作成の DB は schema.sql と seed.sql が
すでに持っているため、列は足さず、確定した日時もすでに入っている。
同じ節の share_status を落とす作り直し（t_development_check・t_physical_record）は、まだ行わない。
*/
func ensureGrowthSchema(db *sql.DB) error {
	for _, c := range []struct{ name, definition string }{
		{"guardian_message", "TEXT"},
		{"finalized_at", "TEXT"},
		// ひとことを書き換えた時刻（決めたこと D-51）。既存の行は書き換えていないので空のまま
		{"guardian_message_corrected_at", "TEXT"},
	} {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('t_development_check') WHERE name = ?`, c.name).Scan(&n); err != nil {
			return fmt.Errorf("t_development_check の列を確かめられません: %w", err)
		}
		if n > 0 {
			continue
		}
		if _, err := db.Exec(`ALTER TABLE t_development_check ADD COLUMN ` + c.name + ` ` + c.definition); err != nil {
			return fmt.Errorf("t_development_check に %s を足せません: %w", c.name, err)
		}
	}
	// 確定済みで確定した日時が無い行を埋める。操作ログの「確定」の最も早い日時、無ければ実施日の 00:00
	// （詳細設計書「変える表」(5-3) の t_development_check、基本設計書「いまのデータの移し方」(5-1)）
	if _, err := db.Exec(`UPDATE t_development_check SET finalized_at = COALESCE(
		(SELECT MIN(l.operated_at) FROM t_operation_log l WHERE l.target_table = 't_development_check'
		   AND l.target_id = t_development_check.development_check_id AND l.after_value = '確定'),
		checked_on || 'T00:00:00') WHERE status = '2' AND finalized_at IS NULL`); err != nil {
		return fmt.Errorf("発達チェックの確定した日時を埋められません: %w", err)
	}
	return nil
}
