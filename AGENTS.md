# AGENTS.md — すくすくシステム モックアップ（Go ＋ React）

このリポジトリで作業する人と AI（Claude Code・Codex・Copilot など）のための決まり。
全体の説明は `MOCKUP.md`、手元で動かす準備は `セットアップ手順.md` にある。
返事・コードのコメント・commit・PR・Issue は日本語で書く。

## ブランチと PR

- 開発の本線は **`mockup-go-react`**。作業ブランチはここから切り、PR もここへ出す。
- `mockup` は旧 Flask 版で、参考として残しているだけ。`docs` は設計書だけのブランチ（下の「設計書」）。
- `mockup`・`mockup-go-react` へ直接 push しない。
- マージするかどうかは持ち主（`issei0423`）が決める。持ち主は、決めたマージを次のどちらかで任せる（2026-10-19 に持ち主が決めた）。
  - **マージ係**（`.github/workflows/merge.yml`）：PR に「マージ」のラベルを付けると、付けた順に 1 本ずつ、本線と合わせた形で CI を回し、ジョブが全部緑なら merge commit で入れる。受け付けるのは持ち主が付けたラベルだけ。
  - 持ち主が任せた AI：マージの順の Issue に従って「マージ」のラベルを付けるか、merge commit で押す。
- AI は、持ち主に任されていなければ「マージ」のラベルを付けない・マージしない。ラベルを付けることはマージと同じに扱う。
- マージは merge commit で入れる（Squash・Rebase にしない）。マージしたブランチは消さない。上に積んだ PR は、土台が入ったら base を `mockup-go-react` へ向け直す（マージ係は自分で向け直す）。
- マージ係は、下書き・ぶつかりのある PR・CI が赤の PR・`.github/` を変える PR を入れずに止め、「マージ止め」のラベルとコメントで理由を書く。直したら「マージ止め」を外し、「マージ」を付け直す。手でマージや向け直しをしたあとは `gh workflow run merge.yml` で続きを回す。
- PR を出すと CI（`.github/workflows/ci.yml`）がジョブ（server・web・結合 ほか）を並べて回す。ジョブが 1 つでも赤なら、マージしない。ジョブを足すときは、checkout に `ref: ${{ inputs.ref }}` を付ける（マージ係が本線と合わせた形を回すため）。

## 構成

| 場所 | 中身 |
| :-- | :-- |
| `server/` | Go ＋ SQLite（`modernc.org/sqlite`、純 Go）。API・スキーマ（`schema.sql`）・デモデータ（`seed.sql`）。権限の判定は `scope.go` ほか |
| `web/src/api/` | データ層。画面は `client.ts` だけを通す。`http.ts` が Go サーバへ、`mock.ts` がブラウザ内のモック（デモデータは `mockDb.ts`）へつなぐ。返す形は `shapes.ts` |
| `web/src/screens/` | 画面（機能ごとのフォルダ） |
| `web/tests/` | vitest。相手はモック。`integration.test.ts` だけが Go サーバにつなぐ |
| `web/仮置き値.md` | 設計で決まっていない値を、どこにどう置いたか |

## コマンド

```
cd server && go vet ./... && go test -count=1 ./...   # Go のテスト。DB は一時フォルダに作る
cd web && npm ci                                       # 依存を package-lock.json のとおりに入れる
cd web && npm test                                     # vitest（モックが相手。サーバは要らない）
cd web && npm run build                                # 型検査（tsc -b）と本番ビルド
cd web && npm run lint                                 # oxlint（既存の警告はある。エラーを出さない）
cd web && npm run review:responsive:check              # レスポンシブレビューの仕組みの型検査
cd server && go run .                                  # :8080。初回に server/sukusuku.db を作る
cd web && npm run dev                                  # :5173。/api は 8080 へ中継される
cd web && npm run dev:mock                             # サーバを立てずに画面だけ
```

結合テストは、サーバを立ててから `cd web && SUKUSUKU_API=http://localhost:8080 npm run test:integration`
（PowerShell では `$env:SUKUSUKU_API='http://localhost:8080'; npm run test:integration`）。
`server/sukusuku.db` を使い続けると、デモの日付は作ったときのまま残る。今日へ寄せ直すときはファイルを消して起動する。

## いちばん大事な決まり：業務の規則は 2 か所にある

参照範囲・権限・承認の可否・入力の検証・操作ログの規則は、**Go サーバ（`server/`）とモック（`web/src/api/mock.ts`）の両方**にある。

- 規則を変えるときは**必ず両方**を直し、両方にテストを足す（Go は `server/*_test.go`、モックは `web/tests/`）。
- **権限の担保はサーバ側**（基本設計書「権限チェックの実装方針」(6-2)）。画面の出し分けやモックだけを直しても、直したことにならない。
- デモデータも 2 か所（`server/seed.sql` と `web/src/api/mockDb.ts`）。片方を変えたらもう片方も合わせる。
- 日付と時刻は JST に固定している。Go は `server/model.go` の `now()`・`today()`、画面は `web/src/api/util.ts` の `now()`・`today()` で作る。

## 仮置き値

- 設計が決めていない値（色・間隔・件数・文言など）を置いたら、`web/仮置き値.md` に「項目・仮置き値・置いた場所」を足し、コードに `【仮置き】` とコメントする。
- `仮置き値.md` は**設計の決定ではない**。ここの値を設計書へ書き写さない。設計で決まったら一覧から落とす。

## 設計書

- 設計の正は `docs` ブランチの Markdown。`git fetch origin docs` のあと `git show origin/docs:基本設計書.md` で読む（ほかに `要件定義書.md`・`図/画面詳細図.md`・`要決定事項.md`・`ナレッジ/決定事項.md`）。
- コードのコメントには典拠を書く。項目は**名前を主に、番号はカッコで添える**：基本設計書「入力項目の制約値」(4-9)。番号だけで書かない。
- 機能と画面は番号でなく名前で呼ぶ（日誌システム・チャットツール・午睡チェック・発達チェック、「園児一覧画面」）。
- 設計と食い違う・設計が決めていないと気づいたら、推測で決めない。PR か Issue に書いて人に判断を任せる。

## テストで気をつけること

- **web のテストの時計は、日本時間の今日の 18:00 で止めてある**（`web/tests/setup-clock.ts`、Issue #152）。デモデータは「今日」の出来事を 17:20 までに置いており、本物の時計だと夜中や朝に前後が逆になって落ちるため。
  - 時計は進まない。時間の経過が要るテストは `vi.advanceTimersByTime(ミリ秒)` で進める。本物の時間を待っても `Date` は変わらない。
  - 時刻に頼っていないかを確かめるときは、`SUKUSUKU_TEST_CLOCK=03:00 npx vitest run` のように時刻を変えて回す。
  - `screens.test.tsx`（13:30 に置き直す）・`autoRefresh.test.tsx`（Date は本物）・`integration.test.ts`（本物）には、この固定は効かない。
- **Go のテストと結合テストは本物の時計で動く。** デモの記録は起動日へずれるので、夜中には「今日の 07:40」が未来になる。一覧の末尾や件数を決め打ちせず、本文や ID で探す（`server/api_dashboard_test.go`）。決まった時間帯にだけ落ちるときは、まず時刻を疑う。
- CI は UTC の環境で回る。手元で同じ条件を見るには `TZ=UTC` を付けて回す。
- 画面を描くテスト（`.tsx`）は、1 行目に `// @vitest-environment jsdom` が要る。
- `mockDb` の中身は同じファイルのテストどうしで使い回される。前のテストの書き込みや件数を当てにしない。
- 落ちたテストを、期待値の書き換えで通さない。規則が変わったのか、不具合なのかを先に確かめる。

## commit と PR

- commit のメッセージは、何をしたかを日本語の文で書く。例：「午睡チェックを、ダイアログを開かずに園児の行で直接記録する形にした」。関係する Issue は「（#136）」のように添える。
- PR の本文は日本語で、何を・なぜ・確かめたこと・**確かめていないこと**を書く。Issue を閉じるなら `Closes #番号`。チェック欄は `.github/pull_request_template.md` にある。
- 1 つの PR に、関係のない変更を混ぜない。
