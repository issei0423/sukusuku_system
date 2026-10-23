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
	// デモデータの加藤 大和（C009）には、推奨で当てた予定が 1 件ある（seed.sql。GitHub Issue #164 の 3）。断った要求で変わらないことを見る
	before, beforeCount := scheduleOf(t, a, "C009")
	for _, body := range []string{
		`{"child_id":"C009","scheduled_on":"2026-10-1","manual":true}`,
		`{"child_id":"C009","scheduled_on":"abc","manual":false}`,
		`{"child_id":"C009","scheduled_on":"","manual":false}`,
	} {
		expectStatus(t, request(t, h, admin, "POST", "/api/development/schedules", body), http.StatusBadRequest)
	}
	if after, n := scheduleOf(t, a, "C009"); after != before || n != beforeCount {
		t.Fatalf("断ったはずの要求で予定が変わりました: %s（%d 件）→ %s（%d 件）", before, beforeCount, after, n)
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
		ChildID   string `json:"child_id"`
		ChildName string `json:"child_name"`
	} `json:"child"`
	ScheduledOn   *string `json:"scheduledOn"`
	LastCheckedOn *string `json:"lastCheckedOn"`
	Overdue       bool    `json:"overdue"`
	Unfilled      int     `json:"unfilled"`
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

// デモデータの日付ずらしは、日付だけの列（_on）も対象にする。モック（mockDb.ts）と同じ。
// 園児の生年月日も同じ日数だけずらし、デモの園児の月齢を起動日に合わせて保つ（GitHub Issue #164）
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
		{`SELECT checked_on FROM t_development_check WHERE development_check_id = 1`, "2026-05-15"},
		{`SELECT birth_date FROM m_child WHERE child_id = 'C001'`, "2025-06-01"},
		{`SELECT birth_date FROM m_child WHERE child_id = 'C008'`, "2025-01-31"},
	} {
		var got string
		if err := a.db.QueryRow(tc.query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if want := addDays(tc.seed, offset); got != want {
			t.Errorf("%s = %s, want %s", tc.query, got, want)
		}
	}
}

// devBody は、発達チェックの保存の本文を作る。results は項目ID → 結果（"1"〜"3"）
func devBody(t *testing.T, childID, checkedOn, status string, results map[int64]string) string {
	t.Helper()
	type result struct {
		DevelopmentItemID int64  `json:"development_item_id"`
		Result            string `json:"result"`
	}
	body := struct {
		ChildID   string   `json:"child_id"`
		CheckedOn string   `json:"checked_on"`
		Status    string   `json:"status"`
		Results   []result `json:"results"`
		Note      string   `json:"note"`
	}{ChildID: childID, CheckedOn: checkedOn, Status: status, Results: []result{}}
	for id, r := range results {
		body.Results = append(body.Results, result{id, r})
	}
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// itemsAt は、園児の、その日の月齢の区分のチェック項目のIDを返す（入力画面に出る項目と同じ）
func itemsAt(t *testing.T, a *app, childID, on string) []int64 {
	t.Helper()
	var birth string
	if err := a.db.QueryRow(`SELECT birth_date FROM m_child WHERE child_id = ?`, childID).Scan(&birth); err != nil {
		t.Fatal(err)
	}
	cat := a.categoryFor(ageInMonths(birth, on))
	if cat == nil {
		t.Fatalf("%s の %s の区分がありません", childID, on)
	}
	rows, err := a.db.Query(`SELECT development_item_id FROM m_development_item
		WHERE development_category_id = ? ORDER BY display_order`, cat.DevelopmentCategoryID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		ids = append(ids, id)
	}
	return ids
}

func devRowOf(t *testing.T, h http.Handler, c *http.Cookie, childID string) devListRow {
	t.Helper()
	for _, r := range devListOf(t, h, c, "1") {
		if r.Child.ChildID == childID {
			return r
		}
	}
	t.Fatalf("一覧に %s がいません", childID)
	return devListRow{}
}

/*
一覧の「未入力 n 件」は、下書きも含めた最新の記録で数える。入力画面の「未入力の項目」と食い違わない（GitHub Issue #143 の 1）。
典拠：要件定義書「チェック漏れの強調」(4-5-2)「下書き保存された記録は、保存されていない項目を未入力として扱う」
*/
func TestDevListCountsDraftUnfilled(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	items := itemsAt(t, a, "C001", today()) // 野原 太郎。前回の確定した記録がある

	// 1 項目だけ「未確認」を選んで下書き保存すると、残りが未入力（未確認は入力済み）
	call(t, h, teacher, "POST", "/api/development/checks",
		devBody(t, "C001", today(), "1", map[int64]string{items[0]: "3"}))
	if got, want := devRowOf(t, h, teacher, "C001").Unfilled, len(items)-1; got != want {
		t.Fatalf("1 項目を入れた下書きのあと、一覧の未入力 = %d, want %d", got, want)
	}

	// すべて選んで下書き保存すると、未入力は 0（#143 の再現：入力画面は 0 件、一覧は 3 件と出ていた）
	all := map[int64]string{}
	for _, id := range items {
		all[id] = "1"
	}
	call(t, h, teacher, "POST", "/api/development/checks", devBody(t, "C001", today(), "1", all))
	row := devRowOf(t, h, teacher, "C001")
	if row.Unfilled != 0 {
		t.Fatalf("すべて入れた下書きのあと、一覧の未入力 = %d, want 0", row.Unfilled)
	}
	// 下書きは実施にならない。前回の実施日は、確定した記録のまま
	if row.LastCheckedOn == nil || *row.LastCheckedOn == today() {
		t.Fatalf("下書きで前回の実施日が変わっています: %v", row.LastCheckedOn)
	}
}

/*
デモデータの確定した発達チェックは、実施日の月齢の区分の項目で記録してある。
日付ずらしで何日ずらしても、生年月日も同じだけずれるため区分が変わらず、一覧に「未入力」が出ない
（GitHub Issue #143 の 1・#164 の追記「月齢の区分がずれる」）
*/
func TestDevSeedChecksKeepCategoryAcrossShift(t *testing.T) {
	// 0 は起動日のまま。ほかは、さらに先の起動日を想定する（2028-02-29 をまたぐ日を含む）
	for _, extra := range []int{0, 30, 91, 200, 365, 700} {
		a, h := newTestApp(t)
		if extra != 0 {
			if err := shiftDatesBy(a.db, extra); err != nil {
				t.Fatal(err)
			}
		}
		teacher := loginAs(a, 3, "staff")
		checked := 0
		for _, r := range devListOf(t, h, teacher, "1") {
			if r.LastCheckedOn == nil {
				continue
			}
			checked++
			if r.Unfilled != 0 {
				t.Errorf("さらに %d 日ずらした日：%s（%s）の未入力 = %d, want 0", extra, r.Child.ChildName, *r.LastCheckedOn, r.Unfilled)
			}
		}
		if checked != 3 {
			t.Fatalf("前回の実施日のある園児が %d 名。デモデータでは 3 名のはず", checked)
		}
	}
}

/*
確定した記録を開き直したとき、いつ確定したかを返す（GitHub Issue #143 の 2）。
日時は操作ログの「確定」から引く。下書きのあいだは返さない
*/
func TestDraftCheckReturnsConfirmedAt(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	path := "/api/children/C010/development/draft?checked_on=" + today()

	type draftView struct {
		Check struct {
			Status  string `json:"status"`
			StaffID string `json:"staff_id"`
		} `json:"check"`
		ConfirmedAt *string `json:"confirmedAt"`
	}
	get := func() draftView {
		t.Helper()
		var v draftView
		if err := json.Unmarshal(call(t, h, teacher, "GET", path, "").Body.Bytes(), &v); err != nil {
			t.Fatal(err)
		}
		return v
	}

	call(t, h, teacher, "POST", "/api/development/checks", devCheckBody("C010", today(), "1"))
	if v := get(); v.ConfirmedAt != nil {
		t.Fatalf("下書きなのに確定した日時が返っています: %s", *v.ConfirmedAt)
	}
	call(t, h, teacher, "POST", "/api/development/checks", devCheckBody("C010", today(), "2"))
	v := get()
	if v.Check.Status != "2" || v.Check.StaffID != "S003" {
		t.Fatalf("check = %+v", v.Check)
	}
	if v.ConfirmedAt == nil || len(*v.ConfirmedAt) < 16 || (*v.ConfirmedAt)[:10] != today() {
		t.Fatalf("確定した日時 = %v, want 今日の日時", v.ConfirmedAt)
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
