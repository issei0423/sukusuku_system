package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io/fs"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

/*
連絡帳の写真（詳細設計書「きょうのようす」(4-4 (2))・(4-4 (3))・「写真」(3-3)・「テストの観点」(9-1) の「写真の同意」、
基本設計書「写真の同意で止める規則」(4-2)、決めたこと D-6）。
モックの同じ観点は web/tests/contactPhoto.test.ts にある（実体の無いモックでは、同意と配信の判定だけ）。

デモデータの園児の写真の同意はすべて 2（自児の保護者へ共有）。同意を変えるテストは m_child を直接書き換える。
*/

// photoMarker は、付帯情報に入れておく目印。保存したファイルに残っていれば、付帯情報が落ちていない
const photoMarker = "GPSLatitude-35.6812-SUKUSUKU-MARKER"

// testImage は、描き直しを確かめるための小さな絵
func testImage() image.Image {
	img := image.NewRGBA(image.Rect(0, 0, 16, 12))
	for y := 0; y < 12; y++ {
		for x := 0; x < 16; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 16), uint8(y * 20), 128, 255})
		}
	}
	return img
}

// jpegWithExif は、位置情報の目印を APP1（Exif）区画に入れた JPEG
func jpegWithExif(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, testImage(), nil); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	payload := append([]byte("Exif\x00\x00"), []byte(photoMarker)...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	seg = append(seg, payload...)
	out := append([]byte{}, raw[:2]...) // SOI のすぐ後ろに入れる
	out = append(out, seg...)
	return append(out, raw[2:]...)
}

// pngChunk は、PNG の塊（長さ・種類・中身・CRC）を作る
func pngChunk(kind string, data []byte) []byte {
	out := make([]byte, 4)
	binary.BigEndian.PutUint32(out, uint32(len(data)))
	out = append(out, kind...)
	out = append(out, data...)
	crc := make([]byte, 4)
	binary.BigEndian.PutUint32(crc, crc32.ChecksumIEEE(append([]byte(kind), data...)))
	return append(out, crc...)
}

// pngWithText は、目印を tEXt の塊に入れた PNG
func pngWithText(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, testImage()); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	const afterIHDR = 8 + 4 + 4 + 13 + 4
	out := append([]byte{}, raw[:afterIHDR]...)
	out = append(out, pngChunk("tEXt", []byte("Comment\x00"+photoMarker))...)
	return append(out, raw[afterIHDR:]...)
}

// pngHeaderOnly は、大きさだけを名乗る PNG（画素の中身は無い）。描き直す前に大きさで止まるかを見る
func pngHeaderOnly(w, h uint32) []byte {
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8], ihdr[9] = 8, 2 // 8bit・RGB
	out := []byte("\x89PNG\r\n\x1a\n")
	out = append(out, pngChunk("IHDR", ihdr)...)
	return append(out, pngChunk("IEND", nil)...)
}

// sendPhoto は、写真を multipart/form-data で送る。画面が申告する形式はいつも image/jpeg（サーバは使わない）
func sendPhoto(t *testing.T, h http.Handler, c *http.Cookie, fields map[string]string, file []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	if file != nil {
		hdr := textproto.MIMEHeader{}
		hdr.Set("Content-Disposition", `form-data; name="file"; filename="photo.jpg"`)
		hdr.Set("Content-Type", "image/jpeg")
		part, err := mw.CreatePart(hdr)
		if err != nil {
			t.Fatal(err)
		}
		part.Write(file)
	}
	mw.Close()
	req := httptest.NewRequest("POST", "/api/contact/photos", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.AddCookie(c)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

type photoSent struct {
	Photo struct {
		ID              int64    `json:"contact_photo_id"`
		ContactDate     string   `json:"contact_date"`
		FileType        string   `json:"file_type"`
		FileSize        int64    `json:"file_size"`
		SubjectChildIDs []string `json:"subject_child_ids"`
		IsDeleted       bool     `json:"is_deleted"`
	} `json:"photo"`
	Events []struct {
		ID             int64   `json:"contact_event_id"`
		ChildID        string  `json:"child_id"`
		EventType      string  `json:"event_type"`
		Body           *string `json:"body"`
		ContactPhotoID *int64  `json:"contact_photo_id"`
		KeepInGrowth   bool    `json:"keep_in_growth"`
	} `json:"events"`
}

func decodePhoto(t *testing.T, rec *httptest.ResponseRecorder) photoSent {
	t.Helper()
	expectStatus(t, rec, http.StatusOK)
	var got photoSent
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

// filesUnder は、-files の下にあるファイルの数
func filesUnder(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			n++
		}
		return nil
	})
	return n
}

func countRows(t *testing.T, a *app, query string, args ...any) int {
	t.Helper()
	var n int
	if err := a.db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func setConsent(t *testing.T, a *app, childID, level string) {
	t.Helper()
	if _, err := a.db.Exec(`UPDATE m_child SET photo_consent_level = ? WHERE child_id = ?`, level, childID); err != nil {
		t.Fatal(err)
	}
}

func setSetting(t *testing.T, a *app, key, value string) {
	t.Helper()
	if _, err := a.db.Exec(`UPDATE m_setting SET setting_value = ? WHERE setting_key = ?`, value, key); err != nil {
		t.Fatal(err)
	}
}

func newPhotoApp(t *testing.T) (*app, http.Handler) {
	t.Helper()
	a, h := newTestApp(t)
	a.filesDir = t.TempDir()
	return a, h
}

// 検査の順（4-4 (2) の表）：大きさ → 先頭のバイトで形式 → 写っている子か届ける子 → contactAccess の Write → 同意。どれで止まっても保存しない
func TestContactPhotoChecks(t *testing.T) {
	a, h := newPhotoApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	jpg := jpegWithExif(t)
	one := map[string]string{"subject_child_ids": "C001"}
	expectMsg := func(t *testing.T, rec *httptest.ResponseRecorder, code int, msg string) {
		t.Helper()
		if b := expectStatus(t, rec, code); !strings.Contains(b, msg) {
			t.Errorf("文言 %q が無い: %s", msg, b)
		}
	}

	t.Run("大きさ：写真は attachment.max_size_mb まで、本文はそれに 1MB 足したところまで", func(t *testing.T) {
		setSetting(t, a, "attachment.max_size_mb", "1")
		defer setSetting(t, a, "attachment.max_size_mb", "10")
		// 写真が 1MB を超える（本文は 2MB まで通る）
		expectMsg(t, sendPhoto(t, h, teacher, one, append(append([]byte{}, jpg...), make([]byte, 1<<20)...)), http.StatusBadRequest, msgPhotoFormat)
		// 本文が 2MB を超える。写っている子が無くても、大きさで先に止まる
		expectMsg(t, sendPhoto(t, h, teacher, nil, append(append([]byte{}, jpg...), make([]byte, 5<<19)...)), http.StatusBadRequest, msgPhotoFormat)
	})

	t.Run("形式：先頭のバイトで決める。申告した形式（image/jpeg）は使わない。読めない中身・大きすぎる絵も断る", func(t *testing.T) {
		for name, file := range map[string][]byte{
			"GIF":              []byte("GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x00\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"),
			"文字":               []byte("これは写真ではありません"),
			"写真が無い":            nil,
			"JPEG の頭だけ":        []byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00ここから先は壊れている"),
			"2万 px 四方を名乗る PNG": pngHeaderOnly(20000, 20000),
		} {
			t.Run(name, func(t *testing.T) {
				// 写っている子が無くても、形式で先に止まる
				expectMsg(t, sendPhoto(t, h, teacher, nil, file), http.StatusBadRequest, msgPhotoFormat)
			})
		}
		setSetting(t, a, "attachment.allowed_types", "image/jpeg")
		defer setSetting(t, a, "attachment.allowed_types", "image/jpeg,image/png")
		expectMsg(t, sendPhoto(t, h, teacher, one, pngWithText(t)), http.StatusBadRequest, msgPhotoFormat)
	})

	t.Run("写っている子が無く、届ける子も無い（または2人）なら送れない", func(t *testing.T) {
		expectMsg(t, sendPhoto(t, h, teacher, map[string]string{}, jpg), http.StatusBadRequest, msgPhotoSubjectRequired)
		expectMsg(t, sendPhoto(t, h, teacher, map[string]string{"subject_child_ids": " , "}, jpg), http.StatusBadRequest, msgPhotoSubjectRequired)
		expectMsg(t, sendPhoto(t, h, teacher, map[string]string{"target_child_id": "C001,C002"}, jpg), http.StatusBadRequest, msgPhotoSubjectRequired)
	})

	t.Run("添える文は200文字まで。成長の記録に残すは 0・1 だけ", func(t *testing.T) {
		expectMsg(t, sendPhoto(t, h, teacher, map[string]string{"subject_child_ids": "C001", "body": strings.Repeat("あ", 201)}, jpg),
			http.StatusBadRequest, msgCommentTooLong)
		expectMsg(t, sendPhoto(t, h, teacher, map[string]string{"subject_child_ids": "C001", "keep_in_growth": "yes"}, jpg),
			http.StatusBadRequest, msgBadChoice)
	})

	t.Run("書ける園児でなければ 403（無い園児と同じ文言）。同意より先に断る", func(t *testing.T) {
		setConsent(t, a, childTaro, "1")
		defer setConsent(t, a, childTaro, "2")
		expectMsg(t, sendPhoto(t, h, otherTeacher, one, jpg), http.StatusForbidden, msgContactForbidden)
		expectStatus(t, sendPhoto(t, h, guardian, one, jpg), http.StatusForbidden)
		expectMsg(t, sendPhoto(t, h, teacher, map[string]string{"subject_child_ids": "C001,C013"}, jpg), http.StatusForbidden, msgContactForbidden)
		expectMsg(t, sendPhoto(t, h, teacher, map[string]string{"target_child_id": "C999"}, jpg), http.StatusForbidden, msgContactForbidden)
		// フリーの職員は読めるが書けない
		a.db.Exec(`DELETE FROM t_class_staff WHERE staff_id = 'S005'`)
		defer a.db.Exec(`INSERT INTO t_class_staff (class_id, staff_id) VALUES (2, 'S005')`)
		expectMsg(t, sendPhoto(t, h, otherTeacher, one, jpg), http.StatusForbidden, msgContactForbidden)
	})

	if n := countRows(t, a, `SELECT COUNT(*) FROM t_contact_photo`); n != 0 {
		t.Errorf("断った写真が %d 件保存された", n)
	}
	if n := filesUnder(t, a.filesDir); n != 0 {
		t.Errorf("断った写真のファイルが %d 個残った", n)
	}
}

// 同意の3通り（基本設計書「写真の同意で止める規則」(4-2)）：1人なら 2 以上、2人以上なら全員 3、写っている子が0人なら条件なし
func TestContactPhotoConsent(t *testing.T) {
	a, h := newPhotoApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	jpg := jpegWithExif(t)

	t.Run("1人：同意 1 は 400 で名前が入る。2 なら送れる", func(t *testing.T) {
		setConsent(t, a, childTaro, "1")
		b := expectStatus(t, sendPhoto(t, h, teacher, map[string]string{"subject_child_ids": "C001"}, jpg), http.StatusBadRequest)
		want := "野原 太郎さんは写真の同意が『園内記録として保持』のため送れません。写真を外すか、写っている子を見直してください。"
		if !strings.Contains(b, want) {
			t.Errorf("同意 1 の文言: %s", b)
		}
		setConsent(t, a, childTaro, "2")
		got := decodePhoto(t, sendPhoto(t, h, teacher, map[string]string{"subject_child_ids": "C001"}, jpg))
		if len(got.Events) != 1 || got.Events[0].ChildID != childTaro || got.Events[0].EventType != "5" {
			t.Fatalf("1人の写真の出来事: %+v", got.Events)
		}
		if lv := countRows(t, a, `SELECT COUNT(*) FROM t_contact_photo_child WHERE contact_photo_id = ? AND child_id = 'C001' AND consent_level = '2'`, got.Photo.ID); lv != 1 {
			t.Errorf("写っている子の行に送った時点の同意が写っていない")
		}
	})

	t.Run("2人以上：1人でも 3 でなければ 400 で、満たさない子の名前が入る。全員 3 なら全員に届く", func(t *testing.T) {
		setConsent(t, a, childTaro, "3")
		setConsent(t, a, "C006", "1")
		setConsent(t, a, "C002", "2")
		b := expectStatus(t, sendPhoto(t, h, teacher, map[string]string{"subject_child_ids": "C001,C006,C002"}, jpg), http.StatusBadRequest)
		want := "伊藤 葵さん・上園 花子さんは、ほかの保護者にも見える場への写真の同意がないため送れません。写真を外すか、写っている子を見直してください。"
		if !strings.Contains(b, want) || strings.Contains(b, "野原") {
			t.Errorf("2人以上の文言: %s", b)
		}
		setConsent(t, a, "C006", "3")
		before := countRows(t, a, `SELECT COUNT(*) FROM t_contact_photo`)
		got := decodePhoto(t, sendPhoto(t, h, teacher, map[string]string{"subject_child_ids": "C001, C006"}, jpg))
		if countRows(t, a, `SELECT COUNT(*) FROM t_contact_photo`) != before+1 {
			t.Fatal("写真の行が1行増えていない")
		}
		children := []string{}
		for _, e := range got.Events {
			if e.ContactPhotoID == nil || *e.ContactPhotoID != got.Photo.ID {
				t.Errorf("出来事が写真を指していない: %+v", e)
			}
			children = append(children, e.ChildID)
		}
		if strings.Join(children, ",") != "C001,C006" || strings.Join(got.Photo.SubjectChildIDs, ",") != "C001,C006" {
			t.Errorf("届く先 %v・写っている子 %v", children, got.Photo.SubjectChildIDs)
		}
	})

	t.Run("写っている子が0人：届ける子を1人選べば、同意に関わらず送れる。写っている子の行は作らず、操作ログに「なし」", func(t *testing.T) {
		setConsent(t, a, childMisaki, "1")
		got := decodePhoto(t, sendPhoto(t, h, teacher, map[string]string{"target_child_id": childMisaki, "subject_child_ids": ""}, jpg))
		if len(got.Events) != 1 || got.Events[0].ChildID != childMisaki || len(got.Photo.SubjectChildIDs) != 0 {
			t.Fatalf("0人の写真: %+v", got)
		}
		if n := countRows(t, a, `SELECT COUNT(*) FROM t_contact_photo_child WHERE contact_photo_id = ?`, got.Photo.ID); n != 0 {
			t.Errorf("写っている子の行が %d 行ある", n)
		}
		var after string
		a.db.QueryRow(`SELECT after_value FROM t_operation_log WHERE function_type = '8' AND operation_type = '1'
			AND target_table = 't_contact_photo' AND target_id = ?`, got.Photo.ID).Scan(&after)
		if !strings.HasPrefix(after, `{"写っている子":"なし","届ける子":"C004"`) {
			t.Errorf("操作ログ: %s", after)
		}
	})
}

// 添える文の他児の名前は、届く家庭ごとに照合する（詳細設計書 (4-4 (2))・(4-5 (2)) の④）
func TestContactPhotoNameCheckPerFamily(t *testing.T) {
	a, h := newPhotoApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	jpg := jpegWithExif(t)
	setConsent(t, a, childTaro, "3")
	setConsent(t, a, "C006", "3")
	body := "たっくんがスコップで砂を運んでいました。"

	// 1人なら「たっくん」は宛先の子の呼び名で、注意は出ない
	decodePhoto(t, sendPhoto(t, h, teacher, map[string]string{"subject_child_ids": "C001", "body": body}, jpg))

	// 2人が写ると、伊藤 葵の家庭には野原 太郎の呼び名が届く。写っている子どうしを互いに宛先にすると見落とす
	fields := map[string]string{"subject_child_ids": "C001,C006", "body": body}
	before := countRows(t, a, `SELECT COUNT(*) FROM t_contact_photo`)
	raw := expectStatus(t, sendPhoto(t, h, teacher, fields, jpg), http.StatusConflict)
	var e otherNamesResp
	json.Unmarshal([]byte(raw), &e)
	if e.Kind != kindOtherChildNames || strings.Join(e.Names, ",") != "野原 太郎" || !strings.Contains(e.Message, "（2 家庭）") ||
		len(e.Matches) != 1 || e.Matches[0].Start != 0 || e.Matches[0].End != 4 {
		t.Fatalf("家庭ごとの注意: %s", raw)
	}
	if countRows(t, a, `SELECT COUNT(*) FROM t_contact_photo`) != before || filesUnder(t, a.filesDir) != before {
		t.Fatal("注意を返したのに保存した")
	}
	fields["acknowledged_names"] = "野原 太郎"
	got := decodePhoto(t, sendPhoto(t, h, teacher, fields, jpg))
	if len(got.Events) != 2 || got.Events[0].Body == nil || *got.Events[0].Body != body {
		t.Fatalf("承諾して送った写真: %+v", got.Events)
	}
}

// 保存（描き直して付帯情報を落とす・-files の下）、届く先、知らせ、実体の配信（4-4 (3)）
func TestContactPhotoSaveAndServe(t *testing.T) {
	a, h := newPhotoApp(t)
	teacher := loginAs(a, accTeacher, "staff")
	otherTeacher := loginAs(a, accOtherTeacher, "staff")
	admin := loginAs(a, accAdmin, "staff")
	guardian := loginAs(a, accGuardian, "guardian")
	otherGuard := loginAs(a, accOtherGuard, "guardian")
	clients := map[string]*liveClient{
		"さくら組の担任":   listen(a, accTeacher),
		"ひまわり組の担任":  listen(a, accOtherTeacher),
		"野原 太郎の保護者": listen(a, accGuardian),
		"宮城 美咲の保護者": listen(a, accOtherGuard),
	}

	drainAll(clients)
	got := decodePhoto(t, sendPhoto(t, h, teacher,
		map[string]string{"subject_child_ids": "C001", "body": "砂場で型抜きをしました。", "keep_in_growth": "1"}, jpegWithExif(t)))
	if got.Photo.FileType != "image/jpeg" || got.Photo.ContactDate != today() || got.Photo.IsDeleted ||
		len(got.Events) != 1 || !got.Events[0].KeepInGrowth || got.Events[0].Body == nil {
		t.Fatalf("送った写真: %+v", got)
	}
	expect(t, "写っている子を読める人にだけ知らせる", clients,
		to(who("さくら組の担任", "野原 太郎の保護者"), liveEvent{Type: evContact, ChildID: childTaro}))

	t.Run("-files の下の contact/YYYY/MM/<32文字>.jpg に、付帯情報を落として描き直して置く", func(t *testing.T) {
		var rel string
		var size int64
		a.db.QueryRow(`SELECT file_path, file_size FROM t_contact_photo WHERE contact_photo_id = ?`, got.Photo.ID).Scan(&rel, &size)
		want := regexp.MustCompile(`^contact/` + today()[:4] + `/` + today()[5:7] + `/[A-Za-z0-9_-]{32}\.jpg$`)
		if !want.MatchString(rel) {
			t.Fatalf("file_path = %q", rel)
		}
		data, err := os.ReadFile(filepath.Join(a.filesDir, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, []byte(photoMarker)) || bytes.Contains(data, []byte("Exif")) {
			t.Error("保存したファイルに付帯情報が残っている")
		}
		if int64(len(data)) != size || size != got.Photo.FileSize {
			t.Errorf("大きさ: ファイル %d・DB %d・応答 %d", len(data), size, got.Photo.FileSize)
		}
		if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
			t.Errorf("保存したファイルが JPEG として読めない: %v", err)
		}
	})

	t.Run("保護者の連絡帳に出来事として出る。写っている子は出さない", func(t *testing.T) {
		rec := request(t, h, guardian, "GET", "/api/contact/children/C001", "")
		b := expectStatus(t, rec, http.StatusOK)
		if !strings.Contains(b, `"contact_photo_id":`+itoa(got.Photo.ID)) || strings.Contains(b, "subject") {
			t.Errorf("保護者の連絡帳: %s", b)
		}
	})

	photo := "/api/contact/photos/" + itoa(got.Photo.ID)
	t.Run("実体：読める人にだけ、見出しを付けて返す", func(t *testing.T) {
		for _, c := range []*http.Cookie{teacher, admin, guardian} {
			rec := request(t, h, c, "GET", photo, "")
			expectStatus(t, rec, http.StatusOK)
			for k, v := range map[string]string{"Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"} {
				if got := rec.Header().Get(k); got != v {
					t.Errorf("%s = %q, want %q", k, got, v)
				}
			}
			if _, err := jpeg.Decode(rec.Body); err != nil {
				t.Errorf("返した実体が JPEG として読めない: %v", err)
			}
		}
		for name, c := range map[string]*http.Cookie{"ほかの家庭": otherGuard, "ほかのクラスの担任": otherTeacher} {
			if b := expectStatus(t, request(t, h, c, "GET", photo, ""), http.StatusForbidden); !strings.Contains(b, msgPhotoForbidden) {
				t.Errorf("%s: %s", name, b)
			}
		}
		// 写真の ID を変えても取れない
		for _, p := range []string{"/api/contact/photos/99999", "/api/contact/photos/abc"} {
			expectStatus(t, request(t, h, teacher, "GET", p, ""), http.StatusForbidden)
		}
	})

	t.Run("保護者へ出す項目（contact.show_items）に photo が無ければ、保護者には返さない（職員には返す）", func(t *testing.T) {
		setSetting(t, a, "contact.show_items", "nap,meal,toilet,temperature,comment,class")
		defer setSetting(t, a, "contact.show_items", defaultShowItems)
		expectStatus(t, request(t, h, guardian, "GET", photo, ""), http.StatusForbidden)
		expectStatus(t, request(t, h, teacher, "GET", photo, ""), http.StatusOK)
	})

	t.Run("フリーの職員は読める", func(t *testing.T) {
		a.db.Exec(`DELETE FROM t_class_staff WHERE staff_id = 'S005'`)
		defer a.db.Exec(`INSERT INTO t_class_staff (class_id, staff_id) VALUES (2, 'S005')`)
		expectStatus(t, request(t, h, otherTeacher, "GET", photo, ""), http.StatusOK)
	})

	t.Run("取り消した写真は、だれにも返さない", func(t *testing.T) {
		expectStatus(t, request(t, h, teacher, "POST", "/api/contact/events/"+itoa(got.Events[0].ID)+"/cancel", `{}`), http.StatusOK)
		for _, c := range []*http.Cookie{teacher, admin, guardian} {
			if b := expectStatus(t, request(t, h, c, "GET", photo, ""), http.StatusForbidden); !strings.Contains(b, msgPhotoForbidden) {
				t.Errorf("取り消したあと: %s", b)
			}
		}
	})

	t.Run("PNG は PNG のまま描き直し、塊の付帯情報を落とす", func(t *testing.T) {
		sent := decodePhoto(t, sendPhoto(t, h, teacher, map[string]string{"target_child_id": childMisaki}, pngWithText(t)))
		rec := request(t, h, teacher, "GET", "/api/contact/photos/"+itoa(sent.Photo.ID), "")
		expectStatus(t, rec, http.StatusOK)
		if rec.Header().Get("Content-Type") != "image/png" || bytes.Contains(rec.Body.Bytes(), []byte(photoMarker)) {
			t.Errorf("PNG の実体: %s・目印 %v", rec.Header().Get("Content-Type"), bytes.Contains(rec.Body.Bytes(), []byte(photoMarker)))
		}
		var rel string
		a.db.QueryRow(`SELECT file_path FROM t_contact_photo WHERE contact_photo_id = ?`, sent.Photo.ID).Scan(&rel)
		if !strings.HasSuffix(rel, ".png") {
			t.Errorf("file_path = %q", rel)
		}
	})
}

// ファイルと DB の片方が失敗したら、もう片方も残さない（詳細設計書 (4-4 (2))）
func TestContactPhotoRollback(t *testing.T) {
	t.Run("DB に入れられなかったら、書いたファイルを消す", func(t *testing.T) {
		a, h := newPhotoApp(t)
		teacher := loginAs(a, accTeacher, "staff")
		if _, err := a.db.Exec(`ALTER TABLE t_contact_photo_child RENAME TO t_contact_photo_child_gone`); err != nil {
			t.Fatal(err)
		}
		expectStatus(t, sendPhoto(t, h, teacher, map[string]string{"subject_child_ids": "C001"}, jpegWithExif(t)), http.StatusInternalServerError)
		if n := filesUnder(t, a.filesDir); n != 0 {
			t.Errorf("ファイルが %d 個残った", n)
		}
		if n := countRows(t, a, `SELECT COUNT(*) FROM t_contact_photo`); n != 0 {
			t.Errorf("写真の行が %d 行残った", n)
		}
	})

	t.Run("ファイルを書けなかったら、DB へ入れない", func(t *testing.T) {
		a, h := newPhotoApp(t)
		teacher := loginAs(a, accTeacher, "staff")
		blocker := filepath.Join(t.TempDir(), "not-a-directory")
		if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		a.filesDir = blocker
		expectStatus(t, sendPhoto(t, h, teacher, map[string]string{"subject_child_ids": "C001"}, jpegWithExif(t)), http.StatusInternalServerError)
		if n := countRows(t, a, `SELECT COUNT(*) FROM t_contact_photo`); n != 0 {
			t.Errorf("写真の行が %d 行入った", n)
		}
		if n := countRows(t, a, `SELECT COUNT(*) FROM t_contact_event WHERE event_type = '5'`); n != 0 {
			t.Errorf("写真の出来事が %d 行入った", n)
		}
	})
}
