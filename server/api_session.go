package main

import (
	"net/http"
	"time"
)

/*
 * 自動ログアウトの予告と「続ける」（GitHub Issue #210。2026-10-19 に持ち主が任せて決めた範囲）
 * 典拠：基本設計書.md「システムの利用方法」(2-2)・「ログイン」(4-3)「自動ログアウトは職員の画面に限り、
 *      最後の操作から時間を数える。午睡チェックの実施中は対象外」、WCAG 2.2 達成基準 2.2.1 タイミング調整可能（レベル A）
 *
 * 職員の画面は、切れる少し前に「まもなくログアウトします」と「続ける」を出す（web/src/components/SessionTimeoutWarning.tsx）。
 * 切れる時刻はサーバが決めて返す。画面は自分で数えた時刻を正とせず、予告を出す前・出している間・切れる時刻に尋ね直す。
 * 同じブラウザのほかのタブで操作・延長すると、同じセッションの期限が延びる。尋ね直せば延びた期限が返るので、
 * 画面は古い予告を出さない。
 *
 *   - GET  /api/session        … いまの期限を返す。尋ねるだけでは延ばさない（session.go の countsAsOperation）
 *   - POST /api/session/extend … 「続ける」。操作の1つとして期限を延ばし（requireLogin）、延びた期限を返す
 *
 * 保護者には自動ログアウトが無い（同 4-3）ので、期限を返さない。画面も保護者には予告を置かない。
 * 手続き（一時パスワード・規約の再同意）の途中は、ほかの機能と同じく 403 にする（requireUser）。予告は職員の共通レイアウトに
 * だけ置き、手続きの画面には置かない。
 * モック（web/src/api/mock.ts の sessionStatus・extendSession）も同じ規則を持つ。
 */

// SessionStatus は、ログインの期限（GET /api/session・POST /api/session/extend の応答）
type SessionStatus struct {
	// 無操作で切るか。職員の画面だけ真
	AutoLogout bool `json:"auto_logout"`
	// その職員が開始した午睡チェックが実施中で、いまは切らない。期限は決まっていない
	NapExempt bool `json:"nap_exempt"`
	// このまま操作が無ければ切れる時刻（JST、'YYYY-MM-DDTHH:MM:SS'）。決まっていないときは null
	ExpiresAt *string `json:"expires_at"`
	// 切れるまでの秒数（切り捨て）。0 のあいだはまだ使える。決まっていないときは null
	RemainingSeconds *int64 `json:"remaining_seconds"`
}

// handleSessionStatus は、いまの期限を返す。期限は延ばさない
func (a *app) handleSessionStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireUser(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, a.sessionStatusOf(r))
}

// handleExtendSession は、予告の「続ける」。requireUser（requireLogin）を通った時点で、操作として期限が延びている
func (a *app) handleExtendSession(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireUser(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, a.sessionStatusOf(r))
}

// sessionStatusOf は、要求のセッションの期限を求める。切れる時刻は sessionAccount の判定と同じ idleDeadline で求める
func (a *app) sessionStatusOf(r *http.Request) SessionStatus {
	sess, ok := a.sessions.lookup(sessionID(r))
	if !ok || !sess.idleLogout {
		return SessionStatus{}
	}
	at := a.sessions.now()
	deadline, napActive := a.idleDeadline(sess, at)
	if napActive {
		return SessionStatus{AutoLogout: true, NapExempt: true}
	}
	// ログインを保つ上限（「ログイン情報の記憶」の保存期間）が先に来るときは、そちらで切れる
	if deadline.After(sess.expiresAt) {
		deadline = sess.expiresAt
	}
	remaining := int64(deadline.Sub(at) / time.Second)
	if remaining < 0 {
		remaining = 0
	}
	expiresAt := deadline.In(jst).Format("2006-01-02T15:04:05")
	return SessionStatus{AutoLogout: true, ExpiresAt: &expiresAt, RemainingSeconds: &remaining}
}
