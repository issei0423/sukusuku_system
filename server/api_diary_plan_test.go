package main

import (
	"net/http"
	"strings"
	"testing"
)

/*
 * 週案・月案の記録日（GitHub Issue #278 の 1）
 * 典拠：基本設計書「日付の扱い」(4-6)・「入力項目の制約値とメッセージ一覧」(4-12)、
 *      図/画面詳細図「日誌作成・編集画面」(3-2) 項目6、詳細設計書「日誌」(4-13 (1))
 * web/tests/diaryFlow.test.ts と同じ規則
 */

func planDiary(recordType, date, status string) string {
	return `{"record_type":"` + recordType + `","class_id":1,"diary_date":"` + date +
		`","body":"来週の予定","status":"` + status + `"}`
}

func TestPlanDiaryDateAllowsUpTo365Days(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")

	for _, status := range []string{"1", "2"} {
		for _, days := range []int{1, 365} {
			date := addDays(today(), days)
			expectStatus(t, request(t, h, teacher, "POST", "/api/diaries", planDiary("3", date, status)), http.StatusOK)
			var n int
			a.db.QueryRow(`SELECT COUNT(*) FROM t_diary WHERE record_type = '3' AND diary_date = ? AND status = ?`, date, status).Scan(&n)
			if n != 1 {
				t.Fatalf("週案・月案の記録日 %s（状態 %s）が保存されていません", date, status)
			}
		}
		body := expectStatus(t, request(t, h, teacher, "POST", "/api/diaries", planDiary("3", addDays(today(), 366), status)), http.StatusBadRequest)
		if !strings.Contains(body, "週案・月案の記録日は365日先までです。") {
			t.Fatalf("366日先の文言が違います: %s", body)
		}
	}
}

func TestOtherDiaryTypesRefuseFutureDate(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	for _, recordType := range []string{"2"} {
		body := expectStatus(t, request(t, h, teacher, "POST", "/api/diaries",
			planDiary(recordType, addDays(today(), 1), "1")), http.StatusBadRequest)
		if !strings.Contains(body, "記録日に未来の日付は指定できません。") {
			t.Fatalf("種別 %s の文言が違います: %s", recordType, body)
		}
	}
}
