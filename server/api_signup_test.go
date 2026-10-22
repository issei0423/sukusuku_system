package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*
 * 保護者の新規登録で受け取るもの（GitHub Issue #170 の 1・4）
 * 典拠：基本設計書.md「保護者アカウントの自己登録」(4-3)・「同意履歴（t_terms_agreement）」(5-2)・
 *      「入力項目の制約値」(4-9)・「アカウント（m_account）」(5-2)、図/画面詳細図.md「新規登録画面（保護者）」(2-3)
 *
 * 画面側のモック（web/src/api/mock.ts の signUpGuardian）と同じ規則であることを、
 * web/tests/signUp.test.ts と同じ観点で確かめる。
 */

// issueCodeFor は、管理者で園児の招待コードを1枚発行する
func issueCodeFor(t *testing.T, a *app, h http.Handler, childID string) string {
	t.Helper()
	admin := loginAs(a, 1, "staff")
	var issued struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(call(t, h, admin, "POST", "/api/admin/invitations",
		`{"child_id":"`+childID+`","valid_days":30}`).Body.Bytes(), &issued); err != nil {
		t.Fatal(err)
	}
	return issued.Code
}

// signUpWith は、ログインしていない端末から新規登録を送る。fields で上書き・削除（nil）できる
func signUpWith(t *testing.T, h http.Handler, code string, fields map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]any{
		"code": code, "email": "signup.test@example.jp", "password": "signup-5678",
		"guardian_name": "検査 太郎", "relationship": "母",
		"terms_agreed": true, "terms_version": "1.1",
	}
	for k, v := range fields {
		if v == nil {
			delete(body, k)
			continue
		}
		body[k] = v
	}
	raw, _ := json.Marshal(body)
	return send(t, h, nil, "POST", "/api/signup", string(raw))
}

// codeStatusOf は、招待コードの状態（1:未使用 2:使用済）を返す
func codeStatusOf(t *testing.T, a *app, code string) string {
	t.Helper()
	var status string
	if err := a.db.QueryRow(`SELECT status FROM t_invitation_code WHERE code = ?`, code).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

/*
 * ---- #170 の 1：規約への同意を受け取らずに登録しない ----
 * 同意しなかった場合は登録を完了しない（基本設計書 4-3）。未チェックのままでは登録できない（画面詳細図 2-3 項目5）。
 * 同意は要配慮個人情報を取り扱う根拠であり、いつ・どの版に同意したかを後から示せる必要がある（同 5-2）。
 * 画面のチェックだけで止めていると、API を直接呼べば同意の記録だけが付いたアカウントができる
 */
func TestSignUpRequiresTermsConsent(t *testing.T) {
	a, h := newTestApp(t)
	code := issueCodeFor(t, a, h, "C007")

	rejected := []struct {
		name   string
		fields map[string]any
	}{
		{"同意の項目が無い", map[string]any{"terms_agreed": nil, "terms_version": nil}},
		{"同意しない", map[string]any{"terms_agreed": false}},
		{"同意したが、どの版かが無い", map[string]any{"terms_version": nil}},
		{"いまの版でない規約への同意", map[string]any{"terms_version": "0.9"}},
	}
	for _, c := range rejected {
		t.Run(c.name+"なら登録しない", func(t *testing.T) {
			rec := signUpWith(t, h, code, c.fields)
			expectStatus(t, rec, http.StatusBadRequest)
			if !strings.Contains(rec.Body.String(), "利用規約") {
				t.Fatalf("同意が要ることを示していない: %s", rec.Body.String())
			}
			var accounts, agreements int
			a.db.QueryRow(`SELECT COUNT(*) FROM m_account WHERE email = 'signup.test@example.jp'`).Scan(&accounts)
			a.db.QueryRow(`SELECT COUNT(*) FROM t_terms_agreement ta JOIN m_account ac ON ac.account_id = ta.account_id
				WHERE ac.email = 'signup.test@example.jp'`).Scan(&agreements)
			if accounts != 0 || agreements != 0 {
				t.Fatalf("同意していないのに、アカウント %d 件・同意の記録 %d 件ができた", accounts, agreements)
			}
			if got := codeStatusOf(t, a, code); got != "1" {
				t.Fatalf("登録していないのに、招待コードが使われた（status=%s）", got)
			}
		})
	}

	t.Run("いまの版に同意すれば登録でき、その版への同意が履歴に残る", func(t *testing.T) {
		rec := signUpWith(t, h, code, nil)
		expectStatus(t, rec, http.StatusOK)
		var u SessionUser
		if err := json.Unmarshal(rec.Body.Bytes(), &u); err != nil {
			t.Fatal(err)
		}
		if !u.TermsAgreed {
			t.Fatalf("同意したのに未同意になっている: %+v", u)
		}
		var version string
		a.db.QueryRow(`SELECT t.terms_version FROM t_terms_agreement ta JOIN m_terms t ON t.terms_id = ta.terms_id
			WHERE ta.account_id = ?`, u.AccountID).Scan(&version)
		if version != a.currentTermsVersion {
			t.Fatalf("同意の履歴の版 = %q, want %q", version, a.currentTermsVersion)
		}
	})
}

/*
 * ---- #170 の 4：保護者の氏名・続柄・メールアドレスの検査 ----
 * 氏名は各50文字以内（基本設計書「入力項目の制約値」(4-9)）。続柄は 母・父・祖母・祖父・その他 から選ぶ必須の項目
 * （画面詳細図 2-3 項目11）。ログインIDはロールをまたいで園内で一意（基本設計書 5-2）であり、
 * 大文字・小文字だけが違うメールアドレスは同じ宛先として扱う
 */
func TestSignUpValidatesGuardianFields(t *testing.T) {
	a, h := newTestApp(t)
	code := issueCodeFor(t, a, h, "C006")

	rejected := []struct {
		name   string
		fields map[string]any
		want   string
	}{
		{"氏名が51文字", map[string]any{"guardian_name": strings.Repeat("あ", 51)}, "50文字以内"},
		{"続柄が選択肢にない", map[string]any{"relationship": "おじ"}, "続柄"},
		{"続柄が空", map[string]any{"relationship": ""}, "続柄"},
		{"続柄が無い", map[string]any{"relationship": nil}, "続柄"},
		{"大文字・小文字だけが違う既存のメールアドレス", map[string]any{"email": "NOHARA.I@EXAMPLE.JP"}, "すでに登録されています"},
		{"大文字・小文字だけが違う職員のログインID", map[string]any{"email": "Takanashi@Hoiku.Example.JP"}, "すでに登録されています"},
	}
	for _, c := range rejected {
		t.Run(c.name+"なら登録しない", func(t *testing.T) {
			rec := signUpWith(t, h, code, c.fields)
			expectStatus(t, rec, http.StatusBadRequest)
			if !strings.Contains(rec.Body.String(), c.want) {
				t.Fatalf("理由が %q を含まない: %s", c.want, rec.Body.String())
			}
			if got := codeStatusOf(t, a, code); got != "1" {
				t.Fatalf("登録していないのに、招待コードが使われた（status=%s）", got)
			}
		})
	}

	t.Run("氏名が50文字ちょうどで、選択肢の続柄なら登録できる", func(t *testing.T) {
		name := strings.Repeat("い", 50)
		rec := signUpWith(t, h, code, map[string]any{"guardian_name": " " + name + " ", "relationship": "祖父"})
		expectStatus(t, rec, http.StatusOK)
		var saved, relationship string
		a.db.QueryRow(`SELECT g.guardian_name, gc.relationship FROM m_guardian g
			JOIN t_guardian_child gc ON gc.guardian_id = g.guardian_id
			JOIN m_account ac ON ac.account_id = g.account_id
			WHERE ac.email = 'signup.test@example.jp'`).Scan(&saved, &relationship)
		// 前後の空白は落として残す。数えるのも落としたあとの文字数
		if saved != name || relationship != "祖父" {
			t.Fatalf("保存した氏名・続柄 = %q・%q", saved, relationship)
		}
	})
}
