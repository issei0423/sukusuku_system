package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * 保護者に見せる範囲（GitHub Issue #157）
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1) ※3「自児のみ、かつ共有されたものに限る」・
 *      「権限チェックの実装方針」(6-2)「画面を経由せず直接リクエストを送っても拒否されること」、
 *      「日誌システム」(4-5)「共有を選べるのは個人日誌だけとする」、図/画面詳細図.md「共有日誌閲覧画面」(2-8)
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、
 * web/tests/guardianScope.test.ts と同じ観点で確かめる。
 */

// 職員の編集画面・タイムラインのための経路は、保護者には使わせない。
// 共有していない日誌（下書き・申請中・差し戻し・ヒヤリハット）と差し戻す理由が読めてしまうため
func TestGuardianCannotUseStaffDiaryRoutes(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, 6, "guardian") // 野原 太郎（C001）の保護者。日誌 1 は C001 の下書き
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
}

// 共有を選べるのは個人日誌だけ。ヒヤリハット・クラス日誌・週案月案は保護者への共有の対象外
// （基本設計書「日誌システム」(4-5)。GitHub Issue #61 で決めたことを API でも守る）
func TestApproveSharesOnlyPersonalDiary(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")
	guardian := loginAs(a, 6, "guardian")

	var incident Diary
	if err := json.Unmarshal(call(t, h, teacher, "POST", "/api/diaries",
		`{"record_type":"4","child_id":"C001","class_id":1,"diary_date":"`+today()+`","body":"【状況】園内限定の記録","status":"2"}`).
		Body.Bytes(), &incident); err != nil {
		t.Fatal(err)
	}

	t.Run("ヒヤリハット・クラス日誌を共有つきで承認しようとすると断り、承認もしない", func(t *testing.T) {
		for _, id := range []int64{incident.DiaryID, 2} { // 2 はさくら組のクラス日誌（申請中）
			expectStatus(t, request(t, h, admin, "POST", "/api/diaries/"+itoa(id)+"/approve",
				`{"share_to_guardian":true}`), http.StatusBadRequest)
			var status string
			var shared bool
			a.db.QueryRow(`SELECT status, is_shared_to_guardian FROM t_diary WHERE diary_id = ?`, id).Scan(&status, &shared)
			if status != "2" || shared {
				t.Fatalf("日誌 %d: status=%s shared=%v（申請中のまま・共有なしであるべき）", id, status, shared)
			}
		}
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE source_type = '2' AND source_id = ?`, incident.DiaryID).Scan(&n)
		if n != 0 {
			t.Fatalf("ヒヤリハットが個人チャットへ流れています（%d 件）", n)
		}
	})

	t.Run("共有しない承認は通る", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/diaries/"+itoa(incident.DiaryID)+"/approve", `{"share_to_guardian":false}`)
	})

	t.Run("すでに共有の印が付いてしまったヒヤリハットも、保護者には見せない", func(t *testing.T) {
		if _, err := a.db.Exec(`UPDATE t_diary SET is_shared_to_guardian = 1 WHERE diary_id = ?`, incident.DiaryID); err != nil {
			t.Fatal(err)
		}
		expectStatus(t, request(t, h, guardian, "GET", "/api/diaries/"+itoa(incident.DiaryID), ""), http.StatusForbidden)
		if strings.Contains(call(t, h, guardian, "GET", "/api/dashboard/guardian", "").Body.String(), "園内限定の記録") {
			t.Fatal("保護者ホームにヒヤリハットが出ています")
		}
		if strings.Contains(call(t, h, guardian, "GET", "/api/diaries", "").Body.String(), "園内限定の記録") {
			t.Fatal("保護者の日誌一覧にヒヤリハットが出ています")
		}
	})
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

// 保護者が見られない日誌を開いたときは「この記録は共有されていません」と示す（画面詳細図 2-8）。
// 自児の未共有・他児・無い日誌を同じ文言にし、あるかどうかを推測させない
func TestGuardianUnsharedDiaryMessage(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, 6, "guardian") // 野原 太郎（C001）の保護者

	for _, id := range []string{"1", "4", "99999"} { // 自児の下書き・他児の共有済み・無い日誌
		var e apiError
		if err := json.Unmarshal([]byte(expectStatus(t,
			request(t, h, guardian, "GET", "/api/diaries/"+id, ""), http.StatusForbidden)), &e); err != nil {
			t.Fatal(err)
		}
		if e.Message != "この記録は共有されていません" {
			t.Fatalf("日誌 %s: message = %q", id, e.Message)
		}
	}
	// 職員にはこれまでどおり権限の文言を返す
	var e apiError
	json.Unmarshal([]byte(expectStatus(t,
		request(t, h, loginAs(a, 5, "staff"), "GET", "/api/diaries/1", ""), http.StatusForbidden)), &e)
	if e.Message != "この日誌を参照する権限がありません" {
		t.Fatalf("職員への message = %q", e.Message)
	}
	// 共有された自児の日誌は開ける
	call(t, h, guardian, "GET", "/api/diaries/5", "")
}
