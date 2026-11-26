package main

import (
	"database/sql"
	"net/http"
	"regexp"
	"strings"
	"time"
)

/*
 * 行事カレンダー
 * 典拠：設計書に定め無し。配布物（基本設計書「配布物の掲載と閲覧」(4-6)・「配布物（t_handout）」(5-5)）の形に合わせた【仮置き】
 *
 * 保育士が予定を書き、保護者が見る。見られる範囲は配布物と同じ（handoutClassIDs）。
 * 書けるのは、園全体の予定は管理者だけ、クラスの予定はそのクラスを扱える職員（canUseClass）。
 * 消すときは論理削除にする（配布物と同じ）。
 *
 * 知らせの受け取り口（GET /api/events。SSE）と取り違えないよう、パスは /api/calendar/events にしている。
 * 画面側のモック（web/src/api/mock.ts）も同じ規則を持つ。規則を変えるときは両方を直す。
 */

// 【仮置き】題名・内容の文字数の上限は設計に定めが無い（web/仮置き値.md）
const (
	eventTitleMax = 50
	eventNoteMax  = 500
)

var timePattern = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)

// CalendarEvent は行事カレンダーの予定（t_event）
type CalendarEvent struct {
	EventID   int64   `json:"event_id"`
	EventDate string  `json:"event_date"`
	StartTime *string `json:"start_time"`
	EndTime   *string `json:"end_time"`
	Title     string  `json:"title"`
	Note      string  `json:"note"`
	ClassID   *int64  `json:"class_id"`
	// 画面が使う導出値。園全体のときは class_name が null
	ClassName *string `json:"class_name"`
	CanEdit   bool    `json:"can_edit"`
}

// eventColumns は予定を読む列。scanEvent と並びを合わせる
const eventColumns = `event_id, event_date, start_time, end_time, title, note, class_id`

func scanEvent(sc interface{ Scan(...any) error }) (CalendarEvent, error) {
	var (
		e          CalendarEvent
		start, end sql.NullString
		classID    sql.NullInt64
	)
	if err := sc.Scan(&e.EventID, &e.EventDate, &start, &end, &e.Title, &e.Note, &classID); err != nil {
		return e, err
	}
	if start.Valid {
		e.StartTime = &start.String
	}
	if end.Valid {
		e.EndTime = &end.String
	}
	e.ClassID = nullInt(classID)
	return e, nil
}

// canWriteEventClass は、その利用者が、その対象（nil は園全体）の予定を書けるかを返す。
// 園全体は管理者だけ。クラスは canUseClass（一般は自クラスだけ）
func (a *app) canWriteEventClass(u *SessionUser, classID *int64) bool {
	if !u.isStaff() {
		return false
	}
	if classID == nil {
		return u.isAdmin()
	}
	return a.canUseClass(u, *classID)
}

// fillEvent は、名前と「直せるか」を入れる。カーソルを閉じたあとに呼ぶ（接続を1本に絞っているため。db.go）
func (a *app) fillEvent(u *SessionUser, e *CalendarEvent) {
	if e.ClassID != nil {
		name := a.className(*e.ClassID)
		e.ClassName = &name
	}
	e.CanEdit = a.canWriteEventClass(u, e.ClassID)
}

// writableEventClassIDs は、その利用者が予定を書けるクラス（今年度）。管理者は全部、一般職員は自クラス、保護者・フリーは空
func (a *app) writableEventClassIDs(u *SessionUser) []int64 {
	ids := []int64{}
	if u.isAdmin() {
		rows, err := a.db.Query(`SELECT class_id FROM m_class WHERE fiscal_year = ? ORDER BY class_id`, fiscalYear)
		if err != nil {
			return ids
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			if rows.Scan(&id) == nil {
				ids = append(ids, id)
			}
		}
		return ids
	}
	if u.isGeneralStaff() && u.ClassID != nil && a.canUseClass(u, *u.ClassID) {
		ids = append(ids, *u.ClassID)
	}
	return ids
}

// loadEvent は、消されていない予定を1件読む
func (a *app) loadEvent(id int64) (CalendarEvent, bool) {
	e, err := scanEvent(a.db.QueryRow(`SELECT `+eventColumns+` FROM t_event WHERE event_id = ? AND is_deleted = 0`, id))
	return e, err == nil
}

// handleCalendarEvents は、見られる予定を、指定した月の分だけ日付順に返す
func (a *app) handleCalendarEvents(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	month := r.URL.Query().Get("month")
	if !monthPattern.MatchString(month) {
		writeErr(w, http.StatusBadRequest, "月を指定してください")
		return
	}
	q := `SELECT ` + eventColumns + ` FROM t_event WHERE is_deleted = 0 AND event_date >= ? AND event_date <= ?`
	args := []any{month + "-01", month + "-31"}
	if ids, all := a.handoutClassIDs(u); !all {
		q += ` AND (class_id IS NULL`
		if len(ids) > 0 {
			q += ` OR class_id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + `)`
			for _, id := range ids {
				args = append(args, id)
			}
		}
		q += `)`
	}
	// 終日（開始が空）を、その日の先頭に置く
	q += ` ORDER BY event_date, start_time IS NOT NULL, start_time, event_id`

	rows, err := a.db.Query(q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "予定を取得できませんでした")
		return
	}
	events := []CalendarEvent{}
	for rows.Next() {
		if e, err := scanEvent(rows); err == nil {
			events = append(events, e)
		}
	}
	rows.Close()
	for i := range events {
		a.fillEvent(u, &events[i])
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"month":              month,
		"events":             events,
		"can_write_all":      u.isAdmin(),
		"writable_class_ids": a.writableEventClassIDs(u),
	})
}

// eventRequest は、予定を足す・直すときの体
type eventRequest struct {
	EventDate string  `json:"event_date"`
	StartTime *string `json:"start_time"`
	EndTime   *string `json:"end_time"`
	Title     string  `json:"title"`
	Note      string  `json:"note"`
	ClassID   *int64  `json:"class_id"`
}

// validateEvent は体を確かめ、整えた値を返す。誤りがあれば、利用者に見せる文言を返す
func validateEvent(req *eventRequest) (start, end *string, message string) {
	req.Title = strings.TrimSpace(req.Title)
	if _, err := time.Parse("2006-01-02", req.EventDate); err != nil {
		return nil, nil, "日付を正しく入力してください"
	}
	// 空の文字列は「指定なし」（終日）として読む
	clean := func(v *string) *string {
		if v == nil || *v == "" {
			return nil
		}
		return v
	}
	start, end = clean(req.StartTime), clean(req.EndTime)
	switch {
	case start != nil && !timePattern.MatchString(*start), end != nil && !timePattern.MatchString(*end):
		return nil, nil, "時刻は「09:30」の形で入力してください"
	case start == nil && end != nil:
		return nil, nil, "終了の時刻だけは指定できません。開始の時刻も入力してください"
	case start != nil && end != nil && *start > *end:
		return nil, nil, "終了の時刻は、開始の時刻以降にしてください"
	case req.Title == "":
		return nil, nil, "題名を入力してください"
	case tooLong(req.Title, eventTitleMax):
		return nil, nil, "題名は" + itoa64(eventTitleMax) + "文字以内で入力してください"
	case tooLong(req.Note, eventNoteMax):
		return nil, nil, "内容は" + itoa64(eventNoteMax) + "文字以内で入力してください"
	}
	return start, end, ""
}

// classIDExists は、今年度にそのクラスがあるかを返す
func (a *app) classIDExists(classID int64) bool {
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_class WHERE class_id = ? AND fiscal_year = ?`, classID, fiscalYear).Scan(&n)
	return n > 0
}

// eventLogValue は、操作ログに残す予定の中身
func eventLogValue(e CalendarEvent) string {
	str := func(v *string) any {
		if v == nil {
			return nil
		}
		return *v
	}
	var cls any
	if e.ClassID != nil {
		cls = *e.ClassID
	}
	return fieldsJSON([]field{
		{"event_date", e.EventDate}, {"start_time", str(e.StartTime)}, {"end_time", str(e.EndTime)},
		{"title", e.Title}, {"note", e.Note}, {"class_id", cls},
	})
}

// handleAddCalendarEvent は予定を足す。園全体は管理者だけ、クラスはそのクラスを扱える職員
func (a *app) handleAddCalendarEvent(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var req eventRequest
	if !readJSON(w, r, &req) {
		return
	}
	start, end, msg := validateEvent(&req)
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	if !a.canWriteEventClass(u, req.ClassID) {
		writeForbidden(w, "この対象の予定は書けません")
		return
	}
	if req.ClassID != nil && !a.classIDExists(*req.ClassID) {
		writeErr(w, http.StatusBadRequest, "対象のクラスが見つかりません")
		return
	}
	at := now()
	res, err := a.db.Exec(`INSERT INTO t_event
		(event_date, start_time, end_time, title, note, class_id,
		 created_staff_id, created_at, updated_staff_id, updated_at, is_deleted)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		req.EventDate, start, end, req.Title, req.Note, req.ClassID, u.staff(), at, u.staff(), at)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "予定を保存できませんでした")
		return
	}
	id, _ := res.LastInsertId()
	e, _ := a.loadEvent(id)
	// 【仮置き】機能種別は配布物の先例に合わせて fnChat を使う。どの機能かは対象テーブル（t_event）で見分ける
	a.log(u.AccountID, fnChat, opCreate, "t_event", i64(id), nil, nil, s(eventLogValue(e)))
	a.notifyCalendar(id, e.EventDate, "create", e.ClassID)
	a.fillEvent(u, &e)
	writeJSON(w, http.StatusOK, map[string]CalendarEvent{"event": e})
}

// handleUpdateCalendarEvent は予定を直す。元のクラスと新しいクラスの両方に権限が要る
func (a *app) handleUpdateCalendarEvent(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "予定の指定が正しくありません")
		return
	}
	before, found := a.loadEvent(id)
	if !found {
		writeErr(w, http.StatusNotFound, "予定が見つかりません")
		return
	}
	if !a.canWriteEventClass(u, before.ClassID) {
		writeForbidden(w, "この予定は直せません")
		return
	}
	var req eventRequest
	if !readJSON(w, r, &req) {
		return
	}
	start, end, msg := validateEvent(&req)
	if msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	if !a.canWriteEventClass(u, req.ClassID) {
		writeForbidden(w, "この対象の予定は書けません")
		return
	}
	if req.ClassID != nil && !a.classIDExists(*req.ClassID) {
		writeErr(w, http.StatusBadRequest, "対象のクラスが見つかりません")
		return
	}
	res, err := a.db.Exec(`UPDATE t_event SET event_date = ?, start_time = ?, end_time = ?, title = ?, note = ?,
		class_id = ?, updated_staff_id = ?, updated_at = ? WHERE event_id = ? AND is_deleted = 0`,
		req.EventDate, start, end, req.Title, req.Note, req.ClassID, u.staff(), now(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "予定を保存できませんでした")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "予定が見つかりません")
		return
	}
	after, _ := a.loadEvent(id)
	a.log(u.AccountID, fnChat, opUpdate, "t_event", i64(id), nil, s(eventLogValue(before)), s(eventLogValue(after)))
	// クラスを移したときは、移す前のクラスの人にも知らせる（その人の画面からは予定が消える）
	a.notifyCalendar(id, after.EventDate, "update", before.ClassID, after.ClassID)
	a.fillEvent(u, &after)
	writeJSON(w, http.StatusOK, map[string]CalendarEvent{"event": after})
}

// handleDeleteCalendarEvent は予定を消す。論理削除とし、一覧から外す
func (a *app) handleDeleteCalendarEvent(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "予定の指定が正しくありません")
		return
	}
	before, found := a.loadEvent(id)
	if !found {
		writeErr(w, http.StatusNotFound, "予定が見つかりません")
		return
	}
	if !a.canWriteEventClass(u, before.ClassID) {
		writeForbidden(w, "この予定は消せません")
		return
	}
	res, err := a.db.Exec(`UPDATE t_event SET is_deleted = 1, deleted_at = ?, deleted_staff_id = ?
		WHERE event_id = ? AND is_deleted = 0`, now(), u.staff(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "予定を消せませんでした")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "予定が見つかりません")
		return
	}
	a.log(u.AccountID, fnChat, opDelete, "t_event", i64(id), nil, s(eventLogValue(before)), nil)
	a.notifyCalendar(id, before.EventDate, "delete", before.ClassID)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
