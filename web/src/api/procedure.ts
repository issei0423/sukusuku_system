/*
 * 手続き（パスワードの変更・規約への同意）を終えるまで、ほかの機能を使わせない
 * 典拠：基本設計書.md「画面遷移」(3-4)「変更・同意を完了するまで他の画面へ進めない」
 *      基本設計書.md「アカウント（m_account）」(5-2) is_temp_password「真の間は他機能を使わせない」
 *
 * 画面の出し分け（App.tsx の RequireStaff / RequireGuardian）は操作性のためであって、権限の担保ではない。
 * 担保はサーバ側（server/session.go の requireUser）が行い、手続きの API 以外を 403 で拒否して理由を kind で返す。
 * モック（api/mock.ts）も同じ規則を持つ（GitHub Issue #153）。
 *
 * 手続きの途中でも呼べるのは、手続きの画面（TopScreen・PasswordChangeScreen・TermsAgreeScreen）が呼ぶものだけである。
 * ログイン・ログアウト・自分の情報の取得（/api/me）・パスワードの変更・規約の本文と同意。
 * 参照表（/api/reference）は園児名・職員名を載せるため含めない。手続きを終えてから読み込む。
 */
import type { SessionUser } from './types';

/** 手続きを終えるまで拒否したときの理由。サーバが 403 と一緒に返す */
export type ProcedureKind = 'password_change_required' | 'terms_agreement_required';

/** 拒否の文言。サーバ側（server/session.go の requireUser）と同じにしてある */
export const procedureMessages: Record<ProcedureKind, string> = {
  password_change_required: '一時パスワードのままでは、ほかの機能は利用できません。パスワードを変更してください',
  terms_agreement_required: '利用規約に同意するまで、ほかの機能は利用できません。利用規約をご確認ください',
};

export function isProcedureKind(v: unknown): v is ProcedureKind {
  return v === 'password_change_required' || v === 'terms_agreement_required';
}

/**
 * その利用者がいま済ませるべき手続き。無ければ null。
 * 両方が要るときはパスワードの変更を先に求める（TopScreen が案内する順と同じ）
 */
export function pendingProcedure(u: Pick<SessionUser, 'is_temp_password' | 'terms_agreed'>): ProcedureKind | null {
  if (u.is_temp_password) return 'password_change_required';
  if (!u.terms_agreed) return 'terms_agreement_required';
  return null;
}

/** 手続きの途中で拒否されたことを表す失敗。文言はそのまま利用者に見せられる */
export class ProcedureRequiredError extends Error {
  readonly kind: ProcedureKind;
  constructor(kind: ProcedureKind, message: string = procedureMessages[kind]) {
    super(message);
    this.kind = kind;
  }
}

/*
 * 拒否されたことの知らせ
 *
 * ログイン中に管理者が一時パスワードを発行し直したときなど、画面が持つ利用者の情報が古いと、
 * 画面は進めたままサーバにだけ拒否される。知らせを受けた画面（App.tsx）は利用者を読み直し、
 * 手続きの画面へ案内する。
 */
type Listener = (kind: ProcedureKind) => void;
const listeners = new Set<Listener>();

/** 知らせを受け取る。戻り値を呼ぶと受け取りをやめる */
export function onProcedureRequired(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyProcedureRequired(kind: ProcedureKind): void {
  listeners.forEach((l) => l(kind));
}
