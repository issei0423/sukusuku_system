package main

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

/*
 * CSV一括登録・年度更新（管理者のみ）
 * 典拠：基本設計書.md「CSV一括登録」(4-4)・「年度更新」(4-4)
 */

var csvHeader = []string{"園児ID", "氏名", "氏名かな", "生年月日", "性別", "クラス名", "平熱"}
var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// CsvRow は1行ぶんの取込内容と判定
type CsvRow struct {
	Line   int      `json:"line"`
	Values []string `json:"values"`
	Error  *string  `json:"error"`
}

// parseChildCsv は取込内容を検証する。取り込む前に全行を検証して返す。
func (a *app) parseChildCsv(text string) ([]string, []CsvRow) {
	lines := []string{}
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) > 0 && strings.Contains(lines[0], "園児ID") {
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

		switch {
		case len(values) < 6:
			row.Error = s("列が足りません（園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱）")
		case values[0] == "":
			row.Error = s("園児IDが空です")
		case seen[values[0]]:
			row.Error = s("同じ園児IDがこのファイル内で重複しています")
		case a.childExists(values[0]):
			row.Error = s("その園児IDはすでに登録されています")
		case values[1] == "":
			row.Error = s("氏名が空です")
		case !dateRe.MatchString(values[3]):
			row.Error = s("生年月日は YYYY-MM-DD で入力してください")
		case values[3] > today():
			row.Error = s("生年月日に未来日は指定できません")
		case values[4] != "1" && values[4] != "2" && values[4] != "9":
			row.Error = s("性別は 1:男 2:女 9:未回答 で入力してください")
		case !a.classExists(values[5]):
			row.Error = s("クラス名が見つかりません")
		}
		if row.Error == nil {
			seen[values[0]] = true
		}
		rows = append(rows, row)
	}
	return csvHeader, rows
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
	header, rows := a.parseChildCsv(req.Text)
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
	_, rows := a.parseChildCsv(req.Text)
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

実行は用意していない。進級先クラスの割り当て規則と卒園の判定条件が未確定であり、
未確定のまま実行できるようにすると誤った割り当てが全機能へ波及するため
（基本設計書「年度更新」(4-4)）。
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
		"note":           "進級先クラスの割り当て規則と、卒園の判定条件が未確定のため、本モックでは実行できません",
	})
}
