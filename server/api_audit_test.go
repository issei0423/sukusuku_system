package main

import (
	"net/http"
	"testing"
)

/*
 * アレルギー一覧の印刷（出力の記録）は、管理者・一般ができ、保護者はできない
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1)「アレルギー一覧の印刷（出力は操作ログに残す）｜保護者 ×・一般 ○※2・管理者 ○」、
 *      図/画面詳細図.md「アレルギー一覧画面」(7-4) の項目2。設計の直しは PR #216 の直-16・直-24
 *
 * 画面側のモック（web/src/api/mock.ts の recordExport）は web/tests/gaps.test.ts で同じ観点を確かめる。
 */
func TestAllergyListPrintIsForStaff(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")     // さくら組の担任。全園児のアレルギー一覧を印刷できる
	guardian := loginAs(a, 6, "guardian") // 西田 太郎（C001）の保護者

	printed := func(t *testing.T, accountID int64) int {
		t.Helper()
		var n int
		if err := a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log
			WHERE account_id = ? AND target_table = 'm_allergy' AND after_value = 'アレルギー一覧を印刷（5 名）'`,
			accountID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	body := `{"kind":"allergy_list","from":"","to":"","count":5}`

	t.Run("一般も管理者も印刷でき、誰が印刷したかが操作ログに残る", func(t *testing.T) {
		for _, tc := range []struct {
			c         *http.Cookie
			accountID int64
		}{{teacher, 3}, {admin, 1}} {
			before := printed(t, tc.accountID)
			call(t, h, tc.c, "POST", "/api/exports", body)
			if got := printed(t, tc.accountID); got != before+1 {
				t.Fatalf("アカウント%d の印刷の記録 = %d, want %d", tc.accountID, got, before+1)
			}
		}
	})

	t.Run("保護者は印刷できず、記録も残らない", func(t *testing.T) {
		expectStatus(t, request(t, h, guardian, "POST", "/api/exports", body), http.StatusForbidden)
		if got := printed(t, 6); got != 0 {
			t.Fatalf("保護者の印刷の記録が %d 件残っています", got)
		}
	})

	t.Run("操作ログの出力と招待コードの出力は、これまでどおり管理者だけ", func(t *testing.T) {
		expectStatus(t, request(t, h, teacher, "POST", "/api/exports",
			`{"kind":"operation_log","from":"2026-04-01","to":"2026-04-30","count":1}`), http.StatusForbidden)
		expectStatus(t, request(t, h, teacher, "POST", "/api/exports",
			`{"kind":"invitation_sheet","from":"","to":"","count":1}`), http.StatusForbidden)
	})
}
