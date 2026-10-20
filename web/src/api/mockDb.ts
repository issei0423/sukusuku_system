/*
 * モックのデータストア
 *
 * Go サーバができるまでの間、ブラウザ内のメモリで永続層の代わりをする。
 * 構造は基本設計書.md「データベース設計」(5) のテーブル定義に合わせてあり、
 * Go 側の実装後は本ファイルを捨てて api/client.ts の fetch 実装に差し替える。
 *
 * 職員と保護者の氏名は、チームの5人の名前を借りている（園児の名字は保護者に合わせた）。
 * メールアドレス・招待コード・測定値・記録の内容はすべて架空である
 * （図/画面詳細図.md「本書の位置づけ」(0)）。
 */
import {
  GROWTH_PERCENTILES, GROWTH_SOURCE_2010, GROWTH_SOURCE_2010_INTERPOLATED,
  HEIGHT_CLASSES_2010, WEIGHT_CLASSES_2010, growthValue2010,
} from './growthStandard2010';
import { now, today } from './util';
import type {
  Account, Staff, Guardian, InvitationCode, Terms,
  Child, ClassRoom, ClassChild, ClassStaff, GuardianChild, Allergy, MedicalHistory,
  Diary, DiaryLock, DiaryTemplate, DiaryAttachment,
  ChatRoom, ChatMember, ChatMessage, ChatRead, ChatReaction, TermsAgreement, MisdeliveryRecord, Handout,
  NapSession, NapRecord, NapAbnormal,
  ContactHomeRecord, ContactEventRecord, ContactClassRecord, ContactFacilityRecord, ContactReadRecord,
  NapSleepRecord, NapExclusionRecord, PhraseRecord,
  DevelopmentCategory, DevelopmentItem, DevelopmentFrequency, ShareSetting,
  DevelopmentSchedule, DevelopmentCheck, DevelopmentResultRecord,
  PhysicalRecord, GrowthStandard, OperationLog, Setting,
} from './types';
import type { ContactPhotoRecord, ContactPhotoChildRecord } from './types';

/** 演習用の固定基準日。デモデータの日付はこの日を軸に組み立てている */
export const DEMO_TODAY = '2026-09-01';
/** 現在の年度。m_class は年度ごとに別レコードとする（基本設計書 5-3） */
export const FISCAL_YEAR = 2026;

/* ============ クラス（m_class） ============ */
export const classes: ClassRoom[] = [
  { class_id: 1, fiscal_year: 2026, class_name: 'さくら組', age_class: 1 },
  { class_id: 2, fiscal_year: 2026, class_name: 'ひまわり組', age_class: 2 },
  { class_id: 3, fiscal_year: 2026, class_name: 'もも組', age_class: 0 },
  // 過年度の割り当てを残し、過去にどのクラスの担任だったかを判定できるようにする（基本設計書 5-3）
  { class_id: 11, fiscal_year: 2025, class_name: 'さくら組', age_class: 1 },
  { class_id: 12, fiscal_year: 2025, class_name: 'ひまわり組', age_class: 2 },
];

/* ============ 職員（m_staff） ============ */
export const staff: Staff[] = [
  { staff_id: 'S001', account_id: 1, staff_name: '野原 一誠', created_at: '2024-04-01T09:00:00', updated_at: '2024-04-01T09:00:00' },
  { staff_id: 'S002', account_id: 2, staff_name: '上園 謙心', created_at: '2024-04-01T09:00:00', updated_at: '2024-04-01T09:00:00' },
  { staff_id: 'S003', account_id: 3, staff_name: '高梨 倫太朗', created_at: '2024-04-01T09:00:00', updated_at: '2026-04-01T09:00:00' },
  { staff_id: 'S004', account_id: 4, staff_name: '宮城 蓮', created_at: '2025-04-01T09:00:00', updated_at: '2026-04-01T09:00:00' },
  { staff_id: 'S005', account_id: 5, staff_name: '金城 宗一郎', created_at: '2025-04-01T09:00:00', updated_at: '2026-04-01T09:00:00' },
];

/* ============ 保護者（m_guardian） ============ */
export const guardians: Guardian[] = [
  { guardian_id: 'G001', account_id: 6, guardian_name: '野原 一誠', phone_number: '090-0000-0001', created_at: '2025-06-10T10:00:00', updated_at: '2025-06-10T10:00:00' },
  { guardian_id: 'G002', account_id: 7, guardian_name: '上園 謙心', phone_number: '090-0000-0002', created_at: '2025-04-05T10:00:00', updated_at: '2025-04-05T10:00:00' },
  { guardian_id: 'G003', account_id: 8, guardian_name: '高梨 倫太朗', phone_number: null, created_at: '2025-06-20T10:00:00', updated_at: '2025-06-20T10:00:00' },
  { guardian_id: 'G004', account_id: 9, guardian_name: '宮城 蓮', phone_number: '090-0000-0004', created_at: '2025-07-01T10:00:00', updated_at: '2025-07-01T10:00:00' },
  { guardian_id: 'G005', account_id: 10, guardian_name: '金城 宗一郎', phone_number: '090-0000-0005', created_at: '2025-07-05T10:00:00', updated_at: '2025-07-05T10:00:00' },
];

/* ============ アカウント（m_account） ============
 * ログインIDのメールアドレスはロールをまたいで園内で一意（基本設計書 5-2）
 * モックのためパスワードは平文で保持する。本実装ではハッシュ化する
 */
const T0 = '2024-04-01T09:00:00';
export const accounts: Account[] = [
  { account_id: 1, email: 'nohara@hoiku.example.jp', password_hash: 'pass1234', role: '1', status: '1', is_temp_password: false, temp_password_expires_at: null, failed_login_count: 0, locked_until: null, terms_version: '1.1', terms_agreed_at: T0, created_at: T0, updated_at: T0 },
  { account_id: 2, email: 'uezono@hoiku.example.jp',    password_hash: 'pass1234', role: '1', status: '1', is_temp_password: false, temp_password_expires_at: null, failed_login_count: 0, locked_until: null, terms_version: '1.1', terms_agreed_at: T0, created_at: T0, updated_at: T0 },
  { account_id: 3, email: 'takanashi@hoiku.example.jp',    password_hash: 'pass1234', role: '2', status: '1', is_temp_password: false, temp_password_expires_at: null, failed_login_count: 0, locked_until: null, terms_version: '1.1', terms_agreed_at: T0, created_at: T0, updated_at: T0 },
  // 一時パスワードでログインした状態を再現する。真の間は他機能を使わせない（基本設計書 5-2）
  { account_id: 4, email: 'miyagi@hoiku.example.jp',      password_hash: 'temp0901', role: '2', status: '1', is_temp_password: true,  temp_password_expires_at: '2026-09-03T09:00:00', failed_login_count: 0, locked_until: null, terms_version: '1.1', terms_agreed_at: T0, created_at: T0, updated_at: T0 },
  { account_id: 5, email: 'kinjo@hoiku.example.jp',    password_hash: 'pass1234', role: '2', status: '1', is_temp_password: false, temp_password_expires_at: null, failed_login_count: 0, locked_until: null, terms_version: '1.1', terms_agreed_at: T0, created_at: T0, updated_at: T0 },
  { account_id: 6, email: 'nohara.i@example.jp',        password_hash: 'pass1234', role: '3', status: '1', is_temp_password: false, temp_password_expires_at: null, failed_login_count: 0, locked_until: null, terms_version: '1.1', terms_agreed_at: '2025-06-10T10:00:00', created_at: '2025-06-10T10:00:00', updated_at: '2025-06-10T10:00:00' },
  // 規約の改定後、まだ再同意していない状態を再現する。次回ログインで同意画面を出す（基本設計書 3-4）
  { account_id: 7, email: 'uezono.k@example.jp',        password_hash: 'pass1234', role: '3', status: '1', is_temp_password: false, temp_password_expires_at: null, failed_login_count: 0, locked_until: null, terms_version: '0.9', terms_agreed_at: '2025-04-05T10:00:00', created_at: '2025-04-05T10:00:00', updated_at: '2025-04-05T10:00:00' },
  { account_id: 8, email: 'takanashi.r@example.jp',          password_hash: 'pass1234', role: '3', status: '2', is_temp_password: false, temp_password_expires_at: null, failed_login_count: 0, locked_until: null, terms_version: '1.1', terms_agreed_at: '2025-06-20T10:00:00', created_at: '2025-06-20T10:00:00', updated_at: '2026-08-20T10:00:00' },
  { account_id: 9, email: 'miyagi.r@example.jp', password_hash: 'pass1234', role: '3', status: '1', is_temp_password: false, temp_password_expires_at: null, failed_login_count: 0, locked_until: null, terms_version: '1.1', terms_agreed_at: '2025-07-01T10:00:00', created_at: '2025-07-01T10:00:00', updated_at: '2025-07-01T10:00:00' },
  { account_id: 10, email: 'kinjo.s@example.jp', password_hash: 'pass1234', role: '3', status: '1', is_temp_password: false, temp_password_expires_at: null, failed_login_count: 0, locked_until: null, terms_version: '1.1', terms_agreed_at: '2025-07-05T10:00:00', created_at: '2025-07-05T10:00:00', updated_at: '2025-07-05T10:00:00' },
];

/**
 * 最新版の利用規約。これと異なる terms_version のアカウントには再同意を求める。
 * 第1.1版は、文章の下書きに外部の AI を使うことの条を足した版（詳細設計書「デモデータ」(5-5 (2))。server/seed.sql と同じ）
 */
export const CURRENT_TERMS_VERSION = '1.1';

/* ============ 園児（m_child） ============ */

/**
 * 呼び名（m_child.nickname）。他児の名前の注意を見せるため（詳細設計書「デモデータ」(5-5 (2))。server/seed.sql と同じ）。
 * 園児情報入力の呼び名の欄で直した値も、他児の名前の注意（mock.ts の nameChildOf）が同じ園児の行から読む
 */
const demoNicknames: Record<string, string> = { C001: 'たっくん', C006: 'あおちゃん', C008: 'ゆいちゃん' };

function child(
  id: string, name: string, kana: string, birth: string, sex: Child['sex'], temp: number,
): Child {
  return {
    child_id: id, child_name: name, child_name_kana: kana,
    nickname: demoNicknames[id] ?? '',
    birth_date: birth, sex,
    normal_temperature: temp, enrollment_status: '1', photo_consent_level: '2',
    is_deleted: false, created_at: '2025-04-01T09:00:00', updated_at: '2026-04-01T09:00:00',
  };
}

export const children: Child[] = [
  // さくら組（1歳児）
  child('C001', '野原 太郎', 'のはら たろう', '2025-06-01', '1', 36.6),
  child('C002', '上園 花子', 'うえぞの はなこ', '2025-03-12', '2', 36.8),
  child('C003', '高梨 健',   'たかなし けん',   '2025-05-20', '1', 36.5),
  child('C004', '宮城 美咲', 'みやぎ みさき', '2025-04-08', '2', 36.7),
  child('C005', '金城 陸',   'きんじょう りく', '2025-07-15', '1', 36.4),
  child('C006', '伊藤 葵',   'いとう あおい', '2025-02-28', '2', 36.6),
  child('C007', '中村 蓮',   'なかむら れん', '2025-08-03', '1', 36.9),
  // 月末生まれ。応当日が存在しない月の扱いを確かめるための例（要件定義書 7-1 No.6）。
  // 生年月日も末尾の日付ずらしで動くため、月末になるのは基準日（2026-09-01）に起動したときだけ
  child('C008', '小林 結衣', 'こばやし ゆい', '2025-01-31', '2', 36.5),
  child('C009', '加藤 大和', 'かとう やまと', '2025-06-22', '1', 36.6),
  child('C010', '吉田 心春', 'よしだ こはる', '2025-03-30', '2', 36.7),
  child('C011', '山本 陽翔', 'やまもと はると', '2025-05-05', '1', 36.8),
  child('C012', '松本 咲良', 'まつもと さくら', '2025-09-09', '2', 36.5),
  // ひまわり組（2歳児）
  child('C013', '井上 空', 'いのうえ そら', '2024-05-14', '1', 36.6),
  child('C014', '木村 楓',   'きむら かえで', '2024-03-02', '2', 36.7),
  child('C015', '林 悠真',   'はやし ゆうま', '2024-07-21', '1', 36.5),
  child('C016', '清水 芽依', 'しみず めい',   '2024-11-11', '2', 36.8),
  child('C017', '山口 湊',   'やまぐち みなと', '2024-09-30', '1', 36.6),
  child('C018', '森 陽菜',   'もり ひな',     '2024-01-25', '2', 36.7),
  // もも組（0歳児）
  child('C019', '池田 樹',   'いけだ いつき', '2026-01-08', '1', 36.9),
  child('C020', '橋本 莉子', 'はしもと りこ', '2025-11-17', '2', 37.0),
  child('C021', '石川 律',   'いしかわ りつ', '2026-02-26', '1', 36.8),
  child('C022', '前田 詩',   'まえだ うた',   '2025-12-05', '2', 36.9),
];

/* ============ クラス在籍（t_class_child） ============ */
export const classChildren: ClassChild[] = [
  ...['C001','C002','C003','C004','C005','C006','C007','C008','C009','C010','C011','C012']
    .map((child_id) => ({ class_id: 1, child_id })),
  ...['C013','C014','C015','C016','C017','C018'].map((child_id) => ({ class_id: 2, child_id })),
  ...['C019','C020','C021','C022'].map((child_id) => ({ class_id: 3, child_id })),
];

/* ============ 担任の割り当て（t_class_staff） ============ */
export const classStaff: ClassStaff[] = [
  { class_id: 1, staff_id: 'S003' },
  { class_id: 1, staff_id: 'S004' },
  { class_id: 2, staff_id: 'S005' },
  { class_id: 11, staff_id: 'S003' },
];

/* ============ 園児と保護者の紐づけ（t_guardian_child） ============
 * 紐づけ単位で終了させる。アカウントの停止は有効な紐づけがゼロになった時点（基本設計書 5-3）
 */
export const guardianChildren: GuardianChild[] = [
  { guardian_id: 'G001', child_id: 'C001', relationship: '父', link_status: '1', linked_at: '2025-06-10T10:00:00', ended_at: null },
  { guardian_id: 'G002', child_id: 'C002', relationship: '父', link_status: '1', linked_at: '2025-04-05T10:00:00', ended_at: null },
  // 退園にともない紐づけを終了した例。参照範囲の判定に用いる
  { guardian_id: 'G003', child_id: 'C003', relationship: '父', link_status: '2', linked_at: '2025-06-20T10:00:00', ended_at: '2026-08-20T10:00:00' },
  { guardian_id: 'G004', child_id: 'C004', relationship: '父', link_status: '1', linked_at: '2025-07-01T10:00:00', ended_at: null },
  { guardian_id: 'G005', child_id: 'C005', relationship: '父', link_status: '1', linked_at: '2025-07-05T10:00:00', ended_at: null },
];

/* ============ アレルギー（m_allergy） ============ */
export const allergies: Allergy[] = [
  { allergy_id: 1, child_id: 'C001', target_food: '卵',       symptom: '発疹',       response: '除去食。発症時は冷却し保護者へ連絡' },
  { allergy_id: 2, child_id: 'C004', target_food: '乳',       symptom: '嘔吐',       response: '除去食。誤食時はただちに園長へ報告' },
  { allergy_id: 3, child_id: 'C004', target_food: '小麦',     symptom: '発疹',       response: '除去食' },
  { allergy_id: 4, child_id: 'C013', target_food: '落花生',   symptom: '呼吸困難',   response: '完全除去。エピペン預かりあり' },
  { allergy_id: 5, child_id: 'C020', target_food: 'そば',     symptom: 'じんましん', response: '完全除去' },
];

/* ============ 既往歴（m_medical_history）。要配慮個人情報（基本設計書 5-3） ============ */
export const medicalHistories: MedicalHistory[] = [
  { medical_history_id: 1, child_id: 'C005', content: '熱性けいれん（2026年3月）' },
  { medical_history_id: 2, child_id: 'C013', content: '気管支ぜんそく。吸入薬を預かり中' },
];

/* ============ 招待コード（t_invitation_code） ============
 * 1枚＝1アカウント。園児ごとに必要枚数を発行する（要件定義書「招待コードの発行」(4-1-2)）
 */
export const invitationCodes: InvitationCode[] = [
  { invitation_code_id: 1, code: 'ABCD-1234-EFGH', child_id: 'C001', expires_on: '2026-09-25', status: '1', used_account_id: null, used_at: null, issued_staff_id: 'S001', created_at: '2026-08-25T10:00:00' },
  { invitation_code_id: 2, code: 'IJKL-5678-MNOP', child_id: 'C001', expires_on: '2026-09-25', status: '2', used_account_id: 6, used_at: '2026-08-26T20:10:00', issued_staff_id: 'S001', created_at: '2026-08-25T10:00:00' },
  { invitation_code_id: 3, code: 'QRST-9012-UVWX', child_id: 'C002', expires_on: '2026-09-25', status: '1', used_account_id: null, used_at: null, issued_staff_id: 'S001', created_at: '2026-08-25T10:00:00' },
  { invitation_code_id: 4, code: 'YZAB-3456-CDEF', child_id: 'C002', expires_on: '2026-09-25', status: '3', used_account_id: null, used_at: null, issued_staff_id: 'S001', created_at: '2026-08-25T10:00:00' },
  { invitation_code_id: 5, code: 'GHIJ-7890-KLMN', child_id: 'C003', expires_on: '2026-09-25', status: '1', used_account_id: null, used_at: null, issued_staff_id: 'S002', created_at: '2026-08-25T10:00:00' },
  { invitation_code_id: 6, code: 'OPQR-1234-STUV', child_id: 'C004', expires_on: '2026-09-25', status: '1', used_account_id: null, used_at: null, issued_staff_id: 'S002', created_at: '2026-08-25T10:00:00' },
  { invitation_code_id: 7, code: 'WXYZ-5678-ABCD', child_id: 'C005', expires_on: '2026-09-25', status: '1', used_account_id: null, used_at: null, issued_staff_id: 'S002', created_at: '2026-08-25T10:00:00' },
];

/* ============ 利用規約（m_terms） ============
 * 本文は 利用規約・プライバシーポリシー.md 第1.0版の草案から抜粋した要約である。
 * 園情報の記入と法務の確認が未了（要決定事項.md B-21）
 */
export const termsDocs: Terms[] = [
  {
    terms_id: 1, terms_version: '1.0', document_type: '1', published_on: '2026-09-01', covers_external_ai: false,
    body: [
      '第1条（本規約について）',
      '本規約は、当園が提供する保育支援システム（以下「本システム」）の利用条件を定めるものです。本システムを利用する職員および保護者の双方に適用します。',
      '',
      '第2条（アカウント）',
      '職員のアカウントは、当園が発行します。保護者のアカウントは、当園が発行する招待コードによって登録します。招待コードは1枚につき1アカウントの登録にのみ使用できます。',
      'アカウントの情報は第三者に共有しないでください。',
      '',
      '第3条（本システムが行わないこと）',
      '本システムは、お子さまの発達の遅速の判定、医療的な診断、療育の要否の判断を一切行いません。',
      '記録および可視化は、保育士が気づくための支援であり、評価と判断の責任は当園にあります。',
      '',
      '第4条（緊急時の連絡）',
      '緊急を要する連絡は、本システムのチャットではなく電話で行います。',
      'チャットの通知は、端末の設定や通信の状況により届かない場合があります。',
      '',
      '第5条（記録の取り扱い）',
      '保護者への記録の共有範囲は、当園が項目ごとに設定します。',
      '',
      '※本文は演習用の草案です。',
    ].join('\n'),
  },
  {
    terms_id: 2, terms_version: '0.9', document_type: '1', published_on: '2025-04-01', covers_external_ai: false,
    body: '（旧版）第1条（本規約について）本規約は、当園が提供する保育支援システムの利用条件を定めるものです。',
  },
  {
    terms_id: 3, terms_version: '1.1', document_type: '1', published_on: '2026-09-01', covers_external_ai: true,
    body: [
      '第1条（本規約について）',
      '本規約は、当園が提供する保育支援システム（以下「本システム」）の利用条件を定めるものです。本システムを利用する職員および保護者の双方に適用します。',
      '',
      '第2条（アカウント）',
      '職員のアカウントは、当園が発行します。保護者のアカウントは、当園が発行する招待コードによって登録します。招待コードは1枚につき1アカウントの登録にのみ使用できます。',
      'アカウントの情報は第三者に共有しないでください。',
      '',
      '第3条（本システムが行わないこと）',
      '本システムは、お子さまの発達の遅速の判定、医療的な診断、療育の要否の判断を一切行いません。',
      '記録および可視化は、保育士が気づくための支援であり、評価と判断の責任は当園にあります。',
      '',
      '第4条（緊急時の連絡）',
      '緊急を要する連絡は、本システムのチャットではなく電話で行います。',
      'チャットの通知は、端末の設定や通信の状況により届かない場合があります。',
      '',
      '第5条（記録の取り扱い）',
      '保護者への記録の共有範囲は、当園が項目ごとに設定します。',
      '',
      '第6条（文章の下書きに外部の AI を使うこと）',
      '当園は、連絡帳の文の下書きを作るために、外部の AI（Anthropic 社の Claude）を使うことがあります。当園が使うと決めたときだけ動きます。',
      '送るのは、その日のできごと（時刻・食事の量・活動のようす）と、担任のメモと、年齢（何歳）だけです。お子さまの名前は置き換えて送り、名前・体温・写真・「家庭から」に書いた内容は送りません。',
      '下書きは担任が読んで直してから送ります。AI が保護者へ自動で送ることはありません。',
      '保護者は、お子さまごとに AI の下書きを使わないことを選べます。選んでも、連絡帳の届き方は変わりません。',
      '',
      '※本文は演習用の草案です。',
    ].join('\n'),
  },
  {
    terms_id: 4, terms_version: '1.1', document_type: '2', published_on: '2026-09-01', covers_external_ai: true,
    body: [
      '第1条（外部の AI へ送る情報）',
      '当園は、連絡帳の文の下書きを作るために、記録の一部を外部の AI（Anthropic 社の Claude）へ送ることがあります。送るのは、その日のできごと（時刻・食事の量・活動のようす）、担任のメモ、年齢（何歳）だけです。',
      '氏名・よみ・呼び名・生年月日・体温・アレルギー・既往歴・排せつの内容・写真・「家庭から」の内容・チャットの本文・発達の記録は送りません。名前は「〇〇ちゃん」「おともだち」に置き換えて送ります。',
      '送った文と返った文は、本システムに残しません。',
      '',
      '第2条（使わないことを選ぶ）',
      '保護者は、お子さまごとに AI の下書きを使わないことを選べます。紐づく保護者の1人でも選べば、そのお子さまには使いません。',
      '',
      '※本文は演習用の草案です。',
    ].join('\n'),
  },
];

/* ============ 日誌の雛形（m_diary_template） ============
 * 日誌は保護者へ届かないため、保護者への共有の既定を持たず、個人日誌の雛形に保護者あての見出しを置かない
 * （詳細設計書「変える表」(5-3)・「デモデータ」(5-5)）
 */
export const diaryTemplates: DiaryTemplate[] = [
  { diary_template_id: 1, record_type: '1', template_name: '個人日誌（標準）', is_deleted: false,
    body: '【今日の様子】\n\n【食事】\n\n【排泄】\n\n【午睡】\n\n【気づいたこと】\n' },
  { diary_template_id: 2, record_type: '2', template_name: 'クラス日誌（標準）', is_deleted: false,
    body: '【ねらい】\n\n【活動内容】\n\n【子どもの姿】\n\n【明日への配慮】\n' },
  { diary_template_id: 3, record_type: '3', template_name: '週案', is_deleted: false,
    body: '【今週のねらい】\n\n【環境構成】\n\n【予想される子どもの活動】\n\n【援助と配慮】\n' },
  { diary_template_id: 4, record_type: '4', template_name: 'ヒヤリハット', is_deleted: false,
    body: '【発生日時】\n\n【発生場所】\n\n【状況】\n\n【とった対応】\n\n【今後の対策】\n' },
];

/** 定型文。雛形とは別に、本文へ挿し込む短文（画面詳細図 3-2） */
export const fixedPhrases: string[] = [
  'よく食べ、おかわりをしていました。',
  '午睡は落ち着いて入眠できました。',
  '園庭で友だちと関わって遊ぶ姿が見られました。',
  '鼻水が出ていたため、こまめに拭き取りました。',
  'ご家庭でも様子を見ていただけますと幸いです。',
];

/* ============ 日誌（t_diary） ============ */
export const diaries: Diary[] = [
  { diary_id: 1, record_type: '1', child_id: 'C001', class_id: 1, diary_date: '2026-09-01', status: '1',
    body: '【今日の様子】\n積み木を高く積んで遊んでいました。崩れても笑って積み直していました。\n\n【食事】\n完食。\n\n【午睡】\n13:05に入眠。',
    created_staff_id: 'S003', approved_staff_id: null, approved_at: null, applied_staff_id: null, applied_at: null,
    nap_abnormal_id: null, returned_reason: null, is_deleted: false, created_at: '2026-09-01T16:40:00', updated_at: '2026-09-01T16:40:00' },
  { diary_id: 2, record_type: '2', child_id: null, class_id: 1, diary_date: '2026-08-31', status: '2',
    body: '【ねらい】\n身近な友だちと関わる楽しさを味わう。\n\n【活動内容】\n園庭でしゃぼん玉遊び。',
    created_staff_id: 'S003', approved_staff_id: null, approved_at: null, applied_staff_id: 'S003', applied_at: '2026-08-31T17:20:00',
    nap_abnormal_id: null, returned_reason: null, is_deleted: false, created_at: '2026-08-31T17:20:00', updated_at: '2026-08-31T17:20:00' },
  /*
   * ヒヤリハット。発生日時・場所・保護者へ伝えたことは列に、状況・とった対応・今後の対策は本文に見出しを付けて持つ
   * （詳細設計書「日誌の画面（作り直し）」(2-13 (8))・「日誌」(4-13 (1))、決めたこと D-33）。
   * 発生日時は異常時の記録（nap_abnormal_id 1）の発見時刻。場所・伝えた日時・相手はデモの値。server/seed.sql の diary_id 3 とそろえる
   */
  { diary_id: 3, record_type: '4', child_id: 'C003', class_id: 1, diary_date: '2026-08-30', status: '4',
    body: '【状況】\n午睡中にうつ伏せの体位を確認した。\n\n【とった対応】\n仰向けに直し、呼吸と顔色を確認した。\n\n【今後の対策】\n午睡の確認のたびに、呼吸とあわせて体位も見る。うつ伏せを見つけて仰向けに直したときは、直したあとの向きも記録する。',
    occurred_at: '2026-08-30T13:40:00', place: '保育室（さくら組）',
    guardian_notice: '1', guardian_noticed_at: '2026-08-30T17:10:00', guardian_notice_method: '2', guardian_notice_person: '父（お迎え）',
    created_staff_id: 'S004', approved_staff_id: null, approved_at: null, applied_staff_id: null, applied_at: null,
    nap_abnormal_id: 1, returned_reason: '発生時の呼吸・顔色の記録が本文にありません。異常時の記録と同じ内容を転記してください。',
    is_deleted: false, created_at: '2026-08-30T18:00:00', updated_at: '2026-08-31T09:10:00' },
  { diary_id: 4, record_type: '1', child_id: 'C002', class_id: 1, diary_date: '2026-08-29', status: '3',
    body: '【今日の様子】\n絵本の読み聞かせに集中していました。\n\n【食事】\n野菜を残しましたが、声をかけると一口食べました。',
    created_staff_id: 'S003', approved_staff_id: 'S001', approved_at: '2026-08-29T18:05:00', applied_staff_id: 'S003', applied_at: '2026-08-29T17:10:00',
    nap_abnormal_id: null, returned_reason: null, is_deleted: false, created_at: '2026-08-29T17:10:00', updated_at: '2026-08-29T18:05:00' },
  { diary_id: 5, record_type: '1', child_id: 'C001', class_id: 1, diary_date: '2026-08-29', status: '3',
    body: '【今日の様子】\n砂場でスコップを使い、型抜きを繰り返していました。\n\n【午睡】\n12:55に入眠。',
    created_staff_id: 'S003', approved_staff_id: 'S001', approved_at: '2026-08-29T18:06:00', applied_staff_id: 'S003', applied_at: '2026-08-29T17:15:00',
    nap_abnormal_id: null, returned_reason: null, is_deleted: false, created_at: '2026-08-29T17:15:00', updated_at: '2026-08-29T18:06:00' },
  { diary_id: 6, record_type: '2', child_id: null, class_id: 2, diary_date: '2026-09-01', status: '2',
    body: '【ねらい】\n身の回りのことを自分でやってみようとする。\n\n【活動内容】\n散歩（近隣公園）。',
    created_staff_id: 'S005', approved_staff_id: null, approved_at: null, applied_staff_id: 'S005', applied_at: '2026-09-01T17:00:00',
    nap_abnormal_id: null, returned_reason: null, is_deleted: false, created_at: '2026-09-01T17:00:00', updated_at: '2026-09-01T17:00:00' },
  { diary_id: 7, record_type: '1', child_id: 'C004', class_id: 1, diary_date: '2026-09-01', status: '2',
    body: '【今日の様子】\n手洗いを自分でしようとする姿がありました。',
    created_staff_id: 'S004', approved_staff_id: null, approved_at: null, applied_staff_id: 'S004', applied_at: '2026-09-01T17:20:00',
    nap_abnormal_id: null, returned_reason: null, is_deleted: false, created_at: '2026-09-01T17:20:00', updated_at: '2026-09-01T17:20:00' },
];

/* ============ 編集ロック（t_diary_lock） ============
 * 他の職員が開いている場合は、その旨をヘッダ直下に出す（画面詳細図 3-2）
 * デモで常にロック中の状態を見せるため、取得時刻は読み込み時の現在時刻にしている
 */
export const diaryLocks: DiaryLock[] = [
  { diary_id: 3, lock_token: 'lock-demo-0001', locked_staff_id: 'S004', locked_at: now(), last_active_at: now() },
];

/** 添付（t_diary_attachment）。1〜3枚（基本設計書 5-4） */
export const diaryAttachments: DiaryAttachment[] = [
  { diary_attachment_id: 1, diary_id: 4, file_path: 'demo/photo-1', file_type: 'image/jpeg' },
  { diary_attachment_id: 2, diary_id: 4, file_path: 'demo/photo-2', file_type: 'image/jpeg' },
];

/* ============ チャット（基本設計書 5-5） ============ */

/**
 * チャットルームの行。child_id は個人チャットの園児で、画面へは返さない（server/schema.sql の m_chat_room.child_id）。
 * 個人チャットのルームは園児単位で作る（基本設計書 5-5）。部屋の名前（園児名＋「の保護者」）で探すと、
 * 同じ氏名の別の園児がいるとき、別の家庭の個人チャットに入ってしまうため、園児ID で結ぶ（GitHub Issue #163）
 */
export type ChatRoomRow = ChatRoom & { child_id?: string | null };

export const chatRooms: ChatRoomRow[] = [
  { chat_room_id: 1, room_type: '1', class_id: null, room_name: '園全体',           is_archived: false, thread_status: null },
  { chat_room_id: 2, room_type: '5', class_id: null, room_name: '職員',             is_archived: false, thread_status: null },
  { chat_room_id: 3, room_type: '2', class_id: 1,    room_name: 'さくら組',         is_archived: false, thread_status: null },
  { chat_room_id: 4, room_type: '2', class_id: 2,    room_name: 'ひまわり組',       is_archived: false, thread_status: null },
  { chat_room_id: 5, room_type: '3', class_id: null, room_name: '運動会実行委員',   is_archived: false, thread_status: null },
  { chat_room_id: 6, room_type: '4', class_id: 1,    room_name: '野原 太郎の保護者', is_archived: false, thread_status: '1',  child_id: 'C001' },
  { chat_room_id: 7, room_type: '4', class_id: 1,    room_name: '上園 花子の保護者', is_archived: false, thread_status: null, child_id: 'C002' },
  { chat_room_id: 8, room_type: '4', class_id: 1,    room_name: '宮城 美咲の保護者', is_archived: false, thread_status: null, child_id: 'C004' },
  { chat_room_id: 9, room_type: '4', class_id: 1,    room_name: '金城 陸の保護者',   is_archived: false, thread_status: null, child_id: 'C005' },
  // 詳細設計書「デモデータ」(5-5)。保護者未登録でも在籍園児には個人チャットがある。
  ...children.filter((c) => !['C001', 'C002', 'C004', 'C005'].includes(c.child_id)).map((c, i) => ({
    chat_room_id: 10 + i, room_type: '4' as const,
    class_id: classChildren.find((cc) => cc.child_id === c.child_id)!.class_id,
    room_name: `${c.child_name}の保護者`, is_archived: false, thread_status: '2' as const, child_id: c.child_id,
  })),
];

/** 参加者（t_chat_member）。left_at で過去の所属期間を保持する（基本設計書 5-5） */
export const chatMembers: ChatMember[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((account_id) => ({ chat_room_id: 1, account_id, joined_at: '2026-04-01T09:00:00', left_at: null })),
  ...[1, 2, 3, 4, 5].map((account_id) => ({ chat_room_id: 2, account_id, joined_at: '2026-04-01T09:00:00', left_at: null })),
  ...[1, 2, 3, 4, 6, 7, 9, 10].map((account_id) => ({ chat_room_id: 3, account_id, joined_at: '2026-04-01T09:00:00', left_at: null })),
  ...[1, 2, 5].map((account_id) => ({ chat_room_id: 4, account_id, joined_at: '2026-04-01T09:00:00', left_at: null })),
  ...[1, 3, 5].map((account_id) => ({ chat_room_id: 5, account_id, joined_at: '2026-06-01T09:00:00', left_at: null })),
  // 個人チャットには、担任と、管理者の全員が入る。管理者も保護者との個人チャットを送受信できる
  // （要件定義書「チャットツール」(4-3)。職員の参加は mock.ts の syncStaffChatRooms が決める。server/seed.sql と同じ）
  ...[1, 2, 3, 4, 6].map((account_id) => ({ chat_room_id: 6, account_id, joined_at: '2025-06-10T10:00:00', left_at: null })),
  ...[1, 2, 3, 4, 7].map((account_id) => ({ chat_room_id: 7, account_id, joined_at: '2025-04-05T10:00:00', left_at: null })),
  ...[1, 2, 3, 4, 9].map((account_id) => ({ chat_room_id: 8, account_id, joined_at: '2025-07-01T10:00:00', left_at: null })),
  ...[1, 2, 3, 4, 10].map((account_id) => ({ chat_room_id: 9, account_id, joined_at: '2025-07-05T10:00:00', left_at: null })),
  ...chatRooms.filter((r) => r.room_type === '4' && r.chat_room_id >= 10).flatMap((r) => {
    const teacherIds = new Set(classStaff.filter((cs) => cs.class_id === r.class_id).map((cs) => cs.staff_id));
    return accounts.filter((a) => a.status === '1' && (a.role === '1' ||
      (a.role === '2' && staff.some((s) => s.account_id === a.account_id && teacherIds.has(s.staff_id)))))
      .map((a) => ({ chat_room_id: r.chat_room_id, account_id: a.account_id, joined_at: '2026-09-01T09:00:00', left_at: null }));
  }),
];

export const chatMessages: ChatMessage[] = [
  { chat_message_id: 1, chat_room_id: 1, sender_account_id: 1, body: '9月の献立表を掲示しました。ご確認ください。', source_type: '1', source_id: null, sent_at: '2026-09-01T08:30:00', edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null },
  { chat_message_id: 2, chat_room_id: 3, sender_account_id: 4, body: '明日の遠足の集合時間ですが、9時でよろしいでしょうか。', source_type: '1', source_id: null, sent_at: '2026-09-01T15:02:00', edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null },
  { chat_message_id: 3, chat_room_id: 3, sender_account_id: 3, body: '9時に園庭でお願いします。', source_type: '1', source_id: null, sent_at: '2026-09-01T15:10:00', edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null },
  { chat_message_id: 4, chat_room_id: 6, sender_account_id: 3, body: '今日は砂場でスコップを使って、型抜きを何度もしていました。', source_type: '1', source_id: null, sent_at: '2026-08-29T18:06:00', edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null },
  { chat_message_id: 5, chat_room_id: 6, sender_account_id: 6, body: 'ありがとうございます。確認しました。', source_type: '1', source_id: null, sent_at: '2026-08-29T20:30:00', edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null },
  { chat_message_id: 6, chat_room_id: 6, sender_account_id: 6, body: '明日は祖母がお迎えに伺います。よろしくお願いします。', source_type: '1', source_id: null, sent_at: '2026-09-01T07:40:00', edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null },
  { chat_message_id: 7, chat_room_id: 7, sender_account_id: 3, body: '今日は絵本の読み聞かせを、最後まで座って聞いていました。', source_type: '1', source_id: null, sent_at: '2026-08-29T18:05:00', edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null },
  { chat_message_id: 8, chat_room_id: 2, sender_account_id: 2, body: '来週の職員会議は水曜16時からです。', source_type: '1', source_id: null, sent_at: '2026-08-31T11:00:00', edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null },
  { chat_message_id: 9, chat_room_id: 5, sender_account_id: 1, body: '種目案を今週中にまとめましょう。', source_type: '1', source_id: null, sent_at: '2026-08-28T13:00:00', edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null },
  // 取消済みのメッセージ。誤送信への対応の記録と対にする（基本設計書「誤送信への対応」(4-6)）
  { chat_message_id: 10, chat_room_id: 7, sender_account_id: 3, body: '', source_type: '1', source_id: null, sent_at: '2026-08-27T16:12:00', edited_at: null, is_deleted: true, deleted_at: '2026-08-27T16:15:00', deleted_account_id: 3 },
];

/** リアクション（t_chat_reaction）。デモデータは持たない */
export const chatReactions: ChatReaction[] = [];

/** 既読（t_chat_read）。保護者側には表示しない（基本設計書 5-5） */
export const chatReads: ChatRead[] = [
  { chat_read_id: 1, chat_message_id: 3, account_id: 1, read_at: '2026-09-01T15:20:00' },
  { chat_read_id: 2, chat_message_id: 3, account_id: 2, read_at: '2026-09-01T15:25:00' },
  { chat_read_id: 3, chat_message_id: 3, account_id: 4, read_at: '2026-09-01T15:11:00' },
  { chat_read_id: 4, chat_message_id: 4, account_id: 6, read_at: '2026-08-29T20:28:00' },
];

/** 誤送信への対応の記録（t_misdelivery_record） */
export const misdeliveryRecords: MisdeliveryRecord[] = [
  { misdelivery_record_id: 1, chat_message_id: 10, occurred_at: '2026-08-27T16:12:00', was_read: false,
    response: '送信から3分後に取消。既読は付いていなかったため、宛先の保護者へは連絡していない。正しい宛先へ送り直した。', staff_id: 'S003' },
];

/* ============ 午睡チェック（基本設計書 5-6） ============ */
export const napSessions: NapSession[] = [
  { nap_session_id: 1, class_id: 1, session_date: '2026-09-01', started_staff_id: 'S003', started_at: '2026-09-01T13:00:00', ended_staff_id: null, ended_at: null, is_auto_closed: false },
  { nap_session_id: 2, class_id: 1, session_date: '2026-08-31', started_staff_id: 'S003', started_at: '2026-08-31T13:00:00', ended_staff_id: 'S003', ended_at: '2026-08-31T15:00:00', is_auto_closed: false },
  { nap_session_id: 3, class_id: 1, session_date: '2026-08-30', started_staff_id: 'S004', started_at: '2026-08-30T13:00:00', ended_staff_id: 'S004', ended_at: '2026-08-30T15:05:00', is_auto_closed: false },
  { nap_session_id: 4, class_id: 2, session_date: '2026-09-01', started_staff_id: 'S005', started_at: '2026-09-01T13:10:00', ended_staff_id: null, ended_at: null, is_auto_closed: false },
];

/**
 * 午睡の記録（t_nap_record）
 * 実施中のセッション1では、12名中8名が記録済みの状態を再現する（画面詳細図 5-1）
 */
export const napRecords: NapRecord[] = [
  { nap_record_id: 1, nap_session_id: 1, child_id: 'C001', checked_at: '2026-09-01T13:20:00', saved_at: '2026-09-01T13:20:30', body_position: '1', breathing: '1', complexion: '1', temperature: 36.6, staff_id: 'S003' },
  { nap_record_id: 2, nap_session_id: 1, child_id: 'C002', checked_at: '2026-09-01T13:20:00', saved_at: '2026-09-01T13:20:40', body_position: '4', breathing: '1', complexion: '1', temperature: 36.8, staff_id: 'S003' },
  { nap_record_id: 3, nap_session_id: 1, child_id: 'C004', checked_at: '2026-09-01T13:21:00', saved_at: '2026-09-01T13:21:10', body_position: '1', breathing: '1', complexion: '1', temperature: null, staff_id: 'S003' },
  { nap_record_id: 4, nap_session_id: 1, child_id: 'C005', checked_at: '2026-09-01T13:21:00', saved_at: '2026-09-01T13:21:20', body_position: '3', breathing: '1', complexion: '1', temperature: null, staff_id: 'S003' },
  { nap_record_id: 5, nap_session_id: 1, child_id: 'C006', checked_at: '2026-09-01T13:22:00', saved_at: '2026-09-01T13:22:10', body_position: '1', breathing: '1', complexion: '1', temperature: null, staff_id: 'S003' },
  { nap_record_id: 6, nap_session_id: 1, child_id: 'C007', checked_at: '2026-09-01T13:22:00', saved_at: '2026-09-01T13:22:20', body_position: '2', breathing: '1', complexion: '1', temperature: null, staff_id: 'S003' },
  { nap_record_id: 7, nap_session_id: 1, child_id: 'C009', checked_at: '2026-09-01T13:23:00', saved_at: '2026-09-01T13:23:10', body_position: '1', breathing: '1', complexion: '1', temperature: null, staff_id: 'S004' },
  { nap_record_id: 8, nap_session_id: 1, child_id: 'C010', checked_at: '2026-09-01T13:23:00', saved_at: '2026-09-01T13:23:20', body_position: '4', breathing: '1', complexion: '1', temperature: null, staff_id: 'S004' },
];

/** 異常時の記録（t_nap_abnormal）。diary_id が空ならヒヤリハット未起票（基本設計書 5-6） */
export const napAbnormals: NapAbnormal[] = [
  { nap_abnormal_id: 1, nap_session_id: 3, child_id: 'C003', found_at: '2026-08-30T13:40:00',
    situation: 'うつ伏せの体位で寝ているのを発見。呼吸あり、顔色は通常。',
    response: '仰向けに直し、5分後に再度確認した。保護者へは降園時に口頭で伝えた。', staff_id: 'S004', diary_id: 3 },
  { nap_abnormal_id: 2, nap_session_id: 2, child_id: 'C005', found_at: '2026-08-31T14:10:00',
    situation: '顔色がやや紅潮していた。体温37.4度。',
    response: '別室で休ませ、保護者へ連絡した。', staff_id: 'S003', diary_id: null },
];

/* ============ 連絡帳と、ねた・おきた（詳細設計書「デモデータ」(5-5)） ============
 * Go の server/seed.sql と同じ ID・同じ内容。野原 太郎（C001）の今日は「家庭から」「ねた」「園から」を空けておき、
 * デモで押して見せる。起動した時刻より後の今日の記録は、下の日付ずらしのあとで外す（詳細設計書「未来の出来事を入れない」(5-5)）
 */
function home(id: number, childId: string, date: string, guardianId: string, v: Partial<ContactHomeRecord> & { submitted_at: string }): ContactHomeRecord {
  return {
    contact_home_id: id, child_id: childId, contact_date: date, guardian_id: guardianId,
    temperature: null, night_sleep_from: null, night_sleep_to: null, breakfast: null, mood_label: null,
    pickup_type: null, pickup_person: null, pickup_time: null, message: null,
    confirmed_staff_id: null, confirmed_at: null, revised_at: null,
    created_at: v.submitted_at, updated_at: v.confirmed_at ?? v.submitted_at, ...v,
  };
}
export const contactHomes: ContactHomeRecord[] = [
  home(1, 'C004', '2026-09-01', 'G004', { temperature: 36.5, night_sleep_from: '20:30', night_sleep_to: '06:30', breakfast: '1', mood_label: 'ごきげん', pickup_type: '1',
    message: '朝から絵本を読んでほしいと言っていました。', submitted_at: '2026-09-01T07:40:00', confirmed_staff_id: 'S003', confirmed_at: '2026-09-01T08:52:00' }),
  home(2, 'C005', '2026-09-01', 'G005', { temperature: 36.7, night_sleep_from: '21:00', night_sleep_to: '06:40', breakfast: '2', mood_label: 'ふつう', pickup_type: '2',
    pickup_person: '祖母', pickup_time: '17:00', message: 'きょうは祖母が迎えに行きます。', submitted_at: '2026-09-01T07:45:00' }),
  // 7:35 に送り、7:50 に園が確認したあと、8:05 に送り直した（確認が外れて「更新」）
  home(3, 'C002', '2026-09-01', 'G002', { temperature: 36.9, night_sleep_from: '21:10', night_sleep_to: '06:50', breakfast: '3', mood_label: 'ふつう', pickup_type: '1',
    message: '少し眠そうです。お昼寝のときによろしくお願いします。', submitted_at: '2026-09-01T08:05:00', revised_at: '2026-09-01T08:05:00',
    created_at: '2026-09-01T07:35:00', updated_at: '2026-09-01T08:05:00' }),
  home(4, 'C001', '2026-08-31', 'G001', { temperature: 36.6, breakfast: '1', mood_label: 'ごきげん',
    submitted_at: '2026-08-31T07:42:00', confirmed_staff_id: 'S003', confirmed_at: '2026-08-31T08:50:00' }),
];

function contactEvent(id: number, childId: string, at: string, staffId: string, v: Partial<ContactEventRecord> & Pick<ContactEventRecord, 'event_type'>): ContactEventRecord {
  return {
    contact_event_id: id, child_id: childId, class_id: 1, contact_date: at.slice(0, 10), recorded_at: at,
    meal_kind: null, meal_amount: null, toilet_label: null, temperature: null, body: null, contact_photo_id: null,
    keep_in_growth: false, staff_id: staffId, corrected_at: null, is_deleted: false, created_at: at, updated_at: at, ...v,
  };
}
/** 給食（meal_kind 1）の量 */
const lunch = (amount: '1' | '2' | '3' | '4') => ({ event_type: '1' as const, meal_kind: '1' as const, meal_amount: amount });
export const contactEvents: ContactEventRecord[] = [
  contactEvent(1, 'C001', '2026-09-01T09:40:00', 'S004', { event_type: '2', toilet_label: 'おしっこ' }),
  // 「成長の記録に残す」を付けてある（詳細設計書「デモデータ」(5-5) の成長の記録の行。server/seed.sql と同じ）
  contactEvent(2, 'C001', '2026-09-01T10:15:00', 'S003', { event_type: '4', body: '園庭の砂場で、スコップの型抜きを何度もくり返していました。', keep_in_growth: true }),
  contactEvent(3, 'C001', '2026-09-01T11:40:00', 'S003', lunch('1')),
  contactEvent(4, 'C002', '2026-09-01T11:40:00', 'S003', lunch('1')),
  contactEvent(5, 'C004', '2026-09-01T11:40:00', 'S003', lunch('2')),
  contactEvent(6, 'C005', '2026-09-01T11:40:00', 'S003', lunch('1')),
  contactEvent(7, 'C006', '2026-09-01T11:40:00', 'S003', lunch('3')),
  contactEvent(8, 'C007', '2026-09-01T11:40:00', 'S003', lunch('1')),
  contactEvent(9, 'C009', '2026-09-01T11:40:00', 'S004', lunch('2')),
  contactEvent(10, 'C010', '2026-09-01T11:40:00', 'S004', lunch('1')),
  contactEvent(11, 'C001', '2026-08-31T09:30:00', 'S004', { event_type: '2', toilet_label: 'おしっこ' }),
  contactEvent(12, 'C001', '2026-08-31T11:40:00', 'S003', lunch('1')),
  contactEvent(13, 'C001', '2026-08-31T15:10:00', 'S003', { event_type: '1', meal_kind: '2', meal_amount: '2' }),
];

export const contactClasses: ContactClassRecord[] = [
  { contact_class_id: 1, class_id: 1, contact_date: '2026-09-01', body: '園庭で砂場あそびと、しゃぼん玉をしました。', contact_photo_id: null, source_diary_id: null,
    staff_id: 'S003', recorded_at: '2026-09-01T10:30:00', corrected_at: null, is_deleted: false, created_at: '2026-09-01T10:30:00', updated_at: '2026-09-01T10:30:00' },
];

export const contactFacilities: ContactFacilityRecord[] = [
  { contact_facility_id: 1, child_id: 'C001', class_id: 1, contact_date: '2026-08-31',
    body: 'しゃぼん玉を追いかけて、園庭をたくさん走っていました。給食はぜんぶ食べて、おひるねは1時間30分でした。',
    staff_id: 'S003', recorded_at: '2026-08-31T17:05:00', corrected_at: null, is_deleted: false, created_at: '2026-08-31T17:05:00', updated_at: '2026-08-31T17:05:00' },
];

export const contactReads: ContactReadRecord[] = [
  { child_id: 'C001', contact_date: '2026-08-31', account_id: 6, read_at: '2026-08-31T20:10:00' },
];

/**
 * 連絡帳の写真（t_contact_photo）と写っている子（t_contact_photo_child）。デモデータには入れない
 * （詳細設計書「デモデータ」(5-5 (1))、決めたこと D-22。実在の子の写真を使わない。server/seed.sql にも入れていない）
 */
export const contactPhotos: ContactPhotoRecord[] = [];
export const contactPhotoChildren: ContactPhotoChildRecord[] = [];

function sleep(id: number, sessionId: number, childId: string, at: string, staffId: string, woke?: { at: string; staff: string }): NapSleepRecord {
  return {
    nap_sleep_id: id, nap_session_id: sessionId, child_id: childId, slept_at: at, woke_at: woke?.at ?? null, sleep_temperature: null,
    slept_staff_id: staffId, woke_staff_id: woke?.staff ?? null, corrected_at: null, is_deleted: false, created_at: at, updated_at: woke?.at ?? at,
  };
}
/**
 * 今日の実施 1（さくら組）は C001 を空けておく（デモ②）。昨日の実施 2 は C001 が 13:02〜14:35。
 * 昨日の C001 には入眠時の体温（監査の層）を入れ、午睡記録検索と CSV のねたの行に出す
 * （画面詳細図「午睡記録検索画面」(5-3) の項目6・9。server/seed.sql と同じ）
 */
export const napSleeps: NapSleepRecord[] = [
  sleep(1, 1, 'C002', '2026-09-01T13:05:00', 'S003'),
  sleep(2, 1, 'C004', '2026-09-01T13:08:00', 'S003'),
  sleep(3, 1, 'C005', '2026-09-01T13:10:00', 'S003'),
  sleep(4, 1, 'C006', '2026-09-01T13:06:00', 'S003'),
  sleep(5, 1, 'C007', '2026-09-01T13:12:00', 'S004'),
  sleep(6, 1, 'C009', '2026-09-01T13:05:00', 'S004'),
  sleep(7, 1, 'C010', '2026-09-01T13:07:00', 'S004'),
  { ...sleep(8, 2, 'C001', '2026-08-31T13:02:00', 'S003', { at: '2026-08-31T14:35:00', staff: 'S003' }), sleep_temperature: 36.5 },
];

/** 今日の実施 1 で C003 は欠席（ダッシュボードの「園から未送信」から外れることを見せる） */
export const napExclusions: NapExclusionRecord[] = [
  { nap_exclusion_id: 1, nap_session_id: 1, child_id: 'C003', reason: '1', staff_id: 'S003', is_deleted: false, created_at: '2026-09-01T13:01:00' },
];

/* ============ 園からのひとことと他児の名前（詳細設計書「デモデータ」(5-5 (2))。server/seed.sql と同じ） ============ */

/*
 * 呼び名（m_child.nickname）は、園児の行（上の child() の demoNicknames）に持つ。
 * 園児の応答（Child）には職員にだけ入れ、保護者へは返さない（インタフェース一覧「Child」。mock.ts の childForGuardian）
 */

/**
 * 定型文（m_phrase）。server/seed.sql と server/db_contact.go の defaultPhrases と同じ順・同じ文。
 * 健康や発達の評価の言葉（「元気に」「順調に」など）を入れない（原則1）。4:日誌は server/api_diary.go の fixedPhrases の5つから、
 * 保護者に向けた「ご家庭でも様子を見ていただけますと幸いです。」を除いた4つ（日誌は園内の記録。詳細設計書「デモデータ」(5-5) 第1.3版）
 */
export const phrases: PhraseRecord[] = ([
  ['1', '今日も一日ありがとうございました。'],
  ['1', 'お迎えのときに、くわしくお話しします。'],
  ['1', 'おうちでも、今日のことを聞いてみてください。'],
  ['1', '明日もよろしくお願いします。'],
  ['2', '園庭で遊びました。'],
  ['2', '絵本を読みました。'],
  ['2', '手洗いを自分でしようとしていました。'],
  ['3', '今日は園庭で遊びました。'],
  ['3', '今日はお散歩に出かけました。'],
  ['3', '今日は室内で製作をしました。'],
  ['4', 'よく食べ、おかわりをしていました。'],
  ['4', '午睡は落ち着いて入眠できました。'],
  ['4', '園庭で友だちと関わって遊ぶ姿が見られました。'],
  ['4', '鼻水が出ていたため、こまめに拭き取りました。'],
] as const).map(([scope, body], i, all) => ({
  phrase_id: i + 1, phrase_scope: scope, body,
  display_order: all.slice(0, i + 1).filter(([x]) => x === scope).length,
  is_deleted: false, updated_staff_id: 'S001', created_at: '2026-04-01T09:00:00', updated_at: '2026-04-01T09:00:00',
}));

/* ============ 発達チェック（基本設計書 5-7） ============
 * 発達過程区分はマスタ化して指針改定に追従する。区分の粒度は
 * 0歳児~2歳児までの機能発達について.md「発達区分一覧」に合わせた
 */
export const developmentCategories: DevelopmentCategory[] = [
  { development_category_id: 1,  age_month_from: 0,  age_month_to: 1,  category_name: '新生児〜56日頃',        display_order: 1 },
  { development_category_id: 2,  age_month_from: 2,  age_month_to: 2,  category_name: '56日頃〜3か月頃',       display_order: 2 },
  { development_category_id: 3,  age_month_from: 3,  age_month_to: 5,  category_name: '3か月頃〜6か月頃',      display_order: 3 },
  { development_category_id: 4,  age_month_from: 6,  age_month_to: 8,  category_name: '6か月頃〜9か月頃',      display_order: 4 },
  { development_category_id: 5,  age_month_from: 9,  age_month_to: 11, category_name: '9か月頃〜12か月頃',     display_order: 5 },
  { development_category_id: 6,  age_month_from: 12, age_month_to: 14, category_name: '1歳頃〜1歳3か月頃',     display_order: 6 },
  { development_category_id: 7,  age_month_from: 15, age_month_to: 17, category_name: '1歳3か月頃〜1歳6か月頃', display_order: 7 },
  { development_category_id: 8,  age_month_from: 18, age_month_to: 20, category_name: '1歳6か月頃〜1歳9か月頃', display_order: 8 },
  { development_category_id: 9,  age_month_from: 21, age_month_to: 23, category_name: '1歳9か月頃〜2歳頃',     display_order: 9 },
  { development_category_id: 10, age_month_from: 24, age_month_to: 29, category_name: '2歳頃〜2歳6か月頃',     display_order: 10 },
  { development_category_id: 11, age_month_from: 30, age_month_to: 35, category_name: '2歳6か月頃〜3歳頃',     display_order: 11 },
];

function devItem(id: number, cat: number, domain: string, name: string, order: number): DevelopmentItem {
  return { development_item_id: id, development_category_id: cat, item_name: name, domain, display_order: order };
}

export const developmentItems: DevelopmentItem[] = [
  // 新生児〜56日頃
  devItem(101, 1, '運動', '仰向けで手足を動かす', 1),
  devItem(102, 1, '人との関わり', 'あやされると泣きやむ', 2),
  devItem(103, 1, '生活', '授乳・睡眠のリズムがある', 3),
  // 56日頃〜3か月頃
  devItem(111, 2, '運動', '首がすわり始める', 1),
  devItem(112, 2, 'ことば', '声を出して笑う', 2),
  devItem(113, 2, '人との関わり', '音のする方へ顔を向ける', 3),
  // 3か月頃〜6か月頃
  devItem(121, 3, '運動', '腹ばいで上体を持ち上げる', 1),
  devItem(122, 3, '運動', '目と手を協応させて物をつかむ', 2),
  devItem(123, 3, '生活', '準備食を口にする', 3),
  // 6か月頃〜9か月頃
  devItem(131, 4, '運動', '寝返りをする', 1),
  devItem(132, 4, '運動', 'お座りの姿勢を保つ', 2),
  devItem(133, 4, '人との関わり', '人まねをする', 3),
  devItem(134, 4, '人との関わり', '後追いをする', 4),
  // 9か月頃〜12か月頃
  devItem(141, 5, '運動', 'つかまり立ちをする', 1),
  devItem(142, 5, '運動', '伝い歩きをする', 2),
  devItem(143, 5, 'ことば', '「パパ」「ママ」などの語を発する', 3),
  devItem(144, 5, '生活', '自分でやりたい気持ちを見せる', 4),
];

developmentItems.push(
  // 1歳頃〜1歳3か月頃
  devItem(151, 6, '運動', 'ひとりで歩く', 1),
  devItem(152, 6, 'ことば', '簡単な言葉と動作が一致する', 2),
  devItem(153, 6, '生活', 'スプーンで食べようとする', 3),
  // 1歳3か月頃〜1歳6か月頃
  devItem(161, 7, '運動', '歩行が安定する', 1),
  devItem(162, 7, '運動', '階段をはう', 2),
  devItem(163, 7, 'ことば', '指差しで要求を伝える', 3),
  devItem(164, 7, 'ことば', '意味のある語を話す', 4),
  devItem(165, 7, '人との関わり', '探索活動が活発になる', 5),
  // 1歳6か月頃〜1歳9か月頃
  devItem(171, 8, 'ことば', '発語が増える', 1),
  devItem(172, 8, 'ことば', '簡単な指示を理解する', 2),
  devItem(173, 8, '生活', '片付けようとする', 3),
  devItem(174, 8, '人との関わり', '友だちと物のやりとりが生じる', 4),
  // 1歳9か月頃〜2歳頃
  devItem(181, 9, 'ことば', '二語文を話す', 1),
  devItem(182, 9, '人との関わり', '自我の芽生えが見られる', 2),
  devItem(183, 9, '生活', '身の回りのことを自分でやろうとする', 3),
  // 2歳頃〜2歳6か月頃
  devItem(191, 10, '人との関わり', '見立て遊び・ごっこ遊びをする', 1),
  devItem(192, 10, '生活', '自分でやりたがる気持ちが強まる', 2),
  devItem(193, 10, '運動', '両足でジャンプする', 3),
  // 2歳6か月頃〜3歳頃
  devItem(201, 11, 'ことば', '色・大小・長短を区別する', 1),
  devItem(202, 11, 'ことば', '二語文を超えた会話をする', 2),
  devItem(203, 11, '人との関わり', '平行遊びの中で友だちとやりとりする', 3),
  devItem(204, 11, '生活', '排せつの自立が進む', 4),
);

/** 推奨頻度（m_development_frequency）。値は仮置き（web/仮置き値.md 参照） */
export const developmentFrequencies: DevelopmentFrequency[] = [
  { development_frequency_id: 1, age_month_from: 0,  age_month_to: 11, interval_days: 90 },
  { development_frequency_id: 2, age_month_from: 12, age_month_to: 35, interval_days: 120 },
  { development_frequency_id: 3, age_month_from: 36, age_month_to: 72, interval_days: 180 },
];

/** 項目単位の共有可否（m_share_setting）。既定は共有可とし、園が項目単位で落とす */
export const shareSettings: ShareSetting[] = developmentItems.map((it, i) => ({
  share_setting_id: i + 1,
  development_item_id: it.development_item_id,
  // 自我の芽生え・かんしゃく等、保護者の受け取り方に配慮が要る項目を園が落とした例
  is_shareable: ![182, 192].includes(it.development_item_id),
  updated_staff_id: 'S001',
  updated_at: '2026-04-01T09:00:00',
}));

/** 園児単位の予定（t_development_schedule）。is_manual_override は園児単位の手動上書き */
export const developmentSchedules: DevelopmentSchedule[] = [
  { development_schedule_id: 1, child_id: 'C001', scheduled_on: '2026-09-01', is_manual_override: false, created_staff_id: 'S001' },
  { development_schedule_id: 2, child_id: 'C002', scheduled_on: '2026-08-20', is_manual_override: false, created_staff_id: 'S001' },
  { development_schedule_id: 3, child_id: 'C003', scheduled_on: '2026-08-25', is_manual_override: false, created_staff_id: 'S001' },
  { development_schedule_id: 4, child_id: 'C004', scheduled_on: '2026-09-10', is_manual_override: false, created_staff_id: 'S001' },
  { development_schedule_id: 5, child_id: 'C005', scheduled_on: '2026-09-05', is_manual_override: true,  created_staff_id: 'S001' },
  { development_schedule_id: 6, child_id: 'C006', scheduled_on: '2026-08-28', is_manual_override: false, created_staff_id: 'S001' },
  { development_schedule_id: 7, child_id: 'C007', scheduled_on: '2026-09-20', is_manual_override: false, created_staff_id: 'S001' },
  { development_schedule_id: 8, child_id: 'C008', scheduled_on: '2026-09-15', is_manual_override: false, created_staff_id: 'S001' },
];

/**
 * 発達チェック（t_development_check）
 *
 * 結果は、実施日の月齢の区分の項目で入れる（基本設計書「月齢の算出」(4-8)。基準日は実施日）。
 * 末尾の日付ずらしは生年月日と実施日を同じ日数だけ動かすが、月の長さの違いで応当日基準の月齢が 1 か月ずれることがある。
 * 区分の境目（誕生日のちょうど 1 年後など）に置くと隣の区分へ移り、一覧に「未入力」が出るため、境目から離して置く
 * （GitHub Issue #143・#164。もとの 2026-06-01 は 1歳0か月ちょうどで、結果の区分と合っていなかった）。
 * サーバ側（server/seed.sql）も同じ
 */
export const developmentChecks: DevelopmentCheck[] = [
  // 成長の記録（詳細設計書「デモデータ」(5-5)）：野原 太郎の確定に、確定した日時と保護者へのひとこと（評価の言葉を入れない）。
  // ほかの確定は「いまのデータの移し方」と同じく実施日の 00:00 を確定した日時とした（server/seed.sql と同じ）
  // 【仮置き】野原 太郎のひとことは、確定した日のうちに担任が書き換えたものとして「訂正しました（日付）」の印を置く
  // （決めたこと D-51。PR #216 で決まった設計。web/仮置き値.md。server/seed.sql と同じ）
  { development_check_id: 1, child_id: 'C001', development_schedule_id: null, checked_on: '2026-05-15', status: '2', staff_id: 'S003', share_status: '2',
    guardian_message: 'ボールを転がすと、追いかけて両手でつかもうとしていました。', finalized_at: '2026-05-15T16:00:00',
    guardian_message_corrected_at: '2026-05-15T17:30:00' },
  { development_check_id: 2, child_id: 'C002', development_schedule_id: null, checked_on: '2026-05-10', status: '2', staff_id: 'S003', share_status: '2',
    finalized_at: '2026-05-10T00:00:00' },
  { development_check_id: 3, child_id: 'C004', development_schedule_id: null, checked_on: '2026-06-05', status: '2', staff_id: 'S004', share_status: '1',
    finalized_at: '2026-06-05T00:00:00' },
];

/**
 * 発達チェックの結果（t_development_result）
 * 「未入力」はレコードが存在しない状態で表す。「未確認」は result='3' として保持する（基本設計書 5-7）
 */
export const developmentResults: DevelopmentResultRecord[] = [
  // C001 の前回（2026-05-15・0歳11か月）。9か月頃〜12か月頃の区分
  { development_result_id: 1, development_check_id: 1, development_item_id: 141, result: '1', note: null },
  { development_result_id: 2, development_check_id: 1, development_item_id: 142, result: '1', note: null },
  { development_result_id: 3, development_check_id: 1, development_item_id: 143, result: '3', note: null },
  { development_result_id: 4, development_check_id: 1, development_item_id: 144, result: '2', note: null },
  // C002 の前回（2026-05-10・1歳1か月）。1歳頃〜1歳3か月頃の区分
  { development_result_id: 5, development_check_id: 2, development_item_id: 151, result: '1', note: null },
  { development_result_id: 6, development_check_id: 2, development_item_id: 152, result: '2', note: null },
  { development_result_id: 7, development_check_id: 2, development_item_id: 153, result: '1', note: null },
  // C004 の前回（2026-06-05・1歳1か月）。1歳頃〜1歳3か月頃の区分
  { development_result_id: 8, development_check_id: 3, development_item_id: 151, result: '1', note: null },
  { development_result_id: 9, development_check_id: 3, development_item_id: 152, result: '1', note: '絵本を指差して名前を言う場面があった' },
  { development_result_id: 10, development_check_id: 3, development_item_id: 153, result: '3', note: null },
];

/* ============ 身体測定（基本設計書 5-7） ============ */
export const physicalRecords: PhysicalRecord[] = [
  { physical_record_id: 1, child_id: 'C001', measured_on: '2026-03-02', height_cm: 73.4, weight_kg: 8.9, staff_id: 'S003', share_status: '2', is_deleted: false, created_at: '2026-03-02T10:00:00', updated_at: '2026-03-02T10:00:00' },
  { physical_record_id: 2, child_id: 'C001', measured_on: '2026-06-01', height_cm: 77.2, weight_kg: 9.5, staff_id: 'S003', share_status: '2', is_deleted: false, created_at: '2026-06-01T10:00:00', updated_at: '2026-06-01T10:00:00' },
  { physical_record_id: 3, child_id: 'C002', measured_on: '2026-03-02', height_cm: 76.1, weight_kg: 9.2, staff_id: 'S003', share_status: '2', is_deleted: false, created_at: '2026-03-02T10:05:00', updated_at: '2026-03-02T10:05:00' },
  { physical_record_id: 4, child_id: 'C002', measured_on: '2026-06-01', height_cm: 79.8, weight_kg: 9.9, staff_id: 'S003', share_status: '1', is_deleted: false, created_at: '2026-06-01T10:05:00', updated_at: '2026-06-01T10:05:00' },
  { physical_record_id: 5, child_id: 'C003', measured_on: '2026-06-01', height_cm: 76.5, weight_kg: 9.1, staff_id: 'S004', share_status: '1', is_deleted: false, created_at: '2026-06-01T10:10:00', updated_at: '2026-06-01T10:10:00' },
  { physical_record_id: 6, child_id: 'C004', measured_on: '2026-06-01', height_cm: 78.0, weight_kg: 9.6, staff_id: 'S004', share_status: '1', is_deleted: false, created_at: '2026-06-01T10:15:00', updated_at: '2026-06-01T10:15:00' },
  { physical_record_id: 7, child_id: 'C001', measured_on: '2026-09-01', height_cm: 78.5, weight_kg: 9.8, staff_id: 'S003', share_status: '1', is_deleted: false, created_at: '2026-09-01T10:00:00', updated_at: '2026-09-01T10:00:00' },
  { physical_record_id: 8, child_id: 'C002', measured_on: '2026-09-01', height_cm: 81.2, weight_kg: 10.3, staff_id: 'S003', share_status: '1', is_deleted: false, created_at: '2026-09-01T10:05:00', updated_at: '2026-09-01T10:05:00' },
  { physical_record_id: 9, child_id: 'C006', measured_on: '2026-09-01', height_cm: 82.0, weight_kg: 10.6, staff_id: 'S003', share_status: '1', is_deleted: false, created_at: '2026-09-01T10:20:00', updated_at: '2026-09-01T10:20:00' },
];

/* ============ 成長曲線基準値（m_growth_standard） ============
 *
 * 厚生労働省「平成22年乳幼児身体発育調査」の公表値を入れる（GitHub Issue #69）。
 * 値と、月齢への当て方は growthStandard2010.ts にある。サーバ側（server/db.go）と同じ規則で作る。
 * 一意制約：sex + age_in_months + measure_type + percentile（基本設計書 5-7）
 */
function roundTo(v: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(v * scale) / scale;
}

function buildGrowthStandards(): GrowthStandard[] {
  const rows: GrowthStandard[] = [];
  let id = 1;
  const source = (interpolated: boolean) => (interpolated ? GROWTH_SOURCE_2010_INTERPOLATED : GROWTH_SOURCE_2010);
  for (const sex of ['1', '2'] as const) {
    for (let m = 0; m <= 72; m++) {
      GROWTH_PERCENTILES.forEach((p, pi) => {
        // 公表値は、身長が小数第1位、体重が小数第2位まで
        const h = growthValue2010(HEIGHT_CLASSES_2010, sex, m, pi);
        const w = growthValue2010(WEIGHT_CLASSES_2010, sex, m, pi);
        rows.push({
          growth_standard_id: id++, sex, age_in_months: m, measure_type: '1', percentile: p,
          standard_value: roundTo(h.value, 1), source_version: source(h.interpolated),
        });
        rows.push({
          growth_standard_id: id++, sex, age_in_months: m, measure_type: '2', percentile: p,
          standard_value: roundTo(w.value, 2), source_version: source(w.interpolated),
        });
      });
    }
  }
  return rows;
}

export const growthStandards: GrowthStandard[] = buildGrowthStandards();

/* ============ 操作ログ（t_operation_log） ============
 * 追記のみとし、更新・削除の手段を設けない（基本設計書 5-8）
 */
export const operationLogs: OperationLog[] = [
  { operation_log_id: 1, account_id: 3, operated_at: '2026-09-01T16:40:00', function_type: '1', operation_type: '1', target_table: 't_diary', target_id: 1, target_child_id: 'C001', before_value: null, after_value: '下書き作成' },
  { operation_log_id: 2, account_id: 3, operated_at: '2026-09-01T13:20:30', function_type: '3', operation_type: '1', target_table: 't_nap_record', target_id: 1, target_child_id: 'C001', before_value: null, after_value: '体位=仰向け 呼吸=あり 顔色=通常 体温=36.6' },
  { operation_log_id: 3, account_id: 1, operated_at: '2026-08-31T09:10:00', function_type: '1', operation_type: '3', target_table: 't_diary', target_id: 3, target_child_id: 'C003', before_value: '申請中', after_value: '差し戻し' },
  { operation_log_id: 4, account_id: 1, operated_at: '2026-08-29T18:05:00', function_type: '1', operation_type: '3', target_table: 't_diary', target_id: 4, target_child_id: 'C002', before_value: '申請中', after_value: '承認済み' },
  { operation_log_id: 5, account_id: 3, operated_at: '2026-09-01T10:00:00', function_type: '5', operation_type: '1', target_table: 't_physical_record', target_id: 7, target_child_id: 'C001', before_value: null, after_value: '身長=78.5 体重=9.8' },
  { operation_log_id: 6, account_id: 1, operated_at: '2026-08-25T10:00:00', function_type: '7', operation_type: '1', target_table: 't_invitation_code', target_id: 1, target_child_id: 'C001', before_value: null, after_value: '招待コードを発行' },
  { operation_log_id: 7, account_id: 1, operated_at: '2026-08-20T10:00:00', function_type: '7', operation_type: '2', target_table: 'm_account', target_id: 8, target_child_id: null, before_value: '有効', after_value: '停止' },
  { operation_log_id: 8, account_id: 2, operated_at: '2026-08-18T11:30:00', function_type: '5', operation_type: '5', target_table: 't_physical_record', target_id: null, target_child_id: 'C002', before_value: null, after_value: 'PDF出力（保護者引き渡し）' },
  { operation_log_id: 9, account_id: 3, operated_at: '2026-08-27T16:15:00', function_type: '2', operation_type: '4', target_table: 't_chat_message', target_id: 10, target_child_id: 'C002', before_value: '（本文）', after_value: '取消' },
  { operation_log_id: 10, account_id: 4, operated_at: '2026-08-30T18:00:00', function_type: '1', operation_type: '1', target_table: 't_diary', target_id: 3, target_child_id: 'C003', before_value: null, after_value: 'ヒヤリハットを起票' },
];

/* ============ 設定マスタ（m_setting） ============
 * 値はすべて仮置きである（web/仮置き値.md 参照）。
 * 設定値が数値として解釈できない場合は既定値へフォールバックし、警告を出す（基本設計書 5-8）
 */
function setting(key: string, value: string, description: string): Setting {
  return { setting_key: key, setting_value: value, description, updated_staff_id: 'S001', updated_at: '2026-04-01T09:00:00' };
}

export const settings: Setting[] = [
  // 園の基本情報。電話番号は保護者向けの緊急連絡の案内に出す（基本設計書「設定マスタ」(5-8)）
  setting('facility.name', 'すくすく保育園', '園の名称'),
  setting('facility.phone_number', '03-0000-0000', '園の電話番号（保護者向けの緊急連絡の案内に出す）'),
  // 午睡チェック
  setting('nap.interval_minutes.age0', '5',  '午睡チェックの間隔（0歳児・分）'),
  setting('nap.interval_minutes.age1', '10', '午睡チェックの間隔（1歳児・分）'),
  setting('nap.interval_minutes.age2', '15', '午睡チェックの間隔（2歳児以上・分）'),
  setting('nap.temperature_required_at_start', 'true', '午睡開始時に体温を必須とするか'),
  setting('nap.time_range', '13:00-15:00', '午睡の時間帯'),
  // 認証
  setting('auth.max_failed_login', '5',  'ログイン失敗回数の上限'),
  setting('auth.lock_minutes', '30', 'ロックの待機時間（分）'),
  setting('auth.remember_days', '30', 'ログイン情報の記憶の保存期間（日）'),
  setting('auth.temp_password_hours', '48', '一時パスワードの有効期限（時間）'),
  // 画面
  setting('ui.auto_logout_minutes', '30', '自動ログアウトまでの無操作時間（分）'),
  setting('ui.diary_lock_minutes', '15', '編集ロックの無操作時間（分）'),
  // 参照範囲
  setting('scope.handover_grace_days', '14', '引き継ぎ猶予期間（日）'),
  setting('scope.fiscal_year_update_date', '04-01', '年度更新の実行日'),
  // 身体測定
  setting('physical.measure_months', '4,8,12', '測定を行う月'),
  setting('physical.height_min', '40', '身長の下限（cm）'),
  setting('physical.height_max', '140', '身長の上限（cm）'),
  setting('physical.weight_min', '2', '体重の下限（kg）'),
  setting('physical.weight_max', '40', '体重の上限（kg）'),
  // 添付
  setting('attachment.allowed_types', 'image/jpeg,image/png', '添付の対応形式'),
  setting('attachment.max_size_mb', '10', '1ファイルあたりの上限サイズ（MB）'),
  setting('handout.allowed_types', 'application/pdf,image/jpeg,image/png', '配布物の対応形式'),
  setting('attachment.max_count_diary', '3', '日誌1件あたりの写真の上限枚数'),
  // データ保持
  setting('retention.record_years', '5', '記録の保持年数'),
  setting('retention.attachment_years', '3', '添付ファイルの保持期間（年）'),
  // 一覧のページング（基本設計書「一覧表示とページング」(3-7)）
  setting('paging.diary_per_page', '50', '日誌一覧の既定件数'),
  setting('paging.nap_search_per_page', '50', '午睡記録検索の既定件数'),
  setting('paging.operation_log_per_page', '100', '操作ログの既定件数'),
  setting('paging.physical_history_count', '12', '過去測定値一覧の既定表示件数'),
  // 連絡帳・通知・AI（基本設計書「設定マスタ」(5-9)、詳細設計書「デモデータ」(5-5)。server/seed.sql と同じ）
  setting('contact.show_items', 'nap,meal,toilet,temperature,comment,photo,class', '保護者へ出すきょうのようすの項目'),
  setting('contact.home_items', 'temperature,night_sleep,breakfast,mood,pickup,message', '「家庭から」の入力欄に出す項目'),
  setting('contact.toilet_choices', 'おしっこ,うんち,おむつ交換,トイレでできた', '排せつの選択肢'),
  setting('contact.mood_choices', 'ごきげん,ふつう,ごきげんななめ', '「家庭から」のきげんの選択肢'),
  setting('push.quiet_hours', '21:00-07:00', '通知を送らない時間帯'),
  setting('ai.enabled', '0', '文章の下書き（AI）を使うか'),
  setting('ai.daily_limit', '300', 'AI の下書きの1日の上限回数'),
  setting('scope.guardian_grace_days', '30', '保護者の猶予期間（日）'),
  setting('nap.temperature_required', '入眠時', '午睡で体温を求める時点'),
  setting('growth.share_physical', '1', '身体測定を成長の記録に出すか'),
  setting('retention.contact_years', '5', '連絡帳の保持年数（要決定。決まるまでは記録の保持年数と同じ）'),
];

/**
 * 同意履歴（t_terms_agreement）。追記のみとし、更新・削除の手段を設けない
 *
 * デモデータは、アカウントが持つ「同意した版と日時」から起こす
 * （サーバ側は server/db.go の ensureTermsAgreement が同じことをする）。
 */
export const termsAgreements: TermsAgreement[] = accounts
  .filter((a) => a.terms_version !== null && a.terms_agreed_at !== null)
  .map((a, i) => ({
    terms_agreement_id: i + 1,
    account_id: a.account_id,
    terms_id: termsDocs.find((t) => t.terms_version === a.terms_version && t.document_type === '1')?.terms_id ?? 0,
    agreed_at: a.terms_agreed_at!,
  }))
  .filter((x) => x.terms_id !== 0);

/* ============ デモデータの日付を起動日に合わせる ============
 *
 * 上のデモデータは DEMO_TODAY（2026-09-01）を「今日」として組み立ててある。
 * そのまま日が経つと、実施中の午睡や今日の日誌が今日のものでなくなり、
 * 画面が正しく描画されない（GitHub Issue #66）。
 *
 * 日付をひとつずつ相対で書き直すのではなく、基準日と起動日の差だけまとめて
 * ずらす。記録どうしの前後関係（昨日・3日前）がそのまま保たれるため。
 * サーバ側（server/seed_shift.go）も同じ扱いにしてある。片方だけ直すと食い違う。
 *
 * ずらすのは記録だけである。年度の開始日などの絶対の日付は動かしてはならない。
 * マスタの配列は下の対象に含めず、記録の中に混ざる birth_date は名前で除外する。
 * ただしマスタにあっても、デモの「今日」から決めた値（一時パスワードの有効期限・園児の生年月日）は、
 * 下で明示的にずらす。
 */

/** ずらしの対象から外す項目名。記録の中に混ざる生年月日は動かさない（園児の生年月日は、下で園児の配列をずらす） */
const SHIFT_EXCLUDED_KEYS = new Set(['birth_date']);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function daysBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split('-').map(Number);
  const [ty, tm, td] = toISO.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

function shiftValue(value: string, days: number): string {
  const datePart = value.slice(0, 10);
  const [y, m, d] = datePart.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const p = (n: number) => String(n).padStart(2, '0');
  const iso = `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}`;
  return value.length === 10 ? iso : iso + value.slice(10);
}

function shiftRows(rows: Record<string, unknown>[], days: number): void {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (SHIFT_EXCLUDED_KEYS.has(key)) continue;
      const v = row[key];
      if (typeof v !== 'string') continue;
      if (!DATE_ONLY.test(v) && !DATE_TIME.test(v)) continue;
      row[key] = shiftValue(v, days);
    }
  }
}

{
  const offset = daysBetween(DEMO_TODAY, today());
  if (offset !== 0) {
    // 記録の配列だけを対象にする。マスタ（children・classes など）は含めない
    const recordSets: Record<string, unknown>[][] = [
      invitationCodes as unknown as Record<string, unknown>[],
      guardianChildren as unknown as Record<string, unknown>[],
      termsAgreements as unknown as Record<string, unknown>[],
      diaries as unknown as Record<string, unknown>[],
      diaryLocks as unknown as Record<string, unknown>[],
      chatMembers as unknown as Record<string, unknown>[],
      chatMessages as unknown as Record<string, unknown>[],
      chatReads as unknown as Record<string, unknown>[],
      misdeliveryRecords as unknown as Record<string, unknown>[],
      napSessions as unknown as Record<string, unknown>[],
      napRecords as unknown as Record<string, unknown>[],
      napAbnormals as unknown as Record<string, unknown>[],
      developmentSchedules as unknown as Record<string, unknown>[],
      developmentChecks as unknown as Record<string, unknown>[],
      developmentResults as unknown as Record<string, unknown>[],
      physicalRecords as unknown as Record<string, unknown>[],
      operationLogs as unknown as Record<string, unknown>[],
      contactHomes as unknown as Record<string, unknown>[],
      contactEvents as unknown as Record<string, unknown>[],
      contactClasses as unknown as Record<string, unknown>[],
      contactFacilities as unknown as Record<string, unknown>[],
      contactReads as unknown as Record<string, unknown>[],
      napSleeps as unknown as Record<string, unknown>[],
      napExclusions as unknown as Record<string, unknown>[],
    ];
    for (const rows of recordSets) shiftRows(rows, offset);

    /*
     * 一時パスワードの有効期限はマスタ（accounts）にあるが、デモの「今日」から 48 時間として決めた日時なので、
     * あわせてずらす。ずらさないと、デモの 宮城 蓮 は起動した日によって期限切れになり、一時パスワードでの
     * ログインを見せられない（GitHub Issue #159。サーバ側は server/seed_shift.go の seedShiftMasterColumns）
     */
    for (const a of accounts) {
      if (a.temp_password_expires_at) a.temp_password_expires_at = shiftValue(a.temp_password_expires_at, offset);
    }

    /*
     * 園児の生年月日も、デモの「今日」に何か月の子かを決めて入れてある。記録と同じ日数だけずらし、
     * 起動した日にもデモの園児の月齢（今日の時点・実施日の時点・測定日の時点）を保つ。ずらさないと、実施日だけが動いて
     * 上園 花子・宮城 美咲の前回の発達チェックが別の発達過程区分になり、一覧に「未入力 5 件」と出る（GitHub Issue #164）。
     * 日付をずらすので、月末生まれ（小林 結衣）は起動した日によって月末でなくなる。
     * サーバ側は server/seed_shift.go の seedShiftMasterColumns
     */
    for (const c of children) c.birth_date = shiftValue(c.birth_date, offset);
  }
  trimFutureDemoContacts();
}

/**
 * 今日のページで、起動した時刻より後の連絡帳の記録を入れない（詳細設計書「未来の出来事を入れない」(5-5)、決めたこと D-8）。
 * 朝に起動すると、まだ起きていない給食やおひるねが保護者の画面に出るため。Go は server/db_contact.go の trimFutureDemoContacts。
 * 既存の午睡の実施と5分ごとの確認にはかけない（今までどおり）
 */
function trimFutureDemoContacts(): void {
  const day = today();
  const at = now();
  const future = (v: string | null) => v !== null && v.slice(0, 10) === day && v > at;
  const drop = <T,>(rows: T[], when: (r: T) => boolean) => {
    for (let i = rows.length - 1; i >= 0; i--) if (when(rows[i])) rows.splice(i, 1);
  };
  drop(contactEvents, (r) => r.contact_date === day && future(r.recorded_at));
  drop(contactClasses, (r) => r.contact_date === day && future(r.recorded_at));
  drop(contactFacilities, (r) => r.contact_date === day && future(r.recorded_at));
  drop(contactHomes, (r) => r.contact_date === day && future(r.submitted_at));
  for (const h of contactHomes) {
    if (future(h.confirmed_at)) { h.confirmed_at = null; h.confirmed_staff_id = null; }
    if (future(h.revised_at)) h.revised_at = null;
  }
  drop(napSleeps, (r) => future(r.slept_at));
  for (const s of napSleeps) if (future(s.woke_at)) { s.woke_at = null; s.woke_staff_id = null; }
  drop(napExclusions, (r) => future(r.created_at));
}

/* ============ 配布物（t_handout） ============
 *
 * 園だより・献立表など、保護者があとから見返すもの（基本設計書「配布物（t_handout）」(5-5)）。
 * 対象の月は起動した日から決める（今月と先月）。固定の月で持つと、日が経ったときに
 * 「今月の献立表」が今月のものでなくなるため。上の日付ずらしの対象には含めない。
 * サーバ側（server/db.go の seedHandouts）も同じ内容にしてある。
 */
function buildHandouts(): Handout[] {
  const [y, m] = today().split('-').map(Number);
  const thisMonth = `${y}-${String(m).padStart(2, '0')}`;
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const prevMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  const label = (ym: string) => `${Number(ym.slice(5))}月`;
  const row = (
    id: number, type: Handout['handout_type'], title: string, month: string, classId: number | null,
    name: string, mime: string, size: number, day: number,
  ): Handout => ({
    handout_id: id, handout_type: type, title, target_month: month, class_id: classId,
    file_name: name, file_type: mime, file_size: size,
    posted_staff_id: 'S001', posted_at: `${month}-${String(day).padStart(2, '0')}T16:30:00`, is_deleted: false,
  });
  return [
    row(1, '1', `${label(prevMonth)}の園だより`, prevMonth, null, `endayori-${prevMonth}.pdf`, 'application/pdf', 512340, 1),
    row(2, '2', `${label(prevMonth)}の献立表`, prevMonth, null, `kondate-${prevMonth}.pdf`, 'application/pdf', 238100, 1),
    row(3, '1', `${label(thisMonth)}の園だより`, thisMonth, null, `endayori-${thisMonth}.pdf`, 'application/pdf', 498200, 1),
    row(4, '2', `${label(thisMonth)}の献立表`, thisMonth, null, `kondate-${thisMonth}.pdf`, 'application/pdf', 241870, 1),
    row(5, '3', '運動会のご案内', thisMonth, null, 'undokai.pdf', 'application/pdf', 301455, 2),
    row(6, '4', `さくら組 ${label(thisMonth)}のクラスだより`, thisMonth, 1, `sakura-${thisMonth}.png`, 'image/png', 1204880, 3),
  ];
}
export const handouts: Handout[] = buildHandouts();
