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

	call(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/approve", approveBody(t, a, d.DiaryID))
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
	call(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/approve",
		`{"share_to_guardian":true,"updated_at":"`+versionOfDiary(t, a, d.DiaryID)+`"}`)
	if got := guardianDiariesOf(t, h, nishida); len(got) != 0 {
		t.Fatalf("共有を選んでいない日誌が保護者に届いています: %+v", got)
	}
}

/*
 * 承認は、管理者が承認画面で読んだ版（updated_at）のときだけ通る（取り下げ・承認の取り消しと同じ。詳細設計書「日誌の状態」(3-6)）。
 * 承認画面を開いているあいだに、保育士が取り下げて本文・園児・「保護者へ共有する」を変えて申請し直すと、状態は申請中に戻る。
 * 古い画面のまま「承認する」を押しても 409 で断り、管理者が読んでいない本文を保護者へ届けない。読み直した版なら承認できる
 */
func TestDiaryApproveNeedsReadVersion(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff")    // 鈴木 浩之（S003・さくら組）
	nishida := loginAs(a, 6, "guardian") // 西田 太郎（C001）の保護者
	murata := loginAs(a, 9, "guardian")  // 村田 美咲（C004）の保護者

	// 1. 鈴木が西田 太郎の個人日誌を、共有せずに申請する。管理者が承認画面で開く（読んだ版）
	d := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		sharedPersonalDiary("C001", "園内で確かめる本文", "2", false)).Body.Bytes())
	read := diaryOf(t, call(t, h, admin, "GET", "/api/diaries/"+itoa(d.DiaryID), "").Body.Bytes())

	// 2. 鈴木が取り下げ、本文・園児（村田 美咲）・「保護者へ共有する」を変えて申請し直す
	call(t, h, teacher, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/withdraw", versionBody(d.UpdatedAt))
	token := acquireToken(t, h, teacher, itoa(d.DiaryID))
	again := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries",
		`{"diary_id":`+itoa(d.DiaryID)+`,"record_type":"1","child_id":"C004","class_id":1,"diary_date":"`+today()+
			`","body":"管理者が読んでいない本文","lock_token":"`+token+`","status":"2","share_to_guardian":true}`).Body.Bytes())
	if again.Status != "2" || !again.ShareToGuardian || again.ChildID == nil || *again.ChildID != "C004" {
		t.Fatalf("申請し直したあと: %+v", again)
	}

	t.Run("古い画面の版で承認すると 409 version_conflict で、保護者に届かない", func(t *testing.T) {
		// 版を送らない要求（前の画面の {}）も同じ
		for _, body := range []string{versionBody(read.UpdatedAt), `{}`} {
			e := errorOf(t, request(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/approve", body), http.StatusConflict)
			if e.Kind != "version_conflict" || e.Message != "他の職員が更新しています。内容を再読み込みしてください。" {
				t.Fatalf("%s: kind=%q message=%q", body, e.Kind, e.Message)
			}
		}
		if got := statusOfDiary(t, a, d.DiaryID); got != "2" {
			t.Fatalf("status = %s, want 2（申請中のまま）", got)
		}
		for name, g := range map[string]*http.Cookie{"西田 太郎の保護者": nishida, "村田 美咲の保護者": murata} {
			if got := guardianDiariesOf(t, h, g); len(got) != 0 {
				t.Fatalf("%sに %d 件届いています: %+v", name, len(got), got)
			}
		}
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE target_table = 't_diary' AND target_id = ? AND operation_type = ?`,
			d.DiaryID, opApprove).Scan(&n)
		if n != 0 {
			t.Fatalf("承認の操作ログが %d 件残っています", n)
		}
	})

	t.Run("読み直した版なら承認でき、申請し直した園児の保護者に届く", func(t *testing.T) {
		cur := diaryOf(t, call(t, h, admin, "GET", "/api/diaries/"+itoa(d.DiaryID), "").Body.Bytes())
		got := diaryOf(t, call(t, h, admin, "POST", "/api/diaries/"+itoa(d.DiaryID)+"/approve", versionBody(cur.UpdatedAt)).Body.Bytes())
		if got.Status != "3" {
			t.Fatalf("status = %s, want 3", got.Status)
		}
		if shared := guardianDiariesOf(t, h, murata); len(shared) != 1 || shared[0].Body != "管理者が読んでいない本文" {
			t.Fatalf("村田 美咲の保護者に届いていません: %+v", shared)
		}
		if other := guardianDiariesOf(t, h, nishida); len(other) != 0 {
			t.Fatalf("西田 太郎の保護者に %d 件届いています", len(other))
		}
	})
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
