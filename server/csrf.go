package main

import (
	"net/http"
	"net/url"
	"strings"
)

/*
 * CSRF 対策（要件定義書「セッションの保護」(8 No.9)、基本設計書「データ保護」(6-3)）
 *
 * 二段構えで守る。
 *
 * 1. セッションの Cookie を SameSite=Strict にする（session.go）。
 *    他サイトからの遷移では Cookie が送られないため、大半の攻撃は成立しない。
 * 2. 状態を変える要求（POST・PUT・PATCH・DELETE）で Origin を検証する。
 *
 * SameSite だけに頼らないのは、ブラウザによって扱いに差があり、
 * 将来この既定が緩和される可能性もあるためである。
 *
 * トークンを配って毎回照合する方式は採らない。Cookie でセッションを持つ構成では、
 * トークンの発行・保持・失効を画面側にも作り込むことになり、
 * 得られる安全性の差に見合わない。Origin の検証は数行で同じ効果が得られる。
 *
 * Origin を送らない要求は Referer で代替する。どちらも無いときは拒否する。
 * 「無ければ通す」は対策にならない。
 */

// 状態を変えないメソッド。読み取りだけなので検証の対象外とする
var safeMethods = map[string]bool{
	http.MethodGet:     true,
	http.MethodHead:    true,
	http.MethodOptions: true,
}

func checkOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if safeMethods[r.Method] || !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}

		if !sameOrigin(r) {
			writeForbidden(w, "要求の送信元を確認できませんでした")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// sameOrigin は、要求の送信元が要求先と同じかを判定する
func sameOrigin(r *http.Request) bool {
	// Origin が付いていればそれを見る
	if o := r.Header.Get("Origin"); o != "" {
		return hostOf(o) == r.Host
	}
	// Origin が無いときは Referer で代替する
	if ref := r.Header.Get("Referer"); ref != "" {
		return hostOf(ref) == r.Host
	}
	// どちらも無い要求は、ブラウザからの通常の操作ではない
	return false
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Host
}
