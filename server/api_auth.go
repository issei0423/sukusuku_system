package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

/*
 * 共通基盤：ログインとアカウント
 * 典拠：基本設計書.md「共通基盤：ログインとアカウント」(4-3)
 *      図/画面詳細図.md「職員用トップ／保護者用トップ」(2-1)
 */

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	// 開いた入口。職員用と保護者用は同じ様式で、入口だけが異なる
	Entrance string `json:"entrance"`
	Remember bool   `json:"remember"`
}

func (a *app) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !readJSON(w, r, &req) {
		return
	}
	maxFailed := a.settingInt("auth.max_failed_login", 5)

	var (
		accountID   int64
		hash        string
		role        string
		status      string
		failedCount int
		lockedUntil sql.NullString
	)
	err := a.db.QueryRow(`SELECT account_id, password_hash, role, status, failed_login_count, locked_until
	                        FROM m_account WHERE email = ?`, req.Email).
		Scan(&accountID, &hash, &role, &status, &failedCount, &lockedUntil)

	if errors.Is(err, sql.ErrNoRows) {
		// 存在しないアカウントでも、あるかどうかを推測させない文言に揃える
		writeJSON(w, http.StatusUnauthorized, apiError{
			Kind: "credential", Remaining: maxFailed,
			Message: "ログインIDまたはパスワードが違います",
		})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ログインの処理に失敗しました")
		return
	}

	if lockedUntil.Valid && lockedUntil.String > now() {
		writeJSON(w, http.StatusUnauthorized, apiError{
			Kind:    "locked",
			Message: "ログインを一定回数以上まちがえたため、アカウントをロックしました。園の管理者へご連絡ください",
		})
		return
	}
	if status == "2" {
		writeJSON(w, http.StatusUnauthorized, apiError{
			Kind: "suspended", Message: "このアカウントは停止されています。園の管理者へご連絡ください",
		})
		return
	}

	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		failedCount++
		if failedCount >= maxFailed {
			lockMinutes := a.settingInt("auth.lock_minutes", 30)
			a.db.Exec(`UPDATE m_account SET failed_login_count = ?, locked_until = ? WHERE account_id = ?`,
				failedCount, fromNowMinutes(lockMinutes), accountID)
			writeJSON(w, http.StatusUnauthorized, apiError{
				Kind:    "locked",
				Message: "ログインを一定回数以上まちがえたため、アカウントをロックしました。園の管理者へご連絡ください",
			})
			return
		}
		a.db.Exec(`UPDATE m_account SET failed_login_count = ? WHERE account_id = ?`, failedCount, accountID)
		writeJSON(w, http.StatusUnauthorized, apiError{
			Kind: "credential", Remaining: maxFailed - failedCount,
			Message: "ログインIDまたはパスワードが違います",
		})
		return
	}

	// 誤った系統でのログインは成立させず、正しい入口を案内する（画面詳細図 2-1）
	isStaffAccount := role == roleAdmin || role == roleGeneralStaff
	if req.Entrance == "staff" && !isStaffAccount {
		writeJSON(w, http.StatusUnauthorized, apiError{
			Kind: "wrong_entrance", Correct: "guardian",
			Message: "このアカウントは保護者用の入口からログインしてください",
		})
		return
	}
	if req.Entrance == "guardian" && isStaffAccount {
		writeJSON(w, http.StatusUnauthorized, apiError{
			Kind: "wrong_entrance", Correct: "staff",
			Message: "このアカウントは職員用の入口からログインしてください",
		})
		return
	}

	a.db.Exec(`UPDATE m_account SET failed_login_count = 0, locked_until = NULL WHERE account_id = ?`, accountID)

	// ログイン状態を保持するかで有効期間を変える
	ttl := a.settingInt("ui.auto_logout_minutes", 30)
	if req.Remember {
		ttl = a.settingInt("auth.remember_days", 30) * 24 * 60
	}
	a.sessions.create(w, accountID, req.Entrance, ttl)

	u, err := a.loadSessionUser(accountID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ログインの処理に失敗しました")
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (a *app) handleLogout(w http.ResponseWriter, r *http.Request) {
	a.sessions.destroy(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleMe はログイン中の利用者を返す。パスワード変更・規約同意のあと画面を進めるためにも使う。
func (a *app) handleMe(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, u)
}

type changePasswordRequest struct {
	Current string `json:"current"`
	Next    string `json:"next"`
}

func (a *app) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var req changePasswordRequest
	if !readJSON(w, r, &req) {
		return
	}

	var hash string
	if err := a.db.QueryRow(`SELECT password_hash FROM m_account WHERE account_id = ?`, u.AccountID).Scan(&hash); err != nil {
		writeErr(w, http.StatusInternalServerError, "アカウントが見つかりません")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Current)) != nil {
		writeErr(w, http.StatusBadRequest, "現在のパスワードが違います")
		return
	}
	// 【仮置き】桁数の制約値は未確定（基本設計書「画面詳細」(3-6)）。web/仮置き値.md を参照
	if len(req.Next) < 8 {
		writeErr(w, http.StatusBadRequest, "パスワードは8文字以上で入力してください")
		return
	}

	next, err := bcrypt.GenerateFromPassword([]byte(req.Next), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "パスワードの変更に失敗しました")
		return
	}
	if _, err := a.db.Exec(`UPDATE m_account
		SET password_hash = ?, is_temp_password = 0, temp_password_expires_at = NULL, updated_at = ?
		WHERE account_id = ?`, string(next), now(), u.AccountID); err != nil {
		writeErr(w, http.StatusInternalServerError, "パスワードの変更に失敗しました")
		return
	}
	a.log(u.AccountID, fnAccount, opUpdate, "m_account", i64(u.AccountID), nil, nil, s("パスワードを変更"))

	updated, _ := a.loadSessionUser(u.AccountID)
	writeJSON(w, http.StatusOK, updated)
}

// Terms は利用規約（m_terms）
type Terms struct {
	TermsID      int64  `json:"terms_id"`
	TermsVersion string `json:"terms_version"`
	DocumentType string `json:"document_type"`
	Body         string `json:"body"`
	PublishedOn  string `json:"published_on"`
}

func (a *app) handleCurrentTerms(w http.ResponseWriter, r *http.Request) {
	var t Terms
	err := a.db.QueryRow(`SELECT terms_id, terms_version, document_type, body, published_on
	                        FROM m_terms WHERE terms_version = ?`, a.currentTermsVersion).
		Scan(&t.TermsID, &t.TermsVersion, &t.DocumentType, &t.Body, &t.PublishedOn)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "利用規約を読み込めませんでした")
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (a *app) handleAgreeTerms(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if _, err := a.db.Exec(`UPDATE m_account SET terms_version = ?, terms_agreed_at = ?, updated_at = ?
	                         WHERE account_id = ?`, a.currentTermsVersion, now(), now(), u.AccountID); err != nil {
		writeErr(w, http.StatusInternalServerError, "同意の記録に失敗しました")
		return
	}
	a.log(u.AccountID, fnAccount, opUpdate, "m_account", i64(u.AccountID), nil, nil,
		s("規約 "+a.currentTermsVersion+" に同意"))

	updated, _ := a.loadSessionUser(u.AccountID)
	writeJSON(w, http.StatusOK, updated)
}

// ---- 保護者アカウントの自己登録（基本設計書「保護者アカウントの自己登録」(4-3)） ----

type usableCode struct {
	ID      int64
	ChildID string
}

// lookupUsableCode は使える招待コードを引く。使えない理由はそのまま画面へ出す。
func (a *app) lookupUsableCode(code string) (usableCode, error) {
	var out usableCode
	normalized := strings.ToUpper(strings.TrimSpace(code))

	var status, expiresOn string
	err := a.db.QueryRow(`SELECT invitation_code_id, child_id, status, expires_on
	                        FROM t_invitation_code WHERE UPPER(code) = ?`, normalized).
		Scan(&out.ID, &out.ChildID, &status, &expiresOn)
	if errors.Is(err, sql.ErrNoRows) {
		return out, errors.New("招待コードが確認できません。園から配布されたコードをお確かめください")
	}
	if err != nil {
		return out, errors.New("招待コードの確認に失敗しました")
	}
	switch {
	case status == "2":
		return out, errors.New("この招待コードはすでに使われています")
	case status == "3":
		return out, errors.New("この招待コードは失効しています")
	case expiresOn < today():
		return out, errors.New("この招待コードは有効期限が切れています")
	}
	return out, nil
}

// handleVerifyInvitationCode は招待コードの有効性だけを返す。
// 園児名を返さない。誰の保護者かを名乗る前の段階であるため（画面詳細図 2-3）。
func (a *app) handleVerifyInvitationCode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if _, err := a.lookupUsableCode(req.Code); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type signUpRequest struct {
	Code         string `json:"code"`
	Email        string `json:"email"`
	Password     string `json:"password"`
	GuardianName string `json:"guardian_name"`
	Relationship string `json:"relationship"`
}

func (a *app) handleSignUpGuardian(w http.ResponseWriter, r *http.Request) {
	var req signUpRequest
	if !readJSON(w, r, &req) {
		return
	}

	code, err := a.lookupUsableCode(req.Code)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "招待コードが確認できません")
		return
	}
	// ログインIDはロールをまたいで園内で一意（基本設計書 5-2）
	var dup int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_account WHERE email = ?`, req.Email).Scan(&dup)
	if dup > 0 {
		writeErr(w, http.StatusBadRequest, "このメールアドレスはすでに登録されています")
		return
	}
	if len(req.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "パスワードは8文字以上で入力してください")
		return
	}
	if strings.TrimSpace(req.GuardianName) == "" {
		writeErr(w, http.StatusBadRequest, "保護者の氏名を入力してください")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}

	/*
	 * 個人チャットのルーム名は、取引を始める前に引いておく。
	 * 接続は1本に絞っている（db.go）ため、取引の途中で a.db へ問い合わせると、
	 * 取引が握っている接続を待ち続けて、サーバ全体が応答しなくなる
	 */
	personalRoomName := a.childName(code.ChildID) + "の保護者"

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}
	defer tx.Rollback()

	res, err := tx.Exec(`INSERT INTO m_account
		(email, password_hash, role, status, is_temp_password, failed_login_count,
		 terms_version, terms_agreed_at, created_at, updated_at)
		VALUES (?, ?, '3', '1', 0, 0, ?, ?, ?, ?)`,
		req.Email, string(hash), a.currentTermsVersion, now(), now(), now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}
	accountID, _ := res.LastInsertId()

	var count int
	tx.QueryRow(`SELECT COUNT(*) FROM m_guardian`).Scan(&count)
	guardianID := "G" + pad3(count+1)

	if _, err := tx.Exec(`INSERT INTO m_guardian (guardian_id, account_id, guardian_name, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)`, guardianID, accountID, req.GuardianName, now(), now()); err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}
	if _, err := tx.Exec(`INSERT INTO t_guardian_child (guardian_id, child_id, relationship, link_status, linked_at)
		VALUES (?, ?, ?, '1', ?)`, guardianID, code.ChildID, req.Relationship, now()); err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}

	// 使用と同時に status を使用済みにする。1枚のコードは1アカウントの登録にのみ使える（基本設計書 5-2）
	if _, err := tx.Exec(`UPDATE t_invitation_code SET status = '2', used_account_id = ?, used_at = ?
		WHERE invitation_code_id = ? AND status = '1'`, accountID, now(), code.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}

	// 自児の個人チャット・クラス・園全体へ参加させる
	joinRooms := []string{}
	var personal int64
	if err := tx.QueryRow(`SELECT chat_room_id FROM m_chat_room
		WHERE room_type = '4' AND room_name = ?`, personalRoomName).Scan(&personal); err == nil {
		joinRooms = append(joinRooms, "")
		tx.Exec(`INSERT OR IGNORE INTO t_chat_member (chat_room_id, account_id, joined_at) VALUES (?, ?, ?)`,
			personal, accountID, now())
	}
	tx.Exec(`INSERT OR IGNORE INTO t_chat_member (chat_room_id, account_id, joined_at)
		SELECT r.chat_room_id, ?, ? FROM m_chat_room r
		 WHERE r.room_type = '2'
		   AND r.class_id IN (SELECT class_id FROM t_class_child WHERE child_id = ?)`,
		accountID, now(), code.ChildID)
	tx.Exec(`INSERT OR IGNORE INTO t_chat_member (chat_room_id, account_id, joined_at)
		SELECT chat_room_id, ?, ? FROM m_chat_room WHERE room_type = '1'`, accountID, now())
	_ = joinRooms

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}

	a.log(accountID, fnAccount, opCreate, "m_account", i64(accountID), s(code.ChildID), nil,
		s("保護者アカウントを自己登録"))

	a.sessions.create(w, accountID, "guardian", a.settingInt("ui.auto_logout_minutes", 30))
	u, _ := a.loadSessionUser(accountID)
	writeJSON(w, http.StatusOK, u)
}

func pad3(n int) string {
	return fmt.Sprintf("%03d", n)
}
