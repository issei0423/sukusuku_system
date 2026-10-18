package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

/*
 * 午睡記録検索と帳票に、ねた・おきたと入眠時の体温を出す。ヒヤリハットを起票した異常時の記録は、
 * ヒヤリハット側の状況・とった対応を出して二重に数えない
 * 典拠：図/画面詳細図.md「午睡記録検索画面」(5-3) の項目6・9・11、基本設計書.md「帳票の出力」(4-8)、
 *      要件定義書.md「日誌システム」(4-3) の「午睡チェックの異常時の記録との関係」
 *
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、web/tests/napReport.test.ts と同じ観点で確かめる。
 */

type napSearchPage struct {
	Rows []struct {
		Kind             string   `json:"kind"`
		NapRecordID      *int64   `json:"nap_record_id"`
		NapSleepID       *int64   `json:"nap_sleep_id"`
		ChildID          string   `json:"child_id"`
		CheckedAt        string   `json:"checked_at"`
		SavedAt          *string  `json:"saved_at"`
		BodyPosition     *string  `json:"body_position"`
		Temperature      *float64 `json:"temperature"`
		SleepTemperature *float64 `json:"sleep_temperature"`
		StaffName        string   `json:"staff_name"`
		ClassName        string   `json:"class_name"`
		SessionDate      string   `json:"session_date"`
	} `json:"rows"`
	Total int `json:"total"`
}

func searchNap(t *testing.T, h http.Handler, c *http.Cookie, query string) napSearchPage {
	t.Helper()
	var p napSearchPage
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/nap/records"+query, "").Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestNapSearchShowsSleepAndWakeRowsWithSleepTemperature(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	var sleptAt, wokeAt, date string
	if err := a.db.QueryRow(`SELECT n.slept_at, n.woke_at, s.session_date FROM t_nap_sleep n
		JOIN t_nap_session s ON s.nap_session_id = n.nap_session_id WHERE n.nap_sleep_id = 8`).
		Scan(&sleptAt, &wokeAt, &date); err != nil {
		t.Fatal(err)
	}

	p := searchNap(t, h, admin, "?from="+date+"&to="+date+"&class_id=1")
	sleepIdx, wakeIdx := -1, -1
	for i, r := range p.Rows {
		if r.NapSleepID == nil || *r.NapSleepID != 8 {
			continue
		}
		switch r.Kind {
		case "sleep":
			sleepIdx = i
			if r.CheckedAt != sleptAt || r.SleepTemperature == nil || *r.SleepTemperature != 36.5 {
				t.Fatalf("ねたの行に、押した時刻と入眠時の体温が出ていません: %+v", r)
			}
			if r.NapRecordID != nil || r.SavedAt != nil || r.BodyPosition != nil || r.Temperature != nil {
				t.Fatalf("ねたの行に確認の値が入っています: %+v", r)
			}
			if r.ChildID != "C001" || r.StaffName == "" || r.ClassName == "" || r.SessionDate != date {
				t.Fatalf("ねたの行の園児・記録者・クラス・日付が正しくありません: %+v", r)
			}
		case "wake":
			wakeIdx = i
			if r.CheckedAt != wokeAt || r.SleepTemperature != nil || r.StaffName == "" {
				t.Fatalf("おきたの行は、おきた時刻と記録者を出し、入眠時の体温を出しません: %+v", r)
			}
		default:
			t.Fatalf("ねた・おきたの行の種類が正しくありません: %+v", r)
		}
	}
	if sleepIdx < 0 || wakeIdx < 0 {
		t.Fatalf("ねた・おきたの行がありません: %+v", p.Rows)
	}
	// 新しい順。おきたはねたより上に出る
	if wakeIdx > sleepIdx {
		t.Fatalf("おきたの行が、ねたの行より下にあります（おきた %d、ねた %d）", wakeIdx, sleepIdx)
	}
	for i := 1; i < len(p.Rows); i++ {
		if p.Rows[i-1].CheckedAt < p.Rows[i].CheckedAt {
			t.Fatalf("時刻の新しい順になっていません: %s のあとに %s", p.Rows[i-1].CheckedAt, p.Rows[i].CheckedAt)
		}
	}
}

func TestNapSearchSleepRowsFollowFiltersAndScope(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	kinjo := loginAs(a, 5, "staff") // ひまわり組。さくら組の C001 は見えない

	has := func(p napSearchPage, sleepID int64) bool {
		for _, r := range p.Rows {
			if r.NapSleepID != nil && *r.NapSleepID == sleepID {
				return true
			}
		}
		return false
	}
	if !has(searchNap(t, h, admin, ""), 8) {
		t.Fatal("管理者の検索に、ねた・おきたの行が出ていません")
	}
	if has(searchNap(t, h, admin, "?class_id=2"), 8) {
		t.Fatal("クラスで絞っても、ほかのクラスのねた・おきたが出ています")
	}
	if has(searchNap(t, h, admin, "?child_name=存在しない名前"), 8) {
		t.Fatal("園児名で絞っても、ほかの園児のねた・おきたが出ています")
	}
	if has(searchNap(t, h, kinjo, ""), 8) {
		t.Fatal("一般（保育士）に、ほかのクラスの園児のねた・おきたが出ています")
	}

	// 取り消した「ねた」は出さない
	if _, err := a.db.Exec(`UPDATE t_nap_sleep SET is_deleted = 1 WHERE nap_sleep_id = 8`); err != nil {
		t.Fatal(err)
	}
	if has(searchNap(t, h, admin, ""), 8) {
		t.Fatal("取り消したねた・おきたが出ています")
	}
}

type napAbnormalJSON struct {
	NapAbnormalID     int64   `json:"nap_abnormal_id"`
	Situation         string  `json:"situation"`
	Response          string  `json:"response"`
	DiaryID           *int64  `json:"diary_id"`
	IncidentSituation *string `json:"incident_situation"`
	IncidentResponse  *string `json:"incident_response"`
}

func napAbnormalByID(t *testing.T, h http.Handler, c *http.Cookie, id int64) napAbnormalJSON {
	t.Helper()
	var all []napAbnormalJSON
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/nap/abnormals", "").Body.Bytes(), &all); err != nil {
		t.Fatal(err)
	}
	for _, x := range all {
		if x.NapAbnormalID == id {
			return x
		}
	}
	t.Fatalf("異常時の記録 %d がありません", id)
	return napAbnormalJSON{}
}

func TestNapAbnormalsReturnIncidentSideForRaisedRecords(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")

	// デモの記録 1 はヒヤリハット（日誌 3）を起票済み。日誌の側の状況・とった対応を返し、記録そのものは書き換えない
	raised := napAbnormalByID(t, h, admin, 1)
	if raised.IncidentSituation == nil || *raised.IncidentSituation != "午睡中にうつ伏せの体位を確認した。" ||
		raised.IncidentResponse == nil || *raised.IncidentResponse != "仰向けに直し、呼吸と顔色を確認した。" {
		t.Fatalf("ヒヤリハット側の状況・とった対応が返っていません: %+v", raised)
	}
	if raised.Situation != "うつ伏せの体位で寝ているのを発見。呼吸あり、顔色は通常。" {
		t.Fatalf("異常時の記録そのものの状況が書き換わっています: %+v", raised)
	}

	// 起票していない記録 2 は null
	notRaised := napAbnormalByID(t, h, admin, 2)
	if notRaised.DiaryID != nil || notRaised.IncidentSituation != nil || notRaised.IncidentResponse != nil {
		t.Fatalf("起票していない記録に、ヒヤリハット側の値が付いています: %+v", notRaised)
	}

	// ヒヤリハットの本文を直したら、直したあとの日誌の側を返す（集計・監査はヒヤリハット側を正とする）
	if _, err := a.db.Exec(`UPDATE t_diary SET body = ? WHERE diary_id = 3`,
		"【発生日時】\r\n13時40分\r\n\r\n【発生場所】\r\nさくら組の午睡室\r\n\r\n【状況】\r\n直した状況。\r\n2行目。\r\n\r\n【とった対応】\r\n直した対応。\r\n\r\n【今後の対策】\r\n5分ごとに確かめる。"); err != nil {
		t.Fatal(err)
	}
	edited := napAbnormalByID(t, h, admin, 1)
	if edited.IncidentSituation == nil || *edited.IncidentSituation != "直した状況。\n2行目。" ||
		edited.IncidentResponse == nil || *edited.IncidentResponse != "直した対応。" {
		t.Fatalf("直したあとのヒヤリハットの状況・とった対応が返っていません: %+v", edited)
	}

	// 日誌が削除されていれば、日誌の側の値は返さない
	if _, err := a.db.Exec(`UPDATE t_diary SET is_deleted = 1 WHERE diary_id = 3`); err != nil {
		t.Fatal(err)
	}
	if gone := napAbnormalByID(t, h, admin, 1); gone.IncidentSituation != nil || gone.IncidentResponse != nil {
		t.Fatalf("削除した日誌の値が返っています: %+v", gone)
	}
}

func TestIncidentSituationResponse(t *testing.T) {
	cases := []struct {
		name, body, situation, response string
	}{
		{"起票したままの本文", "【発生日時】\n2026-09-01 13:40:00\n\n【状況】\nうつ伏せ\n\n【とった対応】\n仰向けに直した\n\n【今後の対策】\n", "うつ伏せ", "仰向けに直した"},
		{"雛形の見出し（発生場所）を挟む", "【発生日時】\n\n【発生場所】\n午睡室\n\n【状況】\nA\n\n【とった対応】\nB", "A", "B"},
		{"見出しが無い", "自由に書いた本文", "", ""},
		{"文の中の【】は見出しにしない", "【状況】\n【注意】のあと泣いた。\n【とった対応】\n抱いた", "【注意】のあと泣いた。", "抱いた"},
	}
	for _, c := range cases {
		s, r := incidentSituationResponse(c.body)
		if s != c.situation || r != c.response {
			t.Errorf("%s: 状況=%q 対応=%q（期待 %q・%q）", c.name, s, r, c.situation, c.response)
		}
	}
}
