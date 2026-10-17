package main

import (
	"database/sql"
	"net/http"
	"strings"
)

/*
園からのひとこと・活動のひとことの段2の守り・定型文・宛先（詳細設計書「園からのひとことと他児の名前」(4-5)・
「訂正・取り消し」(4-7)、基本設計書「園からのひとこと」(4-5)・「送る時点の守り」(4-2)）。

段2：送る人が確かめて届く。管理者の事前の承認は置かない。宛先を大きく示し（画面）、他児の名前を照合する（サーバ）。
当たった名前を承諾（acknowledged_names）すれば送れる。確認のダイアログは挟まない（宛先の表示が確認を兼ねる）。
モックは web/src/api/mock.ts の sendFacility・correctFacility・cancelFacility・nameCheck・phrases が同じ規則を持つ。
*/

// contactRecipient は、送る直前に示す宛先（職員の応答だけ。詳細設計書「型」(4-1 (4)) の ContactRecipient）
type contactRecipient struct {
	ChildID       string   `json:"child_id"`
	ChildName     string   `json:"child_name"`
	HasFacePhoto  bool     `json:"has_face_photo"`
	Relationships []string `json:"relationships"`
}

// recipientOf は、その園児の宛先。続柄は有効な紐づけ（1）の保護者だけ。空なら保護者が未登録
func (a *app) recipientOf(childID string) *contactRecipient {
	r := &contactRecipient{ChildID: childID, ChildName: a.childName(childID), Relationships: []string{}}
	var photo sql.NullString
	a.db.QueryRow(`SELECT face_photo_path FROM m_child WHERE child_id = ?`, childID).Scan(&photo)
	r.HasFacePhoto = photo.Valid && photo.String != ""
	rows, err := a.db.Query(`SELECT IFNULL(relationship, '') FROM t_guardian_child
		WHERE child_id = ? AND link_status = '1' ORDER BY contact_order, guardian_id`, childID)
	if err != nil {
		return r
	}
	defer rows.Close()
	for rows.Next() {
		var rel string
		if rows.Scan(&rel) == nil {
			if rel == "" {
				rel = "保護者"
			}
			r.Relationships = append(r.Relationships, rel)
		}
	}
	return r
}

// contactFacilityRow は、訂正・取り消しで使う園からの1行
type contactFacilityRow struct {
	contactFacilityOut
	StaffID string
}

func (a *app) loadFacilityByID(id int64) (*contactFacilityRow, error) {
	var f contactFacilityRow
	err := a.db.QueryRow(`SELECT contact_facility_id, child_id, contact_date, body, staff_id, recorded_at, corrected_at, is_deleted, updated_at
		FROM t_contact_facility WHERE contact_facility_id = ?`, id).
		Scan(&f.ID, &f.ChildID, &f.ContactDate, &f.Body, &f.StaffID, &f.RecordedAt, &f.CorrectedAt, &f.IsDeleted, &f.UpdatedAt)
	if err != nil {
		return nil, err
	}
	f.StaffName = a.staffName(f.StaffID)
	return &f, nil
}

// checkFacilityBody は、園からの本文を検査する（前後の空白を除いてから。空は送れない・500文字以内）
func checkFacilityBody(body string) (string, string) {
	v := strings.TrimSpace(body)
	if v == "" {
		return "", msgFacilityEmpty
	}
	if tooLong(v, 500) {
		return "", msgFacilityTooLong
	}
	return v, ""
}

// writeOtherNames は、他児の名前の注意（409 other_child_names）を返す。照合できなかったら 500。返したら true
func (a *app) writeOtherNames(w http.ResponseWriter, text, field string, recipients []string, everyone bool, ack []string) bool {
	e, err := a.checkOtherNames(text, field, recipients, everyone, ack)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return true
	}
	if e != nil {
		writeJSON(w, http.StatusConflict, e)
		return true
	}
	return false
}

// PUT /api/contact/children/{childID}/facility（詳細設計書 (4-5 (1))）。要求 { body, acknowledged_names? }、応答 ContactFacility
func (a *app) handleSendFacility(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	classID := a.contactClassOf(childID)
	// ページはサーバの今日
	if !a.contactAccess(u, childID).Write || classID == 0 {
		writeForbidden(w, msgContactForbidden)
		return
	}
	var in struct {
		Body              string   `json:"body"`
		AcknowledgedNames []string `json:"acknowledged_names"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	body, msg := checkFacilityBody(in.Body)
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	day := today()
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_contact_facility WHERE child_id = ? AND contact_date = ? AND is_deleted = 0`, childID, day).Scan(&n)
	if n > 0 {
		writeJSON(w, http.StatusConflict, apiError{Message: msgFacilitySent, Kind: kindAlreadyExists})
		return
	}
	if a.writeOtherNames(w, body, "body", []string{childID}, false, in.AcknowledgedNames) {
		return
	}
	at := now()
	res, err := a.db.Exec(`INSERT INTO t_contact_facility (child_id, class_id, contact_date, body, staff_id, recorded_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, childID, classID, day, body, u.staff(), at, at, at)
	if err != nil {
		// 同時に押されたときは部分一意の索引（ux_contact_facility_alive）が止める。遅いほうは 409
		writeJSON(w, http.StatusConflict, apiError{Message: msgFacilitySent, Kind: kindAlreadyExists})
		return
	}
	id, _ := res.LastInsertId()
	a.log(u.AccountID, fnContact, opCreate, "t_contact_facility", i64(id), &childID, nil, s(fieldsJSON([]field{{"body", body}})))
	a.notifyContactChild(childID, "facility")
	f, err := a.loadFacilityByID(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	writeJSON(w, http.StatusOK, f.contactFacilityOut)
}

// facilityTarget は、訂正・取り消しの相手の園からを読み、直せる人かを確かめる（詳細設計書「訂正・取り消し」(4-7)）
func (a *app) facilityTarget(w http.ResponseWriter, r *http.Request, u *SessionUser) *contactFacilityRow {
	id, valid := pathInt64(r, "id")
	var f *contactFacilityRow
	var err error
	if valid {
		f, err = a.loadFacilityByID(id)
	}
	if !valid || err != nil || f.IsDeleted || !a.contactAccess(u, f.ChildID).Read {
		writeForbidden(w, msgContactForbidden)
		return nil
	}
	if !a.canFixContact(u, f.ChildID, f.ContactDate) {
		writeForbidden(w, msgFixForbidden)
		return nil
	}
	return f
}

// POST /api/contact/facility/{id}/correct。要求 { body, acknowledged_names?, updated_at }。訂正も他児の名前の照合を通る
func (a *app) handleCorrectFacility(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	f := a.facilityTarget(w, r, u)
	if f == nil {
		return
	}
	var in struct {
		Body              string   `json:"body"`
		AcknowledgedNames []string `json:"acknowledged_names"`
		UpdatedAt         string   `json:"updated_at"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	body, msg := checkFacilityBody(in.Body)
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	if a.writeOtherNames(w, body, "body", []string{f.ChildID}, false, in.AcknowledgedNames) {
		return
	}
	at := now()
	res, err := a.db.Exec(`UPDATE t_contact_facility SET body = ?, corrected_at = ?, updated_at = ?
		WHERE contact_facility_id = ? AND is_deleted = 0 AND updated_at = ?`, body, at, at, f.ID, in.UpdatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, http.StatusConflict, apiError{Message: msgFixConflict, Kind: kindVersionConflict})
		return
	}
	before, after := changedFields([]field{{"body", f.Body}}, []field{{"body", body}})
	a.log(u.AccountID, fnContact, opUpdate, "t_contact_facility", i64(f.ID), &f.ChildID, s(before), s(after))
	a.notifyContactChild(f.ChildID, "facility")
	saved, err := a.loadFacilityByID(f.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	writeJSON(w, http.StatusOK, saved.contactFacilityOut)
}

// POST /api/contact/facility/{id}/cancel。取り消したあとは未送信に戻り、送り直せる
func (a *app) handleCancelFacility(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	f := a.facilityTarget(w, r, u)
	if f == nil {
		return
	}
	families, _ := a.readersOf([]string{f.ChildID}, f.ContactDate, f.RecordedAt)
	if _, err := a.db.Exec(`UPDATE t_contact_facility SET is_deleted = 1, updated_at = ? WHERE contact_facility_id = ?`, now(), f.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	a.log(u.AccountID, fnContact, opDelete, "t_contact_facility", i64(f.ID), &f.ChildID, s(fieldsJSON([]field{{"body", f.Body}})), nil)
	a.notifyContactChild(f.ChildID, "facility")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "read_family_count": families})
}

// GET /api/contact/facility/{id}/readers（詳細設計書 (4-7 (3))）
func (a *app) handleFacilityReaders(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	var f *contactFacilityRow
	var err error
	if valid {
		f, err = a.loadFacilityByID(id)
	}
	if !valid || err != nil || f.IsDeleted || !a.contactAccess(u, f.ChildID).Read {
		writeForbidden(w, msgContactForbidden)
		return
	}
	families, guardians := a.readersOf([]string{f.ChildID}, f.ContactDate, f.RecordedAt)
	writeJSON(w, http.StatusOK, map[string]int{"family_count": families, "guardian_count": guardians})
}

/*
POST /api/contact/name-check（詳細設計書 (4-5 (3))）。要求 { child_ids?, class_id?, text }、応答 { names }。
送る経路そのものが照合するため（決めたこと D-4）、本版の画面は呼ばない。テストと次の版のチャットの送信のために置く。
宛先の園児は書ける人だけが指せる（照合で、ほかのクラスの園児の名前が当たったかを知る道にしない）
*/
func (a *app) handleNameCheck(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var in struct {
		ChildIDs []string `json:"child_ids"`
		ClassID  *int64   `json:"class_id"`
		Text     string   `json:"text"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	everyone := in.ClassID != nil
	if everyone && !a.classContactAccess(u, *in.ClassID).Write {
		writeForbidden(w, msgContactClassForbidden)
		return
	}
	for _, id := range in.ChildIDs {
		if !a.contactAccess(u, id).Write {
			writeForbidden(w, msgContactForbidden)
			return
		}
	}
	all, err := a.enrolledNameChildren()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	recipients := []nameChild{}
	if !everyone {
		for _, id := range in.ChildIDs {
			recipients = append(recipients, a.nameChildOf(id))
		}
	}
	names, _ := findOtherNames(in.Text, "text", recipients, all)
	writeJSON(w, http.StatusOK, map[string][]string{"names": names})
}

// phraseOut は定型文（図/インタフェース一覧の Phrase）
type phraseOut struct {
	PhraseID     int64  `json:"phrase_id"`
	PhraseScope  string `json:"phrase_scope"`
	Body         string `json:"body"`
	DisplayOrder int    `json:"display_order"`
}

// GET /api/phrases?scope=1|2|3|4（詳細設計書 (4-5 (4))）。職員だけ。取り消していない行を並び順に
func (a *app) handlePhrases(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	scope := r.URL.Query().Get("scope")
	if scope != "1" && scope != "2" && scope != "3" && scope != "4" {
		writeErr(w, http.StatusBadRequest, msgBadRequest)
		return
	}
	rows, err := a.db.Query(`SELECT phrase_id, phrase_scope, body, display_order FROM m_phrase
		WHERE phrase_scope = ? AND is_deleted = 0 ORDER BY display_order, phrase_id`, scope)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	defer rows.Close()
	out := []phraseOut{}
	for rows.Next() {
		var p phraseOut
		if rows.Scan(&p.PhraseID, &p.PhraseScope, &p.Body, &p.DisplayOrder) == nil {
			out = append(out, p)
		}
	}
	writeJSON(w, http.StatusOK, out)
}
