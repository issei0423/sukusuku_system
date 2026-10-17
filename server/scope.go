package main

import (
	"database/sql"
	"log"
	"strconv"
)

/*
 * 参照範囲と権限の判定
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1)・「権限チェックの実装方針」(6-2)
 *      要件定義書「対象権限列の読み方」(4-2 冒頭)
 *
 * 画面側の出し分けは操作性のためであって、権限の担保ではない。担保はここで行う。
 */

// Child は園児（m_child）
type Child struct {
	ChildID           string   `json:"child_id"`
	ChildName         string   `json:"child_name"`
	ChildNameKana     string   `json:"child_name_kana"`
	Nickname          string   `json:"nickname"`
	BirthDate         string   `json:"birth_date"`
	Sex               string   `json:"sex"`
	NormalTemperature *float64 `json:"normal_temperature"`
	EnrollmentStatus  string   `json:"enrollment_status"`
	PhotoConsentLevel string   `json:"photo_consent_level"`
	IsDeleted         bool     `json:"is_deleted"`
	CreatedAt         string   `json:"created_at"`
	UpdatedAt         string   `json:"updated_at"`
}

const childColumns = `child_id, child_name, IFNULL(child_name_kana,''), nickname, birth_date, sex,
	normal_temperature, enrollment_status, photo_consent_level, is_deleted, created_at, updated_at`

func scanChild(rows interface{ Scan(...any) error }) (Child, error) {
	var c Child
	var temp sql.NullFloat64
	err := rows.Scan(&c.ChildID, &c.ChildName, &c.ChildNameKana, &c.Nickname, &c.BirthDate, &c.Sex,
		&temp, &c.EnrollmentStatus, &c.PhotoConsentLevel, &c.IsDeleted, &c.CreatedAt, &c.UpdatedAt)
	c.NormalTemperature = nullFloat(temp)
	return c, err
}

// canSeeChild は職員・保護者がその園児を参照できるかを判定する。
//
//   - 管理者は全園児
//   - 一般（保育士）は自クラスに限る
//   - 保護者は有効な紐づけのある自児に限る
func (a *app) canSeeChild(u *SessionUser, childID string) bool {
	switch u.Role {
	case "1":
		return true
	case "2":
		if u.ClassID == nil {
			return false
		}
		var n int
		err := a.db.QueryRow(`SELECT COUNT(*) FROM t_class_child WHERE class_id = ? AND child_id = ?`,
			*u.ClassID, childID).Scan(&n)
		return err == nil && n > 0
	default:
		if u.GuardianID == nil {
			return false
		}
		var n int
		err := a.db.QueryRow(`SELECT COUNT(*) FROM t_guardian_child
			WHERE guardian_id = ? AND child_id = ? AND link_status = '1'`,
			*u.GuardianID, childID).Scan(&n)
		return err == nil && n > 0
	}
}

// visibleChildren はその利用者が参照できる在籍中の園児を、かな順で返す。
func (a *app) visibleChildren(u *SessionUser) ([]Child, error) {
	base := `SELECT ` + childColumns + ` FROM m_child
	          WHERE is_deleted = 0 AND enrollment_status = '1'`
	var (
		rows *sql.Rows
		err  error
	)
	switch u.Role {
	case "1":
		rows, err = a.db.Query(base + ` ORDER BY child_name_kana`)
	case "2":
		if u.ClassID == nil {
			return []Child{}, nil
		}
		rows, err = a.db.Query(base+`
			AND child_id IN (SELECT child_id FROM t_class_child WHERE class_id = ?)
			ORDER BY child_name_kana`, *u.ClassID)
	default:
		if u.GuardianID == nil {
			return []Child{}, nil
		}
		rows, err = a.db.Query(base+`
			AND child_id IN (SELECT child_id FROM t_guardian_child
			                  WHERE guardian_id = ? AND link_status = '1')
			ORDER BY child_name_kana`, *u.GuardianID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Child{}
	for rows.Next() {
		c, err := scanChild(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ClassRoom はクラス（m_class）
type ClassRoom struct {
	ClassID    int64  `json:"class_id"`
	FiscalYear int    `json:"fiscal_year"`
	ClassName  string `json:"class_name"`
	// 年齢児（0:0歳児 … 5:5歳児）。午睡チェックの間隔を引く（基本設計書「クラスと紐づけ」(5-3)）
	AgeClass int `json:"age_class"`
}

// selectableClasses は職員が選べるクラス。一般は自クラスのみ（画面詳細図 3-1）。
func (a *app) selectableClasses(u *SessionUser) ([]ClassRoom, error) {
	q := `SELECT class_id, fiscal_year, class_name, age_class FROM m_class WHERE fiscal_year = ?`
	args := []any{fiscalYear}
	if u.isGeneralStaff() {
		if u.ClassID == nil {
			return []ClassRoom{}, nil
		}
		q += ` AND class_id = ?`
		args = append(args, *u.ClassID)
	}
	q += ` ORDER BY class_id`

	rows, err := a.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ClassRoom{}
	for rows.Next() {
		var c ClassRoom
		if err := rows.Scan(&c.ClassID, &c.FiscalYear, &c.ClassName, &c.AgeClass); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// canUseClass は、その職員がそのクラスを扱えるかを返す。
// 一般（保育士）は自クラスに限る（要件定義書「対象権限列の読み方」(4-2 冒頭)）。
func (a *app) canUseClass(u *SessionUser, classID int64) bool {
	if u.isAdmin() {
		return true
	}
	return u.isGeneralStaff() && u.ClassID != nil && *u.ClassID == classID
}

// ---- 名前の解決 ----

func (a *app) childName(childID string) string {
	var n string
	if err := a.db.QueryRow(`SELECT child_name FROM m_child WHERE child_id = ?`, childID).Scan(&n); err != nil {
		return childID
	}
	return n
}

func (a *app) staffName(staffID string) string {
	if staffID == "" {
		return "―"
	}
	var n string
	if err := a.db.QueryRow(`SELECT staff_name FROM m_staff WHERE staff_id = ?`, staffID).Scan(&n); err != nil {
		return staffID
	}
	return n
}

func (a *app) className(classID int64) string {
	var n string
	if err := a.db.QueryRow(`SELECT class_name FROM m_class WHERE class_id = ?`, classID).Scan(&n); err != nil {
		return "―"
	}
	return n
}

// accountName は職員なら staff_name、保護者なら guardian_name を返す
func (a *app) accountName(accountID int64) string {
	var n sql.NullString
	a.db.QueryRow(`SELECT COALESCE(s.staff_name, g.guardian_name)
	                 FROM m_account a
	                 LEFT JOIN m_staff    s ON s.account_id = a.account_id
	                 LEFT JOIN m_guardian g ON g.account_id = a.account_id
	                WHERE a.account_id = ?`, accountID).Scan(&n)
	if n.Valid {
		return n.String
	}
	return "アカウント" + strconv.FormatInt(accountID, 10)
}

// ---- 設定マスタ ----
//
// 設定値が数値として解釈できない場合は、既定値へフォールバックしたうえで
// 警告ログを出力する。異常を黙殺しない（基本設計書 5-8）。

func (a *app) settingInt(key string, fallback int) int {
	var v string
	if err := a.db.QueryRow(`SELECT setting_value FROM m_setting WHERE setting_key = ?`, key).Scan(&v); err != nil {
		log.Printf("[設定マスタ] %s が見つかりません。既定値 %d を用います", key, fallback)
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		log.Printf("[設定マスタ] %s の値 %q を数値として解釈できません。既定値 %d を用います", key, v, fallback)
		return fallback
	}
	return n
}

func (a *app) settingText(key, fallback string) string {
	var v string
	if err := a.db.QueryRow(`SELECT setting_value FROM m_setting WHERE setting_key = ?`, key).Scan(&v); err != nil {
		return fallback
	}
	return v
}
