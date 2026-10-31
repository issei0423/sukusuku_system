package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
)

/*
解除した日から restoreLinkDays 日までは「紐づけを戻す」：参加の時刻ははじめのままで、解除の前のやりとりも読める。
過ぎたら（解除した日時の無い古い行も）断らずに「結び直す」：新しい招待コードで結んだときと同じく今の時刻で参加し直し、
止まっていたアカウントは再開する。解除の前のやりとりは読めない（照合 c2b-3・c5-04 の推し。【仮置き】web/仮置き値.md）。
一覧には、解除のあいだも読める形で戻せる最後の日を載せる。モックは web/tests/admin.test.ts
*/
func TestRestoreGuardianLinkWithinDaysOrRelink(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	// 村田 真一（G004・アカウント9）の紐づけは村田 美咲（C004）の1本だけで、解除するとアカウントが止まる。個人チャットは 8
	const body = `{"guardian_id":"G004","child_id":"C004"}`
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
	accountStatus := func() string {
		var s string
		a.db.QueryRow(`SELECT status FROM m_account WHERE account_id = 9`).Scan(&s)
		return s
	}
	type memberRow struct {
		joined string
		first  *string
		left   *string
	}
	member := func() memberRow {
		var m memberRow
		a.db.QueryRow(`SELECT joined_at, first_joined_at, left_at FROM t_chat_member WHERE chat_room_id = 8 AND account_id = 9`).
			Scan(&m.joined, &m.first, &m.left)
		return m
	}
	lastLogAfter := func() string {
		var v string
		a.db.QueryRow(`SELECT after_value FROM t_operation_log
			WHERE target_table = 't_guardian_child' AND target_child_id = 'C004' AND before_value = '終了'
			ORDER BY operation_log_id DESC LIMIT 1`).Scan(&v)
		return v
	}

	// 解除の前（はじめの参加のあと）に園が送ったやりとり
	before := member()
	old := addDays(today(), -20) + "T10:00:00"
	if before.joined >= old {
		t.Skipf("デモデータの前提が変わった（はじめの参加 %s が %s より後）", before.joined, old)
	}
	res, err := a.db.Exec(`INSERT INTO t_chat_message (chat_room_id, sender_account_id, body, source_type, sent_at)
		VALUES (8, 3, '解除の前のやりとり', '1', ?)`, old)
	if err != nil {
		t.Fatal(err)
	}
	oldID, _ := res.LastInsertId()
	readsOld := func() bool {
		t.Helper()
		_, ok := chatMessagesOf(t, h, loginAs(a, 9, "guardian"), "8")[oldID]
		return ok
	}

	// 解除からちょうど restoreLinkDays 日：「紐づけを戻す」。参加の時刻は変わらず、解除の前のやりとりも読める
	call(t, h, admin, "POST", "/api/admin/guardian-links/end", body)
	if accountStatus() != "2" {
		t.Fatalf("最後の紐づけを解除したのに、アカウントが止まっていない: %s", accountStatus())
	}
	endedDaysAgo(restoreLinkDays)
	call(t, h, admin, "POST", "/api/admin/guardian-links/restore", body)
	if s := linkStatus(); s != "1" {
		t.Fatalf("期間の内なのに戻らない: link_status = %s", s)
	}
	if s := accountStatus(); s != "1" {
		t.Errorf("戻したのにアカウントが再開しない: status = %s", s)
	}
	if m := member(); m.joined != before.joined || m.left != nil {
		t.Errorf("戻したときの参加: joined_at %q→%q、left_at %v（はじめの参加のまま戻るはず）", before.joined, m.joined, m.left)
	}
	if !readsOld() {
		t.Error("戻したのに、解除の前のやりとりが読めない")
	}
	if got := lastLogAfter(); got != "有効（アカウントを再開）" {
		t.Errorf("戻したときの操作ログの変更後 = %q", got)
	}

	// 解除から restoreLinkDays + 1 日：断らずに「結び直す」。一覧の戻せる最後の日は昨日
	call(t, h, admin, "POST", "/api/admin/guardian-links/end", body)
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
	start := now()
	expectStatus(t, request(t, h, admin, "POST", "/api/admin/guardian-links/restore", body), http.StatusOK)
	if s := linkStatus(); s != "1" {
		t.Fatalf("期間を過ぎた紐づけを結び直せない: link_status = %s", s)
	}
	if s := accountStatus(); s != "1" {
		t.Errorf("結び直したのにアカウントが再開しない: status = %s", s)
	}
	m := member()
	if m.joined < start || m.left != nil {
		t.Errorf("結び直したときの参加: joined_at %q（今 %s 以後のはず）、left_at %v", m.joined, start, m.left)
	}
	if m.first == nil || *m.first != before.joined {
		t.Errorf("first_joined_at = %v、はじめの参加 %q を残すはず", m.first, before.joined)
	}
	var linkedAt string
	a.db.QueryRow(`SELECT linked_at FROM t_guardian_child WHERE guardian_id = 'G004' AND child_id = 'C004'`).Scan(&linkedAt)
	if linkedAt < start {
		t.Errorf("結び直したのに linked_at = %q（今 %s 以後のはず）", linkedAt, start)
	}
	if readsOld() {
		t.Error("結び直したのに、解除の前のやりとりが読める（新しい招待コードと同じく読めないはず）")
	}
	if got := lastLogAfter(); got != "有効（結び直し、アカウントを再開）" {
		t.Errorf("結び直したときの操作ログの変更後 = %q", got)
	}

	// 解除した日時の無い古い終了の行も、断らずに結び直す
	call(t, h, admin, "POST", "/api/admin/guardian-links/end", body)
	if _, err := a.db.Exec(`UPDATE t_guardian_child SET ended_at = NULL WHERE guardian_id = 'G004' AND child_id = 'C004'`); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, request(t, h, admin, "POST", "/api/admin/guardian-links/restore", body), http.StatusOK)
	if s := linkStatus(); s != "1" {
		t.Fatalf("解除した日時の無い行を結び直せない: link_status = %s", s)
	}
	if got := lastLogAfter(); got != "有効（結び直し、アカウントを再開）" {
		t.Errorf("解除した日時の無い行の操作ログの変更後 = %q", got)
	}
}

/*
解除から restoreLinkDays 日の内でも、要求に relink: true があれば「結び直す」。親権の変更・家庭の事情で解除したあと、
アカウントが止まった保護者（ログインできず新しい招待コードを使えない）と、解除していたあいだを読ませずに結ぶため
（頭役の決め。【仮置き】web/仮置き値.md）。今の時刻で参加し直し、解除の前のやりとりは読めず、アカウントは再開する。
モックは web/tests/admin.test.ts
*/
func TestRestoreGuardianLinkRelinkWithinDays(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	// 村田 真一（G004・アカウント9）の紐づけは村田 美咲（C004）の1本だけ。個人チャットは 8
	var before string
	a.db.QueryRow(`SELECT joined_at FROM t_chat_member WHERE chat_room_id = 8 AND account_id = 9`).Scan(&before)
	old := addDays(today(), -20) + "T10:00:00"
	if before >= old {
		t.Skipf("デモデータの前提が変わった（はじめの参加 %s が %s より後）", before, old)
	}
	res, err := a.db.Exec(`INSERT INTO t_chat_message (chat_room_id, sender_account_id, body, source_type, sent_at)
		VALUES (8, 3, '解除の前のやりとり', '1', ?)`, old)
	if err != nil {
		t.Fatal(err)
	}
	oldID, _ := res.LastInsertId()

	// 解除した直後（期間の内）に、結び直すを選ぶ
	call(t, h, admin, "POST", "/api/admin/guardian-links/end", `{"guardian_id":"G004","child_id":"C004"}`)
	var status string
	a.db.QueryRow(`SELECT status FROM m_account WHERE account_id = 9`).Scan(&status)
	if status != "2" {
		t.Fatalf("最後の紐づけを解除したのに、アカウントが止まっていない: %s", status)
	}
	start := now()
	expectStatus(t, request(t, h, admin, "POST", "/api/admin/guardian-links/restore",
		`{"guardian_id":"G004","child_id":"C004","relink":true}`), http.StatusOK)

	var link, linkedAt string
	a.db.QueryRow(`SELECT link_status, linked_at FROM t_guardian_child WHERE guardian_id = 'G004' AND child_id = 'C004'`).Scan(&link, &linkedAt)
	a.db.QueryRow(`SELECT status FROM m_account WHERE account_id = 9`).Scan(&status)
	if link != "1" || status != "1" {
		t.Fatalf("結び直したあと: link_status = %s、アカウント = %s（どちらも 1 のはず）", link, status)
	}
	if linkedAt < start {
		t.Errorf("結び直したのに linked_at = %q（今 %s 以後のはず）", linkedAt, start)
	}
	var joined string
	var first, left *string
	a.db.QueryRow(`SELECT joined_at, first_joined_at, left_at FROM t_chat_member WHERE chat_room_id = 8 AND account_id = 9`).
		Scan(&joined, &first, &left)
	if joined < start || left != nil || first == nil || *first != before {
		t.Errorf("結び直したときの参加: joined_at %q（今 %s 以後）、first_joined_at %v（%q のはず）、left_at %v", joined, start, first, before, left)
	}
	if _, ok := chatMessagesOf(t, h, loginAs(a, 9, "guardian"), "8")[oldID]; ok {
		t.Error("期間の内に結び直したのに、解除の前のやりとりが読める")
	}
	var after string
	a.db.QueryRow(`SELECT after_value FROM t_operation_log
		WHERE target_table = 't_guardian_child' AND target_child_id = 'C004' AND before_value = '終了'
		ORDER BY operation_log_id DESC LIMIT 1`).Scan(&after)
	if after != "有効（結び直し、アカウントを再開）" {
		t.Errorf("結び直したときの操作ログの変更後 = %q", after)
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
	// （デモデータにも鈴木 浩之（アカウント8）の停止のシステムの行があるので、村田 真一（アカウント9）の行だけを数える）
	var out struct {
		Rows []struct {
			AccountID   *int64 `json:"account_id"`
			AccountName string `json:"account_name"`
			TargetTable string `json:"target_table"`
			TargetID    *int64 `json:"target_id"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(call(t, h, admin, "GET", "/api/admin/logs", "").Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	var systemRows, adminEnd int
	for _, r := range out.Rows {
		if r.TargetID == nil || *r.TargetID != 9 {
			continue
		}
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
	// デモデータの鈴木 浩之（アカウント8）の停止の行は数えない
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE operator_type = '2' AND target_id = 9`).Scan(&n)
	if n != 0 {
		t.Fatalf("システムの行が %d 件ある", n)
	}
}

/*
デモの鈴木 浩之（G003・アカウント8）は、誤って解除した例（紐づけを戻すの見本）。操作ログは、いまの解除が残す形と同じ2行：
管理者の解除の行（t_guardian_child・有効→終了）と、有効な紐づけがゼロになったことによるシステムの停止の行（照合 c5-08）。
モックは web/tests/admin.test.ts
*/
func TestDemoUnlinkLogMatchesEndGuardianLink(t *testing.T) {
	a, _ := newTestApp(t)
	type logRow struct {
		account                     *int64
		operator, before, after, at string
	}
	read := func(table string) logRow {
		t.Helper()
		var r logRow
		if err := a.db.QueryRow(`SELECT account_id, operator_type, before_value, after_value, operated_at FROM t_operation_log
			WHERE target_table = ? AND target_id = 8 AND target_child_id = 'C003'`, table).
			Scan(&r.account, &r.operator, &r.before, &r.after, &r.at); err != nil {
			t.Fatalf("%s の行が無い: %v", table, err)
		}
		return r
	}
	end, stop := read("t_guardian_child"), read("m_account")
	if end.account == nil || *end.account != 1 || end.operator != "1" || end.before != "有効" || end.after != "終了" {
		t.Errorf("解除の行 = %+v（管理者1・有効→終了のはず）", end)
	}
	if stop.account != nil || stop.operator != "2" || stop.before != "有効" || stop.after != "停止（有効な紐づけがゼロになったため）" {
		t.Errorf("停止の行 = %+v（システム・有効→停止（有効な紐づけがゼロになったため）のはず）", stop)
	}
	var endedAt string
	a.db.QueryRow(`SELECT ended_at FROM t_guardian_child WHERE guardian_id = 'G003' AND child_id = 'C003'`).Scan(&endedAt)
	if end.at != endedAt || stop.at != endedAt {
		t.Errorf("操作の日時 解除 %s・停止 %s、紐づけの解除 %s と同じはず", end.at, stop.at, endedAt)
	}
	var manual int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE target_table = 'm_account' AND target_id = 8 AND operator_type = '1'`).Scan(&manual)
	if manual != 0 {
		t.Errorf("管理者が鈴木 浩之のアカウントを止めた行が %d 件ある（保護者は手で止めない）", manual)
	}
}
