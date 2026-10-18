package main

import (
	"database/sql"
	"fmt"
	"log"
)

/*
ensureNapAbnormalGuardianNotice は、異常時の記録の「保護者への連絡」の4列（t_nap_abnormal の
guardian_notice・guardian_noticed_at・guardian_notice_method・guardian_notice_person）を、
以前に作られたデータベースへ足す。

列は基本設計書「午睡チェック」(5-7) の「足した列（午睡チェックの記録・異常時の記録）」のとおり。
足す前の記録は空（未記入）のまま残す。連絡したかどうかを、あとから推し量って埋めないため。
新規作成のときは schema.sql がすでに持っているため、何も変わらない。定義は schema.sql と同じにしてある。
*/
func ensureNapAbnormalGuardianNotice(db *sql.DB) error {
	cols := []struct{ name, def string }{
		{"guardian_notice", `guardian_notice TEXT CHECK (guardian_notice IN ('1','2'))`},
		{"guardian_noticed_at", `guardian_noticed_at TEXT`},
		{"guardian_notice_method", `guardian_notice_method TEXT CHECK (guardian_notice_method IN ('1','2','3','9'))`},
		{"guardian_notice_person", `guardian_notice_person TEXT`},
	}
	for _, c := range cols {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('t_nap_abnormal') WHERE name = ?`,
			c.name).Scan(&n); err != nil {
			return fmt.Errorf("異常時の記録の列を確かめられません: %w", err)
		}
		if n > 0 {
			continue
		}
		if _, err := db.Exec(`ALTER TABLE t_nap_abnormal ADD COLUMN ` + c.def); err != nil {
			return fmt.Errorf("異常時の記録に %s の列を足せません: %w", c.name, err)
		}
		log.Printf("異常時の記録に保護者への連絡の列（%s）を足しました", c.name)
	}
	return nil
}
