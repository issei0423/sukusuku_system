/*
 * 保護者（スマートフォン）の共通レイアウト
 * 典拠：図/画面詳細図.md「保護者（スマートフォン）」(1-2)
 *
 * 片手操作を前提とする（基本設計書「画面基本構成」(3-5)）。毎日開く行き先（きょう・連絡帳・成長・チャット）は、
 * 画面の下に常に出すタブ（4つ）に置く。メニュー（ドロワー）は、たまに使うものだけ（お子さまの追加・AI の下書きの利用・
 * 園からの日誌・パスワードの変更・利用規約・ログアウト）。ログアウトはメニュー内に置く（基本設計書「画面基本構成」(3-5)）。
 *
 * 【仮置き】PC の幅（1024px 以上）では、下のタブを出さず、左の欄に同じ4つの行き先とメニューの項目を並べる（常に出す）。
 * 設計は保護者の画面をスマートフォン・縦向き・シングルカラムとだけ定め、PC で開いたときの見せ方を
 * 決めていない（基本設計書「想定する端末と向き」(3-5)）ための提案（web/仮置き値.md）。幅の切り替えは CSS（app.css）で行う。
 *
 * 【仮置き】緊急連絡は、設計の「画面の下端に常時表示」（基本設計書「画面基本構成」(3-5)）をやめ、ヘッダの「園に電話」
 * （電話のリンク）に置いた。下端は下のタブが使うため。どの画面でも常に見える点は変えていない。
 * 「急なご連絡は、お電話で」の注意の文は、ホームとチャット・お知らせの下のほうに静かに残した（web/仮置き値.md）。
 *
 * 【仮置き】見た目（白の地・ひよこ黄の細い帯・罫線と藍・丸ゴシックの見出し）は styles/guardian.css が、
 * .guardian-shell の中の色と書体を当て直して決める（web/仮置き値.md「保護者の画面の見た目」）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../session';
import { useAsync, AUTO_REFRESH_MS } from '../hooks';
import { onLive } from '../live';
import { api, settingText } from '../api/client';
import { BellIcon } from '../components/ui';
import {
  TodayIcon, ChatIcon, ContactBookIcon, DiaryIcon, GrowthIcon, AddChildIcon, AiDraftIcon, PasswordIcon, TermsIcon, LogoutIcon, MenuIcon, CloseIcon, CallIcon,
} from '../components/icons';
import { ConfirmDialog, ToastHost } from '../components/feedback';
import ConnectionBanner from '../components/ConnectionBanner';
import AiOptOutDialog from '../components/AiOptOutDialog';
import AddChildDialog from '../components/AddChildDialog';
import ScreenErrorBoundary from '../components/ScreenErrorBoundary';
import { AI_OPT_OUT_TEXT, ADD_CHILD_TEXT } from '../messages';
import { UnsavedInputContext, useUnsavedInputTracker } from '../unsavedInput';
import { GuardianChildContext, readSelectedChild, writeSelectedChild } from '../guardianChild';

/**
 * メニューの行き先（たまに使うもの）。スマートフォンのメニュー（ドロワー）と、PC の幅で常に出す左の欄で同じものを並べる。
 * 先に、ダイアログを開く項目（お子さまの追加・AI の下書きの利用）を置く（dialogItems）。
 * 項目の絵（icon）は文字に添えるだけ（components/icons.tsx の【仮置き】の決まり）
 */
const MENU_PAGES = [
  // 保護者が読める日誌は、保育士が共有を選び、園長が承認したものだけ（server/api_diary_share.go）
  { to: '/guardian/diaries', label: '園からの日誌', icon: <DiaryIcon /> },
];
const MENU_ACCOUNT = [
  { to: '/guardian/password', label: 'パスワードの変更', icon: <PasswordIcon /> },
  { to: '/guardian/terms', label: '利用規約', icon: <TermsIcon /> },
];

/** PC とみなす幅。app.css の保護者レイアウトと同じ値（【仮置き】web/仮置き値.md） */
const PC_WIDTH = '(min-width: 1024px)';

/** いま開いている画面が、下のタブ（4つ）のどれか。どれでもない画面（日誌・パスワードなど）は null */
type Section = 'today' | 'contact' | 'growth' | 'chat';
function sectionOf(pathname: string): Section | null {
  if (pathname === '/guardian') return 'today';
  if (pathname.startsWith('/guardian/contact')) return 'contact';
  if (pathname.startsWith('/guardian/growth')) return 'growth';
  // 園からの配布物はチャットの一部なので、チャットのタブを現在地にする
  if (pathname.startsWith('/guardian/chat') || pathname.startsWith('/guardian/handouts')) return 'chat';
  return null;
}

interface Destination {
  key: Section;
  to: string;
  /** 下のタブの字（短く） */
  label: string;
  /** PC の左の欄の字 */
  longLabel: string;
  icon: ReactNode;
  /** 行に添える字（「新着 2」「未読 3」）。数の札だけにせず、何の数かを字で書く */
  note: string | null;
}

export default function GuardianLayout() {
  const { user, logout } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  // 「AI の下書きの利用」のダイアログ（詳細設計書「AI の下書きの利用」(2-15 (4))）
  const [aiOptOutOpen, setAiOptOutOpen] = useState(false);
  // 「お子さまの追加」のダイアログ（詳細設計書「お子さまの追加」(2-15 (2))）
  const [addChildOpen, setAddChildOpen] = useState(false);
  // 画面を開き直すための番号。お子さまを追加したら進め、保護者ホームを読み直させる（その園児の区画が増える）
  const [screenKey, setScreenKey] = useState(0);
  // 保存していない入力があるときに出す、ログアウトの確認（基本設計書「ログアウト」(4-3)。GitHub Issue #170）
  const [confirmLogout, setConfirmLogout] = useState(false);
  const unsaved = useUnsavedInputTracker();
  const drawer = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  // 園からの返信・連絡帳の新着が、どの画面を開いていてもすぐに下のタブと通知の件数に表れるよう、知らせ（live.ts）を受けて読み直す
  // （知らせが切れている間は数秒ごとに読み直す）。ここで使うのは未読・新着の件数と園児の顔ぶれだけ
  const home = useAsync(() => api.guardianHome(user!), [user?.account_id],
    { refreshMs: AUTO_REFRESH_MS, live: onLive('chat', 'contact') });

  // いま見ているお子さま（下のタブの「連絡帳」「成長」の行き先）。画面をまたいで保つ
  const accountId = user?.account_id;
  const [selected, setSelected] = useState<string | null>(() => readSelectedChild(accountId));
  const children = home.data;
  const childId = children?.find((h) => h.child.child_id === selected)?.child.child_id ?? children?.[0]?.child.child_id ?? null;
  const setChildId = setSelected;
  // 選んだ園児を保存する
  useEffect(() => {
    if (selected) writeSelectedChild(accountId, selected);
  }, [selected, accountId]);
  // 連絡帳・成長の記録を園児の ID つきで開いたら、その園児を選んだことにする（描画のなかで値を合わせる。React の「前の値との比較」の形）
  const urlChild = /^\/guardian\/(?:contact|growth)\/([^/]+)/.exec(pathname)?.[1];
  const [seenUrlChild, setSeenUrlChild] = useState<string | undefined>(undefined);
  if (urlChild !== seenUrlChild) {
    setSeenUrlChild(urlChild);
    if (urlChild) setSelected(decodeURIComponent(urlChild));
  }
  // 別の画面へ移ったら、下のタブの件数を読み直す（開いた画面で既読にしたものを反映する）
  const firstPath = useRef(true);
  const { refresh: refreshHome } = home;
  useEffect(() => {
    if (firstPath.current) { firstPath.current = false; return; }
    refreshHome();
  }, [pathname, refreshHome]);
  // ホームが数えた「新しく n 件」（ホームを開いている間の連絡帳のタブに使う）
  const [homeNew, setHomeNew] = useState<Record<string, number>>({});
  const reportContactNew = useCallback((id: string, count: number) => {
    setHomeNew((prev) => (prev[id] === count ? prev : { ...prev, [id]: count }));
  }, []);
  const childContext = useMemo(() => ({ childId, setChildId, reportContactNew }), [childId, setChildId, reportContactNew]);

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
  // 園が AI を有効にしているときだけ、メニューに「AI の下書きの利用」を置く（GET /api/reference の ai.enabled。詳細設計書「メニューの項目」(2-15 (1))）
  const aiEnabled = settingText('ai.enabled', '0') === '1';

  const doLogout = async () => {
    await logout();
    navigate('/');
  };
  // 誰の保護者かを示す。「園児の氏名 保護者」と表す（図/画面詳細図.md の保護者の表し方）
  const who = `${home.data?.map((h) => h.child.child_name).join('・') || user.display_name} 保護者`;

  // 下のタブ（PC の幅では左の欄の先頭）の4つの行き先。連絡帳・成長は、いま見ているお子さまへ行く
  const section = sectionOf(pathname);
  const now = children?.find((h) => h.child.child_id === childId);
  const cid = childId ? encodeURIComponent(childId) : null;
  const contactNote = (() => {
    if (!now || section === 'contact') return null;
    const n = section === 'today' ? homeNew[now.child.child_id] ?? now.today.unread_contact : now.today.unread_contact;
    return n > 0 ? `新着 ${n}` : null;
  })();
  const destinations: Destination[] = [
    { key: 'today', to: '/guardian', label: 'きょう', longLabel: 'きょう', icon: <TodayIcon />, note: null },
    { key: 'contact', to: cid ? `/guardian/contact/${cid}` : '/guardian', label: '連絡帳', longLabel: '連絡帳', icon: <ContactBookIcon />, note: contactNote },
    { key: 'growth', to: cid ? `/guardian/growth/${cid}` : '/guardian', label: '成長', longLabel: '成長の記録', icon: <GrowthIcon />,
      note: now?.today.growth_new && section !== 'growth' ? '新着' : null },
    { key: 'chat', to: '/guardian/chat', label: 'チャット', longLabel: 'チャット・お知らせ', icon: <ChatIcon />,
      note: unread > 0 && section !== 'chat' ? `未読 ${unread}` : null },
  ];

  /*
   * ダイアログを開く項目。画面は移らない（図/画面詳細図「保護者（スマートフォン）」(1-2) の項目15・18）。
   * 並びは設計の「お子さまの追加・連絡先の変更・通知の設定・AI の下書きの利用」の位置（連絡先の変更は
   * 実装の順番の 15 の残り、通知の設定は【要決定】Web Push を作るかどうか。どちらもまだ画面が無いので置かない）。
   * お子さまの追加は常に置く。AI の下書きの利用は、区画を読めるまでは押させない（ダイアログの園児と初期値は区画から作る）。
   * ドロワーでは、メニューを閉じてから開く（close）
   */
  const dialogItems = (close: () => void) => (
    <>
      <button type="button" className="drawer-item" aria-haspopup="dialog"
        onClick={() => { close(); setAddChildOpen(true); }}><AddChildIcon />{ADD_CHILD_TEXT.title}</button>
      {aiEnabled && (
        <button type="button" className="drawer-item" aria-haspopup="dialog" disabled={!home.data}
          onClick={() => { close(); setAiOptOutOpen(true); }}><AiDraftIcon />{AI_OPT_OUT_TEXT.title}</button>
      )}
    </>
  );
  /*
   * 保存していない入力（書きかけのメッセージなど）があれば、破棄される旨を表示して確認する
   * （基本設計書「ログアウト」(4-3)）。メニューは閉じてから確認を出す（メニューとダイアログを重ねない）
   */
  const onLogout = () => {
    if (unsaved.hasUnsavedInput()) {
      setOpen(false);
      setConfirmLogout(true);
      return;
    }
    void doLogout();
  };
  /*
   * お子さまを追加したら、ダイアログを閉じ、保護者ホームを開き直して読み直す（詳細設計書「お子さまの追加」(2-15 (2)) の③）。
   * メニューの園児名も読み直す。【仮置き】保存していない入力のある画面からは移らない（入力を捨てない。
   * 次に保護者ホームを開けば読み直される。web/仮置き値.md）
   */
  const onChildAdded = () => {
    setAddChildOpen(false);
    home.refresh();
    if (unsaved.hasUnsavedInput()) return;
    setScreenKey((k) => k + 1);
    navigate('/guardian');
  };

  const noteOf = (d: Destination) => d.note && <span className="guardian-nav-note">{d.note}</span>;

  return (
    <div className="guardian-shell">
      <header className="guardian-header">
        <button ref={menuButton} className="guardian-menu-button" onClick={() => setOpen(true)} aria-label="メニューを開く" aria-expanded={open} aria-haspopup="dialog">
          <MenuIcon /><span>メニュー</span>
        </button>
        <Link className="guardian-brand" to="/guardian" aria-label="すくすく 保護者ホーム">
          <img className="guardian-brand-mark" src="/crayon-smiles.png" alt="" />
          <img className="guardian-brand-wordmark" src="/login-wordmark-crayon.png" alt="すくすく" />
        </Link>
        <div className="spacer" />
        {/* 急なご連絡は電話で。どの画面でも常に見えるよう、ヘッダに置く（番号は設定マスタから引く。未設定のあいだは出さない） */}
        {phone && (
          <a className="guardian-call" href={`tel:${phone.replace(/[^0-9+]/g, '')}`}>
            <CallIcon /><span>園に電話</span><span className="guardian-call-number">{phone}</span>
          </a>
        )}
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
                <CloseIcon />閉じる
              </button>
            </div>
            {dialogItems(() => setOpen(false))}
            {MENU_PAGES.map((m) => <Link key={m.to} to={m.to} onClick={() => setOpen(false)}>{m.icon}{m.label}</Link>)}
            {MENU_ACCOUNT.map((m) => <Link key={m.to} to={m.to} onClick={() => setOpen(false)}>{m.icon}{m.label}</Link>)}
            <div className="spacer" />
            {/* 保護者のログアウトはメニュー内（基本設計書 3-5） */}
            <button className="btn-block" onClick={onLogout}><LogoutIcon />ログアウト</button>
          </nav>
        </>
      )}

      {aiOptOutOpen && home.data && (
        <AiOptOutDialog user={user} rows={home.data} onChanged={home.refresh} onClose={() => setAiOptOutOpen(false)} />
      )}

      {addChildOpen && (
        <AddChildDialog user={user} onAdded={onChildAdded} onClose={() => setAddChildOpen(false)} />
      )}

      {confirmLogout && (
        <ConfirmDialog title="保存していない入力があります" confirmLabel="破棄してログアウトする" confirmIcon={<LogoutIcon />} danger
          onConfirm={() => { setConfirmLogout(false); void doLogout(); }} onCancel={() => setConfirmLogout(false)}>
          <p>入力した内容を送信・保存していません。このままログアウトすると、入力した内容は破棄されます。</p>
          <p className="muted">残すときは、「やめる」を押してから送信・保存してください。</p>
        </ConfirmDialog>
      )}

      <div className="guardian-body">
        {/* PC の幅で常に出すメニュー（下のタブの4つの行き先と、メニューの項目）。スマートフォン・タブレットの幅では CSS で隠し、下のタブと上のメニューから開く */}
        <nav className="guardian-sidebar" aria-label="メニュー">
          <div className="who">{who}</div>
          {destinations.map((d) => (
            <Link key={d.key} to={d.to} className="guardian-side-main"
              aria-current={section === d.key ? 'page' : undefined}>{d.icon}<span>{d.longLabel}</span>{noteOf(d)}</Link>
          ))}
          <div className="guardian-side-rule" role="separator" />
          {dialogItems(() => {})}
          {MENU_PAGES.map((m) => <NavLink key={m.to} to={m.to} end>{m.icon}{m.label}</NavLink>)}
          {MENU_ACCOUNT.map((m) => <NavLink key={m.to} to={m.to} end>{m.icon}{m.label}</NavLink>)}
          <div className="spacer" />
          <button className="btn-block" onClick={onLogout}><LogoutIcon />ログアウト</button>
        </nav>
        <main className="guardian-main" tabIndex={-1}>
          {/* 知らせが切れている・サーバに届かないときの帯（詳細設計書「つながっているかの表示」(2-8)） */}
          <ConnectionBanner audience="guardian" />
          <UnsavedInputContext.Provider value={unsaved.report}>
            <GuardianChildContext.Provider value={childContext}>
              {/* 画面の例外で真っ白にしない。画面を移ったら受け皿を作り直す */}
              <ScreenErrorBoundary key={pathname}>
                <Outlet key={screenKey} />
              </ScreenErrorBoundary>
            </GuardianChildContext.Provider>
          </UnsavedInputContext.Provider>
        </main>
      </div>

      {/*
        毎日開く4つの行き先。画面の下に常に出す（片手で押せる。字は必ず出し、現在地は色だけでなく太字と上の線でも示す）。
        連絡帳・成長は園児ごとの道なので、いま見ているお子さまへ行く。PC の幅では出さず、左の欄が同じ行き先を持つ
      */}
      <nav className="guardian-tabs" aria-label="主な画面">
        {destinations.map((d) => (
          <Link key={d.key} to={d.to} className="guardian-tab" aria-current={section === d.key ? 'page' : undefined}>
            {d.icon}<span className="guardian-tab-label">{d.label}</span>{noteOf(d)}
          </Link>
        ))}
      </nav>
      {/* 押した結果の表示。保護者のレイアウトにも置く（詳細設計書「共通の部品」(2-0 (1))、決めたこと D-21） */}
      <ToastHost />
    </div>
  );
}
