package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

/*
招待コードの誤りの文言（基本設計書「メッセージ一覧」(4-12) の招待コードの4つ・「保護者アカウントの自己登録」(4-3)・
「お子さまの追加（園児の追加紐づけ）」(4-3)、詳細設計書「お子さまの追加」(4-15 (1))・決めたこと D-52）

新規登録のコードの確認・新規登録の送信・お子さまの追加（確認と追加）の、どの経路でも同じ4つの文言を返す。
同じコードを同時に送ったときの2つ目も、使用済みの文を返す。
モックの同じ観点は web/tests/invitationMessages.test.ts にある（invitationMessageCases は同じ名前の表と同じ行）。
*/

/*
設計書の4つの文言を、そのまま写したもの（基本設計書「メッセージ一覧」(4-12)）。server/messages.go の定数を使わずに
文字で持つのは、定数の書き換えで文言が設計から離れたときにも気づくため
*/
const (
	wantInvitationNotFound = "招待コードが確認できません。園から配布されたコードをお確かめください"
	wantInvitationUsed     = "この招待コードはすでに使われています。園に新しい招待コードの発行をご依頼ください"
	wantInvitationRevoked  = "この招待コードは失効しています。園に新しい招待コードの発行をご依頼ください"
	wantInvitationExpired  = "この招待コードは有効期限が切れています。園に新しい招待コードの発行をご依頼ください"
)

// invitationMessageCases は、招待コードが使えない場合と、返す文言の表
var invitationMessageCases = []struct {
	name    string
	code    string
	setup   []string
	message string
}{
	{name: "無いコード", code: "ZZZZ-0000-ZZZZ", message: wantInvitationNotFound},
	{name: "取り消した園児のコード", code: codeHanako,
		setup: []string{`UPDATE m_child SET is_deleted = 1 WHERE child_id = 'C002'`}, message: wantInvitationNotFound},
	{name: "在籍していない園児のコード", code: codeHanako,
		setup: []string{`UPDATE m_child SET enrollment_status = '2' WHERE child_id = 'C002'`}, message: wantInvitationNotFound},
	{name: "使用済み", code: codeUsed, message: wantInvitationUsed},
	{name: "失効", code: codeRevoked, message: wantInvitationRevoked},
	{name: "期限切れ", code: codeHanako,
		setup: []string{`UPDATE t_invitation_code SET expires_on = '2000-01-01' WHERE code = '` + codeHanako + `'`}, message: wantInvitationExpired},
}

// errorMessageOf は、誤りの応答の文言（message）を返す
func errorMessageOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var e apiError
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatalf("誤りの応答を読めない: %d %s", rec.Code, rec.Body.String())
	}
	return e.Message
}

func TestInvitationCodeMessagesAreSameOnEveryRoute(t *testing.T) {
	for _, c := range invitationMessageCases {
		t.Run(c.name, func(t *testing.T) {
			a, h := newTestApp(t)
			for _, q := range c.setup {
				mustExec(t, a, q)
			}
			guardian := loginAs(a, accGuardian, "guardian")
			codeBody := `{"code":"` + c.code + `"}`
			routes := []struct {
				name string
				rec  *httptest.ResponseRecorder
			}{
				{"新規登録のコードの確認", send(t, h, nil, "POST", "/api/invitation/verify", codeBody)},
				{"新規登録の送信", signUpWith(t, h, c.code, nil)},
				{"お子さまの追加のコードの確認", send(t, h, guardian, "POST", "/api/invitation/verify", codeBody)},
				{"お子さまの追加", send(t, h, guardian, "POST", "/api/guardian/children", addChildBody(c.code, "母"))},
			}
			for _, r := range routes {
				if r.rec.Code != http.StatusBadRequest {
					t.Errorf("%s: status = %d, want 400 (%s)", r.name, r.rec.Code, r.rec.Body.String())
					continue
				}
				if got := errorMessageOf(t, r.rec); got != c.message {
					t.Errorf("%s: %q, want %q", r.name, got, c.message)
				}
			}
			// どの経路でも、書いていない
			var accounts int
			a.db.QueryRow(`SELECT COUNT(*) FROM m_account WHERE email = 'signup.test@example.jp'`).Scan(&accounts)
			if accounts != 0 {
				t.Fatalf("断ったのにアカウントができた")
			}
			if l := linkOf(t, a, "G001", "C002"); l.found {
				t.Fatalf("断ったのに紐づけができた: %+v", l)
			}
		})
	}
}

/*
お子さまの追加で、同じコードを別の要求が先に使ったとき（使用済みにする条件付きの更新で負けたもの）は、使用済みの文を返す。
lookupUsableCode を通ったあとで、別の要求がコードを使った状態を作り、書き込み（addChildTx）だけを走らせる
*/
func TestAddChildLoserOfSameCodeGetsUsedMessage(t *testing.T) {
	a, _ := newTestApp(t)
	u, err := a.loadSessionUser(accGuardian)
	if err != nil {
		t.Fatal(err)
	}
	code, err := a.lookupUsableCode(codeHanako)
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, a, `UPDATE t_invitation_code SET status = '2', used_account_id = 9, used_at = ? WHERE code = ?`, now(), codeHanako)

	_, fail := a.addChildTx(u, code, "母")
	if fail == nil || fail.status != http.StatusBadRequest || fail.message != wantInvitationUsed {
		t.Fatalf("負けた2つ目: %+v, want 400 %q", fail, wantInvitationUsed)
	}
	if l := linkOf(t, a, "G001", "C002"); l.found {
		t.Fatalf("負けたのに紐づけができた: %+v", l)
	}
}

// お子さまの追加で、2人の保護者が同じコードを同時に送ると、1人だけが追加でき、ほかは使用済みの文を受け取る
func TestAddChildSameCodeAtOnce(t *testing.T) {
	a, h := newTestApp(t)
	cookies := []*http.Cookie{loginAs(a, accGuardian, "guardian"), loginAs(a, accOtherGuard, "guardian")}
	recs := make([]*httptest.ResponseRecorder, len(cookies))
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i, c := range cookies {
		wg.Add(1)
		go func(i int, c *http.Cookie) {
			defer wg.Done()
			<-start
			req := httptest.NewRequest("POST", "/api/guardian/children", strings.NewReader(addChildBody(codeHanako, "母")))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(c)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			recs[i] = rec
		}(i, c)
	}
	close(start)
	wg.Wait()

	ok := 0
	for _, rec := range recs {
		if rec.Code == http.StatusOK {
			ok++
			continue
		}
		if rec.Code != http.StatusBadRequest || errorMessageOf(t, rec) != wantInvitationUsed {
			t.Errorf("2つ目: %d %s, want 400 %q", rec.Code, rec.Body.String(), wantInvitationUsed)
		}
	}
	if ok != 1 {
		t.Fatalf("同時に2件送って %d 件が追加された。1 件だけのはず", ok)
	}
}
