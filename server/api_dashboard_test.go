package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

/*
 * 職員ダッシュボードの「未対応の個人チャット」
 * 典拠：要件定義書「チャットツール」(4-3)、web/仮置き値.md「開いたままの画面の読み直し（自動更新）」
 *
 * 画面側のモック（web/src/api/mock.ts の staffSummary）と同じ規則であることを、
 * web/tests/autoRefresh.test.tsx と同じ観点で確かめる。
 */

// newTestApp は、デモデータ入りのデータベースを一時フォルダに作ってサーバを組み立てる。
// 作業ツリーにある sukusuku.db には触らない
func newTestApp(t *testing.T) (*app, http.Handler) {
	t.Helper()
	db, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	a := &app{db: db, sessions: newSessionStore()}
	if err := a.init(); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	a.routes(mux)
	return a, mux
}

// loginAs は、ログインの手順を飛ばしてセッションを作り、その Cookie を返す
func loginAs(a *app, accountID int64, entrance string) *http.Cookie {
	id := randomToken(16)
	a.sessions.mu.Lock()
	a.sessions.data[id] = session{accountID: accountID, entrance: entrance, expiresAt: time.Now().Add(time.Hour)}
	a.sessions.mu.Unlock()
	return &http.Cookie{Name: sessionCookie, Value: id}
}

func call(t *testing.T, h http.Handler, c *http.Cookie, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(c)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body.String())
	}
	return rec
}

type unhandledSummary struct {
	UnhandledChat     int          `json:"unhandledChat"`
	UnhandledChatRoom *chatRoomRef `json:"unhandledChatRoom"`
}

func summaryOf(t *testing.T, h http.Handler, c *http.Cookie) unhandledSummary {
	t.Helper()
	var got unhandledSummary
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/dashboard/staff", "").Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestStaffSummaryUnhandledPersonalChats(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")      // さくら組の担任。野原 太郎の保護者との個人チャットに参加している
	otherTeacher := loginAs(a, 5, "staff") // ひまわり組の担任。さくら組の個人チャットには参加していない
	guardian := loginAs(a, 6, "guardian")  // 野原 太郎の保護者
	const personalRoom = 6

	t.Run("参加している個人チャットのうち、未対応のものを数え、先頭のチャンネルを返す", func(t *testing.T) {
		got := summaryOf(t, h, teacher)
		if got.UnhandledChat != 1 {
			t.Fatalf("unhandledChat = %d, want 1", got.UnhandledChat)
		}
		if got.UnhandledChatRoom == nil || got.UnhandledChatRoom.ChatRoomID != personalRoom ||
			got.UnhandledChatRoom.RoomName != "野原 太郎の保護者" {
			t.Fatalf("unhandledChatRoom = %+v", got.UnhandledChatRoom)
		}
	})

	t.Run("参加していない個人チャットは数えない", func(t *testing.T) {
		got := summaryOf(t, h, otherTeacher)
		if got.UnhandledChat != 0 || got.UnhandledChatRoom != nil {
			t.Fatalf("got %+v, want 0 and null", got)
		}
	})

	t.Run("対応済みにすると減り、保護者から届くと未対応へ戻って増える", func(t *testing.T) {
		call(t, h, teacher, "POST", "/api/chat/rooms/6/thread-status", `{"status":"2"}`)
		if got := summaryOf(t, h, teacher); got.UnhandledChat != 0 || got.UnhandledChatRoom != nil {
			t.Fatalf("対応済みにしたあと: %+v", got)
		}
		call(t, h, guardian, "POST", "/api/chat/rooms/6/messages", `{"body":"昨夜37.4℃ありました。"}`)
		if got := summaryOf(t, h, teacher); got.UnhandledChat != 1 {
			t.Fatalf("保護者から届いたあと: %+v", got)
		}
	})

	t.Run("旧いデモデータの文言（未対応）も数え、先頭はチャンネルの番号順で決める", func(t *testing.T) {
		if _, err := a.db.Exec(`UPDATE m_chat_room SET thread_status = '未対応' WHERE chat_room_id = 7`); err != nil {
			t.Fatal(err)
		}
		got := summaryOf(t, h, teacher)
		if got.UnhandledChat != 2 {
			t.Fatalf("unhandledChat = %d, want 2", got.UnhandledChat)
		}
		if got.UnhandledChatRoom == nil || got.UnhandledChatRoom.ChatRoomID != personalRoom {
			t.Fatalf("unhandledChatRoom = %+v, want room %d", got.UnhandledChatRoom, personalRoom)
		}
	})
}

// 既読の人数はメッセージと一緒に職員へ返し、保護者には返さない（基本設計書 5-5）。
// 画面はこの値を読み直しのたびに使う（web/src/screens/chat/StaffChatScreen.tsx）
func TestChatMessagesReadCount(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	guardian := loginAs(a, 6, "guardian")

	call(t, h, teacher, "POST", "/api/chat/rooms/6/messages", `{"body":"お大事になさってください。"}`)
	readCountOfLast := func(c *http.Cookie) (int, bool) {
		var list []map[string]any
		if err := json.Unmarshal(call(t, h, c, "GET", "/api/chat/rooms/6/messages", "").Body.Bytes(), &list); err != nil {
			t.Fatal(err)
		}
		last := list[len(list)-1]
		n, _ := last["read_count"].(float64)
		return int(n), last["body"] == "お大事になさってください。"
	}

	if n, ok := readCountOfLast(teacher); !ok || n != 0 {
		t.Fatalf("送った直後: read_count = %d (最後のメッセージか: %v)", n, ok)
	}
	call(t, h, guardian, "POST", "/api/chat/rooms/6/read", "")
	if n, _ := readCountOfLast(teacher); n != 1 {
		t.Fatalf("保護者が読んだあと: read_count = %d, want 1", n)
	}
	// 保護者には既読の人数を見せない（0 のまま返る）
	if n, _ := readCountOfLast(guardian); n != 0 {
		t.Fatalf("保護者への応答に既読の人数が入っている: %d", n)
	}
}
