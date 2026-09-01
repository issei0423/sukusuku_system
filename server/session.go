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
	s.data[id] = session{accountID: accountID, entrance: entrance, expiresAt: time.Now().Add(time.Duration(ttlMinutes) * time.Minute)}
	s.mu.Unlock()

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   ttlMinutes * 60,
		// Secure は HTTPS 公開時に true にする。本演習の動作検証環境は localhost のため false
		// （要件定義書「想定運用環境（HTTPS公開）」(6-1)・「本演習での動作検証環境（localhost）」(6-2)）
		Secure: false,
	})
}

func (s *sessionStore) destroy(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.mu.Lock()
		delete(s.data, c.Value)
		s.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
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

// ---- 利用者の組み立て ----

func (a *app) loadSessionUser(accountID int64) (*SessionUser, error) {
	var (
		u        SessionUser
		staffID  sql.NullString
		guardID  sql.NullString
		classID  sql.NullInt64
		className sql.NullString
		termsVer sql.NullString
		staffName sql.NullString
		guardName sql.NullString
	)
	err := a.db.QueryRow(`
		SELECT a.account_id, a.email, a.role, a.is_temp_password, a.terms_version,
		       s.staff_id, s.staff_name, g.guardian_id, g.guardian_name,
		       c.class_id, c.class_name
		  FROM m_account a
		  LEFT JOIN m_staff    s ON s.account_id = a.account_id
		  LEFT JOIN m_guardian g ON g.account_id = a.account_id
		  LEFT JOIN t_class_staff cs ON cs.staff_id = s.staff_id
		  LEFT JOIN m_class    c ON c.class_id = cs.class_id AND c.fiscal_year = ?
		 WHERE a.account_id = ?`, fiscalYear, accountID).
		Scan(&u.AccountID, &u.Email, &u.Role, &u.IsTempPassword, &termsVer,
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

// requireUser はログイン中の利用者を取り出す。未ログインなら 401 を返す。
func (a *app) requireUser(w http.ResponseWriter, r *http.Request) (*SessionUser, bool) {
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
