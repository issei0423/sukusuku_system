package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

/*
 * 送信元の IP の読み方（GitHub Issue #236 の 6）
 * 公開先は Caddy が 127.0.0.1:8080 へ中継する（deploy/oci-free/Caddyfile.ip）。
 * ループバックの相手からだけ X-Forwarded-For のいちばん右を信じ、ほかの相手からは信じない。
 */

func TestClientIPReadsForwardedForOnlyFromLoopback(t *testing.T) {
	cases := []struct {
		name   string
		remote string
		xff    []string // ヘッダの行。nil なら付けない
		want   string
	}{
		{"ループバック・ヘッダなし", "127.0.0.1:50000", nil, "127.0.0.1"},
		{"ループバック・1つ", "127.0.0.1:50000", []string{"203.0.113.5"}, "203.0.113.5"},
		{"ループバック・複数はいちばん右", "127.0.0.1:50000", []string{"198.51.100.9, 203.0.113.5"}, "203.0.113.5"},
		{"ループバック・空白を挟んだ複数", "127.0.0.1:50000", []string{" 198.51.100.9 ,203.0.113.5 "}, "203.0.113.5"},
		{"ループバック・複数の行は最後の行のいちばん右", "127.0.0.1:50000", []string{"198.51.100.9", "192.0.2.44, 203.0.113.5"}, "203.0.113.5"},
		{"ループバック・127.0.0.0/8 のほかの番地", "127.0.0.2:50000", []string{"203.0.113.5"}, "203.0.113.5"},
		{"ループバック・IPv6", "[::1]:50000", []string{"2001:db8::1"}, "2001:db8::1"},
		{"ループバック・IPv4 を IPv6 で書いた形は IPv4 にそろえる", "127.0.0.1:50000", []string{"::ffff:203.0.113.5"}, "203.0.113.5"},
		{"ループバック・IP として読めない", "127.0.0.1:50000", []string{"not-an-ip"}, "127.0.0.1"},
		{"ループバック・ポート付きは読めない", "127.0.0.1:50000", []string{"203.0.113.5:4321"}, "127.0.0.1"},
		{"ループバック・いちばん右が空", "127.0.0.1:50000", []string{"203.0.113.5, "}, "127.0.0.1"},
		{"ループバック・左だけ読めても、いちばん右が壊れていれば使わない", "127.0.0.1:50000", []string{"203.0.113.5, unknown"}, "127.0.0.1"},
		{"ループバック・値が空", "127.0.0.1:50000", []string{""}, "127.0.0.1"},
		{"ループバックでない・ヘッダは無視", "192.0.2.1:1234", []string{"203.0.113.5"}, "192.0.2.1"},
		{"ループバックでない・園内の番地でも無視", "10.0.0.8:1234", []string{"203.0.113.5"}, "10.0.0.8"},
		{"ループバックでない・IPv6 も無視", "[2001:db8::7]:1234", []string{"203.0.113.5"}, "2001:db8::7"},
		{"ループバックでない・ヘッダなし", "198.51.100.7:5555", nil, "198.51.100.7"},
		{"ポートの無い RemoteAddr はそのまま（ヘッダは信じない）", "@", []string{"203.0.113.5"}, "@"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/api/me", nil)
			r.RemoteAddr = c.remote
			for _, v := range c.xff {
				r.Header.Add("X-Forwarded-For", v)
			}
			if got := clientIP(r); got != c.want {
				t.Fatalf("clientIP = %q、%q になるはず", got, c.want)
			}
		})
	}
}

// sendFrom は、送信元（RemoteAddr）と X-Forwarded-For を指定して要求を送る。xff が空なら付けない
func sendFrom(t *testing.T, h http.Handler, remote, xff, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = remote
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestFailureLimitBehindProxyIsPerClient(t *testing.T) {
	_, h := newTestApp(t)
	const viaCaddy = "127.0.0.1:51234"
	const goodLogin = `{"email":"nishida@hoiku.example.jp","password":"pass1234","entrance":"staff"}`

	// Caddy の向こうの1人が、招待コードの総当たりで上限を超える
	for i := 0; i < ipFailureLimit; i++ {
		rec := sendFrom(t, h, viaCaddy, "203.0.113.5", "POST", "/api/invitation/verify", `{"code":"ZZZZ-ZZZZ-ZZZZ"}`)
		expectStatus(t, rec, http.StatusBadRequest)
	}
	rec := sendFrom(t, h, viaCaddy, "203.0.113.5", "POST", "/api/login", goodLogin)
	expectStatus(t, rec, http.StatusTooManyRequests)
	if kind := errorKindOf(t, rec); kind != "too_many_attempts" {
		t.Fatalf("kind = %q", kind)
	}

	// 同じ Caddy を通ってくるほかの利用者は止めない
	expectStatus(t, sendFrom(t, h, viaCaddy, "203.0.113.6", "POST", "/api/login", goodLogin), http.StatusOK)
	// Caddy を通らない手元からの要求（ヘッダなし）も止めない
	expectStatus(t, sendFrom(t, h, viaCaddy, "", "POST", "/api/login", goodLogin), http.StatusOK)
}

func TestFailureLimitIgnoresForwardedForFromOutside(t *testing.T) {
	_, h := newTestApp(t)
	const attacker = "198.51.100.20:40000"

	// 外から直に来た相手が X-Forwarded-For を毎回替えても、RemoteAddr で数えて止める
	for i := 0; i < ipFailureLimit; i++ {
		rec := sendFrom(t, h, attacker, "203.0.113."+strconv.Itoa(i+1), "POST", "/api/invitation/verify", `{"code":"ZZZZ-ZZZZ-ZZZZ"}`)
		expectStatus(t, rec, http.StatusBadRequest)
	}
	rec := sendFrom(t, h, attacker, "203.0.113.250", "POST", "/api/invitation/verify", `{"code":"ZZZZ-ZZZZ-ZZZZ"}`)
	expectStatus(t, rec, http.StatusTooManyRequests)

	// 偽ったヘッダの値の送信元は数えていない（Caddy の向こうの同じ値の利用者は止めない）
	expectStatus(t, sendFrom(t, h, "127.0.0.1:51234", "203.0.113.1", "POST", "/api/login",
		`{"email":"nishida@hoiku.example.jp","password":"pass1234","entrance":"staff"}`), http.StatusOK)
}
