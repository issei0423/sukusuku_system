package main

import "net/http"

/*
 * 画面が呼ぶエンドポイントの配線
 *
 * 一覧は server/README.md「実装するエンドポイント」に対応する。
 * 権限の判定は各ハンドラの入口（requireStaff / requireAdmin）と、
 * 参照範囲の判定（canSeeChild / visibleChildren / visibleDiaryCondition）で行う。
 * 画面側の出し分けは操作性のためであり、権限の担保ではない（基本設計書「権限チェックの実装方針」(6-2)）。
 */
func (a *app) routes(mux *http.ServeMux) {
	// ---- 認証（基本設計書「共通基盤：ログインとアカウント」(4-3)） ----
	mux.HandleFunc("POST /api/login", a.handleLogin)
	mux.HandleFunc("POST /api/logout", a.handleLogout)
	mux.HandleFunc("GET /api/me", a.handleMe)
	mux.HandleFunc("POST /api/password", a.handleChangePassword)
	mux.HandleFunc("GET /api/terms", a.handleCurrentTerms)
	mux.HandleFunc("POST /api/terms/agree", a.handleAgreeTerms)
	mux.HandleFunc("POST /api/invitation/verify", a.handleVerifyInvitationCode)
	mux.HandleFunc("POST /api/signup", a.handleSignUpGuardian)

	// ---- 園児マスター（基本設計書「共通基盤：園児マスターの管理」(4-4)） ----
	mux.HandleFunc("GET /api/classes", a.handleClasses)
	mux.HandleFunc("GET /api/children", a.handleListChildren)
	mux.HandleFunc("POST /api/children", a.handleSaveChild)
	mux.HandleFunc("GET /api/children/allergies", a.handleAllAllergies)
	mux.HandleFunc("GET /api/children/{childID}", a.handleGetChild)
	mux.HandleFunc("DELETE /api/children/{childID}", a.handleRemoveChild)
	mux.HandleFunc("GET /api/children/{childID}/allergies", a.handleAllergiesOf)
	mux.HandleFunc("GET /api/children/{childID}/medical-histories", a.handleMedicalHistoriesOf)
	mux.HandleFunc("GET /api/children/{childID}/class", a.handleClassOfChild)

	// ---- 日誌システム（基本設計書「日誌システム」(4-5)） ----
	mux.HandleFunc("GET /api/diaries", a.handleListDiaries)
	mux.HandleFunc("GET /api/diaries/templates", a.handleDiaryTemplates)
	mux.HandleFunc("GET /api/diaries/phrases", a.handleDiaryPhrases)
	mux.HandleFunc("GET /api/diaries/{id}", a.handleGetDiary)
	mux.HandleFunc("GET /api/diaries/{id}/attachments", a.handleDiaryAttachments)
	mux.HandleFunc("GET /api/children/{childID}/diaries", a.handlePastDiaries)
	mux.HandleFunc("GET /api/children/{childID}/timeline", a.handleTimeline)
}
