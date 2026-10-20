/*
 * 型定義
 * 典拠：基本設計書.md「データベース設計」(5)
 *
 * 物理名・区分値は同章の定義に合わせる。設計側で言い換えない。
 * 区分値は CHAR(1) の数字コードだが、TypeScript 側では文字列リテラル型で表現する。
 */

/* ---- 区分値（基本設計書 5章の各表の備考） ---- */

/** ロール 1:管理者 2:一般 3:保護者（m_account.role） */
export type Role = '1' | '2' | '3';
/** アカウント状態 1:有効 2:停止（m_account.status） */
export type AccountStatus = '1' | '2';
/** 招待コード状態 1:未使用 2:使用済 3:失効（t_invitation_code.status） */
export type InvitationStatus = '1' | '2' | '3';
/** 規約種別 1:利用規約 2:プライバシーポリシー（m_terms.document_type） */
export type TermsDocumentType = '1' | '2';
/** 性別 1:男 2:女 9:未回答（m_child.sex） */
export type Sex = '1' | '2' | '9';
/** 在籍状態 1:在籍 2:退園 3:卒園（m_child.enrollment_status） */
export type EnrollmentStatus = '1' | '2' | '3';
/** 写真の利用同意 1:園内記録 2:自児保護者へ共有 3:他保護者にも見える場（m_child.photo_consent_level） */
export type PhotoConsentLevel = '1' | '2' | '3';
/** 記録種別 1:個人日誌 2:クラス日誌 3:週案月案 4:ヒヤリハット（t_diary.record_type） */
export type DiaryRecordType = '1' | '2' | '3' | '4';
/** 日誌の状態 1:下書き 2:申請中 3:承認済み 4:差し戻し（t_diary.status） */
export type DiaryStatus = '1' | '2' | '3' | '4';
/** 紐づけ状態 1:有効 2:終了 3:猶予中（t_guardian_child.link_status） */
export type LinkStatus = '1' | '2' | '3';
/** チャットルーム種別 1:園 2:クラスグループ 3:目的別グループ 4:個人 5:職員（m_chat_room.room_type） */
export type ChatRoomType = '1' | '2' | '3' | '4' | '5';
/** メッセージの出所 1:手入力 2:日誌の共有 3:発達身体測定の共有（t_chat_message.source_type） */
export type MessageSourceType = '1' | '2' | '3' | '4';
/** 体位 1:仰向け 2:うつ伏せ 3:左向き 4:右向き（t_nap_record.body_position） */
export type BodyPosition = '1' | '2' | '3' | '4';
/** 呼吸 1:あり 2:確認できず（t_nap_record.breathing） */
export type Breathing = '1' | '2';
/** 顔色 1:通常 2:蒼白 3:紅潮 4:その他（t_nap_record.complexion） */
export type Complexion = '1' | '2' | '3' | '4';
/** 発達チェックの状態 1:下書き 2:確定（t_development_check.status） */
export type DevelopmentCheckStatus = '1' | '2';
/** 発達チェックの結果 1:確認できた 2:一部 3:未確認（t_development_result.result） */
export type DevelopmentResult = '1' | '2' | '3';
/** 身体測定の連携状態 0:対象外 1:未連携 2:連携済（t_physical_record.share_status） */
export type ShareStatus = '0' | '1' | '2';
/** 測定種別 1:身長 2:体重（m_growth_standard.measure_type） */
export type MeasureType = '1' | '2';
/** 機能種別 1:日誌 2:チャット 3:午睡 4:発達 5:身体測定 6:園児 7:アカウント 8:連絡帳 9:設定（t_operation_log.function_type。詳細設計書「変える表」(5-3)） */
export type FunctionType = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
/** 操作区分 1:作成 2:変更 3:承認 4:削除 5:出力 6:AI の下書き（t_operation_log.operation_type。詳細設計書「変える表」(5-3)） */
export type OperationType = '1' | '2' | '3' | '4' | '5' | '6';

/* ---- アカウント・権限（基本設計書 5-2） ---- */

/** アカウント（m_account） */
export interface Account {
  account_id: number;
  email: string;
  /** モックのため平文で保持する。本実装ではハッシュ化して保存し、平文は保持しない（5-2） */
  password_hash: string;
  role: Role;
  status: AccountStatus;
  is_temp_password: boolean;
  temp_password_expires_at: string | null;
  failed_login_count: number;
  locked_until: string | null;
  terms_version: string | null;
  terms_agreed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 職員（m_staff） */
export interface Staff {
  staff_id: string;
  account_id: number;
  staff_name: string;
  created_at: string;
  updated_at: string;
}

/** 保護者（m_guardian） */
export interface Guardian {
  guardian_id: string;
  account_id: number;
  guardian_name: string;
  /** 緊急連絡先。要件定義書側で保持先が未確定（基本設計書「要決定事項」(7) No.1） */
  phone_number: string | null;
  created_at: string;
  updated_at: string;
}

/** 招待コード（t_invitation_code） */
export interface InvitationCode {
  invitation_code_id: number;
  code: string;
  child_id: string;
  expires_on: string;
  status: InvitationStatus;
  used_account_id: number | null;
  used_at: string | null;
  issued_staff_id: string;
  created_at: string;
}

/** 利用規約（m_terms） */
/**
 * 同意履歴（t_terms_agreement）。追記のみ
 * アカウントの terms_version は「再同意が必要か」を判定する現在値であり、履歴とは役割が違う（5-2）
 */
export interface TermsAgreement {
  terms_agreement_id: number;
  account_id: number;
  terms_id: number;
  agreed_at: string;
}

export interface Terms {
  terms_id: number;
  terms_version: string;
  document_type: TermsDocumentType;
  body: string;
  published_on: string;
}

/* ---- 園児・クラス（基本設計書 5-3） ---- */

/** 園児（m_child） */
export interface Child {
  child_id: string;
  child_name: string;
  child_name_kana: string;
  /** 月齢算出の唯一の根拠。未来日不可（5-3） */
  birth_date: string;
  sex: Sex;
  normal_temperature: number | null;
  enrollment_status: EnrollmentStatus;
  photo_consent_level: PhotoConsentLevel;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

/** クラス（m_class）。年度ごとに別レコードとする（5-3） */
export interface ClassRoom {
  class_id: number;
  fiscal_year: number;
  class_name: string;
  /** 年齢児（0:0歳児 … 5:5歳児）。午睡チェックの間隔を引く（基本設計書「クラスと紐づけ」(5-3)） */
  age_class: number;
}

/** 園児のクラス在籍（t_class_child） */
export interface ClassChild { class_id: number; child_id: string; }

/** 担任の割り当て（t_class_staff） */
export interface ClassStaff { class_id: number; staff_id: string; }

/** 園児と保護者の紐づけ（t_guardian_child）。紐づけ単位で終了させる（5-3） */
export interface GuardianChild {
  guardian_id: string;
  child_id: string;
  relationship: string;
  link_status: LinkStatus;
  linked_at: string;
  ended_at: string | null;
  /** 猶予中（3）の終わりの日（詳細設計書「変える表」(5-3)） */
  grace_ends_on?: string | null;
}

/** アレルギー（m_allergy）。1園児に複数登録できる（5-3） */
export interface Allergy {
  allergy_id: number;
  child_id: string;
  target_food: string;
  symptom: string;
  response: string;
}

/** 既往歴（m_medical_history）。要配慮個人情報（5-3） */
export interface MedicalHistory {
  medical_history_id: number;
  child_id: string;
  content: string;
}

/* ---- 日誌（基本設計書 5-4） ---- */

/** 日誌（t_diary）。記録種別でテーブルを分けない（5-4） */
export interface Diary {
  diary_id: number;
  record_type: DiaryRecordType;
  child_id: string | null;
  class_id: number | null;
  diary_date: string;
  body: string;
  status: DiaryStatus;
  created_staff_id: string;
  approved_staff_id: string | null;
  approved_at: string | null;
  /** 承認とは別の指定（5-4） */
  is_shared_to_guardian: boolean;
  shared_at: string | null;
  /** 起票元。ヒヤリハットのみ。異常時の記録と相互に参照する（5-4） */
  nap_abnormal_id: number | null;
  /** 差し戻す理由。差し戻しは理由の入力を必須とする（画面詳細図 3-3） */
  returned_reason: string | null;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
  /*
   * 記入した職員・確認（承認）した職員の氏名。画面が使う導出値。
   * 保護者には職員の名簿を渡さないため、IDから引かずにこの値を出す。
   */
  staff_name?: string;
  approved_staff_name?: string | null;
  /**
   * 最後に申請した職員。日誌を1件開いたときに、職員へだけ返す導出値。
   * 承認画面が「自分が申請した日誌」を見分けて、承認のボタンを押せなくするため（GitHub Issue #174）
   */
  applied_staff_id?: string | null;
}

/** 編集ロック（t_diary_lock）。1件の日誌に1つ（5-4） */
export interface DiaryLock {
  diary_id: number;
  lock_token: string;
  locked_staff_id: string;
  locked_at: string;
  last_active_at: string;
}

/** 雛形（m_diary_template）。保護者共有の既定値を雛形側に持つ（5-4） */
export interface DiaryTemplate {
  diary_template_id: number;
  record_type: DiaryRecordType;
  template_name: string;
  body: string;
  default_share_to_guardian: boolean;
}

/** 添付（t_diary_attachment）。1〜3枚（5-4） */
export interface DiaryAttachment {
  diary_attachment_id: number;
  diary_id: number;
  file_path: string;
  file_type: string;
}

/* ---- チャット（基本設計書 5-5） ---- */

/** チャットルーム（m_chat_room）。クラスグループはクラスと年度で自動構成（5-5） */
export interface ChatRoom {
  chat_room_id: number;
  room_type: ChatRoomType;
  class_id: number | null;
  room_name: string;
  is_archived: boolean;
  /** 個人チャットのみ。'1' 未対応 / '2' 対応済み（要件定義書「チャットツール」(4-3)） */
  thread_status: string | null;
}

/** 参加者（t_chat_member）。left_at で過去の所属期間を保持する（5-5） */
export interface ChatMember {
  chat_room_id: number;
  account_id: number;
  joined_at: string;
  left_at: string | null;
}

/** メッセージ（t_chat_message） */
export interface ChatMessage {
  chat_message_id: number;
  chat_room_id: number;
  sender_account_id: number;
  body: string;
  source_type: MessageSourceType;
  source_id: number | null;
  sent_at: string;
  edited_at: string | null;
  is_deleted: boolean;
  deleted_at: string | null;
  deleted_account_id: number | null;
  /*
   * 送信者の表示名。テーブルの列ではなく、返すときに添える。
   * 保護者にはアカウントの名簿を返さないため（server/api_reference.go）、
   * 画面側で sender_account_id から引くことができない。
   */
  sender_name?: string;
  /**
   * 送信者のロール。職員か保護者かを吹き出しに添えるために返す。職員と保護者に同じ氏名の人がいると、
   * 氏名だけでは誰の発言か分からない（GitHub Issue #141）
   */
  sender_role?: Role;
  /**
   * 既読の人数。職員にだけ返す（保護者側には表示しない。基本設計書 5-5）。
   * メッセージと一緒に受け取り、読み直したときに人数も新しくなるようにする。
   * 保護者が参加するチャンネルでは保護者の既読だけを数える（GitHub Issue #171。server/api_chat.go の readCountRoles）
   */
  read_count?: number;
  /** リアクションの集計。種別ごとの人数と、自分が付けているか */
  reactions?: ReactionSummary[];
}

/** メッセージに付いたリアクションの集計（t_chat_reaction から導く） */
export interface ReactionSummary {
  reaction_type: string;
  count: number;
  mine: boolean;
}

/** 配布物の種類（t_handout.handout_type） */
export type HandoutType = '1' | '2' | '3' | '4' | '5';

/**
 * 配布物（t_handout）。園だより・献立表など、保護者があとから見返すもの
 * class_id が空なら園全体向け。取り下げは論理削除とする（5-5）
 */
export interface Handout {
  handout_id: number;
  handout_type: HandoutType;
  title: string;
  /** 対象の月 'YYYY-MM' */
  target_month: string;
  class_id: number | null;
  file_name: string;
  file_type: string;
  file_size: number;
  posted_staff_id: string;
  posted_at: string;
  is_deleted: boolean;
  /** 画面が使う導出値 */
  class_name?: string;
  posted_staff_name?: string;
}

/** 既読（t_chat_read）。保護者側には表示しない（5-5） */
export interface ChatRead {
  chat_read_id: number;
  chat_message_id: number;
  account_id: number;
  read_at: string;
}

/** リアクション（t_chat_reaction） */
export interface ChatReaction {
  chat_reaction_id: number;
  chat_message_id: number;
  account_id: number;
  reaction_type: string;
}

/** 誤送信への対応の記録（t_misdelivery_record） */
export interface MisdeliveryRecord {
  misdelivery_record_id: number;
  chat_message_id: number;
  occurred_at: string;
  was_read: boolean;
  response: string;
  staff_id: string;
}

/* ---- 午睡チェック（基本設計書 5-6） ---- */

/** 午睡の実施（t_nap_session）。開始・終了の操作を保持する（5-6） */
export interface NapSession {
  nap_session_id: number;
  class_id: number;
  session_date: string;
  started_staff_id: string;
  started_at: string;
  ended_staff_id: string | null;
  ended_at: string | null;
  is_auto_closed: boolean;
}

/** 午睡の記録（t_nap_record）。チェック時刻と保存時刻の両方を保持する。削除フラグは持たない（5-6） */
export interface NapRecord {
  nap_record_id: number;
  nap_session_id: number;
  child_id: string;
  checked_at: string;
  saved_at: string;
  body_position: BodyPosition;
  breathing: Breathing;
  complexion: Complexion;
  temperature: number | null;
  staff_id: string;
}

/** 異常時の記録（t_nap_abnormal）。diary_id が空ならヒヤリハット未起票（5-6） */
export interface NapAbnormal {
  nap_abnormal_id: number;
  nap_session_id: number;
  child_id: string;
  found_at: string;
  recorded_at?: string;
  situation: string;
  response: string;
  staff_id: string;
  diary_id: number | null;
}

/* ---- 連絡帳（基本設計書「連絡帳」(5-4)、詳細設計書「足す表」(5-2)） ----
 * 表の行そのもの。画面へ返す形（職員と保護者で項目が違う）は shapes.ts の ContactHome などが持つ
 */

/** 食事の量・朝ごはん 1:ぜんぶ 2:半分 3:少し 4:食べていない */
export type MealAmount = '1' | '2' | '3' | '4';
/** 出来事の種類 1:食事 2:排せつ 3:体温 4:活動のひとこと 5:写真（t_contact_event.event_type） */
export type ContactEventType = '1' | '2' | '3' | '4' | '5';

/** 家庭から（t_contact_home）。園児×日に1行。状態は列から読む（詳細設計書「家庭から」(3-1)） */
export interface ContactHomeRecord {
  contact_home_id: number;
  child_id: string;
  contact_date: string;
  /** 最後に送った保護者 */
  guardian_id: string;
  temperature: number | null;
  night_sleep_from: string | null;
  night_sleep_to: string | null;
  breakfast: MealAmount | null;
  mood_label: string | null;
  pickup_type: '1' | '2' | null;
  pickup_person: string | null;
  pickup_time: string | null;
  message: string | null;
  submitted_at: string;
  confirmed_staff_id: string | null;
  confirmed_at: string | null;
  revised_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 定型文（m_phrase）。連絡帳と日誌で共通（基本設計書「定型文（m_phrase）」(5-9)） */
export interface PhraseRecord {
  phrase_id: number;
  /** 1:園から 2:活動のひとこと 3:クラスのようす 4:日誌 */
  phrase_scope: '1' | '2' | '3' | '4';
  body: string;
  display_order: number;
  is_deleted: boolean;
  updated_staff_id: string;
  created_at: string;
  updated_at: string;
}

/** 出来事（t_contact_event）。きょうのようすの1件・園児1人 */
export interface ContactEventRecord {
  contact_event_id: number;
  child_id: string;
  class_id: number;
  contact_date: string;
  event_type: ContactEventType;
  recorded_at: string;
  meal_kind: '1' | '2' | null;
  meal_amount: MealAmount | null;
  toilet_label: string | null;
  temperature: number | null;
  body: string | null;
  contact_photo_id: number | null;
  keep_in_growth: boolean;
  staff_id: string;
  corrected_at: string | null;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

/** クラスのようす（t_contact_class） */
export interface ContactClassRecord {
  contact_class_id: number;
  class_id: number;
  contact_date: string;
  body: string;
  contact_photo_id: number | null;
  source_diary_id: number | null;
  staff_id: string;
  recorded_at: string;
  corrected_at: string | null;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

/** 園から（t_contact_facility）。取り消していない行は園児×日に1つ */
export interface ContactFacilityRecord {
  contact_facility_id: number;
  child_id: string;
  class_id: number;
  contact_date: string;
  body: string;
  staff_id: string;
  recorded_at: string;
  corrected_at: string | null;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

/** 保護者が開いた時刻（t_contact_read）。1件ずつの既読は持たない */
export interface ContactReadRecord {
  child_id: string;
  contact_date: string;
  account_id: number;
  read_at: string;
}

/** ねた・おきた（t_nap_sleep）。sleep_temperature だけは監査の層で保護者へ返さない（基本設計書「午睡チェック」(5-7)） */
export interface NapSleepRecord {
  nap_sleep_id: number;
  nap_session_id: number;
  child_id: string;
  slept_at: string;
  woke_at: string | null;
  sleep_temperature: number | null;
  slept_staff_id: string;
  woke_staff_id: string | null;
  corrected_at: string | null;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

/** きょうは対象外（t_nap_exclusion）。監査の層。保護者へは返さない */
export interface NapExclusionRecord {
  nap_exclusion_id: number;
  nap_session_id: number;
  child_id: string;
  /** 1:欠席 2:午睡なし */
  reason: '1' | '2';
  staff_id: string;
  is_deleted: boolean;
  created_at: string;
}

/* ---- 発達チェック・身体測定（基本設計書 5-7） ---- */

/** 発達過程区分（m_development_category）。マスタ化して指針改定に追従する（5-7） */
export interface DevelopmentCategory {
  development_category_id: number;
  age_month_from: number;
  age_month_to: number;
  category_name: string;
  display_order: number;
}

/** 発達チェック項目（m_development_item） */
export interface DevelopmentItem {
  development_item_id: number;
  development_category_id: number;
  item_name: string;
  domain: string;
  display_order: number;
}

/** 推奨頻度（m_development_frequency） */
export interface DevelopmentFrequency {
  development_frequency_id: number;
  age_month_from: number;
  age_month_to: number;
  interval_days: number;
}

/** 項目単位の共有可否（m_share_setting） */
export interface ShareSetting {
  share_setting_id: number;
  development_item_id: number;
  is_shareable: boolean;
  updated_staff_id: string;
  updated_at: string;
}

/** 園児単位の予定（t_development_schedule） */
export interface DevelopmentSchedule {
  development_schedule_id: number;
  child_id: string;
  scheduled_on: string;
  is_manual_override: boolean;
  created_staff_id: string;
}

/** 発達チェック（t_development_check） */
export interface DevelopmentCheck {
  development_check_id: number;
  child_id: string;
  development_schedule_id: number | null;
  checked_on: string;
  status: DevelopmentCheckStatus;
  staff_id: string;
  share_status: ShareStatus;
  /** 所見（チェック単位の自由記述）。列は基本設計書 5-7 の定義に無い（GitHub Issue #58） */
  note?: string | null;
}

/**
 * 発達チェックの結果（t_development_result）
 * 「未入力」はレコードが存在しない状態で表す。「未確認」は result='3' として明示的に保持する（5-7）
 */
export interface DevelopmentResultRecord {
  development_result_id: number;
  development_check_id: number;
  development_item_id: number;
  result: DevelopmentResult;
  note: string | null;
}

/**
 * 身体測定記録（t_physical_record）
 * 一意制約：child_id + measured_on を is_deleted=false の行のみ対象とする（5-7）
 */
export interface PhysicalRecord {
  physical_record_id: number;
  child_id: string;
  measured_on: string;
  height_cm: number;
  weight_kg: number;
  /** 初回登録者。更新時に書き換えない（5-7） */
  staff_id: string;
  share_status: ShareStatus;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

/** 成長曲線基準値（m_growth_standard）。未回答に対応する基準値は持たない（5-7） */
export interface GrowthStandard {
  growth_standard_id: number;
  sex: '1' | '2';
  age_in_months: number;
  measure_type: MeasureType;
  percentile: number;
  standard_value: number;
  source_version: string;
}

/* ---- 共通（基本設計書 5-8） ---- */

/** 操作ログ（t_operation_log）。追記のみとし、更新・削除の手段を設けない（5-8） */
export interface OperationLog {
  operation_log_id: number;
  account_id: number;
  operated_at: string;
  function_type: FunctionType;
  operation_type: OperationType;
  target_table: string;
  target_id: number | null;
  target_child_id: string | null;
  before_value: string | null;
  after_value: string | null;
}

/** 設定マスタ（m_setting）。文字列で保持し、利用側で型変換する（5-8） */
export interface Setting {
  setting_key: string;
  setting_value: string;
  description: string;
  updated_staff_id: string;
  updated_at: string;
}

/* ---- 画面が扱う導出値（テーブルではない） ---- */

/** ログイン中の利用者。ヘッダの常時表示に用いる（基本設計書 3-5） */
export interface SessionUser {
  account_id: number;
  email: string;
  role: Role;
  /** 職員なら staff_name、保護者なら guardian_name */
  display_name: string;
  staff_id: string | null;
  guardian_id: string | null;
  /** 職員の所属クラス。共有端末での記録者の取り違えを防ぐため表示する（画面詳細図 1-1） */
  class_id: number | null;
  class_name: string | null;
  is_temp_password: boolean;
  /** 最新版の規約に同意済みか。未同意なら利用規約同意画面へ送る */
  terms_agreed: boolean;
}

/** 一覧のページング結果（基本設計書「一覧表示とページング」(3-7)） */
export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  per_page: number;
}
