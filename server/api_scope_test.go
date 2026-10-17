package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

/*
 * API を直接呼んだときの権限の抜け（GitHub Issue #153）
 * 典拠：基本設計書.md「権限チェックの実装方針」(6-2)「画面を経由せず直接リクエストを送っても拒否されること」
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、
 * web/tests/apiScope.test.ts と同じ観点で確かめる。
 */

// 手続きの途中で拒否したときの理由。画面（web/src/api/procedure.ts）はこれを見て手続きの画面へ案内する
const (
	procedurePassword = "password_change_required"
	procedureTerms    = "terms_agreement_required"
)

// request は応答の状態を問わずに返す。拒否されることを確かめるために使う（call は 200 以外で止まる）
func request(t *testing.T, h http.Handler, c *http.Cookie, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(c)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// expectStatus は応答の状態を確かめ、本文を返す
func expectStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) string {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, want, rec.Body.String())
	}
	return rec.Body.String()
}

// expectProcedure は、手続きを終えるまで拒否されたこと（403 と理由）を確かめる
func expectProcedure(t *testing.T, rec *httptest.ResponseRecorder, kind string) {
	t.Helper()
	expectStatus(t, rec, http.StatusForbidden)
	var e apiError
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatal(err)
	}
	if e.Kind != kind {
		t.Fatalf("kind = %q, want %q (body: %s)", e.Kind, kind, rec.Body.String())
	}
	if e.Message == "" {
		t.Fatal("利用者に見せる文言が空です")
	}
}

// 一時パスワードのままでは、パスワードの変更に要る API 以外を使わせない
// （基本設計書「画面遷移」(3-4)、「アカウント（m_account）」(5-2) の is_temp_password）
func TestTempPasswordBlocksOtherAPIs(t *testing.T) {
	a, h := newTestApp(t)
	miyagi := loginAs(a, 4, "staff") // 一時パスワード中（さくら組）

	t.Run("園児・アレルギー・参照表・日誌の雛形は、理由つきの 403 で拒否する", func(t *testing.T) {
		for _, path := range []string{
			"/api/children",
			"/api/children/C001/allergies",
			"/api/reference",
			"/api/diaries/templates",
			"/api/dashboard/staff",
		} {
			expectProcedure(t, request(t, h, miyagi, "GET", path, ""), procedurePassword)
		}
		expectProcedure(t, request(t, h, miyagi, "POST", "/api/diaries",
			`{"record_type":"2","class_id":1,"diary_date":"2026-09-01","body":"作れてはならない","status":"1"}`),
			procedurePassword)
	})

	t.Run("自分の情報・規約の本文は取得でき、パスワードを変更すると他の API も使える", func(t *testing.T) {
		var me SessionUser
		if err := json.Unmarshal(call(t, h, miyagi, "GET", "/api/me", "").Body.Bytes(), &me); err != nil {
			t.Fatal(err)
		}
		if !me.IsTempPassword {
			t.Fatal("一時パスワード中であることが返っていません")
		}
		call(t, h, miyagi, "GET", "/api/terms", "")
		call(t, h, miyagi, "POST", "/api/password", `{"current":"temp0901","next":"newpass1234"}`)
		call(t, h, miyagi, "GET", "/api/children", "")
		call(t, h, miyagi, "GET", "/api/reference", "")
	})

	t.Run("ログアウトは手続きの途中でもできる", func(t *testing.T) {
		temp := loginAs(a, 4, "staff")
		if _, err := a.db.Exec(`UPDATE m_account SET is_temp_password = 1 WHERE account_id = 4`); err != nil {
			t.Fatal(err)
		}
		call(t, h, temp, "POST", "/api/logout", "")
		expectStatus(t, request(t, h, temp, "GET", "/api/me", ""), http.StatusUnauthorized)
	})

	t.Run("ログイン中に一時パスワードの状態になったら、その時点から拒否する", func(t *testing.T) {
		teacher := loginAs(a, 3, "staff")
		call(t, h, teacher, "GET", "/api/children", "")
		// 管理者の再発行（POST /api/admin/accounts/{id}/temp-password）は、ログイン中のセッションそのものを切る
		// （GitHub Issue #159。api_account_session_test.go）。ここでは、状態を要求のたびに読むことを確かめる
		if _, err := a.db.Exec(`UPDATE m_account SET is_temp_password = 1 WHERE account_id = 3`); err != nil {
			t.Fatal(err)
		}
		expectProcedure(t, request(t, h, teacher, "GET", "/api/children", ""), procedurePassword)
	})
}

// 規約の改定後は、同意するまで同意に要る API 以外を使わせない（基本設計書「画面遷移」(3-4)）
func TestTermsAgreementBlocksOtherAPIs(t *testing.T) {
	a, h := newTestApp(t)
	uezono := loginAs(a, 7, "guardian") // 規約の再同意が必要な保護者（上園 花子の保護者）

	for _, path := range []string{"/api/dashboard/guardian", "/api/children", "/api/chat/rooms", "/api/reference"} {
		expectProcedure(t, request(t, h, uezono, "GET", path, ""), procedureTerms)
	}

	call(t, h, uezono, "GET", "/api/me", "")
	call(t, h, uezono, "GET", "/api/terms", "")
	call(t, h, uezono, "POST", "/api/terms/agree", "")
	call(t, h, uezono, "GET", "/api/dashboard/guardian", "")
}

// 一時パスワード中で、規約の再同意も要るときは、パスワードの変更を先に求める（画面の TopScreen と同じ順）
func TestTempPasswordComesBeforeTerms(t *testing.T) {
	a, h := newTestApp(t)
	if _, err := a.db.Exec(`UPDATE m_account SET terms_version = '0.9' WHERE account_id = 4`); err != nil {
		t.Fatal(err)
	}
	miyagi := loginAs(a, 4, "staff")
	expectProcedure(t, request(t, h, miyagi, "GET", "/api/children", ""), procedurePassword)
	// 規約への同意は、パスワードの変更より先に済ませてもよい（どちらも手続きの API）
	call(t, h, miyagi, "POST", "/api/terms/agree", "")
	call(t, h, miyagi, "POST", "/api/password", `{"current":"temp0901","next":"newpass1234"}`)
	call(t, h, miyagi, "GET", "/api/children", "")
}

// 日誌の添付は、日誌本体と同じ参照範囲に従う。承認済みであっても参照範囲は広がらない
// （基本設計書「日誌の作成から保護者への共有」(4-5)・「添付ファイルの実体の保存先」(5-5)）
func TestDiaryAttachmentsFollowDiaryScope(t *testing.T) {
	a, h := newTestApp(t)
	const path = "/api/diaries/4/attachments" // 上園 花子（C002・さくら組）の個人日誌。承認済み・保護者へ共有、添付2件

	t.Run("担当外の職員・関係のない保護者には見せない", func(t *testing.T) {
		expectStatus(t, request(t, h, loginAs(a, 5, "staff"), "GET", path, ""), http.StatusForbidden)    // ひまわり組の担任
		expectStatus(t, request(t, h, loginAs(a, 6, "guardian"), "GET", path, ""), http.StatusForbidden) // 野原 太郎の保護者
	})

	t.Run("日誌本体を見られる人には返す", func(t *testing.T) {
		uezono := loginAs(a, 7, "guardian") // C002 の保護者
		call(t, h, uezono, "POST", "/api/terms/agree", "")
		for _, c := range []*http.Cookie{loginAs(a, 1, "staff"), loginAs(a, 3, "staff"), uezono} {
			var got []DiaryAttachment
			if err := json.Unmarshal(call(t, h, c, "GET", path, "").Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if len(got) != 2 {
				t.Fatalf("添付 = %d 件, want 2", len(got))
			}
		}
	})

	t.Run("保護者へ共有していない日誌の添付は、自児の保護者にも見せない", func(t *testing.T) {
		if _, err := a.db.Exec(`UPDATE t_diary SET is_shared_to_guardian = 0 WHERE diary_id = 4`); err != nil {
			t.Fatal(err)
		}
		expectStatus(t, request(t, h, loginAs(a, 7, "guardian"), "GET", path, ""), http.StatusForbidden)
	})

	t.Run("無い日誌は、あるかどうかを推測させない", func(t *testing.T) {
		expectStatus(t, request(t, h, loginAs(a, 3, "staff"), "GET", "/api/diaries/99999/attachments", ""), http.StatusForbidden)
	})
}

// 一般（保育士）は、自クラスのクラス日誌・週案しか作成・更新できない
// （要件定義書「参照範囲の全体規定」(4-1-5)）
func TestClassDiaryRequiresOwnClass(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff") // さくら組（class_id=1）
	kinjo := loginAs(a, 5, "staff")     // ひまわり組（class_id=2）
	admin := loginAs(a, 1, "staff")

	diary := func(recordType string, classID string, status string) string {
		return `{"record_type":"` + recordType + `","class_id":` + classID +
			`,"diary_date":"2026-09-01","body":"クラスの様子","status":"` + status + `"}`
	}

	t.Run("他クラスを対象にした作成は、下書きも申請も拒否する", func(t *testing.T) {
		for _, body := range []string{diary("2", "2", "1"), diary("2", "2", "2"), diary("3", "2", "1")} {
			expectStatus(t, request(t, h, takanashi, "POST", "/api/diaries", body), http.StatusForbidden)
		}
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_diary WHERE class_id = 2 AND created_staff_id = 'S003'`).Scan(&n)
		if n != 0 {
			t.Fatalf("ひまわり組の日誌が %d 件できています", n)
		}
	})

	t.Run("クラスを指定しないクラス日誌は、一般には作らせない", func(t *testing.T) {
		expectStatus(t, request(t, h, takanashi, "POST", "/api/diaries", diary("2", "null", "1")), http.StatusBadRequest)
	})

	t.Run("自クラスなら作成でき、管理者はどのクラスでも作成できる", func(t *testing.T) {
		call(t, h, takanashi, "POST", "/api/diaries", diary("2", "1", "1"))
		call(t, h, kinjo, "POST", "/api/diaries", diary("3", "2", "1"))
		call(t, h, admin, "POST", "/api/diaries", diary("2", "2", "1"))
		call(t, h, admin, "POST", "/api/diaries", diary("3", "null", "1"))
	})

	t.Run("更新で他クラスへ移すことも、他クラスの日誌を書き換えることもできない", func(t *testing.T) {
		var own Diary
		if err := json.Unmarshal(call(t, h, takanashi, "POST", "/api/diaries", diary("2", "1", "1")).Body.Bytes(), &own); err != nil {
			t.Fatal(err)
		}
		var others Diary
		if err := json.Unmarshal(call(t, h, kinjo, "POST", "/api/diaries", diary("2", "2", "1")).Body.Bytes(), &others); err != nil {
			t.Fatal(err)
		}
		update := func(id int64, classID string) string {
			return `{"diary_id":` + itoa(id) + `,"record_type":"2","class_id":` + classID +
				`,"diary_date":"2026-09-01","body":"書き換え","status":"1"}`
		}
		expectStatus(t, request(t, h, takanashi, "POST", "/api/diaries", update(own.DiaryID, "2")), http.StatusForbidden)
		expectStatus(t, request(t, h, takanashi, "POST", "/api/diaries", update(others.DiaryID, "1")), http.StatusForbidden)

		var body string
		a.db.QueryRow(`SELECT body FROM t_diary WHERE diary_id = ?`, others.DiaryID).Scan(&body)
		if body != "クラスの様子" {
			t.Fatalf("ひまわり組の日誌が書き換わっています: %q", body)
		}
		// 自分の日誌は、編集ロックを取れば書き直せる（保存には本人のロックの識別子が要る。GitHub Issue #166）
		token := acquireToken(t, h, takanashi, itoa(own.DiaryID))
		call(t, h, takanashi, "POST", "/api/diaries",
			strings.Replace(update(own.DiaryID, "1"), `"status"`, `"lock_token":"`+token+`","status"`, 1))
	})
}

// 園児の所属クラスも、その園児を参照できる人にだけ返す（基本設計書「権限チェックの実装方針」(6-2)）
func TestClassOfChildRequiresScope(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, 6, "guardian") // 野原 太郎（C001・さくら組）の保護者
	takanashi := loginAs(a, 3, "staff")   // さくら組
	admin := loginAs(a, 1, "staff")

	expectStatus(t, request(t, h, guardian, "GET", "/api/children/C013/class", ""), http.StatusForbidden)  // ひまわり組の園児
	expectStatus(t, request(t, h, takanashi, "GET", "/api/children/C013/class", ""), http.StatusForbidden) // 担当外
	expectStatus(t, request(t, h, guardian, "GET", "/api/children/C999/class", ""), http.StatusForbidden)  // 無い園児も同じ応答

	for _, tc := range []struct {
		c     *http.Cookie
		child string
		want  string
	}{
		{guardian, "C001", "1"},
		{takanashi, "C001", "1"},
		{admin, "C013", "2"},
	} {
		if got := strings.TrimSpace(call(t, h, tc.c, "GET", "/api/children/"+tc.child+"/class", "").Body.String()); got != tc.want {
			t.Fatalf("%s の所属クラス = %s, want %s", tc.child, got, tc.want)
		}
	}
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}

// 既存の日誌の更新は、更新前の日誌がその人に見えるときに限る。種類や園児・クラスを変えて範囲の外へ持ち出させない
// （要件定義書「参照範囲の全体規定」(4-1-5)。GitHub Issue #153 の追記）
func TestDiaryUpdateRequiresVisibleDiary(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff") // さくら組
	kinjo := loginAs(a, 5, "staff")     // ひまわり組

	// 日誌 1 は高梨（さくら組）の下書き。野原 太郎（C001）の個人日誌
	unchanged := func(t *testing.T) {
		t.Helper()
		var recordType, status, body string
		var childID string
		var classID int64
		a.db.QueryRow(`SELECT record_type, child_id, class_id, status, body FROM t_diary WHERE diary_id = 1`).
			Scan(&recordType, &childID, &classID, &status, &body)
		if recordType != "1" || childID != "C001" || classID != 1 || status != "1" || body == "書き換え" {
			t.Fatalf("日誌 1 が書き換わっています: %s %s %d %s %q", recordType, childID, classID, status, body)
		}
	}

	t.Run("担当外の職員は、他クラスの下書きを自クラスの日誌として書き換えて申請できない", func(t *testing.T) {
		expectStatus(t, request(t, h, kinjo, "POST", "/api/diaries",
			`{"diary_id":1,"record_type":"2","class_id":2,"diary_date":"2026-09-01","body":"書き換え","status":"2"}`),
			http.StatusForbidden)
		unchanged(t)
	})

	t.Run("見える日誌でも、種類や園児・クラスを変えて範囲の外へ持ち出せない", func(t *testing.T) {
		for _, body := range []string{
			`{"diary_id":1,"record_type":"2","class_id":2,"diary_date":"2026-09-01","body":"書き換え","status":"1"}`,
			`{"diary_id":1,"record_type":"1","child_id":"C013","class_id":2,"diary_date":"2026-09-01","body":"書き換え","status":"1"}`,
			`{"diary_id":1,"record_type":"4","child_id":"C013","class_id":1,"diary_date":"2026-09-01","body":"書き換え","status":"1"}`,
		} {
			expectStatus(t, request(t, h, takanashi, "POST", "/api/diaries", body), http.StatusForbidden)
		}
		unchanged(t)
		// 範囲の内の書き直しは、編集ロックを取れば通る（保存には本人のロックの識別子が要る。GitHub Issue #166）
		token := acquireToken(t, h, takanashi, "1")
		call(t, h, takanashi, "POST", "/api/diaries",
			`{"diary_id":1,"record_type":"1","child_id":"C001","class_id":1,"diary_date":"2026-09-01","body":"書き直し","lock_token":"`+token+`","status":"1"}`)
	})
}

// 編集ロックの取得・参照も、日誌が見える職員に限る（GitHub Issue #153 の追記）
func TestDiaryLockRequiresVisibleDiary(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff") // さくら組
	kinjo := loginAs(a, 5, "staff")     // ひまわり組

	t.Run("担当外の日誌のロックは取れず、誰が編集中かも見えない", func(t *testing.T) {
		for _, id := range []string{"1", "4", "99999"} {
			expectStatus(t, request(t, h, kinjo, "POST", "/api/diaries/"+id+"/lock", ""), http.StatusForbidden)
		}
		// 日誌 2（さくら組のクラス日誌）は宮城 蓮がロックを持っている
		expectStatus(t, request(t, h, kinjo, "GET", "/api/diaries/2/lock", ""), http.StatusForbidden)
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_diary_lock WHERE locked_staff_id = 'S005'`).Scan(&n)
		if n != 0 {
			t.Fatalf("担当外の職員のロックが %d 件できています", n)
		}
	})

	t.Run("担任はロックを取れ、誰が編集中かも見える", func(t *testing.T) {
		if !strings.Contains(call(t, h, takanashi, "POST", "/api/diaries/1/lock", "").Body.String(), `"token"`) {
			t.Fatal("ロックのトークンが返っていません")
		}
		if !strings.Contains(call(t, h, takanashi, "GET", "/api/diaries/2/lock", "").Body.String(), "宮城 蓮") {
			t.Fatal("編集中の職員が返っていません")
		}
	})
}
