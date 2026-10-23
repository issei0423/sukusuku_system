package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
園からのひとこと・活動のひとこと（段2）・定型文・宛先・ダッシュボードの「園から未送信」
（詳細設計書「園からのひとことと他児の名前」(4-5)・「きょうのようす」(4-4 (1))・「ダッシュボード」(4-8 (2))・「テストの観点」(9-1)）。
モックの同じ観点は web/tests/contactFacility.test.ts にある。

Go のテストは本物の時計で動く。今日の園からはデモデータに入れていない（デモ③で押して見せるため）。
*/

type facilityResp struct {
	ID          int64   `json:"contact_facility_id"`
	Body        string  `json:"body"`
	StaffName   string  `json:"staff_name"`
	CorrectedAt *string `json:"corrected_at"`
	UpdatedAt   string  `json:"updated_at"`
}

type otherNamesResp struct {
	Message string      `json:"message"`
	Kind    string      `json:"kind"`
	Names   []string    `json:"names"`
	Matches []nameMatch `json:"matches"`
}

func TestFacilityFlow(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	path := "/api/contact/children/C001/facility"
	clients := map[string]*liveClient{
		"さくら組の担任":   listen(a, accTeacher),
		"ひまわり組の担任":  listen(a, accOtherTeacher),
		"西田 太郎の保護者": listen(a, accGuardian),
		"村田 美咲の保護者": listen(a, accOtherGuard),
	}
	taro := liveEvent{Type: evContact, ChildID: childTaro}

	t.Run("検査と権限", func(t *testing.T) {
		for _, c := range []struct{ body, msg string }{
			{`{"body":"   "}`, msgFacilityEmpty},
			{`{"body":"` + strings.Repeat("あ", 501) + `"}`, msgFacilityTooLong},
		} {
			b := expectStatus(t, request(t, h, teacher, "PUT", path, c.body), http.StatusBadRequest)
			if !strings.Contains(b, c.msg) {
				t.Errorf("%.40s: %s", c.body, b)
			}
		}
		expectStatus(t, request(t, h, otherTeacher, "PUT", path, `{"body":"今日も一日ありがとうございました。"}`), http.StatusForbidden)
		expectStatus(t, request(t, h, guardian, "PUT", path, `{"body":"今日も一日ありがとうございました。"}`), http.StatusForbidden)
		expectStatus(t, request(t, h, teacher, "PUT", "/api/contact/children/C999/facility", `{"body":"ありがとうございました。"}`), http.StatusForbidden)
	})

	var sent facilityResp
	t.Run("他児の名前が入っていれば 409。承諾を付けて送り直すと保存され、保護者に届く", func(t *testing.T) {
		drainAll(clients)
		body := "あおちゃんとしゃぼん玉を追いかけていました。たっくんは最後まで走っていました。"
		raw := expectStatus(t, request(t, h, teacher, "PUT", path, `{"body":"`+body+`"}`), http.StatusConflict)
		var e otherNamesResp
		json.Unmarshal([]byte(raw), &e)
		if e.Kind != kindOtherChildNames || len(e.Names) != 1 || e.Names[0] != "伊藤 葵" || len(e.Matches) != 1 || e.Matches[0].Start != 0 || e.Matches[0].End != 5 {
			t.Fatalf("他児の名前の注意: %s", raw)
		}
		// 応答に、当たった園児の名前のほかの名前（宛先の呼び名・ほかの園児の一覧）を入れない
		if strings.Contains(raw, "西田") || strings.Contains(raw, "小林") {
			t.Errorf("応答に当たっていない名前が入っている: %s", raw)
		}
		expect(t, "保存していないので知らせも無い", clients, map[string][]liveEvent{})
		decode(t, call(t, h, teacher, "PUT", path, `{"body":"`+body+`","acknowledged_names":["伊藤 葵"]}`), &sent)
		if sent.Body != body || sent.StaffName != "鈴木 浩之" {
			t.Fatalf("送った園から: %+v", sent)
		}
		expect(t, "園から", clients, to(who("さくら組の担任", "西田 太郎の保護者"), taro))
		pb := call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.String()
		if !strings.Contains(pb, body) || strings.Contains(pb, "鈴木") || strings.Contains(pb, "staff_name") || strings.Contains(pb, "recipient") {
			t.Errorf("保護者のページ: %s", pb)
		}
		b := expectStatus(t, request(t, h, teacher, "PUT", path, `{"body":"もう一度送ります。"}`), http.StatusConflict)
		if !strings.Contains(b, msgFacilitySent) || !strings.Contains(b, kindAlreadyExists) {
			t.Errorf("二重の園から: %s", b)
		}
	})

	t.Run("直すときも照合を通る。読んだ版が古ければ 409。保護者に「訂正しました」が出る", func(t *testing.T) {
		fix := "/api/contact/facility/" + itoa(sent.ID) + "/correct"
		raw := expectStatus(t, request(t, h, teacher, "POST", fix, `{"body":"空くんと遊びました。","updated_at":"`+sent.UpdatedAt+`"}`), http.StatusConflict)
		if !strings.Contains(raw, "井上 空") {
			t.Errorf("訂正の照合: %s", raw)
		}
		expectStatus(t, request(t, h, teacher, "POST", fix, `{"body":"砂場で遊びました。","updated_at":"2000-01-01T00:00:00"}`), http.StatusConflict)
		expectStatus(t, request(t, h, otherTeacher, "POST", fix, `{"body":"砂場で遊びました。","updated_at":"`+sent.UpdatedAt+`"}`), http.StatusForbidden)
		var fixed facilityResp
		decode(t, call(t, h, teacher, "POST", fix, `{"body":"砂場で遊びました。","updated_at":"`+sent.UpdatedAt+`"}`), &fixed)
		if fixed.CorrectedAt == nil || fixed.Body != "砂場で遊びました。" {
			t.Fatalf("訂正: %+v", fixed)
		}
		var before, after string
		a.db.QueryRow(`SELECT before_value, after_value FROM t_operation_log WHERE target_table = 't_contact_facility' AND operation_type = '2'`).Scan(&before, &after)
		if !strings.Contains(before, "あおちゃん") || after != `{"body":"砂場で遊びました。"}` {
			t.Errorf("訂正の操作ログ: %s → %s", before, after)
		}
		sent = fixed
	})

	t.Run("取り消すと未送信に戻り、送り直せる", func(t *testing.T) {
		var readers struct {
			Families int `json:"family_count"`
		}
		decode(t, call(t, h, teacher, "GET", "/api/contact/facility/"+itoa(sent.ID)+"/readers", ""), &readers)
		call(t, h, teacher, "POST", "/api/contact/facility/"+itoa(sent.ID)+"/cancel", `{}`)
		if strings.Contains(call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.String(), "砂場で遊びました。") {
			t.Errorf("取り消した園からが保護者に出ている")
		}
		call(t, h, teacher, "PUT", path, `{"body":"明日もよろしくお願いします。"}`)
		expectStatus(t, request(t, h, teacher, "POST", "/api/contact/facility/"+itoa(sent.ID)+"/cancel", `{}`), http.StatusForbidden)
	})
}

// 活動のひとこと（種類 4）は段2：文の検査と他児の名前の照合を通り、送った時点で保護者に届く
func TestCommentEvent(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	comment := func(body, ack string) string {
		return `{"items":[{"child_id":"C001","event_type":"4","body":"` + body + `"}]` + ack + `}`
	}
	b := expectStatus(t, request(t, h, teacher, "POST", "/api/contact/events", comment(strings.Repeat("あ", 201), "")), http.StatusBadRequest)
	if !strings.Contains(b, msgCommentTooLong) {
		t.Errorf("長すぎるひとこと: %s", b)
	}
	expectStatus(t, request(t, h, teacher, "POST", "/api/contact/events", comment("  ", "")), http.StatusBadRequest)
	raw := expectStatus(t, request(t, h, teacher, "POST", "/api/contact/events", comment("空くんと積み木をしていました。", "")), http.StatusConflict)
	if !strings.Contains(raw, kindOtherChildNames) || !strings.Contains(raw, "井上 空") {
		t.Fatalf("ひとことの照合: %s", raw)
	}
	var got recordResp
	decode(t, call(t, h, teacher, "POST", "/api/contact/events", comment("空くんと積み木をしていました。", `,"acknowledged_names":["井上 空"]`)), &got)
	if len(got.Events) != 1 {
		t.Fatalf("ひとことの記録: %+v", got)
	}
	e := got.Events[0]
	pb := call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.String()
	if !strings.Contains(pb, "空くんと積み木をしていました。") {
		t.Errorf("保護者のページにひとことが無い")
	}
	// 直すときも照合を通る
	fix := "/api/contact/events/" + itoa(e.ID) + "/correct"
	expectStatus(t, request(t, h, teacher, "POST", fix, `{"body":"あおちゃんと積み木をしていました。","updated_at":"`+e.UpdatedAt+`"}`), http.StatusConflict)
	call(t, h, teacher, "POST", fix, `{"body":"積み木を高く積んでいました。","updated_at":"`+e.UpdatedAt+`"}`)
	var page struct {
		Events []struct {
			Body        *string `json:"body"`
			CorrectedAt *string `json:"corrected_at"`
		} `json:"events"`
	}
	decode(t, call(t, h, guardian, "GET", "/api/contact/children/C001", ""), &page)
	found := false
	for _, ev := range page.Events {
		if ev.Body != nil && *ev.Body == "積み木を高く積んでいました。" && ev.CorrectedAt != nil {
			found = true
		}
	}
	if !found {
		t.Errorf("ひとことの訂正が保護者に出ていない: %+v", page.Events)
	}
}

// 定型文は職員だけが引ける。使う場所ごとに並び順で返す。評価の言葉を入れない（原則1）
func TestPhrases(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	var list []phraseOut
	decode(t, call(t, h, teacher, "GET", "/api/phrases?scope=1", ""), &list)
	if len(list) != 4 || list[0].Body != "今日も一日ありがとうございました。" {
		t.Fatalf("園からの定型文: %+v", list)
	}
	// 4:日誌は4つ。保護者に向けた文を入れない（日誌は園内の記録。詳細設計書「デモデータ」(5-5) 第1.3版）
	for scope, want := range map[string]int{"2": 3, "3": 3, "4": 4} {
		decode(t, call(t, h, teacher, "GET", "/api/phrases?scope="+scope, ""), &list)
		if len(list) != want {
			t.Errorf("scope %s: %d 件", scope, len(list))
		}
		for _, p := range list {
			if scope == "4" && strings.Contains(p.Body, "ご家庭でも") {
				t.Errorf("日誌の定型文に保護者に向けた文: %s", p.Body)
			}
		}
	}
	expectStatus(t, request(t, h, teacher, "GET", "/api/phrases", ""), http.StatusBadRequest)
	expectStatus(t, request(t, h, teacher, "GET", "/api/phrases?scope=5", ""), http.StatusBadRequest)
	expectStatus(t, request(t, h, guardian, "GET", "/api/phrases?scope=1", ""), http.StatusForbidden)
	for _, p := range defaultPhrases {
		for _, word := range []string{"元気", "順調", "問題", "異常", "健康"} {
			if strings.Contains(p[1], word) {
				t.Errorf("定型文に評価の言葉「%s」: %s", word, p[1])
			}
		}
	}
}

// 宛先は職員の応答だけに入る。保護者が未登録の園児は続柄が空。照合の経路は書ける園児だけを宛先にできる
func TestRecipientAndNameCheckRoute(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	var page struct {
		Recipient *contactRecipient `json:"recipient"`
	}
	decode(t, call(t, h, teacher, "GET", "/api/contact/children/C001", ""), &page)
	if page.Recipient == nil || page.Recipient.ChildName != "西田 太郎" || len(page.Recipient.Relationships) != 1 || page.Recipient.Relationships[0] != "父" {
		t.Errorf("宛先: %+v", page.Recipient)
	}
	decode(t, call(t, h, teacher, "GET", "/api/contact/children/C003", ""), &page)
	if page.Recipient == nil || len(page.Recipient.Relationships) != 0 {
		t.Errorf("紐づけを終えた家庭の宛先（未登録と同じ）: %+v", page.Recipient)
	}
	var view struct {
		Rows []struct {
			Recipient *contactRecipient `json:"recipient"`
		} `json:"rows"`
	}
	decode(t, call(t, h, teacher, "GET", "/api/contact/classes/1", ""), &view)
	if len(view.Rows) == 0 || view.Rows[0].Recipient == nil {
		t.Errorf("連絡帳（クラス）画面の宛先: %+v", view.Rows)
	}

	var res struct {
		Names []string `json:"names"`
	}
	decode(t, call(t, h, teacher, "POST", "/api/contact/name-check", `{"child_ids":["C001"],"text":"たっくんとあおちゃん"}`), &res)
	if len(res.Names) != 1 || res.Names[0] != "伊藤 葵" {
		t.Errorf("照合の経路: %+v", res)
	}
	decode(t, call(t, h, teacher, "POST", "/api/contact/name-check", `{"class_id":1,"text":"たっくんとあおちゃん"}`), &res)
	if len(res.Names) != 2 {
		t.Errorf("クラスあての照合: %+v", res)
	}
	expectStatus(t, request(t, h, otherTeacher, "POST", "/api/contact/name-check", `{"child_ids":["C001"],"text":"たっくん"}`), http.StatusForbidden)
	expectStatus(t, request(t, h, otherTeacher, "POST", "/api/contact/name-check", `{"class_id":1,"text":"たっくん"}`), http.StatusForbidden)
	expectStatus(t, request(t, h, teacher, "POST", "/api/contact/name-check", `{"child_ids":["C001"],"text":"`+strings.Repeat("あ", 1001)+`"}`), http.StatusBadRequest)
}

// ダッシュボードの「園からのひとことを送っていない園児」。送ると減り、今日の午睡で欠席にした子は数えない
func TestFacilityUnsentSummary(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	unsent := func() int {
		var s struct {
			N int `json:"facilityUnsent"`
		}
		decode(t, call(t, h, teacher, "GET", "/api/dashboard/staff", ""), &s)
		return s.N
	}
	n0 := unsent()
	if n0 == 0 {
		t.Fatalf("園から未送信が 0")
	}
	call(t, h, teacher, "PUT", "/api/contact/children/C001/facility", `{"body":"今日も一日ありがとうございました。"}`)
	if n := unsent(); n != n0-1 {
		t.Errorf("送ったあと %d, want %d", n, n0-1)
	}
	s := startOwnNap(t, h, teacher)
	// 欠席でない対象外（午睡なし）は数える。欠席は数えない（デモの「ねた」が無い子で確かめる）
	call(t, h, teacher, "POST", "/api/nap/session/"+itoa(s.NapSessionID)+"/exclusions", `{"child_id":"C011","reason":"2"}`)
	if n := unsent(); n != n0-1 {
		t.Errorf("午睡なしのあと %d, want %d", n, n0-1)
	}
	call(t, h, teacher, "POST", "/api/nap/session/"+itoa(s.NapSessionID)+"/exclusions", `{"child_id":"C012","reason":"1"}`)
	if n := unsent(); n != n0-2 {
		t.Errorf("欠席のあと %d, want %d", n, n0-2)
	}
}
