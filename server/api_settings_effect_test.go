package main

import (
	"net/http"
	"strconv"
	"testing"
)

/*
保存した設定が、次に開いた画面に効くこと。
  - dev.notice_days_before：発達チェックの予定日が「近い」とする日数（発達チェック一覧・職員ダッシュボード）
  - approval.warn_days：承認待ちの滞留の印を付ける日数（承認待ち一覧）

典拠：基本設計書「設定マスタ」(5-9)・「推奨スケジュールの作り方」(4-9)、
画面詳細図「発達チェック一覧画面」(6-1) 項目13・「承認待ち一覧画面」(3-4) 項目5・「職員ダッシュボード」(2-6) 項目4。
モックの同じ観点は web/tests/settingsEffect.test.ts にある。
*/

// saveSetting は、設定画面と同じ道（POST /api/settings）で1つの設定を変える
func saveSetting(t *testing.T, h http.Handler, admin *http.Cookie, key, value string) {
	t.Helper()
	var cur settingsResp
	decode(t, call(t, h, admin, "GET", "/api/settings", ""), &cur)
	call(t, h, admin, "POST", "/api/settings", `{"changes":{"`+key+`":"`+value+`"},"read_at":"`+cur.ReadAt+`"}`)
}

type effectDevRow struct {
	Child struct {
		ChildID string `json:"child_id"`
	} `json:"child"`
	Overdue bool `json:"overdue"`
	Near    bool `json:"near"`
}

// effectNearInAllClasses は、全クラスの発達チェック一覧で「近い」になっている園児の数。ダッシュボードの数と同じになる
func effectNearInAllClasses(t *testing.T, a *app, h http.Handler, c *http.Cookie) int {
	t.Helper()
	rows, err := a.db.Query(`SELECT class_id FROM m_class`)
	if err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	n := 0
	for _, id := range ids {
		var list []effectDevRow
		decode(t, call(t, h, c, "GET", "/api/development/list?class_id="+strconv.FormatInt(id, 10), ""), &list)
		for _, r := range list {
			if r.Near {
				n++
			}
		}
	}
	return n
}

func effectDevRowOf(t *testing.T, h http.Handler, c *http.Cookie, childID string) effectDevRow {
	t.Helper()
	var rows []effectDevRow
	decode(t, call(t, h, c, "GET", "/api/development/list?class_id=1", ""), &rows)
	for _, r := range rows {
		if r.Child.ChildID == childID {
			return r
		}
	}
	t.Fatalf("%s が一覧にありません", childID)
	return effectDevRow{}
}

func TestDevNoticeDaysBeforeEffect(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff") // さくら組

	// C009 の予定を、今日から 10 日後の1件だけにする。確定した記録は無い
	a.db.Exec(`DELETE FROM t_development_schedule WHERE child_id = 'C009'`)
	a.db.Exec(`DELETE FROM t_development_check WHERE child_id = 'C009'`)
	if _, err := a.db.Exec(`INSERT INTO t_development_schedule (child_id, scheduled_on, is_manual_override, created_staff_id)
		VALUES ('C009', ?, 0, 'S001')`, addDays(today(), 10)); err != nil {
		t.Fatal(err)
	}
	near := func() int {
		var s struct {
			DevNear int `json:"devNear"`
		}
		decode(t, call(t, h, admin, "GET", "/api/dashboard/staff", ""), &s)
		return s.DevNear
	}
	// ほかの園児の予定も日数で近くなりうるので、ダッシュボードの数は、一覧で近い園児の数と照らす
	base := near()
	if want := effectNearInAllClasses(t, a, h, admin); base != want {
		t.Fatalf("ダッシュボードの近い %d 名 ≠ 一覧の近い %d 名", base, want)
	}

	// 既定の 7 日では、10 日後は近くない
	if r := effectDevRowOf(t, h, teacher, "C009"); r.Near || r.Overdue {
		t.Fatalf("既定の 7 日で近いになっています: %+v", r)
	}

	// 10 日に変えると、次に開いた一覧とダッシュボードで近いになる（過ぎたとは重ならない）
	saveSetting(t, h, admin, "dev.notice_days_before", "10")
	if r := effectDevRowOf(t, h, teacher, "C009"); !r.Near || r.Overdue {
		t.Fatalf("10 日に変えても近くなりません: %+v", r)
	}
	if got, want := near(), effectNearInAllClasses(t, a, h, admin); got != want || got < base+1 {
		t.Fatalf("ダッシュボードの近い: %d 名（一覧 %d 名、変える前 %d 名）", got, want, base)
	}

	// 9 日に戻すと、また近くない
	saveSetting(t, h, admin, "dev.notice_days_before", "9")
	if r := effectDevRowOf(t, h, teacher, "C009"); r.Near {
		t.Fatalf("9 日で近いになっています: %+v", r)
	}
	if got, want := near(), effectNearInAllClasses(t, a, h, admin); got != want {
		t.Fatalf("ダッシュボードの近い: %d 名（一覧 %d 名）", got, want)
	}
}

func TestDevNearBoundaries(t *testing.T) {
	sch := func(d string) *string { return &d }
	today0 := today()
	for _, c := range []struct {
		name       string
		scheduled  *string
		last       *string
		days       int
		wantNear   bool
		wantOverdu bool
	}{
		{"予定が無い", nil, nil, 7, false, false},
		{"当日は近い", sch(today0), nil, 7, true, false},
		{"ちょうど 7 日後は近い", sch(addDays(today0, 7)), nil, 7, true, false},
		{"8 日後は近くない", sch(addDays(today0, 8)), nil, 7, false, false},
		{"昨日は過ぎた（近いではない）", sch(addDays(today0, -1)), nil, 7, false, true},
		{"予定日より前の確定だけなら近い", sch(addDays(today0, 3)), sch(addDays(today0, -20)), 7, true, false},
		{"予定日以降に確定していれば近くない", sch(today0), sch(today0), 7, false, false},
	} {
		if got := devNear(c.scheduled, c.last, c.days); got != c.wantNear {
			t.Errorf("%s: near=%v", c.name, got)
		}
		if got := devOverdue(c.scheduled, c.last); got != c.wantOverdu {
			t.Errorf("%s: overdue=%v", c.name, got)
		}
	}
}

type pendingRow struct {
	DiaryID     int64   `json:"diary_id"`
	AppliedAt   *string `json:"applied_at"`
	ElapsedDays int     `json:"elapsed_days"`
	WarnDays    int     `json:"warn_days"`
	Stale       bool    `json:"stale"`
}

func TestApprovalWarnDaysEffect(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")

	pending := func(c *http.Cookie) []pendingRow {
		var rows []pendingRow
		decode(t, call(t, h, c, "GET", "/api/diaries/pending", ""), &rows)
		return rows
	}
	rows := pending(admin)
	if len(rows) == 0 {
		t.Fatal("デモに承認待ちがありません")
	}
	// 先頭の1件を、申請から 5 日たったことにする
	id := rows[0].DiaryID
	if _, err := a.db.Exec(`UPDATE t_diary SET applied_at = ? WHERE diary_id = ?`, addDays(today(), -5)+"T09:00:00", id); err != nil {
		t.Fatal(err)
	}
	find := func() pendingRow {
		for _, r := range pending(admin) {
			if r.DiaryID == id {
				return r
			}
		}
		t.Fatalf("日誌 %d が承認待ちにありません", id)
		return pendingRow{}
	}

	// 既定の 3 日を越えているので滞留
	if r := find(); r.ElapsedDays != 5 || r.WarnDays != 3 || !r.Stale {
		t.Fatalf("既定: %+v", r)
	}
	// ちょうど 5 日は「越えて」いないので、5 日に変えると滞留ではない
	saveSetting(t, h, admin, "approval.warn_days", "5")
	if r := find(); r.ElapsedDays != 5 || r.WarnDays != 5 || r.Stale {
		t.Fatalf("5 日: %+v", r)
	}
	saveSetting(t, h, admin, "approval.warn_days", "4")
	if r := find(); !r.Stale || r.WarnDays != 4 {
		t.Fatalf("4 日: %+v", r)
	}
	// 申請した日と同じ日は 0 日。滞留にしない
	if _, err := a.db.Exec(`UPDATE t_diary SET applied_at = ? WHERE diary_id = ?`, today()+"T00:00:00", id); err != nil {
		t.Fatal(err)
	}
	if r := find(); r.ElapsedDays != 0 || r.Stale {
		t.Fatalf("当日: %+v", r)
	}
	// 管理者だけが見られる
	expectStatus(t, request(t, h, teacher, "GET", "/api/diaries/pending", ""), http.StatusForbidden)
}
