package main

import (
	"database/sql"
	"net/http"
	"sort"
	"strings"
)

/*
設定画面の経路（詳細設計書「設定」(4-10)・「設定画面（管理者）」(2-14 (5))・「キーが無い・無効・有効にしていないときの画面」(8-8)）。

GET は settingSpecs の表のキー（連絡帳・通知・AI・そのほか。読むだけのキーも含む）を返し、POST は editable が真のキーだけを受け付ける
（キーごとの区画・既定値・検査は settings_spec.go）。古いキーは返さない。値は m_setting に文字で持ち、読む側（settingInt など）は
呼ばれるたびに m_setting を読むため、保存すればすぐ効く。
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
	// この版では、その値を読む処理がまだ無い（settingNoEffect）。画面は行に「保存しても動きには効きません」を添える
	NoEffect bool `json:"no_effect,omitempty"`
}

type settingsView struct {
	Settings      []settingRow `json:"settings"`
	ReadAt        string       `json:"read_at"`
	AiKeyPresent  bool         `json:"ai_key_present"`
	AiKeyRejected bool         `json:"ai_key_rejected"`
	PushAvailable bool         `json:"push_available"`
}

func (a *app) settingsView() (settingsView, error) {
	v := settingsView{Settings: []settingRow{}, ReadAt: now(), AiKeyPresent: a.ai != nil, AiKeyRejected: a.aiKeyRejected.Load()}
	for _, k := range settingOrder {
		e := settingSpecs[k]
		row := settingRow{Key: k, Group: e.group, DefaultValue: e.def, Editable: e.editable, NoEffect: settingNoEffect[k]}
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
	// 値の前後の空白は、検査の前に落とす。保存する値も操作ログの値も、落としたあとの値（モックの settingsApi.saveSettings と同じ）
	keys := make([]string, 0, len(in.Changes))
	for k, v := range in.Changes {
		in.Changes[k] = strings.TrimSpace(v)
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if e, ok := settingSpecs[k]; !ok || !e.editable {
			writeJSON(w, http.StatusBadRequest, apiError{Message: msgSettingNotEditable, Field: k})
			return
		}
	}
	for _, k := range keys {
		if msg := settingSpecs[k].check(in.Changes[k]); msg != "" {
			writeJSON(w, http.StatusBadRequest, apiError{Message: msg, Field: k})
			return
		}
	}

	// 身長・体重のしきい値は、変えたあとの値で下限 < 上限（変えないほうは、いまの値）
	if k, msg := settingOrderProblem(func(key string) string {
		if v, ok := in.Changes[key]; ok {
			return v
		}
		return a.settingText(key, settingSpecs[key].def)
	}); k != "" {
		writeJSON(w, http.StatusBadRequest, apiError{Message: msg, Field: k})
		return
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
			before = settingSpecs[k].def
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
