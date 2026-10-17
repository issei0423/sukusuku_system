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
	DiaryID            int64   `json:"diary_id"`
	RecordType         string  `json:"record_type"`
	ChildID            *string `json:"child_id"`
	ClassID            *int64  `json:"class_id"`
	DiaryDate          string  `json:"diary_date"`
	Body               string  `json:"body"`
	Status             string  `json:"status"`
	CreatedStaffID     string  `json:"created_staff_id"`
	ApprovedStaffID    *string `json:"approved_staff_id"`
	ApprovedAt         *string `json:"approved_at"`
	IsSharedToGuardian bool    `json:"is_shared_to_guardian"`
	SharedAt           *string `json:"shared_at"`
	NapAbnormalID      *int64  `json:"nap_abnormal_id"`
	ReturnedReason     *string `json:"returned_reason"`
	IsDeleted          bool    `json:"is_deleted"`
	CreatedAt          string  `json:"created_at"`
	UpdatedAt          string  `json:"updated_at"`
	// 画面が使う導出値
	ChildName string `json:"child_name"`
	ClassName string `json:"class_name"`
	StaffName string `json:"staff_name"`
	// 確認（承認）した職員の氏名。保護者には職員の名簿を渡さないため、日誌の側に載せる
	ApprovedStaffName *string `json:"approved_staff_name"`
}

const diaryColumns = `diary_id, record_type, child_id, class_id, diary_date, body, status,
	created_staff_id, approved_staff_id, approved_at, is_shared_to_guardian, shared_at,
	nap_abnormal_id, returned_reason, is_deleted, created_at, updated_at`

func (a *app) scanDiary(rows interface{ Scan(...any) error }) (Diary, error) {
	var (
		d        Diary
		childID  sql.NullString
		classID  sql.NullInt64
		appStaff sql.NullString
		appAt    sql.NullString
		sharedAt sql.NullString
		napID    sql.NullInt64
		reason   sql.NullString
	)
	err := rows.Scan(&d.DiaryID, &d.RecordType, &childID, &classID, &d.DiaryDate, &d.Body, &d.Status,
		&d.CreatedStaffID, &appStaff, &appAt, &d.IsSharedToGuardian, &sharedAt,
		&napID, &reason, &d.IsDeleted, &d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		return d, err
	}
	d.ChildID = nullStr(childID)
	d.ClassID = nullInt(classID)
	d.ApprovedStaffID = nullStr(appStaff)
	d.ApprovedAt = nullStr(appAt)
	d.SharedAt = nullStr(sharedAt)
	d.NapAbnormalID = nullInt(napID)
	d.ReturnedReason = nullStr(reason)

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
}

// visibleDiaryCondition は参照範囲の条件を組み立てる。
//
// 個人日誌・ヒヤリハットは対象園児で、クラス日誌・週案は対象クラスで判定する。
// 承認済みであっても参照範囲は広がらない（基本設計書「日誌の作成から保護者への共有」(4-5)）。
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
		if u.GuardianID == nil {
			return "1 = 0", nil
		}
		// 保護者に見えるのは、承認済みかつ共有指定のある自児の個人日誌のみ。
		// クラス日誌・週案月案・ヒヤリハットは保護者への共有の対象外とする（基本設計書「日誌システム」(4-5)）。
		// 共有の印が付いてしまったものがあっても見せない（GitHub Issue #157）
		return `(record_type = '1' AND status = '3' AND is_shared_to_guardian = 1 AND child_id IN
		          (SELECT child_id FROM t_guardian_child WHERE guardian_id = ? AND link_status = '1'))`,
			[]any{*u.GuardianID}
	}
}

// unsharedDiaryMessage は、保護者が見られない日誌を開いたときの文言。
// 自児の共有されていない日誌・他児の日誌・無い日誌を同じ文言にし、あるかどうかを推測させない
// （図/画面詳細図.md「共有日誌閲覧画面」(2-8)「どちらかが欠けていれば『この記録は共有されていません』と示す」）。
// 画面側のモック（web/src/api/mock.ts の getDiary）と同じ文言にしてある
const unsharedDiaryMessage = "この記録は共有されていません"

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
	u, ok := a.requireUser(w, r)
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
		q += ` AND class_id = ?`
		args = append(args, v)
	}
	if v := r.URL.Query().Get("status"); v != "" {
		q += ` AND status = ?`
		args = append(args, v)
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
	u, ok := a.requireUser(w, r)
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
		if u.isGuardian() {
			writeForbidden(w, unsharedDiaryMessage)
			return
		}
		writeForbidden(w, "この日誌を参照する権限がありません")
		return
	}
	a.enrich(&d)
	writeJSON(w, http.StatusOK, d)
}

// handlePastDiaries はその園児の過去の記録を返す。
// 前回の記述を見ながら書けるようにするため（画面詳細図 3-2）。
//
// 職員の編集画面のための経路であり、保護者には使わせない。下書き・申請中・差し戻し（理由を含む）・
// ヒヤリハットまで、共有していない日誌がすべて返るため（基本設計書「権限と利用可能機能」(6-1) ※3
// 「自児のみ、かつ共有されたものに限る」。GitHub Issue #157）。保護者の閲覧は visibleDiaryCondition を通す
func (a *app) handlePastDiaries(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	if !a.canSeeChild(u, childID) {
		writeForbidden(w, "この園児を参照する権限がありません")
		return
	}
	out, err := a.queryDiaries(`SELECT `+diaryColumns+` FROM t_diary
		WHERE is_deleted = 0 AND child_id = ? ORDER BY diary_date DESC, diary_id DESC`, childID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "過去の記録を取得できませんでした")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleTimeline は園児タイムライン画面のための日誌を返す。
// 職員の画面のための経路であり、保護者には使わせない（handlePastDiaries と同じ。GitHub Issue #157）
func (a *app) handleTimeline(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
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
// 保護者共有の既定値を雛形側に持ち、コードに書かない（基本設計書 5-4）
type DiaryTemplate struct {
	DiaryTemplateID        int64  `json:"diary_template_id"`
	RecordType             string `json:"record_type"`
	TemplateName           string `json:"template_name"`
	Body                   string `json:"body"`
	DefaultShareToGuardian bool   `json:"default_share_to_guardian"`
}

func (a *app) handleDiaryTemplates(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireStaff(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT diary_template_id, record_type, template_name, body, default_share_to_guardian
	                           FROM m_diary_template ORDER BY diary_template_id`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "雛形を取得できませんでした")
		return
	}
	defer rows.Close()
	out := []DiaryTemplate{}
	for rows.Next() {
		var t DiaryTemplate
		if rows.Scan(&t.DiaryTemplateID, &t.RecordType, &t.TemplateName, &t.Body, &t.DefaultShareToGuardian) == nil {
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
 */
var fixedPhrases = []string{
	"よく食べ、おかわりをしていました。",
	"午睡は落ち着いて入眠できました。",
	"園庭で友だちと関わって遊ぶ姿が見られました。",
	"鼻水が出ていたため、こまめに拭き取りました。",
	"ご家庭でも様子を見ていただけますと幸いです。",
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

添付も日誌本体と同じ参照範囲に従う。承認済みであっても参照範囲は広がらない
（基本設計書「日誌の作成から保護者への共有」(4-5)）。添付には園児の写真が含まれるため、
権限の判定を通してから渡す（同「添付ファイルの実体の保存先」(5-5)）。
件数とファイル名だけでも、担当外の園児の写真があることが分かる（GitHub Issue #153）。
*/
func (a *app) handleDiaryAttachments(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
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
