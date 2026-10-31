package main

import (
	"net/http"
	"strings"
	"testing"
)

/*
入眠時の体温（POST /api/nap/sleeps/{id}/temperature。詳細設計書「午睡（ねた・おきた・対象外）」(4-6) の (2)、決めたこと D-7、
基本設計書「ねた・おきた」(4-8)・「ねた・おきた（t_nap_sleep）」(5-7)）。受け入れテスト 04-014。

  - 「ねた」を先に保存し、体温はあとから入れる。小数第1位まで。範囲（30.0〜43.0℃）の外も保存する
  - 訂正の印（corrected_at）を付けず、「ねた」の時刻を変えない。知らせは nap だけで、保護者へは送らない（監査の層）
  - 入れられるのは「おひるね中」の組だけ。終わった実施へは 409 session_ended

モックの同じ観点は web/tests/napSleepTemperature.test.tsx にある。
*/
func TestNapSleepTemperature(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	s := startFreshNap(t, a, h, teacher)
	base := "/api/nap/session/" + itoa(s.NapSessionID)
	var slept napSleepOut
	decode(t, call(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C001"}`), &slept)
	path := "/api/nap/sleeps/" + itoa(slept.ID) + "/temperature"
	clients := map[string]*liveClient{
		"さくら組の担任":   listen(a, accTeacher),
		"西田 太郎の保護者": listen(a, accGuardian),
	}
	drainAll(clients)

	// ほかのクラスの担任と保護者は入れられない
	expectStatus(t, request(t, h, otherTeacher, "POST", path, `{"sleep_temperature":36.8}`), http.StatusForbidden)
	expectStatus(t, request(t, h, guardian, "POST", path, `{"sleep_temperature":36.8}`), http.StatusForbidden)
	// 小数第2位・空は断る
	for _, body := range []string{`{"sleep_temperature":36.85}`, `{}`, `{"sleep_temperature":null}`} {
		if b := expectStatus(t, request(t, h, teacher, "POST", path, body), http.StatusBadRequest); !strings.Contains(b, msgTemperatureFormat) {
			t.Errorf("%s: %s", body, b)
		}
	}

	var got napSleepOut
	decode(t, call(t, h, teacher, "POST", path, `{"sleep_temperature":36.8}`), &got)
	if got.SleepTemperature == nil || *got.SleepTemperature != 36.8 || got.CorrectedAt != nil || got.SleptAt != slept.SleptAt || got.WokeAt != nil {
		t.Fatalf("入眠時の体温: %+v（ねたの時刻を変えず、訂正の印を付けない）", got)
	}
	// 知らせは nap だけ。保護者へは送らない
	expect(t, "入眠時の体温（保護者へは送らない）", clients,
		to(who("さくら組の担任"), liveEvent{Type: evNap, ClassID: classSakura, ChildID: childTaro}))
	// 保護者の連絡帳には出さない（監査の層）
	if body := call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.String(); strings.Contains(body, "sleep_temperature") {
		t.Errorf("保護者の応答に入眠時の体温が入っている: %s", body)
	}
	// 職員の午睡チェック画面の行には出る
	var state []NapChildState
	decode(t, call(t, h, teacher, "GET", "/api/nap/state?class_id=1&session_id="+itoa(s.NapSessionID), ""), &state)
	for _, row := range state {
		if row.Child.ChildID == "C001" && (len(row.Sleeps) != 1 || row.Sleeps[0].SleepTemperature == nil || *row.Sleeps[0].SleepTemperature != 36.8) {
			t.Errorf("午睡チェックの行: %+v", row.Sleeps)
		}
	}

	// 範囲の外も保存する（確かめは画面）。入れ直しても操作ログに元の値を残す
	decode(t, call(t, h, teacher, "POST", path, `{"sleep_temperature":43.5}`), &got)
	if got.SleepTemperature == nil || *got.SleepTemperature != 43.5 {
		t.Fatalf("範囲の外の体温: %+v", got)
	}
	var logs int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log WHERE target_table = 't_nap_sleep' AND target_id = ? AND operation_type = '2'
		AND before_value LIKE '%sleep_temperature%'`, slept.ID).Scan(&logs)
	if logs != 2 {
		t.Errorf("入眠時の体温の操作ログ = %d, want 2", logs)
	}

	// 「おきた」のあとは入れられない
	call(t, h, teacher, "POST", "/api/nap/sleeps/"+itoa(slept.ID)+"/wake", "")
	if b := expectStatus(t, request(t, h, teacher, "POST", path, `{"sleep_temperature":36.9}`), http.StatusConflict); !strings.Contains(b, msgSleepTempAfterWake) {
		t.Errorf("おきたのあと: %s", b)
	}

	// 終わった実施の組へは 409 session_ended
	var second napSleepOut
	decode(t, call(t, h, teacher, "POST", base+"/sleeps", `{"child_id":"C002"}`), &second)
	call(t, h, teacher, "POST", base+"/end", "")
	if b := expectStatus(t, request(t, h, teacher, "POST", "/api/nap/sleeps/"+itoa(second.ID)+"/temperature", `{"sleep_temperature":36.9}`), http.StatusConflict); !strings.Contains(b, kindSessionEnded) {
		t.Errorf("終わった実施: %s", b)
	}
}
