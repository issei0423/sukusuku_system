package main

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

/*
 * 自動ログアウトの予告と「続ける」：期限をサーバが決めて返し、「続ける」で延ばす（GitHub Issue #210）
 * 典拠：基本設計書.md「ログイン」(4-3)「自動ログアウトは職員の画面に限り、最後の操作から時間を数える。
 *      午睡チェックの実施中は対象外」、WCAG 2.2 達成基準 2.2.1 タイミング調整可能（レベル A）
 *
 * 画面（web/src/components/SessionTimeoutWarning.tsx）は、予告を出す前・出している間・切れる時刻に、
 * GET /api/session で期限を尋ね直す。期限を尋ねる要求は操作に数えない（尋ねるたびに延びると、切れなくなる）。
 * 同じブラウザのほかのタブで操作・延長すると同じセッションの期限が延びるので、尋ね直せば延びた期限が返る。
 *
 * モック（web/src/api/mock.ts の sessionStatus・extendSession）にも同じ規則があり、web/tests/sessionTimeout.test.ts で確かめる。
 * 時計の止め方は api_session_idle_test.go と同じ（useFakeClock・idleTestStart）。
 */

// getSessionStatus は GET /api/session を送り、応答の期限を読む
func getSessionStatus(t *testing.T, h http.Handler, c *http.Cookie) SessionStatus {
	t.Helper()
	rec := send(t, h, c, "GET", "/api/session", "")
	expectStatus(t, rec, http.StatusOK)
	return decodeSessionStatus(t, rec.Body.Bytes())
}

func decodeSessionStatus(t *testing.T, body []byte) SessionStatus {
	t.Helper()
	var st SessionStatus
	if err := json.Unmarshal(body, &st); err != nil {
		t.Fatalf("期限の応答を読めない: %v (body: %s)", err, body)
	}
	return st
}

// expectDeadline は、職員の期限が want の時刻（残り remaining 秒）であることを確かめる
func expectDeadline(t *testing.T, st SessionStatus, want time.Time, remaining int64) {
	t.Helper()
	if !st.AutoLogout || st.NapExempt {
		t.Fatalf("auto_logout = %v, nap_exempt = %v, want true, false", st.AutoLogout, st.NapExempt)
	}
	wantAt := want.In(jst).Format("2006-01-02T15:04:05")
	if st.ExpiresAt == nil || *st.ExpiresAt != wantAt {
		t.Fatalf("expires_at = %v, want %s", deref(st.ExpiresAt), wantAt)
	}
	if st.RemainingSeconds == nil || *st.RemainingSeconds != remaining {
		t.Fatalf("remaining_seconds = %v, want %d", derefInt(st.RemainingSeconds), remaining)
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func derefInt(n *int64) any {
	if n == nil {
		return "<nil>"
	}
	return *n
}

func TestSessionStatusReturnsServerDeadline(t *testing.T) {
	a, h := newTestApp(t)
	start := idleTestStart()
	clock := useFakeClock(a, start)
	c := login(t, h, "kinjo@hoiku.example.jp", "pass1234", "staff")

	// 期限はログイン（最初の操作）から30分。サーバが時刻と残りの秒数を返す
	expectDeadline(t, getSessionStatus(t, h, c), start.Add(30*time.Minute), 1800)

	// 期限を尋ねても延びない
	clock.advance(10 * time.Minute)
	expectDeadline(t, getSessionStatus(t, h, c), start.Add(30*time.Minute), 1200)

	// 30分ちょうどまでは使える。過ぎたら尋ねる要求も 401（画面はこれで入口へ戻る）
	clock.advance(20 * time.Minute)
	expectDeadline(t, getSessionStatus(t, h, c), start.Add(30*time.Minute), 0)
	clock.advance(time.Second)
	expectStatus(t, send(t, h, c, "GET", "/api/session", ""), http.StatusUnauthorized)
}

func TestSessionStatusFollowsOperationsInOtherTabs(t *testing.T) {
	a, h := newTestApp(t)
	start := idleTestStart()
	clock := useFakeClock(a, start)
	c := login(t, h, "kinjo@hoiku.example.jp", "pass1234", "staff")

	// 予告を出す少し前に、同じブラウザのほかのタブ（同じ Cookie）で操作した。尋ね直せば延びた期限が返る
	clock.advance(27 * time.Minute)
	expectGet(t, h, c, "/api/children", false, http.StatusOK)
	expectDeadline(t, getSessionStatus(t, h, c), start.Add(57*time.Minute), 1800)

	// ほかのタブの裏の読み直しは延ばさない
	clock.advance(time.Minute)
	expectGet(t, h, c, "/api/dashboard/staff", true, http.StatusOK)
	expectDeadline(t, getSessionStatus(t, h, c), start.Add(57*time.Minute), 1740)
}

func TestExtendSession(t *testing.T) {
	a, h := newTestApp(t)
	start := idleTestStart()
	clock := useFakeClock(a, start)
	c := login(t, h, "kinjo@hoiku.example.jp", "pass1234", "staff")

	// 予告が出ている（残り2分）ところで「続ける」を押した。押した時刻から30分に延び、延びた期限を返す
	clock.advance(28 * time.Minute)
	rec := send(t, h, c, "POST", "/api/session/extend", "{}")
	expectStatus(t, rec, http.StatusOK)
	expectDeadline(t, decodeSessionStatus(t, rec.Body.Bytes()), start.Add(58*time.Minute), 1800)

	// ログインから57分。延ばさなければ30分で切れていた
	clock.advance(29 * time.Minute)
	expectGet(t, h, c, "/api/me", true, http.StatusOK)

	// 延ばした時刻から30分を過ぎたら切れる。切れたあとは「続ける」を押しても戻らない
	clock.advance(time.Minute + time.Second)
	expectStatus(t, send(t, h, c, "POST", "/api/session/extend", "{}"), http.StatusUnauthorized)
	expectStatus(t, send(t, h, c, "GET", "/api/session", ""), http.StatusUnauthorized)
}

func TestSessionStatusDuringNapCheck(t *testing.T) {
	a, h := newTestApp(t)
	start := idleTestStart()
	clock := useFakeClock(a, start)
	day := start.Format("2006-01-02")

	teacher := login(t, h, "takanashi@hoiku.example.jp", "pass1234", "staff") // S003。さくら組の担任
	admin := login(t, h, "nohara@hoiku.example.jp", "pass1234", "staff")      // S001。実施を開始していない
	// 13:05 に高梨がさくら組の午睡チェックを開始した
	if _, err := a.db.Exec(`INSERT INTO t_nap_session (class_id, session_date, started_staff_id, started_at, is_auto_closed)
		VALUES (1, ?, 'S003', ?, 0)`, day, day+"T13:05:00"); err != nil {
		t.Fatal(err)
	}

	// 実施中は切らないので、期限は決まっていない。画面は予告を出さない
	clock.t = at(start, 13, 34, 0)
	st := getSessionStatus(t, h, teacher)
	if !st.AutoLogout || !st.NapExempt || st.ExpiresAt != nil || st.RemainingSeconds != nil {
		t.Fatalf("午睡チェックの実施中の期限 = %+v (expires_at=%v), want nap_exempt で期限なし", st, deref(st.ExpiresAt))
	}
	// 実施を開始していない職員には、ふだんどおりの期限を返す（ログインの 13:05 から30分）
	expectDeadline(t, getSessionStatus(t, h, admin), start.Add(30*time.Minute), 60)

	// 終了の操作を忘れたまま、午睡の時間帯（13:00-15:00）が終わった。15:00 から数え直した期限を返す
	clock.t = at(start, 15, 10, 0)
	expectDeadline(t, getSessionStatus(t, h, teacher), at(start, 15, 30, 0), 1200)
}

func TestGuardianSessionStatusHasNoAutoLogout(t *testing.T) {
	a, h := newTestApp(t)
	useFakeClock(a, idleTestStart())

	// 保護者には自動ログアウトが無いので、予告の期限も返さない（画面も保護者には予告を置かない）
	c := loginRemember(t, h, "nohara.i@example.jp", "guardian", false)
	st := getSessionStatus(t, h, c)
	if st.AutoLogout || st.NapExempt || st.ExpiresAt != nil || st.RemainingSeconds != nil {
		t.Fatalf("保護者の期限 = %+v, want 自動ログアウトなし", st)
	}
}

func TestSessionStatusRequiresLogin(t *testing.T) {
	_, h := newTestApp(t)
	expectStatus(t, send(t, h, nil, "GET", "/api/session", ""), http.StatusUnauthorized)
	expectStatus(t, send(t, h, nil, "POST", "/api/session/extend", "{}"), http.StatusUnauthorized)
}
