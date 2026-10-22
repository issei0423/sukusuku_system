# レスポンシブレビュー・ハーネス

実際の `App` と既存の CSS を、独立したモック環境で描画する。画面ごとの画像と自動検査結果を集め、ボタン・表・フォームのレビューを繰り返せるようにする。

## 実行

`web/` で実行する。Node.js / npm は通常の開発環境と共通。

```powershell
npm ci
npx playwright install chromium webkit
npm run review:responsive
```

実行後は `web/responsive-report/index.html` をブラウザで開く。画面名・端末・検査ルールで検索でき、画像をクリックすると元の解像度で表示できる。`results.json` には画面、端末、CSS セレクター、寸法、指摘が残る。画像の `viewport` は画面上端、`bottom` は本文の内部スクロール下端。途中のすべての行を撮るものではない。

失敗時の trace や詳細は次で開ける。

```powershell
npm run review:responsive:report
```

対象を絞る例:

```powershell
# iPad 縦だけ
npm run review:responsive -- --project=ipad-portrait
# 午睡と体温パネルだけ（3端末）
npm run review:responsive -- --grep "nap"
# 作業前に一覧だけ確認
npm run review:responsive -- --list
# ハーネス自身の型検査
npm run review:responsive:check
# ブラウザの文字の大きさの設定を変えて回す（Chrome の「大」は 20、「特大」は 24。Chromium の端末だけ効く）
$env:RESPONSIVE_FONT_SIZE = '24'; npm run review:responsive -- --project=desktop; Remove-Item Env:RESPONSIVE_FONT_SIZE
```

文字の大きさを変えたときは、画像を全体でなく画面の範囲だけ撮る（fullPage の撮影が Chromium の設定を既定に戻すため）。ページ全体を送る画面は、`bottom` に下端を撮る。

## 端末と画面

| プロジェクト | CSS viewport | エンジン | 対象 |
| --- | --- | --- | --- |
| ipad-portrait | 768 × 1024 | WebKit・タッチ | 全シナリオ |
| ipad-landscape | 1024 × 768 | WebKit・タッチ | 全シナリオ |
| desktop | 1440 × 900 | Chromium | 全シナリオ |
| phone | 390 × 844 | WebKit・タッチ | 保護者・共通画面 |

`scenarios.ts` が対象一覧。職員・管理者・保護者の各権限、確認画面の入力内容、午睡の注意表示・保存後・体温パネル、保護者メニューを含む。タッチ環境の操作シナリオは実際に `tap()` で動かす。全 URL の全状態や全ダイアログを網羅したものではない。

## 判定の読み方

| 判定 | 内容 |
| --- | --- |
| error | ページ・本文・ヘッダー・ダイアログの横方向の超過、操作領域の横方向の欠け |
| review | 小さい操作領域、文字の収まり、別要素が中央に重なる操作部品。画像を見て判断する |
| info | 表の内側での横スクロール。ページ全体のはみ出しとは区別する |

タップ領域は既存の `--tap-min` と同じ 44 × 44 CSS px を目安にし、午睡の直接入力部品は 52 × 52 px を使う。radio / checkbox は関連ラベルを測る。普通の本文リンクは対象外。これは操作性のレビュー基準であり、アクセシビリティ規格への適合判定ではない。

**通常実行の成功は、撮影と検査を完了したという意味。デザインに指摘がないという意味ではない。** 構造的な指摘を CI の失敗条件にする場合:

```powershell
$env:RESPONSIVE_STRICT = '1'
npm run review:responsive
Remove-Item Env:RESPONSIVE_STRICT
```

読み込み失敗、予期しない画面への転送、実行例外、保存操作の失敗は通常モードでもテスト失敗になる。単一原因で複数の要素がはみ出すと指摘件数は増える。件数をそのまま不具合数として扱わない。

## 再現性と構成

- `harness.html` / `harness.tsx`: 開発用の独立入口。製品のエントリーには含めない。既存 `App`、`SessionProvider`、CSS を使用する。
- モック API のみに固定し、HTTP `/api/` 呼び出しはテスト側で遮断する。各ケースの新しいページでメモリ上のデータを初期化する。
- 日付は `2026-09-01 13:30 JST` に固定。午睡の自動終了や実行日の違いを避ける。通常の非同期タイマーは動かす。
- モック API の処理が完了して150ms静まり、フォントと画像の読み込みが完了した後に撮影する。ルートの一致も検査する。
- 専用サーバは `127.0.0.1:5186`。起動済みサーバは流用せず、ポート使用中なら失敗する。閲覧中の開発サーバとは独立する。
- 生成物は Git 対象外。部分実行ではレポートもその部分だけに置き換わる。

画面追加時は `scenarios.ts` に URL・権限・必要な入力状態を追加する。操作が必要なら `steps.ts` の `performAction` に、表示を確認する assertion と実際の操作を追加する（`review.spec.ts` とアクセシビリティの検査が共に使う）。

WebKit エミュレーションは実機の Safari と完全には同じではない。持ちながらの指の届きやすさ、誤タップ、ソフトウェアキーボード、慣性スクロール、画面回転中の状態保持は実機で確認する。デモデータより長い氏名・文章、大量データ、業務フロー全体も別途確認する。

## アクセシビリティの検査（axe・キーボード）

同じハーネスと `scenarios.ts` の場面を使い、アクセシビリティを自動で確かめる。設定は `web/playwright.a11y.config.ts`、専用サーバは `127.0.0.1:5187`。

```powershell
npx playwright install chromium
npm run test:a11y
```

**基準は WCAG 2.2 AA を目安にする（【仮置き】設計書に適合の水準の定めが無い。`web/仮置き値.md`）。** これは自動の検査で拾える範囲の目安であり、規格に適合しているという判定ではない。

| ファイル | 中身 |
| --- | --- |
| `a11y-axe.spec.ts` | 全場面に axe（タグ wcag2a・wcag2aa・wcag21a・wcag21aa・wcag22aa）を掛ける。影響が critical・serious の違反が既知の一覧に無ければ落とす。moderate・minor は一覧に出すだけ |
| `a11y-keyboard.spec.ts` | Tab・Enter・Space・Esc だけで、ログイン、午睡チェックの体温パネルの開け閉め（閉じたらフォーカスが元へ戻る）、保護者メニューの開け閉めを通す。途中でフォーカスが止まった要素すべてに、見える印（outline）があることも確かめる |
| `a11y-known.ts` | 分かっていてまだ直していない違反（規則 × 場面 × Issue・PR の番号）。直したら行を消す |
| `steps.ts` | `review.spec.ts` と共に使う、待ち（`ready`）と場面の操作（`performAction`） |
| `a11y-reporter.ts` | `web/a11y-report/summary.md`（場面・規則・影響・件数の表）と `results.json` を書く |

| プロジェクト | CSS viewport | エンジン | 対象 |
| --- | --- | --- | --- |
| staff | 1024 × 768 | Chromium | 職員・管理者・共通画面（`[staff]`・`[public]`） |
| phone | 390 × 844 | Chromium | 保護者・共通画面（`[guardian]`・`[public]`） |

実行後は `web/a11y-report/summary.md` を開く。axe が自動で決めきれなかったもの（背景が画像のときのコントラストなど）は「人が確かめるもの」に出る。テストは落とさない。違反した要素の HTML と直し方は、`web/a11y-report/html`（Playwright のレポート）の各テストの添付 `axe-results` にある。

axe とキーボードの検査で見られないもの：読み上げソフトでの聞こえ方・読む順、意味の分かりやすさ、ズーム 200% や文字の拡大、実機の VoiceOver・TalkBack、場面に無い画面と状態。これらは人が確かめる。

参考: [Playwright の端末エミュレーション](https://playwright.dev/docs/emulation)、[時計の固定](https://playwright.dev/docs/clock)、[レポーター](https://playwright.dev/docs/test-reporters)。
