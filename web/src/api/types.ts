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
/** 紐づけ状態 1:有効 2:終了（t_guardian_child.link_status） */
export type LinkStatus = '1' | '2';
/** チャットルーム種別 1:園 2:クラスグループ 3:目的別グループ 4:個人 5:職員（m_chat_room.room_type） */
export type ChatRoomType = '1' | '2' | '3' | '4' | '5';
/** メッセージの出所 1:手入力 2:日誌の共有 3:発達身体測定の共有（t_chat_message.source_type） */
export type MessageSourceType = '1' | '2' | '3';
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
/** 機能種別 1:日誌 2:チャット 3:午睡 4:発達 5:身体測定 6:園児 7:アカウント（t_operation_log.function_type） */
export type FunctionType = '1' | '2' | '3' | '4' | '5' | '6' | '7';
/** 操作区分 1:作成 2:変更 3:承認 4:削除 5:出力（t_operation_log.operation_type） */
export type OperationType = '1' | '2' | '3' | '4' | '5';

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
  situation: string;
  response: string;
  staff_id: string;
  diary_id: number | null;
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
