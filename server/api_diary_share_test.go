package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * 日誌の保護者への共有（api_diary_share.go）
 * 保育士が申請するときに「保護者へ共有する」を選び、管理者が承認すると、その園児の保護者が読める。
 * 2026-10-29 に持ち主が決めた（既定は共有しない。対象は個人日誌だけ）。
 * 画面側のモックは web/tests/diaryShare.test.ts が同じ観点で確かめる。
 */

// guardianDiariesOf は、保護者に共有された日誌を返す
func guardianDiariesOf(t *testing.T, h http.Handler, c *http.Cookie) []GuardianDiary {
	t.Helper()
	var out []GuardianDiary
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/guardian/diaries", "").Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// sharedPersonalDiary は、保護者へ共有を選んだ個人日誌の要求
func sharedPersonalDiary(childID, body, status string, share bool) string {
	s := "false"
	if share {
		s = "true"
	}
	return `{"record_type":"1","child_id":"` + childID + `","class_id":1,"diary_date":"` + today() +
		`","body":"` + body + `","status":"` + status + `","share_to_guardian":` + s + `}`
}

func TestDiaryShareNeedsApplicationAndApproval(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")    // さくら組
	nishida := loginAs(a, 6, "guardian") // 西田 太郎（C001）の保護者
	murata := loginAs(a, 9, "guardian")  // 村田 美咲（C004）の保護者

	d := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		sharedPersonalDiary("C001", "積み木で高い塔を作りました", "2", true)).Body.Bytes())
	if !d.ShareToGuardian {
		t.Fatalf("申請した日誌に共有の印がありません")
	}

	// 申請しただけでは届かない（管理者の承認が要る）
	if got := guardianDiariesOf(t, h, nishida); len(got) != 0 {
		t.Fatalf("承認の前に保護者へ %d 件届いています", len(got))
	}

	call(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/approve", "")
	got := guardianDiariesOf(t, h, nishida)
	if len(got) != 1 || got[0].DiaryID != d.DiaryID || got[0].Body != "積み木で高い塔を作りました" || got[0].ChildName == "" {
		t.Fatalf("承認したのに自児の保護者に届いていません: %+v", got)
	}
	if got[0].SharedAt == "" {
		t.Fatalf("共有した日時がありません")
	}
	// 他児の保護者には届かない
	if other := guardianDiariesOf(t, h, murata); len(other) != 0 {
		t.Fatalf("他児の保護者に %d 件届いています", len(other))
	}
	// 保護者に見せる項目だけを返す（職員の ID・差し戻す理由・状態は返さない）
	raw := call(t, h, nishida, "GET", "/api/guardian/diaries", "").Body.String()
	for _, key := range []string{"created_staff_id", "applied_staff_id", "approved_staff_id", "returned_reason", "status"} {
		if strings.Contains(raw, `"`+key+`"`) {
			t.Fatalf("保護者に %s を返しています: %s", key, raw)
		}
	}
	// 操作ログに、共有して承認したことを残す
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE target_table = 't_diary' AND target_id = ? AND after_value = ?`,
		d.DiaryID, diaryLogApproveShared).Scan(&n)
	if n != 1 {
		t.Fatalf("共有して承認した操作ログが %d 件", n)
	}

	// 承認を取り消すと（差し戻しになり）保護者から見えなくなる
	cur := diaryOf(t, call(t, h, admin, "GET", "/api/diaries/"+itoa(d.DiaryID), "").Body.Bytes())
	call(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/revoke-approval",
		`{"reason":"書き直してください","updated_at":"`+cur.UpdatedAt+`"}`)
	if got := guardianDiariesOf(t, h, nishida); len(got) != 0 {
		t.Fatalf("承認を取り消したのに保護者に %d 件見えています", len(got))
	}
}

// 既定は共有しない。共有を選ばずに申請した日誌は、承認しても保護者に届かない
func TestDiaryShareDefaultsToNotShared(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")
	nishida := loginAs(a, 6, "guardian")

	d := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		personalDiary(0, "C001", "1", today(), "園内で確かめる個人日誌", "2")).Body.Bytes())
	if d.ShareToGuardian {
		t.Fatalf("共有を選んでいないのに共有の印があります")
	}
	call(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/approve", `{"share_to_guardian":true}`)
	if got := guardianDiariesOf(t, h, nishida); len(got) != 0 {
		t.Fatalf("共有を選んでいない日誌が保護者に届いています: %+v", got)
	}
}

// 共有できるのは個人日誌だけ。クラス日誌に共有を選んで送っても、共有の印は付かない
func TestDiaryShareOnlyPersonal(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	d := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		`{"record_type":"2","class_id":1,"diary_date":"`+today()+`","body":"クラスの活動","status":"2","share_to_guardian":true}`).Body.Bytes())
	if d.ShareToGuardian {
		t.Fatalf("クラス日誌に共有の印が付いています")
	}
}

// 共有された日誌の経路は保護者だけ。職員は日誌の経路で読む
func TestGuardianDiariesIsForGuardians(t *testing.T) {
	a, h := newTestApp(t)
	for _, id := range []int64{1, 3} {
		expectStatus(t, request(t, h, loginAs(a, id, "staff"), "GET", "/api/guardian/diaries", ""), http.StatusForbidden)
	}
}

// 共有の印の列が無い既存の DB には、起動のときに列を足す。既存の日誌は共有しないまま
func TestEnsureDiaryShareColumn(t *testing.T) {
	a, _ := newTestApp(t)
	if _, err := a.db.Exec(`ALTER TABLE t_diary DROP COLUMN share_to_guardian`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ { // 何度呼んでも同じ結果になる
		if err := ensureInternalDiary(a.db); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err := a.db.QueryRow(`SELECT COUNT(*) FROM t_diary WHERE share_to_guardian <> 0`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("既存の日誌 %d 件に共有の印が付いています", n)
	}
}
