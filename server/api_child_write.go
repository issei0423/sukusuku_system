package main

import (
	"net/http"
	"strings"
)

/*
 * 園児情報の登録・編集・取消
 * 典拠：基本設計書.md「園児情報の登録・編集」(4-4)
 *      図/画面詳細図.md「園児情報入力画面／園児情報確認画面」(7-2)
 *
 * 登録・編集は管理者のみ。一般（保育士）は閲覧のみ。
 */

type childInput struct {
	ChildID           string   `json:"child_id"`
	ChildName         string   `json:"child_name"`
	ChildNameKana     string   `json:"child_name_kana"`
	BirthDate         string   `json:"birth_date"`
	Sex               string   `json:"sex"`
	NormalTemperature *float64 `json:"normal_temperature"`
	PhotoConsentLevel string   `json:"photo_consent_level"`
	ClassID           int64    `json:"class_id"`
	Allergies         []struct {
		TargetFood string `json:"target_food"`
		Symptom    string `json:"symptom"`
		Response   string `json:"response"`
	} `json:"allergies"`
	MedicalHistories []string `json:"medical_histories"`
	// "create" または "edit"
	Mode string `json:"mode"`
}

func (a *app) handleSaveChild(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var in childInput
	if !readJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.ChildID) == "" {
		writeErr(w, http.StatusBadRequest, "園児IDを入力してください")
		return
	}
	if strings.TrimSpace(in.ChildName) == "" {
		writeErr(w, http.StatusBadRequest, "氏名を入力してください")
		return
	}
	// 【仮置き】よみを必須とする。一覧の並びと検索がよみに頼っているため（GitHub Issue #119）
	if strings.TrimSpace(in.ChildNameKana) == "" {
		writeErr(w, http.StatusBadRequest, "よみを入力してください")
		return
	}
	// アレルギーは対象だけでは配膳の場で使えない。症状と対応まで揃えて登録する（GitHub Issue #119）
	for _, al := range in.Allergies {
		if strings.TrimSpace(al.TargetFood) == "" {
			continue
		}
		if strings.TrimSpace(al.Symptom) == "" || strings.TrimSpace(al.Response) == "" {
			writeErr(w, http.StatusBadRequest,
				"アレルギー「"+strings.TrimSpace(al.TargetFood)+"」の症状と対応を入力してください")
			return
		}
	}
	// 生年月日は月齢算出の唯一の根拠。未来日不可（基本設計書 5-3）
	if in.BirthDate == "" || in.BirthDate > today() {
		writeErr(w, http.StatusBadRequest, "生年月日に未来日は指定できません")
		return
	}

	var existing int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_child WHERE child_id = ?`, in.ChildID).Scan(&existing)
	if in.Mode == "create" && existing > 0 {
		writeErr(w, http.StatusBadRequest, "その園児IDはすでに使われています")
		return
	}
	if in.Mode == "edit" && existing == 0 {
		writeErr(w, http.StatusNotFound, "園児が見つかりません")
		return
	}

	var before string
	if existing > 0 {
		var name, birth string
		a.db.QueryRow(`SELECT child_name, birth_date FROM m_child WHERE child_id = ?`, in.ChildID).Scan(&name, &birth)
		before = name + " / " + birth
	}

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}
	defer tx.Rollback()

	if existing > 0 {
		_, err = tx.Exec(`UPDATE m_child SET child_name = ?, child_name_kana = ?, birth_date = ?, sex = ?,
			normal_temperature = ?, photo_consent_level = ?, updated_at = ? WHERE child_id = ?`,
			in.ChildName, in.ChildNameKana, in.BirthDate, in.Sex,
			in.NormalTemperature, in.PhotoConsentLevel, now(), in.ChildID)
	} else {
		_, err = tx.Exec(`INSERT INTO m_child
			(child_id, child_name, child_name_kana, birth_date, sex, normal_temperature,
			 enrollment_status, photo_consent_level, is_deleted, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, '1', ?, 0, ?, ?)`,
			in.ChildID, in.ChildName, in.ChildNameKana, in.BirthDate, in.Sex,
			in.NormalTemperature, in.PhotoConsentLevel, now(), now())
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}

	// クラス在籍の付け替え。当年度ぶんだけを外し、過年度の割り当ては残す（基本設計書 5-3）
	tx.Exec(`DELETE FROM t_class_child WHERE child_id = ?
	          AND class_id IN (SELECT class_id FROM m_class WHERE fiscal_year = ?)`, in.ChildID, fiscalYear)
	if _, err := tx.Exec(`INSERT INTO t_class_child (class_id, child_id) VALUES (?, ?)`, in.ClassID, in.ChildID); err != nil {
		writeErr(w, http.StatusInternalServerError, "クラスの割り当てに失敗しました")
		return
	}

	// アレルギー・既往歴は入力内容で置き換える
	tx.Exec(`DELETE FROM m_allergy WHERE child_id = ?`, in.ChildID)
	for _, al := range in.Allergies {
		if strings.TrimSpace(al.TargetFood) == "" {
			continue
		}
		tx.Exec(`INSERT INTO m_allergy (child_id, target_food, symptom, response) VALUES (?, ?, ?, ?)`,
			in.ChildID, al.TargetFood, al.Symptom, al.Response)
	}
	tx.Exec(`DELETE FROM m_medical_history WHERE child_id = ?`, in.ChildID)
	for _, m := range in.MedicalHistories {
		if strings.TrimSpace(m) == "" {
			continue
		}
		tx.Exec(`INSERT INTO m_medical_history (child_id, content) VALUES (?, ?)`, in.ChildID, m)
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}

	op := opCreate
	var beforePtr *string
	if existing > 0 {
		op = opUpdate
		beforePtr = &before
	}
	a.log(u.AccountID, fnChild, op, "m_child", nil, s(in.ChildID), beforePtr,
		s(in.ChildName+" / "+in.BirthDate))

	row := a.db.QueryRow(`SELECT `+childColumns+` FROM m_child WHERE child_id = ?`, in.ChildID)
	c, _ := scanChild(row)
	writeJSON(w, http.StatusOK, c)
}

// handleChildIDExists は、園児IDがすでに使われているかを返す。
// 入力の時点で重複を知らせるために使う（GitHub Issue #121）。取り消した園児のIDも「使われている」と数える。
func (a *app) handleChildIDExists(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"exists": a.childExists(strings.TrimSpace(r.PathValue("childID")))})
}

// handleRemoveChild は誤登録の取消。論理削除とする（基本設計書 5-1）
func (a *app) handleRemoveChild(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	var name string
	if err := a.db.QueryRow(`SELECT child_name FROM m_child WHERE child_id = ?`, childID).Scan(&name); err != nil {
		writeErr(w, http.StatusNotFound, "園児が見つかりません")
		return
	}
	if _, err := a.db.Exec(`UPDATE m_child SET is_deleted = 1, updated_at = ? WHERE child_id = ?`, now(), childID); err != nil {
		writeErr(w, http.StatusInternalServerError, "取消に失敗しました")
		return
	}
	a.log(u.AccountID, fnChild, opDelete, "m_child", nil, s(childID), s(name), s("取消（論理削除）"))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
