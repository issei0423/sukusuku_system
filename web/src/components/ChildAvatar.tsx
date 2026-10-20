/*
 * 園児の顔写真の代わりの丸（職員の画面だけで使う）
 * 典拠：詳細設計書「共通の部品」(2-0 (1)) の ChildAvatar、基本設計書「宛先を大きく示す」(4-2)「顔写真が無い園児は名前の1文字目を丸で示す」
 *
 * 顔写真の登録は次の版（決めたこと D-22）のため、本版はいつも名前の1文字目の丸で示す。保護者の画面には出さない。
 */
export default function ChildAvatar({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  return (
    <span className={`child-avatar is-${size}`} aria-hidden="true">{[...name.trim()][0] ?? '？'}</span>
  );
}
