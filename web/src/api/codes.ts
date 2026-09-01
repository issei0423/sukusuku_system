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
export const LINK_STATUS: Record<LinkStatus, string> = { '1': '有効', '2': '終了' };
export const FUNCTION_TYPE: Record<FunctionType, string> = {
  '1': '日誌', '2': 'チャット', '3': '午睡', '4': '発達', '5': '身体測定', '6': '園児', '7': 'アカウント',
};
export const OPERATION_TYPE: Record<OperationType, string> = {
  '1': '作成', '2': '変更', '3': '承認', '4': '削除', '5': '出力',
};
