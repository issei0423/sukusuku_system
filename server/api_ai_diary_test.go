package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

/*
保育日誌の下書き（purpose: diary）の経路（詳細設計書「保育日誌の下書き」(8-12)・「日誌の画面（作り直し）」(2-13 (7))・
「テストの観点」(9-1) の「AI に氏名が送られない」「AI の失敗」）。モックの同じ観点は web/tests/ai.test.ts にある。
外部の AI は呼ばない。app.ai に fakeWriter（ai_test.go）を入れる。
今日の記録は insertTodayRecords（api_ai_test.go）で、その日の 0 時台の時刻で入れる。
*/

// diaryDraftBody は、日誌の下書きの要求。個人日誌（C001・さくら組）を既定とし、extra で上書きする（値が nil なら項目を外す）
func diaryDraftBody(t *testing.T, extra map[string]any) string {
	t.Helper()
	m := map[string]any{"purpose": "diary", "record_type": "1", "child_id": "C001", "class_id": 1, "date": today(),
		"headings": []string{"【今日の様子】", "【食事】"}}
	for k, v := range extra {
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	return jsonBody(t, m)
}

// 偽物が返す、見出しごとの文。「〇〇ちゃん」は呼び名に戻る
const diaryFakeReply = `{"sections":[{"heading":"今日の様子","text":"〇〇ちゃんは、おともだちとしゃぼん玉を追いかけた。"},{"heading":"食事","text":""}]}`

// 個人日誌：送った中身は、見出し・クラスのようす・メモだけ。氏名・体温・食事・午睡・ひとことは送らず、返った文の「〇〇ちゃん」は呼び名に戻る
func TestAiDiaryPersonalSendsOnlyClassNotesMemoHeadings(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{reply: draftReply{JSON: diaryFakeReply}}
	enableAI(t, a, fake)
	insertTodayRecords(t, a)
	teacher := loginAs(a, accTeacher, "staff")
	memo := "美咲ちゃんとも遊んだ。電話は 090-1234-5678。西田拓也さんと久保田先生に伝えた"
	var res aiDraftResult
	decode(t, call(t, h, teacher, "POST", "/api/ai/drafts", diaryDraftBody(t, map[string]any{"memo": memo})), &res)

	if fake.calls() != 1 {
		t.Fatalf("呼んだ回数 = %d", fake.calls())
	}
	sent := fake.last()
	var birth string
	a.db.QueryRow(`SELECT birth_date FROM m_child WHERE child_id = 'C001'`).Scan(&birth)
	for _, ng := range []string{"西田", "太郎", "たっくん", "にしだ", "たろう", "伊藤", "あおちゃん", "小林", "ゆいちゃん", "村田", "美咲",
		birth, "37.8", "36.9", "36.4", "拓也", "久保田", "うんち", "090", "1234", "さくら組", "鈴木", "家庭からの連絡の文", "取り消した文",
		"給食", "ぜんぶ", "型抜き", "おひるね", "00:50"} {
		if strings.Contains(sent.User, ng) || strings.Contains(sent.System, ng) {
			t.Errorf("送った文に %q が入っている: %s", ng, sent.User)
		}
	}
	var facts aiDiaryFacts
	if err := json.Unmarshal([]byte(sent.User), &facts); err != nil {
		t.Fatalf("渡す中身が JSON でない: %v %s", err, sent.User)
	}
	if strings.Join(facts.Headings, "|") != "今日の様子|食事" {
		t.Errorf("見出し: %v", facts.Headings)
	}
	found := false
	for _, n := range facts.ClassNotes {
		if n == "〇〇ちゃんとおともだちがしゃぼん玉を追いかけました。" {
			found = true
		}
	}
	if !found {
		t.Errorf("クラスのようす（置き換え済み）が入っていない: %v", facts.ClassNotes)
	}
	if facts.Memo != "おともだちとも遊んだ。電話は （伏せました）。保護者の方と先生に伝えた" {
		t.Errorf("メモの置き換え: %q", facts.Memo)
	}
	if sent.System != diarySystem || sent.System != aiDiarySystemFor(false) || sent.Schema["required"].([]string)[0] != "sections" {
		t.Errorf("指示の文か形が違う")
	}
	// 園内の日誌用の決まり：保護者向けの丁寧語の決まりは入っていない
	if !strings.Contains(sent.System, "保護者には届きません") || strings.Contains(sent.System, "やわらかい丁寧語") {
		t.Errorf("日誌用の指示の文でない")
	}
	want := "【今日の様子】\nたっくんは、おともだちとしゃぼん玉を追いかけた。\n\n【食事】"
	if len(res.Drafts) != 1 || res.Drafts[0] != want || !res.ReplacedOtherNames {
		t.Fatalf("下書き: %+v", res)
	}
	// 操作ログ：日誌（1）・6・t_diary・個人日誌は園児。文は残さない
	var fn, op, table, child, after string
	a.db.QueryRow(`SELECT function_type, operation_type, target_table, IFNULL(target_child_id, ''), after_value FROM t_operation_log
		WHERE operation_type = '6' ORDER BY operation_log_id DESC LIMIT 1`).Scan(&fn, &op, &table, &child, &after)
	if fn != "1" || op != "6" || table != "t_diary" || child != "C001" || after != `{"用途":"保育日誌","結果":"成功"}` {
		t.Errorf("操作ログ: %s %s %s %s %s", fn, op, table, child, after)
	}
	var leaked int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE IFNULL(after_value,'') LIKE '%しゃぼん玉%'`).Scan(&leaked)
	if leaked != 0 {
		t.Errorf("操作ログに文が残っている")
	}
}

// 共有を選んだ個人日誌は、保護者へ送る文の共通の決まりを当てる（要決定事項の推し B）。保護者に出さない設定のクラスのようすは送らない。
// 共有は個人日誌だけ：クラス日誌に付けても無視する
func TestAiDiaryShareUsesGuardianRules(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{reply: draftReply{JSON: diaryFakeReply}}
	enableAI(t, a, fake)
	insertTodayRecords(t, a)
	teacher := loginAs(a, accTeacher, "staff")
	admin := loginAs(a, accAdmin, "staff")
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", diaryDraftBody(t, map[string]any{"share_to_guardian": true})), http.StatusOK)
	sent := fake.last()
	if sent.System != aiCommonRules+"\n\n"+aiDiarySharedRule || sent.System != aiDiarySystemFor(true) {
		t.Errorf("共有を選んだ個人日誌の指示の文: %s", sent.System)
	}
	if !strings.Contains(sent.System, "保護者に向けた、やわらかい丁寧語") || strings.Contains(sent.System, "保護者には届きません") {
		t.Errorf("保護者へ送る文の共通の決まりが当たっていない")
	}
	var facts aiDiaryFacts
	json.Unmarshal([]byte(sent.User), &facts)
	if len(facts.ClassNotes) == 0 {
		t.Fatalf("クラスのようすが送られていない")
	}
	// 保護者に出さない設定でクラスのようすを外していれば、共有を選んだ日誌には送らない。共有しない日誌には送る
	mustExec(t, a, `UPDATE m_setting SET setting_value = 'meal,nap' WHERE setting_key = 'contact.show_items'`)
	call(t, h, teacher, "POST", "/api/ai/drafts", diaryDraftBody(t, map[string]any{"share_to_guardian": true}))
	json.Unmarshal([]byte(fake.last().User), &facts)
	if len(facts.ClassNotes) != 0 {
		t.Errorf("出さない設定のクラスのようすが送られた: %v", facts.ClassNotes)
	}
	call(t, h, teacher, "POST", "/api/ai/drafts", diaryDraftBody(t, nil))
	json.Unmarshal([]byte(fake.last().User), &facts)
	if len(facts.ClassNotes) == 0 || fake.last().System != diarySystem {
		t.Errorf("共有しない日誌のクラスのようす: %v", facts.ClassNotes)
	}
	// クラス日誌に共有を付けても、日誌用の指示の文のまま（admin・クラス 90）
	setupClass90(t, a)
	expectStatus(t, request(t, h, admin, "POST", "/api/ai/drafts", diaryDraftBody(t, map[string]any{
		"record_type": "2", "child_id": nil, "class_id": 90, "share_to_guardian": true})), http.StatusOK)
	if fake.last().System != diarySystem {
		t.Errorf("クラス日誌が共有の指示の文になった")
	}
}

// setupClass90 は、C001 だけが在籍するクラス（全員が使える条件を満たす）を作り、今日と先の日のクラスのようすを入れる
func setupClass90(t *testing.T, a *app) {
	t.Helper()
	mustExec(t, a, `INSERT INTO m_class (class_id, fiscal_year, class_name, age_class) VALUES (90, 2026, 'テスト組', 1)`)
	mustExec(t, a, `INSERT INTO t_class_child (class_id, child_id) VALUES (90, 'C001')`)
	for _, d := range []string{today(), daysFromToday(365)} {
		mustExec(t, a, `INSERT INTO t_contact_class (class_id, contact_date, body, staff_id, recorded_at, created_at, updated_at)
			VALUES (90, ?, 'たっくんとゆいちゃんが園庭を歩きました。', 'S003', ?, ?, ?)`, d, today()+"T00:30:00", today()+"T00:30:00", today()+"T00:30:00")
	}
}

// クラス日誌：クラスの全園児が宛先。全員が「おともだち」で、名前は戻さない。週案月案は365日先まで
func TestAiDiaryClassAndPlan(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{reply: draftReply{JSON: `{"sections":[{"heading":"記録","text":"おともだちが園庭を歩いた。"}]}`}}
	enableAI(t, a, fake)
	setupClass90(t, a)
	admin := loginAs(a, accAdmin, "staff")
	classBody := func(extra map[string]any) string {
		m := map[string]any{"record_type": "2", "child_id": nil, "class_id": 90, "headings": []string{}}
		for k, v := range extra {
			m[k] = v
		}
		return diaryDraftBody(t, m)
	}
	var res aiDraftResult
	decode(t, call(t, h, admin, "POST", "/api/ai/drafts", classBody(nil)), &res)
	if len(res.Drafts) != 1 || res.Drafts[0] != "【記録】\nおともだちが園庭を歩いた。" {
		t.Fatalf("クラス日誌: %+v", res)
	}
	// 見出しが空なら「【記録】」1つ。クラスあてなので全員を「おともだち」に
	var facts aiDiaryFacts
	json.Unmarshal([]byte(fake.last().User), &facts)
	if strings.Join(facts.Headings, "|") != "記録" || len(facts.ClassNotes) != 1 || facts.ClassNotes[0] != "おともだちとおともだちが園庭を歩きました。" {
		t.Errorf("渡す中身: %s", fake.last().User)
	}
	// クラス日誌の操作ログに園児は入らない
	var child string
	a.db.QueryRow(`SELECT IFNULL(target_child_id, '') FROM t_operation_log WHERE operation_type = '6' ORDER BY operation_log_id DESC LIMIT 1`).Scan(&child)
	if child != "" {
		t.Errorf("クラス日誌の操作ログに園児が入った: %q", child)
	}
	// 週案月案は365日先まで（366日先は 400）。クラス日誌は当日まで
	expectStatus(t, request(t, h, admin, "POST", "/api/ai/drafts", classBody(map[string]any{"record_type": "3", "date": daysFromToday(365)})), http.StatusOK)
	expectStatus(t, request(t, h, admin, "POST", "/api/ai/drafts", classBody(map[string]any{"record_type": "3", "date": daysFromToday(366)})), http.StatusBadRequest)
	expectStatus(t, request(t, h, admin, "POST", "/api/ai/drafts", classBody(map[string]any{"date": daysFromToday(1)})), http.StatusBadRequest)
	if fake.calls() != 2 {
		t.Errorf("呼んだ回数 %d", fake.calls())
	}
}

// 要求の検査と、使えない条件（呼ぶ前に止める）。ヒヤリハットは 403
func TestAiDiaryRejections(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{reply: draftReply{JSON: diaryFakeReply}}
	enableAI(t, a, fake)
	setupClass90(t, a)
	mustExec(t, a, `DELETE FROM t_class_staff WHERE staff_id = 'S005'`) // ひまわり組の担任をフリーにする
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	admin := loginAs(a, accAdmin, "staff")
	many := make([]string, 21)
	for i := range many {
		many[i] = "見出し" + string(rune('A'+i))
	}
	for _, c := range []struct {
		name string
		who  *http.Cookie
		body string
		code int
		msg  string
		kind string
	}{
		{"記録種別が無い", teacher, diaryDraftBody(t, map[string]any{"record_type": nil}), 400, msgBadRequest, ""},
		{"記録種別が違う", teacher, diaryDraftBody(t, map[string]any{"record_type": "9"}), 400, msgBadRequest, ""},
		{"個人日誌に園児が無い", teacher, diaryDraftBody(t, map[string]any{"child_id": nil}), 400, msgBadRequest, ""},
		{"クラス日誌に園児がある", admin, diaryDraftBody(t, map[string]any{"record_type": "2", "class_id": 90}), 400, msgBadRequest, ""},
		{"クラスが無い", teacher, diaryDraftBody(t, map[string]any{"class_id": nil}), 400, msgBadRequest, ""},
		{"日付の形が崩れている", teacher, diaryDraftBody(t, map[string]any{"date": "2026/11/26"}), 400, msgBadRequest, ""},
		{"個人日誌の記録日が未来", teacher, diaryDraftBody(t, map[string]any{"date": daysFromToday(1)}), 400, msgBadRequest, ""},
		{"見出しが21個", teacher, diaryDraftBody(t, map[string]any{"headings": many}), 400, msgBadRequest, ""},
		{"見出しが51文字", teacher, diaryDraftBody(t, map[string]any{"headings": []string{strings.Repeat("あ", 51)}}), 400, msgBadRequest, ""},
		{"見出しが空", teacher, diaryDraftBody(t, map[string]any{"headings": []string{"【】"}}), 400, msgBadRequest, ""},
		{"メモが500文字を超える", teacher, diaryDraftBody(t, map[string]any{"memo": strings.Repeat("あ", 501)}), 400, msgAiMemoTooLong, ""},
		{"ヒヤリハットには使えない", teacher, diaryDraftBody(t, map[string]any{"record_type": "4"}), 403, msgAiUnavailableForTarget, ""},
		{"ほかのクラスの担任（個人日誌）", otherTeacher, diaryDraftBody(t, nil), 403, msgAiUnavailableForTarget, ""},
		{"担当クラスの無い一般（フリー）は書けない", otherTeacher, diaryDraftBody(t, map[string]any{"record_type": "2", "child_id": nil, "class_id": 90}), 403, msgAiUnavailableForTarget, ""},
		{"保護者", guardian, diaryDraftBody(t, nil), 403, "職員のみが行えます", ""},
		{"断った子・未同意の子", admin, diaryDraftBody(t, map[string]any{"child_id": "C002"}), 403, msgAiUnavailableForTarget, ""},
		{"園児がそのクラスに在籍していない", admin, diaryDraftBody(t, map[string]any{"class_id": 90, "child_id": "C004"}), 403, msgAiUnavailableForTarget, ""},
		{"クラスの全園児が条件を満たさない（さくら組）", teacher, diaryDraftBody(t, map[string]any{"record_type": "2", "child_id": nil}), 403, msgAiUnavailableForTarget, ""},
		{"メモに AI を使えない子の名前（C002 遠藤の子）", teacher, diaryDraftBody(t, map[string]any{"memo": "遠藤さんとボール遊び"}), 400, msgAiExcludedName, kindAiExcludedName},
	} {
		rec := request(t, h, c.who, "POST", "/api/ai/drafts", c.body)
		if rec.Code != c.code || !strings.Contains(rec.Body.String(), c.msg) || (c.kind != "" && !strings.Contains(rec.Body.String(), c.kind)) {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body.String())
		}
	}
	if fake.calls() != 0 {
		t.Fatalf("止めたのに AI を呼んだ（%d 回）", fake.calls())
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE operation_type = '6'`).Scan(&n)
	if n != 0 {
		t.Fatalf("止めたものが操作ログにある（%d 行）", n)
	}
	// 園が有効にしていないときは使えない
	mustExec(t, a, `UPDATE m_setting SET setting_value = '0' WHERE setting_key = 'ai.enabled'`)
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", diaryDraftBody(t, nil)), http.StatusForbidden)
}

// 見出しは0〜20個・1つ50文字。【】は外して送る。同じ見出しは1つに
func TestAiDiaryHeadings(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{reply: draftReply{JSON: `{"sections":[]}`}}
	enableAI(t, a, fake)
	teacher := loginAs(a, accTeacher, "staff")
	twenty := make([]string, 20)
	for i := range twenty {
		twenty[i] = "【" + strings.Repeat("あ", 49) + string(rune('A'+i)) + "】"
	}
	for _, c := range []struct {
		name     string
		headings any
		want     string
	}{
		{"空は【記録】1つ", []string{}, "記録"},
		{"headings が無くても【記録】1つ", nil, "記録"},
		{"【】を外す・前後の空白を外す", []string{"【今日の様子】", " 食事 "}, "今日の様子|食事"},
		{"同じ見出しは最初の1つだけ", []string{"【食事】", "食事", "【午睡】"}, "食事|午睡"},
		{"名前を置き換える（宛先の呼び名は〇〇ちゃん、ほかの子はおともだち）", []string{"たっくんの様子", "あおちゃんとの遊び"}, "〇〇ちゃんの様子|おともだちとの遊び"},
	} {
		expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", diaryDraftBody(t, map[string]any{"headings": c.headings})), http.StatusOK)
		var facts aiDiaryFacts
		json.Unmarshal([]byte(fake.last().User), &facts)
		if strings.Join(facts.Headings, "|") != c.want {
			t.Errorf("%s: %v, want %s", c.name, facts.Headings, c.want)
		}
	}
	// 20個・50文字ちょうどは通る
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", diaryDraftBody(t, map[string]any{"headings": twenty})), http.StatusOK)
	var facts aiDiaryFacts
	json.Unmarshal([]byte(fake.last().User), &facts)
	if len(facts.Headings) != 20 {
		t.Errorf("見出しの数 %d", len(facts.Headings))
	}
	// 返ってこなかった見出しは空の文として、見出しだけを返す
	var res aiDraftResult
	decode(t, call(t, h, teacher, "POST", "/api/ai/drafts", diaryDraftBody(t, map[string]any{"headings": []string{"今日の様子", "食事"}})), &res)
	if res.Drafts[0] != "【今日の様子】\n\n【食事】" {
		t.Errorf("返らなかった見出し: %q", res.Drafts[0])
	}
}

type errTest string

func (e errTest) Error() string { return string(e) }

// 失敗：拒否・形が合わない・見出しが送ったものと合わない・本文の上限を超える・ほかの子の名前・混雑・接続・時間切れ・キーが無効
func TestAiDiaryFailures(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{}
	enableAI(t, a, fake)
	teacher := loginAs(a, accTeacher, "staff")
	body := diaryDraftBody(t, nil)
	failed := func(name string) {
		t.Helper()
		raw := expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", body), http.StatusServiceUnavailable)
		if !strings.Contains(raw, msgAiFailed) || !strings.Contains(raw, kindAiUnavailable) {
			t.Errorf("%s: %s", name, raw)
		}
	}
	long := strings.Repeat("あ", 2000)
	cases := []struct {
		name  string
		reply draftReply
		err   error
	}{
		{"拒否", draftReply{Refused: true}, nil},
		{"JSON でない", draftReply{JSON: "下書きです"}, nil},
		{"形が合わない（候補を返した）", draftReply{JSON: `{"candidates":["a","b","c"]}`}, nil},
		{"送っていない見出し", draftReply{JSON: `{"sections":[{"heading":"午睡","text":"a"}]}`}, nil},
		{"同じ見出しが2度", draftReply{JSON: `{"sections":[{"heading":"食事","text":"a"},{"heading":"食事","text":"b"}]}`}, nil},
		{"送った順でない", draftReply{JSON: `{"sections":[{"heading":"食事","text":"a"},{"heading":"今日の様子","text":"b"}]}`}, nil},
		{"余計な項目", draftReply{JSON: `{"sections":[{"heading":"食事","text":"a","x":1}]}`}, nil},
		{"全体が2,000文字を超える", draftReply{JSON: `{"sections":[{"heading":"今日の様子","text":"` + long + `"}]}`}, nil},
		{"宛先以外の園児の名前が入っていた", draftReply{JSON: `{"sections":[{"heading":"今日の様子","text":"伊藤葵さんと遊んだ。"}]}`}, nil},
		{"混雑（529）", draftReply{}, &aiStatusError{StatusCode: 529, RequestID: "req_x"}},
		{"接続の失敗", draftReply{}, errTest("dial tcp: connection refused")},
	}
	for _, c := range cases {
		before := fake.calls()
		fake.reply, fake.err = c.reply, c.err
		failed(c.name)
		if fake.calls() != before+1 { // 再試行しない
			t.Errorf("%s: 呼んだ回数 %d", c.name, fake.calls()-before)
		}
	}
	var failedLogs int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE function_type = '1' AND operation_type = '6' AND target_table = 't_diary'
		AND after_value = '{"用途":"保育日誌","結果":"失敗"}'`).Scan(&failedLogs)
	if failedLogs != len(cases) || a.aiSucceededToday() != 0 {
		t.Errorf("失敗の記録 %d・成功の数 %d", failedLogs, a.aiSucceededToday())
	}
	// 2,000文字ちょうどなら通る（見出しの行を含めて）
	fake.err = nil
	fill := 2000 - len([]rune("【今日の様子】\n")) - len([]rune("\n\n【食事】"))
	fake.reply = draftReply{JSON: `{"sections":[{"heading":"今日の様子","text":"` + strings.Repeat("あ", fill) + `"}]}`}
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", body), http.StatusOK)

	// 時間切れ
	fake.block = true
	a.aiTimeoutForTest = 50 * time.Millisecond
	start := time.Now()
	failed("時間切れ")
	if time.Since(start) > 5*time.Second {
		t.Errorf("時間切れまでが長い: %v", time.Since(start))
	}
	fake.block = false
	// キーが無効（401）と分かったら、以降は使えない扱いにする
	fake.err = &aiStatusError{StatusCode: 401, RequestID: "req_y"}
	failed("キーが無効")
	if !a.aiKeyRejected.Load() {
		t.Fatal("キーが無効と分かったのに立たない")
	}
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", body), http.StatusForbidden)
}

// 1日の上限は、園全体で1つ（園からのひとことなどと数を分けない）。上限に達したら呼ばずに 429
func TestAiDiaryDailyLimit(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{}
	enableAI(t, a, fake)
	mustExec(t, a, `UPDATE m_setting SET setting_value = '2' WHERE setting_key = 'ai.daily_limit'`)
	teacher := loginAs(a, accTeacher, "staff")
	// 園からのひとことで1回使うと、日誌の下書きで残りは1回
	fake.reply = draftReply{JSON: `{"draft":"ありがとうございました。"}`}
	call(t, h, teacher, "POST", "/api/ai/drafts", jsonBody(t, map[string]any{"purpose": "facility_note", "child_id": "C001", "date": today()}))
	fake.reply = draftReply{JSON: diaryFakeReply}
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", diaryDraftBody(t, nil)), http.StatusOK)
	raw := expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", diaryDraftBody(t, nil)), http.StatusTooManyRequests)
	if !strings.Contains(raw, msgAiLimit) || !strings.Contains(raw, kindAiLimit) || fake.calls() != 2 {
		t.Fatalf("上限: %s（呼んだ回数 %d）", raw, fake.calls())
	}
	if a.aiInFlight != 0 {
		t.Fatalf("呼び出し中 %d", a.aiInFlight)
	}
}
