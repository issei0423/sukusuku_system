/*
 * 本番のビルドで api/mock.ts の代わりに読み込ませる差し替え
 *
 * VITE_API が mock でないビルド（npm run build。公開先へのデプロイもこれを回す）では、
 * vite.config.ts が mock.ts への読み込みを本ファイルへ向ける。
 * モックとデモデータ（mockDb.ts。デモのパスワードやログインIDを持つ）を、
 * だれでも取れる成果物（dist/）へ入れないため（持ち主の「開発者ログインを無くして」、PR #289 の残り）。
 *
 * client.ts がモックを使うのは VITE_API が mock のときだけなので、本ファイルの中身は呼ばれない。
 * client.ts の型はそのまま mock.ts に合わせて検査されるよう、中身は http の実装を渡すだけにしておく。
 */
export * from './http';
