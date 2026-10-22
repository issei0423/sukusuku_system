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
 * ずらすのは記録テーブル（t_）の日付・日時の列だけである（名前が _date・_at・_on で終わる列）。
 * 日付だけの列（_on。発達チェックの予定日・実施日、身体測定の測定日など）も対象にする。
 * 外すと、作成日時だけがずれて予定日・実施日・測定日が基準日のまま残り、前後関係が崩れる
 * （GitHub Issue #164。モックの web/src/api/mockDb.ts は日付の形の値をすべてずらしている）。
 * 年度の開始日などの絶対の日付は、動かしてはならない。それらはマスタ（m_）にあるため、対象から自然に外れる。
 * ただしマスタにあっても、デモの「今日」から決めた値は明示的に対象へ入れる（seedShiftMasterColumns）。
 * 一時パスワードの有効期限（m_account.temp_password_expires_at）と、園児の生年月日（m_child.birth_date）である。
 * 生年月日をずらさないと、実施日・測定日だけが動いて記録の時点の月齢が変わり、デモの発達チェックが
 * 別の発達過程区分になって「未入力」が出る（GitHub Issue #164）。
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
	offset, err := daysFromSeedBase()
	if err != nil {
		return err
	}
	if offset == 0 {
		return nil
	}
	return shiftDatesBy(db, offset)
}

// daysFromSeedBase は、基準日から起動日（JST の今日）までの日数を返す
func daysFromSeedBase() (int, error) {
	base, err := time.ParseInLocation("2006-01-02", seedBaseDate, jst)
	if err != nil {
		return 0, fmt.Errorf("基準日を解釈できません: %w", err)
	}
	t := nowTime()
	todayJST := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, jst)
	return int(todayJST.Sub(base).Hours() / 24), nil
}

/*
seedShiftDetourDays は、日付をずらすときにいったん逃がす先までの日数（約270年）。

一意制約のある日付の列（t_physical_record の child_id + measured_on、t_development_check の child_id + checked_on）を
一度に offset 日ずらすと、書き換えた行の値が、まだ書き換えていない行の値と重なって止まることがある。
SQLite は一意制約を1行ずつ確かめるためである（例：91 日おきの身体測定を 91 日ずらす日）。
いったんデモデータの日付の幅より遠い先へ逃がしてから戻すことで、途中で重ならないようにする。
*/
const seedShiftDetourDays = 100000

// shiftDatesBy は、記録テーブルの日付・日時の列を offset 日ずらす
func shiftDatesBy(db *sql.DB, offset int) error {
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
			for _, step := range []int{seedShiftDetourDays, offset - seedShiftDetourDays} {
				days := fmt.Sprintf("%+d days", step)
				if _, err := db.Exec(q, days, days); err != nil {
					return fmt.Errorf("%s.%s の日付をずらせませんでした: %w", table, col, err)
				}
			}
			shifted++
		}
	}

	// 記録テーブルの外にあって、ずらす必要のある列。日付だけの列（生年月日）と日時の列を、上と同じく長さで見分ける。
	// どれも一意制約が無いので、逃がさずに一度でずらす
	for _, tc := range seedShiftMasterColumns {
		q := fmt.Sprintf(`UPDATE %s SET %s = CASE
				WHEN length(%s) = 10 THEN date(%s, ?)
				ELSE replace(datetime(%s, ?), ' ', 'T')
			END WHERE %s IS NOT NULL`,
			tc.table, tc.column, tc.column, tc.column, tc.column, tc.column)
		days := fmt.Sprintf("%+d days", offset)
		if _, err := db.Exec(q, days, days); err != nil {
			return fmt.Errorf("%s.%s の日付をずらせませんでした: %w", tc.table, tc.column, err)
		}
		shifted++
	}

	log.Printf("デモデータの日付を %+d 日ずらしました（基準 %s → 起動日 %s、%d 列）",
		offset, seedBaseDate, addDays(seedBaseDate, offset), shifted)
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

// dateColumns は日付・日時を持つ列（_date・_at・_on で終わるもの）の名前を返す
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

// 名前が _date / _at / _on で終わらないが、ずらす必要のある列。テーブル名.列名 で指定する
var seedShiftIncluded = map[string]bool{
	// 招待コードの有効期限。発行日（created_at）だけがずれると、発行日より前に期限が来て、
	// デモデータのコードがすべて期限切れになる（GitHub Issue #129）。
	// いまは _on で終わる列として対象に入るが、漏れの経緯を残すために書いておく
	"t_invitation_code.expires_on": true,
}

/*
seedShiftMasterColumns は、マスタ（m_）にあるが、デモデータの「今日」に合わせて決めた日時の列。

ずらしの対象は記録テーブル（t_）だけだが、一時パスワードの有効期限は「今日から 48 時間」として入れてある。
ずらさないと、デモの 宮城 蓮 は起動した日によって期限切れになり、一時パスワードでのログインを見せられない
（GitHub Issue #159。有効期限をログインで確かめるようにしたため）。

園児の生年月日も、デモの「今日」に何か月の子かを決めて入れてある。記録と同じ日数だけずらし、
起動した日にもデモの園児の月齢（今日の時点・実施日の時点・測定日の時点）を保つ（GitHub Issue #164。
モックの web/src/api/mockDb.ts も同じ）。日付をずらすので、月末生まれ（小林 結衣）は起動した日によって月末でなくなる
*/
var seedShiftMasterColumns = []struct{ table, column string }{
	{"m_account", "temp_password_expires_at"},
	{"m_child", "birth_date"},
}

func hasDateSuffix(name string) bool {
	for _, s := range []string{"_date", "_at", "_on"} {
		if len(name) >= len(s) && name[len(name)-len(s):] == s {
			return true
		}
	}
	return false
}

/*
capFutureDemoDiaryTimes は、起動した日の日誌（t_diary）の時刻のうち、起動した時刻より後のものを起動した時刻に丸める
（GitHub Issue #139）。デモデータの日誌は「今日の夕方（16:40〜17:20）に書いて申請した」として作ってあるため、
朝に起動すると、承認待ちの一覧にまだ来ていない時刻の申請が並ぶ。

【仮置き】設計に無い決めごとである（web/仮置き値.md）。連絡帳の記録は未来のものを外すが
（db_contact.go の trimFutureDemoContacts、決めたこと D-8）、日誌は外さずに丸める。
外すと、承認待ちの一覧をデモで見せられなくなるため。差し戻しの時刻は updated_at に入る。
作成・更新の時刻も同じく丸め、作成 ≦ 申請 ≦ 承認・差し戻しの順を保つ（どの列も同じ時刻を上限にするので、順は崩れない）。
新規作成のときに、日付をずらしたあとで呼ぶ。外すときは、この関数と db.go の呼び出しを消す。
モックは web/src/api/mockDb.ts の capFutureDemoDiaryTimes が同じ規則で丸める。
*/
func capFutureDemoDiaryTimes(db *sql.DB, day, at string) error {
	for _, col := range []string{"created_at", "applied_at", "approved_at", "updated_at"} {
		q := fmt.Sprintf(`UPDATE t_diary SET %s = ? WHERE substr(%s, 1, 10) = ? AND %s > ?`, col, col, col)
		if _, err := db.Exec(q, at, day, at); err != nil {
			return fmt.Errorf("デモデータの日誌の時刻を丸められません: %w", err)
		}
	}
	return nil
}
