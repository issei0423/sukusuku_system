package main

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

/*
日誌を園内の記録の形へ移す（詳細設計書「変える表」(5-3)・「既存の DB の移し方」(5-4) の 7）。
*/

// oldDiaryDB は、日誌を作り直す前の定義（保護者への共有の列がある）で、移しが触る表だけを作った DB を返す
func oldDiaryDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "old.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(1)
	for _, q := range []string{
		`CREATE TABLE m_staff (staff_id TEXT PRIMARY KEY, account_id INTEGER)`,
		`CREATE TABLE m_class (class_id INTEGER PRIMARY KEY, fiscal_year INTEGER NOT NULL, class_name TEXT NOT NULL)`,
		`CREATE TABLE t_class_child (class_id INTEGER NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY (class_id, child_id))`,
		`CREATE TABLE t_operation_log (
		  operation_log_id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, operated_at TEXT NOT NULL,
		  function_type TEXT NOT NULL, operation_type TEXT NOT NULL, target_table TEXT NOT NULL, target_id INTEGER,
		  target_child_id TEXT, before_value TEXT, after_value TEXT)`,
		`CREATE TABLE t_chat_message (
		  chat_message_id INTEGER PRIMARY KEY AUTOINCREMENT, chat_room_id INTEGER NOT NULL, sender_account_id INTEGER NOT NULL,
		  body TEXT NOT NULL, source_type TEXT NOT NULL, source_id INTEGER, sent_at TEXT NOT NULL,
		  is_deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, deleted_account_id INTEGER)`,
		`CREATE TABLE t_diary (
		  diary_id INTEGER PRIMARY KEY AUTOINCREMENT,
		  record_type TEXT NOT NULL CHECK (record_type IN ('1','2','3','4')),
		  child_id TEXT, class_id INTEGER, diary_date TEXT NOT NULL, body TEXT NOT NULL,
		  status TEXT NOT NULL CHECK (status IN ('1','2','3','4')), created_staff_id TEXT NOT NULL,
		  approved_staff_id TEXT, approved_at TEXT,
		  is_shared_to_guardian INTEGER NOT NULL DEFAULT 0, shared_at TEXT,
		  nap_abnormal_id INTEGER, returned_reason TEXT, is_deleted INTEGER NOT NULL DEFAULT 0,
		  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE TABLE m_diary_template (
		  diary_template_id INTEGER PRIMARY KEY AUTOINCREMENT, record_type TEXT NOT NULL, template_name TEXT NOT NULL,
		  body TEXT NOT NULL, default_share_to_guardian INTEGER NOT NULL DEFAULT 0)`,
		`INSERT INTO m_staff VALUES ('S001',1),('S003',3),('S004',4)`,
		`INSERT INTO m_class VALUES (1,2026,'さくら組'),(9,2025,'もも組')`,
		`INSERT INTO t_class_child VALUES (1,'C001'),(9,'C001'),(1,'C004')`,
		// 1: 申請中（操作ログに申請が2回。新しいほうが申請者） 2: 承認済み・共有（操作ログに申請なし）
		// 3: 差し戻し（以前の版は差し戻した管理者を承認者の列に入れていた） 4: クラスの空いた昨年度の個人日誌
		// 5: クラスの空いた今年度のヒヤリハット
		`INSERT INTO t_diary (diary_id, record_type, child_id, class_id, diary_date, body, status, created_staff_id,
		   approved_staff_id, approved_at, is_shared_to_guardian, shared_at, returned_reason, created_at, updated_at) VALUES
		 (1,'1','C001',1,'2026-09-01','申請中','2','S003',NULL,NULL,0,NULL,NULL,'2026-09-01T16:00:00','2026-09-01T17:00:00'),
		 (2,'1','C001',1,'2026-08-29','承認済み','3','S003','S001','2026-08-29T18:05:00',1,'2026-08-29T18:05:00',NULL,'2026-08-29T17:00:00','2026-08-29T18:05:00'),
		 (3,'1','C004',1,'2026-08-30','差し戻し','4','S004','S001',NULL,0,NULL,'直してください','2026-08-30T17:00:00','2026-08-31T09:00:00'),
		 (4,'1','C001',NULL,'2026-03-10','昨年度','1','S003',NULL,NULL,0,NULL,NULL,'2026-03-10T17:00:00','2026-03-10T17:00:00'),
		 (5,'4','C004',NULL,'2026-09-01','【状況】転んだ','1','S004',NULL,NULL,0,NULL,NULL,'2026-09-01T12:00:00','2026-09-01T12:00:00')`,
		`INSERT INTO t_operation_log (account_id, operated_at, function_type, operation_type, target_table, target_id, after_value) VALUES
		 (3,'2026-09-01T16:30:00','1','2','t_diary',1,'申請'),
		 (4,'2026-09-01T16:50:00','1','2','t_diary',1,'作成して申請'),
		 (1,'2026-09-01T16:55:00','1','2','t_diary',1,'下書き保存')`,
		`INSERT INTO t_chat_message (chat_room_id, sender_account_id, body, source_type, source_id, sent_at, is_deleted, deleted_at, deleted_account_id) VALUES
		 (6,3,'日誌を共有しました。','2',2,'2026-08-29T18:05:00',0,NULL,NULL),
		 (6,3,'身体測定を共有しました。','3',1,'2026-08-29T18:10:00',0,NULL,NULL),
		 (6,6,'ありがとうございます。','1',NULL,'2026-08-29T20:00:00',0,NULL,NULL),
		 (6,3,'取り消したもの','1',NULL,'2026-08-28T10:00:00',1,'2026-08-28T10:01:00',3)`,
		`INSERT INTO m_diary_template (record_type, template_name, body, default_share_to_guardian) VALUES ('1','個人日誌','【今日の様子】',1)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	return db
}

func TestEnsureInternalDiaryUpgradesOldDB(t *testing.T) {
	db := oldDiaryDB(t)
	for i := 0; i < 2; i++ {
		if err := ensureInternalDiary(db); err != nil {
			t.Fatalf("%d回目: %v", i+1, err)
		}
	}

	t.Run("共有の列が無くなり、申請者の列とヒヤリハットの欄がある", func(t *testing.T) {
		var ddl string
		db.QueryRow(`SELECT sql FROM sqlite_master WHERE name = 't_diary'`).Scan(&ddl)
		for _, col := range []string{"is_shared_to_guardian", "shared_at"} {
			if strings.Contains(ddl, col) {
				t.Errorf("t_diary に %s が残っている", col)
			}
		}
		for _, col := range []string{"applied_staff_id", "applied_at", "occurred_at", "guardian_notice_person", "class_id              INTEGER NOT NULL"} {
			if !strings.Contains(ddl, col) {
				t.Errorf("t_diary に %s が無い", col)
			}
		}
		db.QueryRow(`SELECT sql FROM sqlite_master WHERE name = 'm_diary_template'`).Scan(&ddl)
		if strings.Contains(ddl, "default_share_to_guardian") || !strings.Contains(ddl, "is_deleted") {
			t.Errorf("m_diary_template = %s", ddl)
		}
		var n int
		db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('ix_diary_class','ix_diary_status','ix_diary_date','ix_diary_child')`).Scan(&n)
		if n != 4 {
			t.Errorf("索引 = %d 個, want 4", n)
		}
	})

	type row struct {
		classID                               int64
		applied, appliedAt, approved, occured sql.NullString
		place                                 sql.NullString
	}
	read := func(id int) row {
		var r row
		if err := db.QueryRow(`SELECT class_id, applied_staff_id, applied_at, approved_staff_id, occurred_at, place
			FROM t_diary WHERE diary_id = ?`, id).Scan(&r.classID, &r.applied, &r.appliedAt, &r.approved, &r.occured, &r.place); err != nil {
			t.Fatalf("日誌 %d: %v", id, err)
		}
		return r
	}

	t.Run("申請者は操作ログの最も新しい申請、無ければ作成者と updated_at", func(t *testing.T) {
		if r := read(1); r.applied.String != "S004" || r.appliedAt.String != "2026-09-01T16:50:00" {
			t.Errorf("日誌 1: %+v", r)
		}
		if r := read(2); r.applied.String != "S003" || r.appliedAt.String != "2026-08-29T18:05:00" || r.approved.String != "S001" {
			t.Errorf("日誌 2: %+v", r)
		}
	})

	t.Run("差し戻し・下書きは申請者が空で、承認者の列に差し戻した管理者を残さない", func(t *testing.T) {
		if r := read(3); r.applied.Valid || r.approved.Valid {
			t.Errorf("日誌 3: %+v", r)
		}
	})

	t.Run("クラスの空いた日誌は記録日の年度のクラス、無ければいまの年度のクラス", func(t *testing.T) {
		if r := read(4); r.classID != 9 {
			t.Errorf("日誌 4（2025年度）: class_id = %d, want 9", r.classID)
		}
		if r := read(5); r.classID != 1 {
			t.Errorf("日誌 5: class_id = %d, want 1", r.classID)
		}
	})

	t.Run("既存のヒヤリハットの発生日時は記録日の 0:00、場所は「（第3.0版より前の記録）」", func(t *testing.T) {
		if r := read(5); r.occured.String != "2026-09-01T00:00:00" || r.place.String != "（第3.0版より前の記録）" {
			t.Errorf("日誌 5: %+v", r)
		}
		if r := read(1); r.occured.Valid || r.place.Valid {
			t.Errorf("個人日誌にヒヤリハットの欄が入った: %+v", r)
		}
	})

	t.Run("共有の知らせ（2・3）だけを取り消し済みにする。取り消した職員は空", func(t *testing.T) {
		rows, _ := db.Query(`SELECT source_type, is_deleted, IFNULL(deleted_account_id, 0) FROM t_chat_message ORDER BY chat_message_id`)
		defer rows.Close()
		var got []string
		for rows.Next() {
			var st string
			var del, by int
			rows.Scan(&st, &del, &by)
			got = append(got, st+":"+itoa64(int64(del))+":"+itoa64(int64(by)))
		}
		want := []string{"2:1:0", "3:1:0", "1:0:0", "1:1:3"}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("メッセージ = %v, want %v", got, want)
		}
	})

	t.Run("作り直したあとも、ヒヤリハットは発生日時と場所が無ければ入らない", func(t *testing.T) {
		db.Exec(`PRAGMA foreign_keys = OFF`)
		if _, err := db.Exec(`INSERT INTO t_diary (record_type, child_id, class_id, diary_date, body, status, created_staff_id, created_at, updated_at)
			VALUES ('4','C001',1,'2026-09-02','【状況】','1','S003','2026-09-02T10:00:00','2026-09-02T10:00:00')`); err == nil {
			t.Error("発生日時の無いヒヤリハットが入った")
		}
		if _, err := db.Exec(`INSERT INTO t_diary (record_type, child_id, class_id, diary_date, body, status, created_staff_id, created_at, updated_at)
			VALUES ('1','C001',1,'2026-09-02','申請','2','S003','2026-09-02T10:00:00','2026-09-02T10:00:00')`); err == nil {
			t.Error("申請者の無い申請中の日誌が入った")
		}
	})
}

// クラスを決められない日誌があれば、移しを止めて日誌の ID を出す（詳細設計書「変える表」(5-3) の ②）
func TestEnsureInternalDiaryStopsWithoutClass(t *testing.T) {
	db := oldDiaryDB(t)
	if _, err := db.Exec(`INSERT INTO t_diary (diary_id, record_type, child_id, class_id, diary_date, body, status, created_staff_id, created_at, updated_at)
		VALUES (42,'1','C999',NULL,'2026-09-01','どのクラスにもいない園児','1','S003','2026-09-01T10:00:00','2026-09-01T10:00:00')`); err != nil {
		t.Fatal(err)
	}
	err := ensureInternalDiary(db)
	if err == nil || !strings.Contains(err.Error(), "42") {
		t.Fatalf("err = %v, want 日誌 42 を含む誤り", err)
	}
	var ddl string
	db.QueryRow(`SELECT sql FROM sqlite_master WHERE name = 't_diary'`).Scan(&ddl)
	if !strings.Contains(ddl, "is_shared_to_guardian") {
		t.Fatal("移しを止めたのに表が作り直された")
	}
}

// 新規作成の DB（schema.sql と seed.sql）では、移しは何もしない。デモデータに共有の知らせは無い
func TestInternalDiaryFreshDB(t *testing.T) {
	a, _ := newTestApp(t)
	var before string
	a.db.QueryRow(`SELECT sql FROM sqlite_master WHERE name = 't_diary'`).Scan(&before)
	if err := ensureInternalDiary(a.db); err != nil {
		t.Fatal(err)
	}
	var after string
	a.db.QueryRow(`SELECT sql FROM sqlite_master WHERE name = 't_diary'`).Scan(&after)
	if before != after {
		t.Fatal("新規作成の DB の t_diary が作り直された")
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE source_type IN ('2','3')`).Scan(&n)
	if n != 0 {
		t.Fatalf("デモデータに共有の知らせが %d 件ある", n)
	}
	var body string
	a.db.QueryRow(`SELECT body FROM m_diary_template WHERE diary_template_id = 1`).Scan(&body)
	if strings.Contains(body, "保護者") {
		t.Fatalf("個人日誌の雛形に保護者あての見出しがある: %q", body)
	}
}
