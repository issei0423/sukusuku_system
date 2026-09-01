package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
)

// apiError は画面へ返すエラー。本文はそのまま利用者に見せる文言とする。
type apiError struct {
	Message string `json:"message"`
	// ログインの失敗理由など、画面が分岐に使う追加情報
	Kind      string `json:"kind,omitempty"`
	Remaining int    `json:"remaining,omitempty"`
	Correct   string `json:"correct,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("JSON の書き出しに失敗しました: %v", err)
	}
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
