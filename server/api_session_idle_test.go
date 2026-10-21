package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

/*
 * ログインの期限：自動ログアウトを最後の操作から数える（GitHub Issue #210）
 * 典拠：基本設計書.md「システムの利用方法」(2-2)・「ログイン」(4-3)「自動ログアウトは職員の画面に限る。
 *      最後の操作から時間を数える（午睡チェックの実施中は対象外）」・「午睡チェックの実施」(4-7)・
 *      「リアルタイムの反映と通知」(4-10)「知らせの受け取りは、職員の自動ログアウトの『操作』に数えない」
 *      要件定義書.md「『ログイン情報の記憶』と自動ログアウトの関係」・「午睡チェック中の例外」(4-1-4 (4))
 *
 * モック（web/src/api/mock.ts）も同じ数え方で期限を返す（sessionStatus。web/tests/sessionTimeout.test.ts）が、
 * 切れたあとにほかの api を拒むことはしない。切る判定（401）はサーバだけにあり、ここで確かめる。
 *
 * 時間はセッションの時計（sessionStore.now）を止めて手で進める。午睡の実施は、デモデータの実施（今日まで）と
 * 重ならないよう1年先の日に置く。本物の時計で回る午睡の自動の解除（autoCloseNapSessions）にも閉じられない
 */

type fakeClock struct{ t time.Time }

func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

// useFakeClock は、セッションの時計を start で止める。返した時計を進めると、セッションの時刻も進む
func useFakeClock(a *app, start time.Time) *fakeClock {
	c := &fakeClock{t: start}
	a.sessions.now = func() time.Time { return c.t }
	return c
}

// idleTestStart は、試しに使う時刻。1年先の日の 13:05（午睡の時間帯 13:00-15:00 の中）
func idleTestStart() time.Time {
	d := time.Now().In(jst).AddDate(1, 0, 0)
	return time.Date(d.Year(), d.Month(), d.Day(), 13, 5, 0, 0, jst)
}

// at は、その日の時刻（JST）
func at(day time.Time, hour, min, sec int) time.Time {
	return time.Date(day.Year(), day.Month(), day.Day(), hour, min, sec, 0, jst)
}

// expectGet は GET を送り、応答の番号を確かめる。auto なら、画面の裏の読み直しの印を付ける（web/src/api/automatic.ts）
func expectGet(t *testing.T, h http.Handler, c *http.Cookie, path string, auto bool, want int) {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	req.AddCookie(c)
	if auto {
		req.Header.Set(autoRefreshHeader, "1")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != want {
		t.Fatalf("GET %s (auto=%v): status = %d, want %d (body: %s)", path, auto, rec.Code, want, rec.Body.String())
	}
}

// loginRemember は、「ログイン情報の記憶」を付けて（または付けずに）ログインし、応答が渡した Cookie をそのまま返す
func loginRemember(t *testing.T, h http.Handler, email, entrance string, remember bool) *http.Cookie {
	t.Helper()
	flag := "false"
	if remember {
		flag = "true"
	}
	rec := send(t, h, nil, "POST", "/api/login",
		`{"email":"`+email+`","password":"pass1234","entrance":"`+entrance+`","remember":`+flag+`}`)
	expectStatus(t, rec, http.StatusOK)
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			return c
		}
	}
	t.Fatalf("セッションの Cookie が返っていない")
	return nil
}

func TestStaffAutoLogoutCountsFromLastOperation(t *testing.T) {
	a, h := newTestApp(t)
	clock := useFakeClock(a, idleTestStart())
	c := login(t, h, "kinjo@hoiku.example.jp", "pass1234", "staff")

	// ログインから20分後と40分後に操作する。ログインから数えるなら、40分後には切れている
	clock.advance(20 * time.Minute)
	expectGet(t, h, c, "/api/children", false, http.StatusOK)
	clock.advance(20 * time.Minute)
	expectGet(t, h, c, "/api/me", false, http.StatusOK)

	// 最後の操作から30分ちょうどまでは使える（裏の読み直しで確かめ、期限は延ばさない）
	clock.advance(30 * time.Minute)
	expectGet(t, h, c, "/api/me", true, http.StatusOK)

	// 30分を過ぎたら 401。そのあとに操作しても戻らない
	clock.advance(time.Second)
	expectGet(t, h, c, "/api/me", true, http.StatusUnauthorized)
	expectGet(t, h, c, "/api/me", false, http.StatusUnauthorized)

	// 切れたセッションはログイン中とみなさない。同じブラウザで、ログインし直せる（409 にならない）
	rec := send(t, h, c, "POST", "/api/login",
		`{"email":"kinjo@hoiku.example.jp","password":"pass1234","entrance":"staff"}`)
	expectStatus(t, rec, http.StatusOK)
}

func TestAutoRefreshDoesNotExtendSession(t *testing.T) {
	a, h := newTestApp(t)
	clock := useFakeClock(a, idleTestStart())
	refreshing := login(t, h, "kinjo@hoiku.example.jp", "pass1234", "staff")
	operating := loginAs(a, 5, "staff") // 同じ職員の別の端末。こちらは操作として送る

	// 5分ごとに読み直す。印の付いた読み直しは操作に数えない
	for i := 0; i < 6; i++ {
		clock.advance(5 * time.Minute)
		expectGet(t, h, refreshing, "/api/dashboard/staff", true, http.StatusOK)
		expectGet(t, h, operating, "/api/dashboard/staff", false, http.StatusOK)
	}

	// ログインから30分を過ぎたところ。読み直しだけを続けた端末は切れ、操作として送った端末は続く
	clock.advance(time.Second)
	expectGet(t, h, refreshing, "/api/dashboard/staff", true, http.StatusUnauthorized)
	expectGet(t, h, operating, "/api/dashboard/staff", true, http.StatusOK)
}

func TestCountsAsOperation(t *testing.T) {
	cases := []struct {
		name, method, path string
		auto               bool
		want               bool
	}{
		{"画面の操作で読む", "GET", "/api/children", false, true},
		{"画面の操作で書く", "POST", "/api/chat/rooms/6/messages", false, true},
		{"裏の読み直し", "GET", "/api/dashboard/staff", true, false},
		// 知らせの受け取り口（PR #196）。EventSource は見出しを付けられないため、経路で見る（基本設計書 4-10）
		{"知らせの受け取り", "GET", "/api/events", false, false},
		// 期限を尋ねるだけでは延ばさない。予告の「続ける」は操作に数える（api_session.go。GitHub Issue #210）
		{"期限を尋ねる", "GET", "/api/session", false, false},
		{"続ける", "POST", "/api/session/extend", false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			if tc.auto {
				req.Header.Set(autoRefreshHeader, "1")
			}
			if got := countsAsOperation(req); got != tc.want {
				t.Fatalf("countsAsOperation(%s %s, auto=%v) = %v, want %v", tc.method, tc.path, tc.auto, got, tc.want)
			}
		})
	}
}

func TestNapCheckKeepsStarterLoggedIn(t *testing.T) {
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

	// 14:40。どちらも最後の操作（ログイン）から95分。画面の読み直しだけが続いている
	clock.t = at(start, 14, 40, 0)
	expectGet(t, h, teacher, "/api/dashboard/staff", true, http.StatusOK)
	// 実施を開始していない職員は、ふだんどおり切れる
	expectGet(t, h, admin, "/api/dashboard/staff", true, http.StatusUnauthorized)

	// 終了の操作を忘れたまま、午睡の時間帯（13:00-15:00）が終わった。15:00 で解除し、そこから数え直す
	clock.t = at(start, 15, 30, 0)
	expectGet(t, h, teacher, "/api/dashboard/staff", true, http.StatusOK)
	clock.t = at(start, 15, 30, 1)
	expectGet(t, h, teacher, "/api/dashboard/staff", true, http.StatusUnauthorized)
}

func TestNapCheckEndedRestartsAutoLogout(t *testing.T) {
	a, h := newTestApp(t)
	start := idleTestStart()
	clock := useFakeClock(a, start)
	day := start.Format("2006-01-02")

	teacher := login(t, h, "takanashi@hoiku.example.jp", "pass1234", "staff")
	// 13:05 に高梨が開始し、13:40 に同じクラスの職員（宮城）が終了した
	if _, err := a.db.Exec(`INSERT INTO t_nap_session
		(class_id, session_date, started_staff_id, started_at, ended_staff_id, ended_at, is_auto_closed)
		VALUES (1, ?, 'S003', ?, 'S004', ?, 0)`, day, day+"T13:05:00", day+"T13:40:00"); err != nil {
		t.Fatal(err)
	}

	// 以後は通常の自動ログアウト。終わった 13:40 から30分
	clock.t = at(start, 14, 10, 0)
	expectGet(t, h, teacher, "/api/me", true, http.StatusOK)
	clock.t = at(start, 14, 10, 1)
	expectGet(t, h, teacher, "/api/me", true, http.StatusUnauthorized)
}

func TestGuardianHasNoAutoLogout(t *testing.T) {
	a, h := newTestApp(t)
	clock := useFakeClock(a, idleTestStart())

	// 記憶を付けずにログインした保護者。3時間、何も操作しなくても切れない
	plain := loginRemember(t, h, "nohara.i@example.jp", "guardian", false)
	clock.advance(3 * time.Hour)
	expectGet(t, h, plain, "/api/dashboard/guardian", true, http.StatusOK)

	// 記憶を付けた保護者は、保存期間（auth.remember_days = 30日）だけで制限する
	remembered := loginRemember(t, h, "miyagi.r@example.jp", "guardian", true)
	if remembered.MaxAge != 30*24*60*60 {
		t.Fatalf("記憶を付けたときの Cookie の保存期間 = %d 秒, want 30日", remembered.MaxAge)
	}
	clock.advance(29 * 24 * time.Hour)
	expectGet(t, h, remembered, "/api/dashboard/guardian", true, http.StatusOK)
	clock.advance(24*time.Hour + time.Second)
	expectGet(t, h, remembered, "/api/dashboard/guardian", false, http.StatusUnauthorized)
}

func TestStaffRememberStillAutoLogout(t *testing.T) {
	a, h := newTestApp(t)
	clock := useFakeClock(a, idleTestStart())

	// 記憶を付けた職員にも自動ログアウトを課す（要件定義書「自動ログアウトを優先する」）
	remembered := loginRemember(t, h, "kinjo@hoiku.example.jp", "staff", true)
	clock.advance(30*time.Minute + time.Second)
	expectGet(t, h, remembered, "/api/me", false, http.StatusUnauthorized)

	// 記憶を付けない職員の Cookie は、ブラウザを閉じるまで残す。Cookie に期限を付けると、
	// ブラウザがログインから数えて捨ててしまい、操作を続けても切れる
	plain := loginRemember(t, h, "takanashi@hoiku.example.jp", "staff", false)
	if plain.MaxAge != 0 || !plain.Expires.IsZero() {
		t.Fatalf("記憶を付けない職員の Cookie に期限が付いている (MaxAge=%d, Expires=%v)", plain.MaxAge, plain.Expires)
	}
}
