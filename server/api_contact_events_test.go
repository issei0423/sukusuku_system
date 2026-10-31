package main

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

/*
きょうのようすの記録（食事・排せつ・体温）と、訂正・取り消し（詳細設計書「きょうのようす」(4-4 (1))・
「訂正・取り消し」(4-7)・「午睡」(4-6 (4))・「テストの観点」(9-1)）。
モックの同じ観点は web/tests/contactEvents.test.ts にある（訂正できる人の表 fixCases は同じ行にする。9-2）。

Go のテストは本物の時計で動く。今日のデモの記録を前提にせず、テストの中で記録してから確かめる（詳細設計書「時計」(9-3)）。
*/

type eventResp struct {
	ID          int64    `json:"contact_event_id"`
	ChildID     string   `json:"child_id"`
	EventType   string   `json:"event_type"`
	RecordedAt  string   `json:"recorded_at"`
	MealAmount  *string  `json:"meal_amount"`
	ToiletLabel *string  `json:"toilet_label"`
	Temperature *float64 `json:"temperature"`
	StaffName   string   `json:"staff_name"`
	CorrectedAt *string  `json:"corrected_at"`
	UpdatedAt   string   `json:"updated_at"`
}

type recordResp struct {
	Events  []eventResp `json:"events"`
	Skipped []string    `json:"skipped"`
}

func record(t *testing.T, h http.Handler, c *http.Cookie, items string) recordResp {
	t.Helper()
	var out recordResp
	decode(t, call(t, h, c, "POST", "/api/contact/events", `{"items":[`+items+`]}`), &out)
	return out
}

// guardianEvents は、保護者が読むその日のページの出来事
func guardianEvents(t *testing.T, h http.Handler, guardian *http.Cookie, child string) []eventResp {
	t.Helper()
	var page struct {
		Events []eventResp `json:"events"`
	}
	decode(t, call(t, h, guardian, "GET", "/api/contact/children/"+child, ""), &page)
	return page.Events
}

func findEvent(list []eventResp, id int64) *eventResp {
	for i := range list {
		if list[i].ID == id {
			return &list[i]
		}
	}
	return nil
}

// 記録すると、その時点で保護者のページに入る（段1。承認を待たない）。検査に当たれば何も保存しない
func TestContactEventsRecord(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")

	t.Run("検査（入力を止める）", func(t *testing.T) {
		many := strings.TrimSuffix(strings.Repeat(`{"child_id":"C001","event_type":"2","toilet_label":"おしっこ"},`, 51), ",")
		for _, c := range []struct{ body, msg string }{
			{`{"items":[]}`, msgBadRequest},
			{`{"items":[` + many + `]}`, msgBadRequest},
			{`{"items":[{"child_id":"C001","event_type":"1","meal_kind":"1"}]}`, msgBadChoice},
			{`{"items":[{"child_id":"C001","event_type":"1","meal_kind":"3","meal_amount":"1"}]}`, msgBadChoice},
			{`{"items":[{"child_id":"C001","event_type":"1","meal_kind":"1","meal_amount":"5"}]}`, msgBadChoice},
			{`{"items":[{"child_id":"C001","event_type":"1","meal_kind":"1","meal_amount":"1","meal_round":3}]}`, msgBadChoice},
			{`{"items":[{"child_id":"C001","event_type":"2","toilet_label":"おもらし"}]}`, msgBadChoice},
			{`{"items":[{"child_id":"C001","event_type":"3","temperature":36.55}]}`, msgTemperatureFormat},
			{`{"items":[{"child_id":"C001","event_type":"3"}]}`, msgTemperatureFormat},
			{`{"items":[{"child_id":"C001","event_type":"2","toilet_label":"おしっこ","recorded_at":"` + daysFromToday(1) + `T00:00:00"}]}`, msgEventTimeRange},
			{`{"items":[{"child_id":"C001","event_type":"2","toilet_label":"おしっこ","recorded_at":"` + daysFromToday(-1) + `T23:59:00"}]}`, msgEventTimeRange},
			{`{"items":[{"child_id":"C001","event_type":"3","temperature":36.5,"recorded_at":"10:00"}]}`, msgEventTimeRange},
			// 写真はこの経路で受け付けない
			{`{"items":[{"child_id":"C001","event_type":"5"}]}`, msgBadChoice},
		} {
			b := expectStatus(t, request(t, h, teacher, "POST", "/api/contact/events", c.body), http.StatusBadRequest)
			if !strings.Contains(b, c.msg) {
				t.Errorf("%.80s: %s, want %s", c.body, b, c.msg)
			}
		}
		toilet := `{"items":[{"child_id":"C001","event_type":"2","toilet_label":"おしっこ"}]}`
		expectStatus(t, request(t, h, otherTeacher, "POST", "/api/contact/events", toilet), http.StatusForbidden)
		expectStatus(t, request(t, h, guardian, "POST", "/api/contact/events", toilet), http.StatusForbidden)
		b := expectStatus(t, request(t, h, teacher, "POST", "/api/contact/events",
			`{"items":[{"child_id":"C999","event_type":"2","toilet_label":"おしっこ"}]}`), http.StatusForbidden)
		if !strings.Contains(b, msgContactForbidden) {
			t.Errorf("無い園児: %s", b)
		}
	})

	t.Run("1件でも誤りがあれば何も保存しない", func(t *testing.T) {
		before := len(guardianEvents(t, h, guardian, "C001"))
		expectStatus(t, request(t, h, teacher, "POST", "/api/contact/events",
			`{"items":[{"child_id":"C001","event_type":"2","toilet_label":"うんち"},{"child_id":"C002","event_type":"3","temperature":36.55}]}`),
			http.StatusBadRequest)
		if after := len(guardianEvents(t, h, guardian, "C001")); after != before {
			t.Errorf("誤りのある要求で保存された: %d → %d", before, after)
		}
	})

	t.Run("排せつ・体温を記録すると保護者のページに入る。範囲の外の体温も保存する（判定しない）", func(t *testing.T) {
		at := today() + "T00:00:00"
		got := record(t, h, teacher, `{"child_id":"C001","event_type":"2","toilet_label":"うんち","recorded_at":"`+at+`"},
			{"child_id":"C001","event_type":"3","temperature":29.5},{"child_id":"C001","event_type":"3","temperature":43.5}`)
		if len(got.Events) != 3 || len(got.Skipped) != 0 || got.Events[0].RecordedAt != at || got.Events[0].StaffName != "鈴木 浩之" {
			t.Fatalf("記録の応答: %+v", got)
		}
		body := call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.String()
		for _, want := range []string{`"temperature":29.5`, `"temperature":43.5`, `"toilet_label":"うんち"`} {
			if !strings.Contains(body, want) {
				t.Errorf("保護者のページに %s が無い: %s", want, body)
			}
		}
		for _, hidden := range []string{"staff_name", "updated_at", "鈴木"} {
			if strings.Contains(body, hidden) {
				t.Errorf("保護者のページに %s が入っている", hidden)
			}
		}
	})

	t.Run("食事の回：その回の記録がある子は飛ばして上書きしない（全員ぜんぶ）", func(t *testing.T) {
		snack := func(child string, round int) string {
			return `{"child_id":"` + child + `","event_type":"1","meal_kind":"2","meal_amount":"1","meal_round":` + itoa(int64(round)) + `}`
		}
		if got := record(t, h, teacher, snack("C003", 1)); len(got.Events) != 1 {
			t.Fatalf("1人ずつ: %+v", got)
		}
		got := record(t, h, teacher, snack("C003", 1)+","+snack("C004", 1))
		if len(got.Events) != 1 || got.Events[0].ChildID != "C004" || len(got.Skipped) != 1 || got.Skipped[0] != "C003" {
			t.Errorf("全員ぜんぶ（1回目）: %+v", got)
		}
		// おやつの2回目は、1回目の記録があっても入る。2回目が既にあれば飛ばす
		if got := record(t, h, teacher, snack("C003", 2)); len(got.Events) != 1 {
			t.Errorf("おやつ（2回目）: %+v", got)
		}
		if got := record(t, h, teacher, snack("C003", 2)); len(got.Events) != 0 || len(got.Skipped) != 1 {
			t.Errorf("おやつ（2回目）の二重: %+v", got)
		}
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE function_type = '8' AND operation_type = '1' AND target_table = 't_contact_event'`).Scan(&n)
		if n < 6 {
			t.Errorf("出来事の作成の操作ログ = %d", n)
		}
	})

	t.Run("保護者に出さない設定の種類は、ページにも出さない", func(t *testing.T) {
		a.db.Exec(`UPDATE m_setting SET setting_value = 'nap,meal,temperature,comment,photo,class' WHERE setting_key = 'contact.show_items'`)
		defer a.db.Exec(`UPDATE m_setting SET setting_value = 'nap,meal,toilet,temperature,comment,photo,class' WHERE setting_key = 'contact.show_items'`)
		for _, e := range guardianEvents(t, h, guardian, "C001") {
			if e.EventType == "2" {
				t.Errorf("出さない設定の排せつが保護者に出ている: %+v", e)
			}
		}
	})
}

// 知らせは、記録した園児を読める職員とその家庭の保護者にだけ届く。ほかの家庭には何も届かない。全員ぜんぶでも園児ごとに1回
func TestNotifyContactEvents(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	clients := map[string]*liveClient{
		"管理者":       listen(a, accAdmin),
		"さくら組の担任":   listen(a, accTeacher),
		"ひまわり組の担任":  listen(a, accOtherTeacher),
		"西田 太郎の保護者": listen(a, accGuardian),
		"村田 美咲の保護者": listen(a, accOtherGuard),
	}
	drainAll(clients)
	taro := liveEvent{Type: evContact, ChildID: childTaro}
	misaki := liveEvent{Type: evContact, ChildID: childMisaki}

	got := record(t, h, teacher, `{"child_id":"C001","event_type":"2","toilet_label":"おしっこ"},{"child_id":"C001","event_type":"3","temperature":36.6}`)
	expect(t, "排せつと体温（1回だけ）", clients, to(who("管理者", "さくら組の担任", "西田 太郎の保護者"), taro))

	record(t, h, teacher, `{"child_id":"C001","event_type":"1","meal_kind":"2","meal_amount":"1"},{"child_id":"C004","event_type":"1","meal_kind":"2","meal_amount":"2"}`)
	expect(t, "全員ぜんぶ（園児ごと）", clients, map[string][]liveEvent{
		"管理者":       {taro, misaki},
		"さくら組の担任":   {taro, misaki},
		"西田 太郎の保護者": {taro},
		"村田 美咲の保護者": {misaki},
	})

	call(t, h, teacher, "POST", "/api/contact/events/"+itoa(got.Events[0].ID)+"/correct",
		`{"toilet_label":"うんち","updated_at":"`+got.Events[0].UpdatedAt+`"}`)
	expect(t, "訂正", clients, to(who("管理者", "さくら組の担任", "西田 太郎の保護者"), taro))
	call(t, h, teacher, "POST", "/api/contact/events/"+itoa(got.Events[1].ID)+"/cancel", `{}`)
	expect(t, "取り消し", clients, to(who("管理者", "さくら組の担任", "西田 太郎の保護者"), taro))

	// 保護者に排せつを出さない設定の園では、排せつの知らせを保護者に送らない（知らせが届くこと自体が情報になる）
	a.db.Exec(`UPDATE m_setting SET setting_value = 'nap,meal,temperature,comment,photo,class' WHERE setting_key = 'contact.show_items'`)
	record(t, h, teacher, `{"child_id":"C001","event_type":"2","toilet_label":"おしっこ"}`)
	expect(t, "出さない設定の排せつ", clients, to(who("管理者", "さくら組の担任"), taro))
}

/*
fixCases は「直す人・記録の日 → 直せるか」の表（詳細設計書「訂正・取り消しのまとめ」(3-5)、基本設計書「取り消し・訂正」(4-2)）。
その日はその園児のクラスの担任（記録した職員に限らない）、管理者はいつでも。web/tests/contactEvents.test.ts の同じ名前の表と同じ行にする。
記録は管理者（西田 拓也）が付けたもの。
*/
var fixCases = []struct {
	name     string
	account  int64
	pastDay  bool
	free     bool
	wantCode int
}{
	{"記録した職員でなくても、その日はクラスの担任が直せる", accTeacher, false, false, http.StatusOK},
	{"管理者はその日に直せる", accAdmin, false, false, http.StatusOK},
	{"管理者は翌日以降も直せる", accAdmin, true, false, http.StatusOK},
	{"担任でも翌日以降は直せない", accTeacher, true, false, http.StatusForbidden},
	{"ほかのクラスの担任は読めない（無い記録と同じ）", accOtherTeacher, false, false, http.StatusForbidden},
	{"フリーの職員は読めるが直せない", accOtherTeacher, false, true, http.StatusForbidden},
	{"保護者は直せない", accGuardian, false, false, http.StatusForbidden},
}

func TestContactEventFixTable(t *testing.T) {
	for _, c := range fixCases {
		t.Run(c.name, func(t *testing.T) {
			a, h := newTestApp(t)
			admin := loginAs(a, accAdmin, "staff")
			got := record(t, h, admin, `{"child_id":"C001","event_type":"1","meal_kind":"2","meal_amount":"1"}`)
			e := got.Events[0]
			if c.pastDay {
				a.db.Exec(`UPDATE t_contact_event SET contact_date = ?, recorded_at = ? WHERE contact_event_id = ?`,
					daysFromToday(-1), daysFromToday(-1)+"T15:00:00", e.ID)
			}
			if c.free {
				a.db.Exec(`DELETE FROM t_class_staff WHERE staff_id = 'S005'`)
			}
			who := loginAs(a, c.account, map[bool]string{true: "guardian", false: "staff"}[c.account == accGuardian])
			body := `{"meal_amount":"3","updated_at":"` + e.UpdatedAt + `"}`
			b := expectStatus(t, request(t, h, who, "POST", "/api/contact/events/"+itoa(e.ID)+"/correct", body), c.wantCode)
			cancel := request(t, h, who, "POST", "/api/contact/events/"+itoa(e.ID)+"/cancel", `{}`)
			if cancel.Code != c.wantCode {
				t.Errorf("取り消し: %d, want %d (%s)", cancel.Code, c.wantCode, cancel.Body.String())
			}
			if c.wantCode == http.StatusForbidden && c.account != accGuardian && c.account != accOtherTeacher || c.free {
				if !strings.Contains(b, msgFixForbidden) {
					t.Errorf("直せない人の文言: %s", b)
				}
			}
		})
	}
}

// 訂正すると保護者に「訂正しました（時刻）」が出る。取り消すと保護者の全画面から消える。読んだ版が古ければ 409
func TestContactEventCorrectCancel(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	got := record(t, h, teacher, `{"child_id":"C001","event_type":"1","meal_kind":"2","meal_amount":"1"},
		{"child_id":"C001","event_type":"2","toilet_label":"おしっこ"},{"child_id":"C001","event_type":"3","temperature":36.6}`)
	meal, toilet, temp := got.Events[0], got.Events[1], got.Events[2]
	path := func(e eventResp, op string) string { return "/api/contact/events/" + itoa(e.ID) + "/" + op }

	b := expectStatus(t, request(t, h, teacher, "POST", path(meal, "correct"), `{"meal_amount":"3","updated_at":"2000-01-01T00:00:00"}`), http.StatusConflict)
	if !strings.Contains(b, msgFixConflict) || !strings.Contains(b, kindVersionConflict) {
		t.Errorf("古い版の訂正: %s", b)
	}
	expectStatus(t, request(t, h, teacher, "POST", path(meal, "correct"), `{"meal_amount":"9","updated_at":"`+meal.UpdatedAt+`"}`), http.StatusBadRequest)
	expectStatus(t, request(t, h, teacher, "POST", path(meal, "correct"), `{"updated_at":"`+meal.UpdatedAt+`"}`), http.StatusBadRequest)
	expectStatus(t, request(t, h, teacher, "POST", path(toilet, "correct"), `{"toilet_label":"おもらし","updated_at":"`+toilet.UpdatedAt+`"}`), http.StatusBadRequest)
	expectStatus(t, request(t, h, teacher, "POST", path(temp, "correct"), `{"temperature":36.66,"updated_at":"`+temp.UpdatedAt+`"}`), http.StatusBadRequest)
	b = expectStatus(t, request(t, h, teacher, "POST", path(toilet, "correct"),
		`{"recorded_at":"`+daysFromToday(1)+`T08:00:00","updated_at":"`+toilet.UpdatedAt+`"}`), http.StatusBadRequest)
	if !strings.Contains(b, msgEventTimeRange) {
		t.Errorf("先の時刻: %s", b)
	}

	var fixed eventResp
	decode(t, call(t, h, teacher, "POST", path(meal, "correct"), `{"meal_amount":"3","updated_at":"`+meal.UpdatedAt+`"}`), &fixed)
	if fixed.CorrectedAt == nil || *fixed.MealAmount != "3" {
		t.Fatalf("訂正: %+v", fixed)
	}
	// 直す先は、その記録の日の 0 時ちょうど。時刻を直せるのは「その日の0時からいままで」なので、
	// 決まった時刻（たとえば 00:05）だと、夜中の 0 時すぎに回したときに未来になって断られる（2026-10-25 に公開先の反映で落ちた）。
	// 記録の日から作るのは、記録したあとに日付が変わっても、その記録の日の中に収めるため
	at := toilet.RecordedAt[:10] + "T00:00:00"
	call(t, h, teacher, "POST", path(toilet, "correct"), `{"recorded_at":"`+at+`","updated_at":"`+toilet.UpdatedAt+`"}`)
	list := guardianEvents(t, h, guardian, "C001")
	if e := findEvent(list, meal.ID); e == nil || e.CorrectedAt == nil || *e.MealAmount != "3" {
		t.Errorf("保護者に訂正が出ていない: %+v", e)
	}
	if e := findEvent(list, toilet.ID); e == nil || e.RecordedAt != at {
		t.Errorf("排せつの時刻の訂正: %+v", e)
	}
	// 操作ログの変更前後は、変わった項目だけ
	var before, after string
	a.db.QueryRow(`SELECT before_value, after_value FROM t_operation_log WHERE function_type = '8' AND operation_type = '2'
		AND target_table = 't_contact_event' AND target_id = ?`, meal.ID).Scan(&before, &after)
	if before != `{"meal_amount":"1"}` || after != `{"meal_amount":"3"}` {
		t.Errorf("訂正の操作ログ: %s → %s", before, after)
	}

	// 取り消しの確認に出す数：取り消す記録のあとに開いた家庭の数
	var readers struct {
		Families  int `json:"family_count"`
		Guardians int `json:"guardian_count"`
	}
	decode(t, call(t, h, teacher, "GET", path(temp, "readers"), ""), &readers)
	if readers.Families != 0 {
		t.Errorf("まだ開いていない: %+v", readers)
	}
	call(t, h, guardian, "POST", "/api/contact/children/C001/read", `{"date":"`+today()+`"}`)
	decode(t, call(t, h, teacher, "GET", path(temp, "readers"), ""), &readers)
	if readers.Families != 1 || readers.Guardians != 1 {
		t.Errorf("開いたあと: %+v", readers)
	}
	expectStatus(t, request(t, h, loginAs(a, accOtherTeacher, "staff"), "GET", path(temp, "readers"), ""), http.StatusForbidden)

	var cancelled struct {
		OK       bool `json:"ok"`
		Families int  `json:"read_family_count"`
	}
	decode(t, call(t, h, teacher, "POST", path(temp, "cancel"), `{}`), &cancelled)
	if !cancelled.OK || cancelled.Families != 1 {
		t.Errorf("取り消しの応答: %+v", cancelled)
	}
	if findEvent(guardianEvents(t, h, guardian, "C001"), temp.ID) != nil {
		t.Errorf("取り消した体温が保護者に出ている")
	}
	staffBody := call(t, h, teacher, "GET", "/api/contact/children/C001", "").Body.String()
	if strings.Contains(staffBody, `"contact_event_id":`+itoa(temp.ID)+`,`) {
		t.Errorf("取り消した体温が職員のページに出ている")
	}
	// 取り消したものは、もう直せない・取り消せない（無い記録と同じ）
	expectStatus(t, request(t, h, teacher, "POST", path(temp, "cancel"), `{}`), http.StatusForbidden)
	var logged string
	a.db.QueryRow(`SELECT before_value FROM t_operation_log WHERE function_type = '8' AND operation_type = '4' AND target_id = ?`, temp.ID).Scan(&logged)
	if !strings.Contains(logged, `"temperature":36.6`) {
		t.Errorf("取り消しの操作ログに元の値が無い: %s", logged)
	}
	// 時刻を後から付けた記録は、保存した時刻より前に開いた家庭を「読んでいる」に数えない（自動レビューの指摘）
	back := record(t, h, teacher, `{"child_id":"C001","event_type":"2","toilet_label":"おしっこ","recorded_at":"`+today()+`T00:00:00"}`)
	a.db.Exec(`UPDATE t_contact_read SET read_at = ? WHERE account_id = ? AND child_id = 'C001'`, today()+"T00:00:01", accGuardian)
	decode(t, call(t, h, teacher, "GET", path(back.Events[0], "readers"), ""), &readers)
	if readers.Families != 0 {
		t.Errorf("後から時刻を付けた記録の読んでいる家庭: %+v", readers)
	}
	// 職員のページは書けるかを返す（保護者には返さない）
	if !strings.Contains(staffBody, `"can_write":true`) {
		t.Errorf("職員のページに can_write が無い")
	}
	if pb := call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.String(); strings.Contains(pb, "can_write\"") {
		t.Errorf("保護者のページに can_write が入っている: %s", pb)
	}
}

// ねた・おきたの訂正・取り消し。実施の後も直せる。おきたが無いまま終わった組に人が「おきた」を入れられる
func TestNapSleepCorrectCancel(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	admin := loginAs(a, accAdmin, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	s := startOwnNap(t, h, teacher)
	var slept napSleepOut
	decode(t, call(t, h, teacher, "POST", "/api/nap/session/"+itoa(s.NapSessionID)+"/sleeps", `{"child_id":"C001"}`), &slept)
	call(t, h, teacher, "POST", "/api/nap/session/"+itoa(s.NapSessionID)+"/end", "")
	start := today() + "T00:00:00"
	a.db.Exec(`UPDATE t_nap_sleep SET slept_at = ?, updated_at = ? WHERE nap_sleep_id = ?`, start, start, slept.ID)
	clients := map[string]*liveClient{
		"さくら組の担任":   listen(a, accTeacher),
		"西田 太郎の保護者": listen(a, accGuardian),
		"村田 美咲の保護者": listen(a, accOtherGuard),
	}
	path := "/api/nap/sleeps/" + itoa(slept.ID)

	expectStatus(t, request(t, h, otherTeacher, "POST", path+"/correct", `{"woke_at":"`+now()+`","updated_at":"`+start+`"}`), http.StatusForbidden)
	expectStatus(t, request(t, h, guardian, "POST", path+"/correct", `{"woke_at":"`+now()+`","updated_at":"`+start+`"}`), http.StatusForbidden)
	b := expectStatus(t, request(t, h, teacher, "POST", path+"/correct", `{"woke_at":"`+start+`","updated_at":"`+start+`"}`), http.StatusBadRequest)
	if !strings.Contains(b, msgWakeBeforeSleep) {
		t.Errorf("ねたより前のおきた: %s", b)
	}
	b = expectStatus(t, request(t, h, teacher, "POST", path+"/correct", `{"woke_at":"`+daysFromToday(1)+`T00:00:00","updated_at":"`+start+`"}`), http.StatusBadRequest)
	if !strings.Contains(b, msgEventTimeRange) {
		t.Errorf("先のおきた: %s", b)
	}
	expectStatus(t, request(t, h, teacher, "POST", path+"/correct", `{"woke_at":"`+now()+`","updated_at":"2000-01-01T00:00:00"}`), http.StatusConflict)
	drainAll(clients)

	// 実施が終わったあとに、人が「おきた」を入れる（自動では入れない）
	woke := now()
	var fixed napSleepOut
	decode(t, call(t, h, teacher, "POST", path+"/correct", `{"woke_at":"`+woke+`","updated_at":"`+start+`"}`), &fixed)
	if fixed.WokeAt == nil || *fixed.WokeAt != woke || fixed.CorrectedAt == nil {
		t.Fatalf("おきたの訂正: %+v", fixed)
	}
	expect(t, "ねた・おきたの訂正", clients, map[string][]liveEvent{
		"さくら組の担任":   {{Type: evNap, ClassID: classSakura, ChildID: childTaro}, {Type: evContact, ChildID: childTaro}},
		"西田 太郎の保護者": {{Type: evContact, ChildID: childTaro}},
	})
	var page struct {
		Sleeps []napSleepOut `json:"sleeps"`
	}
	decode(t, call(t, h, guardian, "GET", "/api/contact/children/C001", ""), &page)
	if len(page.Sleeps) != 1 || page.Sleeps[0].WokeAt == nil || page.Sleeps[0].CorrectedAt == nil {
		t.Errorf("保護者のページの訂正: %+v", page.Sleeps)
	}
	var wokeStaff string
	a.db.QueryRow(`SELECT IFNULL(woke_staff_id, '') FROM t_nap_sleep WHERE nap_sleep_id = ?`, slept.ID).Scan(&wokeStaff)
	if wokeStaff != "S003" {
		t.Errorf("おきたを入れた職員 = %q", wokeStaff)
	}

	// 翌日以降は管理者だけ
	a.db.Exec(`UPDATE t_nap_session SET session_date = ? WHERE nap_session_id = ?`, daysFromToday(-1), s.NapSessionID)
	b = expectStatus(t, request(t, h, teacher, "POST", path+"/cancel", `{}`), http.StatusForbidden)
	if !strings.Contains(b, msgFixForbidden) {
		t.Errorf("翌日の担任の取り消し: %s", b)
	}
	a.db.Exec(`UPDATE t_nap_session SET session_date = ? WHERE nap_session_id = ?`, today(), s.NapSessionID)
	var res struct {
		OK bool `json:"ok"`
	}
	decode(t, call(t, h, admin, "POST", path+"/cancel", `{}`), &res)
	decode(t, call(t, h, guardian, "GET", "/api/contact/children/C001", ""), &page)
	if !res.OK || len(page.Sleeps) != 0 {
		t.Errorf("取り消した組が保護者に出ている: %+v", page.Sleeps)
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE function_type = '3' AND target_table = 't_nap_sleep' AND operation_type IN ('2','4')`).Scan(&n)
	if n != 2 {
		t.Errorf("ねた・おきたの訂正・取り消しの操作ログ = %d, want 2", n)
	}
}

/*
「ねた」と「おきた」が同じ秒に押されると、おきたは ねた＋1秒になり（handleWake。詳細設計書「午睡」(4-6 (3))）、まだ来ていない時刻になる。
その直後に同じ組を直しても断らない。直すときに「その日の0時からいままで」を検査するのは要求で変えた時刻だけで、
元の値と同じ時刻はそのまま通す（受け入れテスト 04-017 で見つかった）。変えた時刻が先なら、これまでどおり断る。
モックは web/tests/contactEvents.test.ts の同じ観点の確かめ
*/
func TestNapSleepCorrectRightAfterSameSecondWake(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	s := startOwnNap(t, h, teacher)
	var slept napSleepOut
	decode(t, call(t, h, teacher, "POST", "/api/nap/session/"+itoa(s.NapSessionID)+"/sleeps", `{"child_id":"C001"}`), &slept)
	// Go のテストの時計は止められない。「ねた」を2秒先へずらし、「おきた」が「ねた」と同じ秒（より前）に押された形を作る
	const layout = "2006-01-02T15:04:05"
	ahead := nowTime().Add(2 * time.Second)
	if ahead.Add(2*time.Second).Format("2006-01-02") != today() {
		t.Skip("日付の変わり目に近い（ねた・おきたが翌日になる）")
	}
	mustExec(t, a, `UPDATE t_nap_sleep SET slept_at = ? WHERE nap_sleep_id = ?`, ahead.Format(layout), slept.ID)
	var woke napSleepOut
	decode(t, call(t, h, teacher, "POST", "/api/nap/sleeps/"+itoa(slept.ID)+"/wake", ""), &woke)
	if want := ahead.Add(time.Second).Format(layout); woke.WokeAt == nil || *woke.WokeAt != want {
		t.Fatalf("同じ秒のおきた = %v、ねた＋1秒 %s のはず", woke.WokeAt, want)
	}
	if *woke.WokeAt <= now() {
		t.Fatalf("おきた %s がもう過ぎている（テストが遅い）", *woke.WokeAt)
	}
	path := "/api/nap/sleeps/" + itoa(slept.ID) + "/correct"
	start := today() + "T00:00:00"

	// すぐ「ねた」を直す。おきたは送らない（画面は変えた時刻だけを送る。FixDialog.tsx）
	var fixed napSleepOut
	decode(t, call(t, h, teacher, "POST", path, `{"slept_at":"`+start+`","updated_at":"`+woke.UpdatedAt+`"}`), &fixed)
	if fixed.SleptAt != start || fixed.WokeAt == nil || *fixed.WokeAt != *woke.WokeAt || fixed.CorrectedAt == nil {
		t.Fatalf("同じ秒のおきたのあとの訂正: %+v", fixed)
	}
	// おきたを元の値のまま添えても通す
	next := today() + "T00:00:01"
	decode(t, call(t, h, teacher, "POST", path,
		`{"slept_at":"`+next+`","woke_at":"`+*woke.WokeAt+`","updated_at":"`+fixed.UpdatedAt+`"}`), &fixed)
	if fixed.SleptAt != next || fixed.WokeAt == nil || *fixed.WokeAt != *woke.WokeAt {
		t.Fatalf("元のおきたを添えた訂正: %+v", fixed)
	}
	// おきたを、まだ来ていない別の時刻へ変えるのは断る
	later := ahead.Add(2 * time.Second).Format(layout)
	b := expectStatus(t, request(t, h, teacher, "POST", path, `{"woke_at":"`+later+`","updated_at":"`+fixed.UpdatedAt+`"}`), http.StatusBadRequest)
	if !strings.Contains(b, msgEventTimeRange) {
		t.Errorf("先のおきたへの訂正: %s", b)
	}
}
