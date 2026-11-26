package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"unicode/utf8"
)

/*
 * 演習用：合言葉つきの URL でのログイン（POST /api/demo-login）
 *
 * 【仮置き】設計書に定めが無い。公開先のデモで、持ち主がログインID・パスワードを打たずに西田 拓也として入るための
 * 入口であり、実装（本番）では持たない（web/仮置き値.md）。
 *
 * - 環境変数 SUKUSUKU_DEMO_LOGIN_KEY（合言葉）を置いたときだけ働く。空・未設定なら、この口は無い（404）。
 *   32 文字（バイトでなく文字）より短い値は、推測されやすいので無効として扱い、起動のログに一言出す。
 *   合言葉の値そのものは、ログ・応答・データベースのどこにも出さない。
 * - 合言葉の判定はサーバだけで行う。画面（web/src/screens/auth/DemoLoginScreen.tsx）は合言葉を送るだけで、
 *   持たない。アカウントの選び分け（職員は nishida@hoiku.example.jp、保護者は nishida.t@example.jp）もここで行い、
 *   デモのログインIDを web のコードへ書かない（web/build/keepMockOutOfBuild.ts の見張り）。
 * - セッションは handleLogin と同じ sessionStore.create で作る（Cookie の属性・自動ログアウト・記憶の上限・
 *   同時ログインの扱いはそのまま）。飛ばすのはパスワードの照合だけ。
 * - 合言葉が違った要求は、未ログインで呼べるほかの口と同じく、送信元ごとの失敗の上限（attempts.go）に数える。
 *   上限を超えた送信元は、照合せずに断る。この口があるかどうかを外から悟らせないため、機能が無いときと、
 *   合言葉が違うとき・上限を超えたときの応答は、同じ 404 にする。
 */

// 合言葉の最小の長さ（文字数）。【仮置き】
const demoLoginKeyMinLen = 32

const (
	demoLoginStaffEmail    = "nishida@hoiku.example.jp"
	demoLoginGuardianEmail = "nishida.t@example.jp"
)

// demoLoginKeyFromEnv は、環境変数の合言葉を読む。使えない値（空・短い）は空を返し、短いときは理由をログに出す
func demoLoginKeyFromEnv() string {
	key := strings.TrimSpace(os.Getenv("SUKUSUKU_DEMO_LOGIN_KEY"))
	if key == "" {
		return ""
	}
	if utf8.RuneCountInString(key) < demoLoginKeyMinLen {
		log.Printf("合言葉つきの URL でのログイン：SUKUSUKU_DEMO_LOGIN_KEY が %d 文字より短いため使いません", demoLoginKeyMinLen)
		return ""
	}
	return key
}

type demoLoginRequest struct {
	Key string `json:"key"`
	As  string `json:"as"`
}

// writeDemoLoginNotFound は、この口が無いときと同じ応答。合言葉が違うときにも使う
func writeDemoLoginNotFound(w http.ResponseWriter) {
	writeErr(w, http.StatusNotFound, "見つかりません")
}

func (a *app) handleDemoLogin(w http.ResponseWriter, r *http.Request) {
	if utf8.RuneCountInString(a.demoLoginKey) < demoLoginKeyMinLen {
		writeDemoLoginNotFound(w)
		return
	}
	// 上限を超えた送信元は、照合せずに断る。応答は合言葉が違うときと同じにする
	if a.guard().blocked(r) {
		writeDemoLoginNotFound(w)
		return
	}
	var req demoLoginRequest
	if !readJSON(w, r, &req) {
		return
	}
	// 長さの違いから合言葉の長さを悟らせないよう、ハッシュにしてから定数時間で比べる
	got, want := sha256.Sum256([]byte(req.Key)), sha256.Sum256([]byte(a.demoLoginKey))
	if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
		a.guard().failed(r)
		writeDemoLoginNotFound(w)
		return
	}

	// ここから先は、合言葉を知っている相手。handleLogin と同じく、ログイン中は新しいセッションを作らない
	if _, ok := a.sessionAccount(r); ok {
		writeAlreadyLoggedIn(w)
		return
	}
	var email string
	switch req.As {
	case "staff":
		email = demoLoginStaffEmail
	case "guardian":
		email = demoLoginGuardianEmail
	default:
		writeErr(w, http.StatusBadRequest, "入口の指定が正しくありません")
		return
	}

	var (
		accountID int64
		role      string
		status    string
	)
	err := a.db.QueryRow(`SELECT account_id, role, status FROM m_account WHERE email = ?`, email).
		Scan(&accountID, &role, &status)
	if errors.Is(err, sql.ErrNoRows) {
		writeDemoLoginNotFound(w)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ログインの処理に失敗しました")
		return
	}
	if status == accountSuspended {
		writeForbidden(w, "このアカウントは停止されています")
		return
	}

	isStaffAccount := role == roleAdmin || role == roleGeneralStaff
	a.sessions.create(w, accountID, req.As, isStaffAccount, false, a.rememberPeriod())

	u, err := a.loadSessionUser(accountID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ログインの処理に失敗しました")
		return
	}
	a.log(accountID, fnAccount, opUpdate, "m_account", i64(accountID), nil, nil, s("合言葉のURLでログイン"))
	writeJSON(w, http.StatusOK, u)
}
