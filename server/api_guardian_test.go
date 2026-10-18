package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * 保護者に見せる範囲（GitHub Issue #157）
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1) ※3「自児のみ、かつ共有されたものに限る」・
 *      「権限チェックの実装方針」(6-2)「画面を経由せず直接リクエストを送っても拒否されること」、
 *      「日誌システム」(4-5)「共有を選べるのは個人日誌だけとする」、図/画面詳細図.md「共有日誌閲覧画面」(2-8)
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、
 * web/tests/guardianScope.test.ts と同じ観点で確かめる。
 */

// 職員の編集画面・タイムラインのための経路は、保護者には使わせない。
// 共有していない日誌（下書き・申請中・差し戻し・ヒヤリハット）と差し戻す理由が読めてしまうため
func TestGuardianCannotUseStaffDiaryRoutes(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, 6, "guardian") // 野原 太郎（C001）の保護者。日誌 1 は C001 の下書き
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
}

// 共有を選べるのは個人日誌だけ。ヒヤリハット・クラス日誌・週案月案は保護者への共有の対象外
// （基本設計書「日誌システム」(4-5)。GitHub Issue #61 で決めたことを API でも守る）
func TestApproveSharesOnlyPersonalDiary(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")
	guardian := loginAs(a, 6, "guardian")

	var incident Diary
	if err := json.Unmarshal(call(t, h, teacher, "POST", "/api/diaries",
		`{"record_type":"4","child_id":"C001","class_id":1,"diary_date":"`+today()+`","body":"【状況】園内限定の記録","status":"2"}`).
		Body.Bytes(), &incident); err != nil {
		t.Fatal(err)
	}

	t.Run("ヒヤリハット・クラス日誌を共有つきで承認しようとすると断り、承認もしない", func(t *testing.T) {
		for _, id := range []int64{incident.DiaryID, 2} { // 2 はさくら組のクラス日誌（申請中）
			expectStatus(t, request(t, h, admin, "POST", "/api/diaries/"+itoa(id)+"/approve",
				`{"share_to_guardian":true}`), http.StatusBadRequest)
			var status string
			var shared bool
			a.db.QueryRow(`SELECT status, is_shared_to_guardian FROM t_diary WHERE diary_id = ?`, id).Scan(&status, &shared)
			if status != "2" || shared {
				t.Fatalf("日誌 %d: status=%s shared=%v（申請中のまま・共有なしであるべき）", id, status, shared)
			}
		}
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message WHERE source_type = '2' AND source_id = ?`, incident.DiaryID).Scan(&n)
		if n != 0 {
			t.Fatalf("ヒヤリハットが個人チャットへ流れています（%d 件）", n)
		}
	})

	t.Run("共有しない承認は通る", func(t *testing.T) {
		call(t, h, admin, "POST", "/api/diaries/"+itoa(incident.DiaryID)+"/approve", `{"share_to_guardian":false}`)
	})

	t.Run("すでに共有の印が付いてしまったヒヤリハットも、保護者には見せない", func(t *testing.T) {
		if _, err := a.db.Exec(`UPDATE t_diary SET is_shared_to_guardian = 1 WHERE diary_id = ?`, incident.DiaryID); err != nil {
			t.Fatal(err)
		}
		expectStatus(t, request(t, h, guardian, "GET", "/api/diaries/"+itoa(incident.DiaryID), ""), http.StatusForbidden)
		if strings.Contains(call(t, h, guardian, "GET", "/api/dashboard/guardian", "").Body.String(), "園内限定の記録") {
			t.Fatal("保護者ホームにヒヤリハットが出ています")
		}
		if strings.Contains(call(t, h, guardian, "GET", "/api/diaries", "").Body.String(), "園内限定の記録") {
			t.Fatal("保護者の日誌一覧にヒヤリハットが出ています")
		}
	})
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

	t.Run("身体測定は、保護者には連携済の記録だけを返す。職員には全件", func(t *testing.T) {
		guardian := loginAs(a, 6, "guardian") // 野原 太郎（C001）。連携済 2 件・未連携 1 件
		var got []PhysicalRecord
		if err := json.Unmarshal(call(t, h, guardian, "GET", "/api/children/C001/physical", "").Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 {
			t.Fatalf("保護者に %d 件返っています。want 2", len(got))
		}
		for _, x := range got {
			if x.ShareStatus != "2" {
				t.Fatalf("連携していない測定値が返っています: %+v", x)
			}
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

// 保護者が見られない日誌を開いたときは「この記録は共有されていません」と示す（画面詳細図 2-8）。
// 自児の未共有・他児・無い日誌を同じ文言にし、あるかどうかを推測させない
func TestGuardianUnsharedDiaryMessage(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, 6, "guardian") // 野原 太郎（C001）の保護者

	for _, id := range []string{"1", "4", "99999"} { // 自児の下書き・他児の共有済み・無い日誌
		var e apiError
		if err := json.Unmarshal([]byte(expectStatus(t,
			request(t, h, guardian, "GET", "/api/diaries/"+id, ""), http.StatusForbidden)), &e); err != nil {
			t.Fatal(err)
		}
		if e.Message != "この記録は共有されていません" {
			t.Fatalf("日誌 %s: message = %q", id, e.Message)
		}
	}
	// 職員にはこれまでどおり権限の文言を返す
	var e apiError
	json.Unmarshal([]byte(expectStatus(t,
		request(t, h, loginAs(a, 5, "staff"), "GET", "/api/diaries/1", ""), http.StatusForbidden)), &e)
	if e.Message != "この日誌を参照する権限がありません" {
		t.Fatalf("職員への message = %q", e.Message)
	}
	// 共有された自児の日誌は開ける
	call(t, h, guardian, "GET", "/api/diaries/5", "")
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
