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
