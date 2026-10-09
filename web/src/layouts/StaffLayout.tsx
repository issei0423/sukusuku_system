/*
 * 職員（タブレット／PC）の共通レイアウト
 * 典拠：図/画面詳細図.md「職員（タブレット／PC）」(1-1)、基本設計書.md「画面基本構成」(3-5)
 */
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../session';
import { useAsync } from '../hooks';
import { api } from '../api/client';
import { BellIcon } from '../components/ui';

const NAV = [
  { to: '/staff', label: 'ダッシュボード', end: true, adminOnly: false },
  { to: '/staff/diary', label: '日誌', end: false, adminOnly: false },
  { to: '/staff/chat', label: 'チャット', end: false, adminOnly: false },
  { to: '/staff/nap', label: '午睡チェック', end: false, adminOnly: false },
  { to: '/staff/growth', label: '発達・身体', end: false, adminOnly: false },
  { to: '/staff/children', label: '園児', end: false, adminOnly: false },
];

const ADMIN_NAV = [
  { to: '/staff/admin/approval', label: '承認待ち' },
  { to: '/staff/admin/staff-accounts', label: '職員アカウント' },
  { to: '/staff/admin/invitations', label: '招待コード' },
  { to: '/staff/admin/guardian-accounts', label: '保護者アカウント' },
  { to: '/staff/admin/fiscal-year', label: '年度更新' },
  { to: '/staff/admin/logs', label: '操作ログ' },
  { to: '/staff/admin/misdelivery', label: '誤送信対応' },
];

export default function StaffLayout() {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const summary = useAsync(() => api.staffSummary(user!), [user?.account_id]);

  if (!user) return null;
  const isAdmin = user.role === '1';

  // 未対応の総数をヘッダの通知に添える（画面詳細図 1-1）
  const s = summary.data;
  const pending = s ? s.returned + s.unreadChat + s.devOverdue + s.pending + s.abnormalWithoutDiary : 0;

  const onLogout = async () => {
    await logout();
    // ログアウトの遷移先はログインしていた系統のトップ（基本設計書「画面遷移」(3-4)）
    navigate('/staff-top');
  };

  return (
    <div className="staff-shell">
      <a className="skip-link" href="#staff-main">本文へ移動</a>
      <header className="app-header">
        <div className="header-brand">
          <img className="header-mark" src="/crayon-smiles.png" alt="" aria-hidden="true" />
          <img className="header-wordmark" src="/login-wordmark-crayon.png" alt="すくすく" />
        </div>
        <div className="spacer" />
        <button className="notify-btn" title="通知" aria-label={`通知 ${pending}件`} onClick={() => navigate('/staff')}>
          <BellIcon />
          {pending > 0 && <span className="notify-badge">{pending}</span>}
        </button>
        {/*
          ログイン中の職員名と所属クラスを常時置く。
          共有端末での記録者の取り違えを防ぐため（要件定義書「端末の利用形態と本人特定」(4-1-4 (4))）
        */}
        <span className="who">
          {user.class_name && <span className="cls">{user.class_name}</span>}
          {user.display_name}
        </span>
        {/* 職員はログアウトをヘッダに常時表示する。共有端末での担当交代に用いる（基本設計書 3-5） */}
        <button onClick={onLogout}>ログアウト</button>
      </header>

      <div className="staff-body">
        <nav className="sidenav" aria-label="職員メニュー">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => (isActive ? 'current' : '')}>
              {n.label}
            </NavLink>
          ))}
          {/* 「管理」は管理者にのみ表示し、一般には項目自体を出さない（画面詳細図 1-1） */}
          {isAdmin && (
            <>
              <hr />
              <div className="group-label">管理（管理者）</div>
              {ADMIN_NAV.map((n) => (
                <NavLink key={n.to} to={n.to}
                  className={({ isActive }) => (isActive ? 'current' : '')}>
                  {n.label}
                </NavLink>
              ))}
            </>
          )}
        </nav>
        <main className="main" id="staff-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
