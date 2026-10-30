package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// 紐づけを戻せるのは、解除した日から restoreLinkDays 日まで。過ぎたら 409 で断り、新しい招待コードへ案内する
// （照合 c2b-3 の推し。【仮置き】web/仮置き値.md）。一覧には戻せる最後の日を載せる。モックは web/tests/admin.test.ts
func TestRestoreGuardianLinkOnlyWithinDays(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	const body = `{"guardian_id":"G004","child_id":"C004"}`
	call(t, h, admin, "POST", "/api/admin/guardian-links/end", body)
	endedDaysAgo := func(days int) {
		t.Helper()
		if _, err := a.db.Exec(`UPDATE t_guardian_child SET ended_at = ? WHERE guardian_id = 'G004' AND child_id = 'C004'`,
			addDays(today(), -days)+"T10:00:00"); err != nil {
			t.Fatal(err)
		}
	}
	linkStatus := func() string {
		var s string
		a.db.QueryRow(`SELECT link_status FROM t_guardian_child WHERE guardian_id = 'G004' AND child_id = 'C004'`).Scan(&s)
		return s
	}

	// 解除から restoreLinkDays + 1 日：戻せない。一覧の戻せる最後の日は昨日
	endedDaysAgo(restoreLinkDays + 1)
	var rows []struct {
		Guardian struct {
			GuardianID string `json:"guardian_id"`
		} `json:"guardian"`
		Links []struct {
			ChildID      string  `json:"child_id"`
			RestoreUntil *string `json:"restore_until"`
		} `json:"links"`
	}
	if err := json.Unmarshal(call(t, h, admin, "GET", "/api/admin/guardian-accounts", "").Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range rows {
		for _, l := range r.Links {
			if r.Guardian.GuardianID == "G004" && l.ChildID == "C004" {
				found = true
				if l.RestoreUntil == nil || *l.RestoreUntil != addDays(today(), -1) {
					t.Errorf("restore_until = %v、昨日 %s のはず", l.RestoreUntil, addDays(today(), -1))
				}
			}
		}
	}
	if !found {
		t.Fatal("一覧に G004・C004 の紐づけが無い")
	}
	res := expectStatus(t, request(t, h, admin, "POST", "/api/admin/guardian-links/restore", body), http.StatusConflict)
	if !strings.Contains(res, msgRestoreLinkExpired()) || !strings.Contains(res, "新しい招待コードで紐づけてください") {
		t.Errorf("断りの文 = %s", res)
	}
	if s := linkStatus(); s != "2" {
		t.Fatalf("期間を過ぎたのに戻った: link_status = %s", s)
	}

	// 解除からちょうど restoreLinkDays 日：まだ戻せる
	endedDaysAgo(restoreLinkDays)
	call(t, h, admin, "POST", "/api/admin/guardian-links/restore", body)
	if s := linkStatus(); s != "1" {
		t.Fatalf("期間の内なのに戻らない: link_status = %s", s)
	}
}

/*
保護者アカウント管理の細部（GitHub Issue #272 の 1・2、#312 の 3）
典拠：基本設計書「アカウントの停止と再開」(4-3)・「保護者と園児の紐づけを戻す」(4-3)・「操作ログの記録」(4-2)・
「操作ログ（t_operation_log）」(5-9)、図/画面詳細図「保護者アカウント管理画面」(7-8) 項目5

モック（web/src/api/mock.ts）にも同じ規則がある。web/tests/admin.test.ts と同じ観点で確かめる。
*/

// 保護者アカウントを管理者が手で停止・再開する操作は設けない。職員の停止・再開は同じ経路で使える
func TestGuardianAccountCannotBeSuspendedByHand(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	// 村田 真一（アカウント9）は有効、鈴木 浩之（アカウント8・G003）は紐づけが終了して停止している
	expectStatus(t, request(t, h, admin, "POST", "/api/admin/accounts/9/status", `{"status":"2"}`), http.StatusBadRequest)
	expectStatus(t, request(t, h, admin, "POST", "/api/admin/accounts/8/status", `{"status":"1"}`), http.StatusBadRequest)
	var s9, s8 string
	a.db.QueryRow(`SELECT status FROM m_account WHERE account_id = 9`).Scan(&s9)
	a.db.QueryRow(`SELECT status FROM m_account WHERE account_id = 8`).Scan(&s8)
	if s9 != "1" || s8 != "2" {
		t.Fatalf("状態が変わった: 9=%s 8=%s", s9, s8)
	}

	// 職員の停止・再開は、これまでどおりできる（職員アカウント管理画面が使う）
	call(t, h, admin, "POST", "/api/admin/accounts/3/status", `{"status":"2"}`)
	call(t, h, admin, "POST", "/api/admin/accounts/3/status", `{"status":"1"}`)
}

// 参加の行が無い保護者（デモデータの鈴木 浩之）も、紐づけを戻すと、個人チャット・クラスグループ・園全体に入る（#272 の 2）
func TestRestoreGuardianLinkJoinsRoomsEvenWithoutMemberRows(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	var rows int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_chat_member WHERE account_id = 8 AND chat_room_id <> 1`).Scan(&rows)
	if rows != 0 {
		t.Skipf("デモデータの前提が変わった（鈴木 浩之の園全体のほかの参加の行: %d）", rows)
	}

	call(t, h, admin, "POST", "/api/admin/guardian-links/restore", `{"guardian_id":"G003","child_id":"C003"}`)

	var personal, class int64
	a.db.QueryRow(`SELECT chat_room_id FROM m_chat_room WHERE room_type = '4' AND child_id = 'C003'`).Scan(&personal)
	a.db.QueryRow(`SELECT r.chat_room_id FROM m_chat_room r JOIN t_class_child cc ON cc.class_id = r.class_id
		WHERE r.room_type = '2' AND cc.child_id = 'C003'`).Scan(&class)
	suzuki := loginAs(a, 8, "guardian")
	rooms := roomIDsOf(t, h, suzuki)
	for name, id := range map[string]int64{"園全体": 1, "個人チャット": personal, "クラスグループ": class} {
		if id == 0 || !rooms[id] {
			t.Errorf("%s（%d）に戻っていない: %v", name, id, rooms)
		}
	}
	// 参加の時刻は、紐づけを結んだ時刻（はじめに参加した時刻の代わり）。今にしない
	// （デモデータの日付は起動日へずれるので、紐づけの linked_at と比べる）
	var joinedAt, linkedAt string
	a.db.QueryRow(`SELECT joined_at FROM t_chat_member WHERE chat_room_id = ? AND account_id = 8`, personal).Scan(&joinedAt)
	a.db.QueryRow(`SELECT linked_at FROM t_guardian_child WHERE guardian_id = 'G003' AND child_id = 'C003'`).Scan(&linkedAt)
	if joinedAt == "" || joinedAt != linkedAt {
		t.Errorf("個人チャットの参加の時刻 = %q、紐づけを結んだ時刻 %q のはず", joinedAt, linkedAt)
	}
	expectStatus(t, request(t, h, suzuki, "POST", "/api/chat/rooms/"+strconv.FormatInt(personal, 10)+"/messages", `{"body":"ありがとうございます。"}`), http.StatusOK)
}

// 抜けていた参加は、はじめに参加した時刻のまま戻る（誤った解除の前に読めていたものを、戻したあとも読めるように）
func TestRestoreGuardianLinkKeepsFirstJoinedAt(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	var before string
	a.db.QueryRow(`SELECT joined_at FROM t_chat_member WHERE chat_room_id = 8 AND account_id = 9`).Scan(&before)

	call(t, h, admin, "POST", "/api/admin/guardian-links/end", `{"guardian_id":"G004","child_id":"C004"}`)
	call(t, h, admin, "POST", "/api/admin/guardian-links/restore", `{"guardian_id":"G004","child_id":"C004"}`)

	var after string
	var left *string
	a.db.QueryRow(`SELECT joined_at, left_at FROM t_chat_member WHERE chat_room_id = 8 AND account_id = 9`).Scan(&after, &left)
	if after != before || left != nil {
		t.Fatalf("joined_at %q→%q、left_at %v", before, after, left)
	}
}

// 有効な紐づけが無くなったことによる停止は、操作者を「システム」（operator_type = '2'）として、解除の行とは別に残す（#312 の 3）
func TestEndLastGuardianLinkLogsSystemStop(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	call(t, h, admin, "POST", "/api/admin/guardian-links/end", `{"guardian_id":"G004","child_id":"C004"}`)

	var endOperator, stopOperator string
	var stopAccount *int64
	var stopAfter string
	if err := a.db.QueryRow(`SELECT operator_type FROM t_operation_log
		WHERE target_table = 't_guardian_child' AND target_id = 9 AND target_child_id = 'C004'`).Scan(&endOperator); err != nil {
		t.Fatal("解除の行が無い:", err)
	}
	if err := a.db.QueryRow(`SELECT operator_type, account_id, after_value FROM t_operation_log
		WHERE target_table = 'm_account' AND target_id = 9`).Scan(&stopOperator, &stopAccount, &stopAfter); err != nil {
		t.Fatal("停止の行が無い:", err)
	}
	if endOperator != "1" {
		t.Errorf("解除の行の操作者の種類 = %s、管理者（1）のはず", endOperator)
	}
	if stopOperator != "2" || stopAccount != nil {
		t.Errorf("停止の行の操作者の種類 = %s、account_id = %v、システム（2・空）のはず", stopOperator, stopAccount)
	}

	// 参照の画面は、操作者を「システム」と出す。account_id が空の行を読み飛ばさない
	var out struct {
		Rows []struct {
			AccountID   *int64 `json:"account_id"`
			AccountName string `json:"account_name"`
			TargetTable string `json:"target_table"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(call(t, h, admin, "GET", "/api/admin/logs", "").Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	var systemRows, adminEnd int
	for _, r := range out.Rows {
		if r.AccountName == "システム" && r.AccountID == nil && r.TargetTable == "m_account" {
			systemRows++
		}
		if r.TargetTable == "t_guardian_child" && r.AccountName != "システム" {
			adminEnd++
		}
	}
	if systemRows != 1 || adminEnd == 0 {
		t.Errorf("操作ログの一覧: システムの停止の行 %d、管理者の解除の行 %d", systemRows, adminEnd)
	}
}

// ほかに有効な紐づけが残る解除では、アカウントは止まらないので、システムの行は出ない
func TestEndGuardianLinkWithRemainingLinkLogsNoSystemRow(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	if _, err := a.db.Exec(`INSERT INTO t_guardian_child (guardian_id, child_id, relationship, link_status, linked_at)
		VALUES ('G004', 'C006', '父', '1', '2026-04-01T09:00:00')`); err != nil {
		t.Fatal(err)
	}
	call(t, h, admin, "POST", "/api/admin/guardian-links/end", `{"guardian_id":"G004","child_id":"C004"}`)
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE operator_type = '2'`).Scan(&n)
	if n != 0 {
		t.Fatalf("システムの行が %d 件ある", n)
	}
}
