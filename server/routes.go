package main

import "net/http"

/*
 * 画面が呼ぶエンドポイントの配線
 *
 * 権限の判定は各ハンドラの入口（requireStaff / requireAdmin）と、
 * 参照範囲の判定（canSeeChild / visibleChildren / visibleDiaryCondition）で行う。
 * 画面側の出し分けは操作性のためであり、権限の担保ではない
 * （基本設計書「権限チェックの実装方針」(6-2)）。
 */
func (a *app) routes(mux *http.ServeMux) {
	a.routeAuth(mux)
	a.routeChild(mux)
	a.routeDiary(mux)
	a.routeChat(mux)
	a.routeNap(mux)
	a.routeGrowth(mux)
	a.routeAdmin(mux)
}

// 共通基盤：ログインとアカウント（基本設計書 4-3）
func (a *app) routeAuth(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/login", a.handleLogin)
	mux.HandleFunc("POST /api/logout", a.handleLogout)
	mux.HandleFunc("GET /api/me", a.handleMe)
	mux.HandleFunc("GET /api/reference", a.handleReference)
	mux.HandleFunc("POST /api/password", a.handleChangePassword)
	mux.HandleFunc("GET /api/terms", a.handleCurrentTerms)
	mux.HandleFunc("POST /api/terms/agree", a.handleAgreeTerms)
	mux.HandleFunc("POST /api/invitation/verify", a.handleVerifyInvitationCode)
	mux.HandleFunc("POST /api/signup", a.handleSignUpGuardian)
	mux.HandleFunc("GET /api/dashboard/staff", a.handleStaffSummary)
	mux.HandleFunc("GET /api/dashboard/guardian", a.handleGuardianHome)
}

// 共通基盤：園児マスターの管理（基本設計書 4-4）
func (a *app) routeChild(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/classes", a.handleClasses)
	mux.HandleFunc("GET /api/children", a.handleListChildren)
	mux.HandleFunc("POST /api/children", a.handleSaveChild)
	mux.HandleFunc("GET /api/children/allergies", a.handleAllAllergies)
	mux.HandleFunc("GET /api/children/{childID}", a.handleGetChild)
	mux.HandleFunc("DELETE /api/children/{childID}", a.handleRemoveChild)
	mux.HandleFunc("GET /api/children/{childID}/allergies", a.handleAllergiesOf)
	mux.HandleFunc("GET /api/children/{childID}/medical-histories", a.handleMedicalHistoriesOf)
	mux.HandleFunc("GET /api/children/{childID}/class", a.handleClassOfChild)
	mux.HandleFunc("GET /api/children/{childID}/exists", a.handleChildIDExists)
	mux.HandleFunc("POST /api/children/csv/parse", a.handleParseChildCsv)
	mux.HandleFunc("POST /api/children/csv/import", a.handleImportChildCsv)
	mux.HandleFunc("GET /api/fiscal-year/preview", a.handlePreviewFiscalYearUpdate)
}

// 日誌システム（基本設計書 4-5）
func (a *app) routeDiary(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/diaries", a.handleListDiaries)
	mux.HandleFunc("POST /api/diaries", a.handleSaveDiary)
	mux.HandleFunc("GET /api/diaries/templates", a.handleDiaryTemplates)
	mux.HandleFunc("GET /api/diaries/phrases", a.handleDiaryPhrases)
	mux.HandleFunc("GET /api/diaries/pending", a.handlePendingDiaries)
	mux.HandleFunc("GET /api/diaries/{id}", a.handleGetDiary)
	mux.HandleFunc("GET /api/diaries/{id}/attachments", a.handleDiaryAttachments)
	mux.HandleFunc("POST /api/diaries/{id}/approve", a.handleApproveDiary)
	mux.HandleFunc("POST /api/diaries/{id}/return", a.handleReturnDiary)
	mux.HandleFunc("POST /api/diaries/{id}/lock", a.handleAcquireLock)
	mux.HandleFunc("DELETE /api/diaries/{id}/lock", a.handleReleaseLock)
	mux.HandleFunc("GET /api/diaries/{id}/lock", a.handleLockOf)
	mux.HandleFunc("GET /api/children/{childID}/diaries", a.handlePastDiaries)
	mux.HandleFunc("GET /api/children/{childID}/timeline", a.handleTimeline)
}

// チャットツール（基本設計書 4-6）
func (a *app) routeChat(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/chat/rooms", a.handleChatRooms)
	mux.HandleFunc("GET /api/chat/rooms/{id}/messages", a.handleChatMessages)
	mux.HandleFunc("POST /api/chat/rooms/{id}/messages", a.handleSendMessage)
	mux.HandleFunc("POST /api/chat/rooms/{id}/read", a.handleMarkRead)
	mux.HandleFunc("GET /api/chat/rooms/{id}/members", a.handleChatMembers)
	mux.HandleFunc("POST /api/chat/messages/{id}/retract", a.handleRetractMessage)
	mux.HandleFunc("POST /api/chat/messages/{id}/edit", a.handleEditMessage)
	mux.HandleFunc("POST /api/chat/messages/{id}/reactions", a.handleToggleReaction)
	mux.HandleFunc("POST /api/chat/rooms/{id}/thread-status", a.handleSetThreadStatus)
	mux.HandleFunc("GET /api/handouts", a.handleHandouts)
	mux.HandleFunc("POST /api/handouts", a.handlePostHandout)
	mux.HandleFunc("POST /api/handouts/{id}/withdraw", a.handleWithdrawHandout)
	mux.HandleFunc("GET /api/chat/groups", a.handleChatGroups)
	mux.HandleFunc("POST /api/chat/groups", a.handleCreateGroup)
	mux.HandleFunc("POST /api/chat/groups/{id}/members", a.handleUpdateGroupMembers)
	mux.HandleFunc("GET /api/chat/misdelivery", a.handleMisdeliveryRecords)
	mux.HandleFunc("POST /api/chat/misdelivery", a.handleAddMisdeliveryRecord)
	mux.HandleFunc("GET /api/chat/misdelivery/pending", a.handleRetractedWithoutRecord)
}

// 午睡チェック（基本設計書 4-7）
func (a *app) routeNap(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/nap/session", a.handleActiveNapSession)
	mux.HandleFunc("POST /api/nap/session", a.handleStartNapSession)
	mux.HandleFunc("POST /api/nap/session/{id}/end", a.handleEndNapSession)
	mux.HandleFunc("POST /api/nap/session/{id}/records", a.handleNapRecord)
	mux.HandleFunc("POST /api/nap/session/{id}/abnormals", a.handleRecordNapAbnormal)
	mux.HandleFunc("GET /api/nap/state", a.handleNapClassState)
	mux.HandleFunc("GET /api/nap/interval", a.handleNapInterval)
	mux.HandleFunc("GET /api/nap/abnormals", a.handleNapAbnormals)
	mux.HandleFunc("POST /api/nap/abnormals/{id}/incident", a.handleRaiseIncidentDiary)
	mux.HandleFunc("GET /api/nap/records", a.handleSearchNapRecords)
}

// 発達チェック・身体測定（基本設計書 4-8）
func (a *app) routeGrowth(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/development/items", a.handleDevelopmentItems)
	mux.HandleFunc("GET /api/development/list", a.handleDevelopmentList)
	mux.HandleFunc("POST /api/development/checks", a.handleSaveDevelopmentCheck)
	mux.HandleFunc("GET /api/development/schedules", a.handleDevelopmentSchedules)
	mux.HandleFunc("POST /api/development/schedules", a.handleSetSchedule)
	mux.HandleFunc("GET /api/development/share-settings", a.handleShareSettings)
	mux.HandleFunc("POST /api/development/share-settings", a.handleSetShareable)
	mux.HandleFunc("GET /api/children/{childID}/development/previous", a.handlePreviousCheck)
	mux.HandleFunc("GET /api/children/{childID}/development/draft", a.handleDraftCheck)

	mux.HandleFunc("GET /api/physical/class-status", a.handlePhysicalClassStatus)
	mux.HandleFunc("GET /api/physical/growth-band", a.handleGrowthBand)
	mux.HandleFunc("GET /api/physical/range-warning", a.handleRangeWarning)
	mux.HandleFunc("POST /api/physical/records", a.handleSavePhysical)
	mux.HandleFunc("DELETE /api/physical/records/{id}", a.handleRemovePhysical)
	mux.HandleFunc("POST /api/physical/export", a.handleExportPdf)
	mux.HandleFunc("GET /api/children/{childID}/physical", a.handlePhysicalRecords)
}

// アカウント管理・監査（基本設計書 4-3・6-4）
func (a *app) routeAdmin(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/accounts", a.handleAllAccounts)
	mux.HandleFunc("GET /api/admin/staff-accounts", a.handleStaffAccounts)
	mux.HandleFunc("POST /api/admin/staff-accounts", a.handleCreateStaffAccount)
	mux.HandleFunc("POST /api/admin/staff-accounts/{staffID}", a.handleUpdateStaffAccount)
	mux.HandleFunc("POST /api/admin/accounts/{id}/temp-password", a.handleReissueTempPassword)
	mux.HandleFunc("POST /api/admin/accounts/{id}/unlock", a.handleUnlockAccount)
	mux.HandleFunc("POST /api/admin/accounts/{id}/status", a.handleSetAccountStatus)
	mux.HandleFunc("GET /api/admin/guardian-accounts", a.handleGuardianAccounts)
	mux.HandleFunc("POST /api/admin/guardian-links/end", a.handleEndGuardianLink)
	mux.HandleFunc("POST /api/admin/guardian-links/restore", a.handleRestoreGuardianLink)
	mux.HandleFunc("GET /api/admin/invitations", a.handleInvitationCodes)
	mux.HandleFunc("POST /api/admin/invitations", a.handleIssueOneInvitationCode)
	mux.HandleFunc("POST /api/admin/invitations/bulk", a.handleIssueInvitationCodes)
	mux.HandleFunc("POST /api/admin/invitations/{id}/revoke", a.handleRevokeInvitationCode)
	mux.HandleFunc("GET /api/admin/logs", a.handleOperationLogs)
	mux.HandleFunc("POST /api/exports", a.handleRecordExport)
}
