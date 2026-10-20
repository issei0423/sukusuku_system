package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

/*
 * 日誌の定型文と、デモのヒヤリハットの本文
 * 典拠：ナレッジ/決定事項.md 2026-10-18「『日誌』は園内の保育日誌として連絡帳とは別に持ち、保護者へは連絡帳で届ける」、
 * 基本設計書「ヒヤリハットの記録」(4-6)、詳細設計書「デモデータ」(5-5)・決めたこと D-33（PR #216 で設計を直した）
 *
 * 画面側のモック（web/src/api/mockDb.ts）と同じ値であることを、web/tests/diaryPhrase.test.ts と同じ観点で確かめる。
 */

// 日誌の定型文。web/tests/diaryPhrase.test.ts と同じ並び
var wantDiaryPhrases = []string{
	"よく食べ、おかわりをしていました。",
	"午睡は落ち着いて入眠できました。",
	"園庭で友だちと関わって遊ぶ姿が見られました。",
	"鼻水が出ていたため、こまめに拭き取りました。",
}

// デモのヒヤリハット（diary_id 3）の今後の対策。web/tests/diaryPhrase.test.ts と同じ文
const wantDemoCountermeasure = "午睡の確認のたびに、呼吸とあわせて体位も見る。うつ伏せを見つけて仰向けに直したときは、直したあとの向きも記録する。"

func TestDiaryPhrasesHaveNoGuardianFacingSentence(t *testing.T) {
	a, h := newTestApp(t)
	var got []string
	if err := json.Unmarshal(call(t, h, loginAs(a, 3, "staff"), "GET", "/api/diaries/phrases", "").Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, wantDiaryPhrases) {
		t.Fatalf("定型文 = %q, want %q", got, wantDiaryPhrases)
	}
	// 日誌は園内の記録であり、保護者に向けた文を候補に出さない
	for _, p := range got {
		if strings.Contains(p, "ご家庭") || strings.Contains(p, "保護者") {
			t.Errorf("保護者に向けた定型文がある: %q", p)
		}
	}
}

func TestDemoIncidentHasCountermeasureHeading(t *testing.T) {
	a, h := newTestApp(t)
	var d Diary
	if err := json.Unmarshal(call(t, h, loginAs(a, 1, "staff"), "GET", "/api/diaries/3", "").Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.RecordType != "4" {
		t.Fatalf("diary_id 3 の記録の種類 = %q, want 4（ヒヤリハット）", d.RecordType)
	}
	// 見出しは雛形（m_diary_template の 4）と同じ順に並ぶ。
	// 発生日時は列（occurred_at）へ移ったので、本文の見出しには無い（#230。詳細設計書「日誌」(4-13 (1))、決めたこと D-33）
	pos := -1
	for _, heading := range []string{"【状況】", "【とった対応】", "【今後の対策】"} {
		i := strings.Index(d.Body, heading)
		if i <= pos {
			t.Fatalf("見出し %s が無いか、順が違う: %q", heading, d.Body)
		}
		pos = i
	}
	// seed.sql の改行は、チェックアウトの設定で CRLF になることがあるため、見出しのあとの空白ごと除いて比べる
	_, after, _ := strings.Cut(d.Body, "【今後の対策】")
	if strings.TrimSpace(after) != wantDemoCountermeasure {
		t.Errorf("今後の対策 = %q, want %q", after, wantDemoCountermeasure)
	}
}
