package main

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

/*
 * ログイン・招待コードの試行の見張り（GitHub Issue #236 の 6、#159 の 5）
 *
 * 1. 送信元（IP）ごとの失敗の回数に上限を置く。
 *    ロックはアカウント単位なので、それだけでは、ログインIDを替えながらの総当たりと、
 *    招待コードの総当たり（未ログインで呼べる）を止められない。上限を超えた送信元には 429 を返す。
 *    数えるのは失敗だけにする。園内の端末が同じ IP から出るとき、朝に職員がそろってログインしても止めないため。
 *
 * 2. 存在しないログインIDへの失敗も、実在のアカウントと同じように数え、同じ回数でロックを返す。
 *    残りの試行回数は画面に出す決まり（画面詳細図「職員用トップ／保護者用トップ」(2-1) 項目7）だが、
 *    存在しないIDだけ「残り 5 回」のまま減らないと、それでIDの有無が分かってしまうため。
 *    回数はメモリだけに持つ（アカウントの行が無いので m_account には書けない）。サーバを起動し直すと消える。
 *
 * 【仮置き】送信元ごとの上限（15 分に 20 回）は設計に定めが無い（web/仮置き値.md）。
 */

const (
	ipFailureLimit  = 20
	ipFailureWindow = 15 * time.Minute
)

type ipFailures struct {
	count int
	since time.Time
}

type unknownLogin struct {
	count       int
	lockedUntil time.Time
	lastFailed  time.Time
}

type attemptGuard struct {
	mu      sync.Mutex
	ips     map[string]*ipFailures
	unknown map[string]*unknownLogin
}

func newAttemptGuard() *attemptGuard {
	return &attemptGuard{ips: map[string]*ipFailures{}, unknown: map[string]*unknownLogin{}}
}

// guard は試行の見張りを返す。テストのように app を直接組み立てたときも使えるよう、初めて呼ばれたときに作る
func (a *app) guard() *attemptGuard {
	a.guardOnce.Do(func() { a.attempts = newAttemptGuard() })
	return a.attempts
}

/*
clientIP は送信元の IP。送信元ごとの失敗の上限（GitHub Issue #236 の 6）が数える先になる。

公開先では、Go サーバは 127.0.0.1:8080 だけで待ち受け（deploy/oci-free/sukusuku.service の -addr）、
前段の Caddy が 443 を受けて reverse_proxy 127.0.0.1:8080 で渡す（deploy/oci-free/Caddyfile.ip）。
RemoteAddr だけを見ると、どの利用者も 127.0.0.1 になり、1人の失敗で全員のログインが止まる。
そこで、相手がループバック（127.0.0.0/8・::1）のときだけ、X-Forwarded-For のいちばん右の値を送信元とする。

  - Caddy の reverse_proxy は X-Forwarded-For を付ける。trusted_proxies を置かない既定では、
    外から来た X-Forwarded-* の値を捨て（"by default, the proxy will ignore their values from incoming
    requests, to prevent spoofing"）、Caddy が見た相手の IP だけを書く。
    典拠：https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults ・
    https://caddyserver.com/docs/caddyfile/options#trusted-proxies（"By default, no proxies are trusted."）・
    Caddy の modules/caddyhttp/reverseproxy/reverseproxy.go の addForwardedHeaders（信じない相手なら Set で相手の IP 1つにする）
  - いちばん右を取るのは、前段が足した値が右に並ぶため。左の値は外から偽れる。
  - 値が IP として読めなければ、RemoteAddr を使う。
  - ループバックでない相手からの X-Forwarded-For は信じない。外から直に来た要求は、ヘッダを偽れるため。
  - 手元の開発で Vite（5173）が /api を 8080 へ中継するときは、xfwd を付けていない（web/vite.config.ts）ので
    X-Forwarded-For を足さない。ヘッダが無ければ、今までどおり RemoteAddr になる。

Caddy に trusted_proxies を置く（CDN などを前に置く）ときは、いちばん右がその proxy の IP になるので、ここも見直す。
*/
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return host
	}
	if fwd := lastForwardedFor(r.Header); fwd != "" {
		return fwd
	}
	return host
}

// lastForwardedFor は、X-Forwarded-For のいちばん右の値を IP として返す。ヘッダが無い・IP として読めないときは空
func lastForwardedFor(h http.Header) string {
	lines := h.Values("X-Forwarded-For")
	if len(lines) == 0 {
		return ""
	}
	// ヘッダが複数の行に分かれて届いても、続けて1つの並びとして読む（RFC 9110 の 5.3）
	last := lines[len(lines)-1]
	if i := strings.LastIndex(last, ","); i >= 0 {
		last = last[i+1:]
	}
	ip := net.ParseIP(strings.TrimSpace(last))
	if ip == nil {
		return ""
	}
	return ip.String()
}

// blocked は、送信元が失敗の上限を超えているかを返す
func (g *attemptGuard) blocked(r *http.Request) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	f, ok := g.ips[clientIP(r)]
	if !ok {
		return false
	}
	if time.Since(f.since) > ipFailureWindow {
		delete(g.ips, clientIP(r))
		return false
	}
	return f.count >= ipFailureLimit
}

// failed は、送信元の失敗を1回数える
func (g *attemptGuard) failed(r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	// ついでに古いものを掃除する。数える先が増え続けないようにするため
	for ip, f := range g.ips {
		if now.Sub(f.since) > ipFailureWindow {
			delete(g.ips, ip)
		}
	}
	ip := clientIP(r)
	f, ok := g.ips[ip]
	if !ok {
		f = &ipFailures{since: now}
		g.ips[ip] = f
	}
	f.count++
}

/*
unknownFailed は、存在しないログインIDへの失敗を数え、実在のアカウントと同じ応答の材料を返す。
locked が真ならロック中（またはこの失敗でロックした）。そうでなければ remaining が残りの回数。
実在のアカウントと同じく、ロックが明けても回数は戻さない（handleLogin は成功するまで戻さない）。
*/
func (g *attemptGuard) unknownFailed(email string, maxFailed, lockMinutes int) (locked bool, remaining int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	// 1日以上失敗の無いものは掃除する
	for k, u := range g.unknown {
		if now.Sub(u.lastFailed) > 24*time.Hour && now.After(u.lockedUntil) {
			delete(g.unknown, k)
		}
	}
	key := strings.ToLower(email)
	u, ok := g.unknown[key]
	if !ok {
		u = &unknownLogin{}
		g.unknown[key] = u
	}
	u.lastFailed = now
	if now.Before(u.lockedUntil) {
		return true, 0
	}
	u.count++
	if u.count >= maxFailed {
		u.lockedUntil = now.Add(time.Duration(lockMinutes) * time.Minute)
		return true, 0
	}
	return false, maxFailed - u.count
}

// writeTooManyAttempts は、送信元の失敗が上限を超えたことを返す
func writeTooManyAttempts(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "900")
	writeJSON(w, http.StatusTooManyRequests, apiError{
		Kind:    "too_many_attempts",
		Message: "失敗が続いたため、しばらく受け付けを止めています。時間をおいてからお試しください",
	})
}
