package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"
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
	if !isISODate(measuredOn) {
		writeErr(w, http.StatusBadRequest, "測定日の形式が正しくありません")
		return
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
	/*
	 * 入力済みは、選んだ測定日と同じ年月に未削除の記録があるかで見る。測定日が数日ずれても同じ回として扱う
	 * （基本設計書「身体測定の記録」(4-8)「選択中の測定日と同一の年月に登録済みの園児には入力済みマークを付す」・
	 * 「測定回の単位は年月とする」、ナレッジ/決定事項.md 2026-08-04。GitHub Issue #47・#165）。
	 * 画面側のモック（web/src/api/mock.ts の classStatus）と同じ規則
	 */
	monthFirst, monthLast := monthRange(measuredOn)
	done := map[string]bool{}
	rows2, err := a.db.Query(`SELECT child_id FROM t_physical_record
		WHERE is_deleted = 0 AND measured_on BETWEEN ? AND ?`, monthFirst, monthLast)
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
	// 保護者は 403。保護者は成長の記録（GET /api/children/{childID}/growth）で、共有する測定値だけを読む
	// （詳細設計書「身体測定・共有範囲の経路」(4-12 (4))。図/インタフェース一覧の対象権限「管理者・一般」に合わせる）。
	// 画面側のモック（web/src/api/mock.ts の recordsOf）と同じ規則
	if u.isGuardian() {
		writeForbidden(w, msgGrowthForbidden)
		return
	}
	if !a.canReadChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	rows, err := a.db.Query(`SELECT physical_record_id, child_id, measured_on, height_cm, weight_kg,
		staff_id, share_status, is_deleted, created_at, updated_at
		FROM t_physical_record WHERE is_deleted = 0 AND child_id = ?
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

// monthRange は 'YYYY-MM-DD' の日付が属する月の初日と末日を返す。測定回（年月）の範囲を引くために使う。
// 日付は isISODate で確かめてから渡す
func monthRange(date string) (first, last string) {
	t, err := time.ParseInLocation("2006-01-02", date, jst)
	if err != nil {
		return date, date
	}
	f := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, jst)
	return f.Format("2006-01-02"), f.AddDate(0, 1, -1).Format("2006-01-02")
}

// monthLabel は 'YYYY-MM-DD' を「2026年10月」の形にする
func monthLabel(date string) string {
	t, err := time.ParseInLocation("2006-01-02", date, jst)
	if err != nil {
		return date
	}
	return strconv.Itoa(t.Year()) + "年" + strconv.Itoa(int(t.Month())) + "月"
}

/*
handleSavePhysical は測定値を登録・修正する。

確認画面を挟まず連続して入力できる（画面詳細図 6-2）。
範囲外の値は注意喚起を返すが、登録自体は妨げない。判定ではないため。
一意制約は child_id + measured_on を is_deleted = 0 の行のみ対象とする（基本設計書 5-7）。

登録済みの記録を黙って書き換えない。同一園児・同一測定日に未削除の記録があれば、上書きの承諾（confirm_overwrite）が
あるときだけ書き換える（基本設計書「身体測定の記録」(4-8)「上書き確認を表示する」）。
【仮置き】承諾をサーバでも確かめる。画面で確かめたあとにほかの職員が同じ日を登録した場合も、
確かめずに書き換えないようにするため（web/仮置き値.md）。

【仮置き】同じ年月の別の測定日に記録があるときは、同じ回の 2 件目になる。同じ月の別の記録としての承諾
（confirm_same_month）があるときだけ登録する。設計は同じ回の 2 件目の扱いを定めていない（web/仮置き値.md、GitHub Issue #165）。
承諾は確認の種類ごとに受け付け、一方の承諾で他方を通さない（同 (4-8)「確認の種類ごとに、対応する承諾だけを受け付ける」）。
画面側のモック（web/src/api/mock.ts の save）と同じ規則
*/
func (a *app) handleSavePhysical(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var req struct {
		ChildID          string  `json:"child_id"`
		MeasuredOn       string  `json:"measured_on"`
		HeightCm         float64 `json:"height_cm"`
		WeightKg         float64 `json:"weight_kg"`
		ConfirmOverwrite bool    `json:"confirm_overwrite"`
		ConfirmSameMonth bool    `json:"confirm_same_month"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !a.canSeeChild(u, req.ChildID) {
		writeForbidden(w, "この園児を記録する権限がありません")
		return
	}
	// 文言は基本設計書「メッセージ一覧」(4-9) の「測定日の欠落」「測定日の形式不正」による。
	// 崩れた測定日を保存すると、年月で数える実施状況や月齢の計算が狂う
	if req.MeasuredOn == "" {
		writeErr(w, http.StatusBadRequest, "測定日は必須項目です")
		return
	}
	if !isISODate(req.MeasuredOn) {
		writeErr(w, http.StatusBadRequest, "測定日の形式が正しくありません")
		return
	}
	if req.MeasuredOn > today() {
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

	if err == nil && !req.ConfirmOverwrite {
		writeErr(w, http.StatusConflict, "この測定日の記録は登録済みです。内容を確かめ、上書きするときはもう一度「登録する」を押してください")
		return
	}
	if err != nil && !req.ConfirmSameMonth {
		monthFirst, monthLast := monthRange(req.MeasuredOn)
		var other string
		if a.db.QueryRow(`SELECT measured_on FROM t_physical_record
			WHERE is_deleted = 0 AND child_id = ? AND measured_on BETWEEN ? AND ?
			ORDER BY measured_on DESC LIMIT 1`, req.ChildID, monthFirst, monthLast).Scan(&other) == nil {
			writeErr(w, http.StatusConflict, monthLabel(req.MeasuredOn)+"の記録は登録済みです（測定日 "+
				strings.ReplaceAll(other, "-", "/")+"）。内容を確かめ、別の記録として登録するときはもう一度「登録する」を押してください")
			return
		}
	}

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
	// その園児を参照できる職員へ知らせる。保護者へは、共有した（連携済の）測定値が変わったときだけ（events.go）
	a.notifyPhysical(req.ChildID, a.sharePhysical())
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
		share   string
	)
	if err := a.db.QueryRow(`SELECT child_id, height_cm, weight_kg, share_status FROM t_physical_record
		WHERE physical_record_id = ?`, id).Scan(&childID, &height, &weight, &share); err != nil {
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
	a.notifyPhysical(childID, a.sharePhysical())
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
