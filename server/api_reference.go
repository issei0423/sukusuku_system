package main

import "net/http"

/*
 * 画面が同期的に使う参照データ
 *
 * 画面には「園児の氏名を引く」「クラス名を引く」「設定マスタの値を引く」といった、
 * 描画のたびに必要になる小さな参照がある。1つずつ問い合わせると往復が増えるため、
 * ログイン直後にまとめて取得し、画面側で保持する。
 *
 * 返す範囲はログイン中の利用者の参照範囲に従う。
 * 保護者には職員の名簿を返さない。チャットの送信者名はメッセージ側が持つため要らない。
 */

type referenceData struct {
	Classes    []ClassRoom           `json:"classes"`
	Children   []Child               `json:"children"`
	Staff      []staffName           `json:"staff"`
	Accounts   []accountName         `json:"accounts"`
	ClassNames map[string]string     `json:"class_names"`
	Settings   map[string]string     `json:"settings"`
	Categories []DevelopmentCategory `json:"categories"`
}

type staffName struct {
	StaffID   string `json:"staff_id"`
	StaffName string `json:"staff_name"`
}

type accountName struct {
	AccountID int64  `json:"account_id"`
	Name      string `json:"name"`
	Role      string `json:"role"`
}

func (a *app) handleReference(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	out := referenceData{
		Classes:    []ClassRoom{},
		Children:   []Child{},
		Staff:      []staffName{},
		Accounts:   []accountName{},
		ClassNames: map[string]string{},
		Settings:   map[string]string{},
		Categories: []DevelopmentCategory{},
	}

	if classes, err := a.selectableClasses(u); err == nil {
		out.Classes = classes
	}
	if children, err := a.visibleChildren(u); err == nil {
		out.Children = children
	}

	// クラス名は過年度ぶんも引けるようにする。過去の記録の表示に要るため
	if rows, err := a.db.Query(`SELECT class_id, class_name FROM m_class`); err == nil {
		for rows.Next() {
			var id int64
			var name string
			if rows.Scan(&id, &name) == nil {
				out.ClassNames[itoa64(id)] = name
			}
		}
		rows.Close()
	}

	if rows, err := a.db.Query(`SELECT setting_key, setting_value FROM m_setting`); err == nil {
		for rows.Next() {
			var k, v string
			if rows.Scan(&k, &v) == nil {
				out.Settings[k] = v
			}
		}
		rows.Close()
	}

	if rows, err := a.db.Query(`SELECT development_category_id, age_month_from, age_month_to,
		category_name, display_order FROM m_development_category ORDER BY display_order`); err == nil {
		for rows.Next() {
			var c DevelopmentCategory
			if rows.Scan(&c.DevelopmentCategoryID, &c.AgeMonthFrom, &c.AgeMonthTo,
				&c.CategoryName, &c.DisplayOrder) == nil {
				out.Categories = append(out.Categories, c)
			}
		}
		rows.Close()
	}

	// 職員の名簿とアカウントの一覧は職員にのみ返す
	if u.isStaff() {
		if rows, err := a.db.Query(`SELECT staff_id, staff_name FROM m_staff ORDER BY staff_id`); err == nil {
			for rows.Next() {
				var x staffName
				if rows.Scan(&x.StaffID, &x.StaffName) == nil {
					out.Staff = append(out.Staff, x)
				}
			}
			rows.Close()
		}
		if rows, err := a.db.Query(`SELECT account_id, role FROM m_account ORDER BY account_id`); err == nil {
			ids := []accountName{}
			for rows.Next() {
				var x accountName
				if rows.Scan(&x.AccountID, &x.Role) == nil {
					ids = append(ids, x)
				}
			}
			rows.Close()
			for i := range ids {
				ids[i].Name = a.accountName(ids[i].AccountID)
			}
			out.Accounts = ids
		}
	}
	writeJSON(w, http.StatusOK, out)
}
