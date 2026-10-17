package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

/*
連絡帳の判定・1ページ・家庭から→確認しました・ねた・おきた・知らせ（詳細設計書「テストの観点」(9-1)）。
モックの同じ観点は web/tests/contact.test.ts にある。判定の表（contactAccessCases）は、同じ表をモックのテストにも写す（9-2）。

Go のテストは本物の時計で動く。今日の連絡帳の行がデモデータに入っていることを前提にせず、
テストの中で記録してから確かめる（詳細設計書「時計」(9-3)）。
*/

// contactAccessCases は「利用者・園児 → 読める・書ける」の表。web/tests/contact.test.ts の同じ名前の表と同じ行にする
var contactAccessCases = []struct {
	name        string
	account     int64
	child       string
	read, write bool
}{
	{"管理者は全園児", accAdmin, "C001", true, true},
	{"管理者はほかのクラスの園児も", accAdmin, "C013", true, true},
	{"管理者でも無い園児は読めない", accAdmin, "C999", false, false},
	{"さくら組の担任は自クラスの園児", accTeacher, "C001", true, true},
	{"さくら組の担任はひまわり組の園児を読めない", accTeacher, "C013", false, false},
	{"ひまわり組の担任はさくら組の園児を読めない", accOtherTeacher, "C001", false, false},
	{"保護者は有効な紐づけの自児", accGuardian, "C001", true, true},
	{"保護者はほかの家庭の園児を読めない", accGuardian, "C004", false, false},
	{"ほかの家庭の保護者は野原 太郎を読めない", accOtherGuard, "C001", false, false},
	{"紐づけを終えた保護者は読めない", 8, "C003", false, false},
}

func TestContactAccessTable(t *testing.T) {
	a, _ := newTestApp(t)
	for _, c := range contactAccessCases {
		u := a.sessionUserByAccount(t, c.account)
		got := a.contactAccess(u, c.child)
		if got.Read != c.read || got.Write != c.write {
			t.Errorf("%s: got %+v, want read=%v write=%v", c.name, got, c.read, c.write)
		}
	}
	// 猶予中（3）は読めるが書けない。linked_at で切らない
	a.db.Exec(`UPDATE t_guardian_child SET link_status = '3', grace_ends_on = ?, linked_at = ? WHERE guardian_id = 'G001'`, daysFromToday(10), now())
	if got := a.contactAccess(a.sessionUserByAccount(t, accGuardian), "C001"); !got.Read || got.Write {
		t.Errorf("猶予中: %+v, want read only", got)
	}
	// フリー（今年度の担任クラスが無い一般）は全園児を読めるが書けない
	a.db.Exec(`DELETE FROM t_class_staff WHERE staff_id = 'S005'`)
	u := a.sessionUserByAccount(t, accOtherTeacher)
	for _, child := range []string{"C001", "C013"} {
		if got := a.contactAccess(u, child); !got.Read || got.Write {
			t.Errorf("フリー %s: %+v, want read only", child, got)
		}
	}
	if got := a.classContactAccess(u, classSakura); !got.Read || got.Write {
		t.Errorf("フリーのクラス: %+v, want read only", got)
	}
}

// sessionUserByAccount は、ログインの手順を飛ばしてセッションの利用者を作る
func (a *app) sessionUserByAccount(t *testing.T, accountID int64) *SessionUser {
	t.Helper()
	u, err := a.loadSessionUser(accountID)
	if err != nil {
		t.Fatalf("アカウント %d: %v", accountID, err)
	}
	return u
}

// 保護者の応答に、段3（監査の層・職員の名前）が入らない。ほかの家庭・無い園児は同じ 403 と同じ文言
func TestContactPageScope(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	other := loginAs(a, accOtherGuard, "guardian")
	s := startOwnNap(t, h, teacher)
	call(t, h, teacher, "POST", "/api/nap/session/"+itoa(s.NapSessionID)+"/sleeps", `{"child_id":"C001"}`)
	a.db.Exec(`UPDATE t_nap_sleep SET sleep_temperature = 36.7 WHERE child_id = 'C001' AND woke_at IS NULL`)

	forbidden := expectStatus(t, request(t, h, other, "GET", "/api/contact/children/C001", ""), http.StatusForbidden)
	missing := expectStatus(t, request(t, h, guardian, "GET", "/api/contact/children/C999", ""), http.StatusForbidden)
	if forbidden != missing || !strings.Contains(forbidden, msgContactForbidden) {
		t.Errorf("ほかの家庭と無い園児で応答が違う: %s / %s", forbidden, missing)
	}
	expectStatus(t, request(t, h, guardian, "GET", "/api/contact/children/C001?date="+daysFromToday(1), ""), http.StatusBadRequest)
	expectStatus(t, request(t, h, guardian, "GET", "/api/contact/classes/1", ""), http.StatusForbidden)
	expectStatus(t, request(t, h, guardian, "GET", "/api/nap/state?class_id=1&session_id="+itoa(s.NapSessionID), ""), http.StatusForbidden)
	expectStatus(t, request(t, h, other, "POST", "/api/contact/children/C001/read", `{"date":"`+today()+`"}`), http.StatusForbidden)
	expectStatus(t, request(t, h, teacher, "POST", "/api/contact/children/C001/read", `{"date":"`+today()+`"}`), http.StatusForbidden)

	body := call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.String()
	for _, hidden := range []string{"sleep_temperature", "nap_session_id", "staff_name", "guardian_name", "confirmed_staff_name", "source_diary_id", "36.7"} {
		if strings.Contains(body, hidden) {
			t.Errorf("保護者の応答に %s が入っている: %s", hidden, body)
		}
	}
	var page struct {
		Sleeps []struct {
			SleptAt string  `json:"slept_at"`
			WokeAt  *string `json:"woke_at"`
		} `json:"sleeps"`
		CanWriteHome bool `json:"can_write_home"`
	}
	json.Unmarshal([]byte(body), &page)
	if len(page.Sleeps) != 1 || page.Sleeps[0].WokeAt != nil || !page.CanWriteHome {
		t.Errorf("保護者のページ: %s", body)
	}
	if !strings.Contains(body, `"last_read_at":null`) {
		t.Errorf("保護者の応答に last_read_at が無い: %s", body)
	}
	// 職員の応答には入眠時の体温と記録した職員の名前がある
	staffBody := call(t, h, teacher, "GET", "/api/contact/children/C001", "").Body.String()
	if !strings.Contains(staffBody, `"sleep_temperature":36.7`) || strings.Contains(staffBody, "last_read_at") {
		t.Errorf("職員の応答: %s", staffBody)
	}
	// 保護者に出さない設定にした種類は、開いた時点の設定で落とす
	a.db.Exec(`UPDATE m_setting SET setting_value = 'meal,toilet,temperature,comment,photo,class' WHERE setting_key = 'contact.show_items'`)
	json.Unmarshal(call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.Bytes(), &page)
	if len(page.Sleeps) != 0 {
		t.Errorf("出さない設定の午睡が保護者に出ている: %+v", page.Sleeps)
	}
	// 開いた時刻を残すと、次の応答の last_read_at に入る
	call(t, h, guardian, "POST", "/api/contact/children/C001/read", `{"date":"`+today()+`"}`)
	if b := call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.String(); strings.Contains(b, `"last_read_at":null`) {
		t.Errorf("開いた時刻が残っていない: %s", b)
	}
}

type homeResp struct {
	ID          int64   `json:"contact_home_id"`
	UpdatedAt   string  `json:"updated_at"`
	ConfirmedAt *string `json:"confirmed_at"`
	RevisedAt   *string `json:"revised_at"`
	Breakfast   *string `json:"breakfast"`
	PickupType  *string `json:"pickup_type"`
	PickupTime  *string `json:"pickup_time"`
	GuardianRel string  `json:"guardian_relationship"`
	StaffName   string  `json:"confirmed_staff_name"`
}

// 家庭から→確認しました（詳細設計書「家庭から」(3-1) の表の行ごと）
func TestContactHomeFlow(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	other := loginAs(a, accOtherGuard, "guardian")
	path := "/api/contact/children/C001/home"
	summary := func() (int, int) {
		var s struct {
			Unconfirmed int `json:"homeUnconfirmed"`
			Revised     int `json:"homeRevised"`
		}
		decode(t, call(t, h, teacher, "GET", "/api/dashboard/staff", ""), &s)
		return s.Unconfirmed, s.Revised
	}
	u0, r0 := summary()

	t.Run("検査（入力を止める）", func(t *testing.T) {
		for _, c := range []struct{ body, msg string }{
			{`{"updated_at":null}`, msgHomeEmpty},
			{`{"message":"   ","updated_at":null}`, msgHomeEmpty},
			{`{"temperature":36.55,"updated_at":null}`, msgTemperatureFormat},
			{`{"night_sleep_from":"21:05","updated_at":null}`, msgBadChoice},
			{`{"breakfast":"5","updated_at":null}`, msgBadChoice},
			{`{"mood_label":"元気","updated_at":null}`, msgBadChoice},
			{`{"pickup_type":"2","pickup_person":"祖母","updated_at":null}`, msgPickupRequired},
			{`{"pickup_type":"2","pickup_person":"` + strings.Repeat("あ", 51) + `","pickup_time":"17:00","updated_at":null}`, msgPickupPersonTooLong},
			{`{"message":"` + strings.Repeat("あ", 501) + `","updated_at":null}`, msgHomeMessageTooLong},
		} {
			b := expectStatus(t, request(t, h, guardian, "PUT", path, c.body), http.StatusBadRequest)
			if !strings.Contains(b, c.msg) {
				t.Errorf("%s: %s, want %s", c.body, b, c.msg)
			}
		}
		expectStatus(t, request(t, h, teacher, "PUT", path, `{"breakfast":"1","updated_at":null}`), http.StatusForbidden)
		expectStatus(t, request(t, h, other, "PUT", path, `{"breakfast":"1","updated_at":null}`), http.StatusForbidden)
		// 範囲の外の体温も保存できる（判定しない）。ここでは確かめるだけで保存しない別の園児は無いため、値の検査だけを見る
	})

	var home homeResp
	t.Run("送る→未確認（ダッシュボードの未確認が1つ増える）", func(t *testing.T) {
		decode(t, call(t, h, guardian, "PUT", path,
			`{"temperature":43.5,"breakfast":"1","mood_label":"ごきげん","pickup_type":"2","pickup_person":"祖母","pickup_time":"17:30","updated_at":null}`), &home)
		if home.ConfirmedAt != nil || home.RevisedAt != nil || home.PickupTime == nil || *home.PickupTime != "17:30" {
			t.Fatalf("送った家庭から: %+v", home)
		}
		if u, r := summary(); u != u0+1 || r != r0 {
			t.Errorf("未確認 %d→%d・更新 %d→%d", u0, u, r0, r)
		}
	})

	t.Run("確認しました：ほかのクラスの職員は押せない・読んだ版が古ければ 409", func(t *testing.T) {
		confirm := "/api/contact/home/" + itoa(home.ID) + "/confirm"
		expectStatus(t, request(t, h, otherTeacher, "POST", confirm, `{"updated_at":"`+home.UpdatedAt+`"}`), http.StatusForbidden)
		expectStatus(t, request(t, h, guardian, "POST", confirm, `{"updated_at":"`+home.UpdatedAt+`"}`), http.StatusForbidden)
		b := expectStatus(t, request(t, h, teacher, "POST", confirm, `{"updated_at":"2000-01-01T00:00:00"}`), http.StatusConflict)
		if !strings.Contains(b, msgConfirmConflict) || !strings.Contains(b, kindVersionConflict) {
			t.Errorf("古い版の確認: %s", b)
		}
		var confirmed homeResp
		decode(t, call(t, h, teacher, "POST", confirm, `{"updated_at":"`+home.UpdatedAt+`"}`), &confirmed)
		if confirmed.ConfirmedAt == nil || confirmed.StaffName != "高梨 倫太朗" || confirmed.GuardianRel != "父" {
			t.Fatalf("確認しました: %+v", confirmed)
		}
		// 二重の確認は書き換えない（200 で今の行）
		var again homeResp
		decode(t, call(t, h, teacher, "POST", confirm, `{"updated_at":"`+home.UpdatedAt+`"}`), &again)
		if *again.ConfirmedAt != *confirmed.ConfirmedAt {
			t.Errorf("二重の確認で書き換わった: %v → %v", *confirmed.ConfirmedAt, *again.ConfirmedAt)
		}
		home = confirmed
		// 保護者の画面には「園が確認しました（時刻）」。職員の名前は出さない
		pb := call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.String()
		if !strings.Contains(pb, `"confirmed_at":"`+*confirmed.ConfirmedAt+`"`) || strings.Contains(pb, "高梨") {
			t.Errorf("保護者のページ: %s", pb)
		}
		if u, r := summary(); u != u0 || r != r0 {
			t.Errorf("確認のあと 未確認 %d・更新 %d, want %d・%d", u, r, u0, r0)
		}
	})

	t.Run("確認済みを送り直す→更新（確認が外れる）。父母が同時に直したら 409", func(t *testing.T) {
		b := expectStatus(t, request(t, h, guardian, "PUT", path, `{"breakfast":"2","updated_at":"2000-01-01T00:00:00"}`), http.StatusConflict)
		if !strings.Contains(b, msgHomeConflict) {
			t.Errorf("古い版の送り直し: %s", b)
		}
		var revised homeResp
		decode(t, call(t, h, guardian, "PUT", path, `{"breakfast":"2","pickup_type":"1","updated_at":"`+home.UpdatedAt+`"}`), &revised)
		if revised.ConfirmedAt != nil || revised.RevisedAt == nil || *revised.Breakfast != "2" || revised.PickupTime != nil {
			t.Fatalf("送り直し: %+v", revised)
		}
		if u, r := summary(); u != u0 || r != r0+1 {
			t.Errorf("送り直しのあと 未確認 %d・更新 %d, want %d・%d", u, r, u0, r0+1)
		}
		// 外れた確認（誰が・いつ）は操作ログの before_value に残る
		var before string
		a.db.QueryRow(`SELECT before_value FROM t_operation_log WHERE function_type = '8' AND operation_type = '2'
			AND target_table = 't_contact_home' AND target_id = ? ORDER BY operation_log_id DESC LIMIT 1`, home.ID).Scan(&before)
		if !strings.Contains(before, `"confirmed_staff_id":"S003"`) || !strings.Contains(before, *home.ConfirmedAt) {
			t.Errorf("操作ログの before_value: %s", before)
		}
	})

	t.Run("猶予中の保護者は家庭からを送れない", func(t *testing.T) {
		a.db.Exec(`UPDATE t_guardian_child SET link_status = '3' WHERE guardian_id = 'G001'`)
		b := expectStatus(t, request(t, h, guardian, "PUT", path, `{"breakfast":"1","updated_at":null}`), http.StatusForbidden)
		if !strings.Contains(b, msgContactGraceReadOnly) {
			t.Errorf("猶予中: %s", b)
		}
		call(t, h, guardian, "GET", "/api/contact/children/C001", "")
	})
}

// ねた・おきた（詳細設計書「午睡の園児」(3-4)）。5分ごとの確認は今までどおり残る
func TestNapSleepWake(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	s := startOwnNap(t, h, teacher)
	base := "/api/nap/session/" + itoa(s.NapSessionID)

	expectStatus(t, request(t, h, otherTeacher, "POST", base+"/sleeps", `{"child_id":"C001"}`), http.StatusForbidden)
	expectStatus(t, request(t, h, guardian, "POST", base+"/sleeps", `{"child_id":"C001"}`), http.StatusForbidden)
	expectStatus(t, request(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C013"}`), http.StatusForbidden)
	expectStatus(t, request(t, h, teacher, "POST", "/api/nap/session/99999/sleeps", `{"child_id":"C001"}`), http.StatusBadRequest)

	var slept napSleepOut
	decode(t, call(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C001"}`), &slept)
	if slept.WokeAt != nil || slept.ChildID != "C001" {
		t.Fatalf("ねた: %+v", slept)
	}
	b := expectStatus(t, request(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C001"}`), http.StatusConflict)
	if !strings.Contains(b, msgSleepTwice) {
		t.Errorf("二重のねた: %s", b)
	}
	// 5分ごとの確認は「ねた」と同じ行で今までどおり記録できる（監査の記録を弱めない）
	call(t, h, teacher, "POST", base+"/records", `{"child_id":"C001","body_position":"1","breathing":"1","complexion":"1"}`)

	// 午睡チェック画面の状態に、その実施の「ねた・おきた」と対象外が入る
	var state []struct {
		Child struct {
			ChildID string `json:"child_id"`
		} `json:"child"`
		Latest *struct{} `json:"latest"`
		Sleeps []napSleepOut
	}
	decode(t, call(t, h, teacher, "GET", "/api/nap/state?class_id=1&session_id="+itoa(s.NapSessionID), ""), &state)
	for _, row := range state {
		if row.Child.ChildID == "C001" && (len(row.Sleeps) != 1 || row.Latest == nil) {
			t.Errorf("午睡チェックの行: %+v", row)
		}
	}

	expectStatus(t, request(t, h, otherTeacher, "POST", "/api/nap/sleeps/"+itoa(slept.ID)+"/wake", ""), http.StatusForbidden)
	var woke napSleepOut
	decode(t, call(t, h, teacher, "POST", "/api/nap/sleeps/"+itoa(slept.ID)+"/wake", ""), &woke)
	if woke.WokeAt == nil || *woke.WokeAt <= woke.SleptAt {
		t.Fatalf("おきた: %+v", woke)
	}
	b = expectStatus(t, request(t, h, teacher, "POST", "/api/nap/sleeps/"+itoa(slept.ID)+"/wake", ""), http.StatusConflict)
	if !strings.Contains(b, msgWokeTwice) {
		t.Errorf("二重のおきた: %s", b)
	}
	// もう一度ねた（おきたのあと）は記録できる
	call(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C001"}`)

	// 対象外の子には「ねた」を押せない
	a.db.Exec(`INSERT INTO t_nap_exclusion (nap_session_id, child_id, reason, staff_id, created_at) VALUES (?, 'C002', '1', 'S003', ?)`, s.NapSessionID, now())
	b = expectStatus(t, request(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C002"}`), http.StatusConflict)
	if !strings.Contains(b, msgSleepExcluded) {
		t.Errorf("対象外のねた: %s", b)
	}
	// 実施が終わったあとは 409。おきたが無いまま終わった組は「ねた（おきた時刻なし）」として返す（session_ended）
	call(t, h, teacher, "POST", base+"/end", "")
	b = expectStatus(t, request(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C004"}`), http.StatusConflict)
	if !strings.Contains(b, kindSessionEnded) {
		t.Errorf("終了後のねた: %s", b)
	}
	var page struct {
		Sleeps []napSleepOut `json:"sleeps"`
	}
	decode(t, call(t, h, guardian, "GET", "/api/contact/children/C001", ""), &page)
	last := page.Sleeps[len(page.Sleeps)-1]
	if last.WokeAt != nil || !last.SessionEnded {
		t.Errorf("おきたが無いまま終わった組: %+v（おきたを推測で入れない）", last)
	}
	// 操作ログ（午睡・作成／変更）
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE function_type = '3' AND target_table = 't_nap_sleep'`).Scan(&n)
	if n != 3 {
		t.Errorf("ねた・おきたの操作ログ = %d, want 3", n)
	}
}

// 「ねた」「家庭から」の知らせは、その園児を読める職員とその家庭の保護者にだけ届く。ほかの家庭には何も届かない
func TestNotifyContactAudience(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	s := startOwnNap(t, h, teacher)
	clients := map[string]*liveClient{
		"管理者":       listen(a, accAdmin),
		"さくら組の担任":   listen(a, accTeacher),
		"ひまわり組の担任":  listen(a, accOtherTeacher),
		"野原 太郎の保護者": listen(a, accGuardian),
		"宮城 美咲の保護者": listen(a, accOtherGuard),
	}
	drainAll(clients)
	taro := liveEvent{Type: evContact, ChildID: childTaro}
	napTaro := liveEvent{Type: evNap, ClassID: classSakura, ChildID: childTaro}

	var slept napSleepOut
	decode(t, call(t, h, teacher, "POST", "/api/nap/session/"+itoa(s.NapSessionID)+"/sleeps", `{"child_id":"C001"}`), &slept)
	expect(t, "ねた（職員には nap と contact、保護者には contact だけ。ほかの家庭には届かない）", clients, map[string][]liveEvent{
		"管理者":       {napTaro, taro},
		"さくら組の担任":   {napTaro, taro},
		"野原 太郎の保護者": {taro},
	})

	call(t, h, teacher, "POST", "/api/nap/sleeps/"+itoa(slept.ID)+"/wake", "")
	expect(t, "おきた", clients, map[string][]liveEvent{
		"管理者":       {napTaro, taro},
		"さくら組の担任":   {napTaro, taro},
		"野原 太郎の保護者": {taro},
	})

	var home homeResp
	decode(t, call(t, h, guardian, "PUT", "/api/contact/children/C001/home", `{"breakfast":"1","updated_at":null}`), &home)
	expect(t, "家庭から", clients, to(who("管理者", "さくら組の担任", "野原 太郎の保護者"), taro))
	call(t, h, teacher, "POST", "/api/contact/home/"+itoa(home.ID)+"/confirm", `{"updated_at":"`+home.UpdatedAt+`"}`)
	expect(t, "確認しました", clients, to(who("管理者", "さくら組の担任", "野原 太郎の保護者"), taro))

	// 保護者に午睡を出さない設定の園では、「ねた」の知らせも保護者に送らない（知らせが届くこと自体が情報になる）
	a.db.Exec(`UPDATE m_setting SET setting_value = 'meal,toilet,temperature,comment,photo,class' WHERE setting_key = 'contact.show_items'`)
	call(t, h, teacher, "POST", "/api/nap/session/"+itoa(s.NapSessionID)+"/sleeps", `{"child_id":"C001"}`)
	expect(t, "出さない設定のねた", clients, to(who("管理者", "さくら組の担任"), napTaro, taro))
}

// 保護者ホームの「きょう」（詳細設計書「ダッシュボード」(4-8 (1))）。ねたが記録した時点で入り、開くと未読が消える
func TestGuardianToday(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	type row struct {
		Child struct {
			ChildID string `json:"child_id"`
		} `json:"child"`
		Today struct {
			ChildID       string       `json:"child_id"`
			CanWriteHome  bool         `json:"can_write_home"`
			Nap           *napSleepOut `json:"nap"`
			Latest        []todayItemOut
			UnreadContact int `json:"unread_contact"`
		} `json:"today"`
	}
	read := func() row {
		var rows []row
		decode(t, call(t, h, guardian, "GET", "/api/dashboard/guardian", ""), &rows)
		if len(rows) != 1 || rows[0].Today.ChildID != "C001" {
			t.Fatalf("保護者ホーム: %+v", rows)
		}
		return rows[0]
	}
	call(t, h, guardian, "POST", "/api/contact/children/C001/read", `{"date":"`+today()+`"}`)
	before := read()
	if before.Today.UnreadContact != 0 || !before.Today.CanWriteHome || len(before.Today.Latest) > 3 {
		t.Fatalf("開いた直後: %+v", before.Today)
	}
	s := startOwnNap(t, h, teacher)
	// 開いた時刻と同じ秒に記録すると新しいものと数えないため、開いた時刻を1分前にしておく
	a.db.Exec(`UPDATE t_contact_read SET read_at = strftime('%Y-%m-%dT%H:%M:%S', read_at, '-1 minute') WHERE account_id = ?`, accGuardian)
	call(t, h, teacher, "POST", "/api/nap/session/"+itoa(s.NapSessionID)+"/sleeps", `{"child_id":"C001"}`)
	after := read()
	if after.Today.Nap == nil || after.Today.Nap.WokeAt != nil || after.Today.Nap.SleepTemperature != nil || after.Today.UnreadContact != 1 {
		t.Fatalf("ねたのあと: %+v", after.Today)
	}
}

// きょうは対象外（詳細設計書「午睡の園児」(3-4)）。「ねた」のある子は対象外にできず、対象外の子は「ねた」を押せない。
// 戻すと「まだ」に戻る。知らせは nap だけ（保護者へは送らない。監査の層）
func TestNapExclusion(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	s := startOwnNap(t, h, teacher)
	base := "/api/nap/session/" + itoa(s.NapSessionID)
	clients := map[string]*liveClient{
		"さくら組の担任":   listen(a, accTeacher),
		"野原 太郎の保護者": listen(a, accGuardian),
	}
	drainAll(clients)

	expectStatus(t, request(t, h, otherTeacher, "POST", base+"/exclusions", `{"child_id":"C001","reason":"1"}`), http.StatusForbidden)
	expectStatus(t, request(t, h, guardian, "POST", base+"/exclusions", `{"child_id":"C001","reason":"1"}`), http.StatusForbidden)
	expectStatus(t, request(t, h, teacher, "POST", base+"/exclusions", `{"child_id":"C001","reason":"3"}`), http.StatusBadRequest)

	var x napExclusionOut
	decode(t, call(t, h, teacher, "POST", base+"/exclusions", `{"child_id":"C001","reason":"1"}`), &x)
	if x.Reason != "1" || x.ChildID != "C001" {
		t.Fatalf("対象外: %+v", x)
	}
	expect(t, "対象外（保護者へは送らない）", clients,
		to(who("さくら組の担任"), liveEvent{Type: evNap, ClassID: classSakura, ChildID: childTaro}))
	b := expectStatus(t, request(t, h, teacher, "POST", base+"/exclusions", `{"child_id":"C001","reason":"2"}`), http.StatusConflict)
	if !strings.Contains(b, kindAlreadyExists) {
		t.Errorf("二重の対象外: %s", b)
	}
	b = expectStatus(t, request(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C001"}`), http.StatusConflict)
	if !strings.Contains(b, msgSleepExcluded) {
		t.Errorf("対象外のねた: %s", b)
	}
	// 保護者の連絡帳には対象外を出さない（監査の層）
	if body := call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.String(); strings.Contains(body, "exclusion") || strings.Contains(body, "欠席") {
		t.Errorf("保護者の応答に対象外が入っている: %s", body)
	}

	call(t, h, teacher, "POST", "/api/nap/exclusions/"+itoa(x.ID)+"/cancel", "")
	drainAll(clients)
	call(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C001"}`)
	b = expectStatus(t, request(t, h, teacher, "POST", base+"/exclusions", `{"child_id":"C001","reason":"1"}`), http.StatusBadRequest)
	if !strings.Contains(b, msgExcludeAfterSleep) {
		t.Errorf("ねたのある子の対象外: %s", b)
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE function_type = '3' AND target_table = 't_nap_exclusion'`).Scan(&n)
	if n != 2 {
		t.Errorf("対象外の操作ログ = %d, want 2（作成・削除）", n)
	}
}

// 「ねた」と「きょうは対象外」を同時に押しても、同じ園児に両方は成り立たない（詳細設計書「午睡の園児」(3-4)、
// 基本設計書「きょうは対象外」(4-8)「『ねた』を記録した園児は、対象外にできない」）。
// 確かめと書き込みのあいだに、もう片方の書き込みを割り込ませない。負けた側は、順に押したときと同じ応答を返す。
// モックの同じ観点は web/tests/contact.test.ts の「ねたと対象外を同時に押す」
func TestNapSleepAndExclusionAtOnce(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	s := startOwnNap(t, h, teacher)
	base := "/api/nap/session/" + itoa(s.NapSessionID)
	for i := 0; i < 40; i++ {
		a.db.Exec(`DELETE FROM t_nap_sleep WHERE nap_session_id = ? AND child_id = 'C002'`, s.NapSessionID)
		a.db.Exec(`DELETE FROM t_nap_exclusion WHERE nap_session_id = ? AND child_id = 'C002'`, s.NapSessionID)
		var sleepRec, excludeRec *httptest.ResponseRecorder
		var wg sync.WaitGroup
		start := make(chan struct{})
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			sleepRec = request(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C002"}`)
		}()
		go func() {
			defer wg.Done()
			<-start
			excludeRec = request(t, h, teacher, "POST", base+"/exclusions", `{"child_id":"C002","reason":"1"}`)
		}()
		close(start)
		wg.Wait()

		var sleeps, exclusions int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_sleep WHERE nap_session_id = ? AND child_id = 'C002' AND is_deleted = 0`, s.NapSessionID).Scan(&sleeps)
		a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_exclusion WHERE nap_session_id = ? AND child_id = 'C002' AND is_deleted = 0`, s.NapSessionID).Scan(&exclusions)
		if sleeps+exclusions != 1 {
			t.Fatalf("%d 回目：ねた %d 件・対象外 %d 件（どちらか1つだけのはず）。ねた %d %s / 対象外 %d %s",
				i+1, sleeps, exclusions, sleepRec.Code, sleepRec.Body.String(), excludeRec.Code, excludeRec.Body.String())
		}
		switch {
		case sleeps == 1:
			// 「ねた」が先に通った：対象外は 400「『ねた』を記録した園児は対象外にできません。」（順に押したときと同じ）
			if sleepRec.Code != http.StatusOK || excludeRec.Code != http.StatusBadRequest || !strings.Contains(excludeRec.Body.String(), msgExcludeAfterSleep) {
				t.Fatalf("%d 回目（ねたが先）：ねた %d / 対象外 %d %s", i+1, sleepRec.Code, excludeRec.Code, excludeRec.Body.String())
			}
		default:
			// 対象外が先に通った：ねたは 409 already_exists「この園児は対象外になっています。…」
			if excludeRec.Code != http.StatusOK || sleepRec.Code != http.StatusConflict ||
				!strings.Contains(sleepRec.Body.String(), msgSleepExcluded) || !strings.Contains(sleepRec.Body.String(), kindAlreadyExists) {
				t.Fatalf("%d 回目（対象外が先）：対象外 %d / ねた %d %s", i+1, excludeRec.Code, sleepRec.Code, sleepRec.Body.String())
			}
		}
	}
}

// 卒園・退園して猶予中（3）の自児も、保護者ホームの「きょう」に出す。家庭からは書けず、読める期限を添える
// （詳細設計書「ダッシュボード」(4-8 (1))「紐づけが 1:有効・3:猶予中の自児ごとに1件」・「保護者ホーム（「きょう」）」(2-5 (2))）。
// 保護者ホームに日誌は出さない（日誌は園内の記録。詳細設計書「日誌」(4-13 (10))）。紐づけを終えた（2）子は出さない。
// モックの同じ観点は web/tests/contact.test.ts の「猶予中の自児も保護者ホームの「きょう」に出す」
func TestGuardianTodayGrace(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")
	type row struct {
		Child struct {
			ChildID string `json:"child_id"`
		} `json:"child"`
		SharedDiaries *json.RawMessage `json:"sharedDiaries"`
		Today         *struct {
			ChildID      string  `json:"child_id"`
			CanWriteHome bool    `json:"can_write_home"`
			GraceEndsOn  *string `json:"grace_ends_on"`
		} `json:"today"`
	}
	read := func() []row {
		var rows []row
		decode(t, call(t, h, guardian, "GET", "/api/dashboard/guardian", ""), &rows)
		return rows
	}
	grace := daysFromToday(20)
	a.db.Exec(`UPDATE m_child SET enrollment_status = '2', withdrawn_on = ? WHERE child_id = 'C001'`, today())
	a.db.Exec(`UPDATE t_guardian_child SET link_status = '3', grace_ends_on = ? WHERE guardian_id = 'G001' AND child_id = 'C001'`, grace)
	rows := read()
	if len(rows) != 1 || rows[0].Child.ChildID != "C001" || rows[0].Today == nil {
		t.Fatalf("猶予中の自児が保護者ホームに無い: %+v", rows)
	}
	if got := rows[0].Today; got.CanWriteHome || got.GraceEndsOn == nil || *got.GraceEndsOn != grace {
		t.Errorf("猶予中の「きょう」: can_write_home=%v grace_ends_on=%v, want false・%s", got.CanWriteHome, got.GraceEndsOn, grace)
	}
	if rows[0].SharedDiaries != nil {
		t.Errorf("保護者ホームに日誌の欄が残っている: %s", *rows[0].SharedDiaries)
	}
	a.db.Exec(`UPDATE t_guardian_child SET link_status = '2' WHERE guardian_id = 'G001' AND child_id = 'C001'`)
	if rows := read(); len(rows) != 0 {
		t.Errorf("紐づけを終えた子が保護者ホームに出ている: %+v", rows)
	}
}
