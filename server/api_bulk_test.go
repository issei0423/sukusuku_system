package main

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*
 * 園児の CSV 一括登録（GitHub Issue #160）
 * 典拠：基本設計書.md「CSV一括登録」(4-4)「平熱が数値でない行は誤りとする。範囲の外の平熱は誤りとせず、
 *      確認を促す表示を添える」、「入力項目の制約値」(4-9)「平熱｜30.0〜43.0℃、小数第1位まで」
 *      「園児ID・職員ID｜20文字以内」、「園児情報の登録・編集」(4-4)「入力値を検証する（必須・形式・未来日でないこと）」
 *
 * 画面側のモック（web/src/api/mock.ts の parseChildCsv）と同じ規則であることを、
 * web/tests/childCsv.test.ts と同じ観点で確かめる。
 */

const csvHead = "園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱\n"

type parsedCsv struct {
	Header []string `json:"header"`
	Rows   []CsvRow `json:"rows"`
}

func parseCsvAPI(t *testing.T, h http.Handler, c *http.Cookie, text string) (*httptest.ResponseRecorder, parsedCsv) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"text": text})
	rec := request(t, h, c, "POST", "/api/children/csv/parse", string(body))
	var out parsedCsv
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("応答を読めない: %v (body: %s)", err, rec.Body.String())
		}
	}
	return rec, out
}

func TestChildCsvTemperatureMustBeFiniteDecimal(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	t.Run("数として書かれていない平熱は誤りにする", func(t *testing.T) {
		for _, v := range []string{"inf", "Inf", "+Inf", "infinity", "-inf", "NaN", "nan", "0x24", "1e2", "-36.5", "+36.5", "３６．５", "36.55"} {
			_, got := parseCsvAPI(t, h, admin, csvHead+"C501,平熱 一,へいねつ いち,2025-04-01,1,さくら組,"+v)
			if len(got.Rows) != 1 || got.Rows[0].Error == nil || !strings.Contains(*got.Rows[0].Error, "平熱") {
				t.Errorf("平熱 %q が誤りにならない: %+v", v, got.Rows)
			}
		}
	})

	t.Run("小数第1位までの数は通す。範囲の外は誤りにせず、確認を促す", func(t *testing.T) {
		for v, warn := range map[string]bool{"36.5": false, "36": false, "37.0": false, "45.0": true, "29.9": true, "365": true} {
			_, got := parseCsvAPI(t, h, admin, csvHead+"C501,平熱 一,へいねつ いち,2025-04-01,1,さくら組,"+v)
			if len(got.Rows) != 1 || got.Rows[0].Error != nil {
				t.Errorf("平熱 %q が誤りになった: %+v", v, got.Rows)
				continue
			}
			if (got.Rows[0].Warning != nil) != warn {
				t.Errorf("平熱 %q の確認の表示 = %v, want %v", v, got.Rows[0].Warning, warn)
			}
		}
	})

	t.Run("inf の行は取り込まない", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"text": csvHead + "C501,平熱 一,へいねつ いち,2025-04-01,1,さくら組,inf"})
		expectStatus(t, request(t, h, admin, "POST", "/api/children/csv/import", string(body)), http.StatusBadRequest)
		if a.childExists("C501") {
			t.Fatal("inf の行が登録された")
		}
	})
}

// すでに inf が入ったデータベースでも、一覧が空の本文（画面は真っ白）にならない
func TestInfiniteTemperatureAlreadyStoredDoesNotBlankLists(t *testing.T) {
	a, h := newTestApp(t)
	// 直す前の CSV 一括登録で入った値を再現する（SQLite は 9e999 を +Inf として持つ）
	if _, err := a.db.Exec(`UPDATE m_child SET normal_temperature = 9e999 WHERE child_id = 'C001'`); err != nil {
		t.Fatal(err)
	}
	teacher := loginAs(a, 3, "staff")
	for _, path := range []string{"/api/children", "/api/reference", "/api/children/C001"} {
		rec := call(t, h, teacher, "GET", path, "")
		if !json.Valid(rec.Body.Bytes()) || rec.Body.Len() == 0 {
			t.Fatalf("%s の本文が JSON になっていない: %q", path, rec.Body.String())
		}
	}
	var c Child
	if err := json.Unmarshal(call(t, h, teacher, "GET", "/api/children/C001", "").Body.Bytes(), &c); err != nil {
		t.Fatal(err)
	}
	if c.NormalTemperature != nil {
		t.Fatalf("数でない平熱が返った: %v", *c.NormalTemperature)
	}
}

// JSON にできない値を返そうとしたとき、200 の空の本文ではなく、失敗として返す
func TestWriteJSONFailsLoudly(t *testing.T) {
	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusOK, map[string]float64{"v": math.Inf(1)})
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var e apiError
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e.Message == "" {
		t.Fatalf("失敗の文言が返っていない: %q", rec.Body.String())
	}
}

func TestChildCsvRejectsImpossibleDatesLongIDsAndShuffledHeader(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	t.Run("存在しない生年月日は誤りにする", func(t *testing.T) {
		for _, d := range []string{"2025-02-30", "2025-13-45", "2025-00-10", "2024-02-30"} {
			_, got := parseCsvAPI(t, h, admin, csvHead+"C201,日付 一,ひづけ いち,"+d+",1,さくら組,36.5")
			if len(got.Rows) != 1 || got.Rows[0].Error == nil || !strings.Contains(*got.Rows[0].Error, "生年月日") {
				t.Errorf("生年月日 %q が誤りにならない: %+v", d, got.Rows)
			}
		}
		// うるう年の 2 月 29 日は実在する
		_, got := parseCsvAPI(t, h, admin, csvHead+"C201,日付 一,ひづけ いち,2024-02-29,1,さくら組,36.5")
		if len(got.Rows) != 1 || got.Rows[0].Error != nil {
			t.Errorf("2024-02-29 が誤りになった: %+v", got.Rows)
		}
	})

	t.Run("園児ID は 20 文字まで", func(t *testing.T) {
		_, got := parseCsvAPI(t, h, admin, csvHead+strings.Repeat("C", 21)+",長い 一,ながい いち,2025-04-01,1,さくら組,36.5")
		if len(got.Rows) != 1 || got.Rows[0].Error == nil || !strings.Contains(*got.Rows[0].Error, "20文字") {
			t.Errorf("21 文字の園児ID が誤りにならない: %+v", got.Rows)
		}
		_, got = parseCsvAPI(t, h, admin, csvHead+strings.Repeat("C", 20)+",長い 一,ながい いち,2025-04-01,1,さくら組,36.5")
		if len(got.Rows) != 1 || got.Rows[0].Error != nil {
			t.Errorf("20 文字の園児ID が誤りになった: %+v", got.Rows)
		}
	})

	t.Run("見出しの並びが違うファイルは、行を読まずに断る", func(t *testing.T) {
		text := "氏名,園児ID,氏名かな,生年月日,性別,クラス名,平熱\n並び 一,C711,ならび いち,2025-04-01,1,さくら組,36.5"
		rec, _ := parseCsvAPI(t, h, admin, text)
		expectStatus(t, rec, http.StatusBadRequest)
		if !strings.Contains(rec.Body.String(), "見出し") {
			t.Fatalf("見出しの誤りと分かる文言になっていない: %s", rec.Body.String())
		}
		body, _ := json.Marshal(map[string]string{"text": text})
		expectStatus(t, request(t, h, admin, "POST", "/api/children/csv/import", string(body)), http.StatusBadRequest)
		if a.childExists("並び 一") || a.childExists("C711") {
			t.Fatal("並びの違うファイルが取り込まれた")
		}
	})

	t.Run("BOM 付き・平熱の列の無い見出しは、そのまま見出しとして読む", func(t *testing.T) {
		rec, got := parseCsvAPI(t, h, admin, string(rune(0xFEFF))+"園児ID,氏名,氏名かな,生年月日,性別,クラス名\nC301,見出 一,みだし いち,2025-04-01,1,さくら組")
		expectStatus(t, rec, http.StatusOK)
		if len(got.Rows) != 1 || got.Rows[0].Error != nil {
			t.Fatalf("got %+v", got.Rows)
		}
	})
}
