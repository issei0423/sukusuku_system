package main

import (
	"fmt"
	"log"
	"net/http"
	"sort"
)

/*
推奨スケジュールの作り方（基本設計書「推奨スケジュールの作り方」(4-9)。docs と第3.0版の作り直し（design-v3-connect）で同じ文面）。

	最初の予定日：園児を登録した日（画面・CSV）を基準日とし、基準日の月齢の推奨頻度の日数を足した日
	健診の節目を優先：基準日と上の日のあいだに乳幼児健診の節目（1歳6か月・3歳・5歳の応当日）があれば、節目の日を予定日にする
	予定の無い在籍園児（第3.0版より前に登録した園児）には、管理者が一括で規則を当てる操作を置く

推奨頻度は m_development_frequency、節目の月齢は設定 dev.milestone_months（既定 18,36,60）から読み、
園が変えられる（基本設計書「推奨スケジュールの作り方に使う値」(5-8)）。
画面側のモック（web/src/api/mock.ts の recommendedScheduleDate・applyRecommendedSchedules）と同じ規則（GitHub Issue #164 の 3）。
*/

// defaultMilestoneMonths は、乳幼児健診の節目の既定（基本設計書「設定マスタ（m_setting）」(5-9) の dev.milestone_months）
const defaultMilestoneMonths = "18,36,60"

type devFrequency struct{ from, to, days int }

// scheduleRule は、予定日を作るのに使うマスタと設定。取引（tx）の中では a.db へ問い合わせない（db.go）ため、
// 取引の前に loadScheduleRule で読んでおき、取引の中ではこれだけで予定日を作る
type scheduleRule struct {
	frequencies []devFrequency
	milestones  []int
}

func (a *app) loadScheduleRule() scheduleRule {
	rule := scheduleRule{}
	rows, err := a.db.Query(`SELECT age_month_from, age_month_to, interval_days FROM m_development_frequency
		ORDER BY age_month_from`)
	if err == nil {
		for rows.Next() {
			var f devFrequency
			if rows.Scan(&f.from, &f.to, &f.days) == nil {
				rule.frequencies = append(rule.frequencies, f)
			}
		}
		rows.Close()
	}
	rule.milestones = parseMilestones(a.settingList("dev.milestone_months", defaultMilestoneMonths))
	return rule
}

// parseMilestones は、節目の月齢を小さい順に並べて返す。数として読めない値があれば、既定値へ戻して警告を出す
// （基本設計書「設定マスタ（m_setting）」(5-9)「既定値へフォールバックしたうえで警告ログを出力する」）
func parseMilestones(values []string) []int {
	out := []int{}
	for _, v := range values {
		n, ok := strictInt(v)
		if !ok || n <= 0 {
			log.Printf("[設定マスタ] dev.milestone_months の値 %q を月齢として解釈できません。既定値 %s を用います", v, defaultMilestoneMonths)
			return []int{18, 36, 60}
		}
		out = append(out, n)
	}
	sort.Ints(out)
	return out
}

/*
next は、基準日（baseDate）から予定日を作る。推奨頻度がマスタに無い月齢では作らない（ok = false）。

【仮置き】節目の「あいだ」は、基準日の翌日から、推奨頻度で数えた日の前日まで（web/仮置き値.md「健診の節目の『あいだ』」）。
基準日ちょうどが節目のときは、節目を予定日にしない。その日を予定日にすると、翌日から「過ぎた」になるため。
節目が2つ入るときは、早いほうを取る。
*/
func (r scheduleRule) next(birthDate, baseDate string) (string, bool) {
	age := ageInMonths(birthDate, baseDate)
	interval, found := 0, false
	for _, f := range r.frequencies {
		if age >= f.from && age <= f.to {
			interval, found = f.days, true
			break
		}
	}
	if !found {
		return "", false
	}
	next := addDays(baseDate, interval)
	for _, m := range r.milestones {
		if d := monthAnniversary(birthDate, m); d != "" && d > baseDate && d < next {
			return d, true
		}
	}
	return next, true
}

// monthAnniversary は、生年月日から months か月の応当日を返す。応当日が存在しない月（1月31日生まれの2月など）は、
// その月の末日とする。月齢の算出（ageInMonths）と同じ考え方で、この日に月齢がちょうど months になる
// （要件定義書「月齢の算出規則」(7-1 No.6)）
func monthAnniversary(birthDate string, months int) string {
	y, m, d, ok := splitDate(birthDate)
	if !ok {
		return ""
	}
	total := (m - 1) + months
	ty, tm := y+total/12, total%12+1
	if last := lastDayOfMonth(ty, tm); d > last {
		d = last
	}
	return fmt.Sprintf("%04d-%02d-%02d", ty, tm, d)
}

/*
handleApplyRecommendedSchedules は、予定の無い在籍園児に推奨スケジュールを当てる（管理者のみ）。

スケジュール設定画面の「予定の無い園児に推奨を当てる」から呼ぶ（基本設計書「推奨スケジュールの作り方」(4-9)
「予定の無い在籍園児には、管理者が一括で規則を当てる操作を置く」）。当てた園児ごとに操作ログへ残す。

【仮置き】基準日は、最後に確定した実施日。確定した記録が無ければ、当てた日（今日）。登録日を基準にすると、
長く在籍している園児が一斉に「過ぎた」になるため（web/仮置き値.md「予定の無い園児へ推奨を当てるときの基準日」）。
【仮置き】対象は、すべてのクラスの在籍園児のうち、予定が1件も無い園児。画面で選んでいるクラスに限らない
（web/仮置き値.md「一括で当てる範囲」）。
*/
func (a *app) handleApplyRecommendedSchedules(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	rule := a.loadScheduleRule()

	type target struct{ childID, scheduledOn, from string }
	targets := []target{}
	rows, err := a.db.Query(`SELECT c.child_id, c.birth_date,
		(SELECT MAX(d.checked_on) FROM t_development_check d WHERE d.child_id = c.child_id AND d.status = '2')
		FROM m_child c
		WHERE c.is_deleted = 0 AND c.enrollment_status = '1'
		  AND NOT EXISTS (SELECT 1 FROM t_development_schedule s WHERE s.child_id = c.child_id)
		ORDER BY c.child_id`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "スケジュールの設定に失敗しました")
		return
	}
	for rows.Next() {
		var (
			childID, birth string
			last           *string
		)
		if rows.Scan(&childID, &birth, &last) != nil {
			continue
		}
		base, from := today(), "当てた日から算出"
		if last != nil && *last != "" {
			base, from = *last, "最後の実施日から算出"
		}
		if d, ok := rule.next(birth, base); ok {
			targets = append(targets, target{childID, d, from})
		}
	}
	rows.Close()

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "スケジュールの設定に失敗しました")
		return
	}
	defer tx.Rollback()
	for _, t := range targets {
		if _, err := tx.Exec(`INSERT INTO t_development_schedule (child_id, scheduled_on, is_manual_override, created_staff_id)
			VALUES (?, ?, 0, ?)`, t.childID, t.scheduledOn, u.staff()); err != nil {
			writeErr(w, http.StatusInternalServerError, "スケジュールの設定に失敗しました")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "スケジュールの設定に失敗しました")
		return
	}
	for _, t := range targets {
		a.log(u.AccountID, fnDev, opCreate, "t_development_schedule", nil, s(t.childID), nil,
			s("次回予定日="+t.scheduledOn+"（推奨を一括で当てた。"+t.from+"）"))
		// 発達チェック一覧の予定日と、ダッシュボードの「未実施」が変わりうる（events.go）
		a.notifyDevelopment(t.childID, false)
	}
	writeJSON(w, http.StatusOK, map[string]int{"applied": len(targets)})
}
