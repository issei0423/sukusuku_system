/*
 * 画面とデータ層のあいだの契約
 *
 * api/mock.ts（ブラウザ内のモック）と api/http.ts（Go サーバへの問い合わせ）は、
 * どちらもここで定義した形を返す。片方だけが違う形を返すと画面が壊れるため、
 * 形の定義は本ファイルの1か所に置く。
 */
import type {
  Account, Child, ChatRoom, DevelopmentItem, GuardianChild, NapRecord, NapSession,
  DiaryRecordType, DiaryStatus, InvitationStatus, Role, FunctionType, OperationType,
  DevelopmentCheck, DevelopmentResultRecord, MealAmount, ContactEventType, Setting,
} from './types';
import type { GuardianNotice, GuardianNoticeMethod } from './types';
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
  | { kind: 'already_logged_in' }
  /** 送信元の失敗が続き、しばらく受け付けを止めている（server/attempts.go。GitHub Issue #236 の 6）。Go サーバだけが返す */
  | { kind: 'too_many_attempts' };

/**
 * ログインの期限（GET /api/session・POST /api/session/extend の応答。GitHub Issue #210）。
 * 期限はサーバが決める（server/api_session.go の sessionStatusOf。モックは api/mock.ts の sessionStatus）。
 * 画面は自分で数えた時刻を正とせず、予告を出す前・出している間に尋ね直す（components/SessionTimeoutWarning.tsx）
 */
export interface SessionStatus {
  /** 無操作で切るか。職員の画面だけ真（基本設計書「ログイン」(4-3)） */
  auto_logout: boolean;
  /** その職員が開始した午睡チェックが実施中で、いまは切らない。期限は決まっていない */
  nap_exempt: boolean;
  /** このまま操作が無ければ切れる時刻（JST、'YYYY-MM-DDTHH:MM:SS'）。決まっていないときは null */
  expires_at: string | null;
  /** 切れるまでの秒数（切り捨て）。0 のあいだはまだ使える。決まっていないときは null */
  remaining_seconds: number | null;
}

/** 園児情報の登録・編集の入力（図/画面詳細図.md 7-2） */
export interface ChildInput {
  child_id: string;
  child_name: string;
  child_name_kana: string;
  nickname?: string;
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
  /**
   * ヒヤリハットの欄（詳細設計書「日誌」(4-13 (1))）。ヒヤリハットのときは本文の代わりにこれを送り、
   * 状況・とった対応・今後の対策を見出しでつないだ本文をサーバ（モック）が作る（決めたこと D-33）
   */
  incident?: DiaryIncidentInput;
}

/** 保存のときに送るヒヤリハットの欄。任意の欄は空の文字列で「無し」とする（サーバ側は diaryIncidentInput） */
export interface DiaryIncidentInput {
  /** 'YYYY-MM-DDTHH:MM:SS' */
  occurred_at: string;
  place: string;
  situation: string;
  response: string;
  countermeasure?: string;
  /** '1' 伝えた / '2' 伝えていない / '' 未記入 */
  guardian_notice?: '' | '1' | '2';
  guardian_noticed_at?: string;
  guardian_notice_method?: '' | '1' | '2' | '3' | '9';
  guardian_notice_person?: string;
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
  is_deleted: boolean;
}

/** チャンネル。未読件数と投稿可否を添える（図/画面詳細図.md 4-1） */
export interface ChatRoomView {
  room: ChatRoom;
  unread: number;
  canPost: boolean;
  /** 参加している保護者の人数。投稿が保護者にも届くことを入力欄の近くで示すために使う */
  guardianCount: number;
  guardianRegisteredCount: number;
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
  /**
   * 起票したヒヤリハットが下書きのまま（申請していない）か。起票していなければ false（GitHub Issue #142 の 5）。
   * 判定はサーバ（server/api_nap.go の napAbnormalDiaryJoin）とモック（mock.ts の incidentDiaryDraft）
   */
  diary_draft: boolean;
  /** 保護者への連絡（画面詳細図「異常時記録画面」(5-2) 項目13）。空は未記入 */
  guardian_notice: GuardianNotice | null;
  guardian_noticed_at: string | null;
  guardian_notice_method: GuardianNoticeMethod | null;
  guardian_notice_person: string | null;
  child_name: string;
  staff_name: string;
  /**
   * 最後に修正した時刻（行の「修正あり」）と、この利用者が直せるか（直せる行にだけ「修正」を出す）。
   * 画面詳細図「異常時記録画面」(5-2) の項目17。判定はサーバ（server/api_nap_abnormal_correct.go の napAbnormalCorrectDenied）と
   * モック（mock.ts の napCorrectDenied）。担保は POST /api/nap/abnormals/{id}/correct
   */
  corrected_at: string | null;
  can_correct: boolean;
}

/**
 * 異常時の記録で送る保護者への連絡（画面詳細図「異常時記録画面」(5-2) 項目13）。
 * guardian_notice が空（''）なら未記入。「した」（'1'）のときだけ日時・手段・相手を使う
 */
export interface AbnormalGuardianNoticeInput {
  guardian_notice?: GuardianNotice | '';
  guardian_noticed_at?: string;
  guardian_notice_method?: GuardianNoticeMethod | '';
  guardian_notice_person?: string;
}

/**
 * 午睡記録検索の行の種類。check は5分ごとの確認（t_nap_record）、sleep は「ねた」、wake は「おきた」（t_nap_sleep）、
 * exclusion は「きょうは対象外」（t_nap_exclusion）
 * （画面詳細図「午睡記録検索画面」(5-3) の項目6「園児ごとの入眠（ねた）と起床（おきた）、入眠時の体温（ねたの行）、
 * きょうは対象外とその理由も、その日の行に出す」）
 */
export type NapSearchRowKind = 'check' | 'sleep' | 'wake' | 'exclusion';

/**
 * 午睡記録検索の1行。確認の行は体位・呼吸・顔色・体温・保存時刻を持つ。ねた・おきた・対象外の行は押した時刻（サーバの時刻）を
 * checked_at に持ち、体位・呼吸・顔色・保存時刻は null。入眠時の体温（sleep_temperature）はねたの行だけに、
 * 対象外の理由（exclusion_reason。1:欠席 2:午睡なし）は対象外の行だけに入る。
 * 職員だけの経路（GET /api/nap/records）で返す
 */
export interface NapSearchRow {
  kind: NapSearchRowKind;
  nap_record_id: number | null;
  nap_sleep_id: number | null;
  nap_exclusion_id: number | null;
  exclusion_reason: '1' | '2' | null;
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
  /** 確認の行だけ：最後に修正した時刻（「修正あり」の印）。ほかの行は null */
  corrected_at: string | null;
  /** 確認の行だけ：この利用者が直せるか（画面は「修正」を出す。担保は POST /api/nap/records/{id}/correct） */
  can_correct: boolean;
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
  /** 在籍中で、今日の園からを送っていない園児の数。今日の午睡で欠席にした子は数えない（詳細設計書 (4-8 (2))） */
  facilityUnsent: number;
}

export interface GuardianHomeRow {
  child: Child;
  ageMonths: number;
  className: string;
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
  /** 職員の応答だけ。直すときに読んだ版として送り返す（詳細設計書「訂正・取り消し」(4-7 (1))） */
  updated_at?: string;
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
  /** 職員の応答だけ。訂正のときに読んだ版として送り返す */
  updated_at?: string;
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
  /** 職員の応答だけ。訂正のときに読んだ版として送り返す（詳細設計書「午睡」(4-6 (4))） */
  updated_at?: string;
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
  /**
   * 職員の応答だけ。その園児の記録を書けるか（contactAccess の Write）。記録・直す部品を出すかに使う。
   * 前の日のページに記録を足せないこと・翌日以降は管理者だけが直せることは、日付で決める
   */
  can_write?: boolean;
  /** 職員の応答だけ。送る直前に示す宛先 */
  recipient?: ContactRecipient;
}

/** 送る直前に示す宛先（職員の応答だけ。詳細設計書「型」(4-1 (4))） */
export interface ContactRecipient {
  child_id: string;
  child_name: string;
  /** 顔写真の登録は次の版。いまはいつも偽（名前の1文字目の丸で示す） */
  has_face_photo: boolean;
  /** 有効な紐づけの続柄（例 ['父', '祖母']）。空なら保護者が未登録 */
  relationships: string[];
}

/** 定型文（m_phrase。図/インタフェース一覧の Phrase）。phrase_scope は 1:園から 2:ひとこと 3:クラスのようす 4:日誌 */
export interface Phrase {
  phrase_id: number;
  phrase_scope: '1' | '2' | '3' | '4';
  body: string;
  display_order: number;
}

/** 他児の名前に当たった本文の位置（符号位置。詳細設計書「誤りの応答」(4-1 (3)) の matches） */
export interface NameMatch {
  field: string;
  start: number;
  end: number;
}

/** 園からの訂正（POST /api/contact/facility/{id}/correct） */
export interface FacilityCorrection {
  body: string;
  acknowledged_names?: string[];
  updated_at: string;
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
  /** 送る直前に示す宛先 */
  recipient: ContactRecipient;
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

/** きょうのようすの1件を記録するときの入力（詳細設計書「型」(4-1 (4))）。meal_round は決めたこと D-5 */
export interface ContactEventInput {
  child_id: string;
  event_type: ContactEventType;
  meal_kind?: '1' | '2';
  meal_amount?: MealAmount;
  meal_round?: 1 | 2;
  toilet_label?: string;
  temperature?: number;
  body?: string;
  /** 排せつ・体温だけ。その日の0時からいままで */
  recorded_at?: string;
}

/** POST /api/contact/events の応答。skipped は「全員ぜんぶ」で記録のある子として飛ばした園児（詳細設計書 (4-4 (1))） */
export interface RecordEventsResult {
  events: ContactEvent[];
  skipped: string[];
}

/** 出来事の訂正（POST /api/contact/events/{id}/correct）。種類に合う項目と、読んだときの版 */
export interface ContactEventCorrection {
  meal_amount?: MealAmount;
  toilet_label?: string;
  temperature?: number;
  /** 活動のひとこと（訂正も他児の名前の照合を通る） */
  body?: string;
  acknowledged_names?: string[];
  recorded_at?: string;
  updated_at: string;
}

/** ねた・おきたの訂正（POST /api/nap/sleeps/{id}/correct） */
export interface NapSleepCorrection {
  slept_at?: string;
  woke_at?: string;
  updated_at: string;
}

/** 取り消しの応答。取り消す時点で読んでいた家庭の数（詳細設計書「訂正・取り消し」(4-7 (2))） */
export interface CancelResult {
  ok: true;
  read_family_count: number;
}

/** 取り消しの確認に出す、いま読んでいる家庭の数と人数（詳細設計書 (4-7 (3))） */
export interface Readers {
  family_count: number;
  guardian_count: number;
}

/**
 * 連絡帳の写真（図/インタフェース一覧の ContactPhoto）。写っている子（subject_child_ids）は職員の応答だけ。
 * 実体は GET /api/contact/photos/{id}（画面は api.photoUrl で URL を得る）
 */
export interface ContactPhoto {
  contact_photo_id: number;
  contact_date: string;
  /** 静止画のみ（image/jpeg・image/png） */
  file_type: string;
  file_size: number;
  /** 職員の応答だけ。写っている子（0人なら空） */
  subject_child_ids?: string[];
  is_deleted: boolean;
}

/**
 * 写真を送る（POST /api/contact/photos、multipart/form-data。詳細設計書「きょうのようす」(4-4 (2))）。
 * 写っている子が0人なら、届ける子（target_child_id）を1人選ぶ。添える文は任意・200文字
 */
export interface SendPhotoInput {
  file: Blob;
  subject_child_ids: string[];
  target_child_id?: string | null;
  body?: string | null;
  /** 届く先の全員の出来事に「成長の記録に残す」を付ける（詳細設計書 (4-12 (3))） */
  keep_in_growth?: boolean;
  acknowledged_names?: string[];
}

/** POST /api/contact/photos の応答。events は届く先の園児ごとの出来事（種類 5） */
export interface SendPhotoResult {
  photo: ContactPhoto;
  events: ContactEvent[];
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
  /**
   * ログイン中の保護者自身の紐づけの「AI の下書きを使わない」。ほかの家族の値は入れない
   * （詳細設計書「ダッシュボード」(4-8 (1))・「AI の下書きの利用」(4-15 (3))。保護者のメニューのダイアログの初期値）
   */
  ai_opt_out: boolean;
}

/**
 * POST /api/invitation/verify の応答（詳細設計書「お子さまの追加」(4-15 (1))）。
 * child_name・relationship は、ログインしている保護者が呼んだときだけ入る（決めたこと D-47）
 */
export interface InvitationPreview {
  ok: true;
  child_name?: string;
  /** 【仮置き】ダイアログの続柄の初期値（最初に登録したときの続柄。設計は渡し方を決めていない。web/仮置き値.md） */
  relationship?: string;
}

/** POST /api/guardian/children の応答（詳細設計書「お子さまの追加」(4-15 (1))） */
export interface AddChildResult {
  ok: true;
  child_id: string;
}

/* ============ 文章の下書き（AI）（詳細設計書「経路」(8-2)） ============ */

/** 用途。facility_note：園からのひとことの下書き（1つ）、rephrase：言い換え（候補3つ）、continue：続きの候補（3つ） */
export type AiPurpose = 'facility_note' | 'rephrase' | 'continue';
/** 下書きを入れる欄（文字数の上限と操作ログの表を決める）。facility：園から 500、comment：活動のひとこと 200、class：クラスのようす 500 */
export type AiField = 'facility' | 'comment' | 'class';

/** GET /api/ai/status の宛先（どちらか一方） */
export type AiTarget = { child_id: string; class_id?: undefined } | { class_id: number; child_id?: undefined };

/** POST /api/ai/drafts の要求。画面は「何の下書きか」「宛先」「メモ」「欄の文」だけを送り、送る項目はサーバが決める */
export type AiDraftInput = AiTarget & {
  purpose: AiPurpose;
  date: string;
  memo?: string;
  text?: string;
  field?: AiField;
};

/** POST /api/ai/drafts の応答 */
export interface AiDraftResult {
  drafts: string[];
  /** メモ・欄の文の中のほかの園児の名前を「おともだち」に置き換えて送った */
  replaced_other_names: boolean;
}

/* ============ 設定画面（詳細設計書「設定」(4-10)。本版は AI の区画だけ） ============ */

export interface SettingRow extends Setting {
  group: 'contact' | 'notify' | 'ai' | 'other';
  /** 基本設計書「設定マスタ（m_setting）」(5-9) の既定値 */
  default_value: string;
  /** 画面から変えられるか */
  editable: boolean;
}

/** GET /api/settings の応答。API キーそのものは返さない（あるか・無効と分かったかの真偽だけ。詳細設計書 (8-8)） */
export interface SettingsView {
  settings: SettingRow[];
  /** サーバの今。保存のときに送り返す（ほかの管理者の変更を見つけるため） */
  read_at: string;
  ai_key_present: boolean;
  ai_key_rejected: boolean;
  push_available: boolean;
}

/*
 * 成長の記録（GET /api/children/{childID}/growth。詳細設計書「成長の記録」(4-12 (1))）。
 * 返すのは事実（測った値・確認できた項目の名前・保護者へのひとこと・連絡帳から残したもの）だけ。
 * 「一部」「未確認」・所見・比較・記録した職員の名前・判定の言葉は入れない
 */
export interface GrowthRecord {
  child_id: string;
  child_name: string;
  sex: Child['sex'];
  birth_date: string;
  grace_ends_on: string | null;
  /** 偽なら measurements は空。画面は身長・体重の区画を出さない */
  share_physical: boolean;
  /** 新しい順・全件 */
  measurements: GrowthMeasurement[];
  /** 新しい順・12件まで */
  achievements: GrowthEntry[];
  next_before: string | null;
  /** 成長グラフの免責（基本設計書「メッセージ一覧」(4-12)） */
  disclaimer: string;
}

export interface GrowthMeasurement {
  physical_record_id: number;
  measured_on: string;
  age_in_months: number;
  height_cm: number;
  weight_kg: number;
  is_today: boolean;
}

/** 「できたこと」の1件。kind ごとに使う項目が違う */
export interface GrowthEntry {
  kind: 'development' | 'contact';
  at: string;
  date: string;
  is_today: boolean;
  /** development：確認できた項目の名前 */
  items?: string[];
  /** development：保護者へのひとこと */
  message?: string | null;
  /** development：ひとことを書き換えた時刻。「訂正しました（日付）」を出す（詳細設計書「成長の記録」(4-12)、決めたこと D-51） */
  message_corrected_at?: string | null;
  /** contact：ひとこと・写真に添えた文 */
  body?: string | null;
  /** contact：写真 */
  contact_photo_id?: number | null;
}

/** 参照のみに使う型の再輸出。画面が types.ts を直接読まなくて済むようにする */
export type { DevelopmentItem, Role };
