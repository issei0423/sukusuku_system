package main

import (
	"database/sql"
	_ "embed"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

//go:embed seed.sql
var seedSQL string

// openDB はデータベースを開き、無ければスキーマを作成してデモデータを投入する。
//
// ドライバは modernc.org/sqlite（純 Go）を使う。cgo を必要とする mattn/go-sqlite3 は
// gcc の無い環境でビルドできないため（server/README.md）。
func openDB(path string) (*sql.DB, error) {
	_, statErr := os.Stat(path)
	fresh := os.IsNotExist(statErr)

	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("データベースを開けません: %w", err)
	}
	// SQLite は書き込みを直列化する。接続を1本に絞って書き込みの競合を避ける
	db.SetMaxOpenConns(1)

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("データベースへ接続できません: %w", err)
	}

	if fresh {
		log.Printf("データベースを新規作成します: %s", path)
		if _, err := db.Exec(schemaSQL); err != nil {
			return nil, fmt.Errorf("スキーマの作成に失敗しました: %w", err)
		}
		if _, err := db.Exec(seedSQL); err != nil {
			return nil, fmt.Errorf("デモデータの投入に失敗しました: %w", err)
		}
		if err := seedGrowthStandards(db); err != nil {
			return nil, fmt.Errorf("成長曲線基準値の投入に失敗しました: %w", err)
		}
		// デモデータは「今日＝2026-09-01」で作ってある。起動日に合わせてずらす（seed_shift.go）
		if err := shiftSeedDates(db); err != nil {
			return nil, err
		}
		if err := trimFutureDemoContacts(db); err != nil {
			return nil, err
		}
		log.Printf("デモデータを投入しました")
	}
	if err := upgradeGrowthStandards(db); err != nil {
		return nil, fmt.Errorf("成長曲線基準値の入れ替えに失敗しました: %w", err)
	}
	if err := ensureTermsAgreement(db); err != nil {
		return nil, err
	}
	if err := ensureDesignColumns(db); err != nil {
		return nil, err
	}
	if err := ensureHandouts(db); err != nil {
		return nil, err
	}
	if err := ensurePersonalRoomChild(db); err != nil {
		return nil, err
	}
	if err := ensureNapAbnormalRecordedAt(db); err != nil {
		return nil, err
	}
	if err := ensureContactSchema(db); err != nil {
		return nil, err
	}
	return db, nil
}

// 発見時刻と保存時刻を分ける（図/画面詳細図「異常時記録画面」(5-2)）。
func ensureNapAbnormalRecordedAt(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('t_nap_abnormal') WHERE name = 'recorded_at'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := db.Exec(`ALTER TABLE t_nap_abnormal ADD COLUMN recorded_at TEXT`); err != nil {
			return err
		}
	}
	_, err := db.Exec(`UPDATE t_nap_abnormal SET recorded_at = found_at WHERE recorded_at IS NULL`)
	return err
}

/*
ensurePersonalRoomChild は、個人チャットと園児を結ぶ列（m_chat_room.child_id）を、以前に作られた
データベースへ足す（GitHub Issue #163）。

個人チャットのルームは園児単位で作る（基本設計書「チャット」(5-5)）。以前は部屋の名前（園児名＋「の保護者」）で
探していたため、同じ氏名の別の園児がいると、その家庭の個人チャットに入ってしまった。

列を足すときに一度だけ、次を行う。

  - 名前から園児を引いて埋める。同じ氏名の園児が2人以上いる部屋は、どちらの部屋か決められないため空のままにし、
    ログに残す（その部屋には新しい保護者が入らない）
  - 保護者の参加のうち、その部屋の園児と有効な紐づけが無いものに left_at を入れる。名前で探していたときに
    別の家庭の個人チャットへ入った保護者を外すため。保護者は left_at が入った時点で参照できなくなる（5-5）

新規作成のときは schema.sql と seed.sql がすでに持っているため、何も変わらない。
*/
func ensurePersonalRoomChild(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('m_chat_room') WHERE name = 'child_id'`).
		Scan(&n); err != nil {
		return fmt.Errorf("チャットルームの列を確かめられません: %w", err)
	}
	if n == 0 {
		if _, err := db.Exec(`ALTER TABLE m_chat_room ADD COLUMN child_id TEXT REFERENCES m_child(child_id)`); err != nil {
			return fmt.Errorf("チャットルームに園児の列を足せません: %w", err)
		}
		if _, err := db.Exec(`UPDATE m_chat_room SET child_id = (
				SELECT c.child_id FROM m_child c WHERE c.child_name || 'の保護者' = m_chat_room.room_name)
			 WHERE room_type = '4' AND child_id IS NULL
			   AND (SELECT COUNT(*) FROM m_child c WHERE c.child_name || 'の保護者' = m_chat_room.room_name) = 1
			   AND (SELECT COUNT(*) FROM m_chat_room x
			         WHERE x.room_type = '4' AND x.room_name = m_chat_room.room_name) = 1`); err != nil {
			return fmt.Errorf("個人チャットの園児を埋められません: %w", err)
		}
		res, err := db.Exec(`UPDATE t_chat_member SET left_at = ?
			 WHERE left_at IS NULL
			   AND account_id IN (SELECT account_id FROM m_account WHERE role = '3')
			   AND chat_room_id IN (SELECT chat_room_id FROM m_chat_room WHERE room_type = '4')
			   AND NOT EXISTS (
			     SELECT 1 FROM m_chat_room r
			       JOIN t_guardian_child gc ON gc.child_id = r.child_id AND gc.link_status = '1'
			       JOIN m_guardian g ON g.guardian_id = gc.guardian_id
			      WHERE r.chat_room_id = t_chat_member.chat_room_id AND g.account_id = t_chat_member.account_id)`,
			now())
		if err != nil {
			return fmt.Errorf("個人チャットの参加者を確かめられません: %w", err)
		}
		left, _ := res.RowsAffected()
		var unresolved int
		db.QueryRow(`SELECT COUNT(*) FROM m_chat_room WHERE room_type = '4' AND child_id IS NULL`).Scan(&unresolved)
		log.Printf("個人チャットに園児の列（child_id）を足しました。園児を決められなかった部屋 %d、外した保護者の参加 %d",
			unresolved, left)
	}
	if _, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_room_child
		ON m_chat_room (child_id) WHERE room_type = '4'`); err != nil {
		return fmt.Errorf("個人チャットの一意制約を作れません: %w", err)
	}
	return nil
}

/*
ensureHandouts は配布物（t_handout）まわりを用意する。

  - 表が無ければ作る
  - チャットのメッセージの種別に「4:配布物の掲載」を足す。SQLite は CHECK 制約をあとから
    変えられないため、古い定義のときは表を作り直して中身を移す
  - 1件も無ければデモデータを入れる。対象の月は起動した日から決める（今月と先月）。
    固定の月で持つと、日が経ったときに「今月の献立表」が今月のものでなくなるため

以前に作られたデータベースでも、ファイルを消さずに使い続けられるようにするため、起動のたびに確かめる。
*/
func ensureHandouts(db *sql.DB) error {
	if _, err := db.Exec(handoutDDL); err != nil {
		return fmt.Errorf("配布物の表を作れません: %w", err)
	}
	db.Exec(`CREATE INDEX IF NOT EXISTS ix_handout_month ON t_handout (target_month, posted_at)`)
	db.Exec(`INSERT OR IGNORE INTO m_setting (setting_key, setting_value, description, updated_staff_id, updated_at)
		VALUES ('handout.allowed_types', 'application/pdf,image/jpeg,image/png', '配布物の対応形式', 'S001', '2026-04-01T09:00:00')`)

	var ddl string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 't_chat_message'`).Scan(&ddl); err != nil {
		return fmt.Errorf("メッセージの表を確かめられません: %w", err)
	}
	if !strings.Contains(ddl, "'4'") {
		if err := rebuildChatMessage(db); err != nil {
			return err
		}
		log.Printf("メッセージの種別に「配布物の掲載」を足しました（表を作り直して中身を移した）")
	}

	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM t_handout`).Scan(&n); err != nil {
		return fmt.Errorf("配布物を確かめられません: %w", err)
	}
	if n > 0 {
		return nil
	}
	return seedHandouts(db)
}

const handoutDDL = `CREATE TABLE IF NOT EXISTS t_handout (
  handout_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  handout_type     TEXT    NOT NULL CHECK (handout_type IN ('1','2','3','4','5')),  -- 1:園だより 2:献立表 3:行事のお知らせ 4:クラスだより 5:その他
  title            TEXT    NOT NULL,
  target_month     TEXT    NOT NULL,                                               -- 対象の月 'YYYY-MM'
  class_id         INTEGER REFERENCES m_class(class_id),                           -- 空なら園全体
  file_name        TEXT    NOT NULL,
  file_path        TEXT    NOT NULL,
  file_type        TEXT    NOT NULL,
  file_size        INTEGER NOT NULL,
  posted_staff_id  TEXT    NOT NULL REFERENCES m_staff(staff_id),
  posted_at        TEXT    NOT NULL,
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT,
  deleted_staff_id TEXT    REFERENCES m_staff(staff_id)
)`

// rebuildChatMessage は t_chat_message を新しい CHECK 制約で作り直す。
// 外部キーの検査を止めた状態で、同じ名前の表へ中身を移す。
func rebuildChatMessage(db *sql.DB) error {
	if _, err := db.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
		return err
	}
	defer db.Exec(`PRAGMA foreign_keys = ON`)

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	steps := []string{
		`CREATE TABLE t_chat_message_new (
		  chat_message_id    INTEGER PRIMARY KEY AUTOINCREMENT,
		  chat_room_id       INTEGER NOT NULL REFERENCES m_chat_room(chat_room_id),
		  sender_account_id  INTEGER NOT NULL REFERENCES m_account(account_id),
		  body               TEXT    NOT NULL,
		  source_type        TEXT    NOT NULL CHECK (source_type IN ('1','2','3','4')),
		  source_id          INTEGER,
		  sent_at            TEXT    NOT NULL,
		  edited_at          TEXT,
		  is_deleted         INTEGER NOT NULL DEFAULT 0,
		  deleted_at         TEXT,
		  deleted_account_id INTEGER REFERENCES m_account(account_id)
		)`,
		`INSERT INTO t_chat_message_new
		   (chat_message_id, chat_room_id, sender_account_id, body, source_type, source_id,
		    sent_at, edited_at, is_deleted, deleted_at, deleted_account_id)
		 SELECT chat_message_id, chat_room_id, sender_account_id, body, source_type, source_id,
		        sent_at, edited_at, is_deleted, deleted_at, deleted_account_id
		   FROM t_chat_message`,
		`DROP TABLE t_chat_message`,
		`ALTER TABLE t_chat_message_new RENAME TO t_chat_message`,
		`CREATE INDEX IF NOT EXISTS ix_chat_message_room ON t_chat_message (chat_room_id, sent_at)`,
	}
	for _, q := range steps {
		if _, err := tx.Exec(q); err != nil {
			return fmt.Errorf("メッセージの表を作り直せません: %w", err)
		}
	}
	return tx.Commit()
}

// seedHandouts は配布物のデモデータを入れる。対象の月は今月と先月にする
func seedHandouts(db *sql.DB) error {
	t := nowTime()
	this := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, jst)
	prev := this.AddDate(0, -1, 0)
	month := func(d time.Time) string { return d.Format("2006-01") }
	label := func(d time.Time) string { return fmt.Sprintf("%d月", int(d.Month())) }
	at := func(d time.Time, day int) string { return d.AddDate(0, 0, day-1).Format("2006-01-02") + "T16:30:00" }

	var sakura sql.NullInt64
	db.QueryRow(`SELECT class_id FROM m_class WHERE fiscal_year = ? AND class_name = 'さくら組'`, fiscalYear).Scan(&sakura)

	type row struct {
		typ, title, month string
		classID           any
		name, mime        string
		size              int
		at                string
	}
	rows := []row{
		{"1", label(prev) + "の園だより", month(prev), nil, "endayori-" + month(prev) + ".pdf", "application/pdf", 512340, at(prev, 1)},
		{"2", label(prev) + "の献立表", month(prev), nil, "kondate-" + month(prev) + ".pdf", "application/pdf", 238100, at(prev, 1)},
		{"1", label(this) + "の園だより", month(this), nil, "endayori-" + month(this) + ".pdf", "application/pdf", 498200, at(this, 1)},
		{"2", label(this) + "の献立表", month(this), nil, "kondate-" + month(this) + ".pdf", "application/pdf", 241870, at(this, 1)},
		{"3", "運動会のご案内", month(this), nil, "undokai.pdf", "application/pdf", 301455, at(this, 2)},
	}
	if sakura.Valid {
		rows = append(rows, row{"4", "さくら組 " + label(this) + "のクラスだより", month(this), sakura.Int64,
			"sakura-" + month(this) + ".png", "image/png", 1204880, at(this, 3)})
	}
	for _, x := range rows {
		if _, err := db.Exec(`INSERT INTO t_handout
			(handout_type, title, target_month, class_id, file_name, file_path, file_type, file_size,
			 posted_staff_id, posted_at, is_deleted)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'S001', ?, 0)`,
			x.typ, x.title, x.month, x.classID, x.name, "handouts/"+x.name, x.mime, x.size, x.at); err != nil {
			return fmt.Errorf("配布物のデモデータを入れられません: %w", err)
		}
	}
	return nil
}

/*
ensureDesignColumns は、基本設計書 第2.3版で足した列と設定を、以前に作られたデータベースへ足す。

- クラスの年齢児（m_class.age_class）。デモデータのクラスには名前から年齢児を入れる
- 園の名称と電話番号（m_setting の facility.name / facility.phone_number）

新規作成のときは schema.sql と seed.sql がすでに持っているため、何も変わらない。
*/
func ensureDesignColumns(db *sql.DB) error {
	rows, err := db.Query(`PRAGMA table_info(m_class)`)
	if err != nil {
		return fmt.Errorf("クラスの列を確かめられません: %w", err)
	}
	hasAgeClass := false
	for rows.Next() {
		var (
			cid        int
			name, typ  string
			notNull    int
			defaultVal sql.NullString
			pk         int
		)
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultVal, &pk); err != nil {
			rows.Close()
			return err
		}
		if name == "age_class" {
			hasAgeClass = true
		}
	}
	rows.Close()
	if !hasAgeClass {
		if _, err := db.Exec(`ALTER TABLE m_class
			ADD COLUMN age_class INTEGER NOT NULL DEFAULT 2 CHECK (age_class BETWEEN 0 AND 5)`); err != nil {
			return fmt.Errorf("クラスに年齢児の列を足せません: %w", err)
		}
		db.Exec(`UPDATE m_class SET age_class = 0 WHERE class_name = 'もも組'`)
		db.Exec(`UPDATE m_class SET age_class = 1 WHERE class_name = 'さくら組'`)
		log.Printf("クラスに年齢児の列（age_class）を足しました")
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO m_setting
		(setting_key, setting_value, description, updated_staff_id, updated_at) VALUES
		('facility.name', 'すくすく保育園', '園の名称', 'S001', '2026-04-01T09:00:00'),
		('facility.phone_number', '03-0000-0000', '園の電話番号（保護者向けの緊急連絡の案内に出す）', 'S001', '2026-04-01T09:00:00')`); err != nil {
		return fmt.Errorf("園の基本情報を用意できません: %w", err)
	}
	return nil
}

/*
ensureTermsAgreement は同意履歴（t_terms_agreement）を用意する。

テーブルが無ければ作り、1行も無ければ、アカウントが持つ「同意した版と日時」から起こす
（基本設計書「同意履歴（t_terms_agreement）」(5-2)）。この表を足す前に作られた
データベースでも、ファイルを消さずに使い続けられるようにするため、起動のたびに確かめる。
定義は schema.sql と同じにしてある。
*/
func ensureTermsAgreement(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS t_terms_agreement (
		terms_agreement_id INTEGER PRIMARY KEY AUTOINCREMENT,
		account_id         INTEGER NOT NULL REFERENCES m_account(account_id),
		terms_id           INTEGER NOT NULL REFERENCES m_terms(terms_id),
		agreed_at          TEXT    NOT NULL
	)`); err != nil {
		return fmt.Errorf("同意履歴の表を作れません: %w", err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM t_terms_agreement`).Scan(&n); err != nil {
		return fmt.Errorf("同意履歴を確かめられません: %w", err)
	}
	if n > 0 {
		return nil
	}
	res, err := db.Exec(`INSERT INTO t_terms_agreement (account_id, terms_id, agreed_at)
		SELECT a.account_id, t.terms_id, a.terms_agreed_at
		  FROM m_account a
		  JOIN m_terms t ON t.terms_version = a.terms_version AND t.document_type = '1'
		 WHERE a.terms_agreed_at IS NOT NULL
		 ORDER BY a.account_id`)
	if err != nil {
		return fmt.Errorf("同意履歴を起こせません: %w", err)
	}
	if rows, _ := res.RowsAffected(); rows > 0 {
		log.Printf("同意履歴を %d 件起こしました（アカウントの同意した版から）", rows)
	}
	return nil
}

// 成長曲線基準値（m_growth_standard）
//
// 厚生労働省「平成22年乳幼児身体発育調査」の公表値を投入する（GitHub Issue #69）。
// 値と、月齢への当て方は growth_standard_2010.go にある。
// 公表値そのものの月齢と、補間で求めた月齢は、source_version で見分けられる。
func seedGrowthStandards(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`INSERT INTO m_growth_standard
		(sex, age_in_months, measure_type, percentile, standard_value, source_version)
		VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	source := func(interpolated bool) string {
		if interpolated {
			return growthSource2010Interpolated
		}
		return growthSource2010
	}
	for _, sex := range []string{"1", "2"} {
		for m := 0; m <= 72; m++ {
			for pi, p := range growthPercentiles {
				// 公表値は、身長が小数第1位、体重が小数第2位まで
				h, hi := growthValue2010(heightClasses2010, sex, m, pi)
				w, wi := growthValue2010(weightClasses2010, sex, m, pi)
				if _, err := stmt.Exec(sex, m, "1", p, roundTo(h, 1), source(hi)); err != nil {
					return err
				}
				if _, err := stmt.Exec(sex, m, "2", p, roundTo(w, 2), source(wi)); err != nil {
					return err
				}
			}
		}
	}
	return tx.Commit()
}

// upgradeGrowthStandards は、以前に作ったデータベースに残る仮の値を、公表値へ入れ替える。
// 基準値はマスタであり、利用者が入力した記録ではないため、起動のたびに確かめて入れ替えてよい。
func upgradeGrowthStandards(db *sql.DB) error {
	var provisional int
	if err := db.QueryRow(`SELECT COUNT(*) FROM m_growth_standard WHERE source_version LIKE '仮置き%'`).
		Scan(&provisional); err != nil {
		return err
	}
	if provisional == 0 {
		return nil
	}
	if _, err := db.Exec(`DELETE FROM m_growth_standard`); err != nil {
		return err
	}
	if err := seedGrowthStandards(db); err != nil {
		return err
	}
	log.Printf("成長曲線基準値を、仮の値から厚生労働省の公表値へ入れ替えました")
	return nil
}

// roundTo は小数第 digits 位に丸める
func roundTo(v float64, digits int) float64 {
	scale := 1.0
	for i := 0; i < digits; i++ {
		scale *= 10
	}
	return float64(int64(v*scale+0.5)) / scale
}

func round2(v float64) float64 {
	return float64(int(v*100+0.5)) / 100
}
