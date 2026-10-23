package main

import (
	"encoding/csv"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

/*
 * 午睡記録検索と帳票に、ねた・おきたと入眠時の体温を出す。ヒヤリハットを起票した異常時の記録は、
 * ヒヤリハット側の状況・とった対応を出して二重に数えない
 * 典拠：図/画面詳細図.md「午睡記録検索画面」(5-3) の項目6・9・10・11、基本設計書.md「帳票の出力」(4-8)、
 *      要件定義書.md「日誌システム」(4-3) の「午睡チェックの異常時の記録との関係」
 *
 * 帳票（GET /api/nap/report）はサーバで作り、管理者だけが出せる。期間と件数はサーバが操作ログへ書く。
 * 画面側のモック（web/src/api/mock.ts）と同じ規則であることを、web/tests/napReport.test.ts と同じ観点で確かめる。
 */

type napSearchPage struct {
	Rows []struct {
		Kind             string   `json:"kind"`
		NapRecordID      *int64   `json:"nap_record_id"`
		NapSleepID       *int64   `json:"nap_sleep_id"`
		NapExclusionID   *int64   `json:"nap_exclusion_id"`
		ExclusionReason  *string  `json:"exclusion_reason"`
		ChildID          string   `json:"child_id"`
		CheckedAt        string   `json:"checked_at"`
		SavedAt          *string  `json:"saved_at"`
		BodyPosition     *string  `json:"body_position"`
		Temperature      *float64 `json:"temperature"`
		SleepTemperature *float64 `json:"sleep_temperature"`
		StaffName        string   `json:"staff_name"`
		ClassName        string   `json:"class_name"`
		SessionDate      string   `json:"session_date"`
	} `json:"rows"`
	Total int `json:"total"`
}

func searchNap(t *testing.T, h http.Handler, c *http.Cookie, query string) napSearchPage {
	t.Helper()
	var p napSearchPage
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/nap/records"+query, "").Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestNapSearchShowsSleepAndWakeRowsWithSleepTemperature(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	var sleptAt, wokeAt, date string
	if err := a.db.QueryRow(`SELECT n.slept_at, n.woke_at, s.session_date FROM t_nap_sleep n
		JOIN t_nap_session s ON s.nap_session_id = n.nap_session_id WHERE n.nap_sleep_id = 8`).
		Scan(&sleptAt, &wokeAt, &date); err != nil {
		t.Fatal(err)
	}

	p := searchNap(t, h, admin, "?from="+date+"&to="+date+"&class_id=1")
	sleepIdx, wakeIdx := -1, -1
	for i, r := range p.Rows {
		if r.NapSleepID == nil || *r.NapSleepID != 8 {
			continue
		}
		switch r.Kind {
		case "sleep":
			sleepIdx = i
			if r.CheckedAt != sleptAt || r.SleepTemperature == nil || *r.SleepTemperature != 36.5 {
				t.Fatalf("ねたの行に、押した時刻と入眠時の体温が出ていません: %+v", r)
			}
			if r.NapRecordID != nil || r.SavedAt != nil || r.BodyPosition != nil || r.Temperature != nil {
				t.Fatalf("ねたの行に確認の値が入っています: %+v", r)
			}
			if r.ChildID != "C001" || r.StaffName == "" || r.ClassName == "" || r.SessionDate != date {
				t.Fatalf("ねたの行の園児・記録者・クラス・日付が正しくありません: %+v", r)
			}
		case "wake":
			wakeIdx = i
			if r.CheckedAt != wokeAt || r.SleepTemperature != nil || r.StaffName == "" {
				t.Fatalf("おきたの行は、おきた時刻と記録者を出し、入眠時の体温を出しません: %+v", r)
			}
		default:
			t.Fatalf("ねた・おきたの行の種類が正しくありません: %+v", r)
		}
	}
	if sleepIdx < 0 || wakeIdx < 0 {
		t.Fatalf("ねた・おきたの行がありません: %+v", p.Rows)
	}
	// 新しい順。おきたはねたより上に出る
	if wakeIdx > sleepIdx {
		t.Fatalf("おきたの行が、ねたの行より下にあります（おきた %d、ねた %d）", wakeIdx, sleepIdx)
	}
	for i := 1; i < len(p.Rows); i++ {
		if p.Rows[i-1].CheckedAt < p.Rows[i].CheckedAt {
			t.Fatalf("時刻の新しい順になっていません: %s のあとに %s", p.Rows[i-1].CheckedAt, p.Rows[i].CheckedAt)
		}
	}
}

func TestNapSearchSleepRowsFollowFiltersAndScope(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	kubota := loginAs(a, 5, "staff") // ひまわり組。さくら組の C001 は見えない

	has := func(p napSearchPage, sleepID int64) bool {
		for _, r := range p.Rows {
			if r.NapSleepID != nil && *r.NapSleepID == sleepID {
				return true
			}
		}
		return false
	}
	if !has(searchNap(t, h, admin, ""), 8) {
		t.Fatal("管理者の検索に、ねた・おきたの行が出ていません")
	}
	if has(searchNap(t, h, admin, "?class_id=2"), 8) {
		t.Fatal("クラスで絞っても、ほかのクラスのねた・おきたが出ています")
	}
	if has(searchNap(t, h, admin, "?child_name=存在しない名前"), 8) {
		t.Fatal("園児名で絞っても、ほかの園児のねた・おきたが出ています")
	}
	if has(searchNap(t, h, kubota, ""), 8) {
		t.Fatal("一般（保育士）に、ほかのクラスの園児のねた・おきたが出ています")
	}

	// 取り消した「ねた」は出さない
	if _, err := a.db.Exec(`UPDATE t_nap_sleep SET is_deleted = 1 WHERE nap_sleep_id = 8`); err != nil {
		t.Fatal(err)
	}
	if has(searchNap(t, h, admin, ""), 8) {
		t.Fatal("取り消したねた・おきたが出ています")
	}
}

// 午睡記録検索に「きょうは対象外」とその理由の行を出す（画面詳細図「午睡記録検索画面」(5-3) の項目6）。
// 帳票と同じ行。並びは時刻の新しい順（同じ時刻は、おきた・確認・ねた・対象外の順）。取り消した対象外は出さない
func TestNapSearchShowsExclusionRows(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	teacher := loginAs(a, 3, "staff") // さくら組の担任
	kubota := loginAs(a, 5, "staff")   // ひまわり組
	_, yesterday, _ := demoNapDates(t, a)
	var sleptAt string
	if err := a.db.QueryRow(`SELECT slept_at FROM t_nap_sleep WHERE nap_sleep_id = 8`).Scan(&sleptAt); err != nil {
		t.Fatal(err)
	}
	// 昨日の実施 2 に足す（デモの今日の対象外は、テストを夜中に回すと起動時に外れる）。
	// 遠藤 花子は「ねた」と同じ時刻にして並びを確かめる。村田 美咲は取り消したもの
	res, err := a.db.Exec(`INSERT INTO t_nap_exclusion (nap_session_id, child_id, reason, staff_id, is_deleted, created_at) VALUES
		(2, 'C002', '2', 'S003', 0, ?)`, sleptAt)
	if err != nil {
		t.Fatal(err)
	}
	exclusionID, _ := res.LastInsertId()
	if _, err := a.db.Exec(`INSERT INTO t_nap_exclusion (nap_session_id, child_id, reason, staff_id, is_deleted, created_at) VALUES
		(2, 'C004', '1', 'S003', 1, ?)`, yesterday+"T13:00:00"); err != nil {
		t.Fatal(err)
	}

	find := func(p napSearchPage, childID string) []int {
		idx := []int{}
		for i, r := range p.Rows {
			if r.Kind == "exclusion" && r.ChildID == childID {
				idx = append(idx, i)
			}
		}
		return idx
	}

	p := searchNap(t, h, admin, "?from="+yesterday+"&to="+yesterday+"&class_id=1")
	got := find(p, "C002")
	if len(got) != 1 {
		t.Fatalf("対象外の行が1行ではありません: %+v", p.Rows)
	}
	x := p.Rows[got[0]]
	if x.NapExclusionID == nil || *x.NapExclusionID != exclusionID || x.ExclusionReason == nil || *x.ExclusionReason != "2" ||
		x.CheckedAt != sleptAt || x.SessionDate != yesterday || x.StaffName != "鈴木 浩之" || x.ClassName != "さくら組" {
		t.Fatalf("対象外の行の値が正しくありません: %+v", x)
	}
	if x.NapRecordID != nil || x.NapSleepID != nil || x.SavedAt != nil || x.BodyPosition != nil ||
		x.Temperature != nil || x.SleepTemperature != nil {
		t.Fatalf("対象外の行に確認・ねたの値が入っています: %+v", x)
	}
	if len(find(p, "C004")) != 0 {
		t.Fatal("取り消した対象外が出ています")
	}
	// 同じ時刻の「ねた」（西田 太郎）より下に出る
	sleepIdx := -1
	for i, r := range p.Rows {
		if r.Kind == "sleep" && r.NapSleepID != nil && *r.NapSleepID == 8 {
			sleepIdx = i
		}
	}
	if sleepIdx < 0 || sleepIdx > got[0] {
		t.Fatalf("同じ時刻の行が、ねた・対象外の順になっていません（ねた %d、対象外 %d）", sleepIdx, got[0])
	}

	// 絞り込みと参照範囲は、ほかの行と同じ
	if len(find(searchNap(t, h, admin, "?class_id=2"), "C002")) != 0 {
		t.Fatal("クラスで絞っても、ほかのクラスの対象外が出ています")
	}
	if len(find(searchNap(t, h, admin, "?child_name=西田"), "C002")) != 0 {
		t.Fatal("園児名で絞っても、ほかの園児の対象外が出ています")
	}
	if len(find(searchNap(t, h, kubota, ""), "C002")) != 0 {
		t.Fatal("一般（保育士）に、ほかのクラスの園児の対象外が出ています")
	}
	if len(find(searchNap(t, h, teacher, ""), "C002")) != 1 {
		t.Fatal("担任に、自クラスの園児の対象外が出ていません")
	}
}

// ---- 帳票（GET /api/nap/report） ----

// demoNapDates は、デモの実施 1（今日）・2（昨日）・3（2日前）の日付を返す。デモの日付は起動日へずれる（seed_shift.go）
func demoNapDates(t *testing.T, a *app) (today, yesterday, twoDaysAgo string) {
	t.Helper()
	dateOf := func(id int) string {
		var d string
		if err := a.db.QueryRow(`SELECT session_date FROM t_nap_session WHERE nap_session_id = ?`, id).Scan(&d); err != nil {
			t.Fatal(err)
		}
		return d
	}
	return dateOf(1), dateOf(2), dateOf(3)
}

// napReportCSVFile は、帳票を CSV として読んだもの
type napReportCSVFile struct {
	raw       string
	header    []string
	rows       [][]string // 一覧の行
	abnormals  [][]string // 同じ期間の異常時の記録の行
	hasTitle   bool
	histories  [][]string // 末尾の修正の履歴の行
	hasHistory bool
}

// napReportOf は帳票を取り、BOM を外して CSV の行に分ける。200 でなければ止める
func napReportOf(t *testing.T, h http.Handler, c *http.Cookie, query string) napReportCSVFile {
	t.Helper()
	rec := request(t, h, c, "GET", "/api/nap/report"+query, "")
	expectStatus(t, rec, http.StatusOK)
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("Content-Type = %q", ct)
	}
	body := rec.Body.String()
	if !strings.HasPrefix(body, utf8BOM) {
		t.Fatal("先頭に BOM がありません（Excel で文字化けする）")
	}
	r := csv.NewReader(strings.NewReader(strings.TrimPrefix(body, utf8BOM)))
	r.FieldsPerRecord = -1
	records, err := r.ReadAll()
	if err != nil {
		t.Fatalf("CSV として読めません: %v\n%s", err, body)
	}
	f := napReportCSVFile{raw: body, header: records[0]}
	section := &f.rows
	for i := 1; i < len(records); i++ {
		if len(records[i]) == 1 && records[i][0] == napReportAbnormalTitle {
			f.hasTitle = true
			if i+1 >= len(records) || strings.Join(records[i+1], ",") != strings.Join(napReportAbnormalHeader, ",") {
				t.Fatalf("異常時の記録の見出しが正しくありません: %v", records[i:])
			}
			section = &f.abnormals
			i++
			continue
		}
		if len(records[i]) == 1 && records[i][0] == napReportHistoryTitle {
			f.hasHistory = true
			if i+1 >= len(records) || strings.Join(records[i+1], ",") != strings.Join(napReportHistoryHeader, ",") {
				t.Fatalf("修正の履歴の見出しが正しくありません: %v", records[i:])
			}
			section = &f.histories
			i++
			continue
		}
		*section = append(*section, records[i])
	}
	return f
}

func countNapExportLogs(t *testing.T, a *app) int {
	t.Helper()
	var n int
	if err := a.db.QueryRow(`SELECT COUNT(*) FROM t_operation_log
		WHERE function_type = '3' AND operation_type = '5'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestNapReportIsAdminOnly(t *testing.T) {
	a, h := newTestApp(t)
	today, _, twoDaysAgo := demoNapDates(t, a)
	q := "?from=" + twoDaysAgo + "&to=" + today + "&format=csv"

	// 一般（保育士。さくら組の担任）と保護者は 403。操作ログにも残さない
	for _, c := range []struct {
		name   string
		cookie *http.Cookie
	}{
		{"一般（保育士）", loginAs(a, 3, "staff")},
		{"保護者", loginAs(a, 6, "guardian")},
	} {
		rec := request(t, h, c.cookie, "GET", "/api/nap/report"+q, "")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%sが帳票を出せています: %d %s", c.name, rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "西田 太郎") {
			t.Fatalf("%sへの拒否の応答に、帳票の中身が入っています", c.name)
		}
	}
	if n := countNapExportLogs(t, a); n != 0 {
		t.Fatalf("拒否した出力が操作ログに %d 件残っています", n)
	}

	// 管理者は出せる
	f := napReportOf(t, h, loginAs(a, 1, "staff"), q)
	if strings.Join(f.header, ",") != "日付,チェック時刻,園児,クラス,体位,呼吸,顔色,体温,記録者,保存時刻,修正あり" {
		t.Fatalf("見出しが正しくありません: %v", f.header)
	}
	if len(f.rows) == 0 {
		t.Fatal("帳票に行がありません")
	}
}

func TestNapReportContents(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	today, yesterday, twoDaysAgo := demoNapDates(t, a)
	/*
	 * きょうは対象外は、昨日の実施 2 に足して確かめる。デモの今日の対象外（13:01）は、テストを夜中に回すと
	 * 起動した時刻より後になって外れる（db_contact.go の trimFutureDemoContacts）。取り消したものは出さない
	 */
	if _, err := a.db.Exec(`INSERT INTO t_nap_exclusion (nap_session_id, child_id, reason, staff_id, is_deleted, created_at) VALUES
		(2, 'C002', '2', 'S003', 0, ?), (2, 'C004', '1', 'S003', 1, ?)`,
		yesterday+"T13:00:00", yesterday+"T13:00:00"); err != nil {
		t.Fatal(err)
	}
	f := napReportOf(t, h, admin, "?from="+twoDaysAgo+"&to="+today+"&format=csv")

	find := func(pred func(r []string) bool) [][]string {
		out := [][]string{}
		for _, r := range f.rows {
			if pred(r) {
				out = append(out, r)
			}
		}
		return out
	}

	// 確認の行：チェックした時刻と保存時刻の両方を出す（デモの記録 1。今日の西田 太郎 13:20:00、保存 13:20:30）
	checks := find(func(r []string) bool { return r[2] == "西田 太郎" && strings.HasSuffix(r[1], "T13:20:00") })
	if len(checks) != 1 {
		t.Fatalf("確認の行が1行ではありません: %v", checks)
	}
	if c := checks[0]; c[0] != today || c[3] != "さくら組" || c[4] != "仰向け" || c[5] != "あり" || c[6] != "通常" ||
		c[7] != "36.6" || c[8] != "鈴木 浩之" || !strings.HasSuffix(c[9], "T13:20:30") {
		t.Fatalf("確認の行の値が正しくありません: %v", c)
	}

	// ねたの行：体温の列に入眠時の体温（デモの昨日の西田 太郎 36.5）。おきたの行は体温を出さない
	sleeps := find(func(r []string) bool { return r[2] == "西田 太郎" && r[4] == "入眠（ねた）" })
	if len(sleeps) != 1 || sleeps[0][0] != yesterday || sleeps[0][7] != "36.5" || sleeps[0][9] != "" {
		t.Fatalf("ねたの行が、入眠時の体温つきの1行になっていません: %v", sleeps)
	}
	wakes := find(func(r []string) bool { return r[2] == "西田 太郎" && r[4] == "起床（おきた）" })
	if len(wakes) != 1 || wakes[0][7] != "" {
		t.Fatalf("おきたの行が正しくありません: %v", wakes)
	}

	// きょうは対象外と理由。1行で出す（昨日の遠藤 花子は午睡なし）。取り消した対象外（昨日の村田 美咲）は出さない
	excluded := find(func(r []string) bool { return r[2] == "遠藤 花子" && r[0] == yesterday })
	if len(excluded) != 1 || excluded[0][1] != yesterday+"T13:00:00" || excluded[0][4] != "きょうは対象外（午睡なし）" ||
		excluded[0][5] != "" || excluded[0][7] != "" || excluded[0][8] != "鈴木 浩之" {
		t.Fatalf("対象外が理由つきの1行で出ていません: %v", excluded)
	}
	if cancelled := find(func(r []string) bool { return r[2] == "村田 美咲" && r[0] == yesterday }); len(cancelled) != 0 {
		t.Fatalf("取り消した対象外が出ています: %v", cancelled)
	}

	// 「修正あり」の列は置き、どの記録も修正していないあいだは空（修正したときは TestNapReportShowsCorrections）
	for _, r := range f.rows {
		if len(r) != len(napReportHeader) || r[10] != "" {
			t.Fatalf("「修正あり」の列が無いか、空ではありません: %v", r)
		}
	}
	// 実施の日 → クラス → 園児 → 時刻 の古い順（TestNapReportOrdersByDateClassChildTime）
	expectNapReportOrder(t, a, f.rows)

	// 異常時の記録：起票済み（記録 1。鈴木 健、日誌 3）はヒヤリハット側の状況・とった対応に印を付けて1行。
	// 記録そのものの文は出さない（二重に数えない）
	if !f.hasTitle || len(f.abnormals) != 2 {
		t.Fatalf("異常時の記録が2行ではありません: %v", f.abnormals)
	}
	raised := [][]string{}
	for _, r := range f.abnormals {
		if r[1] == "鈴木 健" {
			raised = append(raised, r)
		}
	}
	if len(raised) != 1 || raised[0][2] != "午睡中にうつ伏せの体位を確認した。" ||
		raised[0][3] != "仰向けに直し、呼吸と顔色を確認した。" || raised[0][5] != "起票済み" {
		t.Fatalf("起票済みの記録が、ヒヤリハット側の文の1行になっていません: %v", raised)
	}
	if strings.Contains(f.raw, "うつ伏せの体位で寝ているのを発見") {
		t.Fatal("起票済みの記録が、記録そのものの文でも出ています（二重に数えている）")
	}
	// 起票していない記録 2（久保田 陸。昨日）は、記録そのものの文に「未起票」。実施の日の古い順で、2日前の鈴木 健のあと
	notRaised := f.abnormals[1]
	if f.abnormals[0][1] != "鈴木 健" || notRaised[1] != "久保田 陸" || notRaised[2] != "顔色がやや紅潮していた。体温37.4度。" ||
		notRaised[5] != "未起票" {
		t.Fatalf("起票していない記録が正しくありません: %v", f.abnormals)
	}
}

/*
expectNapReportOrder は、帳票の一覧の行が 実施の日 → クラス（番号の順）→ 園児（よみの順）→ 時刻 の古い順に
並んでいることを確かめる。クラスと園児は、帳票に出る名前からデモデータの番号とよみを引く
*/
func expectNapReportOrder(t *testing.T, a *app, rows [][]string) {
	t.Helper()
	type key struct {
		date    string
		classID int64
		kana    string
		at      string
	}
	keyOf := func(r []string) key {
		k := key{date: r[0], at: r[1]}
		if err := a.db.QueryRow(`SELECT MIN(class_id) FROM m_class WHERE class_name = ?`, r[3]).Scan(&k.classID); err != nil {
			t.Fatal(err)
		}
		if err := a.db.QueryRow(`SELECT child_name_kana FROM m_child WHERE child_name = ?`, r[2]).Scan(&k.kana); err != nil {
			t.Fatal(err)
		}
		return k
	}
	for i := 1; i < len(rows); i++ {
		p, c := keyOf(rows[i-1]), keyOf(rows[i])
		ok := true
		switch {
		case p.date != c.date:
			ok = p.date < c.date
		case p.classID != c.classID:
			ok = p.classID < c.classID
		case p.kana != c.kana:
			ok = p.kana < c.kana
		default:
			ok = p.at <= c.at
		}
		if !ok {
			t.Fatalf("実施の日 → クラス → 園児 → 時刻 の古い順になっていません: %v のあとに %v", rows[i-1], rows[i])
		}
	}
}

/*
帳票の一覧は、実施の日 → クラス → 園児 → 時刻 の古い順（2026-10-19、持ち主が任せて決めた）。監査では、1人の子の確認が
間隔どおりかを時刻の順に読むため。画面の一覧（GET /api/nap/records）は時刻の新しい順のまま。
同じ園児の同じ時刻は、ねた・確認・おきたの順（寝ている間の確認を、ねたより下・おきたより上に置く）
*/
func TestNapReportOrdersByDateClassChildTime(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	today, yesterday, _ := demoNapDates(t, a)
	/*
	 * 昨日の実施 2（さくら組）に、西田 太郎（にしだ）の確認を ねた（13:02）・おきた（14:35）と同じ時刻とその間に足し、
	 * 伊藤 葵（いとう）の確認を西田 太郎のどの確認よりも後の時刻に足す。今日の実施 4（ひまわり組）に、井上 空の確認を
	 * さくら組の確認（13:20〜）より前の時刻に足す
	 */
	add := func(session int, child, at string) {
		t.Helper()
		if _, err := a.db.Exec(`INSERT INTO t_nap_record (nap_session_id, child_id, checked_at, saved_at, body_position,
			breathing, complexion, temperature, staff_id) VALUES (?, ?, ?, ?, '1', '1', '1', NULL, 'S003')`,
			session, child, at, at); err != nil {
			t.Fatal(err)
		}
	}
	add(2, "C001", yesterday+"T14:35:00")
	add(2, "C001", yesterday+"T13:20:00")
	add(2, "C001", yesterday+"T13:02:00")
	add(2, "C006", yesterday+"T14:50:00")
	add(4, "C013", today+"T13:15:00")

	f := napReportOf(t, h, admin, "?from="+yesterday+"&to="+today)
	expectNapReportOrder(t, a, f.rows)

	indexOf := func(date, child string) []int {
		out := []int{}
		for i, r := range f.rows {
			if r[0] == date && r[2] == child {
				out = append(out, i)
			}
		}
		return out
	}
	// 同じ日・同じクラスでは、時刻が後でも、よみが先の園児（いとう）を先に出す
	ito, nishida := indexOf(yesterday, "伊藤 葵"), indexOf(yesterday, "西田 太郎")
	if len(ito) != 1 || len(nishida) == 0 || ito[0] > nishida[0] {
		t.Fatalf("園児のよみの順になっていません（伊藤 葵 %v、西田 太郎 %v）", ito, nishida)
	}
	// 1人の子の行は時刻の古い順。同じ時刻は、ねた・確認・おきた
	got := []string{}
	for _, i := range nishida {
		got = append(got, f.rows[i][1][11:]+" "+f.rows[i][4])
	}
	want := []string{"13:02:00 入眠（ねた）", "13:02:00 仰向け", "13:20:00 仰向け", "14:35:00 仰向け", "14:35:00 起床（おきた）"}
	if strings.Join(got, "、") != strings.Join(want, "、") {
		t.Fatalf("昨日の西田 太郎の行 = %v、want %v", got, want)
	}
	// 同じ日では、時刻が前でも、番号の後のクラス（ひまわり組）をさくら組のあとに出す
	if last := f.rows[len(f.rows)-1]; last[0] != today || last[2] != "井上 空" || last[3] != "ひまわり組" {
		t.Fatalf("今日のひまわり組の行が、さくら組のあとに出ていません: %v", last)
	}
	if len(indexOf(today, "西田 太郎")) == 0 {
		t.Fatal("今日のさくら組の行がありません（並びを確かめられない）")
	}

	// 画面の一覧（午睡記録検索）は時刻の新しい順のまま
	p := searchNap(t, h, admin, "?from="+yesterday+"&to="+today)
	for i := 1; i < len(p.Rows); i++ {
		if p.Rows[i-1].CheckedAt < p.Rows[i].CheckedAt {
			t.Fatalf("画面の一覧が時刻の新しい順になっていません: %s のあとに %s", p.Rows[i-1].CheckedAt, p.Rows[i].CheckedAt)
		}
	}
}

/*
帳票の「同じ期間の異常時の記録」の表も、一覧の行と同じ向きで、つないだ実施の日 → クラス → 園児 → 発見時刻 の古い順
（2026-10-19、持ち主が任せて決めた）。監査では1つのファイルを時刻の順に読み、表ごとに向きが違うと読み違えるため。
異常時記録画面の一覧（GET /api/nap/abnormals）は新しい順のまま
*/
func TestNapReportOrdersAbnormalsByDateClassChildTime(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	today, yesterday, twoDaysAgo := demoNapDates(t, a)
	/*
	 * デモ：記録 1（2日前・さくら組・鈴木 健 13:40）、記録 2（昨日・さくら組・久保田 陸 14:10）。
	 * 昨日に、久保田 陸の 13:50 と、よみが後（にしだ）で発見時刻が前の西田 太郎の 13:30 を足す。
	 * 今日に、さくら組の伊藤 葵 13:45 と、発見時刻が前のひまわり組の井上 空 13:15 を足す
	 */
	add := func(session int, child, foundAt string) {
		t.Helper()
		if _, err := a.db.Exec(`INSERT INTO t_nap_abnormal (nap_session_id, child_id, found_at, recorded_at, situation,
			response, staff_id, diary_id) VALUES (?, ?, ?, ?, '状況', '対応', 'S003', NULL)`,
			session, child, foundAt, foundAt); err != nil {
			t.Fatal(err)
		}
	}
	add(2, "C005", yesterday+"T13:50:00")
	add(2, "C001", yesterday+"T13:30:00")
	add(1, "C006", today+"T13:45:00")
	add(4, "C013", today+"T13:15:00")

	f := napReportOf(t, h, admin, "?from="+twoDaysAgo+"&to="+today)
	got := []string{}
	for _, r := range f.abnormals {
		got = append(got, r[0]+" "+r[1])
	}
	want := []string{
		twoDaysAgo + "T13:40:00 鈴木 健",
		yesterday + "T13:50:00 久保田 陸", yesterday + "T14:10:00 久保田 陸",
		yesterday + "T13:30:00 西田 太郎",
		today + "T13:45:00 伊藤 葵",
		today + "T13:15:00 井上 空",
	}
	if strings.Join(got, "、") != strings.Join(want, "、") {
		t.Fatalf("異常時の記録の並び = %v、want %v", got, want)
	}

	// 異常時記録画面の一覧は発見時刻の新しい順のまま
	var list []struct {
		FoundAt string `json:"found_at"`
	}
	decode(t, call(t, h, admin, "GET", "/api/nap/abnormals", ""), &list)
	for i := 1; i < len(list); i++ {
		if list[i-1].FoundAt < list[i].FoundAt {
			t.Fatalf("異常時の記録の一覧が新しい順になっていません: %s のあとに %s", list[i-1].FoundAt, list[i].FoundAt)
		}
	}
}

func TestNapReportFollowsPeriodAndClass(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	today, yesterday, _ := demoNapDates(t, a)

	// 昨日だけ：昨日のねた・おきたと異常時の記録 2 は出し、今日の対象外と2日前の異常時の記録 1 は出さない
	f := napReportOf(t, h, admin, "?from="+yesterday+"&to="+yesterday)
	if len(f.rows) == 0 {
		t.Fatal("昨日の行がありません")
	}
	for _, r := range f.rows {
		if r[0] != yesterday {
			t.Fatalf("期間の外の行が出ています: %v", r)
		}
	}
	if len(f.abnormals) != 1 || f.abnormals[0][1] != "久保田 陸" {
		t.Fatalf("期間の異常時の記録だけになっていません: %v", f.abnormals)
	}

	// ひまわり組だけ：さくら組の園児の行と異常時の記録は出さない
	g := napReportOf(t, h, admin, "?from="+yesterday+"&to="+today+"&class_id=2")
	for _, r := range g.rows {
		if r[3] != "ひまわり組" {
			t.Fatalf("ほかのクラスの行が出ています: %v", r)
		}
	}
	if g.hasTitle || len(g.abnormals) != 0 {
		t.Fatalf("ほかのクラスの異常時の記録が出ています: %v", g.abnormals)
	}
}

func TestNapReportLogsPeriodAndCountCountedByServer(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	today, _, twoDaysAgo := demoNapDates(t, a)

	latest := func() (accountID int64, table, after string) {
		t.Helper()
		if err := a.db.QueryRow(`SELECT account_id, target_table, after_value FROM t_operation_log
			WHERE function_type = '3' AND operation_type = '5' ORDER BY operation_log_id DESC LIMIT 1`).
			Scan(&accountID, &table, &after); err != nil {
			t.Fatal(err)
		}
		return
	}

	// 画面から件数を送っても使わない。件数は帳票に出した行（一覧の行と異常時の記録）をサーバが数える
	f := napReportOf(t, h, admin, "?from="+twoDaysAgo+"&to="+today+"&count=1")
	count := len(f.rows) + len(f.abnormals)
	if count < 10 {
		t.Fatalf("デモの期間の行が少なすぎます（%d 件）", count)
	}
	accountID, table, after := latest()
	want := "午睡記録をCSV出力（期間 " + twoDaysAgo + "〜" + today + "・すべてのクラス・" + strconv.Itoa(count) + " 件）"
	if accountID != 1 || table != "t_nap_record" || after != want {
		t.Fatalf("操作ログ = (%d, %s, %q)、want (1, t_nap_record, %q)", accountID, table, after, want)
	}

	g := napReportOf(t, h, admin, "?from="+today+"&to="+today+"&class_id=1")
	want = "午睡記録をCSV出力（期間 " + today + "〜" + today + "・さくら組・" + strconv.Itoa(len(g.rows)+len(g.abnormals)) + " 件）"
	if _, _, after := latest(); after != want {
		t.Fatalf("クラスを指定した出力の操作ログ = %q、want %q", after, want)
	}
}

/*
画面が申告する出力の記録（POST /api/exports）は、午睡記録を受け付けない。帳票を作るこの経路だけが記録する。
受け付けると、出力していない「午睡記録をCSV出力」を一般の職員も書けて、監査の記録が信用できなくなる
（web/tests/admin.test.ts の「午睡記録の出力は、画面からの申告では記録しない」と同じ）
*/
func TestRecordExportRejectsNapRecord(t *testing.T) {
	a, h := newTestApp(t)
	for _, c := range []struct {
		name   string
		cookie *http.Cookie
	}{
		{"一般（保育士）", loginAs(a, 3, "staff")},
		{"管理者", loginAs(a, 1, "staff")},
	} {
		rec := request(t, h, c.cookie, "POST", "/api/exports",
			`{"kind":"nap_record","from":"2026-09-01","to":"2026-09-30","count":8}`)
		expectStatus(t, rec, http.StatusBadRequest)
		var e apiError
		if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e.Message != "出力の種別が正しくありません" {
			t.Fatalf("%s: 文言 = %q（%v）", c.name, e.Message, err)
		}
	}
	if n := countNapExportLogs(t, a); n != 0 {
		t.Fatalf("申告だけの午睡記録の出力が操作ログに %d 件残っています", n)
	}
}

func TestNapReportRejectsPdfAndBadInput(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	today, _, twoDaysAgo := demoNapDates(t, a)
	period := "from=" + twoDaysAgo + "&to=" + today

	cases := []struct{ name, query, message string }{
		// 【仮置き】PDF は作らない（PDF のライブラリと日本語の字体を入れるかを持ち主が決める）
		{"PDF", "?" + period + "&format=pdf", msgNapReportPdf},
		{"知らない形式", "?" + period + "&format=xlsx", msgNapReportFormat},
		{"期間が無い", "?format=csv", msgNapReportPeriod},
		{"崩れた日付", "?from=2026-9-1&to=" + today, msgNapReportPeriod},
		{"開始が終了より後", "?from=" + today + "&to=" + twoDaysAgo, msgNapReportRange},
		{"崩れたクラス", "?" + period + "&class_id=abc", msgNapReportClass},
	}
	for _, c := range cases {
		rec := request(t, h, admin, "GET", "/api/nap/report"+c.query, "")
		expectStatus(t, rec, http.StatusBadRequest)
		var e apiError
		if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil || e.Message != c.message {
			t.Fatalf("%s: 文言 = %q（%v）、want %q", c.name, e.Message, err, c.message)
		}
	}
	if n := countNapExportLogs(t, a); n != 0 {
		t.Fatalf("出力しなかった要求が操作ログに %d 件残っています", n)
	}
}

func TestNapReportUsesIncidentSideAndEscapesFormula(t *testing.T) {
	a, h := newTestApp(t)
	admin := loginAs(a, 1, "staff")
	today, _, twoDaysAgo := demoNapDates(t, a)
	q := "?from=" + twoDaysAgo + "&to=" + today
	raisedRow := func(f napReportCSVFile) []string {
		t.Helper()
		for _, r := range f.abnormals {
			if r[1] == "鈴木 健" {
				return r
			}
		}
		t.Fatalf("起票済みの記録がありません: %v", f.abnormals)
		return nil
	}

	// ヒヤリハットの本文を直したら、直したあとの日誌の側を出す（集計・監査はヒヤリハット側を正とする）
	if _, err := a.db.Exec(`UPDATE t_diary SET body = ? WHERE diary_id = 3`,
		"【発生日時】\r\n13時40分\r\n\r\n【発生場所】\r\nさくら組の午睡室\r\n\r\n【状況】\r\n直した状況。\r\n2行目。\r\n\r\n【とった対応】\r\n直した対応。\r\n\r\n【今後の対策】\r\n5分ごとに確かめる。"); err != nil {
		t.Fatal(err)
	}
	if r := raisedRow(napReportOf(t, h, admin, q)); r[2] != "直した状況。\n2行目。" || r[3] != "直した対応。" || r[5] != "起票済み" {
		t.Fatalf("直したあとのヒヤリハットの文が出ていません: %v", r)
	}

	// 日誌が削除されていれば、記録そのものの文を出す（印は起票済みのまま）
	if _, err := a.db.Exec(`UPDATE t_diary SET is_deleted = 1 WHERE diary_id = 3`); err != nil {
		t.Fatal(err)
	}
	if r := raisedRow(napReportOf(t, h, admin, q)); r[2] != "うつ伏せの体位で寝ているのを発見。呼吸あり、顔色は通常。" || r[5] != "起票済み" {
		t.Fatalf("日誌が無いときに記録そのものの文が出ていません: %v", r)
	}

	// 式の始まりになる文字で始まるセルは ' を付けて文字列として開かせる。" は二重にする（GitHub Issue #153 と同じ）
	if _, err := a.db.Exec(`UPDATE t_nap_abnormal SET situation = ?, response = ? WHERE nap_abnormal_id = 2`,
		`=HYPERLINK("http://example.invalid")`, `@SUM(1+1)`); err != nil {
		t.Fatal(err)
	}
	f := napReportOf(t, h, admin, q)
	if !strings.Contains(f.raw, `"'=HYPERLINK(""http://example.invalid"")","'@SUM(1+1)"`) {
		t.Fatalf("式として開かれうるセルを逃がしていません:\n%s", f.raw)
	}
}

// 異常時の記録の一覧は、起票したヒヤリハットの文を返さない。一般（保育士）もこの一覧を読めるため、
// 日誌を開けるかどうかと関わりなく日誌の本文が読めてしまう。ヒヤリハット側の文は帳票（管理者だけ）が出す
func TestNapAbnormalsDoNotReturnIncidentText(t *testing.T) {
	a, h := newTestApp(t)
	for _, c := range []*http.Cookie{loginAs(a, 1, "staff"), loginAs(a, 3, "staff")} {
		rec := call(t, h, c, "GET", "/api/nap/abnormals", "")
		var all []map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &all); err != nil {
			t.Fatal(err)
		}
		if len(all) == 0 {
			t.Fatal("異常時の記録がありません")
		}
		for _, x := range all {
			if _, has := x["incident_situation"]; has {
				t.Fatalf("incident_situation を返しています: %v", x)
			}
			if _, has := x["incident_response"]; has {
				t.Fatalf("incident_response を返しています: %v", x)
			}
		}
		if body := rec.Body.String(); strings.Contains(body, "午睡中にうつ伏せの体位を確認した。") {
			t.Fatalf("ヒヤリハットの本文を返しています: %s", body)
		}
	}
}

func TestIncidentSituationResponse(t *testing.T) {
	cases := []struct {
		name, body, situation, response string
	}{
		{"起票したままの本文", "【発生日時】\n2026-09-01 13:40:00\n\n【状況】\nうつ伏せ\n\n【とった対応】\n仰向けに直した\n\n【今後の対策】\n", "うつ伏せ", "仰向けに直した"},
		{"雛形の見出し（発生場所）を挟む", "【発生日時】\n\n【発生場所】\n午睡室\n\n【状況】\nA\n\n【とった対応】\nB", "A", "B"},
		{"見出しが無い", "自由に書いた本文", "", ""},
		{"文の中の【】は見出しにしない", "【状況】\n【注意】のあと泣いた。\n【とった対応】\n抱いた", "【注意】のあと泣いた。", "抱いた"},
	}
	for _, c := range cases {
		s, r := incidentSituationResponse(c.body)
		if s != c.situation || r != c.response {
			t.Errorf("%s: 状況=%q 対応=%q（期待 %q・%q）", c.name, s, r, c.situation, c.response)
		}
	}
}
