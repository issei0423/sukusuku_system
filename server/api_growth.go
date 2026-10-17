package main

import (
	"net/http"
	"sort"
	"strings"
)

/*
成長の記録（保護者）を読む経路（詳細設計書「成長の記録」(4-12 (1))・「成長の記録に届くもの」(3-7)、
基本設計書「成長の記録の閲覧（保護者）」(4-9)、図/画面詳細図「成長の記録画面（保護者・スマートフォン）」(6-6)）。

成長の記録は表を持たず、開いた時点の元の記録と設定を読んで組み立てる（基本設計書「発達チェック・身体測定」(5-8)）。
返すのは事実（測った値と「確認できた」項目の名前・保護者へのひとこと・連絡帳から残したもの）だけで、
「一部」「未確認」・所見・比較・記録した職員の名前・判定の言葉は返さない（段3。システムは判定・診断を行わない）。
モックは web/src/api/mock.ts の growthApi.growthRecord が同じ形を返す（9-2）。
*/

// 成長グラフの免責（基本設計書「メッセージ一覧」(4-12) の成長グラフ。画面に常に出す）
const growthDisclaimer = "本グラフは発育把握の目安であり、発育の判定・診断を行うものではありません。"

// before を省いたとき（最初のページ）の上限。どの日時よりも後ろに並ぶ値
const growthNoBefore = "9999-12-31T23:59:59"

type growthMeasurementOut struct {
	ID          int64   `json:"physical_record_id"`
	MeasuredOn  string  `json:"measured_on"`
	AgeInMonths int     `json:"age_in_months"`
	HeightCm    float64 `json:"height_cm"`
	WeightKg    float64 `json:"weight_kg"`
	IsToday     bool    `json:"is_today"`
}

// growthEntryOut は「できたこと」の1件。kind ごとに使う項目が違い、使わない項目は応答に入れない
type growthEntryOut struct {
	Kind    string `json:"kind"` // development | contact
	At      string `json:"at"`
	Date    string `json:"date"`
	IsToday bool   `json:"is_today"`
	// development：確認できた項目の名前（区分と項目の並び順）と、保護者へのひとこと
	Items   []string `json:"items,omitempty"`
	Message *string  `json:"message,omitempty"`
	// contact：ひとこと・写真に添えた文と写真
	Body           *string `json:"body,omitempty"`
	ContactPhotoID *int64  `json:"contact_photo_id,omitempty"`

	id int64 // 同じ日時のときの並びを決めるため（応答には入れない）
}

type growthRecordOut struct {
	ChildID       string                 `json:"child_id"`
	ChildName     string                 `json:"child_name"`
	Sex           string                 `json:"sex"`
	BirthDate     string                 `json:"birth_date"`
	GraceEndsOn   *string                `json:"grace_ends_on"`
	SharePhysical bool                   `json:"share_physical"`
	Measurements  []growthMeasurementOut `json:"measurements"`
	Achievements  []growthEntryOut       `json:"achievements"`
	NextBefore    *string                `json:"next_before"`
	Disclaimer    string                 `json:"disclaimer"`
}

// GET /api/children/{childID}/growth?before=（詳細設計書 (4-12 (1))）
func (a *app) handleGrowthRecord(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	// 保護者は紐づけが有効か猶予中の自児。linked_at で切らない（基本設計書「権限チェックの実装方針」(6-2) の②）。
	// 職員も同じ関数の Read で呼べる。権限の外も、園児が無いのも、同じ 403 と同じ文言
	if !a.contactAccess(u, childID).Read {
		writeForbidden(w, msgGrowthForbidden)
		return
	}
	before := r.URL.Query().Get("before")
	if before == "" {
		before = growthNoBefore
	} else if !isISODateTime(before) {
		writeErr(w, http.StatusBadRequest, "リクエストの内容を読み取れませんでした")
		return
	}
	out, err := a.growthRecord(u, childID, before)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgGrowthLoadFailed)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) growthRecord(u *SessionUser, childID, before string) (*growthRecordOut, error) {
	out := &growthRecordOut{ChildID: childID, Measurements: []growthMeasurementOut{}, Achievements: []growthEntryOut{}, Disclaimer: growthDisclaimer}
	if err := a.db.QueryRow(`SELECT child_name, sex, COALESCE(birth_date, '') FROM m_child WHERE child_id = ?`, childID).
		Scan(&out.ChildName, &out.Sex, &out.BirthDate); err != nil {
		return nil, err
	}
	if u.isGuardian() && u.GuardianID != nil {
		var grace *string
		a.db.QueryRow(`SELECT grace_ends_on FROM t_guardian_child WHERE guardian_id = ? AND child_id = ? AND link_status = '3'`,
			*u.GuardianID, childID).Scan(&grace)
		out.GraceEndsOn = grace
	}
	day := today()

	// 身長・体重：身体測定を共有するときだけ、未削除の行を全件・測った日の新しい順。before に左右されない
	out.SharePhysical = a.sharePhysical()
	if out.SharePhysical {
		rows, err := a.db.Query(`SELECT physical_record_id, measured_on, height_cm, weight_kg, updated_at FROM t_physical_record
			WHERE child_id = ? AND is_deleted = 0 ORDER BY measured_on DESC, physical_record_id DESC`, childID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var m growthMeasurementOut
			var updatedAt string
			if err := rows.Scan(&m.ID, &m.MeasuredOn, &m.HeightCm, &m.WeightKg, &updatedAt); err != nil {
				rows.Close()
				return nil, err
			}
			m.AgeInMonths = ageInMonths(out.BirthDate, m.MeasuredOn)
			// 「きょう」の印：その日に登録・上書きしたもの（詳細設計書「成長の記録に届くもの」(3-7)）
			m.IsToday = strings.HasPrefix(updatedAt, day)
			out.Measurements = append(out.Measurements, m)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	limit := a.settingInt("paging.physical_history_count", 12)
	dev, err := a.growthDevelopmentEntries(childID, before, limit+1, day)
	if err != nil {
		return nil, err
	}
	contact, err := a.growthContactEntries(childID, before, limit+1)
	if err != nil {
		return nil, err
	}
	entries := append(dev, contact...)
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].At != entries[j].At {
			return entries[i].At > entries[j].At
		}
		if entries[i].Kind != entries[j].Kind {
			return entries[i].Kind > entries[j].Kind // 【仮置き】同じ日時なら発達チェックを先に（web/仮置き値.md）
		}
		return entries[i].id > entries[j].id
	})
	// 13件目まで読んで、あれば next_before に12件目の日時を入れる
	if len(entries) > limit {
		entries = entries[:limit]
		next := entries[limit-1].At
		out.NextBefore = &next
	}
	out.Achievements = append(out.Achievements, entries...)
	return out, nil
}

// growthDeliverable は、確定した発達チェック c に届くもの（共有する「確認できた」項目か保護者へのひとこと）があるかの条件
const growthDeliverable = `(TRIM(COALESCE(c.guardian_message, '')) <> '' OR EXISTS (SELECT 1 FROM t_development_result r
		LEFT JOIN m_share_setting s ON s.development_item_id = r.development_item_id
		WHERE r.development_check_id = c.development_check_id AND r.result = '1' AND COALESCE(s.is_shareable, 1) = 1))`

/*
growthNew は、成長の記録にきょう届いたものがあるか（保護者ホームの「新しい記録があります」。詳細設計書「ダッシュボード」(4-8 (1))
の growth_new）。「きょう」の印と同じ数え方：身体測定は共有するときだけ、その日に登録・上書きしたもの。発達チェックは
その日に初めて確定し、届くものがあるもの。連絡帳から残したものは数えない（連絡帳の新着で既に分かるため。3-7）
*/
func (a *app) growthNew(childID string) bool {
	day := today()
	var n int
	if a.sharePhysical() {
		a.db.QueryRow(`SELECT COUNT(*) FROM t_physical_record WHERE child_id = ? AND is_deleted = 0 AND substr(updated_at, 1, 10) = ?`,
			childID, day).Scan(&n)
		if n > 0 {
			return true
		}
	}
	a.db.QueryRow(`SELECT COUNT(*) FROM t_development_check c WHERE c.child_id = ? AND c.status = '2'
		AND substr(c.finalized_at, 1, 10) = ? AND `+growthDeliverable, childID, day).Scan(&n)
	return n > 0
}

/*
growthDevelopmentEntries は、確定した発達チェックを1回1件にまとめて返す（決めたこと D-31）。
items は「確認できた」かつ項目がいま共有するもの（m_share_setting。行が無ければ共有する）の名前。
items が空でひとことも空の確定は、SQL の条件で落として件数に数えない。下書きは読まない。
*/
func (a *app) growthDevelopmentEntries(childID, before string, limit int, day string) ([]growthEntryOut, error) {
	rows, err := a.db.Query(`SELECT c.development_check_id, c.finalized_at, c.guardian_message FROM t_development_check c
		WHERE c.child_id = ? AND c.status = '2' AND c.finalized_at IS NOT NULL AND c.finalized_at < ?
		  AND `+growthDeliverable+`
		ORDER BY c.finalized_at DESC, c.development_check_id DESC LIMIT ?`, childID, before, limit)
	if err != nil {
		return nil, err
	}
	out := []growthEntryOut{}
	for rows.Next() {
		var e growthEntryOut
		var message *string
		if err := rows.Scan(&e.id, &e.At, &message); err != nil {
			rows.Close()
			return nil, err
		}
		e.Kind = "development"
		e.Date = e.At[:10]
		e.IsToday = e.Date == day
		if message != nil && strings.TrimSpace(*message) != "" {
			e.Message = message
		}
		out = append(out, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 接続は1本のため、行を読み終えてから項目の名前を読む
	for i := range out {
		items, err := a.db.Query(`SELECT i.item_name FROM t_development_check c
			JOIN t_development_result r ON r.development_check_id = c.development_check_id
			JOIN m_development_item i ON i.development_item_id = r.development_item_id
			JOIN m_development_category cat ON cat.development_category_id = i.development_category_id
			LEFT JOIN m_share_setting s ON s.development_item_id = r.development_item_id
			WHERE c.development_check_id = ? AND r.result = '1' AND COALESCE(s.is_shareable, 1) = 1
			ORDER BY cat.display_order, i.display_order, i.development_item_id`, out[i].id)
		if err != nil {
			return nil, err
		}
		out[i].Items = []string{}
		for items.Next() {
			var name string
			if err := items.Scan(&name); err != nil {
				items.Close()
				return nil, err
			}
			out[i].Items = append(out[i].Items, name)
		}
		items.Close()
	}
	return out, nil
}

/*
growthContactEntries は、連絡帳で「成長の記録に残す」を付けたひとこと・写真を返す。
取り消していないもので、その種類がいまの contact.show_items にあるものだけ（決めたこと D-30）。
「きょう」の印は付けない（連絡帳の新着で既に分かるため。詳細設計書「成長の記録に届くもの」(3-7)）。
*/
func (a *app) growthContactEntries(childID, before string, limit int) ([]growthEntryOut, error) {
	types := []any{}
	if a.guardianSeesItem("comment") {
		types = append(types, "4")
	}
	if a.guardianSeesItem("photo") {
		types = append(types, "5")
	}
	out := []growthEntryOut{}
	if len(types) == 0 {
		return out, nil
	}
	args := append([]any{childID, before}, types...)
	args = append(args, limit)
	rows, err := a.db.Query(`SELECT contact_event_id, recorded_at, contact_date, body, contact_photo_id FROM t_contact_event
		WHERE child_id = ? AND keep_in_growth = 1 AND is_deleted = 0 AND recorded_at < ?
		  AND event_type IN (?`+strings.Repeat(",?", len(types)-1)+`)
		ORDER BY recorded_at DESC, contact_event_id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		e := growthEntryOut{Kind: "contact"}
		if err := rows.Scan(&e.id, &e.At, &e.Date, &e.Body, &e.ContactPhotoID); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
