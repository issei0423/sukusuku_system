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
	a.routeContact(mux)
	a.routeGrowth(mux)
	a.routeAdmin(mux)
	a.routeGuardian(mux)
}

// 保護者のメニュー（詳細設計書「保護者のメニュー」(4-15)。api_guardian.go）。本版は AI の下書きの利用とお子さまの追加。
// お子さまの追加の招待コードの確認は、新規登録と同じ POST /api/invitation/verify を広げて使う（routeAuth）
func (a *app) routeGuardian(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/guardian/children", a.handleAddChild)
	mux.HandleFunc("POST /api/guardian/children/{childID}/ai-opt-out", a.handleAiOptOut)
	// 共有された日誌（保育士が共有を選んで申請し、管理者が承認した個人日誌。api_diary_share.go）
	mux.HandleFunc("GET /api/guardian/diaries", a.handleGuardianDiaries)
}

// 連絡帳の読み書きと、ねた・おきた（詳細設計書「経路の一覧」(4-2)）
func (a *app) routeContact(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/contact/children/{childID}", a.handleContactPage)
	mux.HandleFunc("POST /api/contact/children/{childID}/read", a.handleContactRead)
	mux.HandleFunc("PUT /api/contact/children/{childID}/home", a.handleSaveHome)
	mux.HandleFunc("GET /api/contact/classes", a.handleContactClasses)
	mux.HandleFunc("GET /api/contact/classes/{classID}", a.handleContactClass)
	mux.HandleFunc("POST /api/contact/home/{id}/confirm", a.handleConfirmHome)
	mux.HandleFunc("POST /api/nap/session/{id}/sleeps", a.handleSleep)
	mux.HandleFunc("POST /api/nap/sleeps/{id}/wake", a.handleWake)
	mux.HandleFunc("POST /api/nap/session/{id}/exclusions", a.handleExclude)
	mux.HandleFunc("POST /api/nap/exclusions/{id}/cancel", a.handleCancelExclusion)
	// きょうのようすの記録と、訂正・取り消し（詳細設計書「きょうのようす」(4-4)・「訂正・取り消し」(4-7)・(4-6 (4))）
	mux.HandleFunc("POST /api/contact/events", a.handleRecordEvents)
	mux.HandleFunc("POST /api/contact/events/{id}/correct", a.handleCorrectEvent)
	mux.HandleFunc("POST /api/contact/events/{id}/cancel", a.handleCancelEvent)
	mux.HandleFunc("GET /api/contact/events/{id}/readers", a.handleEventReaders)
	mux.HandleFunc("POST /api/nap/sleeps/{id}/correct", a.handleCorrectSleep)
	mux.HandleFunc("POST /api/nap/sleeps/{id}/cancel", a.handleCancelSleep)
	mux.HandleFunc("GET /api/nap/sleeps/{id}/readers", a.handleSleepReaders)
	// 写真を送る・写真の実体（詳細設計書「きょうのようす」(4-4 (2))・(4-4 (3))）
	mux.HandleFunc("POST /api/contact/photos", a.handleSendPhoto)
	mux.HandleFunc("GET /api/contact/photos/{id}", a.handlePhotoFile)
	// 園からのひとこと・他児の名前の照合・定型文（詳細設計書「園からのひとことと他児の名前」(4-5)）
	mux.HandleFunc("PUT /api/contact/children/{childID}/facility", a.handleSendFacility)
	mux.HandleFunc("POST /api/contact/facility/{id}/correct", a.handleCorrectFacility)
	mux.HandleFunc("POST /api/contact/facility/{id}/cancel", a.handleCancelFacility)
	mux.HandleFunc("GET /api/contact/facility/{id}/readers", a.handleFacilityReaders)
	mux.HandleFunc("POST /api/contact/name-check", a.handleNameCheck)
	mux.HandleFunc("GET /api/phrases", a.handlePhrases)
	// 文章の下書き（AI）（詳細設計書「経路」(8-2)）
	mux.HandleFunc("GET /api/ai/status", a.handleAiStatus)
	mux.HandleFunc("POST /api/ai/drafts", a.handleAiDrafts)
}

// 共通基盤：ログインとアカウント（基本設計書 4-3）
func (a *app) routeAuth(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/login", a.handleLogin)
	mux.HandleFunc("POST /api/logout", a.handleLogout)
	mux.HandleFunc("GET /api/me", a.handleMe)
	// 自動ログアウトの期限と、予告の「続ける」（api_session.go。GitHub Issue #210）
	mux.HandleFunc("GET /api/session", a.handleSessionStatus)
	mux.HandleFunc("POST /api/session/extend", a.handleExtendSession)
	mux.HandleFunc("GET /api/reference", a.handleReference)
	mux.HandleFunc("POST /api/password", a.handleChangePassword)
	mux.HandleFunc("GET /api/terms", a.handleCurrentTerms)
	mux.HandleFunc("POST /api/terms/agree", a.handleAgreeTerms)
	mux.HandleFunc("POST /api/invitation/verify", a.handleVerifyInvitationCode)
	mux.HandleFunc("POST /api/signup", a.handleSignUpGuardian)
	mux.HandleFunc("GET /api/dashboard/staff", a.handleStaffSummary)
	mux.HandleFunc("GET /api/dashboard/guardian", a.handleGuardianHome)
	// 開いている画面への知らせ（Server-Sent Events。events.go）
	mux.HandleFunc("GET /api/events", a.handleEvents)
}

// 共通基盤：園児マスターの管理（基本設計書 4-4）
func (a *app) routeChild(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/classes", a.handleClasses)
	mux.HandleFunc("GET /api/children", a.handleListChildren)
	mux.HandleFunc("POST /api/children", a.handleSaveChild)
	mux.HandleFunc("GET /api/children/allergies", a.handleAllAllergies)
	mux.HandleFunc("GET /api/children/same-name-birth", a.handleSameNameBirthChildren)
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
	mux.HandleFunc("POST /api/diaries/{id}/withdraw", a.handleWithdrawDiary)
	mux.HandleFunc("POST /api/diaries/{id}/revoke-approval", a.handleRevokeDiaryApproval)
	mux.HandleFunc("POST /api/diaries/{id}/lock", a.handleAcquireLock)
	mux.HandleFunc("PUT /api/diaries/{id}/lock", a.handleTouchLock)
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
	mux.HandleFunc("GET /api/chat/group-candidates", a.handleGroupCandidates)
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
	// 午睡チェック表（帳票）。管理者だけ。サーバで作り、出力を操作ログへ記録する（api_nap_report.go）
	mux.HandleFunc("GET /api/nap/report", a.handleNapReport)
	// 午睡チェックの記録の修正。行を書き換え、修正前後の値と理由を操作ログに残す（api_nap_correct.go）
	mux.HandleFunc("POST /api/nap/records/{id}/correct", a.handleCorrectNapRecord)
	// 異常時の記録の修正。同じ規則で、発見時刻・状況・とった対応を直す（api_nap_abnormal_correct.go）
	mux.HandleFunc("POST /api/nap/abnormals/{id}/correct", a.handleCorrectNapAbnormal)
}

// 発達チェック・身体測定（基本設計書 4-8）
func (a *app) routeGrowth(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/development/items", a.handleDevelopmentItems)
	mux.HandleFunc("GET /api/development/list", a.handleDevelopmentList)
	mux.HandleFunc("POST /api/development/checks", a.handleSaveDevelopmentCheck)
	mux.HandleFunc("GET /api/development/schedules", a.handleDevelopmentSchedules)
	mux.HandleFunc("POST /api/development/schedules", a.handleSetSchedule)
	mux.HandleFunc("POST /api/development/schedules/apply", a.handleApplyRecommendedSchedules)
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
	mux.HandleFunc("GET /api/children/{childID}/growth", a.handleGrowthRecord)
	mux.HandleFunc("POST /api/contact/events/{id}/keep-in-growth", a.handleKeepInGrowth)
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
	// 設定画面（詳細設計書「設定」(4-10)。本版は AI の区画だけ）
	mux.HandleFunc("GET /api/settings", a.handleSettings)
	mux.HandleFunc("POST /api/settings", a.handleSaveSettings)
}
