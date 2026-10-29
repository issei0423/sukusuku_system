package main

import (
	"net/http"
	"strings"
	"testing"
)

/*
連絡帳の月の一覧（GitHub Issue #268 の 4。詳細設計書「連絡帳を読む経路」(4-3 (2))、図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目4）。
モックの同じ観点は web/tests/contactDetail.test.ts にある。Go のテストは本物の時計で動くため、今日の記録をテストの中で作る。
*/

type monthResp struct {
	Month     string `json:"month"`
	FromMonth string `json:"from_month"`
	ToMonth   string `json:"to_month"`
	Days      []struct {
		Date        string `json:"date"`
		HasHome     bool   `json:"has_home"`
		HasRecords  bool   `json:"has_records"`
		RecordCount int    `json:"record_count"`
		HasFacility bool   `json:"has_facility"`
		Unread      *bool  `json:"unread"`
	} `json:"days"`
}

func TestContactMonth(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	other := loginAs(a, accOtherGuard, "guardian")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	path := "/api/contact/children/C001/month"
	day := today()

	// 今日の記録（排せつ）・家庭から・園から を作る
	record(t, h, teacher, `{"child_id":"C001","event_type":"2","toilet_label":"おしっこ"}`)
	expectStatus(t, request(t, h, guardian, "PUT", "/api/contact/children/C001/home", `{"breakfast":"1","updated_at":null}`), http.StatusOK)
	expectStatus(t, request(t, h, teacher, "PUT", "/api/contact/children/C001/facility", `{"body":"今日は元気に過ごしました"}`), http.StatusOK)

	find := func(m monthResp, date string) int {
		for i, d := range m.Days {
			if d.Date == date {
				return i
			}
		}
		t.Fatalf("%s が月の一覧に無い", date)
		return -1
	}

	var asGuardian monthResp
	decode(t, call(t, h, guardian, "GET", path, ""), &asGuardian)
	if asGuardian.Month != day[:7] || asGuardian.ToMonth != day[:7] || asGuardian.FromMonth > asGuardian.ToMonth {
		t.Errorf("月: %+v", asGuardian)
	}
	// 今日より後の日は出さない
	if last := asGuardian.Days[len(asGuardian.Days)-1].Date; last != day {
		t.Errorf("最後の日 %s, want %s", last, day)
	}
	d := asGuardian.Days[find(asGuardian, day)]
	if !d.HasHome || !d.HasFacility || !d.HasRecords || d.RecordCount < 1 {
		t.Errorf("今日: %+v", d)
	}
	if d.Unread == nil || !*d.Unread {
		t.Errorf("開いていない今日に「新しい」が付かない: %+v", d)
	}

	// 開くと、新しいものは無くなる（開いた時刻と同じ秒の記録は新しいと数えないため、開いた時刻を未来にしてから確かめる）
	call(t, h, guardian, "POST", "/api/contact/children/C001/read", `{"date":"`+day+`"}`)
	a.db.Exec(`UPDATE t_contact_read SET read_at = strftime('%Y-%m-%dT%H:%M:%S', read_at, '+1 minute') WHERE account_id = ?`, accGuardian)
	decode(t, call(t, h, guardian, "GET", path, ""), &asGuardian)
	if d := asGuardian.Days[find(asGuardian, day)]; d.Unread != nil {
		t.Errorf("開いたあとも「新しい」が付く: %+v", d)
	}

	// 職員の応答には「新しい」を付けない
	var asStaff monthResp
	decode(t, call(t, h, teacher, "GET", path, ""), &asStaff)
	if d := asStaff.Days[find(asStaff, day)]; d.Unread != nil || !d.HasRecords {
		t.Errorf("職員の今日: %+v", d)
	}

	// 保護者に排せつを出さない設定なら、保護者の件数に数えない（職員には数える）
	a.db.Exec(`UPDATE m_setting SET setting_value = 'nap,meal,temperature,comment,photo,class' WHERE setting_key = 'contact.show_items'`)
	var hidden monthResp
	decode(t, call(t, h, guardian, "GET", path, ""), &hidden)
	var staffAgain monthResp
	decode(t, call(t, h, teacher, "GET", path, ""), &staffAgain)
	if g, s := hidden.Days[find(hidden, day)].RecordCount, staffAgain.Days[find(staffAgain, day)].RecordCount; g >= s {
		t.Errorf("保護者に出さない種類も数えている（保護者 %d・職員 %d）", g, s)
	}

	// 前の月：今月より前の月は日が31日までそろう。今月より先・形の崩れた月は 400
	var old monthResp
	decode(t, call(t, h, guardian, "GET", path+"?month=2020-01", ""), &old)
	if len(old.Days) != 31 || old.FromMonth != "2020-01" {
		t.Errorf("2020-01: %d日・from %s", len(old.Days), old.FromMonth)
	}
	for _, m := range []string{"2999-01", "2026-13", "202601", "x"} {
		b := expectStatus(t, request(t, h, guardian, "GET", path+"?month="+m, ""), http.StatusBadRequest)
		if !strings.Contains(b, msgContactBadDate) {
			t.Errorf("month=%s: %s", m, b)
		}
	}

	// 権限は1ページを読むのと同じ
	expectStatus(t, request(t, h, other, "GET", path, ""), http.StatusForbidden)
	expectStatus(t, request(t, h, otherTeacher, "GET", path, ""), http.StatusForbidden)
}
