package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * チャットの送る時点と見る範囲の守り
 *   GitHub Issue #299（他児の名前の注意）・#308（猶予中の保護者）・#301（登録と同じ秒）・#312 の 1（管理者のチャンネル一覧）
 *   ・#270 の 1（発達チェックの保護者へのひとこと）・#310（符号位置で数える）
 * 典拠：基本設計書「送る時点の守り」(4-2)・「メッセージの送受信」(4-7)・「メッセージの編集」(4-7)・「メッセージ一覧」(4-12)、
 *      詳細設計書「チャット画面（職員・保護者）」(2-9 (5))・「検査の共通の規則」(4-1 (5))・「発達チェックの保存」(4-12 (2))、
 *      要件定義書「過去ログの参照範囲」(4-4 (c))
 *
 * 画面側のモック（web/src/api/mock.ts）も同じ規則にしてある。web/tests/chatGuards.test.ts が同じ観点を確かめる。
 */

const (
	// 在籍中の別の園児の名前（C004）。西田 太郎（C001）の個人チャットでは他児になる
	otherChildText = "今日は村田 美咲さんと遊びました"
	// 当たる名前（照合の応答の names）
	otherChildName = "村田 美咲"
)

// chatSend は、チャンネルへ送る。応答の状態を問わずに返す
func chatSend(t *testing.T, h http.Handler, c *http.Cookie, room int64, body string, ack ...string) (int, string) {
	t.Helper()
	req := map[string]any{"body": body}
	if len(ack) > 0 {
		req["acknowledged_names"] = ack
	}
	b, _ := json.Marshal(req)
	rec := chatReq(h, c, "POST", "/api/chat/rooms/"+itoa(room)+"/messages", string(b))
	return rec.Code, rec.Body.String()
}

func chatMessageCount(t *testing.T, a *app, room int64, body string) int {
	t.Helper()
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE chat_room_id = ? AND body = ?`, room, body).Scan(&n)
	return n
}

// 保護者の参加するチャンネルへ職員が送るときは、他児の名前の注意（409）を通る（Issue #299）
func TestChatSendOtherNames(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	admin := loginAs(a, accAdmin, "staff")
	guardian := loginAs(a, accGuardian, "guardian")

	// 個人チャット（6：西田 太郎）：宛先以外の在籍園児の名前に当たる
	code, body := chatSend(t, h, teacher, 6, otherChildText)
	if code != http.StatusConflict {
		t.Fatalf("個人チャットで他児の名前に当たったのに %d: %s", code, body)
	}
	var e apiError
	if err := json.Unmarshal([]byte(body), &e); err != nil {
		t.Fatal(err)
	}
	if e.Kind != kindOtherChildNames || len(e.Names) != 1 || e.Names[0] != otherChildName || len(e.Matches) == 0 {
		t.Errorf("注意の応答: %+v", e)
	}
	if e.Message != "ほかのお子さんの名前（"+otherChildName+"）が入っています。このまま送りますか。" {
		t.Errorf("注意の文: %s", e.Message)
	}
	if chatMessageCount(t, a, 6, otherChildText) != 0 {
		t.Error("注意で止めたのに保存された")
	}
	// 承諾した名前を付けて送り直すと保存される
	if code, body := chatSend(t, h, teacher, 6, otherChildText, otherChildName); code != http.StatusOK {
		t.Fatalf("承諾を付けても送れない: %d %s", code, body)
	}
	if chatMessageCount(t, a, 6, otherChildText) != 1 {
		t.Error("承諾を付けて送ったのに保存されていない")
	}
	// 宛先の園児の名前では注意を出さない
	if code, body := chatSend(t, h, teacher, 6, "今日の西田 太郎さんは元気でした"); code != http.StatusOK {
		t.Errorf("宛先の園児の名前で止まった: %d %s", code, body)
	}

	// クラスグループ（3）・園チャット（1）：在籍園児の全員が相手。宛先の園児も当たる
	if code, body := chatSend(t, h, teacher, 3, "今日は西田 太郎さんが"); code != http.StatusConflict {
		t.Errorf("クラスグループで止まらない: %d %s", code, body)
	}
	if code, body := chatSend(t, h, admin, 1, otherChildText); code != http.StatusConflict {
		t.Errorf("園チャットで止まらない: %d %s", code, body)
	}
	if code, body := chatSend(t, h, admin, 1, otherChildText, otherChildName); code != http.StatusOK {
		t.Errorf("園チャットで承諾を付けても送れない: %d %s", code, body)
	}

	// 職員だけのチャンネル（職員チャット 2・目的別グループ 5）は照合しない
	for _, room := range []int64{2, 5} {
		if code, body := chatSend(t, h, admin, room, otherChildText); code != http.StatusOK {
			t.Errorf("職員だけのチャンネル %d で止まった: %d %s", room, code, body)
		}
	}
	// 保護者が園へ送るものは照合しない（関所を通るのは職員が保護者へ届けるもの）
	if code, body := chatSend(t, h, guardian, 6, otherChildText+"（保護者から）"); code != http.StatusOK {
		t.Errorf("保護者の送信が止まった: %d %s", code, body)
	}
}

// 編集を保存するときも、他児の名前の注意を通る（Issue #299）。保護者の編集は通らない
func TestChatEditOtherNames(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")

	var sent map[string]int64
	decode(t, call(t, h, teacher, "POST", "/api/chat/rooms/6/messages", `{"body":"編集の前"}`), &sent)
	id := sent["chat_message_id"]
	path := "/api/chat/messages/" + itoa(id) + "/edit"

	rec := chatReq(h, teacher, "POST", path, `{"body":"`+otherChildText+`"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("編集で他児の名前に当たったのに %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"kind":"other_child_names"`) {
		t.Errorf("注意の応答: %s", rec.Body.String())
	}
	var body string
	a.db.QueryRow(`SELECT body FROM t_chat_message WHERE chat_message_id = ?`, id).Scan(&body)
	if body != "編集の前" {
		t.Errorf("注意で止めたのに本文が変わった: %q", body)
	}
	call(t, h, teacher, "POST", path, `{"body":"`+otherChildText+`","acknowledged_names":["`+otherChildName+`"]}`)
	a.db.QueryRow(`SELECT body FROM t_chat_message WHERE chat_message_id = ?`, id).Scan(&body)
	if body != otherChildText {
		t.Errorf("承諾を付けた編集が保存されていない: %q", body)
	}

	// 保護者が自分の発言を直すときは照合しない
	var mine map[string]int64
	decode(t, call(t, h, guardian, "POST", "/api/chat/rooms/6/messages", `{"body":"保護者から"}`), &mine)
	call(t, h, guardian, "POST", "/api/chat/messages/"+itoa(mine["chat_message_id"])+"/edit", `{"body":"`+otherChildText+`"}`)
}

// 猶予中（紐づけが 3）の保護者は、読めるが、どのチャンネルへも書けない（Issue #308）
func TestChatGraceGuardianCannotWrite(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")

	var sent map[string]int64
	decode(t, call(t, h, guardian, "POST", "/api/chat/rooms/6/messages", `{"body":"猶予の前に送った"}`), &sent)
	call(t, h, teacher, "POST", "/api/chat/rooms/6/messages", `{"body":"園からの返事"}`)

	if _, err := a.db.Exec(`UPDATE m_child SET enrollment_status = '2' WHERE child_id = 'C001'`); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(`UPDATE t_guardian_child SET link_status = '3', grace_ends_on = ? WHERE guardian_id = 'G001' AND child_id = 'C001'`,
		daysFromToday(30)); err != nil {
		t.Fatal(err)
	}
	const want = "卒園・退園したお子さまのやりとりは、読むことだけができます。"

	// 個人チャット：送る・直すは 403 とその文言。何も増えない・変わらない
	var before int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE chat_room_id = 6`).Scan(&before)
	for _, room := range []int64{6, 1, 3} {
		code, body := chatSend(t, h, guardian, room, "猶予のあとに送る")
		if code != http.StatusForbidden || !strings.Contains(body, want) {
			t.Errorf("猶予中の保護者が room %d へ送れた／文言が違う: %d %s", room, code, body)
		}
	}
	rec := chatReq(h, guardian, "POST", "/api/chat/messages/"+itoa(sent["chat_message_id"])+"/edit", `{"body":"猶予のあとに直す"}`)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), want) {
		t.Errorf("猶予中の保護者が編集できた／文言が違う: %d %s", rec.Code, rec.Body.String())
	}
	var after int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE chat_room_id = 6`).Scan(&after)
	if after != before {
		t.Errorf("メッセージが増えた: %d → %d", before, after)
	}
	var body string
	a.db.QueryRow(`SELECT body FROM t_chat_message WHERE chat_message_id = ?`, sent["chat_message_id"]).Scan(&body)
	if body != "猶予の前に送った" {
		t.Errorf("本文が変わった: %q", body)
	}

	// 読むのは設計どおり。チャンネル一覧では投稿できない印（canPost が偽）になる
	var msgs []ChatMessage
	decode(t, call(t, h, guardian, "GET", "/api/chat/rooms/6/messages", ""), &msgs)
	if len(msgs) < 2 {
		t.Errorf("猶予中の保護者が過去ログを読めない: %d 件", len(msgs))
	}
	if v := roomViews(t, h, guardian)[6]; v.Room.ChatRoomID != 6 || v.CanPost {
		t.Errorf("猶予中の個人チャット: %+v", v)
	}
}

// 有効な紐づけが残っている保護者は、猶予中の子とは別の子の個人チャットへ書ける（きょうだい）
func TestChatGraceSiblingStillWrites(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")
	// G001 に、有効な紐づけの子（C002 遠藤 花子）をもう1人足し、C001 だけ猶予中にする
	if _, err := a.db.Exec(`INSERT INTO t_guardian_child (guardian_id, child_id, relationship, link_status, linked_at)
		VALUES ('G001', 'C002', '父', '1', '2026-01-01T10:00:00')`); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(`UPDATE t_guardian_child SET link_status = '3', grace_ends_on = ? WHERE guardian_id = 'G001' AND child_id = 'C001'`,
		daysFromToday(30)); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at) VALUES (7, ?, '2026-01-01T10:00:00')`, accGuardian); err != nil {
		t.Fatal(err)
	}
	if code, _ := chatSend(t, h, guardian, 6, "猶予中の子"); code != http.StatusForbidden {
		t.Errorf("猶予中の子のチャットへ送れた: %d", code)
	}
	if code, body := chatSend(t, h, guardian, 7, "有効な子"); code != http.StatusOK {
		t.Errorf("有効な子のチャットへ送れない: %d %s", code, body)
	}
}

// 登録と同じ秒の境（Issue #301）。最初の保護者は (最初の参加の日時, アカウントID) の順で決め、
// 最初でない保護者には、同じ秒のメッセージを見せない
func TestChatSameSecondJoinHidesFromLaterGuardian(t *testing.T) {
	a, h := newTestApp(t)
	res, err := a.db.Exec(`INSERT INTO m_chat_room (room_type, class_id, room_name, is_archived, thread_status, child_id)
		VALUES ('4', 1, '同じ秒の部屋', 0, '2', NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	room, _ := res.LastInsertId()
	const at = "2026-10-01T10:00:05"
	for _, m := range []struct {
		acc    int64
		joined string
	}{{3, "2026-10-01T09:00:00"}, {9, at}, {10, at}} {
		if _, err := a.db.Exec(`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at) VALUES (?, ?, ?)`, room, m.acc, m.joined); err != nil {
			t.Fatal(err)
		}
	}
	for _, m := range []struct {
		sender int64
		body   string
		sentAt string
	}{
		{3, "入園の前の案内", "2026-10-01T10:00:00"},
		{9, "先の保護者の相談", at},
		{3, "先の保護者への返事", at},
		{3, "登録のあと", "2026-10-01T10:00:06"},
	} {
		if _, err := a.db.Exec(`INSERT INTO t_chat_message (chat_room_id, sender_account_id, body, source_type, sent_at, is_deleted)
			VALUES (?, ?, ?, '1', ?, 0)`, room, m.sender, m.body, m.sentAt); err != nil {
			t.Fatal(err)
		}
	}
	bodies := func(acc int64) []string {
		var msgs []ChatMessage
		decode(t, call(t, h, loginAs(a, acc, "guardian"), "GET", "/api/chat/rooms/"+itoa(room)+"/messages", ""), &msgs)
		out := []string{}
		for _, m := range msgs {
			out = append(out, m.Body)
		}
		return out
	}
	// 先の保護者（アカウントID が小さいほう）にはすべて出る
	if got := bodies(9); len(got) != 4 {
		t.Errorf("先の保護者に隠れた: %v", got)
	}
	// 後の保護者には、保護者がまだいなかった間（登録の前）と登録のあとだけ出る
	got := bodies(10)
	if strings.Join(got, "|") != "入園の前の案内|登録のあと" {
		t.Errorf("後の保護者に、同じ秒のやりとりが見える／見えるべきものが隠れた: %v", got)
	}
	// 未読の数え方も同じ範囲（先の保護者：自分の送信を除く 3 件、後の保護者：2 件）
	unread := func(acc int64) int { return roomViews(t, h, loginAs(a, acc, "guardian"))[room].Unread }
	if unread(9) != 3 || unread(10) != 2 {
		t.Errorf("未読の数: 先=%d 後=%d", unread(9), unread(10))
	}
	// 見えないメッセージにはリアクションも付けられない
	var hidden int64
	a.db.QueryRow(`SELECT chat_message_id FROM t_chat_message WHERE chat_room_id = ? AND body = '先の保護者の相談'`, room).Scan(&hidden)
	if r := chatReq(h, loginAs(a, 10, "guardian"), "POST", "/api/chat/messages/"+itoa(hidden)+"/reactions", `{"reaction_type":"1"}`); r.Code != http.StatusNotFound {
		t.Errorf("同じ秒のメッセージにリアクションできた: %d", r.Code)
	}

	// アカウントID の大小ではなく、最初の参加の日時が先なら先。同じ秒のときだけアカウントIDで決める
	if _, err := a.db.Exec(`UPDATE t_chat_member SET joined_at = '2026-10-01T10:00:04', first_joined_at = '2026-10-01T10:00:04'
		WHERE chat_room_id = ? AND account_id = 10`, room); err != nil {
		t.Fatal(err)
	}
	if got := bodies(10); len(got) != 4 {
		t.Errorf("参加の日時が先の保護者（アカウントID は大きい）に隠れた: %v", got)
	}
}

// 管理者には、参加していないグループも読み取りだけで見せる。書けず、個人チャットは参加の行があるものだけ（Issue #312 の 1）
func TestAdminSeesAllGroups(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")

	res, err := a.db.Exec(`INSERT INTO m_chat_room (room_type, class_id, room_name, is_archived, thread_status, child_id)
		VALUES ('2', 1, '2025年度さくら組', 1, NULL, NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	past, _ := res.LastInsertId()
	// 過去に所属していた担任と保護者（外れている）。管理者は所属したことが無い
	for _, acc := range []int64{accTeacher, accGuardian} {
		if _, err := a.db.Exec(`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at, left_at)
			VALUES (?, ?, '2025-04-01T08:00:00', '2026-03-31T23:59:59')`, past, acc); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.db.Exec(`INSERT INTO t_chat_message (chat_room_id, sender_account_id, body, source_type, sent_at, is_deleted)
		VALUES (?, ?, '過年度のお知らせ', '1', '2026-03-10T10:00:00', 0)`, past, accTeacher); err != nil {
		t.Fatal(err)
	}
	// 管理者が参加していない個人チャット（園児単位の判定なので、管理者に一覧を広げない）
	res, err = a.db.Exec(`INSERT INTO m_chat_room (room_type, class_id, room_name, is_archived, thread_status, child_id)
		VALUES ('4', 1, '参加していない個人チャット', 0, '2', NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	personal, _ := res.LastInsertId()

	v := roomViews(t, h, admin)[past]
	if v.Room.ChatRoomID != past || !v.Left || v.CanPost || v.Unread != 0 {
		t.Errorf("管理者の一覧に、参加していないグループが閲覧のみで出ない: %+v", v)
	}
	if _, ok := roomViews(t, h, admin)[personal]; ok {
		t.Error("管理者が参加していない個人チャットが一覧に出た")
	}
	var msgs []ChatMessage
	decode(t, call(t, h, admin, "GET", "/api/chat/rooms/"+itoa(past)+"/messages", ""), &msgs)
	if len(msgs) != 1 || msgs[0].Body != "過年度のお知らせ" {
		t.Errorf("管理者が過年度のグループを読めない: %+v", msgs)
	}
	expectStatus(t, chatReq(h, admin, "GET", "/api/chat/rooms/"+itoa(personal)+"/messages", ""), http.StatusForbidden)
	if code, _ := chatSend(t, h, admin, past, "管理者の投稿"); code != http.StatusForbidden {
		t.Errorf("管理者が参加していないグループへ書けた: %d", code)
	}

	// 所属したことのない一般の職員と、外れた保護者には出ない（いままでどおり）
	other := loginAs(a, accOtherTeacher, "staff")
	if _, ok := roomViews(t, h, other)[past]; ok {
		t.Error("所属したことのない一般の職員の一覧に出た")
	}
	expectStatus(t, chatReq(h, other, "GET", "/api/chat/rooms/"+itoa(past)+"/messages", ""), http.StatusForbidden)
	if _, ok := roomViews(t, h, guardian)[past]; ok {
		t.Error("外れた保護者の一覧に出た")
	}
	expectStatus(t, chatReq(h, guardian, "GET", "/api/chat/rooms/"+itoa(past)+"/messages", ""), http.StatusForbidden)
	// 所属していた担任は、いままでどおり閲覧のみで読める
	if v := roomViews(t, h, teacher)[past]; !v.Left || v.CanPost {
		t.Errorf("所属していた担任の一覧: %+v", v)
	}
}

// 文字数は符号位置で数える。4バイトの字を含む 1,000 文字は送れ、1,001 文字は送る・直すとも断る（Issue #310）
func TestChatLengthByCodePoint(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")

	exactly := strings.Repeat("𠮷", 1000) // UTF-16 では 2,000
	if code, body := chatSend(t, h, teacher, 6, exactly); code != http.StatusOK {
		t.Fatalf("符号位置で 1,000 文字が送れない: %d %s", code, body)
	}
	over := strings.Repeat("𠮷", 1001)
	if code, _ := chatSend(t, h, teacher, 6, over); code != http.StatusBadRequest {
		t.Errorf("1,001 文字が送れた: %d", code)
	}
	var sent map[string]int64
	decode(t, call(t, h, teacher, "POST", "/api/chat/rooms/6/messages", `{"body":"編集の前"}`), &sent)
	path := "/api/chat/messages/" + itoa(sent["chat_message_id"]) + "/edit"
	expectStatus(t, chatReq(h, teacher, "POST", path, `{"body":"`+over+`"}`), http.StatusBadRequest)
	var body string
	a.db.QueryRow(`SELECT body FROM t_chat_message WHERE chat_message_id = ?`, sent["chat_message_id"]).Scan(&body)
	if body != "編集の前" {
		t.Errorf("1,001 文字の編集が保存された: %d 文字", len([]rune(body)))
	}
	call(t, h, teacher, "POST", path, `{"body":"`+exactly+`"}`)
	a.db.QueryRow(`SELECT body FROM t_chat_message WHERE chat_message_id = ?`, sent["chat_message_id"]).Scan(&body)
	if len([]rune(body)) != 1000 {
		t.Errorf("符号位置で 1,000 文字の編集が保存されていない: %d 文字", len([]rune(body)))
	}
}

// 発達チェックを確定するときの保護者へのひとことは、他児の名前の注意を通る。下書きは通らない（Issue #270 の 1）
func TestDevelopmentGuardianMessageOtherNames(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff") // さくら組
	check := func(status, extra string) *http.Response {
		body := `{"child_id":"C001","checked_on":"` + today() + `","status":"` + status + `","results":[],"note":"",` +
			`"guardian_message":"` + otherChildText + `"` + extra + `}`
		return chatReq(h, teacher, "POST", "/api/development/checks", body).Result()
	}
	grown := func() int {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_development_check WHERE child_id = 'C001' AND guardian_message = ? AND status = '2'`,
			otherChildText).Scan(&n)
		return n
	}

	// 下書きは保護者に届かないので照合しない
	if r := check("1", ""); r.StatusCode != http.StatusOK {
		t.Fatalf("下書きが止まった: %d", r.StatusCode)
	}
	// 確定は止まる（保存されない）
	r := check("2", "")
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("確定で他児の名前に当たったのに %d", r.StatusCode)
	}
	var e apiError
	if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
		t.Fatal(err)
	}
	if e.Kind != kindOtherChildNames || len(e.Names) != 1 || e.Names[0] != otherChildName {
		t.Errorf("注意の応答: %+v", e)
	}
	if grown() != 0 {
		t.Error("注意で止めたのに確定した")
	}
	// 承諾を付けると確定する
	if r := check("2", `,"acknowledged_names":["`+otherChildName+`"]`); r.StatusCode != http.StatusOK {
		t.Fatalf("承諾を付けても確定できない: %d", r.StatusCode)
	}
	if grown() != 1 {
		t.Error("承諾を付けて確定したのに保存されていない")
	}
}
