package main

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

/*
連絡帳の表とデモデータの確かめ（詳細設計書「既存の DB の移し方」(5-4)・「デモデータ」(5-5)・「時計」(9-3)）。
モックの同じ観点は web/tests/contact.test.ts の「デモデータ」にある。
*/

// 連絡帳を足す前の DB（第3.0版の前の定義）を、ensureContactSchema が移せること。2回呼んでも同じになること
func TestEnsureContactSchemaUpgradesOldDB(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "old.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	// 移しが触る表だけを、前の定義で作る（外部キーの先の表は無くても作れる）
	for _, q := range []string{
		`CREATE TABLE m_child (child_id TEXT PRIMARY KEY, child_name TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE t_chat_message (chat_message_id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)`,
		`CREATE TABLE t_guardian_child (
		  guardian_id TEXT NOT NULL, child_id TEXT NOT NULL, relationship TEXT,
		  link_status TEXT NOT NULL CHECK (link_status IN ('1','2')),
		  linked_at TEXT NOT NULL, ended_at TEXT, PRIMARY KEY (guardian_id, child_id))`,
		`CREATE TABLE m_terms (
		  terms_id INTEGER PRIMARY KEY AUTOINCREMENT, terms_version TEXT NOT NULL UNIQUE,
		  document_type TEXT NOT NULL CHECK (document_type IN ('1','2')), body TEXT NOT NULL, published_on TEXT NOT NULL)`,
		`CREATE TABLE t_operation_log (
		  operation_log_id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, operated_at TEXT NOT NULL,
		  function_type TEXT NOT NULL CHECK (function_type IN ('1','2','3','4','5','6','7')),
		  operation_type TEXT NOT NULL CHECK (operation_type IN ('1','2','3','4','5')),
		  target_table TEXT NOT NULL, target_id INTEGER, target_child_id TEXT, before_value TEXT, after_value TEXT)`,
		`CREATE TABLE m_setting (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, description TEXT, updated_staff_id TEXT NOT NULL, updated_at TEXT NOT NULL)`,
		`CREATE TABLE m_staff (staff_id TEXT PRIMARY KEY, staff_name TEXT NOT NULL)`,
		`INSERT INTO m_staff VALUES ('S001','西田 拓也')`,
		`INSERT INTO t_guardian_child VALUES ('G001','C001','父','1','2025-06-10T10:00:00',NULL)`,
		`INSERT INTO m_terms (terms_version, document_type, body, published_on) VALUES ('1.0','1','規約','2025-04-01')`,
		`INSERT INTO t_operation_log (account_id, operated_at, function_type, operation_type, target_table) VALUES (3,'2026-09-01T09:00:00','1','1','t_diary')`,
		`INSERT INTO m_setting VALUES ('contact.mood_choices','ごきげん,ねむい','園が変えた値','S001','2026-09-01T09:00:00')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := ensureContactSchema(db); err != nil {
			t.Fatalf("%d回目: %v", i+1, err)
		}
	}
	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	// 外部キーの先の表（m_account など）はこの DB に無いため、検査を止めて列と CHECK だけを確かめる
	mustExec(`PRAGMA foreign_keys = OFF`)
	// 猶予中（3）・連絡帳（8）・AI の下書き（6）・同じ版の別の文書が入る。前の行は残る
	mustExec(`UPDATE t_guardian_child SET link_status = '3', grace_ends_on = '2026-10-01' WHERE guardian_id = 'G001'`)
	mustExec(`INSERT INTO t_operation_log (account_id, operated_at, function_type, operation_type, target_table) VALUES (3,'2026-09-01T09:10:00','8','6','t_contact_home')`)
	mustExec(`INSERT INTO m_terms (terms_version, document_type, body, published_on) VALUES ('1.0','2','プライバシーポリシー','2025-04-01')`)
	mustExec(`UPDATE m_child SET nickname = 'たっくん'`)
	mustExec(`UPDATE t_chat_message SET quote_contact_date = '2026-09-01'`)
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM t_operation_log`).Scan(&n)
	if n != 2 {
		t.Errorf("操作ログの行 = %d, want 2（前の行が残る）", n)
	}
	for _, table := range []string{"t_contact_home", "t_contact_event", "t_contact_class", "t_contact_facility", "t_contact_read", "t_contact_photo", "t_contact_photo_child", "t_nap_sleep", "t_nap_exclusion", "m_phrase"} {
		if err := db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
			t.Errorf("%s が無い: %v", table, err)
		}
	}
	// 定型文は空のときだけ初期の行を入れる（2回呼んでも増えない）
	db.QueryRow(`SELECT COUNT(*) FROM m_phrase`).Scan(&n)
	if n != len(defaultPhrases) {
		t.Errorf("定型文 = %d, want %d", n, len(defaultPhrases))
	}
	// 設定は足りないものだけを入れる。園が変えた値は書き換えない。AI は使わないが既定
	var mood, ai string
	db.QueryRow(`SELECT setting_value FROM m_setting WHERE setting_key = 'contact.mood_choices'`).Scan(&mood)
	db.QueryRow(`SELECT setting_value FROM m_setting WHERE setting_key = 'ai.enabled'`).Scan(&ai)
	if mood != "ごきげん,ねむい" || ai != "0" {
		t.Errorf("設定 mood=%q ai=%q", mood, ai)
	}
}

// 新規作成の DB では、移しは何もしない（schema.sql と同じ定義）。日付ずらしは新しい表の一意の制約にぶつからない
func TestContactSchemaFreshDBAndShift(t *testing.T) {
	a, _ := newTestApp(t)
	if err := ensureContactSchema(a.db); err != nil {
		t.Fatal(err)
	}
	if err := shiftDatesBy(a.db, 3); err != nil {
		t.Fatalf("日付ずらし: %v", err)
	}
	if err := shiftDatesBy(a.db, -3); err != nil {
		t.Fatalf("日付ずらし（戻す）: %v", err)
	}
	// 昨日の西田 太郎の家庭からは、日付ずらしのあとも昨日のページにある（デモデータ）
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_contact_home WHERE child_id = 'C001' AND contact_date = ?`, daysFromToday(-1)).Scan(&n)
	if n != 1 {
		t.Errorf("昨日の C001 の家庭から = %d 行, want 1", n)
	}
	// 西田 太郎の今日は、家庭から・ねた・園からを空けておく（デモの①②③を押して見せる）
	for _, q := range []string{
		`SELECT COUNT(*) FROM t_contact_home WHERE child_id = 'C001' AND contact_date = ?`,
		`SELECT COUNT(*) FROM t_nap_sleep WHERE child_id = 'C001' AND substr(slept_at, 1, 10) = ?`,
		`SELECT COUNT(*) FROM t_contact_facility WHERE child_id = 'C001' AND contact_date = ?`,
	} {
		a.db.QueryRow(q, today()).Scan(&n)
		if n != 0 {
			t.Errorf("%s = %d, want 0", q, n)
		}
	}
}

// 起動した時刻より後の今日の記録だけを外す（詳細設計書「未来の出来事を入れない」(5-5)）
func TestTrimFutureDemoContacts(t *testing.T) {
	a, _ := newTestApp(t)
	db := a.db
	for _, q := range []string{`DELETE FROM t_contact_event`, `DELETE FROM t_contact_home`, `DELETE FROM t_nap_sleep`, `DELETE FROM t_nap_exclusion`} {
		db.Exec(q)
	}
	// 境目に近い時刻を避け、今の1時間前（過去）と1時間後（未来）で作る。日をまたぐ時間帯は今日の中に収める
	nowT := nowTime()
	past := nowT.Add(-time.Hour)
	future := nowT.Add(time.Hour)
	if past.Format("2006-01-02") != today() || future.Format("2006-01-02") != today() {
		t.Skip("日の変わり目の前後1時間は、今日の中に過去と未来を作れない")
	}
	p, f, d := past.Format("2006-01-02T15:04:05"), future.Format("2006-01-02T15:04:05"), today()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	exec(`INSERT INTO t_contact_event (contact_event_id, child_id, class_id, contact_date, event_type, recorded_at, toilet_label, staff_id, created_at, updated_at) VALUES (901,'C001',1,?,'2',?,'おしっこ','S003',?,?)`, d, p, p, p)
	exec(`INSERT INTO t_contact_event (contact_event_id, child_id, class_id, contact_date, event_type, recorded_at, toilet_label, staff_id, created_at, updated_at) VALUES (902,'C001',1,?,'2',?,'おしっこ','S003',?,?)`, d, f, f, f)
	exec(`INSERT INTO t_contact_home (child_id, contact_date, guardian_id, breakfast, submitted_at, confirmed_staff_id, confirmed_at, created_at, updated_at) VALUES ('C004',?,'G004','1',?,'S003',?,?,?)`, d, p, f, p, f)
	exec(`INSERT INTO t_contact_home (child_id, contact_date, guardian_id, breakfast, submitted_at, created_at, updated_at) VALUES ('C005',?,'G005','1',?,?,?)`, d, f, f, f)
	exec(`INSERT INTO t_nap_sleep (nap_sleep_id, nap_session_id, child_id, slept_at, woke_at, slept_staff_id, woke_staff_id, created_at, updated_at) VALUES (901,1,'C002',?,?,'S003','S003',?,?)`, p, f, p, f)
	exec(`INSERT INTO t_nap_sleep (nap_sleep_id, nap_session_id, child_id, slept_at, slept_staff_id, created_at, updated_at) VALUES (902,1,'C004',?,'S003',?,?)`, f, f, f)
	exec(`INSERT INTO t_nap_exclusion (nap_session_id, child_id, reason, staff_id, created_at) VALUES (1,'C003','1','S003',?)`, f)

	if err := trimFutureDemoContacts(db); err != nil {
		t.Fatal(err)
	}
	count := func(q string) int {
		var n int
		db.QueryRow(q).Scan(&n)
		return n
	}
	if got := count(`SELECT COUNT(*) FROM t_contact_event WHERE contact_event_id = 901`); got != 1 {
		t.Error("過去の出来事が消えた")
	}
	if got := count(`SELECT COUNT(*) FROM t_contact_event WHERE contact_event_id = 902`); got != 0 {
		t.Error("未来の出来事が残った")
	}
	if got := count(`SELECT COUNT(*) FROM t_contact_home WHERE child_id = 'C005'`); got != 0 {
		t.Error("未来に送られた家庭からが残った")
	}
	if got := count(`SELECT COUNT(*) FROM t_contact_home WHERE child_id = 'C004' AND confirmed_at IS NULL AND confirmed_staff_id IS NULL`); got != 1 {
		t.Error("未来の確認が外れていない（未確認に戻る）")
	}
	if got := count(`SELECT COUNT(*) FROM t_nap_sleep WHERE nap_sleep_id = 901 AND woke_at IS NULL`); got != 1 {
		t.Error("未来のおきたが外れていない（おひるね中に戻る）")
	}
	if got := count(`SELECT COUNT(*) FROM t_nap_sleep WHERE nap_sleep_id = 902`); got != 0 {
		t.Error("未来のねたが残った")
	}
	if got := count(`SELECT COUNT(*) FROM t_nap_exclusion`); got != 0 {
		t.Error("未来の対象外が残った")
	}
}

// 定型文の初期の行は、新しい DB（seed.sql）と既存の DB の移し（defaultPhrases）で同じ（詳細設計書「既存の DB の移し方」(5-4) の 5）
func TestDefaultPhrasesMatchSeed(t *testing.T) {
	a, _ := newTestApp(t)
	rows, err := a.db.Query(`SELECT phrase_scope, body FROM m_phrase WHERE is_deleted = 0 ORDER BY phrase_id`)
	if err != nil {
		t.Fatal(err)
	}
	got := [][2]string{}
	for rows.Next() {
		var p [2]string
		rows.Scan(&p[0], &p[1])
		got = append(got, p)
	}
	rows.Close()
	if len(got) != len(defaultPhrases) {
		t.Fatalf("seed.sql の定型文 %d 件、defaultPhrases %d 件", len(got), len(defaultPhrases))
	}
	for i := range got {
		if got[i] != defaultPhrases[i] {
			t.Errorf("%d 行目: seed %v, defaultPhrases %v", i+1, got[i], defaultPhrases[i])
		}
	}
	// 空の m_phrase には、起動のたびの移しが同じ行を入れる。入っていれば何もしない
	a.db.Exec(`DELETE FROM m_phrase`)
	if err := ensureContactSchema(a.db); err != nil {
		t.Fatal(err)
	}
	if err := ensureContactSchema(a.db); err != nil {
		t.Fatal(err)
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_phrase`).Scan(&n)
	if n != len(defaultPhrases) {
		t.Errorf("移したあとの定型文 = %d", n)
	}
	var nick string
	a.db.QueryRow(`SELECT IFNULL(nickname, '') FROM m_child WHERE child_id = 'C001'`).Scan(&nick)
	if nick != "たっくん" {
		t.Errorf("デモの呼び名 = %q", nick)
	}
}
