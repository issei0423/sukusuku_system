package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * 園児マスターの直し（GitHub Issue #279）
 * 典拠：基本設計書「園児情報の登録・編集」(4-4)・「CSV一括登録」(4-4)・「園児情報の取消（誤登録の削除）」(4-4)・
 *      「権限と利用可能機能」(6-1) ※1、図/画面詳細図「園児一覧画面」(7-1)・「CSV一括登録画面」(7-3)・「アレルギー一覧画面」(7-4)
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、web/tests/childMaster.test.ts と同じ観点で確かめる。
 */

func TestCsvImportSexAndPhotoConsent(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")

	t.Run("性別は「男」「女」「未回答」の文字も数字も受ける。空欄と別の文字は受けない", func(t *testing.T) {
		text := csvHead +
			"C931,文字 男,もじ おとこ,2025-06-01,男,さくら組,\n" +
			"C932,文字 女,もじ おんな,2025-06-01,女,さくら組,\n" +
			"C933,文字 未,もじ み,2025-06-01,未回答,さくら組,\n" +
			"C934,数字 男,すうじ おとこ,2025-06-01,1,さくら組,\n" +
			"C935,空欄,くうらん,2025-06-01,,さくら組,\n" +
			"C936,別の字,べつのじ,2025-06-01,不明,さくら組,"
		body, _ := json.Marshal(map[string]string{"text": text})
		var got struct {
			Rows []struct {
				Error *string `json:"error"`
			} `json:"rows"`
		}
		if err := json.Unmarshal(call(t, h, admin, "POST", "/api/children/csv/parse", string(body)).Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		for i, wantErr := range []bool{false, false, false, false, true, true} {
			if (got.Rows[i].Error != nil) != wantErr {
				t.Errorf("%d 行目の誤り = %v, want %v", i+1, got.Rows[i].Error, wantErr)
			}
		}
	})

	t.Run("取り込んだ園児は性別を数字にそろえ、写真の利用同意は園内記録のみ（1）で入る", func(t *testing.T) {
		text := csvHead +
			"C941,取込 男,とりこみ おとこ,2025-06-01,男,さくら組,\n" +
			"C942,取込 女,とりこみ おんな,2025-06-01,女,ひまわり組,\n" +
			"C943,取込 未,とりこみ み,2025-06-01,未回答,もも組,\n" +
			"C944,取込 数,とりこみ すう,2025-06-01,2,さくら組,36.5"
		body, _ := json.Marshal(map[string]string{"text": text})
		call(t, h, admin, "POST", "/api/children/csv/import", string(body))
		for id, want := range map[string]string{"C941": "1", "C942": "2", "C943": "9", "C944": "2"} {
			var sex, consent string
			if err := a.db.QueryRow(`SELECT sex, photo_consent_level FROM m_child WHERE child_id = ?`, id).Scan(&sex, &consent); err != nil {
				t.Fatal(err)
			}
			if sex != want {
				t.Errorf("%s の性別 = %q, want %q", id, sex, want)
			}
			if consent != "1" {
				t.Errorf("%s の写真の利用同意 = %q, want 1（園内記録のみ）", id, consent)
			}
		}
	})
}

func TestAllergyListReturnsOnlyWhatTheListNeeds(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff") // さくら組の担任。ほかのクラスの園児の行も全園児として返る（例外）
	body := call(t, h, teacher, "GET", "/api/children/allergies", "").Body.String()
	for _, banned := range []string{"birth_date", "normal_temperature", "photo_consent_level", "\"sex\"", "child_name_kana", "enrollment_status"} {
		if strings.Contains(body, banned) {
			t.Errorf("アレルギー一覧に %q が含まれている", banned)
		}
	}
	var rows []struct {
		Child     map[string]any `json:"child"`
		ClassName string         `json:"className"`
		Allergies []Allergy      `json:"allergies"`
	}
	if err := json.Unmarshal([]byte(body), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("アレルギーのある園児が返らない")
	}
	for _, r := range rows {
		if r.Child["child_id"] == nil || r.Child["child_name"] == nil || r.ClassName == "" || len(r.Allergies) == 0 {
			t.Errorf("クラス・氏名・アレルギーが揃っていない: %+v", r)
		}
	}
}

func TestRemoveChildBlockedByGuardianAndExpiresCodes(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")

	t.Run("保護者が紐づく園児は、記録が無くても取り消せない", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/children", newChildBody)
		// 西田 太郎（C001）の保護者（G001）を、記録の無い C901 にも紐づける
		a.db.Exec(`UPDATE t_guardian_child SET child_id = 'C901' WHERE guardian_id = 'G001' AND child_id = 'C001'`)
		body := expectStatus(t, request(t, h, admin, "DELETE", "/api/children/C901", ""), http.StatusBadRequest)
		if !strings.Contains(body, "記録または保護者が紐づいている園児は取り消せません。在籍状態を変更してください。") {
			t.Fatalf("文言が違います: %s", body)
		}
		var deleted bool
		a.db.QueryRow(`SELECT is_deleted FROM m_child WHERE child_id = 'C901'`).Scan(&deleted)
		if deleted {
			t.Fatal("保護者が紐づく園児が取り消されている")
		}
	})

	t.Run("取り消せる園児の一覧は、記録も保護者も無い園児だけ", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/children", strings.ReplaceAll(strings.ReplaceAll(newChildBody, "C901", "C902"), "誤登録 太郎", "誤登録 次郎"))
		var ids []string
		if err := json.Unmarshal(call(t, h, admin, "GET", "/api/children/removable", "").Body.Bytes(), &ids); err != nil {
			t.Fatal(err)
		}
		set := map[string]bool{}
		for _, id := range ids {
			set[id] = true
		}
		if !set["C902"] || set["C901"] || set["C001"] {
			t.Errorf("取り消せる園児 = %v（C902 だけが含まれ、C901・C001 は含まれないはず）", ids)
		}
		// 管理者だけの経路の断りの文は、モック（web/src/api/mock.ts）と同じ「この操作は管理者のみが行えます」（requireAdmin）
		teacher := loginAs(a, accTeacher, "staff")
		for _, rq := range []struct{ method, path string }{
			{"GET", "/api/children/removable"},
			{"DELETE", "/api/children/C902"},
		} {
			body := expectStatus(t, request(t, h, teacher, rq.method, rq.path, ""), http.StatusForbidden)
			if !strings.Contains(body, "この操作は管理者のみが行えます") {
				t.Errorf("%s %s の文言が違います: %s", rq.method, rq.path, body)
			}
		}
	})

	t.Run("取り消すと、未使用の招待コードを失効させる", func(t *testing.T) {
		a.db.Exec(`INSERT INTO t_invitation_code (code, child_id, expires_on, status, issued_staff_id, created_at)
			VALUES ('CODE-J3-1','C902',?,'1','S001',?)`, daysFromToday(10), now())
		call(t, h, admin, "DELETE", "/api/children/C902", "")
		var status string
		a.db.QueryRow(`SELECT status FROM t_invitation_code WHERE code = 'CODE-J3-1'`).Scan(&status)
		if status != "3" {
			t.Fatalf("招待コードの状態 = %q, want 3（失効）", status)
		}
	})
}

func TestChildListWithdrawnIsAdminOnly(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	a.db.Exec(`UPDATE m_child SET enrollment_status = '2' WHERE child_id = 'C001'`)
	ids := func(c *http.Cookie, path string) map[string]bool {
		var rows []Child
		if err := json.Unmarshal(call(t, h, c, "GET", path, "").Body.Bytes(), &rows); err != nil {
			t.Fatal(err)
		}
		m := map[string]bool{}
		for _, r := range rows {
			m[r.ChildID] = true
		}
		return m
	}
	if ids(admin, "/api/children")["C001"] {
		t.Error("既定では退園した園児を出さない")
	}
	if !ids(admin, "/api/children?include_withdrawn=1")["C001"] {
		t.Error("管理者が「退園した園児も出す」とすると、退園した園児が出る")
	}
	if ids(teacher, "/api/children?include_withdrawn=1")["C001"] {
		t.Error("一般には、退園した園児を出さない")
	}
}

func TestFreeStaffReadsEveryClassButWritesNothing(t *testing.T) {
	a, h := newTestApp(t)
	// フリー（今年度の担任クラスが無い一般）。ひまわり組の担任（S005）の割り当てを外す
	a.db.Exec(`DELETE FROM t_class_staff WHERE staff_id = 'S005'`)
	free := loginAs(a, accOtherTeacher, "staff")

	var children []Child
	if err := json.Unmarshal(call(t, h, free, "GET", "/api/children", "").Body.Bytes(), &children); err != nil {
		t.Fatal(err)
	}
	classes := map[int64]bool{}
	for _, c := range children {
		var id int64
		a.db.QueryRow(`SELECT class_id FROM t_class_child WHERE child_id = ?`, c.ChildID).Scan(&id)
		classes[id] = true
	}
	if len(children) == 0 || len(classes) < 3 {
		t.Fatalf("フリーは全クラスの園児を読める: 園児 %d 名・%d クラス", len(children), len(classes))
	}

	t.Run("読めるもの", func(t *testing.T) {
		for _, path := range []string{"/api/children/C001", "/api/children/C001/allergies", "/api/children/C001/class",
			"/api/nap/session?class_id=1", "/api/nap/state?class_id=1"} {
			if rec := request(t, h, free, "GET", path, ""); rec.Code != http.StatusOK {
				t.Errorf("GET %s = %d, want 200: %s", path, rec.Code, rec.Body.String())
			}
		}
		var ref struct {
			Classes []ClassRoom `json:"classes"`
		}
		if err := json.Unmarshal(call(t, h, free, "GET", "/api/reference", "").Body.Bytes(), &ref); err != nil {
			t.Fatal(err)
		}
		if len(ref.Classes) < 3 {
			t.Errorf("フリーが選べるクラスは全クラス: %d", len(ref.Classes))
		}
	})

	t.Run("既往歴は読めない（安全側）", func(t *testing.T) {
		expectStatus(t, request(t, h, free, "GET", "/api/children/C001/medical-histories", ""), http.StatusForbidden)
	})

	t.Run("書けない", func(t *testing.T) {
		expectStatus(t, request(t, h, free, "POST", "/api/children", newChildBody), http.StatusForbidden)
		expectStatus(t, request(t, h, free, "POST", "/api/nap/session", `{"class_id":1,"date":"`+today()+`"}`), http.StatusForbidden)
		// 午睡の記録は、園児ごとの書き込みの判定（canSeeChild・contactAccess の Write）で止まる
		if a.canSeeChild(a.sessionUserByAccount(t, accOtherTeacher), "C001") {
			t.Error("canSeeChild はフリーに true を返さない（書き込みの判定に使うため）")
		}
	})
}
