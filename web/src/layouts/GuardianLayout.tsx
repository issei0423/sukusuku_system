/*
 * 保護者（スマートフォン）の共通レイアウト
 * 典拠：図/画面詳細図.md「保護者（スマートフォン）」(1-2)
 *
 * サイドナビを持たず、ホームからの導線に絞る。片手操作を前提とするため。
 * ログアウトはメニュー内に置く（基本設計書「画面基本構成」(3-5)）。
 */
import { useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../session';
import { useAsync } from '../hooks';
import { api } from '../api/client';

export default function GuardianLayout() {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const home = useAsync(() => api.guardianHome(user!), [user?.account_id]);

  if (!user) return null;
  const unread = home.data?.[0]?.unread ?? 0;

  const onLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="guardian-shell">
      <header className="app-header">
        <button onClick={() => setOpen(true)} aria-label="メニュー">≡</button>
        <span className="logo">すくすく保育園</span>
        <div className="spacer" />
        <button className="notify-btn" onClick={() => navigate('/guardian/chat')} aria-label="通知">
          通知
          {unread > 0 && <span className="notify-badge">{unread}</span>}
        </button>
      </header>

      {open && (
        <>
          <div className="drawer-backdrop" onClick={() => setOpen(false)} />
          <nav className="drawer">
            {/* 誰の保護者かを示す。ホームからの導線に絞る */}
            <div className="who">
              {home.data?.map((h) => h.child.child_name).join('・') || user.display_name}
              ちゃんの保護者
            </div>
            <Link to="/guardian" onClick={() => setOpen(false)}>ホーム</Link>
            <Link to="/guardian/chat" onClick={() => setOpen(false)}>チャット</Link>
            <Link to="/guardian/password" onClick={() => setOpen(false)}>パスワードの変更</Link>
            <Link to="/guardian/terms" onClick={() => setOpen(false)}>利用規約</Link>
            <div className="spacer" />
            {/* 保護者のログアウトはメニュー内（基本設計書 3-5） */}
            <button className="btn-block" onClick={onLogout}>ログアウト</button>
          </nav>
        </>
      )}

      <main className="guardian-main">
        <Outlet />
      </main>
    </div>
  );
}
