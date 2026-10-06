package main

import (
	"database/sql"
	_ "embed"
	"fmt"
	"log"
	"os"

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
		log.Printf("デモデータを投入しました")
	}
	if err := ensureTermsAgreement(db); err != nil {
		return nil, err
	}
	if err := ensureDesignColumns(db); err != nil {
		return nil, err
	}
	return db, nil
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
// ここで生成する値は仮置きである。実装時は厚生労働省の乳幼児身体発育調査の公表値を
// 投入する（web/仮置き値.md）。source_version に「仮置き（未投入）」を入れてあり、
// 公表値を入れたら差し替わる。
var (
	heightMedian = map[string][]float64{
		"1": {49.0, 74.9, 86.7, 95.1, 102.0, 108.2, 114.9},
		"2": {48.5, 73.3, 85.4, 93.9, 100.9, 107.3, 113.7},
	}
	weightMedian = map[string][]float64{
		"1": {3.0, 9.3, 11.9, 14.1, 16.2, 18.4, 21.0},
		"2": {2.9, 8.7, 11.3, 13.6, 15.7, 17.9, 20.2},
	}
	percentiles = []int{3, 10, 25, 50, 75, 90, 97}
	heightRatio = map[int]float64{3: 0.930, 10: 0.955, 25: 0.978, 50: 1.0, 75: 1.022, 90: 1.045, 97: 1.070}
	weightRatio = map[int]float64{3: 0.820, 10: 0.880, 25: 0.940, 50: 1.0, 75: 1.070, 90: 1.150, 97: 1.240}
)

// 0/12/24/36/48/60/72 か月の値を線形に補間する
func interpolate(anchors []float64, month int) float64 {
	i := month / 12
	if i > len(anchors)-2 {
		i = len(anchors) - 2
	}
	t := float64(month-i*12) / 12
	return anchors[i] + (anchors[i+1]-anchors[i])*t
}

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

	for _, sex := range []string{"1", "2"} {
		for m := 0; m <= 72; m++ {
			for _, p := range percentiles {
				h := round2(interpolate(heightMedian[sex], m) * heightRatio[p])
				w := round2(interpolate(weightMedian[sex], m) * weightRatio[p])
				if _, err := stmt.Exec(sex, m, "1", p, h, "仮置き（未投入）"); err != nil {
					return err
				}
				if _, err := stmt.Exec(sex, m, "2", p, w, "仮置き（未投入）"); err != nil {
					return err
				}
			}
		}
	}
	return tx.Commit()
}

func round2(v float64) float64 {
	return float64(int(v*100+0.5)) / 100
}
