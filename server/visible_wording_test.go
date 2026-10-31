package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

/*
 * サーバが返して画面に出る文言にも、設計書の名前や章番号を出さない（GitHub Issue #144 の 1）
 *
 * 画面の文言は web/tests/visibleWording.test.ts が見張っているが、サーバが返すエラーの文や、DB に入れる値は
 * その外にある。「（第3.0版より前の記録）」が、日誌の作り直しでヒヤリハットの「場所」に入り、画面の「場所」欄に
 * 出ていた（db_diary.go の rebuildDiarySteps。いまは「（以前の形式の記録）」）。
 *
 * server/ の _test.go 以外の .go を go/parser で読み、文字列リテラル（"…"・`…`）だけを調べる。コメントは
 * 構文木に入れないので、典拠を書いたコメントは引っかからない。DB へ流すだけの SQL の中のコメント（「--」から後ろ）は、
 * 名指しした定数に限って外す（sqlCommentsNotShown）。
 *
 * 規則は web/tests/visibleWording.test.ts の FORBIDDEN・CHAPTER_REF と同じ。片方を変えたら、もう片方も同じに直す。
 * 拾う例・拾わない例の表も、両方に同じものを置いている（TestVisibleWordingRules）。
 * JavaScript の正規表現を RE2（Go の regexp）で書き直したところ：
 *   - \s：JavaScript の \s は全角の空白（U+3000）なども含むが、RE2 の \s は ASCII の空白だけ。jsSpace で同じ範囲にした
 *   - 「同 5-5」の (?!\d)：RE2 に先読みは無い。「数字でない 1 文字か、文字列の終わり」を続けて書いた。
 *     当たるかどうかだけを見るので、結果は同じになる
 */

// 画面に出てはいけない語。web/tests/visibleWording.test.ts の FORBIDDEN と同じ
var forbiddenWording = regexp.MustCompile(`設計書|要件定義書|画面詳細図|画面遷移図|要決定事項|決定事項\.md|GitHub Issue`)

const (
	// JavaScript の \s と同じ空白（WhiteSpace と LineTerminator：TAB・VT・FF・ZWNBSP・Zs の空白、LF・CR・LS・PS）
	jsSpace = `[\t\n\v\f\r\x{feff}\x{2028}\x{2029}\p{Zs}]`
	// 設計書の章番号 1 つ。「5-7」「4-1-2」「4-13 (6)」。ハイフンは全角・ダッシュも同じに扱う
	refHyphen = `[-‐－–]`
	oneRef    = `\d` + refHyphen + `\d{1,2}(?:` + refHyphen + `\d{1,2})*(?:` + jsSpace + `*[（(]\d{1,2}[）)])?`
)

// 設計書を章番号だけで指す形。web/tests/visibleWording.test.ts の CHAPTER_REF と同じ
var chapterRef = regexp.MustCompile(strings.Join([]string{
	// 括弧の中が章番号だけ：「（5-7）」「（同 5-5）」「（3-6・4-13）」
	`[（(]` + jsSpace + `*(?:同` + jsSpace + `*)?` + oneRef +
		`(?:` + jsSpace + `*[・、,，]` + jsSpace + `*` + oneRef + `)*` + jsSpace + `*[）)]`,
	// 括弧の外の「同 5-5」。TS 側の (?!\d) の代わりに (?:\D|$)
	`同` + jsSpace + `*\d` + refHyphen + `\d{1,2}(?:\D|$)`,
	// 設計書の版：「第3.7版」「第2.x版」
	`第\d+\.(?:\d+|x)版`,
}, "|"))

/*
sqlCommentsNotShown は、SQL のコメント（行の「--」から後ろ）を見張りから外す定数。ファイルと定数の名前で名指しする。
外すのは SQL のコメントだけで、同じ文字列の SQL の本体（表の定義・CHECK の値など）は見張る。足すときは、なぜ画面に
出ないかを添える。

  - contact_ddl.go の contactDDL：起動のときに ensureContactSchema（db_contact.go）が db.Exec で DB へ流すだけで、
    応答にも画面にも出ない。schema.sql の「5-4 連絡帳」以降の節と同じ定義を写していて、典拠を SQL のコメントに
    書いている（schema.sql とそろえるため、こちらのコメントだけを消せない）
*/
var sqlCommentsNotShown = []struct{ file, name string }{
	{"contact_ddl.go", "contactDDL"},
}

// SQL の行のコメント。SQL の文字列（'a--b'）の中の「--」も、そこから後ろを外してしまう。いまの contactDDL の値に
// 「--」は無い。名指しした定数の値に「--」を入れるときは、ここを直す
var sqlLineComment = regexp.MustCompile(`--[^\n]*`)

type literalText struct {
	line int
	name string // 定数・変数の値そのものなら、その名前
	text string
}

// Go のソースの文字列リテラルを、行番号つきで返す。コメントは含まない
func stringLiteralsIn(t *testing.T, fileName string, src []byte) []literalText {
	t.Helper()
	fset := token.NewFileSet()
	// parser.ParseComments を付けないので、コメントは構文木に入らない
	file, err := parser.ParseFile(fset, fileName, src, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("%s を読めない: %v", fileName, err)
	}
	names := map[*ast.BasicLit]string{}
	var out []literalText
	// 構文木は親から先に回るので、ValueSpec で名前を控えてから、その値の文字列に来る
	ast.Inspect(file, func(n ast.Node) bool {
		if spec, ok := n.(*ast.ValueSpec); ok {
			for i, v := range spec.Values {
				if lit, ok := v.(*ast.BasicLit); ok && i < len(spec.Names) {
					names[lit] = spec.Names[i].Name
				}
			}
		}
		lit, ok := n.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return true
		}
		text, err := strconv.Unquote(lit.Value)
		if err != nil {
			t.Fatalf("%s:%d の文字列を戻せない: %v", fileName, fset.Position(lit.Pos()).Line, err)
		}
		out = append(out, literalText{line: fset.Position(lit.Pos()).Line, name: names[lit], text: text})
		return true
	})
	return out
}

// 見張る文。sqlCommentsNotShown で名指しした定数だけ、SQL のコメントを除く
func wordingTextOf(file string, lit literalText) string {
	for _, ex := range sqlCommentsNotShown {
		if ex.file == file && ex.name == lit.name {
			return sqlLineComment.ReplaceAllString(lit.text, "")
		}
	}
	return lit.text
}

// server/ の文字列リテラルのうち、pattern に当たるものを「ファイル:行 当たった所」で返す
func wordingHitsInServer(t *testing.T, pattern *regexp.Regexp) []string {
	t.Helper()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	var hits []string
	read := 0
	named := map[string]bool{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		read++
		for _, lit := range stringLiteralsIn(t, f, src) {
			if lit.name != "" {
				named[f+" "+lit.name] = true
			}
			if m := pattern.FindString(wordingTextOf(f, lit)); m != "" {
				hits = append(hits, fmt.Sprintf("%s:%d 「%s」", f, lit.line, strings.TrimSpace(m)))
			}
		}
	}
	// 読む場所を誤って 0 件で通ってしまわないように
	if read <= 50 {
		t.Fatalf("読んだ .go が %d 件しかない。server/ で回していないかもしれない", read)
	}
	// 名指しした定数が名前を変えたり消えたりしたら、外す指定も直す
	for _, ex := range sqlCommentsNotShown {
		if !named[ex.file+" "+ex.name] {
			t.Errorf("SQL のコメントを外す定数 %s が %s に無い。sqlCommentsNotShown を直す", ex.name, ex.file)
		}
	}
	return hits
}

// 名指しした定数でも、外すのは SQL のコメントだけで、SQL の本体は見張る
func TestVisibleWordingSQLCommentsExemptOnlyByName(t *testing.T) {
	sql := "-- ============ 5-4 連絡帳（基本設計書「連絡帳」(5-4)） ============\n" +
		"CREATE TABLE IF NOT EXISTS t_x (\n" +
		"  place TEXT DEFAULT '（同 5-5）'   -- 詳細設計書「家庭から」(3-1)\n" +
		");"
	for _, tc := range []struct {
		file, name     string
		names, chapter bool
	}{
		{"contact_ddl.go", "contactDDL", false, true}, // コメントだけ外れ、本体の「（同 5-5）」は拾う
		{"contact_ddl.go", "otherDDL", true, true},    // 名指ししていない定数は、コメントも見張る
		{"db_diary.go", "contactDDL", true, true},     // ほかのファイルの同じ名前も見張る
		{"contact_ddl.go", "", true, true},            // 定数の値でない文字列も見張る
	} {
		text := wordingTextOf(tc.file, literalText{name: tc.name, text: sql})
		if got := forbiddenWording.MatchString(text); got != tc.names {
			t.Errorf("%s %s: 設計書の名前を拾う = %v, want %v", tc.file, tc.name, got, tc.names)
		}
		if got := chapterRef.MatchString(text); got != tc.chapter {
			t.Errorf("%s %s: 章番号を拾う = %v, want %v", tc.file, tc.name, got, tc.chapter)
		}
	}
}

func TestVisibleWordingCollectsStringsNotComments(t *testing.T) {
	src := strings.Join([]string{
		"// 基本設計書「画面遷移」(3-4)",
		"package sample",
		"",
		"/* 要件定義書 */",
		`const a = "要件定義書"`,
		"var b = `画面詳細図 基本設計書 5-7`",
		`var c = '設'`,
		"func f() string {",
		"	// 基本設計書 5-5",
		`	return "実施中は自動ログアウトの対象外です（基本設計書 5-7）。" // 画面遷移図`,
		"}",
		"type T struct {",
		"	X string `json:\"x\"` // 要決定事項",
		"}",
	}, "\n")
	var lines []int
	for _, lit := range stringLiteralsIn(t, "sample.go", []byte(src)) {
		if forbiddenWording.MatchString(lit.text) {
			lines = append(lines, lit.line)
		}
	}
	if want := []int{5, 6, 10}; !reflect.DeepEqual(lines, want) {
		t.Errorf("拾った行 = %v, want %v", lines, want)
	}
}

// web/tests/visibleWording.test.ts の「調べ方：章番号だけの参照は拾い、画面に出てよい数字は拾わない」と同じ表。
// 片方に足したら、もう片方にも足す
func TestVisibleWordingRules(t *testing.T) {
	refs := []string{
		"ただし保護者側からは参照できなくなります（同 5-5）。",
		"実施中は自動ログアウトの対象外です（5-7）。",
		"（同5-5）",
		"( 5-7 )",
		"（3-6・4-13）",
		"（3-6、4-13）",
		"（4-13 (6)）",
		"(4-1-2)",
		"（5－7）",
		"同 5-5 のとおり",
		"第3.7版の定めによる",
		"第2.x版",
		"（同\u30005-5）", // 全角の空白
		"同\u30005-5",
	}
	allowed := []string{
		"10-31",
		"2026-10-31",
		"（10-31）",
		"月-日（例 04-01）",
		"（04-01）",
		"13:00-15:00",
		"開始-終了（例 21:00-07:00）",
		"03-1234-5678",
		"（03-1234-5678）",
		"（090-1234-5678）",
		"1-5 件",
		"（1-5 件）",
		"1〜2歳児",
		"（0-2歳児）",
		"0-2歳",
		"（2-4列目）",
		"C101,青木 陽菜,あおき ひな,2025-04-10,2,さくら組,36.6",
		"1〜12 の数をカンマで区切る（例 4,8,12）",
		"体温は小数第1位まで（例：34.9）で入力してください",
		"第1条（本規約について）",
		"現在の版：1.1",
		"(1) 招待コードの入力",
		"（2回目）",
		"（同上）",
		"同じ日の中",
		"乳幼児健診の節目（1歳6か月・3歳・5歳）",
		"同 5-123",
		"（以前の形式の記録）",
	}
	for _, s := range refs {
		if !chapterRef.MatchString(s) {
			t.Errorf("章番号の参照を拾わない: %q", s)
		}
	}
	for _, s := range allowed {
		if chapterRef.MatchString(s) {
			t.Errorf("画面に出てよい文を拾った: %q（当たった所 %q）", s, chapterRef.FindString(s))
		}
	}
}

func TestServerStringsHaveNoDesignDocNames(t *testing.T) {
	if hits := wordingHitsInServer(t, forbiddenWording); len(hits) > 0 {
		t.Errorf("サーバの文字列に設計書の名前がある（典拠はコメントへ）:\n%s", strings.Join(hits, "\n"))
	}
}

func TestServerStringsHaveNoChapterRefs(t *testing.T) {
	if hits := wordingHitsInServer(t, chapterRef); len(hits) > 0 {
		t.Errorf("サーバの文字列に、設計書を章番号だけで指す参照がある（典拠はコメントへ）:\n%s", strings.Join(hits, "\n"))
	}
}
