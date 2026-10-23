package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * 園児の取消・操作ログの変更前後・アカウントと招待コードの操作（GitHub Issue #166 の 4〜6、#167 の 1・3・4）
 * 典拠：基本設計書.md「園児情報の取消（誤登録の削除）」(4-4)、「メッセージ一覧」(4-9)「取消の不可」、
 *      「共通の処理」(4-2)「変更前後の値」、「操作ログ（t_operation_log）」(5-8)、
 *      「入力項目の制約値」(4-9)、「設定マスタ（m_setting）」(5-8)、図/画面詳細図.md「招待コード管理画面」(7-7)
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、web/tests/adminChecks.test.ts と同じ観点で確かめる。
 */

type logRow struct {
	ID            int64   `json:"operation_log_id"`
	TargetTable   string  `json:"target_table"`
	TargetID      *int64  `json:"target_id"`
	TargetChildID *string `json:"target_child_id"`
	OperationType string  `json:"operation_type"`
	Before        *string `json:"before_value"`
	After         *string `json:"after_value"`
}

// logsOf は、操作ログを新しい順に返す（対象園児で絞れる）
func logsOf(t *testing.T, h http.Handler, admin *http.Cookie, childID string) []logRow {
	t.Helper()
	path := "/api/admin/logs?per_page=500"
	if childID != "" {
		path += "&child_id=" + childID
	}
	var out struct {
		Rows []logRow `json:"rows"`
	}
	if err := json.Unmarshal(call(t, h, admin, "GET", path, "").Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Rows
}

func logCount(t *testing.T, a *app) int {
	t.Helper()
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log`).Scan(&n)
	return n
}

// jsonOf は、操作ログの変更前後（JSON 文字列）を読む
func jsonOf(t *testing.T, v *string) map[string]any {
	t.Helper()
	if v == nil {
		t.Fatal("値が空です")
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(*v), &m); err != nil {
		t.Fatalf("JSON として読めません: %v (%s)", err, *v)
	}
	return m
}

const newChildBody = `{"mode":"create","child_id":"C901","child_name":"誤登録 太郎","child_name_kana":"ごとうろく たろう",` +
	`"birth_date":"2024-05-01","sex":"1","normal_temperature":36.5,"photo_consent_level":"2","class_id":1,` +
	`"allergies":[],"medical_histories":[]}`

func TestRemoveChildRequiresNoRecords(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	t.Run("記録のある園児は取り消せない", func(t *testing.T) {
		// 西田 太郎（C001）は日誌・身体測定・午睡・個人チャットの記録がある
		body := expectStatus(t, request(t, h, admin, "DELETE", "/api/children/C001", ""), http.StatusBadRequest)
		if !strings.Contains(body, "記録が登録されている園児は取り消せません。在籍状態を変更してください。") {
			t.Fatalf("文言が違います: %s", body)
		}
		var deleted bool
		a.db.QueryRow(`SELECT is_deleted FROM m_child WHERE child_id = 'C001'`).Scan(&deleted)
		if deleted {
			t.Fatal("記録のある園児が取り消されています")
		}
	})

	t.Run("記録の無い誤登録は取り消せ、2 回目は「見つかりません」で操作ログも 1 行だけ", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/children", newChildBody)
		call(t, h, admin, "DELETE", "/api/children/C901", "")
		expectStatus(t, request(t, h, admin, "DELETE", "/api/children/C901", ""), http.StatusNotFound)
		n := 0
		for _, l := range logsOf(t, h, admin, "C901") {
			if l.OperationType == opDelete {
				n++
			}
		}
		if n != 1 {
			t.Fatalf("取消の操作ログが %d 行あります", n)
		}
	})

	t.Run("取り消した園児には招待コードを発行できず、取り消す前のコードでも登録できない", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/children", strings.Replace(newChildBody, "C901", "C902", 1))
		var issued struct {
			Code string `json:"code"`
		}
		json.Unmarshal(call(t, h, admin, "POST", "/api/admin/invitations", `{"child_id":"C902","valid_days":30}`).Body.Bytes(), &issued)
		call(t, h, admin, "DELETE", "/api/children/C902", "")

		expectStatus(t, request(t, h, admin, "POST", "/api/admin/invitations", `{"child_id":"C902","valid_days":30}`),
			http.StatusBadRequest)
		expectStatus(t, request(t, h, admin, "POST", "/api/admin/invitations", `{"child_id":"C999","valid_days":30}`),
			http.StatusNotFound)
		expectStatus(t, send(t, h, nil, "POST", "/api/signup",
			`{"code":"`+issued.Code+`","email":"gotoroku@example.jp","password":"gotoroku-5678","guardian_name":"誤登録 花子","relationship":"母","terms_agreed":true,"terms_version":"1.1"}`),
			http.StatusBadRequest)
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM m_account WHERE email = 'gotoroku@example.jp'`).Scan(&n)
		if n != 0 {
			t.Fatal("取り消した園児の保護者アカウントができています")
		}
	})
}

func TestChildEditLogsChangedFields(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	// 遠藤 花子（C002・さくら組・平熱 36.8・写真の利用同意 2）のクラス・平熱・写真の利用同意・アレルギーを変える。
	// 生年月日はデモの日付ずらし（seed_shift.go）で起動した日に合わせて動くので、いまの値をそのまま送る
	// （GitHub Issue #164。モック側の web/tests/adminChecks.test.ts と同じく、変えない項目はいまの値で送る）
	var birthDate string
	if err := a.db.QueryRow(`SELECT birth_date FROM m_child WHERE child_id = 'C002'`).Scan(&birthDate); err != nil {
		t.Fatal(err)
	}
	call(t, h, admin, "POST", "/api/children", `{"mode":"edit","child_id":"C002","child_name":"遠藤 花子",`+
		`"child_name_kana":"えんどう はなこ","birth_date":"`+birthDate+`","sex":"2","normal_temperature":37.2,`+
		`"photo_consent_level":"3","class_id":2,`+
		`"allergies":[{"target_food":"えび","symptom":"じんましん","response":"除去食"}],"medical_histories":[]}`)

	var row *logRow
	for _, l := range logsOf(t, h, admin, "C002") {
		if l.TargetTable == "m_child" && l.OperationType == opUpdate {
			row = &l
			break
		}
	}
	if row == nil {
		t.Fatal("園児の変更が操作ログにありません")
	}
	before, after := jsonOf(t, row.Before), jsonOf(t, row.After)
	if before["クラス"] != "さくら組" || after["クラス"] != "ひまわり組" {
		t.Fatalf("クラスの変更前後が残っていません: %v → %v", before, after)
	}
	if before["平熱"] != 36.8 || after["平熱"] != 37.2 {
		t.Fatalf("平熱の変更前後が残っていません: %v → %v", before, after)
	}
	if before["写真の利用同意"] == nil || after["写真の利用同意"] == nil || before["写真の利用同意"] == after["写真の利用同意"] {
		t.Fatalf("写真の利用同意の変更前後が残っていません: %v → %v", before, after)
	}
	if !strings.Contains(*row.After, "えび") {
		t.Fatalf("アレルギーの追加が残っていません: %s", *row.After)
	}
	// 変わっていない項目は入れない（基本設計書「操作ログ（t_operation_log）」(5-8)）
	for _, key := range []string{"氏名", "よみ", "生年月日", "性別"} {
		if _, ok := after[key]; ok {
			t.Fatalf("変わっていない %s が入っています: %s", key, *row.After)
		}
	}
}

func TestStaffAccountAndCsvLogsKeepDetails(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	t.Run("職員アカウントの発行は、ロールと担当クラスを残す", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/admin/staff-accounts",
			`{"staff_id":"S010","staff_name":"新任 主任","email":"shinnin@hoiku.example.jp","role":"1","class_id":3}`)
		var after string
		a.db.QueryRow(`SELECT after_value FROM t_operation_log WHERE target_table = 'm_account'
			ORDER BY operation_log_id DESC LIMIT 1`).Scan(&after)
		m := jsonOf(t, &after)
		if m["ロール"] != "管理者" || m["担当クラス"] == nil || m["ログインID"] != "shinnin@hoiku.example.jp" {
			t.Fatalf("発行の内容が残っていません: %s", after)
		}
	})

	t.Run("CSV で登録した園児は、1 名ずつ対象園児つきで残す", func(t *testing.T) {
		text := csvHead + "C101,一括 一郎,いっかつ いちろう,2024-04-01,1,さくら組,36.5\n" +
			"C102,一括 二郎,いっかつ じろう,2024-05-01,1,ひまわり組,\n"
		body, _ := json.Marshal(map[string]string{"text": text})
		call(t, h, admin, "POST", "/api/children/csv/import", string(body))
		for _, id := range []string{"C101", "C102"} {
			rows := logsOf(t, h, admin, id)
			if len(rows) != 1 || rows[0].OperationType != opCreate || !strings.Contains(*rows[0].After, "CSV一括登録") {
				t.Fatalf("%s の登録が操作ログにありません: %+v", id, rows)
			}
		}
	})
}

func TestUnlockAndRevokeCheckCurrentState(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	before := logCount(t, a)

	expectStatus(t, request(t, h, admin, "POST", "/api/admin/accounts/9999/unlock", ""), http.StatusNotFound)
	// 久保田（account 5）はロックされていない
	expectStatus(t, request(t, h, admin, "POST", "/api/admin/accounts/5/unlock", ""), http.StatusBadRequest)
	// 招待コード 4 はデモデータで失効済み、2 は使用済み、9999 は無い
	expectStatus(t, request(t, h, admin, "POST", "/api/admin/invitations/4/revoke", ""), http.StatusBadRequest)
	expectStatus(t, request(t, h, admin, "POST", "/api/admin/invitations/2/revoke", ""), http.StatusBadRequest)
	expectStatus(t, request(t, h, admin, "POST", "/api/admin/invitations/9999/revoke", ""), http.StatusNotFound)
	if got := logCount(t, a); got != before {
		t.Fatalf("状態が変わらない操作が操作ログに %d 行残りました", got-before)
	}

	// ロックされているアカウントは解除でき、操作ログに残る
	a.db.Exec(`UPDATE m_account SET failed_login_count = 5, locked_until = ? WHERE account_id = 5`, plusMinutes(now(), 30))
	call(t, h, admin, "POST", "/api/admin/accounts/5/unlock", "")
	if got := logCount(t, a); got != before+1 {
		t.Fatalf("ロックの解除が操作ログに残っていません（%d 行）", got-before)
	}
}

func TestCreateStaffAccountValidatesInput(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	body := func(staffID, name, email, role, classID string) string {
		return `{"staff_id":"` + staffID + `","staff_name":"` + name + `","email":"` + email +
			`","role":"` + role + `","class_id":` + classID + `}`
	}

	for _, tc := range []struct {
		name, body, want string
	}{
		{"ログインIDがメールアドレスの形でない", body("S020", "形式 確認", "abc2", "2", "null"), "形式"},
		{"大文字・小文字だけが違うログインID", body("S021", "重複 確認", "NISHIDA@hoiku.example.jp", "2", "null"), "すでに使われています"},
		{"すべて空", body("", "", "", "2", "null"), "入力してください"},
		{"氏名が 51 文字", body("S022", strings.Repeat("あ", 51), "long-name@hoiku.example.jp", "2", "null"), "50文字以内"},
		{"職員IDが 21 文字", body(strings.Repeat("S", 21), "長い 職員ID", "long-id@hoiku.example.jp", "2", "null"), "20文字以内"},
		{"ロールが無い", body("S023", "ロール 無し", "no-role@hoiku.example.jp", "", "null"), "ロール"},
		{"無い担当クラス", body("S024", "クラス 無し", "no-class@hoiku.example.jp", "2", "999"), "担当クラス"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := expectStatus(t, request(t, h, admin, "POST", "/api/admin/staff-accounts", tc.body), http.StatusBadRequest)
			if !strings.Contains(got, tc.want) {
				t.Fatalf("文言に %q がありません: %s", tc.want, got)
			}
		})
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_staff WHERE staff_id NOT IN ('S001','S002','S003','S004','S005')`).Scan(&n)
	if n != 0 {
		t.Fatalf("誤った入力で職員が %d 名できています", n)
	}

	t.Run("前後の空白は除いて登録し、空白なしのログインIDでログインできる", func(t *testing.T) {
		var r struct {
			Password string `json:"password"`
		}
		json.Unmarshal(call(t, h, admin, "POST", "/api/admin/staff-accounts",
			body(" S030 ", " 空白 確認 ", " sp@hoiku.example.jp ", "2", "1")).Body.Bytes(), &r)
		var email, staffID, name string
		a.db.QueryRow(`SELECT a.email, s.staff_id, s.staff_name FROM m_account a JOIN m_staff s ON s.account_id = a.account_id
			WHERE s.staff_name LIKE '%空白 確認%'`).Scan(&email, &staffID, &name)
		if email != "sp@hoiku.example.jp" || staffID != "S030" || name != "空白 確認" {
			t.Fatalf("前後の空白が残っています: %q %q %q", email, staffID, name)
		}
		login(t, h, "sp@hoiku.example.jp", r.Password, "staff")
	})
}

func TestBulkInvitationPerChildIsAtMostFive(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	got := expectStatus(t, request(t, h, admin, "POST", "/api/admin/invitations/bulk",
		`{"class_id":2,"per_child":6,"valid_days":30}`), http.StatusBadRequest)
	if !strings.Contains(got, "1〜5枚") {
		t.Fatalf("文言が違います: %s", got)
	}
	call(t, h, admin, "POST", "/api/admin/invitations/bulk", `{"class_id":2,"per_child":5,"valid_days":30}`)
}

func TestMeasureMonthsDefaultFollowsDesign(t *testing.T) {
	a, _ := newTestApp(t)
	var v string
	a.db.QueryRow(`SELECT setting_value FROM m_setting WHERE setting_key = 'physical.measure_months'`).Scan(&v)
	// 年3回。学期の区切りに合わせる（基本設計書「設定マスタ（m_setting）」(5-8) の既定値）
	if v != "4,8,12" {
		t.Fatalf("physical.measure_months = %q, want 4,8,12", v)
	}
}
