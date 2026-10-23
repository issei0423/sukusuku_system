package main

import "testing"

// 朝（08:00）に起動したとき、今日の日誌の申請・承認・差し戻しの時刻が起動した時刻より後にならない（GitHub Issue #139）。
// 外さずに丸めるので、承認待ちの一覧は残る。前の日の日誌と、起動より前の時刻は動かさない
func TestCapFutureDemoDiaryTimes(t *testing.T) {
	a, _ := newTestApp(t)
	db := a.db
	d := today()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	// デモデータの夕方の時刻に戻す（newTestApp は今の時刻で丸め済みのため）
	exec(`UPDATE t_diary SET applied_at = ?, created_at = ?, updated_at = ? WHERE diary_id = 6`, d+"T17:00:00", d+"T17:00:00", d+"T17:00:00")
	exec(`UPDATE t_diary SET applied_at = ?, created_at = ?, updated_at = ? WHERE diary_id = 7`, d+"T17:20:00", d+"T17:20:00", d+"T17:20:00")
	// 差し戻し（差し戻しの時刻は updated_at）。作成は起動より前
	exec(`UPDATE t_diary SET status = '4', returned_reason = '直してください', created_at = ?, updated_at = ? WHERE diary_id = 1`, d+"T07:30:00", d+"T09:00:00")
	// 承認済み。申請は起動より前、承認は起動より後
	exec(`UPDATE t_diary SET diary_date = ?, created_at = ?, applied_at = ?, approved_at = ?, updated_at = ? WHERE diary_id = 5`,
		d, d+"T07:40:00", d+"T07:45:00", d+"T18:06:00", d+"T18:06:00")
	var before4 string
	db.QueryRow(`SELECT applied_at || approved_at || created_at || updated_at FROM t_diary WHERE diary_id = 4`).Scan(&before4)

	at := d + "T08:00:00"
	if err := capFutureDemoDiaryTimes(db, d, at); err != nil {
		t.Fatal(err)
	}

	type times struct{ created, applied, approved, updated string }
	get := func(id int) times {
		t.Helper()
		var r times
		var applied, approved *string
		if err := db.QueryRow(`SELECT created_at, applied_at, approved_at, updated_at FROM t_diary WHERE diary_id = ?`, id).
			Scan(&r.created, &applied, &approved, &r.updated); err != nil {
			t.Fatalf("diary %d: %v", id, err)
		}
		if applied != nil {
			r.applied = *applied
		}
		if approved != nil {
			r.approved = *approved
		}
		return r
	}

	// 承認待ちは消さずに残り、申請の時刻は起動した時刻になる
	var pending int
	db.QueryRow(`SELECT COUNT(*) FROM t_diary WHERE status = '2' AND is_deleted = 0 AND diary_date = ?`, d).Scan(&pending)
	if pending != 2 {
		t.Errorf("今日の承認待ち = %d 件, want 2（丸めるだけで消さない）", pending)
	}
	for _, id := range []int{6, 7} {
		if r := get(id); r.applied != at || r.created != at || r.updated != at {
			t.Errorf("diary %d = %+v, want すべて %s", id, r, at)
		}
	}
	// 差し戻しの時刻は丸め、起動より前の作成の時刻は動かさない
	if r := get(1); r.created != d+"T07:30:00" || r.updated != at {
		t.Errorf("差し戻し diary 1 = %+v", r)
	}
	// 申請 ≦ 承認 の順が保たれる
	if r := get(5); r.applied != d+"T07:45:00" || r.approved != at || r.updated != at || r.created > r.applied || r.applied > r.approved {
		t.Errorf("承認済み diary 5 = %+v", r)
	}
	// 今日の日誌に、起動した時刻より後の時刻は残らない
	var future int
	db.QueryRow(`SELECT COUNT(*) FROM t_diary WHERE substr(applied_at, 1, 10) = ?1 AND applied_at > ?2
		OR substr(approved_at, 1, 10) = ?1 AND approved_at > ?2
		OR substr(created_at, 1, 10) = ?1 AND created_at > ?2
		OR substr(updated_at, 1, 10) = ?1 AND updated_at > ?2`, d, at).Scan(&future)
	if future != 0 {
		t.Errorf("起動した時刻より後の時刻が %d 行に残った", future)
	}
	// 前の日の日誌は動かさない
	var after4 string
	db.QueryRow(`SELECT applied_at || approved_at || created_at || updated_at FROM t_diary WHERE diary_id = 4`).Scan(&after4)
	if after4 != before4 {
		t.Errorf("前の日の日誌が動いた: %s → %s", before4, after4)
	}
}
