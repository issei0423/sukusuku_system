package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

/*
 * 午睡チェックの記録の修正：POST /api/nap/records/{id}/correct
 * 典拠：基本設計書.md「記録の修正と改ざん防止」「帳票の出力」(4-8)・「入力項目の制約値」(4-12) の修正の理由・
 *      「足した列」(5-7) の t_nap_record.corrected_at・「操作ログ（t_operation_log）」(5-9)・「権限と利用可能機能」(6-1)・
 *      「監査への対応」(6-4)、詳細設計書.md「訂正・取り消しのまとめ」(3-5)、図/画面詳細図.md「午睡記録検索画面」(5-3) の
 *      項目12、図/インタフェース一覧.md の POST /api/nap/records/{id}/correct（PR #216 のブランチの第3.4版・第2.4版・第2.5版）
 *
 * - 直せる項目は体位・呼吸・顔色・体温。チェックした時刻・保存時刻・記録した職員は変えない
 * - 直せる人：管理者はいつでも、全クラス。一般は、その園児のクラスの担任が、実施の日（session_date）がサーバの今日のときだけ。
 *   その実施でその園児に異常時の記録があるときは、その日のうちでも管理者だけ
 * - 理由は必須（1〜500文字）
 * - 行を書き換え（2026/10/19 に持ち主が決めた）、corrected_at にサーバの時刻を入れる。修正前の値を before_value に、
 *   修正後の値と理由を after_value に、操作ログ（午睡 3・変更 2）へ残す。これが修正の履歴になり、帳票の末尾に出す。
 *   書き換えと操作ログは1つのトランザクションで書く。履歴が残らないまま値だけが変わることを防ぐため
 * - 削除はしない（保存済みの記録は削除しない）
 *
 * 画面側のモック（web/src/api/mock.ts の correctNapRecord）と同じ規則にしてある。
 * 異常時の記録の修正（POST /api/nap/abnormals/{id}/correct）は api_nap_abnormal_correct.go。直せる人の判定（napCorrectDenied）と
 * 帳票の「修正の履歴」（napReportHistories）は、ここで両方の記録を扱う。
 */

// 修正の文言。【仮置き】設計の「メッセージ一覧」(4-12) に無いため置いた（web/仮置き値.md「午睡チェックの記録の修正」）。
// モック（web/src/api/mock.ts の NAP_CORRECT_MSG）と同じ
const (
	msgNapCorrectTarget     = "午睡の記録の指定が正しくありません"
	msgNapCorrectReason     = "修正の理由を入力してください"
	msgNapCorrectReasonLong = "修正の理由は500文字以内で入力してください"
	msgNapCorrectNotFound   = "午睡の記録が見つかりません"
	msgNapCorrectForbidden  = "この園児の午睡の記録を修正する権限がありません"
	msgNapCorrectPastDay    = "実施の日を過ぎた記録は、管理者が修正します"
	msgNapCorrectAbnormal   = "異常時の記録がある子の午睡チェックの記録は、管理者が修正します"
	msgNapCorrectNoChange   = "いまの記録と同じ値です。直す項目を変えてください"
	msgNapCorrectFailed     = "記録を修正できませんでした。もう一度お試しください"
)

/*
napRecordCorrectDenied は、その利用者がその午睡チェックの記録を直せないときの理由（403 の文言）を返す。直せるときは空。

判定は詳細設計書「訂正・取り消しのまとめ」(3-5) の canCorrect と同じ形：管理者なら直せる。一般なら、実施の日がサーバの
今日で、その園児について contactAccess(u, child).Write が真（その園児のクラスの担任。フリーの職員は直せない）。
午睡チェックの記録は、その実施でその園児に異常時の記録があれば一般には直させない。
午睡記録検索の行の「修正」を出すか（can_correct）にも同じ判定を使う。
*/
func (a *app) napRecordCorrectDenied(u *SessionUser, childID string, sessionID int64, sessionDate string) string {
	if msg := a.napCorrectDenied(u, childID, sessionDate); msg != "" || u.isAdmin() {
		return msg
	}
	var n int
	if err := a.db.QueryRow(`SELECT COUNT(*) FROM t_nap_abnormal WHERE nap_session_id = ? AND child_id = ?`,
		sessionID, childID).Scan(&n); err != nil || n > 0 {
		return msgNapCorrectAbnormal
	}
	return ""
}

/*
napCorrectDenied は、午睡チェックの記録と異常時の記録の修正に共通する、直せる人の判定（403 の文言。直せるときは空）。
管理者なら直せる。一般なら、その園児について contactAccess(u, child).Write が真（その園児のクラスの担任。フリーの職員は直せない）で、
実施の日がサーバの今日のときだけ（基本設計書「記録の修正と改ざん防止」(4-8)）。
異常時の記録の修正（api_nap_abnormal_correct.go の napAbnormalCorrectDenied）はこれだけを使う。
モック（web/src/api/mock.ts の napCorrectDenied）と同じ
*/
func (a *app) napCorrectDenied(u *SessionUser, childID, sessionDate string) string {
	if u.isAdmin() {
		return ""
	}
	if !u.isGeneralStaff() || !a.contactAccess(u, childID).Write {
		return msgNapCorrectForbidden
	}
	if sessionDate != today() {
		return msgNapCorrectPastDay
	}
	return ""
}

// napRecordFields は、操作ログの変更前後に入れる午睡チェックの記録の項目。区分値は表示名、体温は数値（無ければ null）。
// モック（web/src/api/mock.ts の napRecordFields）と同じ項目名・同じ順
func napRecordFields(x NapRecord) []field {
	var temp any
	if x.Temperature != nil {
		temp = *x.Temperature
	}
	return []field{
		{"体位", napBodyPositionLabel[x.BodyPosition]},
		{"呼吸", napBreathingLabel[x.Breathing]},
		{"顔色", napComplexionLabel[x.Complexion]},
		{"体温", temp},
	}
}

// napRecordByID は、午睡チェックの記録を1件返す。無ければ sql.ErrNoRows
func (a *app) napRecordByID(id int64) (*NapRecord, error) {
	var (
		x         NapRecord
		temp      sql.NullFloat64
		corrected sql.NullString
	)
	err := a.db.QueryRow(`SELECT nap_record_id, nap_session_id, child_id, checked_at, saved_at,
		body_position, breathing, complexion, temperature, staff_id, corrected_at
		FROM t_nap_record WHERE nap_record_id = ?`, id).
		Scan(&x.NapRecordID, &x.NapSessionID, &x.ChildID, &x.CheckedAt, &x.SavedAt,
			&x.BodyPosition, &x.Breathing, &x.Complexion, &temp, &x.StaffID, &corrected)
	if err != nil {
		return nil, err
	}
	x.Temperature = nullFloat(temp)
	x.CorrectedAt = nullStr(corrected)
	return &x, nil
}

func (a *app) handleCorrectNapRecord(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, msgNapCorrectTarget)
		return
	}
	var req struct {
		// 直す項目のうち、変えるものだけを送る（図/インタフェース一覧.md）。送らない項目はいまの値のまま
		BodyPosition *string `json:"body_position"`
		Breathing    *string `json:"breathing"`
		Complexion   *string `json:"complexion"`
		// 体温は「送らない（変えない）」「null（消す）」「値」を分けるため、そのまま受け取る。
		// 【仮置き】体温を消せること（web/仮置き値.md「午睡チェックの記録の修正」）
		Temperature json.RawMessage `json:"temperature"`
		Reason      string          `json:"reason"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	// 理由は前後の空白を除いて 1〜500 文字（基本設計書「入力項目の制約値」(4-12)）
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		writeErr(w, http.StatusBadRequest, msgNapCorrectReason)
		return
	}
	if tooLong(reason, 500) {
		writeErr(w, http.StatusBadRequest, msgNapCorrectReasonLong)
		return
	}
	// 値の検査は記録するとき（handleNapRecord）と同じ
	if req.BodyPosition != nil && !oneOf(*req.BodyPosition, "1", "2", "3", "4") {
		writeErr(w, http.StatusBadRequest, "体位を選んでください")
		return
	}
	if req.Breathing != nil && !oneOf(*req.Breathing, "1", "2") {
		writeErr(w, http.StatusBadRequest, "呼吸を選んでください")
		return
	}
	if req.Complexion != nil && !oneOf(*req.Complexion, "1", "2", "3", "4") {
		writeErr(w, http.StatusBadRequest, "顔色を選んでください")
		return
	}
	tempGiven := len(req.Temperature) > 0
	var newTemp *float64
	if tempGiven && string(req.Temperature) != "null" {
		var v float64
		if json.Unmarshal(req.Temperature, &v) != nil || !oneDecimal(v) {
			writeErr(w, http.StatusBadRequest, "体温は小数第1位までで入力してください")
			return
		}
		newTemp = &v
	}

	cur, err := a.napRecordByID(id)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, msgNapCorrectNotFound)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	var (
		sessionDate  string
		sessionClass int64
	)
	if err := a.db.QueryRow(`SELECT session_date, class_id FROM t_nap_session WHERE nap_session_id = ?`,
		cur.NapSessionID).Scan(&sessionDate, &sessionClass); err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	if msg := a.napRecordCorrectDenied(u, cur.ChildID, cur.NapSessionID, sessionDate); msg != "" {
		writeForbidden(w, msg)
		return
	}

	next := *cur
	if req.BodyPosition != nil {
		next.BodyPosition = *req.BodyPosition
	}
	if req.Breathing != nil {
		next.Breathing = *req.Breathing
	}
	if req.Complexion != nil {
		next.Complexion = *req.Complexion
	}
	if tempGiven {
		next.Temperature = newTemp
	}
	// 変わった項目だけを、修正前と修正後に入れる（基本設計書「操作ログ（t_operation_log）」(5-9)）。修正後には理由を添える
	before, after := napRecordFields(*cur), napRecordFields(next)
	var changedBefore, changedAfter []field
	for i := range after {
		if jsonText(before[i].value) == jsonText(after[i].value) {
			continue
		}
		changedBefore = append(changedBefore, before[i])
		changedAfter = append(changedAfter, after[i])
	}
	// 【仮置き】値が変わらない修正は断る。修正の履歴に、何も直していない行を残さないため（web/仮置き値.md）
	if len(changedAfter) == 0 {
		writeErr(w, http.StatusBadRequest, msgNapCorrectNoChange)
		return
	}
	changedAfter = append(changedAfter, field{"理由", reason})

	at := now()
	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE t_nap_record SET body_position = ?, breathing = ?, complexion = ?, temperature = ?,
		corrected_at = ? WHERE nap_record_id = ?`,
		next.BodyPosition, next.Breathing, next.Complexion, next.Temperature, at, id); err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	if _, err := tx.Exec(`INSERT INTO t_operation_log
		(account_id, operated_at, function_type, operation_type, target_table, target_id,
		 target_child_id, before_value, after_value)
		VALUES (?, ?, ?, ?, 't_nap_record', ?, ?, ?, ?)`,
		u.AccountID, at, fnNap, opUpdate, id, cur.ChildID, fieldsJSON(changedBefore), fieldsJSON(changedAfter)); err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	// 開いている午睡チェック画面・午睡記録検索画面へ知らせる。監査の層の記録で、保護者へは送らない（events.go）
	a.notifyNapChild(sessionClass, cur.ChildID)

	got, err := a.napRecordByID(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	writeJSON(w, http.StatusOK, got)
}

// ensureNapRecordCorrectedAt は、以前に作られたデータベースの t_nap_record に corrected_at を足す
// （基本設計書「足した列」(5-7)）。新規作成のときは schema.sql がすでに持っているため、何もしない
func ensureNapRecordCorrectedAt(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('t_nap_record') WHERE name = 'corrected_at'`).Scan(&n); err != nil {
		return fmt.Errorf("午睡の記録の列を確かめられません: %w", err)
	}
	if n > 0 {
		return nil
	}
	if _, err := db.Exec(`ALTER TABLE t_nap_record ADD COLUMN corrected_at TEXT`); err != nil {
		return fmt.Errorf("午睡の記録に修正の時刻の列を足せません: %w", err)
	}
	log.Printf("午睡の記録に修正の時刻の列（corrected_at）を足しました")
	return nil
}

/* ---- 帳票の「修正あり」の印と「修正の履歴」の表（基本設計書「帳票の出力」(4-8)。api_nap_report.go が使う） ---- */

// 【仮置き】一覧の「修正あり」の列に入れる印（web/仮置き値.md「午睡チェックの記録の修正」）
const napReportCorrectedMark = "修正あり"

// 修正の履歴の表の見出しと列。図/画面詳細図.md「午睡記録検索画面」(5-3) の項目10「記録・修正日時・修正者・修正前・修正後・理由。
// 1回の修正で1行」。web/src/api/napReport.ts の NAP_HISTORY_TITLE・NAP_HISTORY_HEADER と同じ
const napReportHistoryTitle = "修正の履歴"

var napReportHistoryHeader = []string{"記録", "修正日時", "修正者", "修正前", "修正後", "理由"}

// 修正前・修正後の列に出す項目の順。操作ログの項目名（午睡チェックの記録は napRecordFields、異常時の記録は
// api_nap_abnormal_correct.go の napAbnormalFields）と同じ
var napCorrectionKeys = []string{"体位", "呼吸", "顔色", "体温", "発見時刻", "状況", "とった対応"}

// napReportHistory は「修正の履歴」の1行。並べ替えの鍵（実施の日・クラス・園児のよみと ID・記録の時刻・修正日時・番号）と、出すセル
type napReportHistory struct {
	date     string
	classID  int64
	kana     string
	childID  string
	recordAt string
	at       string
	logID    int64
	cells    []string
}

/*
napReportHistories は、帳票の期間（実施の日）とクラスに入る午睡チェックの記録と異常時の記録の修正を、操作ログの修正の行
（午睡 3・変更 2・t_nap_record と t_nap_abnormal）から集める。1回の修正で1行（基本設計書「帳票の出力」(4-8)「午睡チェックの記録と
異常時の記録の両方」）。異常時の記録の 午睡 3・変更 2 の行は、修正（api_nap_abnormal_correct.go）だけが書く。

【仮置き】2つの記録の修正を1つの表に、一覧の行と同じ向きで、実施の日 → クラス → 園児 → 記録の時刻 → 修正日時 の古い順に並べる
（同じなら操作ログの番号の順）。記録の時刻は、午睡チェックの記録はチェックした時刻、異常時の記録はいまの発見時刻。
記録の列は「午睡チェックの記録（園児・チェックした時刻）」「異常時の記録（園児・発見時刻）」、修正前・修正後は
「体位=うつ伏せ、体温=36.8」「発見時刻=…、状況=…」の形（体温が無いのは「なし」）。web/src/api/mock.ts の napReport と同じ。
*/
func (a *app) napReportHistories(from, to string, classID int64, hasClass bool) ([]napReportHistory, error) {
	cond := ` AND s.session_date >= ? AND s.session_date <= ?`
	args := []any{fnNap, opUpdate, from, to}
	if hasClass {
		cond += ` AND s.class_id = ?`
		args = append(args, classID)
	}
	type raw struct {
		logID, accountID, classID   int64
		at, childID, recordAt, date string
		before, after               sql.NullString
		label                       string
	}
	raws := []raw{}
	// 記録の種類ごとに、つなぐ表・記録の時刻の列・記録の列の名前を変えて同じ形で読む
	sources := []struct{ table, join, recordAt, label string }{
		{"t_nap_record", `JOIN t_nap_record x ON x.nap_record_id = l.target_id`, "x.checked_at", "午睡チェックの記録"},
		{"t_nap_abnormal", `JOIN t_nap_abnormal x ON x.nap_abnormal_id = l.target_id`, "x.found_at", "異常時の記録"},
	}
	for _, src := range sources {
		rows, err := a.db.Query(`SELECT l.operation_log_id, l.account_id, l.operated_at, l.before_value, l.after_value,
			x.child_id, `+src.recordAt+`, s.session_date, s.class_id
			FROM t_operation_log l `+src.join+`
			JOIN t_nap_session s ON s.nap_session_id = x.nap_session_id
			WHERE l.function_type = ? AND l.operation_type = ? AND l.target_table = '`+src.table+`'`+cond, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			x := raw{label: src.label}
			if err := rows.Scan(&x.logID, &x.accountID, &x.at, &x.before, &x.after, &x.childID, &x.recordAt,
				&x.date, &x.classID); err != nil {
				rows.Close()
				return nil, err
			}
			raws = append(raws, x)
		}
		rows.Close()
	}

	// 名前とよみは、カーソルを閉じたあとに引く（SQLite の接続は1本。db.go）
	kanaOf := map[string]string{}
	out := make([]napReportHistory, 0, len(raws))
	for _, x := range raws {
		kana, ok := kanaOf[x.childID]
		if !ok {
			var k sql.NullString
			a.db.QueryRow(`SELECT child_name_kana FROM m_child WHERE child_id = ?`, x.childID).Scan(&k)
			kana = k.String
			kanaOf[x.childID] = kana
		}
		out = append(out, napReportHistory{date: x.date, classID: x.classID, kana: kana, childID: x.childID,
			recordAt: x.recordAt, at: x.at, logID: x.logID, cells: []string{
				x.label + "（" + a.childName(x.childID) + "・" + x.recordAt + "）",
				x.at, a.accountName(x.accountID), napCorrectionText(x.before), napCorrectionText(x.after),
				napCorrectionReason(x.after),
			}})
	}
	sort.SliceStable(out, func(i, j int) bool {
		x, y := out[i], out[j]
		switch {
		case x.date != y.date:
			return x.date < y.date
		case x.classID != y.classID:
			return x.classID < y.classID
		case x.kana != y.kana:
			return x.kana < y.kana
		case x.childID != y.childID:
			return x.childID < y.childID
		case x.recordAt != y.recordAt:
			return x.recordAt < y.recordAt
		case x.at != y.at:
			return x.at < y.at
		}
		return x.logID < y.logID
	})
	return out, nil
}

// napCorrectionFields は、操作ログの修正前・修正後の JSON を読む。読めなければ nil
func napCorrectionFields(v sql.NullString) map[string]any {
	if !v.Valid {
		return nil
	}
	var m map[string]any
	if json.Unmarshal([]byte(v.String), &m) != nil {
		return nil
	}
	return m
}

// napCorrectionText は、修正前・修正後の値を「体位=うつ伏せ、体温=36.8」「発見時刻=2026-10-22T13:05:00、状況=…」の形にする
// （napCorrectionKeys の順。理由は入れない）
func napCorrectionText(v sql.NullString) string {
	m := napCorrectionFields(v)
	if m == nil {
		return v.String
	}
	parts := []string{}
	for _, k := range napCorrectionKeys {
		val, ok := m[k]
		if !ok {
			continue
		}
		switch x := val.(type) {
		case nil:
			parts = append(parts, k+"=なし")
		case float64:
			parts = append(parts, k+"="+strconv.FormatFloat(x, 'f', 1, 64))
		case string:
			parts = append(parts, k+"="+x)
		default:
			parts = append(parts, k+"="+fmt.Sprint(x))
		}
	}
	return strings.Join(parts, "、")
}

// napCorrectionReason は、修正後の値に添えた理由を返す
func napCorrectionReason(v sql.NullString) string {
	if r, ok := napCorrectionFields(v)["理由"].(string); ok {
		return r
	}
	return ""
}
