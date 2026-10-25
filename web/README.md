# web — すくすくシステム モックアップ（React + TypeScript）

基本設計書 第1.3版の全33画面。動かし方・デモアカウント・構成は、リポジトリ直下の
[`MOCKUP.md`](../MOCKUP.md) を参照。

| コマンド | 内容 |
| :-- | :-- |
| `npm run dev` | 開発サーバ。`/api` は Go サーバ（8080）へ中継する |
| `npm run dev:mock` | Go サーバを立てずに、ブラウザ内のデモデータで動かす |
| `npm test` | テスト87件（モックに対して回すため、サーバは不要） |
| `npm run test:integration` | Go サーバとの結合テスト11件。`SUKUSUKU_API` の指定が要る |
| `npm run build` | 本番ビルド。成果物は Go サーバが配信する |
| `npm run review:responsive` | iPad縦横・PC・保護者向けスマホの画面画像とレイアウト指摘を収集する |

レスポンシブレビューの初期設定・対象画面・結果の読み方は
[`tests/responsive/README.md`](tests/responsive/README.md) を参照。

## データ層

画面は `src/api/client.ts` を通してデータ層を呼ぶ。実装は2つあり、`VITE_API` で切り替わる。

- `src/api/http.ts` … Go サーバへ問い合わせる（既定）
- `src/api/mock.ts` … ブラウザ内のデモデータを読み書きする

`VITE_API` が `mock` でないビルド（`npm run build`）には、モックとデモデータを入れない。
`vite.config.ts` が読み込むプラグイン（`build/keepMockOutOfBuild.ts`）が `mock.ts` の読み込みを
`src/api/noMock.ts` へ向け、書き出した `dist/` に `mockDb.ts` のアカウントのパスワードやログインIDが
残っていたらビルドを落とす。切り替えと見張りが効くことは `tests/keepMockOutOfBuild.test.ts` が確かめる。

2つの実装が返す形は `src/api/shapes.ts` が定義する。片方だけが違う形を返すと画面が壊れるため、
形の定義は1か所に置いている。

設計で確定していない値をどこにどう置いたかは [`仮置き値.md`](仮置き値.md) にまとめている。

なお `public/` と `src/assets/` に残っている画像は Vite の雛形が置いたもので、
本アプリからは参照していない。
