package main

import (
	"database/sql"
	"net/http"
	"strings"
)

/*
 * 共通基盤：園児マスターの管理
 * 典拠：基本設計書.md「共通基盤：園児マスターの管理」(4-4)、図/画面詳細図.md「園児一覧画面」(7-1)
 */

// Allergy はアレルギー（m_allergy）。要配慮個人情報として扱う
type Allergy struct {
	AllergyID  int64  `json:"allergy_id"`
	ChildID    string `json:"child_id"`
	TargetFood string `json:"target_food"`
	Symptom    string `json:"symptom"`
	Response   string `json:"response"`
}

type MedicalHistory struct {
	MedicalHistoryID int64  `json:"medical_history_id"`
	ChildID          string `json:"child_id"`
	Content          string `json:"content"`
}

func (a *app) handleListChildren(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	rows, err := a.visibleChildren(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "園児の一覧を取得できませんでした")
		return
	}
	// 管理者だけ、退園・卒園した園児も出せる。一覧の下にまとめる（図/画面詳細図 (7-1) 項目11。GitHub Issue #279）
	if u.isAdmin() && r.URL.Query().Get("include_withdrawn") == "1" {
		left, err := a.db.Query(`SELECT ` + childColumns + ` FROM m_child
			WHERE is_deleted = 0 AND enrollment_status <> '1' ORDER BY child_name_kana`)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "園児の一覧を取得できませんでした")
			return
		}
		for left.Next() {
			if c, err := scanChild(left); err == nil {
				rows = append(rows, c)
			}
		}
		left.Close()
	}
	if classID, has := queryInt64(r, "class_id"); has {
		inClass := map[string]bool{}
		cc, err := a.db.Query(`SELECT child_id FROM t_class_child WHERE class_id = ?`, classID)
		if err == nil {
			for cc.Next() {
				var id string
				if cc.Scan(&id) == nil {
					inClass[id] = true
				}
			}
			cc.Close()
		}
		filtered := rows[:0:0]
		for _, c := range rows {
			if inClass[c.ChildID] {
				filtered = append(filtered, c)
			}
		}
		rows = filtered
	}
	if q := strings.TrimSpace(r.URL.Query().Get("name")); q != "" {
		filtered := rows[:0:0]
		for _, c := range rows {
			if strings.Contains(c.ChildName, q) || strings.Contains(c.ChildNameKana, q) {
				filtered = append(filtered, c)
			}
		}
		rows = filtered
	}
	writeJSON(w, http.StatusOK, rows)
}

// handleRemovableChildren は、いま取り消せる園児（記録も保護者も紐づいていない園児）の ID を返す。管理者だけ。
// 園児一覧の「取消」を、その行にだけ出すために使う（図/画面詳細図 (7-1) 項目10。GitHub Issue #279）。
// 取り消せるかの最後の判定は handleRemoveChild が行う
func (a *app) handleRemovableChildren(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT child_id FROM m_child WHERE is_deleted = 0 ORDER BY child_id`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "園児を取得できませんでした")
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	out := []string{}
	for _, id := range ids {
		if !a.childHasRecords(id) && !a.childHasGuardian(id) {
			out = append(out, id)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

/*
 * 園児情報・アレルギー・既往歴は、保護者には返さない
 * （基本設計書「権限と利用可能機能」(6-1)「園児情報の参照｜保護者 ×」「既往歴の参照｜保護者 ×」
 * 「アレルギー一覧の参照｜保護者 ×」）。保護者の画面はどれも使っていない。
 * 自児であっても、平熱・写真の利用同意の段階・既往歴は園内で扱う情報である（GitHub Issue #157）。
 * 画面側のモック（web/src/api/mock.ts の getChild・allergiesOf・medicalHistoriesOf）と同じ規則
 */

func (a *app) handleGetChild(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canReadChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	row := a.db.QueryRow(`SELECT `+childColumns+` FROM m_child WHERE child_id = ?`, childID)
	c, err := scanChild(row)
	if err != nil {
		writeErr(w, http.StatusNotFound, "園児が見つかりません")
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *app) allergiesOf(childID string) []Allergy {
	rows, err := a.db.Query(`SELECT allergy_id, child_id, target_food, IFNULL(symptom,''), IFNULL(response,'')
	                           FROM m_allergy WHERE child_id = ? ORDER BY allergy_id`, childID)
	if err != nil {
		return []Allergy{}
	}
	defer rows.Close()
	out := []Allergy{}
	for rows.Next() {
		var x Allergy
		if rows.Scan(&x.AllergyID, &x.ChildID, &x.TargetFood, &x.Symptom, &x.Response) == nil {
			out = append(out, x)
		}
	}
	return out
}

func (a *app) handleAllergiesOf(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canReadChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	writeJSON(w, http.StatusOK, a.allergiesOf(childID))
}

func (a *app) handleMedicalHistoriesOf(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canSeeChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	rows, err := a.db.Query(`SELECT medical_history_id, child_id, content
	                           FROM m_medical_history WHERE child_id = ? ORDER BY medical_history_id`, childID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "既往歴を取得できませんでした")
		return
	}
	defer rows.Close()
	out := []MedicalHistory{}
	for rows.Next() {
		var x MedicalHistory
		if rows.Scan(&x.MedicalHistoryID, &x.ChildID, &x.Content) == nil {
			out = append(out, x)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleAllAllergies はアレルギー一覧画面のためのデータを返す。
//
// 全園児が対象。担当するクラスに関係なく返す。
// 誤食は担任以外が配膳する場面でも起こるため（基本設計書「画面の一覧」(3-2)）。
func (a *app) handleAllAllergies(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	// 【仮置き】並びは園児のよみ順（web/仮置き値.md「一覧の並び順」）。モック（web/src/api/mock.ts の allAllergies）も
	// 同じ並びにした（GitHub Issue #177 の 7）
	// 一覧が使うのは クラス・氏名・対象・症状・対応 だけ。生年月日・平熱・写真の利用同意などは返さない
	// （図/画面詳細図「アレルギー一覧画面」(7-4) 項目3、基本設計書「権限チェックの実装方針」(6-2)。GitHub Issue #279）。
	// 担任でない職員にも全園児を返す例外なので、返す列は必要な分に絞る
	rows, err := a.db.Query(`SELECT child_id, child_name,
		IFNULL((SELECT class_name FROM m_class c
		         JOIN t_class_child cc ON cc.class_id = c.class_id
		        WHERE cc.child_id = m_child.child_id AND c.fiscal_year = ?), '―')
		 FROM m_child
		WHERE is_deleted = 0 AND enrollment_status = '1'
		  AND child_id IN (SELECT child_id FROM m_allergy)
		ORDER BY child_name_kana`, fiscalYear)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "アレルギー一覧を取得できませんでした")
		return
	}
	defer rows.Close()

	type listChild struct {
		ChildID   string `json:"child_id"`
		ChildName string `json:"child_name"`
	}
	type entry struct {
		Child     listChild `json:"child"`
		ClassName string    `json:"className"`
		Allergies []Allergy `json:"allergies"`
	}
	out := []entry{}
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.Child.ChildID, &e.Child.ChildName, &e.ClassName); err != nil {
			continue
		}
		out = append(out, e)
	}
	// アレルギーの取得はカーソルを閉じたあとに行う。
	// データベースの接続を1本に絞っているため、行を読みながら別の問い合わせを投げると止まる（db.go）
	rows.Close()
	for i := range out {
		out[i].Allergies = a.allergiesOf(out[i].Child.ChildID)
	}
	writeJSON(w, http.StatusOK, out)
}

// handleClassOfChild は園児の所属クラスを返す。
// その園児を参照できる人に限る。クラス番号だけでも、園児IDがあるかどうかと所属が分かるため
// （基本設計書「権限チェックの実装方針」(6-2)「園児IDを直接指定した不正な取得を許さない」。GitHub Issue #153）
func (a *app) handleClassOfChild(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canReadChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	var id sql.NullInt64
	a.db.QueryRow(`SELECT cc.class_id FROM t_class_child cc
	                JOIN m_class c ON c.class_id = cc.class_id AND c.fiscal_year = ?
	               WHERE cc.child_id = ?`, fiscalYear, childID).Scan(&id)
	writeJSON(w, http.StatusOK, nullInt(id))
}

func (a *app) handleClasses(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	rows, err := a.selectableClasses(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "クラスを取得できませんでした")
		return
	}
	writeJSON(w, http.StatusOK, rows)
}
