package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

/*
 * 開いている画面への知らせ（events.go）
 * 典拠：ナレッジ/決定事項.md 2026-10-15「相手の画面への反映は、SSE で即時にする」、
 *      web/仮置き値.md「開いたままの画面の読み直し（自動更新）」
 *
 * 知らせが、その情報を見てよい人にだけ届くこと（届く人・届かない人）と、
 * 受け取り口がログインを確かめ、ログアウト・停止・セッションの期限切れで閉じることを確かめる。
 * 画面側の受け取り方は web/tests/live.test.tsx が確かめる。
 */

// listen は、そのアカウントが画面を1つ開いてつないでいる状態を作る（受け取り口を通さず、配る仕組みへ直接つなぐ）
func listen(a *app, accountID int64) *liveClient {
	return a.live.join(accountID, "")
}

// drain は、届いている知らせをすべて取り出す
func drain(c *liveClient) []liveEvent {
	var out []liveEvent
	for {
		select {
		case ev := <-c.events:
			out = append(out, ev)
		default:
			return out
		}
	}
}

func hasEvent(evs []liveEvent, want liveEvent) bool {
	for _, ev := range evs {
		if ev == want {
			return true
		}
	}
	return false
}

// expect は、各アカウントに届いた知らせが want と一致するか（順は問わない）を確かめる。
// want に載せていないアカウントには、何も届いていないことを確かめる
func expect(t *testing.T, step string, clients map[string]*liveClient, want map[string][]liveEvent) {
	t.Helper()
	for name, c := range clients {
		got := drain(c)
		w := want[name]
		if len(got) != len(w) {
			t.Errorf("%s: %s に届いた知らせ = %+v, want %+v", step, name, got, w)
			continue
		}
		for _, ev := range w {
			if !hasEvent(got, ev) {
				t.Errorf("%s: %s に %+v が届いていない（届いたもの %+v）", step, name, ev, got)
			}
		}
	}
}

// drainAll は、ここまでに届いた知らせを捨てる（準備の操作の知らせを、確かめる対象から外す）
func drainAll(clients map[string]*liveClient) {
	for _, c := range clients {
		drain(c)
	}
}

// to は、names の人に evs が届くという期待を組み立てる
func to(names []string, evs ...liveEvent) map[string][]liveEvent {
	out := map[string][]liveEvent{}
	for _, n := range names {
		out[n] = append([]liveEvent{}, evs...)
	}
	return out
}

func who(names ...string) []string { return names }

func chatEv(room int64) liveEvent { return liveEvent{Type: evChat, RoomID: room} }

/* ============ 配る仕組み ============ */

func TestLiveHubSend(t *testing.T) {
	h := newLiveHub()
	a1 := h.join(1, "s-a")
	a1b := h.join(1, "s-b") // 同じ人の別のタブ（別のセッション）
	b := h.join(3, "s-c")
	c := h.join(5, "s-d")

	h.send(chatEv(6), []int64{1, 3})
	for name, cl := range map[string]*liveClient{"1": a1, "1の別タブ": a1b, "3": b} {
		if got := drain(cl); len(got) != 1 || got[0] != chatEv(6) {
			t.Errorf("%s に届いた知らせ = %+v", name, got)
		}
	}
	if got := drain(c); len(got) != 0 {
		t.Errorf("送り先でない人に届いた: %+v", got)
	}

	t.Run("終わったセッションの接続だけを閉じる", func(t *testing.T) {
		h.closeSessions([]string{"s-a"})
		select {
		case <-a1.done:
		default:
			t.Fatal("終わったセッションの接続が閉じていない")
		}
		select {
		case <-a1b.done:
			t.Fatal("同じ人の別のセッションまで閉じた")
		default:
		}
	})

	t.Run("溜まりすぎた接続は閉じる（つなぎ直して読み直させる）", func(t *testing.T) {
		for i := 0; i < liveBuffer+1; i++ {
			h.send(chatEv(6), []int64{5})
		}
		select {
		case <-c.done:
		default:
			t.Fatal("溢れた接続が閉じていない")
		}
	})

	t.Run("閉じた接続は送り先から外れる", func(t *testing.T) {
		h.leave(a1)
		h.leave(c)
		got := h.accounts()
		if len(got) != 2 {
			t.Fatalf("accounts = %v, want [1 3]（重複なし）", got)
		}
	})
}

/* ============ 受け取り口 ============ */

func TestEventsEndpointRequiresLogin(t *testing.T) {
	a, h := newTestApp(t)
	cases := map[string]struct {
		cookie *http.Cookie
		status int
	}{
		"Cookie が無い":       {nil, http.StatusUnauthorized},
		"知らないセッション":        {&http.Cookie{Name: sessionCookie, Value: "unknown"}, http.StatusUnauthorized},
		"一時パスワード中（手続きの途中）": {loginAs(a, 4, "staff"), http.StatusForbidden},
		"規約の再同意の前（手続きの途中）": {loginAs(a, 7, "guardian"), http.StatusForbidden},
		"停止中の保護者":          {loginAs(a, 8, "guardian"), http.StatusUnauthorized},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/api/events", nil)
			if tc.cookie != nil {
				req.AddCookie(tc.cookie)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d", rec.Code, tc.status)
			}
			if len(a.live.accounts()) != 0 {
				t.Fatal("通さなかった要求が送り先に加わった")
			}
		})
	}
}

// readUntil は、want を含む行が来るまで読む。来なければ失敗にする
func readUntil(t *testing.T, r *bufio.Reader, want string) {
	t.Helper()
	found := make(chan error, 1)
	go func() {
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				found <- err
				return
			}
			if strings.Contains(line, want) {
				found <- nil
				return
			}
		}
	}()
	select {
	case err := <-found:
		if err != nil {
			t.Fatalf("%q を待つ間に切れた: %v", want, err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("%q が届かない", want)
	}
}

// openStream は、受け取り口へつなぎ、最初の書き出し（retry）まで読む
func openStream(t *testing.T, url string, c *http.Cookie) (*http.Response, *bufio.Reader) {
	t.Helper()
	req, _ := http.NewRequest("GET", url+"/api/events", nil)
	req.AddCookie(c)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	body := bufio.NewReader(res.Body)
	readUntil(t, body, "retry: 3000")
	return res, body
}

// expectClosed は、サーバが接続を閉じ、送り先から外したことを確かめる
func expectClosed(t *testing.T, a *app, body *bufio.Reader) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, body)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("閉じ方が正しくない: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("接続が閉じない")
	}
	// 受け取り口の後始末（送り先から外す）は、接続を閉じたあとに走る。少し待つ
	deadline := time.Now().Add(time.Second)
	for len(a.live.accounts()) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := a.live.accounts(); len(got) != 0 {
		t.Fatalf("閉じた接続が送り先に残っている: %v", got)
	}
}

func TestEventsEndpointStream(t *testing.T) {
	a, h := newTestApp(t)
	a.live.heartbeat = 50 * time.Millisecond
	srv := httptest.NewServer(h)
	defer srv.Close()

	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")

	res, body := openStream(t, srv.URL, teacher)
	for k, want := range map[string]string{
		"Content-Type":      "text/event-stream",
		"Cache-Control":     "no-cache",
		"X-Accel-Buffering": "no",
	} {
		if got := res.Header.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}

	t.Run("相手の操作が知らせとして届く（中身は入れず、種類と ID だけ）", func(t *testing.T) {
		call(t, h, guardian, "POST", "/api/chat/rooms/6/messages", `{"body":"お迎えは17時です。"}`)
		readUntil(t, body, `data: {"type":"chat","room_id":6}`)
	})

	t.Run("空の知らせ（コメント行）を一定の間隔で送る", func(t *testing.T) {
		readUntil(t, body, ": ping")
	})

	t.Run("ログアウトすると接続を閉じる", func(t *testing.T) {
		call(t, h, teacher, "POST", "/api/logout", "")
		expectClosed(t, a, body)
	})
}

func TestEventsClosedWhenAccountSuspended(t *testing.T) {
	a, h := newTestApp(t)
	srv := httptest.NewServer(h)
	defer srv.Close()
	admin := loginAs(a, accAdmin, "staff")
	other := loginAs(a, accOtherGuard, "guardian")

	_, body := openStream(t, srv.URL, other)
	// 停止は、ほかの知らせを待たずにその場で切る（心拍の間隔は既定の長さのまま）
	call(t, h, admin, "POST", "/api/admin/accounts/9/status", `{"status":"2"}`)
	expectClosed(t, a, body)
}

func TestEventsClosedWhenSessionExpires(t *testing.T) {
	a, h := newTestApp(t)
	a.live.heartbeat = 50 * time.Millisecond
	srv := httptest.NewServer(h)
	defer srv.Close()
	teacher := loginAs(a, accTeacher, "staff")

	_, body := openStream(t, srv.URL, teacher)
	a.sessions.mu.Lock()
	s := a.sessions.data[teacher.Value]
	s.expiresAt = time.Now().Add(-time.Minute)
	a.sessions.data[teacher.Value] = s
	a.sessions.mu.Unlock()
	expectClosed(t, a, body)
}

/* ============ 誰に送るか ============ */

// デモデータの人物（seed.sql）
const (
	accAdmin        = 1 // 管理者（園長）
	accAdmin2       = 2 // 管理者
	accTeacher      = 3 // さくら組の担任。さくら組の個人チャットに参加している
	accOtherTeacher = 5 // ひまわり組の担任
	accGuardian     = 6 // 野原 太郎（C001・さくら組）の保護者。個人チャットは 6
	accOtherGuard   = 9 // 宮城 美咲（C004・さくら組）の保護者。個人チャットは 8
	roomPersonal    = 6 // 野原 太郎の保護者との個人チャット
	roomOtherPerson = 8 // 宮城 美咲の保護者との個人チャット
	roomSakura      = 3 // さくら組のクラスグループ
	roomSchool      = 1 // 園全体
	classSakura     = 1 // さくら組
	classHimawari   = 2 // ひまわり組
	childTaro       = "C001"
	childMisaki     = "C004"
	childHimawari   = "C013" // 井上 空（ひまわり組）
)

func TestNotifyChatAudience(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	clients := map[string]*liveClient{
		"管理者":       listen(a, accAdmin),
		"さくら組の担任":   listen(a, accTeacher),
		"ひまわり組の担任":  listen(a, accOtherTeacher),
		"野原 太郎の保護者": listen(a, accGuardian),
		"宮城 美咲の保護者": listen(a, accOtherGuard),
	}
	personal := chatEv(roomPersonal)

	call(t, h, guardian, "POST", "/api/chat/rooms/6/messages", `{"body":"明日はお休みします。"}`)
	expect(t, "保護者の送信", clients, to(who("管理者", "さくら組の担任", "野原 太郎の保護者"), personal))

	call(t, h, teacher, "POST", "/api/chat/rooms/8/messages", `{"body":"お熱は下がりましたか。"}`)
	expect(t, "ほかの家庭の個人チャット（野原 太郎の保護者には届かない）", clients,
		to(who("管理者", "さくら組の担任", "宮城 美咲の保護者"), chatEv(roomOtherPerson)))

	call(t, h, admin, "POST", "/api/chat/rooms/3/messages", `{"body":"明日は遠足です。"}`)
	expect(t, "さくら組のクラスグループ（ひまわり組の担任には届かない）", clients,
		to(who("管理者", "さくら組の担任", "野原 太郎の保護者", "宮城 美咲の保護者"), chatEv(roomSakura)))

	call(t, h, teacher, "POST", "/api/chat/rooms/6/thread-status", `{"status":"2"}`)
	expect(t, "対応済みにする（保護者の画面には出ない）", clients, to(who("管理者", "さくら組の担任"), personal))

	call(t, h, teacher, "POST", "/api/chat/rooms/6/read", "")
	expect(t, "職員が既読にする（個人チャットの既読の人数は保護者だけを数えるため、本人のほかのタブにだけ送る）",
		clients, to(who("さくら組の担任"), personal))

	call(t, h, teacher, "POST", "/api/chat/rooms/6/messages", `{"body":"承知しました。お大事に。"}`)
	expect(t, "職員の返信", clients, to(who("管理者", "さくら組の担任", "野原 太郎の保護者"), personal))

	call(t, h, guardian, "POST", "/api/chat/rooms/6/read", "")
	expect(t, "保護者が既読にする（人数は職員にだけ出る。本人のほかのタブにも送る）", clients,
		to(who("管理者", "さくら組の担任", "野原 太郎の保護者"), personal))

	call(t, h, guardian, "POST", "/api/chat/rooms/6/read", "")
	expect(t, "新しく既読にしたものが無ければ送らない", clients, nil)

	call(t, h, teacher, "POST", "/api/chat/messages/6/reactions", `{"reaction_type":"1"}`)
	expect(t, "リアクション", clients, to(who("管理者", "さくら組の担任", "野原 太郎の保護者"), personal))

	t.Run("後から加わった保護者には、加わる前のメッセージの変化を送らない", func(t *testing.T) {
		// 最初の保護者の参加時刻を残し、その後から加わった保護者の閲覧範囲を確かめる。
		if _, err := a.db.Exec(`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at, left_at)
			VALUES (6, 7, '2025-06-10T10:00:00', '2025-06-11T10:00:00')`); err != nil {
			t.Fatal(err)
		}
		if _, err := a.db.Exec(`UPDATE t_chat_member SET joined_at = '2099-01-01T00:00:00'
			WHERE chat_room_id = 6 AND account_id = ?`, accGuardian); err != nil {
			t.Fatal(err)
		}
		call(t, h, teacher, "POST", "/api/chat/messages/6/reactions", `{"reaction_type":"2"}`)
		expect(t, "加わる前のメッセージへのリアクション", clients, to(who("管理者", "さくら組の担任"), personal))
		if _, err := a.db.Exec(`UPDATE t_chat_member SET joined_at = '2025-06-10T10:00:00'
			WHERE chat_room_id = 6 AND account_id = ?`, accGuardian); err != nil {
			t.Fatal(err)
		}
		if _, err := a.db.Exec(`DELETE FROM t_chat_member WHERE chat_room_id = 6 AND account_id = 7`); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("外れた人には、外れたあとの投稿を送らない（外れた職員も、外れたあとの投稿は読めない）", func(t *testing.T) {
		if _, err := a.db.Exec(`UPDATE t_chat_member SET left_at = '2026-01-01T00:00:00'
			WHERE chat_room_id = 6 AND account_id IN (?, ?)`, accGuardian, accAdmin); err != nil {
			t.Fatal(err)
		}
		call(t, h, teacher, "POST", "/api/chat/rooms/6/messages", `{"body":"承知しました。"}`)
		expect(t, "外れたあとの送信", clients, to(who("さくら組の担任"), personal))
	})
}

func TestNotifyDiaryAudience(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	clients := map[string]*liveClient{
		"管理者（承認する人）": listen(a, accAdmin),
		"ほかの管理者":     listen(a, accAdmin2),
		"さくら組の担任":    listen(a, accTeacher),
		"ひまわり組の担任":   listen(a, accOtherTeacher),
		"野原 太郎の保護者":  listen(a, accGuardian),
		"宮城 美咲の保護者":  listen(a, accOtherGuard),
	}
	diary := func(id int64) liveEvent { return liveEvent{Type: evDiary, DiaryID: id} }

	// 日誌 7 は宮城 美咲（さくら組）の個人日誌（申請中）。承認と同時に保護者へ共有する
	call(t, h, admin, "POST", "/api/diaries/7/approve", `{"share_to_guardian":true}`)
	expect(t, "承認して保護者へ共有（野原 太郎の保護者には届かない）", clients, map[string][]liveEvent{
		"管理者（承認する人）": {diary(7), chatEv(roomOtherPerson)},
		"ほかの管理者":     {diary(7), chatEv(roomOtherPerson)},
		"さくら組の担任":    {diary(7), chatEv(roomOtherPerson)},
		"宮城 美咲の保護者":  {diary(7), chatEv(roomOtherPerson)},
	})

	// 日誌 6 はひまわり組のクラス日誌（申請中）
	call(t, h, admin, "POST", "/api/diaries/6/return", `{"reason":"活動のねらいを具体的に書いてください。"}`)
	expect(t, "差し戻し（クラス日誌は保護者に見えない）", clients,
		to(who("管理者（承認する人）", "ほかの管理者", "ひまわり組の担任"), diary(6)))

	rec := call(t, h, otherTeacher, "POST", "/api/diaries",
		`{"record_type":"2","class_id":2,"diary_date":"`+today()+`","body":"散歩に出かけた。","status":"1"}`)
	var saved struct {
		DiaryID int64 `json:"diary_id"`
	}
	decode(t, rec, &saved)
	expect(t, "下書きの作成（参照できる職員だけ）", clients,
		to(who("管理者（承認する人）", "ほかの管理者", "ひまわり組の担任"), diary(saved.DiaryID)))
}

func TestNotifyHandoutAudience(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	clients := map[string]*liveClient{
		"管理者":       listen(a, accAdmin),
		"さくら組の担任":   listen(a, accTeacher),
		"ひまわり組の担任":  listen(a, accOtherTeacher),
		"野原 太郎の保護者": listen(a, accGuardian),
		"宮城 美咲の保護者": listen(a, accOtherGuard),
	}
	sakuraPeople := who("管理者", "さくら組の担任", "野原 太郎の保護者", "宮城 美咲の保護者")

	rec := call(t, h, admin, "POST", "/api/handouts", `{"handout_type":"4","title":"さくら組だより","target_month":"2026-10",
		"class_id":1,"file_name":"sakura.pdf","file_type":"application/pdf","file_size":1000}`)
	var posted struct {
		HandoutID int64 `json:"handout_id"`
	}
	decode(t, rec, &posted)
	handout := liveEvent{Type: evHandout, HandoutID: posted.HandoutID}
	expect(t, "さくら組向けの掲載（ひまわり組の担任には届かない）", clients,
		to(sakuraPeople, handout, chatEv(roomSakura)))

	call(t, h, admin, "POST", "/api/handouts/"+itoa(posted.HandoutID)+"/withdraw", "")
	expect(t, "取り下げ（掲載の知らせも取り消す）", clients, to(sakuraPeople, handout, chatEv(roomSakura)))

	rec = call(t, h, admin, "POST", "/api/handouts", `{"handout_type":"1","title":"園だより","target_month":"2026-10",
		"file_name":"en.pdf","file_type":"application/pdf","file_size":1000}`)
	decode(t, rec, &posted)
	expect(t, "園全体向けの掲載", clients,
		to(who("管理者", "さくら組の担任", "ひまわり組の担任", "野原 太郎の保護者", "宮城 美咲の保護者"),
			liveEvent{Type: evHandout, HandoutID: posted.HandoutID}, chatEv(roomSchool)))
}

func TestNotifyNapAudience(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	// デモデータの実施中の午睡チェックを終えておく。どの時刻に回しても、開始から確かめられるようにする
	if _, err := a.db.Exec(`UPDATE t_nap_session SET ended_at = ? WHERE ended_at IS NULL`, now()); err != nil {
		t.Fatal(err)
	}
	clients := map[string]*liveClient{
		"管理者":       listen(a, accAdmin),
		"さくら組の担任":   listen(a, accTeacher),
		"ひまわり組の担任":  listen(a, accOtherTeacher),
		"野原 太郎の保護者": listen(a, accGuardian),
		"宮城 美咲の保護者": listen(a, accOtherGuard),
	}
	sakuraClass := liveEvent{Type: evNap, ClassID: classSakura}

	s := startOwnNap(t, h, teacher)
	expect(t, "さくら組の開始（さくら組に子がいる保護者にも届く）", clients,
		to(who("管理者", "さくら組の担任", "野原 太郎の保護者", "宮城 美咲の保護者"), sakuraClass))

	path := "/api/nap/session/" + itoa(s.NapSessionID)
	call(t, h, teacher, "POST", path+"/records",
		`{"child_id":"C001","body_position":"1","breathing":"1","complexion":"1"}`)
	expect(t, "野原 太郎の記録（ほかの家庭には届かない）", clients,
		to(who("管理者", "さくら組の担任", "野原 太郎の保護者"),
			liveEvent{Type: evNap, ClassID: classSakura, ChildID: childTaro}))

	call(t, h, teacher, "POST", path+"/records",
		`{"child_id":"C004","body_position":"1","breathing":"1","complexion":"1"}`)
	expect(t, "宮城 美咲の記録", clients,
		to(who("管理者", "さくら組の担任", "宮城 美咲の保護者"),
			liveEvent{Type: evNap, ClassID: classSakura, ChildID: childMisaki}))

	rec := call(t, h, teacher, "POST", path+"/abnormals",
		`{"child_id":"C001","situation":"うつ伏せで寝ていた。","response":"仰向けに直した。"}`)
	var abnormal struct {
		ID int64 `json:"nap_abnormal_id"`
	}
	decode(t, rec, &abnormal)
	expect(t, "異常時の記録（園内の記録のため、保護者には送らない）", clients,
		to(who("管理者", "さくら組の担任"), liveEvent{Type: evNap, ClassID: classSakura, ChildID: childTaro}))

	rec = call(t, h, teacher, "POST", "/api/nap/abnormals/"+itoa(abnormal.ID)+"/incident", "")
	var incident struct {
		DiaryID int64 `json:"diary_id"`
	}
	decode(t, rec, &incident)
	expect(t, "ヒヤリハットの起票（日誌も増える。ヒヤリハットは保護者に見えない）", clients,
		to(who("管理者", "さくら組の担任"), liveEvent{Type: evNap, ClassID: classSakura, ChildID: childTaro},
			liveEvent{Type: evDiary, DiaryID: incident.DiaryID}))

	call(t, h, teacher, "POST", path+"/end", "")
	expect(t, "さくら組の終了", clients,
		to(who("管理者", "さくら組の担任", "野原 太郎の保護者", "宮城 美咲の保護者"), sakuraClass))

	call(t, h, otherTeacher, "POST", "/api/nap/session", `{"class_id":2}`)
	expect(t, "ひまわり組の開始（さくら組の担任・保護者には届かない）", clients,
		to(who("管理者", "ひまわり組の担任"), liveEvent{Type: evNap, ClassID: classHimawari}))
}

func TestNotifyGrowthAudience(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	clients := map[string]*liveClient{
		"管理者":       listen(a, accAdmin),
		"さくら組の担任":   listen(a, accTeacher),
		"ひまわり組の担任":  listen(a, accOtherTeacher),
		"野原 太郎の保護者": listen(a, accGuardian),
		"宮城 美咲の保護者": listen(a, accOtherGuard),
	}
	devHimawari := liveEvent{Type: evDevelopment, ChildID: childHimawari}

	call(t, h, otherTeacher, "POST", "/api/development/checks",
		`{"child_id":"C013","results":[],"note":"","status":"1"}`)
	expect(t, "発達チェックの下書き（一覧の未入力の数が変わる）", clients,
		to(who("管理者", "ひまわり組の担任"), devHimawari))
	call(t, h, otherTeacher, "POST", "/api/development/checks",
		`{"child_id":"C013","results":[],"note":"","status":"2"}`)
	expect(t, "発達チェックの確定（発達チェックは保護者に見えない）", clients,
		to(who("管理者", "ひまわり組の担任"), devHimawari))

	call(t, h, admin, "POST", "/api/development/schedules",
		`{"child_id":"C001","scheduled_on":"`+daysFromToday(30)+`","manual":true}`)
	expect(t, "次回の予定日", clients,
		to(who("管理者", "さくら組の担任"), liveEvent{Type: evDevelopment, ChildID: childTaro}))

	physTaro := liveEvent{Type: evPhysical, ChildID: childTaro}
	call(t, h, teacher, "POST", "/api/physical/records",
		`{"child_id":"C001","measured_on":"`+daysFromToday(-1)+`","height_cm":79.0,"weight_kg":10.0,"confirm_same_month":true}`)
	expect(t, "身体測定の登録（共有していない測定値は保護者に見えない）", clients,
		to(who("管理者", "さくら組の担任"), physTaro))

	// 測定値 2 は野原 太郎の共有済み（連携済）の測定値
	var measured string
	if err := a.db.QueryRow(`SELECT measured_on FROM t_physical_record WHERE physical_record_id = 2`).Scan(&measured); err != nil {
		t.Fatal(err)
	}
	call(t, h, teacher, "POST", "/api/physical/records",
		`{"child_id":"C001","measured_on":"`+measured+`","height_cm":77.5,"weight_kg":9.6,"confirm_overwrite":true}`)
	expect(t, "共有済みの測定値の上書き（その家庭の保護者にだけ届く）", clients,
		to(who("管理者", "さくら組の担任", "野原 太郎の保護者"), physTaro))

	call(t, h, admin, "DELETE", "/api/physical/records/1", "")
	expect(t, "共有済みの測定値の削除", clients, to(who("管理者", "さくら組の担任", "野原 太郎の保護者"), physTaro))
}

// 停止したアカウント・手続きの途中のアカウントがつないだままでも、知らせは送らない（受け取り口が閉じるまでの間）
func TestNotifySkipsUnusableAccounts(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	clients := map[string]*liveClient{
		"さくら組の担任":   listen(a, accTeacher),
		"宮城 美咲の保護者": listen(a, accOtherGuard),
	}
	if _, err := a.db.Exec(`UPDATE m_account SET status = '2' WHERE account_id = ?`, accOtherGuard); err != nil {
		t.Fatal(err)
	}
	call(t, h, teacher, "POST", "/api/chat/rooms/8/messages", `{"body":"お熱は下がりましたか。"}`)
	expect(t, "停止中の保護者", clients, to(who("さくら組の担任"), chatEv(roomOtherPerson)))
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatal(err)
	}
}

// daysFromToday は、日本時間の今日から n 日ずらした日付（'YYYY-MM-DD'）
func daysFromToday(n int) string {
	d, _ := time.ParseInLocation("2006-01-02", today(), jst)
	return d.AddDate(0, 0, n).Format("2006-01-02")
}
