package main

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
)

/*
ensureInternalDiary は、既存の DB の日誌を園内の記録の形へ移す（詳細設計書「変える表」(5-3)・「既存の DB の移し方」(5-4) の 7）。

  - t_diary：保護者への共有の列（is_shared_to_guardian・shared_at）を落とし、申請者（applied_staff_id・applied_at）と
    ヒヤリハットの欄（occurred_at ほか）を足し、class_id を必須にする。表を作り直して中身を移す
  - m_diary_template：保護者への共有の既定（default_share_to_guardian）を落とし、is_deleted を足す
  - t_chat_message：日誌・発達身体の共有の知らせ（source_type 2・3）を取り消し済みにする。保護者のチャットに、
    開けない日誌へのカードを残さないため（基本設計書「いまのデータの移し方」(5-1)）

起動のたびに確かめ、足りないものだけを行う（何度呼んでも同じ結果になる）。新規作成の DB は schema.sql と seed.sql が
すでに新しい形を持つため、どの処理も何もしない。t_operation_log の作り直し（ensureContactSchema）のあとに呼ぶ。
*/
func ensureInternalDiary(db *sql.DB) error {
	var ddl string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 't_diary'`).Scan(&ddl); err != nil {
		return fmt.Errorf("t_diary を確かめられません: %w", err)
	}
	if !strings.Contains(ddl, "applied_staff_id") || strings.Contains(ddl, "is_shared_to_guardian") {
		// class_id を決められない日誌があれば、移しを止めて日誌の ID を出す（詳細設計書「変える表」(5-3) の ②）
		ids, err := diariesWithoutClass(db)
		if err != nil {
			return err
		}
		if len(ids) > 0 {
			return fmt.Errorf("クラスを決められない日誌があるため移せません（日誌の ID：%s）", strings.Join(ids, "、"))
		}
		if err := rebuildTable(db, rebuildDiarySteps()); err != nil {
			return fmt.Errorf("t_diary を作り直せません: %w", err)
		}
		log.Print("日誌を園内の記録の形にしました（保護者への共有の列を外し、申請者の列を足した）")
	}

	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'm_diary_template'`).Scan(&ddl); err != nil {
		return fmt.Errorf("m_diary_template を確かめられません: %w", err)
	}
	if strings.Contains(ddl, "default_share_to_guardian") || !strings.Contains(ddl, "is_deleted") {
		if err := rebuildTable(db, rebuildDiaryTemplateSteps); err != nil {
			return fmt.Errorf("m_diary_template を作り直せません: %w", err)
		}
		log.Print("日誌の雛形から保護者への共有の既定を外しました")
	}

	// 取り消した職員は空（システムの移し）。すでに取り消したものは触らない
	res, err := db.Exec(`UPDATE t_chat_message SET is_deleted = 1, deleted_at = ?, deleted_account_id = NULL
		WHERE source_type IN ('2','3') AND is_deleted = 0`, now())
	if err != nil {
		return fmt.Errorf("共有の知らせを取り消せません: %w", err)
	}
	if n, _ := res.RowsAffected(); n > 0 {
		log.Printf("日誌・発達身体の共有の知らせ %d 件を、チャットに出ないようにしました", n)
	}

	// 保護者へ共有する印（share_to_guardian）を足す。既存の日誌は共有しない（0）のまま（api_diary_share.go）
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('t_diary') WHERE name = 'share_to_guardian'`).Scan(&n); err != nil {
		return fmt.Errorf("t_diary の列を確かめられません: %w", err)
	}
	if n == 0 {
		if _, err := db.Exec(`ALTER TABLE t_diary ADD COLUMN share_to_guardian INTEGER NOT NULL DEFAULT 0 CHECK (share_to_guardian IN (0,1))`); err != nil {
			return fmt.Errorf("t_diary に share_to_guardian を足せません: %w", err)
		}
	}
	return nil
}

// diaryFiscalYearSQL は、記録日（d.diary_date）の年度。年度は4月1日に替わる（m_class.fiscal_year と同じ数え方）
const diaryFiscalYearSQL = `(CAST(substr(d.diary_date, 1, 4) AS INTEGER) - (CASE WHEN substr(d.diary_date, 6, 2) < '04' THEN 1 ELSE 0 END))`

// diaryClassSQL は、移すときの日誌のクラス。いまの値が無ければ、記録日の年度の園児のクラス、無ければいまの年度のクラス
func diaryClassSQL() string {
	return fmt.Sprintf(`COALESCE(d.class_id,
		(SELECT cc.class_id FROM t_class_child cc JOIN m_class c ON c.class_id = cc.class_id
		  WHERE cc.child_id = d.child_id AND c.fiscal_year = %s ORDER BY cc.class_id LIMIT 1),
		(SELECT cc.class_id FROM t_class_child cc JOIN m_class c ON c.class_id = cc.class_id
		  WHERE cc.child_id = d.child_id AND c.fiscal_year = %d ORDER BY cc.class_id LIMIT 1))`,
		diaryFiscalYearSQL, fiscalYear)
}

// diariesWithoutClass は、移すときにクラスを決められない日誌の ID を返す
func diariesWithoutClass(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`SELECT d.diary_id FROM t_diary d WHERE ` + diaryClassSQL() + ` IS NULL ORDER BY d.diary_id`)
	if err != nil {
		return nil, fmt.Errorf("日誌のクラスを確かめられません: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, itoa64(id))
		}
	}
	return ids, rows.Err()
}

// diaryTableDDL は t_diary の定義。schema.sql と同じにする（詳細設計書「書き方の対応」(5-1)）。%s は表の名前
const diaryTableDDL = `CREATE TABLE %s (
  diary_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type           TEXT    NOT NULL CHECK (record_type IN ('1','2','3','4')),
  child_id              TEXT    REFERENCES m_child(child_id),
  class_id              INTEGER NOT NULL REFERENCES m_class(class_id),
  diary_date            TEXT    NOT NULL,
  body                  TEXT    NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('1','2','3','4')),
  created_staff_id      TEXT    NOT NULL REFERENCES m_staff(staff_id),
  applied_staff_id      TEXT    REFERENCES m_staff(staff_id),
  applied_at            TEXT,
  approved_staff_id     TEXT    REFERENCES m_staff(staff_id),
  approved_at           TEXT,
  occurred_at           TEXT,
  place                 TEXT,
  guardian_notice       TEXT    CHECK (guardian_notice IN ('1','2')),
  guardian_noticed_at   TEXT,
  guardian_notice_method TEXT   CHECK (guardian_notice_method IN ('1','2','3','9')),
  guardian_notice_person TEXT,
  nap_abnormal_id       INTEGER REFERENCES t_nap_abnormal(nap_abnormal_id),
  returned_reason       TEXT,
  share_to_guardian     INTEGER NOT NULL DEFAULT 0 CHECK (share_to_guardian IN (0,1)),
  is_deleted            INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  CHECK (status NOT IN ('2','3') OR (applied_staff_id IS NOT NULL AND applied_at IS NOT NULL)),
  CHECK (record_type <> '4' OR (occurred_at IS NOT NULL AND place IS NOT NULL)),
  CHECK (guardian_notice IS NOT '1' OR (guardian_noticed_at IS NOT NULL AND guardian_notice_method IS NOT NULL AND guardian_notice_person IS NOT NULL))
)`

// diaryApplyLogSQL は、その日誌を最後に申請した操作ログの行（詳細設計書「変える表」(5-3) の ①）。
// 共有を選んで申請した行（「（保護者へ共有）」付き）も申請の行として数える
const diaryApplyLogSQL = `FROM t_operation_log l
	WHERE l.function_type = '1' AND l.target_table = 't_diary' AND l.target_id = d.diary_id
	  AND l.after_value IN ('` + diaryLogApply + `','` + diaryLogCreateAndApply + `','` +
	diaryLogApplyShared + `','` + diaryLogCreateAndApplyShared + `')
	ORDER BY l.operated_at DESC, l.operation_log_id DESC LIMIT 1`

/*
rebuildDiarySteps は t_diary の作り直しの手順を返す。移す値（詳細設計書「変える表」(5-3)）：

  - ① 申請中・承認済みの行の申請者・申請日時は、操作ログの「申請」「作成して申請」の最も新しい行の操作者と時刻。
    無ければ作成者と updated_at
  - ② class_id が空の行は diaryClassSQL のクラス
  - ③ 既存のヒヤリハットの発生日時は記録日の 0:00、場所は「（以前の形式の記録）」。場所は画面の「場所」欄に出るので、
    設計書の版番号は書かない（server/visible_wording_test.go が見張る）。以前は「（第3.0版より前の記録）」を入れていた。
    この作り直しは古い DB を移すときに1回だけ走るので、もう移した DB の値は書き換えない
  - 差し戻し・下書きの行の承認者は空にする。以前の版は差し戻した管理者を承認者の列に入れていた
*/
func rebuildDiarySteps() []string {
	return []string{
		fmt.Sprintf(diaryTableDDL, "t_diary_new"),
		`INSERT INTO t_diary_new
		  (diary_id, record_type, child_id, class_id, diary_date, body, status, created_staff_id,
		   applied_staff_id, applied_at, approved_staff_id, approved_at, occurred_at, place,
		   nap_abnormal_id, returned_reason, is_deleted, created_at, updated_at)
		 SELECT d.diary_id, d.record_type, d.child_id, ` + diaryClassSQL() + `, d.diary_date, d.body, d.status, d.created_staff_id,
		   CASE WHEN d.status IN ('2','3') THEN COALESCE(
		     (SELECT st.staff_id FROM m_staff st WHERE st.account_id = (SELECT l.account_id ` + diaryApplyLogSQL + `)),
		     d.created_staff_id) END,
		   CASE WHEN d.status IN ('2','3') THEN COALESCE((SELECT l.operated_at ` + diaryApplyLogSQL + `), d.updated_at) END,
		   CASE WHEN d.status = '3' THEN d.approved_staff_id END,
		   CASE WHEN d.status = '3' THEN d.approved_at END,
		   CASE WHEN d.record_type = '4' THEN d.diary_date || 'T00:00:00' END,
		   CASE WHEN d.record_type = '4' THEN '（以前の形式の記録）' END,
		   d.nap_abnormal_id, d.returned_reason, d.is_deleted, d.created_at, d.updated_at
		 FROM t_diary d`,
		`DROP TABLE t_diary`,
		`ALTER TABLE t_diary_new RENAME TO t_diary`,
		`CREATE INDEX ix_diary_date   ON t_diary (diary_date)`,
		`CREATE INDEX ix_diary_child  ON t_diary (child_id, diary_date)`,
		`CREATE INDEX ix_diary_class  ON t_diary (class_id, diary_date)`,
		`CREATE INDEX ix_diary_status ON t_diary (status, applied_at)`,
	}
}

// 雛形（m_diary_template）。保護者への共有の既定を落とし、消した印を足す（schema.sql と同じ定義）
var rebuildDiaryTemplateSteps = []string{
	`CREATE TABLE m_diary_template_new (
	  diary_template_id INTEGER PRIMARY KEY AUTOINCREMENT,
	  record_type       TEXT    NOT NULL CHECK (record_type IN ('1','2','3','4')),
	  template_name     TEXT    NOT NULL,
	  body              TEXT    NOT NULL,
	  is_deleted        INTEGER NOT NULL DEFAULT 0
	)`,
	`INSERT INTO m_diary_template_new (diary_template_id, record_type, template_name, body)
	 SELECT diary_template_id, record_type, template_name, body FROM m_diary_template`,
	`DROP TABLE m_diary_template`,
	`ALTER TABLE m_diary_template_new RENAME TO m_diary_template`,
}
