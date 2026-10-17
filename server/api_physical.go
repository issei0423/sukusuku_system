package main

import (
	"database/sql"
	"net/http"
	"strconv"
)

/*
 * 身体測定
 * 典拠：基本設計書.md「身体測定の記録」(4-8)・「身体測定記録」(5-7)
 *      図/画面詳細図.md「身体記録画面」(6-2)
 *
 * システムは発育の判定・診断を行わない。
 */

// PhysicalRecord は身体測定記録（t_physical_record）
type PhysicalRecord struct {
	PhysicalRecordID int64   `json:"physical_record_id"`
	ChildID          string  `json:"child_id"`
	MeasuredOn       string  `json:"measured_on"`
	HeightCm         float64 `json:"height_cm"`
	WeightKg         float64 `json:"weight_kg"`
	// 初回登録者。更新時に書き換えない（基本設計書 5-7）
	StaffID     string `json:"staff_id"`
	ShareStatus string `json:"share_status"`
	IsDeleted   bool   `json:"is_deleted"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

// GrowthStandard は成長曲線基準値（m_growth_standard）
type GrowthStandard struct {
	GrowthStandardID int64   `json:"growth_standard_id"`
	Sex              string  `json:"sex"`
	AgeInMonths      int     `json:"age_in_months"`
	MeasureType      string  `json:"measure_type"`
	Percentile       int     `json:"percentile"`
	StandardValue    float64 `json:"standard_value"`
	SourceVersion    string  `json:"source_version"`
}

// handlePhysicalClassStatus はクラスの実施状況を返す。
// 未実施の園児名を出す。誰が残っているかを数えさせないため（画面詳細図 6-2）。
func (a *app) handlePhysicalClassStatus(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	classID, _ := queryInt64(r, "class_id")
	measuredOn := r.URL.Query().Get("measured_on")
	if measuredOn == "" {
		measuredOn = today()
	}

	children, err := a.visibleChildren(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "園児を取得できませんでした")
		return
	}
	inClass := map[string]bool{}
	rows, err := a.db.Query(`SELECT child_id FROM t_class_child WHERE class_id = ?`, classID)
	if err == nil {
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				inClass[id] = true
			}
		}
		rows.Close()
	}
	done := map[string]bool{}
	rows2, err := a.db.Query(`SELECT child_id FROM t_physical_record
		WHERE is_deleted = 0 AND measured_on = ?`, measuredOn)
	if err == nil {
		for rows2.Next() {
			var id string
			if rows2.Scan(&id) == nil {
				done[id] = true
			}
		}
		rows2.Close()
	}

	target, doneList, pending := []Child{}, []Child{}, []Child{}
	for _, c := range children {
		if !inClass[c.ChildID] {
			continue
		}
		target = append(target, c)
		if done[c.ChildID] {
			doneList = append(doneList, c)
		} else {
			pending = append(pending, c)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"target": target, "done": doneList, "pending": pending,
	})
}

func (a *app) handlePhysicalRecords(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canSeeChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	// 保護者に見せるのは、共有した（連携済の）測定値だけ。未連携・対象外の測定値は園内に留める
	// （基本設計書「権限と利用可能機能」(6-1)「成長グラフの閲覧｜保護者 ※3」「※3 自児のみ、かつ共有されたものに限る」、
	// 「身体測定記録」(5-7) share_status＝0:対象外 1:未連携 2:連携済。GitHub Issue #157）。
	// 画面側のモック（web/src/api/mock.ts の recordsOf）と同じ規則
	shared := ""
	if u.isGuardian() {
		shared = ` AND share_status = '2'`
	}
	rows, err := a.db.Query(`SELECT physical_record_id, child_id, measured_on, height_cm, weight_kg,
		staff_id, share_status, is_deleted, created_at, updated_at
		FROM t_physical_record WHERE is_deleted = 0 AND child_id = ?`+shared+`
		ORDER BY measured_on DESC`, childID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "測定値を取得できませんでした")
		return
	}
	defer rows.Close()
	out := []PhysicalRecord{}
	for rows.Next() {
		var x PhysicalRecord
		if rows.Scan(&x.PhysicalRecordID, &x.ChildID, &x.MeasuredOn, &x.HeightCm, &x.WeightKg,
			&x.StaffID, &x.ShareStatus, &x.IsDeleted, &x.CreatedAt, &x.UpdatedAt) == nil {
			out = append(out, x)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleGrowthBand は成長曲線の帯を返す。
// 性別が未回答の園児には基準値を持たないため null を返す（基本設計書 5-7）。
func (a *app) handleGrowthBand(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireUser(w, r); !ok {
		return
	}
	sex := r.URL.Query().Get("sex")
	measureType := r.URL.Query().Get("measure_type")
	if sex == "9" || sex == "" {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	rows, err := a.db.Query(`SELECT growth_standard_id, sex, age_in_months, measure_type,
		percentile, standard_value, source_version
		FROM m_growth_standard WHERE sex = ? AND measure_type = ?
		ORDER BY age_in_months, percentile`, sex, measureType)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "基準値を取得できませんでした")
		return
	}
	defer rows.Close()
	out := []GrowthStandard{}
	for rows.Next() {
		var x GrowthStandard
		if rows.Scan(&x.GrowthStandardID, &x.Sex, &x.AgeInMonths, &x.MeasureType,
			&x.Percentile, &x.StandardValue, &x.SourceVersion) == nil {
			out = append(out, x)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handleRangeWarning は範囲チェックの結果を返す。
// しきい値は設定マスタから読む。返すのは注意喚起であって、登録の可否ではない（基本設計書 5-8）。
func (a *app) handleRangeWarning(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	height, _ := strconv.ParseFloat(r.URL.Query().Get("height_cm"), 64)
	weight, _ := strconv.ParseFloat(r.URL.Query().Get("weight_kg"), 64)
	writeJSON(w, http.StatusOK, map[string]any{"warning": a.rangeWarning(height, weight)})
}

func (a *app) rangeWarning(heightCm, weightKg float64) *string {
	hMin := float64(a.settingInt("physical.height_min", 40))
	hMax := float64(a.settingInt("physical.height_max", 140))
	wMin := float64(a.settingInt("physical.weight_min", 2))
	wMax := float64(a.settingInt("physical.weight_max", 40))

	msgs := []string{}
	if heightCm > 0 && (heightCm < hMin || heightCm > hMax) {
		msgs = append(msgs, "身長が想定の範囲（"+
			strconv.FormatFloat(hMin, 'f', -1, 64)+"〜"+strconv.FormatFloat(hMax, 'f', -1, 64)+"cm）の外です")
	}
	if weightKg > 0 && (weightKg < wMin || weightKg > wMax) {
		msgs = append(msgs, "体重が想定の範囲（"+
			strconv.FormatFloat(wMin, 'f', -1, 64)+"〜"+strconv.FormatFloat(wMax, 'f', -1, 64)+"kg）の外です")
	}
	if len(msgs) == 0 {
		return nil
	}
	out := msgs[0]
	for _, m := range msgs[1:] {
		out += "。" + m
	}
	out += "。入力をお確かめください"
	return &out
}

var _ = sql.ErrNoRows

/*
handleSavePhysical は測定値を登録・修正する。

確認画面を挟まず連続して入力できる（画面詳細図 6-2）。
範囲外の値は注意喚起を返すが、登録自体は妨げない。判定ではないため。
一意制約は child_id + measured_on を is_deleted = 0 の行のみ対象とする（基本設計書 5-7）。
*/
func (a *app) handleSavePhysical(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var req struct {
		ChildID    string  `json:"child_id"`
		MeasuredOn string  `json:"measured_on"`
		HeightCm   float64 `json:"height_cm"`
		WeightKg   float64 `json:"weight_kg"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !a.canSeeChild(u, req.ChildID) {
		writeForbidden(w, "この園児を記録する権限がありません")
		return
	}
	if req.MeasuredOn == "" || req.MeasuredOn > today() {
		writeErr(w, http.StatusBadRequest, "測定日に未来日は指定できません")
		return
	}
	if req.HeightCm <= 0 || req.WeightKg <= 0 {
		writeErr(w, http.StatusBadRequest, "身長と体重を入力してください")
		return
	}

	var (
		id     int64
		height float64
		weight float64
	)
	err := a.db.QueryRow(`SELECT physical_record_id, height_cm, weight_kg FROM t_physical_record
		WHERE is_deleted = 0 AND child_id = ? AND measured_on = ?`, req.ChildID, req.MeasuredOn).
		Scan(&id, &height, &weight)

	if err == nil {
		// staff_id は初回登録者。更新時に書き換えない（基本設計書 5-7）
		if _, e := a.db.Exec(`UPDATE t_physical_record SET height_cm = ?, weight_kg = ?, updated_at = ?
			WHERE physical_record_id = ?`, req.HeightCm, req.WeightKg, now(), id); e != nil {
			writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
			return
		}
		a.log(u.AccountID, fnPhysical, opUpdate, "t_physical_record", i64(id), s(req.ChildID),
			s("身長="+strconv.FormatFloat(height, 'f', -1, 64)+" 体重="+strconv.FormatFloat(weight, 'f', -1, 64)),
			s("身長="+strconv.FormatFloat(req.HeightCm, 'f', -1, 64)+" 体重="+strconv.FormatFloat(req.WeightKg, 'f', -1, 64)))
	} else {
		res, e := a.db.Exec(`INSERT INTO t_physical_record
			(child_id, measured_on, height_cm, weight_kg, staff_id, share_status, is_deleted, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, '1', 0, ?, ?)`,
			req.ChildID, req.MeasuredOn, req.HeightCm, req.WeightKg, u.staff(), now(), now())
		if e != nil {
			writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
			return
		}
		id, _ = res.LastInsertId()
		a.log(u.AccountID, fnPhysical, opCreate, "t_physical_record", i64(id), s(req.ChildID), nil,
			s("身長="+strconv.FormatFloat(req.HeightCm, 'f', -1, 64)+" 体重="+strconv.FormatFloat(req.WeightKg, 'f', -1, 64)))
	}

	var out PhysicalRecord
	a.db.QueryRow(`SELECT physical_record_id, child_id, measured_on, height_cm, weight_kg,
		staff_id, share_status, is_deleted, created_at, updated_at
		FROM t_physical_record WHERE physical_record_id = ?`, id).
		Scan(&out.PhysicalRecordID, &out.ChildID, &out.MeasuredOn, &out.HeightCm, &out.WeightKg,
			&out.StaffID, &out.ShareStatus, &out.IsDeleted, &out.CreatedAt, &out.UpdatedAt)
	writeJSON(w, http.StatusOK, out)
}

// handleRemovePhysical は測定値を論理削除する。
// 削除した測定日には登録し直せる（部分一意インデックス。基本設計書 5-7）。
func (a *app) handleRemovePhysical(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "記録の指定が正しくありません")
		return
	}
	var (
		childID string
		height  float64
		weight  float64
	)
	if err := a.db.QueryRow(`SELECT child_id, height_cm, weight_kg FROM t_physical_record
		WHERE physical_record_id = ?`, id).Scan(&childID, &height, &weight); err != nil {
		writeErr(w, http.StatusNotFound, "記録が見つかりません")
		return
	}
	if _, err := a.db.Exec(`UPDATE t_physical_record SET is_deleted = 1, updated_at = ?
		WHERE physical_record_id = ?`, now(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "削除に失敗しました")
		return
	}
	a.log(u.AccountID, fnPhysical, opDelete, "t_physical_record", i64(id), s(childID),
		s("身長="+strconv.FormatFloat(height, 'f', -1, 64)+" 体重="+strconv.FormatFloat(weight, 'f', -1, 64)),
		s("削除"))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleExportPdf は出力の操作を記録する。
// 出力種別に既定値を置かず毎回選ばせる。持ち出しの経緯を後から追えるようにするため（画面詳細図 6-2）。
func (a *app) handleExportPdf(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		ChildID string `json:"child_id"`
		Purpose string `json:"purpose"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	label := "保護者引き渡し"
	if req.Purpose == "internal" {
		label = "園内利用"
	}
	a.log(u.AccountID, fnPhysical, opExport, "t_physical_record", nil, s(req.ChildID), nil,
		s("PDF出力（"+label+"）"))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
