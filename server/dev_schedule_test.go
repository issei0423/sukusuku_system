package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

/*
 * 推奨スケジュールの作り方（GitHub Issue #164 の 3「予定の無い園児は『予定どおり』のまま」）
 * 典拠：基本設計書.md「推奨スケジュールの作り方」(4-9)
 *      「最初の予定日｜園児を登録した日（画面・CSV）を基準日とし、基準日の月齢の推奨頻度の日数を足した日」
 *      「健診の節目を優先｜基準日と上の日のあいだに乳幼児健診の節目（1歳6か月・3歳・5歳の応当日）があれば、節目の日を予定日にする」
 *      「予定の無い在籍園児（第3.0版より前に登録した園児）には、管理者が一括で規則を当てる操作を置く」
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、web/tests/devSchedule.test.ts と同じ観点で確かめる。
 */

// testRule は、デモデータと同じマスタ・設定の値（seed.sql の m_development_frequency と dev.milestone_months）
var testRule = scheduleRule{
	frequencies: []devFrequency{{0, 11, 90}, {12, 35, 120}, {36, 72, 180}},
	milestones:  []int{18, 36, 60},
}

func TestMonthAnniversary(t *testing.T) {
	for _, tc := range []struct {
		birth  string
		months int
		want   string
	}{
		{"2025-06-22", 18, "2026-12-22"},
		{"2025-01-31", 1, "2025-02-28"},  // 応当日が無い月は末日
		{"2023-01-31", 13, "2024-02-29"}, // うるう年の末日
		{"2023-08-31", 18, "2025-02-28"},
		{"2024-12-05", 36, "2027-12-05"},
		{"abc", 18, ""},
	} {
		got := monthAnniversary(tc.birth, tc.months)
		if got != tc.want {
			t.Errorf("monthAnniversary(%q, %d) = %q, want %q", tc.birth, tc.months, got, tc.want)
		}
		// 応当日に、月齢がちょうど months になる（月齢の算出と同じ考え方）
		if got != "" && ageInMonths(tc.birth, got) != tc.months {
			t.Errorf("ageInMonths(%q, %q) = %d, want %d", tc.birth, got, ageInMonths(tc.birth, got), tc.months)
		}
	}
}

func TestScheduleRuleNext(t *testing.T) {
	for _, tc := range []struct {
		name, birth, base, want string
		ok                      bool
	}{
		{"0歳児は基準日に90日を足す", "2025-09-09", "2026-09-01", "2026-11-30", true},
		{"1〜2歳児は120日を足す", "2024-05-14", "2026-09-01", "2026-12-30", true},
		{"3歳以上は180日を足す", "2023-03-01", "2026-09-01", "2027-02-28", true},
		{"あいだに1歳6か月があれば節目の日にする", "2025-06-22", "2026-09-01", "2026-12-22", true},
		{"あいだに3歳があれば節目の日にする", "2023-11-15", "2026-09-01", "2026-11-15", true},
		{"基準日ちょうどの節目は予定日にしない", "2025-03-01", "2026-09-01", "2026-12-30", true},
		{"推奨頻度の日のあとの節目は使わない", "2025-07-15", "2026-09-01", "2026-12-30", true},
		{"推奨頻度がマスタに無い月齢では作らない", "2019-01-01", "2026-09-01", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := testRule.next(tc.birth, tc.base)
			if got != tc.want || ok != tc.ok {
				t.Fatalf("next(%q, %q) = (%q, %v), want (%q, %v)", tc.birth, tc.base, got, ok, tc.want, tc.ok)
			}
		})
	}
	t.Run("節目の設定が読めなければ既定値に戻す", func(t *testing.T) {
		if got := parseMilestones([]string{"36", "18"}); fmt.Sprint(got) != "[18 36]" {
			t.Fatalf("parseMilestones = %v, want [18 36]", got)
		}
		if got := parseMilestones([]string{"18", "abc"}); fmt.Sprint(got) != "[18 36 60]" {
			t.Fatalf("parseMilestones = %v, want [18 36 60]", got)
		}
	})
}

// birthForMilestoneIn は、今日から days 日後（以降で日が 28 以下の最初の日）に 1歳6か月を迎える生年月日と、その節目の日を返す
func birthForMilestoneIn(days int) (birth, milestone string) {
	milestone = addDays(today(), days)
	for {
		if _, _, d, _ := splitDate(milestone); d <= 28 {
			break
		}
		milestone = addDays(milestone, 1)
	}
	y, m, d, _ := splitDate(milestone)
	total := y*12 + (m - 1) - 18
	return fmt.Sprintf("%04d-%02d-%02d", total/12, total%12+1, d), milestone
}

func scheduleOf(t *testing.T, a *app, childID string) (string, int) {
	t.Helper()
	var (
		on string
		n  int
	)
	a.db.QueryRow(`SELECT COUNT(*), IFNULL(MAX(scheduled_on), '') FROM t_development_schedule WHERE child_id = ?`,
		childID).Scan(&n, &on)
	return on, n
}

func childBody(childID, birth string, classID int) string {
	return fmt.Sprintf(`{"mode":"create","child_id":%q,"child_name":"予定 太郎","child_name_kana":"よてい たろう",
		"birth_date":%q,"sex":"1","photo_consent_level":"2","class_id":%d,"allergies":[],"medical_histories":[]}`,
		childID, birth, classID)
}

// 園児の登録（画面・CSV）で、最初の予定日が入る
func TestRegisterChildGetsFirstSchedule(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")
	baby := addDays(today(), -200) // 0歳6か月ごろ。節目は遠い
	milestoneBirth, milestone := birthForMilestoneIn(10)

	t.Run("画面の登録：登録日に推奨頻度の日数を足した日", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/children", childBody("C101", baby, 1))
		if on, n := scheduleOf(t, a, "C101"); n != 1 || on != addDays(today(), 90) {
			t.Fatalf("予定 %d 件・%s, want 1 件・%s", n, on, addDays(today(), 90))
		}
		var manual int
		a.db.QueryRow(`SELECT is_manual_override FROM t_development_schedule WHERE child_id = 'C101'`).Scan(&manual)
		if manual != 0 {
			t.Fatal("規則で作った予定に、手動上書きの印が付いています")
		}
		// 一覧に予定日が出て、「予定どおり」（未実施ではない）
		found := false
		for _, r := range devListOf(t, h, teacher, "1") {
			if r.Child.ChildID != "C101" {
				continue
			}
			found = true
			if r.ScheduledOn == nil || *r.ScheduledOn != addDays(today(), 90) || r.Overdue {
				t.Fatalf("一覧の行 = %+v", r)
			}
		}
		if !found {
			t.Fatal("一覧に登録した園児がいません")
		}
	})

	t.Run("画面の登録：あいだに健診の節目があれば、節目の日を先にする", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/children", childBody("C102", milestoneBirth, 1))
		if on, _ := scheduleOf(t, a, "C102"); on != milestone {
			t.Fatalf("予定日 = %s, want %s（1歳6か月の応当日）", on, milestone)
		}
	})

	t.Run("編集では予定を足さない", func(t *testing.T) {
		body := strings.Replace(childBody("C101", baby, 1), `"mode":"create"`, `"mode":"edit"`, 1)
		call(t, h, admin, "POST", "/api/children", body)
		if _, n := scheduleOf(t, a, "C101"); n != 1 {
			t.Fatalf("編集で予定が %d 件になりました", n)
		}
	})

	t.Run("CSV 一括登録も、同じ規則で当てる", func(t *testing.T) {
		text := csvHead + "C111,一括 一郎,いっかつ いちろう," + baby + ",1,さくら組,\n" +
			"C112,一括 二郎,いっかつ じろう," + milestoneBirth + ",1,ひまわり組,\n"
		body, _ := json.Marshal(map[string]string{"text": text})
		call(t, h, admin, "POST", "/api/children/csv/import", string(body))
		if on, n := scheduleOf(t, a, "C111"); n != 1 || on != addDays(today(), 90) {
			t.Fatalf("C111 の予定 %d 件・%s, want 1 件・%s", n, on, addDays(today(), 90))
		}
		if on, _ := scheduleOf(t, a, "C112"); on != milestone {
			t.Fatalf("C112 の予定日 = %s, want %s", on, milestone)
		}
	})
}

// 予定の無い在籍園児に、管理者が一括で推奨を当てる
func TestApplyRecommendedSchedules(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")

	apply := func(t *testing.T) int {
		t.Helper()
		var got struct {
			Applied int `json:"applied"`
		}
		if err := json.Unmarshal(call(t, h, admin, "POST", "/api/development/schedules/apply", "").Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got.Applied
	}

	t.Run("デモデータの在籍園児には、すべて予定がある", func(t *testing.T) {
		if n := apply(t); n != 0 {
			t.Fatalf("新しいデータベースで %d 名に当てました", n)
		}
	})

	// 第3.0版より前に登録した園児のように、予定の無い園児を作る。
	// C201：記録の無い 0歳児（下書きだけある）。C202：200日前に確定した記録がある 0歳児（下書きはもっと新しい日）。C203：退園
	call(t, h, admin, "POST", "/api/children", childBody("C201", addDays(today(), -200), 1))
	call(t, h, admin, "POST", "/api/children", childBody("C202", addDays(today(), -330), 1))
	call(t, h, admin, "POST", "/api/children", childBody("C203", addDays(today(), -200), 1))
	lastChecked := addDays(today(), -200)
	mustExec(t, a, `DELETE FROM t_development_schedule WHERE child_id IN ('C201','C202','C203')`)
	mustExec(t, a, `INSERT INTO t_development_check (child_id, checked_on, status, staff_id, share_status, finalized_at)
		VALUES ('C202', ?, '2', 'S003', '1', ?), ('C202', ?, '1', 'S003', '1', NULL), ('C201', ?, '1', 'S003', '1', NULL)`,
		lastChecked, lastChecked+"T10:00:00", addDays(today(), -20), addDays(today(), -20))
	mustExec(t, a, `UPDATE m_child SET enrollment_status = '2' WHERE child_id = 'C203'`)
	c001Before, c001Count := scheduleOf(t, a, "C001")

	t.Run("担任は当てられない", func(t *testing.T) {
		expectStatus(t, request(t, h, teacher, "POST", "/api/development/schedules/apply", ""), http.StatusForbidden)
		if _, n := scheduleOf(t, a, "C201"); n != 0 {
			t.Fatal("断ったはずの予定ができています")
		}
	})

	t.Run("基準日は最後に確定した実施日。無ければ当てた日。下書きは基準にしない", func(t *testing.T) {
		if n := apply(t); n != 2 {
			t.Fatalf("当てた園児 %d 名, want 2（C201・C202）", n)
		}
		if on, _ := scheduleOf(t, a, "C201"); on != addDays(today(), 90) {
			t.Fatalf("C201 の予定日 = %s, want %s（当てた日 + 90 日）", on, addDays(today(), 90))
		}
		if on, _ := scheduleOf(t, a, "C202"); on != addDays(lastChecked, 90) {
			t.Fatalf("C202 の予定日 = %s, want %s（最後の実施日 + 90 日）", on, addDays(lastChecked, 90))
		}
		if _, n := scheduleOf(t, a, "C203"); n != 0 {
			t.Fatal("退園した園児に予定を当てています")
		}
		if on, n := scheduleOf(t, a, "C001"); on != c001Before || n != c001Count {
			t.Fatalf("予定のある園児の予定が変わりました: %s（%d 件）→ %s（%d 件）", c001Before, c001Count, on, n)
		}
	})

	t.Run("最後の実施日から数えて予定日を過ぎていれば「過ぎた」（未実施）になる", func(t *testing.T) {
		got := map[string]bool{}
		for _, r := range devListOf(t, h, teacher, "1") {
			got[r.Child.ChildID] = r.Overdue
		}
		if !got["C202"] || got["C201"] {
			t.Fatalf("未実施 C201=%v C202=%v, want false・true", got["C201"], got["C202"])
		}
	})

	t.Run("当てた園児ごとに操作ログへ残す", func(t *testing.T) {
		for id, from := range map[string]string{"C201": "当てた日から算出", "C202": "最後の実施日から算出"} {
			var after string
			a.db.QueryRow(`SELECT IFNULL(after_value, '') FROM t_operation_log
				WHERE target_table = 't_development_schedule' AND target_child_id = ?
				ORDER BY operation_log_id DESC LIMIT 1`, id).Scan(&after)
			if !strings.Contains(after, "推奨を一括で当てた") || !strings.Contains(after, from) {
				t.Fatalf("%s の操作ログ = %q", id, after)
			}
		}
	})

	t.Run("もう一度当てても、予定のある園児は変えない", func(t *testing.T) {
		if n := apply(t); n != 0 {
			t.Fatalf("2 回目に %d 名へ当てました", n)
		}
	})
}

// デモデータの、予定の無かった園児（C009〜C022）の予定日は、基準日に規則で当てた日と同じ。
// 日付ずらし（seed_shift.go）は生年月日と予定日を同じ日数だけ動かすので、ずらす前の日付で比べる
func TestSeedSchedulesFollowRule(t *testing.T) {
	a, _ := newTestApp(t)
	offset, err := daysFromSeedBase()
	if err != nil {
		t.Fatal(err)
	}
	rule := a.loadScheduleRule()
	for i := 9; i <= 22; i++ {
		id := fmt.Sprintf("C%03d", i)
		var birth string
		a.db.QueryRow(`SELECT birth_date FROM m_child WHERE child_id = ?`, id).Scan(&birth)
		on, n := scheduleOf(t, a, id)
		want, _ := rule.next(addDays(birth, -offset), seedBaseDate)
		if n != 1 || addDays(on, -offset) != want {
			t.Errorf("%s の予定 %d 件・%s（ずらす前 %s）, want %s", id, n, on, addDays(on, -offset), want)
		}
	}
}
