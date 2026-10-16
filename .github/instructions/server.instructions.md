---
applyTo: "server/**"
---

# Go サーバ（server/）

`package main` の 1 パッケージ。配線は `routes.go`、ログイン中の利用者は `session.go`、
参照範囲は `scope.go`、応答の補助は `httpx.go`、操作ログは `oplog.go`。
ここの規則は画面側のモック（`web/src/api/mock.ts`）にも同じものがある。変えたらモックも直す。

## ハンドラの書き方

- 入口で `a.requireUser` / `a.requireStaff` / `a.requireAdmin` のどれかを呼び、`ok` が false なら何もせず return する（応答はもう書いてある）。
- ロールを見ただけでは足りない。**相手の園児・クラス・日誌が範囲の中か**を必ず確かめる。
  - 園児：`a.canSeeChild(u, childID)`。一覧は `a.visibleChildren(u)`
  - クラス：`a.canUseClass(u, classID)`。一般（保育士）は自クラスだけ
  - 日誌：`a.visibleDiaryCondition(u)` を WHERE に入れる
  - 添付・所属クラスのような**付属の情報も、本体と同じ範囲**で確かめる。「本体は拒否するのに付属は通す」「個人日誌は確かめるのにクラス日誌は確かめない」が見つかっている抜け（#153）
  - リクエストの `class_id`・`child_id` をそのまま信じない
- ロールは `u.isAdmin()` / `u.isGeneralStaff()` / `u.isStaff()` / `u.isGuardian()` で見る。`u.Role == "1"` と直接比べない（`model.go`）。
- 拒否は `writeForbidden(w, "…")`、それ以外の失敗は `writeErr(w, status, "…")`。文言は利用者にそのまま見せる日本語にし、SQL のエラーや設計書の章番号を出さない（#144）。モックの `fail('…')` と同じ文言にする。
- 状態を変える操作は `a.log(...)` で操作ログに残す。モックの `log(...)` でも同じ操作を残す。
- 文字数の上限は `tooLong`（rune で数える）。上限の正は基本設計書「入力項目の制約値」(4-9)。
- 記録の日付・時刻は `now()` / `today()` / `nowTime()`（JST）で作る。

## データベース

- 接続は 1 本だけ（`db.SetMaxOpenConns(1)`）。**`rows.Next()` の途中で別の問い合わせを投げると止まる**（`a.childName` などの名前引きも問い合わせ）。いったん読み切って `rows.Close()` してから引く（`api_diary.go` の `queryDiaries` → `enrich`）。
- `schema.sql` と `seed.sql` が流れるのは DB を新しく作るときだけ。列や表を足すときは、すでにある `sukusuku.db` へ足す `ensure…` 関数も `db.go` に書く（`ensureDesignColumns` が例）。
- 表は基本設計書「データベース設計」(5) と一致させている。設計に無い表・列を足すなら、PR に理由を書いて人に判断を任せる。
- デモデータ（`seed.sql`）を変えたら、モックのデモデータ（`web/src/api/mockDb.ts`）も合わせる。記録の表（`t_`）の `_date`・`_at` 列は起動日へずらされる（`seed_shift.go`）。

## テスト（`*_test.go`）

手本は `api_dashboard_test.go`。補助の関数はそこにあり、同じパッケージなので別のテストファイルからもそのまま使える（**作り直すと二重定義でビルドが通らない**）。

- `a, h := newTestApp(t)`：デモデータ入りの DB を一時フォルダに作る。作業ツリーの `sukusuku.db` には触らない。
- `loginAs(a, accountID, "staff")` / `loginAs(a, accountID, "guardian")`：セッションの Cookie を作る。ログインの手順は通らない。
  デモのアカウント：1＝管理者、3＝さくら組の担任、4＝一時パスワードのままの職員、5＝ひまわり組の担任、6＝保護者（野原 太郎）、7＝規約の再同意がまだの保護者、8＝停止中の保護者。
- `call(t, h, cookie, method, path, body)`：200 以外なら落とす。403 などを確かめるときは `httptest` で直接呼ぶ（`TestStaffSummaryFailsInsteadOfZeroUnhandled`）。
- `newTestApp` は `checkOrigin`（`csrf.go`）を通さない。送信元の確かめを試すときは `checkOrigin(h)` で包む。
- 権限は「通ること」と「拒否されること」の両方を書く。拒否は、他クラスの担任（3 と 5 を入れ替える）や、関係のない保護者で確かめる。
- デモの記録は起動日へずれる。一覧の末尾や件数を決め打ちせず、本文や ID で探す。
- `t.Run` の名前は日本語で、何を確かめるかを書く。テストの前のコメントに典拠を書く。
- `server/` で `go vet ./... && go test ./...`。
