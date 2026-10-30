package main

import (
	"net/http"
	"sort"
	"strconv"
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

// diaryLine は、時刻の順に並べるための1行
type diaryLine struct {
	at   string
	text string
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
func (a *app) diaryLinesOf(childID, date string) ([]string, error) {
	var lines []diaryLine

	rows, err := a.db.Query(`SELECT recorded_at, meal_kind, meal_amount FROM t_contact_event
		WHERE child_id = ? AND contact_date = ? AND event_type = '1' AND is_deleted = 0`, childID, date)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var at, kind, amount string
		if rows.Scan(&at, &kind, &amount) == nil {
			lines = append(lines, diaryLine{at, hm(at) + " " + mealKindText[kind] + " " + mealAmountText[amount]})
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
		if woke == nil {
			lines = append(lines, diaryLine{slept, hm(slept) + " 午睡（おきたは記録されていません）"})
			continue
		}
		minutes := int((parseLocal(*woke).Sub(parseLocal(slept))).Minutes())
		lines = append(lines, diaryLine{slept, hm(slept) + "〜" + hm(*woke) + " 午睡（" + napDurationText(minutes) + "）"})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}

	sort.SliceStable(lines, func(i, j int) bool { return lines[i].at < lines[j].at })
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, l.text)
	}
	return out, nil
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
	writeJSON(w, http.StatusOK, map[string]any{"lines": lines})
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
