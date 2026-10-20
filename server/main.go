package main

import (
	"database/sql"
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

type app struct {
	db       *sql.DB
	sessions *sessionStore
	// 開いている画面への知らせ（events.go）。init で用意する
	live                *liveHub
	currentTermsVersion string
	// 最新版の規約のID。同意履歴（t_terms_agreement）へ記録するときに使う
	currentTermsID int64
}

func main() {
	addr := flag.String("addr", ":8080", "待ち受けるアドレス")
	dbPath := flag.String("db", "sukusuku.db", "SQLite のファイル")
	webDir := flag.String("web", "../web/dist", "配信する静的ファイルのディレクトリ")
	flag.Parse()

	db, err := openDB(*dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	a := &app{db: db, sessions: newSessionStore()}
	if err := a.init(); err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	a.routes(mux)
	a.serveWeb(mux, *webDir)

	log.Printf("すくすくシステム サーバを起動します http://localhost%s", *addr)
	log.Printf("データベース: %s", *dbPath)
	// 状態を変える要求は送信元を確かめてから通す（csrf.go）
	if err := http.ListenAndServe(*addr, checkOrigin(mux)); err != nil {
		log.Fatal(err)
	}
}

func (a *app) init() error {
	// 開いている画面への知らせ。セッションが終わったら、そのセッションの接続を閉じる（events.go）
	if a.live == nil {
		a.live = newLiveHub()
	}
	a.sessions.onEnd = a.live.closeSessions
	// 最新版の規約。これと異なる terms_version のアカウントには再同意を求める（基本設計書 5-2）
	if err := a.db.QueryRow(`SELECT terms_version, terms_id FROM m_terms
		WHERE document_type = '1' ORDER BY published_on DESC LIMIT 1`).
		Scan(&a.currentTermsVersion, &a.currentTermsID); err != nil {
		return err
	}
	if err := a.seedPasswords(); err != nil {
		return err
	}
	if err := a.refreshDemoLock(); err != nil {
		return err
	}
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
		if _, err := os.Stat(filepath.Join(dir, filepath.Clean(r.URL.Path))); err == nil && r.URL.Path != "/" {
			files.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, index)
	})
}
