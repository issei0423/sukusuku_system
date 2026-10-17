package main

import "strings"

/*
連絡帳の参照と書き込みの判定（詳細設計書「判定の関数」(4-1 (2))、基本設計書「権限と参照範囲の判定」(4-2)）。

既存の canSeeChild は、保護者の猶予中（link_status = '3'）とフリーの職員（今年度の担任クラスが無い一般）を
扱っていないため、連絡帳には使わず、この関数で判定する（決めたこと D-18）。
モックは web/src/api/mock.ts の contactAccess・classContactAccess が同じ規則を持つ（関数の名前もそろえる）。

| 利用者 | Read | Write |
| 管理者 | 全園児 | 全園児 |
| 一般（今年度の担任クラスがある） | そのクラスに在籍する園児 | 同じ範囲 |
| 一般（今年度の担任クラスが無い。フリー） | 全園児 | なし |
| 保護者 | 紐づけが 1:有効 か 3:猶予中 の自児（linked_at で切らない） | 1:有効 のときだけ（家庭からだけに使う） |

権限の外も、園児が無いのも、同じ 403 と同じ文言（msgContactForbidden）にする。
*/
type access struct{ Read, Write bool }

// staffClassIDs は、その職員の今年度の担任クラス。年度は model.go の fiscalYear を使う
// （詳細設計書 (4-1 (2))「本版の実装は fiscalYear を使ってよい」）
func (a *app) staffClassIDs(u *SessionUser) []int64 {
	rows, err := a.db.Query(`SELECT cs.class_id FROM t_class_staff cs
		JOIN m_class c ON c.class_id = cs.class_id AND c.fiscal_year = ?
		WHERE cs.staff_id = ?`, fiscalYear, u.staff())
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out
}

func (a *app) contactAccess(u *SessionUser, childID string) access {
	var n int
	if a.db.QueryRow(`SELECT COUNT(*) FROM m_child WHERE child_id = ? AND is_deleted = 0`, childID).Scan(&n) != nil || n == 0 {
		return access{}
	}
	switch {
	case u.isAdmin():
		return access{Read: true, Write: true}
	case u.isGeneralStaff():
		classes := a.staffClassIDs(u)
		if len(classes) == 0 {
			return access{Read: true}
		}
		args := []any{childID}
		for _, id := range classes {
			args = append(args, id)
		}
		var hit int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_class_child WHERE child_id = ? AND class_id IN (?`+
			strings.Repeat(",?", len(classes)-1)+`)`, args...).Scan(&hit)
		return access{Read: hit > 0, Write: hit > 0}
	case u.isGuardian() && u.GuardianID != nil:
		var status string
		if a.db.QueryRow(`SELECT link_status FROM t_guardian_child WHERE guardian_id = ? AND child_id = ?`,
			*u.GuardianID, childID).Scan(&status) != nil {
			return access{}
		}
		return access{Read: status == "1" || status == "3", Write: status == "1"}
	}
	return access{}
}

// classContactAccess は、そのクラスの連絡帳（クラスの表・クラスのようす）を読めるか・書けるか。職員だけ
func (a *app) classContactAccess(u *SessionUser, classID int64) access {
	if !u.isStaff() {
		return access{}
	}
	var n int
	if a.db.QueryRow(`SELECT COUNT(*) FROM m_class WHERE class_id = ? AND fiscal_year = ?`, classID, fiscalYear).Scan(&n) != nil || n == 0 {
		return access{}
	}
	if u.isAdmin() {
		return access{Read: true, Write: true}
	}
	classes := a.staffClassIDs(u)
	if len(classes) == 0 {
		return access{Read: true}
	}
	for _, id := range classes {
		if id == classID {
			return access{Read: true, Write: true}
		}
	}
	return access{}
}

// contactClassOf は、その園児の今年度のクラス（無ければ 0）
func (a *app) contactClassOf(childID string) int64 {
	var id int64
	a.db.QueryRow(`SELECT cc.class_id FROM t_class_child cc
		JOIN m_class c ON c.class_id = cc.class_id AND c.fiscal_year = ?
		WHERE cc.child_id = ? LIMIT 1`, fiscalYear, childID).Scan(&id)
	return id
}

// settingList は、カンマ区切りの設定の値を分けて返す（詳細設計書「検査の共通の規則」(4-1 (5))）
func (a *app) settingList(key, fallback string) []string {
	out := []string{}
	for _, v := range strings.Split(a.settingText(key, fallback), ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func inList(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// 保護者へ出すきょうのようすの項目の既定（基本設計書「設定マスタ」(5-9)。すべて出す）
const defaultShowItems = "nap,meal,toilet,temperature,comment,photo,class"

// 「家庭から」の項目の既定（同上。すべて）
const defaultHomeItems = "temperature,night_sleep,breakfast,mood,pickup,message"

// eventItem は、出来事の種類を contact.show_items の項目の名前にする
func eventItem(eventType string) string {
	switch eventType {
	case "1":
		return "meal"
	case "2":
		return "toilet"
	case "3":
		return "temperature"
	case "4":
		return "comment"
	case "5":
		return "photo"
	}
	return ""
}

// guardianSeesItem は、保護者にその項目を出すか（開いた時点の設定で決める）。家庭からと園からは常に出す
func (a *app) guardianSeesItem(item string) bool {
	if item == "home" || item == "facility" {
		return true
	}
	return inList(a.settingList("contact.show_items", defaultShowItems), item)
}
