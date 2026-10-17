package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

/*
 * 日誌の写真（添付）の保存（GitHub Issue #175 の 2）
 * 典拠：基本設計書.md「日誌の作成から保護者への共有」(4-5)「保育士が雛形を選び、本文・定型文・写真を入力する」、
 *      「雛形・添付」(5-4)「t_diary_attachment｜1〜3枚」、「設定マスタ」(5-8) attachment.max_count_diary・
 *      attachment.allowed_types、図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目10・「日誌確認画面」(3-3) 項目3
 *
 * 実体は持たず、ファイルの名前と形式だけを持つ（web/仮置き値.md 7「添付ファイルの実体」）。
 * 画面側のモック（web/src/api/mock.ts の saveDiary）と同じ規則であることを、web/tests/diaryEdit.test.ts と同じ観点で確かめる。
 */

// withPhotos は、保存の本文に写真の並びを添える
func withPhotos(body string, photos ...string) string {
	items := make([]string, len(photos))
	for i, p := range photos {
		items[i] = `{"file_path":"` + p + `","file_type":"image/jpeg"}`
	}
	return strings.Replace(body, `"status"`, `"attachments":[`+strings.Join(items, ",")+`],"status"`, 1)
}

// photosOf は、日誌の添付のファイル名を、並びのとおりに返す
func photosOf(t *testing.T, h http.Handler, c *http.Cookie, diaryID int64) []string {
	t.Helper()
	var rows []DiaryAttachment
	if err := json.Unmarshal(call(t, h, c, "GET", "/api/diaries/"+itoa(diaryID)+"/attachments", "").Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(rows))
	for i, r := range rows {
		if r.FileType != "image/jpeg" {
			t.Errorf("写真 %s の形式 = %q、want image/jpeg", r.FilePath, r.FileType)
		}
		out[i] = r.FilePath
	}
	return out
}

func samePhotos(got []string, want ...string) bool {
	return strings.Join(got, ",") == strings.Join(want, ",")
}

// 下書き保存・申請のどちらでも、画面で足した写真が日誌に付き、開き直しても承認画面でも同じ写真が見える
func TestDiaryPhotosAreSaved(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff") // 高梨 倫太朗（S003・さくら組）
	admin := loginAs(a, 1, "staff")   // 野原 一誠（S001・管理者）

	// 新しく書いて、写真 2 枚を付けて下書き保存する
	rec := call(t, h, teacher, "POST", "/api/diaries",
		withPhotos(personalDiary(0, "C001", "1", today(), "園庭で遊びました。", "1"), "demo/photo-a", "demo/photo-b"))
	id := diaryOf(t, rec.Body.Bytes()).DiaryID
	if got := photosOf(t, h, teacher, id); !samePhotos(got, "demo/photo-a", "demo/photo-b") {
		t.Fatalf("下書き保存のあとの写真 = %v、want [demo/photo-a demo/photo-b]", got)
	}

	// 開き直して 1 枚を消し、2 枚を足して申請する。写真は画面の並びで置き換わる
	token := acquireToken(t, h, teacher, itoa(id))
	call(t, h, teacher, "POST", "/api/diaries",
		withPhotos(withLock(personalDiary(id, "C001", "1", today(), "園庭で遊びました。", "2"), token),
			"demo/photo-b", "demo/photo-c", "demo/photo-d"))
	want := []string{"demo/photo-b", "demo/photo-c", "demo/photo-d"}
	if got := photosOf(t, h, teacher, id); !samePhotos(got, want...) {
		t.Errorf("申請のあとの写真 = %v、want %v", got, want)
	}
	// 承認画面で見る写真も同じ（図/画面詳細図.md「日誌承認画面（管理者）」(3-5) 項目3）
	if got := photosOf(t, h, admin, id); !samePhotos(got, want...) {
		t.Errorf("管理者が見る写真 = %v、want %v", got, want)
	}
}

// 写真の並びを送らない保存（写真を扱わない呼び出し）は、付いている写真を消さない
func TestDiarySaveWithoutPhotosKeepsThem(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")

	rec := call(t, h, teacher, "POST", "/api/diaries",
		withPhotos(personalDiary(0, "C001", "1", today(), "本文", "1"), "demo/photo-a"))
	id := diaryOf(t, rec.Body.Bytes()).DiaryID
	token := acquireToken(t, h, teacher, itoa(id))
	call(t, h, teacher, "POST", "/api/diaries", withLock(personalDiary(id, "C001", "1", today(), "本文を直した", "1"), token))
	if got := photosOf(t, h, teacher, id); !samePhotos(got, "demo/photo-a") {
		t.Errorf("写真を送らない保存のあとの写真 = %v、want [demo/photo-a]", got)
	}

	// 空の並びを送ったら、すべて外す（画面で写真をすべて消して保存したとき）
	call(t, h, teacher, "POST", "/api/diaries",
		withPhotos(withLock(personalDiary(id, "C001", "1", today(), "本文を直した", "1"), token)))
	if got := photosOf(t, h, teacher, id); len(got) != 0 {
		t.Errorf("写真をすべて消して保存したあとの写真 = %v、want []", got)
	}
}

// 写真は 3 枚まで（設定マスタ attachment.max_count_diary）、形式は JPEG・PNG（attachment.allowed_types）。
// 断ったときは、日誌も写真も書かない
func TestDiaryPhotosAreLimited(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	countDiaries := func() int {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_diary`).Scan(&n)
		return n
	}
	countPhotos := func() int {
		var n int
		a.db.QueryRow(`SELECT COUNT(*) FROM t_diary_attachment`).Scan(&n)
		return n
	}
	diaries, photos := countDiaries(), countPhotos()
	base := personalDiary(0, "C001", "1", today(), "本文", "1")

	cases := []struct {
		name, body, wantMsg string
	}{
		{"4 枚", withPhotos(base, "p1", "p2", "p3", "p4"), "写真は3枚までです"},
		{"PDF", strings.Replace(base, `"status"`,
			`"attachments":[{"file_path":"demo/a.pdf","file_type":"application/pdf"}],"status"`, 1), "JPEG・PNG"},
		{"名前が空", strings.Replace(base, `"status"`,
			`"attachments":[{"file_path":" ","file_type":"image/png"}],"status"`, 1), "写真のファイル"},
	}
	for _, c := range cases {
		rec := request(t, h, teacher, "POST", "/api/diaries", c.body)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), c.wantMsg) {
			t.Errorf("%s: %d %s、want 400 と「%s」", c.name, rec.Code, rec.Body.String(), c.wantMsg)
		}
	}
	if countDiaries() != diaries || countPhotos() != photos {
		t.Errorf("断った保存で書かれた：日誌 %d→%d 件、写真 %d→%d 件", diaries, countDiaries(), photos, countPhotos())
	}

	// 既存の日誌でも同じ。断ったときは本文も写真も変えない
	token := acquireToken(t, h, teacher, "1")
	rec := request(t, h, teacher, "POST", "/api/diaries",
		withPhotos(withLock(personalDiary(1, "C001", "1", today(), "書き換えた本文", "1"), token), "p1", "p2", "p3", "p4"))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("既存の日誌に 4 枚：%d %s、want 400", rec.Code, rec.Body.String())
	}
	if diaryBodyOf(t, a, 1) == "書き換えた本文" {
		t.Error("写真の上限で断った保存で、本文が書き換わった")
	}
}

// 設定マスタの形式の並びに空白が混じっていても（「image/jpeg, image/png」）、並べた形式を受け付ける（レビューの指摘）
func TestDiaryPhotoTypesToleratesSpacesInSetting(t *testing.T) {
	a, h := newTestApp(t)
	teacher := loginAs(a, 3, "staff")
	if _, err := a.db.Exec(`UPDATE m_setting SET setting_value = 'image/jpeg, image/png'
		WHERE setting_key = 'attachment.allowed_types'`); err != nil {
		t.Fatal(err)
	}
	rec := request(t, h, teacher, "POST", "/api/diaries", strings.Replace(personalDiary(0, "C001", "1", today(), "本文", "1"),
		`"status"`, `"attachments":[{"file_path":"demo/p.png","file_type":"image/png"}],"status"`, 1))
	if rec.Code != http.StatusOK {
		t.Errorf("PNG の写真：%d %s、want 200", rec.Code, rec.Body.String())
	}
}
