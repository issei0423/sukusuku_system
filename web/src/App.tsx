/*
 * 画面の配線
 * 典拠：基本設計書.md「画面の一覧」(3-2)、図/画面遷移図.md
 *
 * 画面IDは採番せず画面名で呼ぶ（基本設計書「画面詳細」(3-6)）。
 * URL は画面名に対応させ、学校テンプレートが求める n-n-n-n 形式の画面IDは
 * 提出時に対応表で満たす（対応表は未作成）。
 */
import { startTransition, useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from './session';
import { api, backend, connectLive, onProcedureRequired, onSessionEnded } from './api/client';
import StaffLayout from './layouts/StaffLayout';
import GuardianLayout from './layouts/GuardianLayout';

// 共通・認証
import TopScreen from './screens/auth/TopScreen';
import SignUpScreen from './screens/auth/SignUpScreen';
import PasswordChangeScreen from './screens/auth/PasswordChangeScreen';
import TermsAgreeScreen from './screens/auth/TermsAgreeScreen';
import StaffDashboard from './screens/auth/StaffDashboard';
import GuardianHome from './screens/auth/GuardianHome';
import GuardianContactScreen from './screens/contact/GuardianContactScreen';
import ContactClassScreen from './screens/contact/ContactClassScreen';

// 日誌システム
import DiaryListScreen from './screens/diary/DiaryListScreen';
import DiaryEditScreen from './screens/diary/DiaryEditScreen';
import DiaryConfirmScreen from './screens/diary/DiaryConfirmScreen';
import ApprovalListScreen from './screens/diary/ApprovalListScreen';
import DiaryApproveScreen from './screens/diary/DiaryApproveScreen';
import ChildTimelineScreen from './screens/diary/ChildTimelineScreen';

// チャットツール
import StaffChatScreen from './screens/chat/StaffChatScreen';
import GuardianChatScreen from './screens/chat/GuardianChatScreen';
import GroupEditScreen from './screens/chat/GroupEditScreen';
import MisdeliveryScreen from './screens/chat/MisdeliveryScreen';
import StaffHandoutsScreen from './screens/chat/StaffHandoutsScreen';
import GuardianHandoutsScreen from './screens/chat/GuardianHandoutsScreen';

// 午睡チェック
import NapCheckScreen from './screens/nap/NapCheckScreen';
import NapAbnormalScreen from './screens/nap/NapAbnormalScreen';
import NapSearchScreen from './screens/nap/NapSearchScreen';

// 発達チェック・身体測定
import DevListScreen from './screens/growth/DevListScreen';
import DevInputScreen from './screens/growth/DevInputScreen';
import DevScheduleScreen from './screens/growth/DevScheduleScreen';
import PhysicalRecordScreen from './screens/growth/PhysicalRecordScreen';
import ShareSettingScreen from './screens/growth/ShareSettingScreen';

// 園児マスター・アカウント管理
import ChildListScreen from './screens/master/ChildListScreen';
import ChildInputScreen from './screens/master/ChildInputScreen';
import ChildConfirmScreen from './screens/master/ChildConfirmScreen';
import ChildCsvScreen from './screens/master/ChildCsvScreen';
import AllergyListScreen from './screens/master/AllergyListScreen';
import FiscalYearScreen from './screens/master/FiscalYearScreen';
import StaffAccountsScreen from './screens/master/StaffAccountsScreen';
import InvitationCodesScreen from './screens/master/InvitationCodesScreen';
import GuardianAccountsScreen from './screens/master/GuardianAccountsScreen';
import OperationLogScreen from './screens/master/OperationLogScreen';

const pageNames: Record<string, string> = {
  '/': '保護者用トップ', '/staff-top': '職員用トップ', '/signup': '新規登録',
  '/password-change': 'パスワードの変更', '/terms-agree': '利用規約への同意',
  '/staff': 'ダッシュボード', '/staff/password': 'パスワードの変更', '/staff/terms': '利用規約',
  '/staff/diary': '日誌', '/staff/diary/new': '日誌の作成', '/staff/diary/confirm': '日誌の確認',
  '/staff/chat': 'チャット', '/staff/chat/groups': 'グループ編成', '/staff/handouts': '配布物',
  '/staff/nap': '午睡チェック', '/staff/nap/abnormal': '異常時の記録', '/staff/nap/search': '午睡記録の検索',
  '/staff/growth': '発達チェック', '/staff/growth/physical': '身体記録',
  '/staff/growth/schedule': 'スケジュール設定', '/staff/growth/share': '共有範囲の設定',
  '/staff/children': '園児', '/staff/children/allergies': 'アレルギー一覧',
  '/staff/children/new': '園児情報の登録', '/staff/children/confirm': '園児情報の確認',
  '/staff/children/csv': 'CSV一括登録',
  '/staff/admin/approval': '承認待ち', '/staff/admin/misdelivery': '誤送信対応',
  '/staff/admin/staff-accounts': '職員アカウント', '/staff/admin/invitations': '招待コード',
  '/staff/admin/guardian-accounts': '保護者アカウント', '/staff/admin/fiscal-year': '年度更新',
  '/staff/admin/logs': '操作ログ', '/guardian': '保護者ホーム', '/guardian/chat': 'チャット・お知らせ',
  '/guardian/handouts': '園からの配布物', '/guardian/password': 'パスワードの変更', '/guardian/terms': '利用規約',
};

function PageNavigation() {
  const { pathname } = useLocation();
  const initial = useRef(true);
  const name = pageNames[pathname] ?? (pathname.startsWith('/staff/admin/approval/') ? '日誌の承認'
    : pathname.startsWith('/staff/diary/timeline/') ? '園児の記録'
    : pathname.startsWith('/staff/diary/') ? '日誌の編集'
    : pathname.startsWith('/staff/growth/dev/') ? '発達チェックの入力'
    : pathname.startsWith('/staff/children/') ? '園児情報の編集' : 'すくすく');
  useEffect(() => {
    document.title = `${name} — すくすく`;
    if (initial.current) { initial.current = false; return; }
    const id = window.setTimeout(() => document.querySelector<HTMLElement>('main')?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [pathname, name]);
  return null;
}

/**
 * ログイン中の職員だけを通す。
 * 一時パスワード中と規約の再同意が必要な間は、完了するまで他の画面へ進めない
 * （基本設計書「画面遷移」(3-4)）
 */
function RequireStaff() {
  const { user } = useSession();
  if (!user) return <Navigate to="/staff-top" replace />;
  if (user.role === '3') return <Navigate to="/guardian" replace />;
  if (user.is_temp_password) return <Navigate to="/password-change" replace />;
  if (!user.terms_agreed) return <Navigate to="/terms-agree" replace />;
  return <StaffLayout />;
}

/**
 * 強制で通る経路（一時パスワードからの変更・規約への同意）は、その手続きが残っている利用者だけに通す
 * （図/画面遷移図.md「共通・認証」(2)「強制で通る経路と、メニューから任意に開く経路の2つがある」。GitHub Issue #178 の 4）。
 * - 未ログインで開いたら、白紙にせず保護者用トップへ送る。どちらの系統かは分からないため、
 *   ほかの知らない経路と同じ入口にそろえる【仮置き】（web/仮置き値.md）
 * - 手続きが残っていない利用者は、メニューから開く任意の画面（パスワードの変更・利用規約の参照）へ送る。
 *   一時パスワードの案内は、一時パスワードでログインした直後だけに出す（図/画面詳細図.md「パスワード変更画面」(2-4) 項目1）
 * - 一時パスワードの変更が先、規約への同意が後（RequireStaff / RequireGuardian と同じ順）
 */
function RequireProcedure({ step }: { step: 'password' | 'terms' }) {
  const { user } = useSession();
  /*
   * この画面の「変更せずログアウトする」「同意せずログアウトする」で利用者が空になったときは、
   * 押したボタンの側が、ログインしていた系統のトップへ送る（基本設計書「ログアウト」(4-3)）。
   * ここでも入口へ送ると、利用者を空にした描画が場所の更新より先に走り、送り先が食い違う
   */
  const [openedWithUser] = useState(() => user !== null);
  if (!user) return openedWithUser ? null : <Navigate to="/" replace />;
  const home = user.role === '3' ? '/guardian' : '/staff';
  if (step === 'password') {
    return user.is_temp_password ? <PasswordChangeScreen forced /> : <Navigate to={`${home}/password`} replace />;
  }
  if (user.is_temp_password) return <Navigate to="/password-change" replace />;
  return user.terms_agreed ? <Navigate to={`${home}/terms`} replace /> : <TermsAgreeScreen />;
}

/** 管理者だけを通す。権限の担保はサーバ側（api/client.ts）が行い、ここは操作性のための出し分け */
function RequireAdmin() {
  const { user } = useSession();
  if (!user) return <Navigate to="/staff-top" replace />;
  // 黙って戻すと、権限が無いのか壊れているのかが分からない。理由を持たせて戻す（GitHub Issue #127）
  if (user.role !== '1') return <Navigate to="/staff" replace state={{ denied: 'admin' }} />;
  return <StaffLayout />;
}

function RequireGuardian() {
  const { user } = useSession();
  if (!user) return <Navigate to="/" replace />;
  if (user.role !== '3') return <Navigate to="/staff" replace />;
  if (user.is_temp_password) return <Navigate to="/password-change" replace />;
  if (!user.terms_agreed) return <Navigate to="/terms-agree" replace />;
  return <GuardianLayout />;
}

export default function App() {
  const { user, setUser } = useSession();
  // モックはメモリ上にしか状態を持たないため、復元するものが無い
  const [ready, setReady] = useState(backend === 'mock');

  /*
   * 手続きの途中と分かったら、その画面へ案内する。
   * ログイン中に管理者が一時パスワードを発行し直したときなど、画面が持つ利用者の情報が古いと、
   * サーバは手続きの API 以外を理由つきで拒否する（server/session.go の requireUser、api/procedure.ts）。
   * 利用者を読み直せば、RequireStaff / RequireGuardian がパスワードの変更・規約への同意の画面へ送る
   */
  const accountId = user?.account_id;
  useEffect(() => {
    if (accountId === undefined) return;
    return onProcedureRequired(() => {
      api.reloadSession(accountId).then(setUser, () => {});
    });
  }, [accountId, setUser]);

  /*
   * サーバにセッションを切られたら、利用者を空にして入口へ戻す（GitHub Issue #159）。
   * アカウントの停止・紐づけの解除・ほかの端末でのパスワードの変更・一時パスワードの再発行のとき、
   * サーバはログイン中のセッションを切る（server/session.go の destroyAccount）。開いたままの画面に
   * 前の内容を残さないため。戻り先はログインしていた系統のトップ（基本設計書「画面遷移」(3-4)）
   */
  const navigate = useNavigate();
  const role = user?.role;
  useEffect(() => {
    if (accountId === undefined) return;
    return onSessionEnded(() => {
      // 利用者を空にするのと、入口へ移るのを同じ描画で行う。ルータは場所の更新を startTransition で行うため、
      // 利用者だけを先に空にすると、RequireStaff / RequireGuardian が理由を持たずに入口へ送り直してしまう
      startTransition(() => {
        setUser(null);
        navigate(role === '3' ? '/' : '/staff-top', { replace: true, state: { sessionEnded: true } });
      });
    });
  }, [accountId, role, setUser, navigate]);

  /*
   * 相手の操作を、開いている画面へすぐに届ける接続（live.ts。server/events.go）。
   * ログインして画面を使える間だけ、タブに1本だけつなぎ、開いている画面すべてで共有する。
   * 一時パスワード中・規約の再同意待ちの間は、ほかの画面へ進めないため、つながない。
   * 利用者が変わったら（ログアウト・ほかの人のログイン）つなぎ直す
   */
  const liveActive = ready && user !== null && !user.is_temp_password && user.terms_agreed;
  useEffect(() => {
    if (!liveActive || accountId === undefined) return undefined;
    return connectLive(accountId);
  }, [liveActive, accountId]);

  /*
   * ページを開き直したときにセッションを復元する。
   * サーバ側にセッションを持つため、再読み込みでログアウトさせない。
   * 復元が終わるまで経路の判定を保留する。未ログイン扱いで入口へ飛ばさないため。
   */
  useEffect(() => {
    if (backend === 'mock') return;
    let alive = true;
    api.bootstrap()
      .then((u) => { if (alive && u) setUser(u); })
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);

  if (!ready) return <div className="empty">読み込んでいます…</div>;

  return (
    <>
    <PageNavigation />
    <Routes>
      {/* ---- 共通・認証（未ログイン） ---- */}
      <Route path="/" element={<TopScreen entrance="guardian" />} />
      <Route path="/staff-top" element={<TopScreen entrance="staff" />} />
      <Route path="/signup" element={<SignUpScreen />} />
      {/* ---- 共通・認証（強制で通る経路。手続きが残っている利用者だけ） ---- */}
      <Route path="/password-change" element={<RequireProcedure step="password" />} />
      <Route path="/terms-agree" element={<RequireProcedure step="terms" />} />

      {/* ---- 職員 ---- */}
      <Route path="/staff" element={<RequireStaff />}>
        <Route index element={<StaffDashboard />} />
        <Route path="password" element={<PasswordChangeScreen />} />
        <Route path="terms" element={<TermsAgreeScreen readOnly />} />

        <Route path="diary" element={<DiaryListScreen />} />
        <Route path="diary/new" element={<DiaryEditScreen />} />
        <Route path="diary/confirm" element={<DiaryConfirmScreen />} />
        <Route path="diary/timeline/:childId" element={<ChildTimelineScreen />} />
        <Route path="diary/:id" element={<DiaryEditScreen />} />

        <Route path="chat" element={<StaffChatScreen />} />
        <Route path="chat/groups" element={<GroupEditScreen />} />
        <Route path="handouts" element={<StaffHandoutsScreen />} />

        <Route path="nap" element={<NapCheckScreen />} />
        <Route path="contact" element={<ContactClassScreen />} />
        <Route path="nap/abnormal" element={<NapAbnormalScreen />} />
        <Route path="nap/search" element={<NapSearchScreen />} />

        <Route path="growth" element={<DevListScreen />} />
        <Route path="growth/dev/:childId" element={<DevInputScreen />} />
        <Route path="growth/physical" element={<PhysicalRecordScreen />} />

        <Route path="children" element={<ChildListScreen />} />
        <Route path="children/allergies" element={<AllergyListScreen />} />
      </Route>

      {/* ---- 職員（管理者のみ） ---- */}
      <Route path="/staff" element={<RequireAdmin />}>
        <Route path="admin/approval" element={<ApprovalListScreen />} />
        <Route path="admin/approval/:id" element={<DiaryApproveScreen />} />
        <Route path="admin/misdelivery" element={<MisdeliveryScreen />} />
        <Route path="admin/staff-accounts" element={<StaffAccountsScreen />} />
        <Route path="admin/invitations" element={<InvitationCodesScreen />} />
        <Route path="admin/guardian-accounts" element={<GuardianAccountsScreen />} />
        <Route path="admin/fiscal-year" element={<FiscalYearScreen />} />
        <Route path="admin/logs" element={<OperationLogScreen />} />
        <Route path="growth/schedule" element={<DevScheduleScreen />} />
        <Route path="growth/share" element={<ShareSettingScreen />} />
        <Route path="children/new" element={<ChildInputScreen />} />
        <Route path="children/confirm" element={<ChildConfirmScreen />} />
        <Route path="children/csv" element={<ChildCsvScreen />} />
        <Route path="children/:childId/edit" element={<ChildInputScreen />} />
      </Route>

      {/* ---- 保護者 ---- */}
      <Route path="/guardian" element={<RequireGuardian />}>
        <Route index element={<GuardianHome />} />
        <Route path="contact/:childId" element={<GuardianContactScreen />} />
        <Route path="chat" element={<GuardianChatScreen />} />
        <Route path="handouts" element={<GuardianHandoutsScreen />} />
        <Route path="password" element={<PasswordChangeScreen />} />
        <Route path="terms" element={<TermsAgreeScreen readOnly />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
