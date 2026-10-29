package main

import (
	"net/http"
	"regexp"
	"sort"
	"time"
)

/*
連絡帳の月の一覧（GET /api/contact/children/{childID}/month?month=YYYY-MM）。
典拠：詳細設計書「連絡帳画面（保護者）」(2-6 (6))・「連絡帳を読む経路」(4-3 (2))、図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目4、
基本設計書「連絡帳の月の一覧」。モックは web/src/api/mock.ts の contactMonth が同じ形を返す。

日ごとに「家庭から」「園から」の有無と、きょうのようすの件数を出す。権限は1ページを読むのと同じ（contactAccess の Read。猶予中を含む）。
保護者の応答は、contact.show_items で外した種類を数えず、「新しい」（unread）を付ける。職員の応答には unread を付けない。

【仮置き】応答の日の形：詳細設計書の形（date・has_records・has_facility・unread）に、画面詳細図が求める「家庭から」の有無（has_home）と
件数（record_count）を足した（web/仮置き値.md）。
【仮置き】移れる月の下限：園児が在籍した月から（同 (2-6 (6))）。在籍の始まりの日を持つ列が無いため、その園児の連絡帳に
いちばん早く記録のある月とし、記録がなければ今月だけにする。上限は今月（保護者は猶予期間の中でも今月まで）。
*/

var monthParam = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)

type monthDayOut struct {
	Date        string `json:"date"`
	HasHome     bool   `json:"has_home"`
	HasRecords  bool   `json:"has_records"`
	RecordCount int    `json:"record_count"`
	HasFacility bool   `json:"has_facility"`
	Unread      *bool  `json:"unread,omitempty"` // 保護者の応答だけ
}

type contactMonthOut struct {
	Month string        `json:"month"`
	From  string        `json:"from_month"` // 移れる最初の月
	To    string        `json:"to_month"`   // 移れる最後の月（今月）
	Days  []monthDayOut `json:"days"`
}

func (a *app) handleContactMonth(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.contactAccess(u, childID).Read {
		writeForbidden(w, msgContactForbidden)
		return
	}
	thisMonth := today()[:7]
	month := r.URL.Query().Get("month")
	if month == "" {
		month = thisMonth
	}
	if !monthParam.MatchString(month) || month > thisMonth {
		writeErr(w, http.StatusBadRequest, msgContactBadDate)
		return
	}
	out, err := a.contactMonth(u, childID, month)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) contactMonth(u *SessionUser, childID, month string) (*contactMonthOut, error) {
	guardian := u.isGuardian()
	first, last := month+"-01", month+"-31"
	days := map[string]*monthDayOut{}
	day := func(date string) *monthDayOut {
		d := days[date]
		if d == nil {
			d = &monthDayOut{Date: date}
			days[date] = d
		}
		return d
	}
	// 保護者が開いた時刻（その日のページごと）。「新しい」の判定に使う
	reads := map[string]string{}
	if guardian {
		rows, err := a.db.Query(`SELECT contact_date, read_at FROM t_contact_read WHERE child_id = ? AND account_id = ?
			AND contact_date BETWEEN ? AND ?`, childID, u.AccountID, first, last)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var date, at string
			if rows.Scan(&date, &at) == nil {
				reads[date] = at
			}
		}
		rows.Close()
	}
	newer := func(date, at string) {
		if !guardian || at <= reads[date] {
			return
		}
		t := true
		day(date).Unread = &t
	}
	count := func(date string) { d := day(date); d.RecordCount++; d.HasRecords = true }

	// 家庭から
	hr, err := a.db.Query(`SELECT contact_date FROM t_contact_home WHERE child_id = ? AND contact_date BETWEEN ? AND ?`, childID, first, last)
	if err != nil {
		return nil, err
	}
	for hr.Next() {
		var date string
		if hr.Scan(&date) == nil {
			day(date).HasHome = true
		}
	}
	hr.Close()
	// 園から（取り消していないもの）
	fr, err := a.db.Query(`SELECT contact_date, recorded_at, corrected_at FROM t_contact_facility
		WHERE child_id = ? AND is_deleted = 0 AND contact_date BETWEEN ? AND ?`, childID, first, last)
	if err != nil {
		return nil, err
	}
	for fr.Next() {
		var date, at string
		var fixed *string
		if fr.Scan(&date, &at, &fixed) == nil {
			day(date).HasFacility = true
			newer(date, laterOf(at, fixed))
		}
	}
	fr.Close()
	// きょうのようす（食事・排せつ・体温・ひとこと・写真）。保護者には出す種類だけ数える
	er, err := a.db.Query(`SELECT contact_date, event_type, recorded_at, corrected_at FROM t_contact_event
		WHERE child_id = ? AND is_deleted = 0 AND contact_date BETWEEN ? AND ?`, childID, first, last)
	if err != nil {
		return nil, err
	}
	for er.Next() {
		var date, kind, at string
		var fixed *string
		if er.Scan(&date, &kind, &at, &fixed) != nil {
			continue
		}
		if guardian && !a.guardianSeesItem(eventItem(kind)) {
			continue
		}
		count(date)
		newer(date, laterOf(at, fixed))
	}
	er.Close()
	// ねた・おきた
	if !guardian || a.guardianSeesItem("nap") {
		nr, err := a.db.Query(`SELECT n.session_date, s.slept_at FROM t_nap_sleep s JOIN t_nap_session n ON n.nap_session_id = s.nap_session_id
			WHERE s.child_id = ? AND s.is_deleted = 0 AND n.session_date BETWEEN ? AND ?`, childID, first, last)
		if err != nil {
			return nil, err
		}
		for nr.Next() {
			var date, at string
			if nr.Scan(&date, &at) == nil {
				count(date)
				newer(date, at)
			}
		}
		nr.Close()
	}
	// クラスのようす（いまのクラス）
	if classID := a.contactClassOf(childID); classID != 0 && (!guardian || a.guardianSeesItem("class")) {
		cr, err := a.db.Query(`SELECT contact_date, recorded_at, corrected_at FROM t_contact_class
			WHERE class_id = ? AND is_deleted = 0 AND contact_date BETWEEN ? AND ?`, classID, first, last)
		if err != nil {
			return nil, err
		}
		for cr.Next() {
			var date, at string
			var fixed *string
			if cr.Scan(&date, &at, &fixed) == nil {
				count(date)
				newer(date, laterOf(at, fixed))
			}
		}
		cr.Close()
	}

	// 移れる月の下限：いちばん早く記録のある月（無ければ今月）
	from := today()[:7]
	var earliest *string
	a.db.QueryRow(`SELECT MIN(d) FROM (
		SELECT MIN(contact_date) AS d FROM t_contact_home WHERE child_id = ?
		UNION ALL SELECT MIN(contact_date) FROM t_contact_event WHERE child_id = ? AND is_deleted = 0
		UNION ALL SELECT MIN(contact_date) FROM t_contact_facility WHERE child_id = ? AND is_deleted = 0)`,
		childID, childID, childID).Scan(&earliest)
	if earliest != nil && len(*earliest) >= 7 && (*earliest)[:7] < from {
		from = (*earliest)[:7]
	}
	if month < from {
		from = month
	}

	// 月の全日を並べる（今日より後の日は出さない）
	out := &contactMonthOut{Month: month, From: from, To: today()[:7], Days: []monthDayOut{}}
	t, err := time.ParseInLocation("2006-01-02", first, jst)
	if err != nil {
		return nil, err
	}
	dates := []string{}
	for d := t; d.Format("2006-01") == month; d = d.AddDate(0, 0, 1) {
		if date := d.Format("2006-01-02"); date <= today() {
			dates = append(dates, date)
		}
	}
	sort.Strings(dates)
	for _, date := range dates {
		if d := days[date]; d != nil {
			out.Days = append(out.Days, *d)
		} else {
			out.Days = append(out.Days, monthDayOut{Date: date})
		}
	}
	return out, nil
}

// laterOf は、記録した時刻と訂正した時刻のうち新しいほう
func laterOf(at string, corrected *string) string {
	if corrected != nil && *corrected > at {
		return *corrected
	}
	return at
}
