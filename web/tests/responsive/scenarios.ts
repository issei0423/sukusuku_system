export type ReviewRole = 'public' | 'teacher' | 'admin' | 'guardian';
export type ReviewAction = 'temperature' | 'temperature-decimal' | 'nap-warning' | 'nap-save' | 'guardian-menu';
export interface Scenario {
  id: string;
  name: string;
  path: string;
  role: ReviewRole;
  action?: ReviewAction;
  state?: unknown;
  /** ロールの既定の利用者から変える点。同意が残っている利用者で開くときなど */
  user?: { terms_agreed?: boolean; is_temp_password?: boolean };
}

export const REVIEW_TIME = '2026-09-01T13:30:00+09:00';
export const scenarios: Scenario[] = [
  { id: 'guardian-login', name: '保護者用トップ', path: '/', role: 'public' },
  { id: 'staff-login', name: '職員用トップ', path: '/staff-top', role: 'public' },
  { id: 'signup', name: '新規登録', path: '/signup', role: 'public' },
  // 同意を求める画面は、同意が残っている利用者にだけ出る（GitHub Issue #178 の 4）
  { id: 'terms', name: '利用規約への同意', path: '/terms-agree', role: 'guardian', user: { terms_agreed: false } },
  { id: 'staff-password', name: '職員パスワード変更', path: '/staff/password', role: 'teacher' },
  { id: 'dashboard', name: '職員ダッシュボード', path: '/staff', role: 'teacher' },
  { id: 'admin-dashboard', name: '管理者ダッシュボード', path: '/staff', role: 'admin' },
  { id: 'diary-list', name: '日誌一覧', path: '/staff/diary', role: 'teacher' },
  { id: 'diary-new', name: '日誌作成', path: '/staff/diary/new', role: 'teacher' },
  { id: 'diary-edit', name: '日誌編集', path: '/staff/diary/1', role: 'teacher' },
  { id: 'diary-confirm', name: '日誌確認', path: '/staff/diary/confirm', role: 'teacher', state: {
    recordType: '1', childId: 'C001', classId: 1, date: '2026-09-01', diaryId: null, photos: [],
    body: '午前中は園庭で遊びました。砂場で友達と道を作り、順番に車を走らせて楽しんでいました。\n給食をよく食べ、落ち着いて午睡に入りました。',
  } },
  { id: 'diary-approval-list', name: '承認待ち一覧', path: '/staff/admin/approval', role: 'admin' },
  { id: 'diary-approval', name: '日誌承認', path: '/staff/admin/approval/2', role: 'admin' },
  { id: 'child-timeline', name: '園児タイムライン', path: '/staff/diary/timeline/C001', role: 'teacher' },
  { id: 'staff-chat', name: '職員チャット', path: '/staff/chat', role: 'teacher' },
  { id: 'chat-groups', name: 'グループ編成', path: '/staff/chat/groups', role: 'teacher' },
  { id: 'misdelivery', name: '誤送信対応', path: '/staff/admin/misdelivery', role: 'admin' },
  { id: 'staff-handouts', name: '配布物管理', path: '/staff/handouts', role: 'admin' },
  { id: 'nap', name: '午睡チェック', path: '/staff/nap', role: 'teacher' },
  { id: 'nap-temperature', name: '体温パネル・整数', path: '/staff/nap', role: 'teacher', action: 'temperature' },
  { id: 'nap-temperature-decimal', name: '体温パネル・小数', path: '/staff/nap', role: 'teacher', action: 'temperature-decimal' },
  { id: 'nap-warning', name: '午睡チェック・注意表示', path: '/staff/nap', role: 'teacher', action: 'nap-warning' },
  { id: 'nap-save', name: '午睡チェック・保存後', path: '/staff/nap', role: 'teacher', action: 'nap-save' },
  { id: 'nap-abnormal', name: '異常時の記録', path: '/staff/nap/abnormal', role: 'teacher' },
  { id: 'nap-search', name: '午睡記録検索', path: '/staff/nap/search', role: 'teacher' },
  { id: 'development', name: '発達チェック一覧', path: '/staff/growth', role: 'teacher' },
  { id: 'development-input', name: '発達チェック入力', path: '/staff/growth/dev/C001', role: 'teacher' },
  { id: 'development-schedule', name: 'スケジュール設定', path: '/staff/growth/schedule', role: 'admin' },
  { id: 'physical', name: '身体記録', path: '/staff/growth/physical', role: 'teacher' },
  { id: 'share', name: '共有範囲設定', path: '/staff/growth/share', role: 'admin' },
  { id: 'children', name: '園児一覧', path: '/staff/children', role: 'admin' },
  { id: 'child-new', name: '園児登録', path: '/staff/children/new', role: 'admin' },
  { id: 'child-edit', name: '園児編集', path: '/staff/children/C001/edit', role: 'admin' },
  { id: 'child-confirm', name: '園児情報確認', path: '/staff/children/confirm', role: 'admin', state: {
    mode: 'create', before: null, form: {
      child_id: 'REVIEW001', child_name: '確認用 はるか', child_name_kana: 'かくにんよう はるか',
      birth_date: '2025-06-01', sex: '2', normal_temperature: 36.6, photo_consent_level: '1', class_id: 1,
      allergies: [{ target_food: '卵', symptom: '発疹', response: '除去食を提供し、保護者へ連絡する' }], medical_histories: ['経過観察中'],
    },
  } },
  { id: 'child-csv', name: 'CSV一括登録', path: '/staff/children/csv', role: 'admin' },
  { id: 'allergies', name: 'アレルギー一覧', path: '/staff/children/allergies', role: 'teacher' },
  { id: 'fiscal-year', name: '年度更新', path: '/staff/admin/fiscal-year', role: 'admin' },
  { id: 'staff-accounts', name: '職員アカウント', path: '/staff/admin/staff-accounts', role: 'admin' },
  { id: 'invitations', name: '招待コード', path: '/staff/admin/invitations', role: 'admin' },
  { id: 'guardian-accounts', name: '保護者アカウント', path: '/staff/admin/guardian-accounts', role: 'admin' },
  { id: 'logs', name: '操作ログ', path: '/staff/admin/logs', role: 'admin' },
  { id: 'guardian-home', name: '保護者ホーム', path: '/guardian', role: 'guardian' },
  { id: 'guardian-menu', name: '保護者メニュー', path: '/guardian', role: 'guardian', action: 'guardian-menu' },
  { id: 'guardian-chat', name: '保護者チャット一覧', path: '/guardian/chat', role: 'guardian' },
  { id: 'guardian-handouts', name: '保護者配布物', path: '/guardian/handouts', role: 'guardian' },
  { id: 'guardian-password', name: '保護者パスワード変更', path: '/guardian/password', role: 'guardian' },
];
