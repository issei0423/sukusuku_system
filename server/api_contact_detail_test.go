package main

import (
	"net/http"
	"strings"
	"testing"
)

/*
連絡帳の細部（GitHub Issue #268）。版を必ず進めること（詳細設計書「足す表」(5-2) の決めたこと D-40）、
直した職員の表示（同「誰が直したかの表示」(4-7 (4))。D-28）、保護者ホームの写真の行の添え文。
モックの同じ観点は web/tests/contactDetail.test.ts にある。
Go のテストは本物の時計で動く。同じ秒に当たるかどうかに頼らず、版が必ず変わることを確かめる。
*/

// nextVersion は、今の時刻が前の値より後なら今の時刻、そうでなければ前の値の1秒後（同じ秒でも同じ版にならない）
func TestNextVersion(t *testing.T) {
	if got := nextVersion("2999-01-01T00:00:00"); got != "2999-01-01T00:00:01" {
		t.Errorf("先の版の次: %s", got)
	}
	if got := nextVersion("2999-12-31T23:59:59"); got != "3000-01-01T00:00:00" {
		t.Errorf("先の版の次（繰り上がり）: %s", got)
	}
	// 同じ秒（いまの時刻と同じ版）の次は、いまの時刻より後になる
	same := now()
	if got := nextVersion(same); got <= same {
		t.Errorf("同じ秒の次の版 %s が %s より進んでいない", got, same)
	}
	if got := nextVersion("2000-01-01T00:00:00"); got <= "2000-01-01T00:00:00" {
		t.Errorf("古い版の次: %s", got)
	}
}

// 保護者が版Aで送り、続けて版Bで送り直したあと、職員が版Aで「確認しました」を押しても通らない（同じ秒でも）
func TestContactHomeVersionAlwaysAdvances(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	path := "/api/contact/children/C001/home"

	var first homeResp
	decode(t, call(t, h, guardian, "PUT", path, `{"temperature":36.5,"message":"版A","updated_at":null}`), &first)
	var second homeResp
	decode(t, call(t, h, guardian, "PUT", path, `{"temperature":38.9,"message":"版B","updated_at":"`+first.UpdatedAt+`"}`), &second)
	if second.UpdatedAt == first.UpdatedAt {
		t.Fatalf("送り直しても版が同じ: %s", first.UpdatedAt)
	}

	confirm := "/api/contact/home/" + itoa(first.ID) + "/confirm"
	b := expectStatus(t, request(t, h, teacher, "POST", confirm, `{"updated_at":"`+first.UpdatedAt+`"}`), http.StatusConflict)
	if !strings.Contains(b, msgConfirmConflict) || !strings.Contains(b, kindVersionConflict) {
		t.Errorf("読んでいない版の確認: %s", b)
	}
	var confirmed homeResp
	decode(t, call(t, h, teacher, "POST", confirm, `{"updated_at":"`+second.UpdatedAt+`"}`), &confirmed)
	if confirmed.ConfirmedAt == nil || confirmed.UpdatedAt == second.UpdatedAt {
		t.Errorf("確認しました: 確認の時刻 %v・版 %s（読んだ版 %s）", confirmed.ConfirmedAt, confirmed.UpdatedAt, second.UpdatedAt)
	}
}

// 訂正・「確認しました」を重ねても、版は毎回変わる。古い版での訂正は 409
func TestContactEventCorrectVersionAdvances(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	got := record(t, h, teacher, `{"child_id":"C001","event_type":"1","meal_kind":"2","meal_amount":"1"}`)
	meal := got.Events[0]
	path := "/api/contact/events/" + itoa(meal.ID) + "/correct"
	var one, two eventResp
	decode(t, call(t, h, teacher, "POST", path, `{"meal_amount":"3","updated_at":"`+meal.UpdatedAt+`"}`), &one)
	if one.UpdatedAt == meal.UpdatedAt {
		t.Fatalf("訂正しても版が同じ: %s", one.UpdatedAt)
	}
	// 読み直していない版での 2 回目は通らない（同じ秒でも）
	expectStatus(t, request(t, h, teacher, "POST", path, `{"meal_amount":"2","updated_at":"`+meal.UpdatedAt+`"}`), http.StatusConflict)
	decode(t, call(t, h, teacher, "POST", path, `{"meal_amount":"2","updated_at":"`+one.UpdatedAt+`"}`), &two)
	if two.UpdatedAt == one.UpdatedAt {
		t.Errorf("2回目の訂正でも版が同じ: %s", two.UpdatedAt)
	}
}

// 職員の画面には、直した職員と時刻（last_change）を出す。記録した職員とは別の人でもよい。保護者の画面には出さない
func TestContactEventLastChange(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	admin := loginAs(a, accAdmin, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	got := record(t, h, teacher, `{"child_id":"C001","event_type":"1","meal_kind":"2","meal_amount":"1"}`)
	meal := got.Events[0]

	type page struct {
		Events []struct {
			ID         int64  `json:"contact_event_id"`
			StaffName  string `json:"staff_name"`
			UpdatedAt  string `json:"updated_at"`
			LastChange *struct {
				StaffName string `json:"staff_name"`
				At        string `json:"at"`
			} `json:"last_change"`
		} `json:"events"`
	}
	read := func(who *http.Cookie) (string, page) {
		rec := call(t, h, who, "GET", "/api/contact/children/C001", "")
		var p page
		decode(t, rec, &p)
		return rec.Body.String(), p
	}
	find := func(p page) int {
		for i, e := range p.Events {
			if e.ID == meal.ID {
				return i
			}
		}
		t.Fatalf("記録 %d がページに無い", meal.ID)
		return -1
	}

	// 直していないうちは付けない
	_, p := read(teacher)
	if e := p.Events[find(p)]; e.LastChange != nil {
		t.Fatalf("直していないのに last_change がある: %+v", e.LastChange)
	}

	// 管理者が直す。記録した職員（担任）はそのままで、直した職員は管理者
	call(t, h, admin, "POST", "/api/contact/events/"+itoa(meal.ID)+"/correct", `{"meal_amount":"3","updated_at":"`+meal.UpdatedAt+`"}`)
	_, p = read(teacher)
	e := p.Events[find(p)]
	if e.StaffName != a.staffName("S003") || e.LastChange == nil || e.LastChange.StaffName != a.accountName(accAdmin) || e.LastChange.At == "" {
		t.Errorf("直したあと（記録 %s・直した職員 %s が欲しい）: %+v", a.staffName("S003"), a.accountName(accAdmin), e)
	}

	// 保護者には、職員の名前も last_change も出さない
	body, _ := read(guardian)
	if strings.Contains(body, "last_change") || strings.Contains(body, a.accountName(accAdmin)) {
		t.Errorf("保護者のページに直した職員が出ている: %s", body)
	}

	// 「成長の記録に残す」の付け外しは、直したことに数えない
	_, p = read(teacher)
	version := p.Events[find(p)].UpdatedAt
	expectStatus(t, request(t, h, teacher, "POST", "/api/contact/events/"+itoa(meal.ID)+"/keep-in-growth",
		`{"keep_in_growth":true,"updated_at":"`+version+`"}`), http.StatusOK)
	_, p = read(teacher)
	if e := p.Events[find(p)]; e.LastChange == nil || e.LastChange.StaffName != a.accountName(accAdmin) {
		t.Errorf("成長の記録に残すを付けたあと: %+v", e.LastChange)
	}
}

// 保護者ホームの写真の行には、添えた文を出す（なければ「写真」）
func TestTodayItemTextPhoto(t *testing.T) {
	text := func(body *string) string { return todayItemText(contactEventOut{EventType: "5", Body: body}) }
	if got := text(nil); got != "写真" {
		t.Errorf("文なし: %q", got)
	}
	blank := "  "
	if got := text(&blank); got != "写真" {
		t.Errorf("空白だけ: %q", got)
	}
	body := "砂場でお山を作りました"
	if got := text(&body); got != body {
		t.Errorf("文あり: %q", got)
	}
	long := strings.Repeat("あ", 50)
	if got := text(&long); got != strings.Repeat("あ", 40)+"…" {
		t.Errorf("長い文: %q", got)
	}
}
