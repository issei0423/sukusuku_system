package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

/*
 * 異常時の記録の「保護者への連絡」
 * 典拠：図/画面詳細図.md「異常時記録画面」(5-2) 項目13（PR #216 の版。午睡中の異常は電話で伝え（段4）、
 *      連絡帳・個人チャットは電話のあとに経過を書く手段）、基本設計書.md「異常時の記録」(4-8)、
 *      「入力項目の制約値」(4-12)、「午睡チェック」(5-7) の「足した列（午睡チェックの記録・異常時の記録）」
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、
 * web/tests/incidentGuidance.test.tsx の「異常時の記録の保護者への連絡（モックの規則）」と同じ観点で確かめる。
 */
func TestNapAbnormalGuardianNotice(t *testing.T) {
	a, h := newTestApp(t)
	takanashi := loginAs(a, 3, "staff") // さくら組
	s := startOwnNap(t, h, takanashi)
	path := "/api/nap/session/" + itoa(s.NapSessionID) + "/abnormals"
	found := today() + "T00:00:00"
	body := func(notice string) string {
		b := `{"child_id":"C001","found_at":"` + found + `","situation":"顔色がやや紅潮","response":"別室で休ませた"`
		if notice != "" {
			b += "," + notice
		}
		return b + "}"
	}
	type stored struct{ notice, at, method, person sql.NullString }
	storedOf := func(rec []byte) stored {
		t.Helper()
		var res struct {
			ID int64 `json:"nap_abnormal_id"`
		}
		if err := json.Unmarshal(rec, &res); err != nil {
			t.Fatal(err)
		}
		var x stored
		a.db.QueryRow(`SELECT guardian_notice, guardian_noticed_at, guardian_notice_method, guardian_notice_person
			FROM t_nap_abnormal WHERE nap_abnormal_id = ?`, res.ID).Scan(&x.notice, &x.at, &x.method, &x.person)
		return x
	}
	count := func() int {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_abnormal`).Scan(&n)
		return n
	}

	t.Run("連絡の要否はシステムが判断しない。未記入のままでも記録でき、4列とも空になる", func(t *testing.T) {
		x := storedOf(call(t, h, takanashi, "POST", path, body("")).Body.Bytes())
		if x.notice.Valid || x.at.Valid || x.method.Valid || x.person.Valid {
			t.Fatalf("未記入のはずが値が入っています: %+v", x)
		}
	})

	t.Run("「しない」は記録でき、日時・手段・相手は持たない", func(t *testing.T) {
		x := storedOf(call(t, h, takanashi, "POST", path, body(
			`"guardian_notice":"2","guardian_noticed_at":"`+found+`","guardian_notice_method":"1","guardian_notice_person":"母"`)).Body.Bytes())
		if x.notice.String != "2" || x.at.Valid || x.method.Valid || x.person.Valid {
			t.Fatalf("しない = %+v", x)
		}
	})

	before := count()
	t.Run("「した」のときは日時・手段・相手が要り、日時の未来・形の崩れ、知らない手段、51文字の相手を断る", func(t *testing.T) {
		cases := map[string]string{
			"日時が無い":      `"guardian_notice":"1","guardian_notice_method":"1","guardian_notice_person":"母"`,
			"手段が無い":      `"guardian_notice":"1","guardian_noticed_at":"` + found + `","guardian_notice_person":"母"`,
			"相手が空白だけ":    `"guardian_notice":"1","guardian_noticed_at":"` + found + `","guardian_notice_method":"1","guardian_notice_person":"　 "`,
			"日時が未来":      `"guardian_notice":"1","guardian_noticed_at":"2999-01-01T10:00:00","guardian_notice_method":"1","guardian_notice_person":"母"`,
			"日時の形が崩れている": `"guardian_notice":"1","guardian_noticed_at":"abc","guardian_notice_method":"1","guardian_notice_person":"母"`,
			"知らない手段":     `"guardian_notice":"1","guardian_noticed_at":"` + found + `","guardian_notice_method":"4","guardian_notice_person":"母"`,
			"相手が51文字":    `"guardian_notice":"1","guardian_noticed_at":"` + found + `","guardian_notice_method":"1","guardian_notice_person":"` + strings.Repeat("母", 51) + `"`,
			"した・しない以外":   `"guardian_notice":"3"`,
		}
		for name, c := range cases {
			got := expectStatus(t, request(t, h, takanashi, "POST", path, body(c)), http.StatusBadRequest)
			if !strings.Contains(got, "保護者") {
				t.Fatalf("%s: 保護者への連絡の文言ではありません: %s", name, got)
			}
		}
		if n := count(); n != before {
			t.Fatalf("断ったはずの記録が %d 件できています", n-before)
		}
	})

	t.Run("「した」は日時・手段・相手を残し、一覧で返す。電話のあとに経過を書いた連絡帳・個人チャットも手段に選べる", func(t *testing.T) {
		person := strings.Repeat("母", 49) + "）"
		x := storedOf(call(t, h, takanashi, "POST", path, body(
			`"guardian_notice":"1","guardian_noticed_at":"`+found+`","guardian_notice_method":"1","guardian_notice_person":" `+person+` "`)).Body.Bytes())
		if x.notice.String != "1" || x.at.String != found || x.method.String != "1" || x.person.String != person {
			t.Fatalf("した = %+v", x)
		}
		storedOf(call(t, h, takanashi, "POST", path, body(
			`"guardian_notice":"1","guardian_noticed_at":"`+found+`","guardian_notice_method":"3","guardian_notice_person":"父"`)).Body.Bytes())

		var list []napAbnormalView
		if err := json.Unmarshal(call(t, h, takanashi, "GET", "/api/nap/abnormals", "").Body.Bytes(), &list); err != nil {
			t.Fatal(err)
		}
		methods := map[string]bool{}
		for _, v := range list {
			if v.GuardianNotice != nil && *v.GuardianNotice == "1" {
				if v.GuardianNoticedAt == nil || v.GuardianNoticeMethod == nil || v.GuardianNoticePerson == nil {
					t.Fatalf("一覧の「した」に日時・手段・相手がありません: %+v", v)
				}
				methods[*v.GuardianNoticeMethod] = true
			}
		}
		if !methods["1"] || !methods["3"] {
			t.Fatalf("一覧の手段 = %v, want 1（電話）と 3（連絡帳・個人チャット）", methods)
		}
	})

	// 【仮置き】発見より前に連絡することはないため、発見時刻より前を断る（web/仮置き値.md。PR #229 で頭役が決めた）
	t.Run("連絡した日時は、ちょうど発見時刻なら通し、1分前は断る", func(t *testing.T) {
		n := count()
		earlier := addDays(today(), -1) + "T23:59:00" // 発見時刻（今日の 00:00）の1分前
		got := expectStatus(t, request(t, h, takanashi, "POST", path, body(
			`"guardian_notice":"1","guardian_noticed_at":"`+earlier+`","guardian_notice_method":"1","guardian_notice_person":"母"`)), http.StatusBadRequest)
		if !strings.Contains(got, "発見時刻より前") {
			t.Fatalf("発見時刻より前を断る文言ではありません: %s", got)
		}
		if c := count(); c != n {
			t.Fatalf("断ったはずの記録が %d 件できています", c-n)
		}
		x := storedOf(call(t, h, takanashi, "POST", path, body(
			`"guardian_notice":"1","guardian_noticed_at":"`+found+`","guardian_notice_method":"1","guardian_notice_person":"母"`)).Body.Bytes())
		if x.at.String != found {
			t.Fatalf("ちょうど発見時刻の連絡 = %+v, want %s", x, found)
		}
	})
}

// 列を足す前に作られたデータベースへ、保護者への連絡の4列を足す。前の記録は未記入のまま残す
func TestEnsureNapAbnormalGuardianNotice(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "old.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE t_nap_abnormal (
		nap_abnormal_id INTEGER PRIMARY KEY AUTOINCREMENT,
		nap_session_id  INTEGER NOT NULL,
		child_id        TEXT    NOT NULL,
		found_at        TEXT    NOT NULL,
		situation       TEXT    NOT NULL,
		response        TEXT    NOT NULL,
		staff_id        TEXT    NOT NULL,
		diary_id        INTEGER
	);
	INSERT INTO t_nap_abnormal (nap_session_id, child_id, found_at, situation, response, staff_id)
	VALUES (1, 'C001', '2026-09-01T13:40:00', '顔色がやや紅潮', '別室で休ませた', 'S003')`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ { // 2回目は何も変えない
		if err := ensureNapAbnormalGuardianNotice(db); err != nil {
			t.Fatalf("%d 回目: %v", i+1, err)
		}
	}
	var notice, at, method, person sql.NullString
	if err := db.QueryRow(`SELECT guardian_notice, guardian_noticed_at, guardian_notice_method, guardian_notice_person
		FROM t_nap_abnormal`).Scan(&notice, &at, &method, &person); err != nil {
		t.Fatal(err)
	}
	if notice.Valid || at.Valid || method.Valid || person.Valid {
		t.Fatalf("前の記録に値が入っています: %v %v %v %v", notice, at, method, person)
	}
	if _, err := db.Exec(`UPDATE t_nap_abnormal SET guardian_notice_method = '4'`); err == nil {
		t.Fatal("手段の CHECK が効いていません")
	}
}
