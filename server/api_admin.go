package main

import (
	"crypto/rand"
	"database/sql"
	"log"
	"math/big"
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

/*
randomPassword は一時パスワードを作る。

以前は「temp」＋4桁（9000通り）で、ログインIDが分かれば総当たりの範囲がはっきりしていた（GitHub Issue #236）。
暗号に使える乱数（crypto/rand）で、4 文字ずつハイフンでつないだ 12 文字とする（例：k7dm-x3pa-9hzt）。

打ちやすさのため、次のようにしている。管理者が口頭や手渡しで伝え、本人が手で打つため。
  - 英小文字と数字だけ。Shift を押さずに打て、大文字・小文字の取り違えも起きない
  - 紛らわしい文字（i・l・o・0・1）は使わない
  - 4 文字ずつに区切り、読み上げ・書き写しで位置を見失わないようにする
文字は 31 種 × 12 文字（約 59 ビット）あり、ロックと送信元ごとの上限の下では総当たりで当たらない。

【仮置き】桁数・文字種は未確定（基本設計書「画面詳細」(3-6)）
*/
func randomPassword() string {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
	return randomFrom(alphabet, 4) + "-" + randomFrom(alphabet, 4) + "-" + randomFrom(alphabet, 4)
}

// randomFrom は、alphabet の文字を暗号に使える乱数で n 個選んで並べる。
// 推測されてはならない値（一時パスワード・招待コード）に使う。math/rand は推測できないことを保証しない
func randomFrom(alphabet string, n int) string {
	max := big.NewInt(int64(len(alphabet)))
	b := make([]byte, n)
	for i := range b {
		k, err := rand.Int(rand.Reader, max)
		if err != nil {
			// 乱数が取れない状態で推測しやすい値を返すわけにはいかない（session.go の randomToken と同じ）
			log.Fatalf("乱数を生成できません: %v", err)
		}
		b[i] = alphabet[k.Int64()]
	}
	return string(b)
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
	hash, err := hashPassword(temp)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "再発行に失敗しました")
		return
	}
	hours := a.settingInt("auth.temp_password_hours", 48)
	res, err := a.db.Exec(`UPDATE m_account
		SET password_hash = ?, is_temp_password = 1, temp_password_expires_at = ?,
		    failed_login_count = 0, locked_until = NULL, updated_at = ?
		WHERE account_id = ?`, hash, fromNowMinutes(hours*60), now(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "再発行に失敗しました")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "アカウントが見つかりません")
		return
	}
	/*
	 * 再発行の時点で旧パスワードを無効化する（基本設計書「一時パスワードの再発行」(4-3)）。旧パスワードで入った
	 * ログイン中のセッションも同じ扱いにして切る（GitHub Issue #159）。管理者が自分のものを再発行したときは、
	 * 操作した端末だけを残す（パスワードの変更へ進ませるため。session.go の requireUser）
	 */
	keep := ""
	if id == u.AccountID {
		keep = sessionID(r)
	}
	a.sessions.destroyAccount(id, keep)
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
	/*
	 * 相手の状態を確かめてから解除する。無いアカウント・ロックされていないアカウントへの解除を通すと、
	 * 操作ログに事実と違う「変更前：ロック中」が残る（GitHub Issue #166 の 6）。画面は、ロック中の行にだけ
	 * 「ロック解除」を出す（職員アカウント管理画面）
	 */
	var lockedUntil sql.NullString
	if err := a.db.QueryRow(`SELECT locked_until FROM m_account WHERE account_id = ?`, id).Scan(&lockedUntil); err != nil {
		writeErr(w, http.StatusNotFound, "アカウントが見つかりません")
		return
	}
	if !lockedUntil.Valid || lockedUntil.String <= now() {
		writeErr(w, http.StatusBadRequest, "このアカウントはロックされていません")
		return
	}
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
	// 保護者アカウントを管理者が手で停止・再開する操作は設けない。止めるときは紐づけの解除、戻すときは紐づけを戻す
	// （基本設計書「アカウントの停止と再開」(4-3)、図/画面詳細図「保護者アカウント管理画面」(7-8) 項目5「置かない」）。
	// 職員の停止・再開（職員アカウント管理画面）はこの経路を使うので、経路は残して保護者だけを断る
	if role == roleGuardian {
		writeErr(w, http.StatusBadRequest, "保護者のアカウントは手で停止・再開できません。紐づけの解除と、紐づけを戻す操作で行ってください")
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "変更に失敗しました")
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE m_account SET status = ?, updated_at = ? WHERE account_id = ?`,
		req.Status, now(), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "変更に失敗しました")
		return
	}
	// 職員は、停止で園全体・職員・クラス・個人チャットから外れ、再開で戻る。職員チャットの参加は
	// 職員アカウントの作成・停止に連動する（基本設計書「チャット」(5-5)、GitHub Issue #162）。
	// 保護者には何もしない（職員でないアカウントは syncStaffChatRooms が飛ばす）
	if _, err := syncStaffChatRooms(tx, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "変更に失敗しました")
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "変更に失敗しました")
		return
	}
	// 停止したアカウントはログインできない（要件定義書、画面詳細図 7-8 項目5）。ログイン中のセッションもその場で切る。
	// サーバ側にセッションを持つのは、即座に無効化できるためである（基本設計書「認証情報の保持方式」(6-3)。GitHub Issue #159）
	if req.Status == accountSuspended {
		a.sessions.destroyAccount(id, "")
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
	/*
	 * 入力の検証。保護者の自己登録（api_auth.go の handleSignUpGuardian）と同じく、前後の空白を除いてから
	 * 必須・桁数・形式を確かめる（基本設計書「入力項目の制約値」(4-9)「ログインID（メールアドレス）254文字以内、
	 * メールアドレス形式」「氏名 各50文字以内」「園児ID・職員ID 20文字以内」）。前後の空白を残すと、空白なしで
	 * 打ってもログインできないアカウントができる（GitHub Issue #167 の 1）
	 */
	req.StaffID = strings.TrimSpace(req.StaffID)
	req.StaffName = strings.TrimSpace(req.StaffName)
	req.Email = strings.TrimSpace(req.Email)
	if msg := validateStaffAccountInput(req.StaffID, req.StaffName, req.Email, req.Role); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	if req.ClassID != nil && !a.currentClassExists(*req.ClassID) {
		writeErr(w, http.StatusBadRequest, "担当クラスの指定が正しくありません")
		return
	}
	// ログインIDはロールをまたいで園内で一意（基本設計書 5-2）
	if a.emailTaken(req.Email) {
		writeErr(w, http.StatusBadRequest, "そのログインIDはすでに使われています")
		return
	}
	var dup int
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
		// 担当クラスの割り当てに失敗したら、発行ごと取り消す。黙って外すと、担当クラスの無い一般ができる
		if _, err := tx.Exec(`INSERT INTO t_class_staff (class_id, staff_id) VALUES (?, ?)`, *req.ClassID, req.StaffID); err != nil {
			writeErr(w, http.StatusInternalServerError, "担当クラスの割り当てに失敗しました")
			return
		}
	}
	// 園全体・職員チャットと、担当クラスのチャンネルへ入れる。職員チャットは作成に連動する
	// （基本設計書「チャット」(5-5)、GitHub Issue #162。chat_membership.go）
	if _, err := syncStaffChatRooms(tx, accountID); err != nil {
		writeErr(w, http.StatusInternalServerError, "発行に失敗しました")
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "発行に失敗しました")
		return
	}

	// 何を発行したか（ロール・担当クラスを含む）を {"項目名": 値} で残す（基本設計書「操作ログ（t_operation_log）」(5-8)、
	// GitHub Issue #166 の 5）。一時パスワードは残さない
	a.log(u.AccountID, fnAccount, opCreate, "m_account", i64(accountID), nil, nil, s(fieldsJSON([]field{
		{"職員ID", req.StaffID},
		{"氏名", req.StaffName},
		{"ログインID", req.Email},
		{"ロール", roleLabel(req.Role)},
		{"担当クラス", a.staffClassName(req.StaffID)},
	})))
	writeJSON(w, http.StatusOK, map[string]string{"password": temp})
}

// validateStaffAccountInput は、職員アカウントの発行の入力を確かめ、誤りがあれば利用者に見せる文言を返す。
// 値は前後の空白を除いてから渡す（基本設計書「入力項目の制約値」(4-9)）
func validateStaffAccountInput(staffID, staffName, email, role string) string {
	switch {
	case staffID == "":
		return "職員IDを入力してください"
	case tooLong(staffID, 20):
		return "職員IDは20文字以内で入力してください"
	case staffName == "":
		return "氏名を入力してください"
	case tooLong(staffName, 50):
		return "氏名は50文字以内で入力してください"
	case role != roleAdmin && role != roleGeneralStaff:
		return "ロールの指定が正しくありません"
	}
	if msg := validateEmail(email); msg != "" {
		return strings.Replace(msg, "メールアドレス", "ログインID（メールアドレス）", 1)
	}
	return ""
}

// currentClassExists は、当年度のクラスかを返す。担当クラスに割り当てられるのは当年度のクラスだけ
func (a *app) currentClassExists(classID int64) bool {
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_class WHERE class_id = ? AND fiscal_year = ?`, classID, fiscalYear).Scan(&n)
	return n > 0
}

/*
emailTaken は、ログインIDがすでに使われているかを返す。

ログインIDはロールをまたいで園内で一意（基本設計書 5-2）。【仮置き】大文字・小文字だけが違うものも
同じとみなす（web/仮置き値.md）。NISHIDA@… と nishida@… が別のアカウントになると、打ち方しだいで
別の人のアカウントに入ろうとすることになる（GitHub Issue #167 の 1）。保護者の自己登録も同じ判定を使う
*/
func (a *app) emailTaken(email string) bool {
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_account WHERE lower(email) = lower(?)`, email).Scan(&n)
	return n > 0
}

func roleLabel(v string) string {
	if v == roleAdmin {
		return "管理者"
	}
	return "一般"
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
	if tooLong(req.StaffName, 50) {
		writeErr(w, http.StatusBadRequest, "氏名は50文字以内で入力してください")
		return
	}
	if req.Role != roleAdmin && req.Role != roleGeneralStaff {
		writeErr(w, http.StatusBadRequest, "ロールの指定が正しくありません")
		return
	}
	if req.ClassID != nil && !a.currentClassExists(*req.ClassID) {
		writeErr(w, http.StatusBadRequest, "担当クラスの指定が正しくありません")
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
	// クラスのチャンネルと個人チャットを、新しい担当クラス・ロールに合わせる。前のクラスからは外れ、
	// 外れるまでの過去ログだけを読める（要件定義書「チャットツール」(4-3) (a)、GitHub Issue #162）
	if _, err := syncStaffChatRooms(tx, accountID); err != nil {
		writeErr(w, http.StatusInternalServerError, "チャットの参加者を変えられませんでした")
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "変更に失敗しました")
		return
	}

	// 変更のあった項目だけを {"項目名": 値} で残す（基本設計書「操作ログ（t_operation_log）」(5-8)、GitHub Issue #166 の 5）
	before, after := changedFields(
		[]field{{"氏名", oldName}, {"ロール", roleLabel(oldRole)}, {"担当クラス", oldClass}},
		[]field{{"氏名", req.StaffName}, {"ロール", roleLabel(req.Role)}, {"担当クラス", a.staffClassName(staffID)}},
	)
	a.log(u.AccountID, fnAccount, opUpdate, "m_account", i64(accountID), nil, s(before), s(after))
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
// 乱数は暗号に使えるもの（randomFrom）。GitHub Issue #236
func randomCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	return randomFrom(alphabet, 4) + "-" + randomFrom(alphabet, 4) + "-" + randomFrom(alphabet, 4)
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
	/*
	 * 【仮置き】園児のよみ順にまとめ（よみが同じなら園児IDの順）、同じ園児の中は発行の古い順にする
	 * （web/仮置き値.md「一覧の並び順」）。画面は返した順に園児ごとにまとめる（図/画面詳細図.md「招待コード管理画面」(7-7)
	 * 「同じ園児の複数枚をまとめて見られる」）。並びを決めていなかったため、モック（園児の氏名の順）と、
	 * まとまりの並びが食い違っていた（GitHub Issue #177 の 7）。画面側のモックは web/src/api/mock.ts の invitationCodes
	 */
	q += ` ORDER BY IFNULL((SELECT child_name_kana FROM m_child WHERE child_id = c.child_id), ''),
		c.child_id, c.invitation_code_id`
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
	// 園児1名あたりの枚数は 1〜5 枚（図/画面詳細図.md「招待コード管理画面」(7-7) 項目10「上限は5枚」、GitHub Issue #167 の 3）
	if !validPerChild(req.PerChild) {
		writeErr(w, http.StatusBadRequest, perChildMessage)
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

// 一括発行の、園児1名あたりの枚数の範囲（図/画面詳細図.md「招待コード管理画面」(7-7) 項目10）
const (
	perChildMin     = 1
	perChildMax     = 5
	perChildMessage = "1名あたりの枚数は1〜5枚で指定してください"
)

func validPerChild(n int) bool {
	return n >= perChildMin && n <= perChildMax
}

// childIssuable は、招待コードを発行できる園児か（取り消していない・在籍中）を返す。
// 一括発行の対象（handleIssueInvitationCodes）と同じ条件。園児が無ければ found を false にする
func (a *app) childIssuable(childID string) (found, issuable bool) {
	var deleted bool
	var enrollment string
	if err := a.db.QueryRow(`SELECT is_deleted, enrollment_status FROM m_child WHERE child_id = ?`, childID).
		Scan(&deleted, &enrollment); err != nil {
		return false, false
	}
	return true, !deleted && enrollment == "1"
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
	// 取り消した・在籍していない園児には発行しない。一括発行と同じ条件にする。取り消した園児に発行すると、
	// その園児に紐づく保護者アカウントができてしまう（GitHub Issue #166 の 4）
	found, issuable := a.childIssuable(req.ChildID)
	if !found {
		writeErr(w, http.StatusNotFound, "園児が見つかりません")
		return
	}
	if !issuable {
		writeErr(w, http.StatusBadRequest, "在籍していない園児には招待コードを発行できません")
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
	// 失効済みのコードを重ねて失効させない。操作ログに事実と違う「変更前：未使用」が残る（GitHub Issue #166 の 6）
	if status == "3" {
		writeErr(w, http.StatusBadRequest, "この招待コードはすでに失効しています")
		return
	}
	if _, err := a.db.Exec(`UPDATE t_invitation_code SET status = '3' WHERE invitation_code_id = ? AND status = '1'`, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "失効に失敗しました")
		return
	}
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
		// 終了した紐づけを「紐づけを戻す」で、解除のあいだも読める形で戻せる最後の日（restoreLinkDays）。
		// 過ぎたら（付いていなければ）「結び直す」になる。終了でなければ付けない
		RestoreUntil *string `json:"restore_until,omitempty"`
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
				if l.LinkStatus == "2" {
					l.RestoreUntil = restoreLinkUntil(ended)
				}
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

	stopped := false
	if remaining == 0 {
		res, _ := a.db.Exec(`UPDATE m_account SET status = '2', updated_at = ?
			WHERE status = '1' AND account_id = (SELECT account_id FROM m_guardian WHERE guardian_id = ?)`,
			now(), req.GuardianID)
		if n, _ := res.RowsAffected(); n > 0 {
			stopped = true
		}
	}

	/*
	 * 解除するとその園児の記録を参照できなくなる（画面詳細図 7-8 項目6）。保護者は left_at が入った時点で
	 * 参照できなくなる（基本設計書「チャット」(5-5)）。その園児の個人チャットと、ほかに有効な紐づけのある園児が
	 * 在籍していないクラスのクラスグループに left_at を入れる。ログイン中のセッションも切る（GitHub Issue #159）。
	 * きょうだいの紐づけが残る保護者は、ログインし直せば残る園児の範囲で使える
	 */
	accountID := a.guardianAccountID(req.GuardianID)
	if accountID != nil {
		a.leaveRoomsOfChild(*accountID, req.GuardianID, req.ChildID)
		a.sessions.destroyAccount(*accountID, "")
	}

	// 紐づけの表は数値の主キーを持たない。相手が分かるよう、保護者のアカウントを対象として残す
	a.log(u.AccountID, fnAccount, opUpdate, "t_guardian_child", accountID,
		s(req.ChildID), s("有効"), s("終了"))
	// 有効な紐づけが無くなったことによる停止は、システムが行った変更として、操作者を「システム」で別の行に残す
	// （基本設計書「操作ログの記録」(4-2)。解除は管理者の操作、停止はその結果としてシステムが行う）。
	// 【仮置き】行の分け方と文言は設計に無い（web/仮置き値.md）
	if stopped {
		a.logSystem(fnAccount, opUpdate, "m_account", accountID, s(req.ChildID),
			s("有効"), s("停止（有効な紐づけがゼロになったため）"))
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// leaveRoomsOfChild は、紐づけを解除した保護者を、その園児の個人チャットと、ほかに有効な紐づけのある園児が
// 在籍していないクラスのクラスグループから外す（left_at を入れる）。所属していた期間の記録は残す（基本設計書 5-5）
func (a *app) leaveRoomsOfChild(accountID int64, guardianID, childID string) {
	a.db.Exec(`UPDATE t_chat_member SET left_at = ?
		 WHERE account_id = ? AND left_at IS NULL
		   AND chat_room_id IN (SELECT chat_room_id FROM m_chat_room WHERE room_type = '4' AND child_id = ?)`,
		now(), accountID, childID)
	a.db.Exec(`UPDATE t_chat_member SET left_at = ?
		 WHERE account_id = ? AND left_at IS NULL
		   AND chat_room_id IN (
		     SELECT r.chat_room_id FROM m_chat_room r
		      WHERE r.room_type = '2'
		        AND r.class_id IN (SELECT class_id FROM t_class_child WHERE child_id = ?)
		        AND NOT EXISTS (
		          SELECT 1 FROM t_class_child cc
		            JOIN t_guardian_child gc ON gc.child_id = cc.child_id
		           WHERE cc.class_id = r.class_id AND gc.guardian_id = ? AND gc.link_status = '1'))`,
		now(), accountID, childID, guardianID)
}

// rejoinRoomsOfChild は、紐づけを戻した保護者を、その園児の個人チャット・いまのクラスのクラスグループ・園全体へ戻す。
// 誤って解除したときの戻し先であり、解除の前の状態へ戻す（基本設計書「保護者と園児の紐づけを戻す」(4-3)、GitHub Issue #118・#159・#272）。
//   - 参加の行があれば、left_at を空にする。参加の時刻は、はじめに参加した時刻のまま（joined_at を変えない）
//   - 参加の行が無ければ（デモデータの初期の形や、行を作らずに終えた紐づけ）、作る。参加の時刻は紐づけを結んだ時刻
//     （linked_at）とする。解除の前に読めていた範囲を、戻したあとも読めるようにするため
//
// 【仮置き】園全体も、行が無い・抜けているときは戻す（解除では抜けないが、参加の行が無い保護者がいる）。web/仮置き値.md
func (a *app) rejoinRoomsOfChild(accountID int64, guardianID, childID string) {
	var linkedAt string
	if a.db.QueryRow(`SELECT linked_at FROM t_guardian_child WHERE guardian_id = ? AND child_id = ?`,
		guardianID, childID).Scan(&linkedAt) != nil || linkedAt > now() {
		linkedAt = now()
	}
	rooms, err := queryIDs(a.db, `SELECT r.chat_room_id FROM m_chat_room r
		WHERE r.is_archived = 0
		  AND (r.room_type = '1'
		       OR (r.room_type = '4' AND r.child_id = ?)
		       OR (r.room_type = '2' AND r.class_id IN (
		             SELECT cc.class_id FROM t_class_child cc
		               JOIN m_class c ON c.class_id = cc.class_id AND c.fiscal_year = ?
		              WHERE cc.child_id = ?)))
		ORDER BY r.chat_room_id`, childID, fiscalYear, childID)
	if err != nil {
		log.Printf("紐づけを戻した保護者の参加ルームを引けませんでした: %v", err)
		return
	}
	for _, roomID := range rooms {
		a.db.Exec(`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at, left_at)
			VALUES (?, ?, ?, NULL)
			ON CONFLICT(chat_room_id, account_id) DO UPDATE SET left_at = NULL
			WHERE t_chat_member.left_at IS NOT NULL`, roomID, accountID, linkedAt)
	}
}

func (a *app) guardianAccountID(guardianID string) *int64 {
	var id sql.NullInt64
	a.db.QueryRow(`SELECT account_id FROM m_guardian WHERE guardian_id = ?`, guardianID).Scan(&id)
	return nullInt(id)
}

// restoreLinkDays は、解除した紐づけを「紐づけを戻す」で、解除のあいだも読める形で戻せる日数。解除した日から数え、その日数あとの日まで。
// 過ぎた紐づけは断らずに「結び直す」（handleRestoreGuardianLink）。
// 【仮置き】設計は「誤って解除したときに限る」とだけ決め、期間を決めていない（web/仮置き値.md。照合 c2b-3・c5-04 の推し）。
// 画面とモックは web/src/api/codes.ts の RESTORE_LINK_DAYS
const restoreLinkDays = 7

// restoreLinkUntil は、終了した紐づけを、解除のあいだも読める形で戻せる最後の日（YYYY-MM-DD）。
// 解除した日時が無ければ nil（結び直す側へ倒す）
func restoreLinkUntil(endedAt sql.NullString) *string {
	if !endedAt.Valid || len(endedAt.String) < 10 {
		return nil
	}
	until := addDays(endedAt.String[:10], restoreLinkDays)
	return &until
}

/*
restoreLinkLogAfter は、「紐づけを戻す」「結び直す」の操作ログの変更後の値。
戻したときは「有効」、結び直したときは「有効（結び直し）」。止まっていたアカウントを再開したら「アカウントを再開」を添える。
【仮置き】文は設計に無い（web/仮置き値.md）。モックは web/src/api/mock.ts の restoreLinkLogAfter
*/
func restoreLinkLogAfter(relink, reopened bool) string {
	notes := []string{}
	if relink {
		notes = append(notes, "結び直し")
	}
	if reopened {
		notes = append(notes, "アカウントを再開")
	}
	if len(notes) == 0 {
		return "有効"
	}
	return "有効（" + strings.Join(notes, "、") + "）"
}

/*
handleRestoreGuardianLink は、解除した紐づけを有効へ戻す。解除によってアカウントが停止していた場合は、あわせて再開する
（GitHub Issue #118）。止まった保護者アカウントを再開する道は、この操作だけ（基本設計書「アカウントの停止と再開」(4-3)
「再開は、紐づけを戻すことで行う」）なので、日数で断らない（照合 c5-04）。

  - 解除した日から restoreLinkDays 日まで：「紐づけを戻す」。誤って解除したときの戻し先で、解除の前の状態へ戻す
    （rejoinRoomsOfChild。参加の時刻ははじめに参加した時刻のまま。解除していたあいだのやりとりも読める。
    基本設計書「保護者と園児の紐づけを戻す」(4-3)）
  - 過ぎたら（解除した日時の無い古い行も）：「結び直す」。新しい招待コードで結んだときと同じ扱いにする。
    紐づけた日時（linked_at）を今にし、個人チャットといまのクラスのクラスグループへ今の時刻で参加し直す
    （お子さまの追加と同じ joinRoomsOfChildNow。決めたこと D-48）。解除していたあいだも、それより前のやりとりも読めない

【仮置き】日数と、過ぎたら結び直すこと（web/仮置き値.md）
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
	var status string
	var endedAt sql.NullString
	if err := a.db.QueryRow(`SELECT link_status, ended_at FROM t_guardian_child WHERE guardian_id = ? AND child_id = ?`,
		req.GuardianID, req.ChildID).Scan(&status, &endedAt); err != nil || status != "2" {
		writeErr(w, http.StatusNotFound, "終了した紐づけが見つかりません")
		return
	}
	until := restoreLinkUntil(endedAt)
	relink := until == nil || today() > *until
	at := now()
	q := `UPDATE t_guardian_child SET link_status = '1', ended_at = NULL
		WHERE guardian_id = ? AND child_id = ? AND link_status = '2'`
	args := []any{req.GuardianID, req.ChildID}
	if relink {
		q = `UPDATE t_guardian_child SET link_status = '1', ended_at = NULL, linked_at = ?
		WHERE guardian_id = ? AND child_id = ? AND link_status = '2'`
		args = append([]any{at}, args...)
	}
	res, err := a.db.Exec(q, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "紐づけを戻せませんでした")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "終了した紐づけが見つかりません")
		return
	}

	reopened := false
	var joined []int64
	accountID := a.guardianAccountID(req.GuardianID)
	if accountID != nil {
		var status string
		a.db.QueryRow(`SELECT status FROM m_account WHERE account_id = ?`, *accountID).Scan(&status)
		if status == "2" {
			a.db.Exec(`UPDATE m_account SET status = '1', updated_at = ? WHERE account_id = ?`, at, *accountID)
			reopened = true
		}
		if relink {
			if joined, err = joinRoomsOfChildNow(a.db, *accountID, req.ChildID, at); err != nil {
				log.Printf("結び直した保護者を参加させられませんでした: %v", err)
			}
		} else {
			a.rejoinRoomsOfChild(*accountID, req.GuardianID, req.ChildID)
		}
	}
	a.log(u.AccountID, fnAccount, opUpdate, "t_guardian_child", accountID, s(req.ChildID), s("終了"), s(restoreLinkLogAfter(relink, reopened)))
	// 結び直したときは、お子さまの追加と同じく、参加の変わったルームへ知らせる
	for _, roomID := range joined {
		a.notifyRoomMembers(roomID)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
