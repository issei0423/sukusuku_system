package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

/*
 * 異常時の記録の修正（POST /api/nap/abnormals/{id}/correct）
 * 典拠：基本設計書.md「記録の修正と改ざん防止」「帳票の出力」(4-8)・「入力項目の制約値」(4-12)・「操作ログ（t_operation_log）」(5-9)、
 *      詳細設計書.md「訂正・取り消しのまとめ」(3-5)、図/画面詳細図.md「異常時記録画面」(5-2) の項目17、図/インタフェース一覧.md
 *
 * 画面側のモック（web/src/api/mock.ts の correctNapAbnormal）と同じ観点を、web/tests/napAbnormalCorrect.test.ts で確かめる。
 * デモ：異常時の記録 1（鈴木 健、2日前の実施 3、ヒヤリハット起票済み）と記録 2（久保田 陸、昨日の実施 2、未起票）。
 * どちらもさくら組。今日の実施 1（さくら組）に記録は無いので、テストが足す
 */

func abnormalCorrectPath(id int64) string {
	return "/api/nap/abnormals/" + strconv.FormatInt(id, 10) + "/correct"
}

// expectAbnormalCorrectError は、異常時の記録の修正が断られた状態と文言を確かめる
func expectAbnormalCorrectError(t *testing.T, h http.Handler, c *http.Cookie, path, body string, status int, message string) {
	t.Helper()
	rec := request(t, h, c, "POST", path, body)
	expectStatus(t, rec, status)
	if got := errorMessageOf(t, rec); got != message {
		t.Fatalf("文言 = %q、want %q", got, message)
	}
}

// napAbnormalCorrectLogs は、異常時の記録の修正の操作ログ（午睡 3・変更 2・t_nap_abnormal）を古い順に返す
func napAbnormalCorrectLogs(t *testing.T, a *app) []napCorrectLog {
	t.Helper()
	rows, err := a.db.Query(`SELECT account_id, target_id, target_child_id, before_value, after_value FROM t_operation_log
		WHERE function_type = '3' AND operation_type = '2' AND target_table = 't_nap_abnormal' ORDER BY operation_log_id`)
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

// addTodayAbnormal は、今日の実施 1（さくら組）に、西田 太郎（C001）の異常時の記録を足す。記録した職員は S004（さくら組のもう1人の担任）。
// noticedAt が空でなければ、保護者へ「した」（電話・母）として連絡した日時を入れる
func addTodayAbnormal(t *testing.T, a *app, foundAt, recordedAt, noticedAt string) int64 {
	t.Helper()
	var notice, at, method, person any
	if noticedAt != "" {
		notice, at, method, person = "1", noticedAt, "1", "母"
	}
	res, err := a.db.Exec(`INSERT INTO t_nap_abnormal (nap_session_id, child_id, found_at, recorded_at, situation,
		response, staff_id, diary_id, guardian_notice, guardian_noticed_at, guardian_notice_method, guardian_notice_person)
		VALUES (1, 'C001', ?, ?, '寝返りでうつ伏せ', '仰向けに直した', 'S004', NULL, ?, ?, ?, ?)`,
		foundAt, recordedAt, notice, at, method, person)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

func abnormalCorrectedAt(t *testing.T, a *app, id int64) sql.NullString {
	t.Helper()
	var v sql.NullString
	if err := a.db.QueryRow(`SELECT corrected_at FROM t_nap_abnormal WHERE nap_abnormal_id = ?`, id).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// minuteISO は、日時を分までにそろえる（画面の datetime-local は分まで送る）
func minuteISO(v string) string { return v[:16] + ":00" }

// 一般（その園児のクラスの担任）は、実施の日のうちに直せる。行を書き換え、変わった項目だけを修正前・修正後と理由で操作ログへ残す
func TestCorrectNapAbnormalByTeacherOnTheDay(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	foundAt, recordedAt := fromNowMinutes(-40), fromNowMinutes(-30)
	id := addTodayAbnormal(t, a, foundAt, recordedAt, "")
	newFound := minuteISO(fromNowMinutes(-45))

	var got napAbnormalView
	decode(t, call(t, h, teacher, "POST", abnormalCorrectPath(id),
		`{"found_at":"`+newFound+`","situation":"寝返りでうつ伏せになっていた","response":"仰向けに直した","reason":"  発見した時刻を見直した  "}`), &got)
	if got.FoundAt != newFound || got.Situation != "寝返りでうつ伏せになっていた" || got.Response != "仰向けに直した" {
		t.Fatalf("書き換えた値が返っていません: %+v", got)
	}
	if got.CorrectedAt == nil || *got.CorrectedAt == "" || !got.CanCorrect {
		t.Fatalf("corrected_at と can_correct が入っていません: %+v", got)
	}
	// 保存時刻・記録した職員は変えない
	if got.RecordedAt != recordedAt || got.StaffID != "S004" || got.ChildID != "C001" || got.ChildName != "西田 太郎" {
		t.Fatalf("変えない項目が変わっています: %+v", got)
	}
	if !abnormalCorrectedAt(t, a, id).Valid {
		t.Fatal("行の corrected_at が入っていません")
	}

	logs := napAbnormalCorrectLogs(t, a)
	if len(logs) != 1 {
		t.Fatalf("修正の操作ログが %d 件、want 1", len(logs))
	}
	l := logs[0]
	// とった対応は同じ値を送ったので入れない。理由は前後の空白を除く
	if l.accountID != accTeacher || l.targetID != id || l.child != "C001" ||
		l.before != `{"発見時刻":"`+foundAt+`","状況":"寝返りでうつ伏せ"}` ||
		l.after != `{"発見時刻":"`+newFound+`","状況":"寝返りでうつ伏せになっていた","理由":"発見した時刻を見直した"}` {
		t.Fatalf("操作ログ = %+v", l)
	}
	// 午睡チェックの記録の修正の操作ログには入れない
	if n := len(napCorrectLogs(t, a)); n != 0 {
		t.Fatalf("午睡チェックの記録の修正の操作ログが %d 件", n)
	}
}

// 理由は必須（1〜500文字）。値の誤り・発見時刻の未来と保存時刻より後・変わらない修正・無い記録も断り、行も操作ログも変えない
func TestCorrectNapAbnormalRejectsBadInput(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	recordedAt := fromNowMinutes(-30)
	plain := addTodayAbnormal(t, a, fromNowMinutes(-40), recordedAt, "")
	// 保護者へ電話した記録（発見 -40 分、連絡 -36 分、保存 -30 分）
	noticedAt := fromNowMinutes(-36)
	noticed := addTodayAbnormal(t, a, fromNowMinutes(-40), recordedAt, noticedAt)
	path := abnormalCorrectPath(plain)
	cases := []struct {
		name, path, body string
		status           int
		message          string
	}{
		{"理由が無い", path, `{"situation":"x"}`, http.StatusBadRequest, msgNapCorrectReason},
		{"理由が空白だけ", path, `{"situation":"x","reason":"　 "}`, http.StatusBadRequest, msgNapCorrectReason},
		{"理由が501文字", path, `{"situation":"x","reason":"` + strings.Repeat("あ", 501) + `"}`, http.StatusBadRequest, msgNapCorrectReasonLong},
		{"状況が空", path, `{"situation":"  ","reason":"x"}`, http.StatusBadRequest, "発見時の状況を入力してください"},
		{"対応が空", path, `{"response":"","reason":"x"}`, http.StatusBadRequest, "とった対応を入力してください"},
		{"状況が1001文字", path, `{"situation":"` + strings.Repeat("あ", 1001) + `","reason":"x"}`, http.StatusBadRequest,
			"発見時の状況と、とった対応は、それぞれ1,000文字以内で入力してください"},
		{"発見時刻の形式", path, `{"found_at":"2026/10/22 13:00","reason":"x"}`, http.StatusBadRequest, "発見時刻の形式が正しくありません"},
		{"発見時刻が未来", path, `{"found_at":"` + minuteISO(fromNowMinutes(5)) + `","reason":"x"}`, http.StatusBadRequest,
			"発見時刻に未来の日時は指定できません"},
		{"発見時刻が保存時刻より後", path, `{"found_at":"` + minuteISO(fromNowMinutes(-20)) + `","reason":"x"}`, http.StatusBadRequest,
			msgNapAbnormalCorrectAfterRec},
		{"発見時刻が保護者へ連絡した日時より後", abnormalCorrectPath(noticed), `{"found_at":"` + minuteISO(plusMinutes(noticedAt, 3)) + `","reason":"x"}`,
			http.StatusBadRequest, msgNapAbnormalCorrectNotice},
		{"変わらない", path, `{"situation":"寝返りでうつ伏せ","response":"仰向けに直した","reason":"x"}`, http.StatusBadRequest, msgNapCorrectNoChange},
		{"直す項目が無い", path, `{"reason":"x"}`, http.StatusBadRequest, msgNapCorrectNoChange},
		{"無い記録", abnormalCorrectPath(999999), `{"situation":"x","reason":"x"}`, http.StatusNotFound, msgNapAbnormalCorrectNotFound},
		{"記録の指定が数でない", "/api/nap/abnormals/abc/correct", `{"situation":"x","reason":"x"}`, http.StatusBadRequest, msgNapAbnormalCorrectTarget},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			expectAbnormalCorrectError(t, h, admin, c.path, c.body, c.status, c.message)
		})
	}
	if logs := napAbnormalCorrectLogs(t, a); len(logs) != 0 || abnormalCorrectedAt(t, a, plain).Valid || abnormalCorrectedAt(t, a, noticed).Valid {
		t.Fatalf("断った修正が残っています: %+v", logs)
	}

	// 500文字ちょうどの理由と、保存時刻と同じ分の発見時刻は受け付ける。連絡した日時と同じ分も受け付ける
	call(t, h, admin, "POST", path, `{"found_at":"`+minuteISO(recordedAt)+`","reason":"`+strings.Repeat("あ", 500)+`"}`)
	call(t, h, admin, "POST", abnormalCorrectPath(noticed), `{"found_at":"`+minuteISO(noticedAt)+`","reason":"連絡の直前に見つけた"}`)
	if logs := napAbnormalCorrectLogs(t, a); len(logs) != 2 {
		t.Fatalf("受け付けた修正の操作ログが %d 件、want 2", len(logs))
	}
}

// 直せる人：一般はその園児のクラスの担任が実施の日のうちだけ。翌日以降は管理者だけ。異常時の記録があることでは断らない
func TestCorrectNapAbnormalWhoCanCorrect(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	other := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	todayID := addTodayAbnormal(t, a, fromNowMinutes(-40), fromNowMinutes(-30), "")
	body := `{"response":"仰向けに直し、5分後にも確かめた","reason":"書き足した"}`

	expectAbnormalCorrectError(t, h, guardian, abnormalCorrectPath(todayID), body, http.StatusForbidden, "職員のみが行えます")
	expectAbnormalCorrectError(t, h, other, abnormalCorrectPath(todayID), body, http.StatusForbidden, msgNapCorrectForbidden) // ほかのクラスの担任
	expectAbnormalCorrectError(t, h, teacher, abnormalCorrectPath(2), body, http.StatusForbidden, msgNapCorrectPastDay)       // 昨日の記録
	expectAbnormalCorrectError(t, h, teacher, abnormalCorrectPath(1), body, http.StatusForbidden, msgNapCorrectPastDay)       // 2日前の記録
	if logs := napAbnormalCorrectLogs(t, a); len(logs) != 0 {
		t.Fatalf("断った修正が残っています: %+v", logs)
	}

	// フリーの職員（今年度の担任クラスが無い一般）は読めるが直せない
	if _, err := a.db.Exec(`DELETE FROM t_class_staff WHERE staff_id = 'S005'`); err != nil {
		t.Fatal(err)
	}
	expectAbnormalCorrectError(t, h, other, abnormalCorrectPath(todayID), body, http.StatusForbidden, msgNapCorrectForbidden)

	// 管理者は翌日以降も直せる（ヒヤリハットを起票した記録も）。担任は、その日のうちなら直せる（記録した職員でなくてもよい）
	call(t, h, admin, "POST", abnormalCorrectPath(2), body)
	call(t, h, admin, "POST", abnormalCorrectPath(1), body)
	call(t, h, teacher, "POST", abnormalCorrectPath(todayID), body)
	logs := napAbnormalCorrectLogs(t, a)
	if len(logs) != 3 || logs[0].accountID != accAdmin || logs[0].targetID != 2 || logs[0].child != "C005" ||
		logs[1].targetID != 1 || logs[2].accountID != accTeacher || logs[2].targetID != todayID {
		t.Fatalf("修正の操作ログ = %+v", logs)
	}
}

// 異常時の記録の一覧に、修正あり（corrected_at）と、その利用者が直せるか（can_correct）を返す
func TestNapAbnormalsShowCorrectedAndCanCorrect(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	todayID := addTodayAbnormal(t, a, fromNowMinutes(-40), fromNowMinutes(-30), "")
	call(t, h, teacher, "POST", abnormalCorrectPath(todayID), `{"situation":"寝返りでうつ伏せになっていた","reason":"書き足した"}`)

	list := func(c *http.Cookie) map[int64]napAbnormalView {
		var rows []napAbnormalView
		decode(t, call(t, h, c, "GET", "/api/nap/abnormals", ""), &rows)
		out := map[int64]napAbnormalView{}
		for _, r := range rows {
			out[r.NapAbnormalID] = r
		}
		return out
	}
	rows := list(teacher)
	if r := rows[todayID]; r.CorrectedAt == nil || !r.CanCorrect || r.Situation != "寝返りでうつ伏せになっていた" {
		t.Fatalf("直した今日の記録に修正ありと修正が出ていません: %+v", r)
	}
	for _, id := range []int64{1, 2} {
		if r, ok := rows[id]; !ok || r.CorrectedAt != nil || r.CanCorrect {
			t.Fatalf("前の日の記録を、担任が直せることになっています: %+v", r)
		}
	}
	for id, r := range list(admin) {
		if !r.CanCorrect {
			t.Fatalf("管理者が直せない記録があります: %d %+v", id, r)
		}
	}
}

// 帳票：修正した異常時の記録に「修正あり」の印を付け、末尾の「修正の履歴」に午睡チェックの記録の修正と一緒に1回1行で出す
func TestNapReportShowsAbnormalCorrections(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	today, yesterday, twoDaysAgo := demoNapDates(t, a)
	q := "?from=" + twoDaysAgo + "&to=" + today

	// 修正の前は、異常時の記録の「修正あり」は空で、履歴の表も出さない
	f := napReportOf(t, h, admin, q)
	for _, r := range f.abnormals {
		if len(r) != len(napReportAbnormalHeader) || r[6] != "" {
			t.Fatalf("直していない異常時の記録の行が正しくありません: %v", r)
		}
	}
	if f.hasHistory {
		t.Fatal("修正が無いのに修正の履歴が出ています")
	}

	// 記録 2（久保田 陸、未起票）の発見時刻と状況、記録 1（鈴木 健、起票済み）のとった対応、今日の午睡チェックの記録 1 を直す
	call(t, h, admin, "POST", abnormalCorrectPath(2),
		`{"found_at":"`+yesterday+`T14:05:00","situation":"顔色が紅潮していた。体温37.4度。","reason":"時刻を見直した"}`)
	call(t, h, admin, "POST", abnormalCorrectPath(1), `{"response":"仰向けに直した。","reason":"書き足した"}`)
	call(t, h, teacher, "POST", correctPath(1), `{"body_position":"2","reason":"押し間違い"}`)

	f = napReportOf(t, h, admin, q)
	if len(f.abnormals) != 2 {
		t.Fatalf("異常時の記録が2行ではありません: %v", f.abnormals)
	}
	// 起票済みの記録は、ヒヤリハット側の文のまま「修正あり」を付ける
	if r := f.abnormals[0]; r[1] != "鈴木 健" || r[2] != "午睡中にうつ伏せの体位を確認した。" || r[5] != "起票済み" || r[6] != "修正あり" {
		t.Fatalf("起票済みの直した記録の行 = %v", r)
	}
	// 未起票の記録は、直したあとの発見時刻と状況で出す
	if r := f.abnormals[1]; r[0] != yesterday+"T14:05:00" || r[1] != "久保田 陸" || r[2] != "顔色が紅潮していた。体温37.4度。" ||
		r[5] != "未起票" || r[6] != "修正あり" {
		t.Fatalf("未起票の直した記録の行 = %v", r)
	}

	// 修正の履歴：一覧と同じ向き（実施の日の古い順）で、異常時の記録と午睡チェックの記録を1つの表に並べる
	if !f.hasHistory || len(f.histories) != 3 {
		t.Fatalf("修正の履歴が3行ではありません: %v", f.histories)
	}
	if h0 := f.histories[0]; h0[0] != "異常時の記録（鈴木 健・"+twoDaysAgo+"T13:40:00）" || h0[2] != "西田 拓也" ||
		h0[3] != "とった対応=仰向けに直し、5分後に再度確認した。保護者へは降園時に口頭で伝えた。" || h0[4] != "とった対応=仰向けに直した。" ||
		h0[5] != "書き足した" {
		t.Fatalf("修正の履歴の1行目 = %v", h0)
	}
	if h1 := f.histories[1]; h1[0] != "異常時の記録（久保田 陸・"+yesterday+"T14:05:00）" ||
		h1[3] != "発見時刻="+yesterday+"T14:10:00、状況=顔色がやや紅潮していた。体温37.4度。" ||
		h1[4] != "発見時刻="+yesterday+"T14:05:00、状況=顔色が紅潮していた。体温37.4度。" || h1[5] != "時刻を見直した" {
		t.Fatalf("修正の履歴の2行目 = %v", h1)
	}
	if h2 := f.histories[2]; h2[0] != "午睡チェックの記録（西田 太郎・"+today+"T13:20:00）" || h2[2] != "鈴木 浩之" || h2[3] != "体位=仰向け" {
		t.Fatalf("修正の履歴の3行目 = %v", h2)
	}

	// クラスの外の修正は出さない（ひまわり組だけ）
	if g := napReportOf(t, h, admin, q+"&class_id=2"); g.hasHistory || len(g.abnormals) != 0 {
		t.Fatalf("ほかのクラスの修正が出ています: %v %v", g.abnormals, g.histories)
	}
}

// 以前に作られたデータベースにも t_nap_abnormal.corrected_at を足す。何度呼んでも同じ
func TestEnsureNapAbnormalCorrectedAt(t *testing.T) {
	a, _ := newTestApp(t)
	if _, err := a.db.Exec(`ALTER TABLE t_nap_abnormal DROP COLUMN corrected_at`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := ensureNapAbnormalCorrectedAt(a.db); err != nil {
			t.Fatal(err)
		}
	}
	if v := abnormalCorrectedAt(t, a, 1); v.Valid {
		t.Fatalf("足したばかりの corrected_at が空ではありません: %v", v)
	}
}
