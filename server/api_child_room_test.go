package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 詳細設計書「園児の登録と個人チャット」(4-9)。
func TestChildRegistrationCreatesPersonalRoom(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	body, _ := json.Marshal(childInput{ChildID: "C901", ChildName: "試験 花", ChildNameKana: "しけん はな", BirthDate: "2025-01-01", Sex: "2", PhotoConsentLevel: "2", ClassID: 2, Mode: "create"})
	expectStatus(t, request(t, h, admin, "POST", "/api/children", string(body)), http.StatusOK)
	var roomID int64
	if err := a.db.QueryRow(`SELECT chat_room_id FROM m_chat_room WHERE child_id = 'C901' AND room_type = '4' AND class_id = 2 AND thread_status = '2'`).Scan(&roomID); err != nil {
		t.Fatal(err)
	}
	for _, accountID := range []int64{1, 2, 5} {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_member WHERE chat_room_id = ? AND account_id = ? AND left_at IS NULL`, roomID, accountID).Scan(&n)
		if n != 1 {
			t.Fatalf("参加者 %d: %d", accountID, n)
		}
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_member WHERE chat_room_id = ? AND account_id = 3`, roomID).Scan(&n)
	if n != 0 {
		t.Fatal("別クラスの担任が参加した")
	}
}

func TestChildCsvCreatesPersonalRooms(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	body, _ := json.Marshal(map[string]string{"text": csvHead + "C901,試験 花,しけん はな,2025-01-01,2,ひまわり組,36.5\n"})
	expectStatus(t, request(t, h, admin, "POST", "/api/children/csv/import", string(body)), http.StatusOK)
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_chat_room WHERE child_id = 'C901' AND room_type = '4'`).Scan(&n)
	if n != 1 {
		t.Fatalf("個人チャット %d 件", n)
	}
}

func TestPersonalRoomFailureRollsBackChild(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	if _, err := a.db.Exec(`CREATE TRIGGER reject_personal_room BEFORE INSERT ON m_chat_room
		WHEN NEW.child_id = 'C901' BEGIN SELECT RAISE(FAIL, 'test'); END`); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(childInput{ChildID: "C901", ChildName: "試験 花", ChildNameKana: "しけん はな", BirthDate: "2025-01-01", Sex: "2", PhotoConsentLevel: "2", ClassID: 2, Mode: "create"})
	r := request(t, h, admin, "POST", "/api/children", string(body))
	expectStatus(t, r, http.StatusInternalServerError)
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_child WHERE child_id = 'C901'`).Scan(&n)
	if n != 0 {
		t.Fatal("個人チャット作成失敗後に園児が残った")
	}
}

func TestMissingPersonalRoomMigrationAndCancellation(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	if _, err := a.db.Exec(`DELETE FROM t_chat_member WHERE chat_room_id = (SELECT chat_room_id FROM m_chat_room WHERE child_id = 'C003')`); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(`DELETE FROM m_chat_room WHERE child_id = 'C003'`); err != nil {
		t.Fatal(err)
	}
	if err := ensureMissingPersonalRooms(a.db); err != nil {
		t.Fatal(err)
	}
	if err := ensureMissingPersonalRooms(a.db); err != nil {
		t.Fatal(err)
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_chat_room WHERE child_id = 'C003'`).Scan(&n)
	if n != 1 {
		t.Fatalf("移行後のルーム数 %d", n)
	}
	// 登録直後で記録が無い園児は取消でき、ルームもアーカイブされる。
	body, _ := json.Marshal(childInput{ChildID: "C901", ChildName: "試験 花", ChildNameKana: "しけん はな", BirthDate: "2025-01-01", Sex: "2", PhotoConsentLevel: "2", ClassID: 2, Mode: "create"})
	expectStatus(t, request(t, h, admin, "POST", "/api/children", string(body)), http.StatusOK)
	expectStatus(t, request(t, h, admin, "DELETE", "/api/children/C901", ""), http.StatusOK)
	a.db.QueryRow(`SELECT is_archived FROM m_chat_room WHERE child_id = 'C901'`).Scan(&n)
	if n != 1 {
		t.Fatal("取消後もルームが有効")
	}
}

func TestGuardianJoinsExistingRoomAfterRegistration(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	body, _ := json.Marshal(childInput{ChildID: "C901", ChildName: "試験 花", ChildNameKana: "しけん はな", BirthDate: "2025-01-01", Sex: "2", PhotoConsentLevel: "2", ClassID: 2, Mode: "create"})
	expectStatus(t, request(t, h, admin, "POST", "/api/children", string(body)), http.StatusOK)
	if _, err := a.db.Exec(`INSERT INTO t_invitation_code (code, child_id, expires_on, status, issued_staff_id, created_at)
		VALUES ('ROOM-901', 'C901', '2099-12-31', '1', 'S001', ?)`, now()); err != nil {
		t.Fatal(err)
	}
	var roomID int64
	a.db.QueryRow(`SELECT chat_room_id FROM m_chat_room WHERE child_id = 'C901'`).Scan(&roomID)
	signup, _ := json.Marshal(signUpRequest{Code: "ROOM-901", Email: "room901@example.jp", Password: "Momo2026!abc", GuardianName: "試験 保護者", Relationship: "母", TermsAgreed: true, TermsVersion: a.currentTermsVersion})
	req := httptest.NewRequest("POST", "/api/signup", strings.NewReader(string(signup)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	expectStatus(t, rec, http.StatusOK)
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_member m JOIN m_account ac ON ac.account_id = m.account_id
		WHERE m.chat_room_id = ? AND ac.email = 'room901@example.jp' AND m.left_at IS NULL`, roomID).Scan(&n)
	if n != 1 {
		t.Fatal("保護者が既存の個人チャットに参加していない")
	}
	a.db.QueryRow(`SELECT COUNT(*) FROM m_chat_room WHERE child_id = 'C901'`).Scan(&n)
	if n != 1 {
		t.Fatal("保護者登録で個人チャットが重複した")
	}
}

// 最初の保護者が参加する前の投稿だけは、後から参加した保護者も読める。
func TestPersonalRoomMessagesBeforeFirstGuardianJoin(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	body, _ := json.Marshal(childInput{ChildID: "C901", ChildName: "試験 花", ChildNameKana: "しけん はな", BirthDate: "2025-01-01", Sex: "2", PhotoConsentLevel: "2", ClassID: 2, Mode: "create"})
	expectStatus(t, request(t, h, admin, "POST", "/api/children", string(body)), http.StatusOK)
	var roomID int64
	if err := a.db.QueryRow(`SELECT chat_room_id FROM m_chat_room WHERE child_id = 'C901'`).Scan(&roomID); err != nil {
		t.Fatal(err)
	}
	room := itoa(roomID)
	for _, msg := range []struct {
		sender     int
		body, sent string
	}{
		{5, "保護者登録前", "2026-01-01T10:00:00"},
		{5, "最初の保護者が参加した後の園の投稿", "2026-01-03T10:00:00"},
		{6, "最初の保護者の投稿", "2026-01-03T11:00:00"},
	} {
		if _, err := a.db.Exec(`INSERT INTO t_chat_message (chat_room_id, sender_account_id, body, source_type, sent_at, is_deleted)
			VALUES (?, ?, ?, '1', ?, 0)`, roomID, msg.sender, msg.body, msg.sent); err != nil {
			t.Fatal(err)
		}
	}
	for _, member := range []struct {
		id     int
		joined string
		left   any
	}{
		{6, "2026-01-02T10:00:00", nil},
		{7, "2026-01-05T10:00:00", nil},
	} {
		if _, err := a.db.Exec(`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at, left_at) VALUES (?, ?, ?, ?)`, roomID, member.id, member.joined, member.left); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.db.Exec(`UPDATE m_account SET terms_version = ?, terms_agreed_at = ? WHERE account_id IN (6, 7)`, a.currentTermsVersion, now()); err != nil {
		t.Fatal(err)
	}
	first := loginAs(a, 6, "guardian")
	second := loginAs(a, 7, "guardian")
	if got := roomViews(t, h, first)[roomID].Unread; got != 2 {
		t.Fatalf("最初の保護者の未読 = %d, want 2", got)
	}
	if got := chatMessagesOf(t, h, first, room); len(got) != 3 {
		t.Fatalf("最初の保護者に見える投稿 = %v", got)
	}
	// 既存の保護者が抜けても、最初に参加した日時を境界として残す。
	if _, err := a.db.Exec(`UPDATE t_chat_member SET left_at = '2026-01-04T10:00:00' WHERE chat_room_id = ? AND account_id = 6`, roomID); err != nil {
		t.Fatal(err)
	}
	if got := roomViews(t, h, second)[roomID].Unread; got != 1 {
		t.Fatalf("後から参加した保護者の未読 = %d, want 1", got)
	}
	if got := chatMessagesOf(t, h, second, room); len(got) != 1 {
		t.Fatalf("後から参加した保護者に見える投稿 = %v", got)
	}
	expectStatus(t, send(t, h, first, "GET", "/api/chat/rooms/"+room+"/messages", ""), http.StatusForbidden)
	expectStatus(t, call(t, h, second, "POST", "/api/chat/rooms/"+room+"/read", ""), http.StatusOK)
	if got := roomViews(t, h, second)[roomID].Unread; got != 0 {
		t.Fatalf("既読後の未読 = %d", got)
	}
}

// 呼び名は職員にだけ返し、保護者へ返す園児の一覧には入れない（インタフェース一覧「Child」）。
func TestGuardianChildrenOmitNickname(t *testing.T) {
	a, _ := newTestApp(t)
	if _, err := a.db.Exec(`UPDATE m_child SET nickname = 'しんちゃん' WHERE child_id = 'C001'`); err != nil {
		t.Fatal(err)
	}
	gid := "G001"
	guardian, err := a.visibleChildren(&SessionUser{AccountID: 6, Role: "3", GuardianID: &gid})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range guardian {
		if c.Nickname != "" {
			t.Fatalf("保護者の一覧に呼び名 %q が入った（%s）", c.Nickname, c.ChildID)
		}
	}
	staff, err := a.visibleChildren(&SessionUser{AccountID: 1, Role: "1"})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range staff {
		found = found || (c.ChildID == "C001" && c.Nickname == "しんちゃん")
	}
	if !found {
		t.Fatal("管理者の一覧に呼び名が入っていない")
	}
}
