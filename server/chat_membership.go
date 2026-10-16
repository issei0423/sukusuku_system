package main

import (
	"database/sql"
	"log"
)

/*
 * チャットの参加者のうち、アカウント・ロール・担任の割り当てから決まるもの（GitHub Issue #162）
 * 典拠：基本設計書.md「チャット」(5-5)「チャンネルの使い分け」・職員チャットの規定
 *      要件定義書「チャットツール」(4-3)「チャンネル別の権限」・(a)「グループの種別」
 *
 * 職員を、どの自動構成のチャンネルに入れるかを、ここ1か所で決める。
 * 職員アカウントの発行・職員の情報の変更・停止と再開のたびに呼び、起動のときにも全職員について合わせ直す。
 *
 *   チャンネル                 入る職員
 *   園全体（room_type=1）      有効な全職員（投稿できるのは管理者だけ。api_chat.go）
 *   職員（room_type=5）        有効な全職員。作成・停止に連動し、手で編成しない
 *   クラス（room_type=2）      そのクラスの当年度の担任と、管理者
 *   個人（room_type=4）        その園児のクラスの当年度の担任と、管理者
 *   目的別（room_type=3）      ここでは決めない。職員がグループ編成画面で手で編成する
 *
 * 停止した職員は、自動構成のチャンネルからすべて外れる。外れるときは行を消さず left_at を入れる
 * （所属していた期間を残す。基本設計書 5-5）。再開・付け替えで戻るときは left_at を消して入れ直す。
 * アーカイブ（過年度のクラスグループ）は閲覧のみのまま残すため、ここでは動かさない。
 *
 * 【仮置き】個人チャットの担任は、ルームの class_id（園児のクラス）で決める。ルームと園児は
 * 名前（「園児名＋の保護者」）でしか結び付いておらず（GitHub Issue #140・#163）、名前で引くと、
 * 同じ氏名の園児が別のクラスにいたときに、ほかのクラスの家庭のやりとりに入ってしまうため。
 *
 * 保護者の参加（招待コードによる登録・紐づけの終了）は、ここでは扱わない（GitHub Issue #140・#171）。
 * 画面側のモック（web/src/api/mock.ts の syncStaffChatRooms）も同じ規則にしてある。片方だけ直すと食い違う。
 */

// dbtx は *sql.DB と *sql.Tx の両方で使うための共通部分。
// 取引の途中では a.db へ問い合わせてはならない（接続を1本に絞っているため。db.go）。
type dbtx interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// autoRoomsWhere は、アカウント・ロール・担任の割り当てから参加者が決まるチャンネル（m_chat_room を r として引く）
const autoRoomsWhere = `r.is_archived = 0 AND r.room_type IN ('1', '2', '4', '5')`

// syncStaffChatRooms は、職員1人の参加を規則に合わせる。入れたり外したりした数を返す。
// 職員でないアカウントには何もしない。
func syncStaffChatRooms(q dbtx, accountID int64) (int, error) {
	var role, status string
	if err := q.QueryRow(`SELECT role, status FROM m_account WHERE account_id = ?`, accountID).
		Scan(&role, &status); err != nil {
		return 0, err
	}
	if role != roleAdmin && role != roleGeneralStaff {
		return 0, nil
	}

	wanted := map[int64]bool{}
	if status == "1" {
		ids, err := queryIDs(q, `SELECT r.chat_room_id FROM m_chat_room r
			WHERE `+autoRoomsWhere+`
			  AND (r.room_type IN ('1', '5')
			       OR ? = '1'
			       OR r.class_id IN (SELECT cs.class_id FROM t_class_staff cs
			                           JOIN m_class c ON c.class_id = cs.class_id AND c.fiscal_year = ?
			                           JOIN m_staff s ON s.staff_id = cs.staff_id
			                          WHERE s.account_id = ?))`,
			role, fiscalYear, accountID)
		if err != nil {
			return 0, err
		}
		for _, id := range ids {
			wanted[id] = true
		}
	}

	current, err := queryIDs(q, `SELECT m.chat_room_id FROM t_chat_member m
		JOIN m_chat_room r ON r.chat_room_id = m.chat_room_id
		WHERE m.account_id = ? AND m.left_at IS NULL AND `+autoRoomsWhere, accountID)
	if err != nil {
		return 0, err
	}
	in := map[int64]bool{}
	changed := 0
	for _, id := range current {
		in[id] = true
		if wanted[id] {
			continue
		}
		if _, err := q.Exec(`UPDATE t_chat_member SET left_at = ? WHERE chat_room_id = ? AND account_id = ?`,
			now(), id, accountID); err != nil {
			return 0, err
		}
		changed++
	}
	for id := range wanted {
		if in[id] {
			continue
		}
		if _, err := q.Exec(`INSERT INTO t_chat_member (chat_room_id, account_id, joined_at, left_at)
			VALUES (?, ?, ?, NULL)
			ON CONFLICT(chat_room_id, account_id) DO UPDATE SET left_at = NULL, joined_at = excluded.joined_at`,
			id, accountID, now()); err != nil {
			return 0, err
		}
		changed++
	}
	return changed, nil
}

// queryIDs は1列の数値を読み切って返す。読み終えてからカーソルを閉じる（同じ接続で続けて書き込むため）
func queryIDs(q dbtx, query string, args ...any) ([]int64, error) {
	rows, err := q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

/*
syncChatMembership は、起動のときに全職員の参加を規則に合わせ直す。

以前のデータベースには、規則と食い違う参加が残っている。デモデータで管理者（上園）を個人チャットに
入れていなかったもの、職員の発行・付け替え・停止が反映されていなかったもの、グループ編成の API で
個人チャット・職員チャットへ入り込んだもの（GitHub Issue #161・#162）。参加は規則から決まるものに
改めたため、何度かけても同じ結果になる。食い違いが無ければ何も書き換えない。

あわせて、職員だけのチャンネル（職員・目的別）に入っている保護者を外す（基本設計書 5-5
「保護者は目的別グループへ入れない」、職員チャットの参加者「保護者は入らない」）。
*/
func (a *app) syncChatMembership() error {
	ids, err := queryIDs(a.db, `SELECT account_id FROM m_account WHERE role IN ('1', '2') ORDER BY account_id`)
	if err != nil {
		return err
	}
	changed := 0
	for _, id := range ids {
		n, err := syncStaffChatRooms(a.db, id)
		if err != nil {
			return err
		}
		changed += n
	}
	res, err := a.db.Exec(`UPDATE t_chat_member SET left_at = ?
		WHERE left_at IS NULL
		  AND account_id IN (SELECT account_id FROM m_account WHERE role = '3')
		  AND chat_room_id IN (SELECT chat_room_id FROM m_chat_room WHERE room_type IN ('3', '5'))`, now())
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	changed += int(n)
	if changed > 0 {
		log.Printf("チャットの参加者を %d 件、規則に合わせて直しました（職員の担任・ロール・状態から決まるもの）", changed)
	}
	return nil
}
