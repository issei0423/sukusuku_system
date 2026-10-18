package main

import (
	"database/sql"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

/*
 * 午睡チェック表（帳票）をサーバで作る：GET /api/nap/report?from&to&class_id&format=csv
 * 典拠：基本設計書.md「帳票の出力」(4-8)・「記録の修正と改ざん防止」(4-8)・「操作ログ（t_operation_log）」(5-9)・
 *      「権限と利用可能機能」(6-1) の「帳票・CSV の出力（サーバで作る）」
 *      図/画面詳細図.md「午睡記録検索画面」(5-3) の項目9・10、図/インタフェース一覧.md の GET /api/nap/report
 *
 * - 出力できるのは管理者だけ。一般（保育士）と保護者は 403（CSV も帳票の一種として管理者に限る）
 * - 期間（必須）とクラス（任意。無ければすべてのクラス）で、その期間の全件を出す。画面のページには頼らない
 * - 出力したことを操作ログへ記録する。期間と件数はサーバが数えた値を書く（画面が申告した値を使わない）。
 *   記録できなかったときは出力しない
 * - 含めるもの：確認の行（チェックした時刻と保存時刻・体位・呼吸・顔色・体温・記録した職員）、ねた・おきた、
 *   入眠時の体温（ねたの行）、きょうは対象外と理由、異常時の記録、「修正あり」の列
 * - ヒヤリハットを起票した異常時の記録は、ヒヤリハット側の状況・とった対応に起票済みの印を付けて1行だけ出す
 *   （要件定義書「日誌システム」(4-3) の「午睡チェックの異常時の記録との関係」の「集計・監査時はヒヤリハット側を正」）
 *
 * 画面側のモック（web/src/api/mock.ts の napReport と web/src/api/napReport.ts）と同じ規則・同じ中身にしてある。
 *
 * 異常時の記録の一覧（GET /api/nap/abnormals。api_nap.go の handleNapAbnormals）は、起票したヒヤリハットの
 * 状況・とった対応を返さない。一般（保育士）もその一覧を読めるため、日誌を開けるかどうかと関わりなく日誌の本文が
 * 読めてしまう。ヒヤリハット側の文は、管理者だけが出せるこの帳票がサーバの中で日誌の本文を読んで出す。
 */

// 帳票の文言。モック（web/src/api/napReport.ts の NAP_REPORT_MSG）と同じ
const (
	// 【仮置き】PDF は作らない。PDF のライブラリと日本語の字体を入れるかが決まっていない（web/仮置き値.md「午睡の帳票」）
	msgNapReportPdf      = "PDF の帳票はまだ出力できません。CSV で出力してください"
	msgNapReportFormat   = "帳票の形式が正しくありません"
	msgNapReportPeriod   = "期間の開始と終了を、日付で指定してください"
	msgNapReportRange    = "期間の開始は、終了より後の日にできません"
	msgNapReportClass    = "クラスの指定が正しくありません"
	msgNapReportLoad     = "午睡の記録を取得できませんでした"
	msgNapReportLogError = "出力したことを操作ログに残せなかったため、出力していません。もう一度お試しください"
)

// 帳票の見出し。画面詳細図「午睡記録検索画面」(5-3) の項目6の並びに「修正あり」を添える
var napReportHeader = []string{"日付", "チェック時刻", "園児", "クラス", "体位", "呼吸", "顔色", "体温", "記録者", "保存時刻", "修正あり"}

// 同じ期間の異常時の記録の見出し。同 (5-3) の項目11の並び
var napReportAbnormalHeader = []string{"発見時刻", "園児", "状況", "対応", "記録者", "ヒヤリハット"}

const napReportAbnormalTitle = "同じ期間の異常時の記録"

// utf8BOM は UTF-8 の BOM（EF BB BF）。ソースに BOM の字そのものを書くと Go が読めないため、バイトで書く
const utf8BOM = "\xef\xbb\xbf"

// 体位・呼吸・顔色・対象外の理由の表示名。web/src/api/codes.ts と同じ
var (
	napBodyPositionLabel = map[string]string{"1": "仰向け", "2": "うつ伏せ", "3": "左向き", "4": "右向き"}
	napBreathingLabel    = map[string]string{"1": "あり", "2": "確認できず"}
	napComplexionLabel   = map[string]string{"1": "通常", "2": "蒼白", "3": "紅潮", "4": "その他"}
	napExclusionLabel    = map[string]string{"1": "欠席", "2": "午睡なし"}
)

// ねた・おきたの行に出す名前。画面詳細図「午睡記録検索画面」(5-3) の項目6。web/src/api/napReport.ts の SLEEP_ROW_LABEL と同じ
var napReportSleepLabel = map[string]string{napRowSleep: "入眠（ねた）", napRowWake: "起床（おきた）"}

// 帳票の行の種類は、午睡記録検索と同じ napRowCheck・napRowSleep・napRowWake・napRowExclusion（api_nap.go）

// napReportLine は帳票の1行。並べ替えの鍵と、出すセルを持つ
type napReportLine struct {
	kind  string
	id    int64
	at    string
	cells []string
}

// napReportAbnormal は「同じ期間の異常時の記録」の1行
type napReportAbnormal struct {
	id      int64
	foundAt string
	cells   []string
}

func (a *app) handleNapReport(w http.ResponseWriter, r *http.Request) {
	// 管理者だけ。拒否するときは、期間・形式の誤りよりも先に返す
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	switch q.Get("format") {
	case "", "csv":
	case "pdf":
		// 【仮置き】PDF の帳票は作らず 400 を返す（web/仮置き値.md「午睡の帳票」）
		writeErr(w, http.StatusBadRequest, msgNapReportPdf)
		return
	default:
		writeErr(w, http.StatusBadRequest, msgNapReportFormat)
		return
	}
	from, to := q.Get("from"), q.Get("to")
	if !isISODate(from) || !isISODate(to) {
		writeErr(w, http.StatusBadRequest, msgNapReportPeriod)
		return
	}
	if from > to {
		writeErr(w, http.StatusBadRequest, msgNapReportRange)
		return
	}
	classID, hasClass := queryInt64(r, "class_id")
	if q.Get("class_id") != "" && !hasClass {
		writeErr(w, http.StatusBadRequest, msgNapReportClass)
		return
	}

	lines, abnormals, err := a.napReportData(from, to, classID, hasClass)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapReportLoad)
		return
	}
	body := napReportCSV(lines, abnormals)

	classLabel := "すべてのクラス"
	if hasClass {
		classLabel = a.className(classID)
	}
	count := len(lines) + len(abnormals)
	after := "午睡記録をCSV出力（期間 " + from + "〜" + to + "・" + classLabel + "・" + strconv.Itoa(count) + " 件）"
	if _, err := a.db.Exec(`INSERT INTO t_operation_log
		(account_id, operated_at, function_type, operation_type, target_table, target_id,
		 target_child_id, before_value, after_value)
		VALUES (?, ?, ?, ?, 't_nap_record', NULL, NULL, NULL, ?)`,
		u.AccountID, now(), fnNap, opExport, after); err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapReportLogError)
		return
	}

	fileName := "午睡記録_" + from + "_" + to + ".csv"
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="nap_report.csv"; filename*=UTF-8''`+url.PathEscape(fileName))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	// Excel で開いても文字化けしないよう、先頭に BOM を付ける（web/src/csv.ts の downloadCsv と同じ）
	w.Write([]byte(utf8BOM + body))
}

/*
napReportData は、期間（実施の日）とクラスで帳票の行と異常時の記録を集める。

行の並びは午睡記録検索と同じ時刻の新しい順（sortNapSearchRows と同じ）。【仮置き】同じ時刻の行は、おきた・確認・ねた・
対象外の順にする（web/仮置き値.md「一覧の並び順」）。異常時の記録は発見時刻の新しい順、同じ時刻はあとで記録したものを先にする
（handleNapAbnormals と同じ）。異常時の記録も、つないだ実施の日とクラスで絞る。

SQLite の接続は1本なので（db.go）、名前を引くのはカーソルを閉じたあとにする。
*/
func (a *app) napReportData(from, to string, classID int64, hasClass bool) ([]napReportLine, []napReportAbnormal, error) {
	cond := ` AND s.session_date >= ? AND s.session_date <= ?`
	args := []any{from, to}
	if hasClass {
		cond += ` AND s.class_id = ?`
		args = append(args, classID)
	}

	type rawLine struct {
		kind, childID, at, staffID, date string
		classID, id                      int64
		savedAt, position, breath, compl string
		temp                             sql.NullFloat64
		reason                           string
	}
	raws := []rawLine{}

	rows, err := a.db.Query(`SELECT r.nap_record_id, r.child_id, r.checked_at, r.saved_at,
		r.body_position, r.breathing, r.complexion, r.temperature, r.staff_id, s.session_date, s.class_id
		FROM t_nap_record r JOIN t_nap_session s ON s.nap_session_id = r.nap_session_id
		WHERE 1 = 1`+cond, args...)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		x := rawLine{kind: napRowCheck}
		if err := rows.Scan(&x.id, &x.childID, &x.at, &x.savedAt, &x.position, &x.breath, &x.compl,
			&x.temp, &x.staffID, &x.date, &x.classID); err != nil {
			rows.Close()
			return nil, nil, err
		}
		raws = append(raws, x)
	}
	rows.Close()

	sleeps, err := a.db.Query(`SELECT n.nap_sleep_id, n.child_id, n.slept_at, n.woke_at, n.sleep_temperature,
		n.slept_staff_id, n.woke_staff_id, s.session_date, s.class_id
		FROM t_nap_sleep n JOIN t_nap_session s ON s.nap_session_id = n.nap_session_id
		WHERE n.is_deleted = 0`+cond, args...)
	if err != nil {
		return nil, nil, err
	}
	for sleeps.Next() {
		var (
			x                 rawLine
			wokeAt, wokeStaff sql.NullString
		)
		if err := sleeps.Scan(&x.id, &x.childID, &x.at, &wokeAt, &x.temp, &x.staffID, &wokeStaff,
			&x.date, &x.classID); err != nil {
			sleeps.Close()
			return nil, nil, err
		}
		slept := x
		slept.kind = napRowSleep
		raws = append(raws, slept)
		if wokeAt.Valid {
			woke := x
			woke.kind = napRowWake
			woke.at = wokeAt.String
			woke.staffID = wokeStaff.String
			woke.temp = sql.NullFloat64{}
			raws = append(raws, woke)
		}
	}
	sleeps.Close()

	exclusions, err := a.db.Query(`SELECT e.nap_exclusion_id, e.child_id, e.created_at, e.reason, e.staff_id,
		s.session_date, s.class_id
		FROM t_nap_exclusion e JOIN t_nap_session s ON s.nap_session_id = e.nap_session_id
		WHERE e.is_deleted = 0`+cond, args...)
	if err != nil {
		return nil, nil, err
	}
	for exclusions.Next() {
		x := rawLine{kind: napRowExclusion}
		if err := exclusions.Scan(&x.id, &x.childID, &x.at, &x.reason, &x.staffID, &x.date, &x.classID); err != nil {
			exclusions.Close()
			return nil, nil, err
		}
		raws = append(raws, x)
	}
	exclusions.Close()

	type rawAbnormal struct {
		id                                         int64
		childID, foundAt, situation, resp, staffID string
		diaryID                                    sql.NullInt64
	}
	rawAbnormals := []rawAbnormal{}
	abnormalRows, err := a.db.Query(`SELECT a.nap_abnormal_id, a.child_id, a.found_at, a.situation, a.response,
		a.staff_id, a.diary_id
		FROM t_nap_abnormal a JOIN t_nap_session s ON s.nap_session_id = a.nap_session_id
		WHERE 1 = 1`+cond, args...)
	if err != nil {
		return nil, nil, err
	}
	for abnormalRows.Next() {
		var x rawAbnormal
		if err := abnormalRows.Scan(&x.id, &x.childID, &x.foundAt, &x.situation, &x.resp, &x.staffID, &x.diaryID); err != nil {
			abnormalRows.Close()
			return nil, nil, err
		}
		rawAbnormals = append(rawAbnormals, x)
	}
	abnormalRows.Close()

	lines := make([]napReportLine, 0, len(raws))
	for _, x := range raws {
		cells := []string{x.date, x.at, a.childName(x.childID), a.className(x.classID)}
		staff := a.staffName(x.staffID)
		switch x.kind {
		case napRowCheck:
			cells = append(cells, napBodyPositionLabel[x.position], napBreathingLabel[x.breath],
				napComplexionLabel[x.compl], napReportTemperature(x.temp), staff, x.savedAt)
		case napRowSleep:
			// ねたの行の体温の列に入眠時の体温を出す（基本設計書「帳票の出力」(4-8)）
			cells = append(cells, napReportSleepLabel[napRowSleep], "", "", napReportTemperature(x.temp), staff, "")
		case napRowWake:
			cells = append(cells, napReportSleepLabel[napRowWake], "", "", "", staff, "")
		case napRowExclusion:
			// 【仮置き】対象外は、体位の列に「きょうは対象外（理由）」を入れて1行で出す（web/仮置き値.md「午睡の帳票」）
			cells = append(cells, "きょうは対象外（"+napExclusionLabel[x.reason]+"）", "", "", "", staff, "")
		}
		/*
		 * 「修正あり」の列は置くが、いまは空にする。午睡チェックの記録を修正する機能（POST /api/nap/records/{id}/correct と
		 * t_nap_record.corrected_at）が、サーバにもモックにも無いため（基本設計書「記録の修正と改ざん防止」(4-8)）
		 */
		cells = append(cells, "")
		lines = append(lines, napReportLine{kind: x.kind, id: x.id, at: x.at, cells: cells})
	}
	rank := map[string]int{napRowWake: 0, napRowCheck: 1, napRowSleep: 2, napRowExclusion: 3}
	sort.SliceStable(lines, func(i, j int) bool {
		if lines[i].at != lines[j].at {
			return lines[i].at > lines[j].at
		}
		if rank[lines[i].kind] != rank[lines[j].kind] {
			return rank[lines[i].kind] < rank[lines[j].kind]
		}
		return lines[i].id < lines[j].id
	})

	abnormals := make([]napReportAbnormal, 0, len(rawAbnormals))
	for _, x := range rawAbnormals {
		situation, resp, mark := x.situation, x.resp, "未起票"
		if x.diaryID.Valid {
			mark = "起票済み"
			// 起票したヒヤリハットの側の状況・とった対応を出す。日誌が見つからないとき（削除したなど）は記録そのものを出す
			var diaryBody string
			if a.db.QueryRow(`SELECT body FROM t_diary WHERE diary_id = ? AND is_deleted = 0`, x.diaryID.Int64).
				Scan(&diaryBody) == nil {
				situation, resp = incidentSituationResponse(diaryBody)
			}
		}
		abnormals = append(abnormals, napReportAbnormal{id: x.id, foundAt: x.foundAt, cells: []string{
			x.foundAt, a.childName(x.childID), situation, resp, a.staffName(x.staffID), mark,
		}})
	}
	sort.SliceStable(abnormals, func(i, j int) bool {
		if abnormals[i].foundAt != abnormals[j].foundAt {
			return abnormals[i].foundAt > abnormals[j].foundAt
		}
		return abnormals[i].id > abnormals[j].id
	})
	return lines, abnormals, nil
}

// napReportTemperature は体温を小数第1位まで出す。記録が無ければ空
func napReportTemperature(v sql.NullFloat64) string {
	if !v.Valid {
		return ""
	}
	return strconv.FormatFloat(v.Float64, 'f', 1, 64)
}

/*
napReportCSV は帳票の本文を作る。1行目は見出し、続けて一覧の行。異常時の記録があれば、1行あけて
「同じ期間の異常時の記録」の見出しと行を続ける。

【仮置き】1つのファイルに2つの表を続ける形（web/仮置き値.md「午睡の帳票」）。行の区切りは改行（\n）で、
画面で作っていたときの CSV（web/src/csv.ts の toCsv）と同じ。
*/
func napReportCSV(lines []napReportLine, abnormals []napReportAbnormal) string {
	out := []string{napReportCSVRow(napReportHeader)}
	for _, l := range lines {
		out = append(out, napReportCSVRow(l.cells))
	}
	if len(abnormals) > 0 {
		out = append(out, "", napReportCSVRow([]string{napReportAbnormalTitle}), napReportCSVRow(napReportAbnormalHeader))
		for _, x := range abnormals {
			out = append(out, napReportCSVRow(x.cells))
		}
	}
	return strings.Join(out, "\n")
}

func napReportCSVRow(cells []string) string {
	quoted := make([]string, len(cells))
	for i, c := range cells {
		quoted[i] = napReportCSVCell(c)
	}
	return strings.Join(quoted, ",")
}

/*
napReportCSVCell は1つのセルを作る。表計算ソフトで式として開かれないよう、先頭が式の始まりになる文字
（= + - @ タブ・改行）のセルには ' を前に付ける。" で囲み、中の " は二重にする。

画面で作っていたときと同じやり方（web/src/csv.ts の csvCell、GitHub Issue #153）。【仮置き】セルの無害化は設計に定めが無い
（web/仮置き値.md）
*/
func napReportCSVCell(v string) string {
	if v != "" && strings.IndexByte("=+-@\t\r\n", v[0]) >= 0 {
		v = "'" + v
	}
	return `"` + strings.ReplaceAll(v, `"`, `""`) + `"`
}
