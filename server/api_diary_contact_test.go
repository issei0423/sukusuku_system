package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// diaryIDFrom は、日誌を保存した応答から日誌の ID を取り出す
func diaryIDFrom(t *testing.T, rec *httptest.ResponseRecorder) int64 {
	t.Helper()
	var d struct {
		DiaryID int64 `json:"diary_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil || d.DiaryID == 0 {
		t.Fatalf("日誌の ID を読めません: %s", rec.Body.String())
	}
	return d.DiaryID
}

func urlQuery(v string) string { return url.QueryEscape(v) }

/*
 * 日誌ときょうのようす（連絡帳）のつながり（GitHub Issue #278 の 2・4）
 * 典拠：基本設計書「きょうのようすから個人日誌の下書きへ」(4-6)・「取り消し・訂正」(4-5)、
 *      詳細設計書「日誌の画面（作り直し）」(2-13 (4)(5))・「日誌」(4-13 (6)(7)(8))
 * web/tests/diaryContact.test.ts と同じ規則
 */

// addMeal は、さくら組の園児 C004 の食事の記録を直接入れる（時刻を決めるため）
func addMeal(t *testing.T, a *app, date, at, kind, amount string, deleted bool, corrected any, updated string) {
	t.Helper()
	if _, err := a.db.Exec(`INSERT INTO t_contact_event
		(child_id, class_id, contact_date, event_type, recorded_at, meal_kind, meal_amount, staff_id,
		 corrected_at, is_deleted, created_at, updated_at)
		VALUES ('C004', 1, ?, '1', ?, ?, ?, 'S003', ?, ?, ?, ?)`,
		date, at, kind, amount, corrected, deleted, at, updated); err != nil {
		t.Fatal(err)
	}
}

// addNap は、C004 のねた・おきたの記録を直接入れる。woke が空ならおきたは未記録
func addNap(t *testing.T, a *app, date, slept, woke string, deleted bool, corrected any, updated string) {
	t.Helper()
	res, err := a.db.Exec(`INSERT INTO t_nap_session (class_id, session_date, started_staff_id, started_at) VALUES (1, ?, 'S003', ?)`, date, slept)
	if err != nil {
		t.Fatal(err)
	}
	sid, _ := res.LastInsertId()
	var wokeAt any
	if woke != "" {
		wokeAt = woke
	}
	if _, err := a.db.Exec(`INSERT INTO t_nap_sleep
		(nap_session_id, child_id, slept_at, woke_at, slept_staff_id, corrected_at, is_deleted, created_at, updated_at)
		VALUES (?, 'C004', ?, ?, 'S003', ?, ?, ?, ?)`, sid, slept, wokeAt, corrected, deleted, slept, updated); err != nil {
		t.Fatal(err)
	}
}

func TestDiaryLinesFromContact(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	const day = "2026-01-05"
	// 食事：給食（少し）・おやつ（ぜんぶ）・取り消したおやつ。午睡：おきたあり・おきたなし
	addMeal(t, a, day, day+"T11:40:00", "1", "3", false, nil, day+"T11:40:00")
	addMeal(t, a, day, day+"T15:10:00", "2", "1", false, nil, day+"T15:10:00")
	addMeal(t, a, day, day+"T15:20:00", "2", "4", true, nil, day+"T15:30:00")
	addNap(t, a, day, day+"T13:05:00", day+"T14:40:00", false, nil, day+"T14:40:00")
	addNap(t, a, day, day+"T16:00:00", "", false, nil, day+"T16:00:00")
	// 保護者へ出さない設定の食事も入る（日誌は園内の記録）
	a.db.Exec(`UPDATE m_setting SET setting_value = 'nap,toilet,temperature,comment,photo,class' WHERE setting_key = 'contact.show_items'`)

	body := expectStatus(t, request(t, h, teacher, "GET", "/api/contact/children/C004/diary-lines?date="+day, ""), http.StatusOK)
	var got struct {
		Lines []string `json:"lines"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"11:40 給食 少し",
		"13:05〜14:40 午睡（1時間35分）",
		"15:10 おやつ ぜんぶ",
		"16:00 午睡（おきたは記録されていません）",
	}
	if strings.Join(got.Lines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("行が違います:\n%v\n期待:\n%v", got.Lines, want)
	}

	// 記録の無い日は空の並び。日付の形が崩れた・未来は 400
	body = expectStatus(t, request(t, h, teacher, "GET", "/api/contact/children/C004/diary-lines?date=2026-01-06", ""), http.StatusOK)
	if !strings.Contains(body, `"lines":[]`) {
		t.Fatalf("記録の無い日が空になりません: %s", body)
	}
	for _, q := range []string{"date=2026-1-5", "date=" + addDays(today(), 1)} {
		body = expectStatus(t, request(t, h, teacher, "GET", "/api/contact/children/C004/diary-lines?"+q, ""), http.StatusBadRequest)
		if !strings.Contains(body, "日付の形式が正しくありません。") {
			t.Fatalf("%s の文言が違います: %s", q, body)
		}
	}
}

func TestDiaryLinesNeedAccess(t *testing.T) {
	a, h := newTestApp(t)
	// 保護者は日誌の経路を使えない（403）。担任でない一般は他クラスの園児の行を読めない
	guardian := loginAs(a, 6, "guardian")
	expectStatus(t, request(t, h, guardian, "GET", "/api/contact/children/C004/diary-lines", ""), http.StatusForbidden)
	teacher := loginAs(a, 3, "staff") // さくら組。もも組の園児は読めない
	var other string
	a.db.QueryRow(`SELECT child_id FROM t_class_child WHERE class_id <> 1 LIMIT 1`).Scan(&other)
	body := expectStatus(t, request(t, h, teacher, "GET", "/api/contact/children/"+other+"/diary-lines", ""), http.StatusForbidden)
	if !strings.Contains(body, "この園児の連絡帳は開けません。") {
		t.Fatalf("文言が違います: %s", body)
	}
}

// 共有する個人日誌の注意のために、保護者の連絡帳に出していない項目の名前を返す（照合 c2b-2 の推し。【仮置き】web/仮置き値.md）。
// きょうのようすから入れる行の hidden_items と、日誌を1件読んだときの、本文に入っている行の hidden_contact_items。
// 判定して本文を変えることはしない。モックは web/tests/diaryContact.test.ts
func TestDiaryHiddenContactItems(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	day := today()
	addMeal(t, a, day, day+"T11:40:00", "1", "3", false, nil, day+"T11:40:00")
	addNap(t, a, day, day+"T13:05:00", day+"T14:40:00", false, nil, day+"T14:40:00")
	hiddenLines := func() []string {
		t.Helper()
		var got struct {
			Hidden []string `json:"hidden_items"`
		}
		decode(t, call(t, h, teacher, "GET", "/api/contact/children/C004/diary-lines?date="+day, ""), &got)
		return got.Hidden
	}
	hiddenOfDiary := func(id int64) []string {
		t.Helper()
		var d struct {
			Hidden []string `json:"hidden_contact_items"`
		}
		decode(t, call(t, h, teacher, "GET", "/api/diaries/"+itoa(id), ""), &d)
		return d.Hidden
	}

	// 全部を保護者へ出す設定では、何も挙げない
	if got := hiddenLines(); got == nil || len(got) != 0 {
		t.Fatalf("全部出す設定で hidden_items = %v（空の並びのはず）", got)
	}
	withMeal := diaryIDFrom(t, call(t, h, teacher, "POST", "/api/diaries", personalDiary(0, "C004", "1", day, "11:40 給食 少し", "1")))
	if got := hiddenOfDiary(withMeal); len(got) != 0 {
		t.Fatalf("全部出す設定で hidden_contact_items = %v", got)
	}

	// 食事を保護者へ出さない設定にする
	if _, err := a.db.Exec(`UPDATE m_setting SET setting_value = 'nap,toilet,temperature,comment,photo,class' WHERE setting_key = 'contact.show_items'`); err != nil {
		t.Fatal(err)
	}
	if got := hiddenLines(); strings.Join(got, ",") != "食事" {
		t.Fatalf("hidden_items = %v（食事だけのはず）", got)
	}
	// 本文に食事の行が入っていれば挙げる。午睡の行だけなら挙げない
	if got := hiddenOfDiary(withMeal); strings.Join(got, ",") != "食事" {
		t.Fatalf("食事の行がある日誌の hidden_contact_items = %v", got)
	}
	napOnly := diaryIDFrom(t, call(t, h, teacher, "POST", "/api/diaries", personalDiary(0, "C004", "1", day, "13:05〜14:40 午睡（1時間35分）", "1")))
	if got := hiddenOfDiary(napOnly); len(got) != 0 {
		t.Fatalf("午睡の行だけの日誌の hidden_contact_items = %v", got)
	}
	// 本文は書き換えない
	var body string
	a.db.QueryRow(`SELECT body FROM t_diary WHERE diary_id = ?`, withMeal).Scan(&body)
	if body != "11:40 給食 少し" {
		t.Fatalf("本文が変わっています: %q", body)
	}
}

/*
本文の行は、記録ごとの変わらない頭（食事は「HH:MM 区分」、午睡は「HH:MM〜」か「HH:MM 午睡」）で照らす。
取り込んだあとに「おきた」が付いた・食事を訂正したでは注意が消えず、保育士が行を消したら消える
（照合 c5-05。【仮置き】web/仮置き値.md）。モックは web/tests/diaryContact.test.ts
*/
func TestDiaryHiddenContactItemsFollowHeads(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	day := today()
	addMeal(t, a, day, day+"T11:40:00", "1", "3", false, nil, day+"T11:40:00")
	// 午睡のあいだに日誌を書く。おきたはまだ無い
	addNap(t, a, day, day+"T13:05:00", "", false, nil, day+"T13:05:00")
	// 午睡と食事を保護者へ出さない設定
	if _, err := a.db.Exec(`UPDATE m_setting SET setting_value = 'toilet,temperature,comment,photo,class' WHERE setting_key = 'contact.show_items'`); err != nil {
		t.Fatal(err)
	}

	// 画面の「きょうのようすから入れる」と同じに、見出しの下へ入れる行を並べた本文で作る
	var got struct {
		Lines []string `json:"lines"`
	}
	decode(t, call(t, h, teacher, "GET", "/api/contact/children/C004/diary-lines?date="+day, ""), &got)
	if strings.Join(got.Lines, "\n") != "11:40 給食 少し\n13:05 午睡（おきたは記録されていません）" {
		t.Fatalf("入れる行 = %q", got.Lines)
	}
	body := "【きょうのようす（連絡帳から）】\n" + strings.Join(got.Lines, "\n")
	id := diaryIDFrom(t, call(t, h, teacher, "POST", "/api/diaries",
		personalDiary(0, "C004", "1", day, strings.ReplaceAll(body, "\n", `\n`), "1")))
	hidden := func() string {
		t.Helper()
		var d struct {
			Hidden []string `json:"hidden_contact_items"`
		}
		decode(t, call(t, h, teacher, "GET", "/api/diaries/"+itoa(id), ""), &d)
		return strings.Join(d.Hidden, ",")
	}
	if got := hidden(); got != "午睡,食事" {
		t.Fatalf("取り込んだ直後の hidden_contact_items = %q", got)
	}

	// 取り込んだあとに「おきた」が付いた（午睡の行の文は「13:05〜14:40 午睡（1時間35分）」に変わる）
	if _, err := a.db.Exec(`UPDATE t_nap_sleep SET woke_at = ? WHERE child_id = 'C004' AND slept_at = ?`, day+"T14:40:00", day+"T13:05:00"); err != nil {
		t.Fatal(err)
	}
	if got := hidden(); got != "午睡,食事" {
		t.Fatalf("おきたが付いたあとの hidden_contact_items = %q（午睡も残るはず）", got)
	}
	// 食事を訂正した（量が「少し」から「ぜんぶ」へ）
	if _, err := a.db.Exec(`UPDATE t_contact_event SET meal_amount = '1', corrected_at = ? WHERE child_id = 'C004' AND recorded_at = ?`,
		now(), day+"T11:40:00"); err != nil {
		t.Fatal(err)
	}
	if got := hidden(); got != "午睡,食事" {
		t.Fatalf("食事を訂正したあとの hidden_contact_items = %q（食事も残るはず）", got)
	}

	// 保育士が午睡の行を消した
	setBody := func(b string) {
		t.Helper()
		if _, err := a.db.Exec(`UPDATE t_diary SET body = ? WHERE diary_id = ?`, b, id); err != nil {
			t.Fatal(err)
		}
	}
	setBody("【きょうのようす（連絡帳から）】\n11:40 給食 少し")
	if got := hidden(); got != "食事" {
		t.Fatalf("午睡の行を消したあとの hidden_contact_items = %q（食事だけのはず）", got)
	}
	// 食事の行も消した
	setBody("きょうは園庭で砂遊びをしました。")
	if got := hidden(); got != "" {
		t.Fatalf("行を全部消したあとの hidden_contact_items = %q", got)
	}
}

// 取り込んだあとに連絡帳で訂正・取り消しされた記録は、日誌を作ったあとのものだけを返す
func TestDiaryContactChangesOnlyAfterCreation(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	day := today()
	later := fromNowMinutes(5)
	// 日誌を作る前に取り消した・訂正した記録は出ない
	addMeal(t, a, day, day+"T10:00:00", "2", "4", true, nil, "2000-01-01T00:00:00")
	addMeal(t, a, day, day+"T10:10:00", "2", "2", false, "2000-01-01T00:00:00", "2000-01-01T00:00:00")
	// 日誌を作ったあとに訂正された給食・取り消された午睡は出る
	addMeal(t, a, day, day+"T11:40:00", "1", "1", false, later, later)
	addNap(t, a, day, day+"T13:05:00", day+"T14:40:00", true, nil, later)
	// 別の日の記録は出ない
	addMeal(t, a, addDays(day, -1), addDays(day, -1)+"T11:40:00", "1", "1", false, later, later)

	id := diaryIDFrom(t, call(t, h, teacher, "POST", "/api/diaries", personalDiary(0, "C004", "1", day, "個人日誌", "1")))
	body := expectStatus(t, request(t, h, teacher, "GET", "/api/diaries/"+itoa(id), ""), http.StatusOK)
	var d struct {
		ContactChanges []DiaryContactChange `json:"contact_changes"`
	}
	if err := json.Unmarshal([]byte(body), &d); err != nil {
		t.Fatal(err)
	}
	if len(d.ContactChanges) != 2 {
		t.Fatalf("件数が違います: %+v", d.ContactChanges)
	}
	if c := d.ContactChanges[0]; c.Kind != "meal" || c.Change != "correct" || c.RecordedAt != day+"T11:40:00" || c.ChangedAt != later {
		t.Fatalf("給食の訂正が違います: %+v", c)
	}
	if c := d.ContactChanges[1]; c.Kind != "nap" || c.Change != "cancel" || c.RecordedAt != day+"T13:05:00" {
		t.Fatalf("午睡の取り消しが違います: %+v", c)
	}

	// 本文は自動では書き換わらない
	if !strings.Contains(body, `"body":"個人日誌"`) {
		t.Fatalf("本文が変わっています: %s", body)
	}
	// 個人日誌以外には付かない
	cid := diaryIDFrom(t, call(t, h, teacher, "POST", "/api/diaries",
		`{"record_type":"2","class_id":1,"diary_date":"`+day+`","body":"クラス日誌","status":"1"}`))
	body = expectStatus(t, request(t, h, teacher, "GET", "/api/diaries/"+itoa(cid), ""), http.StatusOK)
	if strings.Contains(body, "contact_changes") {
		t.Fatalf("クラス日誌に付いています: %s", body)
	}
}

// 日誌一覧の園児名（名前・よみ・空白を問わない）・キーワード（本文。ヒヤリハットは場所も）の絞り込み
func TestDiaryListFilterByChildAndKeyword(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	day := today()
	call(t, h, teacher, "POST", "/api/diaries", personalDiary(0, "C004", "1", day, "あおぞら公園へ行った", "1"))
	call(t, h, teacher, "POST", "/api/diaries", personalDiary(0, "C001", "1", day, "室内で製作をした", "1"))
	var name, kana string
	a.db.QueryRow(`SELECT child_name, child_name_kana FROM m_child WHERE child_id = 'C004'`).Scan(&name, &kana)
	count := func(q string) (n int, body string) {
		body = expectStatus(t, request(t, h, teacher, "GET", "/api/diaries?"+q, ""), http.StatusOK)
		var p struct {
			Total int `json:"total"`
		}
		json.Unmarshal([]byte(body), &p)
		return p.Total, body
	}
	if n, body := count("keyword=" + "あおぞら"); n != 1 || !strings.Contains(body, "あおぞら公園へ行った") {
		t.Fatalf("キーワードで絞れません: %d %s", n, body)
	}
	if n, _ := count("keyword=" + "存在しない語"); n != 0 {
		t.Fatalf("当たらないキーワードで %d 件", n)
	}
	for _, q := range []string{name, strings.ReplaceAll(strings.ReplaceAll(name, " ", ""), "　", ""), kana} {
		if q == "" {
			continue
		}
		if n, body := count("child=" + urlQuery(q)); n < 1 || strings.Contains(body, "室内で製作をした") {
			t.Fatalf("園児名「%s」で絞れません: %d %s", q, n, body)
		}
	}
}
