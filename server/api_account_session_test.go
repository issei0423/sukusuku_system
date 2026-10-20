package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

/*
 * アカウントとログイン中のセッション（GitHub Issue #159）・保護者の新規登録（GitHub Issue #163）
 * 典拠：基本設計書.md「共通基盤：ログインとアカウント」(4-3)・「認証情報の保持方式」(6-3)・
 *      「パスワードの要件」(6-3)・「入力項目の制約値とメッセージ一覧」(4-9)・「チャット」(5-5)
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、
 * web/tests/accountSession.test.ts と同じ観点で確かめる。
 */

// send は Cookie の有無を問わずに要求を送る。未ログインの要求（ログイン・新規登録）にも使う
func send(t *testing.T, h http.Handler, c *http.Cookie, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if c != nil {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// sessionCookieOf は、ログイン・新規登録の応答が渡したセッションの Cookie を返す
func sessionCookieOf(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			return &http.Cookie{Name: c.Name, Value: c.Value}
		}
	}
	t.Fatalf("セッションの Cookie が返っていない (status %d, body: %s)", rec.Code, rec.Body.String())
	return nil
}

// login は、ログインの手順を通してセッションを作る
func login(t *testing.T, h http.Handler, email, password, entrance string) *http.Cookie {
	t.Helper()
	rec := send(t, h, nil, "POST", "/api/login",
		`{"email":"`+email+`","password":"`+password+`","entrance":"`+entrance+`"}`)
	expectStatus(t, rec, http.StatusOK)
	return sessionCookieOf(t, rec)
}

// errorKindOf は、拒否の応答が返した理由（kind）を返す
func errorKindOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var e apiError
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatalf("応答を読めない: %v (body: %s)", err, rec.Body.String())
	}
	return e.Kind
}

// roomIDsOf は、その利用者のチャンネル一覧に並ぶルームの番号を返す
func roomIDsOf(t *testing.T, h http.Handler, c *http.Cookie) map[int64]bool {
	t.Helper()
	var views []ChatRoomView
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/chat/rooms", "").Body.Bytes(), &views); err != nil {
		t.Fatal(err)
	}
	out := map[int64]bool{}
	for _, v := range views {
		out[v.Room.ChatRoomID] = true
	}
	return out
}

/*
 * ---- #159 の 1：停止・紐づけの解除・パスワードの変更・一時パスワードの再発行で、セッションを切る ----
 * 停止したアカウントはログインできない（要件定義書・画面詳細図 7-8 項目5）。サーバ側にセッションを持つのは
 * 即座に無効化できるため（基本設計書「認証情報の保持方式」(6-3)）。
 */

func TestSuspendedAccountLosesSessions(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	takanashi := loginAs(a, 3, "staff")
	kinjo := loginAs(a, 5, "staff")

	call(t, h, admin, "POST", "/api/admin/accounts/3/status", `{"status":"2"}`)

	t.Run("停止した職員のログイン中のセッションは、読むことも書くこともできない", func(t *testing.T) {
		expectStatus(t, request(t, h, takanashi, "GET", "/api/children", ""), http.StatusUnauthorized)
		expectStatus(t, request(t, h, takanashi, "POST", "/api/chat/rooms/2/messages", `{"body":"退職後の投稿"}`),
			http.StatusUnauthorized)
		expectStatus(t, request(t, h, takanashi, "GET", "/api/me", ""), http.StatusUnauthorized)
	})

	t.Run("ほかの職員のセッションには影響しない", func(t *testing.T) {
		call(t, h, kinjo, "GET", "/api/children", "")
	})

	t.Run("停止中のアカウントのセッションが残っていても、要求のたびに状態を見て拒否する", func(t *testing.T) {
		// 停止の操作を経ずに状態だけが変わった場合（紐づけの解除による停止など）にも止まることを確かめる
		if _, err := a.db.Exec(`UPDATE m_account SET status = '2' WHERE account_id = 5`); err != nil {
			t.Fatal(err)
		}
		expectStatus(t, request(t, h, kinjo, "GET", "/api/children", ""), http.StatusUnauthorized)
		expectStatus(t, request(t, h, kinjo, "GET", "/api/me", ""), http.StatusUnauthorized)
	})
}

func TestEndGuardianLinkEndsAccess(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	t.Run("有効な紐づけがゼロになった保護者は、ログイン中のセッションで個人チャットを読み書きできない", func(t *testing.T) {
		nohara := loginAs(a, 6, "guardian")
		call(t, h, admin, "POST", "/api/admin/guardian-links/end", `{"guardian_id":"G001","child_id":"C001"}`)
		expectStatus(t, request(t, h, nohara, "GET", "/api/chat/rooms", ""), http.StatusUnauthorized)
		expectStatus(t, request(t, h, nohara, "GET", "/api/chat/rooms/6/messages", ""), http.StatusUnauthorized)
		expectStatus(t, request(t, h, nohara, "POST", "/api/chat/rooms/6/messages", `{"body":"解除後の投稿"}`),
			http.StatusUnauthorized)
	})

	t.Run("きょうだいの紐づけが残る保護者は、解除した園児の個人チャットを参照できなくなる", func(t *testing.T) {
		// 宮城 美咲（C004）の保護者に、きょうだいとして伊藤 葵（C006、同じさくら組）を足す
		if _, err := a.db.Exec(`INSERT INTO t_guardian_child (guardian_id, child_id, relationship, link_status, linked_at)
			VALUES ('G004', 'C006', '父', '1', '2026-04-01T09:00:00')`); err != nil {
			t.Fatal(err)
		}
		miyagi := loginAs(a, 9, "guardian")
		const personalRoom, classRoom = 8, 3 // 宮城 美咲の保護者・さくら組
		if rooms := roomIDsOf(t, h, miyagi); !rooms[personalRoom] || !rooms[classRoom] {
			t.Fatalf("解除の前: %v", rooms)
		}

		call(t, h, admin, "POST", "/api/admin/guardian-links/end", `{"guardian_id":"G004","child_id":"C004"}`)

		// 解除の時点でセッションは切れる。紐づけが残るのでログインし直せる
		expectStatus(t, request(t, h, miyagi, "GET", "/api/chat/rooms", ""), http.StatusUnauthorized)
		miyagi = login(t, h, "miyagi.r@example.jp", "pass1234", "guardian")
		rooms := roomIDsOf(t, h, miyagi)
		if rooms[personalRoom] {
			t.Fatalf("解除した園児の個人チャットが一覧に残っている: %v", rooms)
		}
		if !rooms[classRoom] {
			t.Fatalf("きょうだいが在籍するクラスのチャンネルまで外れた: %v", rooms)
		}
		expectStatus(t, request(t, h, miyagi, "GET", "/api/chat/rooms/8/messages", ""), http.StatusForbidden)
		expectStatus(t, request(t, h, miyagi, "POST", "/api/chat/rooms/8/messages", `{"body":"解除後の投稿"}`),
			http.StatusForbidden)

		t.Run("紐づけを戻すと、個人チャットへ戻る", func(t *testing.T) {
			call(t, h, admin, "POST", "/api/admin/guardian-links/restore", `{"guardian_id":"G004","child_id":"C004"}`)
			if rooms := roomIDsOf(t, h, miyagi); !rooms[personalRoom] {
				t.Fatalf("戻したあと: %v", rooms)
			}
			call(t, h, miyagi, "GET", "/api/chat/rooms/8/messages", "")
		})
	})
}

func TestChangePasswordEndsOtherSessions(t *testing.T) {
	a, h := newTestApp(t)
	sessionA := login(t, h, "kinjo@hoiku.example.jp", "pass1234", "staff")
	sessionB := loginAs(a, 5, "staff")
	other := loginAs(a, 3, "staff")

	call(t, h, sessionA, "POST", "/api/password", `{"current":"pass1234","next":"kawaru-pass-5678"}`)

	t.Run("変更した端末以外のセッションは切れる", func(t *testing.T) {
		expectStatus(t, request(t, h, sessionB, "GET", "/api/me", ""), http.StatusUnauthorized)
		expectStatus(t, request(t, h, sessionB, "GET", "/api/children", ""), http.StatusUnauthorized)
	})
	t.Run("変更した端末のセッションは続く", func(t *testing.T) {
		call(t, h, sessionA, "GET", "/api/children", "")
	})
	t.Run("ほかのアカウントのセッションには影響しない", func(t *testing.T) {
		call(t, h, other, "GET", "/api/children", "")
	})
}

func TestReissueTempPasswordEndsSessions(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	takanashi := loginAs(a, 3, "staff")

	call(t, h, admin, "POST", "/api/admin/accounts/3/temp-password", "")
	expectStatus(t, request(t, h, takanashi, "GET", "/api/me", ""), http.StatusUnauthorized)
	// 再発行した管理者のセッションは続く
	call(t, h, admin, "GET", "/api/children", "")
}

/*
 * ---- #159 の 2：一時パスワードの有効期限 ----
 * 一時パスワードでのログインなら、有効期限内かを判定する。期限切れなら管理者への連絡を案内する
 * （基本設計書「ログイン」(4-3)、メッセージ一覧 (4-9)「一時パスワードの期限切れ」）
 */
func TestExpiredTempPasswordCannotLogIn(t *testing.T) {
	a, h := newTestApp(t)

	t.Run("デモの一時パスワードは、起動した日から見て期限内にずらしてある", func(t *testing.T) {
		rec := send(t, h, nil, "POST", "/api/login",
			`{"email":"miyagi@hoiku.example.jp","password":"temp0901","entrance":"staff"}`)
		expectStatus(t, rec, http.StatusOK)
	})

	t.Run("期限の切れた一時パスワードでは、正しくてもログインできない", func(t *testing.T) {
		if _, err := a.db.Exec(`UPDATE m_account SET temp_password_expires_at = ? WHERE account_id = 4`,
			plusMinutes(now(), -1)); err != nil {
			t.Fatal(err)
		}
		rec := send(t, h, nil, "POST", "/api/login",
			`{"email":"miyagi@hoiku.example.jp","password":"temp0901","entrance":"staff"}`)
		expectStatus(t, rec, http.StatusUnauthorized)
		if kind := errorKindOf(t, rec); kind != "temp_expired" {
			t.Fatalf("kind = %q, want temp_expired", kind)
		}
		for _, c := range rec.Result().Cookies() {
			if c.Name == sessionCookie && c.Value != "" {
				t.Fatal("期限切れなのにセッションが作られた")
			}
		}
	})

	t.Run("誤ったパスワードでは、期限切れかどうかを明かさない", func(t *testing.T) {
		rec := send(t, h, nil, "POST", "/api/login",
			`{"email":"miyagi@hoiku.example.jp","password":"wrong-pass","entrance":"staff"}`)
		expectStatus(t, rec, http.StatusUnauthorized)
		if kind := errorKindOf(t, rec); kind != "credential" {
			t.Fatalf("kind = %q, want credential", kind)
		}
	})
}

/*
 * ---- #159 の 3：ログイン中は新しいログインを成立させない ----
 * ログイン中のセッションがある場合は認証を成立させず、既存のセッションを維持する。上書きログインは設けない
 * （基本設計書「ログイン」(4-3)）。入口の系統と一致するかを判定する。
 */
func TestNoOverwriteLogin(t *testing.T) {
	a, h := newTestApp(t)
	guardian := login(t, h, "miyagi.r@example.jp", "pass1234", "guardian")

	t.Run("保護者でログイン中に、管理者でログインしても成立しない", func(t *testing.T) {
		rec := send(t, h, guardian, "POST", "/api/login",
			`{"email":"nohara@hoiku.example.jp","password":"pass1234","entrance":"staff"}`)
		expectStatus(t, rec, http.StatusConflict)
		if kind := errorKindOf(t, rec); kind != "already_logged_in" {
			t.Fatalf("kind = %q, want already_logged_in", kind)
		}
		for _, c := range rec.Result().Cookies() {
			if c.Name == sessionCookie {
				t.Fatal("新しいセッションの Cookie が返った")
			}
		}
		// 既存のセッションは保護者のまま続く
		var me SessionUser
		if err := json.Unmarshal(call(t, h, guardian, "GET", "/api/me", "").Body.Bytes(), &me); err != nil {
			t.Fatal(err)
		}
		if me.AccountID != 9 {
			t.Fatalf("セッションの利用者が変わった: %+v", me)
		}
	})

	t.Run("ログイン中に新規登録しても成立しない", func(t *testing.T) {
		rec := send(t, h, guardian, "POST", "/api/signup",
			`{"code":"QRST-9012-UVWX","email":"another@example.jp","password":"pass-5678-x","guardian_name":"上園 次郎","relationship":"父"}`)
		expectStatus(t, rec, http.StatusConflict)
		var used int
		a.db.QueryRow(`SELECT COUNT(*) FROM m_account WHERE email = 'another@example.jp'`).Scan(&used)
		if used != 0 {
			t.Fatal("ログイン中なのにアカウントが作られた")
		}
	})

	t.Run("入口の系統が職員用・保護者用のどちらでもなければ、ログインを成立させない", func(t *testing.T) {
		for _, entrance := range []string{"", "x"} {
			rec := send(t, h, nil, "POST", "/api/login",
				`{"email":"nohara@hoiku.example.jp","password":"pass1234","entrance":"`+entrance+`"}`)
			expectStatus(t, rec, http.StatusBadRequest)
		}
	})

	t.Run("保護者ホームは保護者だけが使える", func(t *testing.T) {
		admin := loginAs(a, 1, "staff")
		expectStatus(t, request(t, h, admin, "GET", "/api/dashboard/guardian", ""), http.StatusForbidden)
		call(t, h, guardian, "GET", "/api/dashboard/guardian", "")
	})
}

/*
 * ---- #159 の 4：パスワードの長さ（8〜128文字）とよく使われるパスワード ----
 * 基本設計書「入力項目の制約値」(4-9)「パスワード｜8〜128文字」、「パスワードの要件」(6-3)「password などは拒否する」
 */
func TestPasswordRules(t *testing.T) {
	_, h := newTestApp(t)
	kinjo := login(t, h, "kinjo@hoiku.example.jp", "pass1234", "staff")
	current := "pass1234"
	change := func(next string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"current": current, "next": next})
		return send(t, h, kinjo, "POST", "/api/password", string(body))
	}

	t.Run("文字数で数える。日本語3文字は短すぎる", func(t *testing.T) {
		expectStatus(t, change("あいう"), http.StatusBadRequest)
	})
	t.Run("よく使われるパスワードは拒否する", func(t *testing.T) {
		expectStatus(t, change("password"), http.StatusBadRequest)
		expectStatus(t, change("Password"), http.StatusBadRequest)
		expectStatus(t, change("12345678"), http.StatusBadRequest)
	})
	t.Run("128文字を超えると理由を示して拒否する", func(t *testing.T) {
		rec := change(strings.Repeat("a", 129))
		expectStatus(t, rec, http.StatusBadRequest)
		if !strings.Contains(rec.Body.String(), "128") {
			t.Fatalf("上限を示していない: %s", rec.Body.String())
		}
	})

	// bcrypt は 72 バイトまでしか扱えない。英字 73 文字・ひらがな 25 文字（75 バイト）・128 文字も通し、
	// そのパスワードでログインできること
	for _, next := range []string{
		strings.Repeat("b", 73),
		strings.Repeat("ひ", 25),
		strings.Repeat("c", 127) + "d",
	} {
		next := next
		t.Run("72バイトを超える長さでも変更でき、ログインできる："+string([]rune(next)[:1])+"…", func(t *testing.T) {
			expectStatus(t, change(next), http.StatusOK)
			current = next
			body, _ := json.Marshal(map[string]string{"email": "kinjo@hoiku.example.jp", "password": next, "entrance": "staff"})
			expectStatus(t, send(t, h, nil, "POST", "/api/login", string(body)), http.StatusOK)
			// 末尾の1文字が違えば通らない（72バイトで切り捨てていないこと）
			wrong := string([]rune(next)[:len([]rune(next))-1]) + "z"
			body, _ = json.Marshal(map[string]string{"email": "kinjo@hoiku.example.jp", "password": wrong, "entrance": "staff"})
			expectStatus(t, send(t, h, nil, "POST", "/api/login", string(body)), http.StatusUnauthorized)
		})
	}

	t.Run("新規登録でも同じ規則にする", func(t *testing.T) {
		signUp := func(email, password string) *httptest.ResponseRecorder {
			body, _ := json.Marshal(map[string]any{
				"code": "GHIJ-7890-KLMN", "email": email, "password": password,
				"guardian_name": "高梨 次郎", "relationship": "父",
				"terms_agreed": true, "terms_version": "1.1", // 規約への同意（GitHub Issue #170）
			})
			return send(t, h, nil, "POST", "/api/signup", string(body))
		}
		expectStatus(t, signUp("short@example.jp", "あいう"), http.StatusBadRequest)
		expectStatus(t, signUp("common@example.jp", "password"), http.StatusBadRequest)
		expectStatus(t, signUp("toolong@example.jp", strings.Repeat("a", 129)), http.StatusBadRequest)
		expectStatus(t, signUp("long@example.jp", strings.Repeat("e", 73)), http.StatusOK)
	})
}

/*
 * ---- #159 の 5：パスワードを知らない人に、停止中であることを示さない ----
 * パスワードの照合より前に停止を判定すると、誤ったパスワードでも停止中と分かってしまう
 * （api_auth.go の「あるかどうかを推測させない文言に揃える」と同じ考え方）
 */
func TestSuspendedIsRevealedOnlyWithCorrectPassword(t *testing.T) {
	_, h := newTestApp(t)
	wrong := send(t, h, nil, "POST", "/api/login",
		`{"email":"takanashi.r@example.jp","password":"wrong-password","entrance":"guardian"}`)
	expectStatus(t, wrong, http.StatusUnauthorized)
	if kind := errorKindOf(t, wrong); kind != "credential" {
		t.Fatalf("誤ったパスワード: kind = %q, want credential", kind)
	}
	right := send(t, h, nil, "POST", "/api/login",
		`{"email":"takanashi.r@example.jp","password":"pass1234","entrance":"guardian"}`)
	expectStatus(t, right, http.StatusUnauthorized)
	if kind := errorKindOf(t, right); kind != "suspended" {
		t.Fatalf("正しいパスワード: kind = %q, want suspended", kind)
	}
}

/*
 * ---- #163 の 1：個人チャットを園児ID で結ぶ ----
 * 個人チャットのルームは園児単位で作る（基本設計書「チャット」(5-5)）。コードに紐づく園児と自動的に紐づける
 * （同「保護者アカウントの自己登録」(4-3)）。氏名の文字列で探すと、同じ氏名の別の園児の部屋に入る。
 */
func TestSignUpJoinsPersonalRoomOfThatChild(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	// ひまわり組に、さくら組の C001 と同じ氏名の園児を登録する
	call(t, h, admin, "POST", "/api/children", `{"mode":"create","child_id":"C023","child_name":"野原 太郎",
		"child_name_kana":"のはら たろう","birth_date":"2024-05-01","sex":"1","photo_consent_level":"2","class_id":2,
		"allergies":[],"medical_histories":[]}`)
	var issued struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(call(t, h, admin, "POST", "/api/admin/invitations",
		`{"child_id":"C023","valid_days":30}`).Body.Bytes(), &issued); err != nil {
		t.Fatal(err)
	}
	rec := send(t, h, nil, "POST", "/api/signup", `{"code":"`+issued.Code+`","email":"other.nohara@example.jp",
		"password":"hanako-5678","guardian_name":"野原 花子","relationship":"母","terms_agreed":true,"terms_version":"1.1"}`)
	expectStatus(t, rec, http.StatusOK)
	hanako := sessionCookieOf(t, rec)

	const otherFamilyRoom = 6 // C001（さくら組）の家庭の個人チャット「野原 太郎の保護者」
	if rooms := roomIDsOf(t, h, hanako); rooms[otherFamilyRoom] {
		t.Fatalf("同じ氏名の別の園児の個人チャットに入った: %v", rooms)
	}
	expectStatus(t, request(t, h, hanako, "GET", "/api/chat/rooms/6/messages", ""), http.StatusForbidden)
	expectStatus(t, request(t, h, hanako, "POST", "/api/chat/rooms/6/messages", `{"body":"明日はお休みします"}`),
		http.StatusForbidden)

	t.Run("日誌の共有も、同じ氏名の別の園児の家庭へ流さない", func(t *testing.T) {
		var before int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE chat_room_id = 6`).Scan(&before)
		a.shareDiaryToGuardian(&SessionUser{AccountID: 1}, 1, "C023")
		var after int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE chat_room_id = 6`).Scan(&after)
		if after != before {
			t.Fatalf("C023 の日誌の共有が C001 の家庭の個人チャットへ流れた（%d → %d 件）", before, after)
		}
	})

	t.Run("元の家庭（C001）の新しい保護者は、これまでどおり C001 の個人チャットへ入る", func(t *testing.T) {
		rec := send(t, h, nil, "POST", "/api/signup", `{"code":"ABCD-1234-EFGH","email":"nohara.m@example.jp",
			"password":"mama-5678-x","guardian_name":"野原 みさえ","relationship":"母","terms_agreed":true,"terms_version":"1.1"}`)
		expectStatus(t, rec, http.StatusOK)
		if rooms := roomIDsOf(t, h, sessionCookieOf(t, rec)); !rooms[otherFamilyRoom] {
			t.Fatalf("自児の個人チャットに入っていない: %v", rooms)
		}
	})
}

/*
 * ---- #163 の 2：招待コード 1 枚を同時に使っても、1 アカウントしか作らない ----
 * 1枚のコードは1アカウントの登録にのみ使える。使用と同時に status を使用済みにする（基本設計書 5-2）
 */
func TestInvitationCodeIsSingleUseUnderConcurrency(t *testing.T) {
	a, h := newTestApp(t)
	const attempts = 5
	codes := make([]int, attempts)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			body, _ := json.Marshal(map[string]any{
				"code": "OPQR-1234-STUV", "email": "dup" + string(rune('a'+i)) + "@example.jp",
				"password": "dup-pass-5678", "guardian_name": "宮城 次郎", "relationship": "父",
				"terms_agreed": true, "terms_version": "1.1",
			})
			req := httptest.NewRequest("POST", "/api/signup", strings.NewReader(string(body)))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			codes[i] = rec.Code
		}(i)
	}
	close(start)
	wg.Wait()

	ok := 0
	for _, c := range codes {
		if c == http.StatusOK {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("同時に %d 件送って %d 件が登録された（応答 %v）。1 件だけのはず", attempts, ok, codes)
	}
	var linked int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_guardian_child WHERE child_id = 'C004' AND link_status = '1'`).Scan(&linked)
	if linked != 2 { // デモデータの 宮城 蓮 と、新しく登録した 1 名
		t.Fatalf("C004 に有効な紐づけが %d 件ある。2 件のはず", linked)
	}
	var accounts int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_account WHERE email LIKE 'dup%@example.jp'`).Scan(&accounts)
	if accounts != 1 {
		t.Fatalf("アカウントが %d 件作られた", accounts)
	}
}

// 以前に作られたデータベース（m_chat_room に child_id が無い）を開くと、名前から園児を埋め、
// 名前で探していたときに別の家庭の個人チャットへ入った保護者を外す（db.go の ensurePersonalRoomChild）
func TestPersonalRoomChildIsAddedToOldDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`DROP INDEX ux_chat_room_child`,
		`ALTER TABLE m_chat_room DROP COLUMN child_id`,
		// 宮城 美咲（C004）の保護者が、名前で探した結果、野原 太郎（C001）の個人チャットに入っている状態
		`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at) VALUES (6, 9, '2026-10-01T10:00:00')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	db.Close()

	db, err = openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for room, child := range map[int]string{6: "C001", 7: "C002", 8: "C004", 9: "C005"} {
		var got sql.NullString
		db.QueryRow(`SELECT child_id FROM m_chat_room WHERE chat_room_id = ?`, room).Scan(&got)
		if got.String != child {
			t.Errorf("room %d: child_id = %q, want %s", room, got.String, child)
		}
	}
	var leftAt sql.NullString
	db.QueryRow(`SELECT left_at FROM t_chat_member WHERE chat_room_id = 6 AND account_id = 9`).Scan(&leftAt)
	if !leftAt.Valid {
		t.Error("別の家庭の個人チャットに入った保護者が外れていない")
	}
	db.QueryRow(`SELECT left_at FROM t_chat_member WHERE chat_room_id = 6 AND account_id = 6`).Scan(&leftAt)
	if leftAt.Valid {
		t.Error("その園児の保護者まで外れた")
	}
}
