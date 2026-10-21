package main

import (
	"database/sql"
	"net/http"
)

/*
 * 日誌システム（参照）
 * 典拠：基本設計書.md「日誌システム」(4-5)
 *      図/画面詳細図.md「日誌一覧画面」(3-1)〜「日誌承認画面」(3-3)
 */

// Diary は日誌（t_diary）。記録種別でテーブルを分けない（基本設計書 5-4）
type Diary struct {
	DiaryID         int64   `json:"diary_id"`
	RecordType      string  `json:"record_type"`
	ChildID         *string `json:"child_id"`
	ClassID         *int64  `json:"class_id"`
	DiaryDate       string  `json:"diary_date"`
	Body            string  `json:"body"`
	Status          string  `json:"status"`
	CreatedStaffID  string  `json:"created_staff_id"`
	ApprovedStaffID *string `json:"approved_staff_id"`
	ApprovedAt      *string `json:"approved_at"`
	// 申請した職員と日時（詳細設計書「日誌の状態」(3-6)）。取り下げると空になる。
	// 「自分が申請した日誌は承認できない」と「取り下げは申請した本人だけ」は、この列で判定する
	AppliedStaffID *string `json:"applied_staff_id"`
	AppliedAt      *string `json:"applied_at"`
	NapAbnormalID  *int64  `json:"nap_abnormal_id"`
	ReturnedReason *string `json:"returned_reason"`
	IsDeleted      bool    `json:"is_deleted"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
	// 画面が使う導出値
	ChildName string `json:"child_name"`
	ClassName string `json:"class_name"`
	StaffName string `json:"staff_name"`
	// 承認の経緯に出す名前（詳細設計書「日誌」(4-13 (6))）
	ApprovedStaffName *string `json:"approved_staff_name"`
	AppliedStaffName  *string `json:"applied_staff_name"`
	// ヒヤリハットの欄。ヒヤリハットのときだけ（詳細設計書「日誌」(4-13 (6))。api_diary_incident.go）
	Incident *DiaryIncident `json:"incident"`
}

const diaryColumns = `diary_id, record_type, child_id, class_id, diary_date, body, status,
	created_staff_id, approved_staff_id, approved_at, applied_staff_id, applied_at,
	nap_abnormal_id, returned_reason, is_deleted, created_at, updated_at,
	occurred_at, place, guardian_notice, guardian_noticed_at, guardian_notice_method, guardian_notice_person`

func (a *app) scanDiary(rows interface{ Scan(...any) error }) (Diary, error) {
	var (
		d            Diary
		childID      sql.NullString
		classID      sql.NullInt64
		appStaff     sql.NullString
		appAt        sql.NullString
		appliedStaff sql.NullString
		appliedAt    sql.NullString
		napID        sql.NullInt64
		reason       sql.NullString
		// ヒヤリハットの列（api_diary_incident.go）
		occurredAt, place, notice, noticedAt, noticeMethod, noticePerson sql.NullString
	)
	err := rows.Scan(&d.DiaryID, &d.RecordType, &childID, &classID, &d.DiaryDate, &d.Body, &d.Status,
		&d.CreatedStaffID, &appStaff, &appAt, &appliedStaff, &appliedAt,
		&napID, &reason, &d.IsDeleted, &d.CreatedAt, &d.UpdatedAt,
		&occurredAt, &place, &notice, &noticedAt, &noticeMethod, &noticePerson)
	if err != nil {
		return d, err
	}
	d.ChildID = nullStr(childID)
	d.ClassID = nullInt(classID)
	d.ApprovedStaffID = nullStr(appStaff)
	d.ApprovedAt = nullStr(appAt)
	d.AppliedStaffID = nullStr(appliedStaff)
	d.AppliedAt = nullStr(appliedAt)
	d.NapAbnormalID = nullInt(napID)
	d.ReturnedReason = nullStr(reason)
	d.Incident = incidentOf(d.RecordType, d.Body, occurredAt, place, notice, noticedAt, noticeMethod, noticePerson)

	return d, nil
}

// enrich は表示用の名前を埋める。
//
// 名前の解決は必ずカーソルを閉じたあとに行う。
// データベースの接続を1本に絞っているため（db.go）、行を読みながら別の問い合わせを
// 投げると接続の取り合いになって止まる。
func (a *app) enrich(d *Diary) {
	d.ChildName = "―"
	if d.ChildID != nil {
		d.ChildName = a.childName(*d.ChildID)
	}
	d.ClassName = "―"
	if d.ClassID != nil {
		d.ClassName = a.className(*d.ClassID)
	}
	d.StaffName = a.staffName(d.CreatedStaffID)
	if d.ApprovedStaffID != nil {
		d.ApprovedStaffName = s(a.staffName(*d.ApprovedStaffID))
	}
	if d.AppliedStaffID != nil {
		d.AppliedStaffName = s(a.staffName(*d.AppliedStaffID))
	}
}

// visibleDiaryCondition は参照範囲の条件を組み立てる。
//
// 個人日誌・ヒヤリハットは対象園児で、クラス日誌・週案は対象クラスで判定する。
// 承認済みであっても参照範囲は広がらない。日誌は園内の記録で、保護者へ返す道を持たない
// （基本設計書「日誌システム（園内の記録）」(4-6)、詳細設計書「日誌」(4-13 (10))）
func (a *app) visibleDiaryCondition(u *SessionUser) (string, []any) {
	switch u.Role {
	case "1":
		return "1 = 1", nil
	case "2":
		if u.ClassID == nil {
			return "1 = 0", nil
		}
		return `((child_id IS NOT NULL AND child_id IN (SELECT child_id FROM t_class_child WHERE class_id = ?))
		         OR (child_id IS NULL AND class_id = ?))`, []any{*u.ClassID, *u.ClassID}
	default:
		return "1 = 0", nil
	}
}

// msgDiaryForbidden は、その日誌を読めないときの文言（既存）。保護者が日誌の経路を呼んだときも同じ文言にする
// （詳細設計書「日誌」(4-13)「保護者が呼んだら 403」）。モック（web/src/api/mock.ts）と同じ
const msgDiaryForbidden = "この日誌を参照する権限がありません"

// requireDiaryStaff は、日誌の経路を職員だけに通す。保護者には 403 を返す（詳細設計書「日誌」(4-13)）。
// 共有日誌閲覧画面を外したため、保護者が日誌を読む経路は無い
func (a *app) requireDiaryStaff(w http.ResponseWriter, r *http.Request) (*SessionUser, bool) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return nil, false
	}
	if !u.isStaff() {
		writeForbidden(w, msgDiaryForbidden)
		return nil, false
	}
	return u, true
}

// canSeeDiary は、その日誌を参照できるかを返す。日誌本体（handleGetDiary）と同じ条件で判定する。
// 無い日誌も「参照できない」とする。あるかどうかを推測させないため
func (a *app) canSeeDiary(u *SessionUser, diaryID int64) bool {
	cond, args := a.visibleDiaryCondition(u)
	args = append(args, diaryID)
	var n int
	err := a.db.QueryRow(`SELECT COUNT(*) FROM t_diary
	                       WHERE is_deleted = 0 AND `+cond+` AND diary_id = ?`, args...).Scan(&n)
	return err == nil && n > 0
}

func (a *app) queryDiaries(q string, args ...any) ([]Diary, error) {
	rows, err := a.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	out := []Diary{}
	for rows.Next() {
		d, err := a.scanDiary(rows)
		if err != nil {
			continue
		}
		out = append(out, d)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range out {
		a.enrich(&out[i])
	}
	return out, nil
}

func (a *app) handleListDiaries(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireDiaryStaff(w, r)
	if !ok {
		return
	}
	cond, args := a.visibleDiaryCondition(u)
	q := `SELECT ` + diaryColumns + ` FROM t_diary WHERE is_deleted = 0 AND ` + cond

	if v := r.URL.Query().Get("record_type"); v != "" {
		q += ` AND record_type = ?`
		args = append(args, v)
	}
	if v, has := queryInt64(r, "class_id"); has {
		// 個人日誌・ヒヤリハットは対象園児の在籍クラスで、クラス日誌・週案は対象クラスで絞る。
		// 参照範囲（visibleDiaryCondition）と同じ考え方にする。対象のクラスで絞ると、以前の版でクラスを空けて
		// 保存した個人日誌が、見られるのに一覧に出なかった（GitHub Issue #174）。モック（listDiaries）と同じ規則
		q += ` AND ((child_id IS NULL AND class_id = ?)
		         OR (child_id IS NOT NULL AND child_id IN (SELECT child_id FROM t_class_child WHERE class_id = ?)))`
		args = append(args, v, v)
	}
	if v := r.URL.Query().Get("status"); v != "" {
		q += ` AND status = ?`
		args = append(args, v)
	}
	// 【仮置き】自分が書いた日誌に絞る。職員ダッシュボードの「差し戻された日誌」（自分が書いたものを数える）から
	// 開いた一覧を、数えた日誌と一致させるため（図/画面詳細図.md「職員ダッシュボード」(2-6) 項目2。GitHub Issue #174）。
	// 日誌一覧画面（3-1）の絞り込みの項目には無い（web/仮置き値.md）
	if r.URL.Query().Get("mine") == "1" && u.isStaff() {
		q += ` AND created_staff_id = ?`
		args = append(args, u.staff())
	}
	if v := r.URL.Query().Get("from"); v != "" {
		q += ` AND diary_date >= ?`
		args = append(args, v)
	}
	if v := r.URL.Query().Get("to"); v != "" {
		q += ` AND diary_date <= ?`
		args = append(args, v)
	}
	q += ` ORDER BY diary_date DESC, diary_id DESC`

	all, err := a.queryDiaries(q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "日誌の一覧を取得できませんでした")
		return
	}
	writeJSON(w, http.StatusOK, page(all, queryInt(r, "page", 1), a.settingInt("paging.diary_per_page", 50)))
}

func (a *app) handleGetDiary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireDiaryStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	cond, args := a.visibleDiaryCondition(u)
	args = append(args, id)

	row := a.db.QueryRow(`SELECT `+diaryColumns+` FROM t_diary
	                       WHERE is_deleted = 0 AND `+cond+` AND diary_id = ?`, args...)
	d, err := a.scanDiary(row)
	if err != nil {
		writeForbidden(w, msgDiaryForbidden)
		return
	}
	a.enrich(&d)
	writeJSON(w, http.StatusOK, d)
}

// handlePastDiaries はその園児の過去の記録を返す。
// 前回の記述を見ながら書けるようにするため（画面詳細図 3-2）。
//
// 職員の編集画面のための経路であり、保護者には使わせない。日誌は園内の記録で、保護者へ返さない
// （詳細設計書「日誌」(4-13)。GitHub Issue #157）
func (a *app) handlePastDiaries(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireDiaryStaff(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canSeeChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	// いま開いている日誌そのものは除く。過去の記録を見ながら書くための欄であるため（GitHub Issue #139・#174）。
	// 除く日誌は exclude で受け取る。モック（pastDiariesOf）と同じ
	exclude, _ := queryInt64(r, "exclude")
	out, err := a.queryDiaries(`SELECT `+diaryColumns+` FROM t_diary
		WHERE is_deleted = 0 AND child_id = ? AND diary_id <> ? ORDER BY diary_date DESC, diary_id DESC`, childID, exclude)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "過去の記録を取得できませんでした")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleTimeline は園児タイムライン画面のための日誌を返す。
// 職員の画面のための経路であり、保護者には使わせない（handlePastDiaries と同じ。GitHub Issue #157）
func (a *app) handleTimeline(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireDiaryStaff(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canSeeChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	out, err := a.queryDiaries(`SELECT `+diaryColumns+` FROM t_diary
		WHERE is_deleted = 0 AND child_id = ? ORDER BY diary_date DESC`, childID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "記録を取得できませんでした")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DiaryTemplate は雛形（m_diary_template）。
// 保護者への共有の既定（default_share_to_guardian）は持たない。日誌は共有しないため（詳細設計書「変える表」(5-3)）
type DiaryTemplate struct {
	DiaryTemplateID int64  `json:"diary_template_id"`
	RecordType      string `json:"record_type"`
	TemplateName    string `json:"template_name"`
	Body            string `json:"body"`
	IsDeleted       bool   `json:"is_deleted"`
}

func (a *app) handleDiaryTemplates(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT diary_template_id, record_type, template_name, body, is_deleted
	                           FROM m_diary_template WHERE is_deleted = 0 ORDER BY diary_template_id`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "雛形を取得できませんでした")
		return
	}
	defer rows.Close()
	out := []DiaryTemplate{}
	for rows.Next() {
		var t DiaryTemplate
		if rows.Scan(&t.DiaryTemplateID, &t.RecordType, &t.TemplateName, &t.Body, &t.IsDeleted) == nil {
			out = append(out, t)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

/*
 * 定型文。雛形とは別に、本文へ挿し込む短文（画面詳細図 3-2）
 *
 * 【仮置き】定型文を保持するテーブルが基本設計書「日誌」(5-4) に定義されていない。
 * 雛形（m_diary_template）は1件で本文全体を差し替えるものであり、粒度が違う。
 * ここでは定数として持っているが、園が編集できる値であるはずで、置き場を決める必要がある。
 *
 * 日誌は園内の保育日誌であり、保護者へは連絡帳で届ける。保護者に向けた文
 * （「ご家庭でも様子を見ていただけますと幸いです。」）は置かない
 * （ナレッジ/決定事項.md 2026-10-18「『日誌』は園内の保育日誌として連絡帳とは別に持ち、保護者へは連絡帳で届ける」、
 * 詳細設計書「デモデータ」(5-5) の m_phrase。PR #216 で設計を直した）。
 * web/src/api/mockDb.ts の fixedPhrases と同じ並びにそろえる
 */
var fixedPhrases = []string{
	"よく食べ、おかわりをしていました。",
	"午睡は落ち着いて入眠できました。",
	"園庭で友だちと関わって遊ぶ姿が見られました。",
	"鼻水が出ていたため、こまめに拭き取りました。",
}

func (a *app) handleDiaryPhrases(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, fixedPhrases)
}

// DiaryAttachment は添付（t_diary_attachment）。1〜3枚（基本設計書 5-4）
type DiaryAttachment struct {
	DiaryAttachmentID int64  `json:"diary_attachment_id"`
	DiaryID           int64  `json:"diary_id"`
	FilePath          string `json:"file_path"`
	FileType          string `json:"file_type"`
}

/*
handleDiaryAttachments は日誌の添付の一覧を返す。

添付も日誌本体と同じ参照範囲に従う。承認済みであっても参照範囲は広がらず、保護者には返さない
（詳細設計書「日誌」(4-13)）。添付には園児の写真が含まれるため、
権限の判定を通してから渡す（同「添付ファイルの実体の保存先」(5-5)）。
件数とファイル名だけでも、担当外の園児の写真があることが分かる（GitHub Issue #153）。
*/
func (a *app) handleDiaryAttachments(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireDiaryStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "日誌の指定が正しくありません")
		return
	}
	if !a.canSeeDiary(u, id) {
		writeForbidden(w, msgDiaryForbidden)
		return
	}
	rows, err := a.db.Query(`SELECT diary_attachment_id, diary_id, file_path, file_type
	                           FROM t_diary_attachment WHERE diary_id = ? ORDER BY diary_attachment_id`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "添付を取得できませんでした")
		return
	}
	defer rows.Close()
	out := []DiaryAttachment{}
	for rows.Next() {
		var x DiaryAttachment
		if rows.Scan(&x.DiaryAttachmentID, &x.DiaryID, &x.FilePath, &x.FileType) == nil {
			out = append(out, x)
		}
	}
	writeJSON(w, http.StatusOK, out)
}
