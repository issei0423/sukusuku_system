/*
 * 職員（タブレット／PC）の共通レイアウト
 * 典拠：図/画面詳細図.md「職員（タブレット／PC）」(1-1)、基本設計書.md「画面基本構成」(3-5)
 */
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../session';
import { useAsync, AUTO_REFRESH_MS } from '../hooks';
import { onLive } from '../live';
import { api } from '../api/client';
import { BellIcon, Alert } from '../components/ui';
import LiveIndicator from '../components/LiveIndicator';
import ConnectionBanner from '../components/ConnectionBanner';
import { ConfirmDialog, ToastHost } from '../components/feedback';
import SessionTimeoutWarning from '../components/SessionTimeoutWarning';
import ScreenErrorBoundary from '../components/ScreenErrorBoundary';
import { UnsavedInputContext, useUnsavedInputTracker } from '../unsavedInput';

const NAV = [
  { to: '/staff', label: 'ダッシュボード', end: true, adminOnly: false },
  { to: '/staff/diary', label: '日誌', end: false, adminOnly: false },
  { to: '/staff/chat', label: 'チャット', end: false, adminOnly: false },
  { to: '/staff/nap', label: '午睡チェック', end: false, adminOnly: false },
  { to: '/staff/contact', label: '連絡帳', end: false, adminOnly: false },
  { to: '/staff/growth', label: '発達・身体', end: false, adminOnly: false },
  { to: '/staff/children', label: '園児', end: false, adminOnly: false },
];

/*
 * 自分のアカウントにかかわる画面。メニューからパスワードの変更・利用規約の参照へ移る
 * （図/画面遷移図.md「共通・認証」(2) の「職員ダッシュボード／保護者ホーム｜メニューからパスワードの変更・利用規約」。
 * GitHub Issue #178 の 3）。図/画面詳細図.md「職員（タブレット／PC）」(1-1) 項目5 のサイドナビの列挙には無く、
 * 設計書どうしでそろっていない。【仮置き】職員のメニューであるサイドナビの末尾に置く（web/仮置き値.md）
 */
const ACCOUNT_NAV = [
  { to: '/staff/password', label: 'パスワードの変更' },
  { to: '/staff/terms', label: '利用規約' },
];

const ADMIN_NAV = [
  { to: '/staff/admin/approval', label: '承認待ち' },
  { to: '/staff/admin/staff-accounts', label: '職員アカウント' },
  { to: '/staff/admin/invitations', label: '招待コード' },
  { to: '/staff/admin/guardian-accounts', label: '保護者アカウント' },
  { to: '/staff/admin/fiscal-year', label: '年度更新' },
  { to: '/staff/admin/logs', label: '操作ログ' },
  { to: '/staff/admin/misdelivery', label: '誤送信対応' },
  { to: '/staff/admin/settings', label: '設定' },
];

export default function StaffLayout() {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  /*
   * 保存していない入力があるときに出す、ログアウトの確認（図/画面詳細図「全画面に共通する規定」(0-2) のログアウト、
   * 基本設計書「ログアウト」(4-3)）。保護者の共通レイアウトと同じ作り（GitHub Issue #170・#304）
   */
  const [confirmLogout, setConfirmLogout] = useState(false);
  const unsaved = useUnsavedInputTracker();
  /*
   * どの画面を開いていても、保護者からのチャットなどがすぐに通知の件数に表れるよう、知らせ（live.ts）を受けて
   * 読み直す。件数はダッシュボードと同じもの（チャット・日誌・午睡・発達チェック）を足している。
   * 知らせが切れている間は数秒ごとに読み直す
   */
  const summary = useAsync(() => api.staffSummary(user!), [user?.account_id],
    { refreshMs: AUTO_REFRESH_MS, live: onLive('chat', 'diary', 'nap', 'development', 'contact') });

  if (!user) return null;
  const isAdmin = user.role === '1';

  // 未対応の総数をヘッダの通知に添える（画面詳細図 1-1）。ダッシュボードに並ぶ件数の合計
  // （誤送信への対応を記録していない取り消しは、管理者にだけ数えて返る。GitHub Issue #141 の 3）
  const s = summary.data;
  const pending = s
    ? s.returned + s.unhandledChat + s.devOverdue + s.pending + s.abnormalWithoutDiary + s.misdeliveryUnrecorded
      + s.homeUnconfirmed + s.homeRevised
    : 0;

  const doLogout = async () => {
    await logout();
    // ログアウトの遷移先はログインしていた系統のトップ（基本設計書「画面遷移」(3-4)）
    navigate('/staff-top');
  };
  // 保存していない入力（書きかけの日誌・メッセージなど）があれば、破棄される旨を表示して確認する（基本設計書「ログアウト」(4-3)）
  const onLogout = () => {
    if (unsaved.hasUnsavedInput()) {
      setConfirmLogout(true);
      return;
    }
    void doLogout();
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
        {/* 相手の操作がすぐに出る状態か。切れている間は自動で読み直していることを示す（live.ts） */}
        <LiveIndicator />
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
          <hr />
          {ACCOUNT_NAV.map((n) => (
            <NavLink key={n.to} to={n.to}
              className={({ isActive }) => (isActive ? 'current' : '')}>
              {n.label}
            </NavLink>
          ))}
          {/* 【仮置き】小さい画面で下の項目があることを示す（web/仮置き値.md）。 */}
          {isAdmin && <div className="sidenav-hint">↕ メニューはスクロールできます</div>}
        </nav>
        <main className="main" id="staff-main" tabIndex={-1}>
          {/* サーバに届かないときの帯。午睡チェック画面では大きく出す（詳細設計書「つながっているかの表示」(2-8)） */}
          <ConnectionBanner audience="staff" large={pathname.startsWith('/staff/nap')} />
          {/*
            担当クラスの無い一般の職員は、園児も日誌も1件も見えない。
            何も出ない理由が画面から分からないため、ここで伝える（GitHub Issue #127）
          */}
          {user.role === '2' && !user.class_id && (
            <div style={{ marginBottom: 16 }}>
              <Alert soft>
                担当クラスが割り当てられていません。園児・日誌・チャットは、担当クラスが決まると表示されます。
                管理者へ割り当てを依頼してください。
              </Alert>
            </div>
          )}
          <UnsavedInputContext.Provider value={unsaved.report}>
            {/* 画面の例外で真っ白にしない。画面を移ったら受け皿を作り直す */}
            <ScreenErrorBoundary key={pathname}>
              <Outlet />
            </ScreenErrorBoundary>
          </UnsavedInputContext.Provider>
        </main>
        <ToastHost />
        {/*
          自動ログアウトの予告と「続ける」。自動ログアウトは職員の画面に限る（基本設計書「ログイン」(4-3)）ので、
          保護者の共通レイアウトには置かない（GitHub Issue #210）
        */}
        <SessionTimeoutWarning />
      </div>

      {confirmLogout && (
        <ConfirmDialog title="保存していない入力があります" confirmLabel="破棄してログアウトする" danger
          onConfirm={() => { setConfirmLogout(false); void doLogout(); }} onCancel={() => setConfirmLogout(false)}>
          <p>入力した内容を送信・保存していません。このままログアウトすると、入力した内容は破棄されます。</p>
          <p className="muted">残すときは、「やめる」を押してから送信・保存してください。</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
