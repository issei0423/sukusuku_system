package main

import (
	"database/sql"
	"strings"
)

/*
 * ヒヤリハットの欄（発生日時・場所・状況・とった対応・今後の対策・保護者へ伝えたこと）
 * 典拠：詳細設計書.md「日誌の画面（作り直し）」(2-13 (8))・「日誌」(4-13 (1)・(6))・決めたこと D-33
 *      基本設計書.md「ヒヤリハットの記録」(4-6)・「日誌（t_diary）」(5-5)
 *      図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目18〜21・28
 *
 * 発生日時・場所・保護者へ伝えたことは列に持つ。状況・とった対応・今後の対策は列を足さず、
 * 本文（body）に見出しを付けてつないで持ち、読むときに見出しで分けて返す（D-33）。
 * 本文に入れるのは、一覧のキーワードの絞り込みで探せるようにするため（2-13 (8)）。
 * 今後の対策は人が書く欄であり、システムは原因の判定・過失の評価をしない（基本設計書「ヒヤリハットの記録」(4-6)）。
 * 画面側のモック（web/src/api/mock.ts の diaryIncidentError・incidentBody・splitIncidentBody）と同じ規則
 */

// ヒヤリハットの本文の見出し（D-33）
const (
	incidentHeadingSituation      = "【状況】"
	incidentHeadingResponse       = "【とった対応】"
	incidentHeadingCountermeasure = "【今後の対策】"
)

// ヒヤリハットの欄の誤りの文言（詳細設計書「日誌」(4-13 (1))）。モック（web/src/api/mock.ts の INCIDENT_MSG）と同じ
const (
	msgIncidentOccurredAt       = "発生日時を入力してください"
	msgIncidentOccurredAtFuture = "発生日時に未来の日時は指定できません。"
	// 【仮置き】形の崩れた値の文言は設計に無い（web/仮置き値.md「ヒヤリハットの欄」）。画面からは送られない
	msgIncidentOccurredAtFormat = "発生日時の形式が正しくありません"
	msgIncidentPlace            = "場所を入力してください。"
	msgIncidentPlaceLong        = "場所は100文字以内で入力してください。"
	msgIncidentSituation        = "状況を入力してください。"
	msgIncidentResponse         = "とった対応を入力してください"
	msgIncidentTextLong         = "状況・とった対応は1,000文字以内で入力してください。"
	msgIncidentCountermeasure   = "今後の対策は1,000文字以内で入力してください。"
	msgIncidentHeadingLine      = "「【状況】」「【とった対応】」「【今後の対策】」だけの行は書けません。"
	msgIncidentGuardianNotice   = "保護者へ伝えた日時・手段・相手を入れてください。"
	// 【仮置き】「伝えた」「伝えていない」のほかの値の文言は設計に無い（web/仮置き値.md「ヒヤリハットの欄」）。画面からは送られない
	msgIncidentGuardianNoticeKind = "保護者へ伝えたかの指定が正しくありません"
)

// 欄の上限（基本設計書「入力項目の制約値」(4-12)、詳細設計書「日誌の画面（作り直し）」(2-13 (8))）
const (
	incidentPlaceMax  = 100
	incidentTextMax   = 1000
	incidentPersonMax = 50
)

// diaryIncidentInput は、保存の要求のヒヤリハットの欄（詳細設計書「日誌」(4-13 (1))）。
// 任意の欄は、空の文字列か null で「無し」とする
type diaryIncidentInput struct {
	OccurredAt           string `json:"occurred_at"`
	Place                string `json:"place"`
	Situation            string `json:"situation"`
	Response             string `json:"response"`
	Countermeasure       string `json:"countermeasure"`
	GuardianNotice       string `json:"guardian_notice"`
	GuardianNoticedAt    string `json:"guardian_noticed_at"`
	GuardianNoticeMethod string `json:"guardian_notice_method"`
	GuardianNoticePerson string `json:"guardian_notice_person"`
}

// DiaryIncident は、読むときに返すヒヤリハットの欄（詳細設計書「日誌」(4-13 (6))）。
// 状況・とった対応・今後の対策は、本文を見出しで分けたもの
type DiaryIncident struct {
	OccurredAt           string  `json:"occurred_at"`
	Place                string  `json:"place"`
	Situation            string  `json:"situation"`
	Response             string  `json:"response"`
	Countermeasure       string  `json:"countermeasure"`
	GuardianNotice       *string `json:"guardian_notice"`
	GuardianNoticedAt    *string `json:"guardian_noticed_at"`
	GuardianNoticeMethod *string `json:"guardian_notice_method"`
	GuardianNoticePerson *string `json:"guardian_notice_person"`
}

// incidentColumns は、保存するヒヤリハットの列の値（ヒヤリハットでなければすべて空）
type incidentColumns struct {
	occurredAt, place                             any
	notice, noticedAt, noticeMethod, noticePerson any
}

// normalizeIncident は、ヒヤリハットの欄の前後の空白を除く。任意の欄も同じく除き、空なら「無し」として扱う
func normalizeIncident(in *diaryIncidentInput) {
	in.OccurredAt = strings.TrimSpace(in.OccurredAt)
	in.Place = strings.TrimSpace(in.Place)
	in.Situation = strings.TrimSpace(in.Situation)
	in.Response = strings.TrimSpace(in.Response)
	in.Countermeasure = strings.TrimSpace(in.Countermeasure)
	in.GuardianNotice = strings.TrimSpace(in.GuardianNotice)
	in.GuardianNoticedAt = strings.TrimSpace(in.GuardianNoticedAt)
	in.GuardianNoticeMethod = strings.TrimSpace(in.GuardianNoticeMethod)
	in.GuardianNoticePerson = strings.TrimSpace(in.GuardianNoticePerson)
}

/*
checkDiaryIncident は、ヒヤリハットの欄を確かめ、断る理由を返す（問題が無ければ空を返す）。
検査の順は詳細設計書「日誌」(4-13 (1)) の文言の並びに合わせる。

  - 発生日時：必須。未来は不可（分の単位で比べる。異常時の記録の発見時刻の foundAtProblem と同じ。web/仮置き値.md）
  - 場所：1〜100文字
  - 状況・とった対応：各1〜1,000文字
  - 今後の対策：任意・1,000文字まで
  - 状況・とった対応・今後の対策に、見出しと同じ文字だけの行を書かせない（本文を見出しで分けるときに取り違えないため）
  - 保護者へ伝えたこと：任意。「伝えた」なら日時（未来は不可）・手段（1・2・3・9）・相手（1〜50文字）が必須
*/
func checkDiaryIncident(in *diaryIncidentInput) string {
	if in.OccurredAt == "" {
		return msgIncidentOccurredAt
	}
	if !isISODateTime(in.OccurredAt) {
		return msgIncidentOccurredAtFormat
	}
	if in.OccurredAt[:16] > now()[:16] {
		return msgIncidentOccurredAtFuture
	}
	if in.Place == "" {
		return msgIncidentPlace
	}
	if tooLong(in.Place, incidentPlaceMax) {
		return msgIncidentPlaceLong
	}
	if in.Situation == "" {
		return msgIncidentSituation
	}
	if in.Response == "" {
		return msgIncidentResponse
	}
	if tooLong(in.Situation, incidentTextMax) || tooLong(in.Response, incidentTextMax) {
		return msgIncidentTextLong
	}
	if tooLong(in.Countermeasure, incidentTextMax) {
		return msgIncidentCountermeasure
	}
	for _, text := range []string{in.Situation, in.Response, in.Countermeasure} {
		if hasIncidentHeadingLine(text) {
			return msgIncidentHeadingLine
		}
	}
	switch in.GuardianNotice {
	case "", "2":
		// 未記入・伝えていない。日時・手段・相手は持たない
	case "1":
		if !isISODateTime(in.GuardianNoticedAt) || in.GuardianNoticedAt[:16] > now()[:16] ||
			!oneOf(in.GuardianNoticeMethod, "1", "2", "3", "9") ||
			in.GuardianNoticePerson == "" || tooLong(in.GuardianNoticePerson, incidentPersonMax) {
			return msgIncidentGuardianNotice
		}
	default:
		return msgIncidentGuardianNoticeKind
	}
	return ""
}

// isIncidentHeading は、その行が本文を分ける見出し（D-33）だけでできているかを返す
func isIncidentHeading(line string) bool {
	switch strings.TrimSpace(line) {
	case incidentHeadingSituation, incidentHeadingResponse, incidentHeadingCountermeasure:
		return true
	}
	return false
}

func hasIncidentHeadingLine(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		if isIncidentHeading(line) {
			return true
		}
	}
	return false
}

/*
incidentBody は、状況・とった対応を見出しを付けてつなぎ、今後の対策があれば見出しを付けて続けた本文を返す
（詳細設計書「日誌」(4-13 (1))、決めたこと D-33）。今後の対策が無いときは、見出しも付けない
*/
func incidentBody(situation, response, countermeasure string) string {
	body := incidentHeadingSituation + "\n" + situation + "\n\n" + incidentHeadingResponse + "\n" + response
	if countermeasure != "" {
		body += "\n\n" + incidentHeadingCountermeasure + "\n" + countermeasure
	}
	return body
}

/*
splitIncidentBody は、ヒヤリハットの本文を見出しで分け、状況・とった対応・今後の対策を返す（詳細設計書「日誌」(4-13 (6))）。

【仮置き】最初の見出しより前に文があれば（以前の形式の記録の「【発生日時】」など）、状況の頭に入れる
（web/仮置き値.md「ヒヤリハットの欄」）。設計は見出しより前の文の扱いを決めていない。捨てると、
以前の記録を開いて保存し直したときに、その文が本文から消えるため。同じ見出しが2回あれば、つないで返す
*/
func splitIncidentBody(body string) (situation, response, countermeasure string) {
	var preamble []string
	parts := map[string][]string{}
	current := ""
	for _, line := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		if isIncidentHeading(line) {
			current = strings.TrimSpace(line)
			continue
		}
		if current == "" {
			preamble = append(preamble, line)
			continue
		}
		parts[current] = append(parts[current], line)
	}
	join := func(lines []string) string { return strings.TrimSpace(strings.Join(lines, "\n")) }
	situation = join(parts[incidentHeadingSituation])
	if head := join(preamble); head != "" {
		if situation != "" {
			situation = head + "\n\n" + situation
		} else {
			situation = head
		}
	}
	return situation, join(parts[incidentHeadingResponse]), join(parts[incidentHeadingCountermeasure])
}

// incidentColumnsOf は、保存するヒヤリハットの列の値を返す。ヒヤリハットでなければ、すべて空にする
func incidentColumnsOf(recordType string, in *diaryIncidentInput) incidentColumns {
	if recordType != "4" || in == nil {
		return incidentColumns{}
	}
	c := incidentColumns{occurredAt: in.OccurredAt, place: in.Place}
	if in.GuardianNotice != "" {
		c.notice = in.GuardianNotice
	}
	if in.GuardianNotice == "1" {
		c.noticedAt, c.noticeMethod, c.noticePerson = in.GuardianNoticedAt, in.GuardianNoticeMethod, in.GuardianNoticePerson
	}
	return c
}

// incidentOf は、読んだ列と本文からヒヤリハットの欄を組み立てる（ヒヤリハットでなければ nil）
func incidentOf(recordType, body string, occurredAt, place, notice, noticedAt, method, person sql.NullString) *DiaryIncident {
	if recordType != "4" {
		return nil
	}
	situation, response, countermeasure := splitIncidentBody(body)
	return &DiaryIncident{
		OccurredAt:           occurredAt.String,
		Place:                place.String,
		Situation:            situation,
		Response:             response,
		Countermeasure:       countermeasure,
		GuardianNotice:       nullStr(notice),
		GuardianNoticedAt:    nullStr(noticedAt),
		GuardianNoticeMethod: nullStr(method),
		GuardianNoticePerson: nullStr(person),
	}
}
