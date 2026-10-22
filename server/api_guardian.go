package main

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
)

/*
保護者のメニューの経路（詳細設計書「保護者のメニュー」(4-15)、画面は「保護者のメニュー」(2-15)）。
どれも保護者だけ（職員が呼んだら 403「保護者のみが行えます」。詳細設計書「本書で足す文言」(4-1 (6))）。
モックは web/src/api/mock.ts の guardianApi が同じ規則を持つ。片方だけ直すと食い違う。

本版は「お子さまの追加」(4-15 (1)) と「AI の下書きの利用」(4-15 (3)) を置く。連絡先の変更 (4-15 (2)) は実装の順番の 15 の残り。
*/

// ---- お子さまの追加（詳細設計書「お子さまの追加」(4-15 (1))、基本設計書「お子さまの追加（園児の追加紐づけ）」(4-3)） ----

// relationshipMax は続柄の上限の文字数（詳細設計書「お子さまの追加」(4-15 (1)) の「relationship は1〜20文字」、
// 基本設計書「保護者と園児の紐づけ（t_guardian_child）」(5-3) の VARCHAR(20)）
const relationshipMax = 20

// loggedInGuardian は、要求を送った人がログイン中の保護者なら、その人を返す（停止中・職員・ログインしていない人は nil）。
// 招待コードの確認は、新規登録の途中（ログインしていない人）とお子さまの追加（ログインしている保護者）の両方が呼ぶ
func (a *app) loggedInGuardian(r *http.Request) *SessionUser {
	// ログイン中かの判定は session.go の sessionAccount（ログイン・新規登録と同じ）
	id, ok := a.sessionAccount(r)
	if !ok {
		return nil
	}
	u, err := a.loadSessionUser(id)
	if err != nil || u.isSuspended() || !u.isGuardian() || u.GuardianID == nil {
		return nil
	}
	return u
}

// guardianLinkStatus は、その保護者のその園児との紐づけの状態（1:有効 2:終了 3:猶予中。行が無ければ ""）
func guardianLinkStatus(q dbtx, guardianID, childID string) (string, error) {
	var status string
	err := q.QueryRow(`SELECT link_status FROM t_guardian_child WHERE guardian_id = ? AND child_id = ?`,
		guardianID, childID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return status, err
}

// alreadyAdded は、そのアカウントにすでに紐づいている園児か（有効・猶予中）。終了（2）は、招待コードで追加し直せる
func alreadyAdded(status string) bool {
	return status == "1" || status == "3"
}

/*
firstRelationship は、その保護者が最初に登録したときの続柄（ダイアログの続柄の初期値。詳細設計書「お子さまの追加」(2-15 (2))）。

【仮置き】設計は初期値を「最初に登録したときの続柄」とするが、それを画面へ渡す経路の項目を決めていない（web/仮置き値.md）。
招待コードの確認の応答（ログインしている保護者のときだけ）に relationship として足し、
紐づけた日時（linked_at）のいちばん古い行の続柄を返す。紐づけの表は作った日時を持たないため、日時の同じ行は園児ID の順
*/
func (a *app) firstRelationship(guardianID string) string {
	var rel string
	a.db.QueryRow(`SELECT IFNULL(relationship, '') FROM t_guardian_child
		WHERE guardian_id = ? AND IFNULL(relationship, '') <> ''
		ORDER BY linked_at, child_id LIMIT 1`, guardianID).Scan(&rel)
	return rel
}

// addChildPreview は、ログインしている保護者が招待コードを確かめたときの応答（詳細設計書「お子さまの追加」(4-15 (1))）
type addChildPreview struct {
	OK        bool   `json:"ok"`
	ChildName string `json:"child_name"`
	// 【仮置き】ダイアログの続柄の初期値（firstRelationship。web/仮置き値.md）
	Relationship string `json:"relationship"`
}

/*
writeAddChildPreview は、ログインしている保護者に、招待コードの園児名を返す（POST /api/invitation/verify を広げたもの）。
コードの検査（lookupUsableCode）は済んでいること。そのアカウントにすでに紐づいている園児なら 400
「このお子さまはすでに追加されています。」（基本設計書「お子さまの追加（園児の追加紐づけ）」(4-3)）。
園児名を返すのはログインしている保護者だけ（決めたこと D-47。コードを拾った人に名前を教えないため）
*/
func (a *app) writeAddChildPreview(w http.ResponseWriter, u *SessionUser, code usableCode) {
	status, err := guardianLinkStatus(a.db, *u.GuardianID, code.ChildID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "招待コードの確認に失敗しました")
		return
	}
	if alreadyAdded(status) {
		writeErr(w, http.StatusBadRequest, msgChildAlreadyAdded)
		return
	}
	var name string
	if err := a.db.QueryRow(`SELECT child_name FROM m_child WHERE child_id = ?`, code.ChildID).Scan(&name); err != nil {
		writeErr(w, http.StatusInternalServerError, "招待コードの確認に失敗しました")
		return
	}
	writeJSON(w, http.StatusOK, addChildPreview{OK: true, ChildName: name, Relationship: a.firstRelationship(*u.GuardianID)})
}

/*
POST /api/guardian/children（詳細設計書「お子さまの追加」(4-15 (1))）。要求 { code, relationship } → { ok: true, child_id }。

  - 保護者だけ（職員は 403「保護者のみが行えます」）。アカウントが有効であることは requireUser が確かめる
  - 招待コードの検査は招待コードの確認と同じ（lookupUsableCode）。そのアカウントにすでに紐づいている園児なら 400
  - 続柄は前後の空白を落として1〜20文字（400「続柄を選んでください。」）。選択肢には絞らない（「その他」は文字で20文字まで。2-15 (2)）
  - 書き込みは1つの処理（addChildTx）。どれかに失敗したら全部を戻し、500「追加できませんでした。もう一度お試しください。」
  - 操作ログ：7・1（t_guardian_child、target_id は保護者のアカウント、target_child_id。基本設計書「操作ログ（t_operation_log）」(5-9)）
  - 知らせ：参加したルームへ chat（職員のメンバー一覧が読み直す）。保護者が参加したことを知らせる文は送らない（基本設計書「チャット」(5-6)）
*/
func (a *app) handleAddChild(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !u.isGuardian() || u.GuardianID == nil {
		writeForbidden(w, msgGuardianOnly)
		return
	}
	var in struct {
		Code         string `json:"code"`
		Relationship string `json:"relationship"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	code, err := a.lookupUsableCode(in.Code)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	status, err := guardianLinkStatus(a.db, *u.GuardianID, code.ChildID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgAddChildFailed)
		return
	}
	if alreadyAdded(status) {
		writeErr(w, http.StatusBadRequest, msgChildAlreadyAdded)
		return
	}
	relationship := strings.TrimSpace(in.Relationship)
	if relationship == "" || tooLong(relationship, relationshipMax) {
		writeErr(w, http.StatusBadRequest, msgRelationshipRequired)
		return
	}

	res, fail := a.addChildTx(u, code, relationship)
	if fail != nil {
		writeErr(w, fail.status, fail.message)
		return
	}
	// 【仮置き】変更後の値の文（web/仮置き値.md）。設計は 7・1 と対象だけを定め、入れる値を決めていない
	after := "招待コードでお子さまを追加"
	if res.restored {
		after = "招待コードでお子さまを追加（終了していた紐づけを有効へ戻した）"
	}
	a.log(u.AccountID, fnAccount, opCreate, "t_guardian_child", i64(u.AccountID), s(code.ChildID), nil, s(after))
	for _, roomID := range res.rooms {
		a.notifyRoomMembers(roomID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "child_id": code.ChildID})
}

// addChildResult は、お子さまの追加で書いたもの
type addChildResult struct {
	// 参加した（または参加し直した）ルーム。知らせを送る先
	rooms []int64
	// 終了（2）の行を有効へ戻したか
	restored bool
}

// addChildFailure は、お子さまの追加を断るときの応答
type addChildFailure struct {
	status  int
	message string
}

/*
addChildTx は、お子さまの追加の書き込みを1つの処理で行う（詳細設計書「お子さまの追加」(4-15 (1))）。
どこかで失敗したら全部を戻す（defer の Rollback）。取引の中では a.db へ問い合わせない（接続は1本。db.go）。

 1. 招待コードを使用済みにする（used_account_id・used_at）。新規登録と同じく「未使用なら」の条件付きの更新で押さえ、
    同時に同じコードを送ったときは、1つだけが進む（GitHub Issue #163 と同じ考え方）
 2. 紐づけ：行が無ければ作る（有効、linked_at は今、contact_order はその園児のいまの最大＋1、ai_opt_out は偽）。
    終了（2）の行があれば、新しい行を作らずに有効へ戻す（linked_at は今。決めたこと D-48）
 3. その園児の個人チャットへ、今の時刻で参加する。終了した紐づけを戻すときも、管理者の「紐づけを戻す」
    （api_admin.go の rejoinRoomsOfChild。もとの参加の時刻を保つ）と違い、今の時刻で新しく参加する（決めたこと D-48）
 4. いまのクラス（今年度）のクラスグループへ、まだ参加していなければ参加する。園全体は新規登録で参加済み

【仮置き】個人チャット・クラスグループのルームが無いときは、参加を飛ばして失敗にしない（新規登録の handleSignUpGuardian と同じ。
web/仮置き値.md）。設計では個人チャットは園児の登録の時点で作ってある（詳細設計書「園児の登録と個人チャット」(4-9)。PR #198）。
連絡順の「いまの最大」は、ほかの保護者の有効・猶予中の紐づけから数える（終了した紐づけは数えない。web/仮置き値.md）
*/
func (a *app) addChildTx(u *SessionUser, code usableCode, relationship string) (addChildResult, *addChildFailure) {
	var out addChildResult
	failed := &addChildFailure{status: http.StatusInternalServerError, message: msgAddChildFailed}
	guardianID := *u.GuardianID
	at := now()

	tx, err := a.db.Begin()
	if err != nil {
		return out, failed
	}
	defer tx.Rollback()

	// 1. 招待コードを使用済みにする
	res, err := tx.Exec(`UPDATE t_invitation_code SET status = '2', used_account_id = ?, used_at = ?
		WHERE invitation_code_id = ? AND status = '1' AND expires_on >= ?`, u.AccountID, at, code.ID, today())
	if err != nil {
		return out, failed
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return out, &addChildFailure{status: http.StatusBadRequest, message: msgInvitationUsed}
	}

	// 2. 紐づけ。連絡順は、その園児のほかの有効・猶予中の紐づけの最大＋1（連絡順は管理者が決め直す。基本設計書「連絡先の変更」(4-3)）
	status, err := guardianLinkStatus(tx, guardianID, code.ChildID)
	if err != nil {
		return out, failed
	}
	if alreadyAdded(status) {
		return out, &addChildFailure{status: http.StatusBadRequest, message: msgChildAlreadyAdded}
	}
	var order int
	if err := tx.QueryRow(`SELECT IFNULL(MAX(contact_order), 0) + 1 FROM t_guardian_child
		WHERE child_id = ? AND guardian_id <> ? AND link_status IN ('1', '3')`, code.ChildID, guardianID).Scan(&order); err != nil {
		return out, failed
	}
	if status == "2" {
		/*
		 * 【仮置き】戻すときの続柄はいま選んだもの、連絡順は上の最大＋1、AI の下書きを断ったか（ai_opt_out）は前の値のまま
		 * （web/仮置き値.md）。設計は新しい行の値だけを決めている。断ったのを黙って外すと、外部へ送る側へ倒れるため残す
		 */
		_, err = tx.Exec(`UPDATE t_guardian_child
			SET link_status = '1', linked_at = ?, ended_at = NULL, grace_ends_on = NULL, relationship = ?, contact_order = ?
			WHERE guardian_id = ? AND child_id = ? AND link_status = '2'`, at, relationship, order, guardianID, code.ChildID)
		out.restored = true
	} else {
		_, err = tx.Exec(`INSERT INTO t_guardian_child
			(guardian_id, child_id, relationship, link_status, linked_at, ai_opt_out, contact_order)
			VALUES (?, ?, ?, '1', ?, 0, ?)`, guardianID, code.ChildID, relationship, at, order)
	}
	if err != nil {
		return out, failed
	}

	// 3・4. 個人チャットと、いまのクラスのクラスグループ。参加中ならそのまま、抜けていたら今の時刻で参加し直す
	rooms, err := queryIDs(tx, `SELECT r.chat_room_id FROM m_chat_room r
		WHERE r.is_archived = 0
		  AND ((r.room_type = '4' AND r.child_id = ?)
		       OR (r.room_type = '2' AND r.class_id IN (
		             SELECT cc.class_id FROM t_class_child cc
		               JOIN m_class c ON c.class_id = cc.class_id AND c.fiscal_year = ?
		              WHERE cc.child_id = ?)))
		ORDER BY r.chat_room_id`, code.ChildID, fiscalYear, code.ChildID)
	if err != nil {
		return out, failed
	}
	for _, roomID := range rooms {
		// 【仮置き】参加し直す前の joined_at を first_joined_at に残す（すでにあれば変えない）。
		// DO UPDATE の中の t_chat_member.joined_at は書き換える前の値。個人チャットの「保護者がまだ1人もいなかった間の投稿は見せる」
		// 境（api_chat.go の firstGuardianJoinedAt）が、ここで joined_at を今にしても動かないように（web/仮置き値.md）
		res, err := tx.Exec(`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at, left_at)
			VALUES (?, ?, ?, NULL)
			ON CONFLICT(chat_room_id, account_id) DO UPDATE SET
			  first_joined_at = COALESCE(t_chat_member.first_joined_at, t_chat_member.joined_at),
			  joined_at = excluded.joined_at, left_at = NULL
			WHERE t_chat_member.left_at IS NOT NULL`, roomID, u.AccountID, at)
		if err != nil {
			return out, failed
		}
		// 参加中だった（きょうだいが同じクラスにいる）ルームは変わらない。
		// 【仮置き】知らせは参加の変わったルームへだけ送る（web/仮置き値.md）
		if n, _ := res.RowsAffected(); n > 0 {
			out.rooms = append(out.rooms, roomID)
		}
	}

	if err := tx.Commit(); err != nil {
		return out, failed
	}
	return out, nil
}

// aiOptOutLogField は、操作ログの変更前後に入れる項目の名前（詳細設計書「AI の下書きの利用」(4-15 (3))）
const aiOptOutLogField = "AI の下書きを使わない"

func aiOptOutLogValue(optOut bool) string {
	if optOut {
		return "使わない"
	}
	return "使う"
}

/*
POST /api/guardian/children/{childID}/ai-opt-out（詳細設計書「AI の下書きの利用」(4-15 (3))）。
要求 { opt_out: boolean } → { ok: true }。

  - ログイン中の保護者の、その園児との紐づけが有効（1）であること。無い・終了（2）は 403「この園児の連絡帳は開けません。」、
    猶予中（3）は 403「卒園・退園したお子さまの設定は変えられません。」（基本設計書「権限チェックの実装方針」(6-2) の、
    猶予中は AI の拒否の切り替えができない）
  - 園が AI を有効にしていること（ai.enabled = '1'）。無効なら 400「いまは AI の下書きを使っていません。」
  - 自分の紐づけの ai_opt_out だけを書き換える。ほかの家族の値は変えない・返さない（決めたこと D-49）。
    紐づく保護者の1人でも断れば、その園児には AI を使わない（api_ai.go の aiChildConsented が読む）
  - 操作ログ：7・2（t_guardian_child、target_id は保護者のアカウント、target_child_id、
    変更前後は {"AI の下書きを使わない": "使わない"} か "使う"）。知らせは送らない
*/
func (a *app) handleAiOptOut(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !u.isGuardian() || u.GuardianID == nil {
		writeForbidden(w, msgGuardianOnly)
		return
	}
	childID := r.PathValue("childID")
	var status string
	var before bool
	err := a.db.QueryRow(`SELECT gc.link_status, gc.ai_opt_out <> 0 FROM t_guardian_child gc
		JOIN m_child c ON c.child_id = gc.child_id AND c.is_deleted = 0
		WHERE gc.guardian_id = ? AND gc.child_id = ?`, *u.GuardianID, childID).Scan(&status, &before)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && status != "1" && status != "3") {
		writeForbidden(w, msgContactForbidden)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	if status == "3" {
		writeForbidden(w, msgGuardianSettingGrace)
		return
	}
	if a.settingText("ai.enabled", "0") != "1" {
		writeErr(w, http.StatusBadRequest, msgAiNotEnabled)
		return
	}
	var in struct {
		OptOut *bool `json:"opt_out"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.OptOut == nil {
		writeErr(w, http.StatusBadRequest, msgBadRequest)
		return
	}
	after := *in.OptOut
	optOut := 0
	if after {
		optOut = 1
	}
	// 自分の紐づけの行だけ。読んだあとに紐づけが有効でなくなっていれば書かない
	res, err := a.db.Exec(`UPDATE t_guardian_child SET ai_opt_out = ?
		WHERE guardian_id = ? AND child_id = ? AND link_status = '1'`, optOut, *u.GuardianID, childID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeForbidden(w, msgContactForbidden)
		return
	}
	// 【仮置き】変わったときだけ残す（基本設計書「操作ログ（t_operation_log）」(5-9) の「変更のあった項目だけを」に寄せた。web/仮置き値.md）
	if before != after {
		a.log(u.AccountID, fnAccount, opUpdate, "t_guardian_child", i64(u.AccountID), s(childID),
			s(fieldsJSON([]field{{aiOptOutLogField, aiOptOutLogValue(before)}})),
			s(fieldsJSON([]field{{aiOptOutLogField, aiOptOutLogValue(after)}})))
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// guardianAiOptOut は、ログイン中の保護者自身の、その園児との紐づけの ai_opt_out（GuardianToday.ai_opt_out。4-15 (3)）。
// ほかの家族の値は読まない
func (a *app) guardianAiOptOut(u *SessionUser, childID string) bool {
	var v int
	a.db.QueryRow(`SELECT ai_opt_out FROM t_guardian_child WHERE guardian_id = ? AND child_id = ?`, u.guardian(), childID).Scan(&v)
	return v != 0
}
