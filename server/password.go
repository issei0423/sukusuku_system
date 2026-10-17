package main

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

/*
 * パスワードの検査とハッシュ化
 * 典拠：基本設計書.md「入力項目の制約値」(4-9)「パスワード｜8〜128文字。文字種の組み合わせは求めない」
 *      基本設計書.md「パスワードの要件」(6-3)「よく使われるパスワード｜password などは拒否する」
 *
 * 長さは文字数（符号位置の数）で数える。バイト数で数えると、日本語3文字（9バイト）が通り、
 * 画面（文字数で数える）とサーバで判定が食い違う（GitHub Issue #159）。
 * 画面側（web/src/api/util.ts の validateNewPassword）と同じ規則にしてある。
 */

const (
	passwordMinLength = 8
	passwordMaxLength = 128
)

/*
commonPasswords は、よく使われるため拒否するパスワード。大文字・小文字を区別せずに照らす。

【仮置き】設計は「password などは拒否する」とだけ定め、一覧を定めていない（web/仮置き値.md）。
漏えいしたパスワードの一覧から、8文字以上で上位に来るものを置いた。
画面側（web/src/api/util.ts の COMMON_PASSWORDS）と同じ一覧にしてある。
*/
var commonPasswords = map[string]bool{
	"password": true, "password1": true, "password12": true, "password123": true, "passw0rd": true,
	"12345678": true, "123456789": true, "1234567890": true, "87654321": true, "11111111": true,
	"00000000": true, "88888888": true, "qwertyui": true, "qwertyuiop": true, "asdfghjk": true,
	"abcd1234": true, "abcdefgh": true, "iloveyou": true, "1q2w3e4r": true, "1qaz2wsx": true,
	"zaq12wsx": true, "sunshine": true, "princess": true, "football": true, "baseball": true,
}

// validateNewPassword は、新しく設定するパスワードを検査する。問題が無ければ空文字を返す
func validateNewPassword(p string) string {
	n := len([]rune(p))
	switch {
	case n < passwordMinLength:
		return "パスワードは8文字以上で入力してください"
	case n > passwordMaxLength:
		return "パスワードは128文字以内で入力してください"
	case commonPasswords[strings.ToLower(p)]:
		return "よく使われるパスワードは使えません。別のパスワードを入力してください"
	}
	return ""
}

/*
bcryptInput は、bcrypt へ渡す値を作る。

bcrypt は 72 バイトまでしか扱えず、それを超えると Go の実装はエラーを返す（以前はこれを 500 にしていた）。
上限の 128 文字は日本語なら 384 バイトになるため、72 バイトを超えるものは SHA-256 の要約（base64 で 44 文字）に
置き換えてから渡す。72 バイト以下はそのまま渡すので、これまでに保存したハッシュはそのまま照合できる。
要約に置き換えた値には接頭辞を付け、そのまま渡した値と取り違えないようにする。

【仮置き】ハッシュ方式そのもの（bcrypt）が仮の選択である（web/仮置き値.md「認証まわりの仮置き」）。
*/
func bcryptInput(p string) []byte {
	if len(p) <= 72 {
		return []byte(p)
	}
	sum := sha256.Sum256([]byte(p))
	return []byte("sha256:" + base64.StdEncoding.EncodeToString(sum[:]))
}

// hashPassword はパスワードをハッシュ化する。平文は保持しない（基本設計書「データ保護」(6-3)）
func hashPassword(p string) (string, error) {
	h, err := bcrypt.GenerateFromPassword(bcryptInput(p), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

// checkPassword は、保存したハッシュとパスワードを照合する
func checkPassword(hash, p string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), bcryptInput(p)) == nil
}
