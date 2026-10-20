package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

/*
成長の記録（詳細設計書「成長の記録」(4-12 (1))・「成長の記録に届くもの」(3-7)・「テストの観点」(9-1) の成長の記録の行）。
モックの同じ観点は web/tests/growth.test.ts にある。判定の表（growthAccessCases）は同じ行にする（9-2）。

Go のテストは本物の時計で動く。今日の連絡帳の行がデモデータに残っていることを当てにせず、
「成長の記録に残す」の行はテストの中で前の日の日付で入れる（詳細設計書「時計」(9-3)）。
*/

type growthResp struct {
	ChildID       string  `json:"child_id"`
	ChildName     string  `json:"child_name"`
	Sex           string  `json:"sex"`
	BirthDate     string  `json:"birth_date"`
	GraceEndsOn   *string `json:"grace_ends_on"`
	SharePhysical bool    `json:"share_physical"`
	Measurements  []struct {
		ID          int64   `json:"physical_record_id"`
		MeasuredOn  string  `json:"measured_on"`
		AgeInMonths int     `json:"age_in_months"`
		HeightCm    float64 `json:"height_cm"`
		WeightKg    float64 `json:"weight_kg"`
		IsToday     bool    `json:"is_today"`
	} `json:"measurements"`
	Achievements []struct {
		Kind               string   `json:"kind"`
		At                 string   `json:"at"`
		Date               string   `json:"date"`
		IsToday            bool     `json:"is_today"`
		Items              []string `json:"items"`
		Message            *string  `json:"message"`
		MessageCorrectedAt *string  `json:"message_corrected_at"`
		Body               *string  `json:"body"`
		ContactPhotoID     *int64   `json:"contact_photo_id"`
	} `json:"achievements"`
	NextBefore *string `json:"next_before"`
	Disclaimer string  `json:"disclaimer"`
}

func readGrowth(t *testing.T, h http.Handler, c *http.Cookie, path string) (growthResp, string) {
	t.Helper()
	rec := call(t, h, c, "GET", path, "")
	var g growthResp
	if err := json.Unmarshal(rec.Body.Bytes(), &g); err != nil {
		t.Fatalf("応答を読めません: %v %s", err, rec.Body.String())
	}
	return g, rec.Body.String()
}

// growthAccessCases は「利用者・園児 → 成長の記録を読めるか」の表。web/tests/growth.test.ts の同じ名前の表と同じ行にする
var growthAccessCases = []struct {
	name    string
	account int64
	child   string
	ok      bool
}{
	{"保護者は紐づけた自児", accGuardian, "C001", true},
	{"保護者はほかの家庭の園児を読めない", accGuardian, "C004", false},
	{"ほかの家庭の保護者は野原 太郎を読めない", accOtherGuard, "C001", false},
	{"保護者は無い園児を読めない", accGuardian, "C999", false},
	{"さくら組の担任は自クラスの園児", accTeacher, "C001", true},
	{"ひまわり組の担任はさくら組の園児を読めない", accOtherTeacher, "C001", false},
	{"管理者は全園児", accAdmin, "C013", true},
}

func TestGrowthAccess(t *testing.T) {
	a, h := newTestApp(t)
	for _, c := range growthAccessCases {
		entrance := "staff"
		if c.account == accGuardian || c.account == accOtherGuard {
			entrance = "guardian"
		}
		rec := request(t, h, loginAs(a, c.account, entrance), "GET", "/api/children/"+c.child+"/growth", "")
		if c.ok && rec.Code != http.StatusOK {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body.String())
		}
		if !c.ok && (rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), msgGrowthForbidden)) {
			t.Errorf("%s: %d %s, want 403 %s", c.name, rec.Code, rec.Body.String(), msgGrowthForbidden)
		}
	}
	// 形の崩れた before は 400
	guardian := loginAs(a, accGuardian, "guardian")
	expectStatus(t, request(t, h, guardian, "GET", "/api/children/C001/growth?before=2026-13-01", ""), http.StatusBadRequest)

	// 猶予中は読める（期限を返す）。紐づけより前の記録も読める（linked_at で切らない）
	grace := daysFromToday(20)
	a.db.Exec(`UPDATE t_guardian_child SET link_status = '3', grace_ends_on = ?, linked_at = ? WHERE guardian_id = 'G001'`, grace, now())
	g, _ := readGrowth(t, h, guardian, "/api/children/C001/growth")
	if g.GraceEndsOn == nil || *g.GraceEndsOn != grace {
		t.Errorf("猶予中の期限: %v, want %s", g.GraceEndsOn, grace)
	}
	if len(g.Measurements) == 0 || len(g.Achievements) == 0 {
		t.Errorf("紐づけより前の記録が読めない: %+v", g)
	}
	// 紐づけを終えたら読めない（デモの紐づけを終えた保護者はアカウントが止まっているため、同じ保護者の紐づけを終えて確かめる）
	a.db.Exec(`UPDATE t_guardian_child SET link_status = '2', ended_at = ? WHERE guardian_id = 'G001'`, now())
	if body := expectStatus(t, request(t, h, guardian, "GET", "/api/children/C001/growth", ""), http.StatusForbidden); !strings.Contains(body, msgGrowthForbidden) {
		t.Errorf("紐づけを終えた保護者: %s", body)
	}
}

// 届くもの（3-7）：確定した「確認できた」のうち共有する項目と保護者へのひとことだけ。測った値は全件・新しい順
func TestGrowthRecordContents(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")

	g, body := readGrowth(t, h, guardian, "/api/children/C001/growth")
	if g.ChildName != "野原 太郎" || !g.SharePhysical || !strings.Contains(g.Disclaimer, "判定・診断を行うものではありません") {
		t.Errorf("見出し・共有・免責: %+v", g)
	}
	// 測った値：C001 の3件を新しい順に。デモの今日の測定（09-01 に置いた行）は「きょう」
	if len(g.Measurements) != 3 {
		t.Fatalf("測った値の件数 = %d, want 3: %s", len(g.Measurements), body)
	}
	for i := 1; i < len(g.Measurements); i++ {
		if g.Measurements[i-1].MeasuredOn < g.Measurements[i].MeasuredOn {
			t.Errorf("測った値が新しい順でない: %+v", g.Measurements)
		}
	}
	if !g.Measurements[0].IsToday || g.Measurements[1].IsToday {
		t.Errorf("きょうの印: %+v", g.Measurements)
	}
	var birth string
	a.db.QueryRow(`SELECT birth_date FROM m_child WHERE child_id = 'C001'`).Scan(&birth)
	if got, want := g.Measurements[0].AgeInMonths, ageInMonths(birth, g.Measurements[0].MeasuredOn); got != want {
		t.Errorf("月齢 = %d, want %d", got, want)
	}

	// できたこと：デモの確定（C001・1件目）は「確認できた」の2項目とひとこと。「一部」「未確認」の項目・所見は返らない
	var dev []string
	var message string
	for _, e := range g.Achievements {
		if e.Kind == "development" {
			dev = e.Items
			if e.Message != nil {
				message = *e.Message
			}
		}
	}
	if strings.Join(dev, "・") != "つかまり立ちをする・伝い歩きをする" {
		t.Errorf("確認できた項目 = %v", dev)
	}
	if message == "" {
		t.Errorf("保護者へのひとことが無い: %s", body)
	}
	a.db.Exec(`UPDATE t_development_check SET note = '所見のひみつ' WHERE development_check_id = 1`)
	_, body = readGrowth(t, h, guardian, "/api/children/C001/growth")
	for _, hidden := range []string{"所見のひみつ", "パパ", "自分でやりたい", "note", "staff", "development_check_id", "development_item_id", "share_status", "やせ", "標準", "遅れ"} {
		if strings.Contains(body, hidden) {
			t.Errorf("保護者の応答に %s が入っている: %s", hidden, body)
		}
	}

	// 項目を「共有しない」にすると、次に開いたときから出ない
	a.db.Exec(`UPDATE m_share_setting SET is_shareable = 0 WHERE development_item_id = 142`)
	g, _ = readGrowth(t, h, guardian, "/api/children/C001/growth")
	for _, e := range g.Achievements {
		if e.Kind == "development" && strings.Join(e.Items, "・") != "つかまり立ちをする" {
			t.Errorf("共有しない項目が出ている: %v", e.Items)
		}
	}

	// 下書きは返らない（ひとことがあっても）
	a.db.Exec(`INSERT INTO t_development_check (child_id, checked_on, status, staff_id, share_status, guardian_message)
		VALUES ('C001', ?, '1', 'S003', '1', '下書きのひとこと')`, daysFromToday(-2))
	if _, body = readGrowth(t, h, guardian, "/api/children/C001/growth"); strings.Contains(body, "下書きのひとこと") {
		t.Errorf("下書きが返っている: %s", body)
	}
	// 確定でも、届くもの（共有する「確認できた」・ひとこと）が無ければ件数に数えない
	a.db.Exec(`INSERT INTO t_development_check (child_id, checked_on, status, staff_id, share_status, finalized_at)
		VALUES ('C001', ?, '2', 'S003', '1', ?)`, daysFromToday(-3), daysFromToday(-3)+"T16:00:00")
	g, _ = readGrowth(t, h, guardian, "/api/children/C001/growth")
	devCount := 0
	for _, e := range g.Achievements {
		if e.Kind == "development" {
			devCount++
		}
	}
	if devCount != 1 {
		t.Errorf("届くもの無しの確定が出ている: %+v", g.Achievements)
	}

	// 身体測定を共有しないにすると、測った値は空（区画ごと出さない）
	a.db.Exec(`UPDATE m_setting SET setting_value = '0' WHERE setting_key = 'growth.share_physical'`)
	g, _ = readGrowth(t, h, guardian, "/api/children/C001/growth")
	if g.SharePhysical || len(g.Measurements) != 0 {
		t.Errorf("共有しない身体測定が出ている: %+v", g.Measurements)
	}
}

// 「成長の記録に残す」を付けた連絡帳の行：取り消したもの・出す項目から外した種類は出ない（3-7、決めたこと D-30）
func TestGrowthRecordFromContact(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")
	day := daysFromToday(-1)
	insert := func(body string, keep, deleted int) {
		if _, err := a.db.Exec(`INSERT INTO t_contact_event (child_id, class_id, contact_date, event_type, recorded_at, body,
			keep_in_growth, staff_id, is_deleted, created_at, updated_at) VALUES ('C001', 1, ?, '4', ?, ?, ?, 'S003', ?, ?, ?)`,
			day, day+"T10:00:00", body, keep, deleted, day+"T10:00:00", day+"T10:00:00"); err != nil {
			t.Fatal(err)
		}
	}
	insert("残したひとこと", 1, 0)
	insert("残していないひとこと", 0, 0)
	insert("取り消したひとこと", 1, 1)

	_, body := readGrowth(t, h, guardian, "/api/children/C001/growth")
	if !strings.Contains(body, "残したひとこと") || strings.Contains(body, "残していないひとこと") || strings.Contains(body, "取り消したひとこと") {
		t.Errorf("連絡帳から残したもの: %s", body)
	}
	g, _ := readGrowth(t, h, guardian, "/api/children/C001/growth")
	for _, e := range g.Achievements {
		if e.Kind == "contact" && e.Body != nil && *e.Body == "残したひとこと" && (e.Date != day || e.IsToday) {
			t.Errorf("連絡帳から残した行の日付・きょうの印: %+v", e)
		}
	}
	// ひとことを出す項目から外すと、成長の記録の側からも見えない
	a.db.Exec(`UPDATE m_setting SET setting_value = 'nap,meal,toilet,temperature,photo,class' WHERE setting_key = 'contact.show_items'`)
	if _, body = readGrowth(t, h, guardian, "/api/children/C001/growth"); strings.Contains(body, "残したひとこと") {
		t.Errorf("出す項目から外したひとことが出ている: %s", body)
	}
}

// 12件ずつ。next_before で続きを読み、重ならず漏れない（4-12 (1)）
func TestGrowthRecordPaging(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")
	a.db.Exec(`UPDATE t_contact_event SET keep_in_growth = 0`)
	for i := 1; i <= 14; i++ {
		day := daysFromToday(-i)
		a.db.Exec(`INSERT INTO t_contact_event (child_id, class_id, contact_date, event_type, recorded_at, body,
			keep_in_growth, staff_id, created_at, updated_at) VALUES ('C001', 1, ?, '4', ?, ?, 1, 'S003', ?, ?)`,
			day, day+"T09:00:00", fmt.Sprintf("ページの行%02d", i), day+"T09:00:00", day+"T09:00:00")
	}
	// デモの発達チェック（1件）と合わせて 15 件
	first, _ := readGrowth(t, h, guardian, "/api/children/C001/growth")
	if len(first.Achievements) != 12 || first.NextBefore == nil {
		t.Fatalf("1ページ目: %d 件 next=%v", len(first.Achievements), first.NextBefore)
	}
	for i := 1; i < len(first.Achievements); i++ {
		if first.Achievements[i-1].At < first.Achievements[i].At {
			t.Errorf("新しい順でない: %s < %s", first.Achievements[i-1].At, first.Achievements[i].At)
		}
	}
	if *first.NextBefore != first.Achievements[11].At {
		t.Errorf("next_before = %s, want 12件目の %s", *first.NextBefore, first.Achievements[11].At)
	}
	second, _ := readGrowth(t, h, guardian, "/api/children/C001/growth?before="+*first.NextBefore)
	if len(second.Achievements) != 3 || second.NextBefore != nil {
		t.Errorf("2ページ目: %d 件 next=%v", len(second.Achievements), second.NextBefore)
	}
	if len(second.Measurements) != len(first.Measurements) {
		t.Errorf("測った値は before に左右されず毎回全件: %d / %d", len(second.Measurements), len(first.Measurements))
	}
}

// 確定したときに finalized_at を入れ、確定し直しても動かさない（3-7、決めたこと D-31）
func TestDevelopmentFinalizedAt(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	day := daysFromToday(-1)
	save := func(status string) {
		call(t, h, teacher, "POST", "/api/development/checks",
			`{"child_id":"C002","checked_on":"`+day+`","results":[{"development_item_id":151,"result":"1"}],"note":"","status":"`+status+`"}`)
	}
	finalized := func() *string {
		var v *string
		a.db.QueryRow(`SELECT finalized_at FROM t_development_check WHERE child_id = 'C002' AND checked_on = ?`, day).Scan(&v)
		return v
	}
	save("1")
	if v := finalized(); v != nil {
		t.Errorf("下書きで finalized_at が入った: %s", *v)
	}
	save("2")
	first := finalized()
	if first == nil {
		t.Fatal("確定で finalized_at が入っていない")
	}
	a.db.Exec(`UPDATE t_development_check SET finalized_at = '2026-01-01T00:00:00' WHERE child_id = 'C002' AND checked_on = ?`, day)
	save("2")
	if v := finalized(); v == nil || *v != "2026-01-01T00:00:00" {
		t.Errorf("確定し直しで finalized_at が動いた: %v", v)
	}
}

// 前の定義の DB に列を足し、確定済みの行の確定した日時を操作ログの「確定」か実施日の 00:00 で埋める（5-3）
func TestEnsureGrowthSchemaUpgradesOldDB(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "old.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	for _, q := range []string{
		`CREATE TABLE t_operation_log (operation_log_id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
		  operated_at TEXT NOT NULL, function_type TEXT NOT NULL, operation_type TEXT NOT NULL, target_table TEXT NOT NULL,
		  target_id INTEGER, target_child_id TEXT, before_value TEXT, after_value TEXT)`,
		`CREATE TABLE t_development_check (development_check_id INTEGER PRIMARY KEY AUTOINCREMENT, child_id TEXT NOT NULL,
		  development_schedule_id INTEGER, checked_on TEXT NOT NULL, status TEXT NOT NULL, staff_id TEXT NOT NULL,
		  share_status TEXT NOT NULL, note TEXT, UNIQUE (child_id, checked_on))`,
		`INSERT INTO t_development_check VALUES (1,'C001',NULL,'2026-05-15','2','S003','2',NULL),
		  (2,'C002',NULL,'2026-05-10','2','S003','2',NULL),(3,'C004',NULL,'2026-06-05','1','S004','1',NULL)`,
		`INSERT INTO t_operation_log (account_id, operated_at, function_type, operation_type, target_table, target_id, after_value)
		  VALUES (3,'2026-05-15T16:00:00','4','1','t_development_check',1,'確定'),(3,'2026-05-16T09:00:00','4','2','t_development_check',1,'確定')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := ensureGrowthSchema(db); err != nil {
			t.Fatalf("%d回目: %v", i+1, err)
		}
	}
	want := map[int64]*string{1: s("2026-05-15T16:00:00"), 2: s("2026-05-10T00:00:00"), 3: nil}
	for id, w := range want {
		var got *string
		db.QueryRow(`SELECT finalized_at FROM t_development_check WHERE development_check_id = ?`, id).Scan(&got)
		if (got == nil) != (w == nil) || (got != nil && *got != *w) {
			t.Errorf("check %d: finalized_at = %v, want %v", id, got, w)
		}
	}
	// ひとことを書き換えた時刻の列も足し、既存の行は書き換えていないので空のまま（決めたこと D-51）
	var corrected int
	db.QueryRow(`SELECT COUNT(*) FROM t_development_check WHERE guardian_message_corrected_at IS NOT NULL`).Scan(&corrected)
	var cols int
	db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('t_development_check') WHERE name = 'guardian_message_corrected_at'`).Scan(&cols)
	if cols != 1 || corrected != 0 {
		t.Errorf("guardian_message_corrected_at: 列 %d、印のある行 %d", cols, corrected)
	}
}

// 「成長の記録に残す」の付け外し（詳細設計書 (4-12 (3))・「成長の記録に届くもの」(3-7)）
func TestKeepInGrowth(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	admin := loginAs(a, accAdmin, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	insert := func(date, eventType, body string) (int64, string) {
		at := date + "T09:00:00"
		var res sql.Result
		var err error
		if eventType == "4" {
			res, err = a.db.Exec(`INSERT INTO t_contact_event (child_id, class_id, contact_date, event_type, recorded_at, body, staff_id, created_at, updated_at)
				VALUES ('C001', 1, ?, '4', ?, ?, 'S004', ?, ?)`, date, at, body, at, at)
		} else {
			res, err = a.db.Exec(`INSERT INTO t_contact_event (child_id, class_id, contact_date, event_type, recorded_at, meal_kind, meal_amount, staff_id, created_at, updated_at)
				VALUES ('C001', 1, ?, '1', ?, '1', '1', 'S004', ?, ?)`, date, at, at, at)
		}
		if err != nil {
			t.Fatal(err)
		}
		id, _ := res.LastInsertId()
		return id, at
	}
	path := func(id int64) string { return "/api/contact/events/" + itoa(id) + "/keep-in-growth" }
	body := func(keep bool, v string) string {
		return fmt.Sprintf(`{"keep_in_growth":%v,"updated_at":"%s"}`, keep, v)
	}
	type eventResp struct {
		Keep        bool    `json:"keep_in_growth"`
		CorrectedAt *string `json:"corrected_at"`
		UpdatedAt   string  `json:"updated_at"`
	}

	id, v := insert(today(), "4", "きょう残すひとこと")
	// 記録した職員でなくても、その日はクラスの担任が付けられる。corrected_at は変えず、版は進む
	var e eventResp
	json.Unmarshal(call(t, h, teacher, "POST", path(id), body(true, v)).Body.Bytes(), &e)
	if !e.Keep || e.CorrectedAt != nil || e.UpdatedAt == v || e.UpdatedAt == "" {
		t.Fatalf("付けたあと: %+v", e)
	}
	if _, gb := readGrowth(t, h, guardian, "/api/children/C001/growth"); !strings.Contains(gb, "きょう残すひとこと") {
		t.Errorf("成長の記録に並ばない: %s", gb)
	}
	var after string
	a.db.QueryRow(`SELECT after_value FROM t_operation_log WHERE target_table = 't_contact_event' AND target_id = ? ORDER BY operation_log_id DESC LIMIT 1`, id).Scan(&after)
	if !strings.Contains(after, `"成長の記録に残す":"残す"`) {
		t.Errorf("操作ログ: %s", after)
	}
	// 読んだ版が古ければ 409
	b := expectStatus(t, request(t, h, teacher, "POST", path(id), body(false, v)), http.StatusConflict)
	if !strings.Contains(b, kindVersionConflict) || !strings.Contains(b, msgVersionConflict) {
		t.Errorf("古い版: %s", b)
	}
	// 値が変わらなければ書き換えない（版も進まない）
	var same eventResp
	json.Unmarshal(call(t, h, teacher, "POST", path(id), body(true, e.UpdatedAt)).Body.Bytes(), &same)
	if same.UpdatedAt != e.UpdatedAt {
		t.Errorf("同じ値で版が進んだ: %s → %s", e.UpdatedAt, same.UpdatedAt)
	}
	// 外すと成長の記録から消える
	call(t, h, teacher, "POST", path(id), body(false, e.UpdatedAt))
	if _, gb := readGrowth(t, h, guardian, "/api/children/C001/growth"); strings.Contains(gb, "きょう残すひとこと") {
		t.Errorf("外したのに成長の記録に残っている: %s", gb)
	}

	// 読めない職員・保護者は 403（連絡帳と同じ文言）。ひとこと・写真でない行は 400
	for name, c := range map[string]*http.Cookie{"ひまわり組の担任": otherTeacher, "保護者": guardian} {
		if b := expectStatus(t, request(t, h, c, "POST", path(id), body(true, "x")), http.StatusForbidden); !strings.Contains(b, msgContactForbidden) {
			t.Errorf("%s: %s", name, b)
		}
	}
	meal, mv := insert(today(), "1", "")
	if b := expectStatus(t, request(t, h, teacher, "POST", path(meal), body(true, mv)), http.StatusBadRequest); !strings.Contains(b, msgBadChoice) {
		t.Errorf("給食の行: %s", b)
	}
	// 前の日の行は管理者だけ
	old, ov := insert(daysFromToday(-1), "4", "きのうのひとこと")
	if b := expectStatus(t, request(t, h, teacher, "POST", path(old), body(true, ov)), http.StatusForbidden); !strings.Contains(b, msgGrowthFixForbidden) {
		t.Errorf("前の日の担任: %s", b)
	}
	call(t, h, admin, "POST", path(old), body(true, ov))
	// 取り消した行は 403
	a.db.Exec(`UPDATE t_contact_event SET is_deleted = 1 WHERE contact_event_id = ?`, old)
	expectStatus(t, request(t, h, admin, "POST", path(old), body(false, ov)), http.StatusForbidden)
	// 保護者の連絡帳の応答には版を入れない
	if b := call(t, h, guardian, "GET", "/api/contact/children/C001", "").Body.String(); strings.Contains(b, "updated_at\":\""+v) {
		t.Errorf("保護者の応答に出来事の版が入っている: %s", b)
	}
}

// 発達チェックの保護者へのひとこと（詳細設計書「発達チェックの保存」(4-12 (2))・「成長の記録に届くもの」(3-7)）
func TestDevelopmentGuardianMessage(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	day := daysFromToday(-1)
	req := func(status, message string) string {
		return `{"child_id":"C001","checked_on":"` + day + `","results":[],"note":"","status":"` + status + `","guardian_message":` + message + `}`
	}
	var c struct {
		GuardianMessage *string `json:"guardian_message"`
		FinalizedAt     *string `json:"finalized_at"`
	}
	// 下書きでは保存するが、保護者には届かない
	json.Unmarshal(call(t, h, teacher, "POST", "/api/development/checks", req("1", `"  積み木を3つ積みました  "`)).Body.Bytes(), &c)
	if c.GuardianMessage == nil || *c.GuardianMessage != "積み木を3つ積みました" || c.FinalizedAt != nil {
		t.Fatalf("下書きの応答: %+v", c)
	}
	if _, b := readGrowth(t, h, guardian, "/api/children/C001/growth"); strings.Contains(b, "積み木を3つ積みました") {
		t.Errorf("下書きのひとことが届いている: %s", b)
	}
	// 確定すると、確認できた項目が無くてもひとことだけで届く
	call(t, h, teacher, "POST", "/api/development/checks", req("2", `"積み木を3つ積みました"`))
	if _, b := readGrowth(t, h, guardian, "/api/children/C001/growth"); !strings.Contains(b, "積み木を3つ積みました") {
		t.Errorf("確定したひとことが届かない: %s", b)
	}
	// 501文字は 400。空白だけなら null で保存する
	long := `"` + strings.Repeat("あ", 501) + `"`
	if b := expectStatus(t, request(t, h, teacher, "POST", "/api/development/checks", req("2", long)), http.StatusBadRequest); !strings.Contains(b, msgGuardianMessageTooLong) {
		t.Errorf("長すぎるひとこと: %s", b)
	}
	json.Unmarshal(call(t, h, teacher, "POST", "/api/development/checks", req("2", `"   "`)).Body.Bytes(), &c)
	if c.GuardianMessage != nil {
		t.Errorf("空白だけのひとことが残った: %s", *c.GuardianMessage)
	}
	// 書けない職員（ほかのクラスの担任・フリー）は 403
	expectStatus(t, request(t, h, otherTeacher, "POST", "/api/development/checks", req("1", `null`)), http.StatusForbidden)
	a.db.Exec(`DELETE FROM t_class_staff WHERE staff_id = 'S005'`)
	free := loginAs(a, accOtherTeacher, "staff")
	expectStatus(t, request(t, h, free, "POST", "/api/development/checks", req("1", `null`)), http.StatusForbidden)
}

/*
確定した保護者へのひとことの訂正（要件定義書「保護者へ届けるときの関所」(4-1-6) の (2)、詳細設計書 (2-12 (2))・(4-12 (2))、
決めたこと D-51。PR #216 で決まった設計）。直せるのは、確定した日（finalized_at の日付）はその園児のクラスの担任、
翌日以降は管理者だけ。空でないひとことを書き換えたときだけ「訂正しました」の印を付け、空にしたら印ごと消し、空から書き足しても
印は付けない。web/tests/growth.test.ts の同じ名前の観点と同じ流れ
*/
func TestDevelopmentGuardianMessageCorrection(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	admin := loginAs(a, accAdmin, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	// 実施日は前の日。確定した日（今日）で担任が直せるかが決まり、実施日では決まらないことも見る
	day := daysFromToday(-2)
	save := func(c *http.Cookie, message, note string) *httptest.ResponseRecorder {
		msg := "null"
		if message != "" {
			msg = `"` + message + `"`
		}
		return request(t, h, c, "POST", "/api/development/checks",
			`{"child_id":"C001","checked_on":"`+day+`","results":[],"note":"`+note+`","status":"2","guardian_message":`+msg+`}`)
	}
	row := func() (message, corrected *string) {
		a.db.QueryRow(`SELECT guardian_message, guardian_message_corrected_at FROM t_development_check
			WHERE child_id = 'C001' AND checked_on = ?`, day).Scan(&message, &corrected)
		return
	}
	entry := func() (found bool, message, corrected *string) {
		g, _ := readGrowth(t, h, guardian, "/api/children/C001/growth")
		for _, e := range g.Achievements {
			if e.Kind == "development" && e.Message != nil && strings.HasPrefix(*e.Message, "ひとこと") {
				return true, e.Message, e.MessageCorrectedAt
			}
		}
		return false, nil, nil
	}

	// 確定した日：担任が書き換えると印が付き、成長の記録に「訂正しました」の時刻が出る
	expectStatus(t, save(teacher, "ひとこと1", ""), http.StatusOK)
	if _, c := row(); c != nil {
		t.Fatalf("初めての確定で印が付いた: %s", *c)
	}
	if found, _, c := entry(); !found || c != nil {
		t.Fatalf("初めての確定の成長の記録: found=%v corrected=%v", found, c)
	}
	expectStatus(t, save(teacher, "ひとこと2", ""), http.StatusOK)
	m, c := row()
	if m == nil || *m != "ひとこと2" || c == nil {
		t.Fatalf("その日の担任の書き換え: message=%v corrected=%v", m, c)
	}
	if found, em, ec := entry(); !found || *em != "ひとこと2" || ec == nil || *ec != *c {
		t.Errorf("成長の記録に訂正の時刻が出ない: found=%v message=%v corrected=%v", found, em, ec)
	}
	var before, after string
	a.db.QueryRow(`SELECT before_value, after_value FROM t_operation_log WHERE target_table = 't_development_check'
		AND before_value IS NOT NULL ORDER BY operation_log_id DESC LIMIT 1`).Scan(&before, &after)
	if before != `{"保護者へのひとこと":"ひとこと1"}` || after != `{"保護者へのひとこと":"ひとこと2"}` {
		t.Errorf("操作ログの直す前・直したあと: %s → %s", before, after)
	}
	// 所見だけを直しても印は動かない
	a.db.Exec(`UPDATE t_development_check SET guardian_message_corrected_at = '2026-01-01T00:00:00' WHERE child_id = 'C001' AND checked_on = ?`, day)
	expectStatus(t, save(teacher, "ひとこと2", "所見だけ"), http.StatusOK)
	if _, c := row(); c == nil || *c != "2026-01-01T00:00:00" {
		t.Errorf("所見だけの直しで印が動いた: %v", c)
	}

	// 翌日以降：担任はひとことを変えられない（書き換え・空にする）。結果・所見だけなら直せる
	a.db.Exec(`UPDATE t_development_check SET finalized_at = ? WHERE child_id = 'C001' AND checked_on = ?`, day+"T16:00:00", day)
	for _, m := range []string{"ひとこと3", ""} {
		if b := expectStatus(t, save(teacher, m, ""), http.StatusForbidden); !strings.Contains(b, msgGuardianMessageFixForbidden) {
			t.Errorf("翌日の担任の %q: %s", m, b)
		}
	}
	expectStatus(t, save(teacher, "ひとこと2", "翌日に所見を直す"), http.StatusOK)
	if m, _ := row(); m == nil || *m != "ひとこと2" {
		t.Errorf("断ったひとことが変わった: %v", m)
	}
	// 管理者は翌日以降も書き換えられ、印が付く
	expectStatus(t, save(admin, "ひとこと4", ""), http.StatusOK)
	if m, c := row(); m == nil || *m != "ひとこと4" || c == nil || *c == "2026-01-01T00:00:00" {
		t.Errorf("翌日の管理者の書き換え: message=%v corrected=%v", m, c)
	}
	// 空にすると取り消し：ひとことは成長の記録から消え、印も消す
	expectStatus(t, save(admin, "", ""), http.StatusOK)
	if m, c := row(); m != nil || c != nil {
		t.Errorf("空にしたあと: message=%v corrected=%v", m, c)
	}
	if found, _, _ := entry(); found {
		t.Error("空にしたひとことが成長の記録に残った")
	}
	// 空から書き足すのも翌日以降は管理者だけ。書き足しは初めて届くため印を付けない
	expectStatus(t, save(teacher, "ひとこと5", ""), http.StatusForbidden)
	expectStatus(t, save(admin, "ひとこと5", ""), http.StatusOK)
	if m, c := row(); m == nil || *m != "ひとこと5" || c != nil {
		t.Errorf("空からの書き足し: message=%v corrected=%v", m, c)
	}
	if found, _, c := entry(); !found || c != nil {
		t.Errorf("書き足したひとことの成長の記録: found=%v corrected=%v", found, c)
	}
}
