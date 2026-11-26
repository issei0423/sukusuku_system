package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"
)

/*
保育日誌の下書き（POST /api/ai/drafts の purpose: diary）。
典拠：詳細設計書「保育日誌の下書き」(8-12)・「日誌の画面（作り直し）」(2-13) の「AI の下書き」(7)、
基本設計書「文章の下書き（AI）」(4-11)・「外部の AI へ送る情報」(6-3)。

日誌は保護者に届かない園内の記録だが、外部へ送る守り（園の有効化・保護者の同意と拒否・送る項目の最小化・名前の置き換え・
送った文を残さない）は、保護者へ届ける文と同じにする。使える条件は aiAvailableFor（8-3）と同じ関数に、日誌を書ける判定
（詳細設計書「日誌」(4-13 (1))）を足したもの。

要求：{ purpose: 'diary', record_type, child_id?（個人日誌）, class_id, date（記録日）, memo?, headings, share_to_guardian? }
【仮置き】設計の要求の形（8-12）に、次の2つを足した。web/仮置き値.md
  - record_type：ヒヤリハットを 403 にし、週案・月案だけ記録日を365日先まで認めるため（要求にこの区別が無いと、サーバが断れない）
  - share_to_guardian：共有を選んだ個人日誌の指示の文を替えるため（要決定事項の推し B。日誌はまだ保存されていないので、画面が送る）
headings は「【…】」の見出しの名前。両端の【】が付いていれば外す。返す下書きは「【見出し】」と文をつないだ1つの文
*/

// 見出しと本文の上限（詳細設計書「保育日誌の下書き」(8-12)）
const (
	aiDiaryHeadingsMax   = 20
	aiDiaryHeadingMax    = 50
	aiDiaryBodyMax       = 2000
	aiDiaryDefaultHeader = "記録"
)

// normalizeAiHeadings は、送られた見出しを整える。両端の空白と「【」「】」を外し、空なら誤り。
// 同じ見出しは最初の1つだけ残す（同じ見出しが2度出ない形を返してもらうため）。空の配列は「【記録】」1つとして扱う（8-12）。
// 数と長さの上限（0〜20個・1つ50文字）を超えたら誤り
func normalizeAiHeadings(raw []string) ([]string, bool) {
	if len(raw) > aiDiaryHeadingsMax {
		return nil, false
	}
	out := []string{}
	seen := map[string]bool{}
	for _, h := range raw {
		h = strings.TrimSpace(h)
		if strings.HasPrefix(h, "【") && strings.HasSuffix(h, "】") {
			h = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(h, "【"), "】"))
		}
		if h == "" || tooLong(h, aiDiaryHeadingMax) {
			return nil, false
		}
		if !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	if len(out) == 0 {
		out = []string{aiDiaryDefaultHeader}
	}
	return out, true
}

/*
aiDiaryWritable は、その職員がその日誌（の下書き）を書ける範囲か。日誌の作成と同じ判定（api_diary_write.go の handleSaveDiary）。
個人日誌は、園児を参照でき、そのクラスを使え、園児がそのクラスに在籍している。クラス日誌・週案月案は、そのクラスを使える
（担当クラスの無い一般（フリー）は書けない）
*/
func (a *app) aiDiaryWritable(u *SessionUser, recordType, childID string, classID int64) bool {
	if !u.isStaff() || !a.canUseClass(u, classID) {
		return false
	}
	if recordType == "1" {
		return a.canSeeChild(u, childID) && a.childInClass(childID, classID)
	}
	return true
}

// aiAvailableForDiary は、その職員がその日誌に AI の下書きを使えるか（8-12「使える条件」）。
// 使える条件（8-3）に、日誌を書ける判定を重ねる。個人日誌はその園児、クラス日誌・週案月案はクラスの全園児が宛先
func (a *app) aiAvailableForDiary(u *SessionUser, recordType, childID string, classID int64) bool {
	if !a.aiDiaryWritable(u, recordType, childID, classID) {
		return false
	}
	if recordType == "1" {
		return a.aiAvailableFor(u, aiTarget{ChildID: childID})
	}
	return a.aiAvailableFor(u, aiTarget{ClassID: classID})
}

func (a *app) handleAiDiary(w http.ResponseWriter, r *http.Request, u *SessionUser, in aiDraftInput) {
	childID := strings.TrimSpace(in.ChildID)
	memo := strings.TrimSpace(in.Memo)
	var classID int64
	if in.ClassID != nil {
		classID = *in.ClassID
	}
	headings, okHeadings := normalizeAiHeadings(in.Headings)
	// 画面の不具合でしか起きない誤り（記録種別・宛先・日付・見出し）。ヒヤリハットだけは園児を持つので宛先の形は問わない
	okType := in.RecordType == "1" || in.RecordType == "2" || in.RecordType == "3" || in.RecordType == "4"
	okChild := in.RecordType == "4" || (in.RecordType == "1") == (childID != "")
	limit := today()
	if in.RecordType == "3" {
		limit = addDays(today(), diaryPlanMaxDays)
	}
	if !okType || classID <= 0 || !okChild || !isISODate(in.Date) || in.Date > limit || !okHeadings {
		writeErr(w, http.StatusBadRequest, msgBadRequest)
		return
	}
	if tooLong(memo, aiMemoMax) {
		writeErr(w, http.StatusBadRequest, msgAiMemoTooLong)
		return
	}
	// ヒヤリハットには使えない（基本設計書「使いどころと使わないところ」(4-11)）
	if in.RecordType == "4" || !a.aiAvailableForDiary(u, in.RecordType, childID, classID) {
		writeForbidden(w, msgAiUnavailableForTarget)
		return
	}

	personal := in.RecordType == "1"
	all, err := a.enrolledNameChildren()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	adults := a.aiAdultNames()
	recipients := []nameChild{}
	if personal {
		recipients = append(recipients, a.nameChildOf(childID))
	}
	// ⑤ メモに AI を使えない園児の名前があれば呼ばない（8-5 ⑤。決めたこと D-12）
	if names, _ := findOtherNames(memo, "memo", recipients, a.aiExcludedChildren(all)); len(names) > 0 {
		writeJSON(w, http.StatusBadRequest, apiError{Message: msgAiExcludedName, Kind: kindAiExcludedName})
		return
	}
	if !a.reserveAiCall(a.settingInt("ai.daily_limit", 300)) {
		writeJSON(w, http.StatusTooManyRequests, apiError{Message: msgAiLimit, Kind: kindAiLimit})
		return
	}
	defer a.releaseAiCall()

	// 送る文を作る（8-12「送る項目」「置き換え」）。メモと見出しは職員が書いた文、クラスのようすは記録の文
	replaced := false
	anonWritten := func(s string) string {
		out, hit := anonymize(s, recipients, all, adults...)
		replaced = replaced || hit
		return out
	}
	anonRecord := func(s string) string {
		out, _ := anonymize(s, recipients, all, adults...)
		return out
	}
	share := personal && in.ShareToGuardian
	notes, err := a.diaryClassNotes(classID, in.Date, share, anonRecord)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactLoadFailed)
		return
	}
	sentHeadings := []string{}
	seen := map[string]bool{}
	for _, h := range headings {
		if ah := strings.TrimSpace(anonWritten(h)); !seen[ah] {
			seen[ah] = true
			sentHeadings = append(sentHeadings, ah)
		}
	}
	facts := aiDiaryFacts{Headings: sentHeadings, ClassNotes: notes, Memo: anonWritten(memo)}
	req := draftRequest{System: aiDiarySystemFor(share), User: aiJSON(facts), Schema: aiDiarySchema()}

	start := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), a.aiTimeoutOf())
	reply, err := a.ai.Write(ctx, req)
	cancel()
	draft, why := a.aiReadDiaryReply(ctx, reply, err, sentHeadings, recipients, all)
	childPtr := (*string)(nil)
	if personal {
		childPtr = s(childID)
	}
	if draft == "" {
		// 送った文・返った文・メモは、どのログにも出さない（8-7 (2)）
		log.Printf("AI の下書きを作れませんでした（用途 %s・%s・%dms）", in.Purpose, why, time.Since(start).Milliseconds())
		a.log(u.AccountID, fnDiary, opAiDraft, "t_diary", nil, childPtr, nil,
			s(fieldsJSON([]field{{"用途", aiPurposeLabel(in.Purpose)}, {"結果", "失敗"}})))
		writeJSON(w, http.StatusServiceUnavailable, apiError{Message: msgAiFailed, Kind: kindAiUnavailable})
		return
	}
	a.log(u.AccountID, fnDiary, opAiDraft, "t_diary", nil, childPtr, nil,
		s(fieldsJSON([]field{{"用途", aiPurposeLabel(in.Purpose)}, {"結果", "成功"}})))
	writeJSON(w, http.StatusOK, aiDraftResult{Drafts: []string{draft}, ReplacedOtherNames: replaced})
}

// aiDiarySection は、返った JSON の見出し1つ分
type aiDiarySection struct {
	Heading string `json:"heading"`
	Text    string `json:"text"`
}

/*
aiReadDiaryReply は、呼んだ結果を日誌の下書きにする（8-12「出力の形」「返す形」）。使えないときは空の文字列と、ログに出す理由を返す。
失敗の振り分けは保護者へ送る文と同じ（aiCallFailure）。
返った見出しは、送った見出しのどれかと一致し、同じ見出しが2度出ず、送った順に並んでいること。
見出しの無い欄は空の文として扱う。「【見出し】」と文をつないで、置き換えを戻す。全体が2,000文字を超えたら使わない
*/
func (a *app) aiReadDiaryReply(ctx context.Context, reply draftReply, err error, sent []string, recipients, all []nameChild) (string, string) {
	if why := a.aiCallFailure(ctx, reply, err); why != "" {
		return "", why
	}
	dec := json.NewDecoder(strings.NewReader(reply.JSON))
	dec.DisallowUnknownFields()
	var v struct {
		Sections *[]aiDiarySection `json:"sections"`
	}
	if dec.Decode(&v) != nil || v.Sections == nil {
		return "", "形が合わない"
	}
	index := map[string]int{}
	for i, h := range sent {
		index[h] = i
	}
	texts := make([]string, len(sent))
	last := -1
	for _, sec := range *v.Sections {
		i, ok := index[sec.Heading]
		if !ok || i <= last {
			return "", "形が合わない"
		}
		last = i
		texts[i] = strings.TrimSpace(sec.Text)
	}
	parts := make([]string, 0, len(sent))
	for i, h := range sent {
		part := "【" + h + "】"
		if texts[i] != "" {
			part += "\n" + texts[i]
		}
		parts = append(parts, part)
	}
	draft := strings.Join(parts, "\n\n")
	if len(recipients) > 0 {
		draft = restoreName(draft, recipients[0])
	}
	draft = strings.TrimSpace(draft)
	if draft == "" || tooLong(draft, aiDiaryBodyMax) {
		return "", "形が合わない"
	}
	// 宛先以外の園児の名前が入っていたら（名前を渡していないので起きないはずだが）使わない（8-6 (3)）
	if names, _ := findOtherNames(draft, "draft", recipients, all); len(names) > 0 {
		return "", "ほかの園児の名前"
	}
	return draft, ""
}
