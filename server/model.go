package main

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// 演習用の固定基準日。デモデータの日付はこの日を軸に組み立てている
const demoToday = "2026-09-01"

// 現在の年度。m_class は年度ごとに別レコードとする（基本設計書 5-3）
const fiscalYear = 2026

// SessionUser は画面が扱うログイン中の利用者。テーブルではなく導出値。
type SessionUser struct {
	AccountID int64  `json:"account_id"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	// 職員なら staff_name、保護者なら guardian_name
	DisplayName string  `json:"display_name"`
	StaffID     *string `json:"staff_id"`
	GuardianID  *string `json:"guardian_id"`
	// 職員の所属クラス。共有端末での記録者の取り違えを防ぐため表示する（画面詳細図 1-1）
	ClassID   *int64  `json:"class_id"`
	ClassName *string `json:"class_name"`
	// 真の間は他機能を使わせない（基本設計書 5-2）
	IsTempPassword bool `json:"is_temp_password"`
	// 最新版の規約に同意済みか
	TermsAgreed bool `json:"terms_agreed"`
}

func (u *SessionUser) isAdmin() bool  { return u.Role == "1" }
func (u *SessionUser) isStaff() bool  { return u.Role == "1" || u.Role == "2" }
func (u *SessionUser) staff() string  { if u.StaffID == nil { return "" }; return *u.StaffID }
func (u *SessionUser) guardian() string { if u.GuardianID == nil { return "" }; return *u.GuardianID }

// Paged は一覧のページング結果（基本設計書「一覧表示とページング」(3-7)）
type Paged[T any] struct {
	Rows    []T `json:"rows"`
	Total   int `json:"total"`
	Page    int `json:"page"`
	PerPage int `json:"per_page"`
}

func page[T any](rows []T, p, perPage int) Paged[T] {
	if rows == nil {
		rows = []T{}
	}
	total := len(rows)
	from := (p - 1) * perPage
	if from > total {
		from = total
	}
	to := from + perPage
	if to > total {
		to = total
	}
	return Paged[T]{Rows: rows[from:to], Total: total, Page: p, PerPage: perPage}
}

// ---- 時刻。サーバの時刻を入れる（基本設計書 5-1） ----

func now() string   { return time.Now().Format("2006-01-02T15:04:05") }
func today() string { return time.Now().Format("2006-01-02") }

func plusMinutes(iso string, minutes int) string {
	t, err := time.ParseInLocation("2006-01-02T15:04:05", iso, time.Local)
	if err != nil {
		return iso
	}
	return t.Add(time.Duration(minutes) * time.Minute).Format("2006-01-02T15:04:05")
}

func fromNowMinutes(minutes int) string {
	return time.Now().Add(time.Duration(minutes) * time.Minute).Format("2006-01-02T15:04:05")
}

func addDays(iso string, days int) string {
	t, err := time.ParseInLocation("2006-01-02", iso, time.Local)
	if err != nil {
		return iso
	}
	return t.AddDate(0, 0, days).Format("2006-01-02")
}

// ageInMonths は月齢を応当日基準で算出する。
//
// 基準日の時点で、生年月日の応当日を何回迎えたかを月齢とする。
// 経過日数を 30 や 30.4375 で割る方式は採らない（要件定義書「月齢の算出規則」(7-1 No.6)）。
// 応当日が存在しない月（1月31日生まれの2月など）は、その月の末日を応当日とみなす。
//
// すべての機能がこの関数を呼ぶ。機能ごとに実装しない（基本設計書「月齢の算出」(4-8)）。
func ageInMonths(birthDate, baseDate string) int {
	by, bm, bd, ok1 := splitDate(birthDate)
	ny, nm, nd, ok2 := splitDate(baseDate)
	if !ok1 || !ok2 {
		return 0
	}
	months := (ny-by)*12 + (nm - bm)

	// 基準日の月に応当日が存在しなければ、その月の末日を応当日とみなす
	anniversary := bd
	if last := lastDayOfMonth(ny, nm); anniversary > last {
		anniversary = last
	}
	if nd < anniversary {
		months--
	}
	if months < 0 {
		return 0
	}
	return months
}

func splitDate(iso string) (y, m, d int, ok bool) {
	parts := strings.Split(iso, "-")
	if len(parts) < 3 {
		return 0, 0, 0, false
	}
	y, e1 := strconv.Atoi(parts[0])
	m, e2 := strconv.Atoi(parts[1])
	d, e3 := strconv.Atoi(parts[2][:2])
	return y, m, d, e1 == nil && e2 == nil && e3 == nil
}

func lastDayOfMonth(year, month int) int {
	return time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, time.Local).Day()
}

// formatAge は「1歳3か月」の形に整える
func formatAge(birthDate, baseDate string) string {
	m := ageInMonths(birthDate, baseDate)
	return fmt.Sprintf("%d歳%dか月", m/12, m%12)
}

// ---- NULL 許容の読み取り ----

func nullStr(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	v := s.String
	return &v
}

func nullInt(n sql.NullInt64) *int64 {
	if !n.Valid {
		return nil
	}
	v := n.Int64
	return &v
}

func nullFloat(f sql.NullFloat64) *float64 {
	if !f.Valid {
		return nil
	}
	v := f.Float64
	return &v
}

func strPtr(s string) *string { if s == "" { return nil }; return &s }
