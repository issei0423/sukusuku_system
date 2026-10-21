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
	// 職員の入口なら、ログインと同じく自動ログアウトを課す（session.go の idleLogout）。ログインした時刻を最後の操作とする
	at := a.sessions.now()
	a.sessions.data[id] = session{accountID: accountID, entrance: entrance,
		expiresAt: at.Add(time.Hour), idleLogout: entrance == "staff", lastActiveAt: at}
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

// 数え損ねたときに「未対応 0 件」と返すと、保育士は「対応漏れなし」と受け取ってしまう。
// 失敗はエラーとして返し、画面には前回の表示を残させる
func TestStaffSummaryFailsInsteadOfZeroUnhandled(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	if _, err := a.db.Exec(`ALTER TABLE m_chat_room RENAME TO m_chat_room_gone`); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/api/dashboard/staff", nil)
	req.AddCookie(teacher)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body: %s)", rec.Code, rec.Body.String())
	}
}

// 既読の人数はメッセージと一緒に職員へ返し、保護者には返さない（基本設計書 5-5）。
// 画面はこの値を読み直しのたびに使う（web/src/screens/chat/StaffChatScreen.tsx）
func TestChatMessagesReadCount(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	guardian := loginAs(a, 6, "guardian")

	const sent = "お大事になさってください。"
	call(t, h, teacher, "POST", "/api/chat/rooms/6/messages", `{"body":"`+sent+`"}`)
	// 一覧の末尾ではなく本文で探す。デモデータには今日の 07:40 のメッセージがあり、
	// それより前の時刻に走らせると、送ったメッセージが末尾に並ばないため
	readCountOfSent := func(c *http.Cookie) int {
		var list []map[string]any
		if err := json.Unmarshal(call(t, h, c, "GET", "/api/chat/rooms/6/messages", "").Body.Bytes(), &list); err != nil {
			t.Fatal(err)
		}
		for _, m := range list {
			if m["body"] == sent {
				n, _ := m["read_count"].(float64)
				return int(n)
			}
		}
		t.Fatalf("送ったメッセージが一覧にない")
		return 0
	}

	if n := readCountOfSent(teacher); n != 0 {
		t.Fatalf("送った直後: read_count = %d, want 0", n)
	}
	call(t, h, guardian, "POST", "/api/chat/rooms/6/read", "")
	if n := readCountOfSent(teacher); n != 1 {
		t.Fatalf("保護者が読んだあと: read_count = %d, want 1", n)
	}
	// 保護者には既読の人数を見せない（0 のまま返る）
	if n := readCountOfSent(guardian); n != 0 {
		t.Fatalf("保護者への応答に既読の人数が入っている: %d", n)
	}
}
