package main

import (
	"database/sql"
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// envOr は、環境変数があればその値、無ければ fallback
func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

type app struct {
	db       *sql.DB
	sessions *sessionStore
	// 添付ファイルの実体を置く場所（起動の引数 -files）。公開ディレクトリには置かず、権限の判定を通してから配信する
	// （基本設計書「添付ファイルの実体の保存先」(5-6)、詳細設計書「写真」(4-4 (2))）。空なら既定の files（photoRoot）
	filesDir string
	// 開いている画面への知らせ（events.go）。init で用意する
	live                *liveHub
	currentTermsVersion string
	// 最新版の規約のID。同意履歴（t_terms_agreement）へ記録するときに使う
	currentTermsID int64
	/*
		外部の AI を呼ぶ口（ai.go）。起動したときに環境変数 ANTHROPIC_API_KEY があれば本物（ai_claude.go）、無ければ nil で AI を使わない
		（詳細設計書「呼び出しの作り（差し替えられる形）」(8-7 (1))）。テストは偽物に差し替える
	*/
	ai draftWriter
	// キーが無効（401・403）と分かった。サーバを起動し直すまで AI を使えない扱いにする（決めたこと D-11）
	aiKeyRejected atomic.Bool
	// テストで AI の時間の上限を短くするとき（0 なら aiTimeout）
	aiTimeoutForTest time.Duration
	// 呼び出し中の AI の下書きの数（1日の上限に含める。api_ai.go の reserveAiCall）
	aiMu       sync.Mutex
	aiInFlight int
	// ログイン・招待コードの試行の見張り（attempts.go）。guard() で取り出す
	guardOnce sync.Once
	attempts  *attemptGuard
}

func main() {
	addr := flag.String("addr", ":8080", "待ち受けるアドレス")
	filesDir := flag.String("files", defaultFilesDir, "添付ファイル（連絡帳の写真）の実体を置くディレクトリ")
	dbPath := flag.String("db", "sukusuku.db", "SQLite のファイル")
	webDir := flag.String("web", "../web/dist", "配信する静的ファイルのディレクトリ")
	// AI の下書きに使うモデル（基本設計書「文章の下書き（AI）」(4-11) の claude-haiku-5-5）。
	// 【仮置き】変える口（-ai-model・環境変数 SUKUSUKU_AI_MODEL）は設計に無い（web/仮置き値.md）
	aiModel := flag.String("ai-model", envOr("SUKUSUKU_AI_MODEL", defaultAiModel), "AI の下書きに使うモデル")
	// HTTPS で公開するときに付ける。Cookie に Secure を付け、Strict-Transport-Security を返す（GitHub Issue #236 の 4）
	secure := flag.Bool("secure", false, "HTTPS で公開する（Cookie の Secure と HSTS を付ける）")
	flag.Parse()

	db, err := openDB(*dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	a := &app{db: db, sessions: newSessionStore(), filesDir: *filesDir}
	a.sessions.secure = *secure
	if err := a.init(); err != nil {
		log.Fatal(err)
	}
	/*
		API キーはサーバの環境変数 ANTHROPIC_API_KEY だけに置く（基本設計書「API キーの置き場所」(6-3)）。
		キーそのものはログ・画面・データベースに出さない。無ければ AI のボタンを出さず、ほかはすべて動く（8-8）
	*/
	if key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")); key != "" {
		a.ai = newClaudeWriter(key, *aiModel)
		log.Printf("AI の下書き：API キーがあります（モデル %s）。使うかは設定画面の AI の区画で決めます", *aiModel)
	} else {
		log.Printf("AI の下書き：API キーが無いため使いません（環境変数 ANTHROPIC_API_KEY）")
	}

	mux := http.NewServeMux()
	a.routes(mux)
	a.serveWeb(mux, *webDir)

	log.Printf("すくすくシステム サーバを起動します http://localhost%s", *addr)
	log.Printf("データベース: %s", *dbPath)
	/*
	 * 状態を変える要求は送信元を確かめてから通す（csrf.go）。応答にはセキュリティのヘッダを付ける（headers.go）。
	 *
	 * 接続ごとの待ち時間に上限を置く。上限が無いと、ヘッダや本文をゆっくり送り続ける接続で
	 * 待ち受けを使い切らせることができる（Slowloris。GitHub Issue #236 の 5）。
	 * WriteTimeout は置かない。相手の操作を開いている画面へ届ける接続（SSE）は長く開いたままにするため。
	 * 【仮置き】秒数は設計に定めが無い（web/仮置き値.md）
	 */
	srv := &http.Server{
		Addr:              *addr,
		Handler:           securityHeaders(checkOrigin(mux), *secure),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func (a *app) init() error {
	// 開いている画面への知らせ。セッションが終わったら、そのセッションの接続を閉じる（events.go）
	if a.live == nil {
		a.live = newLiveHub()
	}
	a.sessions.onEnd = a.live.closeSessions
	// 最新版の規約。これと異なる terms_version のアカウントには再同意を求める（基本設計書 5-2）。
	// 施行日が同じ版（デモの 1.0 と 1.1）は、あとから入れた版を新しいとする
	if err := a.db.QueryRow(`SELECT terms_version, terms_id FROM m_terms
		WHERE document_type = '1' ORDER BY published_on DESC, terms_id DESC LIMIT 1`).
		Scan(&a.currentTermsVersion, &a.currentTermsID); err != nil {
		return err
	}
	if err := a.seedPasswords(); err != nil {
		return err
	}
	if err := a.refreshDemoLock(); err != nil {
		return err
	}
	// 存在しないログインIDの照合に使うハッシュを、先に作っておく。最初の要求で作ると、
	// その1回だけ応答が遅くなり、IDが無いことが分かるため（password.go の dummyPasswordHash）
	dummyPasswordHash()
	// 職員のチャットの参加を、担任・ロール・状態から決まる規則に合わせる（chat_membership.go）
	return a.syncChatMembership()
}

// seedPasswords は、デモデータに入れた平文の目印（!pass1234）を bcrypt のハッシュへ置き換える。
//
// 【仮置き】ハッシュ方式は未確定である（要決定事項.md 優先度A）。bcrypt は仮の選択。
func (a *app) seedPasswords() error {
	rows, err := a.db.Query(`SELECT account_id, password_hash FROM m_account WHERE password_hash LIKE '!%'`)
	if err != nil {
		return err
	}
	type pending struct {
		id    int64
		plain string
	}
	var list []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.plain); err != nil {
			rows.Close()
			return err
		}
		list = append(list, p)
	}
	rows.Close()

	for _, p := range list {
		h, err := bcrypt.GenerateFromPassword([]byte(strings.TrimPrefix(p.plain, "!")), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		if _, err := a.db.Exec(`UPDATE m_account SET password_hash = ? WHERE account_id = ?`, string(h), p.id); err != nil {
			return err
		}
	}
	if len(list) > 0 {
		log.Printf("デモアカウント %d 件のパスワードをハッシュ化しました", len(list))
	}
	return nil
}

// refreshDemoLock はデモ用の編集ロックの時刻を現在時刻へ寄せる。
// 「他の職員が編集中」の状態を、いつ起動しても見せられるようにするため（画面詳細図 3-2）。
func (a *app) refreshDemoLock() error {
	_, err := a.db.Exec(`UPDATE t_diary_lock SET locked_at = ?, last_active_at = ?
	                      WHERE lock_token = 'lock-demo-0001'`, now(), now())
	return err
}

// serveWeb は React のビルド成果物を配信する。
// 画面側は React Router で経路を持つため、静的ファイルが無い経路は index.html へ寄せる。
//
// 【仮置き】キャッシュの指定（web/仮置き値.md「応答ヘッダ」）。
//   - index.html と、そこへ寄せる経路は no-cache（毎回サーバに確かめる。変わっていなければ 304 で軽い）。
//     指定が無いと、ブラウザは Last-Modified から手元の写しを使ってよい時間を見積もり、反映のあとも何時間も
//     古い画面を出し続けた（2026-10-29、OCI の公開先が「ログインしたまま古い」）
//   - /assets/ はビルドが中身からハッシュを付けた名前なので、1年持たせて immutable にする
//   - /assets/ に無いファイルは index.html へ寄せず 404 にする。反映で古いハッシュのファイルが消えたあと、
//     古い画面がそれを読みに来ると、HTML が JavaScript として返って画面が真っ白になるため
func (a *app) serveWeb(mux *http.ServeMux, dir string) {
	index := filepath.Join(dir, "index.html")
	if _, err := os.Stat(index); err != nil {
		log.Printf("静的ファイルが見つかりません（%s）。web/ で npm run build を実行してください", dir)
	}
	files := http.FileServer(http.Dir(dir))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeErr(w, http.StatusNotFound, "そのエンドポイントはありません")
			return
		}
		// /assets/ の下のファイル名の形の経路だけ。/assets/ そのもの（フォルダ）は今までどおり index.html へ寄せる
		hashed := strings.HasPrefix(r.URL.Path, "/assets/") && !strings.HasSuffix(r.URL.Path, "/")
		// ディレクトリは渡さない。渡すと http.FileServer が中身の一覧を返す（GitHub Issue #236 の 10）
		if fi, err := os.Stat(filepath.Join(dir, filepath.Clean(r.URL.Path))); err == nil && !fi.IsDir() {
			if hashed {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			files.ServeHTTP(w, r)
			return
		}
		if hashed {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, index)
	})
}
