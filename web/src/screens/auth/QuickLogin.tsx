/*
 * 演習用：デモの隠しログイン。実装では持たない。
 *
 * ログイン画面の左上と右上に、見えない押し場所を置く。左上 → 右上の順に押すと、
 * 入口に合わせた西田 拓也のアカウント（quickLoginAccounts.ts）でログインする。
 * 順が違う・間があきすぎたときは、はじめからやり直し。
 *
 * デモ用のビルド（npm run build:demo）でだけ TopScreen が描く。本番のビルドには入らない。
 * 読み上げ・キーボードの対象にしない（デモの操作者だけが知っている押し場所のため）。
 */
import { useRef } from 'react';
import { QUICK_LOGIN_ACCOUNTS } from './quickLoginAccounts';

/** 左上を押してから右上を押すまでに待つ時間（ミリ秒）。【仮置き】web/仮置き値.md */
export const QUICK_LOGIN_WINDOW_MS = 5000;

export default function QuickLogin({ entrance, onLogin }: {
  entrance: 'staff' | 'guardian';
  onLogin: (email: string, password: string) => void;
}) {
  const firstAt = useRef<number | null>(null);

  const tapFirst = () => { firstAt.current = Date.now(); };
  const tapSecond = () => {
    const at = firstAt.current;
    firstAt.current = null;
    if (at === null || Date.now() - at > QUICK_LOGIN_WINDOW_MS) return;
    const a = QUICK_LOGIN_ACCOUNTS[entrance];
    onLogin(a.email, a.password);
  };

  // 【仮置き】押し場所の大きさ 64px 四方（web/仮置き値.md）。ヘッダより上に重ねる
  const base: React.CSSProperties = {
    position: 'fixed', top: 0, width: 64, height: 64, zIndex: 1000,
    background: 'transparent', touchAction: 'manipulation',
  };
  return (
    <>
      <div aria-hidden="true" data-testid="quick-login-1" style={{ ...base, left: 0 }} onClick={tapFirst} />
      <div aria-hidden="true" data-testid="quick-login-2" style={{ ...base, right: 0 }} onClick={tapSecond} />
    </>
  );
}
