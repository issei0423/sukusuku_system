package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

/*
 * Go サーバとモックで、規則と結果をそろえる（GitHub Issue #177）
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1)・「権限チェックの実装方針」(6-2)、
 *      要件定義書.md「対象権限列の読み方」(4-2 冒頭)、基本設計書.md「操作ログ（t_operation_log）」(5-8)
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、
 * web/tests/mockServerRules.test.ts と同じ観点で確かめる。並び順は web/仮置き値.md「一覧の並び順」。
 */

// 職員・管理者だけの API は、保護者と担当外の職員に使わせない（Issue #177 の 3）。
// モックには、このうちいくつかの検査が無かった
func TestStaffOnlyRoutesRejectGuardianAndOtherClass(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, 6, "guardian") // 野原 太郎（C001・さくら組）の保護者
	teacher := loginAs(a, 3, "staff")     // さくら組
	kinjo := loginAs(a, 5, "staff")       // ひまわり組

	for _, path := range []string{
		"/api/children/C001/development/previous",
		"/api/children/C001/development/draft",
		"/api/children/allergies",
		"/api/nap/abnormals",
		"/api/chat/misdelivery/pending",
		"/api/development/list?class_id=1",
		"/api/development/schedules?class_id=1",
		"/api/nap/records",
		"/api/physical/class-status?class_id=1",
		"/api/dashboard/staff",
	} {
		expectStatus(t, request(t, h, guardian, "GET", path, ""), http.StatusForbidden)
	}

	t.Run("前回の発達チェックと当日の下書きは、その園児を参照できる職員に限る", func(t *testing.T) {
		for _, path := range []string{"/api/children/C001/development/previous", "/api/children/C001/development/draft"} {
			expectStatus(t, request(t, h, kinjo, "GET", path, ""), http.StatusForbidden)
			call(t, h, teacher, "GET", path, "")
		}
		if call(t, h, teacher, "GET", "/api/children/C001/development/previous", "").Body.String() == "null\n" {
			t.Fatal("担任に、野原 太郎 の前回の記録が返っていません")
		}
	})

	t.Run("取り消して対応を記録していないメッセージは、管理者に限る", func(t *testing.T) {
		expectStatus(t, request(t, h, teacher, "GET", "/api/chat/misdelivery/pending", ""), http.StatusForbidden)
	})

	t.Run("アレルギー一覧は、一般にも自クラスに限らず全園児を返す（基本設計書 6-1 ○※2）", func(t *testing.T) {
		if !strings.Contains(call(t, h, kinjo, "GET", "/api/children/allergies", "").Body.String(), `"child_id":"C001"`) {
			t.Fatal("ひまわり組の職員に、さくら組の 野原 太郎 のアレルギーが返っていません")
		}
	})
}

// 発達チェックを初めて保存したときの操作ログは「作成」、保存し直しは「変更」（Issue #177 の 6）。
// モックは、記録を作ったあとで判定していたため、いつも「変更」になっていた
func TestDevelopmentCheckFirstSaveLogsCreate(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")

	// 高梨 健（C003・さくら組）。デモデータに当日の記録は無い
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_development_check WHERE child_id = 'C003' AND checked_on = ?`, today()).Scan(&n)
	if n != 0 {
		t.Fatalf("前提：C003 に当日の記録が %d 件あります", n)
	}
	latestOp := func() string {
		var op string
		a.db.QueryRow(`SELECT operation_type FROM t_operation_log
			WHERE target_table = 't_development_check' AND target_child_id = 'C003'
			ORDER BY operation_log_id DESC LIMIT 1`).Scan(&op)
		return op
	}
	body := `{"child_id":"C003","checked_on":"` + today() + `","results":[],"note":"","status":"1"}`

	call(t, h, teacher, "POST", "/api/development/checks", body)
	if got := latestOp(); got != opCreate {
		t.Fatalf("初めての保存の操作区分 = %q, want %q（作成）", got, opCreate)
	}
	call(t, h, teacher, "POST", "/api/development/checks", body)
	if got := latestOp(); got != opUpdate {
		t.Fatalf("保存し直しの操作区分 = %q, want %q（変更）", got, opUpdate)
	}
}

// 一覧の並び順をモックとそろえる（Issue #177 の 7。設計に定めが無いため web/仮置き値.md「一覧の並び順」に置いた）
func TestListOrdersMatchMock(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	t.Run("アレルギー一覧は園児のよみ順", func(t *testing.T) {
		var rows []struct {
			Child Child `json:"child"`
		}
		if err := json.Unmarshal(call(t, h, admin, "GET", "/api/children/allergies", "").Body.Bytes(), &rows); err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, r := range rows {
			ids = append(ids, r.Child.ChildID)
		}
		// 井上 空 → 野原 太郎 → 橋本 莉子 → 宮城 美咲
		if want := []string{"C013", "C001", "C020", "C004"}; !reflect.DeepEqual(ids, want) {
			t.Fatalf("並び = %v, want %v", ids, want)
		}
	})

	t.Run("異常時の記録は発見時刻の新しい順。同じ時刻なら、あとで記録したものを先にする", func(t *testing.T) {
		for _, child := range []string{"C001", "C002"} {
			if _, err := a.db.Exec(`INSERT INTO t_nap_abnormal (nap_session_id, child_id, found_at, situation, response, staff_id)
				VALUES (2, ?, '2026-08-29T13:00:00', '並び順の確認', '並び順の確認', 'S003')`, child); err != nil {
				t.Fatal(err)
			}
		}
		var rows []napAbnormalView
		if err := json.Unmarshal(call(t, h, admin, "GET", "/api/nap/abnormals", "").Body.Bytes(), &rows); err != nil {
			t.Fatal(err)
		}
		for i := 1; i < len(rows); i++ {
			p, c := rows[i-1], rows[i]
			if p.FoundAt < c.FoundAt || (p.FoundAt == c.FoundAt && p.NapAbnormalID < c.NapAbnormalID) {
				t.Fatalf("並びが崩れています: %d（%s）の次に %d（%s）", p.NapAbnormalID, p.FoundAt, c.NapAbnormalID, c.FoundAt)
			}
		}
	})

	t.Run("スケジュール設定は園児のよみ順で、発達チェック一覧と同じ並び", func(t *testing.T) {
		for _, classID := range []string{"1", "2"} {
			var sched, list []struct {
				Child Child `json:"child"`
			}
			if err := json.Unmarshal(call(t, h, admin, "GET", "/api/development/schedules?class_id="+classID, "").Body.Bytes(), &sched); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(call(t, h, admin, "GET", "/api/development/list?class_id="+classID, "").Body.Bytes(), &list); err != nil {
				t.Fatal(err)
			}
			if len(sched) < 2 || len(sched) != len(list) {
				t.Fatalf("クラス %s: スケジュール %d 名・一覧 %d 名", classID, len(sched), len(list))
			}
			for i := range sched {
				if i > 0 && sched[i-1].Child.ChildNameKana > sched[i].Child.ChildNameKana {
					t.Fatalf("クラス %s: よみ順になっていません（%s の次に %s）", classID,
						sched[i-1].Child.ChildNameKana, sched[i].Child.ChildNameKana)
				}
				if sched[i].Child.ChildID != list[i].Child.ChildID {
					t.Fatalf("クラス %s の %d 行目: スケジュール %s・一覧 %s", classID, i, sched[i].Child.ChildID, list[i].Child.ChildID)
				}
			}
		}
	})

	t.Run("招待コードは園児のよみ順にまとめ、同じ園児の中は発行の古い順", func(t *testing.T) {
		var rows []struct {
			InvitationCodeID int64 `json:"invitation_code_id"`
		}
		if err := json.Unmarshal(call(t, h, admin, "GET", "/api/admin/invitations", "").Body.Bytes(), &rows); err != nil {
			t.Fatal(err)
		}
		ids := []int64{}
		for _, r := range rows {
			if r.InvitationCodeID <= 7 { // デモデータの 7 枚
				ids = append(ids, r.InvitationCodeID)
			}
		}
		// 上園 花子（3・4）→ 金城 陸（7）→ 高梨 健（5）→ 野原 太郎（1・2）→ 宮城 美咲（6）
		if want := []int64{3, 4, 7, 5, 1, 2, 6}; !reflect.DeepEqual(ids, want) {
			t.Fatalf("並び = %v, want %v", ids, want)
		}
	})

	t.Run("取り消して対応を記録していないメッセージは、送信の新しい順。同じ時刻なら、あとで送ったものを先にする", func(t *testing.T) {
		// デモデータには対応を記録していない取消が無いため、職員の取消を足す（古いものを間に入れ、同じ時刻を 3 件）
		ids := []int64{}
		for _, sentAt := range []string{"2026-08-29T10:00:00", "2026-08-28T10:00:00", "2026-08-30T10:00:00",
			"2026-08-27T10:00:00", "2026-08-27T10:00:00", "2026-08-27T10:00:00"} {
			res, err := a.db.Exec(`INSERT INTO t_chat_message
				(chat_room_id, sender_account_id, body, source_type, sent_at, is_deleted, deleted_at, deleted_account_id)
				VALUES (1, 3, '並び順の確認', '1', ?, 1, ?, 3)`, sentAt, sentAt)
			if err != nil {
				t.Fatal(err)
			}
			id, _ := res.LastInsertId()
			ids = append(ids, id)
		}
		added := map[int64]bool{}
		for _, id := range ids {
			added[id] = true
		}
		var rows []struct {
			ChatMessageID int64 `json:"chat_message_id"`
		}
		if err := json.Unmarshal(call(t, h, admin, "GET", "/api/chat/misdelivery/pending", "").Body.Bytes(), &rows); err != nil {
			t.Fatal(err)
		}
		got := []int64{}
		for _, r := range rows {
			if added[r.ChatMessageID] {
				got = append(got, r.ChatMessageID)
			}
		}
		// 08-30 → 08-29 → 08-28 → 08-27 の 3 件（番号の大きい順）
		if want := []int64{ids[2], ids[0], ids[1], ids[5], ids[4], ids[3]}; !reflect.DeepEqual(got, want) {
			t.Fatalf("並び = %v, want %v", got, want)
		}
	})
}
