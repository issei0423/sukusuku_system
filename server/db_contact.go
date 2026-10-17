package main

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
)

/*
ensureContactSchema は、既存の DB に連絡帳の表と列を足す（詳細設計書「既存の DB の移し方」(5-4)）。

起動のたびに確かめ、足りないものだけを足す（何度呼んでも同じ結果になる）。
新規作成の DB は schema.sql と seed.sql がすでに持っているため、どの処理も何もしない。
定義は schema.sql と同じにする（詳細設計書「書き方の対応」(5-1)。既存の ensureHandouts と同じ決まり）。

本版で行うのは (5-4) の表の 1〜5。6（個人チャットの無い在籍園児にルームを作る）は、
それを使う段（園児の登録時の個人チャット）で足す。
*/
func ensureContactSchema(db *sql.DB) error {
	// 1. 表と索引（contact_ddl.go。schema.sql の「5-4 連絡帳」の節と同じ定義）
	if _, err := db.Exec(contactDDL); err != nil {
		return fmt.Errorf("連絡帳の表を作れません: %w", err)
	}
	// 2. 列を足す（詳細設計書「変える表」(5-3)）
	for _, c := range []struct{ table, name, definition string }{
		{"m_child", "nickname", "TEXT"},
		{"m_child", "face_photo_path", "TEXT"},
		{"m_child", "withdrawn_on", "TEXT"},
		{"m_child", "nap_interval_minutes", "INTEGER CHECK (nap_interval_minutes BETWEEN 1 AND 15)"},
		{"t_chat_message", "confirmed_staff_id", "TEXT"},
		{"t_chat_message", "confirmed_at", "TEXT"},
		{"t_chat_message", "quote_message_id", "INTEGER"},
		{"t_chat_message", "quote_contact_date", "TEXT"},
	} {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, c.table, c.name).Scan(&n); err != nil {
			return fmt.Errorf("%s の列を確かめられません: %w", c.table, err)
		}
		if n > 0 {
			continue
		}
		if _, err := db.Exec(`ALTER TABLE ` + c.table + ` ADD COLUMN ` + c.name + ` ` + c.definition); err != nil {
			return fmt.Errorf("%s に %s を足せません: %w", c.table, c.name, err)
		}
	}
	// 3. 作り直し。新しい定義の目印が無いときだけ
	for _, r := range []struct {
		table, marker string
		steps         []string
		done          string
	}{
		{"t_guardian_child", "'3'", rebuildGuardianChildSteps, "紐づけに「猶予中」を足しました（表を作り直して中身を移した）"},
		{"m_terms", "covers_external_ai", rebuildTermsSteps, "規約の版の一意を文書の種類ごとにしました（表を作り直して中身を移した）"},
		{"t_operation_log", "operator_type", rebuildOperationLogSteps, "操作ログに連絡帳・設定・AI の下書きを足しました（表を作り直して中身を移した）"},
	} {
		var ddl string
		if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, r.table).Scan(&ddl); err != nil {
			return fmt.Errorf("%s を確かめられません: %w", r.table, err)
		}
		if strings.Contains(ddl, r.marker) {
			continue
		}
		if err := rebuildTable(db, r.steps); err != nil {
			return fmt.Errorf("%s を作り直せません: %w", r.table, err)
		}
		log.Print(r.done)
	}
	// 4. 設定の新しいキーを既定値で入れる（基本設計書「設定マスタ」(5-9)。ai.enabled は 0）。seed.sql と同じ値
	for _, st := range contactSettings {
		if _, err := db.Exec(`INSERT OR IGNORE INTO m_setting (setting_key, setting_value, description, updated_staff_id, updated_at)
			VALUES (?, ?, ?, 'S001', '2026-04-01T09:00:00')`, st[0], st[1], st[2]); err != nil {
			return fmt.Errorf("設定 %s を入れられません: %w", st[0], err)
		}
	}
	// 5. m_phrase が空なら初期の行を入れる（詳細設計書「デモデータ」(5-5 (2))。seed.sql と同じ行）
	var phrases int
	if err := db.QueryRow(`SELECT COUNT(*) FROM m_phrase`).Scan(&phrases); err != nil {
		return fmt.Errorf("定型文を確かめられません: %w", err)
	}
	if phrases == 0 {
		order := map[string]int{}
		for _, p := range defaultPhrases {
			order[p[0]]++
			if _, err := db.Exec(`INSERT INTO m_phrase (phrase_scope, body, display_order, updated_staff_id, created_at, updated_at)
				VALUES (?, ?, ?, 'S001', '2026-04-01T09:00:00', '2026-04-01T09:00:00')`, p[0], p[1], order[p[0]]); err != nil {
				return fmt.Errorf("定型文を入れられません: %w", err)
			}
		}
		log.Printf("定型文の初期の行を %d 件入れました", len(defaultPhrases))
	}
	return nil
}

/*
defaultPhrases は、定型文の初期の行（使う場所・文）。seed.sql の m_phrase と mockDb.ts の phrases と同じ順・同じ文
（db_contact_test.go の TestDefaultPhrasesMatchSeed が確かめる）。
健康や発達の評価の言葉（「元気に」「順調に」など）を入れない（詳細設計書「デモデータ」(5-5 (2))、原則1）
*/
var defaultPhrases = [][2]string{
	{"1", "今日も一日ありがとうございました。"},
	{"1", "お迎えのときに、くわしくお話しします。"},
	{"1", "おうちでも、今日のことを聞いてみてください。"},
	{"1", "明日もよろしくお願いします。"},
	{"2", "園庭で遊びました。"},
	{"2", "絵本を読みました。"},
	{"2", "手洗いを自分でしようとしていました。"},
	{"3", "今日は園庭で遊びました。"},
	{"3", "今日はお散歩に出かけました。"},
	{"3", "今日は室内で製作をしました。"},
	{"4", "よく食べ、おかわりをしていました。"},
	{"4", "午睡は落ち着いて入眠できました。"},
	{"4", "園庭で友だちと関わって遊ぶ姿が見られました。"},
	{"4", "鼻水が出ていたため、こまめに拭き取りました。"},
	{"4", "ご家庭でも様子を見ていただけますと幸いです。"},
}

// contactSettings は、連絡帳・通知・AI の設定の既定値（キー・値・説明）。seed.sql と mockDb.ts の settings と同じ
var contactSettings = [][3]string{
	{"contact.show_items", "nap,meal,toilet,temperature,comment,photo,class", "保護者へ出すきょうのようすの項目"},
	{"contact.home_items", "temperature,night_sleep,breakfast,mood,pickup,message", "「家庭から」の入力欄に出す項目"},
	{"contact.toilet_choices", "おしっこ,うんち,おむつ交換,トイレでできた", "排せつの選択肢"},
	{"contact.mood_choices", "ごきげん,ふつう,ごきげんななめ", "「家庭から」のきげんの選択肢"},
	{"push.quiet_hours", "21:00-07:00", "通知を送らない時間帯"},
	{"ai.enabled", "0", "文章の下書き（AI）を使うか"},
	{"ai.daily_limit", "300", "AI の下書きの1日の上限回数"},
	{"scope.guardian_grace_days", "30", "保護者の猶予期間（日）"},
	{"nap.temperature_required", "入眠時", "午睡で体温を求める時点"},
	{"growth.share_physical", "1", "身体測定を成長の記録に出すか"},
	{"retention.contact_years", "5", "連絡帳の保持年数（要決定。決まるまでは記録の保持年数と同じ）"},
}

/*
rebuildTable は、SQLite の「表の作り直し」の手順で表を作り直す（既存の rebuildChatMessage と同じ）。
外部キーの検査を止め、1つのトランザクションで新しい表へ中身を移して入れ替える。
*/
func rebuildTable(db *sql.DB, steps []string) error {
	if _, err := db.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
		return err
	}
	defer db.Exec(`PRAGMA foreign_keys = ON`)
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range steps {
		if _, err := tx.Exec(q); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// 紐づけ（t_guardian_child）。link_status に 3:猶予中 を足し、猶予の終わり・AI を断ったか・連絡の順を足す
var rebuildGuardianChildSteps = []string{
	`CREATE TABLE t_guardian_child_new (
	  guardian_id  TEXT NOT NULL REFERENCES m_guardian(guardian_id),
	  child_id     TEXT NOT NULL REFERENCES m_child(child_id),
	  relationship TEXT,
	  link_status  TEXT NOT NULL CHECK (link_status IN ('1','2','3')),  -- 1:有効 2:終了 3:猶予中
	  linked_at    TEXT NOT NULL,
	  ended_at     TEXT,
	  grace_ends_on TEXT,
	  ai_opt_out INTEGER NOT NULL DEFAULT 0,
	  contact_order INTEGER NOT NULL DEFAULT 1,
	  PRIMARY KEY (guardian_id, child_id)
	)`,
	`INSERT INTO t_guardian_child_new (guardian_id, child_id, relationship, link_status, linked_at, ended_at)
	 SELECT guardian_id, child_id, relationship, link_status, linked_at, ended_at FROM t_guardian_child`,
	`DROP TABLE t_guardian_child`,
	`ALTER TABLE t_guardian_child_new RENAME TO t_guardian_child`,
}

// 規約（m_terms）。版の一意を（版・文書の種類）に改め、外部の AI へ送ることを書いた版かを足す。
// t_terms_agreement は名前で指すため、作り直しのあとも保たれる
var rebuildTermsSteps = []string{
	`CREATE TABLE m_terms_new (
	  terms_id      INTEGER PRIMARY KEY AUTOINCREMENT,
	  terms_version TEXT    NOT NULL,
	  document_type TEXT    NOT NULL CHECK (document_type IN ('1','2')),  -- 1:利用規約 2:プライバシーポリシー
	  body          TEXT    NOT NULL,
	  published_on  TEXT    NOT NULL,
	  covers_external_ai INTEGER NOT NULL DEFAULT 0,
	  UNIQUE (terms_version, document_type)
	)`,
	`INSERT INTO m_terms_new (terms_id, terms_version, document_type, body, published_on)
	 SELECT terms_id, terms_version, document_type, body, published_on FROM m_terms`,
	`DROP TABLE m_terms`,
	`ALTER TABLE m_terms_new RENAME TO m_terms`,
}

// 操作ログ（t_operation_log）。機能 8:連絡帳 9:設定、操作 6:AI の下書き、操作した者の種別を足し、account_id の NOT NULL を外す
var rebuildOperationLogSteps = []string{
	`CREATE TABLE t_operation_log_new (
	  operation_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
	  account_id       INTEGER REFERENCES m_account(account_id),
	  operated_at      TEXT    NOT NULL,
	  function_type    TEXT    NOT NULL CHECK (function_type IN ('1','2','3','4','5','6','7','8','9')),
	  operation_type   TEXT    NOT NULL CHECK (operation_type IN ('1','2','3','4','5','6')),
	  target_table     TEXT    NOT NULL,
	  target_id        INTEGER,
	  target_child_id  TEXT,
	  before_value     TEXT,
	  after_value      TEXT,
	  operator_type    TEXT NOT NULL DEFAULT '1' CHECK (operator_type IN ('1','2')),
	  CHECK (operator_type = '2' OR account_id IS NOT NULL)
	)`,
	`INSERT INTO t_operation_log_new (operation_log_id, account_id, operated_at, function_type, operation_type,
	   target_table, target_id, target_child_id, before_value, after_value)
	 SELECT operation_log_id, account_id, operated_at, function_type, operation_type,
	        target_table, target_id, target_child_id, before_value, after_value FROM t_operation_log`,
	`DROP TABLE t_operation_log`,
	`ALTER TABLE t_operation_log_new RENAME TO t_operation_log`,
	`CREATE INDEX IF NOT EXISTS ix_operation_log_at    ON t_operation_log (operated_at)`,
	`CREATE INDEX IF NOT EXISTS ix_operation_log_child ON t_operation_log (target_child_id, operated_at)`,
}

/*
trimFutureDemoContacts は、デモデータの今日のページで、起動した時刻より後の連絡帳の記録を入れない
（詳細設計書「未来の出来事を入れない」(5-5)、決めたこと D-8）。朝に起動すると、まだ起きていない給食や
おひるねが保護者の画面に出て、デモが事実と食い違うため。新規作成のときに、日付をずらしたあとで呼ぶ。
既存の午睡の実施と5分ごとの確認にはかけない（既存のテストが前提にしているため）。
モックは web/src/api/mockDb.ts の trimFutureDemoContacts が同じ規則で外す。
*/
func trimFutureDemoContacts(db *sql.DB) error {
	day, at := today(), now()
	for _, q := range []string{
		`DELETE FROM t_contact_event    WHERE contact_date = ? AND recorded_at > ?`,
		`DELETE FROM t_contact_class    WHERE contact_date = ? AND recorded_at > ?`,
		`DELETE FROM t_contact_facility WHERE contact_date = ? AND recorded_at > ?`,
		`DELETE FROM t_contact_home     WHERE contact_date = ? AND submitted_at > ?`,
		`UPDATE t_contact_home SET confirmed_at = NULL, confirmed_staff_id = NULL WHERE substr(confirmed_at, 1, 10) = ? AND confirmed_at > ?`,
		`UPDATE t_contact_home SET revised_at = NULL WHERE substr(revised_at, 1, 10) = ? AND revised_at > ?`,
		`DELETE FROM t_nap_sleep        WHERE substr(slept_at, 1, 10) = ? AND slept_at > ?`,
		`UPDATE t_nap_sleep SET woke_at = NULL, woke_staff_id = NULL WHERE substr(woke_at, 1, 10) = ? AND woke_at > ?`,
		`DELETE FROM t_nap_exclusion    WHERE substr(created_at, 1, 10) = ? AND created_at > ?`,
	} {
		if _, err := db.Exec(q, day, at); err != nil {
			return fmt.Errorf("デモデータの未来の記録を外せません: %w", err)
		}
	}
	return nil
}
