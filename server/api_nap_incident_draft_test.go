package main

import (
	"testing"
)

/*
 * 異常時の記録から起票したヒヤリハットが下書きのままのとき（GitHub Issue #142 の 5）
 * 典拠：図/画面詳細図.md「異常時記録画面」(5-2) 項目9・12（起票は下書きを作ること）、
 *      「職員ダッシュボード」(2-6) 項目9、基本設計書.md「帳票の出力」(4-8)（二重に数えない）。
 * 【仮置き】下書きの扱い（web/仮置き値.md「ヒヤリハットが下書きのままの異常時の記録」）。
 * モックは web/tests/incidentDraft.test.tsx で同じ観点を確かめる。
 */
func TestIncidentDraftStaysVisibleUntilApplied(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	suzuki := loginAs(a, 3, "staff") // さくら組の担任
	const abnormalID = 2             // さくら組・久保田 陸（C005）の記録。未起票
	today, _, twoDaysAgo := demoNapDates(t, a)
	q := "?from=" + twoDaysAgo + "&to=" + today

	abnormal := func() napAbnormalView {
		t.Helper()
		var list []napAbnormalView
		decode(t, call(t, h, admin, "GET", "/api/nap/abnormals", ""), &list)
		for _, x := range list {
			if x.NapAbnormalID == abnormalID {
				return x
			}
		}
		t.Fatalf("異常時の記録 %d が一覧にありません", abnormalID)
		return napAbnormalView{}
	}
	withoutDiary := func() int {
		t.Helper()
		var got struct {
			AbnormalWithoutDiary int `json:"abnormalWithoutDiary"`
		}
		decode(t, call(t, h, admin, "GET", "/api/dashboard/staff", ""), &got)
		return got.AbnormalWithoutDiary
	}
	reportMark := func() string {
		t.Helper()
		for _, r := range napReportOf(t, h, admin, q).abnormals {
			if r[1] == "久保田 陸" {
				return r[5]
			}
		}
		t.Fatal("帳票に久保田 陸の異常時の記録がありません")
		return ""
	}

	// 起票する前：未起票として数える
	before := withoutDiary()
	if x := abnormal(); x.DiaryID != nil || x.DiaryDraft {
		t.Fatalf("起票する前なのに diary_id=%v diary_draft=%v", x.DiaryID, x.DiaryDraft)
	}
	if m := reportMark(); m != "未起票" {
		t.Fatalf("帳票の印 = %q, want 未起票", m)
	}

	// 「起票する」を押しただけ（下書き）：一覧は下書きと分かり、ダッシュボードの数は減らない
	var d Diary
	decode(t, call(t, h, suzuki, "POST", "/api/nap/abnormals/2/incident", ""), &d)
	if x := abnormal(); x.DiaryID == nil || *x.DiaryID != d.DiaryID || !x.DiaryDraft {
		t.Fatalf("起票したあとの一覧: diary_id=%v diary_draft=%v, want %d と true", x.DiaryID, x.DiaryDraft, d.DiaryID)
	}
	if n := withoutDiary(); n != before {
		t.Fatalf("下書きのままなのにダッシュボードの数が変わりました: %d → %d", before, n)
	}
	if m := reportMark(); m != "起票済み（下書き）" {
		t.Fatalf("帳票の印 = %q, want 起票済み（下書き）", m)
	}

	// 申請する：「起票済み」になり、ダッシュボードの数が1つ減る
	if _, err := a.db.Exec(`UPDATE t_diary SET status = '2', applied_staff_id = 'S003', applied_at = ? WHERE diary_id = ?`,
		now(), d.DiaryID); err != nil {
		t.Fatal(err)
	}
	if x := abnormal(); x.DiaryDraft {
		t.Fatal("申請したのに、一覧が下書きのままです")
	}
	if n := withoutDiary(); n != before-1 {
		t.Fatalf("申請したあとのダッシュボードの数 = %d, want %d", n, before-1)
	}
	if m := reportMark(); m != "起票済み" {
		t.Fatalf("帳票の印 = %q, want 起票済み", m)
	}

	// 取り下げて下書きに戻すと、また下書きとして数える
	if _, err := a.db.Exec(`UPDATE t_diary SET status = '1', applied_staff_id = NULL, applied_at = NULL WHERE diary_id = ?`,
		d.DiaryID); err != nil {
		t.Fatal(err)
	}
	if x := abnormal(); !x.DiaryDraft {
		t.Fatal("下書きに戻したのに、一覧が下書きになっていません")
	}
	if n := withoutDiary(); n != before {
		t.Fatalf("下書きに戻したあとのダッシュボードの数 = %d, want %d", n, before)
	}

	// 差し戻し（申請まで進んだもの）は「起票済み」。デモの記録 1（日誌 3）は差し戻し
	var list []napAbnormalView
	decode(t, call(t, h, admin, "GET", "/api/nap/abnormals", ""), &list)
	for _, x := range list {
		if x.NapAbnormalID == 1 && (x.DiaryID == nil || x.DiaryDraft) {
			t.Fatalf("差し戻しの記録 1: diary_id=%v diary_draft=%v, want 起票済み", x.DiaryID, x.DiaryDraft)
		}
	}
}
