package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

/*
文章の下書き（AI）の経路（詳細設計書「経路」(8-2)・「使える条件」(8-3)・「送る項目」(8-4)・「置き換えの手順」(8-5)・
「呼び出し・上限・失敗のとき」(8-7)・「テストの観点」(9-1) の「AI 無しで動く」「AI に氏名が送られない」「AI の失敗」）。
モックの同じ観点は web/tests/ai.test.ts にある。aiAvailabilityCases は同じ名前の表と同じ行にする（9-2）。

外部の AI は呼ばない。app.ai に fakeWriter（ai_test.go）を入れる。
Go のテストは本物の時計で動くため、今日の記録はデモデータに頼らず、その日の 0 時台の時刻でテストの中で入れる。
*/

// enableAI は、園が AI を有効にし、呼び出し口に偽物を入れる
func enableAI(t *testing.T, a *app, w draftWriter) {
	t.Helper()
	a.ai = w
	if _, err := a.db.Exec(`UPDATE m_setting SET setting_value = '1' WHERE setting_key = 'ai.enabled'`); err != nil {
		t.Fatal(err)
	}
}

func mustExec(t *testing.T, a *app, q string, args ...any) {
	t.Helper()
	if _, err := a.db.Exec(q, args...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

func jsonBody(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// aiAvailabilityCases は、使える条件 aiAvailableFor（8-3）の表。web/tests/ai.test.ts の同じ名前の表と同じ行
var aiAvailabilityCases = []struct {
	name    string
	account int64
	child   string // 空ならクラス class
	class   int64
	setup   []string // 前に流す SQL
	undo    []string // あとで戻す SQL
	noKey   bool     // 呼び出し口が無い（起動したときに環境変数が無かった）
	reject  bool     // キーが無効と分かった
	want    bool
}{
	{name: "園が有効にし、キーがあり、担任が、同意した保護者の子に", account: accTeacher, child: "C001", want: true},
	{name: "園が有効にしていない", account: accTeacher, child: "C001",
		setup: []string{`UPDATE m_setting SET setting_value = '0' WHERE setting_key = 'ai.enabled'`},
		undo:  []string{`UPDATE m_setting SET setting_value = '1' WHERE setting_key = 'ai.enabled'`}},
	{name: "サーバにキーが無い", account: accTeacher, child: "C001", noKey: true},
	{name: "キーが無効と分かった", account: accTeacher, child: "C001", reject: true},
	{name: "ほかのクラスの担任", account: accOtherTeacher, child: "C001"},
	{name: "管理者", account: accAdmin, child: "C001", want: true},
	{name: "保護者", account: accGuardian, child: "C001"},
	{name: "保護者がまだ1人も登録していない子", account: accTeacher, child: "C006"},
	{name: "保護者が外部の AI を書いた版にまだ同意していない子", account: accTeacher, child: "C002"},
	{name: "保護者が断った子", account: accTeacher, child: "C001",
		setup: []string{`UPDATE t_guardian_child SET ai_opt_out = 1 WHERE guardian_id = 'G001' AND child_id = 'C001'`},
		undo:  []string{`UPDATE t_guardian_child SET ai_opt_out = 0 WHERE guardian_id = 'G001' AND child_id = 'C001'`}},
	{name: "紐づく保護者の1人でも断れば使わない", account: accTeacher, child: "C001",
		setup: []string{`INSERT INTO t_guardian_child (guardian_id, child_id, relationship, link_status, linked_at, ai_opt_out) VALUES ('G004','C001','母','1','2026-04-01T09:00:00',1)`},
		undo:  []string{`DELETE FROM t_guardian_child WHERE guardian_id = 'G004' AND child_id = 'C001'`}},
	{name: "紐づく保護者の全員が同意して断っていなければ使える", account: accTeacher, child: "C001", want: true,
		setup: []string{`INSERT INTO t_guardian_child (guardian_id, child_id, relationship, link_status, linked_at, ai_opt_out) VALUES ('G004','C001','母','1','2026-04-01T09:00:00',0)`},
		undo:  []string{`DELETE FROM t_guardian_child WHERE guardian_id = 'G004' AND child_id = 'C001'`}},
	{name: "終了した紐づけの断りは数えない", account: accTeacher, child: "C001", want: true,
		setup: []string{`INSERT INTO t_guardian_child (guardian_id, child_id, relationship, link_status, linked_at, ended_at, ai_opt_out) VALUES ('G003','C001','母','2','2026-04-01T09:00:00','2026-05-01T09:00:00',1)`},
		undo:  []string{`DELETE FROM t_guardian_child WHERE guardian_id = 'G003' AND child_id = 'C001'`}},
	{name: "クラスあて：在籍園児に条件を満たさない子がいる", account: accTeacher, class: 1},
	{name: "クラスあて：在籍園児の全員が条件を満たす", account: accAdmin, class: 90, want: true,
		setup: []string{`INSERT INTO m_class (class_id, fiscal_year, class_name, age_class) VALUES (90, 2026, 'テスト組', 1)`,
			`INSERT INTO t_class_child (class_id, child_id) VALUES (90, 'C001')`},
		undo: []string{`DELETE FROM t_class_child WHERE class_id = 90`, `DELETE FROM m_class WHERE class_id = 90`}},
}

func TestAiAvailabilityTable(t *testing.T) {
	a, _ := newTestApp(t)
	fake := &fakeWriter{}
	enableAI(t, a, fake)
	for _, c := range aiAvailabilityCases {
		for _, q := range c.setup {
			mustExec(t, a, q)
		}
		if c.noKey {
			a.ai = nil
		}
		a.aiKeyRejected.Store(c.reject)
		u, err := a.loadSessionUser(c.account)
		if err != nil {
			t.Fatal(err)
		}
		if got := a.aiAvailableFor(u, aiTarget{ChildID: c.child, ClassID: c.class}); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
		a.ai = fake
		a.aiKeyRejected.Store(false)
		for _, q := range c.undo {
			mustExec(t, a, q)
		}
	}
}

// AI 無しで動く（9-1）：キーが無い・園が有効にしていないとき、status は偽で、園からは今までどおり送れる
func TestAiWithoutKeyStillDelivers(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	var st struct{ Available bool }
	decode(t, call(t, h, teacher, "GET", "/api/ai/status?child_id=C001", ""), &st)
	if st.Available {
		t.Fatal("キーが無いのに使える")
	}
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts",
		jsonBody(t, map[string]any{"purpose": "facility_note", "child_id": "C001", "date": today()})), http.StatusForbidden)
	// 園が有効にしても、キーが無ければ使えない
	mustExec(t, a, `UPDATE m_setting SET setting_value = '1' WHERE setting_key = 'ai.enabled'`)
	decode(t, call(t, h, teacher, "GET", "/api/ai/status?child_id=C001", ""), &st)
	if st.Available {
		t.Fatal("キーが無いのに使える（有効にしたあと）")
	}
	call(t, h, teacher, "PUT", "/api/contact/children/C001/facility", `{"body":"今日も一日ありがとうございました。"}`)
}

func TestAiStatusRoute(t *testing.T) {
	a, h := newTestApp(t)
	enableAI(t, a, &fakeWriter{})
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	expectStatus(t, request(t, h, guardian, "GET", "/api/ai/status?child_id=C001", ""), http.StatusForbidden)
	expectStatus(t, request(t, h, teacher, "GET", "/api/ai/status", ""), http.StatusBadRequest)
	expectStatus(t, request(t, h, teacher, "GET", "/api/ai/status?child_id=C001&class_id=1", ""), http.StatusBadRequest)
	var st struct{ Available bool }
	decode(t, call(t, h, teacher, "GET", "/api/ai/status?child_id=C001", ""), &st)
	if !st.Available {
		t.Fatal("C001 で使えない")
	}
	// 理由は返さない（断った子かどうかを見せない）
	raw := call(t, h, teacher, "GET", "/api/ai/status?child_id=C002", "").Body.String()
	if strings.TrimSpace(raw) != `{"available":false}` {
		t.Fatalf("使えないときの応答: %s", raw)
	}
}

// insertTodayRecords は、C001 の今日の記録（送ってよいもの・送らないもの）を入れる。時刻は 0 時台（本物の時計でも過去になる）
func insertTodayRecords(t *testing.T, a *app) {
	t.Helper()
	d := today()
	at := func(hms string) string { return d + "T" + hms }
	ev := `INSERT INTO t_contact_event (child_id, class_id, contact_date, event_type, recorded_at, meal_kind, meal_amount, toilet_label, temperature, body, staff_id, created_at, updated_at)
		VALUES ('C001', 1, ?, ?, ?, ?, ?, ?, ?, ?, 'S003', ?, ?)`
	mustExec(t, a, ev, d, "1", at("00:10:00"), "1", "1", nil, nil, nil, at("00:10:00"), at("00:10:00"))
	mustExec(t, a, ev, d, "2", at("00:11:00"), nil, nil, "うんち", nil, nil, at("00:11:00"), at("00:11:00"))
	mustExec(t, a, ev, d, "3", at("00:12:00"), nil, nil, nil, 37.8, nil, at("00:12:00"), at("00:12:00"))
	mustExec(t, a, ev, d, "4", at("00:13:00"), nil, nil, nil, nil, "野原太郎くんは、あおちゃんと砂場で型抜きをくり返していました。", at("00:13:00"), at("00:13:00"))
	// 取り消したひとことは送らない
	mustExec(t, a, ev, d, "4", at("00:14:00"), nil, nil, nil, nil, "取り消した文", at("00:14:00"), at("00:14:00"))
	mustExec(t, a, `UPDATE t_contact_event SET is_deleted = 1 WHERE body = '取り消した文'`)
	mustExec(t, a, `INSERT INTO t_nap_sleep (nap_session_id, child_id, slept_at, woke_at, sleep_temperature, slept_staff_id, woke_staff_id, created_at, updated_at)
		VALUES (1, 'C001', ?, ?, 36.9, 'S003', 'S003', ?, ?)`, at("00:20:00"), at("00:50:00"), at("00:20:00"), at("00:50:00"))
	mustExec(t, a, `INSERT INTO t_contact_class (class_id, contact_date, body, staff_id, recorded_at, created_at, updated_at)
		VALUES (1, ?, 'たっくんとゆいちゃんがしゃぼん玉を追いかけました。', 'S003', ?, ?, ?)`, d, at("00:30:00"), at("00:30:00"), at("00:30:00"))
	mustExec(t, a, `INSERT INTO t_contact_home (child_id, contact_date, guardian_id, temperature, message, submitted_at, created_at, updated_at)
		VALUES ('C001', ?, 'G001', 36.4, '家庭からの連絡の文', ?, ?, ?) ON CONFLICT (child_id, contact_date) DO UPDATE SET message = excluded.message`,
		d, at("00:05:00"), at("00:05:00"), at("00:05:00"))
}

// AI に氏名が送られない（9-1）：送った User と System に、氏名・よみ・呼び名・生年月日・体温・排せつの言葉・電話番号・メールアドレスが無い
func TestAiDraftSendsNoNamesAndRestores(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{reply: draftReply{JSON: `{"draft":"〇〇ちゃんは給食をぜんぶ食べました。おともだちと砂場で型抜きをしていました。"}`}}
	enableAI(t, a, fake)
	insertTodayRecords(t, a)
	teacher := loginAs(a, accTeacher, "staff")
	// メモには AI を使える子（宮城 美咲。保護者が同意している）の名前を書く。使えない子の名前なら呼ばずに 400（TestAiDraftRejections）
	memo := "美咲ちゃんとしゃぼん玉を追いかけた。電話は 090-1234-5678、メールは nohara.i@example.jp。野原一誠さんと金城先生に伝えた"
	var res aiDraftResult
	decode(t, call(t, h, teacher, "POST", "/api/ai/drafts",
		jsonBody(t, map[string]any{"purpose": "facility_note", "child_id": "C001", "date": today(), "memo": memo})), &res)

	if fake.calls() != 1 {
		t.Fatalf("呼んだ回数 = %d", fake.calls())
	}
	sent := fake.last()
	var birth string
	a.db.QueryRow(`SELECT birth_date FROM m_child WHERE child_id = 'C001'`).Scan(&birth)
	for _, ng := range []string{"野原", "太郎", "たっくん", "のはら", "たろう", "伊藤", "あおちゃん", "あおい", "小林", "ゆいちゃん", "宮城", "美咲",
		birth, "37.8", "36.9", "36.4", "一誠", "金城", "うんち", "おしっこ", "090", "1234", "@", "example", "さくら組", "高梨", "家庭からの連絡の文", "取り消した文", "卵"} {
		if strings.Contains(sent.User, ng) || strings.Contains(sent.System, ng) {
			t.Errorf("送った文に %q が入っている: %s", ng, sent.User)
		}
	}
	var facts aiFacilityFacts
	if err := json.Unmarshal([]byte(sent.User), &facts); err != nil {
		t.Fatalf("渡す中身が JSON でない: %v %s", err, sent.User)
	}
	if !strings.HasSuffix(facts.Age, "歳") || strings.Contains(facts.Age, "か月") {
		t.Errorf("年齢: %q", facts.Age)
	}
	if facts.Memo != "おともだちとしゃぼん玉を追いかけた。電話は （伏せました）、メールは （伏せました）。保護者の方と先生に伝えた" {
		t.Errorf("メモの置き換え: %q", facts.Memo)
	}
	// テストで入れた 0 時台の記録だけを見る（本物の時計で動くため、昼すぎに回すとデモの今日の記録も入る）
	whats := []string{}
	for _, r := range facts.Records {
		if r.Time < "01:00" {
			whats = append(whats, r.Time+" "+r.What+" "+r.Amount+r.Woke+" "+r.Text)
		}
	}
	want := []string{
		"00:10 給食 ぜんぶ ",
		"00:13 ひとこと  〇〇ちゃんは、おともだちと砂場で型抜きをくり返していました。",
		"00:20 おひるね 00:50 ",
		"00:30 クラスのようす  〇〇ちゃんとおともだちがしゃぼん玉を追いかけました。",
	}
	if strings.Join(whats, "|") != strings.Join(want, "|") {
		t.Errorf("きょうの記録:\n%s\nwant\n%s", strings.Join(whats, "\n"), strings.Join(want, "\n"))
	}
	if sent.System != aiSystemFor(aiPurposeFacilityNote) || sent.Schema["required"].([]string)[0] != "draft" {
		t.Errorf("指示の文か形が違う")
	}
	// 「〇〇ちゃん」は呼び名に戻る。「おともだち」は戻さない
	if len(res.Drafts) != 1 || res.Drafts[0] != "たっくんは給食をぜんぶ食べました。おともだちと砂場で型抜きをしていました。" || !res.ReplacedOtherNames {
		t.Fatalf("下書き: %+v", res)
	}
	// 操作ログには用途と成否だけ。文は残さない
	var after string
	a.db.QueryRow(`SELECT after_value FROM t_operation_log WHERE operation_type = '6' ORDER BY operation_log_id DESC LIMIT 1`).Scan(&after)
	if after != `{"用途":"園からのひとこと","結果":"成功"}` {
		t.Errorf("操作ログ: %s", after)
	}
	var leaked int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE IFNULL(after_value,'') LIKE '%しゃぼん玉%' OR IFNULL(before_value,'') LIKE '%しゃぼん玉%'
		OR IFNULL(after_value,'') LIKE '%型抜き%'`).Scan(&leaked)
	if leaked != 0 {
		t.Errorf("操作ログに文が残っている（%d 行）", leaked)
	}
}

// 保護者に出さない種類（contact.show_items で外したもの）は送らない（決めたこと D-26）
func TestAiFactsSkipHiddenItems(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{reply: draftReply{JSON: `{"draft":"きょうもありがとうございました。"}`}}
	enableAI(t, a, fake)
	insertTodayRecords(t, a)
	mustExec(t, a, `UPDATE m_setting SET setting_value = 'toilet,temperature,photo' WHERE setting_key = 'contact.show_items'`)
	teacher := loginAs(a, accTeacher, "staff")
	call(t, h, teacher, "POST", "/api/ai/drafts", jsonBody(t, map[string]any{"purpose": "facility_note", "child_id": "C001", "date": today()}))
	var facts aiFacilityFacts
	json.Unmarshal([]byte(fake.last().User), &facts)
	if len(facts.Records) != 0 {
		t.Fatalf("出さない種類が送られた: %+v", facts.Records)
	}
}

func TestAiDraftRejections(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{reply: draftReply{JSON: `{"draft":"ありがとうございました。"}`}}
	enableAI(t, a, fake)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	post := func(c any, body map[string]any) (int, string) {
		rec := request(t, h, c.(*http.Cookie), "POST", "/api/ai/drafts", jsonBody(t, body))
		return rec.Code, rec.Body.String()
	}
	base := func(extra map[string]any) map[string]any {
		m := map[string]any{"purpose": "facility_note", "child_id": "C001", "date": today()}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	for _, c := range []struct {
		name string
		who  *http.Cookie
		body map[string]any
		code int
		msg  string
		kind string
	}{
		{"用途が無い", teacher, base(map[string]any{"purpose": ""}), 400, msgBadRequest, ""},
		{"保育日誌は本版では作らない", teacher, base(map[string]any{"purpose": "diary"}), 400, msgBadRequest, ""},
		{"宛先が無い", teacher, base(map[string]any{"child_id": ""}), 400, msgBadRequest, ""},
		{"宛先が2つ", teacher, base(map[string]any{"class_id": 1}), 400, msgBadRequest, ""},
		{"日付が今日でない", teacher, base(map[string]any{"date": daysFromToday(-1)}), 400, msgBadRequest, ""},
		{"言い換えで文が空", teacher, base(map[string]any{"purpose": "rephrase", "text": "  "}), 400, msgBadRequest, ""},
		{"園からの下書きをクラスあてに", teacher, map[string]any{"purpose": "facility_note", "class_id": 1, "date": today()}, 400, msgBadRequest, ""},
		{"メモが500文字を超える", teacher, base(map[string]any{"memo": strings.Repeat("あ", 501)}), 400, msgAiMemoTooLong, ""},
		{"ひとことの言い換えで200文字を超える", teacher, base(map[string]any{"purpose": "rephrase", "field": "comment", "text": strings.Repeat("あ", 201)}), 400, "文は200文字以内で入力してください。", ""},
		{"園からの続きで500文字を超える", teacher, base(map[string]any{"purpose": "continue", "text": strings.Repeat("あ", 501)}), 400, "文は500文字以内で入力してください。", ""},
		{"ほかのクラスの担任", otherTeacher, base(nil), 403, msgAiUnavailableForTarget, ""},
		{"保護者", guardian, base(nil), 403, "職員のみが行えます", ""},
		{"断った子・未同意の子", teacher, base(map[string]any{"child_id": "C002"}), 403, msgAiUnavailableForTarget, ""},
		{"メモに AI を使えない子の名前（C002 上園の子）", teacher, base(map[string]any{"memo": "上園さんとボール遊び"}), 400, msgAiExcludedName, kindAiExcludedName},
		{"言い換える文に AI を使えない子の名前（呼び名 あおちゃん）", teacher, base(map[string]any{"purpose": "rephrase", "text": "あおちゃんと遊びました。"}), 400, msgAiExcludedName, kindAiExcludedName},
	} {
		code, body := post(c.who, c.body)
		if code != c.code || !strings.Contains(body, c.msg) || (c.kind != "" && !strings.Contains(body, c.kind)) {
			t.Errorf("%s: %d %s", c.name, code, body)
		}
	}
	if fake.calls() != 0 {
		t.Fatalf("止めたのに AI を呼んだ（%d 回）", fake.calls())
	}
	// 呼ぶ前に止めたものは操作ログに残さない
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE operation_type = '6'`).Scan(&n)
	if n != 0 {
		t.Fatalf("止めたものが操作ログにある（%d 行）", n)
	}
	// 記録の文の中の AI を使えない子の名前は「おともだち」にするだけで、呼ぶ（決めたこと D-12）
	mustExec(t, a, `INSERT INTO t_contact_event (child_id, class_id, contact_date, event_type, recorded_at, body, staff_id, created_at, updated_at)
		VALUES ('C001', 1, ?, '4', ?, 'あおちゃんと遊びました。', 'S003', ?, ?)`, today(), today()+"T00:01:00", today()+"T00:01:00", today()+"T00:01:00")
	code, body := post(teacher, base(nil))
	if code != 200 || fake.calls() != 1 || !strings.Contains(fake.last().User, "おともだちと遊びました。") {
		t.Fatalf("記録の文の名前: %d %s / %s", code, body, fake.last().User)
	}
}

func TestAiDraftFailures(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{}
	enableAI(t, a, fake)
	teacher := loginAs(a, accTeacher, "staff")
	body := jsonBody(t, map[string]any{"purpose": "facility_note", "child_id": "C001", "date": today()})
	failed := func(name string) {
		t.Helper()
		raw := expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", body), http.StatusServiceUnavailable)
		if !strings.Contains(raw, msgAiFailed) || !strings.Contains(raw, kindAiUnavailable) {
			t.Errorf("%s: %s", name, raw)
		}
	}
	for _, c := range []struct {
		name  string
		reply draftReply
		err   error
	}{
		{"拒否", draftReply{Refused: true}, nil},
		{"JSON でない", draftReply{JSON: "下書きです"}, nil},
		{"形が合わない（候補を返した）", draftReply{JSON: `{"candidates":["a","b","c"]}`}, nil},
		{"空の下書き", draftReply{JSON: `{"draft":"  "}`}, nil},
		{"500文字を超える", draftReply{JSON: `{"draft":"` + strings.Repeat("あ", 501) + `"}`}, nil},
		{"宛先以外の園児の名前が入っていた", draftReply{JSON: `{"draft":"伊藤葵さんと遊びました。"}`}, nil},
		{"混雑（529）", draftReply{}, &aiStatusError{StatusCode: 529, RequestID: "req_x"}},
		{"接続の失敗", draftReply{}, errors.New("dial tcp: connection refused")},
	} {
		before := fake.calls()
		fake.reply, fake.err = c.reply, c.err
		failed(c.name)
		// 拒否・形が合わないは再試行しない（偽物を呼ぶのは1回）
		if fake.calls() != before+1 {
			t.Errorf("%s: 呼んだ回数 %d", c.name, fake.calls()-before)
		}
	}
	// 失敗は操作ログに「失敗」で残り、上限に数えない
	var failedLogs int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE operation_type = '6' AND after_value = '{"用途":"園からのひとこと","結果":"失敗"}'`).Scan(&failedLogs)
	if failedLogs != 8 || a.aiSucceededToday() != 0 {
		t.Errorf("失敗の記録 %d・成功の数 %d", failedLogs, a.aiSucceededToday())
	}

	// 時間切れ：返さずに待つ偽物と短い上限
	fake.block, fake.err = true, nil
	a.aiTimeoutForTest = 50 * time.Millisecond
	start := time.Now()
	failed("時間切れ")
	if time.Since(start) > 5*time.Second {
		t.Errorf("時間切れまでが長い: %v", time.Since(start))
	}
	fake.block = false

	// キーが無効（401）と分かったら、以降は使えない扱いにし、ボタンが消える
	fake.err = &aiStatusError{StatusCode: 401, RequestID: "req_y"}
	failed("キーが無効")
	var st struct{ Available bool }
	decode(t, call(t, h, teacher, "GET", "/api/ai/status?child_id=C001", ""), &st)
	if st.Available || !a.aiKeyRejected.Load() {
		t.Fatal("キーが無効と分かったあとも使える")
	}
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", body), http.StatusForbidden)
}

// 1日の上限（8-7 (3)）。成功した数で数え、ボタンは出したまま（status は真）押すと 429
func TestAiDailyLimit(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{reply: draftReply{JSON: `{"draft":"ありがとうございました。"}`}}
	enableAI(t, a, fake)
	mustExec(t, a, `UPDATE m_setting SET setting_value = '2' WHERE setting_key = 'ai.daily_limit'`)
	teacher := loginAs(a, accTeacher, "staff")
	admin := loginAs(a, accAdmin, "staff")
	body := jsonBody(t, map[string]any{"purpose": "facility_note", "child_id": "C001", "date": today()})
	call(t, h, teacher, "POST", "/api/ai/drafts", body)
	call(t, h, admin, "POST", "/api/ai/drafts", jsonBody(t, map[string]any{"purpose": "facility_note", "child_id": "C004", "date": today()}))
	raw := expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", body), http.StatusTooManyRequests)
	if !strings.Contains(raw, msgAiLimit) || !strings.Contains(raw, kindAiLimit) {
		t.Fatalf("上限: %s", raw)
	}
	if fake.calls() != 2 {
		t.Fatalf("上限のあとも呼んだ（%d 回）", fake.calls())
	}
	var st struct{ Available bool }
	decode(t, call(t, h, teacher, "GET", "/api/ai/status?child_id=C001", ""), &st)
	if !st.Available {
		t.Fatal("上限に達したら status を偽にしない（決めたこと D-9）")
	}

	// 呼び出し中の数も上限に含める（同時に押されて上限を超えないように。自動レビューの指摘）
	mustExec(t, a, `UPDATE m_setting SET setting_value = '3' WHERE setting_key = 'ai.daily_limit'`)
	if !a.reserveAiCall(3) {
		t.Fatal("成功2件・呼び出し中0件で、上限3に空きがあるのに取れない")
	}
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", body), http.StatusTooManyRequests)
	a.releaseAiCall()
	call(t, h, teacher, "POST", "/api/ai/drafts", body)
	if fake.calls() != 3 || a.aiInFlight != 0 {
		t.Fatalf("呼んだ回数 %d・呼び出し中 %d", fake.calls(), a.aiInFlight)
	}
}

// 言い換え・続きの候補（8-6）。候補はちょうど3つ。続きは書きかけの文と合わせて欄の上限以内
func TestAiRephraseAndContinue(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{}
	enableAI(t, a, fake)
	teacher := loginAs(a, accTeacher, "staff")
	text := "たっくんは、砂場でスコップをつかって遊んでいました。"
	fake.reply = draftReply{JSON: `{"candidates":["〇〇ちゃんは、砂場でスコップを使って遊んでいましたよ。","〇〇ちゃんは砂場で遊びました。","〇〇ちゃんは、砂場でスコップを使って遊んでいました。"]}`}
	var res aiDraftResult
	decode(t, call(t, h, teacher, "POST", "/api/ai/drafts",
		jsonBody(t, map[string]any{"purpose": "rephrase", "child_id": "C001", "date": today(), "field": "comment", "text": text})), &res)
	if len(res.Drafts) != 3 || res.Drafts[1] != "たっくんは砂場で遊びました。" || res.ReplacedOtherNames {
		t.Fatalf("言い換え: %+v", res)
	}
	sent := fake.last()
	if sent.User != `{"先生の文":"〇〇ちゃんは、砂場でスコップをつかって遊んでいました。"}` || sent.System != aiSystemFor(aiPurposeRephrase) {
		t.Fatalf("言い換えに渡す中身: %s", sent.User)
	}
	var after string
	a.db.QueryRow(`SELECT after_value || '|' || target_table FROM t_operation_log WHERE operation_type = '6' ORDER BY operation_log_id DESC LIMIT 1`).Scan(&after)
	if after != `{"用途":"言い換え","結果":"成功"}|t_contact_event` {
		t.Errorf("操作ログ: %s", after)
	}

	// 候補が3つでなければ使わない
	fake.reply = draftReply{JSON: `{"candidates":["a","b"]}`}
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts",
		jsonBody(t, map[string]any{"purpose": "rephrase", "child_id": "C001", "date": today(), "text": text})), http.StatusServiceUnavailable)

	// 続き：書きかけが欄の上限いっぱいなら、呼ばずに 400（自動レビューの指摘）
	before := fake.calls()
	raw := expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts",
		jsonBody(t, map[string]any{"purpose": "continue", "child_id": "C001", "date": today(), "field": "comment", "text": strings.Repeat("あ", 200)})), http.StatusBadRequest)
	if !strings.Contains(raw, msgAiNoRoom) || fake.calls() != before {
		t.Fatalf("空きの無い続き: %s（呼んだ回数 %d）", raw, fake.calls()-before)
	}
	// 続き：ひとこと（200文字）の書きかけ 190 文字に、11 文字の続きは上限を超える
	long := strings.Repeat("あ", 190)
	fake.reply = draftReply{JSON: `{"candidates":["おうちでも聞いてみてください。","た。","た。"]}`}
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts",
		jsonBody(t, map[string]any{"purpose": "continue", "child_id": "C001", "date": today(), "field": "comment", "text": long})), http.StatusServiceUnavailable)
	decode(t, call(t, h, teacher, "POST", "/api/ai/drafts",
		jsonBody(t, map[string]any{"purpose": "continue", "child_id": "C001", "date": today(), "field": "facility", "text": long})), &res)
	if len(res.Drafts) != 3 || fake.last().System != aiSystemFor(aiPurposeContinue) {
		t.Fatalf("続き: %+v", res)
	}
}
