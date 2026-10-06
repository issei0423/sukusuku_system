/*
 * 未ログインの入口の枠
 * 典拠：図/画面詳細図.md「職員用トップ／保護者用トップ」(2-1)
 *
 * 表示するのは認証の導線のみ。園児情報・記録などの実データも、
 * サービス紹介コンテンツも置かない（基本設計書「画面詳細」(3-6)）。
 */
import type { ReactNode } from 'react';

export default function PublicLayout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="public-shell">
      <div className={`public-card${wide ? ' wide' : ''}`}>
        <div className="brand">
          <div className="name"><img src="/login-wordmark-crayon.png" alt="すくすく" /></div>
          <div className="sub">すくすく保育園</div>
        </div>
        {children}
      </div>
    </div>
  );
}
