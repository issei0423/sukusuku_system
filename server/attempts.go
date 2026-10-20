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

// clientIP は送信元の IP。前段の proxy は置かない構成なので、X-Forwarded-For は信じない
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
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
