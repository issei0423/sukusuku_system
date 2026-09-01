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

func (a *app) handleGetChild(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canSeeChild(u, childID) {
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
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canSeeChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	writeJSON(w, http.StatusOK, a.allergiesOf(childID))
}

func (a *app) handleMedicalHistoriesOf(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
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
	rows, err := a.db.Query(`SELECT `+childColumns+`,
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

	type entry struct {
		Child     Child     `json:"child"`
		ClassName string    `json:"className"`
		Allergies []Allergy `json:"allergies"`
	}
	out := []entry{}
	for rows.Next() {
		var (
			c    Child
			temp sql.NullFloat64
			cls  string
		)
		if err := rows.Scan(&c.ChildID, &c.ChildName, &c.ChildNameKana, &c.BirthDate, &c.Sex,
			&temp, &c.EnrollmentStatus, &c.PhotoConsentLevel, &c.IsDeleted, &c.CreatedAt, &c.UpdatedAt, &cls); err != nil {
			continue
		}
		c.NormalTemperature = nullFloat(temp)
		out = append(out, entry{Child: c, ClassName: cls})
	}
	// アレルギーの取得はカーソルを閉じたあとに行う。
	// データベースの接続を1本に絞っているため、行を読みながら別の問い合わせを投げると止まる（db.go）
	rows.Close()
	for i := range out {
		out[i].Allergies = a.allergiesOf(out[i].Child.ChildID)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) handleClassOfChild(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireUser(w, r); !ok {
		return
	}
	var id sql.NullInt64
	a.db.QueryRow(`SELECT cc.class_id FROM t_class_child cc
	                JOIN m_class c ON c.class_id = cc.class_id AND c.fiscal_year = ?
	               WHERE cc.child_id = ?`, fiscalYear, r.PathValue("childID")).Scan(&id)
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
