package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*
 * 画面が思っている利用者と、Cookie のセッションの利用者が違うときは、何もしない（session.go の accountHeader）
 *
 * 同じブラウザのタブは Cookie を共有する。保護者のタブを開いたまま、別のタブでログアウトして職員でログインし直すと、
 * 保護者のタブから送ったメッセージが職員の送信として残り、保護者は自分の送信を編集・取消できなくなっていた。
 * 画面は要求のたびに思っている利用者をヘッダで送り、違えば 409（account_changed）で止める。
 *
 * モック（web/src/api/mock.ts）はタブごとにメモリで動き、Cookie を共有しないので、この食い違いは起きない。
 * 画面が 409 を受けて切り替えることは web/tests/accountChanged.test.tsx で確かめる。
 */

// sendAs は、画面が思っている利用者（expected。0 なら送らない）を添えて要求する
func sendAs(t *testing.T, h http.Handler, c *http.Cookie, expected int64, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if expected != 0 {
		req.Header.Set(accountHeader, fmt.Sprint(expected))
	}
	req.AddCookie(c)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func expectAccountChanged(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	expectStatus(t, rec, http.StatusConflict)
	var e apiError
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e.Kind != kindAccountChanged {
		t.Fatalf("kind = %q, want %q (body: %s)", e.Kind, kindAccountChanged, rec.Body.String())
	}
}

// 野原 太郎の個人チャット（保護者 6 と担任の高梨 3 が入っている）
func noharaPersonalRoom(t *testing.T, a *app) int64 {
	t.Helper()
	var id int64
	if err := a.db.QueryRow(`SELECT r.chat_room_id FROM m_chat_room r
		JOIN t_chat_member m6 ON m6.chat_room_id = r.chat_room_id AND m6.account_id = 6
		JOIN t_chat_member m3 ON m3.chat_room_id = r.chat_room_id AND m3.account_id = 3
		WHERE r.room_type = '4' LIMIT 1`).Scan(&id); err != nil {
		t.Fatalf("野原 太郎の個人チャットが見つからない: %v", err)
	}
	return id
}

func TestAccountHeaderMatchesSession(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, 6, "guardian")

	// 一致すれば通る。送らなくても通る（ページを開き直したときの GET /api/me、結合テスト）
	expectStatus(t, sendAs(t, h, guardian, 6, "GET", "/api/chat/rooms", ""), http.StatusOK)
	expectStatus(t, sendAs(t, h, guardian, 0, "GET", "/api/chat/rooms", ""), http.StatusOK)
	expectStatus(t, sendAs(t, h, guardian, 0, "GET", "/api/me", ""), http.StatusOK)
}

func TestSendFromStaleTabIsRefused(t *testing.T) {
	a, h := newTestApp(t)
	room := noharaPersonalRoom(t, a)
	// 保護者のタブを開いたまま、別のタブでログアウトして職員（高梨）でログインし直した。Cookie は職員のもの
	staff := loginAs(a, 3, "staff")

	var before int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE chat_room_id = ?`, room).Scan(&before)

	// 保護者のタブ（思っている利用者は保護者 6）から送ると、職員の送信として残さずに止める
	path := fmt.Sprintf("/api/chat/rooms/%d/messages", room)
	expectAccountChanged(t, sendAs(t, h, staff, 6, "POST", path, `{"body":"明日は祖母がお迎えに伺います"}`))

	var after int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE chat_room_id = ?`, room).Scan(&after)
	if after != before {
		t.Fatalf("メッセージが %d 件増えた。別のアカウントの送信として残してはいけない", after-before)
	}

	// 読むだけの要求も止める（職員の画面が保護者の Cookie で読みに行き「職員のみが行えます」と出るのも同じ食い違い）
	expectAccountChanged(t, sendAs(t, h, staff, 6, "GET", "/api/chat/rooms", ""))
	// 職員のタブから（思っている利用者が一致）なら通る
	expectStatus(t, sendAs(t, h, staff, 3, "GET", "/api/chat/rooms", ""), http.StatusOK)
}

func TestEditFromStaleTabIsRefused(t *testing.T) {
	a, h := newTestApp(t)
	room := noharaPersonalRoom(t, a)
	guardian := loginAs(a, 6, "guardian")
	path := fmt.Sprintf("/api/chat/rooms/%d/messages", room)
	expectStatus(t, sendAs(t, h, guardian, 6, "POST", path, `{"body":"編集する前の本文"}`), http.StatusOK)
	var msgID int64
	a.db.QueryRow(`SELECT MAX(chat_message_id) FROM t_chat_message WHERE chat_room_id = ?`, room).Scan(&msgID)

	// 別の保護者のアカウントに入れ替わった Cookie で、前の保護者のタブから編集する
	other := loginAs(a, 9, "guardian")
	expectAccountChanged(t, sendAs(t, h, other, 6, "POST", fmt.Sprintf("/api/chat/messages/%d/edit", msgID), `{"body":"書き換え"}`))
	var body string
	a.db.QueryRow(`SELECT body FROM t_chat_message WHERE chat_message_id = ?`, msgID).Scan(&body)
	if body != "編集する前の本文" {
		t.Fatalf("本文 = %q。止めた要求で書き換えてはいけない", body)
	}
}

func TestLiveConnectionChecksAccountQuery(t *testing.T) {
	a, h := newTestApp(t)
	staff := loginAs(a, 3, "staff")
	// 知らせの接続はヘッダを付けられないので、クエリで送る
	expectAccountChanged(t, sendAs(t, h, staff, 0, "GET", "/api/events?"+accountQuery+"=6", ""))
	// 数でない値は、どのアカウントとも一致しない
	expectAccountChanged(t, sendAs(t, h, staff, 0, "GET", "/api/chat/rooms?"+accountQuery+"=x", ""))
}
