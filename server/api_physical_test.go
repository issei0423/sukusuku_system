package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

/*
 * 身体測定の測定回と上書きの確認（GitHub Issue #165 の 1・2）
 * 典拠：基本設計書.md「身体測定の記録」(4-8)「選択中の測定日と同一の年月に登録済みの園児には入力済みマークを付す」・
 *      「測定回の単位は年月とする」・「同一園児・同一測定日に未削除の記録があれば、上書き確認を表示する」・
 *      「確認の種類ごとに、対応する承諾だけを受け付ける」、「入力項目の制約値」(4-9)、メッセージ一覧「測定日の形式不正」
 *
 * 画面側のモック（web/src/api/mock.ts の physicalApi）と同じ規則であることを、
 * web/tests/napPhysical.test.ts と同じ観点で確かめる。
 */

// lastMonthDay は先月の day 日を 'YYYY-MM-DD' で返す。いつ回しても過去の日付になり、デモの記録（起動日へずれる）と重ならない園児で使う
func lastMonthDay(day int) string {
	t := nowTime()
	first := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, jst).AddDate(0, -1, 0)
	return first.AddDate(0, 0, day-1).Format("2006-01-02")
}

func physicalBody(childID, measuredOn string, height, weight float64, extra string) string {
	return fmt.Sprintf(`{"child_id":%q,"measured_on":%q,"height_cm":%v,"weight_kg":%v%s}`,
		childID, measuredOn, height, weight, extra)
}

type physicalStatus struct {
	Target  []Child `json:"target"`
	Done    []Child `json:"done"`
	Pending []Child `json:"pending"`
}

func hasChild(list []Child, childID string) bool {
	for _, c := range list {
		if c.ChildID == childID {
			return true
		}
	}
	return false
}

func TestPhysicalClassStatusCountsByMonth(t *testing.T) {
	a, h := newTestApp(t)
	suzuki := loginAs(a, 3, "staff") // さくら組
	call(t, h, suzuki, "POST", "/api/physical/records", physicalBody("C007", lastMonthDay(3), 80.1, 10.2, ""))

	statusOf := func(measuredOn string) physicalStatus {
		var got physicalStatus
		if err := json.Unmarshal(call(t, h, suzuki, "GET",
			"/api/physical/class-status?class_id=1&measured_on="+measuredOn, "").Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got
	}

	t.Run("同じ年月の別の日を選んでも、入力済みとして数える", func(t *testing.T) {
		got := statusOf(lastMonthDay(10))
		if !hasChild(got.Done, "C007") || hasChild(got.Pending, "C007") {
			t.Fatalf("同じ月の記録がある園児が未実施になっています: done=%v pending=%v", got.Done, got.Pending)
		}
	})

	t.Run("ほかの月を選ぶと、未実施として数える", func(t *testing.T) {
		got := statusOf(today())
		if hasChild(got.Done, "C007") || !hasChild(got.Pending, "C007") {
			t.Fatalf("先月の記録が今月の記録として数えられています: done=%v", got.Done)
		}
	})

	t.Run("削除した記録は数えない", func(t *testing.T) {
		admin := loginAs(a, 1, "staff")
		var id int64
		a.db.QueryRow(`SELECT physical_record_id FROM t_physical_record WHERE child_id = 'C007' AND is_deleted = 0`).Scan(&id)
		call(t, h, admin, "DELETE", "/api/physical/records/"+itoa(id), "")
		if got := statusOf(lastMonthDay(10)); hasChild(got.Done, "C007") {
			t.Fatalf("削除した記録で入力済みになっています")
		}
	})

	t.Run("崩れた測定日は断る", func(t *testing.T) {
		expectStatus(t, request(t, h, suzuki, "GET", "/api/physical/class-status?class_id=1&measured_on=2026-1-5", ""),
			http.StatusBadRequest)
	})
}

func TestPhysicalOverwriteNeedsConfirmation(t *testing.T) {
	a, h := newTestApp(t)
	suzuki := loginAs(a, 3, "staff") // さくら組
	admin := loginAs(a, 1, "staff")
	day := lastMonthDay(5)
	call(t, h, suzuki, "POST", "/api/physical/records", physicalBody("C008", day, 82.5, 10.8, ""))

	stored := func() (float64, string, int) {
		var (
			height float64
			staff  string
			n      int
		)
		a.db.QueryRow(`SELECT height_cm, staff_id FROM t_physical_record WHERE child_id = 'C008' AND is_deleted = 0`).
			Scan(&height, &staff)
		a.db.QueryRow(`SELECT COUNT(*) FROM t_physical_record WHERE child_id = 'C008'`).Scan(&n)
		return height, staff, n
	}

	t.Run("確かめずに同じ測定日へ送ると、上書きせずに断る", func(t *testing.T) {
		body := expectStatus(t, request(t, h, admin, "POST", "/api/physical/records",
			physicalBody("C008", day, 90.0, 10.8, "")), http.StatusConflict)
		if !strings.Contains(body, "この測定日の記録は登録済みです") {
			t.Fatalf("上書き確認の文言がありません: %s", body)
		}
		if height, _, n := stored(); height != 82.5 || n != 1 {
			t.Fatalf("確かめずに書き換わっています: height=%v rows=%d", height, n)
		}
	})

	t.Run("同じ月の別の記録を承諾しても、上書きの承諾にはならない", func(t *testing.T) {
		expectStatus(t, request(t, h, admin, "POST", "/api/physical/records",
			physicalBody("C008", day, 90.0, 10.8, `,"confirm_same_month":true`)), http.StatusConflict)
		if height, _, _ := stored(); height != 82.5 {
			t.Fatalf("上書きの承諾なしに書き換わっています: %v", height)
		}
	})

	t.Run("上書きを承諾すると書き換え、記録した職員は初回登録者のまま", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/physical/records",
			physicalBody("C008", day, 90.0, 10.8, `,"confirm_overwrite":true`))
		if height, staff, n := stored(); height != 90.0 || staff != "S003" || n != 1 {
			t.Fatalf("上書きが正しくありません: height=%v staff=%s rows=%d", height, staff, n)
		}
	})
}

func TestPhysicalSameMonthNeedsConfirmation(t *testing.T) {
	a, h := newTestApp(t)
	suzuki := loginAs(a, 3, "staff") // さくら組
	call(t, h, suzuki, "POST", "/api/physical/records", physicalBody("C010", lastMonthDay(5), 82.5, 10.8, ""))

	count := func() int {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_physical_record WHERE child_id = 'C010' AND is_deleted = 0`).Scan(&n)
		return n
	}

	t.Run("同じ月の別の日へ確かめずに送ると、2件目を作らずに断る", func(t *testing.T) {
		body := expectStatus(t, request(t, h, suzuki, "POST", "/api/physical/records",
			physicalBody("C010", lastMonthDay(4), 82.3, 10.7, "")), http.StatusConflict)
		if !strings.Contains(body, "登録済みです") {
			t.Fatalf("同じ月の記録がある旨の文言がありません: %s", body)
		}
		if n := count(); n != 1 {
			t.Fatalf("確かめずに同じ月の2件目ができています: %d 件", n)
		}
	})

	t.Run("上書きを承諾しても、同じ月の別の記録の承諾にはならない", func(t *testing.T) {
		expectStatus(t, request(t, h, suzuki, "POST", "/api/physical/records",
			physicalBody("C010", lastMonthDay(4), 82.3, 10.7, `,"confirm_overwrite":true`)), http.StatusConflict)
		if n := count(); n != 1 {
			t.Fatalf("承諾なしに2件目ができています: %d 件", n)
		}
	})

	t.Run("同じ月の別の記録として承諾すると、2件目を登録する", func(t *testing.T) {
		call(t, h, suzuki, "POST", "/api/physical/records",
			physicalBody("C010", lastMonthDay(4), 82.3, 10.7, `,"confirm_same_month":true`))
		if n := count(); n != 2 {
			t.Fatalf("承諾した2件目が登録されていません: %d 件", n)
		}
	})

	t.Run("ほかの月なら確かめずに登録できる", func(t *testing.T) {
		call(t, h, suzuki, "POST", "/api/physical/records", physicalBody("C010", today(), 83.0, 11.0, ""))
	})
}

func TestPhysicalRejectsMalformedMeasuredOn(t *testing.T) {
	a, h := newTestApp(t)
	suzuki := loginAs(a, 3, "staff")
	for _, v := range []string{"2026-1-5", "2026/01/05", "2026-02-30"} {
		body := expectStatus(t, request(t, h, suzuki, "POST", "/api/physical/records",
			physicalBody("C011", v, 80, 10, "")), http.StatusBadRequest)
		if !strings.Contains(body, "測定日の形式が正しくありません") {
			t.Fatalf("%s: 形式の誤りとして断っていません: %s", v, body)
		}
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_physical_record WHERE child_id = 'C011'`).Scan(&n)
	if n != 0 {
		t.Fatalf("崩れた測定日の記録が %d 件できています", n)
	}
}
