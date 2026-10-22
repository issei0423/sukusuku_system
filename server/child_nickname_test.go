package main

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

/*
呼び名（m_child.nickname）は、園児情報入力の呼び名の欄（#198。詳細設計書「園児の登録と個人チャット」(4-9)）と、
他児の名前の注意（#201。同「他児の名前の照合」(4-5 (2))）の両方が使う。2つの PR を合わせた状態で、
1つの列を共に使えていること、保護者の応答に呼び名が出ないこと（インタフェース一覧「Child」）を確かめる。
モックの同じ観点は web/tests/childNickname.test.ts
*/

// 園児情報入力で入れた呼び名が、他児の名前の注意に当たる。呼び名が空（NULL）だった園児を直しても、操作ログは呼び名だけを残す
func TestNicknameFromChildInputReachesNameCheck(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")

	// 上園 花子（C002・さくら組）はデモで呼び名が無い（列は NULL）
	var in childInput
	var temp float64
	if err := a.db.QueryRow(`SELECT child_id, child_name, child_name_kana, birth_date, sex, normal_temperature, photo_consent_level
		FROM m_child WHERE child_id = 'C002' AND nickname IS NULL`).
		Scan(&in.ChildID, &in.ChildName, &in.ChildNameKana, &in.BirthDate, &in.Sex, &temp, &in.PhotoConsentLevel); err != nil {
		t.Fatalf("呼び名が NULL の C002 が無い: %v", err)
	}
	in.NormalTemperature, in.ClassID, in.Mode, in.Nickname = &temp, 1, "edit", "はなちゃん"
	body, _ := json.Marshal(in)
	expectStatus(t, call(t, h, admin, "POST", "/api/children", string(body)), http.StatusOK)

	var res struct {
		Names []string `json:"names"`
	}
	decode(t, call(t, h, teacher, "POST", "/api/contact/name-check", `{"child_ids":["C001"],"text":"はなちゃんと砂場で遊びました"}`), &res)
	if len(res.Names) != 1 || res.Names[0] != "上園 花子" {
		t.Errorf("園児情報入力で入れた呼び名が照合に当たらない: %+v", res)
	}

	var before, after string
	if err := a.db.QueryRow(`SELECT IFNULL(before_value, ''), IFNULL(after_value, '') FROM t_operation_log
		WHERE target_table = 'm_child' AND target_child_id = 'C002' ORDER BY operation_log_id DESC LIMIT 1`).Scan(&before, &after); err != nil {
		t.Fatal(err)
	}
	// 呼び名が NULL の行を読み損ねると、Scan はそこで止まり、生年月日・性別・平熱なども空のまま「変わった」と残る
	var b, af map[string]any
	if json.Unmarshal([]byte(before), &b) != nil || json.Unmarshal([]byte(after), &af) != nil ||
		len(b) != 1 || len(af) != 1 || af["呼び名"] != "はなちゃん" {
		t.Errorf("操作ログに呼び名のほかの項目まで残った: before=%s after=%s", before, after)
	}

	var c struct {
		Nickname string `json:"nickname"`
	}
	decode(t, call(t, h, admin, "GET", "/api/children/C002", ""), &c)
	if c.Nickname != "はなちゃん" {
		t.Errorf("職員の応答の呼び名: %q", c.Nickname)
	}
}

// 保護者の応答（保護者ホーム・園児の一覧）には呼び名を入れない。職員の応答には入る
func TestGuardianResponsesOmitNickname(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")
	admin := loginAs(a, accAdmin, "staff")
	for _, path := range []string{"/api/dashboard/guardian", "/api/children"} {
		r := call(t, h, guardian, "GET", path, "")
		expectStatus(t, r, http.StatusOK)
		if s := r.Body.String(); strings.Contains(s, "nickname") || strings.Contains(s, "たっくん") {
			t.Errorf("%s の保護者の応答に呼び名が入った: %s", path, s)
		}
	}
	if s := call(t, h, admin, "GET", "/api/children", "").Body.String(); !strings.Contains(s, `"nickname":"たっくん"`) {
		t.Errorf("職員の園児の一覧に呼び名が無い")
	}
}

// 起動を2回くり返しても、呼び名の列は1本のまま（移しが ALTER を重ねない）。定義は詳細設計書「変える表」(5-3) の TEXT・空のまま
func TestNicknameColumnOnRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "restart.db")
	for i := 0; i < 2; i++ {
		db, err := openDB(path)
		if err != nil {
			t.Fatalf("%d 回目の起動: %v", i+1, err)
		}
		var n, notNull int
		var typ string
		if err := db.QueryRow(`SELECT COUNT(*), MAX("type"), MAX("notnull") FROM pragma_table_info('m_child') WHERE name = 'nickname'`).
			Scan(&n, &typ, &notNull); err != nil {
			t.Fatal(err)
		}
		db.Close()
		if n != 1 || typ != "TEXT" || notNull != 0 {
			t.Fatalf("%d 回目の起動のあとの呼び名の列: 本数 %d・型 %s・NOT NULL %d", i+1, n, typ, notNull)
		}
	}
}
