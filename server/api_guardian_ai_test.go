package main

import (
	"database/sql"
	"net/http"
	"strings"
	"testing"
)

/*
保護者のメニューの「AI の下書きの利用」（POST /api/guardian/children/{childID}/ai-opt-out）
典拠：詳細設計書「AI の下書きの利用」(4-15 (3))・「保護者のメニュー」(2-15 (4))・決めたこと D-49、
     基本設計書「園の有効化と保護者の拒否」(4-11)・「権限チェックの実装方針」(6-2)

権限の担保はサーバ側。モックの同じ観点は web/tests/guardianAiOptOut.test.ts にある（aiOptOutRefusals は同じ名前の表と同じ行）。
*/

// optOutOf は、その紐づけの ai_opt_out（行が無ければ -1）
func optOutOf(t *testing.T, a *app, guardianID, childID string) int {
	t.Helper()
	var v int
	err := a.db.QueryRow(`SELECT ai_opt_out FROM t_guardian_child WHERE guardian_id = ? AND child_id = ?`, guardianID, childID).Scan(&v)
	if err == sql.ErrNoRows {
		return -1
	}
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// aiOptOutLogs は、AI の下書きの利用の操作ログ（新しい順）。[アカウント/機能/操作/対象, 表, 変更前, 変更後]
func aiOptOutLogs(t *testing.T, a *app, childID string) [][4]string {
	t.Helper()
	rows, err := a.db.Query(`SELECT account_id || '/' || function_type || '/' || operation_type || '/' || IFNULL(target_id, ''),
		target_table, IFNULL(before_value, ''), IFNULL(after_value, '') FROM t_operation_log
		WHERE target_table = 't_guardian_child' AND target_child_id = ? AND after_value LIKE '%AI の下書き%'
		ORDER BY operation_log_id DESC`, childID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := [][4]string{}
	for rows.Next() {
		var r [4]string
		if err := rows.Scan(&r[0], &r[1], &r[2], &r[3]); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func optOutBody(v bool) string {
	if v {
		return `{"opt_out":true}`
	}
	return `{"opt_out":false}`
}

// aiOptOutRefusals は、断る場合の表。web/tests/guardianAiOptOut.test.ts の同じ名前の表と同じ行
var aiOptOutRefusals = []struct {
	name    string
	account int64
	child   string
	body    string
	setup   []string
	undo    []string
	status  int
	message string
}{
	{name: "職員（担任）", account: accTeacher, child: "C001", body: optOutBody(true), status: http.StatusForbidden, message: msgGuardianOnly},
	{name: "職員（管理者）", account: accAdmin, child: "C001", body: optOutBody(true), status: http.StatusForbidden, message: msgGuardianOnly},
	{name: "他児（紐づけが無い）", account: accGuardian, child: "C004", body: optOutBody(true), status: http.StatusForbidden, message: msgContactForbidden},
	{name: "無い園児", account: accGuardian, child: "C999", body: optOutBody(true), status: http.StatusForbidden, message: msgContactForbidden},
	{name: "紐づけが終了", account: accGuardian, child: "C001", body: optOutBody(true),
		setup:  []string{`UPDATE t_guardian_child SET link_status = '2', ended_at = '2026-08-20T10:00:00' WHERE guardian_id = 'G001' AND child_id = 'C001'`},
		undo:   []string{`UPDATE t_guardian_child SET link_status = '1', ended_at = NULL WHERE guardian_id = 'G001' AND child_id = 'C001'`},
		status: http.StatusForbidden, message: msgContactForbidden},
	{name: "猶予中", account: accGuardian, child: "C001", body: optOutBody(true),
		setup:  []string{`UPDATE t_guardian_child SET link_status = '3', grace_ends_on = '2099-03-31' WHERE guardian_id = 'G001' AND child_id = 'C001'`},
		undo:   []string{`UPDATE t_guardian_child SET link_status = '1', grace_ends_on = NULL WHERE guardian_id = 'G001' AND child_id = 'C001'`},
		status: http.StatusForbidden, message: msgGuardianSettingGrace},
	{name: "園が AI を有効にしていない", account: accGuardian, child: "C001", body: optOutBody(true),
		setup:  []string{`UPDATE m_setting SET setting_value = '0' WHERE setting_key = 'ai.enabled'`},
		undo:   []string{`UPDATE m_setting SET setting_value = '1' WHERE setting_key = 'ai.enabled'`},
		status: http.StatusBadRequest, message: msgAiNotEnabled},
	{name: "opt_out が無い", account: accGuardian, child: "C001", body: `{}`, status: http.StatusBadRequest, message: msgBadRequest},
	{name: "opt_out が真偽でない", account: accGuardian, child: "C001", body: `{"opt_out":"1"}`, status: http.StatusBadRequest, message: msgBadRequest},
}

func TestAiOptOutRefusals(t *testing.T) {
	a, h := newTestApp(t)
	enableAI(t, a, &fakeWriter{})
	for _, c := range aiOptOutRefusals {
		for _, q := range c.setup {
			mustExec(t, a, q)
		}
		entrance := "staff"
		if c.account == accGuardian {
			entrance = "guardian"
		}
		rec := request(t, h, loginAs(a, c.account, entrance), "POST", "/api/guardian/children/"+c.child+"/ai-opt-out", c.body)
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.message) {
			t.Errorf("%s: %d %s, want %d %q", c.name, rec.Code, rec.Body.String(), c.status, c.message)
		}
		for _, q := range c.undo {
			mustExec(t, a, q)
		}
	}
	// どれも書いていない
	if got := optOutOf(t, a, "G001", "C001"); got != 0 {
		t.Fatalf("断ったのに書き換わった: %d", got)
	}
	if got := optOutOf(t, a, "G004", "C004"); got != 0 {
		t.Fatalf("他児の紐づけが書き換わった: %d", got)
	}
	if logs := aiOptOutLogs(t, a, "C001"); len(logs) != 0 {
		t.Fatalf("断ったのに操作ログがある: %v", logs)
	}
}

// 断ったら、その子には AI の下書きが作られない（api_ai.go の aiChildConsented が読む）。押し直せば戻る
func TestAiOptOutStopsDrafts(t *testing.T) {
	a, h := newTestApp(t)
	fake := &fakeWriter{reply: draftReply{JSON: `{"draft":"きょうもありがとうございました。"}`}}
	enableAI(t, a, fake)
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	status := func() bool {
		var st struct{ Available bool }
		decode(t, call(t, h, teacher, "GET", "/api/ai/status?child_id=C001", ""), &st)
		return st.Available
	}
	draft := `{"purpose":"facility_note","child_id":"C001","date":"` + today() + `"}`
	if !status() {
		t.Fatal("断る前から使えない")
	}

	raw := call(t, h, guardian, "POST", "/api/guardian/children/C001/ai-opt-out", optOutBody(true)).Body.String()
	if strings.TrimSpace(raw) != `{"ok":true}` {
		t.Fatalf("応答にほかの値が入っている: %s", raw)
	}
	if got := optOutOf(t, a, "G001", "C001"); got != 1 {
		t.Fatalf("ai_opt_out = %d", got)
	}
	if status() {
		t.Fatal("断ったのに AI のボタンが出る")
	}
	expectStatus(t, request(t, h, teacher, "POST", "/api/ai/drafts", draft), http.StatusForbidden)
	if len(fake.got) != 0 {
		t.Fatalf("断った子の下書きで AI を呼んだ: %d 回", len(fake.got))
	}
	logs := aiOptOutLogs(t, a, "C001")
	want := [4]string{"6/7/2/6", "t_guardian_child", `{"AI の下書きを使わない":"使う"}`, `{"AI の下書きを使わない":"使わない"}`}
	if len(logs) != 1 || logs[0] != want {
		t.Fatalf("操作ログ: %v, want %v", logs, want)
	}

	// 同じ値をもう一度送っても、変わっていないので操作ログを足さない
	call(t, h, guardian, "POST", "/api/guardian/children/C001/ai-opt-out", optOutBody(true))
	if n := len(aiOptOutLogs(t, a, "C001")); n != 1 {
		t.Fatalf("変わっていないのに操作ログが増えた: %d", n)
	}

	// 外せば戻る
	call(t, h, guardian, "POST", "/api/guardian/children/C001/ai-opt-out", optOutBody(false))
	if !status() {
		t.Fatal("外したのに使えない")
	}
	call(t, h, teacher, "POST", "/api/ai/drafts", draft)
	logs = aiOptOutLogs(t, a, "C001")
	if len(logs) != 2 || logs[0][2] != `{"AI の下書きを使わない":"使わない"}` || logs[0][3] != `{"AI の下書きを使わない":"使う"}` {
		t.Fatalf("外したときの操作ログ: %v", logs)
	}
}

// guardianHomeOptOut は、保護者ホームの「きょう」の ai_opt_out を園児ごとに返す
func guardianHomeOptOut(t *testing.T, h http.Handler, c *http.Cookie) map[string]bool {
	t.Helper()
	var rows []struct {
		Today struct {
			ChildID  string `json:"child_id"`
			AiOptOut bool   `json:"ai_opt_out"`
		} `json:"today"`
	}
	decode(t, call(t, h, c, "GET", "/api/dashboard/guardian", ""), &rows)
	out := map[string]bool{}
	for _, r := range rows {
		out[r.Today.ChildID] = r.Today.AiOptOut
	}
	return out
}

// きょうだいは園児ごと。片方だけ断ったとき、もう片方は使える
func TestAiOptOutSiblings(t *testing.T) {
	a, h := newTestApp(t)
	enableAI(t, a, &fakeWriter{})
	// 野原さん（G001）に、きょうだいとして C006（さくら組。ほかに保護者はいない）を紐づける
	mustExec(t, a, `INSERT INTO t_guardian_child (guardian_id, child_id, relationship, link_status, linked_at) VALUES ('G001','C006','父','1','2026-04-01T09:00:00')`)
	teacher, err := a.loadSessionUser(accTeacher)
	if err != nil {
		t.Fatal(err)
	}
	guardian := loginAs(a, accGuardian, "guardian")
	if !a.aiAvailableFor(teacher, aiTarget{ChildID: "C001"}) || !a.aiAvailableFor(teacher, aiTarget{ChildID: "C006"}) {
		t.Fatal("断る前から使えない")
	}

	call(t, h, guardian, "POST", "/api/guardian/children/C006/ai-opt-out", optOutBody(true))
	if a.aiAvailableFor(teacher, aiTarget{ChildID: "C006"}) {
		t.Fatal("断った C006 に使える")
	}
	if !a.aiAvailableFor(teacher, aiTarget{ChildID: "C001"}) {
		t.Fatal("断っていない C001 まで使えなくなった")
	}
	if got := guardianHomeOptOut(t, h, guardian); !got["C006"] || got["C001"] {
		t.Fatalf("保護者ホームの ai_opt_out: %v", got)
	}
}

// 自分の紐づけの値だけを変える。ほかの家族の値は変えない・見せない（決めたこと D-49）
func TestAiOptOutOnlyOwnLink(t *testing.T) {
	a, h := newTestApp(t)
	enableAI(t, a, &fakeWriter{})
	// C001 に、もう1人の家族（G004）が紐づいていて、その人は断っている
	mustExec(t, a, `INSERT INTO t_guardian_child (guardian_id, child_id, relationship, link_status, linked_at, ai_opt_out) VALUES ('G004','C001','母','1','2026-04-01T09:00:00',1)`)
	teacher, err := a.loadSessionUser(accTeacher)
	if err != nil {
		t.Fatal(err)
	}
	guardian := loginAs(a, accGuardian, "guardian")

	// ほかの家族が断っていることは、自分の画面の初期値に出ない
	if got := guardianHomeOptOut(t, h, guardian); got["C001"] {
		t.Fatalf("ほかの家族の値が出ている: %v", got)
	}
	// 自分が断ってから外しても、ほかの家族の値は変わらない。1人でも断っていれば使わない
	call(t, h, guardian, "POST", "/api/guardian/children/C001/ai-opt-out", optOutBody(true))
	call(t, h, guardian, "POST", "/api/guardian/children/C001/ai-opt-out", optOutBody(false))
	if got := optOutOf(t, a, "G004", "C001"); got != 1 {
		t.Fatalf("ほかの家族の値が変わった: %d", got)
	}
	if got := optOutOf(t, a, "G001", "C001"); got != 0 {
		t.Fatalf("自分の値: %d", got)
	}
	if a.aiAvailableFor(teacher, aiTarget{ChildID: "C001"}) {
		t.Fatal("ほかの家族が断っているのに使える")
	}
}
