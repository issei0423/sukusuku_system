package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * 保護者に見せる範囲（GitHub Issue #157）
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1)・「権限チェックの実装方針」(6-2)「画面を経由せず直接リクエストを
 *      送っても拒否されること」、「日誌システム（園内の記録）」(4-6)、詳細設計書.md「日誌」(4-13)
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、
 * web/tests/guardianScope.test.ts と同じ観点で確かめる。
 */

// 日誌は園内の記録で、保護者へ返す経路を持たない。一覧・1件・添付・園児の日誌・タイムライン・取り下げのどれも 403。
// 承認済みの自児の個人日誌（以前の版で保護者へ共有した日誌 5）も、他児の日誌も、無い日誌も同じ文言にする
// （詳細設計書「日誌」(4-13)「保護者が呼んだら 403『この日誌を参照する権限がありません』」・(10)）
func TestGuardianCannotUseDiaryRoutes(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, 6, "guardian") // 野原 太郎（C001）の保護者。日誌 1 は C001 の下書き、日誌 5 は C001 の承認済み
	teacher := loginAs(a, 3, "staff")     // さくら組
	kinjo := loginAs(a, 5, "staff")       // ひまわり組

	for _, path := range []string{"/api/children/C001/diaries", "/api/children/C001/timeline"} {
		body := expectStatus(t, request(t, h, guardian, "GET", path, ""), http.StatusForbidden)
		if strings.Contains(body, "積み木") {
			t.Fatalf("%s: 下書きの本文が返っています: %s", path, body)
		}
		expectStatus(t, request(t, h, kinjo, "GET", path, ""), http.StatusForbidden)

		var got []Diary
		if err := json.Unmarshal(call(t, h, teacher, "GET", path, "").Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if len(got) == 0 {
			t.Fatalf("%s: 担任に過去の記録が返っていません", path)
		}
	}

	for _, path := range []string{
		"/api/diaries", "/api/diaries?status=3",
		"/api/diaries/5", "/api/diaries/1", "/api/diaries/4", "/api/diaries/99999",
		"/api/diaries/5/attachments", "/api/diaries/4/attachments",
		"/api/children/C001/diaries", "/api/children/C001/timeline",
	} {
		var e apiError
		if err := json.Unmarshal([]byte(expectStatus(t, request(t, h, guardian, "GET", path, ""), http.StatusForbidden)), &e); err != nil {
			t.Fatal(err)
		}
		if e.Message != "この日誌を参照する権限がありません" {
			t.Fatalf("%s: message = %q", path, e.Message)
		}
	}
	// 取り下げも保護者には通さない
	expectStatus(t, request(t, h, guardian, "POST", "/api/diaries/2/withdraw", `{"updated_at":""}`), http.StatusForbidden)
	// 職員にはこれまでどおり（参照範囲の外は同じ文言で 403）
	expectStatus(t, request(t, h, kinjo, "GET", "/api/diaries/1", ""), http.StatusForbidden)
	call(t, h, teacher, "GET", "/api/diaries/5", "")
}

// 承認しても保護者へは何も届かない。どの記録種別でも、個人チャットにメッセージが増えず、保護者ホームに日誌が出ない
// （詳細設計書「日誌」(4-13 (2))。以前の版の共有の指定 share_to_guardian が送られても読まない）
func TestApprovalSendsNothingToGuardian(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")
	guardian := loginAs(a, 6, "guardian")

	countMessages := func() int {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message`).Scan(&n)
		return n
	}
	before := countMessages()

	personal := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		personalDiary(0, "C001", "1", today(), "園内で確かめる個人日誌", "2")).Body.Bytes())
	incident := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		// ヒヤリハットは本文の代わりに欄で送る（詳細設計書「日誌」(4-13 (1))。api_diary_incident.go）
		`{"record_type":"4","child_id":"C001","class_id":1,"diary_date":"`+today()+`","body":"","status":"2",
		  "incident":{"occurred_at":"`+today()+`T00:00:00","place":"保育室","situation":"園内限定の記録","response":"その場で確かめた"}}`).Body.Bytes())
	for _, id := range []int64{personal.DiaryID, incident.DiaryID, 2} { // 2 はさくら組のクラス日誌（申請中）
		d := diaryOf(t, call(t, h, admin, "POST", "/api/diaries/"+itoa(id)+"/approve", `{"share_to_guardian":true}`).Body.Bytes())
		if d.Status != "3" {
			t.Fatalf("日誌 %d: status = %s, want 3", id, d.Status)
		}
	}
	if after := countMessages(); after != before {
		t.Fatalf("承認でチャットのメッセージが %d → %d 件に増えています", before, after)
	}
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE source_type = '2' AND is_deleted = 0`).Scan(&n)
	if n != 0 {
		t.Fatalf("日誌の共有の知らせが %d 件残っています", n)
	}
	home := call(t, h, guardian, "GET", "/api/dashboard/guardian", "").Body.String()
	if strings.Contains(home, "sharedDiaries") || strings.Contains(home, "園内で確かめる個人日誌") || strings.Contains(home, "園内限定の記録") {
		t.Fatalf("保護者ホームに日誌が出ています: %s", home)
	}
}

// 園児情報・既往歴・アレルギーは保護者に見せない。身体測定は共有したもの（連携済）だけ
// （基本設計書 6-1「園児情報の参照｜保護者 ×」「既往歴の参照｜保護者 ×」「成長グラフの閲覧｜保護者 ※3」）
func TestGuardianCannotReadChildRecords(t *testing.T) {
	a, h := newTestApp(t)
	kinjoS := loginAs(a, 10, "guardian") // 金城 陸（C005）の保護者。C005 には既往歴がある
	teacher := loginAs(a, 3, "staff")

	for _, path := range []string{"/api/children/C005", "/api/children/C005/medical-histories", "/api/children/C005/allergies"} {
		body := expectStatus(t, request(t, h, kinjoS, "GET", path, ""), http.StatusForbidden)
		if strings.Contains(body, "熱性けいれん") || strings.Contains(body, "normal_temperature") {
			t.Fatalf("%s: 園内の情報が返っています: %s", path, body)
		}
		call(t, h, teacher, "GET", path, "")
	}

	t.Run("身体測定の経路は、保護者には 403（成長の記録で読む）。職員には全件", func(t *testing.T) {
		guardian := loginAs(a, 6, "guardian") // 野原 太郎（C001）の保護者
		body := expectStatus(t, request(t, h, guardian, "GET", "/api/children/C001/physical", ""), http.StatusForbidden)
		if !strings.Contains(body, msgGrowthForbidden) {
			t.Fatalf("保護者の応答: %s", body)
		}
		var all []PhysicalRecord
		if err := json.Unmarshal(call(t, h, teacher, "GET", "/api/children/C001/physical", "").Body.Bytes(), &all); err != nil {
			t.Fatal(err)
		}
		if len(all) != 3 {
			t.Fatalf("職員に %d 件返っています。want 3", len(all))
		}
	})
}

/*
 * 保護者には自児だけを返し、園児情報入力画面の項目（既往歴・アレルギー・写真の利用同意・平熱）は返さない
 * （図/インタフェース一覧.md「経路の一覧」(1) の GET /api/children・/api/children/{childID}・/class・
 * /allergies・/medical-histories。設計の直しは PR #216（直-30）、基本設計書「権限と利用可能機能」(6-1)
 * 「園児情報の参照｜保護者 ×」「既往歴の参照｜保護者 ×」「アレルギー一覧の参照｜保護者 ×」）。
 * 画面側のモックは web/tests/guardianScope.test.ts で同じ観点を確かめる。
 */
func TestGuardianChildIntakeItemsAreNotReturned(t *testing.T) {
	a, h := newTestApp(t)
	nohara := loginAs(a, 6, "guardian") // 野原 太郎（C001・さくら組）の保護者。C001 には卵のアレルギーがある
	teacher := loginAs(a, 3, "staff")   // さくら組
	admin := loginAs(a, 1, "staff")

	intakeKeys := []string{"normal_temperature", "photo_consent_level"}
	// 園内の情報の本文。アレルギー（C001 の卵・C013 の落花生）と既往歴（C005・C013）
	intakeTexts := []string{"除去食", "落花生", "エピペン", "熱性けいれん", "ぜんそく"}
	noIntake := func(t *testing.T, where, body string) {
		t.Helper()
		for _, k := range intakeKeys {
			if strings.Contains(body, `"`+k+`"`) {
				t.Fatalf("%s: 保護者に %s が返っています: %s", where, k, body)
			}
		}
		for _, s := range intakeTexts {
			if strings.Contains(body, s) {
				t.Fatalf("%s: 保護者に園内の情報（%s）が返っています: %s", where, s, body)
			}
		}
	}

	t.Run("自児・他児とも、園児の詳細・アレルギー・既往歴・アレルギー一覧は 403", func(t *testing.T) {
		for _, child := range []string{"C001", "C013", "C999"} {
			for _, sub := range []string{"", "/allergies", "/medical-histories"} {
				path := "/api/children/" + child + sub
				noIntake(t, path, expectStatus(t, request(t, h, nohara, "GET", path, ""), http.StatusForbidden))
			}
		}
		noIntake(t, "/api/children/allergies",
			expectStatus(t, request(t, h, nohara, "GET", "/api/children/allergies", ""), http.StatusForbidden))
	})

	t.Run("園児の一覧は自児だけで、入力画面の項目を返さない。クラスを指定しても広がらない", func(t *testing.T) {
		for _, path := range []string{"/api/children", "/api/children?class_id=1", "/api/children?class_id=2", "/api/children?name=%E5%AE%AE%E5%9F%8E"} {
			body := call(t, h, nohara, "GET", path, "").Body.String()
			noIntake(t, path, body)
			var got []map[string]any
			if err := json.Unmarshal([]byte(body), &got); err != nil {
				t.Fatal(err)
			}
			for _, c := range got {
				if c["child_id"] != "C001" {
					t.Fatalf("%s: 自児でない園児が返っています: %v", path, c)
				}
			}
		}
		var mine []map[string]any
		if err := json.Unmarshal(call(t, h, nohara, "GET", "/api/children", "").Body.Bytes(), &mine); err != nil {
			t.Fatal(err)
		}
		if len(mine) != 1 || mine[0]["child_name"] != "野原 太郎" || mine[0]["birth_date"] == nil {
			t.Fatalf("自児の氏名・生年月日が返っていません: %v", mine)
		}
	})

	t.Run("参照データと保護者ホームの園児にも、入力画面の項目を載せない", func(t *testing.T) {
		ref := call(t, h, nohara, "GET", "/api/reference", "").Body.String()
		noIntake(t, "/api/reference", ref)
		if !strings.Contains(ref, "野原 太郎") || strings.Contains(ref, "金城 陸") {
			t.Fatalf("/api/reference の園児が自児だけになっていません: %s", ref)
		}
		home := call(t, h, nohara, "GET", "/api/dashboard/guardian", "").Body.String()
		noIntake(t, "/api/dashboard/guardian", home)
	})

	t.Run("所属クラスは自児だけ", func(t *testing.T) {
		call(t, h, nohara, "GET", "/api/children/C001/class", "")
		expectStatus(t, request(t, h, nohara, "GET", "/api/children/C013/class", ""), http.StatusForbidden)
	})

	t.Run("紐づけが終わった保護者には、元の自児も返さない", func(t *testing.T) {
		if _, err := a.db.Exec(`UPDATE t_guardian_child SET link_status = '2', ended_at = ? WHERE guardian_id = 'G001'`, now()); err != nil {
			t.Fatal(err)
		}
		// 後に続くテストのために紐づけを戻す。戻せなかったら知らせる（状態が残ったまま進めない）
		t.Cleanup(func() {
			if _, err := a.db.Exec(`UPDATE t_guardian_child SET link_status = '1', ended_at = NULL WHERE guardian_id = 'G001'`); err != nil {
				t.Errorf("紐づけを戻せませんでした: %v", err)
			}
		})
		if body := strings.TrimSpace(call(t, h, nohara, "GET", "/api/children", "").Body.String()); body != "[]" {
			t.Fatalf("紐づけの終わった園児が返っています: %s", body)
		}
		expectStatus(t, request(t, h, nohara, "GET", "/api/children/C001/class", ""), http.StatusForbidden)
	})

	t.Run("職員には、これまでどおり入力画面の項目を返す", func(t *testing.T) {
		for _, c := range []*http.Cookie{teacher, admin} {
			for _, path := range []string{"/api/children", "/api/children/C001", "/api/reference"} {
				body := call(t, h, c, "GET", path, "").Body.String()
				for _, k := range intakeKeys {
					if !strings.Contains(body, `"`+k+`"`) {
						t.Fatalf("%s: 職員に %s が返っていません: %s", path, k, body)
					}
				}
			}
			if !strings.Contains(call(t, h, c, "GET", "/api/children/C001/allergies", "").Body.String(), "除去食") {
				t.Fatal("職員に自クラスの園児のアレルギーが返っていません")
			}
		}
	})
}

/*
 * 保護者へ返す参照データは、自児のクラスと、保護者の画面で使う設定だけ
 * （詳細設計書「参照データの設定の返し方」(4-10 (7))、決めたこと D-44。図/インタフェース一覧.md の GET /api/reference。
 * クラスを自児のものに絞るのは【仮置き】。web/仮置き値.md）。
 * 画面側のモックは web/tests/guardianScope.test.ts で同じ観点を確かめる。
 */
func TestGuardianReferenceIsNarrowed(t *testing.T) {
	a, h := newTestApp(t)
	nohara := loginAs(a, 6, "guardian") // 野原 太郎（C001・さくら組）の保護者
	teacher := loginAs(a, 3, "staff")   // さくら組
	admin := loginAs(a, 1, "staff")

	readRef := func(t *testing.T, c *http.Cookie) referenceData {
		t.Helper()
		var ref referenceData
		if err := json.Unmarshal(call(t, h, c, "GET", "/api/reference", "").Body.Bytes(), &ref); err != nil {
			t.Fatal(err)
		}
		return ref
	}
	classIDs := func(cs []ClassRoom) []int64 {
		out := []int64{}
		for _, c := range cs {
			out = append(out, c.ClassID)
		}
		return out
	}
	sameIDs := func(got []int64, want ...int64) bool {
		if len(got) != len(want) {
			return false
		}
		for i := range got {
			if got[i] != want[i] {
				return false
			}
		}
		return true
	}

	t.Run("設定は保護者の画面で使うキーだけで、午睡の間隔などは返さない", func(t *testing.T) {
		ref := readRef(t, nohara)
		for k := range ref.Settings {
			if !guardianSettingKeys[k] {
				t.Fatalf("保護者に設定 %s が返っています", k)
			}
		}
		for _, k := range []string{"facility.name", "facility.phone_number"} {
			if ref.Settings[k] == "" {
				t.Fatalf("保護者の画面で使う設定 %s が返っていません: %v", k, ref.Settings)
			}
		}
		for _, k := range []string{"nap.interval_minutes.age0", "nap.time_range", "auth.max_failed_login", "ui.diary_lock_minutes"} {
			if _, has := ref.Settings[k]; has {
				t.Fatalf("保護者に設定 %s が返っています", k)
			}
		}
	})

	t.Run("クラスは自児のクラスだけ。/api/classes も同じ", func(t *testing.T) {
		if got := classIDs(readRef(t, nohara).Classes); !sameIDs(got, 1) {
			t.Fatalf("保護者の参照データのクラス = %v, want [1]", got)
		}
		var classes []ClassRoom
		if err := json.Unmarshal(call(t, h, nohara, "GET", "/api/classes", "").Body.Bytes(), &classes); err != nil {
			t.Fatal(err)
		}
		if got := classIDs(classes); !sameIDs(got, 1) {
			t.Fatalf("保護者の /api/classes = %v, want [1]", got)
		}
	})

	t.Run("きょうだいが別のクラスにいれば両方。紐づけが終われば外れる", func(t *testing.T) {
		if _, err := a.db.Exec(`INSERT INTO t_guardian_child (guardian_id, child_id, relationship, link_status, linked_at)
			VALUES ('G001', 'C013', '父', '1', ?)`, now()); err != nil {
			t.Fatal(err)
		}
		if got := classIDs(readRef(t, nohara).Classes); !sameIDs(got, 1, 2) {
			t.Fatalf("きょうだいのいる保護者のクラス = %v, want [1 2]", got)
		}
		if _, err := a.db.Exec(`UPDATE t_guardian_child SET link_status = '2', ended_at = ? WHERE guardian_id = 'G001' AND child_id = 'C013'`, now()); err != nil {
			t.Fatal(err)
		}
		if got := classIDs(readRef(t, nohara).Classes); !sameIDs(got, 1) {
			t.Fatalf("紐づけを終えたあとのクラス = %v, want [1]", got)
		}
	})

	t.Run("職員には、これまでどおり全キーと選べるクラスを返す", func(t *testing.T) {
		for _, c := range []*http.Cookie{teacher, admin} {
			if _, has := readRef(t, c).Settings["nap.interval_minutes.age0"]; !has {
				t.Fatal("職員に午睡の間隔の設定が返っていません")
			}
		}
		if got := classIDs(readRef(t, teacher).Classes); !sameIDs(got, 1) {
			t.Fatalf("担任のクラス = %v, want [1]", got)
		}
		if got := classIDs(readRef(t, admin).Classes); len(got) < 3 {
			t.Fatalf("管理者のクラス = %v, want 全クラス", got)
		}
	})
}
