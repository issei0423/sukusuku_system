# セキュリティレビュー・ハーネス

画面を通さず、攻撃者が要求を直接組み立てたときに、Go サーバ側で止まるかを確かめる。結果を集め、GLM（OpenCode のモデル）に所見と追加の攻撃案を聞く。

「画面からは正しく使える」ことは既存のテスト（`web/tests/`・`integration.test.ts`）が見ている。ここで見るのは参照範囲・権限・入力の検証そのものである（基本設計書「権限チェックの実装方針」(6-2)：権限の担保はサーバ側で行う）。

## 実行

`web/` で実行する。相手はハーネス自身が使い捨てのデータベースで起動するサーバなので、手元の開発サーバを止めておく必要はない。

```powershell
npm ci
npx playwright install chromium
npm run review:security
```

実行後は `web/security-report/index.html` をブラウザで開く。プローブの判定・試したこと・サーバの応答・GLM の所見が入る。`results.json` には同じ内容が機械の読める形で残る。

初めて回して、いまどこがどうなっているかを見たいとき（落とさずにレポートだけ作る）:

```powershell
$env:SECURITY_REPORT_ONLY = '1'
npm run review:security
Remove-Item Env:SECURITY_REPORT_ONLY
```

GLM への問い合わせを飛ばすとき、待ち時間やモデルを変えるとき:

```powershell
$env:SECURITY_GLM = '0'          # GLM の工程だけを飛ばす
$env:GLM_MODEL = 'opencode/glm-5.3-flash-free'
$env:GLM_TIMEOUT_MS = '240000'
npm run review:security
```

対象を絞る例:

```powershell
# 認可まわりだけ
npm run review:security -- --grep "authz\."
# プローブの一覧だけ確認
npm run review:security -- --list
# ハーネス自身の型検査
npm run review:security:check
```

専用ポートは `8199`（`SECURITY_PORT` で変更できる）。すでに使われていれば、流用せず失敗する。

## プローブ

`probes.ts` が対象の一覧。1 つのプローブは、いくつかの「試したこと（Attempt）」を返す。デモアカウント（`server/seed.sql` と `web/src/api/mockDb.ts` にある）でログインし、Cookie を保持する独立した端末から API を呼ぶ。`Origin`・`Referer` は画面からの操作と同じものを既定で付け、CSRF のプローブだけ偽ったり省いたりする。

| 観点 | id | 重さ | 見ていること |
| --- | --- | --- | --- |
| 認証 | auth.unauthenticated | 高 | ログインしていない端末では、どの API も使えない |
| 認証 | auth.wrong-entrance | 中 | 系統の違う入口（職員用・保護者用）からはログインできない |
| 認証 | auth.suspended-account | 高 | 停止中のアカウントはログインできない |
| 認証 | auth.relogin-while-logged-in | 高 | ログイン中は、別のアカウントでログインし直せない |
| 認証 | auth.credential-response | 中 | ログインの失敗は、アカウントの有無を推測させない |
| セッション | session.cookie | 高 | セッションは、盗まれにくく（HttpOnly・SameSite=Strict）、切れやすい Cookie で持つ |
| セッション | session.tamper | 高 | セッション ID を改ざんした Cookie は通らない |
| セッション | session.fixation | 中 | ログイン前に外から決めたセッション ID を、そのまま使わない |
| 認可 | auth.temp-password-gate | 高 | 一時パスワードのままでは、手続き以外の機能を使えない |
| 認可 | auth.terms-gate | 中 | 規約に同意するまで、他の機能を使えない |
| セッション | auth.stop-cuts-session | 高 | アカウントを停止すると、その場でセッションが切れる |
| 認可 | authz.cross-class-child | 高 | 担当外のクラスの園児は参照できない |
| 認可 | authz.admin-only | 高 | 管理者に限る操作は、一般職員には通らない |
| 認可 | authz.cross-class-diary | 高 | 担当外の日誌は、開くことも編集ロックもできない |
| 認可 | authz.guardian-staff-api | 高 | 保護者は、職員用の API を使えない |
| 認可 | authz.guardian-link-scope | 高 | 保護者は、紐づいた園児の記録しか参照できない |
| 認可 | authz.write-scope | 高 | 書き込みも参照範囲に従う（担当外の園児に記録できない） |
| 認可 | authz.link-removal | 高 | 保護者の紐づけを解除すると、その場で参照できなくなる |
| CSRF | csrf.origin-required | 高 | 状態を変える要求は、送信元を確かめてから通す |
| CSRF | csrf.origin-variants | 中 | 送信元の書き方に抜け道がない（null・別ポート・別ホスト） |
| 入力 | injection.sql | 高 | 入力に SQL の断片を入れても、組み立てた問い合わせにならない |
| 入力 | injection.path-traversal | 高 | 配信ディレクトリの外のファイルは読めない |
| 入力 | input.body-limit | 中 | 大きすぎる本文は受け取らず、サーバも止まらない |
| 出力 | output.error-leak | 中 | エラーの応答から、内部の作りが読み取れない |
| 出力 | output.no-secret-leak | 高 | 応答に、パスワードのハッシュを載せない |
| 出力 | output.headers | 記録 | 【記録】応答のヘッダーに、どんな守りが付いているか |

デモの範囲で試せなかった試み（担当外の園児がいない、など）は「記録のみ」として残す。すべての API や全 URL を網羅したものではない。

## 判定の読み方

| 判定 | 内容 |
| --- | --- |
| 守られていた（ok） | すべての試みが防がれていた |
| 守られていなかった（ng） | 1 つでも防がれていなかった。**テストも落ちる** |
| 記録のみ（info） | 判定しない観点（セキュリティヘッダーの有無など）。落とさない |

期待する状態は、実装を読んで「こうなるはず」を書くのではなく、設計書と「守るべき姿」から書いてある。落ちたときは、期待値を書き換える前に、規則が変わったのか不具合なのかを先に確かめる（AGENTS.md「テストで気をつけること」）。

`ng` は通常モードではテスト失敗になる。CI で赤にしたくないときは `SECURITY_REPORT_ONLY=1` を付ける。

## GLM の所見

レポートの冒頭に、実行結果を渡した GLM の所見（総評・気になる実行結果・追加で試すとよい攻撃・確かめていないこと）を載せる。呼び出しは `glm.ts` が OpenCode の CLI（`opencode run --standalone --model … --format json`）で行う。

**GLM の答えは合否に使わない。** 合否を決めるのはプローブの判定だけである。AI の答えは揺れるため、人が読むための材料として載せている。追加の攻撃案のうち、採るものは人が `probes.ts` に足す。

CLI が見つからないとき（CI など）や `SECURITY_GLM=0` のときは、GLM の工程だけを静かに飛ばし、理由をレポートに残す。**ハーネスの合否には響かせない。** CLI の場所は `OPENCODE_CLI` でも指定できる（既定は PATH → Windows デスクトップ版の同梱 CLI）。

## CI

`.github/workflows/ci.yml` の `security` ジョブが `npm run review:security` を回す。CI には OpenCode の CLI が無いため、GLM の工程は飛ばす。決まった 26 件のプローブを実行し、`ng` があれば赤になる。

## 再現性と構成

- `start-server.mjs`: Go サーバをビルドし、一時フォルダのデータベースで起動する（Playwright の `webServer` から呼ばれる）。静的ファイルは `web/public` を配信する。配信ディレクトリの外（`server/` など）を読めないことの確認に使う。起動したサーバは Playwright が終わるときに一緒に終わる。
- `http.ts`: サーバへ要求を送る薄い道具。端末ごとに Cookie を分けて持つ。`Origin`・`Referer` の付け方と、送る Cookie の値をプローブから変えられる（セッションの改ざん・固定の確認に使う）。
- `probes.ts`: 攻撃ケースの一覧と判定。`security.spec.ts` が 1 つずつ実行する。
- `reporter.ts`: `security-report/` に `results.json` と `index.html` を書く。レスポンシブレビューのレポーターと同じ流儀（`tests/responsive/reporter.ts`）。
- `playwright.security.config.ts`: 実行の設定。サーバ側の状態（セッション、ロック）を 1 つずつ確かめるため、`workers: 1` で順番に回す。
- 生成物（`web/security-report/`）は Git 対象外。

## 確かめていないこと

- セッションの無操作による自動失効（30 分）は、待てないため試していない。
- HTTPS で公開したときの Cookie の `Secure` 属性と HSTS は、localhost のため試していない（設計どおり）。
- 画面（React）側の XSS。ここで見ているのは API の応答だけである。
- 操作ログ（誰が何をしたか）の内容。記録の有無と参照範囲は別のテストが見ている。
- 同時に多数の要求を送ったときの挙動（総当たりの速度、資源の使い切り）。
- ログインの失敗で返る `remaining`（残り回数）が、存在する ID と存在しない ID で異なるため、アカウントの有無が推測できる。文言はそろっている。設計上そう決めているのか、修正するのかは人が判断する（この点はプローブで「記録のみ」として残している）。
- CSRF の `Origin` は、ホストとポートだけを比べている。同じホスト:ポートならスキームが違っても通るが、ブラウザは送信元を偽れないため、いまの使われ方では攻撃にならない（`csrf.origin-variants` で「記録のみ」として残している）。
- GLM の所見と追加の攻撃案は AI の答えであり、正しさは確かめていない。

## プローブがサーバに残すもの

使い捨てのデータベースなので、実行が終われば消える。それでも、途中で他のプローブに響かないよう次のようにしてある。

- `authz.write-scope` は確認用に下書きを 1 件作り、`authz.link-removal` は紐づけを解除する。どちらも状態を変えるプローブとして `probes.ts` の最後に置いてある。
- `authz.link-removal` は、確かめたあと**同じプローブの中で紐づけを戻す**。保護者に紐づけが 1 件しかないデモデータでは、解除するとアカウントも停止するため、戻すときに再開も行っている。

参考: [Playwright の webServer](https://playwright.dev/docs/test-webserver)、[APIRequestContext](https://playwright.dev/docs/api-testing)、[自作レポーター](https://playwright.dev/docs/test-reporters#custom-reporters)。
