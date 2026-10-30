package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"
)

/*
 * 日誌システム（作成・承認・取り下げ・承認の取り消し・編集ロック）
 * 典拠：基本設計書.md「日誌システム（園内の記録）」(4-6)・「編集ロックの解除」(4-5)
 *      詳細設計書.md「日誌の状態」(3-6)・「日誌」(4-13)
 *      図/画面詳細図.md「日誌作成・編集画面」(3-2)・「日誌承認画面（管理者）」(3-3)
 * 日誌は園内の記録であり、どの状態でも保護者には届かない
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
	/*
	 * 日誌に付ける写真。保存のたびに、この並びで日誌の写真（t_diary_attachment）を置き換える。
	 * 送られなかった（null）ときは、付いている写真に触らない。空の並びは「写真なし」として、すべて外す
	 * （【仮置き】web/仮置き値.md「日誌作成・編集画面の動き」。GitHub Issue #175 の 2）
	 */
	Attachments *[]diaryAttachmentInput `json:"attachments"`
	/*
	 * ヒヤリハットの欄（詳細設計書「日誌」(4-13 (1))）。ヒヤリハットのときは本文（body）の代わりにこれを受け取り、
	 * 状況・とった対応・今後の対策を見出しでつないだ本文をサーバが作る（D-33。api_diary_incident.go）。
	 * ほかの記録種別では読まない
	 */
	Incident *diaryIncidentInput `json:"incident"`
	/*
	 * 保護者へ共有する（api_diary_share.go）。個人日誌だけが持ち、ほかの記録種別では送られても共有しない。
	 * 送られなかった（null）ときは、新しく作るなら共有しない、書き換えるなら今の値のままにする
	 */
	ShareToGuardian *bool `json:"share_to_guardian"`
}

// diaryAttachmentInput は、日誌に付ける写真 1 枚。実体は持たず、ファイルの名前と形式だけを受け取る
// （web/仮置き値.md 7「添付ファイルの実体」）
type diaryAttachmentInput struct {
	FilePath string `json:"file_path"`
	FileType string `json:"file_type"`
}

/*
checkDiaryAttachments は、日誌に付ける写真を確かめ、断る理由を返す（問題が無ければ空を返す）。

写真は設定マスタの上限（attachment.max_count_diary、既定 3 枚）まで、形式は attachment.allowed_types（JPEG・PNG）に限る
（基本設計書「雛形・添付」(5-4)「t_diary_attachment｜1〜3枚」・「設定マスタ」(5-8)、
図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目10）。文言は【仮置き】（メッセージ一覧 (4-9) に写真の行が無い）。
画面側のモック（web/src/api/mock.ts の diaryAttachmentError）と同じ規則
*/
func (a *app) checkDiaryAttachments(list []diaryAttachmentInput) string {
	max := a.settingInt("attachment.max_count_diary", 3)
	if len(list) > max {
		return "写真は" + itoa64(int64(max)) + "枚までです"
	}
	// 設定マスタの並びに空白が混じっていても（「image/jpeg, image/png」）、並べた形式を受け付ける
	allowed := strings.Split(a.settingText("attachment.allowed_types", "image/jpeg,image/png"), ",")
	for i := range allowed {
		allowed[i] = strings.TrimSpace(allowed[i])
	}
	for _, p := range list {
		if strings.TrimSpace(p.FilePath) == "" {
			return "写真のファイルを選んでください"
		}
		if !oneOf(p.FileType, allowed...) {
			return "添付できる写真は JPEG・PNG のファイルです"
		}
	}
	return ""
}

// replaceDiaryAttachments は、日誌の写真を渡した並びで置き換える。日誌の保存と同じトランザクションの中で呼ぶ
func replaceDiaryAttachments(tx *sql.Tx, diaryID int64, list []diaryAttachmentInput) error {
	if _, err := tx.Exec(`DELETE FROM t_diary_attachment WHERE diary_id = ?`, diaryID); err != nil {
		return err
	}
	for _, p := range list {
		if _, err := tx.Exec(`INSERT INTO t_diary_attachment (diary_id, file_path, file_type) VALUES (?, ?, ?)`,
			diaryID, strings.TrimSpace(p.FilePath), p.FileType); err != nil {
			return err
		}
	}
	return nil
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
	// 本文は1〜2,000文字。ヒヤリハットは本文の代わりに欄で受け取る（詳細設計書「日誌」(4-13 (1))）
	if in.RecordType != "4" {
		if strings.TrimSpace(in.Body) == "" {
			writeErr(w, http.StatusBadRequest, "本文を入力してください")
			return
		}
		if tooLong(in.Body, 2000) {
			writeErr(w, http.StatusBadRequest, "本文は2,000文字以内で入力してください")
			return
		}
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
	/*
	 * 週案・月案だけは365日先まで認める（記録日を「計画の初日」と読む。基本設計書「日付の扱い」(4-6)・
	 * 「入力項目の制約値」(4-9)、図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目6。GitHub Issue #278 の 1）。
	 * 文言は基本設計書「メッセージ一覧」(4-12)・詳細設計書「日誌」(4-13 (1))。モック（saveDiary）と同じ規則
	 */
	if in.RecordType == "3" {
		if in.DiaryDate > addDays(today(), diaryPlanMaxDays) {
			writeErr(w, http.StatusBadRequest, msgDiaryPlanTooFar)
			return
		}
	} else if in.DiaryDate > today() {
		writeErr(w, http.StatusBadRequest, msgDiaryFutureDate)
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
	/*
	 * ヒヤリハットは、発生日時・場所・状況・とった対応・今後の対策・保護者へ伝えたことを欄で受け取る
	 * （詳細設計書「日誌の画面（作り直し）」(2-13 (8))・「日誌」(4-13 (1))）。本文は欄からサーバが作り、
	 * 送られた body は使わない（D-33）。画面側のモック（web/src/api/mock.ts の saveDiary）と同じ規則
	 */
	if in.RecordType == "4" {
		if in.Incident == nil {
			in.Incident = &diaryIncidentInput{}
		}
		normalizeIncident(in.Incident)
		if msg := checkDiaryIncident(in.Incident); msg != "" {
			writeErr(w, http.StatusBadRequest, msg)
			return
		}
		in.Body = incidentBody(in.Incident.Situation, in.Incident.Response, in.Incident.Countermeasure)
	}
	// 写真は、日誌と一緒に保存する。画面で足した写真が日誌に付かず、確認画面の「写真 n 枚」と承認画面が
	// 食い違っていた（GitHub Issue #175 の 2）
	if in.Attachments != nil {
		if msg := a.checkDiaryAttachments(*in.Attachments); msg != "" {
			writeErr(w, http.StatusBadRequest, msg)
			return
		}
	}

	if in.DiaryID != nil {
		a.updateDiary(w, u, in)
		return
	}

	// 日誌と写真は、ひとまとまりで書く。片方だけが残る状態を作らない。
	// 接続は1本のため、トランザクションの中では tx だけを使う
	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
		return
	}
	defer tx.Rollback()
	// 申請（status = 2）のときは、申請した職員と日時を入れる（詳細設計書「日誌」(4-13 (1))）
	at := now()
	var appliedStaff, appliedAt any
	if in.Status == "2" {
		appliedStaff, appliedAt = u.staff(), at
	}
	inc := incidentColumnsOf(in.RecordType, in.Incident)
	share := shareColumnOf(in.RecordType, in.ShareToGuardian, false)
	res, err := tx.Exec(`INSERT INTO t_diary
		(record_type, child_id, class_id, diary_date, body, status, created_staff_id,
		 applied_staff_id, applied_at, occurred_at, place,
		 guardian_notice, guardian_noticed_at, guardian_notice_method, guardian_notice_person,
		 share_to_guardian, is_deleted, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		in.RecordType, in.ChildID, in.ClassID, in.DiaryDate, in.Body, in.Status, u.staff(),
		appliedStaff, appliedAt, inc.occurredAt, inc.place,
		inc.notice, inc.noticedAt, inc.noticeMethod, inc.noticePerson, share, at, at)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
		return
	}
	id, _ := res.LastInsertId()
	if in.Attachments != nil {
		if err := replaceDiaryAttachments(tx, id, *in.Attachments); err != nil {
			writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
		return
	}

	after := "下書き作成"
	if in.Status == "2" {
		after = diaryApplyLogText(true, share)
	}
	a.log(u.AccountID, fnDiary, opCreate, "t_diary", i64(id), in.ChildID, nil, s(after))
	// その日誌を参照できる人の画面（日誌一覧・ダッシュボードの承認待ちなど）へ知らせる（events.go）
	a.notifyDiary(id)

	a.writeDiaryByID(w, id)
}

func (a *app) updateDiary(w http.ResponseWriter, u *SessionUser, in diaryInput) {
	var (
		status, version string
		shared          bool
	)
	if err := a.db.QueryRow(`SELECT status, updated_at, share_to_guardian FROM t_diary WHERE diary_id = ? AND is_deleted = 0`,
		*in.DiaryID).Scan(&status, &version, &shared); err != nil {
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
		writeErr(w, http.StatusConflict, msgDiaryLockReleased)
		return
	}

	// 差し戻す理由は、再申請しても消さない。承認されるまで残し、次に差し戻されたときに上書きする。
	// 承認者が前回の指摘を見ながら確かめられるようにするため（基本設計書「日誌（t_diary）」(5-4)。GitHub Issue #174）
	// 日誌と写真は、ひとまとまりで書く。接続は1本のため、トランザクションの中では tx だけを使う
	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
		return
	}
	defer tx.Rollback()
	// 申請するときは、申請した職員と日時を入れ直す（詳細設計書「日誌の状態」(3-6)）。下書き保存では変えない
	at := now()
	/*
	 * 下書き保存では状態を変えない。差し戻された日誌は差し戻しのまま残す。作成者の一覧とダッシュボードの
	 * 「差し戻された日誌」から消さないため（詳細設計書「日誌の状態」(3-6)、基本設計書「日誌の作成から承認まで」(4-6)、
	 * 図/画面詳細図「日誌作成・編集画面」(3-2) 項目12。GitHub Issue #305 の 1）。画面は下書き保存を status 1 で送る
	 */
	next := in.Status
	if next == "1" && status == "4" {
		next = "4"
	}
	// ヒヤリハットの列は、欄で受け取った値で書き換える。ほかの記録種別に変えたときは空にする
	inc := incidentColumnsOf(in.RecordType, in.Incident)
	share := shareColumnOf(in.RecordType, in.ShareToGuardian, shared)
	if _, err := tx.Exec(`UPDATE t_diary
		SET record_type = ?, child_id = ?, class_id = ?, diary_date = ?, body = ?, status = ?,
		    applied_staff_id = CASE WHEN ? = '2' THEN ? ELSE applied_staff_id END,
		    applied_at = CASE WHEN ? = '2' THEN ? ELSE applied_at END,
		    occurred_at = ?, place = ?,
		    guardian_notice = ?, guardian_noticed_at = ?, guardian_notice_method = ?, guardian_notice_person = ?,
		    share_to_guardian = ?, updated_at = ?
		WHERE diary_id = ?`,
		in.RecordType, in.ChildID, in.ClassID, in.DiaryDate, in.Body, next,
		in.Status, u.staff(), in.Status, at, inc.occurredAt, inc.place,
		inc.notice, inc.noticedAt, inc.noticeMethod, inc.noticePerson,
		share, nextDiaryVersion(version), *in.DiaryID); err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
		return
	}
	if in.Attachments != nil {
		if err := replaceDiaryAttachments(tx, *in.DiaryID, *in.Attachments); err != nil {
			writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
			return
		}
	}

	/*
	 * 申請したらロックを外す。申請中の日誌は編集できず、読むだけの人にロックを持たせない（基本設計書「編集ロックの解除」(4-5)
	 * 「保存…でロックを解除する」）。下書き保存は、編集画面に残って書き続けるため外さず、操作として最終操作時刻を進める
	 * （【仮置き】web/仮置き値.md「日誌の編集ロックの動き」）
	 */
	if in.Status == "2" {
		tx.Exec(`DELETE FROM t_diary_lock WHERE diary_id = ?`, *in.DiaryID)
	} else {
		tx.Exec(`UPDATE t_diary_lock SET last_active_at = ? WHERE diary_id = ?`, now(), *in.DiaryID)
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌の保存に失敗しました")
		return
	}

	after := "下書き保存"
	if in.Status == "2" {
		after = diaryApplyLogText(false, share)
	}
	a.log(u.AccountID, fnDiary, opUpdate, "t_diary", in.DiaryID, in.ChildID, s(status), s(after))
	// 差し戻された日誌の件数・承認待ちの件数が変わりうる（events.go）
	a.notifyDiary(*in.DiaryID)

	a.writeDiaryByID(w, *in.DiaryID)
}

/*
 * 申請したことを残す操作ログの「変更後」の文言（詳細設計書「日誌」(4-13 (1))）。
 * 申請した職員は日誌の列（applied_staff_id）で持つ。古い DB を移すときは、この文言の行から申請者を起こす
 * （db_diary.go。詳細設計書「変える表」(5-3)）。文言を変えるときは、画面側のモック（web/src/api/mock.ts）も合わせる
 */
const (
	diaryLogApply          = "申請"
	diaryLogCreateAndApply = "作成して申請"
	// 保護者へ共有するを選んで申請したとき。操作ログの1行で、共有を選んだことが分かるように
	// （照合 c2b-4 の推し。【仮置き】詳細設計書 3-6 の文に足した。web/仮置き値.md）
	diaryLogApplyShared          = "申請（保護者へ共有）"
	diaryLogCreateAndApplyShared = "作成して申請（保護者へ共有）"
	// 共有していた日誌の承認を取り消したとき、「承認の取り消し」に添える（保護者から見えなくなったことが分かるように。【仮置き】同上）
	diaryLogRevokeSharedNote = "（保護者への共有を止めた）"
)

// diaryApplyLogText は、申請の行の「変更後」の文。共有を選んでいれば「（保護者へ共有）」を付ける
func diaryApplyLogText(created, share bool) string {
	switch {
	case created && share:
		return diaryLogCreateAndApplyShared
	case created:
		return diaryLogCreateAndApply
	case share:
		return diaryLogApplyShared
	}
	return diaryLogApply
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

// handlePendingDiaries は承認待ちの一覧を返す。申請日時の古い順（詳細設計書「日誌の画面（作り直し）」(2-13 (1))
// の承認待ち一覧画面）。同じ時刻は日誌の番号の順にする
func (a *app) handlePendingDiaries(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	diaries, err := a.queryDiaries(`SELECT ` + diaryColumns + ` FROM t_diary
		WHERE is_deleted = 0 AND status = '2' ORDER BY applied_at, diary_id`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "承認待ちを取得できませんでした")
		return
	}
	// 設定を変えたら、次に開いたときから効く。一覧を作るたびに読む
	warnDays := a.settingInt("approval.warn_days", 3)
	out := make([]pendingDiary, len(diaries))
	for i, d := range diaries {
		out[i] = pendingDiary{Diary: d, ElapsedDays: pendingElapsedDays(d.AppliedAt), WarnDays: warnDays}
		out[i].Stale = out[i].ElapsedDays > warnDays
	}
	writeJSON(w, http.StatusOK, out)
}

/*
pendingDiary は、承認待ちの一覧の1行。日誌に、申請からの経過日数と、滞留の印を足す。

経過日数は申請した日から今日までの日数で、warn_days（approval.warn_days。既定 3 日）を越えたら Stale にする。
滞留を見つけるための表示であって、期限の判定ではない（基本設計書「設定マスタ」(5-9)、画面詳細図「承認待ち一覧画面」(3-4) 項目5）。
画面側のモック（web/src/api/mock.ts の pendingDiaries）と同じ規則
*/
type pendingDiary struct {
	Diary
	ElapsedDays int  `json:"elapsed_days"`
	WarnDays    int  `json:"warn_days"`
	Stale       bool `json:"stale"`
}

// pendingElapsedDays は、申請の日時から今日までの日数（暦の日の差）を返す。申請の日時が無い・読めないときは 0
func pendingElapsedDays(appliedAt *string) int {
	if appliedAt == nil || len(*appliedAt) < 10 {
		return 0
	}
	from, err1 := time.ParseInLocation("2006-01-02", (*appliedAt)[:10], jst)
	to, err2 := time.ParseInLocation("2006-01-02", today(), jst)
	if err1 != nil || err2 != nil || to.Before(from) {
		return 0
	}
	return int(to.Sub(from).Hours()/24 + 0.5)
}

// 日誌の状態の遷移で返す文言（詳細設計書「日誌の状態」(3-6)・「日誌」(4-13)）。モック（web/src/api/mock.ts）と同じ
const (
	msgDiaryApproveAdminOnly  = "承認は管理者のみが行えます"
	msgDiaryWithdrawn         = "この日誌は取り下げられました。"
	msgDiaryApproveNotApplied = "申請中の日誌のみ承認できます"
	msgDiaryReturnNotApplied  = "申請中の日誌のみ差し戻せます"
	msgDiaryOwnApplication    = "自分が申請した日誌は承認できません。ほかの管理者に依頼してください。"
	msgDiaryWithdrawOwnOnly   = "申請を取り下げられるのは、申請した本人だけです。"
	msgDiaryWithdrawTooLate   = "すでに承認または差し戻しされたため、取り下げられません。"
	msgDiaryRevokeAdminOnly   = "承認の取り消しは管理者のみが行えます。"
	msgDiaryRevokeReason      = "承認を取り消す理由を入力してください。"
	msgDiaryRevokeReasonLong  = "承認を取り消す理由は500文字以内で入力してください。"
	msgDiaryNotApproved       = "承認済みの日誌ではありません。画面を読み込み直してください。"
	msgDiaryVersionConflict   = "他の職員が更新しています。内容を再読み込みしてください。"
	// 基本設計書「メッセージ一覧」(4-12) の日誌の文言（句点まで）。GitHub Issue #278 の 5
	msgDiaryLockReleased = "編集ロックが解除されました。内容を再読み込みしてください。"
	msgDiaryFutureDate   = "記録日に未来の日付は指定できません。"
	// 詳細設計書「日誌」(4-13 (1))（本書で足す文言）
	msgDiaryPlanTooFar = "週案・月案の記録日は365日先までです。"
)

// diaryPlanMaxDays は、週案・月案の記録日を先の日付にできる日数（基本設計書「日付の扱い」(4-6)）
const diaryPlanMaxDays = 365

// requireAdminFor は管理者だけを通す。管理者でなければ、その操作の文言で 403 を返す
func (a *app) requireAdminFor(w http.ResponseWriter, r *http.Request, message string) (*SessionUser, bool) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return nil, false
	}
	if !u.isAdmin() {
		writeForbidden(w, message)
		return nil, false
	}
	return u, true
}

// diaryStatusOf は日誌のいまの状態を返す。無ければ空
func (a *app) diaryStatusOf(id int64) string {
	var status string
	a.db.QueryRow(`SELECT status FROM t_diary WHERE diary_id = ? AND is_deleted = 0`, id).Scan(&status)
	return status
}

// notAppliedMessage は、申請中でない日誌を承認・差し戻ししようとしたときの 409 の文言を返す。
// 下書きなら、申請が取り下げられたあとに届いた操作である（詳細設計書「日誌の状態」(3-6)）
func notAppliedMessage(status, otherwise string) string {
	if status == "1" {
		return msgDiaryWithdrawn
	}
	return otherwise
}

/*
nextDiaryVersion は、日誌を書き換えるときの新しい updated_at を返す。

読んだ版（updated_at）で取り下げ・承認の取り消しを確かめるため、書くたびに必ず前の値より進める。
同じ秒のうちに2回書き換えても別の版になる（詳細設計書「足す表」(5-2) の決めたこと D-40）。
今の時刻が前の値より後なら今の時刻、そうでなければ前の値の1秒後にする
*/
func nextDiaryVersion(previous string) string { return nextVersion(previous) }

/*
handleApproveDiary は承認する（基本設計書「日誌システム（園内の記録）」(4-6)、詳細設計書「日誌」(4-13 (2))）。

保育士が申請するときに「保護者へ共有する」を選んだ個人日誌は、承認すると、その園児の保護者が読めるようになる。
保育士の申請と管理者の承認の2つがそろって共有になる（2026-10-29 に持ち主が決めた。api_diary_share.go）。
共有するかは申請した保育士が決め、管理者は承認か差し戻しで答える。要求から読むのは、管理者が画面で読んだ版
（updated_at）だけ（承認の要求に share_to_guardian が送られても使わない）。

読んだ版が今の版と違えば 409（取り下げ・承認の取り消しと同じ。詳細設計書「足す表」(5-2) の決めたこと D-40）。
承認画面を開いているあいだに、保育士が取り下げて本文・園児・「保護者へ共有する」を変えて申請し直すと、
状態は申請中に戻るため、状態だけでは見分けられない。版を見ないと、管理者が読んでいない本文が、
共有と知らないまま保護者へ届く（基本設計書「日誌システム（園内の記録）」(4-6)「管理者が日誌承認画面で内容を確認し」）
*/
func (a *app) handleApproveDiary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdminFor(w, r, msgDiaryApproveAdminOnly)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	var req diaryVersionInput
	if !readJSON(w, r, &req) {
		return
	}
	var (
		status    string
		childID   sql.NullString
		applicant sql.NullString
		version   string
		shared    bool
	)
	if err := a.db.QueryRow(`SELECT status, child_id, applied_staff_id, updated_at, share_to_guardian FROM t_diary
		WHERE diary_id = ? AND is_deleted = 0`, id).Scan(&status, &childID, &applicant, &version, &shared); err != nil {
		writeErr(w, http.StatusNotFound, "日誌が見つかりません")
		return
	}
	if status != "2" {
		writeErr(w, http.StatusConflict, notAppliedMessage(status, msgDiaryApproveNotApplied))
		return
	}
	/*
	 * 自分が申請した日誌は承認できない。申請者の列（applied_staff_id）で判定する。作成者が管理者でも、
	 * ほかの職員が申請したものは承認できる（詳細設計書「日誌の状態」(3-6)。GitHub Issue #106・#174）。
	 * 画面側のモック（approveDiary）と同じ規則
	 */
	if applicant.Valid && applicant.String == u.staff() {
		writeForbidden(w, msgDiaryOwnApplication)
		return
	}
	if req.UpdatedAt != version {
		writeJSON(w, http.StatusConflict, apiError{Message: msgDiaryVersionConflict, Kind: kindVersionConflict})
		return
	}
	// 状態と版を条件にして書き換え、取り下げ・申請し直しとほぼ同時に押されたときは後に届いたほうを拒む（詳細設計書「日誌の状態」(3-6)）
	at := now()
	res, err := a.db.Exec(`UPDATE t_diary
		SET status = '3', approved_staff_id = ?, approved_at = ?, returned_reason = NULL, updated_at = ?
		WHERE diary_id = ? AND status = '2' AND updated_at = ?`,
		u.staff(), at, nextDiaryVersion(version), id, req.UpdatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "承認に失敗しました")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// 検査のあとに取り下げ・差し戻し・申請し直しが先に済んだ
		if latest := a.diaryStatusOf(id); latest != "2" {
			writeErr(w, http.StatusConflict, notAppliedMessage(latest, msgDiaryApproveNotApplied))
			return
		}
		writeJSON(w, http.StatusConflict, apiError{Message: msgDiaryVersionConflict, Kind: kindVersionConflict})
		return
	}
	after := "承認済み"
	if shared {
		after = diaryLogApproveShared
	}
	a.log(u.AccountID, fnDiary, opApprove, "t_diary", i64(id), nullStr(childID), s("申請中"), s(after))
	// 承認待ちが減る（events.go。日誌の知らせは職員だけ）
	a.notifyDiary(id)
	a.writeDiaryByID(w, id)
}

// handleReturnDiary は差し戻す。理由の入力を必須とする（画面詳細図 3-3）。
// 差し戻した管理者は承認者の列（approved_*）に書かない。承認していない人が「承認の経緯」に出るため。
// 差し戻した管理者は操作ログで辿る（詳細設計書「日誌の状態」(3-6)・「日誌」(4-13 (3))）
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
		version string
	)
	if err := a.db.QueryRow(`SELECT status, child_id, updated_at FROM t_diary WHERE diary_id = ? AND is_deleted = 0`,
		id).Scan(&status, &childID, &version); err != nil {
		writeErr(w, http.StatusNotFound, "日誌が見つかりません")
		return
	}
	if status != "2" {
		writeErr(w, http.StatusConflict, notAppliedMessage(status, msgDiaryReturnNotApplied))
		return
	}

	res, err := a.db.Exec(`UPDATE t_diary SET status = '4', returned_reason = ?, updated_at = ?
		WHERE diary_id = ? AND status = '2'`, req.Reason, nextDiaryVersion(version), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "差し戻しに失敗しました")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusConflict, notAppliedMessage(a.diaryStatusOf(id), msgDiaryReturnNotApplied))
		return
	}
	// 差し戻しは更新（操作区分 2）として残す。承認（3）ではない（詳細設計書「日誌の状態」(3-6)「差し戻す｜…｜1・2」。GitHub Issue #305 の 2）
	a.log(u.AccountID, fnDiary, opUpdate, "t_diary", i64(id), nullStr(childID),
		s("申請中"), s("差し戻し："+req.Reason))
	// 承認待ちが減り、作成者の「差し戻された日誌」が増える（events.go）
	a.notifyDiary(id)

	a.writeDiaryByID(w, id)
}

// diaryVersionInput は、読んだ版を添える操作の要求（取り下げ・承認・承認の取り消し。承認は reason を読まない）
type diaryVersionInput struct {
	Reason    string `json:"reason"`
	UpdatedAt string `json:"updated_at"`
}

/*
handleWithdrawDiary は申請を取り下げ、下書きに戻す（詳細設計書「日誌の状態」(3-6)・「日誌」(4-13 (4))）。

取り下げられるのは申請した本人だけで、申請中（承認・差し戻しの前）のときだけ。読んだ版が今の版と違えば 409。
状態と版を書き換えの文の条件にし、承認・差し戻しとほぼ同時に押されたときは後に届いたほうを拒む。
*/
func (a *app) handleWithdrawDiary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireDiaryStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	var req diaryVersionInput
	if !readJSON(w, r, &req) {
		return
	}
	if !a.canSeeDiary(u, id) {
		writeForbidden(w, msgDiaryForbidden)
		return
	}
	d, err := a.scanDiary(a.db.QueryRow(`SELECT `+diaryColumns+` FROM t_diary WHERE diary_id = ? AND is_deleted = 0`, id))
	if err != nil {
		writeForbidden(w, msgDiaryForbidden)
		return
	}
	// 承認・差し戻しのあとも申請者の列は残るため、本人なら次の状態の検査で 409 になる
	if d.AppliedStaffID == nil || *d.AppliedStaffID != u.staff() {
		writeForbidden(w, msgDiaryWithdrawOwnOnly)
		return
	}
	if d.Status != "2" {
		writeErr(w, http.StatusConflict, msgDiaryWithdrawTooLate)
		return
	}
	if req.UpdatedAt != d.UpdatedAt {
		writeJSON(w, http.StatusConflict, apiError{Message: msgDiaryVersionConflict, Kind: kindVersionConflict})
		return
	}
	res, err := a.db.Exec(`UPDATE t_diary SET status = '1', applied_staff_id = NULL, applied_at = NULL, updated_at = ?
		WHERE diary_id = ? AND status = '2' AND updated_at = ?`, nextDiaryVersion(d.UpdatedAt), id, req.UpdatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "申請を取り下げられませんでした")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// 検査のあとに承認・差し戻しが先に済んだ
		if a.diaryStatusOf(id) != "2" {
			writeErr(w, http.StatusConflict, msgDiaryWithdrawTooLate)
			return
		}
		writeJSON(w, http.StatusConflict, apiError{Message: msgDiaryVersionConflict, Kind: kindVersionConflict})
		return
	}
	appliedAt := ""
	if d.AppliedAt != nil {
		appliedAt = *d.AppliedAt
	}
	a.log(u.AccountID, fnDiary, opUpdate, "t_diary", i64(id), d.ChildID,
		s("申請者："+a.staffName(*d.AppliedStaffID)+"（"+*d.AppliedStaffID+"）・申請日時："+appliedAt), s("取り下げ"))
	// 承認待ちの一覧を開いている管理者の画面から消える（events.go）
	a.notifyDiary(id)
	a.writeDiaryByID(w, id)
}

/*
handleRevokeDiaryApproval は承認を取り消して差し戻す（詳細設計書「日誌の状態」(3-6)・「日誌」(4-13 (5))）。

管理者なら、自分が承認したものも、ほかの管理者が承認したものも取り消せる。理由は必須（500文字）。
承認者・承認日時は空にし、元の値は操作ログに残す（基本設計書「承認の取り消し」(4-6)）。
*/
func (a *app) handleRevokeDiaryApproval(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdminFor(w, r, msgDiaryRevokeAdminOnly)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	var req diaryVersionInput
	if !readJSON(w, r, &req) {
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		writeErr(w, http.StatusBadRequest, msgDiaryRevokeReason)
		return
	}
	if tooLong(reason, 500) {
		writeErr(w, http.StatusBadRequest, msgDiaryRevokeReasonLong)
		return
	}
	d, err := a.scanDiary(a.db.QueryRow(`SELECT `+diaryColumns+` FROM t_diary WHERE diary_id = ? AND is_deleted = 0`, id))
	if err != nil {
		writeErr(w, http.StatusNotFound, "日誌が見つかりません")
		return
	}
	if d.Status != "3" {
		writeErr(w, http.StatusConflict, msgDiaryNotApproved)
		return
	}
	if req.UpdatedAt != d.UpdatedAt {
		writeJSON(w, http.StatusConflict, apiError{Message: msgDiaryVersionConflict, Kind: kindVersionConflict})
		return
	}
	res, err := a.db.Exec(`UPDATE t_diary
		SET status = '4', approved_staff_id = NULL, approved_at = NULL, returned_reason = ?, updated_at = ?
		WHERE diary_id = ? AND status = '3' AND updated_at = ?`,
		reason, nextDiaryVersion(d.UpdatedAt), id, req.UpdatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "承認を取り消せませんでした")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if a.diaryStatusOf(id) != "3" {
			writeErr(w, http.StatusConflict, msgDiaryNotApproved)
			return
		}
		writeJSON(w, http.StatusConflict, apiError{Message: msgDiaryVersionConflict, Kind: kindVersionConflict})
		return
	}
	before := "承認者："
	if d.ApprovedStaffID != nil {
		before += a.staffName(*d.ApprovedStaffID) + "（" + *d.ApprovedStaffID + "）"
	}
	if d.ApprovedAt != nil {
		before += "・承認日時：" + *d.ApprovedAt
	}
	label := "承認の取り消し"
	if d.ShareToGuardian {
		label += diaryLogRevokeSharedNote
	}
	a.log(u.AccountID, fnDiary, opUpdate, "t_diary", i64(id), d.ChildID, s(before), s(label+"："+reason))
	// 作成者の一覧とダッシュボードの「差し戻された日誌」が読み直す（events.go）
	a.notifyDiary(id)
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
	// 基本設計書「編集ロックの解除」(4-5)：申請中・承認済みの日誌にはロックを取得しない。
	var status string
	if err := a.db.QueryRow(`SELECT status FROM t_diary WHERE diary_id = ?`, id).Scan(&status); err != nil || (status != "1" && status != "4") {
		writeForbidden(w, "この日誌は編集できません")
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
		writeErr(w, http.StatusConflict, msgDiaryLockReleased)
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
