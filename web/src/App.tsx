/*
 * 画面の配線
 * 典拠：基本設計書.md「画面の一覧」(3-2)、図/画面遷移図.md
 *
 * 画面IDは採番せず画面名で呼ぶ（基本設計書「画面詳細」(3-6)）。
 * URL は画面名に対応させ、学校テンプレートが求める n-n-n-n 形式の画面IDは
 * 提出時に対応表で満たす（対応表は未作成）。
 */
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './session';
import { api, backend } from './api/client';
import StaffLayout from './layouts/StaffLayout';
import GuardianLayout from './layouts/GuardianLayout';

// 共通・認証
import TopScreen from './screens/auth/TopScreen';
import SignUpScreen from './screens/auth/SignUpScreen';
import PasswordChangeScreen from './screens/auth/PasswordChangeScreen';
import TermsAgreeScreen from './screens/auth/TermsAgreeScreen';
import StaffDashboard from './screens/auth/StaffDashboard';
import GuardianHome from './screens/auth/GuardianHome';

// 日誌システム
import DiaryListScreen from './screens/diary/DiaryListScreen';
import DiaryEditScreen from './screens/diary/DiaryEditScreen';
import DiaryConfirmScreen from './screens/diary/DiaryConfirmScreen';
import ApprovalListScreen from './screens/diary/ApprovalListScreen';
import DiaryApproveScreen from './screens/diary/DiaryApproveScreen';
import ChildTimelineScreen from './screens/diary/ChildTimelineScreen';
import GuardianDiaryScreen from './screens/diary/GuardianDiaryScreen';

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
  const { setUser } = useSession();
  // モックはメモリ上にしか状態を持たないため、復元するものが無い
  const [ready, setReady] = useState(backend === 'mock');

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
    <Routes>
      {/* ---- 共通・認証（未ログイン） ---- */}
      <Route path="/" element={<TopScreen entrance="guardian" />} />
      <Route path="/staff-top" element={<TopScreen entrance="staff" />} />
      <Route path="/signup" element={<SignUpScreen />} />
      <Route path="/password-change" element={<PasswordChangeScreen forced />} />
      <Route path="/terms-agree" element={<TermsAgreeScreen />} />

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
        <Route path="chat" element={<GuardianChatScreen />} />
        <Route path="handouts" element={<GuardianHandoutsScreen />} />
        <Route path="diary/:id" element={<GuardianDiaryScreen />} />
        <Route path="password" element={<PasswordChangeScreen />} />
        <Route path="terms" element={<TermsAgreeScreen readOnly />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
