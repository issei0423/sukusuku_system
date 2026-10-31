package main

import (
	"net/http"
	"strings"
	"testing"
)

/*
管理者だけの経路は、承認・承認の取り消しのほかは、requireAdmin の総称の文「この操作は管理者のみが行えます」で断る
（照合 c2a-05・c5-07。固有の文を持つのは requireAdminFor の承認と承認の取り消しだけ）。
ロックの強制解除・操作ログと招待コードの出力は、職員の経路の中で管理者だけに許す操作なので、固有の文のまま（ここでは見ない）。
モック（web/src/api/mock.ts の ADMIN_ONLY_MESSAGE）も同じ文にそろえる。モックは web/tests/mockServerRules.test.ts
*/
func TestAdminOnlyRoutesUseGenericMessage(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff") // 一般（さくら組の担任）
	routes := []struct{ method, path, body string }{
		{"GET", "/api/children/removable", ""},
		{"POST", "/api/children", `{}`},
		{"GET", "/api/children/C001/exists", ""},
		{"GET", "/api/children/same-name-birth?name=x&birth_date=2024-04-01", ""},
		{"DELETE", "/api/children/C001", ""},
		{"GET", "/api/diaries/pending", ""},
		{"POST", "/api/diaries/1/return", `{"reason":"x"}`},
		{"GET", "/api/chat/misdelivery", ""},
		{"POST", "/api/chat/misdelivery", `{}`},
		{"GET", "/api/chat/misdelivery/pending", ""},
		{"POST", "/api/development/schedules", `{}`},
		{"POST", "/api/development/schedules/apply", `{}`},
		{"GET", "/api/development/share-settings", ""},
		{"POST", "/api/development/share-settings", `{}`},
		{"DELETE", "/api/physical/records/1", ""},
		{"POST", "/api/physical/export", `{}`},
		{"GET", "/api/admin/accounts", ""},
		{"GET", "/api/admin/staff-accounts", ""},
		{"POST", "/api/admin/staff-accounts", `{}`},
		{"POST", "/api/admin/staff-accounts/S005", `{}`},
		{"POST", "/api/admin/accounts/5/temp-password", ""},
		{"POST", "/api/admin/accounts/5/unlock", ""},
		{"POST", "/api/admin/accounts/5/status", `{"status":"2"}`},
		{"GET", "/api/admin/guardian-accounts", ""},
		{"POST", "/api/admin/guardian-links/end", `{}`},
		{"POST", "/api/admin/guardian-links/restore", `{}`},
		{"GET", "/api/admin/invitations", ""},
		{"POST", "/api/admin/invitations", `{}`},
		{"POST", "/api/admin/invitations/bulk", `{}`},
		{"POST", "/api/admin/invitations/1/revoke", ""},
		{"GET", "/api/admin/logs", ""},
		{"POST", "/api/children/csv/import", `{}`},
		{"GET", "/api/fiscal-year/preview", ""},
		{"POST", "/api/handouts", `{}`},
		{"POST", "/api/handouts/1/withdraw", ""},
	}
	for _, rt := range routes {
		rec := request(t, h, teacher, rt.method, rt.path, rt.body)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "この操作は管理者のみが行えます") {
			t.Errorf("%s %s: %d %s（403 と総称の文のはず）", rt.method, rt.path, rec.Code, strings.TrimSpace(rec.Body.String()))
		}
	}
}
