package main

import (
	"database/sql"
	"log"
	"math"
	"net/http"
	"sort"
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
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	classID, _ := queryInt64(r, "class_id")
	// 一般（保育士）は自クラスに限る（GitHub Issue #96）
	if !a.canUseClass(u, classID) {
		writeForbidden(w, "このクラスの午睡チェックを参照する権限がありません")
		return
	}
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
		if _, err := a.db.Exec(`UPDATE t_nap_session SET ended_at = ?, is_auto_closed = 1
			WHERE nap_session_id = ? AND ended_at IS NULL`, endedAt, x.id); err != nil {
			// 解除できなかった実施は実施中のまま残る。黙って捨てない（GitHub Issue #99）
			log.Printf("午睡チェックの自動解除に失敗しました（session=%d）: %v", x.id, err)
		}
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
	if !a.canUseClass(u, req.ClassID) {
		writeForbidden(w, "このクラスの午睡チェックを開始する権限がありません")
		return
	}
	// 【仮置き】開始できるのは当日だけとする。過去の日付で開始すると、足した直後に自動で解除され、
	// 呼ぶたびに行が増える（GitHub Issue #97）。記録は起きたときに付けるものである
	if req.Date != today() {
		writeErr(w, http.StatusBadRequest, "午睡チェックは当日のぶんだけ開始できます")
		return
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
	// そのクラスを扱える職員の画面へ知らせる。保護者へは送らない（events.go。詳細設計書「PR #196 からの変更」(6-1)）
	a.notifyNapSession(req.ClassID)

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
	/*
	 * 終了できるのは、そのクラスを扱える職員が、実施中の実施を終了するときに限る。
	 * 一般（保育士）は自クラスに限る（基本設計書「午睡チェックの実施」(4-7)「午睡チェックの開始・参照・記録は、
	 * 一般（保育士）は自クラスに限る」）。開始と取得だけでなく終了も同じ（GitHub Issue #96・#158）。
	 * 終了した実施（自動で解除されたものを含む）は、終了時刻と終了した職員を書き換えない。
	 * 画面側のモック（web/src/api/mock.ts の endSession）と同じ規則
	 */
	a.autoCloseNapSessions()
	var (
		classID int64
		endedAt sql.NullString
	)
	if err := a.db.QueryRow(`SELECT class_id, ended_at FROM t_nap_session WHERE nap_session_id = ?`, id).
		Scan(&classID, &endedAt); err != nil {
		writeErr(w, http.StatusNotFound, "午睡チェックが見つかりません")
		return
	}
	if !a.canUseClass(u, classID) {
		writeForbidden(w, "このクラスの午睡チェックを終了する権限がありません")
		return
	}
	if endedAt.Valid {
		writeErr(w, http.StatusConflict, "この午睡チェックはすでに終了しています。画面を読み込み直してください")
		return
	}
	if _, err := a.db.Exec(`UPDATE t_nap_session SET ended_staff_id = ?, ended_at = ?
		WHERE nap_session_id = ? AND ended_at IS NULL`, u.staff(), now(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "終了できませんでした")
		return
	}
	a.log(u.AccountID, fnNap, opUpdate, "t_nap_session", i64(id), nil, s("実施中"), s("終了"))
	a.notifyNapSession(classID)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// NapChildState は園児カードの状態。直近の記録が無ければ latest は null（画面詳細図 5-1）
// sleeps・exclusion は、ねた・おきたと「きょうは対象外」（詳細設計書「午睡（ねた・おきた・対象外）」(4-6 (6))）
type NapChildState struct {
	Child     Child            `json:"child"`
	Latest    *NapRecord       `json:"latest"`
	Sleeps    []napSleepOut    `json:"sleeps"`
	Exclusion *napExclusionOut `json:"exclusion"`
}

func (a *app) handleNapClassState(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	classID, _ := queryInt64(r, "class_id")
	sessionID, hasSession := queryInt64(r, "session_id")
	if !a.canUseClass(u, classID) {
		writeForbidden(w, "このクラスの午睡チェックを参照する権限がありません")
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

	out := []NapChildState{}
	for _, c := range children {
		if !inClass[c.ChildID] {
			continue
		}
		out = append(out, NapChildState{Child: c, Sleeps: []napSleepOut{}})
	}
	if !hasSession {
		writeJSON(w, http.StatusOK, out)
		return
	}
	// 直近の記録はカーソルを閉じたあとに引く
	for i := range out {
		out[i].Latest = a.latestNapRecord(sessionID, out[i].Child.ChildID)
		out[i].Sleeps = a.napSessionSleeps(sessionID, out[i].Child.ChildID)
		out[i].Exclusion = a.napSessionExclusion(sessionID, out[i].Child.ChildID)
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
	// 体温は小数第1位まで。範囲（30.0〜43.0℃）の外は画面で確かめるだけで、記録は妨げない
	// （基本設計書「入力項目の制約値」(4-9)「体温　30.0〜43.0℃、小数第1位まで」「範囲外でも入力を妨げず、確認を促すだけ」。
	// GitHub Issue #165）。画面側のモック（web/src/api/mock.ts の record）と同じ規則
	if req.Temperature != nil && !oneDecimal(*req.Temperature) {
		writeErr(w, http.StatusBadRequest, "体温は小数第1位までで入力してください")
		return
	}
	if !a.canSeeChild(u, req.ChildID) {
		writeForbidden(w, "この園児を記録する権限がありません")
		return
	}
	// 終了した実施へは記録しない。自動で解除された直後に、開いたままの画面から記録が付くのを防ぐ
	// （GitHub Issue #97）
	a.autoCloseNapSessions()
	var (
		sessionClass int64
		endedAt      sql.NullString
	)
	if err := a.db.QueryRow(`SELECT class_id, ended_at FROM t_nap_session WHERE nap_session_id = ?`,
		sessionID).Scan(&sessionClass, &endedAt); err != nil {
		writeErr(w, http.StatusNotFound, "午睡チェックが見つかりません")
		return
	}
	if !a.canUseClass(u, sessionClass) {
		writeForbidden(w, "このクラスの午睡チェックを記録する権限がありません")
		return
	}
	// 記録は、その園児のクラスの実施に付ける。管理者でも、ほかのクラスの園児を付けさせない
	// （異常時の記録と同じ。GitHub Issue #158・#165）
	var inClass int
	if err := a.db.QueryRow(`SELECT COUNT(*) FROM t_class_child WHERE class_id = ? AND child_id = ?`,
		sessionClass, req.ChildID).Scan(&inClass); err != nil {
		writeErr(w, http.StatusInternalServerError, "記録に失敗しました")
		return
	}
	if inClass == 0 {
		writeErr(w, http.StatusBadRequest, "この園児のクラスの午睡チェックではありません。園児のクラスの午睡チェックへ記録してください")
		return
	}
	if endedAt.Valid {
		writeErr(w, http.StatusConflict, "この午睡チェックは終了しています。画面を読み込み直してください")
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
	// その園児を参照できる職員の画面へ知らせる。5分ごとの確認は監査の層で、保護者へは送らない（events.go）
	a.notifyNapChild(sessionClass, req.ChildID)

	writeJSON(w, http.StatusOK, a.latestNapRecord(sessionID, req.ChildID))
}

// oneDecimal は、値が小数第1位までで表せるかを返す。浮動小数の誤差（36.7 が 36.700000000000003 になるなど）は許す
func oneDecimal(v float64) bool {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return false
	}
	return math.Abs(v*10-math.Round(v*10)) < 1e-6
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
// 年齢はクラスの年齢児（m_class.age_class）から引く。0歳児は age0、1歳児は age1、
// 2歳児以上は age2 のマスタ値を使う（基本設計書「クラスと紐づけ」(5-3)）。
func (a *app) handleNapInterval(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	classID, _ := queryInt64(r, "class_id")
	ageClass := 2
	a.db.QueryRow(`SELECT age_class FROM m_class WHERE class_id = ?`, classID).Scan(&ageClass)
	key := "nap.interval_minutes.age2"
	fallback := 15
	switch ageClass {
	case 0:
		key, fallback = "nap.interval_minutes.age0", 5
	case 1:
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
	RecordedAt    string `json:"recorded_at"`
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
	// 【仮置き】並びは発見時刻の新しい順、同じ時刻はあとで記録したものを先にする（web/仮置き値.md「一覧の並び順」）。
	// 同じ時刻の並びを決めておかないと、モック（web/src/api/mock.ts の abnormals）と食い違う（GitHub Issue #177 の 7）
	rows, err := a.db.Query(`SELECT nap_abnormal_id, nap_session_id, child_id, found_at, recorded_at,
		situation, response, staff_id, diary_id
		FROM t_nap_abnormal ORDER BY found_at DESC, nap_abnormal_id DESC`)
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
		if rows.Scan(&x.NapAbnormalID, &x.NapSessionID, &x.ChildID, &x.FoundAt, &x.RecordedAt,
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

/*
incidentSituationResponse は、ヒヤリハットの本文から「【状況】」と「【とった対応】」の見出しの下の文を取り出す。

本文は見出しを付けてつないで持つ（基本設計書「ヒヤリハットの記録」(4-6)、詳細設計書「日誌」(4-13) の (1)
「ヒヤリハットの本文」）。見出しは「【〇〇】」だけの行とし、次の見出しの行までをその見出しの文とする。
見出しが無いときは空の文を返す。画面側のモック（web/src/api/mock.ts の incidentSituationResponse）と同じ規則
*/
func incidentSituationResponse(body string) (situation, response string) {
	sections := map[string][]string{}
	current := ""
	for _, line := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		if t := strings.TrimSpace(line); isIncidentHeading(t) {
			current = t
			continue
		}
		if current != "" {
			sections[current] = append(sections[current], line)
		}
	}
	join := func(heading string) string {
		return strings.TrimSpace(strings.Join(sections[heading], "\n"))
	}
	return join("【状況】"), join("【とった対応】")
}

// isIncidentHeading は、行が「【〇〇】」だけの見出しかを返す
func isIncidentHeading(t string) bool {
	if !strings.HasPrefix(t, "【") || !strings.HasSuffix(t, "】") {
		return false
	}
	inner := strings.TrimSuffix(strings.TrimPrefix(t, "【"), "】")
	return inner != "" && !strings.ContainsAny(inner, "【】")
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
	if tooLong(req.Situation, 1000) || tooLong(req.Response, 1000) {
		writeErr(w, http.StatusBadRequest, "発見時の状況と、とった対応は、それぞれ1,000文字以内で入力してください")
		return
	}
	if strings.TrimSpace(req.Response) == "" {
		writeErr(w, http.StatusBadRequest, "とった対応を入力してください")
		return
	}
	if req.FoundAt == "" {
		req.FoundAt = now()
	}
	if msg := foundAtProblem(req.FoundAt); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	if !a.canSeeChild(u, req.ChildID) {
		writeForbidden(w, "この園児を記録する権限がありません")
		return
	}
	/*
	 * 記録は、その園児のクラスの、実施中の午睡チェックにつなぐ（GitHub Issue #158）。
	 * 起票するヒヤリハットの「対象のクラス」は実施のクラスから引くため、別のクラスの実施へ付けると
	 * 園児と違うクラスの記録になる。終了した実施へは記録しない（午睡の記録と同じ。基本設計書「午睡チェックの実施」(4-7)）。
	 *
	 * 【仮置き】実施中の午睡チェックが無いときは記録できない。記録の操作で午睡チェックを開始しない
	 * （開始は「午睡チェックを開始する」を押したときに限る。同 (4-7) 処理内容 1・2）。web/仮置き値.md
	 * 画面側のモック（web/src/api/mock.ts の recordAbnormal）と同じ規則
	 */
	a.autoCloseNapSessions()
	var (
		sessionClass int64
		endedAt      sql.NullString
	)
	if err := a.db.QueryRow(`SELECT class_id, ended_at FROM t_nap_session WHERE nap_session_id = ?`,
		sessionID).Scan(&sessionClass, &endedAt); err != nil {
		writeErr(w, http.StatusNotFound, "午睡チェックが見つかりません")
		return
	}
	if !a.canUseClass(u, sessionClass) {
		writeForbidden(w, "このクラスの午睡チェックへ記録する権限がありません")
		return
	}
	var inClass int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_class_child WHERE class_id = ? AND child_id = ?`,
		sessionClass, req.ChildID).Scan(&inClass)
	if inClass == 0 {
		writeErr(w, http.StatusBadRequest, "この園児のクラスの午睡チェックではありません。園児のクラスの午睡チェックへ記録してください")
		return
	}
	if endedAt.Valid {
		writeErr(w, http.StatusConflict, "この午睡チェックは終了しています。画面を読み込み直してください")
		return
	}
	res, err := a.db.Exec(`INSERT INTO t_nap_abnormal
		(nap_session_id, child_id, found_at, recorded_at, situation, response, staff_id)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		sessionID, req.ChildID, req.FoundAt, now(), req.Situation, req.Response, u.staff())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "記録に失敗しました")
		return
	}
	id, _ := res.LastInsertId()
	a.log(u.AccountID, fnNap, opCreate, "t_nap_abnormal", i64(id), s(req.ChildID), nil, s("異常時の記録"))
	// 職員の画面（午睡チェック画面の強調・ダッシュボードの「ヒヤリハット未起票」）へ知らせる。
	// 園内の記録のため保護者には送らない（events.go）
	a.notifyNapChild(sessionClass, req.ChildID)
	writeJSON(w, http.StatusOK, map[string]int64{"nap_abnormal_id": id})
}

/*
foundAtProblem は発見時刻を確かめ、受け付けられないときは利用者に見せる文言を返す。

形は 'YYYY-MM-DDTHH:MM:SS'（画面は datetime-local の値に秒を足して送る）。崩れた値を保存すると、
起票のときに記録日を取り出せない（GitHub Issue #158）。未来の日時は認めない
（基本設計書「入力項目の制約値」(4-9)「記録日・測定日　未来日は認めない」「記録は起きたことを書くものである」）。

【仮置き】未来かどうかは分の単位で比べる。画面が送る値は分までで、端末とサーバの時計のわずかなずれで
今の時刻を断らないようにするため（web/仮置き値.md）。画面側のモック（web/src/api/mock.ts）と同じ規則
*/
func foundAtProblem(v string) string {
	if !isISODateTime(v) {
		return "発見時刻の形式が正しくありません"
	}
	if v[:16] > now()[:16] {
		return "発見時刻に未来の日時は指定できません"
	}
	return ""
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
	// 起票できるのは、その園児を参照できる職員に限る。一般（保育士）は自クラスの園児のみ
	// （基本設計書「権限と利用可能機能」(6-1)「異常時の記録　一般 ※1」。GitHub Issue #158）。
	// 拒否するときは、記録の中身も起票済みかどうかも返さない
	if !a.canSeeChild(u, childID) {
		writeForbidden(w, "この園児の記録からヒヤリハットを起票する権限がありません")
		return
	}
	if diaryID.Valid {
		writeErr(w, http.StatusBadRequest, "この記録からはすでにヒヤリハットを起票しています")
		return
	}

	var (
		classID     sql.NullInt64
		sessionDate sql.NullString
	)
	a.db.QueryRow(`SELECT class_id, session_date FROM t_nap_session WHERE nap_session_id = ?`, sessionID).
		Scan(&classID, &sessionDate)

	// 記録日は発見時刻の日付。検査を入れる前に入ってしまった崩れた値では、その実施の日にする。
	// 崩れた値の先頭を切り出してサーバの処理を落とさない（GitHub Issue #158）
	diaryDate := today()
	switch {
	case len(foundAt) >= 10 && isISODate(foundAt[:10]):
		diaryDate = foundAt[:10]
	case sessionDate.Valid && isISODate(sessionDate.String):
		diaryDate = sessionDate.String
	}

	body := "【発生日時】\n" + strings.Replace(foundAt, "T", " ", 1) +
		"\n\n【状況】\n" + situation +
		"\n\n【とった対応】\n" + response +
		"\n\n【今後の対策】\n"

	// 発生日時は発見時刻（詳細設計書「日誌の画面（作り直し）」(2-13 (8))）。場所は【仮置き】（incidentPlaceholder）
	occurredAt, place := incidentPlaceholder("4", foundAt)
	res, err := a.db.Exec(`INSERT INTO t_diary
		(record_type, child_id, class_id, diary_date, body, status, created_staff_id,
		 occurred_at, place, nap_abnormal_id, is_deleted, created_at, updated_at)
		VALUES ('4', ?, ?, ?, ?, '1', ?, ?, ?, ?, 0, ?, ?)`,
		childID, classID, diaryDate, body, u.staff(), occurredAt, place, abnormalID, now(), now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "起票に失敗しました")
		return
	}
	newDiaryID, _ := res.LastInsertId()
	a.db.Exec(`UPDATE t_nap_abnormal SET diary_id = ? WHERE nap_abnormal_id = ?`, newDiaryID, abnormalID)

	a.log(u.AccountID, fnDiary, opCreate, "t_diary", i64(newDiaryID), s(childID), nil,
		s("異常時の記録からヒヤリハットを起票"))
	// 「ヒヤリハット未起票の異常時の記録」が減り、日誌（下書き）が増える（events.go）
	a.notifyNapChild(classID.Int64, childID)
	a.notifyDiary(newDiaryID)
	a.writeDiaryByID(w, newDiaryID)
}

/*
handleSearchNapRecords は午睡記録検索画面のためのデータを返す。

チェック時刻と保存時刻の両方を出し、後から入れた記録が分かるようにする（基本設計書 5-6）。
記録は削除できない（同「記録の修正と改ざん防止」(4-7)）ため、削除の導線は持たない。

5分ごとの確認（t_nap_record）に、ねた・おきた（t_nap_sleep）を同じ一覧の行として並べる。ねたの行には
入眠時の体温（sleep_temperature）を出す（画面詳細図「午睡記録検索画面」(5-3) の項目6「園児ごとの入眠（ねた）と
起床（おきた）、入眠時の体温（ねたの行）…も、その日の行に出す」、基本設計書「帳票の出力」(4-8)）。
取り消した「ねた」（is_deleted = 1）は出さない。期間・クラス・園児名・参照範囲は確認の行と同じ規則で絞る。
きょうは対象外とその理由（t_nap_exclusion）も、押した時刻の行として出す（同 (5-3) の項目6「きょうは対象外とその理由も、
その日の行に出す」）。取り消した対象外は出さない。帳票（api_nap_report.go）と同じ行・同じ並び。
画面側のモック（web/src/api/mock.ts の searchRecords）と同じ規則
*/
func (a *app) handleSearchNapRecords(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	cond := ``
	args := []any{}
	if v := r.URL.Query().Get("from"); v != "" {
		cond += ` AND s.session_date >= ?`
		args = append(args, v)
	}
	if v := r.URL.Query().Get("to"); v != "" {
		cond += ` AND s.session_date <= ?`
		args = append(args, v)
	}
	if v, has := queryInt64(r, "class_id"); has {
		cond += ` AND s.class_id = ?`
		args = append(args, v)
	}

	all := []napSearchRow{}
	rows, err := a.db.Query(`SELECT r.nap_record_id, r.nap_session_id, r.child_id, r.checked_at, r.saved_at,
		r.body_position, r.breathing, r.complexion, r.temperature, r.staff_id,
		s.session_date, s.class_id
		FROM t_nap_record r
		JOIN t_nap_session s ON s.nap_session_id = r.nap_session_id
		WHERE 1 = 1`+cond, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "午睡の記録を取得できませんでした")
		return
	}
	for rows.Next() {
		var (
			x                          napSearchRow
			recordID                   int64
			savedAt                    string
			position, breath, complexn string
			temp                       sql.NullFloat64
		)
		if rows.Scan(&recordID, &x.NapSessionID, &x.ChildID, &x.CheckedAt, &savedAt,
			&position, &breath, &complexn, &temp, &x.StaffID,
			&x.SessionDate, &x.classID) == nil {
			x.Kind = napRowCheck
			x.NapRecordID = &recordID
			x.SavedAt = &savedAt
			x.BodyPosition, x.Breathing, x.Complexion = &position, &breath, &complexn
			x.Temperature = nullFloat(temp)
			all = append(all, x)
		}
	}
	rows.Close()

	sleeps, err := a.db.Query(`SELECT n.nap_sleep_id, n.nap_session_id, n.child_id, n.slept_at, n.woke_at,
		n.sleep_temperature, n.slept_staff_id, n.woke_staff_id, s.session_date, s.class_id
		FROM t_nap_sleep n
		JOIN t_nap_session s ON s.nap_session_id = n.nap_session_id
		WHERE n.is_deleted = 0`+cond, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "午睡の記録を取得できませんでした")
		return
	}
	for sleeps.Next() {
		var (
			x           napSearchRow
			sleepID     int64
			wokeAt      sql.NullString
			temp        sql.NullFloat64
			wokeStaffID sql.NullString
		)
		if sleeps.Scan(&sleepID, &x.NapSessionID, &x.ChildID, &x.CheckedAt, &wokeAt,
			&temp, &x.StaffID, &wokeStaffID, &x.SessionDate, &x.classID) != nil {
			continue
		}
		x.NapSleepID = &sleepID
		slept := x
		slept.Kind = napRowSleep
		slept.SleepTemperature = nullFloat(temp)
		all = append(all, slept)
		if wokeAt.Valid {
			woke := x
			woke.Kind = napRowWake
			woke.CheckedAt = wokeAt.String
			woke.StaffID = wokeStaffID.String
			all = append(all, woke)
		}
	}
	sleeps.Close()

	// きょうは対象外と理由（t_nap_exclusion）も、その日の行として出す。取り消した対象外は出さない
	exclusions, err := a.db.Query(`SELECT e.nap_exclusion_id, e.nap_session_id, e.child_id, e.created_at, e.reason,
		e.staff_id, s.session_date, s.class_id
		FROM t_nap_exclusion e
		JOIN t_nap_session s ON s.nap_session_id = e.nap_session_id
		WHERE e.is_deleted = 0`+cond, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "午睡の記録を取得できませんでした")
		return
	}
	for exclusions.Next() {
		var (
			x           napSearchRow
			exclusionID int64
			reason      string
		)
		if exclusions.Scan(&exclusionID, &x.NapSessionID, &x.ChildID, &x.CheckedAt, &reason,
			&x.StaffID, &x.SessionDate, &x.classID) != nil {
			continue
		}
		x.Kind = napRowExclusion
		x.NapExclusionID = &exclusionID
		x.ExclusionReason = &reason
		all = append(all, x)
	}
	exclusions.Close()

	sortNapSearchRows(all)

	nameFilter := strings.TrimSpace(r.URL.Query().Get("child_name"))
	out := []napSearchRow{}
	for _, x := range all {
		if !a.canSeeChild(u, x.ChildID) {
			continue
		}
		x.ChildName = a.childName(x.ChildID)
		if nameFilter != "" && !strings.Contains(x.ChildName, nameFilter) {
			continue
		}
		x.ClassName = a.className(x.classID)
		if x.StaffID != "" {
			x.StaffName = a.staffName(x.StaffID)
		}
		out = append(out, x)
	}
	writeJSON(w, http.StatusOK,
		page(out, queryInt(r, "page", 1), a.settingInt("paging.nap_search_per_page", 50)))
}

// 午睡記録検索の行の種類
const (
	napRowCheck = "check" // 5分ごとの確認（t_nap_record）
	napRowSleep = "sleep" // ねた（t_nap_sleep の slept_at）
	napRowWake  = "wake"  // おきた（t_nap_sleep の woke_at）
	// きょうは対象外（t_nap_exclusion。押した時刻は created_at）
	napRowExclusion = "exclusion"
)

/*
napSearchRow は午睡記録検索の1行。

確認の行は、体位・呼吸・顔色・体温・保存時刻を持つ。ねた・おきたの行は、押した時刻（サーバの時刻）を
checked_at に持ち、体位・呼吸・顔色・保存時刻は持たない（null）。入眠時の体温はねたの行だけに出す。
入眠時の体温は監査の層の値であり、この経路は職員だけが呼べる（基本設計書「ねた・おきた（t_nap_sleep）」(5-7)）。
きょうは対象外の行は、押した時刻を checked_at に、理由（1:欠席 2:午睡なし）を exclusion_reason に持つ
*/
type napSearchRow struct {
	Kind             string   `json:"kind"`
	NapRecordID      *int64   `json:"nap_record_id"`
	NapSleepID       *int64   `json:"nap_sleep_id"`
	NapExclusionID   *int64   `json:"nap_exclusion_id"`
	ExclusionReason  *string  `json:"exclusion_reason"`
	NapSessionID     int64    `json:"nap_session_id"`
	ChildID          string   `json:"child_id"`
	CheckedAt        string   `json:"checked_at"`
	SavedAt          *string  `json:"saved_at"`
	BodyPosition     *string  `json:"body_position"`
	Breathing        *string  `json:"breathing"`
	Complexion       *string  `json:"complexion"`
	Temperature      *float64 `json:"temperature"`
	SleepTemperature *float64 `json:"sleep_temperature"`
	StaffID          string   `json:"staff_id"`
	SessionDate      string   `json:"session_date"`
	ChildName        string   `json:"child_name"`
	ClassName        string   `json:"class_name"`
	StaffName        string   `json:"staff_name"`
	classID          int64
}

/*
sortNapSearchRows は時刻の新しい順に並べる。

【仮置き】同じ時刻の行は、おきた・確認・ねた・対象外の順にし、同じ種類は ID の小さい順にする（web/仮置き値.md
「一覧の並び順」）。新しい順の一覧で、寝ている間の出来事を、ねたより上・おきたより下に置くため。
画面側のモック（web/src/api/mock.ts の searchRecords）と同じ並び。帳票（api_nap_report.go の sortNapReportLines）は
実施の日 → クラス → 園児 → 時刻 の古い順で、この並びとは違う
*/
func sortNapSearchRows(rows []napSearchRow) {
	rank := map[string]int{napRowWake: 0, napRowCheck: 1, napRowSleep: 2, napRowExclusion: 3}
	id := func(x napSearchRow) int64 {
		if x.NapRecordID != nil {
			return *x.NapRecordID
		}
		if x.NapSleepID != nil {
			return *x.NapSleepID
		}
		if x.NapExclusionID != nil {
			return *x.NapExclusionID
		}
		return 0
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].CheckedAt != rows[j].CheckedAt {
			return rows[i].CheckedAt > rows[j].CheckedAt
		}
		if rank[rows[i].Kind] != rank[rows[j].Kind] {
			return rank[rows[i].Kind] < rank[rows[j].Kind]
		}
		return id(rows[i]) < id(rows[j])
	})
}
