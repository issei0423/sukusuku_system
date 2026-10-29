# 受け入れテスト（画面のブラックボックス試験）

テスト仕様書 兼 成績書（docs ブランチの `テスト仕様書.md`）のケースを、本物の画面（`web/dist`）と Go サーバで回し、ケースNoごとの結果と証跡を残す。

- 相手は、ハーネスが自分で立てる使い捨てのサーバ（127.0.0.1 だけ）。手元の開発サーバや公開先には向けない
- 期待する結果は**設計書から**書く（下の「期待は設計書から」）
- 結果は `web/acceptance-report/results.json`、証跡は `web/acceptance-report/shots/<ケースNo>.png`（どちらも Git に入れない）

## 回し方

`web/` で回す。

```sh
npm ci
npx playwright install chromium     # 初めてのときだけ
npm run test:acceptance:check       # 型検査と、ケースの並びの確かめ（ビルドもサーバの起動もしない）
npm run test:acceptance             # 全部。画面とサーバのビルドから始まる
```

この PC では、重いコマンドは鍵を通す（テスト仕様書の決まり「重いコマンドは鍵を通す」）。`test:acceptance` は画面のビルドと Playwright を回すので重い。

```sh
bash /c/Users/calif/sukusuku-worktrees/agent-runner/agent-harness/api-agent/scripts/heavy.sh npm --prefix web run test:acceptance
```

| したいこと | 書き方（bash。PowerShell は `$env:名前='値'` を先に置く） |
| :-- | :-- |
| 自分のシートだけ | `npm run test:acceptance -- tests/acceptance/02-contact.spec.ts` |
| 1ケースだけ | `npm run test:acceptance -- --grep "02-003"` |
| 自分のポートで | `ACCEPTANCE_PORT=8192 npm run test:acceptance -- …` |
| 画面のビルドを飛ばす（手直しを繰り返すとき） | `ACCEPTANCE_SKIP_BUILD=1 npm run test:acceptance -- …`（`web/dist` があるときだけ効く。**成績に残す回は飛ばさない**） |
| 成績に混ぜない試しの回 | `ACCEPTANCE_REPORT_DIR=<スクラッチパッド>/<点id>/report npm run test:acceptance -- …`（results.json・shots・server.log をそこへ書く） |
| 手で立てて画面を見る | `node tests/acceptance/start-server.mjs`（Ctrl+C で止まる） |
| 失敗のトレースを見る | `npx playwright show-trace test-results/acceptance/<…>/trace.zip` |

## 後の係へ：ファイルの置き方

- **1シート1ファイル**：`web/tests/acceptance/<シート番号2桁>-<名前>.spec.ts`。名前は次のとおりにそろえる

  | シート | ファイル |
  | :-- | :-- |
  | 01 共通基盤 | `01-common.spec.ts`（見本の 01-001・01-002 がある。続きを 01-003 から足す） |
  | 02 連絡帳 | `02-contact.spec.ts` |
  | 03 チャットツール | `03-chat.spec.ts` |
  | 04 午睡チェック | `04-nap.spec.ts` |
  | 05 発達チェック・身体測定・成長の記録 | `05-growth.spec.ts` |
  | 06 日誌システム | `06-diary.spec.ts` |
  | 07 園児マスター・アカウント・運用 | `07-master.spec.ts` |
  | 08 不正アクセス | `08-intrusion.spec.ts` |

- 足してよいのは、自分のシートの spec と、要れば同じ名前の `*.helpers.ts`（例：`02-contact.helpers.ts`）だけ
- **共有のファイルは書き換えない**：`paths.mjs`・`start-server.mjs`・`global-setup.ts`・`harness.ts`・`accounts.ts`・`reporter.ts`・`check-cases.mjs`・`tsconfig.json`・この README・`web/playwright.acceptance.config.ts`・`web/package.json`・`.gitignore`。口が足りなければ、自分のシートの helpers に書くか、報告の「提案」に書く
- `npm run test:acceptance:check` が、ファイル名・ケースNo・重なりを見る。commit の前に回す

## ポート

サーバは1回の実行で1つのポートを使い、describe ごとに同じポートで立て直す。係ごとに番号を分ける。

| 係 | `ACCEPTANCE_PORT` |
| :-- | :-- |
| 土台（見本） | 8190（既定） |
| T6 | 8191 |
| T7 | 8192 |
| T8 | 8193 |
| T9 | 8194 |
| T10 | 8195 |
| T11 | 8196 |
| T12 | 8197 |

セキュリティのハーネス（8199）・レスポンシブレビュー（5186・5187）とは重ならない。ポートが埋まっていれば、流用せずに止まる。

## ケースNoとテスト名

- テスト名は**ケースNoと空白で始める**：`test('02-003 「確認しました」：…', …)`
- ケースNoはシート番号2桁と連番3桁（`02-003`）。入力チェックは `I` を付ける（`02-I001`）。シート番号はファイル名と同じにする
- **1つのテストが1つのケース**。ケースNoを重ねない
- 成績書の「方法」の列には `自動テスト（02-contact.spec.ts 02-003）` と書く（テスト仕様書の決まり「列の形」）
- ケースNoで始まらないテストは results.json に載らない（注意として出る）

## 書き方

```ts
import { ACCOUNTS, PHONE, evidence, expect, fillLogin, login, test } from './harness';

test.describe('連絡帳（クラス）画面', () => {
  test('02-003 確認しました：家庭からの連絡に「確認しました」を押すと、…', async ({ page }) => {
    // 典拠：図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目n
    await login(page, 'staffSakura');
    // … 操作 …
    await expect(page.getByText('…')).toBeVisible();
    await evidence(page, '02-003');
  });
});

test.describe('保護者の連絡帳画面', () => {
  test.use({ viewport: PHONE });        // 保護者はスマートフォンの縦向き
  test('02-010 …', async ({ page }) => {
    await login(page, ACCOUNTS.guardian);
    // …
  });
});
```

### サーバとデータ

- **describe ごとに、新しいデータベース（デモデータから）でサーバを立て直す。** 同じ describe のテストは同じサーバを使うので、前のテストの書き込みが残る
- 前のテストの結果に頼るなら `test.describe.configure({ mode: 'serial' })` を置く。前が落ちると、残りは飛ばされて「未実施」になる
- テストごとに新しいデータベースにしたいときは、describe の中で `test.use({ serverScope: 'test' })`
- **ログインの失敗を多く起こすケース**（ロック、送信元ごとの上限）は、自分の describe に分ける。アカウントは5回の失敗で30分ロック、送信元（IP）は15分に20回で止まる（`server/attempts.go`）。テストはすべて 127.0.0.1 から来るので、送信元の上限は同じ describe の失敗の合計で数えられる
- サーバはテストの直前（フィクスチャ）に立つ。**`beforeAll` ではサーバを使わない**（まだ立っていないか、前の describe のサーバのことがある）。下ごしらえは `beforeEach` か、テストの中で行う
- NG の原因を見るときは、`serverInfo()` で、いまのサーバのデータベースの場所が分かる。サーバのログは `acceptance-report/server.log`

### ログイン

- `login(page, 'staffSakura')`：入口のトップを開き、入れて「ログイン」を押し、トップから移るまで待つ。移った先の経路を返す。移れなければ、出た誤りの文を添えて止まる
- `gotoTop(page, 'staff' | 'guardian')`・`fillLogin(page, who, { password?, email? })`：ログインの失敗を確かめるケースで、押す前までを行う
- `login(page, 'guardian', { via: 'staff' })`：誤った系統の入口から試す（移れないので止まる。失敗を確かめるなら `gotoTop`＋`fillLogin` を使う）
- **パスワードは文字で書かない。** `passwordOf('guardian')` が `server/seed.sql` から読む。誤ったパスワードを試すときだけ、文字で書く

| `ACCOUNTS` の名前 | 誰か |
| :-- | :-- |
| `admin` | 管理者（西田 拓也）。担当クラスなし |
| `admin2` | 管理者（遠藤 直人）。管理者が2人要るケース（自分の申請は承認できない、など） |
| `staffSakura` | 一般・さくら組担任（鈴木 浩之） |
| `staffTempPassword` | 一般・さくら組担任（村田 真一）。一時パスワードのまま |
| `staffHimawari` | 一般・ひまわり組担任（久保田 和也） |
| `guardian` | 保護者（西田 太郎の保護者） |
| `guardianTermsStale` | 保護者（遠藤 花子の保護者）。規約の再同意が要る |
| `guardianSuspended` | 保護者（停止中。紐づけが終わっている） |
| `guardianMurata` | 保護者（村田 美咲の保護者） |
| `guardianKubota` | 保護者（久保田 陸の保護者） |

園児は、さくら組（2026年度）が C001〜C012、ひまわり組が C013〜C018、もも組が C019〜C022（`server/seed.sql`）。

### 証跡

- `await evidence(page, '02-003')`：**確認事項を確かめ終えたところ**（期待する結果が画面に出ている状態）で呼ぶ。`acceptance-report/shots/02-003.png` に撮る（既定は `fullPage: true`）
- **この画面は本文が内側でスクロールする作りなので、`fullPage` でも見えている範囲（1024×768・390×844）しか写らない**（2026-10-26 に 01-001・01-002 の証跡で確かめた）。確かめた所が下のほうにあるときは、`await target.scrollIntoViewIfNeeded()` で見える所まで送ってから撮る
- ケースNoはテスト名の頭と同じにする（違えば止まる）。同じテストで何度呼んでも、最後の1枚が残る
- `evidence()` を呼ぶ前に落ちたら、落ちた時点の画面を同じ名前で自動で残す（results.json の `evidenceNote` が「落ちた時点の画面」になる）
- `shots/` には前の回の画像が残ることがある。その回の証跡は results.json の `evidence` を見る

### 結果（results.json）

| 結果 | いつ |
| :-- | :-- |
| `OK` | 通った |
| `NG` | 確認事項のとおりにならなかった（期待で落ちた・時間切れ）。`error` に要約 |
| `未実施` | 回していない。`reason` に理由。`test.skip(true, '理由')`、serial で前が落ちて飛ばされた、途中で止めた、ハーネス自身の不具合（エラーに `[acceptance:harness]` が付いたもの。127.0.0.1 以外への要求を含む） |

- 回せないケースは `test.skip(true, '理由')` にする（理由がそのまま `reason` に入る）
- **NG を `test.fail()`・`test.fixme()` で隠さない。** 落ちるまま残し、`<スクラッチパッド>/<点id>/ng.md` に書く
- 1件ずつ、ケースNo・テスト名・ファイル・結果・実施日時（JST）・確認日・実施者・証跡・エラーの要約・未実施の理由・本線とハーネスの commit が入る
- `commits.main` は、試験した版（`origin/mockup-go-react` との分岐点）。`commits.appSameAsMain` が `false` なら、`server/`・`web/src/` がその版と違う（手元の書き換えを含む）
- 実施者は `Claude（AI）`。人が回したときは `ACCEPTANCE_TESTER` で名前を渡す
- 自分のシートだけを回すと、results.json にはそのシートだけが入る（前の回の分は上書きで消える）

## 期待は設計書から

- docs ブランチの設計書から書く：`git fetch origin docs` のあと `git show origin/docs:図/画面詳細図.md`（ほかに `基本設計書.md`・`要件定義書.md`・`図/画面遷移図.md`・`詳細設計書.md`）
- **コードを読んで期待を決めない。** コードを読むのは NG の原因を見るときだけ（授業の雛形 1.8「開発担当者以外がテスト項目を抽出」の代わり）
- 部品は、設計書の表示名で探す（`getByRole('button', { name: '確認しました' })`、`getByLabel('ログインID')`）。表示名で見つからないなら、それは NG の候補
- 典拠は spec のコメントに「図/画面詳細図「職員用トップ／保護者用トップ」(2-1) 項目5」の形で書く。名前を主に、番号はカッコで添える
- 画面の移り先は、URL でなく画面の中身（見出し・区画・ヘッダ）で確かめる。設計書は URL を決めていない。入口の URL だけは `TOP_PATH` に置いてある
- **NG でも期待を書き換えない。** `server/`・`web/src/` は直さない（雛形 1.9：テストと修正を並行しない）。NG は `ng.md` に、ケースNo・期待・実際・証跡・典拠・ケースの誤りの見込みを書く
- 設計書が決めていないこと（【要決定】、仮置き値）は、期待に入れない

## 夜中の注意

- **Go サーバは本物の時計で動き、時計を止める口が無い。** デモデータは起動した日へずらして入る（`server/seed_shift.go`）ので、デモの「今日の 07:40」は夜中には未来になる。**ケースは自分で作ったデータで確かめ、デモの時刻や件数に頼らない**
- 一覧の末尾や件数を決め打ちしない。自分で入れた本文や名前で探す
- 確認日は、各ケースが始まった時刻（JST）の日付。0時をまたいで回すと、シートの中で確認日が分かれる
- きょうの日付を見るケースは `jstToday()`（JST の YYYY-MM-DD）と比べる。0時の直前に回さない
- 画面の時刻は、サーバの時刻による（図/画面詳細図「全画面に共通する規定」(0-2) の「時刻」）。ブラウザの時計を進めても、サーバの「本日」は変わらない

## 外へ出さないこと

- 相手は 127.0.0.1 だけ。`baseURL` が 127.0.0.1 でなければ、設定を読んだところで止まる。ブラウザが 127.0.0.1 以外へ出す要求（画面の移動・画像の読み込みなど）は止め、そのケースを「未実施」にする。画面の中からの `fetch` は、サーバの CSP（`default-src 'self'`。`server/headers.go`）がそれより先に止めるので、ハーネスは気づかない（2026-10-26 に試して確かめた）
- サーバの子プロセスに `ANTHROPIC_API_KEY` を渡さない（AI の下書きは使えない状態で回る）
- Web Push は購読しない（ブラウザの service worker を止め、通知の許可も与えない）

## ファイル

| ファイル | 役目 |
| :-- | :-- |
| `../../playwright.acceptance.config.ts` | 設定。1ワーカーで順に回す。やり直しはしない（1回目の結果を成績にする） |
| `global-setup.ts` | 最初に1回、画面（`npm run build`）とサーバ（`go build`）をビルドする |
| `start-server.mjs` | サーバを使い捨てのデータベース・添付の置き場で立てる口。直に回すと、手で見るためのサーバが立つ |
| `harness.ts` | `test`・`expect`・`login`・`evidence` など。describe ごとのサーバ、外への要求の止め、落ちたときの証跡 |
| `accounts.ts` | デモアカウント。パスワードは `server/seed.sql` から読む |
| `reporter.ts` | `results.json` を書く |
| `check-cases.mjs` | ケースの並びを、サーバを立てずに確かめる |
| `paths.mjs` | 共に使う値（置き場、ポート、ケースNoの形、画面の大きさ） |
| `01-common.spec.ts` | シート 01。見本の 01-001・01-002 |
