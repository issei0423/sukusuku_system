package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func staleFiles(t *testing.T, path string) []string {
	t.Helper()
	m, err := filepath.Glob(path + ".stale-*")
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func userVersion(t *testing.T, path string) int {
	t.Helper()
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// 新しく作った DB には、seed の指紋が user_version として書かれる
func TestFreshDBHasSeedFingerprint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fresh.db")
	if got, want := userVersion(t, path), seedFingerprint(); got != want || got <= 0 {
		t.Fatalf("user_version = %d, want %d（正の値）", got, want)
	}
}

// 指紋が違うデモの DB は、開き直すと退けて作り直される
func TestStaleDemoDBIsRebuilt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "demo.db")
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO m_setting (setting_key, setting_value, description, updated_staff_id, updated_at)
		   VALUES ('test.marker', 'old', '目印', 'S001', '2026-04-01T09:00:00')`,
		`PRAGMA user_version = 0`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	db.Close()

	db, err = openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	var marker, nishida, v int
	db.QueryRow(`SELECT COUNT(*) FROM m_setting WHERE setting_key = 'test.marker'`).Scan(&marker)
	db.QueryRow(`SELECT COUNT(*) FROM m_account WHERE email = 'nishida@hoiku.example.jp'`).Scan(&nishida)
	db.QueryRow(`PRAGMA user_version`).Scan(&v)
	db.Close()
	if marker != 0 {
		t.Error("作り直したのに目印が残っている")
	}
	if nishida != 1 {
		t.Error("いまの seed のアカウント nishida@hoiku.example.jp がいない")
	}
	if v != seedFingerprint() {
		t.Errorf("user_version = %d, want %d", v, seedFingerprint())
	}
	stale := staleFiles(t, path)
	if len(stale) != 1 {
		t.Fatalf(".stale-* が %d 個ある（%v）。1 個のはず", len(stale), stale)
	}
	// 退けたものは openDB でなく直接開く（openDB で開くとまた作り直される）
	old, err := sql.Open("sqlite", stale[0])
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	old.QueryRow(`SELECT COUNT(*) FROM m_setting WHERE setting_key = 'test.marker'`).Scan(&marker)
	if marker != 1 {
		t.Error("退けた DB に目印が残っていない")
	}
}

// 指紋が違っても、デモの DB でなければ作り直さない（user_version も書かない）
func TestStaleNonDemoDBIsKept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "real.db")
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`UPDATE m_account SET email = 'u' || account_id || '@school.test'`,
		`INSERT INTO m_setting (setting_key, setting_value, description, updated_staff_id, updated_at)
		   VALUES ('test.marker', 'real', '目印', 'S001', '2026-04-01T09:00:00')`,
		`PRAGMA user_version = 0`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	db.Close()

	db, err = openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	var marker, v int
	db.QueryRow(`SELECT COUNT(*) FROM m_setting WHERE setting_key = 'test.marker'`).Scan(&marker)
	db.QueryRow(`PRAGMA user_version`).Scan(&v)
	db.Close()
	if marker != 1 {
		t.Error("デモの DB でないのに作り直された")
	}
	if v != 0 {
		t.Errorf("user_version = %d。デモの DB でなければ書かない", v)
	}
	if n := len(staleFiles(t, path)); n != 0 {
		t.Errorf(".stale-* が %d 個できた", n)
	}
}

// example.jp のアカウントがあっても、1番のアカウントが seed の管理者でなければデモの DB とみなさない
// （確認用に example.jp のアカウントを作った本当の園の DB を取り違えない）
func TestDBWithoutSeedAdminIsKept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "school.db")
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`UPDATE m_account SET email = 'admin@school.test' WHERE account_id = 1`,
		`INSERT INTO m_setting (setting_key, setting_value, description, updated_staff_id, updated_at)
		   VALUES ('test.marker', 'school', '目印', 'S001', '2026-04-01T09:00:00')`,
		`PRAGMA user_version = 0`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	db.Close()

	db, err = openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	var marker int
	db.QueryRow(`SELECT COUNT(*) FROM m_setting WHERE setting_key = 'test.marker'`).Scan(&marker)
	db.Close()
	if marker != 1 || len(staleFiles(t, path)) != 0 {
		t.Errorf("1番が seed の管理者でないのに作り直された（目印 %d）", marker)
	}
}

// 指紋が同じ DB を開き直しても、データは残る
func TestSameFingerprintDBIsKept(t *testing.T) {
	path := filepath.Join(t.TempDir(), "same.db")
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO m_setting (setting_key, setting_value, description, updated_staff_id, updated_at)
		VALUES ('test.marker', 'kept', '目印', 'S001', '2026-04-01T09:00:00')`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var marker int
	db.QueryRow(`SELECT COUNT(*) FROM m_setting WHERE setting_key = 'test.marker'`).Scan(&marker)
	if marker != 1 || len(staleFiles(t, path)) != 0 {
		t.Errorf("指紋が同じなのに作り直された（目印 %d）", marker)
	}
}

// 退けた DB が4つ以上になると、新しいものから3つだけ残る（添えものも一緒に消える）
func TestStaleDBsAreCappedAtThree(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "demo.db")
	stamps := []string{"20261001T000000Z", "20261002T000000Z", "20261003T000000Z", "20261004T000000Z"}
	for _, s := range stamps {
		for _, suf := range []string{"", "-wal", "-shm"} {
			if err := os.WriteFile(path+".stale-"+s+suf, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	moved, err := moveAsideStaleDB(path, time.Date(2026, 10, 30, 1, 2, 3, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(moved, ".stale-20261030T010203Z") {
		t.Errorf("退けた先 = %s", moved)
	}
	var mains []string
	for _, f := range staleFiles(t, path) {
		if !strings.HasSuffix(f, "-wal") && !strings.HasSuffix(f, "-shm") {
			mains = append(mains, filepath.Base(f))
		}
	}
	want := []string{"demo.db.stale-20261003T000000Z", "demo.db.stale-20261004T000000Z", "demo.db.stale-20261030T010203Z"}
	if strings.Join(mains, ",") != strings.Join(want, ",") {
		t.Errorf("残ったもの %v, want %v", mains, want)
	}
	for _, f := range []string{".stale-20261001T000000Z", ".stale-20261002T000000Z"} {
		for _, suf := range []string{"", "-wal", "-shm"} {
			if _, err := os.Stat(path + f + suf); err == nil {
				t.Errorf("%s が残っている", f+suf)
			}
		}
	}
	if _, err := os.Stat(path + ".stale-20261004T000000Z-wal"); err != nil {
		t.Error("残すものの添えものまで消えた")
	}
}

// 指紋は改行が CRLF でも LF でも同じ
func TestSeedFingerprintIgnoresLineEndings(t *testing.T) {
	lf := "a\nb\nc\n"
	crlf := "a\r\nb\r\nc\r\n"
	if fingerprintOf(lf) != fingerprintOf(crlf) {
		t.Error("CRLF と LF で指紋が違う")
	}
	if fingerprintOf(lf) == fingerprintOf("a\nb\nd\n") {
		t.Error("中身が違うのに指紋が同じ")
	}
	if v := seedFingerprint(); v <= 0 || v > 0x7fffffff {
		t.Errorf("指紋 %d が正の 31 ビットでない", v)
	}
}

// コメントだけの行・空行・字下げだけの直しでは、指紋は変わらない（デモの DB を作り直さない）
func TestSeedFingerprintIgnoresCommentsAndBlankLines(t *testing.T) {
	base := "-- デモデータ\nINSERT INTO t VALUES (1);\n"
	same := "-- デモデータ（コメントを直した）\n\n  -- 足したコメント\n    INSERT INTO t VALUES (1);  \n"
	if fingerprintOf(base) != fingerprintOf(same) {
		t.Error("コメント・空行・字下げだけの違いで指紋が変わった")
	}
	if fingerprintOf(base) == fingerprintOf("-- デモデータ\nINSERT INTO t VALUES (2);\n") {
		t.Error("値が違うのに指紋が同じ")
	}
}

// SUKUSUKU_DEMO_RESEED=off なら、指紋が違うデモの DB でも作り直さない
func TestDemoReseedCanBeTurnedOff(t *testing.T) {
	t.Setenv("SUKUSUKU_DEMO_RESEED", "off")
	path := filepath.Join(t.TempDir(), "keep.db")
	db, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO m_setting (setting_key, setting_value, description, updated_staff_id, updated_at)
		   VALUES ('test.marker', 'keep', '目印', 'S001', '2026-04-01T09:00:00')`,
		`PRAGMA user_version = 0`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	db.Close()

	db, err = openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	var marker int
	db.QueryRow(`SELECT COUNT(*) FROM m_setting WHERE setting_key = 'test.marker'`).Scan(&marker)
	db.Close()
	if marker != 1 || len(staleFiles(t, path)) != 0 {
		t.Errorf("止めたのに作り直された（目印 %d）", marker)
	}
}
