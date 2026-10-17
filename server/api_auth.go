package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"regexp"
	"strings"
	"unicode"
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
	/*
	 * ログイン中のセッションがある場合は認証を成立させず、既存のセッションを維持したまま、
	 * ログアウトを促して終了する。新しいセッションは作らない。上書きログインは設けない
	 * （基本設計書「ログイン」(4-3)、要件定義書「同時ログインの扱い」(4-1-1)）。
	 * 画面（TopScreen）もログイン中は入力欄を出さないが、ログインより前に開いておいた別のタブからは
	 * 送れてしまうため、サーバで止める（GitHub Issue #159）。案内にログイン中の氏名・ロールは出さない
	 */
	if _, ok := a.sessions.accountID(r); ok {
		writeAlreadyLoggedIn(w)
		return
	}
	var req loginRequest
	if !readJSON(w, r, &req) {
		return
	}
	// アカウントのロールが、使われた入口の系統と一致するかを判定する（基本設計書「ログイン」(4-3)）。
	// 入口が職員用・保護者用のどちらでもない要求は、判定ができないため受け付けない
	if req.Entrance != "staff" && req.Entrance != "guardian" {
		writeErr(w, http.StatusBadRequest, "入口の指定が正しくありません。職員用または保護者用のトップからログインしてください")
		return
	}
	maxFailed := a.settingInt("auth.max_failed_login", 5)

	var (
		accountID     int64
		hash          string
		role          string
		status        string
		failedCount   int
		lockedUntil   sql.NullString
		isTemp        bool
		tempExpiresAt sql.NullString
	)
	err := a.db.QueryRow(`SELECT account_id, password_hash, role, status, failed_login_count, locked_until,
	                             is_temp_password, temp_password_expires_at
	                        FROM m_account WHERE email = ?`, req.Email).
		Scan(&accountID, &hash, &role, &status, &failedCount, &lockedUntil, &isTemp, &tempExpiresAt)

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

	if !checkPassword(hash, req.Password) {
		failedCount++
		/*
		 * ログインの失敗と、失敗が続いたことによるロックを操作ログに残す（GitHub Issue #115）。
		 * 不正な試行に気づくための記録である。成功とログアウトは残さない。誰が記録したかは、
		 * 各操作の記録で追えるため（基本設計書「共通基盤：ログインとアカウント」(4-3)）。
		 * ログインできていないので、操作者は確かめられない。操作者の欄には、試された
		 * アカウントを入れる（本人とは限らない）。存在しないログインIDへの試行は、入れる先の
		 * アカウントが無いため残らない。
		 */
		attempt := "続けて " + strconv.Itoa(failedCount) + " 回目"
		if failedCount >= maxFailed {
			lockMinutes := a.settingInt("auth.lock_minutes", 30)
			a.db.Exec(`UPDATE m_account SET failed_login_count = ?, locked_until = ? WHERE account_id = ?`,
				failedCount, fromNowMinutes(lockMinutes), accountID)
			a.log(accountID, fnAccount, opUpdate, "m_account", i64(accountID), nil, nil,
				s("ログインに失敗（"+attempt+"）。失敗が続いたためロック"))
			writeJSON(w, http.StatusUnauthorized, apiError{
				Kind:    "locked",
				Message: "ログインを一定回数以上まちがえたため、アカウントをロックしました。園の管理者へご連絡ください",
			})
			return
		}
		a.db.Exec(`UPDATE m_account SET failed_login_count = ? WHERE account_id = ?`, failedCount, accountID)
		a.log(accountID, fnAccount, opUpdate, "m_account", i64(accountID), nil, nil, s("ログインに失敗（"+attempt+"）"))
		writeJSON(w, http.StatusUnauthorized, apiError{
			Kind: "credential", Remaining: maxFailed - failedCount,
			Message: "ログインIDまたはパスワードが違います",
		})
		return
	}

	/*
	 * 停止の判定は、パスワードの照合のあとに行う。照合より前に行うと、パスワードを知らない人にも
	 * 「停止中のアカウントがある」ことを示してしまう（上の「あるかどうかを推測させない」と同じ考え方。
	 * GitHub Issue #159）
	 */
	if status == accountSuspended {
		writeJSON(w, http.StatusUnauthorized, apiError{
			Kind: "suspended", Message: "このアカウントは停止されています。園の管理者へご連絡ください",
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

	/*
	 * 一時パスワードでのログインなら、有効期限内かを判定する。期限切れなら管理者への連絡を案内する
	 * （基本設計書「ログイン」(4-3)、メッセージ一覧 (4-9)「一時パスワードの期限切れ」）。
	 * 期限切れはロックとは区別し、待機時間の経過では解消しない。管理者が再発行する
	 */
	if isTemp && tempExpiresAt.Valid && tempExpiresAt.String < now() {
		writeJSON(w, http.StatusUnauthorized, apiError{
			Kind: "temp_expired", Message: "一時パスワードの有効期限が切れています。管理者へご連絡ください。",
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
	// 編集ロックを持ったままログアウトすると、ほかの職員が無操作の経過まで保存できなくなる。
	// ログアウトは編集の終了であり、保持しているロックをすべて外す（基本設計書「編集ロックの解除」(4-5)）
	if accountID, ok := a.sessions.accountID(r); ok {
		a.db.Exec(`DELETE FROM t_diary_lock WHERE locked_staff_id =
			(SELECT staff_id FROM m_staff WHERE account_id = ?)`, accountID)
	}
	a.sessions.destroy(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleMe はログイン中の利用者を返す。パスワード変更・規約同意のあと画面を進めるためにも使う。
// 手続きの途中でも返す。画面はこの値で、どの手続きの画面へ進めるかを決める（session.go の requireUser）
func (a *app) handleMe(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireLogin(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, u)
}

type changePasswordRequest struct {
	Current string `json:"current"`
	Next    string `json:"next"`
}

// handleChangePassword はパスワードを変更する。一時パスワード中に使う手続きのため、requireLogin で通す
func (a *app) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireLogin(w, r)
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
	if !checkPassword(hash, req.Current) {
		writeErr(w, http.StatusBadRequest, "現在のパスワードが違います")
		return
	}
	// 現在と同じパスワードへの変更は認めない。一時パスワードを同じ値のまま使い続けられると、
	// 変更を強制する意味がなくなるため（基本設計書「パスワードの要件」(6-3)）
	if req.Next == req.Current {
		writeErr(w, http.StatusBadRequest, "現在と同じパスワードは使えません。別のパスワードを入力してください。")
		return
	}
	// 8〜128文字（文字数で数える）。よく使われるパスワードは拒否する（password.go）
	if msg := validateNewPassword(req.Next); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}

	next, err := hashPassword(req.Next)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "パスワードの変更に失敗しました")
		return
	}
	if _, err := a.db.Exec(`UPDATE m_account
		SET password_hash = ?, is_temp_password = 0, temp_password_expires_at = NULL, updated_at = ?
		WHERE account_id = ?`, next, now(), u.AccountID); err != nil {
		writeErr(w, http.StatusInternalServerError, "パスワードの変更に失敗しました")
		return
	}
	/*
	 * パスワードを変更したときは、変更した端末以外のセッションをすべて無効化する
	 * （基本設計書「ログイン」(4-3)・「認証情報の保持方式」(6-3)、画面詳細図 2-4）。
	 * 変更する動機の多くは「他人に知られたかもしれない」であり、他の端末のログインが生き続けるのは目的に反する
	 */
	a.sessions.destroyAccount(u.AccountID, sessionID(r))
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

// handleAgreeTerms は規約への同意を記録する。再同意が要る間に使う手続きのため、requireLogin で通す
func (a *app) handleAgreeTerms(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireLogin(w, r)
	if !ok {
		return
	}
	// アカウントの同意済みの印と、同意履歴の行は、ひとまとまりで書く。
	// 履歴が欠けたまま同意済みになると、いつ・どの版に同意したかを示せなくなる（GitHub Issue #99）
	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "同意の記録に失敗しました")
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE m_account SET terms_version = ?, terms_agreed_at = ?, updated_at = ?
	                         WHERE account_id = ?`, a.currentTermsVersion, now(), now(), u.AccountID); err != nil {
		writeErr(w, http.StatusInternalServerError, "同意の記録に失敗しました")
		return
	}
	/*
	 * 同意は履歴として残す。追記のみとし、前の版に同意した行は消さない
	 * （基本設計書「同意履歴（t_terms_agreement）」(5-2)）。
	 * 同意は要配慮個人情報を取り扱う根拠であり、いつ・どの版に同意したかを後から示せる必要がある
	 */
	if _, err := tx.Exec(`INSERT INTO t_terms_agreement (account_id, terms_id, agreed_at)
		VALUES (?, ?, ?)`, u.AccountID, a.currentTermsID, now()); err != nil {
		writeErr(w, http.StatusInternalServerError, "同意の記録に失敗しました")
		return
	}
	if err := tx.Commit(); err != nil {
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

/*
normalizeInvitationCode は、入力された招待コードを照合用の形に直す。

大文字・小文字を区別せず、ハイフンは入力しても省略してもよい
（基本設計書「招待コード（t_invitation_code）」(5-2)）。打ち方の違いで失敗させない。
空白は、配布物から書き写すときに紛れ込みやすいため、あわせて取り除く。
画面側（web/src/api/util.ts の normalizeInvitationCode）と同じ規則にしてある。
*/
func normalizeInvitationCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		if r == '-' || r == 'ー' || r == '－' || r == '‐' || unicode.IsSpace(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// emailPattern はメールアドレス形式のおおまかな検査。届くかどうかまでは確かめない
var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// validateEmail はログインID（メールアドレス）の必須・桁数・形式を検査する（基本設計書「入力項目の制約値」(4-9)）
func validateEmail(email string) string {
	switch {
	case strings.TrimSpace(email) == "":
		return "メールアドレスを入力してください"
	case len([]rune(email)) > 254:
		return "メールアドレスは254文字以内で入力してください"
	case !emailPattern.MatchString(email):
		return "メールアドレスの形式が正しくありません"
	}
	return ""
}

// lookupUsableCode は使える招待コードを引く。使えない理由はそのまま画面へ出す。
func (a *app) lookupUsableCode(code string) (usableCode, error) {
	var out usableCode
	normalized := normalizeInvitationCode(code)

	var status, expiresOn string
	err := a.db.QueryRow(`SELECT invitation_code_id, child_id, status, expires_on
	                        FROM t_invitation_code WHERE REPLACE(UPPER(code), '-', '') = ?`, normalized).
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
	// 取り消した（誤登録）・在籍していない園児のコードでは登録させない。発行のあとで園児を取り消しても、
	// 配ったコードで、その園児に紐づく保護者アカウントができてしまうため（GitHub Issue #166 の 4）。
	// 園児の状態は言わず、無いコードと同じ文言にする
	if _, issuable := a.childIssuable(out.ChildID); !issuable {
		return out, errors.New("招待コードが確認できません。園から配布されたコードをお確かめください")
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
	// 利用規約に同意したか（画面の「利用規約に同意します」）と、画面に出して同意を得た規約の版。
	// 同意は要配慮個人情報を取り扱う根拠であり、いつ・どの版に同意したかを後から示せる必要がある
	// （基本設計書「同意履歴（t_terms_agreement）」(5-2)。GitHub Issue #170）
	TermsAgreed  bool   `json:"terms_agreed"`
	TermsVersion string `json:"terms_version"`
}

// guardianRelationships は続柄の選択肢（画面詳細図「新規登録画面（保護者）」(2-3) 項目11）
var guardianRelationships = map[string]bool{"母": true, "父": true, "祖母": true, "祖父": true, "その他": true}

// termsNotAgreedMessage は規約に同意しないときの文言（基本設計書「メッセージ一覧」(4-9)「規約に同意しない」）
const termsNotAgreedMessage = "利用規約に同意いただけない場合、ご利用いただけません。"

// 【仮置き】画面に出していた規約が、送るまでのあいだに改定されたときの文言（web/仮置き値.md）
const termsOutdatedMessage = "利用規約が改定されました。改定後の利用規約をお読みいただき、あらためて同意してください。"

func (a *app) handleSignUpGuardian(w http.ResponseWriter, r *http.Request) {
	// ログイン中は新しいアカウントを作らせない。登録が成立するとセッションが新しい保護者に置き換わり、
	// 上書きログインと同じことになる（基本設計書「ログイン」(4-3)。GitHub Issue #159）
	if _, ok := a.sessions.accountID(r); ok {
		writeAlreadyLoggedIn(w)
		return
	}
	var req signUpRequest
	if !readJSON(w, r, &req) {
		return
	}

	code, err := a.lookupUsableCode(req.Code)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "招待コードが確認できません")
		return
	}
	/*
	 * 規約への同意を受け取ってから登録する。同意しなかった場合は登録を完了しない
	 * （基本設計書「保護者アカウントの自己登録」(4-3)、画面詳細図 2-3 項目5「未チェックのままでは登録できない」）。
	 * 画面のチェックだけで止めると、API を直接呼んだ登録にも同意の記録が付いてしまう（GitHub Issue #170）。
	 * 同意した版は、画面に出した版と、いま有効な版が同じときだけ記録する。送るまでのあいだに規約が改定されていたら、
	 * 読んでいない版に同意したことになるため、改定後の規約を読み直してもらう
	 */
	if !req.TermsAgreed {
		writeErr(w, http.StatusBadRequest, termsNotAgreedMessage)
		return
	}
	if req.TermsVersion != a.currentTermsVersion {
		writeErr(w, http.StatusBadRequest, termsOutdatedMessage)
		return
	}
	// ログインIDはメールアドレス。空や形式の誤りを受け付けない（要件定義書「ログインIDの定義」(4-1-1)）
	req.Email = strings.TrimSpace(req.Email)
	if msg := validateEmail(req.Email); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	/*
	 * ログインIDはロールをまたいで園内で一意（基本設計書 5-2）。
	 * 大文字・小文字だけが違うメールアドレスは同じ宛先に届くため、同じものとして重複を判定する（GitHub Issue #170）。
	 * 判定は職員アカウントの発行と同じ api_admin.go の emailTaken を使う（GitHub Issue #167 の 1）
	 */
	if a.emailTaken(req.Email) {
		writeErr(w, http.StatusBadRequest, "このメールアドレスはすでに登録されています")
		return
	}
	// 8〜128文字（文字数で数える）。よく使われるパスワードは拒否する（password.go）
	if msg := validateNewPassword(req.Password); msg != "" {
		writeErr(w, http.StatusBadRequest, msg)
		return
	}
	// 氏名は前後の空白を落として、50文字以内（基本設計書「入力項目の制約値」(4-9)「氏名・かな（園児・職員・保護者）」）
	req.GuardianName = strings.TrimSpace(req.GuardianName)
	if req.GuardianName == "" {
		writeErr(w, http.StatusBadRequest, "保護者の氏名を入力してください")
		return
	}
	if tooLong(req.GuardianName, 50) {
		writeErr(w, http.StatusBadRequest, "保護者の氏名は50文字以内で入力してください")
		return
	}
	// 続柄は必須で、選択肢のどれか（画面詳細図 2-3 項目11）。お迎えに来る人が誰かを職員が確かめる手がかりになる（基本設計書 5-5）
	if !guardianRelationships[req.Relationship] {
		writeErr(w, http.StatusBadRequest, "続柄は 母・父・祖母・祖父・その他 から選んでください")
		return
	}

	hash, err := hashPassword(req.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}

	/*
	 * 取引の中では a.db へ問い合わせない。接続は1本に絞っている（db.go）ため、取引の途中で a.db へ
	 * 問い合わせると、取引が握っている接続を待ち続けて、サーバ全体が応答しなくなる。tx を使う
	 */
	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}
	defer tx.Rollback()

	/*
	 * 招待コードは、取引の中で「未使用なら使用済みにする」条件付きの更新で押さえる。
	 * 1枚のコードは1アカウントの登録にのみ使える。使用と同時に status を使用済みにする（基本設計書 5-2）。
	 *
	 * 上の lookupUsableCode は取引の外で読むため、同じコードを同時に送ると、どれも「未使用」と読める。
	 * 更新できた（1行）ものだけが登録へ進み、ほかは取引ごと取り消す（GitHub Issue #163）。
	 * SQLite は書き込みを1つずつ行うため、2つ目以降の更新は、1つ目の確定後の状態（使用済み）を見る
	 */
	res, err := tx.Exec(`UPDATE t_invitation_code SET status = '2', used_at = ?
		WHERE invitation_code_id = ? AND status = '1' AND expires_on >= ?`, now(), code.ID, today())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}
	if n, _ := res.RowsAffected(); n != 1 {
		// 文言は基本設計書「メッセージ一覧」(4-9)「招待コードが使用済み」による
		writeErr(w, http.StatusBadRequest, "この招待コードは既に使用されています。")
		return
	}

	res, err = tx.Exec(`INSERT INTO m_account
		(email, password_hash, role, status, is_temp_password, failed_login_count,
		 terms_version, terms_agreed_at, created_at, updated_at)
		VALUES (?, ?, '3', '1', 0, 0, ?, ?, ?, ?)`,
		req.Email, hash, a.currentTermsVersion, now(), now(), now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}
	accountID, _ := res.LastInsertId()

	// 登録のときの同意も履歴へ残す（基本設計書「同意履歴（t_terms_agreement）」(5-2)）
	if _, err := tx.Exec(`INSERT INTO t_terms_agreement (account_id, terms_id, agreed_at)
		VALUES (?, ?, ?)`, accountID, a.currentTermsID, now()); err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}

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
	if _, err := tx.Exec(`UPDATE t_invitation_code SET used_account_id = ? WHERE invitation_code_id = ?`,
		accountID, code.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}

	/*
	 * 自児の個人チャット・クラス・園全体へ参加させる。
	 * 個人チャットは園児ID（m_chat_room.child_id）で引く。個人チャットのルームは園児単位で作る
	 * （基本設計書「チャット」(5-5)）。部屋の名前（園児名＋「の保護者」）で探すと、同じ氏名の別の園児がいるとき、
	 * 別の家庭の個人チャットに入ってしまう（GitHub Issue #163。#140 の「あわせて気になる点」）
	 */
	tx.Exec(`INSERT OR IGNORE INTO t_chat_member (chat_room_id, account_id, joined_at)
		SELECT chat_room_id, ?, ? FROM m_chat_room WHERE room_type = '4' AND child_id = ?`,
		accountID, now(), code.ChildID)
	tx.Exec(`INSERT OR IGNORE INTO t_chat_member (chat_room_id, account_id, joined_at)
		SELECT r.chat_room_id, ?, ? FROM m_chat_room r
		 WHERE r.room_type = '2'
		   AND r.class_id IN (SELECT class_id FROM t_class_child WHERE child_id = ?)`,
		accountID, now(), code.ChildID)
	tx.Exec(`INSERT OR IGNORE INTO t_chat_member (chat_room_id, account_id, joined_at)
		SELECT chat_room_id, ?, ? FROM m_chat_room WHERE room_type = '1'`, accountID, now())

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

// writeAlreadyLoggedIn は、ログイン中に新しいログイン・新規登録を受けたときの応答。
// ログイン中の氏名・ロールは出さない。共有端末で前の利用者が誰であったかを第三者に示さないため
// （基本設計書「ログイン」(4-3)）
func writeAlreadyLoggedIn(w http.ResponseWriter) {
	writeJSON(w, http.StatusConflict, apiError{
		Kind:    "already_logged_in",
		Message: "すでにログインしています。別のアカウントでログインするには、先にログアウトしてください",
	})
}

func pad3(n int) string {
	return fmt.Sprintf("%03d", n)
}
