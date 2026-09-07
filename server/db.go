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
	return db, nil
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
