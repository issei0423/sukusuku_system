package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * 担当クラスの無い一般（フリー）の日誌（受け入れテスト 06-045）
 * 典拠：基本設計書「権限と利用可能機能」(6-1) ※1「担当クラスの無い職員（フリー）は全クラスを閲覧のみ（記録の作成・編集・確認はできない）」、
 *      同「権限と参照範囲の判定」(4-2)、図/画面詳細図「職員（タブレット／PC）」(1-1) の注記「全クラスを閲覧のみ…記録の作成・編集のボタンは出さない」
 *
 * 画面側のモック（web/src/api/mock.ts の canSeeDiary・canWriteDiary）と同じ規則であることを、
 * web/tests/diaryFreeStaff.test.ts と同じ観点で確かめる。
 */

// freeStaffApp は、ひまわり組の担任（S005）の割り当てを外してフリーにし、そのログインを返す
func freeStaffApp(t *testing.T) (*app, http.Handler, *http.Cookie) {
	t.Helper()
	a, h := newTestApp(t)
	if _, err := a.db.Exec(`DELETE FROM t_class_staff WHERE staff_id = 'S005'`); err != nil {
		t.Fatal(err)
	}
	return a, h, loginAs(a, accOtherTeacher, "staff")
}

// insertDiary は、日誌を1件足して番号を返す（下ごしらえ。画面を通さない）。申請中・承認済みには申請者と申請日時を入れる
// （schema.sql の CHECK。承認者は入れなくてよい）
func insertDiary(t *testing.T, a *app, recordType string, childID any, classID int64, status, staffID string) int64 {
	t.Helper()
	var appliedStaff, appliedAt any
	if status == "2" || status == "3" {
		appliedStaff, appliedAt = staffID, now()
	}
	res, err := a.db.Exec(`INSERT INTO t_diary (record_type, child_id, class_id, diary_date, body, status, created_staff_id,
		applied_staff_id, applied_at, is_deleted, created_at, updated_at)
		VALUES (?, ?, ?, ?, 'フリーの職員のテスト', ?, ?, ?, ?, 0, ?, ?)`,
		recordType, childID, classID, today(), status, staffID, appliedStaff, appliedAt, now(), now())
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestFreeStaffReadsEveryClassDiary(t *testing.T) {
	a, h, free := freeStaffApp(t)
	// ひまわり組のクラス日誌（承認済み）と、ひまわり組の園児の個人日誌（申請中）
	himawariClass := insertDiary(t, a, "2", nil, classHimawari, "3", "S001")
	himawariChild := insertDiary(t, a, "1", childHimawari, classHimawari, "2", "S001")

	var list Paged[Diary]
	if err := json.Unmarshal(call(t, h, free, "GET", "/api/diaries", "").Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	seen := map[int64]bool{}
	for _, d := range list.Rows {
		seen[d.DiaryID] = true
	}
	// 日誌 1（さくら組の下書き）・2（さくら組のクラス日誌）・3（さくら組のヒヤリハット）と、ひまわり組の2件
	for _, id := range []int64{1, 2, 3, himawariClass, himawariChild} {
		if !seen[id] {
			t.Errorf("フリーの日誌一覧に日誌 %d が出ない", id)
		}
	}

	// 日誌本体・添付・誰が編集中か・その園児の過去の記録（どれも読むだけの経路）
	for _, path := range []string{
		"/api/diaries/1", "/api/diaries/" + itoa(himawariClass), "/api/diaries/" + itoa(himawariChild),
		"/api/diaries/1/attachments", "/api/diaries/3/lock", "/api/children/" + childHimawari + "/diaries",
	} {
		if rec := request(t, h, free, "GET", path, ""); rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200: %s", path, rec.Code, rec.Body.String())
		}
	}
	// 日誌 3 は村田 真一がロックを持っている。誰が編集中かは読める（画面に「〇〇さんが編集中です。」を出すため）
	if !strings.Contains(call(t, h, free, "GET", "/api/diaries/3/lock", "").Body.String(), "村田 真一") {
		t.Error("フリーにも、誰が編集中かが返る")
	}
}

func TestFreeStaffDiaryReadScopeMatchesReadableChildren(t *testing.T) {
	a, h, free := freeStaffApp(t)
	// 読める園児・クラスは canReadChild・canReadClass と同じ範囲：在籍中の園児と、今年度のクラス
	pastClass := insertDiary(t, a, "2", nil, 11, "3", "S003") // 2025年度のさくら組
	expectStatus(t, request(t, h, free, "GET", "/api/diaries/"+itoa(pastClass), ""), http.StatusForbidden)
	a.db.Exec(`UPDATE m_child SET enrollment_status = '2' WHERE child_id = 'C002'`) // 日誌 4 の園児が退園
	expectStatus(t, request(t, h, free, "GET", "/api/diaries/4", ""), http.StatusForbidden)
	expectStatus(t, request(t, h, free, "GET", "/api/children/C002/diaries", ""), http.StatusForbidden)
	// 管理者には今までどおり出る
	admin := loginAs(a, accAdmin, "staff")
	call(t, h, admin, "GET", "/api/diaries/"+itoa(pastClass), "")
	call(t, h, admin, "GET", "/api/diaries/4", "")
}

func TestFreeStaffCannotWriteDiary(t *testing.T) {
	a, h, free := freeStaffApp(t)
	suzuki := loginAs(a, accTeacher, "staff")
	bodyOf := func(id int64) (body, status string) {
		t.Helper()
		a.db.QueryRow(`SELECT body, status FROM t_diary WHERE diary_id = ?`, id).Scan(&body, &status)
		return
	}
	before, beforeStatus := bodyOf(1)

	t.Run("作れない", func(t *testing.T) {
		for _, body := range []string{
			`{"record_type":"1","child_id":"C001","class_id":1,"diary_date":"` + today() + `","body":"フリーが書いた","status":"1"}`,
			`{"record_type":"2","class_id":2,"diary_date":"` + today() + `","body":"フリーが書いた","status":"2"}`,
		} {
			expectStatus(t, request(t, h, free, "POST", "/api/diaries", body), http.StatusForbidden)
		}
		// デモの日誌 6 は久保田（S005）が担任のときに書いたもの。足されていないことは本文で見る
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_diary WHERE body = 'フリーが書いた'`).Scan(&n)
		if n != 0 {
			t.Fatalf("フリーの職員の日誌が %d 件できています", n)
		}
	})

	t.Run("編集ロックを取れない", func(t *testing.T) {
		got := expectStatus(t, request(t, h, free, "POST", "/api/diaries/1/lock", ""), http.StatusForbidden)
		if !strings.Contains(got, msgDiaryWriteForbidden) {
			t.Errorf("文言 = %s, want %s", got, msgDiaryWriteForbidden)
		}
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_diary_lock WHERE locked_staff_id = 'S005'`).Scan(&n)
		if n != 0 {
			t.Fatalf("フリーの職員のロックが %d 件できています", n)
		}
	})

	t.Run("書き換えられない（担任のロックの識別子を添えても）", func(t *testing.T) {
		token := acquireToken(t, h, suzuki, "1")
		got := expectStatus(t, request(t, h, free, "POST", "/api/diaries",
			`{"diary_id":1,"record_type":"1","child_id":"C001","class_id":1,"diary_date":"2026-09-01",`+
				`"body":"フリーが書き換え","lock_token":"`+token+`","status":"2"}`), http.StatusForbidden)
		if !strings.Contains(got, "権限がありません") {
			t.Errorf("文言 = %s", got)
		}
		if body, status := bodyOf(1); body != before || status != beforeStatus {
			t.Fatalf("日誌 1 が書き換わっています: %q %s", body, status)
		}
	})

	t.Run("自分の申請でも取り下げられない（担任だったときの申請）", func(t *testing.T) {
		a.db.Exec(`UPDATE t_diary SET applied_staff_id = 'S005' WHERE diary_id = 2`)
		var version string
		a.db.QueryRow(`SELECT updated_at FROM t_diary WHERE diary_id = 2`).Scan(&version)
		got := expectStatus(t, request(t, h, free, "POST", "/api/diaries/2/withdraw", `{"updated_at":"`+version+`"}`), http.StatusForbidden)
		if !strings.Contains(got, msgDiaryWriteForbidden) {
			t.Errorf("文言 = %s, want %s", got, msgDiaryWriteForbidden)
		}
		if _, status := bodyOf(2); status != "2" {
			t.Fatalf("日誌 2 の状態 = %s, want 2（申請中のまま）", status)
		}
	})
}
