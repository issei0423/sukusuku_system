package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

/*
 * 同じ氏名・同じ生年月日の園児を重ねて登録しようとしたときの知らせ（GitHub Issue #144 の 2）
 *
 * 園児IDは使われている番号の次が自動で入るため、同じ子を二重に登録するまちがいは ID の重複では防げない。
 * 登録の確認画面と CSV 一括登録の取込内容で知らせる。止めはしない（同じ氏名・生年月日の別の子もありうる）。
 * 【仮置き】設計に定めが無い（web/仮置き値.md「同じ氏名・生年月日の園児の知らせ」）。
 *
 * 画面側のモック（web/src/api/mock.ts の findSameNameBirthChildren）と同じ規則であることを、
 * web/tests/childSameNameBirth.test.tsx と同じ観点で確かめる。
 */

func sameNameBirthAPI(t *testing.T, h http.Handler, c *http.Cookie, name, birth string) []Child {
	t.Helper()
	rec := call(t, h, c, "GET", "/api/children/same-name-birth?child_name="+url.QueryEscape(name)+
		"&birth_date="+url.QueryEscape(birth), "")
	var out []Child
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("応答を読めない: %v (body: %s)", err, rec.Body.String())
	}
	return out
}

func childIDs(rows []Child) []string {
	ids := []string{}
	for _, c := range rows {
		ids = append(ids, c.ChildID)
	}
	return ids
}

func TestSameNameBirthChildren(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")

	// デモの生年月日は起動日へずらしてあるため、いまの値を引く
	var birth string
	if err := a.db.QueryRow(`SELECT birth_date FROM m_child WHERE child_id = 'C001'`).Scan(&birth); err != nil {
		t.Fatal(err)
	}

	t.Run("同じ氏名・生年月日の園児を返す。氏名の空白の違いは問わない", func(t *testing.T) {
		for _, name := range []string{"西田 太郎", "西田　太郎", "西田太郎", " 西田 太郎 "} {
			if got := childIDs(sameNameBirthAPI(t, h, admin, name, birth)); strings.Join(got, ",") != "C001" {
				t.Errorf("氏名 %q: %v, want [C001]", name, got)
			}
		}
	})

	t.Run("氏名か生年月日が違えば返さない", func(t *testing.T) {
		if got := sameNameBirthAPI(t, h, admin, "西田 次郎", birth); len(got) != 0 {
			t.Errorf("氏名が違うのに返した: %v", childIDs(got))
		}
		if got := sameNameBirthAPI(t, h, admin, "西田 太郎", "2020-01-01"); len(got) != 0 {
			t.Errorf("生年月日が違うのに返した: %v", childIDs(got))
		}
	})

	t.Run("取り消した園児（誤登録）は比べない", func(t *testing.T) {
		if _, err := a.db.Exec(`INSERT INTO m_child
			(child_id, child_name, child_name_kana, birth_date, sex, enrollment_status, photo_consent_level,
			 is_deleted, created_at, updated_at)
			VALUES ('C960', '取消 一', 'とりけし いち', '2025-05-05', '1', '1', '2', 1, ?, ?)`, now(), now()); err != nil {
			t.Fatal(err)
		}
		if got := sameNameBirthAPI(t, h, admin, "取消 一", "2025-05-05"); len(got) != 0 {
			t.Errorf("取り消した園児を返した: %v", childIDs(got))
		}
	})

	t.Run("退園・卒園した園児は比べる", func(t *testing.T) {
		if _, err := a.db.Exec(`INSERT INTO m_child
			(child_id, child_name, child_name_kana, birth_date, sex, enrollment_status, photo_consent_level,
			 is_deleted, created_at, updated_at)
			VALUES ('C961', '退園 一', 'たいえん いち', '2024-06-06', '2', '2', '2', 0, ?, ?)`, now(), now()); err != nil {
			t.Fatal(err)
		}
		if got := childIDs(sameNameBirthAPI(t, h, admin, "退園一", "2024-06-06")); strings.Join(got, ",") != "C961" {
			t.Errorf("退園した園児: %v, want [C961]", got)
		}
	})

	t.Run("管理者のみ。園児の登録は管理者の操作である", func(t *testing.T) {
		expectStatus(t, request(t, h, teacher, "GET",
			"/api/children/same-name-birth?child_name="+url.QueryEscape("西田 太郎")+"&birth_date="+birth, ""),
			http.StatusForbidden)
	})
}

func TestChildCsvWarnsSameNameBirth(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	var birth string
	if err := a.db.QueryRow(`SELECT birth_date FROM m_child WHERE child_id = 'C001'`).Scan(&birth); err != nil {
		t.Fatal(err)
	}

	t.Run("登録済みの園児と同じ氏名・生年月日の行は、誤りにせず確認を促す", func(t *testing.T) {
		_, got := parseCsvAPI(t, h, admin, csvHead+"C501,西田　太郎,にしだ たろう,"+birth+",1,さくら組,36.5")
		if len(got.Rows) != 1 || got.Rows[0].Error != nil {
			t.Fatalf("誤りになった: %+v", got.Rows)
		}
		if w := got.Rows[0].Warning; w == nil || !strings.Contains(*w, "同じ氏名・生年月日の園児がいます") ||
			!strings.Contains(*w, "C001") {
			t.Errorf("確認の表示 = %v", strOrNil(w))
		}
	})

	t.Run("同じファイルの中で同じ氏名・生年月日の行が重なれば、後の行で確認を促す", func(t *testing.T) {
		_, got := parseCsvAPI(t, h, admin, csvHead+
			"C501,重複 一,ちょうふく いち,2025-04-01,1,さくら組,36.5\n"+
			"C502,重複 一,ちょうふく いち,2025-04-01,1,さくら組,36.5\n"+
			"C503,重複 二,ちょうふく に,2025-04-01,1,さくら組,36.5")
		if len(got.Rows) != 3 {
			t.Fatalf("行数 = %d", len(got.Rows))
		}
		if got.Rows[0].Warning != nil || got.Rows[2].Warning != nil {
			t.Errorf("重ならない行に確認の表示が出た: %v / %v", strOrNil(got.Rows[0].Warning), strOrNil(got.Rows[2].Warning))
		}
		if w := got.Rows[1].Warning; got.Rows[1].Error != nil || w == nil ||
			!strings.Contains(*w, "このファイル内") || !strings.Contains(*w, "1 行目") {
			t.Errorf("2 行目の確認の表示 = %v (誤り %v)", strOrNil(w), strOrNil(got.Rows[1].Error))
		}
	})

	t.Run("範囲の外の平熱と重なっても、両方を示す", func(t *testing.T) {
		_, got := parseCsvAPI(t, h, admin, csvHead+"C501,西田 太郎,にしだ たろう,"+birth+",1,さくら組,45.0")
		if w := got.Rows[0].Warning; w == nil || !strings.Contains(*w, "平熱") || !strings.Contains(*w, "C001") {
			t.Errorf("確認の表示 = %v", strOrNil(w))
		}
	})

	t.Run("確認を促すだけで、取り込みは止めない", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"text": csvHead + "C501,西田 太郎,にしだ たろう," + birth + ",1,さくら組,36.5"})
		expectStatus(t, request(t, h, admin, "POST", "/api/children/csv/import", string(body)), http.StatusOK)
		if !a.childExists("C501") {
			t.Fatal("取り込まれていない")
		}
	})
}

// strOrNil は、落ちたときに中身を読めるよう *string を文字列にする
func strOrNil(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}
