package main

import (
	"database/sql"
	"net/http"
	"strings"
	"unicode/utf8"
)

/*
 * 園児情報の登録・編集・取消
 * 典拠：基本設計書.md「園児情報の登録・編集」(4-4)
 *      図/画面詳細図.md「園児情報入力画面／園児情報確認画面」(7-2)
 *
 * 登録・編集は管理者のみ。一般（保育士）は閲覧のみ。
 */

type childInput struct {
	ChildID           string   `json:"child_id"`
	ChildName         string   `json:"child_name"`
	ChildNameKana     string   `json:"child_name_kana"`
	Nickname          string   `json:"nickname"`
	BirthDate         string   `json:"birth_date"`
	Sex               string   `json:"sex"`
	NormalTemperature *float64 `json:"normal_temperature"`
	PhotoConsentLevel string   `json:"photo_consent_level"`
	ClassID           int64    `json:"class_id"`
	Allergies         []struct {
		TargetFood string `json:"target_food"`
		Symptom    string `json:"symptom"`
		Response   string `json:"response"`
	} `json:"allergies"`
	MedicalHistories []string `json:"medical_histories"`
	// "create" または "edit"
	Mode string `json:"mode"`
}

func (a *app) handleSaveChild(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var in childInput
	if !readJSON(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.ChildID) == "" {
		writeErr(w, http.StatusBadRequest, "園児IDを入力してください")
		return
	}
	if strings.TrimSpace(in.ChildName) == "" {
		writeErr(w, http.StatusBadRequest, "氏名を入力してください")
		return
	}
	// 【仮置き】よみを必須とする。一覧の並びと検索がよみに頼っているため（GitHub Issue #119）
	if strings.TrimSpace(in.ChildNameKana) == "" {
		writeErr(w, http.StatusBadRequest, "よみを入力してください")
		return
	}
	if tooLong(in.ChildName, 50) || tooLong(in.ChildNameKana, 50) {
		writeErr(w, http.StatusBadRequest, "氏名とよみは、それぞれ50文字以内で入力してください")
		return
	}
	if utf8.RuneCountInString(in.Nickname) > 20 {
		writeErr(w, http.StatusBadRequest, "呼び名は20文字以内で入力してください。")
		return
	}
	if !isKana(in.ChildNameKana) {
		writeErr(w, http.StatusBadRequest, "よみは、ひらがなで入力してください")
		return
	}
	// アレルギーは対象だけでは配膳の場で使えない。症状と対応まで揃えて登録する（GitHub Issue #119）
	for _, al := range in.Allergies {
		if strings.TrimSpace(al.TargetFood) == "" {
			continue
		}
		if strings.TrimSpace(al.Symptom) == "" || strings.TrimSpace(al.Response) == "" {
			writeErr(w, http.StatusBadRequest,
				"アレルギー「"+strings.TrimSpace(al.TargetFood)+"」の症状と対応を入力してください")
			return
		}
	}
	// 生年月日は月齢算出の唯一の根拠。未来日不可（基本設計書 5-3）
	if in.BirthDate == "" || in.BirthDate > today() {
		writeErr(w, http.StatusBadRequest, "生年月日に未来日は指定できません")
		return
	}

	var existing int
	a.db.QueryRow(`SELECT COUNT(*) FROM m_child WHERE child_id = ?`, in.ChildID).Scan(&existing)
	if in.Mode == "create" && existing > 0 {
		writeErr(w, http.StatusBadRequest, "その園児IDはすでに使われています")
		return
	}
	if in.Mode == "edit" && existing == 0 {
		writeErr(w, http.StatusNotFound, "園児が見つかりません")
		return
	}

	// 変更前の値。取引の中では a.db へ問い合わせない（db.go）ため、先に読んでおく
	var before []field
	if existing > 0 {
		before = a.childFieldsOf(in.ChildID)
	}

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}
	defer tx.Rollback()

	if existing > 0 {
		_, err = tx.Exec(`UPDATE m_child SET child_name = ?, child_name_kana = ?, birth_date = ?, sex = ?,
			normal_temperature = ?, photo_consent_level = ?, nickname = ?, updated_at = ? WHERE child_id = ?`,
			in.ChildName, in.ChildNameKana, in.BirthDate, in.Sex,
			in.NormalTemperature, in.PhotoConsentLevel, in.Nickname, now(), in.ChildID)
	} else {
		_, err = tx.Exec(`INSERT INTO m_child
			(child_id, child_name, child_name_kana, birth_date, sex, normal_temperature,
			 enrollment_status, photo_consent_level, nickname, is_deleted, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, '1', ?, ?, 0, ?, ?)`,
			in.ChildID, in.ChildName, in.ChildNameKana, in.BirthDate, in.Sex,
			in.NormalTemperature, in.PhotoConsentLevel, in.Nickname, now(), now())
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}

	// クラス在籍の付け替え。当年度ぶんだけを外し、過年度の割り当ては残す（基本設計書 5-3）
	tx.Exec(`DELETE FROM t_class_child WHERE child_id = ?
	          AND class_id IN (SELECT class_id FROM m_class WHERE fiscal_year = ?)`, in.ChildID, fiscalYear)
	if _, err := tx.Exec(`INSERT INTO t_class_child (class_id, child_id) VALUES (?, ?)`, in.ClassID, in.ChildID); err != nil {
		writeErr(w, http.StatusInternalServerError, "クラスの割り当てに失敗しました")
		return
	}
	var roomID int64
	if existing == 0 {
		roomID, err = createPersonalRoom(tx, in.ChildID)
	} else {
		_, err = tx.Exec(`UPDATE m_chat_room SET room_name = ?, class_id = ? WHERE room_type = '4' AND child_id = ?`,
			in.ChildName+"の保護者", in.ClassID, in.ChildID)
		if err == nil {
			err = syncPersonalRoomStaff(tx)
		}
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "登録できませんでした。もう一度お試しください。")
		return
	}

	// アレルギー・既往歴は入力内容で置き換える
	tx.Exec(`DELETE FROM m_allergy WHERE child_id = ?`, in.ChildID)
	for _, al := range in.Allergies {
		if strings.TrimSpace(al.TargetFood) == "" {
			continue
		}
		tx.Exec(`INSERT INTO m_allergy (child_id, target_food, symptom, response) VALUES (?, ?, ?, ?)`,
			in.ChildID, al.TargetFood, al.Symptom, al.Response)
	}
	tx.Exec(`DELETE FROM m_medical_history WHERE child_id = ?`, in.ChildID)
	for _, m := range in.MedicalHistories {
		if strings.TrimSpace(m) == "" {
			continue
		}
		tx.Exec(`INSERT INTO m_medical_history (child_id, content) VALUES (?, ?)`, in.ChildID, m)
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "登録に失敗しました")
		return
	}
	if roomID != 0 {
		a.notifyRoomMembers(roomID)
	}

	/*
	 * 操作ログには、変更のあった項目だけを {"項目名": 値} の JSON で残す（基本設計書「操作ログ（t_operation_log）」(5-8)、
	 * 「共通の処理」(4-2)「変更前後の値：訂正内容を追えるようにするため」）。氏名と生年月日だけを残すと、
	 * クラス・アレルギー・平熱を変えても前後が同じに見え、誰がいつ変えたかを追えない（GitHub Issue #166 の 5）
	 */
	after := a.childFieldsOf(in.ChildID)
	if existing > 0 {
		b, af := changedFields(before, after)
		a.log(u.AccountID, fnChild, opUpdate, "m_child", nil, s(in.ChildID), s(b), s(af))
	} else {
		a.log(u.AccountID, fnChild, opCreate, "m_child", nil, s(in.ChildID), nil, s(fieldsJSON(after)))
	}

	row := a.db.QueryRow(`SELECT `+childColumns+` FROM m_child WHERE child_id = ?`, in.ChildID)
	c, _ := scanChild(row)
	writeJSON(w, http.StatusOK, c)
}

// handleChildIDExists は、園児IDがすでに使われているかを返す。
// 入力の時点で重複を知らせるために使う（GitHub Issue #121）。取り消した園児のIDも「使われている」と数える。
func (a *app) handleChildIDExists(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"exists": a.childExists(strings.TrimSpace(r.PathValue("childID")))})
}

/*
sameNameBirthChildren は、氏名と生年月日が同じ園児を返す。同じ子を重ねて登録しようとしていないかを
知らせるために使う（GitHub Issue #144 の 2）。園児IDは使われている番号の次が自動で入るため、
同じ子の二重登録は園児IDの重複では防げない。

【仮置き】設計に定めが無い（web/仮置き値.md「同じ氏名・生年月日の園児の知らせ」）。
  - 知らせるだけで、登録は止めない。同じ氏名・生年月日の別の子もありうる
  - 氏名は空白（半角・全角）とタブを除いて比べる。打ち方の違いで見逃さないため
  - 取り消した園児（誤登録の取消。基本設計書「園児（m_child）」(5-3) の is_deleted）は比べない。
    退園・卒園した園児は比べる

画面側のモック（web/src/api/mock.ts の findSameNameBirthChildren）と同じ規則
*/
func (a *app) sameNameBirthChildren(name, birthDate string) ([]Child, error) {
	key := childNameKey(name)
	if key == "" || birthDate == "" {
		return []Child{}, nil
	}
	rows, err := a.db.Query(`SELECT `+childColumns+` FROM m_child
		WHERE is_deleted = 0 AND birth_date = ? ORDER BY child_id`, birthDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Child{}
	for rows.Next() {
		c, err := scanChild(rows)
		if err != nil {
			return nil, err
		}
		if childNameKey(c.ChildName) == key {
			out = append(out, c)
		}
	}
	return out, rows.Err()
}

// childNameKeyReplacer は、氏名を比べるときに除く文字（半角・全角の空白とタブ）
var childNameKeyReplacer = strings.NewReplacer(" ", "", "\u3000", "", "\t", "")

// childNameKey は、氏名を比べるための形にする。「大城 ひなた」を、全角の空白で書いても空白なしで書いても同じに扱う
func childNameKey(name string) string {
	return childNameKeyReplacer.Replace(name)
}

// handleSameNameBirthChildren は、氏名と生年月日が同じ園児を返す。登録の確認画面で知らせるために使う
// （GitHub Issue #144 の 2）。園児の登録は管理者の操作のため、管理者に限る
func (a *app) handleSameNameBirthChildren(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	q := r.URL.Query()
	rows, err := a.sameNameBirthChildren(q.Get("child_name"), strings.TrimSpace(q.Get("birth_date")))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "園児の一覧を取得できませんでした")
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

/*
childFieldsOf は、操作ログに残す園児の項目を、いま保存されている値で並べる。

区分値は表示名にする（操作ログ参照画面でそのまま読めるように）。クラスは当年度の在籍クラス、
アレルギーは「対象（症状／対応）」の形で並べる。画面側のモック（web/src/api/mock.ts の childFields）と同じ項目・同じ順。
*/
func (a *app) childFieldsOf(childID string) []field {
	var (
		name, kana, nickname, birth, sex, consent string
		temp                                      sql.NullFloat64
		className                                 sql.NullString
	)
	// 呼び名の列は NULL がある（空のまま足した列）。NULL のまま読むと Scan が失敗し、ほかの項目まで空になる
	a.db.QueryRow(`SELECT child_name, child_name_kana, IFNULL(nickname, ''), birth_date, sex, normal_temperature, photo_consent_level
		FROM m_child WHERE child_id = ?`, childID).Scan(&name, &kana, &nickname, &birth, &sex, &temp, &consent)
	a.db.QueryRow(`SELECT c.class_name FROM t_class_child cc
		JOIN m_class c ON c.class_id = cc.class_id AND c.fiscal_year = ?
		WHERE cc.child_id = ? LIMIT 1`, fiscalYear, childID).Scan(&className)

	allergies := []string{}
	if rows, err := a.db.Query(`SELECT target_food, IFNULL(symptom, ''), IFNULL(response, '') FROM m_allergy
		WHERE child_id = ? ORDER BY allergy_id`, childID); err == nil {
		for rows.Next() {
			var food, symptom, response string
			if rows.Scan(&food, &symptom, &response) == nil {
				allergies = append(allergies, food+"（"+symptom+"／"+response+"）")
			}
		}
		rows.Close()
	}
	histories := []string{}
	if rows, err := a.db.Query(`SELECT content FROM m_medical_history
		WHERE child_id = ? ORDER BY medical_history_id`, childID); err == nil {
		for rows.Next() {
			var content string
			if rows.Scan(&content) == nil {
				histories = append(histories, content)
			}
		}
		rows.Close()
	}

	var tempValue any
	if temp.Valid {
		tempValue = temp.Float64
	}
	class := "所属クラスなし"
	if className.Valid {
		class = className.String
	}
	return []field{
		{"氏名", name},
		{"よみ", kana},
		{"呼び名", nickname},
		{"生年月日", birth},
		{"性別", sexLabels[sex]},
		{"平熱", tempValue},
		{"写真の利用同意", photoConsentLabels[consent]},
		{"クラス", class},
		{"アレルギー", allergies},
		{"既往歴", histories},
	}
}

// 区分値の表示名（基本設計書「園児（m_child）」(5-3)。画面は web/src/api/codes.ts の SEX・PHOTO_CONSENT）
var (
	sexLabels          = map[string]string{"1": "男", "2": "女", "9": "未回答"}
	photoConsentLabels = map[string]string{"1": "園内記録のみ", "2": "自児保護者へ共有まで", "3": "他保護者にも見える場まで"}
)

// childHasRecords は、日誌・午睡チェック・発達チェック・身体測定・チャットのいずれかの記録が紐づいているかを返す
// （基本設計書「園児情報の取消（誤登録の削除）」(4-4)）。論理削除した記録も、残っていて園児に紐づくため数える。
// チャットは、その園児の個人チャットのメッセージ（取消したものを含む）を数える（【仮置き】web/仮置き値.md）
func (a *app) childHasRecords(childID string) bool {
	var n int
	a.db.QueryRow(`SELECT
		  (SELECT COUNT(*) FROM t_diary WHERE child_id = ?)
		+ (SELECT COUNT(*) FROM t_nap_record WHERE child_id = ?)
		+ (SELECT COUNT(*) FROM t_nap_abnormal WHERE child_id = ?)
		+ (SELECT COUNT(*) FROM t_development_check WHERE child_id = ?)
		+ (SELECT COUNT(*) FROM t_physical_record WHERE child_id = ?)
		+ (SELECT COUNT(*) FROM t_chat_message m JOIN m_chat_room r ON r.chat_room_id = m.chat_room_id
		    WHERE r.room_type = '4' AND r.child_id = ?)`,
		childID, childID, childID, childID, childID, childID).Scan(&n)
	return n > 0
}

// handleRemoveChild は誤登録の取消。論理削除とする（基本設計書 5-1）
func (a *app) handleRemoveChild(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	childID := r.PathValue("childID")
	var name string
	// 取り消した園児は「見つからない」として扱う。同じ取消を重ねて受けて、操作ログに 2 行残さない（GitHub Issue #166 の 4）
	if err := a.db.QueryRow(`SELECT child_name FROM m_child WHERE child_id = ? AND is_deleted = 0`, childID).
		Scan(&name); err != nil {
		writeErr(w, http.StatusNotFound, "園児が見つかりません")
		return
	}
	// 記録のある園児は取り消せない。在籍の終了（退園・卒園）は在籍状態の変更で行う
	// （基本設計書「園児情報の取消（誤登録の削除）」(4-4)、文言は「メッセージ一覧」(4-9)「取消の不可」）
	if a.childHasRecords(childID) {
		writeErr(w, http.StatusBadRequest, "記録が登録されている園児は取り消せません。在籍状態を変更してください。")
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "取消に失敗しました")
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE m_child SET is_deleted = 1, updated_at = ? WHERE child_id = ?`, now(), childID); err != nil {
		writeErr(w, http.StatusInternalServerError, "取消に失敗しました")
		return
	}
	if _, err := tx.Exec(`UPDATE m_chat_room SET is_archived = 1 WHERE room_type = '4' AND child_id = ?`, childID); err != nil {
		writeErr(w, http.StatusInternalServerError, "取消に失敗しました")
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "取消に失敗しました")
		return
	}
	a.log(u.AccountID, fnChild, opDelete, "m_child", nil, s(childID), s(name), s("取消（論理削除）"))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
