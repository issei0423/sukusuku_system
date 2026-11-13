/*
 * 演習用：デモの隠しログイン（QuickLogin.tsx）で入るアカウント。実装では持たない。
 *
 * 持ち主が 2026-11-13 に「保育士と保護者はどっちも西田」「ログインページの左上と右上に透明なタブを付けて、
 * 1 左上 2 右上の順で押すと西田のアカウントで楽にログインされるように」と頼んだ。
 *
 * デモ用のビルド（npm run build:demo。.env.demo の VITE_DEMO_QUICK_LOGIN=1）にだけ入る。
 * 本番のビルド（npm run build）では、TopScreen が描かないのでこのファイルごと落ちる。
 * 入ってしまったら build/keepMockOutOfBuild.ts の見張りがビルドを落とす（PR #289・#294 で公開先から外した経緯）。
 * build/keepMockOutOfBuild.ts も、デモ用のビルドで見張りから外す値としてここを読む。
 * アカウントは server/seed.sql・web/src/api/mockDb.ts のデモデータに合わせる。
 */
export const QUICK_LOGIN_ACCOUNTS = {
  staff: { email: 'nishida@hoiku.example.jp', password: 'pass1234' },
  guardian: { email: 'nishida.t@example.jp', password: 'pass1234' },
} as const;
