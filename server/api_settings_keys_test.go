package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
設定画面の全キー（詳細設計書「設定」(4-10 (1)〜(3))、基本設計書「設定マスタ（m_setting）」(5-9) の既定値）。
モックの同じ観点は web/tests/settingsKeys.test.ts にある。AI の2つのキーだけの観点は api_settings_test.go。
*/

func TestSettingsAllKeys(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")

	var v settingsResp
	decode(t, call(t, h, admin, "GET", "/api/settings", ""), &v)
	if len(v.Settings) != len(settingOrder) {
		t.Fatalf("返すキーの数: %d（表は %d）", len(v.Settings), len(settingOrder))
	}
	group := map[string]string{}
	for _, s := range v.Settings {
		group[s.Key] = s.Group
		if want := settingSpecs[s.Key]; s.Default != want.def || s.Editable != want.editable {
			t.Errorf("%s の既定値・変えられるか: %+v", s.Key, s)
		}
	}
	// 古いキーは返さない
	if _, ok := group["nap.temperature_required_at_start"]; ok {
		t.Error("古いキー nap.temperature_required_at_start を返している")
	}
	for k, g := range map[string]string{
		"contact.show_items": "contact", "contact.mood_choices": "contact", "push.quiet_hours": "notify", "ai.enabled": "ai",
		"dev.notice_days_before": "other", "approval.warn_days": "other", "facility.name": "other", "growth.share_physical": "other",
	} {
		if group[k] != g {
			t.Errorf("%s の区画: %q（want %q）", k, group[k], g)
		}
	}
	// 基本設計書「設定マスタ」の既定値（園が入力するものは空）
	for k, d := range map[string]string{"dev.notice_days_before": "7", "approval.warn_days": "3", "scope.handover_grace_days": "30", "facility.name": ""} {
		if settingSpecs[k].def != d {
			t.Errorf("%s の既定値: %q（want %q）", k, settingSpecs[k].def, d)
		}
	}
	for _, k := range []string{"attachment.allowed_types", "handout.allowed_types", "retention.contact_years", "growth.share_physical", "nap.temperature_required"} {
		if settingSpecs[k].editable {
			t.Errorf("%s は読むだけ", k)
		}
	}
	// デモデータは、表のキーをすべて持つ（既定値で返すキーが無い）
	for _, k := range settingOrder {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM m_setting WHERE setting_key = ?`, k).Scan(&n)
		if n != 1 {
			t.Errorf("m_setting に %s が無い", k)
		}
	}

	save := func(changes map[string]string) (int, string) {
		var cur settingsResp
		decode(t, call(t, h, admin, "GET", "/api/settings", ""), &cur)
		b, _ := json.Marshal(map[string]any{"changes": changes, "read_at": cur.ReadAt})
		rec := request(t, h, admin, "POST", "/api/settings", string(b))
		return rec.Code, rec.Body.String()
	}
	// キーごとの検査：入らない値と入る値
	for _, c := range []struct {
		key  string
		bad  []string
		good []string
	}{
		{"contact.show_items", []string{"nap,nap", "nap,hoge", "nap, meal"}, []string{"", "nap", "nap,meal,toilet,temperature,comment,photo,class"}},
		{"contact.home_items", []string{"", "mood,mood", "nap"}, []string{"mood", "temperature,message"}},
		{"contact.toilet_choices", []string{"", "a,,b", "a,a", strings.Repeat("あ", 21), "a\nb","あ,い,う,え,お,か,き,く,け,こ,さ,し,す,せ,そ,た,ち,つ,て,と,な,に,ぬ,ね,の,は,ひ,ふ,へ,ほ,ま,み,む,め,も,や,ゆ,よ,ら,り,る,れ,ろ,わ,を,ん,あ1,い1,う1,え1,お1,か1,き1,く1,け1,こ1"}, []string{"おしっこ", "おしっこ,うんち", strings.Repeat("あ", 20), " a "}},
		{"contact.mood_choices", []string{"", "x,x"}, []string{"ごきげん,ふつう"}},
		{"push.quiet_hours", []string{"21:00-21:00", "21:03-07:00", "25:00-07:00", "21:00", "9:00-10:00"}, []string{"21:00-07:00", "00:00-23:55", "22:30-06:15"}},
		{"ai.daily_limit", []string{"0", "10001", "05"}, []string{"1", "10000", " 5 "}},
		{"facility.name", []string{"", "  ", strings.Repeat("園", 51)}, []string{"あ", strings.Repeat("園", 50)}},
		{"facility.phone_number", []string{"03-0000-000a", "０３-0000", strings.Repeat("1", 21)}, []string{"", "03-1234-5678", strings.Repeat("1", 20)}},
		{"nap.interval_minutes.age0", []string{"0", "16", "5.5", ""}, []string{"1", "15"}},
		{"nap.interval_minutes.age1", []string{"0", "16"}, []string{"15"}},
		{"nap.interval_minutes.age2", []string{"0", "16"}, []string{"1"}},
		{"nap.time_range", []string{"15:00-13:00", "13:00-13:00", "13:00", "24:00-25:00"}, []string{"12:30-15:30", "00:00-23:59"}},
		{"auth.max_failed_login", []string{"2", "11"}, []string{"3", "10"}},
		{"auth.lock_minutes", []string{"0", "1441"}, []string{"1", "1440"}},
		{"auth.remember_days", []string{"0", "91"}, []string{"1", "90"}},
		{"auth.temp_password_hours", []string{"0", "169"}, []string{"1", "168"}},
		{"ui.auto_logout_minutes", []string{"4", "121"}, []string{"5", "120"}},
		{"ui.diary_lock_minutes", []string{"4", "61"}, []string{"5", "60"}},
		{"scope.handover_grace_days", []string{"0", "91"}, []string{"1", "90"}},
		{"scope.guardian_grace_days", []string{"0", "91"}, []string{"1", "90"}},
		{"scope.fiscal_year_update_date", []string{"02-29", "13-01", "4-1", "04-31", "00-10"}, []string{"04-01", "02-28", "12-31"}},
		{"physical.measure_months", []string{"", "0", "13", "4,4", "4,"}, []string{"4", "4,8,12", "1,2,3,4,5,6,7,8,9,10,11,12"}},
		{"physical.height_min", []string{"19.9", "200.1", "40.55", "abc", "40."}, []string{"20", "20.0", "40.5"}},
		{"physical.height_max", []string{"19.9", "200.1", "140.55"}, []string{"200", "141.5"}},
		{"physical.weight_min", []string{"0.49", "100.01", "2.555"}, []string{"0.5", "0.50", "2.25"}},
		{"physical.weight_max", []string{"0.49", "100.01"}, []string{"100", "40.25"}},
		{"dev.milestone_months", []string{"", "0", "73", "18,18"}, []string{"1", "18,36,60", "72"}},
		{"dev.notice_days_before", []string{"0", "61", "-1", "7.5"}, []string{"1", "60"}},
		{"attachment.max_size_mb", []string{"0", "21"}, []string{"1", "20"}},
		{"attachment.max_count_diary", []string{"0", "4"}, []string{"1", "3"}},
		{"retention.record_years", []string{"0", "31"}, []string{"1", "30"}},
		{"retention.attachment_years", []string{"0", "31"}, []string{"1", "30"}},
		{"approval.warn_days", []string{"0", "31"}, []string{"1", "30"}},
		{"paging.diary_per_page", []string{"9", "201"}, []string{"10", "200"}},
		{"paging.nap_search_per_page", []string{"9", "201"}, []string{"10", "200"}},
		{"paging.operation_log_per_page", []string{"9", "501"}, []string{"10", "500"}},
		{"paging.physical_history_count", []string{"5", "51"}, []string{"6", "50"}},
	} {
		before := a.settingText(c.key, "")
		for _, bad := range c.bad {
			code, body := save(map[string]string{c.key: bad})
			if code != http.StatusBadRequest || !strings.Contains(body, `"field":"`+c.key+`"`) {
				t.Errorf("%s=%q が通った／文言が違う: %d %s", c.key, bad, code, body)
			}
			if got := a.settingText(c.key, ""); got != before {
				t.Errorf("%s=%q で誤りなのに書いた: %q", c.key, bad, got)
			}
		}
		for _, good := range c.good {
			if code, body := save(map[string]string{c.key: good}); code != http.StatusOK {
				t.Errorf("%s=%q が通らない: %d %s", c.key, good, code, body)
			}
		}
	}

	// 誤りの文言は「〇〇は△△で入力してください。」の形（詳細設計書「設定ごとの検査」(4-10 (3))）
	_, body := save(map[string]string{"dev.notice_days_before": "0"})
	if !strings.Contains(body, "発達チェックの予定日が近いとする日数は1〜60の整数で入力してください。") {
		t.Errorf("dev.notice_days_before の文言: %s", body)
	}
	_, body = save(map[string]string{"push.quiet_hours": "21:00-21:00"})
	if !strings.Contains(body, msgSettingQuietHoursSame) {
		t.Errorf("通知の時間帯の文言: %s", body)
	}
}

func TestSettingsThresholdOrder(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	save := func(changes string) (int, string) {
		var cur settingsResp
		decode(t, call(t, h, admin, "GET", "/api/settings", ""), &cur)
		rec := request(t, h, admin, "POST", "/api/settings", `{"changes":`+changes+`,"read_at":"`+cur.ReadAt+`"}`)
		return rec.Code, rec.Body.String()
	}
	// 変えないほうは、いまの値（上限 140・40）と比べる
	for _, c := range []struct{ changes, msg, field string }{
		{`{"physical.height_min":"140"}`, msgSettingHeightOrder, "physical.height_min"},
		{`{"physical.height_max":"40"}`, msgSettingHeightOrder, "physical.height_min"},
		{`{"physical.weight_min":"40"}`, msgSettingWeightOrder, "physical.weight_min"},
		{`{"physical.weight_max":"1.5"}`, msgSettingWeightOrder, "physical.weight_min"},
		{`{"physical.height_min":"150","physical.height_max":"100"}`, msgSettingHeightOrder, "physical.height_min"},
	} {
		code, body := save(c.changes)
		if code != 400 || !strings.Contains(body, c.msg) || !strings.Contains(body, `"field":"`+c.field+`"`) {
			t.Errorf("%s: %d %s", c.changes, code, body)
		}
	}
	if a.settingText("physical.height_min", "") != "40" {
		t.Fatal("誤りなのに書いた")
	}
	// 両方を一度に変えれば、変えたあとの値で比べるので通る
	if code, body := save(`{"physical.height_min":"100.5","physical.height_max":"120"}`); code != 200 {
		t.Fatalf("両方を変える: %d %s", code, body)
	}
}

// 設定を保存すると、その値を読んでいる処理にすぐ効く。変えた分だけ操作ログに残る
func TestSettingsTakeEffectAndLog(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")

	var cur settingsResp
	decode(t, call(t, h, admin, "GET", "/api/settings", ""), &cur)
	post := func(c *http.Cookie, changes string) int {
		return request(t, h, c, "POST", "/api/settings", `{"changes":`+changes+`,"read_at":"`+cur.ReadAt+`"}`).Code
	}
	if post(teacher, `{"dev.notice_days_before":"14"}`) != http.StatusForbidden || post(guardian, `{"dev.notice_days_before":"14"}`) != http.StatusForbidden {
		t.Fatal("管理者のほかが変えられた")
	}
	if a.settingInt("dev.notice_days_before", 0) != 7 {
		t.Fatal("管理者のほかの要求で変わった")
	}
	changes := `{"dev.notice_days_before":"14","paging.operation_log_per_page":"10","auth.max_failed_login":"3","physical.height_min":"40.5","physical.weight_min":"2.25",` +
		`"contact.toilet_choices":"おしっこ,うんち","facility.phone_number":"03-1111-2222","approval.warn_days":"3"}`
	if code := post(admin, changes); code != 200 {
		t.Fatalf("保存: %d", code)
	}
	if a.settingInt("dev.notice_days_before", 0) != 14 || a.settingInt("paging.operation_log_per_page", 0) != 10 || a.settingInt("auth.max_failed_login", 0) != 3 {
		t.Error("整数の設定がすぐ効かない")
	}
	// 小数の設定（身長・体重のしきい値）を、整数として読めずに既定値へ戻さない
	if a.settingFloat("physical.height_min", 0) != 40.5 || a.settingFloat("physical.weight_min", 0) != 2.25 {
		t.Error("小数の設定が読めない")
	}
	if w := a.rangeWarning(40.2, 2.1); w == nil || !strings.Contains(*w, "40.5〜140") || !strings.Contains(*w, "2.25〜40") {
		t.Errorf("しきい値の注意が新しい値を使わない: %v", w)
	}
	if got := a.settingList("contact.toilet_choices", ""); strings.Join(got, "|") != "おしっこ|うんち" {
		t.Errorf("選択肢: %v", got)
	}
	// 保護者の画面が読む参照データにも、保存した値が出る
	var ref struct {
		Settings map[string]string `json:"settings"`
	}
	decode(t, call(t, h, guardian, "GET", "/api/reference", ""), &ref)
	if ref.Settings["facility.phone_number"] != "03-1111-2222" {
		t.Errorf("保護者の画面の電話の案内: %v", ref.Settings)
	}

	// 操作ログ：変えたキーごとに 9・2。値が同じ approval.warn_days は残さない
	logs := map[string]string{}
	rows, _ := a.db.Query(`SELECT before_value, after_value FROM t_operation_log WHERE function_type = '9' AND operation_type = '2' AND target_table = 'm_setting'`)
	for rows.Next() {
		var b, af string
		rows.Scan(&b, &af)
		logs[b] = af
	}
	rows.Close()
	if logs[`{"dev.notice_days_before":"7"}`] != `{"dev.notice_days_before":"14"}` || len(logs) != 7 {
		t.Errorf("操作ログ: %v", logs)
	}
}

// 値の前後の空白は、検査の前にサーバで落とす。保存する値も操作ログの値も落としたあと（画面を通らない呼び出しでも同じ）。
// 空白だけの値は、落とすと空になるので、空を断るキーでは断る
func TestSettingsTrimsWhitespace(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	var cur settingsResp
	decode(t, call(t, h, admin, "GET", "/api/settings", ""), &cur)
	post := func(changes string) (int, string) {
		rec := request(t, h, admin, "POST", "/api/settings", `{"changes":`+changes+`,"read_at":"`+cur.ReadAt+`"}`)
		return rec.Code, rec.Body.String()
	}
	// 半角・全角の空白、改行まで落とす。整数も空白つきで入る
	if code, body := post(`{"facility.name":"　 すくすく園 \n","dev.notice_days_before":" 10 "}`); code != 200 {
		t.Fatalf("保存: %d %s", code, body)
	}
	if got := a.settingText("facility.name", ""); got != "すくすく園" {
		t.Errorf("保存した値に空白が残った: %q", got)
	}
	if a.settingText("dev.notice_days_before", "") != "10" || a.settingInt("dev.notice_days_before", 0) != 10 {
		t.Errorf("整数の値に空白が残った: %q", a.settingText("dev.notice_days_before", ""))
	}
	var after string
	a.db.QueryRow(`SELECT after_value FROM t_operation_log WHERE target_table = 'm_setting' AND after_value LIKE '%facility.name%'`).Scan(&after)
	if after != `{"facility.name":"すくすく園"}` {
		t.Errorf("操作ログの値に空白が残った: %q", after)
	}
	// 空白だけは、落とすと空になる。園の名称は空を断る
	if code, body := post(`{"facility.name":"  　"}`); code != 400 || !strings.Contains(body, `"field":"facility.name"`) {
		t.Errorf("空白だけの園の名称が通った: %d %s", code, body)
	}
	if a.settingText("facility.name", "") != "すくすく園" {
		t.Error("誤りなのに書いた")
	}
}
