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

// moveChildClass は、園児情報の編集で、その園児のクラスだけを替える（ほかの項目はいまの値のまま送る）
func moveChildClass(t *testing.T, a *app, h http.Handler, admin *http.Cookie, childID string, classID int64) {
	t.Helper()
	in := childInput{ChildID: childID, ClassID: classID, Mode: "edit"}
	if err := a.db.QueryRow(`SELECT child_name, child_name_kana, birth_date, sex, photo_consent_level FROM m_child WHERE child_id = ?`,
		childID).Scan(&in.ChildName, &in.ChildNameKana, &in.BirthDate, &in.Sex, &in.PhotoConsentLevel); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(in)
	expectStatus(t, request(t, h, admin, "POST", "/api/children", string(body)), http.StatusOK)
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

// 年度の途中で園児のクラスを替えたら、その園児に有効な紐づけのある保護者は、前のクラスのクラスグループから外れ、
// 新しいクラスのクラスグループへ今の時刻で入る。前のクラスに、ほかに有効な紐づけの子がいれば、前のクラスのグループに残る
// （紐づけの解除の leaveRoomsOfChild と同じ条件）
func TestChildClassChangeMovesGuardianClassGroup(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	sakura, himawari := classGroupOf(t, a, 1), classGroupOf(t, a, 2)

	t.Run("前のクラスに、ほかに有効な紐づけの子がいなければ、前のクラスのグループから外れて新しいクラスのグループに入る", func(t *testing.T) {
		// 村田 美咲（C004）をさくら組からひまわり組へ。保護者は村田 真一（アカウント9・G004）だけ
		const murata = 9
		// 前提（デモデータの形）が崩れたら、黙って飛ばさずに落とす。崩れたまま緑になると、確かめていないことに気づけない
		if _, left, ok := memberOf(a, sakura, murata); !ok || left.Valid {
			t.Fatalf("デモデータの前提が変わった（村田 真一のさくら組の参加: ok=%v left=%v）", ok, left)
		}
		at := now()
		moveChildClass(t, a, h, admin, "C004", 2)

		if _, left, _ := memberOf(a, sakura, murata); !left.Valid {
			t.Errorf("前のクラス（さくら組）のグループから外れていない")
		}
		joinedAt, left, ok := memberOf(a, himawari, murata)
		if !ok || left.Valid {
			t.Fatalf("新しいクラス（ひまわり組）のグループに入っていない: ok=%v left=%v", ok, left)
		}
		if joinedAt < at {
			t.Errorf("参加の時刻 = %q、クラスを替えた時刻（%q 以降）のはず", joinedAt, at)
		}
		guardian := loginAs(a, murata, "guardian")
		rooms := roomIDsOf(t, h, guardian)
		if !rooms[himawari] || rooms[sakura] {
			t.Errorf("保護者のチャンネル一覧 = %v（ひまわり組 %d だけがあり、さくら組 %d は無いはず）", rooms, himawari, sakura)
		}
	})

	t.Run("前のクラスに、ほかに有効な紐づけの子がいれば、前のクラスのグループに残る", func(t *testing.T) {
		// 西田 拓也（アカウント6・G001）に、さくら組の遠藤 花子（C002）を有効な紐づけでつなぎ、C002 だけをひまわり組へ。
		// 西田 太郎（C001）はさくら組に残る
		const nishida = 6
		if _, err := a.db.Exec(`INSERT INTO t_guardian_child (guardian_id, child_id, relationship, link_status, linked_at)
			VALUES ('G001', 'C002', '父', '1', '2026-01-01T10:00:00')`); err != nil {
			t.Fatal(err)
		}
		moveChildClass(t, a, h, admin, "C002", 2)

		if _, left, ok := memberOf(a, sakura, nishida); !ok || left.Valid {
			t.Errorf("きょうだいが残る前のクラス（さくら組）のグループから外れた: ok=%v left=%v", ok, left)
		}
		if _, left, ok := memberOf(a, himawari, nishida); !ok || left.Valid {
			t.Errorf("新しいクラス（ひまわり組）のグループに入っていない: ok=%v left=%v", ok, left)
		}
	})
}
