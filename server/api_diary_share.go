package main

import (
	"net/http"
)

/*
 * 日誌の保護者への共有
 *
 * 保育士が個人日誌を申請するときに「保護者へ共有する」を選び、管理者（園長）が承認すると、
 * その園児の保護者が読めるようになる。保育士の申請と管理者の承認の2つがそろって共有になる。
 * 2026-10-29 に持ち主が決めた（案2：申請するときに共有を選ぶ。既定は共有しない。対象は個人日誌だけ）。
 * ナレッジ/決定事項.md 2026-10-18「日誌を保護者へ共有する道は戻さない」を改めるもので、設計書は追って直す。
 *
 * - 共有するかは申請した保育士が決める。管理者は承認か差し戻しで答える（承認の要求の本文は読まない）
 * - 承認を取り消すと（差し戻しになり）保護者からは見えなくなる。承認済みの日誌は書き換えられないため、
 *   保護者が読む本文は承認したときのまま変わらない
 * - 保護者は日誌の経路（/api/diaries/...）を使えないまま（api_diary.go の requireDiaryStaff）。
 *   共有された日誌は、下の経路で保護者に見せる項目だけを返す（差し戻す理由・職員の ID などは返さない）
 *
 * 画面側のモック（web/src/api/mock.ts の guardianDiaries・saveDiary・approveDiary）と同じ規則
 */

// diaryLogApproveShared は、共有を選んだ日誌を承認したときの操作ログの「変更後」の文言。モックと同じ
const diaryLogApproveShared = "承認済み（保護者へ共有）"

// guardianDiaryLimit は、保護者に返す共有された日誌の件数の上限。【仮置き】新しい順に 100 件（web/仮置き値.md）
const guardianDiaryLimit = 100

/*
shareColumnOf は、保存する共有の印を返す。個人日誌（記録種別 1）だけが共有でき、ほかの記録種別は常に共有しない。
送られなかった（nil）ときは current（新しく作るなら false、書き換えるなら今の値）にする。
*/
func shareColumnOf(recordType string, in *bool, current bool) bool {
	if recordType != "1" {
		return false
	}
	if in == nil {
		return current
	}
	return *in
}

// GuardianDiary は、保護者に見せる共有された日誌。保護者に見せる項目だけを持つ
type GuardianDiary struct {
	DiaryID   int64  `json:"diary_id"`
	ChildID   string `json:"child_id"`
	ChildName string `json:"child_name"`
	DiaryDate string `json:"diary_date"`
	Body      string `json:"body"`
	// 共有された日時（承認した日時）
	SharedAt string `json:"shared_at"`
}

/*
handleGuardianDiaries は、保護者に共有された日誌を返す。自児（紐づけが有効な園児）の、承認済みで共有を選んだ
個人日誌だけ。記録日の新しい順。保護者のみ（職員は日誌の経路で読む）。
*/
func (a *app) handleGuardianDiaries(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !u.isGuardian() || u.GuardianID == nil {
		writeForbidden(w, "共有された日誌は保護者のみが利用できます")
		return
	}
	rows, err := a.db.Query(`SELECT d.diary_id, d.child_id, d.diary_date, d.body, d.approved_at
		FROM t_diary d
		WHERE d.is_deleted = 0 AND d.record_type = '1' AND d.status = '3' AND d.share_to_guardian = 1
		  AND d.child_id IN (SELECT child_id FROM t_guardian_child WHERE guardian_id = ? AND link_status = '1')
		ORDER BY d.diary_date DESC, d.approved_at DESC, d.diary_id DESC
		LIMIT ?`, *u.GuardianID, guardianDiaryLimit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "共有された日誌を取得できませんでした")
		return
	}
	out := []GuardianDiary{}
	for rows.Next() {
		var d GuardianDiary
		if err := rows.Scan(&d.DiaryID, &d.ChildID, &d.DiaryDate, &d.Body, &d.SharedAt); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, "共有された日誌を取得できませんでした")
			return
		}
		out = append(out, d)
	}
	rows.Close()
	// 名前の解決はカーソルを閉じたあとに行う（接続は1本。api_diary.go の enrich）
	for i := range out {
		out[i].ChildName = a.childName(out[i].ChildID)
	}
	writeJSON(w, http.StatusOK, out)
}
