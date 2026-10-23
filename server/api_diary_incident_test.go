package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * ヒヤリハットの欄（発生日時・場所・状況・とった対応・今後の対策・保護者へ伝えたこと）の保存と読み出し。
 * 典拠：詳細設計書「日誌の画面（作り直し）」(2-13 (8))・「日誌」(4-13 (1)・(6))・決めたこと D-33、
 *      基本設計書「ヒヤリハットの記録」(4-6)。
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、web/tests/diaryIncident.test.ts と同じ観点で確かめる。
 */

// incidentRequest は、ヒヤリハットの保存の要求を作る。fields で欄を上書きする
func incidentRequest(t *testing.T, diaryID int64, token string, fields map[string]string) string {
	t.Helper()
	inc := map[string]string{
		"occurred_at": today() + "T00:00:00",
		"place":       "園庭",
		"situation":   "すべり台の階段で足を踏み外しかけた。",
		"response":    "そばにいた職員が体を支え、けががないことを確かめた。",
	}
	for k, v := range fields {
		inc[k] = v
	}
	req := map[string]any{
		"record_type": "4", "child_id": "C001", "class_id": 1, "diary_date": today(),
		// ヒヤリハットでは本文を送っても使わない（サーバが欄から作る）
		"body": "送った本文", "status": "1", "incident": inc,
	}
	if diaryID != 0 {
		req["diary_id"] = diaryID
		req["lock_token"] = token
	}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

type incidentRow struct {
	body, occurredAt, place                       string
	notice, noticedAt, noticeMethod, noticePerson *string
}

func readIncidentRow(t *testing.T, a *app, id int64) incidentRow {
	t.Helper()
	var r incidentRow
	var occurredAt, place, notice, noticedAt, method, person nullString
	if err := a.db.QueryRow(`SELECT body, occurred_at, place, guardian_notice, guardian_noticed_at,
		guardian_notice_method, guardian_notice_person FROM t_diary WHERE diary_id = ?`, id).
		Scan(&r.body, &occurredAt, &place, &notice, &noticedAt, &method, &person); err != nil {
		t.Fatal(err)
	}
	r.occurredAt, r.place = occurredAt.String, place.String
	r.notice, r.noticedAt, r.noticeMethod, r.noticePerson = notice.ptr(), noticedAt.ptr(), method.ptr(), person.ptr()
	return r
}

// nullString は、NULL を読める文字列（テストで空と NULL を分けて見るため）
type nullString struct {
	String string
	Valid  bool
}

func (n *nullString) Scan(v any) error {
	switch x := v.(type) {
	case nil:
		n.String, n.Valid = "", false
	case string:
		n.String, n.Valid = x, true
	case []byte:
		n.String, n.Valid = string(x), true
	}
	return nil
}

func (n nullString) ptr() *string {
	if !n.Valid {
		return nil
	}
	return &n.String
}

func TestIncidentFieldsAreSavedAndReturned(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff") // 鈴木（さくら組の担任）

	t.Run("状況・とった対応・今後の対策を見出しでつないで本文に持ち、読むときは分けて返す", func(t *testing.T) {
		saved := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries", incidentRequest(t, 0, "", map[string]string{
			"countermeasure":         "すべり台の階段に、上り下りの順番の目印を付ける。",
			"guardian_notice":        "1",
			"guardian_noticed_at":    today() + "T00:00:00",
			"guardian_notice_method": "2",
			"guardian_notice_person": "母（お迎え）",
		})).Body.Bytes())

		row := readIncidentRow(t, a, saved.DiaryID)
		wantBody := "【状況】\nすべり台の階段で足を踏み外しかけた。\n\n【とった対応】\nそばにいた職員が体を支え、けががないことを確かめた。" +
			"\n\n【今後の対策】\nすべり台の階段に、上り下りの順番の目印を付ける。"
		if row.body != wantBody {
			t.Fatalf("本文 = %q, want %q", row.body, wantBody)
		}
		if row.occurredAt != today()+"T00:00:00" || row.place != "園庭" {
			t.Fatalf("発生日時・場所 = %q・%q", row.occurredAt, row.place)
		}
		if row.notice == nil || *row.notice != "1" || row.noticeMethod == nil || *row.noticeMethod != "2" ||
			row.noticePerson == nil || *row.noticePerson != "母（お迎え）" || row.noticedAt == nil {
			t.Fatalf("保護者へ伝えたことの列が違います: %+v", row)
		}

		got := diaryOf(t, call(t, h, teacher, "GET", "/api/diaries/"+itoa(saved.DiaryID), "").Body.Bytes())
		if got.Incident == nil {
			t.Fatal("incident が返っていません")
		}
		inc := got.Incident
		if inc.Situation != "すべり台の階段で足を踏み外しかけた。" ||
			inc.Response != "そばにいた職員が体を支え、けががないことを確かめた。" ||
			inc.Countermeasure != "すべり台の階段に、上り下りの順番の目印を付ける。" {
			t.Fatalf("見出しで分けた欄が違います: %+v", inc)
		}
		if inc.OccurredAt != today()+"T00:00:00" || inc.Place != "園庭" ||
			inc.GuardianNotice == nil || *inc.GuardianNotice != "1" || inc.GuardianNoticePerson == nil {
			t.Fatalf("列の欄が違います: %+v", inc)
		}
	})

	t.Run("今後の対策が無いときは見出しも付けず、countermeasure は空で返す", func(t *testing.T) {
		saved := diaryOf(t, call(t, h, teacher, "POST", "/api/diaries", incidentRequest(t, 0, "", nil)).Body.Bytes())
		row := readIncidentRow(t, a, saved.DiaryID)
		if strings.Contains(row.body, "【今後の対策】") {
			t.Fatalf("今後の対策の見出しが付いています: %q", row.body)
		}
		if saved.Incident == nil || saved.Incident.Countermeasure != "" {
			t.Fatalf("countermeasure = %+v", saved.Incident)
		}
		// 保護者へ伝えたことは未記入（空）。日時・手段・相手も持たない
		if row.notice != nil || row.noticedAt != nil || row.noticeMethod != nil || row.noticePerson != nil {
			t.Fatalf("保護者へ伝えたことの列が空ではありません: %+v", row)
		}
	})

	t.Run("ヒヤリハットでない日誌は incident を返さない", func(t *testing.T) {
		got := diaryOf(t, call(t, h, teacher, "GET", "/api/diaries/1", "").Body.Bytes())
		if got.Incident != nil {
			t.Fatalf("個人日誌に incident が返っています: %+v", got.Incident)
		}
	})
}

func TestIncidentFieldsAreValidated(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	count := func() int {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_diary`).Scan(&n)
		return n
	}
	before := count()

	cases := []struct {
		name   string
		fields map[string]string
		want   string
	}{
		{"発生日時が空", map[string]string{"occurred_at": ""}, "発生日時を入力してください"},
		{"発生日時の形が崩れている", map[string]string{"occurred_at": "2026-02-30T10:00:00"}, "発生日時の形式が正しくありません"},
		{"発生日時が未来", map[string]string{"occurred_at": "2999-01-01T09:00:00"}, "発生日時に未来の日時は指定できません。"},
		{"場所が空白だけ", map[string]string{"place": "　 "}, "場所を入力してください。"},
		{"場所が101文字", map[string]string{"place": strings.Repeat("あ", 101)}, "場所は100文字以内で入力してください。"},
		{"状況が空", map[string]string{"situation": ""}, "状況を入力してください。"},
		{"とった対応が空", map[string]string{"response": " "}, "とった対応を入力してください"},
		{"状況が1,001文字", map[string]string{"situation": strings.Repeat("あ", 1001)}, "状況・とった対応は1,000文字以内で入力してください。"},
		{"とった対応が1,001文字", map[string]string{"response": strings.Repeat("あ", 1001)}, "状況・とった対応は1,000文字以内で入力してください。"},
		{"今後の対策が1,001文字", map[string]string{"countermeasure": strings.Repeat("あ", 1001)}, "今後の対策は1,000文字以内で入力してください。"},
		{"状況に【今後の対策】だけの行", map[string]string{"situation": "転びかけた。\n【今後の対策】\n目印を付ける"}, "「【状況】」「【とった対応】」「【今後の対策】」だけの行は書けません。"},
		{"とった対応に前後に空白のある【状況】の行", map[string]string{"response": "支えた。\n 【状況】 "}, "「【状況】」「【とった対応】」「【今後の対策】」だけの行は書けません。"},
		{"今後の対策に【とった対応】だけの行", map[string]string{"countermeasure": "【とった対応】\n見直す"}, "「【状況】」「【とった対応】」「【今後の対策】」だけの行は書けません。"},
		{"伝えたのに手段が無い", map[string]string{"guardian_notice": "1", "guardian_noticed_at": today() + "T00:00:00", "guardian_notice_person": "母"}, "保護者へ伝えた日時・手段・相手を入れてください。"},
		{"伝えたのに日時が未来", map[string]string{"guardian_notice": "1", "guardian_noticed_at": "2999-01-01T09:00:00", "guardian_notice_method": "1", "guardian_notice_person": "母"}, "保護者へ伝えた日時・手段・相手を入れてください。"},
		{"伝えた相手が51文字", map[string]string{"guardian_notice": "1", "guardian_noticed_at": today() + "T00:00:00", "guardian_notice_method": "1", "guardian_notice_person": strings.Repeat("あ", 51)}, "保護者へ伝えた日時・手段・相手を入れてください。"},
		{"伝えた手段が 4", map[string]string{"guardian_notice": "1", "guardian_noticed_at": today() + "T00:00:00", "guardian_notice_method": "4", "guardian_notice_person": "母"}, "保護者へ伝えた日時・手段・相手を入れてください。"},
		{"伝えたかの値が 3", map[string]string{"guardian_notice": "3"}, "保護者へ伝えたかの指定が正しくありません"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := expectStatus(t, request(t, h, teacher, "POST", "/api/diaries", incidentRequest(t, 0, "", tc.fields)), http.StatusBadRequest)
			if !strings.Contains(body, tc.want) {
				t.Fatalf("文言が違います: %s（want %s）", body, tc.want)
			}
		})
	}
	if n := count(); n != before {
		t.Fatalf("断ったはずの日誌が %d 件できています", n-before)
	}

	t.Run("欄を送らないヒヤリハットは、本文があっても断る", func(t *testing.T) {
		body := expectStatus(t, request(t, h, teacher, "POST", "/api/diaries",
			`{"record_type":"4","child_id":"C001","class_id":1,"diary_date":"`+today()+`","body":"【状況】本文だけ","status":"1"}`),
			http.StatusBadRequest)
		if !strings.Contains(body, "発生日時を入力してください") {
			t.Fatalf("文言が違います: %s", body)
		}
	})

	t.Run("上限ちょうど（場所100文字・状況・とった対応・今後の対策 1,000文字・相手50文字）は通る", func(t *testing.T) {
		call(t, h, teacher, "POST", "/api/diaries", incidentRequest(t, 0, "", map[string]string{
			"place": strings.Repeat("あ", 100), "situation": strings.Repeat("い", 1000),
			"response": strings.Repeat("う", 1000), "countermeasure": strings.Repeat("え", 1000),
			"guardian_notice": "1", "guardian_noticed_at": today() + "T00:00:00",
			"guardian_notice_method": "9", "guardian_notice_person": strings.Repeat("お", 50),
		}))
	})
}

// デモのヒヤリハット（diary_id 3。差し戻し）を開いて直す。今後の対策・保護者へ伝えたことを書き換えられる
func TestIncidentDemoDiaryCanBeEdited(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	// デモでは、差し戻しの日誌 3 の編集ロックを村田が持っている（seed.sql）。テストの DB で外してから鈴木が取る
	a.db.Exec(`DELETE FROM t_diary_lock WHERE diary_id = 3`)

	got := diaryOf(t, call(t, h, teacher, "GET", "/api/diaries/3", "").Body.Bytes())
	if got.Incident == nil || got.Incident.Situation != "午睡中にうつ伏せの体位を確認した。" ||
		!strings.HasPrefix(got.Incident.Countermeasure, "午睡の確認のたびに") || got.Incident.Place != "保育室（さくら組）" {
		t.Fatalf("デモのヒヤリハットの欄が違います: %+v", got.Incident)
	}

	token := acquireToken(t, h, teacher, "3")
	req := incidentRequest(t, 3, token, map[string]string{
		"occurred_at": got.Incident.OccurredAt, "place": "保育室（さくら組）",
		"situation": got.Incident.Situation, "response": "仰向けに直し、呼吸と顔色を確認した。呼吸あり、顔色は通常。",
		"countermeasure": "午睡の確認の表に、体位の欄を足す。", "guardian_notice": "2",
	})
	req = strings.Replace(req, `"child_id":"C001"`, `"child_id":"C003"`, 1)
	req = strings.Replace(req, `"diary_date":"`+today()+`"`, `"diary_date":"`+got.DiaryDate+`"`, 1)
	call(t, h, teacher, "POST", "/api/diaries", req)
	row := readIncidentRow(t, a, 3)
	if !strings.HasSuffix(row.body, "【今後の対策】\n午睡の確認の表に、体位の欄を足す。") {
		t.Fatalf("今後の対策が本文に入っていません: %q", row.body)
	}
	// 「伝えていない」に変えたら、伝えた日時・手段・相手を残さない
	if row.notice == nil || *row.notice != "2" || row.noticedAt != nil || row.noticeMethod != nil || row.noticePerson != nil {
		t.Fatalf("保護者へ伝えたことの列が違います: %+v", row)
	}
}

// 異常時の記録から起票したヒヤリハットは、発生日時（発見時刻）・状況・とった対応を引き継ぎ、場所は空で始まる
func TestRaisedIncidentUsesFields(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")

	var foundAt, situation, response string
	a.db.QueryRow(`SELECT found_at, situation, response FROM t_nap_abnormal WHERE nap_abnormal_id = 2`).
		Scan(&foundAt, &situation, &response)
	d := diaryOf(t, call(t, h, teacher, "POST", "/api/nap/abnormals/2/incident", "").Body.Bytes())

	row := readIncidentRow(t, a, d.DiaryID)
	if want := "【状況】\n" + situation + "\n\n【とった対応】\n" + response; row.body != want {
		t.Fatalf("本文 = %q, want %q", row.body, want)
	}
	if row.occurredAt != foundAt || row.place != "" {
		t.Fatalf("発生日時・場所 = %q・%q（発見時刻 %q・空のはず）", row.occurredAt, row.place, foundAt)
	}
	if d.Incident == nil || d.Incident.Situation != situation || d.Incident.Response != response || d.Incident.Countermeasure != "" {
		t.Fatalf("起票した日誌の欄が違います: %+v", d.Incident)
	}

	// 場所を入れないまま保存しようとすると断られる（作成者が画面で入れる）
	token := acquireToken(t, h, teacher, itoa(d.DiaryID))
	req := incidentRequest(t, d.DiaryID, token, map[string]string{
		"occurred_at": foundAt, "place": "", "situation": situation, "response": response,
	})
	req = strings.Replace(req, `"child_id":"C001"`, `"child_id":"C005"`, 1)
	body := expectStatus(t, request(t, h, teacher, "POST", "/api/diaries", req), http.StatusBadRequest)
	if !strings.Contains(body, "場所を入力してください。") {
		t.Fatalf("文言が違います: %s", body)
	}
}

func TestSplitIncidentBody(t *testing.T) {
	for _, tc := range []struct {
		name, body                 string
		situation, response, after string
	}{
		{"3つの見出し", "【状況】\nA\n\n【とった対応】\nB\n\n【今後の対策】\nC", "A", "B", "C"},
		{"今後の対策なし", "【状況】\nA\nA2\n\n【とった対応】\nB", "A\nA2", "B", ""},
		// 【仮置き】見出しより前の文（第3.0版より前の記録の【発生日時】など）は状況の頭に入れ、捨てない
		{"見出しより前の文", "【発生日時】\n午睡中の13時40分ごろ\n\n【状況】\nA\n\n【とった対応】\nB", "【発生日時】\n午睡中の13時40分ごろ\n\nA", "B", ""},
		{"見出しが無い本文", "自由に書いた本文", "自由に書いた本文", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r, c := splitIncidentBody(tc.body)
			if s != tc.situation || r != tc.response || c != tc.after {
				t.Fatalf("got (%q, %q, %q), want (%q, %q, %q)", s, r, c, tc.situation, tc.response, tc.after)
			}
		})
	}
}
