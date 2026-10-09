package main

import (
	"database/sql"
	"math/rand"
	"net/http"
	"strconv"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

/*
 * アカウント管理・監査（管理者のみ）
 * 典拠：基本設計書.md「共通基盤：ログインとアカウント」(4-3)・「監査への対応」(6-4)
 *      図/画面詳細図.md「招待コード管理画面」(7-3)
 */

type Account struct {
	AccountID             int64   `json:"account_id"`
	Email                 string  `json:"email"`
	Role                  string  `json:"role"`
	Status                string  `json:"status"`
	IsTempPassword        bool    `json:"is_temp_password"`
	TempPasswordExpiresAt *string `json:"temp_password_expires_at"`
	FailedLoginCount      int     `json:"failed_login_count"`
	LockedUntil           *string `json:"locked_until"`
	TermsVersion          *string `json:"terms_version"`
	CreatedAt             string  `json:"created_at"`
	UpdatedAt             string  `json:"updated_at"`
}

const accountColumns = `account_id, email, role, status, is_temp_password, temp_password_expires_at,
	failed_login_count, locked_until, terms_version, created_at, updated_at`

func scanAccount(row interface{ Scan(...any) error }) (Account, error) {
	var (
		x       Account
		expires sql.NullString
		locked  sql.NullString
		terms   sql.NullString
	)
	err := row.Scan(&x.AccountID, &x.Email, &x.Role, &x.Status, &x.IsTempPassword, &expires,
		&x.FailedLoginCount, &locked, &terms, &x.CreatedAt, &x.UpdatedAt)
	x.TempPasswordExpiresAt = nullStr(expires)
	x.LockedUntil = nullStr(locked)
	x.TermsVersion = nullStr(terms)
	return x, err
}

func (a *app) handleStaffAccounts(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT s.staff_id, s.staff_name, s.created_at, s.updated_at, ` +
		`a.account_id, a.email, a.role, a.status, a.is_temp_password, a.temp_password_expires_at,
		a.failed_login_count, a.locked_until, a.terms_version, a.created_at, a.updated_at
		FROM m_staff s JOIN m_account a ON a.account_id = s.account_id
		ORDER BY s.staff_id`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "職員アカウントを取得できませんでした")
		return
	}
	type staffRow struct {
		Staff struct {
			StaffID   string `json:"staff_id"`
			StaffName string `json:"staff_name"`
			CreatedAt string `json:"created_at"`
			UpdatedAt string `json:"updated_at"`
		} `json:"staff"`
		Account   Account `json:"account"`
		ClassName string  `json:"className"`
		Locked    bool    `json:"locked"`
	}
	out := []staffRow{}
	for rows.Next() {
		var (
			x       staffRow
			expires sql.NullString
			locked  sql.NullString
			terms   sql.NullString
		)
		if rows.Scan(&x.Staff.StaffID, &x.Staff.StaffName, &x.Staff.CreatedAt, &x.Staff.UpdatedAt,
			&x.Account.AccountID, &x.Account.Email, &x.Account.Role, &x.Account.Status,
			&x.Account.IsTempPassword, &expires, &x.Account.FailedLoginCount, &locked, &terms,
			&x.Account.CreatedAt, &x.Account.UpdatedAt) != nil {
			continue
		}
		x.Account.TempPasswordExpiresAt = nullStr(expires)
		x.Account.LockedUntil = nullStr(locked)
		x.Account.TermsVersion = nullStr(terms)
		x.Locked = locked.Valid && locked.String > now()
		out = append(out, x)
	}
	rows.Close()

	for i := range out {
		var name sql.NullString
		a.db.QueryRow(`SELECT c.class_name FROM t_class_staff cs
			JOIN m_class c ON c.class_id = cs.class_id AND c.fiscal_year = ?
			WHERE cs.staff_id = ? LIMIT 1`, fiscalYear, out[i].Staff.StaffID).Scan(&name)
		out[i].ClassName = "―"
		if name.Valid {
			out[i].ClassName = name.String
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// randomPassword は一時パスワードを作る。
// 【仮置き】桁数・文字種は未確定（基本設計書「画面詳細」(3-6)）
func randomPassword() string {
	return "temp" + strconv.Itoa(1000+rand.Intn(9000))
}

// handleReissueTempPassword は一時パスワードを再発行する（基本設計書「一時パスワードの再発行」(4-3)）
func (a *app) handleReissueTempPassword(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, "アカウントの指定が正しくありません")
		return
	}
	temp := randomPassword()
	hash, err := bcrypt.GenerateFromPassword([]byte(temp), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "再発行に失敗しました")
		return
	}
	hours := a.settingInt("auth.temp_password_hours", 48)
	res, err := a.db.Exec(`UPDATE m_account
		SET password_hash = ?, is_temp_password = 1, temp_password_expires_at = ?,
		    failed_login_count = 0, locked_until = NULL, updated_at = ?
		WHERE account_id = ?`, string(hash), fromNowMinutes(hours*60), now(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "再発行に失敗しました")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "アカウントが見つかりません")
		return
	}
	a.log(u.AccountID, fnAccount, opUpdate, "m_account", i64(id), nil, nil, s("一時パスワードを再発行"))
	writeJSON(w, http.StatusOK, map[string]string{"password": temp})
}

// handleUnlockAccount はロックを解除する。管理者は経過を待たず解除できる（基本設計書 5-2）
func (a *app) handleUnlockAccount(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	id, _ := pathInt64(r, "id")
	if _, err := a.db.Exec(`UPDATE m_account SET locked_until = NULL, failed_login_count = 0
		WHERE account_id = ?`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "解除に失敗しました")
		return
	}
	a.log(u.AccountID, fnAccount, opUpdate, "m_account", i64(id), nil, s("ロック中"), s("ロックを解除"))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) handleSetAccountStatus(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	id, _ := pathInt64(r, "id")
	var req struct {
		Status string `json:"status"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if id == u.AccountID {
		writeErr(w, http.StatusBadRequest, "自分のアカウントは停止できません")
		return
	}
	if req.Status != "1" && req.Status != "2" {
		writeErr(w, http.StatusBadRequest, "状態の指定が正しくありません")
		return
	}
	var before, role string
	if err := a.db.QueryRow(`SELECT status, role FROM m_account WHERE account_id = ?`, id).Scan(&before, &role); err != nil {
		writeErr(w, http.StatusNotFound, "アカウントが見つかりません")
		return
	}
	// 保護者のアカウントは、有効な紐づけがゼロになった時点で停止する（基本設計書 5-3）。
	// 紐づけが無いまま再開すると、その規則と合わない状態になる（GitHub Issue #118）
	if req.Status == "1" && role == roleGuardian {
		var active int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_guardian_child gc
			JOIN m_guardian g ON g.guardian_id = gc.guardian_id
			WHERE g.account_id = ? AND gc.link_status = '1'`, id).Scan(&active)
		if active == 0 {
			writeErr(w, http.StatusBadRequest, "有効な紐づけが無いため再開できません。先に紐づけを戻してください")
			return
		}
	}
	if _, err := a.db.Exec(`UPDATE m_account SET status = ?, updated_at = ? WHERE account_id = ?`,
		req.Status, now(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "変更に失敗しました")
		return
	}
	label := func(v string) string {
		if v == "1" {
			return "有効"
		}
		return "停止"
	}
	a.log(u.AccountID, fnAccount, opUpdate, "m_account", i64(id), nil, s(label(before)), s(label(req.Status)))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleCreateStaffAccount は職員アカウントを発行する。
// 職員アカウントは管理者が発行する。自己登録の導線は職員側に置かない（画面詳細図 2-1）。
func (a *app) handleCreateStaffAccount(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		StaffID   string `json:"staff_id"`
		StaffName string `json:"staff_name"`
		Email     string `json:"email"`
		Role      string `json:"role"`
		ClassID   *int64 `json:"class_id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Role == roleGuardian {
		writeErr(w, http.StatusBadRequest, "保護者アカウントは招待コードによる自己登録で作成します")
		return
	}
	// ログインIDはロールをまたいで園内で一意（基本設計書 5-2）
	var dup int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_account WHERE email = ?`, req.Email).Scan(&dup)
	if dup > 0 {
		writeErr(w, http.StatusBadRequest, "そのログインIDはすでに使われています")
		return
	}
	a.db.QueryRow(`SELECT COUNT(*) FROM m_staff WHERE staff_id = ?`, req.StaffID).Scan(&dup)
	if dup > 0 {
		writeErr(w, http.StatusBadRequest, "その職員IDはすでに使われています")
		return
	}

	temp := randomPassword()
	hash, err := bcrypt.GenerateFromPassword([]byte(temp), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "発行に失敗しました")
		return
	}
	hours := a.settingInt("auth.temp_password_hours", 48)

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "発行に失敗しました")
		return
	}
	defer tx.Rollback()

	res, err := tx.Exec(`INSERT INTO m_account
		(email, password_hash, role, status, is_temp_password, temp_password_expires_at,
		 failed_login_count, created_at, updated_at)
		VALUES (?, ?, ?, '1', 1, ?, 0, ?, ?)`,
		req.Email, string(hash), req.Role, fromNowMinutes(hours*60), now(), now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "発行に失敗しました")
		return
	}
	accountID, _ := res.LastInsertId()

	if _, err := tx.Exec(`INSERT INTO m_staff (staff_id, account_id, staff_name, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)`, req.StaffID, accountID, req.StaffName, now(), now()); err != nil {
		writeErr(w, http.StatusInternalServerError, "発行に失敗しました")
		return
	}
	if req.ClassID != nil {
		tx.Exec(`INSERT OR IGNORE INTO t_class_staff (class_id, staff_id) VALUES (?, ?)`, *req.ClassID, req.StaffID)
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "発行に失敗しました")
		return
	}

	a.log(u.AccountID, fnAccount, opCreate, "m_account", i64(accountID), nil, nil,
		s("職員アカウントを発行（"+req.StaffName+"）"))
	writeJSON(w, http.StatusOK, map[string]string{"password": temp})
}

/*
handleUpdateStaffAccount は、発行済みの職員の氏名・ロール・担当クラスを変える。

年度の途中の担任の交代と、発行の誤りの訂正を受ける（GitHub Issue #112）。
ログインIDと職員IDは変えない。記録の作成者として各所から参照されているため。
*/
func (a *app) handleUpdateStaffAccount(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	staffID := r.PathValue("staffID")
	var req struct {
		StaffName string `json:"staff_name"`
		Role      string `json:"role"`
		ClassID   *int64 `json:"class_id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	req.StaffName = strings.TrimSpace(req.StaffName)
	if req.StaffName == "" {
		writeErr(w, http.StatusBadRequest, "氏名を入力してください")
		return
	}
	if req.Role != roleAdmin && req.Role != roleGeneralStaff {
		writeErr(w, http.StatusBadRequest, "ロールの指定が正しくありません")
		return
	}

	var (
		accountID        int64
		oldName, oldRole string
	)
	if err := a.db.QueryRow(`SELECT s.account_id, s.staff_name, a.role FROM m_staff s
		JOIN m_account a ON a.account_id = s.account_id WHERE s.staff_id = ?`, staffID).
		Scan(&accountID, &oldName, &oldRole); err != nil {
		writeErr(w, http.StatusNotFound, "職員が見つかりません")
		return
	}
	// 自分のロールは変えられない。管理者が自分を一般へ下げると、戻せる人がいなくなることがある
	if accountID == u.AccountID && req.Role != oldRole {
		writeErr(w, http.StatusBadRequest, "自分のロールは変更できません")
		return
	}
	oldClass := a.staffClassName(staffID)

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "変更に失敗しました")
		return
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`UPDATE m_staff SET staff_name = ?, updated_at = ? WHERE staff_id = ?`,
		req.StaffName, now(), staffID); err != nil {
		writeErr(w, http.StatusInternalServerError, "変更に失敗しました")
		return
	}
	if _, err := tx.Exec(`UPDATE m_account SET role = ?, updated_at = ? WHERE account_id = ?`,
		req.Role, now(), accountID); err != nil {
		writeErr(w, http.StatusInternalServerError, "変更に失敗しました")
		return
	}
	// 担当クラスの付け替え。当年度ぶんだけを外し、過年度の割り当ては残す（基本設計書 5-3）
	if _, err := tx.Exec(`DELETE FROM t_class_staff WHERE staff_id = ?
		AND class_id IN (SELECT class_id FROM m_class WHERE fiscal_year = ?)`, staffID, fiscalYear); err != nil {
		writeErr(w, http.StatusInternalServerError, "変更に失敗しました")
		return
	}
	if req.ClassID != nil {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO t_class_staff (class_id, staff_id) VALUES (?, ?)`,
			*req.ClassID, staffID); err != nil {
			writeErr(w, http.StatusInternalServerError, "担当クラスの割り当てに失敗しました")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "変更に失敗しました")
		return
	}

	roleLabel := func(v string) string {
		if v == roleAdmin {
			return "管理者"
		}
		return "一般"
	}
	a.log(u.AccountID, fnAccount, opUpdate, "m_account", i64(accountID), nil,
		s(oldName+" / "+roleLabel(oldRole)+" / "+oldClass),
		s(req.StaffName+" / "+roleLabel(req.Role)+" / "+a.staffClassName(staffID)))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// staffClassName は当年度の担当クラス名を返す。無ければ「担当クラスなし」
func (a *app) staffClassName(staffID string) string {
	var name sql.NullString
	a.db.QueryRow(`SELECT c.class_name FROM t_class_staff cs
		JOIN m_class c ON c.class_id = cs.class_id AND c.fiscal_year = ?
		WHERE cs.staff_id = ? LIMIT 1`, fiscalYear, staffID).Scan(&name)
	if name.Valid {
		return name.String
	}
	return "担当クラスなし"
}

func (a *app) handleAllAccounts(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT account_id, role FROM m_account ORDER BY account_id`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "アカウントを取得できませんでした")
		return
	}
	type row struct {
		AccountID int64  `json:"account_id"`
		Name      string `json:"name"`
		Role      string `json:"role"`
	}
	out := []row{}
	for rows.Next() {
		var x row
		if rows.Scan(&x.AccountID, &x.Role) == nil {
			out = append(out, x)
		}
	}
	rows.Close()
	for i := range out {
		out[i].Name = a.accountName(out[i].AccountID)
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- 招待コード（要件定義書「招待コードの発行」(4-1-2)、図/画面詳細図.md 7-3） ----
//
// 1枚のコードは1アカウントの登録にのみ使える。両親それぞれに配るなら2枚を発行する。

// randomCode は推測困難な値を作る（基本設計書 5-2）。
// 紛らわしい文字（I・O・0・1）を除いた集合を使う。配布物の読み違いを避けるため。
func randomCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	block := func() string {
		var b strings.Builder
		for i := 0; i < 4; i++ {
			b.WriteByte(alphabet[rand.Intn(len(alphabet))])
		}
		return b.String()
	}
	return block() + "-" + block() + "-" + block()
}

func (a *app) handleInvitationCodes(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	q := `SELECT c.invitation_code_id, c.code, c.child_id, c.expires_on, c.status,
		c.issued_staff_id, c.created_at,
		(SELECT class_id FROM t_class_child WHERE child_id = c.child_id LIMIT 1)
		FROM t_invitation_code c WHERE 1 = 1`
	args := []any{}
	if v := r.URL.Query().Get("status"); v != "" {
		q += ` AND c.status = ?`
		args = append(args, v)
	}
	rows, err := a.db.Query(q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "招待コードを取得できませんでした")
		return
	}
	type row struct {
		InvitationCodeID int64  `json:"invitation_code_id"`
		Code             string `json:"code"`
		ChildID          string `json:"child_id"`
		ExpiresOn        string `json:"expires_on"`
		Status           string `json:"status"`
		IssuedStaffID    string `json:"issued_staff_id"`
		CreatedAt        string `json:"created_at"`
		ClassID          *int64 `json:"class_id"`
		ChildName        string `json:"child_name"`
		IssuedStaffName  string `json:"issued_staff_name"`
		Expired          bool   `json:"expired"`
	}
	all := []row{}
	for rows.Next() {
		var (
			x       row
			classID sql.NullInt64
		)
		if rows.Scan(&x.InvitationCodeID, &x.Code, &x.ChildID, &x.ExpiresOn, &x.Status,
			&x.IssuedStaffID, &x.CreatedAt, &classID) == nil {
			x.ClassID = nullInt(classID)
			x.Expired = x.Status == "1" && x.ExpiresOn < today()
			all = append(all, x)
		}
	}
	rows.Close()

	filterClass, hasClass := queryInt64(r, "class_id")
	out := []row{}
	for _, x := range all {
		if hasClass && (x.ClassID == nil || *x.ClassID != filterClass) {
			continue
		}
		x.ChildName = a.childName(x.ChildID)
		x.IssuedStaffName = a.staffName(x.IssuedStaffID)
		out = append(out, x)
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) handleIssueInvitationCodes(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		ClassID   int64 `json:"class_id"`
		PerChild  int   `json:"per_child"`
		ValidDays int   `json:"valid_days"`
		// 使えるコード（未使用・期限内）をすでに持つ園児にも発行するか。
		// 既定では飛ばす。配り直しのつもりが無いのに枚数が増えるのを防ぐ（GitHub Issue #122）
		IncludeExisting bool `json:"include_existing"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.PerChild < 1 {
		writeErr(w, http.StatusBadRequest, "1名あたりの枚数は1以上で指定してください")
		return
	}
	if !validInvitationDays(req.ValidDays) {
		writeErr(w, http.StatusBadRequest, invitationDaysMessage)
		return
	}
	rows, err := a.db.Query(`SELECT cc.child_id FROM t_class_child cc
		JOIN m_child c ON c.child_id = cc.child_id
		WHERE cc.class_id = ? AND c.is_deleted = 0 AND c.enrollment_status = '1'`, req.ClassID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "園児を取得できませんでした")
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()

	issued, skipped := 0, 0
	for _, childID := range ids {
		if !req.IncludeExisting && a.usableCodeCount(childID) > 0 {
			skipped++
			continue
		}
		for i := 0; i < req.PerChild; i++ {
			if _, err := a.db.Exec(`INSERT INTO t_invitation_code
				(code, child_id, expires_on, status, issued_staff_id, created_at)
				VALUES (?, ?, ?, '1', ?, ?)`,
				randomCode(), childID, addDays(today(), req.ValidDays), u.staff(), now()); err == nil {
				issued++
			}
		}
	}
	a.log(u.AccountID, fnAccount, opCreate, "t_invitation_code", nil, nil, nil,
		s(a.className(req.ClassID)+" へ "+strconv.Itoa(issued)+" 枚を一括発行"))
	writeJSON(w, http.StatusOK, map[string]int{"issued": issued, "skipped": skipped})
}

// 【仮置き】招待コードの有効日数は 1〜365 日とする。0 や負の値を通すと、発行した時点で
// 期限切れ・当日期限のコードができる（GitHub Issue #100）。設計に上下限の定めは無い。
const (
	invitationDaysMin     = 1
	invitationDaysMax     = 365
	invitationDaysMessage = "有効期限は 1〜365 日で指定してください"
)

func validInvitationDays(days int) bool {
	return days >= invitationDaysMin && days <= invitationDaysMax
}

// usableCodeCount は、その園児がいま使えるコード（未使用・期限内）の枚数を返す
func (a *app) usableCodeCount(childID string) int {
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_invitation_code
		WHERE child_id = ? AND status = '1' AND expires_on >= ?`, childID, today()).Scan(&n)
	return n
}

func (a *app) handleIssueOneInvitationCode(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		ChildID   string `json:"child_id"`
		ValidDays int    `json:"valid_days"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !validInvitationDays(req.ValidDays) {
		writeErr(w, http.StatusBadRequest, invitationDaysMessage)
		return
	}
	code := randomCode()
	if _, err := a.db.Exec(`INSERT INTO t_invitation_code
		(code, child_id, expires_on, status, issued_staff_id, created_at)
		VALUES (?, ?, ?, '1', ?, ?)`,
		code, req.ChildID, addDays(today(), req.ValidDays), u.staff(), now()); err != nil {
		writeErr(w, http.StatusInternalServerError, "発行に失敗しました")
		return
	}
	a.log(u.AccountID, fnAccount, opCreate, "t_invitation_code", nil, s(req.ChildID), nil, s("招待コードを発行"))
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
}

func (a *app) handleRevokeInvitationCode(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	id, _ := pathInt64(r, "id")
	var status, childID string
	if err := a.db.QueryRow(`SELECT status, child_id FROM t_invitation_code WHERE invitation_code_id = ?`,
		id).Scan(&status, &childID); err != nil {
		writeErr(w, http.StatusNotFound, "招待コードが見つかりません")
		return
	}
	if status == "2" {
		writeErr(w, http.StatusBadRequest, "使用済みの招待コードは失効できません")
		return
	}
	a.db.Exec(`UPDATE t_invitation_code SET status = '3' WHERE invitation_code_id = ?`, id)
	a.log(u.AccountID, fnAccount, opUpdate, "t_invitation_code", i64(id), s(childID), s("未使用"), s("失効"))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- 保護者アカウント管理 ----

func (a *app) handleGuardianAccounts(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	rows, err := a.db.Query(`SELECT g.guardian_id, g.account_id, g.guardian_name, g.phone_number,
		g.created_at, g.updated_at, ` + accountColumnsPrefixed + `
		FROM m_guardian g JOIN m_account a ON a.account_id = g.account_id
		ORDER BY g.guardian_id`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "保護者アカウントを取得できませんでした")
		return
	}
	type link struct {
		GuardianID string  `json:"guardian_id"`
		ChildID    string  `json:"child_id"`
		Relation   string  `json:"relationship"`
		LinkStatus string  `json:"link_status"`
		LinkedAt   string  `json:"linked_at"`
		EndedAt    *string `json:"ended_at"`
		ChildName  string  `json:"child_name"`
	}
	type row struct {
		Guardian struct {
			GuardianID   string  `json:"guardian_id"`
			AccountID    int64   `json:"account_id"`
			GuardianName string  `json:"guardian_name"`
			PhoneNumber  *string `json:"phone_number"`
			CreatedAt    string  `json:"created_at"`
			UpdatedAt    string  `json:"updated_at"`
		} `json:"guardian"`
		Account     Account `json:"account"`
		Links       []link  `json:"links"`
		ActiveLinks int     `json:"activeLinks"`
		TermsAgreed bool    `json:"termsAgreed"`
	}
	out := []row{}
	for rows.Next() {
		var (
			x       row
			phone   sql.NullString
			expires sql.NullString
			locked  sql.NullString
			terms   sql.NullString
		)
		if rows.Scan(&x.Guardian.GuardianID, &x.Guardian.AccountID, &x.Guardian.GuardianName, &phone,
			&x.Guardian.CreatedAt, &x.Guardian.UpdatedAt,
			&x.Account.AccountID, &x.Account.Email, &x.Account.Role, &x.Account.Status,
			&x.Account.IsTempPassword, &expires, &x.Account.FailedLoginCount, &locked, &terms,
			&x.Account.CreatedAt, &x.Account.UpdatedAt) != nil {
			continue
		}
		x.Guardian.PhoneNumber = nullStr(phone)
		x.Account.TempPasswordExpiresAt = nullStr(expires)
		x.Account.LockedUntil = nullStr(locked)
		x.Account.TermsVersion = nullStr(terms)
		x.TermsAgreed = terms.Valid && terms.String == a.currentTermsVersion
		x.Links = []link{}
		out = append(out, x)
	}
	rows.Close()

	for i := range out {
		lr, err := a.db.Query(`SELECT guardian_id, child_id, IFNULL(relationship,''), link_status, linked_at, ended_at
			FROM t_guardian_child WHERE guardian_id = ? ORDER BY child_id`, out[i].Guardian.GuardianID)
		if err != nil {
			continue
		}
		ls := []link{}
		for lr.Next() {
			var (
				l     link
				ended sql.NullString
			)
			if lr.Scan(&l.GuardianID, &l.ChildID, &l.Relation, &l.LinkStatus, &l.LinkedAt, &ended) == nil {
				l.EndedAt = nullStr(ended)
				ls = append(ls, l)
			}
		}
		lr.Close()
		for j := range ls {
			ls[j].ChildName = a.childName(ls[j].ChildID)
			if ls[j].LinkStatus == "1" {
				out[i].ActiveLinks++
			}
		}
		out[i].Links = ls
	}
	writeJSON(w, http.StatusOK, out)
}

const accountColumnsPrefixed = `a.account_id, a.email, a.role, a.status, a.is_temp_password,
	a.temp_password_expires_at, a.failed_login_count, a.locked_until, a.terms_version,
	a.created_at, a.updated_at`

/*
handleEndGuardianLink は紐づけを終了する。

紐づけ単位で終了させる。
アカウントの停止は有効な紐づけがゼロになった時点（基本設計書 5-3）。
*/
func (a *app) handleEndGuardianLink(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		GuardianID string `json:"guardian_id"`
		ChildID    string `json:"child_id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	res, err := a.db.Exec(`UPDATE t_guardian_child SET link_status = '2', ended_at = ?
		WHERE guardian_id = ? AND child_id = ? AND link_status = '1'`, now(), req.GuardianID, req.ChildID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "解除に失敗しました")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "有効な紐づけが見つかりません")
		return
	}

	var remaining int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_guardian_child
		WHERE guardian_id = ? AND link_status = '1'`, req.GuardianID).Scan(&remaining)

	after := "終了"
	if remaining == 0 {
		a.db.Exec(`UPDATE m_account SET status = '2', updated_at = ?
			WHERE account_id = (SELECT account_id FROM m_guardian WHERE guardian_id = ?)`,
			now(), req.GuardianID)
		after = "終了（有効な紐づけがゼロのためアカウントを停止）"
	}
	// 紐づけの表は数値の主キーを持たない。相手が分かるよう、保護者のアカウントを対象として残す
	a.log(u.AccountID, fnAccount, opUpdate, "t_guardian_child", a.guardianAccountID(req.GuardianID),
		s(req.ChildID), s("有効"), s(after))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) guardianAccountID(guardianID string) *int64 {
	var id sql.NullInt64
	a.db.QueryRow(`SELECT account_id FROM m_guardian WHERE guardian_id = ?`, guardianID).Scan(&id)
	return nullInt(id)
}

/*
handleRestoreGuardianLink は、解除した紐づけを戻す。

誤って解除したときの戻し先。解除によってアカウントが停止していた場合は、あわせて再開する
（GitHub Issue #118）。
*/
func (a *app) handleRestoreGuardianLink(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var req struct {
		GuardianID string `json:"guardian_id"`
		ChildID    string `json:"child_id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	res, err := a.db.Exec(`UPDATE t_guardian_child SET link_status = '1', ended_at = NULL
		WHERE guardian_id = ? AND child_id = ? AND link_status = '2'`, req.GuardianID, req.ChildID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "紐づけを戻せませんでした")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "終了した紐づけが見つかりません")
		return
	}

	after := "有効"
	accountID := a.guardianAccountID(req.GuardianID)
	if accountID != nil {
		var status string
		a.db.QueryRow(`SELECT status FROM m_account WHERE account_id = ?`, *accountID).Scan(&status)
		if status == "2" {
			a.db.Exec(`UPDATE m_account SET status = '1', updated_at = ? WHERE account_id = ?`, now(), *accountID)
			after = "有効（アカウントを再開）"
		}
	}
	a.log(u.AccountID, fnAccount, opUpdate, "t_guardian_child", accountID, s(req.ChildID), s("終了"), s(after))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
