package main

import (
	"reflect"
	"testing"
)

/*
他児の名前の照合（詳細設計書「他児の名前の照合」(4-5 (2))・「テストの観点」(9-1) の「他児の名前の注意」）。
nameCheckCases は web/tests/nameCheck.test.ts の同じ名前の表と同じ行にする（9-2）。
デモデータに頼らず、作り物の園児の一覧で確かめる（同じ名の子・1文字の姓を入れるため）。
*/
var nameCheckChildren = []nameChild{
	{ID: "A", Name: "西田 太郎", Kana: "にしだ たろう", Nickname: "たっくん"},
	{ID: "B", Name: "伊藤 葵", Kana: "いとう あおい", Nickname: "あおちゃん"},
	{ID: "C", Name: "小林 結衣", Kana: "こばやし ゆい", Nickname: "ゆいちゃん"},
	{ID: "D", Name: "井上 空", Kana: "いのうえ そら"},
	{ID: "E", Name: "前田 詩", Kana: "まえだ うた"},
	{ID: "F", Name: "林 悠真", Kana: "はやし ゆうま"},
	{ID: "G", Name: "山田 ゆい", Kana: "やまだ ゆい"},
	{ID: "H", Name: "西田 あい", Kana: "にしだ あい"},
}

var nameCheckCases = []struct {
	name      string
	recipient string // 空ならクラスあて（在籍園児の全員が相手）
	text      string
	names     []string
	matches   [][2]int
}{
	{"宛先の子の呼び名は当てない", "A", "たっくんは砂場で遊びました。", []string{}, [][2]int{}},
	{"ほかの子の呼び名に当たる", "A", "あおちゃんと砂場で遊びました。", []string{"伊藤 葵"}, [][2]int{{0, 5}}},
	{"よみのカタカナに当たる", "A", "アオイちゃんと遊びました。", []string{"伊藤 葵"}, [][2]int{{0, 3}}},
	{"氏名（空白なし）に当たる", "A", "伊藤葵さんと遊びました。", []string{"伊藤 葵"}, [][2]int{{0, 3}}},
	{"氏名（半角の空白）に当たる", "A", "伊藤 葵さんと遊びました。", []string{"伊藤 葵"}, [][2]int{{0, 4}}},
	{"よみ（全角の空白）に当たる", "A", "いとう　あおいさんと遊びました。", []string{"伊藤 葵"}, [][2]int{{0, 7}}},
	{"1文字の名はふだんの言葉に当てない", "A", "空が青い日でした。", []string{}, [][2]int{}},
	{"1文字の名に敬称が続けば当たる", "A", "空くんと遊びました。", []string{"井上 空"}, [][2]int{{0, 1}}},
	{"2文字以下の仮名はふだんの言葉に当てない", "A", "うたをうたいました。", []string{}, [][2]int{}},
	{"2文字以下の仮名に敬称が続けば当たる", "A", "うたちゃんと歌いました。", []string{"前田 詩"}, [][2]int{{0, 2}}},
	{"1文字の姓に敬称が続けば当たる（ほかの子の姓の中でも）", "A", "小林さんと林の中を歩きました。", []string{"小林 結衣", "林 悠真"}, [][2]int{{0, 2}}},
	{"宛先と同じ名の子を数えない（呼び名）", "C", "ゆいちゃんが笑っていました。", []string{}, [][2]int{}},
	{"宛先と同じ名の子を数えない（よみ）", "G", "ゆいちゃんが笑っていました。", []string{}, [][2]int{}},
	{"同じ名の子が2人いれば両方に当たる", "A", "ゆいちゃんと遊びました。", []string{"小林 結衣", "山田 ゆい"}, [][2]int{{0, 5}}},
	{"クラスあては在籍園児の全員が相手", "", "たっくんとあおちゃんが遊びました。", []string{"西田 太郎", "伊藤 葵"}, [][2]int{{0, 4}, {5, 10}}},
	{"名前が無ければ当たらない", "A", "園庭で砂場あそびをしました。", []string{}, [][2]int{}},
	{"同じ姓のきょうだいの氏名は、宛先の姓に重なっても当たる", "A", "西田あいに伝えました。", []string{"西田 あい"}, [][2]int{{0, 4}}},
	{"宛先の姓だけなら、同じ姓のきょうだいに当てない", "A", "西田さんに伝えました。", []string{}, [][2]int{}},
}

func TestNameCheckTable(t *testing.T) {
	for _, c := range nameCheckCases {
		var recipients []nameChild
		for _, ch := range nameCheckChildren {
			if ch.ID == c.recipient {
				recipients = append(recipients, ch)
			}
		}
		names, matches := findOtherNames(c.text, "body", recipients, nameCheckChildren)
		got := [][2]int{}
		for _, m := range matches {
			if m.Field != "body" {
				t.Errorf("%s: field = %q", c.name, m.Field)
			}
			got = append(got, [2]int{m.Start, m.End})
		}
		if !reflect.DeepEqual(names, c.names) || !reflect.DeepEqual(got, c.matches) {
			t.Errorf("%s: names=%v matches=%v, want %v %v", c.name, names, got, c.names, c.matches)
		}
	}
}

// 承諾が当たった名前をすべて含めば通し、新しい名前が入れば再び 409 にする（4-5 (2) の⑥）
func TestCheckOtherNamesAcknowledged(t *testing.T) {
	a, _ := newTestApp(t)
	e, err := a.checkOtherNames("あおちゃんと遊びました。", "body", []string{"C001"}, false, nil)
	if err != nil || e == nil || e.Kind != kindOtherChildNames || !reflect.DeepEqual(e.Names, []string{"伊藤 葵"}) {
		t.Fatalf("当たり: %+v %v", e, err)
	}
	if e.Message != "ほかのお子さんの名前（伊藤 葵）が入っています。このまま送りますか。" {
		t.Errorf("文言: %s", e.Message)
	}
	if e, _ := a.checkOtherNames("あおちゃんと遊びました。", "body", []string{"C001"}, false, []string{"伊藤 葵"}); e != nil {
		t.Errorf("承諾したのに止まる: %+v", e)
	}
	if e, _ := a.checkOtherNames("あおちゃんとゆいちゃんと遊びました。", "body", []string{"C001"}, false, []string{"伊藤 葵"}); e == nil ||
		!reflect.DeepEqual(e.Names, []string{"伊藤 葵", "小林 結衣"}) {
		t.Errorf("新しい名前: %+v", e)
	}
}
