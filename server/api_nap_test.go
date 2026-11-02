package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestAbnormalKeepsDiscoveryAndRecordingTimesSeparately(t *testing.T) {
	a, h := newTestApp(t)
	staff := loginAs(a, 3, "staff")
	day, _ := time.Parse("2006-01-02", today())
	tomorrow := day.AddDate(0, 0, 1).Format("2006-01-02")
	// テストを走らせる時間帯によらず、実施が自動終了しないよう翌日の実施にする。
	if _, err := a.db.Exec(`UPDATE t_nap_session SET session_date = ?, started_at = ? WHERE nap_session_id = 1`, tomorrow, tomorrow+"T13:00:00"); err != nil {
		t.Fatal(err)
	}
	instant, _ := time.Parse("2006-01-02T15:04:05", now())
	found := instant.Add(-5 * time.Minute).Format("2006-01-02T15:04:05")
	r := chatReq(h, staff, "POST", "/api/nap/session/1/abnormals", `{"child_id":"C001","found_at":"`+found+`","situation":"呼吸を確認できず","response":"再確認した"}`)
	if r.Code != http.StatusOK {
		t.Fatalf("異常時の記録を保存できません: %d %s", r.Code, r.Body.String())
	}
	var got struct{ FoundAt, RecordedAt string }
	if err := a.db.QueryRow(`SELECT found_at, recorded_at FROM t_nap_abnormal ORDER BY nap_abnormal_id DESC LIMIT 1`).Scan(&got.FoundAt, &got.RecordedAt); err != nil {
		t.Fatal(err)
	}
	if got.FoundAt != found || got.RecordedAt <= found {
		t.Fatalf("発見時刻と保存時刻が別になっていません: %+v", got)
	}
}

/*
 * 午睡チェックの終了と異常時の記録（GitHub Issue #158）
 * 典拠：基本設計書.md「午睡チェック」(4-7)「午睡チェックの開始・参照・記録は、一般（保育士）は自クラスに限る」・
 *      「終了した実施へは記録できない」、「権限と利用可能機能」(6-1)「異常時の記録　一般 ※1」、
 *      「入力項目の制約値」(4-9)「未来日は認めない」
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、
 * web/tests/napScope.test.ts と同じ観点で確かめる。
 */

// startOwnNap はさくら組の当日の実施を返す。実施中のものがあればそれを、無ければ開始する
func startOwnNap(t *testing.T, h http.Handler, teacher *http.Cookie) NapSession {
	t.Helper()
	var s NapSession
	if err := json.Unmarshal(call(t, h, teacher, "POST", "/api/nap/session", `{"class_id":1}`).Body.Bytes(), &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestEndNapSessionRequiresOwnClass(t *testing.T) {
	a, h := newTestApp(t)
	suzuki := loginAs(a, 3, "staff") // さくら組
	kubota := loginAs(a, 5, "staff") // ひまわり組
	admin := loginAs(a, 1, "staff")
	s := startOwnNap(t, h, suzuki)
	path := "/api/nap/session/" + itoa(s.NapSessionID) + "/end"

	endedOf := func() (sql.NullString, sql.NullString) {
		var staff, at sql.NullString
		a.db.QueryRow(`SELECT ended_staff_id, ended_at FROM t_nap_session WHERE nap_session_id = ?`,
			s.NapSessionID).Scan(&staff, &at)
		return staff, at
	}

	t.Run("ほかのクラスの職員は終了できず、実施中のまま残る", func(t *testing.T) {
		expectStatus(t, request(t, h, kubota, "POST", path, ""), http.StatusForbidden)
		if staff, at := endedOf(); staff.Valid || at.Valid {
			t.Fatalf("終了されています: %v %v", staff, at)
		}
	})

	t.Run("無い実施は終了できず、操作ログも残らない", func(t *testing.T) {
		expectStatus(t, request(t, h, kubota, "POST", "/api/nap/session/99999/end", ""), http.StatusNotFound)
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE target_table = 't_nap_session' AND target_id = 99999`).Scan(&n)
		if n != 0 {
			t.Fatalf("無い実施の終了が操作ログに %d 件残っています", n)
		}
	})

	t.Run("担任は終了でき、終了した実施をもう一度終了しても終了時刻・終了した職員を書き換えない", func(t *testing.T) {
		call(t, h, suzuki, "POST", path, "")
		staff, at := endedOf()
		if staff.String != "S003" || !at.Valid {
			t.Fatalf("終了の記録が正しくありません: %v %v", staff, at)
		}
		for _, c := range []*http.Cookie{suzuki, admin} {
			expectStatus(t, request(t, h, c, "POST", path, ""), http.StatusConflict)
		}
		if staff2, at2 := endedOf(); staff2 != staff || at2 != at {
			t.Fatalf("終了の記録が書き換わっています: %v %v", staff2, at2)
		}
	})
}

// 異常時の記録は、その園児のクラスの、実施中の午睡チェックにつなぐ
func TestNapAbnormalFollowsChildClass(t *testing.T) {
	a, h := newTestApp(t)
	suzuki := loginAs(a, 3, "staff") // さくら組
	kubota := loginAs(a, 5, "staff") // ひまわり組
	admin := loginAs(a, 1, "staff")
	s := startOwnNap(t, h, suzuki)
	path := "/api/nap/session/" + itoa(s.NapSessionID) + "/abnormals"
	body := func(childID, foundAt string) string {
		return `{"child_id":"` + childID + `","found_at":"` + foundAt + `","situation":"顔色がやや紅潮","response":"別室で休ませた"}`
	}
	count := func() int {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_abnormal`).Scan(&n)
		return n
	}
	before := count()
	valid := today() + "T00:00:00"

	t.Run("ほかのクラスの職員は、そのクラスの実施へ記録できない", func(t *testing.T) {
		expectStatus(t, request(t, h, kubota, "POST", path, body("C013", valid)), http.StatusForbidden)
		expectStatus(t, request(t, h, kubota, "POST", path, body("C001", valid)), http.StatusForbidden)
	})

	t.Run("園児のクラスと違う実施へは、管理者でも記録できない", func(t *testing.T) {
		expectStatus(t, request(t, h, admin, "POST", path, body("C013", valid)), http.StatusBadRequest)
	})

	t.Run("終了した実施・無い実施へは記録できない", func(t *testing.T) {
		expectStatus(t, request(t, h, suzuki, "POST", "/api/nap/session/2/abnormals", body("C001", valid)), http.StatusConflict)
		expectStatus(t, request(t, h, suzuki, "POST", "/api/nap/session/99999/abnormals", body("C001", valid)), http.StatusNotFound)
	})

	t.Run("発見時刻は、未来の日時と形の崩れた値を断る", func(t *testing.T) {
		for _, v := range []string{"2999-01-01T10:00:00", addDays(today(), 1) + "T00:00:00", "abc", "2026-10-1T10:00:00", today()} {
			expectStatus(t, request(t, h, suzuki, "POST", path, body("C001", v)), http.StatusBadRequest)
		}
	})

	if n := count(); n != before {
		t.Fatalf("断ったはずの記録が %d 件できています", n-before)
	}

	t.Run("自クラスの実施中の実施へは記録できる。発見時刻を空にすると今の時刻を入れる", func(t *testing.T) {
		call(t, h, suzuki, "POST", path, body("C001", valid))
		call(t, h, suzuki, "POST", path, body("C002", ""))
		call(t, h, admin, "POST", path, body("C003", valid))
		if n := count(); n != before+3 {
			t.Fatalf("記録 = %d 件, want %d", n-before, 3)
		}
	})
}

// ほかのクラスの異常時の記録から、ヒヤリハットを起票させない。中身も返さない
func TestRaiseIncidentRequiresChildScope(t *testing.T) {
	a, h := newTestApp(t)
	suzuki := loginAs(a, 3, "staff")
	kubota := loginAs(a, 5, "staff")
	const path = "/api/nap/abnormals/2/incident" // 2 はさくら組・久保田 陸（C005）の記録。未起票

	rec := request(t, h, kubota, "POST", path, "")
	body := expectStatus(t, rec, http.StatusForbidden)
	if strings.Contains(body, "体温37.4度") {
		t.Fatalf("記録の中身が返っています: %s", body)
	}
	var diaryID sql.NullInt64
	a.db.QueryRow(`SELECT diary_id FROM t_nap_abnormal WHERE nap_abnormal_id = 2`).Scan(&diaryID)
	if diaryID.Valid {
		t.Fatalf("起票されています（diary_id=%d）", diaryID.Int64)
	}

	var d Diary
	if err := json.Unmarshal(call(t, h, suzuki, "POST", path, "").Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.CreatedStaffID != "S003" || d.RecordType != "4" {
		t.Fatalf("起票した日誌が正しくありません: %+v", d)
	}
}

// 検査を入れる前に入ってしまった崩れた発見時刻でも、起票でサーバの処理が落ちない
func TestRaiseIncidentWithBrokenFoundAt(t *testing.T) {
	a, h := newTestApp(t)
	suzuki := loginAs(a, 3, "staff")
	res, err := a.db.Exec(`INSERT INTO t_nap_abnormal (nap_session_id, child_id, found_at, situation, response, staff_id)
		VALUES (2, 'C001', 'abc', '状況', '対応', 'S003')`)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()

	var d Diary
	if err := json.Unmarshal(call(t, h, suzuki, "POST", "/api/nap/abnormals/"+itoa(id)+"/incident", "").Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	// 記録日は、その実施の日にする
	var sessionDate string
	a.db.QueryRow(`SELECT session_date FROM t_nap_session WHERE nap_session_id = 2`).Scan(&sessionDate)
	if d.DiaryDate != sessionDate {
		t.Fatalf("diary_date = %q, want %q", d.DiaryDate, sessionDate)
	}
}

/*
 * 午睡の記録の体温の桁と、記録する実施のクラス（GitHub Issue #165 の 4）
 * 典拠：基本設計書.md「入力項目の制約値」(4-9)「体温　30.0〜43.0℃、小数第1位まで」「範囲外でも入力を妨げず、確認を促すだけ」、
 *      図/画面詳細図.md「午睡チェック画面」(5-1) 項目12
 */
func TestNapRecordTemperatureOneDecimal(t *testing.T) {
	a, h := newTestApp(t)
	suzuki := loginAs(a, 3, "staff")
	s := startOwnNap(t, h, suzuki)
	path := "/api/nap/session/" + itoa(s.NapSessionID) + "/records"
	body := func(temperature string) string {
		return `{"child_id":"C006","body_position":"1","breathing":"1","complexion":"1","temperature":` + temperature + `}`
	}
	count := func() int {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_record WHERE nap_session_id = ? AND child_id = 'C006'`, s.NapSessionID).Scan(&n)
		return n
	}
	before := count()

	t.Run("小数第2位までの体温は断る", func(t *testing.T) {
		for _, v := range []string{"36.55", "36.05", "37.123"} {
			got := expectStatus(t, request(t, h, suzuki, "POST", path, body(v)), http.StatusBadRequest)
			if !strings.Contains(got, "小数第1位") {
				t.Fatalf("%s: 桁の誤りとして断っていません: %s", v, got)
			}
		}
		if n := count(); n != before {
			t.Fatalf("断ったはずの記録が %d 件できています", n-before)
		}
	})

	t.Run("小数第1位までの体温・範囲の外の体温・体温なしは記録できる（範囲の外は確かめるだけで妨げない）", func(t *testing.T) {
		for _, v := range []string{"36.5", "37", "25.0", "null"} {
			call(t, h, suzuki, "POST", path, body(v))
		}
		var got float64
		a.db.QueryRow(`SELECT temperature FROM t_nap_record WHERE nap_session_id = ? AND child_id = 'C006'
			AND temperature IS NOT NULL ORDER BY nap_record_id LIMIT 1`, s.NapSessionID).Scan(&got)
		if got != 36.5 {
			t.Fatalf("temperature = %v, want 36.5", got)
		}
	})
}

// 午睡の記録は、その園児のクラスの実施に付ける。管理者でも、ほかのクラスの園児を付けさせない（異常時の記録と同じ。GitHub Issue #158）
func TestNapRecordFollowsChildClass(t *testing.T) {
	a, h := newTestApp(t)
	suzuki := loginAs(a, 3, "staff")
	admin := loginAs(a, 1, "staff")
	s := startOwnNap(t, h, suzuki)
	path := "/api/nap/session/" + itoa(s.NapSessionID) + "/records"
	body := `{"child_id":"C013","body_position":"1","breathing":"1","complexion":"1","temperature":null}` // C013 はひまわり組

	expectStatus(t, request(t, h, admin, "POST", path, body), http.StatusBadRequest)
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_record WHERE nap_session_id = ? AND child_id = 'C013'`, s.NapSessionID).Scan(&n)
	if n != 0 {
		t.Fatalf("ほかのクラスの園児の記録が %d 件付いています", n)
	}
}

/*
GET /api/nap/session の ended=1 は、その日に最後に終えた実施を返す。午睡チェック画面が、終えたあとも園児の行を
状態の表示だけで出すため（詳細設計書「行の状態ごとの表示」(2-4 (2)) の「実施の後」。受け入れテスト 04-021）。
参照の範囲は実施中のものと同じ（一般は自クラスに限る）。ended を付けないときは今までどおり実施中のものだけ。
【仮置き】設計に無い口（web/仮置き値.md）。モックの同じ観点は web/tests/napCheckRows.test.tsx の lastEndedSession
*/
func TestLastEndedNapSession(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	// 実施が無いときの応答は、本文の無い 200（writeJSON の nil。画面は null として読む）
	session := func(c *http.Cookie, path string) *NapSession {
		t.Helper()
		rec := call(t, h, c, "GET", path, "")
		if strings.TrimSpace(rec.Body.String()) == "" {
			return nil
		}
		var s *NapSession
		decode(t, rec, &s)
		return s
	}
	ended := func(c *http.Cookie, date string) *NapSession {
		t.Helper()
		return session(c, "/api/nap/session?class_id=1&date="+date+"&ended=1")
	}
	active := func() *NapSession {
		t.Helper()
		return session(teacher, "/api/nap/session?class_id=1")
	}

	// デモの実施を終えて、新しく開始する（startFreshNap）。終えた実施はデモの実施、実施中は新しいもの
	s := startFreshNap(t, a, h, teacher)
	if got := ended(teacher, today()); got == nil || got.NapSessionID == s.NapSessionID || got.EndedAt == nil {
		t.Fatalf("終えた実施（デモ） = %+v、実施中は %d", got, s.NapSessionID)
	}
	if got := active(); got == nil || got.NapSessionID != s.NapSessionID {
		t.Fatalf("ended を付けないときは実施中のもの: %+v", got)
	}

	// 新しい実施を終えると、終えた時刻が同じ秒でも、後に作ったほうを返す。実施中のものは無くなる
	call(t, h, teacher, "POST", "/api/nap/session/"+itoa(s.NapSessionID)+"/end", "")
	if got := ended(teacher, today()); got == nil || got.NapSessionID != s.NapSessionID || got.EndedStaffID == nil || *got.EndedStaffID != "S003" {
		t.Fatalf("最後に終えた実施 = %+v, want %d", got, s.NapSessionID)
	}
	if got := active(); got != nil {
		t.Fatalf("終えたあとの実施中 = %+v, want null", got)
	}

	// 終えた実施の無い日は null。ほかのクラスの担任は読めない
	if got := ended(teacher, addDays(today(), 1)); got != nil {
		t.Fatalf("終えた実施の無い日 = %+v, want null", got)
	}
	expectStatus(t, request(t, h, otherTeacher, "GET", "/api/nap/session?class_id=1&ended=1", ""), http.StatusForbidden)
}
