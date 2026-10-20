package main

import (
	"database/sql"
	"net/http"
	"sort"
	"strconv"
)

/*
設定画面の経路（詳細設計書「設定」(4-10)・「設定画面（管理者）」(2-14 (5))・「キーが無い・無効・有効にしていないときの画面」(8-8)）。

本版（実装の順番の 10）は AI の区画だけを作る（決めたこと D-15。ai.enabled の既定は「使わない」で、画面が無いと AI のデモができない）。
GET は AI の区画の2つのキー（ai.enabled・ai.daily_limit）だけを返し、POST もこの2つだけを受け付ける。ほかの区画は実装の順番の 14 で足す。
どちらも管理者だけ。API キーそのものは返さない（あるか・無効と分かったかの真偽だけ）。
モックは web/src/api/mock.ts の settingsApi が同じ規則を持つ。
*/

type settingRow struct {
	Key          string `json:"setting_key"`
	Value        string `json:"setting_value"`
	Description  string `json:"description"`
	UpdatedStaff string `json:"updated_staff_id"`
	UpdatedAt    string `json:"updated_at"`
	Group        string `json:"group"`
	DefaultValue string `json:"default_value"`
	Editable     bool   `json:"editable"`
}

type settingsView struct {
	Settings      []settingRow `json:"settings"`
	ReadAt        string       `json:"read_at"`
	AiKeyPresent  bool         `json:"ai_key_present"`
	AiKeyRejected bool         `json:"ai_key_rejected"`
	PushAvailable bool         `json:"push_available"`
}

// editableSetting は、画面から変えられる設定のキーと区画・既定値・検査（4-10 (3) のうち本版で受け付けるもの）
type editableSetting struct {
	group, def string
	check      func(v string) string // 誤りの文言。正しければ空
}

var editableSettings = map[string]editableSetting{
	"ai.enabled": {"ai", "0", func(v string) string {
		if v != "0" && v != "1" {
			return msgBadChoice
		}
		return ""
	}},
	"ai.daily_limit": {"ai", "300", func(v string) string {
		if n, ok := strictInt(v); !ok || n < 1 || n > 10000 {
			return msgSettingAiDailyLimit
		}
		return ""
	}},
}

// strictInt は、符号・空白・先頭の0を許さない整数として読む（「 5」「+5」「05」を受けない）
func strictInt(v string) (int, bool) {
	if v == "" || len(v) > 9 || (len(v) > 1 && v[0] == '0') {
		return 0, false
	}
	for _, c := range v {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(v)
	return n, err == nil
}

func (a *app) settingsView() (settingsView, error) {
	keys := make([]string, 0, len(editableSettings))
	for k := range editableSettings {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	v := settingsView{Settings: []settingRow{}, ReadAt: now(), AiKeyPresent: a.ai != nil, AiKeyRejected: a.aiKeyRejected.Load()}
	for _, k := range keys {
		e := editableSettings[k]
		row := settingRow{Key: k, Group: e.group, DefaultValue: e.def, Editable: true}
		err := a.db.QueryRow(`SELECT setting_value, IFNULL(description, ''), updated_staff_id, updated_at FROM m_setting WHERE setting_key = ?`, k).
			Scan(&row.Value, &row.Description, &row.UpdatedStaff, &row.UpdatedAt)
		if err == sql.ErrNoRows {
			row.Value = e.def
		} else if err != nil {
			return v, err
		}
		v.Settings = append(v.Settings, row)
	}
	return v, nil
}

func (a *app) handleSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	v, err := a.settingsView()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "設定を読み込めませんでした。もう一度お試しください。")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

type settingsInput struct {
	Changes map[string]string `json:"changes"`
	ReadAt  string            `json:"read_at"`
}

func (a *app) handleSaveSettings(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var in settingsInput
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.Changes) == 0 || !isISODateTime(in.ReadAt) {
		writeErr(w, http.StatusBadRequest, msgBadRequest)
		return
	}
	keys := make([]string, 0, len(in.Changes))
	for k := range in.Changes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if _, ok := editableSettings[k]; !ok {
			writeJSON(w, http.StatusBadRequest, apiError{Message: msgSettingNotEditable, Field: k})
			return
		}
	}
	for _, k := range keys {
		if msg := editableSettings[k].check(in.Changes[k]); msg != "" {
			writeJSON(w, http.StatusBadRequest, apiError{Message: msg, Field: k})
			return
		}
	}

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	defer tx.Rollback()
	type change struct{ key, before, after string }
	changes := []change{}
	at := now()
	for _, k := range keys {
		var before, updatedAt string
		err := tx.QueryRow(`SELECT setting_value, updated_at FROM m_setting WHERE setting_key = ?`, k).Scan(&before, &updatedAt)
		if err != nil && err != sql.ErrNoRows {
			writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
			return
		}
		// ほかの管理者が、読んだあとに変えていた（4-10 (2)）
		if err == nil && updatedAt > in.ReadAt {
			writeJSON(w, http.StatusConflict, apiError{Message: msgSettingConflict, Kind: kindVersionConflict})
			return
		}
		if err == sql.ErrNoRows {
			before = editableSettings[k].def
			if _, err := tx.Exec(`INSERT INTO m_setting (setting_key, setting_value, description, updated_staff_id, updated_at)
				VALUES (?, ?, NULL, ?, ?)`, k, in.Changes[k], u.staff(), at); err != nil {
				writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
				return
			}
		} else if _, err := tx.Exec(`UPDATE m_setting SET setting_value = ?, updated_staff_id = ?, updated_at = ? WHERE setting_key = ?`,
			in.Changes[k], u.staff(), at, k); err != nil {
			writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
			return
		}
		changes = append(changes, change{k, before, in.Changes[k]})
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	// 操作ログ：キーごとに 9・2、変更前後は {"キー": 値}（基本設計書「操作ログ（t_operation_log）」(5-9)）
	for _, c := range changes {
		if c.before == c.after {
			continue
		}
		a.log(u.AccountID, fnSetting, opUpdate, "m_setting", nil, nil,
			s(fieldsJSON([]field{{c.key, c.before}})), s(fieldsJSON([]field{{c.key, c.after}})))
	}
	// 知らせは送らない（設定は記録ではない。2-14 (1)）
	v, err := a.settingsView()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "設定を読み込めませんでした。もう一度お試しください。")
		return
	}
	writeJSON(w, http.StatusOK, v)
}
