package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * 日誌の申請・承認・一覧の流れ（GitHub Issue #174・#139）
 * 典拠：基本設計書.md「日誌の作成から保護者への共有」(4-5)・「日誌（t_diary）」(5-4)・「入力項目の制約値」(4-9)
 *      図/画面詳細図.md「職員ダッシュボード」(2-6)・「日誌一覧画面」(3-1)・「日誌作成・編集画面」(3-2)
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、web/tests/diaryFlow.test.ts と同じ観点で確かめる。
 */

func diaryOf(t *testing.T, body []byte) Diary {
	t.Helper()
	var d Diary
	if err := json.Unmarshal(body, &d); err != nil {
		t.Fatal(err)
	}
	return d
}

// personalDiary は、個人日誌の保存の本文を作る。diaryID が 0 なら新しく作る
func personalDiary(diaryID int64, childID, classID, date, body, status string) string {
	id := ""
	if diaryID != 0 {
		id = `"diary_id":` + itoa(diaryID) + `,`
	}
	return `{` + id + `"record_type":"1","child_id":"` + childID + `","class_id":` + classID +
		`,"diary_date":"` + date + `","body":"` + body + `","status":"` + status + `"}`
}

func statusOfDiary(t *testing.T, a *app, id int64) string {
	t.Helper()
	var status string
	if err := a.db.QueryRow(`SELECT status FROM t_diary WHERE diary_id = ?`, id).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

// 自分が申請した日誌は承認できない。作成者でなくても、書き直して申請した管理者は承認できない
// （基本設計書「日誌の作成から保護者への共有」(4-5)「自分が申請した日誌は、承認できない。ほかの管理者に承認を依頼する」）
func TestApplicantCannotApproveRewrittenDiary(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")   // 野原 一誠（S001・管理者）
	admin2 := loginAs(a, 2, "staff")  // 上園 謙心（S002・管理者）
	teacher := loginAs(a, 3, "staff") // 高梨 倫太朗（S003・さくら組）

	// 日誌 1 は高梨が書いた野原 太郎（C001）の下書き。園長が本文を書き直して申請する
	call(t, h, admin, "POST", "/api/diaries", personalDiary(1, "C001", "1", today(), "園長が書き直した本文です。", "2"))

	t.Run("書き直して申請した管理者は、承認できない（共有もしない）", func(t *testing.T) {
		body := expectStatus(t, request(t, h, admin, "POST", "/api/diaries/1/approve", `{"share_to_guardian":true}`),
			http.StatusBadRequest)
		if !strings.Contains(body, "自分が申請した日誌は承認できません") {
			t.Fatalf("文言が違います: %s", body)
		}
		if got := statusOfDiary(t, a, 1); got != "2" {
			t.Fatalf("status = %s, want 2（申請中のまま）", got)
		}
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE source_type = '2' AND source_id = 1`).Scan(&n)
		if n != 0 {
			t.Fatalf("個人チャットへ %d 件流れています", n)
		}
	})

	t.Run("日誌を開くと、申請した職員が分かる（承認画面が承認のボタンを押せなくするため）", func(t *testing.T) {
		d := diaryOf(t, call(t, h, admin, "GET", "/api/diaries/1", "").Body.Bytes())
		if d.AppliedStaffID == nil || *d.AppliedStaffID != "S001" {
			t.Fatalf("applied_staff_id = %v, want S001", d.AppliedStaffID)
		}
	})

	t.Run("差し戻され、作成者が直して申請し直したものは、最後に申請した人で判定する", func(t *testing.T) {
		call(t, h, admin2, "POST", "/api/diaries/1/return", `{"reason":"作成者が直してください"}`)
		call(t, h, teacher, "POST", "/api/diaries", personalDiary(1, "C001", "1", today(), "高梨が直した本文です。", "2"))
		d := diaryOf(t, call(t, h, admin, "GET", "/api/diaries/1", "").Body.Bytes())
		if d.AppliedStaffID == nil || *d.AppliedStaffID != "S003" {
			t.Fatalf("applied_staff_id = %v, want S003", d.AppliedStaffID)
		}
		call(t, h, admin, "POST", "/api/diaries/1/approve", `{"share_to_guardian":false}`)
	})

	t.Run("ほかの管理者が書き直して申請したものは、別の管理者が承認できる", func(t *testing.T) {
		// 日誌 7 は宮城（S004）が書いた申請中の個人日誌。差し戻して、上園が書き直して申請する
		call(t, h, admin, "POST", "/api/diaries/7/return", `{"reason":"書き直します"}`)
		call(t, h, admin2, "POST", "/api/diaries", personalDiary(7, "C004", "1", today(), "上園が書き直した本文です。", "2"))
		expectStatus(t, request(t, h, admin2, "POST", "/api/diaries/7/approve", `{"share_to_guardian":false}`),
			http.StatusBadRequest)
		call(t, h, admin, "POST", "/api/diaries/7/approve", `{"share_to_guardian":false}`)
	})
}

// 対象のクラスは必須。個人日誌・ヒヤリハットは、対象の園児が在籍するクラスに限る
// （図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目5「入力：必須」「『対象のクラス』は常に出し」）
func TestDiaryClassIsRequired(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff") // さくら組（class_id=1）

	count := func() int {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_diary`).Scan(&n)
		return n
	}
	before := count()

	t.Run("クラスを指定しない日誌は、一般も管理者も作れない", func(t *testing.T) {
		for _, tc := range []struct {
			c    *http.Cookie
			body string
		}{
			{teacher, personalDiary(0, "C004", "null", today(), "クラスなし", "1")},
			{admin, personalDiary(0, "C004", "null", today(), "クラスなし", "2")},
			{admin, `{"record_type":"2","class_id":null,"diary_date":"` + today() + `","body":"クラスなし","status":"1"}`},
			{admin, `{"record_type":"3","diary_date":"` + today() + `","body":"クラスなし","status":"1"}`},
			{admin, `{"record_type":"4","child_id":"C004","diary_date":"` + today() + `","body":"クラスなし","status":"1"}`},
		} {
			body := expectStatus(t, request(t, h, tc.c, "POST", "/api/diaries", tc.body), http.StatusBadRequest)
			if !strings.Contains(body, "対象のクラスを選んでください") {
				t.Fatalf("文言が違います: %s", body)
			}
		}
		if n := count(); n != before {
			t.Fatalf("日誌が %d 件できています", n-before)
		}
	})

	t.Run("既存の日誌のクラスを外すこともできない", func(t *testing.T) {
		expectStatus(t, request(t, h, teacher, "POST", "/api/diaries",
			personalDiary(1, "C001", "null", today(), "クラスを外す", "1")), http.StatusBadRequest)
		var classID int64
		a.db.QueryRow(`SELECT class_id FROM t_diary WHERE diary_id = 1`).Scan(&classID)
		if classID != 1 {
			t.Fatalf("日誌 1 の class_id = %d, want 1", classID)
		}
	})

	t.Run("個人日誌のクラスは、対象の園児が在籍するクラスに限る", func(t *testing.T) {
		// C004 はさくら組（1）。ひまわり組（2）を対象のクラスにはできない
		body := expectStatus(t, request(t, h, admin, "POST", "/api/diaries",
			personalDiary(0, "C004", "2", today(), "クラス違い", "1")), http.StatusBadRequest)
		if !strings.Contains(body, "在籍するクラス") {
			t.Fatalf("文言が違います: %s", body)
		}
		d := diaryOf(t, call(t, h, admin, "POST", "/api/diaries", personalDiary(0, "C004", "1", today(), "園長の記録", "1")).Body.Bytes())
		if d.ClassID == nil || *d.ClassID != 1 {
			t.Fatalf("class_id = %v, want 1", d.ClassID)
		}
	})
}

// 記録日は当日まで。形の崩れた値も断る（基本設計書「入力項目の制約値」(4-9)「記録日・測定日 未来日は認めない」、
// 図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目6）
func TestDiaryDateCannotBeFuture(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	tomorrow := nowTime().AddDate(0, 0, 1).Format("2006-01-02")

	for _, tc := range []struct {
		date string
		want string
	}{
		{tomorrow, "記録日に未来日は指定できません"},
		{"", "記録日の形式が正しくありません"},
		{"2026-10-1", "記録日の形式が正しくありません"},
		{"2026-02-30", "記録日の形式が正しくありません"},
	} {
		for _, status := range []string{"1", "2"} {
			body := expectStatus(t, request(t, h, teacher, "POST", "/api/diaries",
				personalDiary(0, "C004", "1", tc.date, "未来の記録", status)), http.StatusBadRequest)
			if !strings.Contains(body, tc.want) {
				t.Fatalf("%q: 文言が違います: %s", tc.date, body)
			}
		}
	}
	expectStatus(t, request(t, h, teacher, "POST", "/api/diaries",
		personalDiary(1, "C001", "1", tomorrow, "未来へ移す", "1")), http.StatusBadRequest)
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_diary WHERE diary_date > ?`, today()).Scan(&n)
	if n != 0 {
		t.Fatalf("未来の記録日の日誌が %d 件あります", n)
	}
	call(t, h, teacher, "POST", "/api/diaries", personalDiary(0, "C004", "1", today(), "今日の記録", "1"))
}

// 差し戻す理由は、再申請しても消さず、承認されるまで残す
// （基本設計書「日誌（t_diary）」(5-4)「再申請しても消さない。承認されるまで残し、次に差し戻されたときに上書きする」）
func TestResubmitKeepsReturnedReason(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")
	const reason = "食事と午睡の様子を書き足してください"

	d := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		personalDiary(0, "C004", "1", today(), "伊藤 葵の記録", "2")).Body.Bytes())
	call(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/return", `{"reason":"`+reason+`"}`)

	reasonOf := func() *string {
		return diaryOf(t, call(t, h, admin, "GET", "/api/diaries/"+itoa(d.DiaryID), "").Body.Bytes()).ReturnedReason
	}

	call(t, h, teacher, "POST", "/api/diaries", personalDiary(d.DiaryID, "C004", "1", today(), "書き足しました（下書き）", "1"))
	if got := reasonOf(); got == nil || *got != reason {
		t.Fatalf("下書き保存のあと: returned_reason = %v, want %q", got, reason)
	}
	call(t, h, teacher, "POST", "/api/diaries", personalDiary(d.DiaryID, "C004", "1", today(), "書き足しました", "2"))
	if got := reasonOf(); got == nil || *got != reason {
		t.Fatalf("再申請のあと: returned_reason = %v, want %q", got, reason)
	}

	call(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/return", `{"reason":"もう少し"}`)
	if got := reasonOf(); got == nil || *got != "もう少し" {
		t.Fatalf("2度目の差し戻しで上書きされていません: %v", got)
	}
	call(t, h, teacher, "POST", "/api/diaries", personalDiary(d.DiaryID, "C004", "1", today(), "直しました", "2"))
	call(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/approve", `{"share_to_guardian":false}`)
	if got := reasonOf(); got != nil {
		t.Fatalf("承認のあと: returned_reason = %q, want null", *got)
	}
}

type diaryPage struct {
	Rows  []Diary `json:"rows"`
	Total int     `json:"total"`
}

// ダッシュボードの「差し戻された日誌 n 件」と、そこから開いた日誌一覧（状態＝差し戻し・自分が書いたもの）が一致する
// （図/画面詳細図.md「職員ダッシュボード」(2-6) 項目2「日誌一覧画面へ遷移する（状態＝差し戻しで絞る）」）
func TestReturnedDiariesMatchDashboard(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff") // 高梨（S003・さくら組）
	old := nowTime().AddDate(0, 0, -40).Format("2006-01-02")

	// 40 日前の記録（一覧の期間の既定＝直近 31 日の外）を申請し、差し戻される
	d := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		personalDiary(0, "C004", "1", old, "40日前の記録", "2")).Body.Bytes())
	call(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/return", `{"reason":"書き足してください"}`)
	// 以前の版で、クラスを指定せずに保存された個人日誌（差し戻し）
	res, err := a.db.Exec(`INSERT INTO t_diary (record_type, child_id, class_id, diary_date, body, status,
		created_staff_id, returned_reason, is_deleted, created_at, updated_at)
		VALUES ('1', 'C004', NULL, ?, 'クラスなしの記録', '4', 'S003', '直してください', 0, ?, ?)`, today(), now(), now())
	if err != nil {
		t.Fatal(err)
	}
	legacyID, _ := res.LastInsertId()

	var summary struct {
		Returned int `json:"returned"`
	}
	if err := json.Unmarshal(call(t, h, teacher, "GET", "/api/dashboard/staff", "").Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Returned != 2 {
		t.Fatalf("returned = %d, want 2", summary.Returned)
	}

	ids := func(path string) map[int64]bool {
		var p diaryPage
		if err := json.Unmarshal(call(t, h, teacher, "GET", path, "").Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		out := map[int64]bool{}
		for _, r := range p.Rows {
			out[r.DiaryID] = true
		}
		if len(out) != p.Total {
			t.Fatalf("%s: rows %d, total %d", path, len(out), p.Total)
		}
		return out
	}

	t.Run("自分が書いたものに絞ると、ダッシュボードと同じ日誌が出る（宮城のヒヤリハットは出ない）", func(t *testing.T) {
		got := ids("/api/diaries?status=4&mine=1")
		if len(got) != summary.Returned || !got[d.DiaryID] || !got[legacyID] || got[3] {
			t.Fatalf("got %v, want {%d, %d}", got, d.DiaryID, legacyID)
		}
	})

	t.Run("クラスで絞っても、クラスの空いた個人日誌は園児の在籍クラスで拾う", func(t *testing.T) {
		got := ids("/api/diaries?status=4&mine=1&class_id=1")
		if !got[d.DiaryID] || !got[legacyID] {
			t.Fatalf("got %v, want %d と %d を含む", got, d.DiaryID, legacyID)
		}
		if g := ids("/api/diaries?status=4&mine=1&class_id=2"); g[d.DiaryID] || g[legacyID] {
			t.Fatalf("ひまわり組で絞ったのに出ています: %v", g)
		}
	})

	t.Run("自分が書いたもので絞らなければ、見える範囲の差し戻しがすべて出る", func(t *testing.T) {
		if got := ids("/api/diaries?status=4"); !got[3] {
			t.Fatalf("宮城のヒヤリハット（日誌 3）が出ていません: %v", got)
		}
	})
}

// 「この園児の過去の記録」に、いま開いている日誌そのものを出さない（GitHub Issue #139 の 1）
func TestPastDiariesExcludeOpenDiary(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")

	has := func(path string, id int64) bool {
		var out []Diary
		if err := json.Unmarshal(call(t, h, teacher, "GET", path, "").Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		for _, d := range out {
			if d.DiaryID == id {
				return true
			}
		}
		return false
	}
	if !has("/api/children/C001/diaries", 1) {
		t.Fatal("除く指定が無いのに、日誌 1 が出ていません")
	}
	if has("/api/children/C001/diaries?exclude=1", 1) {
		t.Fatal("開いている日誌 1 が過去の記録に出ています")
	}
	if !has("/api/children/C001/diaries?exclude=1", 5) {
		t.Fatal("ほかの日誌（日誌 5）まで消えています")
	}
}
