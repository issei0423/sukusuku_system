package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*
保護者のクラスグループの参加を「いまのクラス」に追従させる（照合 c2b-E2）
典拠：基本設計書「権限と参照範囲の判定」(4-2) の表「グループ｜保護者が読める範囲＝現在所属しているグループのみ」、
詳細設計書「判定の関数」(4-1 (2))「『いまのクラス』（担任の判定・クラスグループ・午睡の一覧）」

モック（web/src/api/mock.ts）にも同じ規則がある。web/tests/classGroupFollow.test.ts が同じ観点を確かめる。
*/

// classGroupOf は、そのクラスのクラスグループのルームを返す
func classGroupOf(t *testing.T, a *app, classID int64) int64 {
	t.Helper()
	var id int64
	if err := a.db.QueryRow(`SELECT chat_room_id FROM m_chat_room WHERE room_type = '2' AND class_id = ? AND is_archived = 0`,
		classID).Scan(&id); err != nil {
		t.Fatalf("クラス %d のクラスグループが無い: %v", classID, err)
	}
	return id
}

// memberOf は、参加の行の joined_at と left_at を返す。行が無ければ ok は偽
func memberOf(a *app, roomID, accountID int64) (joinedAt string, leftAt sql.NullString, ok bool) {
	err := a.db.QueryRow(`SELECT joined_at, left_at FROM t_chat_member WHERE chat_room_id = ? AND account_id = ?`,
		roomID, accountID).Scan(&joinedAt, &leftAt)
	return joinedAt, leftAt, err == nil
}

// 新規登録では、いまの年度のクラスのクラスグループにだけ入る。過年度のクラスグループ（閲覧のみのアーカイブ）には入らない
// （基本設計書「年度更新」(4-4)「過年度のクラスグループは閲覧のみのアーカイブとして残す（保護者は現在所属しているグループしか読めない）」）
func TestSignUpJoinsOnlyCurrentClassGroup(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	body, _ := json.Marshal(childInput{ChildID: "C901", ChildName: "試験 花", ChildNameKana: "しけん はな", BirthDate: "2024-05-01",
		Sex: "2", PhotoConsentLevel: "2", ClassID: 2, Mode: "create"})
	expectStatus(t, request(t, h, admin, "POST", "/api/children", string(body)), http.StatusOK)

	// 前の年度は 2025 年度のさくら組（11）にいたことにし、その年度のクラスグループをアーカイブとして置く
	res, err := a.db.Exec(`INSERT INTO m_chat_room (room_type, class_id, room_name, is_archived) VALUES ('2', 11, 'さくら組', 1)`)
	if err != nil {
		t.Fatal(err)
	}
	pastRoom, _ := res.LastInsertId()
	if _, err := a.db.Exec(`INSERT INTO t_class_child (class_id, child_id) VALUES (11, 'C901')`); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(`INSERT INTO t_invitation_code (code, child_id, expires_on, status, issued_staff_id, created_at)
		VALUES ('FOLLOW-901', 'C901', '2099-12-31', '1', 'S001', ?)`, now()); err != nil {
		t.Fatal(err)
	}
	signup, _ := json.Marshal(signUpRequest{Code: "FOLLOW-901", Email: "follow901@example.jp", Password: "Momo2026!abc",
		GuardianName: "試験 保護者", Relationship: "母", TermsAgreed: true, TermsVersion: a.currentTermsVersion})
	req := httptest.NewRequest("POST", "/api/signup", strings.NewReader(string(signup)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	expectStatus(t, rec, http.StatusOK)

	var accountID int64
	if err := a.db.QueryRow(`SELECT account_id FROM m_account WHERE email = 'follow901@example.jp'`).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	if _, left, ok := memberOf(a, classGroupOf(t, a, 2), accountID); !ok || left.Valid {
		t.Errorf("いまのクラス（ひまわり組）のクラスグループに入っていない: ok=%v left=%v", ok, left)
	}
	if _, _, ok := memberOf(a, pastRoom, accountID); ok {
		t.Errorf("過年度のクラスグループ（アーカイブ）に入った")
	}
}
