package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * 日誌を園内の記録にした作り直しの、申請の取り下げ・承認の取り消し・承認と差し戻しの列
 * 典拠：詳細設計書.md「日誌の状態（取り下げと承認の取り消しを含む）」(3-6)・「日誌」(4-13 (2)〜(5))
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、web/tests/diaryInternal.test.ts と同じ観点で確かめる。
 * 保護者が日誌を読めないことは api_guardian_test.go の TestGuardianCannotUseDiaryRoutes にある。
 */

// errorOf は誤りの応答（状態と文言・kind）を確かめ、apiError を返す
func errorOf(t *testing.T, rec interface{ Result() *http.Response }, want int) apiError {
	t.Helper()
	res := rec.Result()
	defer res.Body.Close()
	var e apiError
	json.NewDecoder(res.Body).Decode(&e)
	if res.StatusCode != want {
		t.Fatalf("status = %d, want %d (message: %s)", res.StatusCode, want, e.Message)
	}
	return e
}

// lastDiaryLog は、その日誌の最も新しい操作ログの変更前・変更後を返す
func lastDiaryLog(t *testing.T, a *app, id int64) (string, string) {
	t.Helper()
	var before, after string
	if err := a.db.QueryRow(`SELECT IFNULL(before_value, ''), IFNULL(after_value, '') FROM t_operation_log
		WHERE function_type = '1' AND target_table = 't_diary' AND target_id = ?
		ORDER BY operation_log_id DESC LIMIT 1`, id).Scan(&before, &after); err != nil {
		t.Fatal(err)
	}
	return before, after
}

func versionBody(updatedAt string) string { return `{"updated_at":"` + updatedAt + `"}` }

// 申請の取り下げ：申請した本人だけ・申請中だけ・読んだ版のときだけ。下書きに戻り、申請者が空になる
func TestWithdrawDiary(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")   // 西田 拓也（S001・管理者）
	teacher := loginAs(a, 3, "staff") // 鈴木 浩之（S003・さくら組）
	murata := loginAs(a, 4, "staff")  // 村田（S004・さくら組）。同じクラスで日誌は読める
	guardian := loginAs(a, 6, "guardian")
	// 村田は一時パスワードのデモアカウント。変えてからでないと日誌を開けない
	call(t, h, murata, "POST", "/api/password", `{"current":"temp0901","next":"newpass1234"}`)

	d := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		personalDiary(0, "C001", "1", today(), "取り下げを試す日誌", "2")).Body.Bytes())
	path := "/api/diaries/" + itoa(d.DiaryID) + "/withdraw"
	if d.AppliedStaffID == nil || *d.AppliedStaffID != "S003" || d.AppliedAt == nil {
		t.Fatalf("作って申請した日誌の申請者 = %v・%v, want S003・日時", d.AppliedStaffID, d.AppliedAt)
	}

	t.Run("申請した本人でなければ 403（管理者・同じクラスの職員・保護者）", func(t *testing.T) {
		for _, c := range []*http.Cookie{admin, murata} {
			if e := errorOf(t, request(t, h, c, "POST", path, versionBody(d.UpdatedAt)), http.StatusForbidden); e.Message != "申請を取り下げられるのは、申請した本人だけです。" {
				t.Fatalf("message = %q", e.Message)
			}
		}
		expectStatus(t, request(t, h, guardian, "POST", path, versionBody(d.UpdatedAt)), http.StatusForbidden)
	})

	t.Run("読んだ版が今の版と違えば 409 version_conflict", func(t *testing.T) {
		e := errorOf(t, request(t, h, teacher, "POST", path, versionBody("2000-01-01T00:00:00")), http.StatusConflict)
		if e.Kind != "version_conflict" || e.Message != "他の職員が更新しています。内容を再読み込みしてください。" {
			t.Fatalf("kind=%q message=%q", e.Kind, e.Message)
		}
	})

	var withdrawn Diary
	t.Run("本人が取り下げると下書きに戻り、申請者が空になる。操作ログに申請者と申請日時が残る", func(t *testing.T) {
		withdrawn = diaryOf(t, call(t, h, teacher, "POST", path, versionBody(d.UpdatedAt)).Body.Bytes())
		if withdrawn.Status != "1" || withdrawn.AppliedStaffID != nil || withdrawn.AppliedAt != nil {
			t.Fatalf("取り下げのあと: status=%s applied=%v・%v", withdrawn.Status, withdrawn.AppliedStaffID, withdrawn.AppliedAt)
		}
		if withdrawn.UpdatedAt <= d.UpdatedAt {
			t.Fatalf("版が進んでいない: %s → %s", d.UpdatedAt, withdrawn.UpdatedAt)
		}
		before, after := lastDiaryLog(t, a, d.DiaryID)
		if after != "取り下げ" || !strings.Contains(before, "S003") || !strings.Contains(before, *d.AppliedAt) {
			t.Fatalf("操作ログ: before=%q after=%q", before, after)
		}
		var pending []Diary
		json.Unmarshal(call(t, h, admin, "GET", "/api/diaries/pending", "").Body.Bytes(), &pending)
		for _, p := range pending {
			if p.DiaryID == d.DiaryID {
				t.Fatal("取り下げた日誌が承認待ちに残っている")
			}
		}
	})

	t.Run("取り下げたあとに届いた承認・差し戻しは 409「この日誌は取り下げられました。」", func(t *testing.T) {
		for _, c := range []struct{ path, body string }{
			{"/approve", ""}, {"/return", `{"reason":"直してください"}`},
		} {
			e := errorOf(t, request(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+c.path, c.body), http.StatusConflict)
			if e.Message != "この日誌は取り下げられました。" {
				t.Fatalf("%s: message = %q", c.path, e.Message)
			}
		}
		if got := statusOfDiary(t, a, d.DiaryID); got != "1" {
			t.Fatalf("status = %s, want 1", got)
		}
	})

	t.Run("下書きに戻った日誌は、ロックを取って直して申請し直せる", func(t *testing.T) {
		again := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries", withLock(
			personalDiary(d.DiaryID, "C001", "1", today(), "直して申請し直す", "2"), acquireToken(t, h, teacher, itoa(d.DiaryID)))).Body.Bytes())
		if again.Status != "2" || again.AppliedStaffID == nil || *again.AppliedStaffID != "S003" {
			t.Fatalf("申請し直したあと: %+v", again)
		}
		if again.UpdatedAt <= withdrawn.UpdatedAt {
			t.Fatalf("版が進んでいない: %s → %s", withdrawn.UpdatedAt, again.UpdatedAt)
		}
		// 前の版（取り下げたときの版）では取り下げられない
		errorOf(t, request(t, h, teacher, "POST", path, versionBody(withdrawn.UpdatedAt)), http.StatusConflict)
		d = again
	})

	t.Run("承認が先に済んでいれば、取り下げは 409「すでに承認または差し戻しされたため…」", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/approve", "")
		e := errorOf(t, request(t, h, teacher, "POST", path, versionBody(d.UpdatedAt)), http.StatusConflict)
		if e.Message != "すでに承認または差し戻しされたため、取り下げられません。" {
			t.Fatalf("message = %q", e.Message)
		}
		if got := statusOfDiary(t, a, d.DiaryID); got != "3" {
			t.Fatalf("status = %s, want 3（承認のまま）", got)
		}
	})

	t.Run("差し戻しが先に済んでいても 409", func(t *testing.T) {
		// 日誌 2 は鈴木が申請したさくら組のクラス日誌
		var cls Diary
		decode(t, call(t, h, teacher, "GET", "/api/diaries/2", ""), &cls)
		call(t, h, admin, "POST", "/api/diaries/2/return", `{"reason":"活動を書き足してください"}`)
		e := errorOf(t, request(t, h, teacher, "POST", "/api/diaries/2/withdraw", versionBody(cls.UpdatedAt)), http.StatusConflict)
		if e.Message != "すでに承認または差し戻しされたため、取り下げられません。" {
			t.Fatalf("message = %q", e.Message)
		}
	})
}

// 承認の取り消し：管理者だけ・理由が必須（500文字）・承認済みだけ・読んだ版のときだけ。
// 承認者・承認日時が空になり差し戻しになる。元の承認者・承認日時は操作ログに残る
func TestRevokeDiaryApproval(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")   // S001。日誌 4・5 を承認した管理者
	admin2 := loginAs(a, 2, "staff")  // S002。承認していない管理者
	teacher := loginAs(a, 3, "staff") // S003。日誌 4・5 の作成者

	var approved Diary
	decode(t, call(t, h, admin, "GET", "/api/diaries/4", ""), &approved)
	path := "/api/diaries/4/revoke-approval"
	body := func(reason, version string) string {
		b, _ := json.Marshal(map[string]string{"reason": reason, "updated_at": version})
		return string(b)
	}

	t.Run("管理者でなければ 403", func(t *testing.T) {
		e := errorOf(t, request(t, h, teacher, "POST", path, body("確かめ直します", approved.UpdatedAt)), http.StatusForbidden)
		if e.Message != "承認の取り消しは管理者のみが行えます。" {
			t.Fatalf("message = %q", e.Message)
		}
	})

	t.Run("理由が空・空白だけ・500文字を超えると 400", func(t *testing.T) {
		for reason, want := range map[string]string{
			"":                       "承認を取り消す理由を入力してください。",
			"　 ":                     "承認を取り消す理由を入力してください。",
			strings.Repeat("あ", 501): "承認を取り消す理由は500文字以内で入力してください。",
		} {
			if e := errorOf(t, request(t, h, admin, "POST", path, body(reason, approved.UpdatedAt)), http.StatusBadRequest); e.Message != want {
				t.Fatalf("message = %q, want %q", e.Message, want)
			}
		}
	})

	t.Run("読んだ版が違えば 409 version_conflict", func(t *testing.T) {
		e := errorOf(t, request(t, h, admin, "POST", path, body("確かめ直します", "2000-01-01T00:00:00")), http.StatusConflict)
		if e.Kind != "version_conflict" {
			t.Fatalf("kind = %q", e.Kind)
		}
	})

	t.Run("ほかの管理者が承認したものも取り消せる。差し戻しになり、承認者・承認日時が空になる", func(t *testing.T) {
		got := diaryOf(t, call(t, h, admin2, "POST", path, body(" 本文を確かめ直してください ", approved.UpdatedAt)).Body.Bytes())
		if got.Status != "4" || got.ApprovedStaffID != nil || got.ApprovedAt != nil || got.ApprovedStaffName != nil {
			t.Fatalf("取り消しのあと: %+v", got)
		}
		if got.ReturnedReason == nil || *got.ReturnedReason != "本文を確かめ直してください" {
			t.Fatalf("returned_reason = %v", got.ReturnedReason)
		}
		before, after := lastDiaryLog(t, a, 4)
		if !strings.Contains(before, "S001") || !strings.Contains(before, *approved.ApprovedAt) || after != "承認の取り消し：本文を確かめ直してください" {
			t.Fatalf("操作ログ: before=%q after=%q", before, after)
		}
		// 作成者の「差し戻された日誌」に出る
		var page diaryPage
		decode(t, call(t, h, teacher, "GET", "/api/diaries?status=4&mine=1", ""), &page)
		found := false
		for _, r := range page.Rows {
			found = found || r.DiaryID == 4
		}
		if !found {
			t.Fatal("取り消した日誌が作成者の差し戻しの一覧に無い")
		}
	})

	t.Run("もう承認済みでなければ 409", func(t *testing.T) {
		var now Diary
		decode(t, call(t, h, admin, "GET", "/api/diaries/4", ""), &now)
		e := errorOf(t, request(t, h, admin, "POST", path, body("もう一度", now.UpdatedAt)), http.StatusConflict)
		if e.Message != "承認済みの日誌ではありません。画面を読み込み直してください。" {
			t.Fatalf("message = %q", e.Message)
		}
	})

	t.Run("自分が承認したものも取り消せる", func(t *testing.T) {
		var five Diary
		decode(t, call(t, h, admin, "GET", "/api/diaries/5", ""), &five)
		got := diaryOf(t, call(t, h, admin, "POST", "/api/diaries/5/revoke-approval", body("確かめ直します", five.UpdatedAt)).Body.Bytes())
		if got.Status != "4" {
			t.Fatalf("status = %s", got.Status)
		}
	})
}

// 承認・差し戻しの列：自分が申請した日誌は申請者の列で拒み、作成者の管理者でも別の人が申請したものは承認できる。
// 差し戻しは承認者の列を書かない。承認待ちは申請日時の古い順（詳細設計書「日誌の状態」(3-6)・「日誌の画面（作り直し）」(2-13 (1))）
func TestApprovalUsesApplicantColumn(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	admin2 := loginAs(a, 2, "staff")
	teacher := loginAs(a, 3, "staff")

	t.Run("作成者が管理者でも、ほかの職員が申請したものは承認できる", func(t *testing.T) {
		draft := diaryOf(t, call(t, h, admin, "POST", "/api/diaries",
			personalDiary(0, "C001", "1", today(), "園長が書き始めた記録", "1")).Body.Bytes())
		call(t, h, teacher, "POST", "/api/diaries", withLock(
			personalDiary(draft.DiaryID, "C001", "1", today(), "担任が書き足して申請", "2"), acquireToken(t, h, teacher, itoa(draft.DiaryID))))
		got := diaryOf(t, call(t, h, admin, "POST", "/api/diaries/"+itoa(draft.DiaryID)+"/approve", "").Body.Bytes())
		if got.Status != "3" || got.ApprovedStaffID == nil || *got.ApprovedStaffID != "S001" || got.AppliedStaffName == nil {
			t.Fatalf("承認のあと: %+v", got)
		}
	})

	t.Run("自分が申請したものは 403", func(t *testing.T) {
		mine := diaryOf(t, call(t, h, admin2, "POST", "/api/diaries",
			personalDiary(0, "C001", "1", today(), "遠藤が書いて申請", "2")).Body.Bytes())
		e := errorOf(t, request(t, h, admin2, "POST", "/api/diaries/"+itoa(mine.DiaryID)+"/approve", ""), http.StatusForbidden)
		if e.Message != "自分が申請した日誌は承認できません。ほかの管理者に依頼してください。" {
			t.Fatalf("message = %q", e.Message)
		}
	})

	t.Run("管理者でなければ「承認は管理者のみが行えます」", func(t *testing.T) {
		if e := errorOf(t, request(t, h, teacher, "POST", "/api/diaries/6/approve", ""), http.StatusForbidden); e.Message != "承認は管理者のみが行えます" {
			t.Fatalf("message = %q", e.Message)
		}
	})

	t.Run("差し戻しは承認者の列を書かない", func(t *testing.T) {
		got := diaryOf(t, call(t, h, admin, "POST", "/api/diaries/7/return", `{"reason":"書き足してください"}`).Body.Bytes())
		if got.Status != "4" || got.ApprovedStaffID != nil || got.ApprovedAt != nil {
			t.Fatalf("差し戻しのあと: %+v", got)
		}
		if e := errorOf(t, request(t, h, admin, "POST", "/api/diaries/7/approve", ""), http.StatusConflict); e.Message != "申請中の日誌のみ承認できます" {
			t.Fatalf("message = %q", e.Message)
		}
	})

	t.Run("承認待ちは申請日時の古い順", func(t *testing.T) {
		// 日誌 6（ひまわり組）を古く、日誌 2（さくら組）を新しくする
		a.db.Exec(`UPDATE t_diary SET applied_at = '2026-01-02T09:00:00' WHERE diary_id = 2`)
		a.db.Exec(`UPDATE t_diary SET applied_at = '2026-01-01T09:00:00' WHERE diary_id = 6`)
		var pending []Diary
		decode(t, call(t, h, admin, "GET", "/api/diaries/pending", ""), &pending)
		pos := map[int64]int{}
		for i, p := range pending {
			pos[p.DiaryID] = i
			if p.AppliedStaffID == nil || p.AppliedStaffName == nil {
				t.Fatalf("承認待ちに申請者が無い: %+v", p)
			}
		}
		if pos[6] > pos[2] {
			t.Fatalf("並び: %v（日誌 6 が 2 より先であるべき）", pos)
		}
	})
}
