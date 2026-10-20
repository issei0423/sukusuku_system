package main

import (
	"reflect"
	"testing"
)

/*
他児の名前の照合を、届く家庭ごとに行うことと、照合の前に除く語（詳細設計書「他児の名前の照合」(4-5 (2)) の③の2・④、
「写真」(4-4 (2))、「テストの観点」(9-1) の「他児の名前の照合（家庭ごと・除くもの）」）。
nameFamilyCases は web/tests/nameCheck.test.ts の同じ名前の表と同じ行にする（9-2）。
*/

// nameFamilyChildren は、nameCheckChildren に、クラス名・職員の姓と重なる園児を足したもの
var nameFamilyChildren = append(append([]nameChild{}, nameCheckChildren...),
	nameChild{ID: "I", Name: "松本 咲良", Kana: "まつもと さくら"},
	nameChild{ID: "J", Name: "高梨 健", Kana: "たかなし けん"},
)

var nameFamilyCases = []struct {
	name     string
	families [][]string // 家庭ごとの宛先の園児
	excluded []string
	text     string
	names    []string
	matches  [][2]int
}{
	{"写っているもう1人の呼び名は、その子でない家庭への送信で当たる", [][]string{{"A"}, {"B"}}, nil, "たっくんが初めてひとりで立ちました。", []string{"野原 太郎"}, [][2]int{{0, 4}}},
	{"写っている2人の名前が両方あれば両方に当たる", [][]string{{"A"}, {"B"}}, nil, "たっくんとあおちゃんが遊びました。", []string{"野原 太郎", "伊藤 葵"}, [][2]int{{0, 4}, {5, 10}}},
	{"写っていない子の名前は、家庭ごとの当たりを1つの位置にまとめる", [][]string{{"A"}, {"B"}}, nil, "ゆいちゃんと遊びました。", []string{"小林 結衣", "山田 ゆい"}, [][2]int{{0, 5}}},
	{"家庭が1つなら今までと同じ", [][]string{{"A"}}, nil, "たっくんは砂場で遊びました。", []string{}, [][2]int{}},
	{"クラス名の中の名前は当てない", [][]string{{"A"}}, []string{"さくら組"}, "さくら組のみなさんと遊びました。", []string{}, [][2]int{}},
	{"クラス名の外の同じ名前は当てる", [][]string{{"A"}}, []string{"さくら組"}, "さくら組のさくらちゃん", []string{"松本 咲良"}, [][2]int{{5, 8}}},
	{"「姓＋先生」の中の名前は当てない", [][]string{{"A"}}, staffTitleWords("高梨 倫太朗"), "高梨先生と散歩しました。", []string{}, [][2]int{}},
	{"「せんせい」も除く", [][]string{{"A"}}, staffTitleWords("高梨 倫太朗"), "高梨せんせいと散歩しました。", []string{}, [][2]int{}},
	{"「姓＋先生」の外の園児の氏名は当てる", [][]string{{"A"}}, staffTitleWords("高梨 倫太朗"), "高梨健くんと高梨先生", []string{"高梨 健"}, [][2]int{{0, 3}}},
}

func TestNameCheckFamilies(t *testing.T) {
	byID := map[string]nameChild{}
	for _, c := range nameFamilyChildren {
		byID[c.ID] = c
	}
	for _, c := range nameFamilyCases {
		families := [][]nameChild{}
		for _, f := range c.families {
			fam := []nameChild{}
			for _, id := range f {
				fam = append(fam, byID[id])
			}
			families = append(families, fam)
		}
		names, matches := findOtherNamesFor(c.text, "body", families, nameFamilyChildren, c.excluded)
		got := [][2]int{}
		for _, m := range matches {
			got = append(got, [2]int{m.Start, m.End})
		}
		if !reflect.DeepEqual(names, c.names) || !reflect.DeepEqual(got, c.matches) {
			t.Errorf("%s: names=%v matches=%v, want %v %v", c.name, names, got, c.names, c.matches)
		}
	}
}

// デモデータで：「さくら組」と園児「松本 咲良（さくら）」、「高梨先生」と園児「高梨 健」が当たらない。
// 2人が写った写真（C001・C006）の添え文は家庭ごとに照合し、注意に届く家庭の数を添える
func TestCheckOtherNamesFamiliesAndExclusions(t *testing.T) {
	a, h := newTestApp(t)
	if e, err := a.checkOtherNames("さくら組のみなさんと高梨先生と散歩しました。", "body", []string{"C001"}, false, nil); err != nil || e != nil {
		t.Errorf("クラス名と「〇〇先生」で注意が出る: %+v %v", e, err)
	}
	if e, _ := a.checkOtherNames("高梨健くんと高梨先生と散歩しました。", "body", []string{"C001"}, false, nil); e == nil ||
		!reflect.DeepEqual(e.Names, []string{"高梨 健"}) {
		t.Errorf("「先生」の外の園児の氏名: %+v", e)
	}
	e, err := a.checkOtherNames("たっくんが初めてひとりで立ちました。", "body", []string{"C001", "C006"}, false, nil)
	if err != nil || e == nil || !reflect.DeepEqual(e.Names, []string{"野原 太郎"}) {
		t.Fatalf("写っているもう1人の呼び名: %+v %v", e, err)
	}
	if e.Message != "ほかのお子さんの名前（野原 太郎）が入っています。このまま送りますか。この文は写っている全員（2 家庭）に届きます。" {
		t.Errorf("文言: %s", e.Message)
	}
	if e, _ := a.checkOtherNames("たっくんが初めてひとりで立ちました。", "body", []string{"C001", "C006"}, false, []string{"野原 太郎"}); e != nil {
		t.Errorf("承諾したのに止まる: %+v", e)
	}
	// 宛先が1人なら、家庭の数を添えない
	if e, _ := a.checkOtherNames("あおちゃんと遊びました。", "body", []string{"C001"}, false, nil); e == nil ||
		e.Message != "ほかのお子さんの名前（伊藤 葵）が入っています。このまま送りますか。" {
		t.Errorf("宛先が1人の文言: %+v", e)
	}

	// 照合の経路（POST /api/contact/name-check）も同じ
	teacher := loginAs(a, accTeacher, "staff")
	var res struct {
		Names []string `json:"names"`
	}
	decode(t, call(t, h, teacher, "POST", "/api/contact/name-check", `{"child_ids":["C001","C006"],"text":"たっくんとあおちゃん"}`), &res)
	if len(res.Names) != 2 {
		t.Errorf("写っている2人の照合の経路: %+v", res)
	}
	decode(t, call(t, h, teacher, "POST", "/api/contact/name-check", `{"child_ids":["C001"],"text":"さくら組の高梨先生"}`), &res)
	if len(res.Names) != 0 {
		t.Errorf("照合の経路で除く語: %+v", res)
	}
}
