package main

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

/*
設定のキーごとの区画・既定値・検査（詳細設計書「設定ごとの検査」(4-10 (3))、基本設計書「設定マスタ（m_setting）」(5-9) の既定値の表）。
GET /api/settings が返すのはこの表のキーだけで（古いキー nap.temperature_required_at_start などは返さない）、
POST /api/settings が受け付けるのは editable が真のキーだけ。モックは web/src/api/mock.ts の SETTING_SPECS が同じ表を持つ。

文言は「〇〇は△△で入力してください。」の形にそろえる（〇〇は説明の名前）。範囲は演習上の想定（決めたこと D-46）。
*/

type settingSpec struct {
	group, def string
	editable   bool
	check      func(v string) string // 誤りの文言。正しければ空。editable が偽のキーは使わない
}

// 区画（SettingRow.group）
const (
	groupContact = "contact"
	groupNotify  = "notify"
	groupAI      = "ai"
	groupOther   = "other"
)

// 設定の文言（画面とモックは web/src/messages.ts の MSG に同じ文言を持つ）
const (
	msgSettingShowItems        = "保護者へ出す項目に、選べない値か重なった値が入っています。画面を読み込み直してください。"
	msgSettingHomeItems        = "「家庭から」の項目は、1つ以上選んでください。"
	msgSettingQuietHoursFormat = "通知を送らない時間帯は、5分刻みの「開始-終了」（例 21:00-07:00）で入力してください。"
	msgSettingQuietHoursSame   = "開始と終了は違う時刻にしてください。"
	msgSettingHeightOrder      = "身長の下限は上限より小さくしてください。"
	msgSettingWeightOrder      = "体重の下限は上限より小さくしてください。"
)

// settingSpecs は、設定のキーと検査の表
var settingSpecs = map[string]settingSpec{
	// 連絡帳
	"contact.show_items": {groupContact, defaultShowItems, true, func(v string) string {
		if !pickFrom(v, []string{"nap", "meal", "toilet", "temperature", "comment", "photo", "class"}, 0) {
			return msgSettingShowItems
		}
		return ""
	}},
	"contact.home_items": {groupContact, defaultHomeItems, true, func(v string) string {
		if !pickFrom(v, []string{"temperature", "night_sleep", "breakfast", "mood", "pickup", "message"}, 1) {
			return msgSettingHomeItems
		}
		return ""
	}},
	"contact.toilet_choices": {groupContact, defaultToiletChoices, true, choicesCheck("排せつの選択肢")},
	"contact.mood_choices":   {groupContact, "ごきげん,ふつう,ごきげんななめ", true, choicesCheck("きげんの選択肢")},
	// 通知
	"push.quiet_hours": {groupNotify, "21:00-07:00", true, func(v string) string {
		from, to, ok := parseHourRange(v)
		if !ok || from%5 != 0 || to%5 != 0 {
			return msgSettingQuietHoursFormat
		}
		if from == to {
			return msgSettingQuietHoursSame
		}
		return ""
	}},
	// AI
	"ai.enabled": {groupAI, "0", true, func(v string) string {
		if v != "0" && v != "1" {
			return msgBadChoice
		}
		return ""
	}},
	"ai.daily_limit": {groupAI, "300", true, intCheck("1日の上限回数", 1, 10000)},
	// そのほか
	"facility.name": {groupOther, "", true, func(v string) string {
		if n := utf8.RuneCountInString(v); strings.TrimSpace(v) == "" || n > 50 {
			return "園の名称は1〜50文字で入力してください。"
		}
		return ""
	}},
	"facility.phone_number": {groupOther, "", true, func(v string) string {
		if utf8.RuneCountInString(v) > 20 || strings.Trim(v, "0123456789-") != "" {
			return "園の電話番号は、数字とハイフンの20文字以内で入力してください。"
		}
		return ""
	}},
	"nap.interval_minutes.age0": {groupOther, "5", true, intCheck("午睡のチェック間隔（0歳児）", 1, 15)},
	"nap.interval_minutes.age1": {groupOther, "10", true, intCheck("午睡のチェック間隔（1歳児）", 1, 15)},
	"nap.interval_minutes.age2": {groupOther, "15", true, intCheck("午睡のチェック間隔（2歳児以上）", 1, 15)},
	"nap.time_range": {groupOther, "13:00-15:00", true, func(v string) string {
		from, to, ok := parseHourRange(v)
		if !ok || from >= to {
			return "午睡の時間帯は、同じ日の中の「開始-終了」（開始より終了が後。例 13:00-15:00）で入力してください。"
		}
		return ""
	}},
	"auth.max_failed_login":         {groupOther, "5", true, intCheck("ログイン失敗の上限回数", 3, 10)},
	"auth.lock_minutes":             {groupOther, "30", true, intCheck("ロックの待機時間", 1, 1440)},
	"auth.remember_days":            {groupOther, "30", true, intCheck("ログイン情報を覚えておく日数", 1, 90)},
	"auth.temp_password_hours":      {groupOther, "48", true, intCheck("一時パスワードの有効時間", 1, 168)},
	"ui.auto_logout_minutes":        {groupOther, "30", true, intCheck("自動ログアウトまでの無操作の時間", 5, 120)},
	"ui.diary_lock_minutes":         {groupOther, "15", true, intCheck("日誌の編集ロックの無操作の時間", 5, 60)},
	"scope.handover_grace_days":     {groupOther, "30", true, intCheck("職員の引き継ぎ猶予期間", 1, 90)},
	"scope.guardian_grace_days":     {groupOther, "30", true, intCheck("保護者の猶予期間", 1, 90)},
	"scope.fiscal_year_update_date": {groupOther, "04-01", true, func(v string) string {
		if !isMonthDay(v) {
			return "年度更新の実行日は、実在する月日の「MM-DD」（2月29日は不可）で入力してください。"
		}
		return ""
	}},
	"physical.measure_months":       {groupOther, "4,8,12", true, intListCheck("身体測定を行う月", 1, 12)},
	"physical.height_min":           {groupOther, "40", true, decimalCheck("身長の下限", 20, 200, 1)},
	"physical.height_max":           {groupOther, "140", true, decimalCheck("身長の上限", 20, 200, 1)},
	"physical.weight_min":           {groupOther, "2", true, decimalCheck("体重の下限", 0.5, 100, 2)},
	"physical.weight_max":           {groupOther, "40", true, decimalCheck("体重の上限", 0.5, 100, 2)},
	"dev.milestone_months":          {groupOther, defaultMilestoneMonths, true, intListCheck("乳幼児健診の節目の月齢", 1, 72)},
	"dev.notice_days_before":        {groupOther, "7", true, intCheck("発達チェックの予定日が近いとする日数", 1, 60)},
	"attachment.max_size_mb":        {groupOther, "10", true, intCheck("添付ファイルの上限サイズ", 1, 20)},
	"attachment.max_count_diary":    {groupOther, "3", true, intCheck("日誌の写真の上限枚数", 1, 3)},
	"retention.record_years":        {groupOther, "5", true, intCheck("記録の保持年数", 1, 30)},
	"retention.attachment_years":    {groupOther, "3", true, intCheck("添付ファイルの保持年数", 1, 30)},
	"approval.warn_days":            {groupOther, "3", true, intCheck("承認待ちの滞留を示す日数", 1, 30)},
	"paging.diary_per_page":         {groupOther, "50", true, intCheck("日誌一覧の1ページの件数", 10, 200)},
	"paging.nap_search_per_page":    {groupOther, "50", true, intCheck("午睡記録検索の1ページの件数", 10, 200)},
	"paging.operation_log_per_page": {groupOther, "100", true, intCheck("操作ログの1ページの件数", 10, 500)},
	"paging.physical_history_count": {groupOther, "12", true, intCheck("過去の測定値の表示件数", 6, 50)},
	// 読むだけ（editable を偽にする。理由は画面に添える）
	"attachment.allowed_types": {groupOther, "image/jpeg,image/png", false, nil},
	"handout.allowed_types":    {groupOther, "application/pdf,image/jpeg,image/png", false, nil},
	"retention.contact_years":  {groupOther, "5", false, nil}, // 【要決定】決まるまでは記録の保持年数と同じ
	"growth.share_physical":    {groupOther, "1", false, nil},
	"nap.temperature_required": {groupOther, "入眠時", false, nil},
}

/*
settingNoEffect は、画面から保存できる（editable）が、この版ではその値を読む処理がまだ無いキー（「効くか」の印）。
GET /api/settings の行に no_effect を付け、設定画面の行に「この版では、保存しても動きには効きません。」を添える
（「そのほかの設定値」の説明は「変えるとすぐ、その値を使う画面と処理に効きます」と言うため、効かない行を見分けられるように）。
読む処理を作ったら、ここから外す。モックは web/src/api/settingSpecs.ts の noEffect が同じ7つを持つ。
【仮置き】照合 c2a-X の推し（web/仮置き値.md）
*/
var settingNoEffect = map[string]bool{
	"push.quiet_hours":              true, // Web Push は【要決定】で作っていない
	"scope.handover_grace_days":     true, // 職員の引き継ぎ猶予は次の版（詳細設計書 4-1）
	"scope.guardian_grace_days":     true, // 猶予の終わりの日を入れる処理（年度更新・退園）がまだ無い
	"scope.fiscal_year_update_date": true, // 年度更新の実行は作っていない（api_bulk.go）
	"physical.measure_months":       true,
	"retention.record_years":        true,
	"retention.attachment_years":    true,
}

// settingOrder は、GET が返すキーの並び（区画ごと、画面の並び）
var settingOrder = []string{
	"contact.show_items", "contact.home_items", "contact.toilet_choices", "contact.mood_choices",
	"push.quiet_hours",
	"ai.enabled", "ai.daily_limit",
	"facility.name", "facility.phone_number",
	"nap.interval_minutes.age0", "nap.interval_minutes.age1", "nap.interval_minutes.age2", "nap.time_range",
	"auth.max_failed_login", "auth.lock_minutes", "auth.remember_days", "auth.temp_password_hours",
	"ui.auto_logout_minutes", "ui.diary_lock_minutes",
	"scope.handover_grace_days", "scope.guardian_grace_days", "scope.fiscal_year_update_date",
	"physical.measure_months", "physical.height_min", "physical.height_max", "physical.weight_min", "physical.weight_max",
	"dev.milestone_months", "dev.notice_days_before",
	"attachment.max_size_mb", "attachment.max_count_diary", "retention.record_years", "retention.attachment_years",
	"approval.warn_days",
	"paging.diary_per_page", "paging.nap_search_per_page", "paging.operation_log_per_page", "paging.physical_history_count",
	"attachment.allowed_types", "handout.allowed_types", "retention.contact_years", "growth.share_physical", "nap.temperature_required",
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

func intCheck(label string, lo, hi int) func(string) string {
	return func(v string) string {
		if n, ok := strictInt(v); !ok || n < lo || n > hi {
			return fmt.Sprintf("%sは%d〜%dの整数で入力してください。", label, lo, hi)
		}
		return ""
	}
}

// intListCheck は、lo〜hi の整数のカンマ区切りを1つ以上、重ねずに
func intListCheck(label string, lo, hi int) func(string) string {
	return func(v string) string {
		seen := map[int]bool{}
		for _, p := range strings.Split(v, ",") {
			n, ok := strictInt(p)
			if !ok || n < lo || n > hi || seen[n] {
				return fmt.Sprintf("%sは、%d〜%dの整数をカンマで区切って（重ねずに）入力してください。", label, lo, hi)
			}
			seen[n] = true
		}
		return ""
	}
}

// decimalCheck は、lo〜hi の数値（小数は places 桁まで。符号・指数・先頭の0を許さない）
func decimalCheck(label string, lo, hi float64, places int) func(string) string {
	return func(v string) string {
		if n, ok := parseDecimal(v, places); !ok || n < lo || n > hi {
			return fmt.Sprintf("%sは%s〜%sの数値（小数第%d位まで）で入力してください。", label,
				strconv.FormatFloat(lo, 'f', places, 64), strconv.FormatFloat(hi, 'f', places, 64), places)
		}
		return ""
	}
}

func parseDecimal(v string, places int) (float64, bool) {
	whole, frac, hasDot := strings.Cut(v, ".")
	if _, ok := strictInt(whole); !ok || (hasDot && (frac == "" || len(frac) > places)) {
		return 0, false
	}
	for _, c := range frac {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseFloat(v, 64)
	return n, err == nil
}

// pickFrom は、v が allowed のうちのいくつか（min 個以上）を重ねずにカンマで並べたものか。空は 0 個
func pickFrom(v string, allowed []string, min int) bool {
	if v == "" {
		return min == 0
	}
	seen := map[string]bool{}
	for _, p := range strings.Split(v, ",") {
		if !inList(allowed, p) || seen[p] {
			return false
		}
		seen[p] = true
	}
	return len(seen) >= min
}

// choicesCheck は、排せつ・きげんの選択肢（1つ以上。1つ1〜20文字。カンマと改行を含めない。重ねない。全体100文字以内）
func choicesCheck(label string) func(string) string {
	return func(v string) string {
		if strings.ContainsAny(v, "\r\n") {
			return label + "に改行は入れられません。"
		}
		seen := map[string]bool{}
		for _, p := range strings.Split(v, ",") {
			if n := utf8.RuneCountInString(p); p != strings.TrimSpace(p) || n < 1 || n > 20 {
				return label + "は、1つ以上、1つ1〜20文字（前後に空白を入れない）で入力してください。"
			}
			if seen[p] {
				return label + "に同じ言葉があります。"
			}
			seen[p] = true
		}
		if utf8.RuneCountInString(v) > 100 {
			return label + "は、つないで100文字以内にしてください。"
		}
		return ""
	}
}

// parseHourRange は、「HH:mm-HH:mm」を、その日の0時からの分に直す
func parseHourRange(v string) (from, to int, ok bool) {
	a, b, found := strings.Cut(v, "-")
	if !found {
		return 0, 0, false
	}
	from, ok1 := parseHourMinute(a)
	to, ok2 := parseHourMinute(b)
	return from, to, ok1 && ok2
}

func parseHourMinute(v string) (int, bool) {
	if len(v) != 5 || v[2] != ':' {
		return 0, false
	}
	h, ok1 := twoDigits(v[:2])
	m, ok2 := twoDigits(v[3:])
	return h*60 + m, ok1 && ok2 && h < 24 && m < 60
}

func twoDigits(v string) (int, bool) {
	if len(v) != 2 || v[0] < '0' || v[0] > '9' || v[1] < '0' || v[1] > '9' {
		return 0, false
	}
	return int(v[0]-'0')*10 + int(v[1]-'0'), true
}

// isMonthDay は、「MM-DD」が実在する月日か（2月29日は不可）
func isMonthDay(v string) bool {
	if len(v) != 5 || v[2] != '-' {
		return false
	}
	m, ok1 := twoDigits(v[:2])
	d, ok2 := twoDigits(v[3:])
	days := []int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	return ok1 && ok2 && m >= 1 && m <= 12 && d >= 1 && d <= days[m-1]
}

// settingOrderProblem は、身長・体重のしきい値を、変えたあとの値で比べる（下限 < 上限）。誤りのキーと文言。無ければ空
func settingOrderProblem(after func(key string) string) (key, msg string) {
	for _, p := range [][3]string{
		{"physical.height_min", "physical.height_max", msgSettingHeightOrder},
		{"physical.weight_min", "physical.weight_max", msgSettingWeightOrder},
	} {
		lo, ok1 := parseDecimal(after(p[0]), 2)
		hi, ok2 := parseDecimal(after(p[1]), 2)
		if ok1 && ok2 && lo >= hi {
			return p[0], p[2]
		}
	}
	return "", ""
}
