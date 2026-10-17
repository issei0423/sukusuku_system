package main

import (
	"context"
	"sync"
	"testing"
)

/*
外部の AI の差し替えと、送る前の置き換え（詳細設計書「テストでの差し替え」(8-11)・「置き換えの手順」(8-5)・「2か所の規則をそろえる」(9-2)）。
テスト・CI では外部へ呼ばない。fakeWriter が受けた draftRequest を全部持ち、決めた JSON か誤りか拒否を返す。
anonymizeCases・restoreCases は web/tests/ai.test.ts の同じ名前の表と同じ行にする。園児は namecheck_test.go の nameCheckChildren。
*/

// fakeWriter は、外部の AI の代わり。受けた要求を残し、決めた答えを返す。block なら context が切れるまで返さない
type fakeWriter struct {
	mu    sync.Mutex
	got   []draftRequest
	reply draftReply
	err   error
	block bool
}

func (f *fakeWriter) Write(ctx context.Context, req draftRequest) (draftReply, error) {
	f.mu.Lock()
	f.got = append(f.got, req)
	f.mu.Unlock()
	if f.block {
		<-ctx.Done()
		return draftReply{}, ctx.Err()
	}
	return f.reply, f.err
}

func (f *fakeWriter) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.got)
}

func (f *fakeWriter) last() draftRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.got) == 0 {
		return draftRequest{}
	}
	return f.got[len(f.got)-1]
}

var anonymizeCases = []struct {
	name      string
	recipient string // 空ならクラスあて（在籍園児の全員を「おともだち」に）
	text      string
	want      string
	replaced  bool
}{
	{"宛先の呼び名を〇〇ちゃんに", "A", "たっくんが砂場で遊びました。", "〇〇ちゃんが砂場で遊びました。", false},
	{"宛先の名と後ろの敬称をまとめて〇〇ちゃんに", "A", "太郎くんは最後まで走りました。", "〇〇ちゃんは最後まで走りました。", false},
	{"宛先の氏名（空白あり）と敬称", "A", "野原 太郎さんへ。", "〇〇ちゃんへ。", false},
	{"ほかの子の呼び名をおともだちに", "A", "あおちゃんとしゃぼん玉をしました。", "おともだちとしゃぼん玉をしました。", true},
	{"ほかの子のよみ（カタカナ）と敬称", "A", "アオイちゃんと遊びました。", "おともだちと遊びました。", true},
	{"1文字の名はふだんの言葉では替えない", "A", "空が青い日でした。", "空が青い日でした。", false},
	{"1文字の名に敬称が続けば替える", "A", "空くんと遊びました。", "おともだちと遊びました。", true},
	{"宛先と同じ名の子を数えない", "C", "ゆいちゃんが笑っていました。", "〇〇ちゃんが笑っていました。", false},
	{"同じ姓のきょうだいの氏名は、宛先の姓より長いのでおともだち", "A", "野原あいに伝えました。", "おともだちに伝えました。", true},
	{"クラスあては全員をおともだちに", "", "たっくんとあおちゃんが遊びました。", "おともだちとおともだちが遊びました。", true},
	{"携帯電話の番号を伏せる", "A", "090-1234-5678 にお電話ください。", "（伏せました） にお電話ください。", false},
	{"区切りの無い番号を伏せる", "A", "09012345678まで", "（伏せました）まで", false},
	{"固定電話（10桁）を伏せる", "A", "098（123）4567へ", "（伏せました）へ", false},
	{"メールアドレスを伏せる", "A", "nohara.i@example.jp へ送ってください。", "（伏せました） へ送ってください。", false},
	{"0で始まらない数は伏せない", "A", "12345678901", "12345678901", false},
	{"12桁の数は伏せない", "A", "090123456789", "090123456789", false},
	{"時刻は伏せない", "A", "11:40に給食、09:30に散歩。", "11:40に給食、09:30に散歩。", false},
	{"名前が無ければそのまま", "A", "園庭で砂場あそびをしました。", "園庭で砂場あそびをしました。", false},
}

func TestAnonymizeTable(t *testing.T) {
	for _, c := range anonymizeCases {
		var recipients []nameChild
		for _, ch := range nameCheckChildren {
			if ch.ID == c.recipient {
				recipients = append(recipients, ch)
			}
		}
		got, replaced := anonymize(c.text, recipients, nameCheckChildren)
		if got != c.want || replaced != c.replaced {
			t.Errorf("%s: %q（置き換え %v）, want %q（%v）", c.name, got, replaced, c.want, c.replaced)
		}
	}
}

// anonymizeAdultCases は、保護者・職員の氏名を伏せる表（web/tests/ai.test.ts の同じ名前の表と同じ行）。宛先は野原 太郎（A）
var anonymizeAdultCases = []struct{ name, text, want string }{
	{"保護者の姓名", "野原一誠さんから電話がありました。", "保護者の方から電話がありました。"},
	{"保護者の名と敬称", "一誠さんに伝えました。", "保護者の方に伝えました。"},
	{"職員の姓と先生", "高梨先生と散歩しました。", "先生と散歩しました。"},
	{"職員の姓名（空白あり）", "金城 宗一郎が見ていました。", "先生が見ていました。"},
	{"園児の姓と同じなら園児として", "野原さんが笑っていました。", "〇〇ちゃんが笑っていました。"},
	{"保護者と職員の両方にいる人に先生が続けば職員として", "一誠先生が来ました。", "先生が来ました。"},
}

var anonymizeAdults = []nameAdult{{Name: "野原 一誠", Repl: anonGuardian}, {Name: "野原 一誠", Repl: anonStaff}, {Name: "高梨 倫太朗", Repl: anonStaff}, {Name: "金城 宗一郎", Repl: anonStaff}}

func TestAnonymizeAdultsTable(t *testing.T) {
	for _, c := range anonymizeAdultCases {
		got, _ := anonymize(c.text, nameCheckChildren[:1], nameCheckChildren, anonymizeAdults...)
		if got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

var restoreCases = []struct {
	name, recipient, text, want string
}{
	{"呼び名があれば呼び名に戻す", "A", "〇〇ちゃんは給食をぜんぶ食べました。", "たっくんは給食をぜんぶ食べました。"},
	{"呼び名が無ければ名にちゃんを付ける", "D", "〇〇ちゃんは砂場で遊びました。", "空ちゃんは砂場で遊びました。"},
	{"〇〇だけが残っていても戻す", "A", "〇〇は笑っていました。", "たっくんは笑っていました。"},
	{"おともだちは戻さない", "A", "おともだちと〇〇ちゃんが遊びました。", "おともだちとたっくんが遊びました。"},
}

func TestRestoreNameTable(t *testing.T) {
	for _, c := range restoreCases {
		var who nameChild
		for _, ch := range nameCheckChildren {
			if ch.ID == c.recipient {
				who = ch
			}
		}
		if got := restoreName(c.text, who); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}
