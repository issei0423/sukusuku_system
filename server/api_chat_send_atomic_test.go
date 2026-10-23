package main

import (
	"net/http"
	"strings"
	"testing"
)

/*
 * 保護者からの送信は、メッセージと未対応への戻しを、どちらも入れるか、どちらも入れない（要件定義書「チャットツール」(4-3)）
 *
 * 保護者から新しく受信した個人チャットは、自動で未対応へ戻す。メッセージだけが入って戻しが失敗すると、
 * 保護者から届いたのに「対応済み」のまま残り、職員の未対応の一覧に出ない。
 *
 * モック（web/src/api/mock.ts）はメモリの上で続けて書き換えるだけで、途中で失敗することがない。
 */

func threadStatusOf(t *testing.T, a *app, room int64) string {
	t.Helper()
	var status string
	if err := a.db.QueryRow(`SELECT thread_status FROM m_chat_room WHERE chat_room_id = ?`, room).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func messageCountOf(t *testing.T, a *app, room int64) int {
	t.Helper()
	var n int
	if err := a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE chat_room_id = ?`, room).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ふだんは、保護者が送ると未対応に戻る
func TestGuardianSendReopensThread(t *testing.T) {
	a, h := newTestApp(t)
	room := nishidaPersonalRoom(t, a)
	mustExec(t, a, `UPDATE m_chat_room SET thread_status = '2' WHERE chat_room_id = ?`, room)
	guardian := loginAs(a, 6, "guardian")

	call(t, h, guardian, "POST", "/api/chat/rooms/"+itoa(room)+"/messages", `{"body":"明日は祖母がお迎えに伺います"}`)
	if got := threadStatusOf(t, a, room); got != "1" {
		t.Fatalf("thread_status = %q, want 1（未対応）", got)
	}
}

// 未対応への戻しが失敗したら、メッセージも入れない。操作ログも残さない
func TestGuardianSendRollsBackWhenReopenFails(t *testing.T) {
	a, h := newTestApp(t)
	room := nishidaPersonalRoom(t, a)
	mustExec(t, a, `UPDATE m_chat_room SET thread_status = '2' WHERE chat_room_id = ?`, room)
	guardian := loginAs(a, 6, "guardian")
	before := messageCountOf(t, a, room)
	var logsBefore int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE function_type = ? AND target_table = 't_chat_message'`, fnChat).Scan(&logsBefore)

	// 未対応への戻しで失敗させる
	mustExec(t, a, `CREATE TRIGGER test_fail_reopen BEFORE UPDATE OF thread_status ON m_chat_room
		BEGIN SELECT RAISE(ABORT, 'テストで止める'); END`)

	rec := chatReq(h, guardian, "POST", "/api/chat/rooms/"+itoa(room)+"/messages", `{"body":"明日は祖母がお迎えに伺います"}`)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "送信に失敗しました") {
		t.Fatalf("送信: %d %s", rec.Code, rec.Body.String())
	}
	if got := messageCountOf(t, a, room); got != before {
		t.Fatalf("メッセージが %d 件増えた。未対応へ戻せないなら、メッセージも入れない", got-before)
	}
	if got := threadStatusOf(t, a, room); got != "2" {
		t.Fatalf("thread_status = %q, want 2（変わらない）", got)
	}
	var logsAfter int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE function_type = ? AND target_table = 't_chat_message'`, fnChat).Scan(&logsAfter)
	if logsAfter != logsBefore {
		t.Fatalf("送れなかったのに、送信の操作ログが %d 件増えた", logsAfter-logsBefore)
	}
}
