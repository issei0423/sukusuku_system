package main

import (
	"net/http"
	"strings"
	"testing"
)

/*
設定画面の AI の区画（詳細設計書「設定」(4-10)・「キーが無い・無効・有効にしていないときの画面」(8-8)、決めたこと D-15）。
全キーの読み書きは TestSettingsAllKeys（api_settings_keys_test.go）。
モックの同じ観点は web/tests/ai.test.ts にある。
*/

type settingsResp struct {
	Settings []struct {
		Key      string `json:"setting_key"`
		Value    string `json:"setting_value"`
		Group    string `json:"group"`
		Default  string `json:"default_value"`
		Editable bool   `json:"editable"`
	} `json:"settings"`
	ReadAt        string `json:"read_at"`
	AiKeyPresent  bool   `json:"ai_key_present"`
	AiKeyRejected bool   `json:"ai_key_rejected"`
	PushAvailable bool   `json:"push_available"`
}

func (r settingsResp) value(key string) string {
	for _, s := range r.Settings {
		if s.Key == key {
			return s.Value
		}
	}
	return "（無い）"
}

func TestSettingsAiSection(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, accAdmin, "staff")
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")

	expectStatus(t, request(t, h, teacher, "GET", "/api/settings", ""), http.StatusForbidden)
	expectStatus(t, request(t, h, guardian, "GET", "/api/settings", ""), http.StatusForbidden)

	var v settingsResp
	raw := call(t, h, admin, "GET", "/api/settings", "").Body.String()
	decode(t, call(t, h, admin, "GET", "/api/settings", ""), &v)
	// キーそのものは返さない。キーが無ければ ai_key_present は偽
	if v.AiKeyPresent || v.AiKeyRejected || v.PushAvailable || len(v.Settings) != len(settingOrder) || v.value("ai.enabled") != "0" || v.value("ai.daily_limit") != "300" {
		t.Fatalf("読み込み: %s", raw)
	}
	for _, s := range v.Settings {
		if strings.HasPrefix(s.Key, "ai.") && (s.Group != "ai" || !s.Editable) {
			t.Errorf("区画・変えられるか: %+v", s)
		}
	}
	a.ai = &fakeWriter{}
	a.aiKeyRejected.Store(true)
	decode(t, call(t, h, admin, "GET", "/api/settings", ""), &v)
	if !v.AiKeyPresent || !v.AiKeyRejected {
		t.Fatalf("キーがあって無効と分かった: %+v", v)
	}
	if strings.Contains(raw, "sk-") {
		t.Fatal("キーらしい文字が応答に入っている")
	}

	save := func(c *http.Cookie, changes string, readAt string) (int, string) {
		rec := request(t, h, c, "POST", "/api/settings", `{"changes":`+changes+`,"read_at":"`+readAt+`"}`)
		return rec.Code, rec.Body.String()
	}
	for _, c := range []struct {
		name, changes, msg, field string
		code                      int
	}{
		{"一般は変えられない", `{"ai.enabled":"1"}`, "この操作は管理者のみが行えます", "", 403},
		{"読むだけのキー", `{"retention.contact_years":"20"}`, msgSettingNotEditable, "retention.contact_years", 400},
		{"表に無いキー", `{"nap.temperature_required_at_start":"false"}`, msgSettingNotEditable, "nap.temperature_required_at_start", 400},
		{"有効にするかは 0 か 1", `{"ai.enabled":"yes"}`, msgBadChoice, "ai.enabled", 400},
		{"上限回数が 0", `{"ai.daily_limit":"0"}`, msgSettingAiDailyLimit, "ai.daily_limit", 400},
		{"上限回数が 10001", `{"ai.daily_limit":"10001"}`, msgSettingAiDailyLimit, "ai.daily_limit", 400},
		{"上限回数が整数でない", `{"ai.daily_limit":"5.5"}`, msgSettingAiDailyLimit, "ai.daily_limit", 400},
		{"変えるものが無い", `{}`, msgBadRequest, "", 400},
	} {
		who := admin
		if c.code == 403 {
			who = teacher
		}
		code, body := save(who, c.changes, v.ReadAt)
		if code != c.code || !strings.Contains(body, c.msg) || (c.field != "" && !strings.Contains(body, `"field":"`+c.field+`"`)) {
			t.Errorf("%s: %d %s", c.name, code, body)
		}
	}
	// 1つでも誤りがあれば何も書かない
	save(admin, `{"ai.enabled":"1","ai.daily_limit":"0"}`, v.ReadAt)
	if a.settingText("ai.enabled", "") != "0" {
		t.Fatal("誤りがあったのに書いた")
	}

	code, body := save(admin, `{"ai.enabled":"1","ai.daily_limit":"50"}`, v.ReadAt)
	if code != 200 || a.settingText("ai.enabled", "") != "1" || a.settingInt("ai.daily_limit", 0) != 50 {
		t.Fatalf("保存: %d %s", code, body)
	}
	var logs []string
	rows, _ := a.db.Query(`SELECT before_value || '→' || after_value FROM t_operation_log WHERE function_type = '9' AND operation_type = '2' AND target_table = 'm_setting' ORDER BY operation_log_id`)
	for rows.Next() {
		var l string
		rows.Scan(&l)
		logs = append(logs, l)
	}
	rows.Close()
	if strings.Join(logs, "|") != `{"ai.daily_limit":"300"}→{"ai.daily_limit":"50"}|{"ai.enabled":"0"}→{"ai.enabled":"1"}` {
		t.Errorf("操作ログ: %v", logs)
	}

	// ほかの管理者が、読んだあとに変えていたら 409
	mustExec(t, a, `UPDATE m_setting SET updated_at = ? WHERE setting_key = 'ai.enabled'`, today()+"T23:59:59")
	code, body = save(admin, `{"ai.enabled":"0"}`, today()+"T23:59:58")
	if code != http.StatusConflict || !strings.Contains(body, msgSettingConflict) || !strings.Contains(body, kindVersionConflict) {
		t.Fatalf("ほかの管理者の変更: %d %s", code, body)
	}
}
