package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

/*
 * セキュリティで気づいた点（GitHub Issue #236）
 * 推測されてはならない値の作り方・応答ヘッダ・Cookie・セッションの掃除・静的ファイルの配信を確かめる。
 */

// ---- #236 の 1：一時パスワード ----

func TestTempPasswordIsHardToGuess(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	rec := call(t, h, admin, "POST", "/api/admin/accounts/3/temp-password", "")
	var out struct {
		Password string `json:"password"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	// 以前の「temp」＋4桁（9000通り）の形でない。紛らわしい文字を除いた英小文字と数字を 4 文字ずつ 3 組
	if !regexp.MustCompile(`^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$`).MatchString(out.Password) {
		t.Fatalf("一時パスワードの形が違う: %q", out.Password)
	}
	// 発行した一時パスワードでログインできる
	login(t, h, "takanashi@hoiku.example.jp", out.Password, "staff")

	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		p := randomPassword()
		if seen[p] {
			t.Fatalf("200 回のうちに同じ一時パスワードが出た: %q", p)
		}
		seen[p] = true
	}
}

// ---- #236 の 2：招待コード ----

func TestInvitationCodeShape(t *testing.T) {
	pattern := regexp.MustCompile(`^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$`)
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		c := randomCode()
		if !pattern.MatchString(c) {
			t.Fatalf("招待コードの形が違う: %q", c)
		}
		if seen[c] {
			t.Fatalf("200 回のうちに同じ招待コードが出た: %q", c)
		}
		seen[c] = true
	}
}

// ---- #236 の 3・4：応答ヘッダ ----

func TestSecurityHeaders(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})

	get := func(h http.Handler, path string) http.Header {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec.Result().Header
	}

	api := get(securityHeaders(ok, false), "/api/me")
	for name, want := range map[string]string{
		"Content-Security-Policy": contentSecurityPolicy,
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "same-origin",
		"Cache-Control":           "no-store",
	} {
		if got := api.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if !strings.Contains(api.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Error("ほかのサイトの枠に入れさせない指定が無い")
	}
	if api.Get("Strict-Transport-Security") != "" {
		t.Error("-secure でないのに HSTS を付けている（localhost の http がつながらなくなる）")
	}

	// 画面のファイルはキャッシュしてよい
	if got := get(securityHeaders(ok, false), "/assets/index.js").Get("Cache-Control"); got != "" {
		t.Errorf("画面のファイルに Cache-Control = %q", got)
	}
	if got := get(securityHeaders(ok, true), "/").Get("Strict-Transport-Security"); got == "" {
		t.Error("-secure なのに HSTS が無い")
	}
}

func TestSessionCookieSecureFollowsFlag(t *testing.T) {
	for _, secure := range []bool{false, true} {
		s := newSessionStore()
		s.secure = secure

		rec := httptest.NewRecorder()
		s.create(rec, 1, "staff", 30)
		c := rec.Result().Cookies()[0]
		if c.Secure != secure || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode {
			t.Errorf("secure=%v: Cookie = %+v", secure, c)
		}

		// ログアウトで消す Cookie にも同じ属性を付ける
		req := httptest.NewRequest("POST", "/api/logout", nil)
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: c.Value})
		rec = httptest.NewRecorder()
		s.destroy(rec, req)
		c = rec.Result().Cookies()[0]
		if c.Secure != secure || c.SameSite != http.SameSiteStrictMode || c.MaxAge >= 0 {
			t.Errorf("secure=%v: 消す Cookie = %+v", secure, c)
		}
	}
}

// ---- #236 の 7：存在しないログインIDでも照合する ----

func TestUnknownLoginIDIsCheckedAgainstDummyHash(t *testing.T) {
	// どのパスワードとも一致しない
	for _, p := range []string{"", "password", "pass1234"} {
		if checkPassword(dummyPasswordHash(), p) {
			t.Fatalf("照合用のハッシュが %q と一致した", p)
		}
	}
	_, h := newTestApp(t)
	rec := send(t, h, nil, "POST", "/api/login",
		`{"email":"nobody@hoiku.example.jp","password":"pass1234","entrance":"staff"}`)
	expectStatus(t, rec, http.StatusUnauthorized)
	if kind := errorKindOf(t, rec); kind != "credential" {
		t.Fatalf("kind = %q", kind)
	}
}

// ---- #236 の 9：期限の切れたセッションの掃除 ----

func TestExpiredSessionsArePurged(t *testing.T) {
	s := newSessionStore()
	s.data["old"] = session{accountID: 1, expiresAt: time.Now().Add(-time.Minute)}
	s.data["live"] = session{accountID: 2, expiresAt: time.Now().Add(time.Hour)}

	s.create(httptest.NewRecorder(), 3, "staff", 30)

	if _, ok := s.data["old"]; ok {
		t.Error("期限の切れたセッションが残っている")
	}
	if _, ok := s.data["live"]; !ok {
		t.Error("期限内のセッションまで消えた")
	}
	if len(s.data) != 2 {
		t.Errorf("セッションの数 = %d, want 2", len(s.data))
	}
}

// ---- #236 の 10：静的ファイルの配信でディレクトリの一覧を出さない ----

func TestServeWebDoesNotListDirectories(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html>index"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	(&app{}).serveWeb(mux, dir)

	get := func(path string) string {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec.Body.String()
	}
	if body := get("/assets/"); strings.Contains(body, "app.js") || !strings.Contains(body, "index") {
		t.Errorf("/assets/ が一覧を返した: %q", body)
	}
	if body := get("/assets/app.js"); body != "console.log(1)" {
		t.Errorf("/assets/app.js = %q", body)
	}
	if body := get("/staff/diary/1"); !strings.Contains(body, "index") {
		t.Errorf("画面の経路が index.html に寄らない: %q", body)
	}
}

// ---- #159 の 5：存在しないログインIDも、残りの回数とロックが実在のアカウントと同じに進む ----

func TestUnknownLoginIDCountsDownLikeRealAccount(t *testing.T) {
	_, h := newTestApp(t)
	remainingOf := func(email string) []any {
		var out []any
		for i := 0; i < 6; i++ {
			rec := send(t, h, nil, "POST", "/api/login",
				`{"email":"`+email+`","password":"wrong-pass","entrance":"staff"}`)
			var body apiError
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Kind == "credential" {
				out = append(out, body.Remaining)
			} else {
				out = append(out, body.Kind)
			}
		}
		return out
	}
	real := remainingOf("kinjo@hoiku.example.jp")
	unknown := remainingOf("nobody@hoiku.example.jp")
	want := []any{4, 3, 2, 1, "locked", "locked"}
	for i := range want {
		if real[i] != want[i] || unknown[i] != want[i] {
			t.Fatalf("実在: %v / 存在しない: %v、どちらも %v になるはず", real, unknown, want)
		}
	}
}

// ---- #236 の 6：送信元ごとの失敗の上限 ----

func TestTooManyFailuresFromOneAddressAreRefused(t *testing.T) {
	_, h := newTestApp(t)
	// 招待コードの総当たり。上限までは理由を返し、超えたら 429
	for i := 0; i < ipFailureLimit; i++ {
		rec := send(t, h, nil, "POST", "/api/invitation/verify", `{"code":"ZZZZ-ZZZZ-ZZZZ"}`)
		expectStatus(t, rec, http.StatusBadRequest)
	}
	rec := send(t, h, nil, "POST", "/api/invitation/verify", `{"code":"ABCD-1234-EFGH"}`)
	expectStatus(t, rec, http.StatusTooManyRequests)
	if kind := errorKindOf(t, rec); kind != "too_many_attempts" {
		t.Fatalf("kind = %q", kind)
	}
	// 同じ送信元からは、正しいパスワードのログインも新規登録も止める
	expectStatus(t, send(t, h, nil, "POST", "/api/login",
		`{"email":"nohara@hoiku.example.jp","password":"pass1234","entrance":"staff"}`), http.StatusTooManyRequests)
	expectStatus(t, send(t, h, nil, "POST", "/api/signup", `{"code":"ABCD-1234-EFGH"}`), http.StatusTooManyRequests)

	// ほかの送信元は止めない
	req := httptest.NewRequest("POST", "/api/login",
		strings.NewReader(`{"email":"nohara@hoiku.example.jp","password":"pass1234","entrance":"staff"}`))
	req.RemoteAddr = "198.51.100.7:5555"
	other := httptest.NewRecorder()
	h.ServeHTTP(other, req)
	expectStatus(t, other, http.StatusOK)
}

func TestSuccessfulLoginsAreNotCounted(t *testing.T) {
	a, h := newTestApp(t)
	// 園内の端末が同じ送信元でも、成功したログインは数えない（朝にそろってログインしても止めない）
	for i := 0; i < ipFailureLimit+5; i++ {
		login(t, h, "nohara@hoiku.example.jp", "pass1234", "staff")
		a.sessions.destroyAccount(1, "")
	}
}
