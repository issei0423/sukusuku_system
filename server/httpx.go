package main

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"
)

// apiError は画面へ返すエラー。本文はそのまま利用者に見せる文言とする。
type apiError struct {
	Message string `json:"message"`
	// ログインの失敗理由など、画面が分岐に使う追加情報
	Kind      string `json:"kind,omitempty"`
	Remaining int    `json:"remaining,omitempty"`
	Correct   string `json:"correct,omitempty"`
	// 他児の名前の注意（409 other_child_names）で、当たった園児の氏名と本文の中の位置（詳細設計書「誤りの応答」(4-1 (3))）
	Names   []string    `json:"names,omitempty"`
	Matches []nameMatch `json:"matches,omitempty"`
}

/*
writeJSON は値を JSON にして返す。

JSON にしてから状態を書く。先に 200 を書いてから JSON にできない値（+Inf など）に当たると、
200 の空の本文が返り、画面は中身が null のまま描こうとして真っ白になる（GitHub Issue #160）。
JSON にできないときは 500 と文言を返し、画面にはエラーとして出させる。
*/
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if v == nil {
		w.WriteHeader(status)
		return
	}
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(v); err != nil {
		log.Printf("JSON の書き出しに失敗しました: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(apiError{Message: "データを返せませんでした。管理者へご連絡ください"})
		return
	}
	w.WriteHeader(status)
	w.Write(buf.Bytes())
}

func writeErr(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, apiError{Message: message})
}

// 権限が無いことを返す。画面側の出し分けは操作性のためであり、
// 権限の担保はここで行う（基本設計書「権限チェックの実装方針」(6-2)）
func writeForbidden(w http.ResponseWriter, message string) {
	writeJSON(w, http.StatusForbidden, apiError{Message: message})
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "リクエストの内容を読み取れませんでした")
		return false
	}
	return true
}

// tooLong は、文字数（バイト数ではない）が上限を超えているかを返す。
// 上限の正は基本設計書「入力項目の制約値」(4-9)
func tooLong(v string, max int) bool {
	return len([]rune(v)) > max
}

// isKana は、よみとして受け取れる文字だけで出来ているかを返す。
// ひらがな・長音・姓と名のあいだの空白を受け取る
func isKana(v string) bool {
	for _, c := range v {
		switch {
		case c >= 'ぁ' && c <= 'ゖ', c == 'ー', c == ' ', c == '　':
		default:
			return false
		}
	}
	return true
}

// isISODate は、'YYYY-MM-DD' の形で、実在する日付かを返す。
// 月日を1桁で書いた値（2026-10-1）や、2月30日のような値は受け取らない。
// 崩れた日付を保存すると、月齢の計算や日付の並べ替えが狂うため（GitHub Issue #164）
func isISODate(v string) bool {
	t, err := time.ParseInLocation("2006-01-02", v, jst)
	return err == nil && t.Format("2006-01-02") == v
}

// isISODateTime は、'YYYY-MM-DDTHH:MM:SS' の形で、実在する日時かを返す
func isISODateTime(v string) bool {
	t, err := time.ParseInLocation("2006-01-02T15:04:05", v, jst)
	return err == nil && t.Format("2006-01-02T15:04:05") == v
}

func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func queryInt64(r *http.Request, key string) (int64, bool) {
	v := r.URL.Query().Get(key)
	if v == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func pathInt64(r *http.Request, name string) (int64, bool) {
	n, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}
