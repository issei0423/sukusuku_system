package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*
 * 合言葉つきの URL でのログイン（api_demo_login.go）
 * 【仮置き】設計書に定めが無い演習用の入口。合言葉はテスト用の値で、本物ではない
 */

const testDemoKey = "test-demo-login-key-0123456789-abcdefghij"

func demoLoginCall(t *testing.T, h http.Handler, cookies []*http.Cookie, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/demo-login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func demoBody(key, as string) string {
	b, _ := json.Marshal(map[string]string{"key": key, "as": as})
	return string(b)
}

func TestDemoLoginIsAbsentWithoutKey(t *testing.T) {
	_, h := newTestApp(t)
	// 未設定（空）なら 404。合言葉を送っても同じ
	expectStatus(t, demoLoginCall(t, h, nil, demoBody(testDemoKey, "staff")), http.StatusNotFound)
	expectStatus(t, demoLoginCall(t, h, nil, demoBody("", "staff")), http.StatusNotFound)
}

func TestDemoLoginShortKeyIsInvalid(t *testing.T) {
	a, h := newTestApp(t)
	short := strings.Repeat("a", demoLoginKeyMinLen-1)
	a.demoLoginKey = short
	// 短い値は、その値を送っても通らない
	expectStatus(t, demoLoginCall(t, h, nil, demoBody(short, "staff")), http.StatusNotFound)
	// ちょうど最小の長さなら使える
	ok := strings.Repeat("a", demoLoginKeyMinLen)
	a.demoLoginKey = ok
	expectStatus(t, demoLoginCall(t, h, nil, demoBody(ok, "staff")), http.StatusOK)
}

func TestDemoLoginKeyFromEnv(t *testing.T) {
	t.Setenv("SUKUSUKU_DEMO_LOGIN_KEY", "")
	if got := demoLoginKeyFromEnv(); got != "" {
		t.Fatalf("未設定なのに値がある: %q", got)
	}
	t.Setenv("SUKUSUKU_DEMO_LOGIN_KEY", strings.Repeat("b", demoLoginKeyMinLen-1))
	if got := demoLoginKeyFromEnv(); got != "" {
		t.Fatal("短い値は無効のはず")
	}
	t.Setenv("SUKUSUKU_DEMO_LOGIN_KEY", "  "+testDemoKey+"\n")
	if got := demoLoginKeyFromEnv(); got != testDemoKey {
		t.Fatalf("前後の空白を除いた値になるはず: %q", got)
	}
}

func TestDemoLoginWrongKeyIsNotFoundAndCounts(t *testing.T) {
	a, h := newTestApp(t)
	a.demoLoginKey = testDemoKey
	rec := demoLoginCall(t, h, nil, demoBody(testDemoKey+"x", "staff"))
	expectStatus(t, rec, http.StatusNotFound)
	// 機能が無いときと同じ応答（有無を悟らせない）
	_, offH := newTestApp(t)
	offRec := demoLoginCall(t, offH, nil, demoBody(testDemoKey, "staff"))
	if rec.Body.String() != offRec.Body.String() {
		t.Fatalf("応答が違う: %q と %q", rec.Body.String(), offRec.Body.String())
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("失敗でセッションを作ってはいけない")
	}
	// 失敗は送信元ごとの数に入る（ほかの口の失敗と合わせて上限になる）。上のを含めて上限の回数
	for i := 1; i < ipFailureLimit; i++ {
		expectStatus(t, demoLoginCall(t, h, nil, demoBody("wrong", "staff")), http.StatusNotFound)
	}
	if !a.guard().blocked(httptest.NewRequest("POST", "/api/login", nil)) {
		t.Fatal("失敗が上限に達したのに、送信元が止まっていない")
	}
}

func TestDemoLoginBlockedSourceIsRefusedEvenWithRightKey(t *testing.T) {
	a, h := newTestApp(t)
	a.demoLoginKey = testDemoKey
	for i := 0; i < ipFailureLimit; i++ {
		expectStatus(t, demoLoginCall(t, h, nil, demoBody("wrong", "staff")), http.StatusNotFound)
	}
	rec := demoLoginCall(t, h, nil, demoBody(testDemoKey, "staff"))
	expectStatus(t, rec, http.StatusNotFound)
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("止めた送信元にセッションを作ってはいけない")
	}
}

func TestDemoLoginCreatesSessionForEachEntrance(t *testing.T) {
	cases := []struct {
		as, email, role string
	}{
		{"staff", "nishida@hoiku.example.jp", "1"},
		{"guardian", "nishida.t@example.jp", "3"},
	}
	for _, c := range cases {
		t.Run(c.as, func(t *testing.T) {
			a, h := newTestApp(t)
			a.demoLoginKey = testDemoKey
			rec := demoLoginCall(t, h, nil, demoBody(testDemoKey, c.as))
			expectStatus(t, rec, http.StatusOK)
			var u struct {
				Email string `json:"email"`
				Role  string `json:"role"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &u); err != nil {
				t.Fatal(err)
			}
			cookies := rec.Result().Cookies()
			if len(cookies) != 1 || cookies[0].Name != sessionCookie {
				t.Fatalf("セッションの Cookie が1つ付くはず: %v", cookies)
			}
			// handleLogin と同じ属性（記憶なし＝ブラウザを閉じると消える・HttpOnly・SameSite=Strict）
			if !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].MaxAge != 0 {
				t.Fatalf("Cookie の属性が handleLogin と違う: %+v", cookies[0])
			}
			me := call(t, h, cookies[0], "GET", "/api/me", "")
			u.Email, u.Role = "", ""
			if err := json.Unmarshal(me.Body.Bytes(), &u); err != nil {
				t.Fatal(err)
			}
			if u.Email != c.email || u.Role != c.role {
				t.Fatalf("/api/me = %+v、%s のはず", u, c.email)
			}
			// 職員の入口は、通常のログインと同じく自動ログアウトの対象
			a.sessions.mu.Lock()
			defer a.sessions.mu.Unlock()
			s := a.sessions.data[cookies[0].Value]
			if s.entrance != c.as || s.idleLogout != (c.as == "staff") {
				t.Fatalf("セッションの作りが handleLogin と違う: %+v", s)
			}
		})
	}
}

func TestDemoLoginRejectsBadEntrance(t *testing.T) {
	a, h := newTestApp(t)
	a.demoLoginKey = testDemoKey
	for _, as := range []string{"", "admin", "Staff"} {
		rec := demoLoginCall(t, h, nil, demoBody(testDemoKey, as))
		expectStatus(t, rec, http.StatusBadRequest)
		if len(rec.Result().Cookies()) != 0 {
			t.Fatal("入口が不正でセッションを作ってはいけない")
		}
	}
	// 合言葉が違えば、入口が不正でも 400 でなく 404（有無を悟らせない）
	expectStatus(t, demoLoginCall(t, h, nil, demoBody("wrong", "admin")), http.StatusNotFound)
}

func TestDemoLoginRefusesWhenAlreadyLoggedIn(t *testing.T) {
	a, h := newTestApp(t)
	a.demoLoginKey = testDemoKey
	c := loginAs(a, 1, "staff")
	rec := demoLoginCall(t, h, []*http.Cookie{c}, demoBody(testDemoKey, "guardian"))
	expectStatus(t, rec, http.StatusConflict)
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("ログイン中に新しいセッションを作ってはいけない")
	}
}

func TestDemoLoginSuspendedAccountIsRefused(t *testing.T) {
	a, h := newTestApp(t)
	a.demoLoginKey = testDemoKey
	if _, err := a.db.Exec(`UPDATE m_account SET status = ? WHERE email = ?`, accountSuspended, demoLoginGuardianEmail); err != nil {
		t.Fatal(err)
	}
	rec := demoLoginCall(t, h, nil, demoBody(testDemoKey, "guardian"))
	expectStatus(t, rec, http.StatusForbidden)
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("停止中のアカウントにセッションを作ってはいけない")
	}
}

func TestDemoLoginMissingAccountIsNotFound(t *testing.T) {
	a, h := newTestApp(t)
	a.demoLoginKey = testDemoKey
	if _, err := a.db.Exec(`UPDATE m_account SET email = 'moved@example.jp' WHERE email = ?`, demoLoginStaffEmail); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, demoLoginCall(t, h, nil, demoBody(testDemoKey, "staff")), http.StatusNotFound)
}

func TestDemoLoginLeavesOperationLog(t *testing.T) {
	a, h := newTestApp(t)
	a.demoLoginKey = testDemoKey
	count := func() int {
		var n int
		if err := a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log
			WHERE account_id = 1 AND function_type = ? AND after_value = ?`, fnAccount, "合言葉のURLでログイン").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// 失敗は操作ログに残さない（入れる先のアカウントが無い）
	expectStatus(t, demoLoginCall(t, h, nil, demoBody("wrong", "staff")), http.StatusNotFound)
	if count() != 0 {
		t.Fatal("失敗でログが残っている")
	}
	expectStatus(t, demoLoginCall(t, h, nil, demoBody(testDemoKey, "staff")), http.StatusOK)
	if count() != 1 {
		t.Fatalf("成功のログが1件残るはず: %d", count())
	}
}

func TestDemoLoginKeyNeverAppearsInResponses(t *testing.T) {
	a, h := newTestApp(t)
	a.demoLoginKey = testDemoKey
	for _, body := range []string{demoBody("wrong", "staff"), demoBody(testDemoKey, "x"), demoBody(testDemoKey, "staff")} {
		rec := demoLoginCall(t, h, nil, body)
		if strings.Contains(rec.Body.String(), testDemoKey) {
			t.Fatalf("応答に合言葉が出ている: %s", rec.Body.String())
		}
	}
}
