package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * 保護者に見せる範囲（GitHub Issue #157）
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1)・「権限チェックの実装方針」(6-2)「画面を経由せず直接リクエストを
 *      送っても拒否されること」、「日誌システム（園内の記録）」(4-6)、詳細設計書.md「日誌」(4-13)
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、
 * web/tests/guardianScope.test.ts と同じ観点で確かめる。
 */

// 日誌は園内の記録で、保護者へ返す経路を持たない。一覧・1件・添付・園児の日誌・タイムライン・取り下げのどれも 403。
// 承認済みの自児の個人日誌（以前の版で保護者へ共有した日誌 5）も、他児の日誌も、無い日誌も同じ文言にする
// （詳細設計書「日誌」(4-13)「保護者が呼んだら 403『この日誌を参照する権限がありません』」・(10)）
func TestGuardianCannotUseDiaryRoutes(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, 6, "guardian") // 野原 太郎（C001）の保護者。日誌 1 は C001 の下書き、日誌 5 は C001 の承認済み
	teacher := loginAs(a, 3, "staff")     // さくら組
	kinjo := loginAs(a, 5, "staff")       // ひまわり組

	for _, path := range []string{"/api/children/C001/diaries", "/api/children/C001/timeline"} {
		body := expectStatus(t, request(t, h, guardian, "GET", path, ""), http.StatusForbidden)
		if strings.Contains(body, "積み木") {
			t.Fatalf("%s: 下書きの本文が返っています: %s", path, body)
		}
		expectStatus(t, request(t, h, kinjo, "GET", path, ""), http.StatusForbidden)

		var got []Diary
		if err := json.Unmarshal(call(t, h, teacher, "GET", path, "").Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if len(got) == 0 {
			t.Fatalf("%s: 担任に過去の記録が返っていません", path)
		}
	}

	for _, path := range []string{
		"/api/diaries", "/api/diaries?status=3",
		"/api/diaries/5", "/api/diaries/1", "/api/diaries/4", "/api/diaries/99999",
		"/api/diaries/5/attachments", "/api/diaries/4/attachments",
		"/api/children/C001/diaries", "/api/children/C001/timeline",
	} {
		var e apiError
		if err := json.Unmarshal([]byte(expectStatus(t, request(t, h, guardian, "GET", path, ""), http.StatusForbidden)), &e); err != nil {
			t.Fatal(err)
		}
		if e.Message != "この日誌を参照する権限がありません" {
			t.Fatalf("%s: message = %q", path, e.Message)
		}
	}
	// 取り下げも保護者には通さない
	expectStatus(t, request(t, h, guardian, "POST", "/api/diaries/2/withdraw", `{"updated_at":""}`), http.StatusForbidden)
	// 職員にはこれまでどおり（参照範囲の外は同じ文言で 403）
	expectStatus(t, request(t, h, kinjo, "GET", "/api/diaries/1", ""), http.StatusForbidden)
	call(t, h, teacher, "GET", "/api/diaries/5", "")
}

// 承認しても保護者へは何も届かない。どの記録種別でも、個人チャットにメッセージが増えず、保護者ホームに日誌が出ない
// （詳細設計書「日誌」(4-13 (2))。以前の版の共有の指定 share_to_guardian が送られても読まない）
func TestApprovalSendsNothingToGuardian(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")
	guardian := loginAs(a, 6, "guardian")

	countMessages := func() int {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message`).Scan(&n)
		return n
	}
	before := countMessages()

	personal := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		personalDiary(0, "C001", "1", today(), "園内で確かめる個人日誌", "2")).Body.Bytes())
	incident := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		`{"record_type":"4","child_id":"C001","class_id":1,"diary_date":"`+today()+`","body":"【状況】園内限定の記録","status":"2"}`).Body.Bytes())
	for _, id := range []int64{personal.DiaryID, incident.DiaryID, 2} { // 2 はさくら組のクラス日誌（申請中）
		d := diaryOf(t, call(t, h, admin, "POST", "/api/diaries/"+itoa(id)+"/approve", `{"share_to_guardian":true}`).Body.Bytes())
		if d.Status != "3" {
			t.Fatalf("日誌 %d: status = %s, want 3", id, d.Status)
		}
	}
	if after := countMessages(); after != before {
		t.Fatalf("承認でチャットのメッセージが %d → %d 件に増えています", before, after)
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE source_type = '2' AND is_deleted = 0`).Scan(&n)
	if n != 0 {
		t.Fatalf("日誌の共有の知らせが %d 件残っています", n)
	}
	home := call(t, h, guardian, "GET", "/api/dashboard/guardian", "").Body.String()
	if strings.Contains(home, "sharedDiaries") || strings.Contains(home, "園内で確かめる個人日誌") || strings.Contains(home, "園内限定の記録") {
		t.Fatalf("保護者ホームに日誌が出ています: %s", home)
	}
}

// 園児情報・既往歴・アレルギーは保護者に見せない。身体測定は共有したもの（連携済）だけ
// （基本設計書 6-1「園児情報の参照｜保護者 ×」「既往歴の参照｜保護者 ×」「成長グラフの閲覧｜保護者 ※3」）
func TestGuardianCannotReadChildRecords(t *testing.T) {
	a, h := newTestApp(t)
	kinjoS := loginAs(a, 10, "guardian") // 金城 陸（C005）の保護者。C005 には既往歴がある
	teacher := loginAs(a, 3, "staff")

	for _, path := range []string{"/api/children/C005", "/api/children/C005/medical-histories", "/api/children/C005/allergies"} {
		body := expectStatus(t, request(t, h, kinjoS, "GET", path, ""), http.StatusForbidden)
		if strings.Contains(body, "熱性けいれん") || strings.Contains(body, "normal_temperature") {
			t.Fatalf("%s: 園内の情報が返っています: %s", path, body)
		}
		call(t, h, teacher, "GET", path, "")
	}

	t.Run("身体測定の経路は、保護者には 403（成長の記録で読む）。職員には全件", func(t *testing.T) {
		guardian := loginAs(a, 6, "guardian") // 野原 太郎（C001）の保護者
		body := expectStatus(t, request(t, h, guardian, "GET", "/api/children/C001/physical", ""), http.StatusForbidden)
		if !strings.Contains(body, msgGrowthForbidden) {
			t.Fatalf("保護者の応答: %s", body)
		}
		var all []PhysicalRecord
		if err := json.Unmarshal(call(t, h, teacher, "GET", "/api/children/C001/physical", "").Body.Bytes(), &all); err != nil {
			t.Fatal(err)
		}
		if len(all) != 3 {
			t.Fatalf("職員に %d 件返っています。want 3", len(all))
		}
	})
}
