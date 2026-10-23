package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

/*
 * 午睡チェックの記録の修正（POST /api/nap/records/{id}/correct）
 * 典拠：基本設計書.md「記録の修正と改ざん防止」「帳票の出力」(4-8)・「入力項目の制約値」(4-12)・「操作ログ（t_operation_log）」(5-9)、
 *      詳細設計書.md「訂正・取り消しのまとめ」(3-5)、図/画面詳細図.md「午睡記録検索画面」(5-3) の項目10・12
 *
 * 画面側のモック（web/src/api/mock.ts の correctNapRecord）と同じ観点を、web/tests/napCorrect.test.ts で確かめる。
 * デモ：今日の実施 1（さくら組）に記録 1（西田 太郎 13:20、仰向け・あり・通常・36.6、記録者 鈴木 浩之）と
 * 記録 2（遠藤 花子 13:20、右向き・36.8）。異常時の記録は2日前（記録 1）と昨日（記録 2）にだけある
 */

type napRecordOut struct {
	NapRecordID  int64    `json:"nap_record_id"`
	ChildID      string   `json:"child_id"`
	CheckedAt    string   `json:"checked_at"`
	SavedAt      string   `json:"saved_at"`
	BodyPosition string   `json:"body_position"`
	Breathing    string   `json:"breathing"`
	Complexion   string   `json:"complexion"`
	Temperature  *float64 `json:"temperature"`
	StaffID      string   `json:"staff_id"`
	CorrectedAt  *string  `json:"corrected_at"`
}

func correctPath(id int64) string {
	return "/api/nap/records/" + strconv.FormatInt(id, 10) + "/correct"
}

// expectNapCorrectError は、修正が断られた状態と文言を確かめる
func expectNapCorrectError(t *testing.T, h http.Handler, c *http.Cookie, id int64, body string, status int, message string) {
	t.Helper()
	rec := request(t, h, c, "POST", correctPath(id), body)
	expectStatus(t, rec, status)
	var e apiError
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e.Message != message {
		t.Fatalf("文言 = %q（%v）、want %q", e.Message, err, message)
	}
}

type napCorrectLog struct {
	accountID     int64
	targetID      int64
	child         string
	before, after string
}

// napCorrectLogs は、午睡チェックの記録の修正の操作ログ（午睡 3・変更 2・t_nap_record）を古い順に返す
func napCorrectLogs(t *testing.T, a *app) []napCorrectLog {
	t.Helper()
	rows, err := a.db.Query(`SELECT account_id, target_id, target_child_id, before_value, after_value FROM t_operation_log
		WHERE function_type = '3' AND operation_type = '2' AND target_table = 't_nap_record' ORDER BY operation_log_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []napCorrectLog{}
	for rows.Next() {
		var x napCorrectLog
		if err := rows.Scan(&x.accountID, &x.targetID, &x.child, &x.before, &x.after); err != nil {
			t.Fatal(err)
		}
		out = append(out, x)
	}
	return out
}

func recordOf(t *testing.T, a *app, id int64) *NapRecord {
	t.Helper()
	x, err := a.napRecordByID(id)
	if err != nil {
		t.Fatal(err)
	}
	return x
}

// 一般（その園児のクラスの担任）は、実施の日のうちに直せる。行を書き換え、変わった項目だけを修正前・修正後と理由で操作ログへ残す
func TestCorrectNapRecordByTeacherOnTheDay(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	before := recordOf(t, a, 1)

	var got napRecordOut
	decode(t, call(t, h, teacher, "POST", correctPath(1),
		`{"body_position":"2","temperature":36.9,"breathing":"1","reason":"  体位を押し間違えた  "}`), &got)
	if got.BodyPosition != "2" || got.Temperature == nil || *got.Temperature != 36.9 || got.Breathing != "1" {
		t.Fatalf("書き換えた値が返っていません: %+v", got)
	}
	if got.CorrectedAt == nil || *got.CorrectedAt == "" {
		t.Fatalf("corrected_at が入っていません: %+v", got)
	}
	// チェックした時刻・保存時刻・記録した職員は変えない
	if got.CheckedAt != before.CheckedAt || got.SavedAt != before.SavedAt || got.StaffID != before.StaffID || got.ChildID != "C001" {
		t.Fatalf("変えない項目が変わっています: %+v（前 %+v）", got, before)
	}
	after := recordOf(t, a, 1)
	if after.BodyPosition != "2" || after.CorrectedAt == nil {
		t.Fatalf("行が書き換わっていません: %+v", after)
	}

	logs := napCorrectLogs(t, a)
	if len(logs) != 1 {
		t.Fatalf("修正の操作ログが %d 件、want 1", len(logs))
	}
	l := logs[0]
	// 呼吸は同じ値を送ったので入れない。理由は前後の空白を除く
	if l.accountID != accTeacher || l.targetID != 1 || l.child != "C001" ||
		l.before != `{"体位":"仰向け","体温":36.6}` || l.after != `{"体位":"うつ伏せ","体温":36.9,"理由":"体位を押し間違えた"}` {
		t.Fatalf("操作ログ = %+v", l)
	}

	// 体温は null で消せる
	decode(t, call(t, h, teacher, "POST", correctPath(1), `{"temperature":null,"reason":"体温は測っていなかった"}`), &got)
	if got.Temperature != nil {
		t.Fatalf("体温が消えていません: %+v", got)
	}
	if logs := napCorrectLogs(t, a); len(logs) != 2 || logs[1].before != `{"体温":36.9}` ||
		logs[1].after != `{"体温":null,"理由":"体温は測っていなかった"}` {
		t.Fatalf("体温を消した操作ログ = %+v", logs)
	}
}

// 理由は必須（1〜500文字）。値の誤り・変わらない修正・無い記録も断り、行も操作ログも変えない
func TestCorrectNapRecordRejectsBadInput(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	cases := []struct {
		name, body string
		id         int64
		status     int
		message    string
	}{
		{"理由が無い", `{"body_position":"2"}`, 1, http.StatusBadRequest, msgNapCorrectReason},
		{"理由が空白だけ", `{"body_position":"2","reason":"　 "}`, 1, http.StatusBadRequest, msgNapCorrectReason},
		{"理由が501文字", `{"body_position":"2","reason":"` + strings.Repeat("あ", 501) + `"}`, 1, http.StatusBadRequest, msgNapCorrectReasonLong},
		{"体位の値が無い", `{"body_position":"9","reason":"x"}`, 1, http.StatusBadRequest, "体位を選んでください"},
		{"呼吸の値が無い", `{"breathing":"","reason":"x"}`, 1, http.StatusBadRequest, "呼吸を選んでください"},
		{"顔色の値が無い", `{"complexion":"5","reason":"x"}`, 1, http.StatusBadRequest, "顔色を選んでください"},
		{"体温が小数第2位", `{"temperature":36.65,"reason":"x"}`, 1, http.StatusBadRequest, "体温は小数第1位までで入力してください"},
		{"体温が数でない", `{"temperature":"36.5","reason":"x"}`, 1, http.StatusBadRequest, "体温は小数第1位までで入力してください"},
		{"変わらない", `{"body_position":"1","temperature":36.6,"reason":"x"}`, 1, http.StatusBadRequest, msgNapCorrectNoChange},
		{"直す項目が無い", `{"reason":"x"}`, 1, http.StatusBadRequest, msgNapCorrectNoChange},
		{"無い記録", `{"body_position":"2","reason":"x"}`, 999999, http.StatusNotFound, msgNapCorrectNotFound},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			expectNapCorrectError(t, h, admin, c.id, c.body, c.status, c.message)
		})
	}
	if logs := napCorrectLogs(t, a); len(logs) != 0 || recordOf(t, a, 1).CorrectedAt != nil {
		t.Fatalf("断った修正が残っています: %+v", logs)
	}
	// 500文字ちょうどは受け付ける
	call(t, h, admin, "POST", correctPath(1), `{"body_position":"3","reason":"`+strings.Repeat("あ", 500)+`"}`)
	if logs := napCorrectLogs(t, a); len(logs) != 1 {
		t.Fatalf("500文字の理由の修正の操作ログが %d 件、want 1", len(logs))
	}
}

// 直せる人：一般はその園児のクラスの担任が実施の日のうちだけ。翌日以降と、その実施で異常時の記録がある子は管理者だけ
func TestCorrectNapRecordWhoCanCorrect(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	other := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	_, yesterday, _ := demoNapDates(t, a)

	// 昨日の実施 2（さくら組）に、西田 太郎の確認の記録を足す
	res, err := a.db.Exec(`INSERT INTO t_nap_record (nap_session_id, child_id, checked_at, saved_at, body_position,
		breathing, complexion, temperature, staff_id) VALUES (2, 'C001', ?, ?, '1', '1', '1', NULL, 'S003')`,
		yesterday+"T13:20:00", yesterday+"T13:20:10")
	if err != nil {
		t.Fatal(err)
	}
	yesterdayID, _ := res.LastInsertId()
	// 今日の実施 1 で、遠藤 花子（記録 2）に異常時の記録を足す
	if _, err := a.db.Exec(`INSERT INTO t_nap_abnormal (nap_session_id, child_id, found_at, recorded_at, situation,
		response, staff_id, diary_id) VALUES (1, 'C002', ?, ?, '状況', '対応', 'S003', NULL)`, now(), now()); err != nil {
		t.Fatal(err)
	}
	body := `{"complexion":"3","reason":"顔色を見直した"}`

	expectNapCorrectError(t, h, guardian, 1, body, http.StatusForbidden, "職員のみが行えます")
	expectNapCorrectError(t, h, other, 1, body, http.StatusForbidden, msgNapCorrectForbidden)           // ほかのクラスの担任
	expectNapCorrectError(t, h, teacher, yesterdayID, body, http.StatusForbidden, msgNapCorrectPastDay) // 翌日以降の一般
	expectNapCorrectError(t, h, teacher, 2, body, http.StatusForbidden, msgNapCorrectAbnormal)          // 異常時の記録がある子
	if logs := napCorrectLogs(t, a); len(logs) != 0 || recordOf(t, a, 2).CorrectedAt != nil {
		t.Fatalf("断った修正が残っています: %+v", logs)
	}

	// フリーの職員（今年度の担任クラスが無い一般）は読めるが直せない
	if _, err := a.db.Exec(`DELETE FROM t_class_staff WHERE staff_id = 'S005'`); err != nil {
		t.Fatal(err)
	}
	expectNapCorrectError(t, h, other, 1, body, http.StatusForbidden, msgNapCorrectForbidden)

	// 管理者は翌日以降も、異常時の記録がある子も直せる
	call(t, h, admin, "POST", correctPath(yesterdayID), body)
	call(t, h, admin, "POST", correctPath(2), body)
	// その園児のクラスの担任は、その日のうちなら直せる（記録した職員でなくてもよい）
	call(t, h, teacher, "POST", correctPath(1), body)
	logs := napCorrectLogs(t, a)
	if len(logs) != 3 || logs[0].accountID != accAdmin || logs[0].targetID != yesterdayID ||
		logs[1].targetID != 2 || logs[2].accountID != accTeacher || logs[2].targetID != 1 {
		t.Fatalf("修正の操作ログ = %+v", logs)
	}
}

// 午睡記録検索の確認の行に、修正あり（corrected_at）と、その利用者が直せるか（can_correct）を返す
func TestNapSearchShowsCorrectedAndCanCorrect(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	today, yesterday, _ := demoNapDates(t, a)
	if _, err := a.db.Exec(`INSERT INTO t_nap_record (nap_session_id, child_id, checked_at, saved_at, body_position,
		breathing, complexion, temperature, staff_id) VALUES (2, 'C001', ?, ?, '1', '1', '1', NULL, 'S003')`,
		yesterday+"T13:20:00", yesterday+"T13:20:10"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(`INSERT INTO t_nap_abnormal (nap_session_id, child_id, found_at, recorded_at, situation,
		response, staff_id, diary_id) VALUES (1, 'C002', ?, ?, '状況', '対応', 'S003', NULL)`, now(), now()); err != nil {
		t.Fatal(err)
	}
	call(t, h, teacher, "POST", correctPath(1), `{"body_position":"3","reason":"左向きだった"}`)

	type row struct {
		Kind        string  `json:"kind"`
		NapRecordID *int64  `json:"nap_record_id"`
		ChildID     string  `json:"child_id"`
		SessionDate string  `json:"session_date"`
		CorrectedAt *string `json:"corrected_at"`
		CanCorrect  bool    `json:"can_correct"`
	}
	search := func(c *http.Cookie) []row {
		var p struct {
			Rows []row `json:"rows"`
		}
		decode(t, call(t, h, c, "GET", "/api/nap/records?from="+yesterday+"&to="+today+"&class_id=1", ""), &p)
		return p.Rows
	}
	find := func(rows []row, pred func(r row) bool) row {
		t.Helper()
		for _, r := range rows {
			if pred(r) {
				return r
			}
		}
		t.Fatal("行が見つかりません")
		return row{}
	}
	isRecord := func(id int64) func(r row) bool {
		return func(r row) bool { return r.NapRecordID != nil && *r.NapRecordID == id }
	}

	rows := search(teacher)
	if r := find(rows, isRecord(1)); r.CorrectedAt == nil || !r.CanCorrect {
		t.Fatalf("直した今日の記録に修正ありと修正が出ていません: %+v", r)
	}
	if r := find(rows, isRecord(2)); r.CorrectedAt != nil || r.CanCorrect {
		t.Fatalf("異常時の記録がある子の行を、担任が直せることになっています: %+v", r)
	}
	if r := find(rows, func(r row) bool { return r.Kind == "check" && r.SessionDate == yesterday }); r.CanCorrect {
		t.Fatalf("昨日の行を、担任が直せることになっています: %+v", r)
	}
	for _, r := range rows {
		if r.Kind != "check" && (r.CanCorrect || r.CorrectedAt != nil) {
			t.Fatalf("確認でない行に修正が出ています: %+v", r)
		}
	}
	for _, r := range search(admin) {
		if r.Kind == "check" && !r.CanCorrect {
			t.Fatalf("管理者が直せない確認の行があります: %+v", r)
		}
	}
}

// 帳票：修正した記録に「修正あり」の印を付け、末尾に「修正の履歴」の表（1回の修正で1行）を続ける。件数に履歴の行も入れる
func TestNapReportShowsCorrections(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	today, _, twoDaysAgo := demoNapDates(t, a)

	// 修正の前は、履歴の表を出さない
	if f := napReportOf(t, h, admin, "?from="+twoDaysAgo+"&to="+today); f.hasHistory {
		t.Fatal("修正が無いのに修正の履歴が出ています")
	}

	call(t, h, teacher, "POST", correctPath(1), `{"body_position":"2","temperature":36.9,"reason":"押し間違い"}`)
	call(t, h, admin, "POST", correctPath(1), `{"temperature":null,"reason":"=未計測"}`)
	call(t, h, admin, "POST", correctPath(2), `{"breathing":"2","reason":"見直した"}`)

	f := napReportOf(t, h, admin, "?from="+twoDaysAgo+"&to="+today)
	isFixed := func(r []string) bool {
		return r[0] == today && strings.HasSuffix(r[1], "T13:20:00") && r[5] != "" && (r[2] == "西田 太郎" || r[2] == "遠藤 花子")
	}
	fixed := 0
	for _, r := range f.rows {
		switch {
		case isFixed(r):
			fixed++
			if r[10] != "修正あり" {
				t.Fatalf("修正した行に「修正あり」が付いていません: %v", r)
			}
		case r[10] != "":
			t.Fatalf("直していない行に「修正あり」が付いています: %v", r)
		}
		// 一覧の値は直したあとの値
		if isFixed(r) && r[2] == "西田 太郎" && (r[4] != "うつ伏せ" || r[7] != "") {
			t.Fatalf("一覧が直したあとの値になっていません: %v", r)
		}
	}
	if fixed != 2 {
		t.Fatalf("修正した行が %d 行、want 2", fixed)
	}

	// 修正の履歴：並びは 園児（よみ：えんどう → にしだ）→ 修正日時。式の始まりのセルは逃がす（' を付けて出す）
	if !f.hasHistory || len(f.histories) != 3 {
		t.Fatalf("修正の履歴が3行ではありません: %v", f.histories)
	}
	rec := "午睡チェックの記録（遠藤 花子・" + today + "T13:20:00）"
	if h0 := f.histories[0]; h0[0] != rec || h0[2] != "西田 拓也" || h0[3] != "呼吸=あり" || h0[4] != "呼吸=確認できず" || h0[5] != "見直した" {
		t.Fatalf("修正の履歴の1行目 = %v", h0)
	}
	rec = "午睡チェックの記録（西田 太郎・" + today + "T13:20:00）"
	if h1 := f.histories[1]; h1[0] != rec || h1[2] != "鈴木 浩之" || h1[3] != "体位=仰向け、体温=36.6" ||
		h1[4] != "体位=うつ伏せ、体温=36.9" || h1[5] != "押し間違い" {
		t.Fatalf("修正の履歴の2行目 = %v", h1)
	}
	if h2 := f.histories[2]; h2[0] != rec || h2[2] != "西田 拓也" || h2[3] != "体温=36.9" || h2[4] != "体温=なし" ||
		h2[5] != "'=未計測" || h2[1] < f.histories[1][1] {
		t.Fatalf("修正の履歴の3行目 = %v", h2)
	}
	for _, r := range f.histories {
		if len(r) != len(napReportHistoryHeader) || r[1] == "" {
			t.Fatalf("修正の履歴の行の形が正しくありません: %v", r)
		}
	}

	// 件数は、一覧・異常時の記録・修正の履歴の行の合計
	var after string
	if err := a.db.QueryRow(`SELECT after_value FROM t_operation_log WHERE function_type = '3' AND operation_type = '5'
		ORDER BY operation_log_id DESC LIMIT 1`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	count := len(f.rows) + len(f.abnormals) + len(f.histories)
	if !strings.HasSuffix(after, "・"+strconv.Itoa(count)+" 件）") {
		t.Fatalf("出力の操作ログ = %q、件数 want %d", after, count)
	}

	// クラスの外の修正は出さない（ひまわり組だけ）
	if g := napReportOf(t, h, admin, "?from="+twoDaysAgo+"&to="+today+"&class_id=2"); g.hasHistory {
		t.Fatalf("ほかのクラスの修正の履歴が出ています: %v", g.histories)
	}
}

// 以前に作られたデータベースにも corrected_at を足す。何度呼んでも同じ
func TestEnsureNapRecordCorrectedAt(t *testing.T) {
	a, _ := newTestApp(t)
	if _, err := a.db.Exec(`ALTER TABLE t_nap_record DROP COLUMN corrected_at`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := ensureNapRecordCorrectedAt(a.db); err != nil {
			t.Fatal(err)
		}
	}
	if x := recordOf(t, a, 1); x.CorrectedAt != nil {
		t.Fatalf("足したばかりの corrected_at が空ではありません: %+v", x)
	}
}
