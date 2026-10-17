package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
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
		Kind           string   `json:"kind"`
		At             string   `json:"at"`
		Date           string   `json:"date"`
		IsToday        bool     `json:"is_today"`
		Items          []string `json:"items"`
		Message        *string  `json:"message"`
		Body           *string  `json:"body"`
		ContactPhotoID *int64   `json:"contact_photo_id"`
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
}
