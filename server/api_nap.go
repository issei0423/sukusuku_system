package main

import (
	"database/sql"
	"net/http"
	"strings"
)

/*
 * 午睡チェック
 * 典拠：基本設計書.md「午睡チェック」(4-7)・「午睡チェック」(5-6)
 *      図/画面詳細図.md「午睡チェック画面」(5-1)
 */

// NapSession は午睡の実施（t_nap_session）。開始・終了の操作を保持する
type NapSession struct {
	NapSessionID   int64   `json:"nap_session_id"`
	ClassID        int64   `json:"class_id"`
	SessionDate    string  `json:"session_date"`
	StartedStaffID string  `json:"started_staff_id"`
	StartedAt      string  `json:"started_at"`
	EndedStaffID   *string `json:"ended_staff_id"`
	EndedAt        *string `json:"ended_at"`
	IsAutoClosed   bool    `json:"is_auto_closed"`
}

// NapRecord は午睡の記録（t_nap_record）。チェック時刻と保存時刻の両方を保持する
type NapRecord struct {
	NapRecordID  int64    `json:"nap_record_id"`
	NapSessionID int64    `json:"nap_session_id"`
	ChildID      string   `json:"child_id"`
	CheckedAt    string   `json:"checked_at"`
	SavedAt      string   `json:"saved_at"`
	BodyPosition string   `json:"body_position"`
	Breathing    string   `json:"breathing"`
	Complexion   string   `json:"complexion"`
	Temperature  *float64 `json:"temperature"`
	StaffID      string   `json:"staff_id"`
}

func (a *app) handleActiveNapSession(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	classID, _ := queryInt64(r, "class_id")
	date := r.URL.Query().Get("date")
	if date == "" {
		date = today()
	}
	s, err := a.napSession(classID, date)
	if err != nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (a *app) napSession(classID int64, date string) (*NapSession, error) {
	a.autoCloseNapSessions()
	var (
		s        NapSession
		endStaff sql.NullString
		endAt    sql.NullString
	)
	err := a.db.QueryRow(`SELECT nap_session_id, class_id, session_date, started_staff_id, started_at,
		ended_staff_id, ended_at, is_auto_closed
		FROM t_nap_session WHERE class_id = ? AND session_date = ? AND ended_at IS NULL`, classID, date).
		Scan(&s.NapSessionID, &s.ClassID, &s.SessionDate, &s.StartedStaffID, &s.StartedAt,
			&endStaff, &endAt, &s.IsAutoClosed)
	if err != nil {
		return nil, err
	}
	s.EndedStaffID = nullStr(endStaff)
	s.EndedAt = nullStr(endAt)
	return &s, nil
}

/*
napAutoCloseAt は、終了操作を忘れた実施を自動で解除する時刻と、そのとき記録する終了時刻を返す。

終了操作を忘れた場合は、午睡の時間帯（マスタ値 nap.time_range）の終了時刻で解除する
（基本設計書「午睡チェックの実施」(4-7)）。解除しないと実施中の扱いが残り、
共用のタブレットが自動ログアウトの対象外のままになる。

【仮置き】時間帯の終了時刻より後に開始した実施は、開始した時点で解除の時刻を過ぎている。
開始した直後に解除しないよう、その日の終わりに解除する（web/仮置き値.md）。
画面側（web/src/api/util.ts の napAutoCloseAt）と同じ規則にしてある。
*/
func napAutoCloseAt(sessionDate, startedAt, timeRange string) (closeAt, endedAt string) {
	end := "15:00"
	if i := strings.Index(timeRange, "-"); i >= 0 && len(strings.TrimSpace(timeRange[i+1:])) == 5 {
		end = strings.TrimSpace(timeRange[i+1:])
	}
	rangeEnd := sessionDate + "T" + end + ":00"
	if startedAt < rangeEnd {
		return rangeEnd, rangeEnd
	}
	dayEnd := sessionDate + "T23:59:59"
	return dayEnd, dayEnd
}

// autoCloseNapSessions は、解除の時刻を過ぎた実施中の午睡チェックを終了にする
func (a *app) autoCloseNapSessions() {
	rows, err := a.db.Query(`SELECT nap_session_id, session_date, started_at
		FROM t_nap_session WHERE ended_at IS NULL`)
	if err != nil {
		return
	}
	type open struct {
		id          int64
		date, start string
	}
	list := []open{}
	for rows.Next() {
		var x open
		if rows.Scan(&x.id, &x.date, &x.start) == nil {
			list = append(list, x)
		}
	}
	rows.Close()

	timeRange := a.settingText("nap.time_range", "13:00-15:00")
	for _, x := range list {
		closeAt, endedAt := napAutoCloseAt(x.date, x.start, timeRange)
		if now() <= closeAt {
			continue
		}
		// 終了した職員はいないため ended_staff_id は空のままにし、自動で解除した印を立てる
		a.db.Exec(`UPDATE t_nap_session SET ended_at = ?, is_auto_closed = 1
			WHERE nap_session_id = ? AND ended_at IS NULL`, endedAt, x.id)
	}
}

func (a *app) handleStartNapSession(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var req struct {
		ClassID int64  `json:"class_id"`
		Date    string `json:"date"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Date == "" {
		req.Date = today()
	}
	// すでに実施中なら、それをそのまま返す
	if s, err := a.napSession(req.ClassID, req.Date); err == nil {
		writeJSON(w, http.StatusOK, s)
		return
	}
	res, err := a.db.Exec(`INSERT INTO t_nap_session
		(class_id, session_date, started_staff_id, started_at, is_auto_closed)
		VALUES (?, ?, ?, ?, 0)`, req.ClassID, req.Date, u.staff(), now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "午睡チェックを開始できませんでした")
		return
	}
	id, _ := res.LastInsertId()
	a.log(u.AccountID, fnNap, opCreate, "t_nap_session", i64(id), nil, nil,
		s("午睡チェックを開始（"+a.className(req.ClassID)+"）"))

	got, _ := a.napSession(req.ClassID, req.Date)
	writeJSON(w, http.StatusOK, got)
}

func (a *app) handleEndNapSession(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "午睡チェックの指定が正しくありません")
		return
	}
	if _, err := a.db.Exec(`UPDATE t_nap_session SET ended_staff_id = ?, ended_at = ?
		WHERE nap_session_id = ?`, u.staff(), now(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "終了できませんでした")
		return
	}
	a.log(u.AccountID, fnNap, opUpdate, "t_nap_session", i64(id), nil, s("実施中"), s("終了"))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// NapChildState は園児カードの状態。直近の記録が無ければ latest は null（画面詳細図 5-1）
type NapChildState struct {
	Child  Child      `json:"child"`
	Latest *NapRecord `json:"latest"`
}

func (a *app) handleNapClassState(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	classID, _ := queryInt64(r, "class_id")
	sessionID, hasSession := queryInt64(r, "session_id")

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

	out := []NapChildState{}
	for _, c := range children {
		if !inClass[c.ChildID] {
			continue
		}
		out = append(out, NapChildState{Child: c})
	}
	if !hasSession {
		writeJSON(w, http.StatusOK, out)
		return
	}
	// 直近の記録はカーソルを閉じたあとに引く
	for i := range out {
		out[i].Latest = a.latestNapRecord(sessionID, out[i].Child.ChildID)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) latestNapRecord(sessionID int64, childID string) *NapRecord {
	var (
		x    NapRecord
		temp sql.NullFloat64
	)
	err := a.db.QueryRow(`SELECT nap_record_id, nap_session_id, child_id, checked_at, saved_at,
		body_position, breathing, complexion, temperature, staff_id
		FROM t_nap_record WHERE nap_session_id = ? AND child_id = ?
		ORDER BY checked_at DESC, nap_record_id DESC LIMIT 1`, sessionID, childID).
		Scan(&x.NapRecordID, &x.NapSessionID, &x.ChildID, &x.CheckedAt, &x.SavedAt,
			&x.BodyPosition, &x.Breathing, &x.Complexion, &temp, &x.StaffID)
	if err != nil {
		return nil
	}
	x.Temperature = nullFloat(temp)
	return &x
}

/*
handleNapRecord は1件ずつ記録する。

確認画面を挟まない。連続入力を前提とするため（基本設計書「画面の洗い出しの考え方」(3-1) 基準2）。
うつ伏せや呼吸が確認できない場合でも記録自体は妨げない。
警告は注意喚起であって判定ではない（画面詳細図 5-1）。
*/
func (a *app) handleNapRecord(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	sessionID, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "午睡チェックの指定が正しくありません")
		return
	}
	var req struct {
		ChildID      string   `json:"child_id"`
		BodyPosition string   `json:"body_position"`
		Breathing    string   `json:"breathing"`
		Complexion   string   `json:"complexion"`
		Temperature  *float64 `json:"temperature"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	// 体位・呼吸・顔色は、保育士が見て選んだ値だけを受け取る。空のまま既定値で埋めない
	if !oneOf(req.BodyPosition, "1", "2", "3", "4") {
		writeErr(w, http.StatusBadRequest, "体位を選んでください")
		return
	}
	if !oneOf(req.Breathing, "1", "2") {
		writeErr(w, http.StatusBadRequest, "呼吸を選んでください")
		return
	}
	if !oneOf(req.Complexion, "1", "2", "3", "4") {
		writeErr(w, http.StatusBadRequest, "顔色を選んでください")
		return
	}
	if !a.canSeeChild(u, req.ChildID) {
		writeForbidden(w, "この園児を記録する権限がありません")
		return
	}
	res, err := a.db.Exec(`INSERT INTO t_nap_record
		(nap_session_id, child_id, checked_at, saved_at, body_position, breathing, complexion, temperature, staff_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sessionID, req.ChildID, now(), now(), req.BodyPosition, req.Breathing, req.Complexion,
		req.Temperature, u.staff())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "記録に失敗しました")
		return
	}
	id, _ := res.LastInsertId()
	a.log(u.AccountID, fnNap, opCreate, "t_nap_record", i64(id), s(req.ChildID), nil,
		s("体位="+req.BodyPosition+" 呼吸="+req.Breathing+" 顔色="+req.Complexion))

	writeJSON(w, http.StatusOK, a.latestNapRecord(sessionID, req.ChildID))
}

// oneOf は値が選択肢のいずれかであるかを返す
func oneOf(v string, choices ...string) bool {
	for _, c := range choices {
		if v == c {
			return true
		}
	}
	return false
}

// handleNapInterval は年齢に応じたチェック間隔を返す。マスタ値を用いる（基本設計書 5-8）
//
// 【仮置き】クラスと年齢の対応が m_class に無いため、クラス名から引いている（GitHub Issue #59）。
func (a *app) handleNapInterval(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	classID, _ := queryInt64(r, "class_id")
	name := a.className(classID)
	key := "nap.interval_minutes.age2"
	fallback := 15
	switch name {
	case "もも組":
		key, fallback = "nap.interval_minutes.age0", 5
	case "さくら組":
		key, fallback = "nap.interval_minutes.age1", 10
	}
	writeJSON(w, http.StatusOK, map[string]int{"interval_minutes": a.settingInt(key, fallback)})
}

// ---- 異常時の記録（基本設計書「異常時の記録」(4-7)、5-6） ----

type napAbnormalView struct {
	NapAbnormalID int64  `json:"nap_abnormal_id"`
	NapSessionID  int64  `json:"nap_session_id"`
	ChildID       string `json:"child_id"`
	FoundAt       string `json:"found_at"`
	Situation     string `json:"situation"`
	Response      string `json:"response"`
	StaffID       string `json:"staff_id"`
	DiaryID       *int64 `json:"diary_id"`
	ChildName     string `json:"child_name"`
	StaffName     string `json:"staff_name"`
}

func (a *app) handleNapAbnormals(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	rows, err := a.db.Query(`SELECT nap_abnormal_id, nap_session_id, child_id, found_at,
		situation, response, staff_id, diary_id
		FROM t_nap_abnormal ORDER BY found_at DESC`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "異常時の記録を取得できませんでした")
		return
	}
	all := []napAbnormalView{}
	for rows.Next() {
		var (
			x       napAbnormalView
			diaryID sql.NullInt64
		)
		if rows.Scan(&x.NapAbnormalID, &x.NapSessionID, &x.ChildID, &x.FoundAt,
			&x.Situation, &x.Response, &x.StaffID, &diaryID) == nil {
			x.DiaryID = nullInt(diaryID)
			all = append(all, x)
		}
	}
	rows.Close()

	out := []napAbnormalView{}
	for _, x := range all {
		if !a.canSeeChild(u, x.ChildID) {
			continue
		}
		x.ChildName = a.childName(x.ChildID)
		x.StaffName = a.staffName(x.StaffID)
		out = append(out, x)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) handleRecordNapAbnormal(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	sessionID, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "午睡チェックの指定が正しくありません")
		return
	}
	var req struct {
		ChildID   string `json:"child_id"`
		FoundAt   string `json:"found_at"`
		Situation string `json:"situation"`
		Response  string `json:"response"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Situation) == "" {
		writeErr(w, http.StatusBadRequest, "発見時の状況を入力してください")
		return
	}
	if strings.TrimSpace(req.Response) == "" {
		writeErr(w, http.StatusBadRequest, "とった対応を入力してください")
		return
	}
	if !a.canSeeChild(u, req.ChildID) {
		writeForbidden(w, "この園児を記録する権限がありません")
		return
	}
	if req.FoundAt == "" {
		req.FoundAt = now()
	}
	res, err := a.db.Exec(`INSERT INTO t_nap_abnormal
		(nap_session_id, child_id, found_at, situation, response, staff_id)
		VALUES (?, ?, ?, ?, ?, ?)`,
		sessionID, req.ChildID, req.FoundAt, req.Situation, req.Response, u.staff())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "記録に失敗しました")
		return
	}
	id, _ := res.LastInsertId()
	a.log(u.AccountID, fnNap, opCreate, "t_nap_abnormal", i64(id), s(req.ChildID), nil, s("異常時の記録"))
	writeJSON(w, http.StatusOK, map[string]int64{"nap_abnormal_id": id})
}

// handleRaiseIncidentDiary は異常時の記録からヒヤリハットを起票し、相互に参照させる（基本設計書 5-6）
func (a *app) handleRaiseIncidentDiary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	abnormalID, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "異常時の記録の指定が正しくありません")
		return
	}
	var (
		childID   string
		foundAt   string
		situation string
		response  string
		diaryID   sql.NullInt64
		sessionID int64
	)
	err := a.db.QueryRow(`SELECT child_id, found_at, situation, response, diary_id, nap_session_id
		FROM t_nap_abnormal WHERE nap_abnormal_id = ?`, abnormalID).
		Scan(&childID, &foundAt, &situation, &response, &diaryID, &sessionID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "異常時の記録が見つかりません")
		return
	}
	if diaryID.Valid {
		writeErr(w, http.StatusBadRequest, "この記録からはすでにヒヤリハットを起票しています")
		return
	}

	var classID sql.NullInt64
	a.db.QueryRow(`SELECT class_id FROM t_nap_session WHERE nap_session_id = ?`, sessionID).Scan(&classID)

	body := "【発生日時】\n" + strings.Replace(foundAt, "T", " ", 1) +
		"\n\n【状況】\n" + situation +
		"\n\n【とった対応】\n" + response +
		"\n\n【今後の対策】\n"

	res, err := a.db.Exec(`INSERT INTO t_diary
		(record_type, child_id, class_id, diary_date, body, status, created_staff_id,
		 is_shared_to_guardian, nap_abnormal_id, is_deleted, created_at, updated_at)
		VALUES ('4', ?, ?, ?, ?, '1', ?, 0, ?, 0, ?, ?)`,
		childID, classID, foundAt[:10], body, u.staff(), abnormalID, now(), now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "起票に失敗しました")
		return
	}
	newDiaryID, _ := res.LastInsertId()
	a.db.Exec(`UPDATE t_nap_abnormal SET diary_id = ? WHERE nap_abnormal_id = ?`, newDiaryID, abnormalID)

	a.log(u.AccountID, fnDiary, opCreate, "t_diary", i64(newDiaryID), s(childID), nil,
		s("異常時の記録からヒヤリハットを起票"))
	a.writeDiaryByID(w, newDiaryID)
}

/*
handleSearchNapRecords は午睡記録検索画面のためのデータを返す。

チェック時刻と保存時刻の両方を出し、後から入れた記録が分かるようにする（基本設計書 5-6）。
記録は削除できない（同「記録の修正と改ざん防止」(4-7)）ため、削除の導線は持たない。
*/
func (a *app) handleSearchNapRecords(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	q := `SELECT r.nap_record_id, r.nap_session_id, r.child_id, r.checked_at, r.saved_at,
		r.body_position, r.breathing, r.complexion, r.temperature, r.staff_id,
		s.session_date, s.class_id
		FROM t_nap_record r
		JOIN t_nap_session s ON s.nap_session_id = r.nap_session_id
		WHERE 1 = 1`
	args := []any{}
	if v := r.URL.Query().Get("from"); v != "" {
		q += ` AND s.session_date >= ?`
		args = append(args, v)
	}
	if v := r.URL.Query().Get("to"); v != "" {
		q += ` AND s.session_date <= ?`
		args = append(args, v)
	}
	if v, has := queryInt64(r, "class_id"); has {
		q += ` AND s.class_id = ?`
		args = append(args, v)
	}
	q += ` ORDER BY r.checked_at DESC`

	rows, err := a.db.Query(q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "午睡の記録を取得できませんでした")
		return
	}
	type row struct {
		NapRecord
		SessionDate string `json:"session_date"`
		ChildName   string `json:"child_name"`
		ClassName   string `json:"class_name"`
		StaffName   string `json:"staff_name"`
		classID     int64
	}
	all := []row{}
	for rows.Next() {
		var (
			x    row
			temp sql.NullFloat64
		)
		if rows.Scan(&x.NapRecordID, &x.NapSessionID, &x.ChildID, &x.CheckedAt, &x.SavedAt,
			&x.BodyPosition, &x.Breathing, &x.Complexion, &temp, &x.StaffID,
			&x.SessionDate, &x.classID) == nil {
			x.Temperature = nullFloat(temp)
			all = append(all, x)
		}
	}
	rows.Close()

	nameFilter := strings.TrimSpace(r.URL.Query().Get("child_name"))
	out := []row{}
	for _, x := range all {
		if !a.canSeeChild(u, x.ChildID) {
			continue
		}
		x.ChildName = a.childName(x.ChildID)
		if nameFilter != "" && !strings.Contains(x.ChildName, nameFilter) {
			continue
		}
		x.ClassName = a.className(x.classID)
		x.StaffName = a.staffName(x.StaffID)
		out = append(out, x)
	}
	writeJSON(w, http.StatusOK,
		page(out, queryInt(r, "page", 1), a.settingInt("paging.nap_search_per_page", 50)))
}
