package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

/*
午睡チェックの誤りの文言（基本設計書「メッセージ一覧」(4-12) の午睡チェック、詳細設計書「午睡（ねた・おきた・対象外）」(4-6) の共通・(5)、
「誤りの種類」の session_ended）。受け入れテスト 04-019・04-022 の文言。

設計書の文言を、server/messages.go の定数を使わずに文字で持つ。定数の書き換えで文言が設計から離れたときにも気づくため
（api_invitation_messages_test.go と同じ考え）。モックの同じ観点は web/tests/napMessages.test.ts にある。
*/
const (
	wantNapSessionEnded      = "午睡チェックは終了しています。画面を読み込み直してください。"
	wantNapExcludeAfterSleep = "「ねた」を記録した園児は対象外にできません。"
)

func TestNapMessagesFollowDesign(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	s := startFreshNap(t, a, h, teacher)
	base := "/api/nap/session/" + itoa(s.NapSessionID)

	t.Run("「ねた」のある子を対象外にしようとした", func(t *testing.T) {
		call(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C001"}`)
		rec := request(t, h, teacher, "POST", base+"/exclusions", `{"child_id":"C001","reason":"1"}`)
		expectStatus(t, rec, http.StatusBadRequest)
		if got := errorMessageOf(t, rec); got != wantNapExcludeAfterSleep {
			t.Errorf("文言 = %q, want %q", got, wantNapExcludeAfterSleep)
		}
	})

	call(t, h, teacher, "POST", base+"/end", "")
	found := today() + "T00:00:00"
	// 終わった実施へ送るものは、どれも 409 session_ended と同じ文（5分ごとの確認・異常時の記録も、ねた・おきたと同じ）
	for _, c := range []struct{ name, path, body string }{
		{"5分ごとの確認", base + "/records", `{"child_id":"C002","body_position":"1","breathing":"1","complexion":"1","temperature":null}`},
		{"異常時の記録", base + "/abnormals", `{"child_id":"C002","found_at":"` + found + `","situation":"状況","response":"対応"}`},
		{"ねた", base + "/sleeps", `{"child_id":"C002"}`},
	} {
		t.Run("終わった実施への"+c.name, func(t *testing.T) {
			rec := request(t, h, teacher, "POST", c.path, c.body)
			expectStatus(t, rec, http.StatusConflict)
			var e apiError
			if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
				t.Fatalf("誤りの応答を読めない: %s", rec.Body.String())
			}
			if e.Message != wantNapSessionEnded || e.Kind != kindSessionEnded {
				t.Errorf("応答 = %+v, want 文言 %q・kind %q", e, wantNapSessionEnded, kindSessionEnded)
			}
		})
	}
}
