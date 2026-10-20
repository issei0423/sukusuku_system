package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

/*
 * 誤送信への対応の記録の「発生日時」（GitHub Issue #178 の 1）
 * 典拠：図/画面詳細図.md「誤送信対応記録画面（管理者）」(4-4) 項目3「発生日時｜初期値：対象メッセージの送信日時／入力：必須」
 *      基本設計書「誤送信への対応」(4-6)
 *
 * 発生日時が空のとき、記録した時刻を黙って入れていた。監査の記録が事実と違う時刻になるため、空は断る。
 * 画面側のモック（web/src/api/mock.ts の addMisdeliveryRecord）も同じ規則にしてある。web/tests/misdelivery.test.ts が同じ観点を確かめる。
 */

func TestAddMisdeliveryRecordRequiresOccurredAt(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	takanashi := loginAs(a, 3, "staff")

	// 高梨（さくら組）が、さくら組のチャンネルへ送ったメッセージを取り消す
	id := sentID(t, call(t, h, takanashi, "POST", "/api/chat/rooms/3/messages", `{"body":"（誤送信）明日の持ち物"}`).Body)
	call(t, h, takanashi, "POST", "/api/chat/messages/"+itoa(id)+"/retract", "")

	for _, c := range []struct{ name, occurredAt string }{
		{"空", ""},
		{"秒の無い形", "2026-10-17T15:10"},
		{"実在しない日時", "2026-02-30T15:10:00"},
	} {
		rec := send(t, h, admin, "POST", "/api/chat/misdelivery",
			`{"chat_message_id":`+itoa(id)+`,"occurred_at":"`+c.occurredAt+`","was_read":false,"response":"送信者へ取り消しを依頼した"}`)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("発生日時が%sでも記録できる: %d %s", c.name, rec.Code, rec.Body.String())
		}
	}

	// 入れた発生日時のまま残る
	call(t, h, admin, "POST", "/api/chat/misdelivery",
		`{"chat_message_id":`+itoa(id)+`,"occurred_at":"2026-10-17T15:10:00","was_read":false,"response":"送信者へ取り消しを依頼した"}`)
	var records []struct {
		ChatMessageID int64  `json:"chat_message_id"`
		OccurredAt    string `json:"occurred_at"`
	}
	if err := json.Unmarshal(call(t, h, admin, "GET", "/api/chat/misdelivery", "").Body.Bytes(), &records); err != nil {
		t.Fatal(err)
	}
	found := 0
	for _, r := range records {
		if r.ChatMessageID != id {
			continue
		}
		found++
		if r.OccurredAt != "2026-10-17T15:10:00" {
			t.Errorf("発生日時 = %q, want 2026-10-17T15:10:00", r.OccurredAt)
		}
	}
	if found != 1 {
		t.Errorf("このメッセージの記録が %d 件ある（断った要求まで記録されている）", found)
	}
}
