package main

import (
	"database/sql"
	"net/http"
)

/*
 * ダッシュボード・保護者ホーム
 * 典拠：図/画面詳細図.md「職員ダッシュボード」(2-4)、基本設計書.md「画面の一覧」(3-2)
 *
 * 未対応の件数を最上部に置く。出勤直後に「何が残っているか」を1画面で把握させるため。
 * 承認待ちの区画は管理者にのみ表示する。
 */

func (a *app) handleStaffSummary(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}

	// 自分が書いて差し戻された日誌。開いた先の日誌一覧（状態＝差し戻し・自分が書いたもの）と同じ範囲を数えるため、
	// 参照範囲の外へ出たもの（担当を外れたクラスの日誌）は数えない（GitHub Issue #174）
	var returned int
	cond, condArgs := a.visibleDiaryCondition(u)
	a.db.QueryRow(`SELECT COUNT(*) FROM t_diary
		WHERE is_deleted = 0 AND status = '4' AND created_staff_id = ? AND `+cond,
		append([]any{u.staff()}, condArgs...)...).Scan(&returned)

	// 未読のチャット。外れたチャンネルの、外れたあとの投稿は数えない（読めないため。api_chat.go の afterLeftClause）
	var unreadChat int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message m
		WHERE m.is_deleted = 0 AND m.sender_account_id <> ?
		  AND m.chat_room_id IN (SELECT chat_room_id FROM t_chat_member WHERE account_id = ?)
		  AND NOT EXISTS (SELECT 1 FROM t_chat_read x
		                   WHERE x.chat_message_id = m.chat_message_id AND x.account_id = ?)`+afterLeftClause,
		u.AccountID, u.AccountID, u.AccountID, u.AccountID).Scan(&unreadChat)

	unhandledChat, unhandledChatRoom, err := a.unhandledPersonalChats(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "集計に失敗しました")
		return
	}

	// 承認待ちは管理者にのみ数える
	pending := 0
	if u.isAdmin() {
		a.db.QueryRow(`SELECT COUNT(*) FROM t_diary WHERE is_deleted = 0 AND status = '2'`).Scan(&pending)
	}

	children, err := a.visibleChildren(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "集計に失敗しました")
		return
	}
	visible := map[string]bool{}
	for _, c := range children {
		visible[c.ChildID] = true
	}
	// 家庭からの「未確認」「更新」と、おひるね中の園児（詳細設計書「ダッシュボード」(4-8 (2))）。今日のページだけを数える。
	// 一般は自クラス、管理者は全クラス（visibleChildren の範囲）
	homeUnconfirmed, homeRevised, napSleeping := 0, 0, 0
	// 園からのひとことを送っていない園児：在籍中で、今日の取り消していない園からが無い園児。
	// 今日の午睡で「きょうは対象外（欠席）」にした子は数えない（詳細設計書 (4-8 (2))、基本設計書「届いていない家庭の一覧」(4-5)）
	facilityUnsent := 0
	for _, c := range children {
		if c.EnrollmentStatus == "1" {
			var sent, absent int
			a.db.QueryRow(`SELECT COUNT(*) FROM t_contact_facility WHERE child_id = ? AND contact_date = ? AND is_deleted = 0`,
				c.ChildID, today()).Scan(&sent)
			a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_exclusion x JOIN t_nap_session n ON n.nap_session_id = x.nap_session_id
				WHERE x.child_id = ? AND x.reason = '1' AND x.is_deleted = 0 AND n.session_date = ?`, c.ChildID, today()).Scan(&absent)
			if sent == 0 && absent == 0 {
				facilityUnsent++
			}
		}
		h, err := a.loadContactHome(c.ChildID, today())
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "集計に失敗しました")
			return
		}
		switch homeState(h) {
		case "unconfirmed":
			homeUnconfirmed++
		case "revised":
			homeRevised++
		}
		var sleeping int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_sleep s JOIN t_nap_session n ON n.nap_session_id = s.nap_session_id
			WHERE s.child_id = ? AND s.woke_at IS NULL AND s.is_deleted = 0 AND n.ended_at IS NULL AND n.session_date = ?`,
			c.ChildID, today()).Scan(&sleeping)
		if sleeping > 0 {
			napSleeping++
		}
	}

	// 発達チェックの未実施。園児ごとに最新の予定日で判定し、発達チェック一覧の「未実施」と同じ数にする
	// （判定は api_dev.go の devOverdue。過去の予定をすべて数えると一覧と食い違う。GitHub Issue #164）
	overdueCount := 0
	rows, err := a.db.Query(`SELECT s.child_id, MAX(s.scheduled_on),
		(SELECT MAX(checked_on) FROM t_development_check c
		  WHERE c.child_id = s.child_id AND c.status = '2')
		FROM t_development_schedule s GROUP BY s.child_id`)
	if err == nil {
		for rows.Next() {
			var (
				childID   string
				scheduled sql.NullString
				last      sql.NullString
			)
			if rows.Scan(&childID, &scheduled, &last) != nil {
				continue
			}
			if !visible[childID] {
				continue
			}
			if devOverdue(nullStr(scheduled), nullStr(last)) {
				overdueCount++
			}
		}
		rows.Close()
	}

	// 異常時の記録のうち、ヒヤリハットを起票していないもの、起票したヒヤリハットが下書きのままのもの
	// （申請していない下書きは「起票済み」として埋もれるため。GitHub Issue #142 の 5。判定は api_nap.go の napAbnormalDiaryJoin）
	abnormalWithoutDiary := 0
	ar, err := a.db.Query(`SELECT a.child_id FROM t_nap_abnormal a `+napAbnormalDiaryJoin+`
		WHERE a.diary_id IS NULL OR d.status = ?`, diaryStatusDraft)
	if err == nil {
		for ar.Next() {
			var childID string
			if ar.Scan(&childID) == nil && visible[childID] {
				abnormalWithoutDiary++
			}
		}
		ar.Close()
	}

	// 実施中の午睡チェック
	var activeNap *NapSession
	classes, _ := a.selectableClasses(u)
	for _, c := range classes {
		if s, err := a.napSession(c.ClassID, today()); err == nil {
			activeNap = s
			break
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"returned":             returned,
		"unreadChat":           unreadChat,
		"unhandledChat":        unhandledChat,
		"unhandledChatRoom":    unhandledChatRoom,
		"devOverdue":           overdueCount,
		"pending":              pending,
		"abnormalWithoutDiary": abnormalWithoutDiary,
		"activeNap":            activeNap,
		"homeUnconfirmed":      homeUnconfirmed,
		"homeRevised":          homeRevised,
		"napSleeping":          napSleeping,
		"facilityUnsent":       facilityUnsent,
	})
}

// chatRoomRef は、ダッシュボードから開くチャンネル
type chatRoomRef struct {
	ChatRoomID int64  `json:"chat_room_id"`
	RoomName   string `json:"room_name"`
}

/*
unhandledPersonalChats は、未対応のままの保護者との個人チャットを数え、先頭のものを返す。

未対応／対応済みは、保護者からの連絡（欠席・遅刻・お迎え時間の変更など）の対応漏れを防ぐための状態
（要件定義書「チャットツール」(4-3)）。開いたままのダッシュボードでも気づけるよう、「未対応」の欄に出す。

数える範囲は、チャット画面の見出しの「未対応 n 件」と同じにする（いま参加している個人チャット）。
外れた個人チャット（担任を付け替える前のクラスの家庭など）は数えない。返信も状態の切り替えもできないため
（GitHub Issue #161・#162）。先頭は、チャット画面の一覧と同じ並び（チャンネルの番号順）で決める。
旧いデモデータは状態を文言（未対応）で持っていたため、それも数える（handleChatRooms と同じ扱い）。
画面側のモック（web/src/api/mock.ts の staffSummary）も同じ規則にしてある。片方だけ直すと食い違う。

数え損ねたときは 0 件として返さず、エラーにする。「未対応 0 件」は「対応漏れなし」と読まれるため。
*/
func (a *app) unhandledPersonalChats(u *SessionUser) (int, *chatRoomRef, error) {
	rows, err := a.db.Query(`SELECT r.chat_room_id, r.room_name FROM m_chat_room r
		JOIN t_chat_member m ON m.chat_room_id = r.chat_room_id AND m.account_id = ? AND m.left_at IS NULL
		WHERE r.room_type = '4' AND r.thread_status IN ('1', '未対応')
		ORDER BY r.chat_room_id`, u.AccountID)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()
	count := 0
	var first *chatRoomRef
	for rows.Next() {
		var ref chatRoomRef
		if err := rows.Scan(&ref.ChatRoomID, &ref.RoomName); err != nil {
			return 0, nil, err
		}
		if first == nil {
			first = &ref
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	return count, first, nil
}

// handleGuardianHome は自児の情報とチャットへの導線を返す。
// 記録の閲覧はチャット画面の中で行い、専用の閲覧画面を持たない（基本設計書「画面体系図」(3-3)）。
func (a *app) handleGuardianHome(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	// 保護者ホームは保護者のためのもの。職員が呼ぶと、参照範囲の園児すべてが「自児」として並び、
	// 保護者の画面のまま職員の範囲が見えてしまう（GitHub Issue #159 の 3）
	if !u.isGuardian() {
		writeForbidden(w, "保護者ホームは保護者のみが利用できます")
		return
	}
	// 「きょう」は連絡帳を読める自児ごとに1件（猶予中を含む。contact_scope.go の guardianContactChildren）
	children, err := a.guardianContactChildren(u)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "取得に失敗しました")
		return
	}

	var unread int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_message m
		WHERE m.is_deleted = 0 AND m.sender_account_id <> ?
		  AND m.chat_room_id IN (SELECT chat_room_id FROM t_chat_member
		                          WHERE account_id = ? AND left_at IS NULL)
		  AND NOT EXISTS (SELECT 1 FROM t_chat_read x
		                   WHERE x.chat_message_id = m.chat_message_id AND x.account_id = ?)`+
		// 参加するより前の個人チャットのやりとりは、未読にも数えない（api_chat.go）
		beforeJoinedClause,
		u.AccountID, u.AccountID, u.AccountID, u.AccountID).Scan(&unread)

	type homeRow struct {
		Child     Child  `json:"child"`
		AgeMonths int    `json:"ageMonths"`
		ClassName string `json:"className"`
		Unread    int    `json:"unread"`
		// 園児1人の「きょう」（詳細設計書「ダッシュボード」(4-8 (1)) の GuardianToday）
		Today *guardianTodayOut `json:"today"`
	}
	out := []homeRow{}
	for _, c := range children {
		out = append(out, homeRow{Child: c, Unread: unread})
	}

	for i := range out {
		childID := out[i].Child.ChildID
		out[i].AgeMonths = ageInMonths(out[i].Child.BirthDate, today())

		var classID sql.NullInt64
		a.db.QueryRow(`SELECT cc.class_id FROM t_class_child cc
			JOIN m_class c ON c.class_id = cc.class_id AND c.fiscal_year = ?
			WHERE cc.child_id = ?`, fiscalYear, childID).Scan(&classID)
		out[i].ClassName = "―"
		if classID.Valid {
			out[i].ClassName = a.className(classID.Int64)
		}

		t, err := a.guardianToday(u, childID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "取得に失敗しました")
			return
		}
		out[i].Today = t
	}
	writeJSON(w, http.StatusOK, out)
}
