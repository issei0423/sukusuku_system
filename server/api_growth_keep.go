package main

import (
	"net/http"
	"time"
)

/*
「成長の記録に残す」の付け外し（詳細設計書「成長の記録」(4-12 (3))・「成長の記録に届くもの」(3-7) の「成長の記録に残す」の状態、
「職員の画面から成長の記録へ届けるもの」(2-12 (1))）。

活動のひとこと・写真に印を付けると、その子の成長の記録の「できたこと」に並ぶ。付け外しは連絡帳の中身を変えないため、
corrected_at を変えず、保護者の連絡帳に「訂正しました」を出さない。できる人と期限は訂正と同じ（canKeepInGrowth）。
モックは web/src/api/mock.ts の growthApi.keepInGrowth が同じ規則を持つ（9-2）。
*/

/*
canKeepInGrowth は、その園児のその日の記録を直せるか（詳細設計書「訂正・取り消しのまとめ」(3-5) の canCorrect、
基本設計書「取り消し・訂正」(4-2)）。その日（ページがサーバの今日）はその園児のクラスの担任（contactAccess の Write。
記録した職員に限らない）、管理者はいつでも。フリーの職員・保護者は直せない。
PR #200 の canFixContact と同じ規則。#200 と合わせるときは canFixContact に寄せて、この関数を消す
*/
func (a *app) canKeepInGrowth(u *SessionUser, childID, contactDate string) bool {
	if !u.isStaff() || !a.contactAccess(u, childID).Write {
		return false
	}
	return u.isAdmin() || contactDate == today()
}

// laterVersion は、書き換えたときの updated_at。いまの時刻が前の版と同じ秒でも、必ず進める（決めたこと D-40）
func laterVersion(prev string) string {
	at := now()
	if at <= prev {
		if t, err := time.ParseInLocation("2006-01-02T15:04:05", prev, jst); err == nil {
			at = t.Add(time.Second).Format("2006-01-02T15:04:05")
		}
	}
	return at
}

// POST /api/contact/events/{id}/keep-in-growth（詳細設計書 (4-12 (3))）。要求 { keep_in_growth, updated_at }、応答 ContactEvent
func (a *app) handleKeepInGrowth(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	var childID, date, eventType, updatedAt string
	var keep, deleted bool
	// 行があり、取り消していない。職員で、その園児を読める（どれも外れたら同じ 403 と同じ文言）
	if !valid || !u.isStaff() ||
		a.db.QueryRow(`SELECT child_id, contact_date, event_type, keep_in_growth, is_deleted, updated_at FROM t_contact_event
			WHERE contact_event_id = ?`, id).Scan(&childID, &date, &eventType, &keep, &deleted, &updatedAt) != nil ||
		deleted || !a.contactAccess(u, childID).Read {
		writeForbidden(w, msgContactForbidden)
		return
	}
	var in struct {
		KeepInGrowth bool   `json:"keep_in_growth"`
		UpdatedAt    string `json:"updated_at"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if eventType != "4" && eventType != "5" {
		writeErr(w, http.StatusBadRequest, msgBadChoice)
		return
	}
	if !a.canKeepInGrowth(u, childID, date) {
		writeForbidden(w, msgGrowthFixForbidden)
		return
	}
	if in.UpdatedAt != updatedAt {
		writeJSON(w, http.StatusConflict, apiError{Message: msgVersionConflict, Kind: kindVersionConflict})
		return
	}
	// 値が変わらなければ書き換えず、いまの行を返す
	if in.KeepInGrowth != keep {
		flag := 0
		if in.KeepInGrowth {
			flag = 1
		}
		// keep_in_growth と updated_at だけを書き換える。corrected_at は変えない（3-7）。読んだ版の照合は書き換えの文の条件で行う
		res, err := a.db.Exec(`UPDATE t_contact_event SET keep_in_growth = ?, updated_at = ?
			WHERE contact_event_id = ? AND updated_at = ? AND is_deleted = 0`, flag, laterVersion(updatedAt), id, updatedAt)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeJSON(w, http.StatusConflict, apiError{Message: msgVersionConflict, Kind: kindVersionConflict})
			return
		}
		label := map[bool]string{true: "残す", false: "残さない"}
		a.log(u.AccountID, fnContact, opUpdate, "t_contact_event", i64(id), &childID,
			s(jsonText(map[string]string{"成長の記録に残す": label[keep]})),
			s(jsonText(map[string]string{"成長の記録に残す": label[in.KeepInGrowth]})))
		a.notifyContactChild(childID, eventItem(eventType))
	}
	e, err := a.loadContactEvent(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	writeJSON(w, http.StatusOK, e.contactEventOut)
}

