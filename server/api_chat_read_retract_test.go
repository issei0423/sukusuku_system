package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

/*
 * チャットの既読・届く人数・取消・グループ編成の一覧（GitHub Issue #171・#172・#141）
 * 典拠：基本設計書「既読確認」(4-6)・「誤送信への対応」(4-6)・「チャット」(5-5)
 *      要件定義書「チャットツール」(4-3)「既読確認」「メッセージの削除」
 *      図/画面詳細図.md「チャット画面（職員）」(4-1) No.19・「グループ編成画面」(4-3)・「誤送信対応記録画面」(4-4)
 *
 * 画面側のモック（web/src/api/mock.ts）も同じ規則にしてある。web/tests/chatReadRetract.test.ts が同じ観点を確かめる。
 * デモデータのチャンネルとアカウントは api_chat_membership_test.go の説明のとおり。アカウント 8 は停止中の保護者。
 */

// chatMessagesOf は、その利用者が読めるメッセージを ID で引けるようにして返す
func chatMessagesOf(t *testing.T, h http.Handler, c *http.Cookie, roomID string) map[int64]ChatMessage {
	t.Helper()
	var list []ChatMessage
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/chat/rooms/"+roomID+"/messages", "").Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	out := map[int64]ChatMessage{}
	for _, m := range list {
		out[m.ChatMessageID] = m
	}
	return out
}

func memberIDsOf(t *testing.T, h http.Handler, c *http.Cookie, roomID string) map[int64]bool {
	t.Helper()
	var list []memberView
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/chat/rooms/"+roomID+"/members", "").Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	out := map[int64]bool{}
	for _, m := range list {
		out[m.AccountID] = true
	}
	return out
}

func sentID(t *testing.T, rec interface{ Bytes() []byte }) int64 {
	t.Helper()
	var got struct {
		ChatMessageID int64 `json:"chat_message_id"`
	}
	if err := json.Unmarshal(rec.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got.ChatMessageID
}

// #171 の 1：後から登録した保護者が、見えない登録前のメッセージまで既読にする
func TestMarkReadSkipsMessagesBeforeJoined(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	// 上園 花子（C002）の家庭に、新しい保護者（上園 母）が招待コードで加わる
	var issued struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(call(t, h, admin, "POST", "/api/admin/invitations",
		`{"child_id":"C002","valid_days":14}`).Body.Bytes(), &issued); err != nil {
		t.Fatal(err)
	}
	rec := send(t, h, nil, "POST", "/api/signup", `{"code":"`+issued.Code+`","email":"uezono.haha@example.jp",
		"password":"uezono-5678","guardian_name":"上園 母","relationship":"母","terms_agreed":true,"terms_version":"1.1"}`)
	expectStatus(t, rec, http.StatusOK)
	haha := sessionCookieOf(t, rec)

	const personalRoom = "7" // 上園 花子の保護者。ID 7（担任が送ったメッセージ）は登録より前のもの
	if got := chatMessagesOf(t, h, haha, personalRoom); len(got) != 0 {
		t.Fatalf("登録より前のメッセージが見えている: %v", got)
	}
	// 保護者のチャット画面は、チャンネルを開くとこれを呼ぶ
	call(t, h, haha, "POST", "/api/chat/rooms/"+personalRoom+"/read", "")

	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_read r JOIN m_account ac ON ac.account_id = r.account_id
		WHERE r.chat_message_id = 7 AND ac.email = 'uezono.haha@example.jp'`).Scan(&n)
	if n != 0 {
		t.Fatalf("見えない登録前のメッセージが既読になった（%d 件）", n)
	}
	takanashi := loginAs(a, 3, "staff")
	if got := chatMessagesOf(t, h, takanashi, personalRoom)[7].ReadCount; got != 0 {
		t.Fatalf("職員の画面の既読 = %d, want 0", got)
	}

	t.Run("登録のあとに届いたものは、開けば既読になる", func(t *testing.T) {
		// 登録と同じ秒に送られたものは見せない側へ倒す（beforeJoinedClause）。登録を数秒前へずらしておく
		if _, err := a.db.Exec(`UPDATE t_chat_member SET joined_at = replace(datetime(joined_at, '-5 seconds'), ' ', 'T')
			WHERE account_id = (SELECT account_id FROM m_account WHERE email = 'uezono.haha@example.jp')`); err != nil {
			t.Fatal(err)
		}
		id := sentID(t, call(t, h, takanashi, "POST", "/api/chat/rooms/"+personalRoom+"/messages",
			`{"body":"ご登録ありがとうございます。"}`).Body)
		call(t, h, haha, "POST", "/api/chat/rooms/"+personalRoom+"/read", "")
		if got := chatMessagesOf(t, h, takanashi, personalRoom)[id].ReadCount; got != 1 {
			t.Fatalf("既読 = %d, want 1", got)
		}
	})
}

// #171 の 2・#141 の 4：「保護者 n 名にも届きます」の n とメンバー欄に、停止した保護者が入る
func TestGuardianCountExcludesSuspendedAccounts(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	takanashi := loginAs(a, 3, "staff")

	// 園全体の保護者のうち、アカウント 8（高梨 倫太朗）は紐づけを終えて停止している。読めるのは 6・7・9・10 の 4 名
	if got := roomViews(t, h, takanashi)[1].GuardianCount; got != 4 {
		t.Fatalf("園全体の保護者 = %d, want 4（停止中のアカウント 8 を数えない）", got)
	}
	if memberIDsOf(t, h, takanashi, "1")[8] {
		t.Fatal("園全体のメンバー欄に、停止中の保護者（アカウント 8）が出ている")
	}

	// 金城 陸（C005）と保護者（G005・アカウント 10）の紐づけを終える。有効な紐づけが無くなりアカウントは停止になる
	call(t, h, admin, "POST", "/api/admin/guardian-links/end", `{"guardian_id":"G005","child_id":"C005"}`)

	views := roomViews(t, h, takanashi)
	for _, c := range []struct {
		room int64
		name string
		want int
	}{{1, "園全体", 3}, {3, "さくら組", 3}, {9, "金城 陸の保護者", 0}} {
		if got := views[c.room].GuardianCount; got != c.want {
			t.Errorf("%s の保護者 = %d, want %d", c.name, got, c.want)
		}
	}
	for _, room := range []string{"1", "3", "9"} {
		if memberIDsOf(t, h, takanashi, room)[10] {
			t.Errorf("room %s のメンバー欄に、紐づけを終えて停止した保護者（アカウント 10）が出ている", room)
		}
	}

	t.Run("紐づけを戻してアカウントが再開すると、また数える", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/admin/guardian-links/restore", `{"guardian_id":"G005","child_id":"C005"}`)
		views := roomViews(t, h, takanashi)
		if views[1].GuardianCount != 4 || views[9].GuardianCount != 1 {
			t.Fatalf("園全体 = %d・金城 陸の保護者 = %d, want 4・1", views[1].GuardianCount, views[9].GuardianCount)
		}
	})
}

// #171 の 5：既読の人数に職員が入り、保護者が何人読んだかが分からない
func TestReadCountCountsGuardiansInGuardianRooms(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff")

	t.Run("保護者が参加するチャンネルでは、保護者の既読だけを数える", func(t *testing.T) {
		// さくら組の「9時に園庭でお願いします。」（ID 3）は、職員 3 名（1・2・4）が読み、保護者は誰も読んでいない
		if got := chatMessagesOf(t, h, takanashi, "3")[3].ReadCount; got != 0 {
			t.Fatalf("既読 = %d, want 0（職員の既読を数えない）", got)
		}
		call(t, h, loginAs(a, 6, "guardian"), "POST", "/api/chat/rooms/3/read", "")
		if got := chatMessagesOf(t, h, takanashi, "3")[3].ReadCount; got != 1 {
			t.Fatalf("保護者が読んだあとの既読 = %d, want 1", got)
		}
	})

	t.Run("職員だけのチャンネルでは、職員の既読を数える", func(t *testing.T) {
		// 職員チャットの「来週の職員会議は水曜16時からです。」（ID 8、上園が送った）
		call(t, h, takanashi, "POST", "/api/chat/rooms/2/read", "")
		if got := chatMessagesOf(t, h, loginAs(a, 2, "staff"), "2")[8].ReadCount; got != 1 {
			t.Fatalf("職員チャットの既読 = %d, want 1", got)
		}
	})
}

// #141 の 1：メッセージの送信者が、職員なのか保護者なのか分からない
func TestChatMessageCarriesSenderRole(t *testing.T) {
	a, h := newTestApp(t)
	for _, viewer := range []struct {
		name   string
		cookie *http.Cookie
	}{{"職員", loginAs(a, 3, "staff")}, {"保護者", loginAs(a, 6, "guardian")}} {
		got := chatMessagesOf(t, h, viewer.cookie, "6")
		// ID 4 は担任（高梨）が送ったもの、ID 5 は保護者（野原 一誠）が送ったもの
		if got[4].SenderRole != roleGeneralStaff || got[5].SenderRole != roleGuardian {
			t.Errorf("%sの画面：送信者のロール = %q・%q, want %q・%q", viewer.name,
				got[4].SenderRole, got[5].SenderRole, roleGeneralStaff, roleGuardian)
		}
	}
}

// #171 の 4：保護者が自分のメッセージを取り消すと、誤送信対応の「対応の記録がない取消メッセージ」に並ぶ
func TestRetractedWithoutRecordExcludesGuardianMessages(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	guardian := loginAs(a, 9, "guardian")
	takanashi := loginAs(a, 3, "staff")

	byGuardian := sentID(t, call(t, h, guardian, "POST", "/api/chat/rooms/8/messages",
		`{"body":"明日はお休みします（打ちまちがい）"}`).Body)
	call(t, h, guardian, "POST", "/api/chat/messages/"+itoa(byGuardian)+"/retract", "")
	byStaff := sentID(t, call(t, h, takanashi, "POST", "/api/chat/rooms/8/messages",
		`{"body":"（誤送信）野原 太郎くんの発熱の記録"}`).Body)
	call(t, h, takanashi, "POST", "/api/chat/messages/"+itoa(byStaff)+"/retract", "")

	var pending []struct {
		ChatMessageID int64 `json:"chat_message_id"`
	}
	if err := json.Unmarshal(call(t, h, admin, "GET", "/api/chat/misdelivery/pending", "").Body.Bytes(), &pending); err != nil {
		t.Fatal(err)
	}
	ids := map[int64]bool{}
	for _, p := range pending {
		ids[p.ChatMessageID] = true
	}
	if ids[byGuardian] {
		t.Error("保護者が自分で取り消したメッセージが、誤送信対応の対象に並ぶ")
	}
	if !ids[byStaff] {
		t.Error("職員が取り消したメッセージが、誤送信対応の対象に並ばない")
	}
}

// #172 の 4：一般の職員のグループ編成画面に、自分の入っていないグループが出る
func TestChatGroupsListsOnlyEditableGroups(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff")
	kinjo := loginAs(a, 5, "staff")
	admin := loginAs(a, 1, "staff")

	var created ChatRoom
	if err := json.Unmarshal(call(t, h, takanashi, "POST", "/api/chat/groups",
		`{"name":"G 遠足下見（高梨・宮城）","account_ids":[4]}`).Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	groupIDs := func(c *http.Cookie) map[int64]bool {
		var list []ChatRoom
		if err := json.Unmarshal(call(t, h, c, "GET", "/api/chat/groups", "").Body.Bytes(), &list); err != nil {
			t.Fatal(err)
		}
		out := map[int64]bool{}
		for _, g := range list {
			out[g.ChatRoomID] = true
		}
		return out
	}

	if got := groupIDs(kinjo); got[created.ChatRoomID] || !got[5] {
		t.Fatalf("金城（運動会実行委員だけに参加）のグループ = %v", got)
	}
	if got := groupIDs(admin); !got[created.ChatRoomID] || !got[5] {
		t.Fatalf("管理者には、参加していないグループも出す（全グループを参照・編成できる）: %v", got)
	}
	t.Run("外されたグループは、編成できないので出さない", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/chat/groups/5/members", `{"account_ids":[1,3]}`)
		if got := groupIDs(kinjo); got[5] {
			t.Fatalf("外された運動会実行委員が出ている: %v", got)
		}
	})
}
