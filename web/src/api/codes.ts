/*
 * 区分値の表示名
 * 典拠：基本設計書.md「データベース設計」(5) 各表の備考
 *
 * 画面には数字コードを出さず、必ずこの表を通した名称で表示する。
 */
import type {
  Role, AccountStatus, InvitationStatus, Sex, EnrollmentStatus, PhotoConsentLevel,
  DiaryRecordType, DiaryStatus, ChatRoomType, BodyPosition, Breathing, Complexion,
  DevelopmentResult, ShareStatus, MeasureType, FunctionType, OperationType, LinkStatus,
  GuardianNotice, GuardianNoticeMethod,
} from './types';

export const ROLE: Record<Role, string> = { '1': '管理者', '2': '一般', '3': '保護者' };
export const ACCOUNT_STATUS: Record<AccountStatus, string> = { '1': '有効', '2': '停止' };
export const INVITATION_STATUS: Record<InvitationStatus, string> = { '1': '未使用', '2': '使用済', '3': '失効' };
export const SEX: Record<Sex, string> = { '1': '男', '2': '女', '9': '未回答' };
export const ENROLLMENT_STATUS: Record<EnrollmentStatus, string> = { '1': '在籍', '2': '退園', '3': '卒園' };
export const PHOTO_CONSENT: Record<PhotoConsentLevel, string> = {
  '1': '園内記録のみ', '2': '自児保護者へ共有まで', '3': '他保護者にも見える場まで',
};
export const DIARY_RECORD_TYPE: Record<DiaryRecordType, string> = {
  '1': '個人日誌', '2': 'クラス日誌', '3': '週案・月案', '4': 'ヒヤリハット',
};
export const DIARY_STATUS: Record<DiaryStatus, string> = {
  '1': '下書き', '2': '申請中', '3': '承認済', '4': '差し戻し',
};
/** 差し戻しは他と区別できる色にする（画面詳細図 3-1） */
export const DIARY_STATUS_CLASS: Record<DiaryStatus, string> = {
  '1': 'tag-draft', '2': 'tag-applied', '3': 'tag-approved', '4': 'tag-returned',
};
export const CHAT_ROOM_TYPE: Record<ChatRoomType, string> = {
  '1': '園全体', '2': 'クラス', '3': '目的別グループ', '4': '個人', '5': '職員',
};
/** 保護者が参加するチャンネル（園全体・クラスグループ・個人チャット。基本設計書「チャット」(5-5)） */
export const GUARDIAN_ROOM_TYPES: readonly ChatRoomType[] = ['1', '2', '4'];
/**
 * 吹き出しに添える、送信者が職員か保護者か。
 * 【仮置き】職員と保護者に同じ氏名の人がいると、氏名だけでは誰の発言か分からない（GitHub Issue #141。web/仮置き値.md）。
 * 管理者と一般は分けない。保護者に園の中の権限の区分を見せる必要がないため
 */
export const SENDER_KIND: Record<Role, string> = { '1': '職員', '2': '職員', '3': '保護者' };
export const BODY_POSITION: Record<BodyPosition, string> = {
  '1': '仰向け', '2': 'うつ伏せ', '3': '左向き', '4': '右向き',
};
export const BREATHING: Record<Breathing, string> = { '1': 'あり', '2': '確認できず' };
export const COMPLEXION: Record<Complexion, string> = { '1': '通常', '2': '蒼白', '3': '紅潮', '4': 'その他' };
export const DEVELOPMENT_RESULT: Record<DevelopmentResult, string> = {
  '1': '確認できた', '2': '一部', '3': '未確認',
};
export const SHARE_STATUS: Record<ShareStatus, string> = { '0': '対象外', '1': '未連携', '2': '連携済' };
export const MEASURE_TYPE: Record<MeasureType, string> = { '1': '身長', '2': '体重' };
export const LINK_STATUS: Record<LinkStatus, string> = { '1': '有効', '2': '終了', '3': '猶予中' };
export const FUNCTION_TYPE: Record<FunctionType, string> = {
  '1': '日誌', '2': 'チャット', '3': '午睡', '4': '発達', '5': '身体測定', '6': '園児', '7': 'アカウント', '8': '連絡帳', '9': '設定',
};
export const OPERATION_TYPE: Record<OperationType, string> = {
  '1': '作成', '2': '変更', '3': '承認', '4': '削除', '5': '出力', '6': 'AIの下書き',
};

/*
 * リアクションの種別（t_chat_reaction.reaction_type）
 *
 * 【仮置き】要件定義書「チャットツール」(4-3) は「メッセージに絵文字で反応する」とだけ定め、
 * 使える絵文字を定めていない。動かすために4つを置いた（web/仮置き値.md）。
 * Go サーバ（server/api_chat.go の reactionTypes）と同じ並びにしてある。
 */
export const REACTION: Record<string, { emoji: string; label: string }> = {
  '1': { emoji: '👍', label: '了解' },
  '2': { emoji: '🙏', label: 'ありがとう' },
  '3': { emoji: '😊', label: 'うれしい' },
  '4': { emoji: '✅', label: '確認しました' },
};

/** 個人チャットのスレッドの状態（m_chat_room.thread_status） */
export const THREAD_STATUS: Record<string, string> = { '1': '未対応', '2': '対応済み' };

/** 配布物の種類（t_handout.handout_type） */
export const HANDOUT_TYPE: Record<string, string> = {
  '1': '園だより', '2': '献立表', '3': '行事のお知らせ', '4': 'クラスだより', '5': 'その他',
};

/** 異常時の記録の保護者への連絡（t_nap_abnormal.guardian_notice） */
export const GUARDIAN_NOTICE: Record<GuardianNotice, string> = { '1': 'した', '2': 'しない' };

/*
 * 保護者への連絡の手段（t_nap_abnormal.guardian_notice_method。基本設計書「午睡チェック」(5-7)）
 * 並びは選択肢の並び。午睡中の異常は電話で伝える（段4）ため電話を先頭に置き、
 * 連絡帳・個人チャットは電話のあとに経過を書く手段として後ろに置く
 * （PR #216 の 図/画面詳細図.md「異常時記録画面」(5-2) 項目13）。Go サーバ（server/api_nap.go の guardianNoticeMethods）と同じ並び
 */
export const GUARDIAN_NOTICE_METHOD: Record<GuardianNoticeMethod, string> = {
  '1': '電話', '2': 'お迎えのときに対面', '3': '連絡帳・個人チャット', '9': 'その他',
};
export const GUARDIAN_NOTICE_METHOD_ORDER: GuardianNoticeMethod[] = ['1', '2', '3', '9'];
