package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

/*
文章の下書き（AI）の経路（詳細設計書「AI」(8)：「経路」(8-2)・「使える条件」(8-3)・「呼び出し・上限・失敗のとき」(8-7)、
基本設計書「文章の下書き（AI）」(4-11)・「外部の AI へ送る情報」(6-3)）。

AI は「選ぶ → 定型文 → AI の下書き → 手で直す」の任意の層。下書きは画面の入力欄に入るだけで、送るのは職員が「送る」を押したとき
（段2の守り：宛先の表示・他児の名前の照合を通る）。勝手に送らない。まとめて送る経路は置かない。

- GET  /api/ai/status?child_id= か ?class_id= → { available }（職員だけ。理由は返さない。断った子かどうかを見せないため）
- POST /api/ai/drafts → { drafts, replaced_other_names }

モックは web/src/api/mock.ts の aiApi が同じ規則を持つ（関数の名前 aiAvailableFor もそろえる）。
保育日誌の下書き（purpose: diary。8-12）は本版では作らない（400 を返す）。
*/

// aiTarget は下書きの宛先。園児（child）かクラス（class）のどちらか一方
type aiTarget struct {
	ChildID string
	ClassID int64
}

func (t aiTarget) isClass() bool { return t.ChildID == "" }

/*
aiChildConsented は、その園児に AI を使ってよいか（8-3 の④）。
有効な紐づけ（link_status = '1'）の保護者が1人以上いて、その全員が外部の AI を書いた版（m_terms.covers_external_ai = 1）の
規約に同意していて（t_terms_agreement）、誰も ai_opt_out でない。保護者がまだ1人も登録していない子には使わない（同意を得ていないため）
*/
func (a *app) aiChildConsented(childID string) bool {
	var links, agreed, optOut int
	err := a.db.QueryRow(`SELECT COUNT(*),
		IFNULL(SUM(CASE WHEN EXISTS (SELECT 1 FROM t_terms_agreement ta JOIN m_terms t ON t.terms_id = ta.terms_id
		                             WHERE ta.account_id = g.account_id AND t.covers_external_ai = 1) THEN 1 ELSE 0 END), 0),
		IFNULL(SUM(CASE WHEN gc.ai_opt_out <> 0 THEN 1 ELSE 0 END), 0)
		FROM t_guardian_child gc JOIN m_guardian g ON g.guardian_id = gc.guardian_id
		WHERE gc.child_id = ? AND gc.link_status = '1'`, childID).Scan(&links, &agreed, &optOut)
	return err == nil && links > 0 && agreed == links && optOut == 0
}

// enrolledClassChildIDs は、そのクラスの在籍園児（在籍・取り消していない）
func (a *app) enrolledClassChildIDs(classID int64) []string {
	rows, err := a.db.Query(`SELECT cc.child_id FROM t_class_child cc JOIN m_child c ON c.child_id = cc.child_id
		WHERE cc.class_id = ? AND c.enrollment_status = '1' AND c.is_deleted = 0 ORDER BY cc.child_id`, classID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out
}

// aiKeyUsable は、サーバに AI の呼び出し口があり、キーが無効と分かっていないか（8-3 の②）
func (a *app) aiKeyUsable() bool {
	return a.ai != nil && !a.aiKeyRejected.Load()
}

/*
aiAvailableFor は、その職員がその宛先に AI の下書きを使えるか（8-3）。/api/ai/status と /api/ai/drafts の両方が呼ぶ
（基本設計書「処理の流れ」(4-11) の「サーバでもう一度確かめる」）。

① m_setting の ai.enabled が 1 ② 呼び出し口があり、キーが無効と分かっていない ③ 職員で、宛先を Write できる
④ 宛先の園児が aiChildConsented。クラスあては在籍園児の全員が満たす。
上限に達したかはここに入れない（ボタンを出したまま、押したときに 429 で知らせる。決めたこと D-9）
*/
func (a *app) aiAvailableFor(u *SessionUser, t aiTarget) bool {
	if a.settingText("ai.enabled", "0") != "1" || !a.aiKeyUsable() || !u.isStaff() {
		return false
	}
	if t.isClass() {
		if !a.classContactAccess(u, t.ClassID).Write {
			return false
		}
		for _, id := range a.enrolledClassChildIDs(t.ClassID) {
			if !a.aiChildConsented(id) {
				return false
			}
		}
		return true
	}
	return a.contactAccess(u, t.ChildID).Write && a.aiChildConsented(t.ChildID)
}

// aiExcludedChildren は、在籍園児のうち AI を使えない子（8-5 の⑤。メモにこの子の名前があれば呼ばない）
func (a *app) aiExcludedChildren(all []nameChild) []nameChild {
	out := []nameChild{}
	for _, c := range all {
		if !a.aiChildConsented(c.ID) {
			out = append(out, c)
		}
	}
	return out
}

func (a *app) handleAiStatus(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	t, ok := aiTargetOf(r.URL.Query().Get("child_id"), r.URL.Query().Get("class_id"))
	if !ok {
		writeErr(w, http.StatusBadRequest, msgBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"available": a.aiAvailableFor(u, t)})
}

// aiTargetOf は、child_id と class_id のどちらか一方だけを宛先にする
func aiTargetOf(childID, classID string) (aiTarget, bool) {
	childID = strings.TrimSpace(childID)
	classID = strings.TrimSpace(classID)
	if (childID == "") == (classID == "") {
		return aiTarget{}, false
	}
	if childID != "" {
		return aiTarget{ChildID: childID}, true
	}
	id, err := strconv.ParseInt(classID, 10, 64)
	if err != nil || id <= 0 {
		return aiTarget{}, false
	}
	return aiTarget{ClassID: id}, true
}

type aiDraftInput struct {
	Purpose string `json:"purpose"`
	ChildID string `json:"child_id"`
	ClassID *int64 `json:"class_id"`
	Date    string `json:"date"`
	Memo    string `json:"memo"`
	Text    string `json:"text"`
	// 下書きを入れる欄（facility：園から・comment：活動のひとこと・class：クラスのようす）。文字数の上限と操作ログの表を決める
	Field string `json:"field"`
}

type aiDraftResult struct {
	Drafts             []string `json:"drafts"`
	ReplacedOtherNames bool     `json:"replaced_other_names"`
}

// aiField は、下書きを入れる欄の上限（基本設計書「入力項目の制約値」(4-12)）と、操作ログの target_table。
// 【仮置き】要求の field で欄を選ぶ（詳細設計書 (8-2) は field を日誌だけに置いている。web/仮置き値.md）
type aiField struct {
	max   int
	table string
}

var aiFields = map[string]aiField{
	"facility": {500, "t_contact_facility"},
	"comment":  {200, "t_contact_event"},
	"class":    {500, "t_contact_class"},
}

// aiMemoMax は、メモの上限（詳細設計書「経路」(8-2)）
const aiMemoMax = 500

func (a *app) handleAiDrafts(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	var in aiDraftInput
	if !readJSON(w, r, &in) {
		return
	}
	classID := ""
	if in.ClassID != nil {
		classID = strconv.FormatInt(*in.ClassID, 10)
	}
	t, okTarget := aiTargetOf(in.ChildID, classID)
	purposeOK := in.Purpose == aiPurposeFacilityNote || in.Purpose == aiPurposeRephrase || in.Purpose == aiPurposeContinue
	fieldName := in.Field
	if fieldName == "" {
		fieldName = map[bool]string{true: "class", false: "facility"}[t.isClass()]
	}
	fld, okField := aiFields[fieldName]
	if okField && t.isClass() != (fieldName == "class") {
		okField = false
	}
	text := strings.TrimSpace(in.Text)
	// 画面の不具合でしか起きない誤り（用途・宛先・日付・言い換えの文が無い）。園からの下書きは園児あてだけ
	if !purposeOK || !okTarget || !okField || in.Date != today() ||
		(in.Purpose == aiPurposeFacilityNote && (t.isClass() || fieldName != "facility")) ||
		(in.Purpose != aiPurposeFacilityNote && text == "") {
		writeErr(w, http.StatusBadRequest, msgBadRequest)
		return
	}
	memo := strings.TrimSpace(in.Memo)
	if tooLong(memo, aiMemoMax) {
		writeErr(w, http.StatusBadRequest, msgAiMemoTooLong)
		return
	}
	if tooLong(text, fld.max) {
		writeErr(w, http.StatusBadRequest, aiTextTooLong(fld.max))
		return
	}
	if !a.aiAvailableFor(u, t) {
		writeForbidden(w, msgAiUnavailableForTarget)
		return
	}

	all, err := a.enrolledNameChildren()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	recipients := []nameChild{}
	if !t.isClass() {
		recipients = append(recipients, a.nameChildOf(t.ChildID))
	}
	// ⑤ その場で職員が書いた文（メモ・言い換える文）に、AI を使えない園児の名前があれば呼ばない（決めたこと D-12）。
	// 【仮置き】言い換える文（text）にも当てる（設計はメモだけを挙げる。web/仮置き値.md）
	excluded := a.aiExcludedChildren(all)
	for _, written := range []string{memo, text} {
		if names, _ := findOtherNames(written, "memo", recipients, excluded); len(names) > 0 {
			writeJSON(w, http.StatusBadRequest, apiError{Message: msgAiExcludedName, Kind: kindAiExcludedName})
			return
		}
	}
	// 1日の上限（8-7 (3)）。失敗した呼び出しは数えない。呼ぶ前に止めたもの（403・400・429）は操作ログに残さない
	if a.aiSucceededToday() >= a.settingInt("ai.daily_limit", 300) {
		writeJSON(w, http.StatusTooManyRequests, apiError{Message: msgAiLimit, Kind: kindAiLimit})
		return
	}

	// 送る文を作る（8-4・8-5・8-6）。置き換えたのはメモか職員の文か（「置き換えて送りました」を出す）
	replaced := false
	anonWritten := func(s string) string {
		out, hit := anonymize(s, recipients, all)
		replaced = replaced || hit
		return out
	}
	anonRecord := func(s string) string {
		out, _ := anonymize(s, recipients, all)
		return out
	}
	var user any
	if in.Purpose == aiPurposeFacilityNote {
		facts, err := a.facilityFacts(t.ChildID, in.Date, anonRecord)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
			return
		}
		facts.Memo = anonWritten(memo)
		user = facts
	} else {
		user = aiTextFacts{Text: anonWritten(text)}
	}
	req := draftRequest{System: aiSystemFor(in.Purpose), User: aiJSON(user), Schema: aiSchemaFor(in.Purpose)}

	start := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), a.aiTimeoutOf())
	reply, err := a.ai.Write(ctx, req)
	cancel()
	drafts, why := a.aiReadReply(ctx, in.Purpose, reply, err, fld.max, text, recipients, all)
	childPtr := (*string)(nil)
	if !t.isClass() {
		childPtr = s(t.ChildID)
	}
	if drafts == nil {
		// 送った文・返った文・メモは、どのログにも出さない。用途・状態・RequestID・かかった時間だけ（8-7 (2)）
		log.Printf("AI の下書きを作れませんでした（用途 %s・%s・%dms）", in.Purpose, why, time.Since(start).Milliseconds())
		a.log(u.AccountID, fnContact, opAiDraft, fld.table, nil, childPtr, nil,
			s(fieldsJSON([]field{{"用途", aiPurposeLabel(in.Purpose)}, {"結果", "失敗"}})))
		writeJSON(w, http.StatusServiceUnavailable, apiError{Message: msgAiFailed, Kind: kindAiUnavailable})
		return
	}
	a.log(u.AccountID, fnContact, opAiDraft, fld.table, nil, childPtr, nil,
		s(fieldsJSON([]field{{"用途", aiPurposeLabel(in.Purpose)}, {"結果", "成功"}})))
	writeJSON(w, http.StatusOK, aiDraftResult{Drafts: drafts, ReplacedOtherNames: replaced})
}

/*
aiReadReply は、呼んだ結果を下書きにする（8-7 (2) の失敗の振り分けと 8-6 (3) の検査）。
使えないときは nil と、ログに出す理由（状態コードと RequestID だけ。本文は入れない）を返す。
キーが無効（401・403）と分かったら、サーバを起動し直すまで AI を使えない扱いにする（決めたこと D-11）
*/
func (a *app) aiReadReply(ctx context.Context, purpose string, reply draftReply, err error, max int, base string,
	recipients, all []nameChild) ([]string, string) {
	if err != nil {
		var se *aiStatusError
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded):
			return nil, "時間切れ"
		case errors.As(err, &se):
			if se.keyRejected() {
				a.aiKeyRejected.Store(true)
				log.Printf("API キーが無効です。環境変数を確かめてください")
			}
			return nil, "状態 " + strconv.Itoa(se.StatusCode) + "・RequestID " + se.RequestID
		default:
			return nil, "接続の失敗"
		}
	}
	if reply.Refused {
		return nil, "拒否"
	}
	drafts, ok := parseDrafts(purpose, reply.JSON)
	if !ok {
		return nil, "形が合わない"
	}
	for i, d := range drafts {
		if len(recipients) > 0 {
			d = restoreName(d, recipients[0])
		}
		d = strings.TrimSpace(d)
		limit := max
		if purpose == aiPurposeContinue {
			limit = max - len([]rune(base))
		}
		if d == "" || tooLong(d, limit) {
			return nil, "形が合わない"
		}
		// 宛先以外の園児の名前が入っていたら（名前を渡していないので起きないはずだが）使わない（8-6 (3)）
		if names, _ := findOtherNames(d, "draft", recipients, all); len(names) > 0 {
			return nil, "ほかの園児の名前"
		}
		drafts[i] = d
	}
	return drafts, ""
}

// parseDrafts は、返った JSON を形どおりに読む（8-6 (3)。園からは1つ、言い換え・続きはちょうど3つ）
func parseDrafts(purpose, raw string) ([]string, bool) {
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if purpose == aiPurposeFacilityNote {
		var v struct {
			Draft *string `json:"draft"`
		}
		if dec.Decode(&v) != nil || v.Draft == nil {
			return nil, false
		}
		return []string{*v.Draft}, true
	}
	var v struct {
		Candidates []string `json:"candidates"`
	}
	if dec.Decode(&v) != nil || len(v.Candidates) != 3 {
		return nil, false
	}
	return v.Candidates, true
}

// aiJSON は、渡す中身を JSON の文字列にする（< > & を置き換えない）
func aiJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "{}"
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

// aiSucceededToday は、その日（サーバの日付）に成功した AI の下書きの数（8-7 (3)。園全体で1つの上限）
func (a *app) aiSucceededToday() int {
	var n int
	d := today()
	a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log
		WHERE operation_type = ? AND operated_at >= ? AND operated_at <= ? AND after_value LIKE '%"結果":"成功"%'`,
		opAiDraft, d+"T00:00:00", d+"T23:59:59").Scan(&n)
	return n
}
