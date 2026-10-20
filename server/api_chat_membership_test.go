package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
)

/*
 * チャットの参加者（GitHub Issue #161・#162）
 * 典拠：要件定義書「チャットツール」(4-3) 機能一覧「グループの作成・メンバー編成」・(a)「グループの種別」・(c)「過去ログの参照範囲」
 *      基本設計書「チャット」(5-5)「チャンネルの使い分け」・職員チャットの規定、「メッセージの送受信」(4-6)
 *      図/画面詳細図.md「グループ編成画面」(4-3) No.6・No.8
 *
 * 画面側のモック（web/src/api/mock.ts）も同じ規則にしてある。web/tests/chatMembership.test.ts が同じ観点を確かめる。
 */

// chatReq は、応答の状態を問わずに API を呼ぶ（call は 200 以外で止まるため）
func chatReq(h http.Handler, c *http.Cookie, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(c)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGuardianCannotReadChatMembers(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, 6, "guardian")
	staff := loginAs(a, 3, "staff")
	for _, roomID := range []string{"1", "3"} {
		r := chatReq(h, guardian, "GET", "/api/chat/rooms/"+roomID+"/members", "")
		if r.Code != http.StatusForbidden {
			t.Fatalf("保護者にメンバー一覧を返しました: room=%s status=%d body=%s", roomID, r.Code, r.Body.String())
		}
	}
	if r := chatReq(h, staff, "GET", "/api/chat/rooms/3/members", ""); r.Code != http.StatusOK {
		t.Fatalf("担任のメンバー一覧まで拒否されました: %d", r.Code)
	}
}

// currentRooms は、いま参加している（left_at の無い）チャンネルを番号順に返す
func currentRooms(t *testing.T, a *app, accountID int64) []int64 {
	t.Helper()
	rows, err := a.db.Query(`SELECT chat_room_id FROM t_chat_member
		WHERE account_id = ? AND left_at IS NULL ORDER BY chat_room_id`, accountID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var id int64
		rows.Scan(&id)
		out = append(out, id)
	}
	return out
}

func sameRooms(got []int64, want ...int64) bool {
	sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func roomViews(t *testing.T, h http.Handler, c *http.Cookie) map[int64]ChatRoomView {
	t.Helper()
	var list []ChatRoomView
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/chat/rooms", "").Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	out := map[int64]ChatRoomView{}
	for _, v := range list {
		out[v.Room.ChatRoomID] = v
	}
	return out
}

func messageBodies(t *testing.T, h http.Handler, c *http.Cookie, roomID string) []string {
	t.Helper()
	var list []ChatMessage
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/chat/rooms/"+roomID+"/messages", "").Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, m := range list {
		out = append(out, m.Body)
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// デモデータのチャンネル：1 園全体、2 職員、3 さくら組、4 ひまわり組、5 運動会実行委員（目的別）、
// 6〜9 さくら組の個人チャット。アカウント：1・2 管理者、3・4 さくら組の担任、5 ひまわり組の担任、6〜10 保護者

func TestGroupMembersOnlyPurposeGroups(t *testing.T) {
	a, h := newTestApp(t)
	kinjo := loginAs(a, 5, "staff") // ひまわり組の担任
	admin := loginAs(a, 1, "staff")
	guardian := loginAs(a, 6, "guardian") // 野原 太郎の保護者

	t.Run("ほかのクラスの個人チャットに自分を足せない", func(t *testing.T) {
		if rec := chatReq(h, kinjo, "POST", "/api/chat/groups/6/members", `{"account_ids":[1,3,4,6,5]}`); rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
		}
		if rec := chatReq(h, kinjo, "GET", "/api/chat/rooms/6/messages", ""); rec.Code != http.StatusForbidden {
			t.Fatalf("編成のあと、ほかのクラスの個人チャットが読める: %d", rec.Code)
		}
	})

	t.Run("管理者でも、個人チャットから家庭を外せない", func(t *testing.T) {
		if rec := chatReq(h, admin, "POST", "/api/chat/groups/9/members", `{"account_ids":[1]}`); rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		if !sameRooms(currentRooms(t, a, 10), 1, 3, 9) {
			t.Fatalf("保護者（金城 陸の保護者）の参加が変わった: %v", currentRooms(t, a, 10))
		}
	})

	t.Run("職員チャットに保護者を入れられない", func(t *testing.T) {
		if rec := chatReq(h, kinjo, "POST", "/api/chat/groups/2/members", `{"account_ids":[1,2,3,4,5,6]}`); rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		if rec := chatReq(h, guardian, "GET", "/api/chat/rooms/2/messages", ""); rec.Code != http.StatusForbidden {
			t.Fatalf("保護者が職員チャットを読める: %d", rec.Code)
		}
	})

	t.Run("目的別グループに保護者を入れられない（作るときも、編成するときも）", func(t *testing.T) {
		var before int
		a.db.QueryRow(`SELECT COUNT(*) FROM m_chat_room WHERE room_type = '3'`).Scan(&before)
		teacher := loginAs(a, 3, "staff")
		if rec := chatReq(h, teacher, "POST", "/api/chat/groups", `{"name":"T3 遠足の打ち合わせ","account_ids":[9]}`); rec.Code != http.StatusBadRequest {
			t.Fatalf("作成: status = %d, want 400", rec.Code)
		}
		var after int
		a.db.QueryRow(`SELECT COUNT(*) FROM m_chat_room WHERE room_type = '3'`).Scan(&after)
		if after != before {
			t.Fatalf("断ったのにグループができている: %d → %d", before, after)
		}
		if rec := chatReq(h, admin, "POST", "/api/chat/groups/5/members", `{"account_ids":[1,3,5,6]}`); rec.Code != http.StatusBadRequest {
			t.Fatalf("編成: status = %d, want 400", rec.Code)
		}
		if !sameRooms(currentRooms(t, a, 6), 1, 3, 6) {
			t.Fatalf("保護者が目的別グループに入った: %v", currentRooms(t, a, 6))
		}
	})

	t.Run("一般は、参加していない目的別グループを編成できない。管理者はできる", func(t *testing.T) {
		var created struct {
			ChatRoomID int64 `json:"chat_room_id"`
		}
		json.Unmarshal(call(t, h, admin, "POST", "/api/chat/groups", `{"name":"園長と主任","account_ids":[2]}`).Body.Bytes(), &created)
		teacher := loginAs(a, 3, "staff")
		path := "/api/chat/groups/" + itoa64(created.ChatRoomID) + "/members"
		if rec := chatReq(h, teacher, "POST", path, `{"account_ids":[1,2,3]}`); rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
		call(t, h, admin, "POST", path, `{"account_ids":[1,2,3]}`)
		// 加わった一般は、そのグループを編成できる
		call(t, h, teacher, "POST", path, `{"account_ids":[1,3]}`)
	})

	t.Run("停止している職員は加えられない", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/admin/accounts/4/status", `{"status":"2"}`)
		if rec := chatReq(h, admin, "POST", "/api/chat/groups/5/members", `{"account_ids":[1,3,5,4]}`); rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		call(t, h, admin, "POST", "/api/admin/accounts/4/status", `{"status":"1"}`)
	})
}

func TestRemovedStaffCannotReadOrWriteAfterLeaving(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	kinjo := loginAs(a, 5, "staff")

	// 外す前のやりとり。外したのと同じ秒に入らないよう、日時を過去に置く
	if _, err := a.db.Exec(`INSERT INTO t_chat_message
		(chat_room_id, sender_account_id, body, source_type, sent_at, is_deleted)
		VALUES (5, 5, 'K0 金城の外される前の投稿', '1', '2026-01-05T10:00:00', 0)`); err != nil {
		t.Fatal(err)
	}
	var k0 int64
	a.db.QueryRow(`SELECT chat_message_id FROM t_chat_message WHERE body = 'K0 金城の外される前の投稿'`).Scan(&k0)

	call(t, h, admin, "POST", "/api/chat/groups/5/members", `{"account_ids":[1,3]}`)
	call(t, h, admin, "POST", "/api/chat/rooms/5/messages", `{"body":"L1 金城さんを外したあとの打ち合わせ"}`)

	t.Run("外したあとの投稿は読めず、未読にも数えない。外す前のものは読める", func(t *testing.T) {
		bodies := messageBodies(t, h, kinjo, "5")
		if contains(bodies, "L1 金城さんを外したあとの打ち合わせ") {
			t.Fatalf("外したあとの投稿が読める: %v", bodies)
		}
		if !contains(bodies, "K0 金城の外される前の投稿") || !contains(bodies, "種目案を今週中にまとめましょう。") {
			t.Fatalf("所属していた期間の過去ログが読めない: %v", bodies)
		}
		v, ok := roomViews(t, h, kinjo)[5]
		if !ok {
			t.Fatalf("過去ログを読めるチャンネルが一覧から消えた")
		}
		if v.CanPost || !v.Left {
			t.Fatalf("外れたチャンネルの表示: canPost=%v left=%v", v.CanPost, v.Left)
		}
		if v.Unread != 1 { // デモデータの「種目案を…」だけ
			t.Fatalf("unread = %d, want 1", v.Unread)
		}
	})

	t.Run("ダッシュボードの未読にも、外したあとの投稿を数えない", func(t *testing.T) {
		var got struct {
			UnreadChat int `json:"unreadChat"`
		}
		var before struct {
			UnreadChat int `json:"unreadChat"`
		}
		json.Unmarshal(call(t, h, kinjo, "GET", "/api/dashboard/staff", "").Body.Bytes(), &before)
		call(t, h, admin, "POST", "/api/chat/rooms/5/messages", `{"body":"L3 もう1件"}`)
		json.Unmarshal(call(t, h, kinjo, "GET", "/api/dashboard/staff", "").Body.Bytes(), &got)
		if got.UnreadChat != before.UnreadChat {
			t.Fatalf("unreadChat = %d → %d", before.UnreadChat, got.UnreadChat)
		}
	})

	t.Run("投稿・リアクション・編集・取消はできない", func(t *testing.T) {
		if rec := chatReq(h, kinjo, "POST", "/api/chat/rooms/5/messages", `{"body":"L2 外された金城からの投稿"}`); rec.Code != http.StatusForbidden {
			t.Fatalf("投稿: status = %d, want 403", rec.Code)
		}
		if rec := chatReq(h, kinjo, "POST", "/api/chat/messages/"+itoa64(k0)+"/reactions", `{"reaction_type":"1"}`); rec.Code != http.StatusForbidden {
			t.Fatalf("リアクション: status = %d, want 403", rec.Code)
		}
		if rec := chatReq(h, kinjo, "POST", "/api/chat/messages/"+itoa64(k0)+"/edit", `{"body":"書き換え"}`); rec.Code != http.StatusForbidden {
			t.Fatalf("編集: status = %d, want 403", rec.Code)
		}
		if rec := chatReq(h, kinjo, "POST", "/api/chat/messages/"+itoa64(k0)+"/retract", ""); rec.Code != http.StatusForbidden {
			t.Fatalf("取消: status = %d, want 403", rec.Code)
		}
	})

	t.Run("既読にするのは、読める範囲のメッセージだけ", func(t *testing.T) {
		call(t, h, kinjo, "POST", "/api/chat/rooms/5/read", "")
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_read x JOIN t_chat_message m ON m.chat_message_id = x.chat_message_id
			WHERE x.account_id = 5 AND m.body LIKE 'L%'`).Scan(&n)
		if n != 0 {
			t.Fatalf("外したあとの投稿が既読になった: %d 件", n)
		}
	})

	t.Run("いまの参加者の一覧は返さない", func(t *testing.T) {
		if rec := chatReq(h, kinjo, "GET", "/api/chat/rooms/5/members", ""); rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
	})

	t.Run("入れ直すと、また読み書きできる", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/chat/groups/5/members", `{"account_ids":[1,3,5]}`)
		call(t, h, kinjo, "POST", "/api/chat/rooms/5/messages", `{"body":"L4 戻りました"}`)
		if v := roomViews(t, h, kinjo)[5]; !v.CanPost || v.Left {
			t.Fatalf("入れ直したあと: canPost=%v left=%v", v.CanPost, v.Left)
		}
	})
}

func TestStaffAccountChangesFollowChatMembers(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	t.Run("管理者は、保護者との個人チャットにも参加している", func(t *testing.T) {
		if !sameRooms(currentRooms(t, a, 2), 1, 2, 3, 4, 6, 7, 8, 9) {
			t.Fatalf("上園（管理者）の参加: %v", currentRooms(t, a, 2))
		}
	})

	t.Run("発行した職員は、園全体・職員・担当クラスとその個人チャットに入る", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/admin/staff-accounts",
			`{"staff_id":"S010","staff_name":"新任 一郎","email":"shinnin@hoiku.example.jp","role":"2","class_id":1}`)
		var id int64
		a.db.QueryRow(`SELECT account_id FROM m_staff WHERE staff_id = 'S010'`).Scan(&id)
		if !sameRooms(currentRooms(t, a, id), 1, 2, 3, 6, 7, 8, 9) {
			t.Fatalf("新任の参加: %v", currentRooms(t, a, id))
		}
		// 担当クラスを割り当てない一般は、園全体と職員だけ
		call(t, h, admin, "POST", "/api/admin/staff-accounts",
			`{"staff_id":"S011","staff_name":"新任 二郎","email":"shinnin2@hoiku.example.jp","role":"2","class_id":null}`)
		a.db.QueryRow(`SELECT account_id FROM m_staff WHERE staff_id = 'S011'`).Scan(&id)
		if !sameRooms(currentRooms(t, a, id), 1, 2) {
			t.Fatalf("担当なしの参加: %v", currentRooms(t, a, id))
		}
	})

	t.Run("担任を付け替えると、前のクラスから外れ、新しいクラスに入る", func(t *testing.T) {
		kinjo := loginAs(a, 5, "staff")
		call(t, h, admin, "POST", "/api/admin/staff-accounts/S005", `{"staff_name":"金城 宗一郎","role":"2","class_id":1}`)
		// 目的別グループ（5）は手で編成するものなので、付け替えでは動かさない
		if !sameRooms(currentRooms(t, a, 5), 1, 2, 3, 5, 6, 7, 8, 9) {
			t.Fatalf("金城の参加: %v", currentRooms(t, a, 5))
		}
		call(t, h, kinjo, "POST", "/api/chat/rooms/8/messages", `{"body":"新しい担任の金城です。"}`)
		if rec := chatReq(h, kinjo, "POST", "/api/chat/rooms/4/messages", `{"body":"前のクラスへ"}`); rec.Code != http.StatusForbidden {
			t.Fatalf("前のクラスへ投稿できる: %d", rec.Code)
		}
		if v, ok := roomViews(t, h, kinjo)[4]; !ok || v.CanPost || !v.Left {
			t.Fatalf("前のクラスは閲覧のみで残る: %+v ok=%v", v, ok)
		}

		teacher := loginAs(a, 3, "staff")
		call(t, h, admin, "POST", "/api/admin/staff-accounts/S003", `{"staff_name":"高梨 倫太朗","role":"2","class_id":2}`)
		if !sameRooms(currentRooms(t, a, 3), 1, 2, 4, 5) {
			t.Fatalf("高梨の参加: %v", currentRooms(t, a, 3))
		}
		if rec := chatReq(h, teacher, "POST", "/api/chat/rooms/8/messages", `{"body":"外れた家庭へ"}`); rec.Code != http.StatusForbidden {
			t.Fatalf("外れた家庭へ投稿できる: %d", rec.Code)
		}
		// 未対応の個人チャットは、外れた担任のダッシュボードに数えない
		if got := summaryOf(t, h, teacher); got.UnhandledChat != 0 {
			t.Fatalf("外れた個人チャットを未対応に数えている: %+v", got)
		}
	})

	t.Run("一般を管理者にすると全クラスと個人チャットに入り、戻すと担当クラスだけになる", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/admin/staff-accounts/S003", `{"staff_name":"高梨 倫太朗","role":"1","class_id":2}`)
		if !sameRooms(currentRooms(t, a, 3), 1, 2, 3, 4, 5, 6, 7, 8, 9) {
			t.Fatalf("管理者にしたあと: %v", currentRooms(t, a, 3))
		}
		call(t, h, admin, "POST", "/api/admin/staff-accounts/S003", `{"staff_name":"高梨 倫太朗","role":"2","class_id":1}`)
		if !sameRooms(currentRooms(t, a, 3), 1, 2, 3, 5, 6, 7, 8, 9) {
			t.Fatalf("一般に戻したあと: %v", currentRooms(t, a, 3))
		}
	})

	t.Run("停止すると職員チャットなどから外れ、再開すると戻る", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/admin/accounts/4/status", `{"status":"2"}`)
		var members []memberView
		json.Unmarshal(call(t, h, admin, "GET", "/api/chat/rooms/2/members", "").Body.Bytes(), &members)
		for _, m := range members {
			if m.AccountID == 4 {
				t.Fatalf("停止した職員が職員チャットのメンバーに残っている")
			}
		}
		if got := currentRooms(t, a, 4); len(got) != 0 {
			t.Fatalf("停止した職員の参加: %v", got)
		}
		call(t, h, admin, "POST", "/api/admin/accounts/4/status", `{"status":"1"}`)
		if !sameRooms(currentRooms(t, a, 4), 1, 2, 3, 6, 7, 8, 9) {
			t.Fatalf("再開したあと: %v", currentRooms(t, a, 4))
		}
	})
}

// 以前のデータベース（編成の API で参加者が崩れたもの、管理者が個人チャットに入っていないもの）は、起動のときに直す
func TestStartupRepairsChatMembers(t *testing.T) {
	a, _ := newTestApp(t)
	for _, q := range []string{
		`DELETE FROM t_chat_member WHERE chat_room_id IN (6, 7, 8, 9) AND account_id = 2`,
		`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at) VALUES (6, 5, '2026-10-17T01:00:00')`,
		`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at) VALUES (2, 6, '2026-10-17T01:00:00')`,
		`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at) VALUES (5, 9, '2026-10-17T01:00:00')`,
		`UPDATE t_chat_member SET left_at = '2026-10-17T01:00:00' WHERE chat_room_id = 2 AND account_id = 3`,
	} {
		if _, err := a.db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.init(); err != nil {
		t.Fatal(err)
	}
	if !sameRooms(currentRooms(t, a, 2), 1, 2, 3, 4, 6, 7, 8, 9) {
		t.Fatalf("管理者: %v", currentRooms(t, a, 2))
	}
	if !sameRooms(currentRooms(t, a, 5), 1, 2, 4, 5) {
		t.Fatalf("ほかのクラスの個人チャットに入り込んだ職員: %v", currentRooms(t, a, 5))
	}
	if !sameRooms(currentRooms(t, a, 3), 1, 2, 3, 5, 6, 7, 8, 9) {
		t.Fatalf("職員チャットから外れていた職員: %v", currentRooms(t, a, 3))
	}
	if !sameRooms(currentRooms(t, a, 6), 1, 3, 6) {
		t.Fatalf("職員チャットに入った保護者: %v", currentRooms(t, a, 6))
	}
	if !sameRooms(currentRooms(t, a, 9), 1, 3, 8) {
		t.Fatalf("目的別グループに入った保護者: %v", currentRooms(t, a, 9))
	}
}
