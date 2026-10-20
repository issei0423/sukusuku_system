package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"log"
	"net/http"
	"sync"
	"time"
)

/*
 * ログイン状態の保持
 *
 * 【仮置き】認証情報の保持方式は未確定である（要決定事項.md 優先度A）。
 * ここではサーバ側にセッションを持ち、HttpOnly・SameSite=Strict の Cookie で
 * セッションIDだけを渡す方式を仮に採っている。方式が決まったら差し替える。
 *
 * 【仮置き】CSRF 対策の方式も未確定（同 優先度A）。
 * SameSite=Strict は緩和策であって、対策の決定ではない。
 */

type session struct {
	accountID int64
	// 開いた入口。ログアウトの遷移先はログインしていた系統のトップ（基本設計書「画面遷移」(3-4)）
	entrance  string
	expiresAt time.Time
}

type sessionStore struct {
	mu   sync.RWMutex
	data map[string]session
	// HTTPS で公開するときに真にする。Cookie に Secure を付ける（main.go の -secure。GitHub Issue #236 の 4）
	secure bool
	// セッションが終わったとき（destroy・destroyAccount）に、終わったセッションIDを受け取る。
	// 開いている画面への知らせの接続を、その場で閉じるために使う（events.go の closeSessions）。
	// 鍵を外してから呼ぶ
	onEnd func(ids []string)
}

// ended は、終わったセッションを知らせる
func (s *sessionStore) ended(ids []string) {
	if s.onEnd != nil && len(ids) > 0 {
		s.onEnd(ids)
	}
}

func newSessionStore() *sessionStore {
	return &sessionStore{data: make(map[string]session)}
}

const sessionCookie = "sukusuku_session"

func randomToken(bytes int) string {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		// 乱数が取れない状態で推測しやすい値を返すわけにはいかない
		log.Fatalf("乱数を生成できません: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func (s *sessionStore) create(w http.ResponseWriter, accountID int64, entrance string, ttlMinutes int) {
	id := randomToken(32)
	s.mu.Lock()
	// 期限の切れたセッションを掃除する。参照のときに弾くだけでは、ログアウトしないまま切れたものが
	// メモリに溜まり続けるため（GitHub Issue #236 の 9）。ログインのたびに一度なめれば十分に小さく保てる
	t := time.Now()
	for k, v := range s.data {
		if t.After(v.expiresAt) {
			delete(s.data, k)
		}
	}
	s.data[id] = session{accountID: accountID, entrance: entrance, expiresAt: time.Now().Add(time.Duration(ttlMinutes) * time.Minute)}
	s.mu.Unlock()

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   ttlMinutes * 60,
		// Secure は HTTPS 公開時に true にする（起動時の -secure）。本演習の動作検証環境は localhost のため既定は false
		// （要件定義書「想定運用環境（HTTPS公開）」(6-1)・「本演習での動作検証環境（localhost）」(6-2)）
		Secure: s.secure,
	})
}

func (s *sessionStore) destroy(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.mu.Lock()
		delete(s.data, c.Value)
		s.mu.Unlock()
		s.ended([]string{c.Value})
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: s.secure})
}

func (s *sessionStore) accountID(r *http.Request) (int64, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return 0, false
	}
	s.mu.RLock()
	sess, ok := s.data[c.Value]
	s.mu.RUnlock()
	if !ok || time.Now().After(sess.expiresAt) {
		return 0, false
	}
	return sess.accountID, true
}

// sessionID は、要求が持つセッションIDを返す。無ければ空文字
func sessionID(r *http.Request) string {
	if c, err := r.Cookie(sessionCookie); err == nil {
		return c.Value
	}
	return ""
}

/*
destroyAccount は、そのアカウントのセッションを keep 以外すべて無効化する。消した数を返す。

サーバ側にセッションを持つのは、サーバ側で即座に無効化できるためである（基本設計書「認証情報の保持方式」(6-3)）。
次のときに呼ぶ（GitHub Issue #159）。
  - パスワードの変更 … 変更した端末以外のセッションをすべて無効化する（同 6-3、画面詳細図 2-4）。keep は変更した端末のセッション
  - 一時パスワードの再発行 … その時点で旧パスワードを無効化する（基本設計書「一時パスワードの再発行」(4-3)）。
    旧パスワードで入ったセッションも同じ扱いにする
  - アカウントの停止 … 停止したアカウントはログインできない（要件定義書、画面詳細図 7-8 項目5）
  - 紐づけの解除 … その園児の記録を参照できなくなる（画面詳細図 7-8 項目6、基本設計書 5-5）
*/
func (s *sessionStore) destroyAccount(accountID int64, keep string) int {
	s.mu.Lock()
	var ids []string
	for id, sess := range s.data {
		if sess.accountID == accountID && id != keep {
			delete(s.data, id)
			ids = append(ids, id)
		}
	}
	s.mu.Unlock()
	s.ended(ids)
	return len(ids)
}

// ---- 利用者の組み立て ----

func (a *app) loadSessionUser(accountID int64) (*SessionUser, error) {
	var (
		u         SessionUser
		staffID   sql.NullString
		guardID   sql.NullString
		classID   sql.NullInt64
		className sql.NullString
		termsVer  sql.NullString
		staffName sql.NullString
		guardName sql.NullString
	)
	err := a.db.QueryRow(`
		SELECT a.account_id, a.email, a.role, a.status, a.is_temp_password, a.terms_version,
		       s.staff_id, s.staff_name, g.guardian_id, g.guardian_name,
		       c.class_id, c.class_name
		  FROM m_account a
		  LEFT JOIN m_staff    s ON s.account_id = a.account_id
		  LEFT JOIN m_guardian g ON g.account_id = a.account_id
		  LEFT JOIN t_class_staff cs ON cs.staff_id = s.staff_id
		  LEFT JOIN m_class    c ON c.class_id = cs.class_id AND c.fiscal_year = ?
		 WHERE a.account_id = ?`, fiscalYear, accountID).
		Scan(&u.AccountID, &u.Email, &u.Role, &u.status, &u.IsTempPassword, &termsVer,
			&staffID, &staffName, &guardID, &guardName, &classID, &className)
	if err != nil {
		return nil, err
	}

	u.StaffID = nullStr(staffID)
	u.GuardianID = nullStr(guardID)
	u.ClassID = nullInt(classID)
	u.ClassName = nullStr(className)
	switch {
	case staffName.Valid:
		u.DisplayName = staffName.String
	case guardName.Valid:
		u.DisplayName = guardName.String
	default:
		u.DisplayName = u.Email
	}
	u.TermsAgreed = termsVer.Valid && termsVer.String == a.currentTermsVersion
	return &u, nil
}

/*
 * 手続きを終えるまで、ほかの機能を使わせない
 *
 * 一時パスワードでのログイン時と規約の改定後の初回ログイン時は、変更・同意を完了するまで
 * 他の画面へ進めない（基本設計書「画面遷移」(3-4)）。is_temp_password が真の間は他機能を使わせない
 * （同「アカウント（m_account）」(5-2)）。画面の出し分けだけでは API を直接呼ぶと通るため、
 * ここで拒否する（同「権限チェックの実装方針」(6-2)。GitHub Issue #153）。
 *
 * 拒否は 403 とし、理由を kind で返す。画面はこれを見て、パスワードの変更・規約への同意の画面へ案内する
 * （web/src/api/procedure.ts）。文言は画面側のモック（同ファイルの procedureMessages）と同じにしてある。
 *
 * 手続きの途中でも通すのは、手続きの画面が呼ぶ API だけである（requireLogin を使うもの）。
 *   - GET  /api/me           … 自分の情報。ページを開き直したとき・手続きのあとに画面を進めるため
 *   - POST /api/password     … パスワードの変更
 *   - POST /api/terms/agree  … 規約への同意
 * ログイン・ログアウト・規約の本文（GET /api/terms）はセッションを問わない。
 * 参照表（GET /api/reference）は園児名・職員名を載せるため通さない。画面は手続きを終えてから読み込む。
 */
const (
	kindPasswordChangeRequired = "password_change_required"
	kindTermsAgreementRequired = "terms_agreement_required"
)

// requireLogin はログイン中の利用者を取り出す。未ログインなら 401 を返す。
// 一時パスワード中・規約の再同意が必要な間も通す。手続きそのものの API だけが使う。
//
// 停止中のアカウントは、セッションが残っていても通さない。状態は要求のたびにデータベースから読む。
// 停止・紐づけの解除のときにはセッションも消している（destroyAccount）が、状態だけが変わる経路が
// あっても止まるようにするため（GitHub Issue #159）。停止したアカウントはログインできない（要件定義書、
// 画面詳細図 7-8 項目5）
func (a *app) requireLogin(w http.ResponseWriter, r *http.Request) (*SessionUser, bool) {
	id, ok := a.sessions.accountID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, apiError{Message: "ログインしていません"})
		return nil, false
	}
	u, err := a.loadSessionUser(id)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, apiError{Message: "ログインしていません"})
		return nil, false
	}
	if u.isSuspended() {
		a.sessions.destroyAccount(u.AccountID, "")
		writeJSON(w, http.StatusUnauthorized, apiError{Message: "ログインしていません"})
		return nil, false
	}
	return u, true
}

// requireUser はログイン中の利用者を取り出す。未ログインなら 401 を返す。
// 一時パスワード中・規約の再同意が必要な間は、手続きを終えるまで 403 を返す。
// 状態は毎回データベースから読む。ログイン中に一時パスワードを発行し直されたときも、その時点から止めるため
func (a *app) requireUser(w http.ResponseWriter, r *http.Request) (*SessionUser, bool) {
	u, ok := a.requireLogin(w, r)
	if !ok {
		return nil, false
	}
	// 両方が要るときはパスワードの変更を先に求める。画面（TopScreen）が案内する順と同じ
	switch {
	case u.IsTempPassword:
		writeJSON(w, http.StatusForbidden, apiError{
			Kind:    kindPasswordChangeRequired,
			Message: "一時パスワードのままでは、ほかの機能は利用できません。パスワードを変更してください",
		})
		return nil, false
	case !u.TermsAgreed:
		writeJSON(w, http.StatusForbidden, apiError{
			Kind:    kindTermsAgreementRequired,
			Message: "利用規約に同意するまで、ほかの機能は利用できません。利用規約をご確認ください",
		})
		return nil, false
	}
	return u, true
}

// requireStaff は職員のみを通す
func (a *app) requireStaff(w http.ResponseWriter, r *http.Request) (*SessionUser, bool) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return nil, false
	}
	if !u.isStaff() {
		writeForbidden(w, "職員のみが行えます")
		return nil, false
	}
	return u, true
}

// requireAdmin は管理者のみを通す
func (a *app) requireAdmin(w http.ResponseWriter, r *http.Request) (*SessionUser, bool) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return nil, false
	}
	if !u.isAdmin() {
		writeForbidden(w, "この操作は管理者のみが行えます")
		return nil, false
	}
	return u, true
}
