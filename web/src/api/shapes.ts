/*
 * 画面とデータ層のあいだの契約
 *
 * api/mock.ts（ブラウザ内のモック）と api/http.ts（Go サーバへの問い合わせ）は、
 * どちらもここで定義した形を返す。片方だけが違う形を返すと画面が壊れるため、
 * 形の定義は本ファイルの1か所に置く。
 */
import type {
  Account, Child, ChatRoom, Diary, DevelopmentItem, GuardianChild, NapRecord, NapSession,
  DiaryRecordType, DiaryStatus, InvitationStatus, Role, FunctionType, OperationType,
  DevelopmentCheck, DevelopmentResultRecord, MealAmount, ContactEventType,
} from './types';
import type { BodyPosition, Breathing, Complexion } from './types';

/** ログインの失敗理由。画面が分岐に使う（図/画面詳細図.md「職員用トップ／保護者用トップ」(2-1)） */
export type LoginError =
  | { kind: 'credential'; remaining: number }
  | { kind: 'locked'; until?: string }
  | { kind: 'suspended' }
  | { kind: 'wrong_entrance'; correct: 'staff' | 'guardian' }
  /** 一時パスワードの有効期限切れ（基本設計書「ログイン」(4-3)、メッセージ一覧 (4-9)。GitHub Issue #159） */
  | { kind: 'temp_expired' }
  /** ログイン中の新しいログイン・新規登録。上書きログインは設けない（基本設計書「ログイン」(4-3)。GitHub Issue #159） */
  | { kind: 'already_logged_in' };

/** 園児情報の登録・編集の入力（図/画面詳細図.md 7-2） */
export interface ChildInput {
  child_id: string;
  child_name: string;
  child_name_kana: string;
  birth_date: string;
  sex: Child['sex'];
  normal_temperature: number | null;
  photo_consent_level: Child['photo_consent_level'];
  class_id: number;
  allergies: { target_food: string; symptom: string; response: string }[];
  medical_histories: string[];
}

export interface DiaryFilter {
  recordType?: DiaryRecordType | '';
  classId?: number | '';
  status?: DiaryStatus | '';
  from?: string;
  to?: string;
  page?: number;
  /** 【仮置き】自分が書いた日誌に絞る。職員ダッシュボードの「差し戻された日誌」から開いたとき（GitHub Issue #174） */
  mine?: boolean;
}

export interface DiaryInput {
  diary_id?: number;
  record_type: DiaryRecordType;
  child_id: string | null;
  class_id: number | null;
  diary_date: string;
  body: string;
  lock_token?: string;
  /**
   * 日誌に付ける写真。保存のたびに、この並びで日誌の写真を置き換える。送らなければ付いている写真に触らず、
   * 空の並びはすべて外す（【仮置き】web/仮置き値.md「日誌作成・編集画面の動き」。GitHub Issue #175 の 2）
   */
  attachments?: DiaryAttachmentInput[];
}

/** 日誌に付ける写真 1 枚。実体は持たず、ファイルの名前と形式だけを持つ（web/仮置き値.md 7「添付ファイルの実体」） */
export interface DiaryAttachmentInput {
  file_path: string;
  file_type: string;
}

export interface DiaryTemplate {
  diary_template_id: number;
  record_type: DiaryRecordType;
  template_name: string;
  body: string;
  default_share_to_guardian: boolean;
}

/** チャンネル。未読件数と投稿可否を添える（図/画面詳細図.md 4-1） */
export interface ChatRoomView {
  room: ChatRoom;
  unread: number;
  canPost: boolean;
  /** 参加している保護者の人数。投稿が保護者にも届くことを入力欄の近くで示すために使う */
  guardianCount: number;
  /**
   * 外れたチャンネル。職員は、外れるまでの過去ログだけを読める（投稿はできない）
   * （図/画面詳細図.md「グループ編成画面」(4-3) No.8、基本設計書「チャット」(5-5)。GitHub Issue #161）
   */
  left: boolean;
}

export interface MisdeliveryRow {
  misdelivery_record_id: number;
  chat_message_id: number;
  occurred_at: string;
  was_read: boolean;
  response: string;
  staff_id: string;
  room_name: string;
  staff_name: string;
}

export interface RetractedRow {
  chat_message_id: number;
  room_name: string;
  sent_at: string;
  deleted_at: string | null;
  sender_name: string;
}

/** 午睡の園児カード。直近の記録が無ければ latest は null（図/画面詳細図.md 5-1） */
export interface NapChildState {
  child: Child;
  latest: NapRecord | null;
  /** その実施の、取り消していない「ねた・おきた」（入眠時の体温を含む。詳細設計書「午睡（ねた・おきた・対象外）」(4-6 (6))） */
  sleeps: NapSleep[];
  /** その実施の「きょうは対象外」 */
  exclusion: NapExclusion | null;
}

export interface NapAbnormalRow {
  nap_abnormal_id: number;
  nap_session_id: number;
  child_id: string;
  found_at: string;
  recorded_at?: string;
  situation: string;
  response: string;
  staff_id: string;
  diary_id: number | null;
  child_name: string;
  staff_name: string;
}

/**
 * 午睡記録検索の行の種類。check は5分ごとの確認（t_nap_record）、sleep は「ねた」、wake は「おきた」（t_nap_sleep）
 * （画面詳細図「午睡記録検索画面」(5-3) の項目6「園児ごとの入眠（ねた）と起床（おきた）、入眠時の体温（ねたの行）…も、その日の行に出す」）
 */
export type NapSearchRowKind = 'check' | 'sleep' | 'wake';

/**
 * 午睡記録検索の1行。確認の行は体位・呼吸・顔色・体温・保存時刻を持つ。ねた・おきたの行は押した時刻（サーバの時刻）を
 * checked_at に持ち、体位・呼吸・顔色・保存時刻は null。入眠時の体温（sleep_temperature）はねたの行だけに入る。
 * 職員だけの経路（GET /api/nap/records）で返す
 */
export interface NapSearchRow {
  kind: NapSearchRowKind;
  nap_record_id: number | null;
  nap_sleep_id: number | null;
  nap_session_id: number;
  child_id: string;
  checked_at: string;
  saved_at: string | null;
  body_position: BodyPosition | null;
  breathing: Breathing | null;
  complexion: Complexion | null;
  temperature: number | null;
  sleep_temperature: number | null;
  staff_id: string;
  session_date: string;
  child_name: string;
  class_name: string;
  staff_name: string;
}

/** 発達チェック一覧の行。overdue は予定日を過ぎて未実施の状態 */
export interface DevListRow {
  child: Child;
  ageMonths: number;
  scheduledOn: string | null;
  lastCheckedOn: string | null;
  overdue: boolean;
  /**
   * いちばん新しい記録（下書きを含む）に残っている未入力の項目数。未入力はチェック漏れの対象（基本設計書 5-7）。
   * 下書きの保存していない項目も未入力として数える（要件定義書「チェック漏れの強調」(4-5-2)。GitHub Issue #143）
   */
  unfilled: number;
}

/** 発達チェック入力画面が読み直す、その日の記録 */
export interface DevDraftView {
  check: DevelopmentCheck;
  results: DevelopmentResultRecord[];
  /** 最後に確定した日時（操作ログの「確定」から引く）。下書きと、操作ログの無い記録は null（GitHub Issue #143） */
  confirmedAt: string | null;
}

export interface DevScheduleRow {
  child: Child;
  ageMonths: number;
  /** システムが提案する予定日。マスタの推奨頻度から算出する */
  suggested: string;
  intervalDays: number | null;
  scheduledOn: string | null;
  isManualOverride: boolean;
}

/** CSV の1行ぶんの取込内容と判定（基本設計書「CSV一括登録」(4-4)） */
export interface CsvRow {
  line: number;
  values: string[];
  error: string | null;
  /** 取り込みは妨げないが、確かめてほしいこと（範囲の外の平熱など） */
  warning?: string | null;
}

export interface FiscalClassRow {
  className: string;
  childCount: number;
  staffNames: string[];
}

export interface StaffAccountRow {
  staff: { staff_id: string; staff_name: string };
  account: Account;
  className: string;
  locked: boolean;
}

export interface GuardianAccountRow {
  guardian: {
    guardian_id: string;
    account_id: number;
    guardian_name: string;
    phone_number: string | null;
  };
  account: Account;
  links: (GuardianChild & { child_name: string })[];
  activeLinks: number;
  /** 最新版の利用規約に同意済みか */
  termsAgreed: boolean;
}

export interface InvitationCodeRow {
  invitation_code_id: number;
  code: string;
  child_id: string;
  expires_on: string;
  status: InvitationStatus;
  issued_staff_id: string;
  created_at: string;
  class_id: number | null;
  child_name: string;
  issued_staff_name: string;
  expired: boolean;
}

export interface OperationLogRow {
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
  account_name: string;
  child_name: string;
  /** 操作の相手。園児に紐づかない操作で、誰・何に対する操作かを示す（GitHub Issue #114）。無ければ空 */
  target_label: string;
}

/** 職員ダッシュボードの未対応の集計（図/画面詳細図.md 2-4） */
export interface StaffSummary {
  returned: number;
  unreadChat: number;
  /**
   * 未対応のままの、保護者との個人チャットの数（要件定義書「チャットツール」(4-3) の未対応スレッド）。
   * 自分が参加しているものだけを数える。チャット画面の見出しの「未対応 n 件」と同じ範囲
   */
  unhandledChat: number;
  /** そのうち、チャット画面の一覧でいちばん上に来るもの。ダッシュボードの「開く」でここを開く。無ければ null */
  unhandledChatRoom: { chat_room_id: number; room_name: string } | null;
  devOverdue: number;
  pending: number;
  abnormalWithoutDiary: number;
  activeNap: NapSession | null;
  /** 今日の家庭からの「未確認」「更新」の園児の数（詳細設計書「ダッシュボード」(4-8 (2))） */
  homeUnconfirmed: number;
  homeRevised: number;
  /** 実施中の午睡で、おひるね中の園児の数 */
  napSleeping: number;
}

export interface GuardianHomeRow {
  child: Child;
  ageMonths: number;
  className: string;
  /** 承認済みかつ共有指定のあるものだけ */
  sharedDiaries: Diary[];
  unread: number;
  /** 園児1人の「きょう」（詳細設計書「ダッシュボード」(4-8 (1))） */
  today: GuardianToday;
}

/* ============ 連絡帳（詳細設計書「型」(4-1 (4))、図/インタフェース一覧「やり取りするデータの項目」(2)） ============
 * 職員と保護者で返す項目が違う。「職員の応答だけ」の項目は、保護者の応答には入らない（段3）
 */

export type { MealAmount, ContactEventType };
/** 家庭からの状態（詳細設計書「家庭から」(3-1)） */
export type HomeState = 'none' | 'unconfirmed' | 'confirmed' | 'revised';

/** 家庭から（t_contact_home） */
export interface ContactHome {
  contact_home_id: number;
  child_id: string;
  contact_date: string;
  /** 最後に送った保護者 */
  guardian_id: string;
  /** 職員の応答だけ（父母のどちらが書いたか） */
  guardian_name?: string;
  /** 職員の応答だけ。「母 7:40」と出すための続柄（詳細設計書「家庭からの列」(2-2 (3))） */
  guardian_relationship?: string;
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
  confirmed_at: string | null;
  /** 職員の応答だけ */
  confirmed_staff_name?: string;
  revised_at: string | null;
  /** 同時編集の検出に使う */
  updated_at: string;
}

/** 家庭からを送るときの入力。updated_at は読んだときの版（初めてなら null） */
export interface ContactHomeInput {
  temperature: number | null;
  night_sleep_from: string | null;
  night_sleep_to: string | null;
  breakfast: MealAmount | null;
  mood_label: string | null;
  pickup_type: '1' | '2' | null;
  pickup_person: string | null;
  pickup_time: string | null;
  message: string | null;
  updated_at: string | null;
}

/** 出来事（t_contact_event）。きょうのようすの1件・園児1人 */
export interface ContactEvent {
  contact_event_id: number;
  child_id: string;
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
  /** 職員の応答だけ */
  staff_name?: string;
  corrected_at: string | null;
  is_deleted: boolean;
}

/** クラスのようす（t_contact_class） */
export interface ContactClass {
  contact_class_id: number;
  class_id: number;
  contact_date: string;
  body: string;
  contact_photo_id: number | null;
  /** 職員の応答だけ */
  source_diary_id?: number | null;
  recorded_at: string;
  corrected_at: string | null;
  is_deleted: boolean;
}

/** 園から（t_contact_facility） */
export interface ContactFacility {
  contact_facility_id: number;
  child_id: string;
  contact_date: string;
  body: string;
  /** 職員の応答だけ（保護者には返さない） */
  staff_name?: string;
  recorded_at: string;
  corrected_at: string | null;
  is_deleted: boolean;
}

/** ねた・おきた（t_nap_sleep） */
export interface NapSleep {
  nap_sleep_id: number;
  child_id: string;
  slept_at: string;
  woke_at: string | null;
  /** 職員の応答だけ。入眠時の体温（監査の層） */
  sleep_temperature?: number | null;
  /** 職員の応答だけ */
  nap_session_id?: number;
  corrected_at: string | null;
  is_deleted: boolean;
  /**
   * その実施が終わったか（自動の解除を含む）。おきたが無いまま終わった組を「おひるね中」でなく「ねた」と出すため
   * （詳細設計書「午睡の園児」(3-4) の「ねた（おきた時刻なし）」。図/インタフェース一覧の NapSleep に足した）
   */
  session_ended: boolean;
}

/** きょうは対象外（t_nap_exclusion）。保護者へは返さない */
export interface NapExclusion {
  nap_exclusion_id: number;
  nap_session_id: number;
  child_id: string;
  reason: '1' | '2';
  staff_id: string;
  is_deleted: boolean;
}

/** 連絡帳の1ページ（GET /api/contact/children/{childID}） */
export interface ContactPage {
  child_id: string;
  child_name: string;
  contact_date: string;
  /** その日のクラス。無ければ null */
  class_id: number | null;
  home: ContactHome | null;
  events: ContactEvent[];
  sleeps: NapSleep[];
  class_notes: ContactClass[];
  facility: ContactFacility | null;
  /** 保護者が家庭からを書けるか（有効な紐づけで、サーバの今日のページ） */
  can_write_home: boolean;
  /** 保護者の応答だけ。そのページを前に開いた時刻（無ければ null） */
  last_read_at?: string | null;
}

/** 連絡帳（クラス）画面の1行（園児） */
export interface ContactClassRow {
  child: Child;
  home_state: HomeState;
  home: ContactHome | null;
  events: ContactEvent[];
  sleeps: NapSleep[];
  exclusion: NapExclusion | null;
  facility: ContactFacility | null;
}

/** 連絡帳（クラス）画面（GET /api/contact/classes/{classID}） */
export interface ContactClassView {
  class_id: number;
  class_name: string;
  contact_date: string;
  /** 有効な紐づけの保護者が1人以上いる在籍園児の数（決めたこと D-27） */
  family_count: number;
  unregistered_count: number;
  /** このクラスの記録を書けるか（フリーの職員は読むだけ） */
  can_write: boolean;
  rows: ContactClassRow[];
  class_notes: ContactClass[];
}

/** 保護者ホームの「きょう」の1件（午睡を除く） */
export interface TodayItem {
  kind: 'meal' | 'toilet' | 'temperature' | 'comment' | 'photo' | 'class_note';
  recorded_at: string;
  corrected_at: string | null;
  text: string;
  contact_photo_id: number | null;
}

/** 保護者ホームの「きょう」（GET /api/dashboard/guardian の1件の today） */
export interface GuardianToday {
  child_id: string;
  child_name: string;
  class_name: string;
  contact_date: string;
  can_write_home: boolean;
  grace_ends_on: string | null;
  home: { submitted_at: string; confirmed_at: string | null; revised_at: string | null } | null;
  /** その日のいちばん新しい組（無ければ null） */
  nap: NapSleep | null;
  /** 午睡を除く新しい3件 */
  latest: TodayItem[];
  facility: { recorded_at: string; corrected_at: string | null; excerpt: string } | null;
  unread_contact: number;
  unread_chat: number;
  personal_room_id: number | null;
  /** 成長の記録を作るまでは常に偽 */
  growth_new: boolean;
}

/** 参照のみに使う型の再輸出。画面が types.ts を直接読まなくて済むようにする */
export type { DevelopmentItem, Role };
