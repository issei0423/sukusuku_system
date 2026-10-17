package main

import (
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

/*
 * CSV一括登録・年度更新（管理者のみ）
 * 典拠：基本設計書.md「CSV一括登録」(4-4)・「年度更新」(4-4)
 */

var csvHeader = []string{"園児ID", "氏名", "氏名かな", "生年月日", "性別", "クラス名", "平熱"}
var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

/*
temperatureRe は、平熱として受け取る書き方。小数第1位までの数（基本設計書「入力項目の制約値」(4-9)
「体温｜30.0〜43.0℃、小数第1位まで」。平熱は体温と同じ）。

平熱が数値でない行は誤りとする（同「CSV一括登録」(4-4)）。strconv.ParseFloat は inf・infinity・nan・
1e2 のような書き方も数として受け取り、+Inf が保存されると、園児を返す API が JSON を書けずに空の本文になって
画面が真っ白になった（GitHub Issue #160）。そのため、数字と小数点だけの書き方に限る。
範囲（30.0〜43.0℃）の外は誤りとせず、確認を促す（同 4-4）。

【仮置き】整数部は3桁までとした。範囲の外でも取り込む設計のため、打ち間違い（365 など）は通して確認を促し、
それより大きな桁は書き方の誤りとして止める（web/仮置き値.md）。画面側（web/src/api/mock.ts）と同じ規則
*/
var temperatureRe = regexp.MustCompile(`^\d{1,3}(\.\d)?$`)

// childIDMaxLength は園児IDの上限（基本設計書「入力項目の制約値」(4-9)「園児ID・職員ID｜20文字以内」）
const childIDMaxLength = 20

// errCsvHeader は、見出しの並びが取込の様式と違うこと。行を読み進めると、別の列の値を園児ID や氏名として
// 取り込んでしまうため、ファイルごと断る（GitHub Issue #160）
var errCsvHeader = errors.New("見出しの並びが取込の様式と違います。1行目を「" +
	strings.Join(csvHeader, ",") + "」の順にしてください（平熱の列は省けます）")

// validBirthDate は、YYYY-MM-DD の形で、実在する日付かを返す（2025-02-30 や 2025-13-45 を通さない）。
// 生年月日は月齢算出の唯一の根拠である（基本設計書 5-3）
func validBirthDate(v string) bool {
	if !dateRe.MatchString(v) {
		return false
	}
	_, err := time.ParseInLocation("2006-01-02", v, jst)
	return err == nil
}

// checkCsvHeader は、見出しの並びが取込の様式と同じかを確かめる。平熱の列は省いてよい。BOM 付きでも読む
func checkCsvHeader(line string) error {
	cols := strings.Split(strings.TrimPrefix(line, string(rune(0xFEFF))), ",")
	if len(cols) < len(csvHeader)-1 || len(cols) > len(csvHeader) {
		return errCsvHeader
	}
	for i, c := range cols {
		if strings.TrimSpace(c) != csvHeader[i] {
			return errCsvHeader
		}
	}
	return nil
}

// CsvRow は1行ぶんの取込内容と判定
type CsvRow struct {
	Line   int      `json:"line"`
	Values []string `json:"values"`
	Error  *string  `json:"error"`
	// 取り込みは妨げないが、確かめてほしいこと。範囲の外の平熱など
	// （基本設計書「入力項目の制約値」(4-9)：範囲のしきい値は判定ではない）
	Warning *string `json:"warning"`
}

// 体温として入力しうる範囲（基本設計書「入力項目の制約値」(4-9)）
const (
	temperatureMin = 30.0
	temperatureMax = 43.0
)

// parseChildCsv は取込内容を検証する。取り込む前に全行を検証して返す。
// 見出しの並びが違うときは、行を読まずに errCsvHeader を返す
func (a *app) parseChildCsv(text string) ([]string, []CsvRow, error) {
	lines := []string{}
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) > 0 && strings.Contains(lines[0], "園児ID") {
		if err := checkCsvHeader(lines[0]); err != nil {
			return csvHeader, nil, err
		}
		lines = lines[1:]
	}

	// 同じ取込の中での重複も弾く。ファイル内で同じ園児IDが2度出ることがある
	seen := map[string]bool{}
	rows := make([]CsvRow, 0, len(lines))

	for i, line := range lines {
		values := strings.Split(line, ",")
		for j := range values {
			values[j] = strings.TrimSpace(values[j])
		}
		row := CsvRow{Line: i + 1, Values: values}

		// 誤りは1行の中でまとめて示す。1つ直すたびに次の誤りが出る作りにしない（GitHub Issue #121）
		errs := []string{}
		if len(values) < 6 {
			errs = append(errs, "列が足りません（園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱）")
		} else {
			switch {
			case values[0] == "":
				errs = append(errs, "園児IDが空です")
			case tooLong(values[0], childIDMaxLength):
				errs = append(errs, "園児IDは20文字以内で入力してください")
			case seen[values[0]]:
				errs = append(errs, "同じ園児IDがこのファイル内で重複しています")
			case a.childExists(values[0]):
				errs = append(errs, "その園児IDはすでに登録されています")
			}
			if values[1] == "" {
				errs = append(errs, "氏名が空です")
			}
			if values[2] == "" {
				errs = append(errs, "氏名かなが空です")
			} else if !isKana(values[2]) {
				errs = append(errs, "氏名かなは、ひらがなで入力してください")
			}
			if tooLong(values[1], 50) || tooLong(values[2], 50) {
				errs = append(errs, "氏名と氏名かなは、それぞれ50文字以内で入力してください")
			}
			switch {
			case !validBirthDate(values[3]):
				errs = append(errs, "生年月日の形式が正しくありません。YYYY-MM-DD の形で、実在する日付を入力してください")
			case values[3] > today():
				errs = append(errs, "生年月日に未来日は指定できません")
			}
			if values[4] != "1" && values[4] != "2" && values[4] != "9" {
				errs = append(errs, "性別は 1:男 2:女 9:未回答 で入力してください")
			}
			if !a.classExists(values[5]) {
				errs = append(errs, "クラス名が見つかりません")
			}
			if len(values) > 6 && values[6] != "" {
				f, e := strconv.ParseFloat(values[6], 64)
				switch {
				case !temperatureRe.MatchString(values[6]) || e != nil:
					errs = append(errs, "平熱は数値（小数第1位まで。例：36.5）で入力してください")
				case f < temperatureMin || f > temperatureMax:
					row.Warning = s("平熱が想定の範囲（30.0〜43.0℃）の外です。値を確かめてください")
				}
			}
		}
		if len(errs) > 0 {
			row.Error = s(strings.Join(errs, "／"))
		}
		if row.Error == nil {
			seen[values[0]] = true
		}
		rows = append(rows, row)
	}
	return csvHeader, rows, nil
}

func (a *app) childExists(childID string) bool {
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_child WHERE child_id = ?`, childID).Scan(&n)
	return n > 0
}

func (a *app) classExists(className string) bool {
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_class WHERE fiscal_year = ? AND class_name = ?`,
		fiscalYear, className).Scan(&n)
	return n > 0
}

func (a *app) handleParseChildCsv(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	var req struct {
		Text string `json:"text"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	header, rows, err := a.parseChildCsv(req.Text)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"header": header, "rows": rows})
}

// handleImportChildCsv はエラー行があるときは1件も取り込まない。
// 中途半端に登録された状態を作らないため。
func (a *app) handleImportChildCsv(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		Text string `json:"text"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	_, rows, err := a.parseChildCsv(req.Text)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, row := range rows {
		if row.Error != nil {
			writeErr(w, http.StatusBadRequest,
				"エラー行があるため取り込めません。すべて解消してから実行してください")
			return
		}
	}
	if len(rows) == 0 {
		writeErr(w, http.StatusBadRequest, "取り込む行がありません")
		return
	}

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "取り込みに失敗しました")
		return
	}
	defer tx.Rollback()

	for _, row := range rows {
		v := row.Values
		var temp any
		if len(v) > 6 && v[6] != "" {
			if f, e := strconv.ParseFloat(v[6], 64); e == nil {
				temp = f
			}
		}
		if _, e := tx.Exec(`INSERT INTO m_child
			(child_id, child_name, child_name_kana, birth_date, sex, normal_temperature,
			 enrollment_status, photo_consent_level, is_deleted, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, '1', '2', 0, ?, ?)`,
			v[0], v[1], v[2], v[3], v[4], temp, now(), now()); e != nil {
			writeErr(w, http.StatusInternalServerError, "取り込みに失敗しました")
			return
		}
		var classID int64
		if e := tx.QueryRow(`SELECT class_id FROM m_class WHERE fiscal_year = ? AND class_name = ?`,
			fiscalYear, v[5]).Scan(&classID); e == nil {
			tx.Exec(`INSERT OR IGNORE INTO t_class_child (class_id, child_id) VALUES (?, ?)`, classID, v[0])
		}
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "取り込みに失敗しました")
		return
	}

	a.log(u.AccountID, fnChild, opCreate, "m_child", nil, nil, nil,
		s("CSV一括登録 "+strconv.Itoa(len(rows))+" 件"))
	writeJSON(w, http.StatusOK, map[string]int{"imported": len(rows)})
}

/*
handlePreviewFiscalYearUpdate は年度更新の内容を一覧で返す。

実行は用意していない。モックアップでは、進級先の割り当てと卒園の処理を実装していないため。
処理の内容は基本設計書「年度更新」(4-4) が定めている。
*/
func (a *app) handlePreviewFiscalYearUpdate(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT class_id, class_name FROM m_class
		WHERE fiscal_year = ? ORDER BY class_id`, fiscalYear)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "クラスを取得できませんでした")
		return
	}
	type classRow struct {
		ClassName  string   `json:"className"`
		ChildCount int      `json:"childCount"`
		StaffNames []string `json:"staffNames"`
		classID    int64
	}
	list := []classRow{}
	for rows.Next() {
		var x classRow
		if rows.Scan(&x.classID, &x.ClassName) == nil {
			x.StaffNames = []string{}
			list = append(list, x)
		}
	}
	rows.Close()

	for i := range list {
		a.db.QueryRow(`SELECT COUNT(*) FROM t_class_child WHERE class_id = ?`, list[i].classID).
			Scan(&list[i].ChildCount)

		sr, err := a.db.Query(`SELECT staff_id FROM t_class_staff WHERE class_id = ?`, list[i].classID)
		if err != nil {
			continue
		}
		ids := []string{}
		for sr.Next() {
			var id string
			if sr.Scan(&id) == nil {
				ids = append(ids, id)
			}
		}
		sr.Close()
		for _, id := range ids {
			list[i].StaffNames = append(list[i].StaffNames, a.staffName(id))
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"nextFiscalYear": fiscalYear + 1,
		"classes":        list,
		"note":           "このモックアップでは、年度更新の実行を実装していません。現在の年度の内訳だけを表示しています",
	})
}
