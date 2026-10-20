package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
)

/*
 * 日誌システム（作成・承認・編集ロック）
 * 典拠：基本設計書.md「日誌の作成から保護者への共有」(4-5)・「編集ロックの解除」(4-5)
 *      図/画面詳細図.md「日誌作成・編集画面」(3-2)・「日誌承認画面（管理者）」(3-3)
 */

type diaryInput struct {
	DiaryID    *int64  `json:"diary_id"`
	RecordType string  `json:"record_type"`
	ChildID    *string `json:"child_id"`
	ClassID    *int64  `json:"class_id"`
	DiaryDate  string  `json:"diary_date"`
	Body       string  `json:"body"`
	LockToken  string  `json:"lock_token"`
	// "1" 下書き / "2" 申請
	Status string `json:"status"`
}

func (a *app) handleSaveDiary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var in diaryInput
	if !readJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.Body) == "" {
		writeErr(w, http.StatusBadRequest, "本文を入力してください")
		return
	}
	if tooLong(in.Body, 2000) {
		writeErr(w, http.StatusBadRequest, "本文は2,000文字以内で入力してください")
		return
	}
	if in.Status != "1" && in.Status != "2" {
		writeErr(w, http.StatusBadRequest, "保存する状態の指定が正しくありません")
		return
	}
	/*
	 * 記録日は当日まで。形の崩れた値も断る（基本設計書「入力項目の制約値」(4-9)「記録日・測定日 未来日は認めない
	 * （当日まで）」、図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目6）。先の日付で申請できると、
	 * 日誌一覧の期間の既定（当日まで）から外れて、書いた本人の一覧に出なくなっていた（GitHub Issue #174）。
	 * 画面側のモック（web/src/api/mock.ts の saveDiary）と同じ規則
	 */
	if !isISODate(in.DiaryDate) {
		writeErr(w, http.StatusBadRequest, "記録日の形式が正しくありません")
		return
	}
	if in.DiaryDate > today() {
		writeErr(w, http.StatusBadRequest, "記録日に未来日は指定できません")
		return
	}
	// 個人日誌・ヒヤリハットは対象園児が要る
	needsChild := in.RecordType == "1" || in.RecordType == "4"
	if needsChild {
		if in.ChildID == nil || *in.ChildID == "" {
			writeErr(w, http.StatusBadRequest, "対象の園児を選んでください")
			return
		}
		if !a.canSeeChild(u, *in.ChildID) {
			writeForbidden(w, "この園児の日誌を作成する権限がありません")
			return
		}
	} else {
		in.ChildID = nil
	}
	/*
	 * 対象のクラスは、記録種別によらず必須とする（図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目5「入力：必須」
	 * 「『対象のクラス』は常に出し、初期値は自分の担当クラス」）。
	 * クラス日誌・週案は、対象クラスで参照範囲を判定する（api_diary.go の visibleDiaryCondition）。
	 * クラスの空いたクラス日誌は管理者にしか見えず、一般が作ると、保存した直後から書いた本人にも開けなくなる。
	 * クラスの空いた個人日誌は、日誌一覧をクラスで絞ると出なくなる（GitHub Issue #174）。
	 * 一般（保育士）が扱えるのは、閲覧・入力・編集のいずれも自クラスに限る
	 * （要件定義書「参照範囲の全体規定」(4-1-5)）。他クラスを対象に作ると、作った本人には見えず、
	 * そのクラスの担任には見える日誌ができてしまう（GitHub Issue #153）
	 */
	if in.ClassID == nil {
		writeErr(w, http.StatusBadRequest, "対象のクラスを選んでください")
		return
	}
	if !a.canUseClass(u, *in.ClassID) {
		writeForbidden(w, "このクラスの日誌を作成する権限がありません")
		return
	}
	// 【仮置き】個人日誌・ヒヤリハットの対象のクラスは、対象の園児が在籍するクラスに限る（web/仮置き値.md）。
	// ほかのクラスにすると、園児の担任が日誌一覧を自クラスで絞ったときに出ない（GitHub Issue #174）
	if needsChild && !a.childInClass(*in.ChildID, *in.ClassID) {
		writeErr(w, http.StatusBadRequest, "対象のクラスは、対象の園児が在籍するクラスを選んでください")
		return
	}

	if in.DiaryID != nil {
		a.updateDiary(w, u, in)
		return
	}

	res, err := a.db.Exec(`INSERT INTO t_diary
		(record_type, child_id, class_id, diary_date, body, status, created_staff_id,
		 is_shared_to_guardian, is_deleted, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
		in.RecordType, in.ChildID, in.ClassID, in.DiaryDate, in.Body, in.Status, u.staff(), now(), now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
		return
	}
	id, _ := res.LastInsertId()

	after := "下書き作成"
	if in.Status == "2" {
		after = diaryLogCreateAndApply
	}
	a.log(u.AccountID, fnDiary, opCreate, "t_diary", i64(id), in.ChildID, nil, s(after))

	a.writeDiaryByID(w, id)
}

func (a *app) updateDiary(w http.ResponseWriter, u *SessionUser, in diaryInput) {
	var status string
	if err := a.db.QueryRow(`SELECT status FROM t_diary WHERE diary_id = ? AND is_deleted = 0`,
		*in.DiaryID).Scan(&status); err != nil {
		writeErr(w, http.StatusNotFound, "日誌が見つかりません")
		return
	}
	// 書き換える日誌そのものも、参照範囲の内にあるものに限る。入力の園児・クラスを確かめるだけでは、
	// 他クラスの日誌を日誌IDで指定して自クラスへ書き換えられてしまう（GitHub Issue #153）
	if !a.canSeeDiary(u, *in.DiaryID) {
		writeForbidden(w, "この日誌を編集する権限がありません")
		return
	}
	if status == "2" || status == "3" {
		writeErr(w, http.StatusBadRequest, "申請中または承認済みの日誌は編集できません")
		return
	}

	/*
	 * 保存時のロック識別子が、現在有効なロックと一致するかを照合する。一致しない場合は、他者の更新の有無に
	 * かかわらず保存を拒否する（基本設計書「同時編集の検出」(4-2)・「編集ロックの解除」(4-5)、5-4）。
	 * ロックの行が無いとき（管理者が強制解除して行を消したまま、ほかの職員が保存して離れたあと）も
	 * 一致しないとみなす。行が無いからと照合を飛ばすと、強制解除された人の古い識別子でも、識別子なしでも
	 * 保存が通り、ほかの人の直しを黙って上書きする（GitHub Issue #166 の 1）。
	 * 識別子が一致しても、ロックを持つ本人でなければ通さない（同 2）
	 */
	if !a.holdsDiaryLock(u, *in.DiaryID, in.LockToken) {
		writeErr(w, http.StatusConflict, "編集ロックが解除されました。内容を再読み込みしてください")
		return
	}

	// 差し戻す理由は、再申請しても消さない。承認されるまで残し、次に差し戻されたときに上書きする。
	// 承認者が前回の指摘を見ながら確かめられるようにするため（基本設計書「日誌（t_diary）」(5-4)。GitHub Issue #174）
	_, err := a.db.Exec(`UPDATE t_diary
		SET record_type = ?, child_id = ?, class_id = ?, diary_date = ?, body = ?, status = ?, updated_at = ?
		WHERE diary_id = ?`,
		in.RecordType, in.ChildID, in.ClassID, in.DiaryDate, in.Body, in.Status, now(), *in.DiaryID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
		return
	}

	/*
	 * 申請したらロックを外す。申請中の日誌は編集できず、読むだけの人にロックを持たせない（基本設計書「編集ロックの解除」(4-5)
	 * 「保存…でロックを解除する」）。下書き保存は、編集画面に残って書き続けるため外さず、操作として最終操作時刻を進める
	 * （【仮置き】web/仮置き値.md「日誌の編集ロックの動き」）
	 */
	if in.Status == "2" {
		a.db.Exec(`DELETE FROM t_diary_lock WHERE diary_id = ?`, *in.DiaryID)
	} else {
		a.db.Exec(`UPDATE t_diary_lock SET last_active_at = ? WHERE diary_id = ?`, now(), *in.DiaryID)
	}

	after := "下書き保存"
	if in.Status == "2" {
		after = diaryLogApply
	}
	a.log(u.AccountID, fnDiary, opUpdate, "t_diary", in.DiaryID, in.ChildID, s(status), s(after))

	a.writeDiaryByID(w, *in.DiaryID)
}

/*
 * 申請したことを残す操作ログの「変更後」の文言。最後に申請した職員は、これで操作ログから引く（diaryApplicant）。
 * 申請した人は日誌（t_diary）の列に無い。申請と差し戻しの往復の経緯は操作ログで追うと定めているため
 * （基本設計書「日誌（t_diary）」(5-4)）。文言を変えるときは、画面側のモック（web/src/api/mock.ts）も合わせる
 */
const (
	diaryLogApply          = "申請"
	diaryLogCreateAndApply = "作成して申請"
)

// diaryApplicant は、その日誌を最後に申請した職員の職員IDを返す。申請の記録が無ければ空を返す
func (a *app) diaryApplicant(diaryID int64) string {
	var staffID string
	a.db.QueryRow(`SELECT s.staff_id FROM t_operation_log l
		JOIN m_staff s ON s.account_id = l.account_id
		WHERE l.function_type = ? AND l.target_table = 't_diary' AND l.target_id = ?
		  AND l.after_value IN (?, ?)
		ORDER BY l.operation_log_id DESC LIMIT 1`,
		fnDiary, diaryID, diaryLogApply, diaryLogCreateAndApply).Scan(&staffID)
	return staffID
}

// childInClass は、その園児がそのクラスに在籍している（いた）かを返す
func (a *app) childInClass(childID string, classID int64) bool {
	var n int
	err := a.db.QueryRow(`SELECT COUNT(*) FROM t_class_child WHERE class_id = ? AND child_id = ?`,
		classID, childID).Scan(&n)
	return err == nil && n > 0
}

func (a *app) writeDiaryByID(w http.ResponseWriter, id int64) {
	row := a.db.QueryRow(`SELECT `+diaryColumns+` FROM t_diary WHERE diary_id = ?`, id)
	d, err := a.scanDiary(row)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌を読み直せませんでした")
		return
	}
	a.enrich(&d)
	writeJSON(w, http.StatusOK, d)
}

// ---- 承認（管理者のみ） ----

// handlePendingDiaries は承認待ちの一覧を返す
func (a *app) handlePendingDiaries(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	out, err := a.queryDiaries(`SELECT ` + diaryColumns + ` FROM t_diary
		WHERE is_deleted = 0 AND status = '2' ORDER BY updated_at`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "承認待ちを取得できませんでした")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

/*
handleApproveDiary は承認する。

保護者への共有の指定を、承認と同じ操作で受け取る。
承認後に別画面で指定させると共有し忘れが起きるため（画面詳細図 3-3）。
*/
func (a *app) handleApproveDiary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	var req struct {
		ShareToGuardian bool `json:"share_to_guardian"`
	}
	if !readJSON(w, r, &req) {
		return
	}

	var (
		status     string
		childID    sql.NullString
		creator    string
		recordType string
	)
	if err := a.db.QueryRow(`SELECT status, child_id, created_staff_id, record_type FROM t_diary
		WHERE diary_id = ? AND is_deleted = 0`, id).Scan(&status, &childID, &creator, &recordType); err != nil {
		writeErr(w, http.StatusNotFound, "日誌が見つかりません")
		return
	}
	if status != "2" {
		writeErr(w, http.StatusBadRequest, "申請中の日誌のみ承認できます")
		return
	}
	// 共有を選べるのは個人日誌だけ。クラス日誌・週案月案・ヒヤリハットは保護者への共有の対象外とする
	// （基本設計書「日誌システム」(4-5)）。画面（DiaryApproveScreen）は選ばせないが、API でも断る
	// （GitHub Issue #61・#157）。画面側のモック（web/src/api/mock.ts の approveDiary）と同じ規則
	if req.ShareToGuardian && recordType != "1" {
		writeErr(w, http.StatusBadRequest, "保護者へ共有できるのは個人日誌だけです。共有しないで承認してください")
		return
	}
	/*
	 * 自分が申請した日誌は承認できない。承認を「作成者とは別の人による確認」として扱うため
	 * （基本設計書「日誌の作成から保護者への共有」(4-5)。演習上の想定。GitHub Issue #106）。
	 * 作成者だけでなく、最後に申請した職員も見る。担任の下書きを書き直して申請した管理者が、
	 * 自分で承認して保護者へ共有できていた（GitHub Issue #174）。画面側のモック（approveDiary）と同じ規則
	 */
	if creator == u.staff() || a.diaryApplicant(id) == u.staff() {
		writeErr(w, http.StatusBadRequest, "自分が申請した日誌は承認できません。ほかの管理者に承認を依頼してください")
		return
	}

	var sharedAt any
	if req.ShareToGuardian {
		sharedAt = now()
	}
	if _, err := a.db.Exec(`UPDATE t_diary
		SET status = '3', approved_staff_id = ?, approved_at = ?, returned_reason = NULL,
		    is_shared_to_guardian = ?, shared_at = ?, updated_at = ?
		WHERE diary_id = ?`,
		u.staff(), now(), req.ShareToGuardian, sharedAt, now(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "承認に失敗しました")
		return
	}

	after := "承認済み・共有しない"
	if req.ShareToGuardian {
		after = "承認済み・保護者へ共有"
	}
	a.log(u.AccountID, fnDiary, opApprove, "t_diary", i64(id), nullStr(childID), s("申請中"), s(after))

	// 共有する場合、対象園児に紐づく保護者との個人チャットへ送る（基本設計書 4-5）
	if req.ShareToGuardian && childID.Valid {
		a.shareDiaryToGuardian(u, id, childID.String)
	}
	a.writeDiaryByID(w, id)
}

// shareDiaryToGuardian は個人チャットへ日誌の共有として流す（t_chat_message.source_type = 2）。
// 個人チャットは園児ID で引く。部屋の名前で探すと、同じ氏名の別の園児の家庭へ流れる（GitHub Issue #163）
func (a *app) shareDiaryToGuardian(u *SessionUser, diaryID int64, childID string) {
	var roomID int64
	err := a.db.QueryRow(`SELECT chat_room_id FROM m_chat_room
		WHERE room_type = '4' AND child_id = ?`, childID).Scan(&roomID)
	if err != nil {
		// 【要確認】個人チャットが無い場合の共有先が定義されていない（GitHub Issue #61 と同じ論点）
		return
	}
	a.db.Exec(`INSERT INTO t_chat_message
		(chat_room_id, sender_account_id, body, source_type, source_id, sent_at, is_deleted)
		VALUES (?, ?, '日誌を共有しました。', '2', ?, ?, 0)`,
		roomID, u.AccountID, diaryID, now())
}

// handleReturnDiary は差し戻す。理由の入力を必須とする（画面詳細図 3-3）
func (a *app) handleReturnDiary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		writeErr(w, http.StatusBadRequest, "差し戻す理由を入力してください")
		return
	}
	if tooLong(req.Reason, 500) {
		writeErr(w, http.StatusBadRequest, "差し戻す理由は500文字以内で入力してください")
		return
	}

	var (
		status  string
		childID sql.NullString
	)
	if err := a.db.QueryRow(`SELECT status, child_id FROM t_diary WHERE diary_id = ? AND is_deleted = 0`,
		id).Scan(&status, &childID); err != nil {
		writeErr(w, http.StatusNotFound, "日誌が見つかりません")
		return
	}
	if status != "2" {
		writeErr(w, http.StatusBadRequest, "申請中の日誌のみ差し戻せます")
		return
	}

	if _, err := a.db.Exec(`UPDATE t_diary
		SET status = '4', returned_reason = ?, approved_staff_id = ?, updated_at = ?
		WHERE diary_id = ?`, req.Reason, u.staff(), now(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "差し戻しに失敗しました")
		return
	}
	a.log(u.AccountID, fnDiary, opApprove, "t_diary", i64(id), nullStr(childID),
		s("申請中"), s("差し戻し："+req.Reason))

	a.writeDiaryByID(w, id)
}

// ---- 編集ロック（基本設計書「編集ロックの解除」(4-5)、5-4） ----

/*
handleAcquireLock は編集ロックを取得する。

取得のたびにトークンを発行し、保存時に照合する。
他の職員が保持していて無操作の時間内なら、その職員名を返して画面に出す（画面詳細図 3-2）。
*/
func (a *app) handleAcquireLock(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	// ロックを取れるのは、その日誌を参照できる職員に限る。担当外の日誌のロックを取られると、
	// 担任が無操作の経過まで保存できなくなる（GitHub Issue #153）
	if !a.canSeeDiary(u, id) {
		writeForbidden(w, "この日誌を編集する権限がありません")
		return
	}
	idleMinutes := a.settingInt("ui.diary_lock_minutes", 15)

	var (
		heldStaff  sql.NullString
		lastActive sql.NullString
	)
	a.db.QueryRow(`SELECT locked_staff_id, last_active_at FROM t_diary_lock WHERE diary_id = ?`, id).
		Scan(&heldStaff, &lastActive)

	if heldStaff.Valid && heldStaff.String != u.staff() && lastActive.Valid {
		if plusMinutes(lastActive.String, idleMinutes) > now() {
			writeJSON(w, http.StatusOK, map[string]string{"held_by": a.staffName(heldStaff.String)})
			return
		}
	}

	token := "lock-" + strconv.FormatInt(id, 10) + "-" + randomToken(9)
	if _, err := a.db.Exec(`INSERT INTO t_diary_lock (diary_id, lock_token, locked_staff_id, locked_at, last_active_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(diary_id) DO UPDATE SET
		  lock_token = excluded.lock_token,
		  locked_staff_id = excluded.locked_staff_id,
		  locked_at = excluded.locked_at,
		  last_active_at = excluded.last_active_at`,
		id, token, u.staff(), now(), now()); err != nil {
		writeErr(w, http.StatusInternalServerError, "編集ロックを取得できませんでした")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

// handleReleaseLock はロックを解除する。
//
// 管理者が強制解除するとレコードを削除する。
// 保存時にトークンが一致せず、他者の更新が無くても保存が拒否される（基本設計書 5-4）。
//
// 本人の解除（保存せずに離れる・タブを閉じる）は、取得のときに渡した識別子を添えて送らせ、一致するときだけ外す。
// 同じ職員が取り直したあと（確認画面から戻ったとき、開発時に画面を 2 回描いたとき）に、古い識別子の解除が
// 遅れて届いても、取り直したロックを外さないため（GitHub Issue #166）
func (a *app) handleReleaseLock(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	force := r.URL.Query().Get("force") == "true"

	var held, token string
	if err := a.db.QueryRow(`SELECT locked_staff_id, lock_token FROM t_diary_lock WHERE diary_id = ?`, id).
		Scan(&held, &token); err != nil {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	if force && !u.isAdmin() {
		writeForbidden(w, "ロックの強制解除は管理者のみが行えます")
		return
	}
	if !force && (held != u.staff() || token != r.URL.Query().Get("token")) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}

	a.db.Exec(`DELETE FROM t_diary_lock WHERE diary_id = ?`, id)
	if force {
		a.log(u.AccountID, fnDiary, opUpdate, "t_diary_lock", i64(id), nil, s("ロックあり"), s("管理者が強制解除"))
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

/*
handleTouchLock は、編集画面での操作を知らせ、ロックの最終操作時刻（last_active_at）を進める。

無操作の判定は、取得した時刻からではなく最後の操作から数える（基本設計書「編集ロックの解除」(4-5)
「編集画面で一定時間（マスタ値）操作がない場合、自動で解除する」、5-4 last_active_at「無操作の判定に用いる」）。
取得のときにしか進めないと、書き続けていても取得から無操作の時間で切れ、ほかの職員に取られる（GitHub Issue #166 の 3）。
識別子が一致しない（ロックが外れた・ほかの職員へ移った）ときは 409 を返し、画面に解除を知らせる。
*/
func (a *app) handleTouchLock(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	var req struct {
		LockToken string `json:"lock_token"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !a.holdsDiaryLock(u, id, req.LockToken) {
		writeErr(w, http.StatusConflict, "編集ロックが解除されました。内容を再読み込みしてください")
		return
	}
	a.db.Exec(`UPDATE t_diary_lock SET last_active_at = ? WHERE diary_id = ?`, now(), id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

/*
holdsDiaryLock は、その職員が、渡した識別子のロックをいま持っているかを返す。

無操作の時間を過ぎていても、ほかの職員が取り直すまでは、持っていた本人の識別子を有効とみなす
（【仮置き】web/仮置き値.md「日誌の編集ロックの動き」）。無操作の解除は、ほかの職員が取りにきたときに行い
（handleAcquireLock）、そのとき識別子が替わるので、元の編集者の保存は断られる。
*/
func (a *app) holdsDiaryLock(u *SessionUser, diaryID int64, token string) bool {
	if token == "" {
		return false
	}
	var held, current string
	if err := a.db.QueryRow(`SELECT locked_staff_id, lock_token FROM t_diary_lock WHERE diary_id = ?`, diaryID).
		Scan(&held, &current); err != nil {
		return false
	}
	return held == u.staff() && current == token
}

/*
handleLockOf は編集ロックの状態を返す。誰が編集中かは日誌の中身と同じ範囲で見せる（GitHub Issue #153）。

ロックの識別子は返さない。識別子は取得した本人だけが持ち、保存のときに照合するものである（基本設計書
「日誌の作成から保護者への共有」(4-5)）。ほかの人に渡すと、その識別子で編集中の日誌を上書きできてしまう
（GitHub Issue #166 の 2）。画面が使うのは、編集中の職員と最終操作時刻だけである
*/
func (a *app) handleLockOf(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	if !a.canSeeDiary(u, id) {
		writeForbidden(w, "この日誌を参照する権限がありません")
		return
	}
	var staffID, lockedAt, lastActive string
	err := a.db.QueryRow(`SELECT locked_staff_id, locked_at, last_active_at
	                        FROM t_diary_lock WHERE diary_id = ?`, id).
		Scan(&staffID, &lockedAt, &lastActive)
	if err != nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"diary_id":        id,
		"locked_staff_id": staffID,
		"locked_at":       lockedAt,
		"last_active_at":  lastActive,
		"staff_name":      a.staffName(staffID),
	})
}
