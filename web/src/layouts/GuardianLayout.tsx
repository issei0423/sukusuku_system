/*
 * 保護者（スマートフォン）の共通レイアウト
 * 典拠：図/画面詳細図.md「保護者（スマートフォン）」(1-2)
 *
 * サイドナビを持たず、ホームからの導線に絞る。片手操作を前提とするため。
 * ログアウトはメニュー内に置く（基本設計書「画面基本構成」(3-5)）。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../session';
import { useAsync, AUTO_REFRESH_MS } from '../hooks';
import { api, settingText } from '../api/client';
import { BellIcon } from '../components/ui';

export default function GuardianLayout() {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  // 園からの返信が、どの画面を開いていても数秒で通知の件数に表れるよう、裏で読み直す
  const home = useAsync(() => api.guardianHome(user!), [user?.account_id], { refreshMs: AUTO_REFRESH_MS });

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
              {/* 誰の保護者かを示す。「園児の氏名 保護者」と表す（図/画面詳細図.md の保護者の表し方） */}
              <div className="who">
                {home.data?.map((h) => h.child.child_name).join('・') || user.display_name}
                {' '}保護者
              </div>
              <button className="drawer-close" onClick={() => setOpen(false)} aria-label="メニューを閉じる">
                <span aria-hidden="true">×</span> 閉じる
              </button>
            </div>
            <Link to="/guardian" onClick={() => setOpen(false)}>ホーム</Link>
            <Link to="/guardian/chat" onClick={() => setOpen(false)}>チャット・お知らせ</Link>
            <Link to="/guardian/handouts" onClick={() => setOpen(false)}>園からの配布物</Link>
            <Link to="/guardian/password" onClick={() => setOpen(false)}>パスワードの変更</Link>
            <Link to="/guardian/terms" onClick={() => setOpen(false)}>利用規約</Link>
            <div className="spacer" />
            {/* 保護者のログアウトはメニュー内（基本設計書 3-5） */}
            <button className="btn-block" onClick={onLogout}>ログアウト</button>
          </nav>
        </>
      )}

      <main className="guardian-main" tabIndex={-1}>
        <Outlet />
      </main>

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
