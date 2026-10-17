package main

import "net/http"

/*
ねた・おきたの訂正・取り消し（詳細設計書「午睡（ねた・おきた・対象外）」(4-6 (4))・「午睡の園児」(3-4)・
「訂正・取り消しのまとめ」(3-5)、基本設計書「取り消し・訂正」(4-5)）。

押し間違いを直す道。実施の後も直せる（実施中に限るのは記録を足すほう）。おきたが無いまま実施が終わった組に
「おきた」を入れるのもここで行う（おきたを推測で入れない。人が時刻を入れる）。
直せるのは、その日（実施の日）はその園児のクラスの担任（押した職員に限らない）、管理者はいつでも（canFixContact）。
保護者には「訂正しました（時刻）」が出る。取り消した組は保護者の画面から消える。
知らせは nap（職員）と contact（職員と保護者）の両方。モックは web/src/api/mock.ts の correctSleep・cancelSleep。
*/

// sleepTarget は、訂正・取り消しの相手の組と実施の日・クラスを読み、直せる人かを確かめる。だめなら応答を書いて nil を返す
func (a *app) sleepTarget(w http.ResponseWriter, r *http.Request, u *SessionUser) (*napSleepOut, string, int64) {
	id, valid := pathInt64(r, "id")
	var sleep *napSleepOut
	var err error
	if valid {
		sleep, err = a.loadNapSleep(id)
	}
	if !valid || err != nil || sleep.IsDeleted || !a.contactAccess(u, sleep.ChildID).Read {
		writeForbidden(w, msgContactForbidden)
		return nil, "", 0
	}
	var sessionDate string
	var classID int64
	if a.db.QueryRow(`SELECT session_date, class_id FROM t_nap_session WHERE nap_session_id = ?`, sleep.NapSessionID).
		Scan(&sessionDate, &classID) != nil {
		writeForbidden(w, msgContactForbidden)
		return nil, "", 0
	}
	if !a.canFixContact(u, sleep.ChildID, sessionDate) {
		writeForbidden(w, msgFixForbidden)
		return nil, "", 0
	}
	return sleep, sessionDate, classID
}

func sleepLogFields(sleptAt string, wokeAt *string) []field {
	return []field{{"slept_at", sleptAt}, {"woke_at", wokeAt}}
}

// POST /api/nap/sleeps/{id}/correct。要求 { slept_at?, woke_at?, updated_at }。slept_at < woke_at ≦ サーバの今、両方とも実施の日の中
func (a *app) handleCorrectSleep(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	sleep, sessionDate, classID := a.sleepTarget(w, r, u)
	if sleep == nil {
		return
	}
	var in struct {
		SleptAt   *string `json:"slept_at"`
		WokeAt    *string `json:"woke_at"`
		UpdatedAt string  `json:"updated_at"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.SleptAt == nil && in.WokeAt == nil {
		writeErr(w, http.StatusBadRequest, msgBadChoice)
		return
	}
	sleptAt, wokeAt := sleep.SleptAt, sleep.WokeAt
	if in.SleptAt != nil {
		sleptAt = *in.SleptAt
	}
	if in.WokeAt != nil {
		wokeAt = in.WokeAt
	}
	if !inDayUntilNow(sleptAt, sessionDate) || (wokeAt != nil && !inDayUntilNow(*wokeAt, sessionDate)) {
		writeErr(w, http.StatusBadRequest, msgEventTimeRange)
		return
	}
	if wokeAt != nil && *wokeAt <= sleptAt {
		writeErr(w, http.StatusBadRequest, msgWakeBeforeSleep)
		return
	}
	at := now()
	// おきたを新しく入れたときは、入れた職員を woke_staff_id に残す
	res, err := a.db.Exec(`UPDATE t_nap_sleep SET slept_at = ?, woke_at = ?,
		woke_staff_id = CASE WHEN woke_staff_id IS NULL AND ? IS NOT NULL THEN ? ELSE woke_staff_id END,
		corrected_at = ?, updated_at = ? WHERE nap_sleep_id = ? AND is_deleted = 0 AND updated_at = ?`,
		sleptAt, wokeAt, wokeAt, u.staff(), at, at, sleep.ID, in.UpdatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, http.StatusConflict, apiError{Message: msgFixConflict, Kind: kindVersionConflict})
		return
	}
	before, after := changedFields(sleepLogFields(sleep.SleptAt, sleep.WokeAt), sleepLogFields(sleptAt, wokeAt))
	a.log(u.AccountID, fnNap, opUpdate, "t_nap_sleep", i64(sleep.ID), &sleep.ChildID, s(before), s(after))
	a.notifyNapChild(classID, sleep.ChildID)
	a.notifyContactChild(sleep.ChildID, "nap")
	v, err := a.loadNapSleep(sleep.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// POST /api/nap/sleeps/{id}/cancel。is_deleted を立てる。応答 { ok, read_family_count }
func (a *app) handleCancelSleep(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	sleep, sessionDate, classID := a.sleepTarget(w, r, u)
	if sleep == nil {
		return
	}
	families, _ := a.readersOf([]string{sleep.ChildID}, sessionDate, sleep.SleptAt)
	if _, err := a.db.Exec(`UPDATE t_nap_sleep SET is_deleted = 1, updated_at = ? WHERE nap_sleep_id = ? AND is_deleted = 0`,
		now(), sleep.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	a.log(u.AccountID, fnNap, opDelete, "t_nap_sleep", i64(sleep.ID), &sleep.ChildID,
		s(fieldsJSON(sleepLogFields(sleep.SleptAt, sleep.WokeAt))), nil)
	a.notifyNapChild(classID, sleep.ChildID)
	a.notifyContactChild(sleep.ChildID, "nap")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "read_family_count": families})
}

// GET /api/nap/sleeps/{id}/readers。取り消しの確認に、いま読んでいる家庭の数を出す
// （詳細設計書「訂正・取り消し」(4-7 (3)) の数え方を、ねた・おきたにも当てた）
func (a *app) handleSleepReaders(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	var sleep *napSleepOut
	var err error
	if valid {
		sleep, err = a.loadNapSleep(id)
	}
	var sessionDate string
	if !valid || err != nil || sleep.IsDeleted || !a.contactAccess(u, sleep.ChildID).Read ||
		a.db.QueryRow(`SELECT session_date FROM t_nap_session WHERE nap_session_id = ?`, sleep.NapSessionID).Scan(&sessionDate) != nil {
		writeForbidden(w, msgContactForbidden)
		return
	}
	families, guardians := a.readersOf([]string{sleep.ChildID}, sessionDate, sleep.SleptAt)
	writeJSON(w, http.StatusOK, map[string]int{"family_count": families, "guardian_count": guardians})
}
