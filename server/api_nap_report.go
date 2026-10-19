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
 *   入眠時の体温（ねたの行）、きょうは対象外と理由、異常時の記録、「修正あり」の印、末尾の「修正の履歴」の表
 *   （修正した午睡チェックの記録ごとに、操作ログの修正の行から作る。api_nap_correct.go）
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

// napReportLine は帳票の1行。並べ替えの鍵（実施の日・クラス・園児のよみと ID・時刻・種類・番号）と、出すセルを持つ
type napReportLine struct {
	kind    string
	id      int64
	date    string
	classID int64
	kana    string
	childID string
	at      string
	cells   []string
}

// napReportLineRank は、同じ園児の同じ時刻の行の並び。時刻の古い順の中で、寝ている間の確認をねたより下・
// おきたより上に置く（午睡記録検索の新しい順の並び（sortNapSearchRows）を逆にしたもの）
var napReportLineRank = map[string]int{napRowExclusion: 0, napRowSleep: 1, napRowCheck: 2, napRowWake: 3}

/*
sortNapReportLines は、帳票の一覧の行を 実施の日 → クラス → 園児 → 時刻 の古い順に並べる。
監査では、1人の子の確認が間隔どおりかを時刻の順に読むため（2026-10-19、持ち主が任せて決めた）。
画面の一覧（午睡記録検索）は時刻の新しい順のまま。

【仮置き】クラスはクラスの番号の順、園児はよみの順（よみが同じなら園児IDの順）。ほかのよみ順の一覧と同じく、よみは
文字コードの順で比べる（モックは日本語の照合の順。web/仮置き値.md「一覧の並び順」）。同じ時刻は napReportLineRank、
同じ種類は番号の小さい順。web/src/api/napReport.ts の sortReportLines と同じ。
*/
func sortNapReportLines(lines []napReportLine) {
	sort.SliceStable(lines, func(i, j int) bool {
		x, y := lines[i], lines[j]
		switch {
		case x.date != y.date:
			return x.date < y.date
		case x.classID != y.classID:
			return x.classID < y.classID
		case x.kana != y.kana:
			return x.kana < y.kana
		case x.childID != y.childID:
			return x.childID < y.childID
		case x.at != y.at:
			return x.at < y.at
		case napReportLineRank[x.kind] != napReportLineRank[y.kind]:
			return napReportLineRank[x.kind] < napReportLineRank[y.kind]
		}
		return x.id < y.id
	})
}

// napReportAbnormal は「同じ期間の異常時の記録」の1行。並べ替えの鍵（つないだ実施の日・クラス・園児のよみと ID・発見時刻・番号）と、出すセルを持つ
type napReportAbnormal struct {
	id      int64
	date    string
	classID int64
	kana    string
	childID string
	foundAt string
	cells   []string
}

/*
sortNapReportAbnormals は、同じ期間の異常時の記録を、つないだ実施の日 → クラス → 園児 → 発見時刻 の古い順に並べる。
一覧の行（sortNapReportLines）と同じ向きにする。監査では1つのファイルを時刻の順に読み、表ごとに向きが違うと読み違えるため
（2026-10-19、持ち主が任せて決めた）。画面の「同じ期間の異常時の記録」と異常時記録画面の一覧（handleNapAbnormals）は新しい順のまま。

【仮置き】クラス・園児の比べ方は sortNapReportLines と同じ。同じ発見時刻は、先に記録したもの（番号の小さいもの）を先にする。
web/src/api/napReport.ts の sortReportAbnormals と同じ。
*/
func sortNapReportAbnormals(rows []napReportAbnormal) {
	sort.SliceStable(rows, func(i, j int) bool {
		x, y := rows[i], rows[j]
		switch {
		case x.date != y.date:
			return x.date < y.date
		case x.classID != y.classID:
			return x.classID < y.classID
		case x.kana != y.kana:
			return x.kana < y.kana
		case x.childID != y.childID:
			return x.childID < y.childID
		case x.foundAt != y.foundAt:
			return x.foundAt < y.foundAt
		}
		return x.id < y.id
	})
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
	histories, err := a.napReportHistories(from, to, classID, hasClass)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgNapReportLoad)
		return
	}
	body := napReportCSV(lines, abnormals, histories)

	classLabel := "すべてのクラス"
	if hasClass {
		classLabel = a.className(classID)
	}
	// 【仮置き】件数は、一覧・異常時の記録・修正の履歴の行の合計（出したデータの行の数。web/仮置き値.md）
	count := len(lines) + len(abnormals) + len(histories)
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

行は 実施の日 → クラス → 園児 → 時刻 の古い順（sortNapReportLines。画面の一覧の新しい順とは違う）。
異常時の記録も同じ向きで、つないだ実施の日 → クラス → 園児 → 発見時刻 の古い順（sortNapReportAbnormals）。
異常時の記録も、つないだ実施の日とクラスで絞る。

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
		corrected                        sql.NullString
	}
	raws := []rawLine{}

	rows, err := a.db.Query(`SELECT r.nap_record_id, r.child_id, r.checked_at, r.saved_at,
		r.body_position, r.breathing, r.complexion, r.temperature, r.staff_id, s.session_date, s.class_id,
		r.corrected_at
		FROM t_nap_record r JOIN t_nap_session s ON s.nap_session_id = r.nap_session_id
		WHERE 1 = 1`+cond, args...)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		x := rawLine{kind: napRowCheck}
		if err := rows.Scan(&x.id, &x.childID, &x.at, &x.savedAt, &x.position, &x.breath, &x.compl,
			&x.temp, &x.staffID, &x.date, &x.classID, &x.corrected); err != nil {
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
		date                                       string
		classID                                    int64
	}
	rawAbnormals := []rawAbnormal{}
	abnormalRows, err := a.db.Query(`SELECT a.nap_abnormal_id, a.child_id, a.found_at, a.situation, a.response,
		a.staff_id, a.diary_id, s.session_date, s.class_id
		FROM t_nap_abnormal a JOIN t_nap_session s ON s.nap_session_id = a.nap_session_id
		WHERE 1 = 1`+cond, args...)
	if err != nil {
		return nil, nil, err
	}
	for abnormalRows.Next() {
		var x rawAbnormal
		if err := abnormalRows.Scan(&x.id, &x.childID, &x.foundAt, &x.situation, &x.resp, &x.staffID, &x.diaryID,
			&x.date, &x.classID); err != nil {
			abnormalRows.Close()
			return nil, nil, err
		}
		rawAbnormals = append(rawAbnormals, x)
	}
	abnormalRows.Close()

	// 園児のよみは並べ替えにだけ使う（帳票には出さない）。園児ごとに1回だけ引く
	kanaOf := map[string]string{}
	childKana := func(childID string) string {
		if k, ok := kanaOf[childID]; ok {
			return k
		}
		var k sql.NullString
		a.db.QueryRow(`SELECT child_name_kana FROM m_child WHERE child_id = ?`, childID).Scan(&k)
		kanaOf[childID] = k.String
		return k.String
	}

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
		 * 「修正あり」の列：修正した午睡チェックの記録（t_nap_record.corrected_at がある）に印を付ける
		 * （基本設計書「帳票の出力」(4-8)）。ねた・おきた・対象外の行は空（伝える層の訂正は別の規則。異常時の記録の修正は別の PR）
		 */
		mark := ""
		if x.kind == napRowCheck && x.corrected.Valid {
			mark = napReportCorrectedMark
		}
		cells = append(cells, mark)
		lines = append(lines, napReportLine{kind: x.kind, id: x.id, date: x.date, classID: x.classID,
			kana: childKana(x.childID), childID: x.childID, at: x.at, cells: cells})
	}
	sortNapReportLines(lines)

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
		abnormals = append(abnormals, napReportAbnormal{id: x.id, date: x.date, classID: x.classID,
			kana: childKana(x.childID), childID: x.childID, foundAt: x.foundAt, cells: []string{
				x.foundAt, a.childName(x.childID), situation, resp, a.staffName(x.staffID), mark,
			}})
	}
	sortNapReportAbnormals(abnormals)
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
「同じ期間の異常時の記録」の見出しと行を続ける。修正の履歴があれば、ファイルの末尾に1行あけて「修正の履歴」の
見出しと行を続ける（基本設計書「帳票の出力」(4-8)）。

【仮置き】1つのファイルに表を続ける形（web/仮置き値.md「午睡の帳票」）。行の区切りは改行（\n）で、
画面で作っていたときの CSV（web/src/csv.ts の toCsv）と同じ。
*/
func napReportCSV(lines []napReportLine, abnormals []napReportAbnormal, histories []napReportHistory) string {
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
	if len(histories) > 0 {
		out = append(out, "", napReportCSVRow([]string{napReportHistoryTitle}), napReportCSVRow(napReportHistoryHeader))
		for _, x := range histories {
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
