package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

/*
 * 管理者のダッシュボードの「対応の記録がない取り消し」（GitHub Issue #141 の 3）
 * 典拠：図/画面詳細図.md「誤送信対応記録画面（管理者）」(4-4) 項目9・「この記録は管理者が行う」、
 *      基本設計書「誤送信への対応」(4-6)
 *
 * 職員が取り消したメッセージは、管理者が誤送信対応の画面を自分から開かないと気づけなかった。
 * 管理者のダッシュボードにだけ件数を出し、数える範囲は同じ画面の「対応の記録がない取り消し」の一覧とそろえる。
 * 画面側のモック（web/src/api/mock.ts の staffSummary）も同じ規則にしてある。
 * web/tests/dashboardMisdelivery.test.tsx が同じ観点を確かめる。片方だけを直すと食い違う。
 */

func TestStaffSummaryCountsRetractedWithoutRecordForAdminOnly(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	suzuki := loginAs(a, 3, "staff")
	guardian := loginAs(a, 9, "guardian")

	count := func(c *http.Cookie) int {
		t.Helper()
		var s struct {
			MisdeliveryUnrecorded *int `json:"misdeliveryUnrecorded"`
		}
		if err := json.Unmarshal(call(t, h, c, "GET", "/api/dashboard/staff", "").Body.Bytes(), &s); err != nil {
			t.Fatal(err)
		}
		if s.MisdeliveryUnrecorded == nil {
			t.Fatal("ダッシュボードの集計に misdeliveryUnrecorded が無い")
		}
		return *s.MisdeliveryUnrecorded
	}
	// 一覧（誤送信対応記録画面の「対応の記録がない取り消し」）の件数
	listed := func() int {
		t.Helper()
		var rows []struct {
			ChatMessageID int64 `json:"chat_message_id"`
		}
		if err := json.Unmarshal(call(t, h, admin, "GET", "/api/chat/misdelivery/pending", "").Body.Bytes(), &rows); err != nil {
			t.Fatal(err)
		}
		return len(rows)
	}
	// 管理者のダッシュボードの件数が、いつも一覧の件数と同じであること
	expectCount := func(step string, want int) {
		t.Helper()
		got := count(admin)
		if got != want {
			t.Errorf("%s：管理者のダッシュボードの件数 = %d, want %d", step, got, want)
		}
		if n := listed(); got != n {
			t.Errorf("%s：ダッシュボードの件数 %d が、誤送信対応の一覧の件数 %d と食い違う", step, got, n)
		}
	}

	before := count(admin)
	expectCount("はじめ", before)

	// 担任（一般の職員）が個人チャットへ送ったメッセージを取り消すと、管理者の件数が増える
	byStaff := sentID(t, call(t, h, suzuki, "POST", "/api/chat/rooms/8/messages",
		`{"body":"（誤送信）西田 太郎くんの発熱の記録"}`).Body)
	call(t, h, suzuki, "POST", "/api/chat/messages/"+itoa(byStaff)+"/retract", "")
	expectCount("職員が取り消したあと", before+1)

	// 一般の職員には数えない（記録するのは管理者。取り消した本人であっても 0）
	if got := count(suzuki); got != 0 {
		t.Errorf("一般の職員のダッシュボードに、対応の記録がない取り消しが %d 件と出る", got)
	}

	// 保護者が自分で取り消したものは数えない
	byGuardian := sentID(t, call(t, h, guardian, "POST", "/api/chat/rooms/8/messages",
		`{"body":"明日はお休みします（打ちまちがい）"}`).Body)
	call(t, h, guardian, "POST", "/api/chat/messages/"+itoa(byGuardian)+"/retract", "")
	expectCount("保護者が取り消したあと", before+1)

	// 配布物の取り下げで取り消された掲載の知らせは数えない
	var posted struct {
		HandoutID int64 `json:"handout_id"`
	}
	if err := json.Unmarshal(call(t, h, admin, "POST", "/api/handouts", `{"handout_type":"4","title":"さくら組だより",
		"target_month":"2026-10","class_id":1,"file_name":"sakura.pdf","file_type":"application/pdf","file_size":1000}`).
		Body.Bytes(), &posted); err != nil {
		t.Fatal(err)
	}
	call(t, h, admin, "POST", "/api/handouts/"+itoa(posted.HandoutID)+"/withdraw", "")
	expectCount("配布物を取り下げたあと", before+1)

	// 対応を記録すると、数が減る
	call(t, h, admin, "POST", "/api/chat/misdelivery",
		`{"chat_message_id":`+itoa(byStaff)+`,"occurred_at":"2026-10-17T15:10:00","was_read":false,"response":"送信者へ取り消しを依頼した"}`)
	expectCount("対応を記録したあと", before)
}
