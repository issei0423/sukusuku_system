package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"unicode/utf8"
)

/*
連絡帳を読む経路（詳細設計書「連絡帳の1ページと家庭から」(4-3)、図/インタフェース一覧「ContactPage」ほか）。

返す形は職員と保護者で分ける。保護者の応答からは、取り消した行・contact.show_items で外した種類（開いた時点の設定）・
入眠時の体温と実施の ID・記録した職員の名前・書いた保護者と確認した職員の名前を落とす（段3。基本設計書「届ける範囲」）。
モックは web/src/api/mock.ts の contactApi が同じ形を返す。
*/

// ---- 返す形（図/インタフェース一覧「やり取りするデータの項目」(2)） ----

type contactHomeOut struct {
	ID          int64  `json:"contact_home_id"`
	ChildID     string `json:"child_id"`
	ContactDate string `json:"contact_date"`
	GuardianID  string `json:"guardian_id"`
	// 職員の応答だけ（父母のどちらが書いたか）。続柄は詳細設計書「家庭からの列」(2-2 (3)) の「母 7:40」のために足した
	GuardianName         string   `json:"guardian_name,omitempty"`
	GuardianRelationship string   `json:"guardian_relationship,omitempty"`
	Temperature          *float64 `json:"temperature"`
	NightSleepFrom       *string  `json:"night_sleep_from"`
	NightSleepTo         *string  `json:"night_sleep_to"`
	Breakfast            *string  `json:"breakfast"`
	MoodLabel            *string  `json:"mood_label"`
	PickupType           *string  `json:"pickup_type"`
	PickupPerson         *string  `json:"pickup_person"`
	PickupTime           *string  `json:"pickup_time"`
	Message              *string  `json:"message"`
	SubmittedAt          string   `json:"submitted_at"`
	ConfirmedAt          *string  `json:"confirmed_at"`
	ConfirmedStaffName   string   `json:"confirmed_staff_name,omitempty"` // 職員の応答だけ
	RevisedAt            *string  `json:"revised_at"`
	UpdatedAt            string   `json:"updated_at"`
}

type contactEventOut struct {
	ID             int64    `json:"contact_event_id"`
	ChildID        string   `json:"child_id"`
	ContactDate    string   `json:"contact_date"`
	EventType      string   `json:"event_type"`
	RecordedAt     string   `json:"recorded_at"`
	MealKind       *string  `json:"meal_kind"`
	MealAmount     *string  `json:"meal_amount"`
	ToiletLabel    *string  `json:"toilet_label"`
	Temperature    *float64 `json:"temperature"`
	Body           *string  `json:"body"`
	ContactPhotoID *int64   `json:"contact_photo_id"`
	KeepInGrowth   bool     `json:"keep_in_growth"`
	StaffName      string   `json:"staff_name,omitempty"` // 職員の応答だけ
	CorrectedAt    *string  `json:"corrected_at"`
	IsDeleted      bool     `json:"is_deleted"`
	// 職員の応答だけ。訂正のときに読んだ版として送り返す（詳細設計書「訂正・取り消し」(4-7 (1))）
	UpdatedAt string `json:"updated_at,omitempty"`
}

type contactClassOut struct {
	ID             int64   `json:"contact_class_id"`
	ClassID        int64   `json:"class_id"`
	ContactDate    string  `json:"contact_date"`
	Body           string  `json:"body"`
	ContactPhotoID *int64  `json:"contact_photo_id"`
	SourceDiaryID  *int64  `json:"source_diary_id,omitempty"` // 職員の応答だけ
	RecordedAt     string  `json:"recorded_at"`
	CorrectedAt    *string `json:"corrected_at"`
	IsDeleted      bool    `json:"is_deleted"`
}

type contactFacilityOut struct {
	ID          int64   `json:"contact_facility_id"`
	ChildID     string  `json:"child_id"`
	ContactDate string  `json:"contact_date"`
	Body        string  `json:"body"`
	StaffName   string  `json:"staff_name,omitempty"` // 職員の応答だけ
	RecordedAt  string  `json:"recorded_at"`
	CorrectedAt *string `json:"corrected_at"`
	IsDeleted   bool    `json:"is_deleted"`
	// 職員の応答だけ。訂正のときに読んだ版として送り返す（詳細設計書「訂正・取り消し」(4-7 (1))）
	UpdatedAt string `json:"updated_at,omitempty"`
}

type napSleepOut struct {
	ID               int64    `json:"nap_sleep_id"`
	ChildID          string   `json:"child_id"`
	SleptAt          string   `json:"slept_at"`
	WokeAt           *string  `json:"woke_at"`
	SleepTemperature *float64 `json:"sleep_temperature,omitempty"` // 職員の応答だけ（監査の層）
	NapSessionID     int64    `json:"nap_session_id,omitempty"`    // 職員の応答だけ
	CorrectedAt      *string  `json:"corrected_at"`
	IsDeleted        bool     `json:"is_deleted"`
	// その実施が終わったか（自動の解除を含む）。おきたが無いまま終わった組を「おひるね中」でなく「ねた」と出すため
	// （詳細設計書「午睡の園児」(3-4) の「ねた（おきた時刻なし）」。図/インタフェース一覧の NapSleep に足した）
	SessionEnded bool `json:"session_ended"`
	// 職員の応答だけ。訂正のときに読んだ版として送り返す（詳細設計書「訂正・取り消し」(4-7)・「午睡」(4-6 (4))）
	UpdatedAt string `json:"updated_at,omitempty"`
}

type napExclusionOut struct {
	ID           int64  `json:"nap_exclusion_id"`
	NapSessionID int64  `json:"nap_session_id"`
	ChildID      string `json:"child_id"`
	Reason       string `json:"reason"`
	StaffID      string `json:"staff_id"`
	IsDeleted    bool   `json:"is_deleted"`
}

type contactPageOut struct {
	ChildID      string              `json:"child_id"`
	ChildName    string              `json:"child_name"`
	ContactDate  string              `json:"contact_date"`
	ClassID      *int64              `json:"class_id"`
	Home         *contactHomeOut     `json:"home"`
	Events       []contactEventOut   `json:"events"`
	Sleeps       []napSleepOut       `json:"sleeps"`
	ClassNotes   []contactClassOut   `json:"class_notes"`
	Facility     *contactFacilityOut `json:"facility"`
	CanWriteHome bool                `json:"can_write_home"`
	// 職員の応答だけ。その園児の記録を書けるか（contactAccess の Write）。画面が記録・直す部品を出すかに使う。
	// 前の日のページに記録を足せないこと・翌日以降は管理者だけが直せることは、画面とサーバがそれぞれ日付で決める
	CanWrite *bool `json:"can_write,omitempty"`
	// 職員の応答だけ。送る直前に示す宛先（詳細設計書「型」(4-1 (4)) の ContactRecipient）
	Recipient *contactRecipient `json:"recipient,omitempty"`
	// 保護者の応答だけ。そのページを前に開いた時刻（無ければ null）。画面が「新」の印に使う
	LastReadAt any `json:"last_read_at,omitempty"`
}

// ---- 行を読む ----

type contactHomeRow struct {
	contactHomeOut
	ConfirmedStaffID *string
}

const contactHomeColumns = `contact_home_id, child_id, contact_date, guardian_id, temperature, night_sleep_from, night_sleep_to,
	breakfast, mood_label, pickup_type, pickup_person, pickup_time, message, submitted_at, confirmed_staff_id, confirmed_at,
	revised_at, updated_at`

func (a *app) loadContactHome(childID, date string) (*contactHomeRow, error) {
	var h contactHomeRow
	err := a.db.QueryRow(`SELECT `+contactHomeColumns+` FROM t_contact_home WHERE child_id = ? AND contact_date = ?`, childID, date).
		Scan(&h.ID, &h.ChildID, &h.ContactDate, &h.GuardianID, &h.Temperature, &h.NightSleepFrom, &h.NightSleepTo,
			&h.Breakfast, &h.MoodLabel, &h.PickupType, &h.PickupPerson, &h.PickupTime, &h.Message, &h.SubmittedAt,
			&h.ConfirmedStaffID, &h.ConfirmedAt, &h.RevisedAt, &h.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &h, nil
}

// homeView は、家庭からを見る人に合わせた形にする。職員にだけ、書いた保護者と確認した職員の名前を添える
func (a *app) homeView(h *contactHomeRow, staff bool) *contactHomeOut {
	if h == nil {
		return nil
	}
	out := h.contactHomeOut
	out.GuardianName, out.GuardianRelationship, out.ConfirmedStaffName = "", "", ""
	if staff {
		a.db.QueryRow(`SELECT g.guardian_name, IFNULL(gc.relationship, '') FROM m_guardian g
			LEFT JOIN t_guardian_child gc ON gc.guardian_id = g.guardian_id AND gc.child_id = ?
			WHERE g.guardian_id = ?`, h.ChildID, h.GuardianID).Scan(&out.GuardianName, &out.GuardianRelationship)
		if h.ConfirmedStaffID != nil {
			out.ConfirmedStaffName = a.staffName(*h.ConfirmedStaffID)
		}
	}
	return &out
}

func (a *app) loadContactEvents(childID, date string, staff bool) ([]contactEventOut, error) {
	rows, err := a.db.Query(`SELECT contact_event_id, child_id, contact_date, event_type, recorded_at, meal_kind, meal_amount,
		toilet_label, temperature, body, contact_photo_id, keep_in_growth, staff_id, corrected_at, is_deleted, updated_at
		FROM t_contact_event WHERE child_id = ? AND contact_date = ? AND is_deleted = 0
		ORDER BY recorded_at, contact_event_id`, childID, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []contactEventOut{}
	var staffIDs []string
	for rows.Next() {
		var e contactEventOut
		var staffID string
		if err := rows.Scan(&e.ID, &e.ChildID, &e.ContactDate, &e.EventType, &e.RecordedAt, &e.MealKind, &e.MealAmount,
			&e.ToiletLabel, &e.Temperature, &e.Body, &e.ContactPhotoID, &e.KeepInGrowth, &staffID, &e.CorrectedAt, &e.IsDeleted, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
		staffIDs = append(staffIDs, staffID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	// 名前はカーソルを閉じたあとに引く（接続は1本）
	for i := range out {
		if staff {
			out[i].StaffName = a.staffName(staffIDs[i])
		} else {
			out[i].UpdatedAt = ""
		}
	}
	return out, nil
}

// loadNapSleeps は、その日の実施の、取り消していない「ねた・おきた」。t_nap_record・t_nap_exclusion は読まない（段3）
func (a *app) loadNapSleeps(childID, date string, staff bool) ([]napSleepOut, error) {
	rows, err := a.db.Query(`SELECT s.nap_sleep_id, s.child_id, s.slept_at, s.woke_at, s.sleep_temperature, s.nap_session_id,
		s.corrected_at, s.is_deleted, n.ended_at IS NOT NULL, s.updated_at
		FROM t_nap_sleep s JOIN t_nap_session n ON n.nap_session_id = s.nap_session_id
		WHERE s.child_id = ? AND n.session_date = ? AND s.is_deleted = 0
		ORDER BY s.slept_at, s.nap_sleep_id`, childID, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []napSleepOut{}
	for rows.Next() {
		var v napSleepOut
		if err := rows.Scan(&v.ID, &v.ChildID, &v.SleptAt, &v.WokeAt, &v.SleepTemperature, &v.NapSessionID, &v.CorrectedAt, &v.IsDeleted, &v.SessionEnded, &v.UpdatedAt); err != nil {
			return nil, err
		}
		if !staff {
			v.SleepTemperature, v.NapSessionID, v.UpdatedAt = nil, 0, ""
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (a *app) loadClassNotes(classID int64, date string, staff bool) ([]contactClassOut, error) {
	rows, err := a.db.Query(`SELECT contact_class_id, class_id, contact_date, body, contact_photo_id, source_diary_id,
		recorded_at, corrected_at, is_deleted
		FROM t_contact_class WHERE class_id = ? AND contact_date = ? AND is_deleted = 0
		ORDER BY recorded_at, contact_class_id`, classID, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []contactClassOut{}
	for rows.Next() {
		var c contactClassOut
		if err := rows.Scan(&c.ID, &c.ClassID, &c.ContactDate, &c.Body, &c.ContactPhotoID, &c.SourceDiaryID,
			&c.RecordedAt, &c.CorrectedAt, &c.IsDeleted); err != nil {
			return nil, err
		}
		if !staff {
			c.SourceDiaryID = nil
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (a *app) loadFacility(childID, date string, staff bool) (*contactFacilityOut, error) {
	var f contactFacilityOut
	var staffID string
	err := a.db.QueryRow(`SELECT contact_facility_id, child_id, contact_date, body, staff_id, recorded_at, corrected_at, is_deleted, updated_at
		FROM t_contact_facility WHERE child_id = ? AND contact_date = ? AND is_deleted = 0`, childID, date).
		Scan(&f.ID, &f.ChildID, &f.ContactDate, &f.Body, &staffID, &f.RecordedAt, &f.CorrectedAt, &f.IsDeleted, &f.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if staff {
		f.StaffName = a.staffName(staffID)
	} else {
		f.UpdatedAt = ""
	}
	return &f, nil
}

// contactPage は、連絡帳の1ページを見る人に合わせて組み立てる。権限は呼ぶ側で確かめておく
func (a *app) contactPage(u *SessionUser, childID, date string) (*contactPageOut, error) {
	// 午睡の時間帯を過ぎた実施を先に終えておく（「おひるね中」のまま出さないため）
	a.autoCloseNapSessions()
	staff := u.isStaff()
	p := &contactPageOut{ChildID: childID, ChildName: a.childName(childID), ContactDate: date}
	if id := a.contactClassOf(childID); id != 0 {
		p.ClassID = &id
	}
	h, err := a.loadContactHome(childID, date)
	if err != nil {
		return nil, err
	}
	p.Home = a.homeView(h, staff)
	if p.Events, err = a.loadContactEvents(childID, date, staff); err != nil {
		return nil, err
	}
	if p.Sleeps, err = a.loadNapSleeps(childID, date, staff); err != nil {
		return nil, err
	}
	p.ClassNotes = []contactClassOut{}
	if p.ClassID != nil {
		if p.ClassNotes, err = a.loadClassNotes(*p.ClassID, date, staff); err != nil {
			return nil, err
		}
	}
	if p.Facility, err = a.loadFacility(childID, date, staff); err != nil {
		return nil, err
	}
	if staff {
		canWrite := a.contactAccess(u, childID).Write
		p.CanWrite = &canWrite
		p.Recipient = a.recipientOf(childID)
	}
	if !staff {
		// 保護者に出さない種類は、開いた時点の設定で落とす（基本設計書「出す項目と選択肢の設定」(4-5)）
		shown := p.Events[:0]
		for _, e := range p.Events {
			if a.guardianSeesItem(eventItem(e.EventType)) {
				shown = append(shown, e)
			}
		}
		p.Events = shown
		if !a.guardianSeesItem("nap") {
			p.Sleeps = []napSleepOut{}
		}
		if !a.guardianSeesItem("class") {
			p.ClassNotes = []contactClassOut{}
		}
		p.CanWriteHome = a.contactAccess(u, childID).Write && date == today()
		var read sql.NullString
		a.db.QueryRow(`SELECT read_at FROM t_contact_read WHERE child_id = ? AND contact_date = ? AND account_id = ?`,
			childID, date, u.AccountID).Scan(&read)
		p.LastReadAt = nullStr(read)
	}
	return p, nil
}

// contactDateParam は、クエリの date を読む。省略時はサーバの今日。今日より後・形の崩れた値は 400
func contactDateParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	d := r.URL.Query().Get("date")
	if d == "" {
		return today(), true
	}
	if !isISODate(d) || d > today() {
		writeErr(w, http.StatusBadRequest, msgContactBadDate)
		return "", false
	}
	return d, true
}

// GET /api/contact/children/{childID}?date=（詳細設計書 (4-3 (1))）
func (a *app) handleContactPage(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.contactAccess(u, childID).Read {
		writeForbidden(w, msgContactForbidden)
		return
	}
	date, ok := contactDateParam(w, r)
	if !ok {
		return
	}
	p, err := a.contactPage(u, childID, date)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// POST /api/contact/children/{childID}/read（詳細設計書 (4-3 (3))）。保護者が開いた時刻を残す。知らせは送らない
func (a *app) handleContactRead(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !u.isGuardian() {
		writeForbidden(w, msgGuardianOnly)
		return
	}
	childID := r.PathValue("childID")
	if !a.contactAccess(u, childID).Read {
		writeForbidden(w, msgContactForbidden)
		return
	}
	var in struct {
		Date string `json:"date"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if !isISODate(in.Date) || in.Date > today() {
		writeErr(w, http.StatusBadRequest, msgContactBadDate)
		return
	}
	if _, err := a.db.Exec(`INSERT INTO t_contact_read (child_id, contact_date, account_id, read_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (child_id, contact_date, account_id) DO UPDATE SET read_at = excluded.read_at`,
		childID, in.Date, u.AccountID, now()); err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- 連絡帳（クラス）画面 ----

type contactClassRowOut struct {
	Child     Child               `json:"child"`
	HomeState string              `json:"home_state"`
	Home      *contactHomeOut     `json:"home"`
	Events    []contactEventOut   `json:"events"`
	Sleeps    []napSleepOut       `json:"sleeps"`
	Exclusion *napExclusionOut    `json:"exclusion"`
	Facility  *contactFacilityOut `json:"facility"`
	Recipient *contactRecipient   `json:"recipient"`
}

// homeState は、家庭からの状態を列から読む（詳細設計書「家庭から」(3-1)）
func homeState(h *contactHomeRow) string {
	switch {
	case h == nil:
		return "none"
	case h.ConfirmedAt != nil:
		return "confirmed"
	case h.RevisedAt != nil:
		return "revised"
	}
	return "unconfirmed"
}

func (a *app) loadExclusion(childID, date string) *napExclusionOut {
	var x napExclusionOut
	if a.db.QueryRow(`SELECT x.nap_exclusion_id, x.nap_session_id, x.child_id, x.reason, x.staff_id, x.is_deleted
		FROM t_nap_exclusion x JOIN t_nap_session n ON n.nap_session_id = x.nap_session_id
		WHERE x.child_id = ? AND n.session_date = ? AND x.is_deleted = 0
		ORDER BY x.nap_exclusion_id DESC LIMIT 1`, childID, date).
		Scan(&x.ID, &x.NapSessionID, &x.ChildID, &x.Reason, &x.StaffID, &x.IsDeleted) != nil {
		return nil
	}
	return &x
}

// GET /api/contact/classes/{classID}?date=（詳細設計書 (4-3 (4))）。職員だけ
func (a *app) handleContactClass(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	classID, valid := pathInt64(r, "classID")
	if !valid || !a.classContactAccess(u, classID).Read {
		writeForbidden(w, msgContactClassForbidden)
		return
	}
	date, ok := contactDateParam(w, r)
	if !ok {
		return
	}
	rows, err := a.db.Query(`SELECT `+childColumns+` FROM m_child
		WHERE is_deleted = 0 AND enrollment_status = '1'
		  AND child_id IN (SELECT child_id FROM t_class_child WHERE class_id = ?)
		ORDER BY child_name_kana, child_id`, classID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	children := []Child{}
	for rows.Next() {
		c, err := scanChild(rows)
		if err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
			return
		}
		children = append(children, c)
	}
	rows.Close()

	out := []contactClassRowOut{}
	families := 0
	for _, c := range children {
		h, err := a.loadContactHome(c.ChildID, date)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
			return
		}
		row := contactClassRowOut{Child: c, HomeState: homeState(h), Home: a.homeView(h, true)}
		row.Events, _ = a.loadContactEvents(c.ChildID, date, true)
		row.Sleeps, _ = a.loadNapSleeps(c.ChildID, date, true)
		row.Exclusion = a.loadExclusion(c.ChildID, date)
		row.Facility, _ = a.loadFacility(c.ChildID, date, true)
		row.Recipient = a.recipientOf(c.ChildID)
		out = append(out, row)
		// 家庭の数は、有効な紐づけの保護者が1人以上いる在籍園児の数（決めたこと D-27）
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_guardian_child WHERE child_id = ? AND link_status = '1'`, c.ChildID).Scan(&n)
		if n > 0 {
			families++
		}
	}
	notes, err := a.loadClassNotes(classID, date, true)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"class_id": classID, "class_name": a.className(classID), "contact_date": date,
		"family_count": families, "unregistered_count": len(out) - families,
		"can_write": a.classContactAccess(u, classID).Write,
		"rows":      out, "class_notes": notes,
	})
}

// GET /api/contact/classes（本書の表に無い。連絡帳（クラス）画面のクラスを選ぶ欄のため）。
// classContactAccess の Read で選べるクラスを返す（詳細設計書「空・読み込み中・つながっていないとき」(2-2 (9))）
func (a *app) handleContactClasses(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	rows, err := a.db.Query(`SELECT class_id, class_name FROM m_class WHERE fiscal_year = ? ORDER BY class_id`, fiscalYear)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	type classRef struct {
		ClassID   int64  `json:"class_id"`
		ClassName string `json:"class_name"`
	}
	all := []classRef{}
	for rows.Next() {
		var c classRef
		if rows.Scan(&c.ClassID, &c.ClassName) == nil {
			all = append(all, c)
		}
	}
	rows.Close()
	out := []classRef{}
	for _, c := range all {
		if a.classContactAccess(u, c.ClassID).Read {
			out = append(out, c)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- 保護者ホームの「きょう」（詳細設計書「ダッシュボード」(4-8 (1))） ----

type todayItemOut struct {
	Kind           string  `json:"kind"`
	RecordedAt     string  `json:"recorded_at"`
	CorrectedAt    *string `json:"corrected_at"`
	Text           string  `json:"text"`
	ContactPhotoID *int64  `json:"contact_photo_id"`
}

type guardianTodayOut struct {
	ChildID      string  `json:"child_id"`
	ChildName    string  `json:"child_name"`
	ClassName    string  `json:"class_name"`
	ContactDate  string  `json:"contact_date"`
	CanWriteHome bool    `json:"can_write_home"`
	GraceEndsOn  *string `json:"grace_ends_on"`
	Home         *struct {
		SubmittedAt string  `json:"submitted_at"`
		ConfirmedAt *string `json:"confirmed_at"`
		RevisedAt   *string `json:"revised_at"`
	} `json:"home"`
	Nap      *napSleepOut   `json:"nap"`
	Latest   []todayItemOut `json:"latest"`
	Facility *struct {
		RecordedAt  string  `json:"recorded_at"`
		CorrectedAt *string `json:"corrected_at"`
		Excerpt     string  `json:"excerpt"`
	} `json:"facility"`
	UnreadContact  int    `json:"unread_contact"`
	UnreadChat     int    `json:"unread_chat"`
	PersonalRoomID *int64 `json:"personal_room_id"`
	GrowthNew      bool   `json:"growth_new"`
}

// mealAmountText は食事の量の言葉。保護者には「食べない」を「食べていない」と出す（詳細設計書「食事の列」(2-2 (4))）
var mealAmountText = map[string]string{"1": "ぜんぶ", "2": "半分", "3": "少し", "4": "食べていない"}
var mealKindText = map[string]string{"1": "給食", "2": "おやつ"}

func excerpt(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

// todayItemText は、きょうのようすの1件を短い文にする（判定の言葉を付けない）
func todayItemText(e contactEventOut) string {
	switch e.EventType {
	case "1":
		return mealKindText[deref(e.MealKind)] + " " + mealAmountText[deref(e.MealAmount)]
	case "2":
		return deref(e.ToiletLabel)
	case "3":
		if e.Temperature != nil {
			return formatTemp(*e.Temperature) + "℃"
		}
	case "4":
		return excerpt(deref(e.Body), 40)
	case "5":
		return "写真"
	}
	return ""
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func formatTemp(v float64) string { return strconv.FormatFloat(v, 'f', 1, 64) }

// guardianToday は、保護者ホームの園児1人の「きょう」を、今日のページから作る
func (a *app) guardianToday(u *SessionUser, childID string) (*guardianTodayOut, error) {
	day := today()
	p, err := a.contactPage(u, childID, day)
	if err != nil {
		return nil, err
	}
	t := &guardianTodayOut{ChildID: childID, ChildName: p.ChildName, ClassName: "―", ContactDate: day,
		CanWriteHome: p.CanWriteHome, Latest: []todayItemOut{}}
	if p.ClassID != nil {
		t.ClassName = a.className(*p.ClassID)
	}
	var grace sql.NullString
	a.db.QueryRow(`SELECT grace_ends_on FROM t_guardian_child WHERE guardian_id = ? AND child_id = ? AND link_status = '3'`,
		u.guardian(), childID).Scan(&grace)
	t.GraceEndsOn = nullStr(grace)
	if p.Home != nil {
		t.Home = &struct {
			SubmittedAt string  `json:"submitted_at"`
			ConfirmedAt *string `json:"confirmed_at"`
			RevisedAt   *string `json:"revised_at"`
		}{p.Home.SubmittedAt, p.Home.ConfirmedAt, p.Home.RevisedAt}
	}
	if n := len(p.Sleeps); n > 0 {
		latest := p.Sleeps[0]
		for _, s := range p.Sleeps[1:] {
			if s.SleptAt >= latest.SleptAt {
				latest = s
			}
		}
		t.Nap = &latest
	}
	items := []todayItemOut{}
	for _, e := range p.Events {
		items = append(items, todayItemOut{Kind: map[string]string{"1": "meal", "2": "toilet", "3": "temperature", "4": "comment", "5": "photo"}[e.EventType],
			RecordedAt: e.RecordedAt, CorrectedAt: e.CorrectedAt, Text: todayItemText(e), ContactPhotoID: e.ContactPhotoID})
	}
	for _, c := range p.ClassNotes {
		items = append(items, todayItemOut{Kind: "class_note", RecordedAt: c.RecordedAt, CorrectedAt: c.CorrectedAt,
			Text: excerpt(c.Body, 40), ContactPhotoID: c.ContactPhotoID})
	}
	// 新しい順に3件
	for i := 0; i < len(items); i++ {
		for j := i + 1; j < len(items); j++ {
			if items[j].RecordedAt > items[i].RecordedAt {
				items[i], items[j] = items[j], items[i]
			}
		}
	}
	if len(items) > 3 {
		items = items[:3]
	}
	t.Latest = items
	if p.Facility != nil {
		t.Facility = &struct {
			RecordedAt  string  `json:"recorded_at"`
			CorrectedAt *string `json:"corrected_at"`
			Excerpt     string  `json:"excerpt"`
		}{p.Facility.RecordedAt, p.Facility.CorrectedAt, excerpt(p.Facility.Body, 60)}
	}
	// 未読：開いた時刻（無ければ0時）より後に記録・訂正されたもの。確認しましたも1件に数える
	read := day + "T00:00:00"
	if s, ok := p.LastReadAt.(*string); ok && s != nil {
		read = *s
	}
	after := func(at string, corrected *string) bool {
		return at > read || (corrected != nil && *corrected > read)
	}
	for _, e := range p.Events {
		if after(e.RecordedAt, e.CorrectedAt) {
			t.UnreadContact++
		}
	}
	for _, c := range p.ClassNotes {
		if after(c.RecordedAt, c.CorrectedAt) {
			t.UnreadContact++
		}
	}
	if p.Facility != nil && after(p.Facility.RecordedAt, p.Facility.CorrectedAt) {
		t.UnreadContact++
	}
	for _, s := range p.Sleeps {
		if after(s.SleptAt, s.CorrectedAt) {
			t.UnreadContact++
		}
		if s.WokeAt != nil && *s.WokeAt > read {
			t.UnreadContact++
		}
	}
	if p.Home != nil && p.Home.ConfirmedAt != nil && *p.Home.ConfirmedAt > read {
		t.UnreadContact++
	}
	// 個人チャット（その園児の、園とのやりとり）
	var room int64
	if a.db.QueryRow(`SELECT chat_room_id FROM m_chat_room WHERE room_type = '4' AND child_id = ? ORDER BY chat_room_id LIMIT 1`, childID).Scan(&room) == nil {
		t.PersonalRoomID = &room
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message m
			WHERE m.chat_room_id = ? AND m.is_deleted = 0 AND m.sender_account_id <> ?
			  AND m.chat_room_id IN (SELECT chat_room_id FROM t_chat_member WHERE account_id = ? AND left_at IS NULL)
			  AND NOT EXISTS (SELECT 1 FROM t_chat_read x WHERE x.chat_message_id = m.chat_message_id AND x.account_id = ?)`+
			beforeJoinedClause, room, u.AccountID, u.AccountID, u.AccountID, u.AccountID).Scan(&t.UnreadChat)
	}
	return t, nil
}
