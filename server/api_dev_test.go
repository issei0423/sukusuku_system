package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

/*
 * 発達チェックの実施日・確定・未実施の判定（GitHub Issue #164）
 * 典拠：基本設計書.md「入力項目の制約値」(4-9)「記録日・測定日　未来日は認めない（当日まで）」、
 *      「発達チェックの実施」(4-8)「実施予定日を過ぎて未入力の項目・園児をチェック漏れとして強調表示」、
 *      図/画面詳細図.md「発達チェック入力画面」(6-2) 項目3「実施日　制限：未来日は選べない」
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、
 * web/tests/devCheck.test.ts と同じ観点で確かめる。
 */

func devCheckBody(childID, checkedOn, status string) string {
	return `{"child_id":"` + childID + `","checked_on":"` + checkedOn + `","status":"` + status + `","results":[],"note":""}`
}

// 実施日は、形の崩れた値と未来日を断る
func TestDevelopmentCheckDateValidation(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff") // さくら組

	for _, d := range []string{addDays(today(), 1), "2027-03-01", "2026-10-1", "abc", "2026-02-30", today() + "T10:00:00"} {
		for _, status := range []string{"1", "2"} {
			expectStatus(t, request(t, h, teacher, "POST", "/api/development/checks", devCheckBody("C010", d, status)),
				http.StatusBadRequest)
		}
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_development_check WHERE child_id = 'C010'`).Scan(&n)
	if n != 0 {
		t.Fatalf("断ったはずの記録が %d 件できています", n)
	}
	call(t, h, teacher, "POST", "/api/development/checks", devCheckBody("C010", today(), "2"))
}

// すでに入ってしまった崩れた実施日があっても、一覧とダッシュボードが開ける
func TestDevelopmentListSurvivesBrokenDate(t *testing.T) {
	a, h := newTestApp(t)
	if _, err := a.db.Exec(`INSERT INTO t_development_check (child_id, checked_on, status, staff_id, share_status)
		VALUES ('C011', '2026-10-1', '2', 'S003', '1')`); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*http.Cookie{loginAs(a, 3, "staff"), loginAs(a, 1, "staff")} {
		call(t, h, c, "GET", "/api/development/list?class_id=1", "")
		call(t, h, c, "GET", "/api/development/schedules?class_id=1", "")
		call(t, h, c, "GET", "/api/dashboard/staff", "")
	}
}

// 月齢の計算は、形の崩れた日付で落ちない（基本設計書「月齢の算出」(4-8)）
func TestAgeInMonthsWithBrokenDate(t *testing.T) {
	for _, tc := range []struct {
		birth, base string
		want        int
	}{
		{"2025-01-15", "2026-10-1", 20}, // 一桁の日はそのまま読む
		{"2025-01-15", "abc", 0},
		{"2025-01-15", "2026-10-", 0},
		{"2025-01-15", "", 0},
		{"2025-1", "2026-10-17", 0},
	} {
		if got := ageInMonths(tc.birth, tc.base); got != tc.want {
			t.Errorf("ageInMonths(%q, %q) = %d, want %d", tc.birth, tc.base, got, tc.want)
		}
	}
}

// 管理者の予定日の上書きも、形の崩れた日付を断る
func TestSetScheduleDateValidation(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	for _, body := range []string{
		`{"child_id":"C009","scheduled_on":"2026-10-1","manual":true}`,
		`{"child_id":"C009","scheduled_on":"abc","manual":false}`,
		`{"child_id":"C009","scheduled_on":"","manual":false}`,
	} {
		expectStatus(t, request(t, h, admin, "POST", "/api/development/schedules", body), http.StatusBadRequest)
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_development_schedule WHERE child_id = 'C009'`).Scan(&n)
	if n != 0 {
		t.Fatalf("断ったはずの予定が %d 件できています", n)
	}
	call(t, h, admin, "POST", "/api/development/schedules", `{"child_id":"C009","scheduled_on":"`+today()+`","manual":true}`)
}

// 確定した発達チェックは、下書きに戻さない。確定で作った次回の予定日と食い違わせないため
func TestConfirmedCheckCannotBeDraftedAgain(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	call(t, h, teacher, "POST", "/api/development/checks", devCheckBody("C010", today(), "2"))

	expectStatus(t, request(t, h, teacher, "POST", "/api/development/checks", devCheckBody("C010", today(), "1")),
		http.StatusBadRequest)
	var status string
	a.db.QueryRow(`SELECT status FROM t_development_check WHERE child_id = 'C010' AND checked_on = ?`, today()).Scan(&status)
	if status != "2" {
		t.Fatalf("status = %q, want 2（確定のまま）", status)
	}
	// 確定のまま直すことはできる
	call(t, h, teacher, "POST", "/api/development/checks", devCheckBody("C010", today(), "2"))
}

type devListRow struct {
	Child struct {
		ChildID string `json:"child_id"`
	} `json:"child"`
	ScheduledOn *string `json:"scheduledOn"`
	Overdue     bool    `json:"overdue"`
}

func devListOf(t *testing.T, h http.Handler, c *http.Cookie, classID string) []devListRow {
	t.Helper()
	var rows []devListRow
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/development/list?class_id="+classID, "").Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

func devOverdueOf(t *testing.T, h http.Handler, c *http.Cookie) int {
	t.Helper()
	var got struct {
		DevOverdue int `json:"devOverdue"`
	}
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/dashboard/staff", "").Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got.DevOverdue
}

// 「未実施」は予定日を過ぎてから。一覧とダッシュボードは同じ数を出す
func TestDevelopmentOverdueRule(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")

	t.Run("予定日の当日は、まだ未実施にしない", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/development/schedules", `{"child_id":"C009","scheduled_on":"`+today()+`","manual":true}`)
		for _, r := range devListOf(t, h, teacher, "1") {
			if r.Child.ChildID == "C009" && r.Overdue {
				t.Fatal("予定日の当日に未実施になっています")
			}
		}
	})

	t.Run("過去の予定が複数あっても、ダッシュボードは園児ごとに数え、一覧と同じ数になる", func(t *testing.T) {
		// 加藤 大和（C009）に、満たしていない古い予定を足す
		if _, err := a.db.Exec(`INSERT INTO t_development_schedule (child_id, scheduled_on, is_manual_override, created_staff_id)
			VALUES ('C009', ?, 0, 'S001'), ('C003', ?, 0, 'S001')`, addDays(today(), -30), addDays(today(), -200)); err != nil {
			t.Fatal(err)
		}
		listed := 0
		for _, r := range devListOf(t, h, teacher, "1") {
			if r.Overdue {
				listed++
			}
		}
		if got := devOverdueOf(t, h, teacher); got != listed {
			t.Fatalf("ダッシュボード %d 件、一覧 %d 件", got, listed)
		}
	})
}

// デモデータの日付ずらしは、日付だけの列（_on）も対象にする。モック（mockDb.ts）と同じ
func TestSeedShiftMovesOnColumns(t *testing.T) {
	a, _ := newTestApp(t)
	offset, err := daysFromSeedBase()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		query, seed string
	}{
		{`SELECT measured_on FROM t_physical_record WHERE physical_record_id = 7`, "2026-09-01"},
		{`SELECT measured_on FROM t_physical_record WHERE physical_record_id = 1`, "2026-03-02"},
		{`SELECT scheduled_on FROM t_development_schedule WHERE development_schedule_id = 2`, "2026-08-20"},
		{`SELECT checked_on FROM t_development_check WHERE development_check_id = 1`, "2026-06-01"},
	} {
		var got string
		if err := a.db.QueryRow(tc.query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if want := addDays(tc.seed, offset); got != want {
			t.Errorf("%s = %s, want %s", tc.query, got, want)
		}
	}
	// 生年月日はずらさない
	var birth string
	a.db.QueryRow(`SELECT birth_date FROM m_child WHERE child_id = 'C001'`).Scan(&birth)
	if birth != "2025-06-01" {
		t.Errorf("生年月日がずれています: %s", birth)
	}
}

// 一意制約のある日付の列も、ずらす途中で同じ値が2行できて止まらない。
// 野原 太郎（C001）の身体測定は 91 日おきにあり、91 日ずらすと1行ずつ書き換える途中で測定日が重なる
func TestSeedShiftAvoidsUniqueCollision(t *testing.T) {
	a, _ := newTestApp(t)
	before := measuredOnOf(t, a, "C001")
	if err := shiftDatesBy(a.db, 91); err != nil {
		t.Fatal(err)
	}
	after := measuredOnOf(t, a, "C001")
	if len(after) != len(before) {
		t.Fatalf("行の数が変わっています: %v → %v", before, after)
	}
	for i := range before {
		if want := addDays(before[i], 91); after[i] != want {
			t.Fatalf("%d 行目: %s, want %s", i, after[i], want)
		}
	}
}

func measuredOnOf(t *testing.T, a *app, childID string) []string {
	t.Helper()
	rows, err := a.db.Query(`SELECT measured_on FROM t_physical_record WHERE child_id = ? ORDER BY physical_record_id`, childID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var v string
		rows.Scan(&v)
		out = append(out, v)
	}
	return out
}
