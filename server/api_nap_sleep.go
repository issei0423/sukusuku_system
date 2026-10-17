package main

import (
	"database/sql"
	"net/http"
	"time"
)

/*
ねた・おきた（詳細設計書「午睡の園児」(3-4)・「午睡（ねた・おきた・対象外）」(4-6)、基本設計書「ねた・おきた」(4-8)）。

5分ごとの確認（t_nap_record）と監査の記録はそのまま残し、伝える層の t_nap_sleep を足す。
時刻はサーバの今で打つ（画面は端末の時計で記録の時刻を作らない）。入眠時の体温は求めない（決めたこと D-7）。
知らせは nap（職員だけ）と contact（職員と保護者）の両方（詳細設計書「知らせの種類と送り先」(6-2)）。
モックは web/src/api/mock.ts の sleep・wake が同じ規則を持つ。
*/

// napSleepTarget は、記録してよい実施と園児かを確かめる。だめなら応答を書いて false を返す
func (a *app) napSleepTarget(w http.ResponseWriter, u *SessionUser, sessionID int64, childID string) (int64, bool) {
	a.autoCloseNapSessions()
	var classID int64
	var ended sql.NullString
	if err := a.db.QueryRow(`SELECT class_id, ended_at FROM t_nap_session WHERE nap_session_id = ?`, sessionID).Scan(&classID, &ended); err != nil {
		writeErr(w, http.StatusBadRequest, msgNapNotStarted)
		return 0, false
	}
	var enrolled int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_class_child WHERE class_id = ? AND child_id = ?`, classID, childID).Scan(&enrolled)
	// フリーの職員は読めるが書けない（contactAccess の Write）。クラスを扱えない職員も同じ
	if !a.canUseClass(u, classID) || enrolled == 0 || !a.contactAccess(u, childID).Write {
		writeForbidden(w, msgContactForbidden)
		return 0, false
	}
	if ended.Valid {
		writeJSON(w, http.StatusConflict, apiError{Message: msgSessionEnded, Kind: kindSessionEnded})
		return 0, false
	}
	return classID, true
}

func (a *app) loadNapSleep(id int64) (*napSleepOut, error) {
	var v napSleepOut
	err := a.db.QueryRow(`SELECT s.nap_sleep_id, s.child_id, s.slept_at, s.woke_at, s.sleep_temperature, s.nap_session_id,
		s.corrected_at, s.is_deleted, n.ended_at IS NOT NULL
		FROM t_nap_sleep s JOIN t_nap_session n ON n.nap_session_id = s.nap_session_id WHERE s.nap_sleep_id = ?`, id).
		Scan(&v.ID, &v.ChildID, &v.SleptAt, &v.WokeAt, &v.SleepTemperature, &v.NapSessionID, &v.CorrectedAt, &v.IsDeleted, &v.SessionEnded)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// POST /api/nap/session/{id}/sleeps（ねた）。要求 { child_id }
func (a *app) handleSleep(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	sessionID, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, msgNapNotStarted)
		return
	}
	var in struct {
		ChildID string `json:"child_id"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	classID, ok := a.napSleepTarget(w, u, sessionID, in.ChildID)
	if !ok {
		return
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_exclusion WHERE nap_session_id = ? AND child_id = ? AND is_deleted = 0`, sessionID, in.ChildID).Scan(&n)
	if n > 0 {
		writeJSON(w, http.StatusConflict, apiError{Message: msgSleepExcluded, Kind: kindAlreadyExists})
		return
	}
	a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_sleep WHERE nap_session_id = ? AND child_id = ? AND woke_at IS NULL AND is_deleted = 0`,
		sessionID, in.ChildID).Scan(&n)
	if n > 0 {
		writeJSON(w, http.StatusConflict, apiError{Message: msgSleepTwice, Kind: kindAlreadyExists})
		return
	}
	at := now()
	res, err := a.db.Exec(`INSERT INTO t_nap_sleep (nap_session_id, child_id, slept_at, slept_staff_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)`, sessionID, in.ChildID, at, u.staff(), at, at)
	if err != nil {
		// 同時に押されたときは部分一意の索引（ux_nap_sleep_open）が止める
		writeJSON(w, http.StatusConflict, apiError{Message: msgSleepTwice, Kind: kindAlreadyExists})
		return
	}
	id, _ := res.LastInsertId()
	a.log(u.AccountID, fnNap, opCreate, "t_nap_sleep", i64(id), &in.ChildID, nil, s(jsonText(map[string]string{"slept_at": at})))
	a.notifyNapChild(classID, in.ChildID)
	a.notifyContactChild(in.ChildID, "nap")
	v, err := a.loadNapSleep(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// POST /api/nap/sleeps/{id}/wake（おきた）。woke_at は slept_at より後（同じ秒なら1秒足す）
func (a *app) handleWake(w http.ResponseWriter, r *http.Request) {
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
	if !valid || err != nil || sleep.IsDeleted {
		writeForbidden(w, msgContactForbidden)
		return
	}
	classID, ok := a.napSleepTarget(w, u, sleep.NapSessionID, sleep.ChildID)
	if !ok {
		return
	}
	if sleep.WokeAt != nil {
		writeJSON(w, http.StatusConflict, apiError{Message: msgWokeTwice, Kind: kindAlreadyExists})
		return
	}
	at := now()
	if at <= sleep.SleptAt {
		t, _ := time.ParseInLocation("2006-01-02T15:04:05", sleep.SleptAt, jst)
		at = t.Add(time.Second).Format("2006-01-02T15:04:05")
	}
	res, err := a.db.Exec(`UPDATE t_nap_sleep SET woke_at = ?, woke_staff_id = ?, updated_at = ?
		WHERE nap_sleep_id = ? AND woke_at IS NULL AND is_deleted = 0`, at, u.staff(), now(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, http.StatusConflict, apiError{Message: msgWokeTwice, Kind: kindAlreadyExists})
		return
	}
	a.log(u.AccountID, fnNap, opUpdate, "t_nap_sleep", i64(id), &sleep.ChildID,
		s(jsonText(map[string]any{"woke_at": nil})), s(jsonText(map[string]string{"woke_at": at})))
	a.notifyNapChild(classID, sleep.ChildID)
	a.notifyContactChild(sleep.ChildID, "nap")
	v, _ := a.loadNapSleep(id)
	writeJSON(w, http.StatusOK, v)
}

// napSessionSleeps は、その実施の園児の、取り消していない「ねた・おきた」（入眠時の体温を含む。職員だけ）
func (a *app) napSessionSleeps(sessionID int64, childID string) []napSleepOut {
	rows, err := a.db.Query(`SELECT s.nap_sleep_id, s.child_id, s.slept_at, s.woke_at, s.sleep_temperature, s.nap_session_id,
		s.corrected_at, s.is_deleted, n.ended_at IS NOT NULL
		FROM t_nap_sleep s JOIN t_nap_session n ON n.nap_session_id = s.nap_session_id
		WHERE s.nap_session_id = ? AND s.child_id = ? AND s.is_deleted = 0 ORDER BY s.slept_at, s.nap_sleep_id`, sessionID, childID)
	out := []napSleepOut{}
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var v napSleepOut
		if rows.Scan(&v.ID, &v.ChildID, &v.SleptAt, &v.WokeAt, &v.SleepTemperature, &v.NapSessionID, &v.CorrectedAt, &v.IsDeleted, &v.SessionEnded) == nil {
			out = append(out, v)
		}
	}
	return out
}

// napSessionExclusion は、その実施の園児の、取り消していない「対象外」
func (a *app) napSessionExclusion(sessionID int64, childID string) *napExclusionOut {
	var x napExclusionOut
	if a.db.QueryRow(`SELECT nap_exclusion_id, nap_session_id, child_id, reason, staff_id, is_deleted
		FROM t_nap_exclusion WHERE nap_session_id = ? AND child_id = ? AND is_deleted = 0
		ORDER BY nap_exclusion_id DESC LIMIT 1`, sessionID, childID).
		Scan(&x.ID, &x.NapSessionID, &x.ChildID, &x.Reason, &x.StaffID, &x.IsDeleted) != nil {
		return nil
	}
	return &x
}

/*
きょうは対象外（詳細設計書「午睡（ねた・おきた・対象外）」(4-6 (5))）。監査の層であり、保護者へは返さない。
知らせは nap だけ（職員だけ）。対象外の子はタイマーと未記録の数から外す（画面）。
*/

// POST /api/nap/session/{id}/exclusions。要求 { child_id, reason: '1' | '2' }（1:欠席 2:午睡なし）
func (a *app) handleExclude(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	sessionID, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, msgNapNotStarted)
		return
	}
	var in struct {
		ChildID string `json:"child_id"`
		Reason  string `json:"reason"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Reason != "1" && in.Reason != "2" {
		writeErr(w, http.StatusBadRequest, msgBadChoice)
		return
	}
	classID, ok := a.napSleepTarget(w, u, sessionID, in.ChildID)
	if !ok {
		return
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_sleep WHERE nap_session_id = ? AND child_id = ? AND is_deleted = 0`, sessionID, in.ChildID).Scan(&n)
	if n > 0 {
		writeErr(w, http.StatusBadRequest, msgExcludeAfterSleep)
		return
	}
	at := now()
	res, err := a.db.Exec(`INSERT INTO t_nap_exclusion (nap_session_id, child_id, reason, staff_id, created_at) VALUES (?, ?, ?, ?, ?)`,
		sessionID, in.ChildID, in.Reason, u.staff(), at)
	if err != nil {
		// 取り消していない対象外は1つだけ（部分一意の索引 ux_nap_exclusion_alive）
		writeJSON(w, http.StatusConflict, apiError{Message: msgExcludedTwice, Kind: kindAlreadyExists})
		return
	}
	id, _ := res.LastInsertId()
	a.log(u.AccountID, fnNap, opCreate, "t_nap_exclusion", i64(id), &in.ChildID, nil, s(jsonText(map[string]string{"reason": in.Reason})))
	a.notifyNapChild(classID, in.ChildID)
	x := a.napSessionExclusion(sessionID, in.ChildID)
	writeJSON(w, http.StatusOK, x)
}

// POST /api/nap/exclusions/{id}/cancel（戻す）。実施中だけ
func (a *app) handleCancelExclusion(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	var sessionID int64
	var childID, reason string
	if !valid || a.db.QueryRow(`SELECT nap_session_id, child_id, reason FROM t_nap_exclusion WHERE nap_exclusion_id = ? AND is_deleted = 0`, id).
		Scan(&sessionID, &childID, &reason) != nil {
		writeForbidden(w, msgContactForbidden)
		return
	}
	classID, ok := a.napSleepTarget(w, u, sessionID, childID)
	if !ok {
		return
	}
	if _, err := a.db.Exec(`UPDATE t_nap_exclusion SET is_deleted = 1 WHERE nap_exclusion_id = ? AND is_deleted = 0`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	a.log(u.AccountID, fnNap, opDelete, "t_nap_exclusion", i64(id), &childID, s(jsonText(map[string]string{"reason": reason})), nil)
	a.notifyNapChild(classID, childID)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
