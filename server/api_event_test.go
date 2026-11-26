package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

/*
 * 行事カレンダー（api_event.go）
 * 典拠：設計書に定め無し。配布物（基本設計書「配布物の掲載と閲覧」(4-6)）の形に合わせた【仮置き】
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、web/tests/calendar.test.ts と同じ観点で確かめる。
 * 読む API は GET /api/calendar/events（GET /api/events は知らせの受け取り口）。
 */

// 固定の月。デモデータ（起動した月・来月）と混ざらないよう、遠い月で試す
const calMonth = "2027-03"

type calResp struct {
	Month            string          `json:"month"`
	Events           []CalendarEvent `json:"events"`
	CanWriteAll      bool            `json:"can_write_all"`
	WritableClassIDs []int64         `json:"writable_class_ids"`
}

// calBody は、予定の体を作る。start・end・class が空なら null にする
func calBody(date, start, end, title, class string) string {
	str := func(v string) string {
		if v == "" {
			return "null"
		}
		return `"` + v + `"`
	}
	if class == "" {
		class = "null"
	}
	return `{"event_date":"` + date + `","start_time":` + str(start) + `,"end_time":` + str(end) +
		`,"title":"` + title + `","note":"","class_id":` + class + `}`
}

func calList(t *testing.T, h http.Handler, c *http.Cookie, month string) calResp {
	t.Helper()
	var got calResp
	decode(t, call(t, h, c, "GET", "/api/calendar/events?month="+month, ""), &got)
	return got
}

// calAdd は予定を足し、足した予定を返す
func calAdd(t *testing.T, h http.Handler, c *http.Cookie, body string) CalendarEvent {
	t.Helper()
	var got struct {
		Event CalendarEvent `json:"event"`
	}
	decode(t, call(t, h, c, "POST", "/api/calendar/events", body), &got)
	return got.Event
}

func calTitles(r calResp) []string {
	out := []string{}
	for _, e := range r.Events {
		out = append(out, e.Title)
	}
	return out
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestCalendarWritePermission(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	sakura := loginAs(a, accTeacher, "staff")
	himawari := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")

	// 保育士は自クラスに足せる。足した本人の画面では直せる印が付く
	e := calAdd(t, h, sakura, calBody(calMonth+"-10", "10:00", "11:00", "さくら組の予定", "1"))
	if e.EventID == 0 || e.ClassID == nil || *e.ClassID != classSakura || e.ClassName == nil || *e.ClassName != "さくら組" || !e.CanEdit {
		t.Fatalf("足した予定 = %+v", e)
	}
	// 他クラス・園全体は 403
	expectStatus(t, request(t, h, sakura, "POST", "/api/calendar/events", calBody(calMonth+"-10", "", "", "x", "2")), http.StatusForbidden)
	expectStatus(t, request(t, h, sakura, "POST", "/api/calendar/events", calBody(calMonth+"-10", "", "", "x", "")), http.StatusForbidden)
	// 管理者は園全体にも、どのクラスにも足せる
	all := calAdd(t, h, admin, calBody(calMonth+"-11", "", "", "園全体の予定", ""))
	if all.ClassID != nil || all.ClassName != nil || !all.CanEdit {
		t.Fatalf("園全体の予定 = %+v", all)
	}
	calAdd(t, h, admin, calBody(calMonth+"-12", "", "", "ひまわり組の予定", "2"))
	// 保護者の POST は 403（足す・直す・消す）
	expectStatus(t, request(t, h, guardian, "POST", "/api/calendar/events", calBody(calMonth+"-10", "", "", "x", "1")), http.StatusForbidden)
	id := "/api/calendar/events/" + itoa(e.EventID)
	expectStatus(t, request(t, h, guardian, "POST", id, calBody(calMonth+"-10", "", "", "x", "1")), http.StatusForbidden)
	expectStatus(t, request(t, h, guardian, "POST", id+"/delete", ""), http.StatusForbidden)
	// ほかのクラスの保育士は、直せない・消せない
	expectStatus(t, request(t, h, himawari, "POST", id, calBody(calMonth+"-10", "", "", "x", "2")), http.StatusForbidden)
	expectStatus(t, request(t, h, himawari, "POST", id+"/delete", ""), http.StatusForbidden)
	// 存在しないクラスは 400（管理者）
	expectStatus(t, request(t, h, admin, "POST", "/api/calendar/events", calBody(calMonth+"-10", "", "", "x", "999")), http.StatusBadRequest)
	// ログインしていなければ 401
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/calendar/events", strings.NewReader("{}")))
	expectStatus(t, rec, http.StatusUnauthorized)
}

func TestCalendarVisibleRange(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	sakura := loginAs(a, accTeacher, "staff")
	himawari := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian") // 西田 太郎（さくら組）の保護者
	calAdd(t, h, admin, calBody(calMonth+"-03", "", "", "園全体", ""))
	calAdd(t, h, admin, calBody(calMonth+"-01", "", "", "さくら", "1"))
	calAdd(t, h, admin, calBody(calMonth+"-02", "", "", "ひまわり", "2"))
	// 別の月は出ない
	calAdd(t, h, admin, calBody("2027-04-01", "", "", "来月", ""))
	calAdd(t, h, admin, calBody("2027-02-28", "", "", "先月", ""))

	cases := []struct {
		name string
		who  *http.Cookie
		want []string
	}{
		{"管理者は全部", admin, []string{"さくら", "ひまわり", "園全体"}},
		{"さくら組の保育士", sakura, []string{"さくら", "園全体"}},
		{"ひまわり組の保育士", himawari, []string{"ひまわり", "園全体"}},
		{"保護者は自分の子のクラスと園全体だけ（別クラスは出ない）", guardian, []string{"さくら", "園全体"}},
	}
	for _, c := range cases {
		if got := calTitles(calList(t, h, c.who, calMonth)); !sameStrings(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}

	// 保護者は書けない印、保育士は自クラスだけ、管理者は全クラス
	g := calList(t, h, guardian, calMonth)
	if g.CanWriteAll || g.WritableClassIDs == nil || len(g.WritableClassIDs) != 0 {
		t.Errorf("保護者: can_write_all=%v writable=%v", g.CanWriteAll, g.WritableClassIDs)
	}
	for _, e := range g.Events {
		if e.CanEdit {
			t.Errorf("保護者に直せる印が付いている: %+v", e)
		}
	}
	s := calList(t, h, sakura, calMonth)
	if s.CanWriteAll || len(s.WritableClassIDs) != 1 || s.WritableClassIDs[0] != classSakura {
		t.Errorf("さくら組の保育士: %+v", s)
	}
	for _, e := range s.Events {
		if e.CanEdit != (e.ClassID != nil && *e.ClassID == classSakura) {
			t.Errorf("さくら組の保育士の can_edit: %+v", e)
		}
	}
	ad := calList(t, h, admin, calMonth)
	if !ad.CanWriteAll || len(ad.WritableClassIDs) != 3 || ad.Month != calMonth {
		t.Errorf("管理者（今年度のクラスは 3 つ）: %+v", ad)
	}

	// 担当クラスの無い保育士（フリー）は、園全体だけが見えて、書けるクラスは無い
	if _, err := a.db.Exec(`DELETE FROM t_class_staff WHERE staff_id = 'S005'`); err != nil {
		t.Fatal(err)
	}
	free := calList(t, h, himawari, calMonth)
	if got := calTitles(free); !sameStrings(got, []string{"園全体"}) || free.CanWriteAll || len(free.WritableClassIDs) != 0 {
		t.Errorf("フリーの保育士: %v %+v", got, free)
	}
}

func TestCalendarOrder(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	calAdd(t, h, admin, calBody(calMonth+"-05", "13:00", "", "午後", ""))
	calAdd(t, h, admin, calBody(calMonth+"-05", "", "", "終日", ""))
	calAdd(t, h, admin, calBody(calMonth+"-05", "09:00", "10:00", "午前", ""))
	calAdd(t, h, admin, calBody(calMonth+"-01", "", "", "ついたち", ""))
	got := calTitles(calList(t, h, admin, calMonth))
	if want := []string{"ついたち", "終日", "午前", "午後"}; !sameStrings(got, want) {
		t.Errorf("並び = %v, want %v", got, want)
	}
}

func TestCalendarUpdateMovesClass(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	sakura := loginAs(a, accTeacher, "staff")
	e := calAdd(t, h, sakura, calBody(calMonth+"-10", "", "", "さくら", "1"))
	path := "/api/calendar/events/" + itoa(e.EventID)

	// 同じクラスの中なら直せる（時刻・題名・内容）
	var upd struct {
		Event CalendarEvent `json:"event"`
	}
	decode(t, call(t, h, sakura, "POST", path,
		`{"event_date":"`+calMonth+`-12","start_time":"09:00","end_time":"09:30","title":"さくら（直した）","note":"持ち物","class_id":1}`), &upd)
	if u := upd.Event; u.EventID != e.EventID || u.EventDate != calMonth+"-12" || u.Title != "さくら（直した）" || u.Note != "持ち物" ||
		u.StartTime == nil || *u.StartTime != "09:00" || u.EndTime == nil || *u.EndTime != "09:30" {
		t.Fatalf("直した予定 = %+v", u)
	}
	// 新しいクラス（ひまわり組・園全体）への移し替えは、新しい側の権限が無いので 403。予定は元のまま
	expectStatus(t, request(t, h, sakura, "POST", path, calBody(calMonth+"-12", "", "", "x", "2")), http.StatusForbidden)
	expectStatus(t, request(t, h, sakura, "POST", path, calBody(calMonth+"-12", "", "", "x", "")), http.StatusForbidden)
	if got := calTitles(calList(t, h, sakura, calMonth)); !sameStrings(got, []string{"さくら（直した）"}) {
		t.Errorf("403 のあとの予定 = %v", got)
	}
	// 管理者が園全体の予定にすると、さくら組の保育士は元のクラスの権限があっても直せなくなる
	decode(t, call(t, h, admin, "POST", path, calBody(calMonth+"-12", "", "", "園全体へ", "")), &upd)
	if upd.Event.ClassID != nil || upd.Event.ClassName != nil {
		t.Fatalf("園全体へ移した予定 = %+v", upd.Event)
	}
	expectStatus(t, request(t, h, sakura, "POST", path, calBody(calMonth+"-12", "", "", "戻す", "1")), http.StatusForbidden)
	expectStatus(t, request(t, h, sakura, "POST", path+"/delete", ""), http.StatusForbidden)
	// 存在しない id は 404
	expectStatus(t, request(t, h, admin, "POST", "/api/calendar/events/9999", calBody(calMonth+"-12", "", "", "x", "")), http.StatusNotFound)
}

func TestCalendarDelete(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	sakura := loginAs(a, accTeacher, "staff")
	e := calAdd(t, h, sakura, calBody(calMonth+"-10", "", "", "消す予定", "1"))
	path := "/api/calendar/events/" + itoa(e.EventID)

	var ok map[string]bool
	decode(t, call(t, h, sakura, "POST", path+"/delete", ""), &ok)
	if !ok["ok"] {
		t.Fatalf("ok = %v", ok)
	}
	if got := calTitles(calList(t, h, admin, calMonth)); len(got) != 0 {
		t.Errorf("消した予定が出る: %v", got)
	}
	// 論理削除（行は残り、消した人が入る）
	var deleted int
	var by string
	if err := a.db.QueryRow(`SELECT is_deleted, deleted_staff_id FROM t_event WHERE event_id = ?`, e.EventID).Scan(&deleted, &by); err != nil || deleted != 1 || by != "S003" {
		t.Errorf("論理削除 = %d %q %v", deleted, by, err)
	}
	// 二度消す・消したものを直すのは 404
	expectStatus(t, request(t, h, sakura, "POST", path+"/delete", ""), http.StatusNotFound)
	expectStatus(t, request(t, h, admin, "POST", path, calBody(calMonth+"-10", "", "", "x", "1")), http.StatusNotFound)
}

func TestCalendarValidation(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	long := func(n int) string { return strings.Repeat("あ", n) }
	cases := []struct {
		name string
		body string
	}{
		{"日付が空", calBody("", "", "", "題名", "")},
		{"存在しない日付", calBody("2027-02-29", "", "", "題名", "")},
		{"日付の形が違う", calBody("2027/03/10", "", "", "題名", "")},
		{"開始の時刻の形が違う", calBody(calMonth+"-10", "9:00", "", "題名", "")},
		{"24時", calBody(calMonth+"-10", "24:00", "", "題名", "")},
		{"終了の時刻の形が違う", calBody(calMonth+"-10", "09:00", "10:60", "題名", "")},
		{"終了だけ指定", calBody(calMonth+"-10", "", "10:00", "題名", "")},
		{"開始が終了より後", calBody(calMonth+"-10", "11:00", "10:00", "題名", "")},
		{"題名が空", calBody(calMonth+"-10", "", "", "", "")},
		{"題名が空白だけ", calBody(calMonth+"-10", "", "", " 　 ", "")},
		{"題名が51文字", calBody(calMonth+"-10", "", "", long(51), "")},
		{"内容が501文字", `{"event_date":"` + calMonth + `-10","title":"題名","note":"` + long(501) + `","class_id":null}`},
	}
	for _, c := range cases {
		rec := request(t, h, admin, "POST", "/api/calendar/events", c.body)
		expectStatus(t, rec, http.StatusBadRequest)
		var e apiError
		if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e.Message == "" {
			t.Errorf("%s: 利用者に見せる文言が無い（%s）", c.name, rec.Body.String())
		}
	}
	// 直すときも同じ検証
	e := calAdd(t, h, admin, calBody(calMonth+"-10", "", "", "題名", ""))
	expectStatus(t, request(t, h, admin, "POST", "/api/calendar/events/"+itoa(e.EventID), calBody(calMonth+"-10", "11:00", "10:00", "題名", "")), http.StatusBadRequest)
	// 境目：題名 50 文字・内容 500 文字（rune で数える）・開始＝終了・開始だけ は通る
	calAdd(t, h, admin, calBody(calMonth+"-10", "10:00", "10:00", long(50), ""))
	calAdd(t, h, admin, calBody(calMonth+"-10", "10:00", "", "開始だけ", ""))
	calAdd(t, h, admin, `{"event_date":"`+calMonth+`-10","title":" 前後の空白 ","note":"`+long(500)+`","class_id":null}`)
	found := false
	for _, ev := range calList(t, h, admin, calMonth).Events {
		if ev.Title == "前後の空白" {
			found = true
		}
	}
	if !found {
		t.Errorf("題名の前後の空白を除いていない")
	}
}

func TestCalendarMonthParam(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	for _, q := range []string{"", "?month=", "?month=2027-3", "?month=2027-13", "?month=2027-00", "?month=202703", "?month=2027-03-01"} {
		expectStatus(t, request(t, h, admin, "GET", "/api/calendar/events"+q, ""), http.StatusBadRequest)
	}
	// ログインしていなければ 401
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/calendar/events?month="+calMonth, nil))
	expectStatus(t, rec, http.StatusUnauthorized)
}

// デモデータ：今月の運動会・誕生会（園全体）・身体測定（1番目のクラス）、来月の遠足（2番目のクラス）
func TestCalendarSeed(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	n := nowTime()
	this := time.Date(n.Year(), n.Month(), 1, 0, 0, 0, 0, jst)
	thisMonth, nextMonth := this.Format("2006-01"), this.AddDate(0, 1, 0).Format("2006-01")

	cur := calList(t, h, admin, thisMonth)
	if got := calTitles(cur); !sameStrings(got, []string{"運動会", "身体測定", "誕生会"}) {
		t.Fatalf("今月 = %v", got)
	}
	undokai, sokutei, tanjo := cur.Events[0], cur.Events[1], cur.Events[2]
	if undokai.EventDate != thisMonth+"-10" || *undokai.StartTime != "09:30" || *undokai.EndTime != "12:00" ||
		undokai.ClassID != nil || undokai.Note != "体操服・水筒を持ってきてください" {
		t.Errorf("運動会 = %+v", undokai)
	}
	if tanjo.EventDate != thisMonth+"-20" || *tanjo.StartTime != "10:00" || *tanjo.EndTime != "10:45" ||
		tanjo.ClassID != nil || tanjo.Note != "今月生まれのお友だちをお祝いします" {
		t.Errorf("誕生会 = %+v", tanjo)
	}
	if sokutei.EventDate != thisMonth+"-15" || sokutei.StartTime != nil || sokutei.EndTime != nil ||
		sokutei.ClassID == nil || *sokutei.ClassID != classSakura || *sokutei.ClassName != "さくら組" || sokutei.Note != "" {
		t.Errorf("身体測定 = %+v", sokutei)
	}
	next := calList(t, h, admin, nextMonth)
	if len(next.Events) != 1 {
		t.Fatalf("来月 = %v", calTitles(next))
	}
	enzoku := next.Events[0]
	if enzoku.Title != "遠足" || enzoku.EventDate != nextMonth+"-05" || *enzoku.StartTime != "09:00" || *enzoku.EndTime != "14:00" ||
		enzoku.ClassID == nil || *enzoku.ClassID != classHimawari || *enzoku.ClassName != "ひまわり組" || enzoku.Note != "お弁当・レジャーシート" {
		t.Errorf("遠足 = %+v", enzoku)
	}
}

// 操作ログ：足す・直す・消すを t_event として残す
func TestCalendarOperationLog(t *testing.T) {
	a, h := newTestApp(t)
	sakura := loginAs(a, accTeacher, "staff")
	e := calAdd(t, h, sakura, calBody(calMonth+"-10", "", "", "さくら", "1"))
	path := "/api/calendar/events/" + itoa(e.EventID)
	call(t, h, sakura, "POST", path, calBody(calMonth+"-10", "", "", "さくら2", "1"))
	call(t, h, sakura, "POST", path+"/delete", "")
	rows, err := a.db.Query(`SELECT operation_type, function_type, before_value, after_value FROM t_operation_log
		WHERE target_table = 't_event' AND target_id = ? AND account_id = ? ORDER BY operation_log_id`, e.EventID, accTeacher)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ops []string
	for rows.Next() {
		var op, fn string
		var before, after *string
		if err := rows.Scan(&op, &fn, &before, &after); err != nil {
			t.Fatal(err)
		}
		ops = append(ops, op)
		if fn != fnChat {
			t.Errorf("function_type = %q", fn)
		}
		switch op {
		case opCreate:
			if before != nil || after == nil || !strings.Contains(*after, "さくら") {
				t.Errorf("足すログ = %v %v", before, after)
			}
		case opUpdate:
			if before == nil || after == nil || !strings.Contains(*before, `"さくら"`) || !strings.Contains(*after, "さくら2") {
				t.Errorf("直すログ = %v %v", before, after)
			}
		case opDelete:
			if before == nil || after != nil {
				t.Errorf("消すログ = %v %v", before, after)
			}
		}
	}
	if !sameStrings(ops, []string{opCreate, opUpdate, opDelete}) {
		t.Errorf("操作 = %v", ops)
	}
}

// 知らせ（calendar）は、その予定を見られる人にだけ届く。クラスを移したときは、移す前の人にも届く
func TestNotifyCalendarAudience(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	sakura := loginAs(a, accTeacher, "staff")
	clients := map[string]*liveClient{
		"管理者":       listen(a, accAdmin),
		"さくら組の担任":   listen(a, accTeacher),
		"ひまわり組の担任":  listen(a, accOtherTeacher),
		"西田 太郎の保護者": listen(a, accGuardian),
		"村田 美咲の保護者": listen(a, accOtherGuard),
	}
	sakuraPeople := who("管理者", "さくら組の担任", "西田 太郎の保護者", "村田 美咲の保護者")
	date := calMonth + "-10"

	e := calAdd(t, h, sakura, calBody(date, "", "", "さくら", "1"))
	expect(t, "さくら組の予定を足す（ひまわり組の担任には届かない）", clients,
		to(sakuraPeople, liveEvent{Type: evCalendar, EventID: e.EventID, EventDate: date, Op: "create"}))

	path := "/api/calendar/events/" + itoa(e.EventID)
	call(t, h, sakura, "POST", path, calBody(date, "", "", "さくら2", "1"))
	expect(t, "直す", clients,
		to(sakuraPeople, liveEvent{Type: evCalendar, EventID: e.EventID, EventDate: date, Op: "update"}))

	// さくら組から園全体へ移す。移す前のさくら組の人にも、移した先の全員にも、1回ずつ届く
	call(t, h, admin, "POST", path, calBody(date, "", "", "園全体へ", ""))
	everyone := who("管理者", "さくら組の担任", "ひまわり組の担任", "西田 太郎の保護者", "村田 美咲の保護者")
	expect(t, "園全体へ移す", clients,
		to(everyone, liveEvent{Type: evCalendar, EventID: e.EventID, EventDate: date, Op: "update"}))

	// ひまわり組へ移す。移す前（園全体）を見ていた人にも届く
	call(t, h, admin, "POST", path, calBody(date, "", "", "ひまわり組へ", "2"))
	expect(t, "園全体からひまわり組へ移す", clients,
		to(everyone, liveEvent{Type: evCalendar, EventID: e.EventID, EventDate: date, Op: "update"}))

	call(t, h, admin, "POST", path+"/delete", "")
	expect(t, "消す（ひまわり組向け）", clients,
		to(who("管理者", "ひまわり組の担任"), liveEvent{Type: evCalendar, EventID: e.EventID, EventDate: date, Op: "delete"}))
}
