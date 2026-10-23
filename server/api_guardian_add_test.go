package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
保護者のメニューの「お子さまの追加」（POST /api/invitation/verify を広げたもの・POST /api/guardian/children）
典拠：詳細設計書「お子さまの追加」(4-15 (1))・(2-15 (2))・決めたこと D-47・D-48、
     基本設計書「お子さまの追加（園児の追加紐づけ）」(4-3)・「操作ログ（t_operation_log）」(5-9)・「チャット」(5-6)

権限の担保はサーバ側。モックの同じ観点は web/tests/guardianAddChild.test.ts にある（addChildRefusals は同じ名前の表と同じ行）。
デモデータ：西田さん（G001・アカウント 6）は C001 に紐づく。QRST-9012-UVWX は C002（遠藤 花子。さくら組・個人チャット 7。
遠藤さん（G002）が連絡順 1 で紐づく）の未使用のコード、ABCD-1234-EFGH は C001 の未使用のコード、IJKL-5678-MNOP は使用済み、
YZAB-3456-CDEF は失効
*/

const (
	codeHanako  = "QRST-9012-UVWX" // C002（遠藤 花子）の未使用のコード
	codeTaro    = "ABCD-1234-EFGH" // C001（西田 太郎）の未使用のコード
	codeUsed    = "IJKL-5678-MNOP" // 使用済み
	codeRevoked = "YZAB-3456-CDEF" // 失効
)

func addChildBody(code, relationship string) string {
	b, _ := json.Marshal(map[string]string{"code": code, "relationship": relationship})
	return string(b)
}

// linkRow は、紐づけの行（無ければ found が偽）
type linkRow struct {
	found        bool
	status       string
	relationship string
	linkedAt     string
	endedAt      string
	order        int
	aiOptOut     int
}

func linkOf(t *testing.T, a *app, guardianID, childID string) linkRow {
	t.Helper()
	var r linkRow
	err := a.db.QueryRow(`SELECT link_status, IFNULL(relationship, ''), linked_at, IFNULL(ended_at, ''), contact_order, ai_opt_out
		FROM t_guardian_child WHERE guardian_id = ? AND child_id = ?`, guardianID, childID).
		Scan(&r.status, &r.relationship, &r.linkedAt, &r.endedAt, &r.order, &r.aiOptOut)
	if err != nil {
		return linkRow{}
	}
	r.found = true
	return r
}

// codeUseOf は、招待コードの状態と使ったアカウント（"状態/アカウント"）
func codeUseOf(t *testing.T, a *app, code string) string {
	t.Helper()
	var v string
	if err := a.db.QueryRow(`SELECT status || '/' || IFNULL(used_account_id, '') FROM t_invitation_code WHERE code = ?`, code).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// membershipOf は、ルームの参加（"joined_at/left_at"。無ければ ""）
func membershipOf(t *testing.T, a *app, roomID, accountID int64) string {
	t.Helper()
	var v string
	a.db.QueryRow(`SELECT joined_at || '/' || IFNULL(left_at, '') FROM t_chat_member WHERE chat_room_id = ? AND account_id = ?`,
		roomID, accountID).Scan(&v)
	return v
}

// addChildLogs は、お子さまの追加の操作ログ（[アカウント/機能/操作/対象, 表, 変更後]）
func addChildLogs(t *testing.T, a *app, childID string) [][3]string {
	t.Helper()
	rows, err := a.db.Query(`SELECT account_id || '/' || function_type || '/' || operation_type || '/' || IFNULL(target_id, ''),
		target_table, IFNULL(after_value, '') FROM t_operation_log
		WHERE target_table = 't_guardian_child' AND target_child_id = ? AND after_value LIKE '%お子さまを追加%'
		ORDER BY operation_log_id`, childID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := [][3]string{}
	for rows.Next() {
		var r [3]string
		if err := rows.Scan(&r[0], &r[1], &r[2]); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

// 招待コードの確認：ログインしている保護者にだけ園児名を返し、すでに紐づいている園児なら 400（決めたこと D-47）
func TestVerifyInvitationForGuardian(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")

	// ログインしていない人（新規登録の途中）には、園児名を返さない（今の動きのまま）
	anon := send(t, h, nil, "POST", "/api/invitation/verify", `{"code":"`+codeHanako+`"}`)
	if anon.Code != http.StatusOK || strings.TrimSpace(anon.Body.String()) != `{"ok":true}` {
		t.Fatalf("ログインしていない人への応答: %d %s", anon.Code, anon.Body.String())
	}
	// 職員にも返さない
	staff := send(t, h, loginAs(a, accTeacher, "staff"), "POST", "/api/invitation/verify", `{"code":"`+codeHanako+`"}`)
	if strings.Contains(staff.Body.String(), "child_name") {
		t.Fatalf("職員に園児名を返した: %s", staff.Body.String())
	}

	var got struct {
		OK           bool   `json:"ok"`
		ChildName    string `json:"child_name"`
		Relationship string `json:"relationship"`
	}
	// 大文字小文字を区別せず、ハイフンは省いてよい（新規登録と同じ形）
	decode(t, call(t, h, guardian, "POST", "/api/invitation/verify", `{"code":"qrst9012uvwx"}`), &got)
	if !got.OK || got.ChildName != "遠藤 花子" || got.Relationship != "父" {
		t.Fatalf("保護者への応答: %+v", got)
	}

	// すでに紐づいている園児（有効・猶予中）は 400
	rec := send(t, h, guardian, "POST", "/api/invitation/verify", `{"code":"`+codeTaro+`"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), msgChildAlreadyAdded) {
		t.Fatalf("追加済み: %d %s", rec.Code, rec.Body.String())
	}
	mustExec(t, a, `UPDATE t_guardian_child SET link_status = '3', grace_ends_on = '2099-03-31' WHERE guardian_id = 'G001' AND child_id = 'C001'`)
	rec = send(t, h, guardian, "POST", "/api/invitation/verify", `{"code":"`+codeTaro+`"}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), msgChildAlreadyAdded) {
		t.Fatalf("猶予中: %d %s", rec.Code, rec.Body.String())
	}
	// 終了した紐づけは追加し直せる（決めたこと D-48）
	mustExec(t, a, `UPDATE t_guardian_child SET link_status = '2', grace_ends_on = NULL, ended_at = '2026-08-20T10:00:00' WHERE guardian_id = 'G001' AND child_id = 'C001'`)
	decode(t, call(t, h, guardian, "POST", "/api/invitation/verify", `{"code":"`+codeTaro+`"}`), &got)
	if got.ChildName != "西田 太郎" {
		t.Fatalf("終了した紐づけの園児: %+v", got)
	}
	// 確かめるだけでは、コードを使わない
	if got := codeUseOf(t, a, codeHanako); got != "1/" {
		t.Fatalf("確かめただけでコードの状態が変わった: %s", got)
	}
}

// addChildRefusals は、断る場合の表。web/tests/guardianAddChild.test.ts の同じ名前の表と同じ行
var addChildRefusals = []struct {
	name    string
	account int64
	code    string
	rel     string
	setup   []string
	undo    []string
	status  int
	message string
}{
	{name: "職員（担任）", account: accTeacher, code: codeHanako, rel: "母", status: http.StatusForbidden, message: msgGuardianOnly},
	{name: "職員（管理者）", account: accAdmin, code: codeHanako, rel: "母", status: http.StatusForbidden, message: msgGuardianOnly},
	// 招待コードの4つの文言は api_invitation_messages_test.go の wantInvitation…（基本設計書「メッセージ一覧」(4-12)）
	{name: "無いコード", account: accGuardian, code: "ZZZZ-0000-ZZZZ", rel: "母", status: http.StatusBadRequest, message: wantInvitationNotFound},
	{name: "使用済み", account: accGuardian, code: codeUsed, rel: "母", status: http.StatusBadRequest, message: wantInvitationUsed},
	{name: "失効", account: accGuardian, code: codeRevoked, rel: "母", status: http.StatusBadRequest, message: wantInvitationRevoked},
	{name: "期限切れ", account: accGuardian, code: codeHanako, rel: "母",
		setup:  []string{`UPDATE t_invitation_code SET expires_on = '2000-01-01' WHERE code = '` + codeHanako + `'`},
		undo:   []string{`UPDATE t_invitation_code SET expires_on = '2099-12-31' WHERE code = '` + codeHanako + `'`},
		status: http.StatusBadRequest, message: wantInvitationExpired},
	{name: "もう追加済み（有効）", account: accGuardian, code: codeTaro, rel: "父", status: http.StatusBadRequest, message: msgChildAlreadyAdded},
	{name: "もう追加済み（猶予中）", account: accGuardian, code: codeTaro, rel: "父",
		setup:  []string{`UPDATE t_guardian_child SET link_status = '3', grace_ends_on = '2099-03-31' WHERE guardian_id = 'G001' AND child_id = 'C001'`},
		undo:   []string{`UPDATE t_guardian_child SET link_status = '1', grace_ends_on = NULL WHERE guardian_id = 'G001' AND child_id = 'C001'`},
		status: http.StatusBadRequest, message: msgChildAlreadyAdded},
	{name: "続柄が空", account: accGuardian, code: codeHanako, rel: "  ", status: http.StatusBadRequest, message: msgRelationshipRequired},
	{name: "続柄が21文字", account: accGuardian, code: codeHanako, rel: strings.Repeat("あ", 21), status: http.StatusBadRequest, message: msgRelationshipRequired},
}

func TestAddChildRefusals(t *testing.T) {
	a, h := newTestApp(t)
	for _, c := range addChildRefusals {
		for _, q := range c.setup {
			mustExec(t, a, q)
		}
		entrance := "staff"
		if c.account == accGuardian {
			entrance = "guardian"
		}
		rec := request(t, h, loginAs(a, c.account, entrance), "POST", "/api/guardian/children", addChildBody(c.code, c.rel))
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.message) {
			t.Errorf("%s: %d %s, want %d %q", c.name, rec.Code, rec.Body.String(), c.status, c.message)
		}
		for _, q := range c.undo {
			mustExec(t, a, q)
		}
	}
	// どれも書いていない
	if l := linkOf(t, a, "G001", "C002"); l.found {
		t.Fatalf("断ったのに紐づけができた: %+v", l)
	}
	if got := codeUseOf(t, a, codeHanako); got != "1/" {
		t.Fatalf("断ったのにコードを使った: %s", got)
	}
	if got := codeUseOf(t, a, codeTaro); got != "1/" {
		t.Fatalf("断ったのにコードを使った: %s", got)
	}
	if l := linkOf(t, a, "G001", "C001"); l.status != "1" {
		t.Fatalf("断ったのに紐づけが変わった: %+v", l)
	}
	if got := membershipOf(t, a, 7, accGuardian); got != "" {
		t.Fatalf("断ったのに個人チャットに入った: %s", got)
	}
	if logs := addChildLogs(t, a, "C002"); len(logs) != 0 {
		t.Fatalf("断ったのに操作ログがある: %v", logs)
	}
}

// 成功：紐づけ・コードの使用済み・個人チャットへの参加が1つの処理で行われ、保護者ホームに区画が増える
func TestAddChildSucceeds(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")
	teacher := listen(a, accTeacher)
	other := listen(a, accOtherGuard)
	sakuraBefore := membershipOf(t, a, roomSakura, accGuardian)
	before := now()

	raw := call(t, h, guardian, "POST", "/api/guardian/children", addChildBody("qrst-9012-uvwx", " 母 ")).Body.String()
	if strings.TrimSpace(raw) != `{"child_id":"C002","ok":true}` {
		t.Fatalf("応答: %s", raw)
	}
	l := linkOf(t, a, "G001", "C002")
	// 続柄は前後の空白を落とす。連絡順は、遠藤さん（1）の次。AI の下書きは断っていない
	if !l.found || l.status != "1" || l.relationship != "母" || l.order != 2 || l.aiOptOut != 0 || l.linkedAt < before || l.endedAt != "" {
		t.Fatalf("紐づけ: %+v", l)
	}
	if got := codeUseOf(t, a, codeHanako); got != "2/6" {
		t.Fatalf("コード: %s", got)
	}
	// 個人チャット（7）へ今の時刻で参加する。さくら組のクラスグループ（3）は参加済みのまま変えない
	if m := membershipOf(t, a, 7, accGuardian); !strings.HasSuffix(m, "/") || m < before {
		t.Fatalf("個人チャットの参加: %s", m)
	}
	if m := membershipOf(t, a, roomSakura, accGuardian); m != sakuraBefore {
		t.Fatalf("参加済みのクラスグループの参加を変えた: %s → %s", sakuraBefore, m)
	}
	logs := addChildLogs(t, a, "C002")
	if len(logs) != 1 || logs[0] != [3]string{"6/7/1/6", "t_guardian_child", "招待コードでお子さまを追加"} {
		t.Fatalf("操作ログ: %v", logs)
	}
	// 知らせは参加したルーム（個人チャット 7）の参加者へ。参加の変わらないクラスグループと、ほかの家庭へは送らない
	if evs := drain(teacher); !hasEvent(evs, chatEv(7)) || hasEvent(evs, chatEv(roomSakura)) {
		t.Fatalf("担任への知らせ: %v", evs)
	}
	if evs := drain(other); len(evs) != 0 {
		t.Fatalf("ほかの家庭への知らせ: %v", evs)
	}
	// 保護者ホームに、その園児の区画が増える
	if home := guardianHomeOptOut(t, h, guardian); len(home) != 2 {
		t.Fatalf("保護者ホームの区画: %v", home)
	}
	// 同じコードは使えない
	rec := request(t, h, guardian, "POST", "/api/guardian/children", addChildBody(codeHanako, "母"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("2回目: %d %s", rec.Code, rec.Body.String())
	}
}

// ほかのクラスの子：いまのクラスのクラスグループへ参加する。個人チャットのルームが無い子は、個人チャットの参加を飛ばす
func TestAddChildJoinsClassGroup(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")
	code := issueCodeFor(t, a, h, childHimawari) // 井上 空（ひまわり組。クラスグループ 4、個人チャットのルームは無い）
	before := now()
	call(t, h, guardian, "POST", "/api/guardian/children", addChildBody(code, "祖父"))
	if m := membershipOf(t, a, 4, accGuardian); m < before || !strings.HasSuffix(m, "/") {
		t.Fatalf("ひまわり組のクラスグループの参加: %s", m)
	}
	if l := linkOf(t, a, "G001", childHimawari); l.status != "1" || l.order != 1 || l.relationship != "祖父" {
		t.Fatalf("紐づけ: %+v", l)
	}
}

// 終了した紐づけ：新しい行を作らずに有効へ戻し、個人チャットへは今の時刻で新しく参加する（決めたこと D-48）
func TestAddChildRestoresEndedLink(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")
	// 管理者が紐づけを解除したあと（api_admin.go の handleEndGuardianLink と同じ形。AI の下書きは断っていた）
	mustExec(t, a, `UPDATE t_guardian_child SET link_status = '2', ended_at = '2026-08-20T10:00:00', ai_opt_out = 1 WHERE guardian_id = 'G001' AND child_id = 'C001'`)
	mustExec(t, a, `UPDATE t_chat_member SET left_at = '2026-08-20T10:00:00' WHERE account_id = 6 AND chat_room_id IN (3, 6)`)
	// 外れていたあいだに園が書いた連絡。デモの記録は起動日へずれ、夜中には「今日の 07:40」が未来になるため、決まった過去の時刻で足す
	mustExec(t, a, `INSERT INTO t_chat_message (chat_room_id, sender_account_id, body, source_type, sent_at, is_deleted)
		VALUES (6, 3, '外れていたあいだの連絡', '1', '2026-09-15T10:00:00', 0)`)
	before := now()

	call(t, h, guardian, "POST", "/api/guardian/children", addChildBody(codeTaro, "母"))
	var n int
	a.db.QueryRow(`SELECT COUNT(*) FROM t_guardian_child WHERE guardian_id = 'G001' AND child_id = 'C001'`).Scan(&n)
	l := linkOf(t, a, "G001", "C001")
	if n != 1 || l.status != "1" || l.endedAt != "" || l.linkedAt < before || l.relationship != "母" {
		t.Fatalf("戻した紐づけ（%d 行）: %+v", n, l)
	}
	// 【仮置き】断っていたのは残す（web/仮置き値.md）
	if l.aiOptOut != 1 {
		t.Fatalf("AI の下書きを断っていたのを外した: %+v", l)
	}
	// 個人チャットとクラスグループへ、今の時刻で参加し直す。外れていたあいだのやりとりは見せない
	for _, room := range []int64{roomPersonal, roomSakura} {
		if m := membershipOf(t, a, room, accGuardian); m < before || !strings.HasSuffix(m, "/") {
			t.Fatalf("ルーム %d の参加: %s", room, m)
		}
	}
	var msgs []struct {
		Body string `json:"body"`
	}
	decode(t, call(t, h, guardian, "GET", "/api/chat/rooms/6/messages", ""), &msgs)
	for _, m := range msgs {
		if m.Body == "外れていたあいだの連絡" {
			t.Fatal("外れていたあいだのやりとりが見える")
		}
	}
	logs := addChildLogs(t, a, "C001")
	if len(logs) != 1 || logs[0][0] != "6/7/1/6" || !strings.Contains(logs[0][2], "戻した") {
		t.Fatalf("操作ログ: %v", logs)
	}
}

// 【仮置き】参加し直しても、最初に参加した日時（first_joined_at）は書き換える前の joined_at のまま残す。
// 個人チャットの「保護者がまだ1人もいなかった間の投稿は見せる」境（#198）が、D-48 の参加し直しで今へ動かないように。
// あとから2人目の保護者が加わっても、同じ境で見せる・見せないを分ける（web/仮置き値.md）
func TestAddChildRejoinKeepsFirstGuardianJoin(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")
	var firstJoined string
	if err := a.db.QueryRow(`SELECT joined_at FROM t_chat_member WHERE chat_room_id = 6 AND account_id = 6`).Scan(&firstJoined); err != nil {
		t.Fatal(err)
	}
	mustExec(t, a, `UPDATE t_guardian_child SET link_status = '2', ended_at = '2026-08-20T10:00:00' WHERE guardian_id = 'G001' AND child_id = 'C001'`)
	mustExec(t, a, `UPDATE t_chat_member SET left_at = '2026-08-20T10:00:00' WHERE account_id = 6 AND chat_room_id IN (3, 6)`)
	// 保護者がまだ1人も参加していなかった間の連絡（最初の参加より前）と、外れていたあいだの連絡
	mustExec(t, a, `INSERT INTO t_chat_message (chat_room_id, sender_account_id, body, source_type, sent_at, is_deleted)
		VALUES (6, 3, '保護者がいなかった間の連絡', '1', '2025-01-01T10:00:00', 0),
		       (6, 3, '外れていたあいだの連絡', '1', '2026-09-15T10:00:00', 0)`)

	call(t, h, guardian, "POST", "/api/guardian/children", addChildBody(codeTaro, "母"))
	var first, joined string
	if err := a.db.QueryRow(`SELECT IFNULL(first_joined_at, ''), joined_at FROM t_chat_member WHERE chat_room_id = 6 AND account_id = 6`).Scan(&first, &joined); err != nil {
		t.Fatal(err)
	}
	// DO UPDATE の中で読む joined_at は書き換える前の値（項の並びに頼らない）
	if first != firstJoined || joined == firstJoined {
		t.Fatalf("参加し直した行：first_joined_at=%q joined_at=%q（前の joined_at=%q）", first, joined, firstJoined)
	}

	seen := func(c *http.Cookie) (before, gap bool) {
		for _, m := range chatMessagesOf(t, h, c, "6") {
			before = before || m.Body == "保護者がいなかった間の連絡"
			gap = gap || m.Body == "外れていたあいだの連絡"
		}
		return
	}
	if before, gap := seen(guardian); !before || gap {
		t.Fatalf("参加し直した保護者：保護者がいなかった間=%v 外れていたあいだ=%v（見える・見えない、のはず）", before, gap)
	}

	// 2人目の保護者が今の時刻で加わる。境は最初の保護者の first_joined_at のまま
	mustExec(t, a, `INSERT INTO t_chat_member (chat_room_id, account_id, joined_at, left_at) VALUES (6, 7, ?, NULL)`, now())
	mustExec(t, a, `UPDATE m_account SET terms_version = ?, terms_agreed_at = ? WHERE account_id = 7`, a.currentTermsVersion, now())
	second := loginAs(a, 7, "guardian")
	if before, gap := seen(second); !before || gap {
		t.Fatalf("2人目の保護者：保護者がいなかった間=%v 外れていたあいだ=%v（見える・見えない、のはず）", before, gap)
	}
}

// 途中で失敗したら全部を戻す（紐づけ・コードの使用済み・参加のどれも残さない）
func TestAddChildRollsBack(t *testing.T) {
	a, h := newTestApp(t)
	guardian := loginAs(a, accGuardian, "guardian")
	// 最後の書き込み（チャットの参加）で失敗させる
	mustExec(t, a, `CREATE TRIGGER test_fail_join BEFORE INSERT ON t_chat_member WHEN NEW.account_id = 6
		BEGIN SELECT RAISE(ABORT, 'テストで止める'); END`)

	rec := request(t, h, guardian, "POST", "/api/guardian/children", addChildBody(codeHanako, "母"))
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), msgAddChildFailed) {
		t.Fatalf("新しい紐づけ: %d %s", rec.Code, rec.Body.String())
	}
	if l := linkOf(t, a, "G001", "C002"); l.found {
		t.Fatalf("紐づけが残った: %+v", l)
	}
	if got := codeUseOf(t, a, codeHanako); got != "1/" {
		t.Fatalf("コードが使用済みのまま: %s", got)
	}
	if got := membershipOf(t, a, 7, accGuardian); got != "" {
		t.Fatalf("参加が残った: %s", got)
	}
	if logs := addChildLogs(t, a, "C002"); len(logs) != 0 {
		t.Fatalf("操作ログが残った: %v", logs)
	}

	// 終了した紐づけを戻す途中で失敗しても、終了のまま
	mustExec(t, a, `UPDATE t_guardian_child SET link_status = '2', ended_at = '2026-08-20T10:00:00' WHERE guardian_id = 'G001' AND child_id = 'C001'`)
	mustExec(t, a, `UPDATE t_chat_member SET left_at = '2026-08-20T10:00:00' WHERE account_id = 6 AND chat_room_id = 6`)
	rec = request(t, h, guardian, "POST", "/api/guardian/children", addChildBody(codeTaro, "母"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("戻す紐づけ: %d %s", rec.Code, rec.Body.String())
	}
	if l := linkOf(t, a, "G001", "C001"); l.status != "2" || l.endedAt == "" || l.relationship != "父" {
		t.Fatalf("戻す途中で失敗したのに紐づけが変わった: %+v", l)
	}
	if got := codeUseOf(t, a, codeTaro); got != "1/" {
		t.Fatalf("コードが使用済みのまま: %s", got)
	}
	if m := membershipOf(t, a, roomPersonal, accGuardian); strings.HasSuffix(m, "/") {
		t.Fatalf("個人チャットに戻った: %s", m)
	}

	// 止めるのをやめれば追加できる（同じコードがまだ使える）
	mustExec(t, a, `DROP TRIGGER test_fail_join`)
	call(t, h, guardian, "POST", "/api/guardian/children", addChildBody(codeHanako, "母"))
	if l := linkOf(t, a, "G001", "C002"); l.status != "1" {
		t.Fatalf("やり直し: %+v", l)
	}
}
