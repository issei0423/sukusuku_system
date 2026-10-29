package main

import (
	"database/sql"
	"fmt"
	"math"
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
	// アカウントの状態（m_account.status。1:有効 2:停止）。画面へは返さない。
	// 停止中のアカウントのセッションを通さないために使う（session.go の requireLogin）
	status string
}

// SessionUser.Role に入る値（m_account.role）。DB には "1" 〜 "3" の文字列で
// 保存されている（基本設計書「データベース設計」(5-2)）。
//
// u.Role == "1" のように直接比較すると、コードを読んだだけでは「1」が何を指すか
// 分からない。そのため、以下の isAdmin() などのメソッドを通して使うこと。
const (
	roleAdmin        = "1" // 管理者
	roleGeneralStaff = "2" // 一般（保育士）
	roleGuardian     = "3" // 保護者
)

// isAdmin : ログイン中の利用者が管理者か
func (u *SessionUser) isAdmin() bool { return u.Role == roleAdmin }

// isGeneralStaff : ログイン中の利用者が一般（保育士）か
func (u *SessionUser) isGeneralStaff() bool { return u.Role == roleGeneralStaff }

// isStaff : ログイン中の利用者が職員（管理者 or 一般）か
func (u *SessionUser) isStaff() bool { return u.Role == roleAdmin || u.Role == roleGeneralStaff }

// isGuardian : ログイン中の利用者が保護者か
func (u *SessionUser) isGuardian() bool { return u.Role == roleGuardian }

// m_account.status に入る値（基本設計書「アカウント（m_account）」(5-2)）
const (
	accountActive    = "1" // 有効
	accountSuspended = "2" // 停止
)

// isSuspended : アカウントが停止されているか
func (u *SessionUser) isSuspended() bool { return u.status == accountSuspended }

func (u *SessionUser) staff() string {
	if u.StaffID == nil {
		return ""
	}
	return *u.StaffID
}
func (u *SessionUser) guardian() string {
	if u.GuardianID == nil {
		return ""
	}
	return *u.GuardianID
}

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

/*
 * 日付と時刻は日本標準時（JST）で扱う。
 *
 * 記録は日付そのものが意味を持つ（その日の日誌か、その日の午睡か）。
 * サーバの置き場所や端末の設定で日付が変わると、同じ記録が別の日のものに
 * 見えてしまう。国内の園で使うシステムであり、JST に固定してよい。
 * time.Local を使わないのは、動かす環境によって結果が変わるため。
 */
var jst = time.FixedZone("JST", 9*60*60)

// nowTime は JST での現在時刻。日付・時刻はすべてこれを起点にする
func nowTime() time.Time { return time.Now().In(jst) }

func now() string   { return nowTime().Format("2006-01-02T15:04:05") }
func today() string { return nowTime().Format("2006-01-02") }

/*
nextVersion は、行を書き換えるときの新しい updated_at（版）を返す。

読んだ版（updated_at）で「確認しました」・訂正・取り下げを確かめるため、書くたびに必ず前の値より進める。
同じ秒のうちに2回書き換えても別の版になる（詳細設計書「足す表」(5-2) の決めたこと D-40）。
今の時刻が前の値より後なら今の時刻、そうでなければ前の値の1秒後にする
*/
func nextVersion(previous string) string {
	current := now()
	if current > previous {
		return current
	}
	t, err := time.ParseInLocation("2006-01-02T15:04:05", previous, jst)
	if err != nil {
		return current
	}
	return t.Add(time.Second).Format("2006-01-02T15:04:05")
}

func plusMinutes(iso string, minutes int) string {
	t, err := time.ParseInLocation("2006-01-02T15:04:05", iso, jst)
	if err != nil {
		return iso
	}
	return t.Add(time.Duration(minutes) * time.Minute).Format("2006-01-02T15:04:05")
}

func fromNowMinutes(minutes int) string {
	return nowTime().Add(time.Duration(minutes) * time.Minute).Format("2006-01-02T15:04:05")
}

func addDays(iso string, days int) string {
	t, err := time.ParseInLocation("2006-01-02", iso, jst)
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

// splitDate は 'YYYY-MM-DD'（後ろに時刻が続いてもよい）を年月日に分ける。
//
// 形の崩れた値でも落ちない。読めなければ ok を偽で返し、月齢は 0 になる。
// 保存の API で検査を入れる前に入ってしまった値（2026-10-1 など）があっても、
// 一覧やダッシュボードが開けなくならないようにするため（GitHub Issue #164）。
// 1桁の月日は、そのまま数として読む
func splitDate(iso string) (y, m, d int, ok bool) {
	parts := strings.SplitN(iso, "-", 3)
	if len(parts) < 3 {
		return 0, 0, 0, false
	}
	day := parts[2]
	if i := strings.IndexAny(day, "T "); i >= 0 {
		day = day[:i]
	}
	y, e1 := strconv.Atoi(parts[0])
	m, e2 := strconv.Atoi(parts[1])
	d, e3 := strconv.Atoi(day)
	if e1 != nil || e2 != nil || e3 != nil || m < 1 || m > 12 || d < 1 || d > 31 {
		return 0, 0, 0, false
	}
	return y, m, d, true
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

// nullFloat は、空の値を nil にする。数でない値（+Inf・NaN）も nil にする。
// JSON にできず、園児を返す API がまとめて失敗するため。直す前の CSV 一括登録で平熱に inf が
// 入ったデータベースでも、一覧や午睡チェックを開けるようにする（GitHub Issue #160）
func nullFloat(f sql.NullFloat64) *float64 {
	if !f.Valid || math.IsInf(f.Float64, 0) || math.IsNaN(f.Float64) {
		return nil
	}
	v := f.Float64
	return &v
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }
