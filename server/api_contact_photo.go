package main

import (
	"bytes"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

/*
連絡帳の写真（詳細設計書「写真を送る」(2-2 (7))・「写真」(3-3)・「きょうのようす」(4-4 (2))・(4-4 (3))、
基本設計書「写真の同意で止める規則」(4-2)・「添付ファイルの実体の保存先」(5-6)、決めたこと D-6）。

写真は段2（送る時点の守りを通してから届ける）。送る時点の検査は次の順（4-4 (2) の表）：
大きさ → 先頭のバイトで形式 → 写っている子か届ける子 → contactAccess の Write → 同意 → 届く家庭ごとの他児の名前。
実体はサーバの起動の引数 -files の下に置き、DB には -files からの道筋だけを持つ。公開ディレクトリに置かず、
GET /api/contact/photos/{id} で権限の判定を通してから配信する（写真の ID だけで配らない）。
モックは web/src/api/mock.ts の sendPhoto・photoUrl が同じ規則を持つ（実体は URL.createObjectURL）。
*/

// defaultFilesDir は、起動の引数 -files の既定（詳細設計書「写真」(4-4 (2))）
const defaultFilesDir = "files"

/*
maxPhotoPixels は、描き直す前に読む画像の画素数の上限。
【仮置き】設計に値が無い（web/仮置き値.md）。画面は長い辺 1600px に縮めてから送る（2-2 (7)）が、
10MB の PNG でも数万 px 四方を名乗れ、描き直しでサーバのメモリを使い切るため、先に大きさだけを読んで止める。
4800万画素のスマートフォンの写真（8000×6000）が通る値にした
*/
const maxPhotoPixels = 50_000_000

// contactPhotoOut は ContactPhoto（図/インタフェース一覧）。職員だけが受け取る形（写っている子を入れる）
type contactPhotoOut struct {
	ID              int64    `json:"contact_photo_id"`
	ContactDate     string   `json:"contact_date"`
	FileType        string   `json:"file_type"`
	FileSize        int64    `json:"file_size"`
	SubjectChildIDs []string `json:"subject_child_ids"`
	IsDeleted       bool     `json:"is_deleted"`
}

// photoRoot は、写真の実体を置く場所（-files。テストなどで空なら既定の files）
func (a *app) photoRoot() string {
	if a.filesDir == "" {
		return defaultFilesDir
	}
	return a.filesDir
}

// photoPath は、DB の file_path（-files からの道筋。区切りは /）を、ファイルの場所にする。-files の外を指させない
func (a *app) photoPath(rel string) string {
	return filepath.Join(a.photoRoot(), filepath.FromSlash(strings.TrimPrefix(path.Clean("/"+rel), "/")))
}

// splitIDs は、カンマ区切りの値を分ける。前後の空白を除き、空と重なりを落とす
func splitIDs(v string) []string {
	out := []string{}
	for _, x := range strings.Split(v, ",") {
		if x = strings.TrimSpace(x); x != "" && !inList(out, x) {
			out = append(out, x)
		}
	}
	return out
}

/*
redrawPhoto は、画像を読み直して描き直す（決めたこと D-6）。標準の image/jpeg・image/png だけを使う。
描き直すと、位置情報などの付帯情報（JPEG の APP 区画・PNG の tEXt などの塊）は残らない（読むときに捨て、書くときに作らない）。
JPEG は品質 85。返すのは描き直した中身と、拡張子。【仮置き】PNG は PNG のまま .png で置く（web/仮置き値.md）
*/
func redrawPhoto(img image.Image, fileType string) ([]byte, string, error) {
	var buf bytes.Buffer
	switch fileType {
	case "image/jpeg":
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85}); err != nil {
			return nil, "", err
		}
		return buf.Bytes(), ".jpg", nil
	case "image/png":
		if err := png.Encode(&buf, img); err != nil {
			return nil, "", err
		}
		return buf.Bytes(), ".png", nil
	}
	return nil, "", errors.New("描き直せない形式です: " + fileType)
}

// boolInt は、真偽を SQLite の 0・1 にする
func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// writeNewFile は、まだ無いファイルとして書く。途中で失敗したら書きかけを消す
func writeNewFile(name string, data []byte) error {
	f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(name)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

/*
POST /api/contact/photos（詳細設計書 (4-4 (2))）。multipart/form-data。
項目：file、subject_child_ids（写っている子。カンマ区切り。0人以上）、target_child_id（写っている子が0人のときの届ける子。1人）、
body（任意・200文字）、keep_in_growth（1 なら届く先の全員の出来事に付ける）、acknowledged_names（カンマ区切り）。
応答 { photo: ContactPhoto, events: ContactEvent[] }。
写真の行・写っている子の行（送った時点の同意を写す）・届く先ごとの出来事（種類 5）を1つの処理で作る。
ファイルを書けなかったら DB へ入れない。DB に入れられなかったら書いたファイルを消す
*/
func (a *app) handleSendPhoto(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireStaff(w, r)
	if !ok {
		return
	}
	// ① 本文の大きさは attachment.max_size_mb＋1MB まで。写真そのものは attachment.max_size_mb まで
	limit := int64(a.settingInt("attachment.max_size_mb", 10)) << 20
	r.Body = http.MaxBytesReader(w, r.Body, limit+1<<20)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) || r.ContentLength > limit+1<<20 {
			writeErr(w, http.StatusBadRequest, msgPhotoFormat)
			return
		}
		writeErr(w, http.StatusBadRequest, msgBadRequest)
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, _, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, msgPhotoFormat)
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	file.Close()
	if err != nil || len(data) == 0 || int64(len(data)) > limit {
		writeErr(w, http.StatusBadRequest, msgPhotoFormat)
		return
	}

	// ② 形式はファイルの先頭から決める。画面が申告した形式（Content-Type・ファイル名）は使わない。
	// 描き直せる形式（JPEG・PNG）で、attachment.allowed_types にあるものだけ。読めない中身も同じ文言で断る
	fileType := http.DetectContentType(data)
	if (fileType != "image/jpeg" && fileType != "image/png") ||
		!inList(a.settingList("attachment.allowed_types", "image/jpeg,image/png"), fileType) {
		writeErr(w, http.StatusBadRequest, msgPhotoFormat)
		return
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxPhotoPixels {
		writeErr(w, http.StatusBadRequest, msgPhotoFormat)
		return
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		writeErr(w, http.StatusBadRequest, msgPhotoFormat)
		return
	}

	// ③ 写っている子が1人以上か、0人なら届ける子が1人
	subjects := splitIDs(r.FormValue("subject_child_ids"))
	recipients := subjects
	target := strings.TrimSpace(r.FormValue("target_child_id"))
	if len(subjects) == 0 {
		if target == "" || strings.Contains(target, ",") {
			writeErr(w, http.StatusBadRequest, msgPhotoSubjectRequired)
			return
		}
		recipients = []string{target}
	}
	// 添える文（任意・200文字）と、成長の記録に残すか（4-12 (3)）。【仮置き】上限を超えたときは活動のひとことと同じ文（web/仮置き値.md）
	rawBody := r.FormValue("body")
	body := trimmedOrNil(&rawBody)
	if body != nil && tooLong(*body, 200) {
		writeErr(w, http.StatusBadRequest, msgCommentTooLong)
		return
	}
	keep := false
	switch r.FormValue("keep_in_growth") {
	case "", "0":
	case "1":
		keep = true
	default:
		writeErr(w, http.StatusBadRequest, msgBadChoice)
		return
	}

	// ④ 写っている子・届ける子のすべてについて contactAccess の Write。ページはサーバの今日（その日に在籍するクラスが要る）
	classOf := map[string]int64{}
	for _, id := range recipients {
		classID := a.contactClassOf(id)
		if !a.contactAccess(u, id).Write || classID == 0 {
			writeForbidden(w, msgContactForbidden)
			return
		}
		classOf[id] = classID
	}

	// ⑤ 同意：写っている子が1人なら 2 以上、2人以上なら全員 3。満たさない子の名前を集める。0人は条件なし
	consent := map[string]string{}
	failed := []string{}
	for _, id := range subjects {
		var level, name string
		if err := a.db.QueryRow(`SELECT photo_consent_level, child_name FROM m_child WHERE child_id = ?`, id).Scan(&level, &name); err != nil {
			writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
			return
		}
		consent[id] = level
		if (len(subjects) == 1 && level < "2") || (len(subjects) >= 2 && level != "3") {
			failed = append(failed, name)
		}
	}
	if len(failed) > 0 {
		writeErr(w, http.StatusBadRequest, photoConsentMessage(failed, len(subjects)))
		return
	}

	// ⑥ 添える文があれば、届く家庭ごとに他児の名前を照合する（写っているほかの子も相手。namecheck.go の checkOtherNames）。
	// 写っている子が0人なら、届ける子が宛先
	if body != nil && a.writeOtherNames(w, *body, "body", recipients, false, splitIDs(r.FormValue("acknowledged_names"))) {
		return
	}

	// 保存：描き直して付帯情報を落とし、-files の下の contact/YYYY/MM/<ランダムな32文字>.jpg（PNG は .png）に書く
	redrawn, ext, err := redrawPhoto(img, fileType)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	day := today()
	rel := path.Join("contact", day[:4], day[5:7], randomToken(24)+ext)
	full := a.photoPath(rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	if err := writeNewFile(full, redrawn); err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	// ここから先で DB に入れられなかったら、書いたファイルを消す
	saved := false
	defer func() {
		if !saved {
			os.Remove(full)
		}
	}()

	tx, err := a.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	defer tx.Rollback()
	at := now()
	size := int64(len(redrawn))
	// 写真の行の class_id は「撮ったクラス」（基本設計書「写真（t_contact_photo）」(5-4)）。【仮置き】届く先の先頭の園児のクラスを入れる（web/仮置き値.md）
	res, err := tx.Exec(`INSERT INTO t_contact_photo (class_id, contact_date, file_path, file_type, file_size, staff_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, classOf[recipients[0]], day, rel, fileType, size, u.staff(), at)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	photoID, _ := res.LastInsertId()
	for _, id := range subjects {
		if _, err := tx.Exec(`INSERT INTO t_contact_photo_child (contact_photo_id, child_id, consent_level) VALUES (?, ?, ?)`,
			photoID, id, consent[id]); err != nil {
			writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
			return
		}
	}
	eventIDs := []int64{}
	for _, id := range recipients {
		res, err := tx.Exec(`INSERT INTO t_contact_event (child_id, class_id, contact_date, event_type, recorded_at,
			body, contact_photo_id, keep_in_growth, staff_id, created_at, updated_at)
			VALUES (?, ?, ?, '5', ?, ?, ?, ?, ?, ?, ?)`,
			id, classOf[id], day, at, body, photoID, boolInt(keep), u.staff(), at, at)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
			return
		}
		eid, _ := res.LastInsertId()
		eventIDs = append(eventIDs, eid)
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, msgContactSaveFailed)
		return
	}
	saved = true

	// 操作ログ：写真の行に 8・1。写っている子が0人のときは {"写っている子":"なし"}（基本設計書「写真（t_contact_photo）」(5-4)）。
	// 【仮置き】届く先ごとの出来事にも 8・1 を残す（取り消しは出来事ごとに 8・4 を残すため、園児ごとに辿れるようにそろえた）
	var subjectValue any = subjects
	if len(subjects) == 0 {
		subjectValue = "なし"
	}
	photoFields := []field{{"写っている子", subjectValue}}
	if len(subjects) == 0 {
		photoFields = append(photoFields, field{"届ける子", target})
	}
	photoFields = append(photoFields, field{"file_type", fileType}, field{"file_size", size})
	var logChild *string
	if len(recipients) == 1 {
		logChild = &recipients[0]
	}
	a.log(u.AccountID, fnContact, opCreate, "t_contact_photo", i64(photoID), logChild, nil, s(fieldsJSON(photoFields)))
	events := []contactEventOut{}
	for i, eid := range eventIDs {
		childID := recipients[i]
		fields := append(eventLogFields("5", nil, nil, nil, body, nil, at), field{"contact_photo_id", photoID}, field{"keep_in_growth", keep})
		a.log(u.AccountID, fnContact, opCreate, "t_contact_event", i64(eid), &childID, nil, s(fieldsJSON(fields)))
		if e, err := a.loadContactEvent(eid); err == nil {
			events = append(events, e.contactEventOut)
		}
	}
	// 知らせ：届く先の園児ごとに contact（保護者には、contact.show_items に photo があるときだけ。events.go）
	for _, id := range recipients {
		a.notifyContactChild(id, "photo")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"photo": contactPhotoOut{ID: photoID, ContactDate: day, FileType: fileType, FileSize: size,
			SubjectChildIDs: subjects, IsDeleted: false},
		"events": events,
	})
}

/*
canSeePhoto は、その利用者にその写真の実体を返してよいか（詳細設計書「写真の実体」(4-4 (3))、
基本設計書「紐づけで判定する記録の、表ごとの確かめ方」(6-2)）。取り消した写真は呼ぶ側で断る。

| 利用者 | 返す条件 |
| 職員 | その写真を指す出来事の園児か、クラスのようすのクラスを Read できる |
| 保護者 | その写真を指す取り消していない出来事のうち、Read できる園児のものがある。または、Read できる園児がその日に在籍したクラスの |
|        | クラスのようすが指す。contact.show_items に photo が無ければ返さない |

その日に在籍したクラスは、在籍の期間で引く関数（classOfChildOn）がまだ無いため、今年度のクラス（contactClassOf）で見る。
モックは web/src/api/mock.ts の canSeePhoto
*/
func (a *app) canSeePhoto(u *SessionUser, photoID int64) bool {
	guardian := u.isGuardian()
	if !u.isStaff() && !guardian {
		return false
	}
	if guardian && !a.guardianSeesItem("photo") {
		return false
	}
	alive := ""
	if guardian {
		alive = " AND is_deleted = 0"
	}
	childIDs := []string{}
	rows, err := a.db.Query(`SELECT DISTINCT child_id FROM t_contact_event WHERE contact_photo_id = ?`+alive, photoID)
	if err != nil {
		return false
	}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			childIDs = append(childIDs, id)
		}
	}
	rows.Close()
	for _, id := range childIDs {
		if a.contactAccess(u, id).Read {
			return true
		}
	}
	classIDs := []int64{}
	crows, err := a.db.Query(`SELECT DISTINCT class_id FROM t_contact_class WHERE contact_photo_id = ?`+alive, photoID)
	if err != nil {
		return false
	}
	for crows.Next() {
		var id int64
		if crows.Scan(&id) == nil {
			classIDs = append(classIDs, id)
		}
	}
	crows.Close()
	if len(classIDs) == 0 {
		return false
	}
	if !guardian {
		for _, id := range classIDs {
			if a.classContactAccess(u, id).Read {
				return true
			}
		}
		return false
	}
	children, err := a.guardianContactChildren(u)
	if err != nil {
		return false
	}
	for _, c := range children {
		for _, id := range classIDs {
			if a.contactClassOf(c.ChildID) == id {
				return true
			}
		}
	}
	return false
}

/*
GET /api/contact/photos/{id}（詳細設計書 (4-4 (3))）。写真の実体を返す。
取り消した写真・条件に合わない・無い写真は、どれも 403「この写真は開けません。」（写真の ID だけで配らない）。
見出しは Content-Type（保存した形式）・Cache-Control: private, no-store・X-Content-Type-Options: nosniff
*/
func (a *app) handlePhotoFile(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id, valid := pathInt64(r, "id")
	var rel, fileType string
	var deleted bool
	if !valid || a.db.QueryRow(`SELECT file_path, file_type, is_deleted FROM t_contact_photo WHERE contact_photo_id = ?`, id).
		Scan(&rel, &fileType, &deleted) != nil || deleted || !a.canSeePhoto(u, id) {
		writeForbidden(w, msgPhotoForbidden)
		return
	}
	// 【仮置き】実体が無い（消えた・置き場所を変えた）ときも、同じ文言で断る（web/仮置き値.md）
	data, err := os.ReadFile(a.photoPath(rel))
	if err != nil {
		writeForbidden(w, msgPhotoForbidden)
		return
	}
	w.Header().Set("Content-Type", fileType)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}
