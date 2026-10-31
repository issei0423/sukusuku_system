package main

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

/*
 * 日誌ときょうのようす（連絡帳）のつながり
 * 典拠：基本設計書.md「きょうのようすから個人日誌の下書きへ」(4-6)・「取り消し・訂正」(4-5)・
 *      「入力項目の制約値とメッセージ一覧」(4-12)、
 *      詳細設計書.md「日誌の画面（作り直し）」(2-13 (4)(5))・「日誌」(4-13 (6)(8))、
 *      図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目22・25
 * GitHub Issue #278 の 2。モック（web/src/api/mock.ts の contactApi.diaryLines・diaryContactChanges）と同じ文・同じ規則にする
 */

// DiaryContactChange は、取り込んだあとに連絡帳で訂正・取り消しされた記録の1件（詳細設計書「日誌」(4-13 (6))）
type DiaryContactChange struct {
	Kind       string `json:"kind"`        // meal | nap
	RecordedAt string `json:"recorded_at"` // 記録の時刻（食事は記録した時刻、午睡はねた時刻）
	// 食事の区分（1:給食 2:おやつ）。「11:40 給食（15:20 に訂正）」と出すために添える（【仮置き】設計の形に足した項目。web/仮置き値.md）
	MealKind  string `json:"meal_kind,omitempty"`
	Change    string `json:"change"` // correct | cancel
	ChangedAt string `json:"changed_at"`
}

// diaryLine は、時刻の順に並べるための1行。item は保護者へ出す項目（contact.show_items）の名前（meal・nap）。
// heads は、本文の行がこの記録から入れたものかを照らす、記録があとで変わっても変わらない頭（hiddenContactItems）。
// 食事は「HH:MM 区分」（量は訂正で変わる）、午睡は「HH:MM〜」か「HH:MM 午睡」（おきたがあとから付く）
type diaryLine struct {
	at    string
	text  string
	item  string
	heads []string
}

// parseLocal は 'YYYY-MM-DDTHH:MM:SS'（JST）を時刻にする。崩れていれば 0 時刻を返す
func parseLocal(v string) time.Time {
	t, _ := time.ParseInLocation("2006-01-02T15:04:05", v, jst)
	return t
}

// napDurationText は、寝た長さの言葉。「1時間35分」「35分」。ちょうどの時間は「1時間」とする
func napDurationText(minutes int) string {
	if minutes < 60 {
		return strconv.Itoa(minutes) + "分"
	}
	if minutes%60 == 0 {
		return strconv.Itoa(minutes/60) + "時間"
	}
	return strconv.Itoa(minutes/60) + "時間" + strconv.Itoa(minutes%60) + "分"
}

/*
diaryLinesOf は、その園児・その日のきょうのようすのうち、午睡と食事を時刻つきの行にする。
取り消した記録は入れない。保護者へ出さない設定の項目も入れる（日誌は園内の記録であるため）。
入眠時の体温・5分ごとの確認・対象外は入れない（午睡は「ねた・おきた・何分」、食事は「区分と量」に限る）
*/
func (a *app) diaryLinesOf(childID, date string) ([]diaryLine, error) {
	var lines []diaryLine

	rows, err := a.db.Query(`SELECT recorded_at, meal_kind, meal_amount FROM t_contact_event
		WHERE child_id = ? AND contact_date = ? AND event_type = '1' AND is_deleted = 0`, childID, date)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var at, kind, amount string
		if rows.Scan(&at, &kind, &amount) == nil {
			head := hm(at) + " " + mealKindText[kind]
			lines = append(lines, diaryLine{at, head + " " + mealAmountText[amount], "meal", []string{head}})
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}

	rows, err = a.db.Query(`SELECT s.slept_at, s.woke_at FROM t_nap_sleep s
		JOIN t_nap_session ses ON ses.nap_session_id = s.nap_session_id
		WHERE s.child_id = ? AND ses.session_date = ? AND s.is_deleted = 0`, childID, date)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var slept string
		var woke *string
		if rows.Scan(&slept, &woke) != nil {
			continue
		}
		heads := []string{hm(slept) + "〜", hm(slept) + " 午睡"}
		if woke == nil {
			lines = append(lines, diaryLine{slept, hm(slept) + " 午睡（おきたは記録されていません）", "nap", heads})
			continue
		}
		minutes := int((parseLocal(*woke).Sub(parseLocal(slept))).Minutes())
		lines = append(lines, diaryLine{slept, hm(slept) + "〜" + hm(*woke) + " 午睡（" + napDurationText(minutes) + "）", "nap", heads})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}

	sort.SliceStable(lines, func(i, j int) bool { return lines[i].at < lines[j].at })
	return lines, nil
}

// diaryContactItemLabels は、きょうのようすから入れる項目の、画面での名前（設定画面の「保護者へ出す項目」と同じ名前）。並びは注意に出す順
var diaryContactItemLabels = []struct{ item, label string }{{"nap", "午睡"}, {"meal", "食事"}}

/*
hiddenContactItems は、きょうのようすから入れる行のうち、保護者へ出さない設定（contact.show_items）の項目の名前を返す。
body が nil でなければ、その本文に入っている行だけを数える。本文の行（前後の空白を除く）が、記録の変わらない頭
（diaryLine.heads）で始まれば入っているとみなす。行の文字全体で照らすと、取り込んだあとに「おきた」が付いた・食事を訂正した
だけで行の文が変わり、本文に残っているのに数えなくなる（照合 c5-05）。保育士が行を消せば数えない。

共有を選んだ個人日誌は、承認すると保護者が読む。保護者の連絡帳に出していない項目が本文に入っていれば、
日誌作成・編集画面と日誌承認画面に、その項目の名前を挙げた注意を出す。判定して消すことはしない（消すかは人が決める。
基本設計書の設計原則1）。【仮置き】照合 c2b-2・c5-05 の推し（web/仮置き値.md）。モックは web/src/api/mock.ts の hiddenContactItems
*/
func (a *app) hiddenContactItems(lines []diaryLine, body *string) []string {
	var bodyLines []string
	if body != nil {
		for _, bl := range strings.Split(*body, "\n") {
			bodyLines = append(bodyLines, strings.TrimSpace(bl))
		}
	}
	out := []string{}
	for _, it := range diaryContactItemLabels {
		if a.guardianSeesItem(it.item) {
			continue
		}
		for _, l := range lines {
			if l.item == it.item && (body == nil || bodyHasHead(bodyLines, l.heads)) {
				out = append(out, it.label)
				break
			}
		}
	}
	return out
}

// bodyHasHead は、本文のどれかの行が、heads のどれかで始まるか
func bodyHasHead(bodyLines, heads []string) bool {
	for _, bl := range bodyLines {
		for _, h := range heads {
			if strings.HasPrefix(bl, h) {
				return true
			}
		}
	}
	return false
}

// hiddenContactItemsOfDiary は、個人日誌の本文に入っている、保護者へ出さない設定の項目の名前（日誌を1件読んだとき）。
// 本文の行と、その園児・記録日のきょうのようすから入れる行とを、記録の変わらない頭で照らす
func (a *app) hiddenContactItemsOfDiary(d Diary) []string {
	if d.RecordType != "1" || d.ChildID == nil {
		return nil
	}
	lines, err := a.diaryLinesOf(*d.ChildID, d.DiaryDate)
	if err != nil {
		return nil
	}
	return a.hiddenContactItems(lines, &d.Body)
}

// GET /api/contact/children/{childID}/diary-lines?date=（詳細設計書「日誌」(4-13 (8))）。職員だけ
func (a *app) handleDiaryLines(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireDiaryStaff(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.contactAccess(u, childID).Read {
		writeForbidden(w, msgContactForbidden)
		return
	}
	date := r.URL.Query().Get("date")
	if date == "" {
		date = today()
	}
	if !isISODate(date) || date > today() {
		// 日付の形が崩れている・未来のとき（詳細設計書「日誌」(4-13 (8))。連絡帳と同じ文。片方だけ直すとモックとずれる）
		writeErr(w, http.StatusBadRequest, msgContactBadDate)
		return
	}
	lines, err := a.diaryLinesOf(childID, date)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	texts := make([]string, 0, len(lines))
	for _, l := range lines {
		texts = append(texts, l.text)
	}
	// hidden_items：入れる行のうち、保護者の連絡帳に出していない項目の名前（共有する日誌の注意に使う。【仮置き】照合 c2b-2）
	writeJSON(w, http.StatusOK, map[string]any{"lines": texts, "hidden_items": a.hiddenContactItems(lines, nil)})
}

/*
contactChangesOf は、個人日誌のときだけ、日誌を作ったあとに訂正・取り消しされた、その園児・記録日の食事と午睡を返す。
日誌と連絡帳の行を結ぶ列は持たず、時刻で比べる（基本設計書「取り消し・訂正」(4-5)）。取り込んでいない記録に当たることがある
*/
func (a *app) contactChangesOf(d Diary) ([]DiaryContactChange, error) {
	out := []DiaryContactChange{}
	if d.RecordType != "1" || d.ChildID == nil {
		return out, nil
	}
	rows, err := a.db.Query(`SELECT recorded_at, is_deleted, corrected_at, updated_at, meal_kind FROM t_contact_event
		WHERE child_id = ? AND contact_date = ? AND event_type = '1'
		  AND ((is_deleted = 1 AND updated_at > ?) OR (is_deleted = 0 AND corrected_at > ?))`,
		*d.ChildID, d.DiaryDate, d.CreatedAt, d.CreatedAt)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var at, updated, kind string
		var deleted bool
		var corrected *string
		if rows.Scan(&at, &deleted, &corrected, &updated, &kind) != nil {
			continue
		}
		c := DiaryContactChange{Kind: "meal", RecordedAt: at, MealKind: kind, Change: "correct", ChangedAt: deref(corrected)}
		if deleted {
			c.Change, c.ChangedAt = "cancel", updated
		}
		out = append(out, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	rows, err = a.db.Query(`SELECT s.slept_at, s.is_deleted, s.corrected_at, s.updated_at FROM t_nap_sleep s
		JOIN t_nap_session ses ON ses.nap_session_id = s.nap_session_id
		WHERE s.child_id = ? AND ses.session_date = ?
		  AND ((s.is_deleted = 1 AND s.updated_at > ?) OR (s.is_deleted = 0 AND s.corrected_at > ?))`,
		*d.ChildID, d.DiaryDate, d.CreatedAt, d.CreatedAt)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var at, updated string
		var deleted bool
		var corrected *string
		if rows.Scan(&at, &deleted, &corrected, &updated) != nil {
			continue
		}
		c := DiaryContactChange{Kind: "nap", RecordedAt: at, Change: "correct", ChangedAt: deref(corrected)}
		if deleted {
			c.Change, c.ChangedAt = "cancel", updated
		}
		out = append(out, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].RecordedAt < out[j].RecordedAt })
	return out, nil
}
