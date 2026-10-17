package main

import (
	"database/sql"
	"net/http"
	"strings"
)

/*
きょうのようすの記録（詳細設計書「きょうのようす」(4-4 (1))・「きょうのようすの出来事」(3-2)、
基本設計書「食事の記録」「排せつ・体温の記録」(4-5)）。

食事・排せつ・体温は段1（記録した時点で保護者が読める。承認・確認のダイアログを挟まない）。
時刻はサーバの今で打つ。排せつ・体温だけは、その日の0時からいままでの時刻を付けられる。
体温は判定しない（範囲の外も保存する。判定の言葉を付けない。要件定義書「判断を行わないことの担保」(7-1 No.5)）。
活動のひとこと（種類 4）は段2の守り（他児の名前の注意）を通すため、園からのひとことと同じ段で受け付ける。
モックは web/src/api/mock.ts の recordEvents が同じ規則を持つ。
*/

// 排せつの選択肢の既定（基本設計書「出す項目と選択肢の設定」(4-5)）
const defaultToiletChoices = "おしっこ,うんち,おむつ交換,トイレでできた"

// ContactEventInput（詳細設計書「型」(4-1 (4))）。meal_round は本書で足したもの（決めたこと D-5）
type contactEventInput struct {
	ChildID     string   `json:"child_id"`
	EventType   string   `json:"event_type"`
	MealKind    *string  `json:"meal_kind"`
	MealAmount  *string  `json:"meal_amount"`
	MealRound   *int     `json:"meal_round"`
	ToiletLabel *string  `json:"toilet_label"`
	Temperature *float64 `json:"temperature"`
	Body        *string  `json:"body"`
	RecordedAt  *string  `json:"recorded_at"`
}

// eventValues は、検査を通った保存する値
type eventValues struct {
	MealKind, MealAmount, ToiletLabel, Body *string
	Temperature                             *float64
	RecordedAt                              string
	Round                                   int
}

// inDayUntilNow は、時刻がその日の 00:00:00 からサーバの今までにあるか（詳細設計書「検査の共通の規則」(4-1 (5))）
func inDayUntilNow(at, day string) bool {
	return isISODateTime(at) && at[:10] == day && at <= now()
}

/*
checkEventInput は、1件の入力を検査する（詳細設計書 (4-4 (1)) の表の順）。
種類ごとの必須の項目だけを見て、ほかの種類の項目は無視する。
*/
func (a *app) checkEventInput(in contactEventInput, day string) (eventValues, string) {
	v := eventValues{RecordedAt: now(), Round: 1}
	switch in.EventType {
	case "1":
		if in.MealKind == nil || mealKindText[*in.MealKind] == "" || in.MealAmount == nil || mealAmountText[*in.MealAmount] == "" {
			return v, msgBadChoice
		}
		if in.MealRound != nil {
			if *in.MealRound != 1 && *in.MealRound != 2 {
				return v, msgBadChoice
			}
			v.Round = *in.MealRound
		}
		v.MealKind, v.MealAmount = in.MealKind, in.MealAmount
	case "2":
		label := trimmedOrNil(in.ToiletLabel)
		if label == nil || !inList(a.settingList("contact.toilet_choices", defaultToiletChoices), *label) {
			return v, msgBadChoice
		}
		v.ToiletLabel = label
	case "3":
		if in.Temperature == nil || !oneDecimal(*in.Temperature) {
			return v, msgTemperatureFormat
		}
		v.Temperature = in.Temperature
	default:
		// 活動のひとこと（4）は段2の守りと一緒に受け付ける。写真（5）はこの経路では受け付けない（4-4 (2)）
		return v, msgBadChoice
	}
	// 時刻を後から付けられるのは排せつ・体温だけ。ほかの種類で送られたら無視して今にする
	if (in.EventType == "2" || in.EventType == "3") && in.RecordedAt != nil {
		if !inDayUntilNow(*in.RecordedAt, day) {
			return v, msgEventTimeRange
		}
		v.RecordedAt = *in.RecordedAt
	}
	return v, ""
}

// eventLogFields は、操作ログに残す出来事の値（種類に合う項目だけ）
func eventLogFields(eventType string, mealKind, mealAmount, toilet, body *string, temperature *float64, recordedAt string) []field {
	out := []field{{"event_type", eventType}, {"recorded_at", recordedAt}}
	switch eventType {
	case "1":
		out = append(out, field{"meal_kind", mealKind}, field{"meal_amount", mealAmount})
	case "2":
		out = append(out, field{"toilet_label", toilet})
	case "3":
		out = append(out, field{"temperature", temperature})
	case "4", "5":
		out = append(out, field{"body", body})
	}
	return out
}

// notifyContactChildItems は、1つの書き込みで変わった園児ごとに1回だけ知らせる（詳細設計書「知らせの種類と送り先」(6-2)）。
// 保護者には、変わった種類のどれかを出しているときだけ送る
func (a *app) notifyContactChildItems(byChild map[string][]string, order []string) {
	for _, childID := range order {
		items := byChild[childID]
		item := items[0]
		for _, it := range items {
			if a.guardianSeesItem(it) {
				item = it
				break
			}
		}
		a.notifyContactChild(childID, item)
	}
}

// POST /api/contact/events（詳細設計書 (4-4 (1))）。要求 { items }、応答 { events, skipped }
func (a *app) handleRecordEvents(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var in struct {
		Items []contactEventInput `json:"items"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.Items) == 0 || len(in.Items) > 50 {
		writeErr(w, http.StatusBadRequest, msgBadRequest)
		return
	}
	day := today()
	classOf := map[string]int64{}
	for _, it := range in.Items {
		if _, seen := classOf[it.ChildID]; seen {
			continue
		}
		// ページはサーバの今日。その日に在籍するクラスが無い園児には記録できない
		classID := a.contactClassOf(it.ChildID)
		if !a.contactAccess(u, it.ChildID).Write || classID == 0 {
			writeForbidden(w, msgContactForbidden)
			return
		}
		classOf[it.ChildID] = classID
	}
	values := make([]eventValues, len(in.Items))
	for i, it := range in.Items {
		v, msg := a.checkEventInput(it, day)
		if msg != "" {
			writeErr(w, http.StatusBadRequest, msg)
			return
		}
		values[i] = v
	}

	// 全件を1つの処理で保存する。1件でも誤りがあれば何も保存しない（飛ばすのは誤りではない）
	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	defer tx.Rollback()
	at := now()
	created := []int64{}
	createdIdx := []int{}
	skipped := []string{}
	for i, it := range in.Items {
		v := values[i]
		if it.EventType == "1" {
			// 「全員ぜんぶ」で記録のある子を上書きしない：その回の数の記録が既にあれば飛ばす（決めたこと D-5）
			var n int
			if err := tx.QueryRow(`SELECT COUNT(*) FROM t_contact_event
				WHERE child_id = ? AND contact_date = ? AND event_type = '1' AND meal_kind = ? AND is_deleted = 0`,
				it.ChildID, day, *v.MealKind).Scan(&n); err != nil {
				writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
				return
			}
			if n >= v.Round {
				if !inList(skipped, it.ChildID) {
					skipped = append(skipped, it.ChildID)
				}
				continue
			}
		}
		res, err := tx.Exec(`INSERT INTO t_contact_event (child_id, class_id, contact_date, event_type, recorded_at,
			meal_kind, meal_amount, toilet_label, temperature, body, staff_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			it.ChildID, classOf[it.ChildID], day, it.EventType, v.RecordedAt,
			v.MealKind, v.MealAmount, v.ToiletLabel, v.Temperature, v.Body, u.staff(), at, at)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
			return
		}
		id, _ := res.LastInsertId()
		created = append(created, id)
		createdIdx = append(createdIdx, i)
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}

	// 操作ログは1件ごとに作成。知らせは園児ごとに1回（トランザクションの外で送る）
	byChild := map[string][]string{}
	order := []string{}
	events := []contactEventOut{}
	for k, id := range created {
		it, v := in.Items[createdIdx[k]], values[createdIdx[k]]
		a.log(u.AccountID, fnContact, opCreate, "t_contact_event", i64(id), &it.ChildID, nil,
			s(fieldsJSON(eventLogFields(it.EventType, v.MealKind, v.MealAmount, v.ToiletLabel, v.Body, v.Temperature, v.RecordedAt))))
		if _, seen := byChild[it.ChildID]; !seen {
			order = append(order, it.ChildID)
		}
		byChild[it.ChildID] = append(byChild[it.ChildID], eventItem(it.EventType))
		if e, err := a.loadContactEvent(id); err == nil {
			events = append(events, e.contactEventOut)
		}
	}
	a.notifyContactChildItems(byChild, order)
	writeJSON(w, http.StatusOK, map[string]any{"events": events, "skipped": skipped})
}

// contactEventRow は、訂正・取り消しで使う出来事の1行（職員の形と、判定に使う列）
type contactEventRow struct {
	contactEventOut
	StaffID string
	ClassID int64
	// 保存した時刻。保護者に届いた時刻であり、取り消しの確認の「いま読んでいる家庭」の起点にする
	CreatedAt string
}

func (a *app) loadContactEvent(id int64) (*contactEventRow, error) {
	var e contactEventRow
	err := a.db.QueryRow(`SELECT contact_event_id, child_id, class_id, contact_date, event_type, recorded_at, meal_kind, meal_amount,
		toilet_label, temperature, body, contact_photo_id, keep_in_growth, staff_id, corrected_at, is_deleted, updated_at, created_at
		FROM t_contact_event WHERE contact_event_id = ?`, id).
		Scan(&e.ID, &e.ChildID, &e.ClassID, &e.ContactDate, &e.EventType, &e.RecordedAt, &e.MealKind, &e.MealAmount,
			&e.ToiletLabel, &e.Temperature, &e.Body, &e.ContactPhotoID, &e.KeepInGrowth, &e.StaffID, &e.CorrectedAt, &e.IsDeleted, &e.UpdatedAt, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	e.StaffName = a.staffName(e.StaffID)
	return &e, nil
}

/*
canFixContact は、その園児のその日の記録を直せる・取り消せるか（基本設計書「取り消し・訂正」(4-2)・(4-5)、
詳細設計書「訂正・取り消しのまとめ」(3-5)）。

その日（サーバの日付でページが今日）はその園児のクラスの担任（contactAccess の Write。記録した職員に限らない）、
管理者はいつでも。フリーの職員・保護者は直せない。
詳細設計書 (3-5)・(4-7 (1)) は「その日は記録した職員と管理者」とするが、基本設計書「取り消し・訂正」(4-2) は
「記録した職員に限らない」と定め、図/画面詳細図「誰でも使える操作の条件」(0-2) の④も同じ。
詳細設計書「本書の位置づけ」(1-1) の「食い違えば基本設計書を正とする」に従った。
モックは web/src/api/mock.ts の canFixContact。
*/
func (a *app) canFixContact(u *SessionUser, childID, contactDate string) bool {
	if !u.isStaff() || !a.contactAccess(u, childID).Write {
		return false
	}
	return u.isAdmin() || contactDate == today()
}

/*
readersOf は、その園児のその日のページを、時刻 since 以降に開いた保護者の家庭の数と人数
（詳細設計書「訂正・取り消し」(4-7 (3))、基本設計書「保護者が開いた時刻（t_contact_read）」(5-4)）。
紐づけが有効か猶予中の保護者だけを数える。
since は記録を保存した時刻（created_at）を渡す。詳細設計書は recorded_at とするが、排せつ・体温は時刻を後から付けられ、
そのときは recorded_at より後に保護者へ届く。届く前に開いた家庭を「読んでいる」に数えないため（自動レビューの指摘）
*/
func (a *app) readersOf(childIDs []string, contactDate, since string) (families, guardians int) {
	for _, childID := range childIDs {
		var n int
		a.db.QueryRow(`SELECT COUNT(DISTINCT r.account_id) FROM t_contact_read r
			JOIN m_guardian g ON g.account_id = r.account_id
			JOIN t_guardian_child gc ON gc.guardian_id = g.guardian_id AND gc.child_id = r.child_id AND gc.link_status IN ('1','3')
			WHERE r.child_id = ? AND r.contact_date = ? AND r.read_at >= ?`, childID, contactDate, since).Scan(&n)
		if n > 0 {
			families++
			guardians += n
		}
	}
	return families, guardians
}

// eventTarget は、訂正・取り消しの相手の出来事を読み、直せる人かを確かめる。だめなら応答を書いて nil を返す
func (a *app) eventTarget(w http.ResponseWriter, r *http.Request, u *SessionUser) *contactEventRow {
	id, valid := pathInt64(r, "id")
	var e *contactEventRow
	var err error
	if valid {
		e, err = a.loadContactEvent(id)
	}
	// 行が無い・取り消した・読めないは、無い園児と同じ 403
	if !valid || err != nil || e.IsDeleted || !a.contactAccess(u, e.ChildID).Read {
		writeForbidden(w, msgContactForbidden)
		return nil
	}
	if !a.canFixContact(u, e.ChildID, e.ContactDate) {
		writeForbidden(w, msgFixForbidden)
		return nil
	}
	return e
}

/*
POST /api/contact/events/{id}/correct（詳細設計書「訂正・取り消し」(4-7 (1))）。
要求は直す項目と読んだときの updated_at。値の検査は記録するときと同じ。corrected_at を今にし、
変わった項目だけを操作ログの変更前後に残す。保護者には「訂正しました（時刻）」が出る。
*/
func (a *app) handleCorrectEvent(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	e := a.eventTarget(w, r, u)
	if e == nil {
		return
	}
	var in struct {
		MealAmount  *string  `json:"meal_amount"`
		ToiletLabel *string  `json:"toilet_label"`
		Temperature *float64 `json:"temperature"`
		RecordedAt  *string  `json:"recorded_at"`
		UpdatedAt   string   `json:"updated_at"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	mealAmount, toilet, temperature, recordedAt := e.MealAmount, e.ToiletLabel, e.Temperature, e.RecordedAt
	changed := false
	switch e.EventType {
	case "1":
		if in.MealAmount != nil {
			if mealAmountText[*in.MealAmount] == "" {
				writeErr(w, http.StatusBadRequest, msgBadChoice)
				return
			}
			mealAmount, changed = in.MealAmount, true
		}
	case "2":
		if in.ToiletLabel != nil {
			label := trimmedOrNil(in.ToiletLabel)
			if label == nil || !inList(a.settingList("contact.toilet_choices", defaultToiletChoices), *label) {
				writeErr(w, http.StatusBadRequest, msgBadChoice)
				return
			}
			toilet, changed = label, true
		}
	case "3":
		if in.Temperature != nil {
			if !oneDecimal(*in.Temperature) {
				writeErr(w, http.StatusBadRequest, msgTemperatureFormat)
				return
			}
			temperature, changed = in.Temperature, true
		}
	}
	// 時刻を直せるのは排せつ・体温だけ（その日の0時からいままで。前の日のページはその日の中）
	if (e.EventType == "2" || e.EventType == "3") && in.RecordedAt != nil {
		if !inDayUntilNow(*in.RecordedAt, e.ContactDate) {
			writeErr(w, http.StatusBadRequest, msgEventTimeRange)
			return
		}
		recordedAt, changed = *in.RecordedAt, true
	}
	if !changed {
		writeErr(w, http.StatusBadRequest, msgBadChoice)
		return
	}
	at := now()
	res, err := a.db.Exec(`UPDATE t_contact_event SET meal_amount = ?, toilet_label = ?, temperature = ?, recorded_at = ?,
		corrected_at = ?, updated_at = ? WHERE contact_event_id = ? AND is_deleted = 0 AND updated_at = ?`,
		mealAmount, toilet, temperature, recordedAt, at, at, e.ID, in.UpdatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, http.StatusConflict, apiError{Message: msgFixConflict, Kind: kindVersionConflict})
		return
	}
	before, after := changedFields(
		eventLogFields(e.EventType, e.MealKind, e.MealAmount, e.ToiletLabel, e.Body, e.Temperature, e.RecordedAt),
		eventLogFields(e.EventType, e.MealKind, mealAmount, toilet, e.Body, temperature, recordedAt))
	a.log(u.AccountID, fnContact, opUpdate, "t_contact_event", i64(e.ID), &e.ChildID, s(before), s(after))
	a.notifyContactChild(e.ChildID, eventItem(e.EventType))
	saved, err := a.loadContactEvent(e.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	writeJSON(w, http.StatusOK, saved.contactEventOut)
}

/*
POST /api/contact/events/{id}/cancel（詳細設計書「訂正・取り消し」(4-7 (2))）。
is_deleted を立て、保護者の全画面（連絡帳・保護者ホームの「きょう」）から消す。戻す操作は持たない（送り直す）。
写真の出来事は、同じ写真を指す出来事と写真の行をまとめて取り消す。
応答の read_family_count は取り消す時点で数える。
誤送信として記録する（misdelivery）のは、誤送信の記録の表（t_misdelivery_record）を連絡帳に広げる作り直しと一緒に足す。
*/
func (a *app) handleCancelEvent(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	e := a.eventTarget(w, r, u)
	if e == nil {
		return
	}
	// 同じ写真を指す出来事（写真のときだけ。ほかは自分だけ）
	targets := []contactEventRow{*e}
	if e.ContactPhotoID != nil {
		rows, err := a.db.Query(`SELECT contact_event_id FROM t_contact_event
			WHERE contact_photo_id = ? AND contact_event_id <> ? AND is_deleted = 0`, *e.ContactPhotoID, e.ID)
		if err == nil {
			ids := []int64{}
			for rows.Next() {
				var id int64
				if rows.Scan(&id) == nil {
					ids = append(ids, id)
				}
			}
			rows.Close()
			for _, id := range ids {
				if other, err := a.loadContactEvent(id); err == nil {
					// 写っているほかの園児の分も、その園児を直せる人でなければ取り消さない（自動レビューの指摘）
					if !a.canFixContact(u, other.ChildID, other.ContactDate) {
						writeForbidden(w, msgFixForbidden)
						return
					}
					targets = append(targets, *other)
				}
			}
		}
	}
	childIDs := []string{}
	for _, t := range targets {
		if !inList(childIDs, t.ChildID) {
			childIDs = append(childIDs, t.ChildID)
		}
	}
	families, _ := a.readersOf(childIDs, e.ContactDate, e.CreatedAt)

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	defer tx.Rollback()
	at := now()
	done := []contactEventRow{}
	for i, t := range targets {
		res, err := tx.Exec(`UPDATE t_contact_event SET is_deleted = 1, updated_at = ? WHERE contact_event_id = ? AND is_deleted = 0`, at, t.ID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
			return
		}
		// 読んだあとに、ほかの職員が先に取り消していた（同時に押した）。二重に記録・知らせしない
		n, _ := res.RowsAffected()
		if n == 0 && i == 0 {
			writeForbidden(w, msgContactForbidden)
			return
		}
		if n > 0 {
			done = append(done, t)
		}
	}
	if e.ContactPhotoID != nil {
		if _, err := tx.Exec(`UPDATE t_contact_photo SET is_deleted = 1 WHERE contact_photo_id = ?`, *e.ContactPhotoID); err != nil {
			writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	for _, t := range done {
		before := fieldsJSON(eventLogFields(t.EventType, t.MealKind, t.MealAmount, t.ToiletLabel, t.Body, t.Temperature, t.RecordedAt))
		a.log(u.AccountID, fnContact, opDelete, "t_contact_event", i64(t.ID), &t.ChildID, s(before), nil)
	}
	for _, childID := range childIDs {
		a.notifyContactChild(childID, eventItem(e.EventType))
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "read_family_count": families})
}

// GET /api/contact/events/{id}/readers（詳細設計書「訂正・取り消し」(4-7 (3))）。取り消しの確認に「いま保護者 n 家庭（m 名）が読んでいます」を出す
func (a *app) handleEventReaders(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	var e *contactEventRow
	var err error
	if valid {
		e, err = a.loadContactEvent(id)
	}
	if !valid || err != nil || e.IsDeleted || !a.contactAccess(u, e.ChildID).Read {
		writeForbidden(w, msgContactForbidden)
		return
	}
	childIDs := []string{e.ChildID}
	if e.ContactPhotoID != nil {
		var others sql.NullString
		a.db.QueryRow(`SELECT GROUP_CONCAT(DISTINCT child_id) FROM t_contact_event WHERE contact_photo_id = ? AND is_deleted = 0`,
			*e.ContactPhotoID).Scan(&others)
		if others.Valid {
			for _, c := range strings.Split(others.String, ",") {
				if !inList(childIDs, c) {
					childIDs = append(childIDs, c)
				}
			}
		}
	}
	families, guardians := a.readersOf(childIDs, e.ContactDate, e.CreatedAt)
	writeJSON(w, http.StatusOK, map[string]int{"family_count": families, "guardian_count": guardians})
}
