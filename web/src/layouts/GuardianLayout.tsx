/*
 * 保護者（スマートフォン）の共通レイアウト
 * 典拠：図/画面詳細図.md「保護者（スマートフォン）」(1-2)
 *
 * スマートフォンではサイドナビを持たず、ホームからの導線に絞る。片手操作を前提とするため。
 * ログアウトはメニュー内に置く（基本設計書「画面基本構成」(3-5)）。
 *
 * 【仮置き】PC の幅（1024px 以上）では、メニューを左に常に出し、緊急連絡の番号をヘッダに置く。
 * 設計は保護者の画面をスマートフォン・縦向き・シングルカラムとだけ定め、PC で開いたときの見せ方を
 * 決めていない（基本設計書「想定する端末と向き」(3-5)）。PC で開くと 480px の列が中央に出るだけで、
 * メニューも隠れたままになるための提案（web/仮置き値.md）。幅の切り替えは CSS（app.css）で行う。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../session';
import { useAsync, AUTO_REFRESH_MS } from '../hooks';
import { api, settingText } from '../api/client';
import { BellIcon } from '../components/ui';

/** メニューの行き先。スマートフォンのメニュー（ドロワー）と、PC の幅で常に出すメニューで同じものを並べる */
const MENU = [
  { to: '/guardian', label: 'ホーム' },
  { to: '/guardian/chat', label: 'チャット・お知らせ' },
  { to: '/guardian/handouts', label: '園からの配布物' },
  { to: '/guardian/password', label: 'パスワードの変更' },
  { to: '/guardian/terms', label: '利用規約' },
];

/** PC とみなす幅。app.css の保護者レイアウトと同じ値（【仮置き】web/仮置き値.md） */
const PC_WIDTH = '(min-width: 1024px)';

export default function GuardianLayout() {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  // 園からの返信が、どの画面を開いていても数秒で通知の件数に表れるよう、裏で読み直す
  const home = useAsync(() => api.guardianHome(user!), [user?.account_id], { refreshMs: AUTO_REFRESH_MS });

  // PC の幅へ広げたら、開いていたメニューを閉じる。PC の幅ではメニューを左に常に出すため
  useEffect(() => {
    // matchMedia の無い環境（テストの jsdom）では見張らない
    if (typeof window.matchMedia !== 'function') return;
    const wide = window.matchMedia(PC_WIDTH);
    const onChange = () => { if (wide.matches) setOpen(false); };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, []);

  // 開いたらメニューに入り、閉じたら開いたボタンへ戻る
  useEffect(() => {
    if (!open) return;
    drawer.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(drawer.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? []);
      if (!items.length) return;
      if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === items[items.length - 1]) { e.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', onKey);
    const trigger = menuButton.current;
    return () => { document.removeEventListener('keydown', onKey); trigger?.focus(); };
  }, [open]);

  if (!user) return null;
  const unread = home.data?.[0]?.unread ?? 0;
  const phone = settingText('facility.phone_number', '');

  const onLogout = async () => {
    await logout();
    navigate('/');
  };
  // 誰の保護者かを示す。「園児の氏名 保護者」と表す（図/画面詳細図.md の保護者の表し方）
  const who = `${home.data?.map((h) => h.child.child_name).join('・') || user.display_name} 保護者`;

  return (
    <div className="guardian-shell">
      <header className="guardian-header">
        <button ref={menuButton} className="guardian-menu-button" onClick={() => setOpen(true)} aria-label="メニューを開く" aria-expanded={open} aria-haspopup="dialog">
          <span aria-hidden="true">☰</span><span>メニュー</span>
        </button>
        <Link className="guardian-brand" to="/guardian" aria-label="すくすく 保護者ホーム">
          <img className="guardian-brand-mark" src="/crayon-smiles.png" alt="" />
          <img className="guardian-brand-wordmark" src="/login-wordmark-crayon.png" alt="すくすく" />
        </Link>
        <div className="spacer" />
        {/* PC の幅では、緊急連絡の番号をヘッダにも置く（下端の案内は PC の幅では出さない） */}
        <div className="guardian-header-phone">
          <span>緊急のご連絡</span>
          {phone && <a href={`tel:${phone.replace(/[^0-9+]/g, '')}`}>{phone}</a>}
        </div>
        <button className="notify-btn" onClick={() => navigate('/guardian/chat')} title="通知" aria-label={`通知${unread > 0 ? ` ${unread}件` : ' 0件'}`}>
          <BellIcon />
          {unread > 0 && <span className="notify-badge">{unread}</span>}
        </button>
      </header>

      {open && (
        <>
          <div className="drawer-backdrop" onClick={() => setOpen(false)} />
          <nav ref={drawer} className="drawer guardian-drawer" role="dialog" aria-modal="true" aria-label="メニュー">
            {/*
              閉じるボタンをメニューの中に置く。外側の暗い部分を押しても閉じるが、
              それは見て分かる操作ではないため、閉じ方を文字で示す
            */}
            <div className="drawer-head">
              <div className="who">{who}</div>
              <button className="drawer-close" onClick={() => setOpen(false)} aria-label="メニューを閉じる">
                <span aria-hidden="true">×</span> 閉じる
              </button>
            </div>
            {MENU.map((m) => <Link key={m.to} to={m.to} onClick={() => setOpen(false)}>{m.label}</Link>)}
            <div className="spacer" />
            {/* 保護者のログアウトはメニュー内（基本設計書 3-5） */}
            <button className="btn-block" onClick={onLogout}>ログアウト</button>
          </nav>
        </>
      )}

      <div className="guardian-body">
        {/* PC の幅で常に出すメニュー。スマートフォン・タブレットの幅では CSS で隠し、上のメニューから開く */}
        <nav className="guardian-sidebar" aria-label="メニュー">
          <div className="who">{who}</div>
          {MENU.map((m) => <NavLink key={m.to} to={m.to} end>{m.label}</NavLink>)}
          <div className="spacer" />
          <button className="btn-block" onClick={onLogout}>ログアウト</button>
        </nav>
        <main className="guardian-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      {/*
        緊急連絡の案内は、保護者向けの全画面に常時置く（基本設計書「画面基本構成」(3-5)）。
        その場で電話へ切り替えられるよう、園の電話番号を添える。番号は設定マスタから引く。
        番号が未設定のあいだは文言だけを出す
      */}
      <footer className="guardian-footer">
        <span>緊急のご連絡はお電話でお願いします</span>
        {phone && <a href={`tel:${phone.replace(/[^0-9+]/g, '')}`}>{phone}</a>}
      </footer>
    </div>
  );
}
