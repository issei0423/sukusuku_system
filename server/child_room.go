package main

import (
	"database/sql"
	"fmt"
	"log"
)

// createPersonalRoom は園児の在籍クラスから個人チャットと職員参加者を作る。
// 詳細設計書「園児の登録と個人チャット」(4-9)。取引内では渡された dbtx だけを使う。
func createPersonalRoom(q dbtx, childID string) (int64, error) {
	var name string
	var classID int64
	if err := q.QueryRow(`SELECT c.child_name, cc.class_id FROM m_child c
		JOIN t_class_child cc ON cc.child_id = c.child_id
		JOIN m_class cl ON cl.class_id = cc.class_id AND cl.fiscal_year = ?
		WHERE c.child_id = ? AND c.is_deleted = 0 AND c.enrollment_status = '1'`, fiscalYear, childID).
		Scan(&name, &classID); err != nil {
		return 0, err
	}
	res, err := q.Exec(`INSERT INTO m_chat_room (room_type, class_id, room_name, is_archived, thread_status, child_id)
		VALUES ('4', ?, ?, 0, '2', ?)`, classID, name+"の保護者", childID)
	if err != nil {
		return 0, err
	}
	roomID, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	if err := syncPersonalRoomStaff(q, roomID); err != nil {
		return 0, err
	}
	return roomID, nil
}

func syncPersonalRoomStaff(q dbtx, roomID int64) error {
	ids, err := queryIDs(q, `SELECT account_id FROM m_account WHERE role IN ('1','2')`)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := syncStaffChatRooms(q, id); err != nil {
			return err
		}
	}
	return nil
}

// ensureMissingPersonalRooms は既存DBの在籍園児の不足分だけを補う（詳細設計書「既存の DB の移し方」(5-4)）。
func ensureMissingPersonalRooms(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ids, err := queryChildIDs(tx, `SELECT c.child_id FROM m_child c WHERE c.enrollment_status = '1' AND c.is_deleted = 0
		AND NOT EXISTS (SELECT 1 FROM m_chat_room r WHERE r.room_type = '4' AND r.child_id = c.child_id)
		AND EXISTS (SELECT 1 FROM t_class_child cc JOIN m_class cl ON cl.class_id = cc.class_id
			WHERE cc.child_id = c.child_id AND cl.fiscal_year = ?)`, fiscalYear)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := createPersonalRoom(tx, id); err != nil {
			return fmt.Errorf("園児 %s の個人チャットを作れません: %w", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("個人チャットの無い在籍園児に %d 件作りました", len(ids))
	return nil
}

func queryChildIDs(q dbtx, query string, args ...any) ([]string, error) {
	rows, err := q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func ensureChildNickname(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('m_child') WHERE name = 'nickname'`).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		_, err := db.Exec(`ALTER TABLE m_child ADD COLUMN nickname TEXT NOT NULL DEFAULT ''`)
		return err
	}
	return nil
}
