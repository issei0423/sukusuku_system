# すくすくシステム：Copilot への案内

保育園の職員と保護者が使う「すくすくシステム」のモックアップ（学校の企画開発演習）。
返事・コードのコメント・commit のメッセージ・PR と Issue の本文は**日本語**で書く。
ルートに `AGENTS.md` があれば、それも読むこと。
`server/` と `web/` には、このファイルに加えてパスごとの指示（`.github/instructions/`）がある。

## ブランチ

- 開発の本線は **`mockup-go-react`**。作業ブランチはここから切り、PR もここへ出す。
- デフォルトブランチの `mockup` は旧 Flask 版（参考として残しているだけ）。`docs` は設計書だけのブランチ。
- `mockup`・`mockup-go-react` へ直接 push しない。

## 構成

| 場所 | 中身 |
| :-- | :-- |
| `server/` | Go 1.27 ＋ SQLite（`modernc.org/sqlite`、純 Go）。API・スキーマ（`schema.sql`）・デモデータ（`seed.sql`） |
| `web/` | React 19 ＋ TypeScript ＋ Vite。画面は `src/screens/`、データ層は `src/api/`、テストは `tests/` |
| `MOCKUP.md` | 全体の説明。デモアカウント（パスワードは `pass1234`）、日付の扱い、テストの一覧 |
| `セットアップ手順.md` | 手元で動かす手順とつまずいたとき |
| `web/仮置き値.md` | 設計で決まっていない値を、どこにどう置いたか |

## コマンド

```
cd server && go vet ./... && go test ./...   # Go のテスト。DB は一時フォルダに作る
cd web && npm ci && npm test                  # 画面側のテスト（vitest）。モックが相手なのでサーバは要らない
cd web && npm run lint && npm run build       # oxlint（既存の警告がある）と、型検査つきのビルド
cd server && go run .                         # :8080。初回に server/sukusuku.db を作る
cd web && npm run dev                         # :5173。/api は 8080 へ中継される
cd web && npm run dev:mock                    # サーバを立てずに画面だけ
```

Go と画面をつないだ結合テストは、サーバを起動してから
`SUKUSUKU_API=http://localhost:8080 npm run test:integration`（`npm test` では飛ばされる）。

## いちばん大事な決まり：業務の規則は 2 か所にある

参照範囲・権限・承認の可否・入力の検証・操作ログの規則は、
**Go サーバ（`server/`）と画面側のモック（`web/src/api/mock.ts`）の両方**にある。片方だけ直すと食い違う。

- 規則を変えるときは**必ず両方**を直し、両方にテストを足す（Go は `server/*_test.go`、モックは `web/tests/`）。
- **権限の担保はサーバ側**（基本設計書「権限チェックの実装方針」(6-2)）。画面の出し分けやモックだけ直しても直したことにならない。
- API を足すときは `server/routes.go` とハンドラ、`web/src/api/http.ts`、`web/src/api/mock.ts` の 3 か所。返す形は `web/src/api/shapes.ts`・`types.ts` に合わせる。
- デモデータも 2 か所（`server/seed.sql` と `web/src/api/mockDb.ts`）。
- 日付と時刻は JST に固定している。記録の日付・時刻は、Go なら `now()`/`today()`（`server/model.go`）、画面なら `now()`/`today()`（`web/src/api/util.ts`）で作り、`time.Now()` や `new Date()` から直接作らない。

レビューでは、規則の変更が片側だけになっていないかを必ず見る。

## 設計書と、根拠の書き方

- 設計の正は `docs` ブランチの Markdown。`git fetch origin docs` のあと
  `git show origin/docs:基本設計書.md` で読む（ほかに `要件定義書.md`・`図/画面詳細図.md`・`ナレッジ/決定事項.md`）。
- コメントには根拠を書く。項目は**名前を主に、番号はカッコで添える**：`基本設計書「入力項目の制約値」(4-9)`。番号だけで書かない。
- 機能も番号でなく名前で呼ぶ（日誌システム・チャットツール・午睡チェック・発達チェック）。画面も名前で呼ぶ。
- 設計が決めていない値を置いたら `web/仮置き値.md` に「項目・仮置き・置いた場所」を足し、コードに `【仮置き】` と書く。
- 設計と食い違う、設計が決めていない、と気づいたら推測で決めない。PR や Issue に書いて人に判断を任せる。

## commit と PR

- commit のメッセージは、何をしたかを日本語の文で書く。例：「午睡の体温に範囲の確かめを足した（#142）」。
- PR の本文は日本語で、何を・なぜ・確かめたこと・**確かめていないこと**を書く。直した Issue の番号を添える。

## テストで気をつけること

- デモデータは「今日＝2026-09-01」を起動日へずらして作るので、テストは時刻に左右される（`MOCKUP.md`「日付と時刻の扱い」）。時刻に頼るテストは時計を固定する。
- Issue #152 が開いている間は、夜中から朝 7:40（JST）に `npm test` を回すと 2 件落ちる。既知の落ち方なので、ほかの変更のせいにしない。
- 落ちたテストを、期待値を書き換えて通さない。規則が変わったのか不具合なのかを確かめる。
