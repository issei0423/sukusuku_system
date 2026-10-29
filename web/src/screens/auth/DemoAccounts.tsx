/*
 * 演習用：デモアカウント。実装では持たない。
 * デモの場で「どのアカウントで何が見えるか」を切り替えるために置いている。
 *
 * 手元の開発サーバ（npm run dev・npm run dev:mock）でだけ出す。本番のビルドには入れない。
 * 公開先の画面に管理者を含むログインIDと共通のパスワードが出て、だれでも入れてしまったため
 * （PR #289 で一度外した）。TopScreen が import.meta.env.DEV のときだけ描くので、本番のビルドでは
 * このファイルごと落ちる。入ってしまったら build/keepMockOutOfBuild.ts の見張りがビルドを落とす。
 * アカウントは server/seed.sql・web/src/api/mockDb.ts のデモデータに合わせる。
 */
export default function DemoAccounts({ entrance, onPick }: {
  entrance: 'staff' | 'guardian';
  onPick: (email: string, password: string) => void;
}) {
  const staffList = [
    { email: 'nishida@hoiku.example.jp', label: '西田 拓也（管理者・園長）' },
    { email: 'suzuki@hoiku.example.jp', label: '鈴木 浩之（一般・さくら組）' },
    { email: 'kubota@hoiku.example.jp', label: '久保田 和也（一般・ひまわり組）' },
    { email: 'murata@hoiku.example.jp', label: '村田 真一（一時パスワード中）', password: 'temp0901' },
  ];
  const guardianList = [
    { email: 'nishida.t@example.jp', label: '西田 拓也（西田 太郎の保護者）' },
    { email: 'endo.n@example.jp', label: '遠藤 直人（規約の再同意が必要）' },
    { email: 'suzuki.h@example.jp', label: '鈴木 浩之（停止中のアカウント）' },
    { email: 'murata.s@example.jp', label: '村田 真一（村田 美咲の保護者）' },
    { email: 'kubota.k@example.jp', label: '久保田 和也（久保田 陸の保護者）' },
  ];
  const list: { email: string; label: string; password?: string }[] = entrance === 'staff' ? staffList : guardianList;

  return (
    <details open style={{ marginTop: 24 }}>
      <summary className="muted" style={{ cursor: 'pointer' }}>演習用：デモアカウント</summary>
      <div className="stack" style={{ marginTop: 8 }}>
        {list.map((a) => (
          <button key={a.email} type="button" className="btn-sm"
            onClick={() => onPick(a.email, a.password ?? 'pass1234')}>{a.label}</button>
        ))}
        <div className="muted">
          押すとログインIDとパスワードが入ります。パスワードはいずれも pass1234。村田 真一（職員）のみ一時パスワード temp0901。
        </div>
      </div>
    </details>
  );
}
