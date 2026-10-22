package main

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
)

/*
 * 異常時の記録の修正：POST /api/nap/abnormals/{id}/correct
 * 典拠：基本設計書.md「記録の修正と改ざん防止」「帳票の出力」(4-8)・「入力項目の制約値」(4-12) の異常時の発見時刻（修正のとき）と
 *      修正の理由・「足した列」(5-7) の t_nap_abnormal.corrected_at・「操作ログ（t_operation_log）」(5-9)・「監査への対応」(6-4)、
 *      詳細設計書.md「訂正・取り消しのまとめ」(3-5)、図/画面詳細図.md「異常時記録画面」(5-2) の項目17、
 *      図/インタフェース一覧.md の POST /api/nap/abnormals/{id}/correct（第2.5版）
 *
 * - 直せる項目は発見時刻・状況・とった対応。保存時刻（recorded_at）・記録した職員は変えない。保護者への連絡はここでは直さない
 *   （画面詳細図「異常時記録画面」(5-2) 項目17「保護者への連絡は項目13で足す・直す」）
 * - 発見時刻は、未来と保存時刻より後を断る（発見したのは記録を残すより前である）
 * - 直せる人：管理者はいつでも、全クラス。一般は、その園児のクラスの担任が、実施の日（session_date）がサーバの今日のときだけ
 *   （午睡チェックの記録と違い、異常時の記録があることでは断らない）
 * - 理由は必須（1〜500文字）
 * - 行を書き換え（2026/10/19 に持ち主が決めた）、corrected_at にサーバの時刻を入れる。修正前の値を before_value に、
 *   修正後の値と理由を after_value に、操作ログ（午睡 3・変更 2・t_nap_abnormal）へ残す。これが修正の履歴になり、帳票の末尾に出す。
 *   書き換えと操作ログは1つのトランザクションで書く
 * - 削除はしない
 *
 * 画面側のモック（web/src/api/mock.ts の correctNapAbnormal）と同じ規則にしてある。
 */

// 異常時の記録の修正の文言。【仮置き】設計の「メッセージ一覧」(4-12) に無いため置いた（web/仮置き値.md「異常時の記録の修正」）。
// 理由・権限・値が変わらないときは、午睡チェックの記録の修正と同じ文言（api_nap_correct.go の msgNapCorrect*）を使う。
// モック（web/src/api/napCorrect.ts の NAP_ABNORMAL_CORRECT_MSG）と同じ
const (
	msgNapAbnormalCorrectTarget   = "異常時の記録の指定が正しくありません"
	msgNapAbnormalCorrectNotFound = "異常時の記録が見つかりません"
	msgNapAbnormalCorrectAfterRec = "発見時刻は、記録を保存した時刻より後にできません"
	msgNapAbnormalCorrectNotice   = "発見時刻は、保護者へ連絡した日時より後にできません"
)

// napAbnormalFields は、操作ログの変更前後に入れる異常時の記録の項目。
// モック（web/src/api/napCorrect.ts の napAbnormalFields）と同じ項目名・同じ順
func napAbnormalFields(foundAt, situation, response string) []field {
	return []field{
		{"発見時刻", foundAt},
		{"状況", situation},
		{"とった対応", response},
	}
}

// napAbnormalCorrectDenied は、その利用者がその異常時の記録を直せないときの理由（403 の文言）を返す。直せるときは空。
// 判定は午睡チェックの記録と同じ形（napCorrectDenied）で、異常時の記録があることでは断らない。
// 異常時記録画面の一覧の行に「修正」を出すか（can_correct）にも同じ判定を使う
func (a *app) napAbnormalCorrectDenied(u *SessionUser, childID, sessionDate string) string {
	return a.napCorrectDenied(u, childID, sessionDate)
}

// napAbnormalCurrent は、修正のときに読む異常時の記録のいまの値と、つないだ実施の日・クラス
type napAbnormalCurrent struct {
	childID, foundAt, recordedAt      string
	situation, response               string
	guardianNotice, guardianNoticedAt sql.NullString
	sessionDate                       string
	sessionClass                      int64
}

// napAbnormalForCorrect は、異常時の記録のいまの値を返す。無ければ sql.ErrNoRows。
// 保存時刻が空の古い記録は、発見時刻を保存時刻とみなす（db.go の ensureNapAbnormalRecordedAt と同じ埋め方）
func (a *app) napAbnormalForCorrect(id int64) (*napAbnormalCurrent, error) {
	var x napAbnormalCurrent
	err := a.db.QueryRow(`SELECT a.child_id, a.found_at, COALESCE(a.recorded_at, a.found_at),
		a.situation, a.response, a.guardian_notice, a.guardian_noticed_at, s.session_date, s.class_id
		FROM t_nap_abnormal a JOIN t_nap_session s ON s.nap_session_id = a.nap_session_id
		WHERE a.nap_abnormal_id = ?`, id).
		Scan(&x.childID, &x.foundAt, &x.recordedAt, &x.situation, &x.response,
			&x.guardianNotice, &x.guardianNoticedAt, &x.sessionDate, &x.sessionClass)
	if err != nil {
		return nil, err
	}
	return &x, nil
}

// minuteOf は、日時の文字列の分までを返す（未来・保存時刻との前後を分の単位で比べるため。foundAtProblem と同じ）
func minuteOf(v string) string {
	return v[:min(16, len(v))]
}

func (a *app) handleCorrectNapAbnormal(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	if !valid {
		writeErr(w, http.StatusBadRequest, msgNapAbnormalCorrectTarget)
		return
	}
	var req struct {
		// 直す項目のうち、変えるものだけを送る（図/インタフェース一覧.md）。送らない項目はいまの値のまま
		FoundAt   *string `json:"found_at"`
		Situation *string `json:"situation"`
		Response  *string `json:"response"`
		Reason    string  `json:"reason"`
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
	// 値の検査は記録するとき（handleRecordNapAbnormal）と同じ文言・同じ上限（各1,000文字以内、必須）
	if req.Situation != nil && strings.TrimSpace(*req.Situation) == "" {
		writeErr(w, http.StatusBadRequest, "発見時の状況を入力してください")
		return
	}
	if req.Response != nil && strings.TrimSpace(*req.Response) == "" {
		writeErr(w, http.StatusBadRequest, "とった対応を入力してください")
		return
	}
	if (req.Situation != nil && tooLong(*req.Situation, 1000)) || (req.Response != nil && tooLong(*req.Response, 1000)) {
		writeErr(w, http.StatusBadRequest, "発見時の状況と、とった対応は、それぞれ1,000文字以内で入力してください")
		return
	}
	// 発見時刻の形式と未来は、記録するときと同じく分の単位で確かめる（foundAtProblem）
	if req.FoundAt != nil {
		if msg := foundAtProblem(*req.FoundAt); msg != "" {
			writeErr(w, http.StatusBadRequest, msg)
			return
		}
	}

	cur, err := a.napAbnormalForCorrect(id)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, msgNapAbnormalCorrectNotFound)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	if msg := a.napAbnormalCorrectDenied(u, cur.childID, cur.sessionDate); msg != "" {
		writeForbidden(w, msg)
		return
	}

	foundAt, situation, response := cur.foundAt, cur.situation, cur.response
	if req.FoundAt != nil {
		foundAt = *req.FoundAt
	}
	if req.Situation != nil {
		situation = *req.Situation
	}
	if req.Response != nil {
		response = *req.Response
	}
	if foundAt != cur.foundAt {
		// 保存時刻より後は断る（基本設計書「入力項目の制約値」(4-12) の異常時の発見時刻（修正のとき））。未来と同じく分の単位で比べる
		if minuteOf(foundAt) > minuteOf(cur.recordedAt) {
			writeErr(w, http.StatusBadRequest, msgNapAbnormalCorrectAfterRec)
			return
		}
		/*
		 * 【仮置き】保護者へ連絡した（「した」）記録は、発見時刻を連絡した日時より後にできない。記録するときに
		 * 「連絡した日時に、発見時刻より前の日時は指定できません」と断る規則（api_nap.go の guardianNotice.problem）を、
		 * 直したあとも崩さないため。設計は発見時刻と連絡した日時の前後を決めていない（web/仮置き値.md「異常時の記録の修正」）
		 */
		if cur.guardianNotice.String == "1" && cur.guardianNoticedAt.Valid &&
			minuteOf(foundAt) > minuteOf(cur.guardianNoticedAt.String) {
			writeErr(w, http.StatusBadRequest, msgNapAbnormalCorrectNotice)
			return
		}
	}

	// 変わった項目だけを、修正前と修正後に入れる（基本設計書「操作ログ（t_operation_log）」(5-9)）。修正後には理由を添える
	before := napAbnormalFields(cur.foundAt, cur.situation, cur.response)
	after := napAbnormalFields(foundAt, situation, response)
	var changedBefore, changedAfter []field
	for i := range after {
		if jsonText(before[i].value) == jsonText(after[i].value) {
			continue
		}
		changedBefore = append(changedBefore, before[i])
		changedAfter = append(changedAfter, after[i])
	}
	// 【仮置き】値が変わらない修正は断る。修正の履歴に、何も直していない行を残さないため（午睡チェックの記録の修正と同じ）
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
	if _, err := tx.Exec(`UPDATE t_nap_abnormal SET found_at = ?, situation = ?, response = ?, corrected_at = ?
		WHERE nap_abnormal_id = ?`, foundAt, situation, response, at, id); err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	if _, err := tx.Exec(`INSERT INTO t_operation_log
		(account_id, operated_at, function_type, operation_type, target_table, target_id,
		 target_child_id, before_value, after_value)
		VALUES (?, ?, ?, ?, 't_nap_abnormal', ?, ?, ?, ?)`,
		u.AccountID, at, fnNap, opUpdate, id, cur.childID, fieldsJSON(changedBefore), fieldsJSON(changedAfter)); err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	// 開いている午睡チェック画面・異常時記録画面へ知らせる。園内の記録のため保護者へは送らない（events.go）
	a.notifyNapChild(cur.sessionClass, cur.childID)

	got, err := a.napAbnormalViewByID(u, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapCorrectFailed)
		return
	}
	writeJSON(w, http.StatusOK, got)
}

// ensureNapAbnormalCorrectedAt は、以前に作られたデータベースの t_nap_abnormal に corrected_at を足す
// （基本設計書「足した列」(5-7)。2026/10/19 に足した）。新規作成のときは schema.sql がすでに持っているため、何もしない
func ensureNapAbnormalCorrectedAt(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('t_nap_abnormal') WHERE name = 'corrected_at'`).Scan(&n); err != nil {
		return fmt.Errorf("異常時の記録の列を確かめられません: %w", err)
	}
	if n > 0 {
		return nil
	}
	if _, err := db.Exec(`ALTER TABLE t_nap_abnormal ADD COLUMN corrected_at TEXT`); err != nil {
		return fmt.Errorf("異常時の記録に修正の時刻の列を足せません: %w", err)
	}
	log.Printf("異常時の記録に修正の時刻の列（corrected_at）を足しました")
	return nil
}
