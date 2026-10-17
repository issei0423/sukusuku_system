package main

import (
	"database/sql"
	"fmt"
	"log"
	"time"
)

/*
 * デモデータの日付を、起動した日に合わせてずらす
 *
 * デモデータは「今日＝2026-09-01」として作ってある。実施中の午睡、今日の日誌、
 * 直近のチャットといった記録が、この日を基準に組み立てられている。
 * そのまま日が経つと「実施中の午睡が今日のものではない」状態になり、
 * 画面が実施中として描画されなくなる（GitHub Issue #66）。
 *
 * 日付をひとつずつ相対で書き直すのではなく、基準日と起動日の差だけ
 * まとめてずらす。記録どうしの前後関係（昨日・3日前）がそのまま保たれるため。
 *
 * ずらすのは記録テーブル（t_）の日付・日時の列だけである。
 * 園児の生年月日や年度の開始日は絶対の日付であり、動かしてはならない。
 * それらはマスタ（m_）にあるため、対象から自然に外れる。
 * ただし一時パスワードの有効期限（m_account.temp_password_expires_at）は、デモの「今日」から
 * 決めた日時なので、明示的に対象へ入れる（seedShiftMasterColumns）。
 * ただし t_invitation_code.birth_date は記録テーブルにある生年月日なので、
 * 明示的に除外する。
 *
 * 新規作成のときにだけ実行する。すでにあるデータベースへ毎回かけると、
 * 利用者が入力した記録まで動いてしまう。基準を取り直したいときは
 * データベースのファイルを消して作り直す（MOCKUP.md）。
 */

// デモデータが「今日」として作られている日
const seedBaseDate = "2026-09-01"

// ずらしの対象から外す列。テーブル名.列名 で指定する
var seedShiftExcluded = map[string]bool{
	// 園児の生年月日。招待コードの照合に使う値であり、動かすと本人確認が通らなくなる
	"t_invitation_code.birth_date": true,
}

func shiftSeedDates(db *sql.DB) error {
	base, err := time.ParseInLocation("2006-01-02", seedBaseDate, jst)
	if err != nil {
		return fmt.Errorf("基準日を解釈できません: %w", err)
	}
	t := nowTime()
	todayJST := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, jst)

	offset := int(todayJST.Sub(base).Hours() / 24)
	if offset == 0 {
		return nil
	}

	tables, err := recordTables(db)
	if err != nil {
		return err
	}

	shifted := 0
	for _, table := range tables {
		cols, err := dateColumns(db, table)
		if err != nil {
			return err
		}
		for _, col := range cols {
			/*
			 * 日付だけの列と日時の列が混ざっている。長さで見分ける。
			 * SQLite の datetime() は 'YYYY-MM-DD HH:MM:SS' を返すため、
			 * 区切りを 'T' へ戻して元の書式に揃える。
			 */
			q := fmt.Sprintf(`UPDATE %s SET %s = CASE
				WHEN %s IS NULL THEN NULL
				WHEN length(%s) = 10 THEN date(%s, ?)
				ELSE replace(datetime(%s, ?), ' ', 'T')
			END`, table, col, col, col, col, col)
			days := fmt.Sprintf("%+d days", offset)
			if _, err := db.Exec(q, days, days); err != nil {
				return fmt.Errorf("%s.%s の日付をずらせませんでした: %w", table, col, err)
			}
			shifted++
		}
	}

	// 記録テーブルの外にあって、ずらす必要のある列
	for _, tc := range seedShiftMasterColumns {
		q := fmt.Sprintf(`UPDATE %s SET %s = replace(datetime(%s, ?), ' ', 'T') WHERE %s IS NOT NULL`,
			tc.table, tc.column, tc.column, tc.column)
		if _, err := db.Exec(q, fmt.Sprintf("%+d days", offset)); err != nil {
			return fmt.Errorf("%s.%s の日付をずらせませんでした: %w", tc.table, tc.column, err)
		}
		shifted++
	}

	log.Printf("デモデータの日付を %+d 日ずらしました（基準 %s → 起動日 %s、%d 列）",
		offset, seedBaseDate, todayJST.Format("2006-01-02"), shifted)
	return nil
}

// recordTables は記録テーブル（t_ で始まるもの）の名前を返す
func recordTables(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`SELECT name FROM sqlite_master
		WHERE type = 'table' AND name LIKE 't\_%' ESCAPE '\' ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("テーブルの一覧を取得できません: %w", err)
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// dateColumns は日付・日時を持つ列（_date か _at で終わるもの）の名前を返す
func dateColumns(db *sql.DB, table string) ([]string, error) {
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return nil, fmt.Errorf("%s の列を取得できません: %w", table, err)
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var (
			cid        int
			name, typ  string
			notNull    int
			defaultVal sql.NullString
			pk         int
		)
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultVal, &pk); err != nil {
			return nil, err
		}
		if !hasDateSuffix(name) && !seedShiftIncluded[table+"."+name] {
			continue
		}
		if seedShiftExcluded[table+"."+name] {
			continue
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// 名前が _date / _at で終わらないが、ずらす必要のある列。テーブル名.列名 で指定する
var seedShiftIncluded = map[string]bool{
	// 招待コードの有効期限。発行日（created_at）だけがずれると、発行日より前に期限が来て、
	// デモデータのコードがすべて期限切れになる（GitHub Issue #129）
	"t_invitation_code.expires_on": true,
}

/*
seedShiftMasterColumns は、マスタ（m_）にあるが、デモデータの「今日」に合わせて決めた日時の列。

ずらしの対象は記録テーブル（t_）だけだが、一時パスワードの有効期限は「今日から 48 時間」として入れてある。
ずらさないと、デモの 宮城 蓮 は起動した日によって期限切れになり、一時パスワードでのログインを見せられない
（GitHub Issue #159。有効期限をログインで確かめるようにしたため）。日時（YYYY-MM-DDTHH:MM:SS）の列に限る
*/
var seedShiftMasterColumns = []struct{ table, column string }{
	{"m_account", "temp_password_expires_at"},
}

func hasDateSuffix(name string) bool {
	for _, s := range []string{"_date", "_at"} {
		if len(name) >= len(s) && name[len(name)-len(s):] == s {
			return true
		}
	}
	return false
}
