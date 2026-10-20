package main

import (
	"net/http"
	"strings"
)

/*
 * セキュリティに関わる応答ヘッダ（GitHub Issue #236 の 3・4）
 *
 * すべての応答に付ける。
 *   - Content-Security-Policy … 読み込めるものを自分のオリジンに限り、ほかのサイトの枠（iframe）に
 *     入れさせない（frame-ancestors。クリックジャッキングの対策）。XSS が起きたときの被害も抑える。
 *     style-src の 'unsafe-inline' は、画面が style 属性を使っているため
 *   - X-Content-Type-Options … Content-Type と違う種類として解釈させない
 *   - Referrer-Policy … ほかのサイトへ移るときに、園内の画面の URL を渡さない
 *
 * API の応答には Cache-Control: no-store を付ける。園児の情報（要配慮個人情報を含む）を、
 * 共有の端末のブラウザのキャッシュに残さないため（基本設計書「データ保護」(6-3)）。
 *
 * HTTPS で公開するとき（-secure）は Strict-Transport-Security も付ける。
 * localhost の http で付けると、ブラウザが以後 https でしかつながなくなるため、既定では付けない。
 *
 * 【仮置き】ヘッダの値は設計に定めが無い（web/仮置き値.md）。
 */

const contentSecurityPolicy = "default-src 'self'; " +
	"img-src 'self' data: blob:; " +
	"style-src 'self' 'unsafe-inline'; " +
	"object-src 'none'; " +
	"base-uri 'self'; " +
	"form-action 'self'; " +
	"frame-ancestors 'none'"

func securityHeaders(next http.Handler, secure bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		if secure {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}
