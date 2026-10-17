package main

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

/*
他児の名前の照合（詳細設計書「他児の名前の照合」(4-5 (2))、決めたこと D-13・D-17、基本設計書「送る時点の守り」(4-2)）。

機械的な文字の照合であり、判断ではない（設計原則1）。当たっても送るのは止めない（承諾すれば送れる）。
応答と画面には当たった園児の名前だけを出し、園児の名前の一覧を画面へ配らない。
モックは web/src/api/mock.ts の findOtherNames が同じ規則を持つ。照合の表（nameCheckCases）は同じ行にする（9-2）。

① 照合する名前（園児1人について）：氏名（空白を除く）・姓・名、よみ（空白を除く）・よみの姓・よみの名、呼び名と、
   呼び名の末尾の「ちゃん」「くん」「さん」を除いたもの
② 書き方の揺れ：本文はそのままにし、名前の側に変種を作る。仮名の名前はひらがなとカタカナの両方、
   氏名とよみは姓と名の間に空白なし・半角の空白・全角の空白の3つ（本文の位置をそのまま返すため。AI へ送る前の置き換えと同じ関数）
③ 短い名前：1文字の名前と2文字以下の仮名の名前は、すぐ後ろに敬称（ちゃん・くん・さん・君）が続くときだけ当てる
④ 相手：宛先以外の在籍園児（enrollment_status = '1'、取り消していない）全員。宛先がクラスなら在籍園児全員。
   宛先の子の名前に当たった部分は、先に印を付けて除いてから探す（同じ名の子を取り違えない。D-17）。
   除くのは、ほかの子の当たりが印の中に**すべて入る**ときだけにする。宛先の姓の印に一部が重なる、同じ姓のきょうだいの
   氏名（宛先「野原 太郎」で本文「野原あいに伝えました」）は当てる（自動レビューの指摘。一部でも重なれば除くと、きょうだいの名前を見落とす）
⑤ 返すもの：当たった園児ごとに氏名を1つ（names）と、本文の中の当たった位置（matches。符号位置で数える）
*/

// nameMatch は、本文の中で他児の名前に当たった位置（詳細設計書「誤りの応答」(4-1 (3)) の matches）
type nameMatch struct {
	Field string `json:"field"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

// nameChild は、照合に使う園児の名前（氏名・よみ・呼び名）
type nameChild struct {
	ID, Name, Kana, Nickname string
}

var honorifics = []string{"ちゃん", "くん", "さん", "君"}

func isKanaRune(r rune) bool {
	return (r >= 'ぁ' && r <= 'ゖ') || (r >= 'ァ' && r <= 'ヶ') || r == 'ー'
}

func allKana(s string) bool {
	for _, r := range s {
		if !isKanaRune(r) {
			return false
		}
	}
	return s != ""
}

// toKatakana・toHiragana は、ひらがなとカタカナを入れ替える（長音などはそのまま）
func toKatakana(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'ぁ' && r <= 'ゖ' {
			return r + 0x60
		}
		return r
	}, s)
}

func toHiragana(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'ァ' && r <= 'ヶ' {
			return r - 0x60
		}
		return r
	}, s)
}

// splitName は、氏名・よみを半角・全角の空白で姓と名に分ける
func splitName(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool { return r == ' ' || r == '　' || r == '\t' })
}

// nameVariant は照合する1つの書き方。short は「すぐ後ろに敬称が続くときだけ当てる」
type nameVariant struct {
	text  []rune
	short bool
}

// nameVariants は、園児1人の照合する書き方をすべて作る（① ② ③）
func nameVariants(c nameChild) []nameVariant {
	seen := map[string]bool{}
	out := []nameVariant{}
	add := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" {
			return
		}
		forms := []string{s}
		if allKana(s) {
			forms = []string{toHiragana(s), toKatakana(s)}
		}
		for _, f := range forms {
			if seen[f] {
				continue
			}
			seen[f] = true
			n := utf8.RuneCountInString(f)
			short := n == 1 || (allKana(f) && n <= 2)
			out = append(out, nameVariant{text: []rune(f), short: short})
		}
	}
	// 氏名とよみ：空白なし・半角・全角、と姓・名
	for _, full := range []string{c.Name, c.Kana} {
		parts := splitName(full)
		if len(parts) == 0 {
			continue
		}
		add(strings.Join(parts, ""))
		if len(parts) >= 2 {
			add(strings.Join(parts, " "))
			add(strings.Join(parts, "　"))
			for _, p := range parts {
				add(p)
			}
		}
	}
	// 呼び名と、末尾の敬称を除いたもの
	if nick := strings.TrimSpace(c.Nickname); nick != "" {
		add(nick)
		for _, h := range []string{"ちゃん", "くん", "さん"} {
			if strings.HasSuffix(nick, h) {
				add(strings.TrimSuffix(nick, h))
			}
		}
	}
	return out
}

// occurrences は、本文の中の書き方の位置（符号位置）を返す。短い名前は敬称が続くときだけ
func occurrences(text []rune, v nameVariant) [][2]int {
	out := [][2]int{}
	n := len(v.text)
	for i := 0; i+n <= len(text); i++ {
		if string(text[i:i+n]) != string(v.text) {
			continue
		}
		if v.short {
			rest := string(text[i+n:])
			ok := false
			for _, h := range honorifics {
				if strings.HasPrefix(rest, h) {
					ok = true
					break
				}
			}
			if !ok {
				continue
			}
		}
		out = append(out, [2]int{i, i + n})
	}
	return out
}

/*
findOtherNames は、本文 text に、宛先（recipients）以外の園児の名前があるかを照合する。
everyone は、在籍園児の全員（候補 all）が相手か（宛先がクラスのとき）。field は matches に入れる欄の名前。
names は当たった園児の氏名（照合の候補の並び順）、matches は当たった位置（始まりの順）。
*/
func findOtherNames(text, field string, recipients []nameChild, all []nameChild) ([]string, []nameMatch) {
	runes := []rune(text)
	masked := make([]bool, len(runes))
	isRecipient := map[string]bool{}
	// 宛先の子の名前に当たった部分を先に除く（D-17）。長い書き方から印を付ける
	for _, r := range recipients {
		isRecipient[r.ID] = true
		vs := nameVariants(r)
		sort.SliceStable(vs, func(i, j int) bool { return len(vs[i].text) > len(vs[j].text) })
		for _, v := range vs {
			for _, o := range occurrences(runes, v) {
				// すぐ後ろの敬称も宛先の子の名前の部分に含める（宛先「山田 ゆい」の「ゆいちゃん」を、ほかの子の呼び名「ゆいちゃん」と数えない）
				end := o[1]
				rest := string(runes[end:])
				for _, h := range honorifics {
					if strings.HasPrefix(rest, h) {
						end += utf8.RuneCountInString(h)
						break
					}
				}
				for k := o[0]; k < end; k++ {
					masked[k] = true
				}
			}
		}
	}
	names := []string{}
	matches := []nameMatch{}
	for _, c := range all {
		if isRecipient[c.ID] {
			continue
		}
		found := [][2]int{}
		for _, v := range nameVariants(c) {
			for _, o := range occurrences(runes, v) {
				inside := true
				for k := o[0]; k < o[1]; k++ {
					if !masked[k] {
						inside = false
						break
					}
				}
				if !inside {
					found = append(found, o)
				}
			}
		}
		if len(found) == 0 {
			continue
		}
		names = append(names, c.Name)
		// ほかの当たりに含まれる短い当たりを除く（「野原太郎」と「野原」が同じ所に当たったときは長いほう）
		for _, o := range found {
			inside := false
			for _, p := range found {
				if p != o && p[0] <= o[0] && o[1] <= p[1] {
					inside = true
					break
				}
			}
			if !inside {
				matches = append(matches, nameMatch{Field: field, Start: o[0], End: o[1]})
			}
		}
	}
	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].Start != matches[j].Start {
			return matches[i].Start < matches[j].Start
		}
		return matches[i].End > matches[j].End
	})
	// 【仮置き】位置は強調の表示に使う。同じ位置・ほかの当たりに含まれる位置（同じ名の子、「小林」の中の「林」）は1つにまとめる（web/仮置き値.md）。
	// 名前（names）はまとめない（どちらの子かを決めない。判断しない）
	uniq := []nameMatch{}
	for _, m := range matches {
		inside := false
		for _, u := range uniq {
			if u.Start <= m.Start && m.End <= u.End {
				inside = true
				break
			}
		}
		if !inside {
			uniq = append(uniq, m)
		}
	}
	return names, uniq
}

// enrolledNameChildren は、照合の候補（在籍・取り消していない園児）を、よみの順で返す
func (a *app) enrolledNameChildren() ([]nameChild, error) {
	rows, err := a.db.Query(`SELECT child_id, child_name, IFNULL(child_name_kana, ''), IFNULL(nickname, '') FROM m_child
		WHERE enrollment_status = '1' AND is_deleted = 0 ORDER BY child_name_kana, child_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []nameChild{}
	for rows.Next() {
		var c nameChild
		if err := rows.Scan(&c.ID, &c.Name, &c.Kana, &c.Nickname); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// nameChildOf は、宛先の園児の名前（在籍していない子も宛先にはなる）
func (a *app) nameChildOf(childID string) nameChild {
	c := nameChild{ID: childID}
	a.db.QueryRow(`SELECT child_name, IFNULL(child_name_kana, ''), IFNULL(nickname, '') FROM m_child WHERE child_id = ?`, childID).
		Scan(&c.Name, &c.Kana, &c.Nickname)
	return c
}

/*
checkOtherNames は、段2の送信の本文を照合し、承諾（acknowledged）が当たった名前をすべて含むかを見る（4-5 (2) の⑥）。
含まなければ 409 other_child_names の応答（apiError）を返す。照合できなかったときは ok=false・err を返す。
*/
func (a *app) checkOtherNames(text, field string, recipientIDs []string, everyone bool, acknowledged []string) (*apiError, error) {
	all, err := a.enrolledNameChildren()
	if err != nil {
		return nil, err
	}
	recipients := []nameChild{}
	if !everyone {
		for _, id := range recipientIDs {
			recipients = append(recipients, a.nameChildOf(id))
		}
	}
	names, matches := findOtherNames(text, field, recipients, all)
	if len(names) == 0 {
		return nil, nil
	}
	missing := false
	for _, n := range names {
		if !inList(acknowledged, n) {
			missing = true
			break
		}
	}
	if !missing {
		return nil, nil
	}
	return &apiError{Message: otherNamesMessage(names), Kind: kindOtherChildNames, Names: names, Matches: matches}, nil
}

// otherNamesMessage は、基本設計書「メッセージ一覧」(4-12) の「他児の名前の注意」の文
func otherNamesMessage(names []string) string {
	return "ほかのお子さんの名前（" + strings.Join(names, "・") + "）が入っています。このまま送りますか。"
}

/*
外部の AI へ送る前の置き換え（詳細設計書「置き換えの手順」(8-5)、基本設計書「送る項目と置き換え」(4-11)・「外部の AI へ送る情報」(6-3)）。

他児の名前の照合と同じ関数（nameVariants・occurrences）で当て、同じ短い名前の規則を使う。
モックは web/src/api/mock.ts の anonymize・restoreName が同じ規則を持つ。表（anonymizeCases）は同じ行にする（9-2）。

① 宛先の園児の名前（後ろに続く敬称を含む）を「〇〇ちゃん」にする
② 宛先以外の在籍園児の名前（敬称を含む）を「おともだち」にする。宛先の名前の部分にすべて入る当たりは数えない（D-17 と同じ）
③ 電話番号の形（数字と区切りで10〜11桁、0 で始まる）とメールアドレスの形を「（伏せました）」にする
④ 宛先がクラスのときは①を行わず、在籍園児の全員を②で置き換える（呼ぶ側が recipients を空にして渡す）
重なった当たりは長いほうを選ぶ（同じ姓のきょうだいの氏名「野原あい」は、宛先の姓「野原」より長いので「おともだち」になる）。
*/
const (
	anonRecipient     = "〇〇ちゃん"
	anonRecipientBare = "〇〇"
	anonOther         = "おともだち"
	anonContact       = "（伏せました）"
)

var (
	// 【仮置き】電話番号の区切りとして認める文字（web/仮置き値.md）。全角の数字も数える
	anonPhonePattern = regexp.MustCompile(`[0０](?:[-‐‑–—―−ー－ 　()（）]*[0-9０-９]){9,10}`)
	anonEmailPattern = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
)

func isDigitRune(r rune) bool { return (r >= '0' && r <= '9') || (r >= '０' && r <= '９') }

// maskContacts は、電話番号とメールアドレスの形の文字列を「（伏せました）」にする（③）。
// 電話番号は、前後に数字が続くもの（12桁以上の数の一部）を当てない
func maskContacts(text string) string {
	text = anonEmailPattern.ReplaceAllString(text, anonContact)
	var b strings.Builder
	last := 0
	for _, m := range anonPhonePattern.FindAllStringIndex(text, -1) {
		before, _ := utf8.DecodeLastRuneInString(text[:m[0]])
		after, _ := utf8.DecodeRuneInString(text[m[1]:])
		if isDigitRune(before) || isDigitRune(after) {
			continue
		}
		b.WriteString(text[last:m[0]])
		b.WriteString(anonContact)
		last = m[1]
	}
	b.WriteString(text[last:])
	return b.String()
}

// withHonorific は、名前の当たりの終わり（end）のすぐ後ろに敬称が続けば、敬称の後ろまで広げる
func withHonorific(runes []rune, end int) int {
	rest := string(runes[end:])
	for _, h := range honorifics {
		if strings.HasPrefix(rest, h) {
			return end + utf8.RuneCountInString(h)
		}
	}
	return end
}

/*
anonymize は、外部の AI へ送る文を置き換える。recipients は宛先の園児（クラスあては空）、all は在籍園児の全員。
replacedOthers は、宛先以外の園児の名前を「おともだち」に置き換えたか（画面に「置き換えて送りました」を出すため）。
*/
func anonymize(text string, recipients []nameChild, all []nameChild) (out string, replacedOthers bool) {
	runes := []rune(maskContacts(text))
	type span struct {
		s, e int
		repl string
	}
	spans := []span{}
	masked := make([]bool, len(runes))
	isRecipient := map[string]bool{}
	for _, r := range recipients {
		isRecipient[r.ID] = true
		for _, v := range nameVariants(r) {
			for _, o := range occurrences(runes, v) {
				e := withHonorific(runes, o[1])
				spans = append(spans, span{o[0], e, anonRecipient})
				for k := o[0]; k < e; k++ {
					masked[k] = true
				}
			}
		}
	}
	for _, c := range all {
		if isRecipient[c.ID] {
			continue
		}
		for _, v := range nameVariants(c) {
			for _, o := range occurrences(runes, v) {
				inside := true
				for k := o[0]; k < o[1]; k++ {
					if !masked[k] {
						inside = false
						break
					}
				}
				if !inside {
					spans = append(spans, span{o[0], withHonorific(runes, o[1]), anonOther})
				}
			}
		}
	}
	// 長い当たりから選び、すでに選んだ当たりに重なるものは捨てる。同じ長さなら先に足したもの（宛先）を残す
	sort.SliceStable(spans, func(i, j int) bool { return spans[i].e-spans[i].s > spans[j].e-spans[j].s })
	taken := make([]bool, len(runes))
	chosen := []span{}
	for _, sp := range spans {
		free := true
		for k := sp.s; k < sp.e; k++ {
			if taken[k] {
				free = false
				break
			}
		}
		if !free {
			continue
		}
		for k := sp.s; k < sp.e; k++ {
			taken[k] = true
		}
		chosen = append(chosen, sp)
	}
	sort.Slice(chosen, func(i, j int) bool { return chosen[i].s < chosen[j].s })
	var b strings.Builder
	pos := 0
	for _, sp := range chosen {
		b.WriteString(string(runes[pos:sp.s]))
		b.WriteString(sp.repl)
		pos = sp.e
		if sp.repl == anonOther {
			replacedOthers = true
		}
	}
	b.WriteString(string(runes[pos:]))
	return b.String(), replacedOthers
}

/*
callName は、下書きの「〇〇ちゃん」を戻す名前（詳細設計書「置き換えの手順」(8-5) の戻し方、決めたこと D-14）。
呼び名があれば呼び名、無ければ名（氏名の空白の後ろ）に「ちゃん」を付けたもの。くん・ちゃんの使い分けはシステムが決めない
*/
func callName(c nameChild) string {
	if nick := strings.TrimSpace(c.Nickname); nick != "" {
		return nick
	}
	parts := splitName(c.Name)
	if len(parts) == 0 {
		return c.Name + "ちゃん"
	}
	return parts[len(parts)-1] + "ちゃん"
}

// restoreName は、下書きの「〇〇ちゃん」と、残った「〇〇」を宛先の園児の名前に戻す。「おともだち」は戻さない
func restoreName(text string, c nameChild) string {
	name := callName(c)
	text = strings.ReplaceAll(text, anonRecipient, name)
	return strings.ReplaceAll(text, anonRecipientBare, name)
}
