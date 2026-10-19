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
} from './types';

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
}

export interface DiaryInput {
  diary_id?: number;
  record_type: DiaryRecordType;
  child_id: string | null;
  class_id: number | null;
  diary_date: string;
  body: string;
  lock_token?: string;
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
}

export interface NapAbnormalRow {
  nap_abnormal_id: number;
  nap_session_id: number;
  child_id: string;
  found_at: string;
  situation: string;
  response: string;
  staff_id: string;
  diary_id: number | null;
  child_name: string;
  staff_name: string;
}

export interface NapSearchRow extends NapRecord {
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
  /** 前回の確定した記録に残っている未入力の項目数。未入力はチェック漏れの対象（基本設計書 5-7） */
  unfilled: number;
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
}

export interface GuardianHomeRow {
  child: Child;
  ageMonths: number;
  className: string;
  /** 承認済みかつ共有指定のあるものだけ */
  sharedDiaries: Diary[];
  unread: number;
}

/** 参照のみに使う型の再輸出。画面が types.ts を直接読まなくて済むようにする */
export type { DevelopmentItem, Role };
