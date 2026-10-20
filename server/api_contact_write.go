package main

import (
	"database/sql"
	"net/http"
	"strings"
)

/*
家庭からと「確認しました」（詳細設計書「家庭から」(3-1)・(4-3 (5))・(4-3 (6))、基本設計書「家庭からの記入」「家庭からの確認」(4-5)）。
モックは web/src/api/mock.ts の saveHome・confirmHome が同じ規則を持つ。
*/

// ContactHomeInput（詳細設計書「型」(4-1 (4))）。updated_at は読んだときの版（初めてなら null）
type contactHomeInput struct {
	Temperature    *float64 `json:"temperature"`
	NightSleepFrom *string  `json:"night_sleep_from"`
	NightSleepTo   *string  `json:"night_sleep_to"`
	Breakfast      *string  `json:"breakfast"`
	MoodLabel      *string  `json:"mood_label"`
	PickupType     *string  `json:"pickup_type"`
	PickupPerson   *string  `json:"pickup_person"`
	PickupTime     *string  `json:"pickup_time"`
	Message        *string  `json:"message"`
	UpdatedAt      *string  `json:"updated_at"`
}

// isHHmm10 は 'HH:mm' で、分が 10 の倍数か（詳細設計書「検査の共通の規則」(4-1 (5))）
func isHHmm10(v string) bool {
	if len(v) != 5 || v[2] != ':' {
		return false
	}
	for _, i := range []int{0, 1, 3, 4} {
		if v[i] < '0' || v[i] > '9' {
			return false
		}
	}
	h, m := int(v[0]-'0')*10+int(v[1]-'0'), int(v[3]-'0')*10+int(v[4]-'0')
	return h < 24 && m < 60 && m%10 == 0
}

// trimmedOrNil は、前後の空白を除き、空なら nil にする
func trimmedOrNil(p *string) *string {
	if p == nil {
		return nil
	}
	v := strings.TrimSpace(*p)
	if v == "" {
		return nil
	}
	return &v
}

/*
checkHomeInput は家庭からの入力を検査し、保存する値を返す（詳細設計書 (4-3 (5)) の表の順）。
contact.home_items に無い項目は送られても書き換えず、今の値（old）を残す。
*/
func (a *app) checkHomeInput(in contactHomeInput, old *contactHomeRow) (contactHomeInput, string) {
	items := a.settingList("contact.home_items", defaultHomeItems)
	on := func(item string) bool { return inList(items, item) }
	out := contactHomeInput{}
	if old != nil {
		out = contactHomeInput{Temperature: old.Temperature, NightSleepFrom: old.NightSleepFrom, NightSleepTo: old.NightSleepTo,
			Breakfast: old.Breakfast, MoodLabel: old.MoodLabel, PickupType: old.PickupType, PickupPerson: old.PickupPerson,
			PickupTime: old.PickupTime, Message: old.Message}
	}
	in.NightSleepFrom, in.NightSleepTo = trimmedOrNil(in.NightSleepFrom), trimmedOrNil(in.NightSleepTo)
	in.Breakfast, in.MoodLabel, in.PickupType = trimmedOrNil(in.Breakfast), trimmedOrNil(in.MoodLabel), trimmedOrNil(in.PickupType)
	in.PickupPerson, in.PickupTime, in.Message = trimmedOrNil(in.PickupPerson), trimmedOrNil(in.PickupTime), trimmedOrNil(in.Message)

	entered := (on("temperature") && in.Temperature != nil) ||
		(on("night_sleep") && (in.NightSleepFrom != nil || in.NightSleepTo != nil)) ||
		(on("breakfast") && in.Breakfast != nil) || (on("mood") && in.MoodLabel != nil) ||
		(on("pickup") && in.PickupType != nil) || (on("message") && in.Message != nil)
	if !entered {
		return out, msgHomeEmpty
	}
	if on("temperature") {
		if in.Temperature != nil && !oneDecimal(*in.Temperature) {
			return out, msgTemperatureFormat
		}
		out.Temperature = in.Temperature
	}
	if on("night_sleep") {
		for _, v := range []*string{in.NightSleepFrom, in.NightSleepTo} {
			if v != nil && !isHHmm10(*v) {
				return out, msgBadChoice
			}
		}
		out.NightSleepFrom, out.NightSleepTo = in.NightSleepFrom, in.NightSleepTo
	}
	if on("breakfast") {
		if in.Breakfast != nil && mealAmountText[*in.Breakfast] == "" {
			return out, msgBadChoice
		}
		out.Breakfast = in.Breakfast
	}
	if on("mood") {
		if in.MoodLabel != nil && !inList(a.settingList("contact.mood_choices", ""), *in.MoodLabel) {
			return out, msgBadChoice
		}
		out.MoodLabel = in.MoodLabel
	}
	if on("pickup") {
		out.PickupType, out.PickupPerson, out.PickupTime = in.PickupType, nil, nil
		if in.PickupType != nil {
			switch *in.PickupType {
			case "1":
				// いつもどおりなら、人と時刻は持たない
			case "2":
				if in.PickupPerson == nil || in.PickupTime == nil {
					return out, msgPickupRequired
				}
				if tooLong(*in.PickupPerson, 50) {
					return out, msgPickupPersonTooLong
				}
				if !isHHmm10(*in.PickupTime) {
					return out, msgBadChoice
				}
				out.PickupPerson, out.PickupTime = in.PickupPerson, in.PickupTime
			default:
				return out, msgBadChoice
			}
		}
	}
	if on("message") {
		if in.Message != nil && tooLong(*in.Message, 500) {
			return out, msgHomeMessageTooLong
		}
		out.Message = in.Message
	}
	return out, ""
}

// PUT /api/contact/children/{childID}/home（家庭から）。ページはサーバの今日（要求に日付を持たない）
func (a *app) handleSaveHome(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	acc := a.contactAccess(u, childID)
	if !u.isGuardian() || !acc.Read {
		writeForbidden(w, msgContactForbidden)
		return
	}
	if !acc.Write {
		writeForbidden(w, msgContactGraceReadOnly)
		return
	}
	var in contactHomeInput
	if !readJSON(w, r, &in) {
		return
	}
	day := today()
	old, err := a.loadContactHome(childID, day)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	v, msg := a.checkHomeInput(in, old)
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	// 父母が同時に直したとき（読んだ版が今の行と違う）
	if old != nil && (in.UpdatedAt == nil || *in.UpdatedAt != old.UpdatedAt) {
		writeJSON(w, http.StatusConflict, apiError{Message: msgHomeConflict, Kind: kindVersionConflict})
		return
	}
	at := now()
	// 検査と書き込みのあいだに、ほかのご家族の送信が入ったら書き込まない（同時編集の検出。基本設計書 (4-2)）。
	// 初めての行は一意の制約（園児×日）が、送り直しは読んだ版（updated_at）の条件が止める
	conflict := false
	if old == nil {
		_, err = a.db.Exec(`INSERT INTO t_contact_home (child_id, contact_date, guardian_id, temperature, night_sleep_from, night_sleep_to,
			breakfast, mood_label, pickup_type, pickup_person, pickup_time, message, submitted_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			childID, day, u.guardian(), v.Temperature, v.NightSleepFrom, v.NightSleepTo, v.Breakfast, v.MoodLabel,
			v.PickupType, v.PickupPerson, v.PickupTime, v.Message, at, at, at)
		if err != nil {
			if again, _ := a.loadContactHome(childID, day); again != nil {
				conflict, err = true, nil
			}
		}
	} else {
		// 確認済み・更新の行を送り直すと「更新」（確認を外し、revised_at に今）。未確認のままなら未確認（詳細設計書 (3-1)）
		revised := old.RevisedAt
		if old.ConfirmedAt != nil || old.RevisedAt != nil {
			revised = &at
		}
		var res sql.Result
		res, err = a.db.Exec(`UPDATE t_contact_home SET guardian_id = ?, temperature = ?, night_sleep_from = ?, night_sleep_to = ?,
			breakfast = ?, mood_label = ?, pickup_type = ?, pickup_person = ?, pickup_time = ?, message = ?, submitted_at = ?,
			confirmed_staff_id = NULL, confirmed_at = NULL, revised_at = ?, updated_at = ?
			WHERE contact_home_id = ? AND updated_at = ?`,
			u.guardian(), v.Temperature, v.NightSleepFrom, v.NightSleepTo, v.Breakfast, v.MoodLabel,
			v.PickupType, v.PickupPerson, v.PickupTime, v.Message, at, revised, at, old.ID, old.UpdatedAt)
		if err == nil {
			if n, _ := res.RowsAffected(); n == 0 {
				conflict = true
			}
		}
	}
	if conflict {
		writeJSON(w, http.StatusConflict, apiError{Message: msgHomeConflict, Kind: kindVersionConflict})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	saved, err := a.loadContactHome(childID, day)
	if err != nil || saved == nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	// 送り直しの前の値と、外れた確認（誰が・いつ）を before_value に残す（詳細設計書 (3-1)）
	if old == nil {
		a.log(u.AccountID, fnContact, opCreate, "t_contact_home", i64(saved.ID), &childID, nil, s(jsonText(homeLogValue(saved))))
	} else {
		a.log(u.AccountID, fnContact, opUpdate, "t_contact_home", i64(saved.ID), &childID, s(jsonText(homeLogValue(old))), s(jsonText(homeLogValue(saved))))
	}
	a.notifyContactChild(childID, "home")
	writeJSON(w, http.StatusOK, a.homeView(saved, false))
}

// homeLogValue は操作ログに残す家庭からの値（確認した職員の ID を含む）
func homeLogValue(h *contactHomeRow) map[string]any {
	return map[string]any{
		"guardian_id": h.GuardianID, "temperature": h.Temperature, "night_sleep_from": h.NightSleepFrom, "night_sleep_to": h.NightSleepTo,
		"breakfast": h.Breakfast, "mood_label": h.MoodLabel, "pickup_type": h.PickupType, "pickup_person": h.PickupPerson,
		"pickup_time": h.PickupTime, "message": h.Message, "submitted_at": h.SubmittedAt,
		"confirmed_staff_id": h.ConfirmedStaffID, "confirmed_at": h.ConfirmedAt, "revised_at": h.RevisedAt,
	}
}

// POST /api/contact/home/{id}/confirm（確認しました）。画面が読んだ版を付けて送る（決めたこと D-16）。
// 前の日のページでも押せる（決めたこと D-24）。外す操作は持たない
func (a *app) handleConfirmHome(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	var childID, date string
	if !valid || !u.isStaff() ||
		a.db.QueryRow(`SELECT child_id, contact_date FROM t_contact_home WHERE contact_home_id = ?`, id).Scan(&childID, &date) != nil ||
		!a.contactAccess(u, childID).Write {
		writeForbidden(w, msgContactForbidden)
		return
	}
	var in struct {
		UpdatedAt string `json:"updated_at"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	h, err := a.loadContactHome(childID, date)
	if err != nil || h == nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	// すでに確認済みなら書き換えない。知らせも送らない（二重の確認）
	if h.ConfirmedAt != nil {
		writeJSON(w, http.StatusOK, a.homeView(h, true))
		return
	}
	if in.UpdatedAt != h.UpdatedAt {
		writeJSON(w, http.StatusConflict, apiError{Message: msgConfirmConflict, Kind: kindVersionConflict})
		return
	}
	at := now()
	// 読んだ版のまま、まだ確認されていないときだけ書く（あいだに保護者が直していたら 409）
	res, err := a.db.Exec(`UPDATE t_contact_home SET confirmed_staff_id = ?, confirmed_at = ?, updated_at = ?
		WHERE contact_home_id = ? AND confirmed_at IS NULL AND updated_at = ?`, u.staff(), at, at, id, in.UpdatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if cur, _ := a.loadContactHome(childID, date); cur != nil && cur.ConfirmedAt != nil {
			writeJSON(w, http.StatusOK, a.homeView(cur, true))
			return
		}
		writeJSON(w, http.StatusConflict, apiError{Message: msgConfirmConflict, Kind: kindVersionConflict})
		return
	}
	a.log(u.AccountID, fnContact, opUpdate, "t_contact_home", i64(id), &childID, nil, s(jsonText(map[string]string{"確認": "確認しました"})))
	a.notifyContactChild(childID, "home")
	h, _ = a.loadContactHome(childID, date)
	writeJSON(w, http.StatusOK, a.homeView(h, true))
}
