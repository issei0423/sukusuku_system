package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

/*
 * 日誌の編集ロック（GitHub Issue #166 の 1〜3）
 * 典拠：基本設計書.md「同時編集の検出」(4-2)「識別子が一致しない場合は、他者の更新の有無にかかわらず保存を拒否する
 *      （管理者による強制解除を検出するため）」「開いてから他者による更新があった場合、上書きせず」、
 *      「日誌の作成から保護者への共有」(4-5)「保存時のロック識別子が、現在有効なロックと一致するかを照合する」、
 *      「編集ロックの解除」(4-5)「解除された編集者の保存は、他者の更新の有無にかかわらず拒否する」
 *      「編集画面で一定時間（マスタ値）操作がない場合、自動で解除する」、
 *      「編集ロック（t_diary_lock）」(5-4) last_active_at「無操作の判定に用いる」
 *
 * 画面側のモック（web/src/api/mock.ts の acquireLock・touchLock・releaseLock・saveDiary）と同じ規則であることを、
 * web/tests/diaryLock.test.ts と同じ観点で確かめる。
 */

// acquireToken は編集ロックを取り、その識別子を返す。ほかの職員が持っていて取れないときは止める
func acquireToken(t *testing.T, h http.Handler, c *http.Cookie, diaryID string) string {
	t.Helper()
	var r struct {
		Token  string `json:"token"`
		HeldBy string `json:"held_by"`
	}
	if err := json.Unmarshal(call(t, h, c, "POST", "/api/diaries/"+diaryID+"/lock", "").Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	if r.Token == "" {
		t.Fatalf("ロックを取れませんでした（%s さんが編集中）", r.HeldBy)
	}
	return r.Token
}

// heldByOf は、ロックを取りにいって「編集中」と返された相手の氏名を返す。取れてしまったら空を返す
func heldByOf(t *testing.T, h http.Handler, c *http.Cookie, diaryID string) string {
	t.Helper()
	var r struct {
		HeldBy string `json:"held_by"`
	}
	if err := json.Unmarshal(call(t, h, c, "POST", "/api/diaries/"+diaryID+"/lock", "").Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	return r.HeldBy
}

// saveDiary1 は日誌 1（高梨が書いた 野原 太郎 の個人日誌の下書き）を、渡した識別子で保存する
func saveDiary1(t *testing.T, h http.Handler, c *http.Cookie, token, body, status string) *httptest.ResponseRecorder {
	t.Helper()
	return request(t, h, c, "POST", "/api/diaries",
		`{"diary_id":1,"record_type":"1","child_id":"C001","class_id":1,"diary_date":"2026-09-01",`+
			`"body":"`+body+`","lock_token":"`+token+`","status":"`+status+`"}`)
}

func diaryBodyOf(t *testing.T, a *app, id int) string {
	t.Helper()
	var body string
	if err := a.db.QueryRow(`SELECT body FROM t_diary WHERE diary_id = ?`, id).Scan(&body); err != nil {
		t.Fatal(err)
	}
	return body
}

func lockRowCount(t *testing.T, a *app, id int) int {
	t.Helper()
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_diary_lock WHERE diary_id = ?`, id).Scan(&n)
	return n
}

func TestApprovedDiaryCannotBeLocked(t *testing.T) {
	a, h := newTestApp(t)
	staff := loginAs(a, 3, "staff")
	for _, id := range []int{2, 5} {
		r := chatReq(h, staff, "POST", "/api/diaries/"+strconv.Itoa(id)+"/lock", "")
		if r.Code == http.StatusOK || lockRowCount(t, a, id) != 0 {
			t.Fatalf("申請中・承認済みの日誌にロックを取得できました: diary=%d status=%d %s", id, r.Code, r.Body.String())
		}
	}
}

func TestForceUnlockedEditorCannotSave(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff") // さくら組の担任。日誌 1 を書いた本人
	admin := loginAs(a, 1, "staff")

	t1 := acquireToken(t, h, takanashi, "1")
	// 管理者が強制解除して、何も直さずに離れる（ロックの行は消えたまま）
	call(t, h, admin, "DELETE", "/api/diaries/1/lock?force=true", "")

	expectStatus(t, saveDiary1(t, h, takanashi, t1, "解除されたあとの保存", "1"), http.StatusConflict)
	expectStatus(t, saveDiary1(t, h, takanashi, t1, "解除されたあとの申請", "2"), http.StatusConflict)
	// ロックの行が無いとき、識別子を空にしても通さない
	expectStatus(t, saveDiary1(t, h, takanashi, "", "識別子なしの保存", "1"), http.StatusConflict)
	if got := diaryBodyOf(t, a, 1); strings.Contains(got, "保存") || strings.Contains(got, "申請") {
		t.Fatalf("解除された編集者の保存が通っています: %q", got)
	}

	// 開き直せば（ロックを取り直せば）保存できる
	t2 := acquireToken(t, h, takanashi, "1")
	expectStatus(t, saveDiary1(t, h, takanashi, t2, "開き直してからの保存", "1"), http.StatusOK)
}

func TestLockTokenIsNotGivenToOthers(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff")
	admin := loginAs(a, 1, "staff")

	t1 := acquireToken(t, h, takanashi, "1")

	t.Run("ロックの状態には、誰が編集中かだけを返し、識別子は返さない", func(t *testing.T) {
		body := call(t, h, admin, "GET", "/api/diaries/1/lock", "").Body.String()
		if strings.Contains(body, t1) || strings.Contains(body, "lock_token") {
			t.Fatalf("ロックの識別子が返っています: %s", body)
		}
		if !strings.Contains(body, "高梨 倫太朗") {
			t.Fatalf("編集中の職員が返っていません: %s", body)
		}
	})

	t.Run("ほかの人が持つ識別子を使っても、本人でなければ保存できない", func(t *testing.T) {
		expectStatus(t, saveDiary1(t, h, admin, t1, "園長の上書き", "1"), http.StatusConflict)
		if got := diaryBodyOf(t, a, 1); got == "園長の上書き" {
			t.Fatal("ほかの職員が編集中の日誌を上書きできています")
		}
		expectStatus(t, saveDiary1(t, h, takanashi, t1, "高梨の版", "1"), http.StatusOK)
	})
}

// 確認画面にいる間もロックは残り、ほかの職員の直しを申請が黙って上書きしない（GitHub Issue #166 の 1 の手順 B）
func TestSubmitDoesNotOverwriteOthersUpdate(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff")
	admin := loginAs(a, 1, "staff")

	t1 := acquireToken(t, h, takanashi, "1")
	// 高梨が確認画面にいる間は、園長が開いても「編集中」になり、ロックを持たないので保存もできない
	if got := heldByOf(t, h, admin, "1"); got != "高梨 倫太朗" {
		t.Fatalf("held_by = %q, want 高梨 倫太朗", got)
	}
	expectStatus(t, saveDiary1(t, h, admin, "", "園長が直して保存した版", "1"), http.StatusConflict)

	// 高梨のロックが外れてから園長が直して保存すると、高梨の古い識別子での申請は断る
	call(t, h, takanashi, "DELETE", "/api/diaries/1/lock?token="+url.QueryEscape(t1), "")
	t2 := acquireToken(t, h, admin, "1")
	expectStatus(t, saveDiary1(t, h, admin, t2, "園長が直して保存した版", "1"), http.StatusOK)
	call(t, h, admin, "DELETE", "/api/diaries/1/lock?token="+url.QueryEscape(t2), "")

	expectStatus(t, saveDiary1(t, h, takanashi, t1, "高梨の版", "2"), http.StatusConflict)
	if got := diaryBodyOf(t, a, 1); got != "園長が直して保存した版" {
		t.Fatalf("園長の直しが上書きされています: %q", got)
	}
}

func TestSaveKeepsOrReleasesLock(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff")

	t1 := acquireToken(t, h, takanashi, "1")
	a.db.Exec(`UPDATE t_diary_lock SET last_active_at = '2000-01-01T00:00:00' WHERE diary_id = 1`)

	t.Run("下書き保存は操作として数え、ロックを持ったまま書き続けられる", func(t *testing.T) {
		expectStatus(t, saveDiary1(t, h, takanashi, t1, "下書き1", "1"), http.StatusOK)
		var lastActive string
		a.db.QueryRow(`SELECT last_active_at FROM t_diary_lock WHERE diary_id = 1`).Scan(&lastActive)
		if lastActive < today() {
			t.Fatalf("下書き保存で最終操作時刻が進んでいません: %s", lastActive)
		}
		expectStatus(t, saveDiary1(t, h, takanashi, t1, "下書き2", "1"), http.StatusOK)
	})

	t.Run("申請するとロックを外す（申請中の日誌は編集できないため）", func(t *testing.T) {
		expectStatus(t, saveDiary1(t, h, takanashi, t1, "申請する本文", "2"), http.StatusOK)
		if n := lockRowCount(t, a, 1); n != 0 {
			t.Fatalf("申請したあともロックが %d 件残っています", n)
		}
	})
}

func TestTouchKeepsLockWhileEditing(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff")
	admin := loginAs(a, 1, "staff")
	stale := func() {
		// 無操作の時間（既定 15 分）より前に取ったことにする
		a.db.Exec(`UPDATE t_diary_lock SET last_active_at = ? WHERE diary_id = 1`, plusMinutes(now(), -20))
	}

	t1 := acquireToken(t, h, takanashi, "1")
	stale()
	// 編集を続けている（操作のたびに知らせる）間は、取った時刻から数えずに、最後の操作から数える
	call(t, h, takanashi, "PUT", "/api/diaries/1/lock", `{"lock_token":"`+t1+`"}`)
	if got := heldByOf(t, h, admin, "1"); got != "高梨 倫太朗" {
		t.Fatalf("操作を続けているのにロックがほかの人へ移りました（held_by = %q）", got)
	}
	expectStatus(t, saveDiary1(t, h, takanashi, t1, "書き続けた本文", "1"), http.StatusOK)

	t.Run("操作の知らせも、本人の識別子でなければ受け付けない", func(t *testing.T) {
		expectStatus(t, request(t, h, admin, "PUT", "/api/diaries/1/lock", `{"lock_token":"`+t1+`"}`), http.StatusConflict)
		expectStatus(t, request(t, h, takanashi, "PUT", "/api/diaries/1/lock", `{"lock_token":"lock-1-wrong"}`), http.StatusConflict)
	})

	t.Run("操作が無いまま無操作の時間を過ぎると、ほかの職員が引き取れ、元の編集者の保存と知らせは断る", func(t *testing.T) {
		stale()
		t2 := acquireToken(t, h, admin, "1")
		expectStatus(t, request(t, h, takanashi, "PUT", "/api/diaries/1/lock", `{"lock_token":"`+t1+`"}`), http.StatusConflict)
		expectStatus(t, saveDiary1(t, h, takanashi, t1, "引き取られたあとの保存", "1"), http.StatusConflict)
		expectStatus(t, saveDiary1(t, h, admin, t2, "引き取った人の保存", "1"), http.StatusOK)
	})
}

// 解除は識別子で行う。同じ人が取り直したあとに、古い識別子の解除が届いても外さない
// （確認画面から戻る・開発時に画面を 2 回描くときに、解除と取得が前後するため）
func TestReleaseWithOldTokenKeepsNewLock(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff")

	t1 := acquireToken(t, h, takanashi, "1")
	t2 := acquireToken(t, h, takanashi, "1")
	call(t, h, takanashi, "DELETE", "/api/diaries/1/lock?token="+url.QueryEscape(t1), "")
	if n := lockRowCount(t, a, 1); n != 1 {
		t.Fatal("古い識別子の解除で、取り直したロックが外れました")
	}
	// 識別子を添えない解除も、ロックを外さない
	call(t, h, takanashi, "DELETE", "/api/diaries/1/lock", "")
	if n := lockRowCount(t, a, 1); n != 1 {
		t.Fatal("識別子を添えない解除で、ロックが外れました")
	}
	expectStatus(t, saveDiary1(t, h, takanashi, t2, "取り直した識別子での保存", "1"), http.StatusOK)

	call(t, h, takanashi, "DELETE", "/api/diaries/1/lock?token="+url.QueryEscape(t2), "")
	if n := lockRowCount(t, a, 1); n != 0 {
		t.Fatal("本人の識別子での解除で、ロックが外れません")
	}
}
