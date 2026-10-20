package main

import (
	"database/sql"
	"strconv"
)

/*
外部の AI へ送る項目（詳細設計書「送る項目」(8-4)、基本設計書「送る項目と置き換え」(4-11)・「外部の AI へ送る情報」(6-3)）。

**送ってよい列だけを読む。** 送らない列を「除く」形にしない（列が足されたときに、知らないうちに送る側へ入らないようにする）。
このファイルの SELECT に書いた列のほかは、外部の AI へ渡らない。

| 用途 | 読む |
| facility_note | ① 年齢（m_child.birth_date と date から「n歳」だけ） ② 午睡（t_nap_sleep の slept_at・woke_at の時:分） ③ 食事（t_contact_event 種類1 の recorded_at・meal_kind・meal_amount を言葉にする） ④ ひとこと・写真に添えた文（種類4・5 の recorded_at・body） ⑤ クラスのようす（その日のクラスの t_contact_class.body） ⑥ 担任のメモ。すべて取り消していないもの |
| rephrase・continue | 職員がその欄に書いた文（text）だけ |

読まないもの：氏名・よみ・呼び名・生年月日・月齢・クラス名・園名・保護者名・職員名・アレルギー・既往歴・体温（連絡帳・午睡とも）・
排せつ・写真・家庭から・チャット・発達の記録・異常時の記録・ヒヤリハット。
④⑤⑥の文は、呼ぶ側（api_ai.go）が anonymize（namecheck.go）を通してから入れる（anon に渡す）。
保護者に出さない設定（contact.show_items）で外した種類は送らない（保護者に出していない事実を、保護者へ送る文に書かせないため。決めたこと D-26）。
モックは web/src/api/mock.ts の facilityFacts が同じ項目を読む。
*/

// aiRecord は「きょうの記録」の1行（8-6 (2) の形）
type aiRecord struct {
	Time   string `json:"時刻"`
	What   string `json:"こと"`
	Amount string `json:"量,omitempty"`
	Woke   string `json:"おきた,omitempty"`
	Text   string `json:"文,omitempty"`
}

// aiFacilityFacts は、園からのひとことの下書きに渡す中身（8-6 (2)）
type aiFacilityFacts struct {
	Age     string     `json:"年齢"`
	Records []aiRecord `json:"きょうの記録"`
	Memo    string     `json:"先生のメモ,omitempty"`
}

// aiTextFacts は、言い換え・続きの候補に渡す中身（8-6 (2)）
type aiTextFacts struct {
	Text string `json:"先生の文"`
}

// hm は 'YYYY-MM-DDTHH:MM:SS' から時:分だけを取り出す
func hm(at string) string {
	if len(at) < 16 {
		return ""
	}
	return at[11:16]
}

/*
facilityFacts は、園からのひとことの下書きの材料を集める。anon は記録の文（④⑤）の置き換え。
メモ（⑥）は呼ぶ側が置き換えて入れる
*/
func (a *app) facilityFacts(childID, date string, anon func(string) string) (aiFacilityFacts, error) {
	facts := aiFacilityFacts{Records: []aiRecord{}}
	var birth string
	if err := a.db.QueryRow(`SELECT birth_date FROM m_child WHERE child_id = ?`, childID).Scan(&birth); err != nil {
		return facts, err
	}
	// ① 年齢は「n歳」だけ（月齢・生年月日は送らない）
	facts.Age = strconv.Itoa(ageInMonths(birth, date)/12) + "歳"

	type row struct {
		at  string
		rec aiRecord
	}
	rows := []row{}
	add := func(at string, rec aiRecord) { rows = append(rows, row{at, rec}) }

	// ② 午睡：ねた・おきたの時刻だけ（sleep_temperature は読まない）
	if a.guardianSeesItem("nap") {
		rs, err := a.db.Query(`SELECT slept_at, woke_at FROM t_nap_sleep
			WHERE child_id = ? AND is_deleted = 0 AND substr(slept_at, 1, 10) = ? ORDER BY slept_at`, childID, date)
		if err != nil {
			return facts, err
		}
		for rs.Next() {
			var slept string
			var woke sql.NullString
			if err := rs.Scan(&slept, &woke); err != nil {
				rs.Close()
				return facts, err
			}
			rec := aiRecord{Time: hm(slept), What: "おひるね"}
			if woke.Valid {
				rec.Woke = hm(woke.String)
			}
			add(slept, rec)
		}
		rs.Close()
	}

	// ③ 食事：区分と量を言葉にする。④ ひとこと・写真に添えた文。体温（種類3）・排せつ（種類2）は読まない
	kinds := []string{}
	if a.guardianSeesItem("meal") {
		kinds = append(kinds, "1")
	}
	if a.guardianSeesItem("comment") {
		kinds = append(kinds, "4")
	}
	if a.guardianSeesItem("photo") {
		kinds = append(kinds, "5")
	}
	for _, kind := range kinds {
		rs, err := a.db.Query(`SELECT recorded_at, IFNULL(meal_kind, ''), IFNULL(meal_amount, ''), IFNULL(body, '') FROM t_contact_event
			WHERE child_id = ? AND contact_date = ? AND event_type = ? AND is_deleted = 0 ORDER BY recorded_at`, childID, date, kind)
		if err != nil {
			return facts, err
		}
		for rs.Next() {
			var at, mealKind, amount, body string
			if err := rs.Scan(&at, &mealKind, &amount, &body); err != nil {
				rs.Close()
				return facts, err
			}
			switch kind {
			case "1":
				add(at, aiRecord{Time: hm(at), What: mealKindText[mealKind], Amount: mealAmountText[amount]})
			case "4":
				add(at, aiRecord{Time: hm(at), What: "ひとこと", Text: anon(body)})
			case "5":
				if body != "" {
					add(at, aiRecord{Time: hm(at), What: "写真に添えた文", Text: anon(body)})
				}
			}
		}
		rs.Close()
	}

	// ⑤ クラスのようす：その日のその子のクラスの文
	if classID := a.contactClassOf(childID); classID != 0 && a.guardianSeesItem("class") {
		rs, err := a.db.Query(`SELECT recorded_at, body FROM t_contact_class
			WHERE class_id = ? AND contact_date = ? AND is_deleted = 0 ORDER BY recorded_at`, classID, date)
		if err != nil {
			return facts, err
		}
		for rs.Next() {
			var at, body string
			if err := rs.Scan(&at, &body); err != nil {
				rs.Close()
				return facts, err
			}
			add(at, aiRecord{Time: hm(at), What: "クラスのようす", Text: anon(body)})
		}
		rs.Close()
	}

	// 時刻の順に並べる（同じ時刻は読んだ順）
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && rows[j].at < rows[j-1].at; j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}
	for _, r := range rows {
		facts.Records = append(facts.Records, r.rec)
	}
	return facts, nil
}
