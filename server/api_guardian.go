package main

import (
	"database/sql"
	"errors"
	"net/http"
)

/*
保護者のメニューの経路（詳細設計書「保護者のメニュー」(4-15)、画面は「保護者のメニュー」(2-15)）。
どれも保護者だけ（職員が呼んだら 403「保護者のみが行えます」。詳細設計書「本書で足す文言」(4-1 (6))）。
モックは web/src/api/mock.ts の guardianApi が同じ規則を持つ。片方だけ直すと食い違う。

本版は「AI の下書きの利用」(4-15 (3)) だけを置く。お子さまの追加 (4-15 (1))・連絡先の変更 (4-15 (2)) は実装の順番の 15 の残り。
*/

// aiOptOutLogField は、操作ログの変更前後に入れる項目の名前（詳細設計書「AI の下書きの利用」(4-15 (3))）
const aiOptOutLogField = "AI の下書きを使わない"

func aiOptOutLogValue(optOut bool) string {
	if optOut {
		return "使わない"
	}
	return "使う"
}

/*
POST /api/guardian/children/{childID}/ai-opt-out（詳細設計書「AI の下書きの利用」(4-15 (3))）。
要求 { opt_out: boolean } → { ok: true }。

  - ログイン中の保護者の、その園児との紐づけが有効（1）であること。無い・終了（2）は 403「この園児の連絡帳は開けません。」、
    猶予中（3）は 403「卒園・退園したお子さまの設定は変えられません。」（基本設計書「権限チェックの実装方針」(6-2) の、
    猶予中は AI の拒否の切り替えができない）
  - 園が AI を有効にしていること（ai.enabled = '1'）。無効なら 400「いまは AI の下書きを使っていません。」
  - 自分の紐づけの ai_opt_out だけを書き換える。ほかの家族の値は変えない・返さない（決めたこと D-49）。
    紐づく保護者の1人でも断れば、その園児には AI を使わない（api_ai.go の aiChildConsented が読む）
  - 操作ログ：7・2（t_guardian_child、target_id は保護者のアカウント、target_child_id、
    変更前後は {"AI の下書きを使わない": "使わない"} か "使う"）。知らせは送らない
*/
func (a *app) handleAiOptOut(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !u.isGuardian() || u.GuardianID == nil {
		writeForbidden(w, msgGuardianOnly)
		return
	}
	childID := r.PathValue("childID")
	var status string
	var before bool
	err := a.db.QueryRow(`SELECT gc.link_status, gc.ai_opt_out <> 0 FROM t_guardian_child gc
		JOIN m_child c ON c.child_id = gc.child_id AND c.is_deleted = 0
		WHERE gc.guardian_id = ? AND gc.child_id = ?`, *u.GuardianID, childID).Scan(&status, &before)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && status != "1" && status != "3") {
		writeForbidden(w, msgContactForbidden)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	if status == "3" {
		writeForbidden(w, msgGuardianSettingGrace)
		return
	}
	if a.settingText("ai.enabled", "0") != "1" {
		writeErr(w, http.StatusBadRequest, msgAiNotEnabled)
		return
	}
	var in struct {
		OptOut *bool `json:"opt_out"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.OptOut == nil {
		writeErr(w, http.StatusBadRequest, msgBadRequest)
		return
	}
	after := *in.OptOut
	optOut := 0
	if after {
		optOut = 1
	}
	// 自分の紐づけの行だけ。読んだあとに紐づけが有効でなくなっていれば書かない
	res, err := a.db.Exec(`UPDATE t_guardian_child SET ai_opt_out = ?
		WHERE guardian_id = ? AND child_id = ? AND link_status = '1'`, optOut, *u.GuardianID, childID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeForbidden(w, msgContactForbidden)
		return
	}
	// 【仮置き】変わったときだけ残す（基本設計書「操作ログ（t_operation_log）」(5-9) の「変更のあった項目だけを」に寄せた。web/仮置き値.md）
	if before != after {
		a.log(u.AccountID, fnAccount, opUpdate, "t_guardian_child", i64(u.AccountID), s(childID),
			s(fieldsJSON([]field{{aiOptOutLogField, aiOptOutLogValue(before)}})),
			s(fieldsJSON([]field{{aiOptOutLogField, aiOptOutLogValue(after)}})))
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// guardianAiOptOut は、ログイン中の保護者自身の、その園児との紐づけの ai_opt_out（GuardianToday.ai_opt_out。4-15 (3)）。
// ほかの家族の値は読まない
func (a *app) guardianAiOptOut(u *SessionUser, childID string) bool {
	var v int
	a.db.QueryRow(`SELECT ai_opt_out FROM t_guardian_child WHERE guardian_id = ? AND child_id = ?`, u.guardian(), childID).Scan(&v)
	return v != 0
}
