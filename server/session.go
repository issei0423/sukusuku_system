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

/*
 * ログインの期限（GitHub Issue #210）
 *
 * 期限は2つあり、どちらか一方に当たった時点で再認証を求める（要件定義書「『ログイン情報の記憶』と
 * 自動ログアウトの関係」(4-1-4 (4))）。
 *
 *   - ログインを保つ上限（expiresAt）… ログインした時刻から数える。操作を続けていても、過ぎたら切る
 *   - 自動ログアウト（idleLogout）… 職員の画面に限り、最後の操作から ui.auto_logout_minutes を過ぎたら切る。
 *     記憶を付けた職員にも課す（同上「自動ログアウトを優先する」）。保護者には課さない
 *     （基本設計書「システムの利用方法」(2-2)・「ログイン」(4-3)）
 *
 * 自動ログアウトの例外として、その職員が開始した午睡チェックが実施中のあいだは切らない
 * （基本設計書「午睡チェックの実施」(4-7)、要件定義書「午睡チェック中の例外」(4-1-4 (4))）。判定は app.sessionAccount。
 * 開いたままの画面が裏で読み直す要求と、知らせの受け取りは、操作に数えない（countsAsOperation）。
 *
 * 切れる時刻はサーバが決め、画面へ返す（api_session.go の GET /api/session。切れる前の予告と「続ける」に使う）。
 * 判定と返す時刻は、どちらも idleDeadline で求める。
 */
type session struct {
	accountID int64
	// 開いた入口。ログアウトの遷移先はログインしていた系統のトップ（基本設計書「画面遷移」(3-4)）
	entrance string
	// ログインを保つ上限。ログインした時刻に「ログイン情報の記憶」の保存期間（auth.remember_days）を足す。
	// 【仮置き】記憶を付けなかったときの上限は設計に無い。同じ保存期間を上限にする（web/仮置き値.md）
	expiresAt time.Time
	// 無操作で切るか（自動ログアウト）。職員の画面だけ真にする
	idleLogout bool
	// 最後の操作の時刻。無操作の時間はここから数える
	lastActiveAt time.Time
}

type sessionStore struct {
	mu   sync.RWMutex
	data map[string]session
	// いまの時刻。テストで時間を進めるために差し替える
	now func() time.Time
}

func newSessionStore() *sessionStore {
	return &sessionStore{data: make(map[string]session), now: time.Now}
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

/*
create はセッションを作り、Cookie で識別子を渡す。ログインそのものを最初の操作とする。

remember は「ログイン情報の記憶」を付けたか。付けたときだけ、Cookie に保存期間（lifetime）を持たせる。
ブラウザを閉じて開き直したときに再認証を求めずに済む期間が、記憶の意味である（要件定義書「『ログイン情報の記憶』と
自動ログアウトの関係」(4-1-4 (4))）。付けないときは、ブラウザを閉じたら消える Cookie にする。
職員の Cookie に自動ログアウトの時間を持たせない。持たせるとログインから数えて消えてしまう。無操作の判定はサーバが行う
*/
func (s *sessionStore) create(w http.ResponseWriter, accountID int64, entrance string, idleLogout, remember bool, lifetime time.Duration) {
	id := randomToken(32)
	at := s.now()
	s.mu.Lock()
	s.data[id] = session{
		accountID: accountID, entrance: entrance,
		expiresAt: at.Add(lifetime), idleLogout: idleLogout, lastActiveAt: at,
	}
	s.mu.Unlock()

	maxAge := 0
	if remember {
		maxAge = int(lifetime / time.Second)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   maxAge,
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

// lookup は、そのセッションを返す。無いもの・ログインを保つ上限を過ぎたものは返さない。
// 自動ログアウト（無操作）の判定はここではしない。午睡チェックの実施をデータベースで確かめるため、app.sessionAccount で行う
func (s *sessionStore) lookup(id string) (session, bool) {
	s.mu.RLock()
	sess, ok := s.data[id]
	s.mu.RUnlock()
	if !ok || s.now().After(sess.expiresAt) {
		return session{}, false
	}
	return sess, true
}

// touch は、そのセッションの最後の操作の時刻をいまにする
func (s *sessionStore) touch(id string) {
	s.mu.Lock()
	if sess, ok := s.data[id]; ok {
		sess.lastActiveAt = s.now()
		s.data[id] = sess
	}
	s.mu.Unlock()
}

// drop は、期限の切れたセッションを消す。切れたあとに操作しても、つながり直さない
func (s *sessionStore) drop(id string) {
	s.mu.Lock()
	delete(s.data, id)
	s.mu.Unlock()
}

/*
autoRefreshHeader は、開いたままの画面が裏で読み直す要求に付ける印の見出し。【仮置き】名前は設計に無い（web/仮置き値.md）。

職員の自動ログアウトは、最後の操作から時間を数える（基本設計書「ログイン」(4-3)）。画面の5秒ごとの読み直し
（web/src/hooks.ts の useAsync。GitHub Issue #150）は利用者の操作ではないので、画面はこの見出しを付けて送り
（web/src/api/automatic.ts）、サーバは期限を延ばさない。

印は「延ばさない」ことにだけ使う。付けても権限の判定は変わらない。付け忘れた要求は操作に数える側に倒れ、
切れるのが遅れるだけで、切れてはいけないときに切れることはない
*/
const autoRefreshHeader = "X-Sukusuku-Auto-Refresh"

// liveEventsPath は、開いている画面への知らせの受け取り口（PR #196 の GET /api/events。SSE）。
// 知らせの受け取りは、職員の自動ログアウトの「操作」に数えない（基本設計書「リアルタイムの反映と通知」(4-10)）。
// EventSource は見出しを付けられないため、経路で見る
const liveEventsPath = "/api/events"

// sessionStatusPath は、ログインの期限を尋ねる口（api_session.go の GET /api/session）。
// 画面は予告を出す前・出している間に何度も尋ねる。尋ねるたびに延びると切れなくなるため、操作に数えない（GitHub Issue #210）
const sessionStatusPath = "/api/session"

// countsAsOperation は、その要求を利用者の操作に数えるか（期限を延ばすか）を返す
func countsAsOperation(r *http.Request) bool {
	if r.Header.Get(autoRefreshHeader) != "" {
		return false
	}
	return r.URL.Path != liveEventsPath && r.URL.Path != sessionStatusPath
}

/*
sessionAccount は、要求のセッションがいま使えるかを判定し、そのアカウントを返す。期限を延ばすことはしない（requireLogin が行う）。

職員の画面は、最後の操作から ui.auto_logout_minutes を過ぎたら切る（自動ログアウト）。設定を変えたら、
ログイン中のセッションにもその場で効く。ただし、その職員が開始した午睡チェックが実施中のあいだは切らない。
実施が終わったら（終了の操作・時間帯の終わりでの自動の解除）、終わった時刻から数え直す。要件定義書「午睡チェック中の例外」
(4-1-4 (4)) の「以後は通常の自動ログアウトが適用される」による。実施中に操作が無くても、終わった直後に切れることはない
*/
func (a *app) sessionAccount(r *http.Request) (int64, bool) {
	id := sessionID(r)
	sess, ok := a.sessions.lookup(id)
	if !ok {
		return 0, false
	}
	if !sess.idleLogout {
		return sess.accountID, true
	}
	at := a.sessions.now()
	// 最後の操作から時間内なら、午睡チェックの実施を確かめるまでもなく使える（要求のたびにデータベースを引かない）
	if !at.After(sess.lastActiveAt.Add(a.idleLimit())) {
		return sess.accountID, true
	}
	deadline, napActive := a.idleDeadline(sess, at)
	if napActive || !at.After(deadline) {
		return sess.accountID, true
	}
	a.sessions.drop(id)
	return 0, false
}

// idleLimit は、自動ログアウトまでの無操作の時間（ui.auto_logout_minutes）
func (a *app) idleLimit() time.Duration {
	return time.Duration(a.settingInt("ui.auto_logout_minutes", 30)) * time.Minute
}

/*
idleDeadline は、職員のセッションが、このまま操作が無ければ切れる時刻を返す。切れるかどうかの判定（sessionAccount）と、
画面へ返す期限（api_session.go の sessionStatusOf）は、どちらもこれで求める。

最後の操作の時刻から ui.auto_logout_minutes。最後の操作より後に、その職員が開始した午睡チェックの実施が終わっていれば、
終わった時刻から数える。実施中なら切らないので、切れる時刻は決まらない（napActive が真、deadline はゼロ）
*/
func (a *app) idleDeadline(sess session, at time.Time) (deadline time.Time, napActive bool) {
	active, endedAt := a.napExemption(sess.accountID, sess.lastActiveAt, at)
	if active {
		return time.Time{}, true
	}
	from := sess.lastActiveAt
	if endedAt.After(from) {
		from = endedAt
	}
	return from.Add(a.idleLimit()), false
}

/*
napExemption は、そのアカウントの職員が開始した午睡チェックのうち、いま実施中のものがあるかを返す。
無ければ、since より後に終わった実施の、いちばん遅い終わりの時刻を返す（無ければゼロ）。

担当は開始した職員とする。担当を交代するときは「終了 → ログアウト → 次の職員がログイン → 開始」の順で
引き継ぐ（基本設計書「午睡チェックの実施」(4-7)）。実施の記録（t_nap_session）は、自動ログアウトの例外範囲と
担当者の追跡に用いる（同「午睡チェック」(5-7)）。

終了の操作を忘れた実施は、午睡の時間帯（nap.time_range）の終わりで解除する（napAutoCloseAt）。
データベースの解除（autoCloseNapSessions）を待たずに、同じ規則で解除の時刻を求める
*/
func (a *app) napExemption(accountID int64, since, at time.Time) (active bool, lastEnded time.Time) {
	const layout = "2006-01-02T15:04:05"
	// 接続は1本に絞っている（db.go）。行を読んでいる途中で a.db へ問い合わせないよう、設定は先に読む
	timeRange := a.settingText("nap.time_range", "13:00-15:00")
	rows, err := a.db.Query(`SELECT ns.session_date, ns.started_at, ns.ended_at
		  FROM t_nap_session ns
		  JOIN m_staff st ON st.staff_id = ns.started_staff_id
		 WHERE st.account_id = ? AND (ns.ended_at IS NULL OR ns.ended_at > ?)`,
		accountID, since.In(jst).Format(layout))
	if err != nil {
		// 確かめられないときは例外を当てず、通常の自動ログアウトにする。黙って捨てない（GitHub Issue #99）
		log.Printf("午睡チェックの実施を確かめられません（account=%d）: %v", accountID, err)
		return false, time.Time{}
	}
	defer rows.Close()

	nowISO := at.In(jst).Format(layout)
	for rows.Next() {
		var date, started string
		var ended sql.NullString
		if err := rows.Scan(&date, &started, &ended); err != nil {
			continue
		}
		end := ended.String
		if !ended.Valid {
			closeAt, _ := napAutoCloseAt(date, started, timeRange)
			if nowISO <= closeAt {
				return true, time.Time{}
			}
			end = closeAt
		}
		if t, err := time.ParseInLocation(layout, end, jst); err == nil && t.After(lastEnded) {
			lastEnded = t
		}
	}
	return false, lastEnded
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
	defer s.mu.Unlock()
	n := 0
	for id, sess := range s.data {
		if sess.accountID == accountID && id != keep {
			delete(s.data, id)
			n++
		}
	}
	return n
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
//
// 通した要求が利用者の操作なら、最後の操作の時刻をいまにする（自動ログアウトを最後の操作から数える。
// 基本設計書「ログイン」(4-3)。GitHub Issue #210）。裏の読み直し・知らせの受け取りでは延ばさない（countsAsOperation）
func (a *app) requireLogin(w http.ResponseWriter, r *http.Request) (*SessionUser, bool) {
	id, ok := a.sessionAccount(r)
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
	if countsAsOperation(r) {
		a.sessions.touch(sessionID(r))
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
