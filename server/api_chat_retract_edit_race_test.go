package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

/*
 * メッセージの取消・編集を同時に押しても、取消の規則が崩れない（基本設計書「誤送信への対応」(4-6)・「メッセージの編集」(4-6)）
 *
 * 取消・編集は「取り消し済みでないか」を確かめてから書き込む。確かめと書き込みのあいだに別の要求が割り込むと、
 *   - 取消を2回同時に押すと、両方が通り、取り消した日時が上書きされ、操作ログが2件になる（GitHub Issue #100 で防いだ場面）
 *   - 編集と取消が重なると、取消のあとに編集が本文を書き戻し、取り消したメッセージに本文が残る
 * 書き込みに「取り消し済みでない」ことを条件として入れ、負けた側は順に押したときと同じ 409 を返す。
 *
 * モック（web/src/api/mock.ts）は要求を1つずつ最後まで処理するので、割り込みは起きない。
 * 順に押したときの応答は web/tests/chatReadRetract.test.ts が確かめる。
 */

// guardianSends は、西田 太郎の個人チャットへ保護者 6 として送り、そのメッセージの ID を返す
func guardianSends(t *testing.T, h http.Handler, guardian *http.Cookie, room int64, body string) int64 {
	t.Helper()
	return sentID(t, call(t, h, guardian, "POST", "/api/chat/rooms/"+itoa(room)+"/messages", `{"body":"`+body+`"}`).Body)
}

// atOnce は、2つの要求を同時に送り、それぞれの応答を返す
func atOnce(h http.Handler, c *http.Cookie, path1, body1, path2, body2 string) (*httptest.ResponseRecorder, *httptest.ResponseRecorder) {
	var rec1, rec2 *httptest.ResponseRecorder
	var wg sync.WaitGroup
	start := make(chan struct{})
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		rec1 = chatReq(h, c, "POST", path1, body1)
	}()
	go func() {
		defer wg.Done()
		<-start
		rec2 = chatReq(h, c, "POST", path2, body2)
	}()
	close(start)
	wg.Wait()
	return rec1, rec2
}

func retractLogs(a *app, id int64) int {
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log
		WHERE target_table = 't_chat_message' AND target_id = ? AND operation_type = ?`, id, opDelete).Scan(&n)
	return n
}

// 取消を2つのタブから同時に押しても、通るのは1つ。もう1つは順に押したときと同じ 409 を返し、操作ログは1件
func TestRetractTwiceAtOnce(t *testing.T) {
	a, h := newTestApp(t)
	room := nishidaPersonalRoom(t, a)
	guardian := loginAs(a, 6, "guardian")
	for i := 0; i < 40; i++ {
		id := guardianSends(t, h, guardian, room, "取り消す本文")
		path := "/api/chat/messages/" + itoa(id) + "/retract"
		rec1, rec2 := atOnce(h, guardian, path, "", path, "")

		ok, conflict := 0, 0
		for _, rec := range []*httptest.ResponseRecorder{rec1, rec2} {
			switch {
			case rec.Code == http.StatusOK:
				ok++
			case rec.Code == http.StatusConflict && strings.Contains(rec.Body.String(), "すでに取り消されています"):
				conflict++
			}
		}
		if ok != 1 || conflict != 1 {
			t.Fatalf("%d 回目：%d %s / %d %s（通るのは1つ、もう1つは 409 のはず）",
				i+1, rec1.Code, rec1.Body.String(), rec2.Code, rec2.Body.String())
		}
		if n := retractLogs(a, id); n != 1 {
			t.Fatalf("%d 回目：取消の操作ログ = %d 件, want 1", i+1, n)
		}
	}
}

// 編集と取消を同時に押しても、取り消したメッセージに本文は残らない。
// 取消が先なら編集は 409。編集が先なら、そのあとの取消で本文が消える
func TestEditAndRetractAtOnce(t *testing.T) {
	a, h := newTestApp(t)
	room := nishidaPersonalRoom(t, a)
	guardian := loginAs(a, 6, "guardian")
	for i := 0; i < 40; i++ {
		id := guardianSends(t, h, guardian, room, "編集する前の本文")
		editRec, retractRec := atOnce(h, guardian,
			"/api/chat/messages/"+itoa(id)+"/edit", `{"body":"書き換えた本文"}`,
			"/api/chat/messages/"+itoa(id)+"/retract", "")

		var body string
		var isDeleted bool
		a.db.QueryRow(`SELECT body, is_deleted FROM t_chat_message WHERE chat_message_id = ?`, id).Scan(&body, &isDeleted)
		if retractRec.Code != http.StatusOK || !isDeleted || body != "" {
			t.Fatalf("%d 回目：取消 %d %s / 編集 %d %s / 本文 %q・取消済み %v（取り消したメッセージに本文を残さない）",
				i+1, retractRec.Code, retractRec.Body.String(), editRec.Code, editRec.Body.String(), body, isDeleted)
		}
		switch editRec.Code {
		case http.StatusOK:
		case http.StatusConflict:
			if !strings.Contains(editRec.Body.String(), "取り消したメッセージは編集できません") {
				t.Fatalf("%d 回目：編集の応答 %s", i+1, editRec.Body.String())
			}
			// 通らなかった編集は、操作ログに残さない
			var n int
			a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log
				WHERE target_table = 't_chat_message' AND target_id = ? AND operation_type = ?`, id, opUpdate).Scan(&n)
			if n != 0 {
				t.Fatalf("%d 回目：通らなかった編集の操作ログ = %d 件", i+1, n)
			}
		default:
			t.Fatalf("%d 回目：編集 %d %s", i+1, editRec.Code, editRec.Body.String())
		}
	}
}
