/*
 * API のモック実装
 *
 * ブラウザ内の mockDb を読み書きする。Go サーバを立てずに画面を動かすための実装であり、
 * テスト（web/tests/）はこちらを使う。実行時にどちらを使うかは api/client.ts が決める。
 *
 * 本ファイルの権限の判定は、Go サーバ（server/scope.go ほか）と同じ規則を持つ。
 * 【注意】同じ規則を2か所に持っているため、片方だけを直すと食い違う。
 * 規則を変えるときは必ず両方を直すこと。
 *
 * 画面側での出し分けは操作性のためであって、権限の担保ではない
 * （基本設計書.md「権限チェックの実装方針」(6-2)）。
 */
import * as db from './mockDb';
import { CURRENT_TERMS_VERSION } from './mockDb';
import type {
  Account, Child, ClassRoom, Diary, SessionUser, Role,
  InvitationCode, NapRecord, NapSession, NapAbnormal, PhysicalRecord, GrowthStandard,
  DevelopmentCheck, DevelopmentResultRecord, DevelopmentItem, ChatRoom, ChatMessage,
  OperationLog, Allergy, FunctionType, OperationType, Paged, Handout,
} from './types';
import {
  ageInMonths, now, today, addDays, plusMinutes, fromNowMinutes, napAutoCloseAt, normalizeInvitationCode, validateEmail,
  validateNewPassword, isRealDate, validateStaffAccountInput, formatYM, isOneDecimal,
} from './util';
import { BODY_POSITION, BREATHING, COMPLEXION, REACTION, HANDOUT_TYPE, SEX, PHOTO_CONSENT } from './codes';
import {
  ProcedureRequiredError, SESSION_ENDED_MESSAGE, notifyProcedureRequired, notifySessionEnded, pendingProcedure,
} from './procedure';
import type {
  LoginError, ChildInput, DiaryFilter, DiaryInput, DiaryAttachmentInput, ChatRoomView, NapChildState, DevListRow, CsvRow,
  DevDraftView,
} from './shapes';

// 画面はこれまでどおり client 経由で型を参照する。定義の実体は shapes.ts が持つ
export type {
  LoginError, ChildInput, DiaryFilter, DiaryInput, ChatRoomView, NapChildState, DevListRow, CsvRow,
};

/** 通信の代わり。画面側が非同期を前提に書けるようにする */
function ok<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 60));
}
function fail<T = never>(message: string): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 60));
}

/**
 * ログイン中の利用者を、もう通さないときの応答。サーバの 401（server/session.go の requireLogin）にあたる。
 * 画面（App.tsx）へ知らせて入口へ戻させる（api/procedure.ts の onSessionEnded。GitHub Issue #159）
 */
function sessionEnded<T = never>(): Promise<T> {
  notifySessionEnded();
  return fail(SESSION_ENDED_MESSAGE);
}

/* ============ 採番 ============ */
let seq = 10_000;
const nextId = () => ++seq;

/* ============ 参照の補助 ============ */
export const findChild = (id: string) => db.children.find((c) => c.child_id === id);
export const findStaff = (id: string) => db.staff.find((s) => s.staff_id === id);
export const findAccount = (id: number) => db.accounts.find((a) => a.account_id === id);
export const staffName = (id: string | null) => (id ? findStaff(id)?.staff_name ?? id : '―');
export const childName = (id: string | null) => (id ? findChild(id)?.child_name ?? id : '―');
export const className = (id: number | null) => (id ? db.classes.find((c) => c.class_id === id)?.class_name ?? '―' : '―');

/** アカウントの表示名。職員なら staff_name、保護者なら guardian_name */
export function accountName(accountId: number): string {
  const s = db.staff.find((x) => x.account_id === accountId);
  if (s) return s.staff_name;
  const g = db.guardians.find((x) => x.account_id === accountId);
  return g ? g.guardian_name : `アカウント${accountId}`;
}

/** 設定マスタの値。数値として解釈できなければ既定値へフォールバックし警告を出す（基本設計書 5-8） */
export function settingNumber(key: string, fallback: number): number {
  const row = db.settings.find((s) => s.setting_key === key);
  const n = Number(row?.setting_value);
  if (!row || Number.isNaN(n)) {
    console.warn(`[設定マスタ] ${key} を数値として解釈できません。既定値 ${fallback} を用います`);
    return fallback;
  }
  return n;
}
export function settingText(key: string, fallback: string): string {
  return db.settings.find((s) => s.setting_key === key)?.setting_value ?? fallback;
}

/**
 * 同意を履歴へ追記する。前の版に同意した行は消さない
 * （基本設計書「同意履歴（t_terms_agreement）」(5-2)）。
 * 同意は要配慮個人情報を取り扱う根拠であり、いつ・どの版に同意したかを後から示せる必要がある
 */
function recordTermsAgreement(accountId: number, agreedAt: string): void {
  const terms = db.termsDocs.find((t) => t.terms_version === CURRENT_TERMS_VERSION && t.document_type === '1');
  if (!terms) return;
  db.termsAgreements.push({
    terms_agreement_id: nextId(), account_id: accountId, terms_id: terms.terms_id, agreed_at: agreedAt,
  });
}

/* ============ 操作ログ ============
 * 記録する操作はサーバ側で決める。画面側から呼ばせない（基本設計書「監査への対応」(6-4)）
 */
function log(
  accountId: number, functionType: FunctionType, operationType: OperationType,
  table: string, targetId: number | null, childId: string | null,
  before: string | null, after: string | null,
): void {
  db.operationLogs.unshift({
    operation_log_id: nextId(), account_id: accountId, operated_at: now(),
    function_type: functionType, operation_type: operationType,
    target_table: table, target_id: targetId, target_child_id: childId,
    before_value: before, after_value: after,
  });
}

/*
 * 変更前後の値（基本設計書「操作ログ（t_operation_log）」(5-8)）
 * 「変更前後の値は JSON 文字列で保持する。変更のあった項目だけを {"項目名": 値} の形で入れる」。
 * 項目は並べた順に書く。サーバ側（server/oplog.go の fieldsJSON・changedFields）と同じ項目名・同じ順。
 * 【仮置き】ほかの操作の記録（日誌の「申請」、アカウントの「停止」など）は、まだ文で残している（web/仮置き値.md）
 */
type Field = [name: string, value: unknown];

function fieldsJSON(fields: Field[]): string {
  return JSON.stringify(Object.fromEntries(fields));
}

/** 変わった項目だけを、変更前と変更後の JSON 文字列にする。before と after は同じ項目を同じ順に並べて渡す */
function changedFields(before: Field[], after: Field[]): [string, string] {
  const changed = after.map((_, i) => i).filter((i) => JSON.stringify(before[i]?.[1]) !== JSON.stringify(after[i][1]));
  return [fieldsJSON(changed.map((i) => before[i])), fieldsJSON(changed.map((i) => after[i]))];
}

/**
 * 操作ログに残す園児の項目を、いま保存されている値で並べる。区分値は表示名にする。
 * サーバ側（server/api_child_write.go の childFieldsOf）と同じ項目・同じ順
 */
function childFields(childId: string): Field[] {
  const c = findChild(childId)!;
  const cc = db.classChildren.find((x) => x.child_id === childId
    && db.classes.some((k) => k.class_id === x.class_id && k.fiscal_year === db.FISCAL_YEAR));
  return [
    ['氏名', c.child_name],
    ['よみ', c.child_name_kana],
    ['生年月日', c.birth_date],
    ['性別', SEX[c.sex]],
    ['平熱', c.normal_temperature],
    ['写真の利用同意', PHOTO_CONSENT[c.photo_consent_level]],
    ['クラス', cc ? className(cc.class_id) : '所属クラスなし'],
    ['アレルギー', db.allergies.filter((a) => a.child_id === childId)
      .map((a) => `${a.target_food}（${a.symptom ?? ''}／${a.response ?? ''}）`)],
    ['既往歴', db.medicalHistories.filter((m) => m.child_id === childId).map((m) => m.content)],
  ];
}

/**
 * 日誌・午睡チェック・発達チェック・身体測定・チャットのいずれかの記録が紐づいているか
 * （基本設計書「園児情報の取消（誤登録の削除）」(4-4)）。論理削除した記録も、残っていて園児に紐づくため数える。
 * チャットは、その園児の個人チャットのメッセージ（取消したものを含む）を数える（【仮置き】web/仮置き値.md）。
 * サーバ側は server/api_child_write.go の childHasRecords
 */
function childHasRecords(childId: string): boolean {
  const personalRooms = new Set(db.chatRooms.filter((r) => r.room_type === '4' && r.child_id === childId)
    .map((r) => r.chat_room_id));
  return db.diaries.some((d) => d.child_id === childId)
    || db.napRecords.some((r) => r.child_id === childId)
    || db.napAbnormals.some((r) => r.child_id === childId)
    || db.developmentChecks.some((r) => r.child_id === childId)
    || db.physicalRecords.some((r) => r.child_id === childId)
    || db.chatMessages.some((m) => personalRooms.has(m.chat_room_id));
}

/**
 * 招待コードを発行できる園児か（取り消していない・在籍中）。一括発行の対象と同じ条件。
 * サーバ側は server/api_admin.go の childIssuable
 */
function childIssuable(childId: string): { found: boolean; issuable: boolean } {
  const c = findChild(childId);
  return { found: !!c, issuable: !!c && !c.is_deleted && c.enrollment_status === '1' };
}

/**
 * 操作の相手を、人が読める名前にする。園児に紐づかない操作（アカウントの停止、クラス日誌の承認など）は、
 * 対象園児の列だけでは誰・何に対する操作かが分からない（GitHub Issue #114）。
 * サーバ側（server/api_audit.go の targetLabel）と同じ規則を持つ。
 */
function targetLabel(table: string, targetId: number | null): string {
  if (targetId === null) return '';
  if (table === 'm_account' || table === 't_guardian_child') return accountName(targetId);
  if (table === 't_diary' || table === 't_diary_lock') {
    const d = db.diaries.find((x) => x.diary_id === targetId);
    if (!d) return '';
    const kind = { '1': '個人日誌', '2': 'クラス日誌', '3': '週案・月案', '4': 'ヒヤリハット' }[d.record_type];
    const who = d.child_id ? childName(d.child_id) : d.class_id ? className(d.class_id) : '';
    return [kind, who, d.diary_date].filter(Boolean).join(' ');
  }
  return '';
}

/**
 * その職員がそのクラスを扱えるか。一般（保育士）は自クラスに限る
 * （要件定義書「対象権限列の読み方」(4-2 冒頭)。サーバ側は server/scope.go の canUseClass）
 */
function canUseClass(user: SessionUser, classId: number): boolean {
  if (user.role === '1') return true;
  return user.role === '2' && user.class_id === classId;
}

/**
 * 【仮置き】招待コードの有効日数は 1〜365 日とする。0 や負の値を通すと、発行した時点で
 * 期限切れ・当日期限のコードができる（GitHub Issue #100）
 */
const INVITATION_DAYS_MESSAGE = '有効期限は 1〜365 日で指定してください';
const validInvitationDays = (days: number) => Number.isInteger(days) && days >= 1 && days <= 365;
// 一括発行の、園児1名あたりの枚数は 1〜5 枚（図/画面詳細図.md「招待コード管理画面」(7-7) 項目10）
const PER_CHILD_MESSAGE = '1名あたりの枚数は1〜5枚で指定してください';
const validPerChild = (n: number) => Number.isInteger(n) && n >= 1 && n <= 5;

/** ログイン中の職員。ログアウトのときに、保持している編集ロックを外すために持つ */
let loggedInStaffId: string | null = null;

/** 体温として入力しうる範囲（基本設計書「入力項目の制約値」(4-9)） */
const TEMPERATURE_MIN = 30.0;
const TEMPERATURE_MAX = 43.0;

/* ============ 権限（基本設計書「権限と利用可能機能」(6-1)） ============ */

/** 職員が参照できる園児か。一般（保育士）は自クラスに限る（要件定義書「対象権限列の読み方」(4-2 冒頭)） */
export function canSeeChild(user: SessionUser, childId: string): boolean {
  if (user.role === '1') return true;
  if (user.role === '2') {
    if (user.class_id == null) return false;
    return db.classChildren.some((cc) => cc.class_id === user.class_id && cc.child_id === childId);
  }
  // 保護者は有効な紐づけのある自児のみ
  if (!user.guardian_id) return false;
  return db.guardianChildren.some(
    (gc) => gc.guardian_id === user.guardian_id && gc.child_id === childId && gc.link_status === '1',
  );
}

/** 保護者の自児一覧。紐づけが終了したものは含めない */
export function childrenOfGuardian(guardianId: string): Child[] {
  return db.guardianChildren
    .filter((gc) => gc.guardian_id === guardianId && gc.link_status === '1')
    .map((gc) => findChild(gc.child_id))
    .filter((c): c is Child => !!c);
}

/** 職員が参照できる園児の一覧 */
export function visibleChildren(user: SessionUser): Child[] {
  const alive = db.children.filter((c) => !c.is_deleted && c.enrollment_status === '1');
  if (user.role === '1') return alive;
  if (user.role === '2') {
    if (user.class_id == null) return [];
    const ids = new Set(db.classChildren.filter((cc) => cc.class_id === user.class_id).map((cc) => cc.child_id));
    return alive.filter((c) => ids.has(c.child_id));
  }
  return user.guardian_id ? childrenOfGuardian(user.guardian_id) : [];
}

/** 職員が選べるクラス。一般は自クラスのみ（画面詳細図 3-1） */
export function selectableClasses(user: SessionUser): ClassRoom[] {
  const current = db.classes.filter((c) => c.fiscal_year === db.FISCAL_YEAR);
  if (user.role === '1') return current;
  return current.filter((c) => c.class_id === user.class_id);
}

/**
 * その日誌を参照できるか。個人日誌・ヒヤリハットは対象園児で、クラス日誌・週案は対象クラスで判定する。
 * 保護者に見えるのは、承認済みかつ保護者へ共有した自児の個人日誌のみ。承認済みであっても参照範囲は広がらない
 * （基本設計書「日誌の作成から保護者への共有」(4-5)）。クラス日誌・週案月案・ヒヤリハットは保護者への共有の
 * 対象外であり、共有の印が付いてしまったものがあっても見せない（同 (4-5)。GitHub Issue #157）。
 * サーバ側（server/api_diary.go の visibleDiaryCondition・canSeeDiary）と同じ規則
 */
function canSeeDiary(user: SessionUser, d: Diary): boolean {
  if (d.is_deleted) return false;
  if (user.role === '1') return true;
  if (user.role === '2') {
    if (d.child_id) return canSeeChild(user, d.child_id);
    return user.class_id != null && d.class_id === user.class_id;
  }
  return d.record_type === '1' && d.status === '3' && d.is_shared_to_guardian
    && !!d.child_id && canSeeChild(user, d.child_id);
}

/*
 * 申請したことを残す操作ログの「変更後」の文言。最後に申請した職員は、これで操作ログから引く（diaryApplicant）。
 * 申請と差し戻しの往復の経緯は操作ログで追うと定めているため（基本設計書「日誌（t_diary）」(5-4)）。
 * サーバ側（server/api_diary_write.go の diaryLogApply・diaryLogCreateAndApply）と同じ文言
 */
const DIARY_LOG_APPLY = '申請';
const DIARY_LOG_CREATE_AND_APPLY = '作成して申請';

/** その日誌を最後に申請した職員の職員ID。申請の記録が無ければ null（サーバ側は diaryApplicant） */
function diaryApplicant(diaryId: number): string | null {
  // 操作ログは新しいものが先頭（log が unshift する）
  const l = db.operationLogs.find((x) => x.function_type === '1' && x.target_table === 't_diary'
    && x.target_id === diaryId && (x.after_value === DIARY_LOG_APPLY || x.after_value === DIARY_LOG_CREATE_AND_APPLY));
  if (!l) return null;
  return db.staff.find((st) => st.account_id === l.account_id)?.staff_id ?? null;
}

/**
 * 保護者が見られない日誌を開いたときの文言。自児の共有されていない日誌・他児の日誌・無い日誌を同じ文言にし、
 * あるかどうかを推測させない（図/画面詳細図.md「共有日誌閲覧画面」(2-8)）。
 * サーバ側（server/api_diary.go の unsharedDiaryMessage）と同じ文言
 */
const UNSHARED_DIARY_MESSAGE = 'この記録は共有されていません';

/** 職員に限る操作を、保護者が呼んだときの文言。サーバ側（server/session.go の requireStaff）と同じ */
const STAFF_ONLY_MESSAGE = '職員のみが行えます';

/* ============ 認証（基本設計書「共通基盤：ログインとアカウント」(4-3)） ============ */

function buildSessionUser(a: Account): SessionUser {
  const s = db.staff.find((x) => x.account_id === a.account_id);
  const g = db.guardians.find((x) => x.account_id === a.account_id);
  const cs = s ? db.classStaff.find((x) => x.staff_id === s.staff_id
    && db.classes.some((c) => c.class_id === x.class_id && c.fiscal_year === db.FISCAL_YEAR)) : undefined;
  return {
    account_id: a.account_id,
    email: a.email,
    role: a.role,
    display_name: s?.staff_name ?? g?.guardian_name ?? a.email,
    staff_id: s?.staff_id ?? null,
    guardian_id: g?.guardian_id ?? null,
    class_id: cs?.class_id ?? null,
    class_name: cs ? className(cs.class_id) : null,
    is_temp_password: a.is_temp_password,
    terms_agreed: a.terms_version === CURRENT_TERMS_VERSION,
  };
}

export const authApi = {
  /**
   * ログイン
   * @param entrance 開いた入口。保護者用トップと職員用トップは同じ様式で入口だけが異なる（画面詳細図 2-1）
   */
  async login(email: string, password: string, entrance: 'staff' | 'guardian'): Promise<SessionUser> {
    const a = db.accounts.find((x) => x.email === email);
    const max = settingNumber('auth.max_failed_login', 5);

    if (!a) return fail(JSON.stringify({ kind: 'credential', remaining: max } satisfies LoginError));

    if (a.locked_until && a.locked_until > now()) {
      return fail(JSON.stringify({ kind: 'locked', until: a.locked_until } satisfies LoginError));
    }

    if (a.password_hash !== password) {
      a.failed_login_count += 1;
      // ログインの失敗と、失敗が続いたことによるロックを操作ログに残す（GitHub Issue #115）。
      // 成功とログアウトは残さない。操作者の欄には、試されたアカウントを入れる（本人とは限らない）。
      // サーバ側（server/api_auth.go の handleLogin）と同じ扱い
      const attempt = `続けて ${a.failed_login_count} 回目`;
      if (a.failed_login_count >= max) {
        const mins = settingNumber('auth.lock_minutes', 30);
        a.locked_until = fromNowMinutes(mins);
        log(a.account_id, '7', '2', 'm_account', a.account_id, null, null,
          `ログインに失敗（${attempt}）。失敗が続いたためロック`);
        return fail(JSON.stringify({ kind: 'locked', until: a.locked_until } satisfies LoginError));
      }
      log(a.account_id, '7', '2', 'm_account', a.account_id, null, null, `ログインに失敗（${attempt}）`);
      return fail(JSON.stringify({ kind: 'credential', remaining: max - a.failed_login_count } satisfies LoginError));
    }

    // 停止の判定は、パスワードの照合のあとに行う。照合より前に行うと、パスワードを知らない人にも
    // 停止中のアカウントがあることを示してしまう（GitHub Issue #159。server/api_auth.go の handleLogin と同じ順）
    if (a.status === '2') return fail(JSON.stringify({ kind: 'suspended' } satisfies LoginError));

    // 系統の判定。職員用トップからは保護者を、保護者用トップからは職員を通さない
    const isStaffAccount = a.role === '1' || a.role === '2';
    if (entrance === 'staff' && !isStaffAccount) {
      return fail(JSON.stringify({ kind: 'wrong_entrance', correct: 'guardian' } satisfies LoginError));
    }
    if (entrance === 'guardian' && isStaffAccount) {
      return fail(JSON.stringify({ kind: 'wrong_entrance', correct: 'staff' } satisfies LoginError));
    }

    // 一時パスワードでのログインなら、有効期限内かを判定する。期限切れなら管理者への連絡を案内する
    // （基本設計書「ログイン」(4-3)、メッセージ一覧 (4-9)。GitHub Issue #159）
    if (a.is_temp_password && a.temp_password_expires_at && a.temp_password_expires_at < now()) {
      return fail(JSON.stringify({ kind: 'temp_expired' } satisfies LoginError));
    }

    a.failed_login_count = 0;
    a.locked_until = null;
    const sessionUser = buildSessionUser(a);
    loggedInStaffId = sessionUser.staff_id;
    return ok(sessionUser);
  },

  /** パスワードの変更。一時パスワードの状態を解除する */
  async changePassword(accountId: number, current: string, next: string): Promise<void> {
    const a = findAccount(accountId);
    if (!a) return fail('アカウントが見つかりません');
    if (a.status === '2') return sessionEnded();
    if (a.password_hash !== current) return fail('現在のパスワードが違います');
    // 現在と同じパスワードへの変更は認めない（基本設計書「パスワードの要件」(6-3)）
    if (next === current) return fail('現在と同じパスワードは使えません。別のパスワードを入力してください。');
    // 8〜128文字（文字数で数える）。よく使われるパスワードは拒否する（server/password.go と同じ規則。GitHub Issue #159）
    const passwordError = validateNewPassword(next);
    if (passwordError) return fail(passwordError);
    a.password_hash = next;
    a.is_temp_password = false;
    a.temp_password_expires_at = null;
    a.updated_at = now();
    log(accountId, '7', '2', 'm_account', accountId, null, null, 'パスワードを変更');
    return ok(undefined);
  },

  /** 利用規約への同意。最新版でなければ再同意を求める（基本設計書 5-2） */
  async agreeTerms(accountId: number): Promise<void> {
    const a = findAccount(accountId);
    if (!a) return fail('アカウントが見つかりません');
    if (a.status === '2') return sessionEnded();
    a.terms_version = CURRENT_TERMS_VERSION;
    a.terms_agreed_at = now();
    recordTermsAgreement(accountId, a.terms_agreed_at);
    log(accountId, '7', '2', 'm_account', accountId, null, null, `規約 ${CURRENT_TERMS_VERSION} に同意`);
    return ok(undefined);
  },

  async currentTerms() {
    return ok(db.termsDocs.find((t) => t.terms_version === CURRENT_TERMS_VERSION)!);
  },

  /**
   * ページを開き直したときにセッションを復元する。
   * モックはメモリ上にしか状態を持たないため、常に未ログインとして返す
   */
  async bootstrap(): Promise<SessionUser | null> {
    return ok(null);
  },

  /**
   * ログアウト。保持している編集ロックをすべて外す。
   * ロックを持ったままログアウトすると、ほかの職員が無操作の経過まで保存できなくなる
   * （基本設計書「編集ロックの解除」(4-5)、GitHub Issue #110）
   */
  async logout(): Promise<void> {
    if (loggedInStaffId) {
      for (let i = db.diaryLocks.length - 1; i >= 0; i--) {
        if (db.diaryLocks[i].locked_staff_id === loggedInStaffId) db.diaryLocks.splice(i, 1);
      }
    }
    loggedInStaffId = null;
    return ok(undefined);
  },

  /** ログイン中の利用者を組み直す。パスワード変更・規約同意のあと画面を進めるために使う */
  async reloadSession(accountId: number): Promise<SessionUser> {
    const a = findAccount(accountId);
    if (!a) return fail('アカウントが見つかりません');
    // 停止中のアカウントは、ログイン中であっても通さない（server/session.go の requireLogin。GitHub Issue #159）
    if (a.status === '2') return sessionEnded();
    return ok(buildSessionUser(a));
  },
};

/* ============ 園児マスター（基本設計書「共通基盤：園児マスターの管理」(4-4)） ============ */

/**
 * 氏名と生年月日が同じ園児。同じ子を重ねて登録しようとしていないかを知らせるために使う（GitHub Issue #144 の 2）。
 * 園児IDは使われている番号の次が自動で入るため、同じ子の二重登録は園児IDの重複では防げない。
 * 【仮置き】知らせるだけで、登録は止めない。氏名は空白（半角・全角）とタブを除いて比べる。取り消した園児
 * （誤登録の取消）は比べず、退園・卒園した園児は比べる（web/仮置き値.md「同じ氏名・生年月日の園児の知らせ」）。
 * サーバ側（server/api_child_write.go の sameNameBirthChildren）と同じ規則
 */
function findSameNameBirthChildren(childName: string, birthDate: string): Child[] {
  const key = childNameKey(childName);
  if (!key || !birthDate) return [];
  return db.children
    .filter((c) => !c.is_deleted && c.birth_date === birthDate && childNameKey(c.child_name) === key)
    .sort((a, b) => (a.child_id < b.child_id ? -1 : a.child_id > b.child_id ? 1 : 0));
}

/** 氏名を比べるための形。「大城 ひなた」を、全角の空白で書いても空白なしで書いても同じに扱う（server/api_child_write.go の childNameKey） */
function childNameKey(name: string): string {
  return name.replace(/[ \u3000\t]/g, '');
}

export const childApi = {
  async listChildren(user: SessionUser, filter: { classId?: number; name?: string } = {}): Promise<Child[]> {
    let rows = visibleChildren(user);
    if (filter.classId) {
      const ids = new Set(db.classChildren.filter((cc) => cc.class_id === filter.classId).map((cc) => cc.child_id));
      rows = rows.filter((c) => ids.has(c.child_id));
    }
    if (filter.name) {
      const q = filter.name.trim();
      rows = rows.filter((c) => c.child_name.includes(q) || c.child_name_kana.includes(q));
    }
    return ok([...rows].sort((a, b) => a.child_name_kana.localeCompare(b.child_name_kana, 'ja')));
  },

  /*
   * 園児情報・アレルギー・既往歴は、保護者には返さない（基本設計書「権限と利用可能機能」(6-1)「園児情報の参照｜保護者 ×」
   * 「既往歴の参照｜保護者 ×」「アレルギー一覧の参照｜保護者 ×」。GitHub Issue #157）。保護者の画面はどれも使っていない。
   * サーバ側は server/api_child.go の handleGetChild・handleAllergiesOf・handleMedicalHistoriesOf（requireStaff）
   */
  async getChild(user: SessionUser, childId: string): Promise<Child> {
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    const c = findChild(childId);
    return c ? ok(c) : fail('園児が見つかりません');
  },

  async allergiesOf(user: SessionUser, childId: string): Promise<Allergy[]> {
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    return ok(db.allergies.filter((a) => a.child_id === childId));
  },

  /**
   * アレルギー一覧画面は全園児が対象（画面詳細図 7-1 の補足）。一般にも自クラスの制限をかけないが、保護者には返さない
   * （基本設計書「権限と利用可能機能」(6-1)「アレルギー一覧の参照｜保護者 ×・一般 ○※2」。GitHub Issue #177 の 3）。
   * 【仮置き】並びは園児のよみ順（web/仮置き値.md「一覧の並び順」。GitHub Issue #177 の 7）。
   * サーバ側は server/api_child.go の handleAllAllergies
   */
  async allAllergies(user: SessionUser): Promise<{ child: Child; className: string; allergies: Allergy[] }[]> {
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    const rows = db.children
      .filter((c) => !c.is_deleted && c.enrollment_status === '1')
      .sort((a, b) => a.child_name_kana.localeCompare(b.child_name_kana, 'ja'))
      .map((c) => ({
        child: c,
        className: className(db.classChildren.find((cc) => cc.child_id === c.child_id)?.class_id ?? null),
        allergies: db.allergies.filter((a) => a.child_id === c.child_id),
      }))
      .filter((r) => r.allergies.length > 0);
    return ok(rows);
  },

  async medicalHistoriesOf(user: SessionUser, childId: string) {
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    return ok(db.medicalHistories.filter((m) => m.child_id === childId));
  },

  /**
   * 園児の所属クラス。その園児を参照できる人に限る。クラス番号だけでも、園児IDがあるかどうかと
   * 所属が分かるため（基本設計書「権限チェックの実装方針」(6-2)。サーバ側は server/api_child.go の handleClassOfChild）
   */
  async classOf(user: SessionUser, childId: string): Promise<number | null> {
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    return ok(db.classChildren.find((cc) => cc.child_id === childId)?.class_id ?? null);
  },

  /** 登録・編集は管理者のみ（画面詳細図 7-1） */
  async saveChild(user: SessionUser, input: ChildInput, mode: 'create' | 'edit'): Promise<Child> {
    if (user.role !== '1') return fail('園児情報の登録・編集は管理者のみが行えます');
    if (!input.child_id.trim()) return fail('園児IDを入力してください');
    if (!input.child_name.trim()) return fail('氏名を入力してください');
    // 【仮置き】よみを必須とする。一覧の並びと検索がよみに頼っているため（GitHub Issue #119）
    if (!input.child_name_kana.trim()) return fail('よみを入力してください');
    if (tooLong(input.child_name, 50) || tooLong(input.child_name_kana, 50)) {
      return fail('氏名とよみは、それぞれ50文字以内で入力してください');
    }
    if (!isKana(input.child_name_kana)) return fail('よみは、ひらがなで入力してください');
    if (!input.birth_date || input.birth_date > today()) return fail('生年月日に未来日は指定できません');
    // アレルギーは対象だけでは配膳の場で使えない。症状と対応まで揃えて登録する（GitHub Issue #119）
    const incomplete = input.allergies.find((a) => a.target_food.trim() && (!a.symptom.trim() || !a.response.trim()));
    if (incomplete) return fail(`アレルギー「${incomplete.target_food.trim()}」の症状と対応を入力してください`);

    const existing = findChild(input.child_id);
    if (mode === 'create' && existing) return fail('その園児IDはすでに使われています');
    if (mode === 'edit' && !existing) return fail('園児が見つかりません');

    const before = existing ? childFields(input.child_id) : null;
    const row: Child = {
      child_id: input.child_id,
      child_name: input.child_name,
      child_name_kana: input.child_name_kana,
      birth_date: input.birth_date,
      sex: input.sex,
      normal_temperature: input.normal_temperature,
      enrollment_status: existing?.enrollment_status ?? '1',
      photo_consent_level: input.photo_consent_level,
      is_deleted: false,
      created_at: existing?.created_at ?? now(),
      updated_at: now(),
    };
    if (existing) Object.assign(existing, row);
    else db.children.push(row);

    // クラス在籍の付け替え
    const idx = db.classChildren.findIndex((cc) => cc.child_id === input.child_id);
    if (idx >= 0) db.classChildren[idx].class_id = input.class_id;
    else db.classChildren.push({ class_id: input.class_id, child_id: input.child_id });

    // アレルギー・既往歴は入力内容で置き換える
    for (let i = db.allergies.length - 1; i >= 0; i--) {
      if (db.allergies[i].child_id === input.child_id) db.allergies.splice(i, 1);
    }
    input.allergies.filter((a) => a.target_food.trim()).forEach((a) => {
      db.allergies.push({ allergy_id: nextId(), child_id: input.child_id, ...a });
    });
    for (let i = db.medicalHistories.length - 1; i >= 0; i--) {
      if (db.medicalHistories[i].child_id === input.child_id) db.medicalHistories.splice(i, 1);
    }
    input.medical_histories.filter((m) => m.trim()).forEach((content) => {
      db.medicalHistories.push({ medical_history_id: nextId(), child_id: input.child_id, content });
    });

    /*
     * 操作ログには、変更のあった項目だけを {"項目名": 値} の JSON で残す（基本設計書「操作ログ（t_operation_log）」(5-8)）。
     * 氏名と生年月日だけを残すと、クラス・アレルギー・平熱を変えても前後が同じに見える（GitHub Issue #166 の 5）。
     * サーバ側は server/api_child_write.go の handleSaveChild
     */
    const after = childFields(input.child_id);
    if (before) {
      const [b, a] = changedFields(before, after);
      log(user.account_id, '6', '2', 'm_child', null, input.child_id, b, a);
    } else {
      log(user.account_id, '6', '1', 'm_child', null, input.child_id, null, fieldsJSON(after));
    }
    return ok(row);
  },

  /** 園児IDがすでに使われているか。入力の時点で重複を知らせるために使う（GitHub Issue #121） */
  async childIdExists(user: SessionUser, childId: string): Promise<boolean> {
    if (user.role !== '1') return fail('園児情報の登録・編集は管理者のみが行えます');
    return ok(db.children.some((c) => c.child_id === childId.trim()));
  },

  /**
   * 氏名と生年月日が同じ園児。登録の確認画面で、重ねて登録していないかを知らせるために使う（GitHub Issue #144 の 2）。
   * サーバ側は server/api_child_write.go の handleSameNameBirthChildren
   */
  async sameNameBirthChildren(user: SessionUser, childName: string, birthDate: string): Promise<Child[]> {
    if (user.role !== '1') return fail('園児情報の登録・編集は管理者のみが行えます');
    return ok(findSameNameBirthChildren(childName, birthDate.trim()));
  },

  /** 誤登録の取消。論理削除とする（基本設計書 5-1）。サーバ側は server/api_child_write.go の handleRemoveChild */
  async removeChild(user: SessionUser, childId: string): Promise<void> {
    if (user.role !== '1') return fail('園児情報の取消は管理者のみが行えます');
    const c = findChild(childId);
    // 取り消した園児は「見つからない」として扱う。同じ取消を重ねて受けて、操作ログに 2 行残さない（GitHub Issue #166 の 4）
    if (!c || c.is_deleted) return fail('園児が見つかりません');
    // 記録のある園児は取り消せない。在籍の終了（退園・卒園）は在籍状態の変更で行う
    // （基本設計書「園児情報の取消（誤登録の削除）」(4-4)、文言は「メッセージ一覧」(4-9)「取消の不可」）
    if (childHasRecords(childId)) return fail('記録が登録されている園児は取り消せません。在籍状態を変更してください。');
    c.is_deleted = true;
    c.updated_at = now();
    log(user.account_id, '6', '4', 'm_child', null, childId, c.child_name, '取消（論理削除）');
    return ok(undefined);
  },
};

/* ============ 日誌システム（基本設計書「日誌システム」(4-5)） ============ */

export const diaryApi = {
  async listDiaries(user: SessionUser, f: DiaryFilter = {}): Promise<Paged<Diary>> {
    const perPage = settingNumber('paging.diary_per_page', 50);

    // 個人日誌・ヒヤリハットは対象園児で、クラス日誌・週案は対象クラスで参照範囲を判定する。
    // 保護者は、承認済みかつ共有した自児の個人日誌だけ（サーバ側の visibleDiaryCondition と同じ。GitHub Issue #157）
    let rows = db.diaries.filter((d) => canSeeDiary(user, d));

    if (f.recordType) rows = rows.filter((d) => d.record_type === f.recordType);
    // 個人日誌・ヒヤリハットは対象園児の在籍クラスで、クラス日誌・週案は対象クラスで絞る。参照範囲と同じ考え方にする。
    // 対象のクラスで絞ると、以前の版でクラスを空けて保存した個人日誌が、見られるのに一覧に出なかった
    // （GitHub Issue #174。サーバ側は server/api_diary.go の handleListDiaries）
    if (f.classId) {
      const classId = f.classId;
      rows = rows.filter((d) => (d.child_id
        ? db.classChildren.some((cc) => cc.class_id === classId && cc.child_id === d.child_id)
        : d.class_id === classId));
    }
    if (f.status) rows = rows.filter((d) => d.status === f.status);
    // 【仮置き】自分が書いた日誌に絞る。職員ダッシュボードの「差し戻された日誌」（自分が書いたものを数える）から
    // 開いた一覧を、数えた日誌と一致させるため（図/画面詳細図.md「職員ダッシュボード」(2-6) 項目2。GitHub Issue #174）
    if (f.mine && user.staff_id) rows = rows.filter((d) => d.created_staff_id === user.staff_id);
    if (f.from) rows = rows.filter((d) => d.diary_date >= f.from!);
    if (f.to) rows = rows.filter((d) => d.diary_date <= f.to!);

    rows.sort((a, b) => b.diary_date.localeCompare(a.diary_date) || b.diary_id - a.diary_id);
    const page = f.page ?? 1;
    return ok({ rows: rows.slice((page - 1) * perPage, page * perPage), total: rows.length, page, per_page: perPage });
  },

  async getDiary(user: SessionUser, diaryId: number): Promise<Diary> {
    const d = db.diaries.find((x) => x.diary_id === diaryId && !x.is_deleted);
    // 保護者には、見られない日誌を「この記録は共有されていません」と示す（画面詳細図 2-8。GitHub Issue #157）
    if (user.role === '3' && (!d || !canSeeDiary(user, d))) return fail(UNSHARED_DIARY_MESSAGE);
    if (!d) return fail('日誌が見つかりません');
    if (!canSeeDiary(user, d)) return fail('この日誌を参照する権限がありません');
    // 記入した職員・確認した職員の氏名を載せる。Go サーバ（server/api_diary.go の enrich）と同じ
    // 最後に申請した職員は、職員にだけ返す（承認画面が使う。サーバ側の handleGetDiary と同じ）
    const applied = user.role === '3' ? null : diaryApplicant(d.diary_id);
    return ok({
      ...d,
      staff_name: staffName(d.created_staff_id),
      approved_staff_name: d.approved_staff_id ? staffName(d.approved_staff_id) : null,
      ...(applied ? { applied_staff_id: applied } : {}),
    });
  },

  async templates(): Promise<typeof db.diaryTemplates> { return ok(db.diaryTemplates); },
  async phrases(): Promise<string[]> { return ok(db.fixedPhrases); },
  /**
   * 日誌の添付。日誌本体と同じ参照範囲に従う（基本設計書「日誌の作成から保護者への共有」(4-5)・
   * 「添付ファイルの実体の保存先」(5-5)）。サーバ側は server/api_diary.go の handleDiaryAttachments
   */
  async attachmentsOf(user: SessionUser, diaryId: number) {
    const d = db.diaries.find((x) => x.diary_id === diaryId);
    if (!d || !canSeeDiary(user, d)) return fail('この日誌を参照する権限がありません');
    return ok(db.diaryAttachments.filter((a) => a.diary_id === diaryId));
  },

  /**
   * その園児の過去の記録。前回の記述を見ながら書けるようにする（画面詳細図 3-2）
   * 職員の編集画面のための経路であり、保護者には使わせない。下書き・申請中・差し戻し（理由を含む）・ヒヤリハットまで、
   * 共有していない日誌がすべて返るため（基本設計書 6-1 ※3「自児のみ、かつ共有されたものに限る」。GitHub Issue #157）。
   * サーバ側は server/api_diary.go の handlePastDiaries
   */
  async pastDiariesOf(user: SessionUser, childId: string, excludeDiaryId?: number): Promise<Diary[]> {
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    return ok(db.diaries
      .filter((d) => !d.is_deleted && d.child_id === childId && d.diary_id !== excludeDiaryId)
      .sort((a, b) => b.diary_date.localeCompare(a.diary_date)));
  },

  /**
   * 編集ロックの取得。取得のたびにトークンを発行し、保存時に照合する（基本設計書 5-4）
   * すでに他者が保持していれば、その職員名を返して画面に出す
   */
  async acquireLock(user: SessionUser, diaryId: number): Promise<{ token: string } | { heldBy: string }> {
    // ロックを取れるのは、その日誌を参照できる職員に限る（サーバ側は server/api_diary_write.go の handleAcquireLock）
    const d = db.diaries.find((x) => x.diary_id === diaryId);
    if (!d || !canSeeDiary(user, d)) return fail('この日誌を編集する権限がありません');
    const idle = settingNumber('ui.diary_lock_minutes', 15);
    const held = db.diaryLocks.find((l) => l.diary_id === diaryId);
    if (held && held.locked_staff_id !== user.staff_id) {
      const idleUntil = plusMinutes(held.last_active_at, idle);
      if (idleUntil > now()) return ok({ heldBy: staffName(held.locked_staff_id) });
    }
    const token = `lock-${diaryId}-${nextId()}`;
    const row = { diary_id: diaryId, lock_token: token, locked_staff_id: user.staff_id!, locked_at: now(), last_active_at: now() };
    if (held) Object.assign(held, row); else db.diaryLocks.push(row);
    return ok({ token });
  },

  /**
   * ロックの解除。管理者による強制解除はレコードを削除する（基本設計書「編集ロックの解除」(4-5)）。
   * 本人の解除は、取得のときに渡した識別子が一致するときだけ外す。同じ職員が取り直したあとに、古い識別子の解除が
   * 遅れて届いても、取り直したロックを外さないため（GitHub Issue #166。サーバ側は handleReleaseLock）
   */
  async releaseLock(user: SessionUser, diaryId: number, force = false, token?: string): Promise<void> {
    const i = db.diaryLocks.findIndex((l) => l.diary_id === diaryId);
    if (i < 0) return ok(undefined);
    if (force && user.role !== '1') return fail('ロックの強制解除は管理者のみが行えます');
    if (!force && (db.diaryLocks[i].locked_staff_id !== user.staff_id || db.diaryLocks[i].lock_token !== token)) {
      return ok(undefined);
    }
    db.diaryLocks.splice(i, 1);
    if (force) log(user.account_id, '1', '2', 't_diary_lock', diaryId, null, 'ロックあり', '管理者が強制解除');
    return ok(undefined);
  },

  /**
   * 編集画面での操作を知らせ、ロックの最終操作時刻を進める。無操作の判定は最後の操作から数える
   * （基本設計書「編集ロックの解除」(4-5)、5-4 last_active_at「無操作の判定に用いる」。GitHub Issue #166 の 3）。
   * ロックが外れた・ほかの職員へ移ったときは断り、画面に解除を知らせる。サーバ側は handleTouchLock
   */
  async touchLock(user: SessionUser, diaryId: number, token: string): Promise<void> {
    const l = heldDiaryLock(user, diaryId, token);
    if (!l) return fail(LOCK_RELEASED_MESSAGE);
    l.last_active_at = now();
    return ok(undefined);
  },

  /**
   * 編集ロックの状態。誰が編集中かは日誌の中身と同じ範囲で見せる（サーバ側は handleLockOf）。
   * ロックの識別子は返さない。識別子は取得した本人だけが持ち、保存のときに照合するもの（GitHub Issue #166 の 2）
   */
  async lockOf(user: SessionUser, diaryId: number) {
    const d = db.diaries.find((x) => x.diary_id === diaryId);
    if (!d || !canSeeDiary(user, d)) return fail('この日誌を参照する権限がありません');
    const l = db.diaryLocks.find((x) => x.diary_id === diaryId);
    return ok(l ? {
      diary_id: l.diary_id, locked_staff_id: l.locked_staff_id, locked_at: l.locked_at,
      last_active_at: l.last_active_at, staff_name: staffName(l.locked_staff_id),
    } : null);
  },
};

// 文言は基本設計書「メッセージ一覧」(4-9)「ロックの解除」による
const LOCK_RELEASED_MESSAGE = '編集ロックが解除されました。内容を再読み込みしてください';

/**
 * その職員が、渡した識別子のロックをいま持っていれば、そのロックを返す。
 * 無操作の時間を過ぎていても、ほかの職員が取り直すまでは本人の識別子を有効とみなす（【仮置き】web/仮置き値.md）。
 * サーバ側は server/api_diary_write.go の holdsDiaryLock
 */
function heldDiaryLock(user: SessionUser, diaryId: number, token: string | undefined) {
  if (!token) return undefined;
  return db.diaryLocks.find((l) => l.diary_id === diaryId && l.lock_token === token
    && l.locked_staff_id === user.staff_id);
}

/**
 * 日誌に付ける写真を確かめ、断る理由を返す（問題が無ければ null）。
 * 写真は設定マスタの上限（attachment.max_count_diary、既定 3 枚）まで、形式は attachment.allowed_types（JPEG・PNG）に限る
 * （基本設計書「雛形・添付」(5-4)「t_diary_attachment｜1〜3枚」・「設定マスタ」(5-8)、
 * 図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目10）。文言は【仮置き】。
 * サーバ側は server/api_diary_write.go の checkDiaryAttachments
 */
function diaryAttachmentError(photos: DiaryAttachmentInput[]): string | null {
  const max = settingNumber('attachment.max_count_diary', 3);
  if (photos.length > max) return `写真は${max}枚までです`;
  // 設定マスタの並びに空白が混じっていても（「image/jpeg, image/png」）、並べた形式を受け付ける
  const allowed = settingText('attachment.allowed_types', 'image/jpeg,image/png').split(',').map((x) => x.trim());
  for (const p of photos) {
    if (!p.file_path.trim()) return '写真のファイルを選んでください';
    if (!allowed.includes(p.file_type)) return '添付できる写真は JPEG・PNG のファイルです';
  }
  return null;
}

/** 日誌の写真を、渡した並びで置き換える（サーバ側は server/api_diary_write.go の replaceDiaryAttachments） */
function replaceDiaryAttachments(diaryId: number, photos: DiaryAttachmentInput[]): void {
  for (let i = db.diaryAttachments.length - 1; i >= 0; i--) {
    if (db.diaryAttachments[i].diary_id === diaryId) db.diaryAttachments.splice(i, 1);
  }
  photos.forEach((p) => {
    db.diaryAttachments.push({
      diary_attachment_id: nextId(), diary_id: diaryId, file_path: p.file_path.trim(), file_type: p.file_type,
    });
  });
}

const diaryApi2 = {
  /** 下書き保存・申請。status は呼び出し側が指定する */
  async saveDiary(user: SessionUser, input: DiaryInput, status: '1' | '2'): Promise<Diary> {
    if (!input.body.trim()) return fail('本文を入力してください');
    if (tooLong(input.body, 2000)) return fail('本文は2,000文字以内で入力してください');
    // 記録日は当日まで。形の崩れた値も断る（基本設計書「入力項目の制約値」(4-9)、
    // 図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目6。GitHub Issue #174）
    if (!isISODate(input.diary_date)) return fail('記録日の形式が正しくありません');
    if (input.diary_date > today()) return fail('記録日に未来日は指定できません');
    const needsChild = input.record_type === '1' || input.record_type === '4';
    if (needsChild) {
      if (!input.child_id) return fail('対象の園児を選んでください');
      if (!canSeeChild(user, input.child_id)) return fail('この園児の日誌を作成する権限がありません');
    }
    // 対象のクラスは、記録種別によらず必須とする（図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目5。GitHub Issue #174）。
    // クラス日誌・週案は対象クラスで参照範囲を判定する。一般が扱えるのは自クラスに限る
    // （要件定義書「参照範囲の全体規定」(4-1-5)）。サーバ側は server/api_diary_write.go の handleSaveDiary
    if (input.class_id == null) return fail('対象のクラスを選んでください');
    if (!canUseClass(user, input.class_id)) return fail('このクラスの日誌を作成する権限がありません');
    // 【仮置き】個人日誌・ヒヤリハットの対象のクラスは、対象の園児が在籍するクラスに限る（web/仮置き値.md）
    const classId = input.class_id;
    if (needsChild && !db.classChildren.some((cc) => cc.class_id === classId && cc.child_id === input.child_id)) {
      return fail('対象のクラスは、対象の園児が在籍するクラスを選んでください');
    }
    // 写真は、日誌と一緒に保存する。画面で足した写真が日誌に付かず、確認画面の「写真 n 枚」と承認画面が
    // 食い違っていた（GitHub Issue #175 の 2）。サーバ側は server/api_diary_write.go の checkDiaryAttachments
    const photos = input.attachments;
    if (photos) {
      const msg = diaryAttachmentError(photos);
      if (msg) return fail(msg);
    }

    if (input.diary_id) {
      const d = db.diaries.find((x) => x.diary_id === input.diary_id);
      if (!d) return fail('日誌が見つかりません');
      // 書き換える日誌そのものも参照範囲の内に限る。他クラスの日誌を日誌IDで指定して書き換えさせない
      if (!canSeeDiary(user, d)) return fail('この日誌を編集する権限がありません');
      // 申請中・承認済みは編集できない（サーバ側の updateDiary と同じ。GitHub Issue #174 の「確かめていないこと」）
      if (d.status === '2' || d.status === '3') return fail('申請中または承認済みの日誌は編集できません');
      /*
       * 保存時のロック識別子が、現在有効なロックと一致するかを照合する。ロックが無いときも一致しないとみなし、
       * 他者の更新の有無にかかわらず拒否する。識別子が一致しても、ロックを持つ本人でなければ通さない
       * （基本設計書「同時編集の検出」(4-2)・「編集ロックの解除」(4-5)、GitHub Issue #166 の 1・2）。
       * サーバ側は server/api_diary_write.go の updateDiary
       */
      const lock = heldDiaryLock(user, d.diary_id, input.lock_token);
      if (!lock) return fail(LOCK_RELEASED_MESSAGE);
      const before = `${d.status}`;
      if (photos) replaceDiaryAttachments(d.diary_id, photos);
      d.record_type = input.record_type;
      d.child_id = input.child_id;
      d.class_id = input.class_id;
      d.diary_date = input.diary_date;
      d.body = input.body;
      d.status = status;
      // 差し戻す理由は、再申請しても消さない。承認されるまで残し、次に差し戻されたときに上書きする
      // （基本設計書「日誌（t_diary）」(5-4)。GitHub Issue #174）
      d.updated_at = now();
      // 申請したらロックを外す（申請中の日誌は編集できない）。下書き保存は編集画面に残って書き続けるため外さず、
      // 操作として最終操作時刻を進める（【仮置き】web/仮置き値.md「日誌の編集ロックの動き」）
      if (status === '2') db.diaryLocks.splice(db.diaryLocks.indexOf(lock), 1);
      else lock.last_active_at = now();
      log(user.account_id, '1', '2', 't_diary', d.diary_id, d.child_id, before,
        status === '2' ? DIARY_LOG_APPLY : '下書き保存');
      return ok(d);
    }

    const row: Diary = {
      diary_id: nextId(),
      record_type: input.record_type,
      child_id: input.child_id,
      class_id: input.class_id,
      diary_date: input.diary_date,
      body: input.body,
      status,
      created_staff_id: user.staff_id!,
      approved_staff_id: null, approved_at: null,
      is_shared_to_guardian: false, shared_at: null,
      nap_abnormal_id: null, returned_reason: null,
      is_deleted: false, created_at: now(), updated_at: now(),
    };
    db.diaries.unshift(row);
    if (photos) replaceDiaryAttachments(row.diary_id, photos);
    log(user.account_id, '1', '1', 't_diary', row.diary_id, row.child_id, null,
      status === '2' ? DIARY_LOG_CREATE_AND_APPLY : '下書き作成');
    return ok(row);
  },

  /** 承認待ちの一覧。管理者のみ（画面詳細図 2-4） */
  async pendingDiaries(user: SessionUser): Promise<Diary[]> {
    if (user.role !== '1') return fail('承認は管理者のみが行えます');
    return ok(db.diaries.filter((d) => !d.is_deleted && d.status === '2')
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at)));
  },

  /**
   * 承認。保護者への共有の指定を同じ操作で受け取る（画面詳細図 3-3）
   * 承認後に別画面で指定させると共有し忘れが起きるため
   */
  async approveDiary(user: SessionUser, diaryId: number, shareToGuardian: boolean): Promise<Diary> {
    if (user.role !== '1') return fail('承認は管理者のみが行えます');
    const d = db.diaries.find((x) => x.diary_id === diaryId);
    if (!d) return fail('日誌が見つかりません');
    if (d.status !== '2') return fail('申請中の日誌のみ承認できます');
    // 共有を選べるのは個人日誌だけ。クラス日誌・週案月案・ヒヤリハットは保護者への共有の対象外とする
    // （基本設計書「日誌システム」(4-5)。GitHub Issue #61・#157）。サーバ側は server/api_diary_write.go の handleApproveDiary
    if (shareToGuardian && d.record_type !== '1') {
      return fail('保護者へ共有できるのは個人日誌だけです。共有しないで承認してください');
    }
    // 自分が申請した日誌は承認できない（基本設計書「日誌の作成から保護者への共有」(4-5)。演習上の想定。GitHub Issue #106）。
    // 作成者だけでなく、最後に申請した職員も見る。担任の下書きを書き直して申請した管理者が、
    // 自分で承認して保護者へ共有できていた（GitHub Issue #174）。サーバ側は server/api_diary_write.go の handleApproveDiary
    if (d.created_staff_id === user.staff_id || diaryApplicant(d.diary_id) === user.staff_id) {
      return fail('自分が申請した日誌は承認できません。ほかの管理者に承認を依頼してください');
    }

    d.status = '3';
    d.approved_staff_id = user.staff_id;
    d.approved_at = now();
    d.returned_reason = null;
    d.is_shared_to_guardian = shareToGuardian;
    d.shared_at = shareToGuardian ? now() : null;
    d.updated_at = now();
    log(user.account_id, '1', '3', 't_diary', d.diary_id, d.child_id, '申請中',
      shareToGuardian ? '承認済み・保護者へ共有' : '承認済み・共有しない');

    // 共有する場合、個人チャットへ日誌の共有としてメッセージを流す（基本設計書 5-5 source_type=2）。
    // 個人チャットは園児ID で引く。部屋の名前で探すと、同じ氏名の別の園児の家庭へ流れる（GitHub Issue #163）
    if (shareToGuardian && d.child_id) {
      const room = db.chatRooms.find((r) => r.room_type === '4' && r.child_id === d.child_id);
      if (room) {
        db.chatMessages.push({
          chat_message_id: nextId(), chat_room_id: room.chat_room_id, sender_account_id: user.account_id,
          body: '日誌を共有しました。', source_type: '2', source_id: d.diary_id, sent_at: now(),
          edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null,
        });
      }
    }
    return ok(d);
  },

  /** 差し戻し。理由の入力を必須とする（画面詳細図 3-3） */
  async returnDiary(user: SessionUser, diaryId: number, reason: string): Promise<Diary> {
    if (user.role !== '1') return fail('差し戻しは管理者のみが行えます');
    if (!reason.trim()) return fail('差し戻す理由を入力してください');
    if (tooLong(reason, 500)) return fail('差し戻す理由は500文字以内で入力してください');
    const d = db.diaries.find((x) => x.diary_id === diaryId);
    if (!d) return fail('日誌が見つかりません');
    if (d.status !== '2') return fail('申請中の日誌のみ差し戻せます');
    d.status = '4';
    d.returned_reason = reason;
    d.approved_staff_id = user.staff_id;
    d.updated_at = now();
    log(user.account_id, '1', '3', 't_diary', d.diary_id, d.child_id, '申請中', `差し戻し：${reason}`);
    return ok(d);
  },

  /**
   * 園児タイムライン。記録を時系列で並べる。職員の画面のための経路であり、保護者には使わせない
   * （pastDiariesOf と同じ。サーバ側は server/api_diary.go の handleTimeline。GitHub Issue #157）
   */
  async timelineOf(user: SessionUser, childId: string): Promise<Diary[]> {
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    return ok(db.diaries
      .filter((d) => !d.is_deleted && d.child_id === childId)
      .sort((a, b) => b.diary_date.localeCompare(a.diary_date)));
  },
};

/* ============ チャットツール（基本設計書「チャットツール」(4-6)） ============ */

export const chatApi = {
  /**
   * 参加しているチャンネル。left_at が入っていても職員は参照できる（基本設計書 5-5）。
   * 外れたチャンネルは閲覧のみとし、外れるまでの過去ログだけを見せる（GitHub Issue #161。server/api_chat.go と同じ）
   */
  async rooms(user: SessionUser): Promise<ChatRoomView[]> {
    const isStaff = user.role === '1' || user.role === '2';
    const mine = db.chatMembers.filter((m) => m.account_id === user.account_id
      && (isStaff || m.left_at === null));

    const views = mine.map((m) => {
      const room = db.chatRooms.find((r) => r.chat_room_id === m.chat_room_id)!;
      const unread = db.chatMessages.filter((msg) =>
        msg.chat_room_id === room.chat_room_id
        && !msg.is_deleted
        && !hiddenBeforeJoined(user, msg)
        && !hiddenAfterLeft(user, msg)
        && msg.sender_account_id !== user.account_id
        && !db.chatReads.some((r) => r.chat_message_id === msg.chat_message_id && r.account_id === user.account_id),
      ).length;

      // 園全体は管理者のみ投稿できる。保護者は個人チャットのみ送受信できる
      let canPost = true;
      if (room.room_type === '1') canPost = user.role === '1';
      if (user.role === '3') canPost = room.room_type === '4';
      // 外れたチャンネルへは投稿できない（図/画面詳細図.md「グループ編成画面」(4-3) No.8）
      const left = m.left_at !== null;
      if (left) canPost = false;

      // 参加している保護者の人数。投稿が保護者にも届くことを入力欄の近くで示すために使う。
      // 実際に読める保護者の数なので、停止中の保護者は数えない（GitHub Issue #171。api_chat.go の activeGuardianWhere）
      const guardianCount = db.chatMembers.filter((x) =>
        x.chat_room_id === room.chat_room_id && x.left_at === null && isActiveGuardian(x.account_id)).length;

      return { room, unread, canPost, guardianCount, left };
    });

    const order: Record<string, number> = { '1': 0, '5': 1, '2': 2, '3': 3, '4': 4 };
    views.sort((a, b) => order[a.room.room_type] - order[b.room.room_type]
      || a.room.chat_room_id - b.room.chat_room_id);
    return ok(views);
  },

  async messages(user: SessionUser, roomId: number): Promise<ChatMessage[]> {
    const member = db.chatMembers.find((m) => m.chat_room_id === roomId && m.account_id === user.account_id);
    if (!member) return fail('このチャンネルを参照する権限がありません');
    // 保護者は left_at が入った時点で参照できなくなる（基本設計書 5-5）
    if (user.role === '3' && member.left_at) return fail('このチャンネルは参照できません');
    // 送信者名を添える。保護者はアカウントの名簿を参照できないため、画面側では引けない
    // （サーバ側の api_chat.go も同じ扱い。片方だけ直すと食い違う）
    const isStaff = user.role === '1' || user.role === '2';
    const roomType = db.chatRooms.find((r) => r.chat_room_id === roomId)?.room_type ?? '';
    // 外れた職員には、外れたあとの投稿を返さない（GitHub Issue #161）
    return ok(db.chatMessages.filter((m) => m.chat_room_id === roomId
      && !hiddenBeforeJoined(user, m) && !hiddenAfterLeft(user, m))
      .sort((a, b) => a.sent_at.localeCompare(b.sent_at))
      .map((m) => ({
        ...m,
        sender_name: accountName(m.sender_account_id),
        // 職員か保護者かを吹き出しに添えるために返す（GitHub Issue #141。api_chat.go の SenderRole と同じ）
        sender_role: findAccount(m.sender_account_id)?.role,
        // 既読の人数は職員にだけ添える。保護者側には表示しないため、そもそも返さない（基本設計書 5-5。api_chat.go と同じ）
        ...(isStaff ? { read_count: readCountOf(m.chat_message_id, roomType) } : {}),
        reactions: reactionSummary(m.chat_message_id, user.account_id),
      })));
  },

  /**
   * リアクションを付ける・外す。同じ種別をもう一度選ぶと外れる
   * （要件定義書「チャットツール」(4-3)。全ロールが使える）
   */
  async toggleReaction(user: SessionUser, messageId: number, reactionType: string): Promise<void> {
    if (!(reactionType in REACTION)) return fail('リアクションの指定が正しくありません');
    const m = db.chatMessages.find((x) => x.chat_message_id === messageId);
    if (!m) return fail('メッセージが見つかりません');
    const member = db.chatMembers.find((x) => x.chat_room_id === m.chat_room_id && x.account_id === user.account_id);
    if (!member || (user.role === '3' && member.left_at)) return fail('このチャンネルを参照する権限がありません');
    // 外れたチャンネルの過去ログには反応できない。閲覧のみである（GitHub Issue #161）
    if (member.left_at) return fail(LEFT_ROOM_MESSAGE);
    // 後から登録した保護者には、登録より前のメッセージを見せない。見えないものには反応もできない
    // （GitHub Issue #100）。存在を知らせないよう、見つからないときと同じ応答にする
    if (hiddenBeforeJoined(user, m)) return fail('メッセージが見つかりません');
    if (m.is_deleted) return fail('取り消したメッセージには反応できません');

    const i = db.chatReactions.findIndex((r) =>
      r.chat_message_id === messageId && r.account_id === user.account_id && r.reaction_type === reactionType);
    if (i >= 0) db.chatReactions.splice(i, 1);
    else {
      db.chatReactions.push({
        chat_reaction_id: nextId(), chat_message_id: messageId,
        account_id: user.account_id, reaction_type: reactionType,
      });
    }
    return ok(undefined);
  },

  /**
   * 個人チャットのスレッドを「未対応／対応済み」に切り替える（要件定義書「チャットツール」(4-3)）
   * 職員だけが切り替えられる。保護者から新しく受信したときは、自動で未対応へ戻る
   */
  async setThreadStatus(user: SessionUser, roomId: number, status: '1' | '2'): Promise<void> {
    if (user.role === '3') return fail('未対応スレッドの管理は職員のみが行えます');
    if (status !== '1' && status !== '2') return fail('状態の指定が正しくありません');
    const room = db.chatRooms.find((r) => r.chat_room_id === roomId);
    const member = db.chatMembers.find((x) => x.chat_room_id === roomId && x.account_id === user.account_id);
    if (!room || !member) return fail('このチャンネルを参照する権限がありません');
    // 外れた個人チャット（前のクラスの家庭など）の状態は切り替えられない（GitHub Issue #161・#162）
    if (member.left_at) return fail(LEFT_ROOM_MESSAGE);
    if (room.room_type !== '4') return fail('未対応／対応済みを持つのは個人チャットだけです');
    const before = room.thread_status;
    room.thread_status = status;
    log(user.account_id, '2', '2', 'm_chat_room', roomId, null,
      before === '1' ? '未対応' : before === '2' ? '対応済み' : null, status === '1' ? '未対応' : '対応済み');
    return ok(undefined);
  },

  /** 既読は人数で示す。保護者側には表示しない（基本設計書 5-5）。数え方は messages の read_count と同じ */
  async readCount(messageId: number): Promise<number> {
    const m = db.chatMessages.find((x) => x.chat_message_id === messageId);
    const roomType = db.chatRooms.find((r) => r.chat_room_id === m?.chat_room_id)?.room_type ?? '';
    return ok(readCountOf(messageId, roomType));
  },

  async markRead(user: SessionUser, roomId: number): Promise<void> {
    const member = db.chatMembers.find((x) => x.chat_room_id === roomId && x.account_id === user.account_id);
    if (!member || (user.role === '3' && member.left_at)) return fail('このチャンネルを参照する権限がありません');
    // 既読にするのは読めるメッセージだけ。外れた職員の、外れたあとの投稿は含めない（GitHub Issue #161）。
    // 後から登録した保護者の、登録より前のやりとりも含めない。見えていないものを既読にすると、誤送信のときに
    // 既読が付いていたかの判断を誤らせる（基本設計書「既読確認」(4-6)・「チャット」(5-5)。GitHub Issue #171）
    db.chatMessages
      .filter((m) => m.chat_room_id === roomId && m.sender_account_id !== user.account_id && !m.is_deleted
        && !hiddenAfterLeft(user, m) && !hiddenBeforeJoined(user, m))
      .forEach((m) => {
        const already = db.chatReads.some((r) => r.chat_message_id === m.chat_message_id && r.account_id === user.account_id);
        if (!already) {
          db.chatReads.push({ chat_read_id: nextId(), chat_message_id: m.chat_message_id, account_id: user.account_id, read_at: now() });
        }
      });
    return ok(undefined);
  },

  async send(user: SessionUser, roomId: number, body: string): Promise<ChatMessage> {
    if (!body.trim()) return fail('メッセージを入力してください');
    // 編集と同じ上限（基本設計書「入力項目の制約値」(4-9)）
    if (tooLong(body, 1000)) return fail('本文は1,000文字以内で入力してください');
    const rooms = await chatApi.rooms(user);
    const view = rooms.find((r) => r.room.chat_room_id === roomId);
    if (!view) return fail('このチャンネルを参照する権限がありません');
    // 外れたチャンネルへは投稿できない。閲覧のみの権限では拒否する
    // （基本設計書「メッセージの送受信」(4-6)、図/画面詳細図.md 4-3 No.8。GitHub Issue #161）
    if (view.left) return fail(LEFT_ROOM_MESSAGE);
    if (!view.canPost) return fail('このチャンネルへは投稿できません');

    const msg: ChatMessage = {
      chat_message_id: nextId(), chat_room_id: roomId, sender_account_id: user.account_id,
      body, source_type: '1', source_id: null, sent_at: now(),
      edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null,
    };
    db.chatMessages.push(msg);
    // 保護者から新しく受信した個人チャットは、自動で未対応へ戻す（要件定義書「チャットツール」(4-3)）
    if (user.role === '3' && view.room.room_type === '4') view.room.thread_status = '1';
    log(user.account_id, '2', '1', 't_chat_message', msg.chat_message_id, null, null, '送信');
    return ok(msg);
  },

  /** 取消。本文を残さず、取消の事実だけを残す（基本設計書「誤送信への対応」(4-6)） */
  async retract(user: SessionUser, messageId: number): Promise<void> {
    const m = db.chatMessages.find((x) => x.chat_message_id === messageId);
    if (!m) return fail('メッセージが見つかりません');
    if (m.sender_account_id !== user.account_id && user.role !== '1') {
      return fail('自分が送信したメッセージのみ取り消せます');
    }
    // 外れたチャンネルのメッセージは、送った本人でも取り消せない（閲覧のみ。GitHub Issue #161）。
    // 誤送信への対応は管理者が行う（基本設計書「誤送信への対応」(4-6)）ため、管理者は参加を問わない
    if (user.role !== '1' && !isParticipant(user, m.chat_room_id)) return fail(LEFT_ROOM_MESSAGE);
    // 取り消した日時と操作ログを上書き・重複させない（GitHub Issue #100）
    if (m.is_deleted) return fail('このメッセージはすでに取り消されています');
    const before = m.body;
    m.is_deleted = true;
    m.body = '';
    m.deleted_at = now();
    m.deleted_account_id = user.account_id;
    log(user.account_id, '2', '4', 't_chat_message', messageId, null, before, '取消');
    return ok(undefined);
  },

  async edit(user: SessionUser, messageId: number, body: string): Promise<void> {
    // 空の本文は受け付けない。上限は新規送信と同じ（基本設計書「入力項目の制約値」(4-9)）
    if (!body.trim()) return fail('本文を入力してください');
    if ([...body].length > 1000) return fail('本文は1,000文字以内で入力してください');
    const m = db.chatMessages.find((x) => x.chat_message_id === messageId);
    if (!m) return fail('メッセージが見つかりません');
    /*
     * 編集できるのは送信者本人。園チャット（room_type=1）だけは例外で、管理者同士なら互いに編集できる
     * （基本設計書「メッセージの編集」(4-6)）。園全体への発信は園としての意思表示であり、
     * 発信者個人のものではないため。園チャットへ投稿できるのは管理者だけなので、
     * 送信者の権限を改めて調べる必要はない
     */
    const room = db.chatRooms.find((r) => r.chat_room_id === m.chat_room_id);
    const schoolWide = room?.room_type === '1' && user.role === '1';
    if (m.sender_account_id !== user.account_id && !schoolWide) {
      return fail('自分が送信したメッセージのみ編集できます');
    }
    // 外れたチャンネルのメッセージは、送った本人でも編集できない。編集はいまの参加者が読む本文を
    // 書き換えるため、投稿と同じく閲覧のみの権限では拒否する（GitHub Issue #161）
    if (!isParticipant(user, m.chat_room_id)) return fail(LEFT_ROOM_MESSAGE);
    // 取り消し済みのものは編集できない（基本設計書「メッセージの編集」(4-6)）
    if (m.is_deleted) return fail('取り消したメッセージは編集できません');
    const before = m.body;
    m.body = body;
    m.edited_at = now();
    log(user.account_id, '2', '2', 't_chat_message', messageId, null, before, body);
    return ok(undefined);
  },

  /**
   * メンバー。続柄は職員にだけ返す。お迎えに来る人が誰なのかを職員が確かめられるようにするため
   * （基本設計書「チャット」(5-5)）
   */
  async members(roomId: number, viewer?: SessionUser) {
    // 参加していないチャンネルのメンバーは返さない。ほかの家庭の保護者の氏名や続柄が読めてしまう
    // （GitHub Issue #95）。外れた人にも、いまの参加者は返さない（外れたあとのことは見せない。#161）。
    // 管理者は、グループ編成のために全チャンネルを参照できる。
    // 画面からは必ず viewer を渡す。渡さない呼び出しはテストのためだけに残している
    if (viewer && viewer.role !== '1' && !isParticipant(viewer, roomId)) {
      return fail('このチャンネルを参照する権限がありません');
    }
    const forStaff = !!viewer && viewer.role !== '3';
    // 停止中の保護者は、読めないため並べない（GitHub Issue #171・#141）。停止中の職員は除かない
    // （目的別グループの編成は、いまの参加者を初期値にして送るため。api_chat.go の handleChatMembers と同じ）
    return ok(db.chatMembers.filter((m) => m.chat_room_id === roomId && m.left_at === null
      && !(findAccount(m.account_id)?.role === '3' && !isActiveGuardian(m.account_id)))
      .map((m) => {
        const role = findAccount(m.account_id)?.role ?? '2';
        return {
          account_id: m.account_id, name: accountName(m.account_id), role,
          relationship: role === '3' && forStaff ? relationshipOf(m.account_id) : null,
        };
      }));
  },
};

/**
 * 読める保護者か。停止中の保護者（紐づけを終えて有効な紐づけがゼロになった人など）は、参加の行が残っていても
 * ログインできず読めないため、「保護者 n 名にも届きます」の n とメンバー欄に入れない（GitHub Issue #171・#141）。
 * 【仮置き】参加の行（left_at）は動かさず、数えるときに除く。Go サーバ（server/api_chat.go の activeGuardianWhere）と同じ
 */
function isActiveGuardian(accountId: number): boolean {
  const a = findAccount(accountId);
  return a?.role === '3' && a.status === '1';
}

/**
 * 既読の人数。保護者が参加するチャンネル（園全体・クラスグループ・個人チャット）では保護者の既読だけを数える。
 * 既読確認は、園が送ったものを保護者が開いたかを職員が確かめるためのもの（要件定義書「チャットツール」(4-3)
 * 「既読確認」、基本設計書「既読確認」(4-6)）。職員の既読を混ぜると「保護者 n 名にも届きます」と並んだ人数が
 * 読んだ家庭の数に見える（GitHub Issue #171）。
 * 【仮置き】職員だけのチャンネル（職員チャット・目的別グループ）は職員の既読を数える。
 * Go サーバ（server/api_chat.go の readCountRoles）と同じ規則にしてある
 */
function readCountOf(messageId: number, roomType: string): number {
  const guardianRoom = roomType === '1' || roomType === '2' || roomType === '4';
  return db.chatReads.filter((r) => r.chat_message_id === messageId
    && (findAccount(r.account_id)?.role === '3') === guardianRoom).length;
}

/**
 * 保護者に見せないメッセージか
 *
 * 後から登録した保護者には、登録より前の個人チャットのやりとりを見せない
 * （基本設計書「チャット」(5-5)）。先に登録していた保護者は、自分の書いたものが
 * 後から加わる人に読まれることを知らないため。職員には適用しない。
 * Go サーバ（server/api_chat.go の beforeJoinedClause）と同じ規則にしてある。
 */
function hiddenBeforeJoined(user: SessionUser, m: ChatMessage): boolean {
  if (user.role !== '3') return false;
  const room = db.chatRooms.find((r) => r.chat_room_id === m.chat_room_id);
  if (room?.room_type !== '4') return false;
  const member = db.chatMembers.find((x) => x.chat_room_id === m.chat_room_id && x.account_id === user.account_id);
  // 【仮置き】時刻は秒の単位で持つため、登録と同じ秒のメッセージは前か後かを区別できない。
  // 見せない側へ倒す（GitHub Issue #102）。見せる側へ倒すと、登録の直前に送られたものが読めてしまう
  return !!member && m.sent_at <= member.joined_at;
}

/**
 * チャンネルから外れた人に見せないメッセージか
 *
 * 外れたあとの投稿は参照させない。読めるのは所属していた期間の過去ログだけである
 * （図/画面詳細図.md「グループ編成画面」(4-3) No.8、基本設計書「メッセージの送受信」(4-6)。GitHub Issue #161）。
 * 保護者は外れた時点でチャンネルごと参照できなくなるため、実際に効くのは職員である。
 * Go サーバ（server/api_chat.go の afterLeftClause）と同じ規則にしてある。
 */
function hiddenAfterLeft(user: SessionUser, m: ChatMessage): boolean {
  const member = db.chatMembers.find((x) => x.chat_room_id === m.chat_room_id && x.account_id === user.account_id);
  // 【仮置き】外れたのと同じ秒に送られたメッセージは、外れる前か後かを区別できない。見せない側へ倒す
  return !!member?.left_at && m.sent_at >= member.left_at;
}

/**
 * いまそのチャンネルに参加しているか（外れていないか）。
 * 投稿・編集・取消・リアクション・未対応の切り替え・メンバー一覧の取得は、いまの参加者に限る
 * （基本設計書「メッセージの送受信」(4-6)「閲覧のみの権限では拒否する」。server/api_chat.go の isParticipant）
 */
function isParticipant(user: SessionUser, roomId: number): boolean {
  const member = db.chatMembers.find((x) => x.chat_room_id === roomId && x.account_id === user.account_id);
  return !!member && member.left_at === null;
}

/** 外れたチャンネルへ書こうとしたときの知らせ */
const LEFT_ROOM_MESSAGE = 'このチャンネルからは外れているため、閲覧のみです';

/**
 * 職員1人のチャットの参加を、アカウント・ロール・担任の割り当てから決まる規則に合わせる（GitHub Issue #162）
 *
 *   園全体・職員チャット … 有効な全職員（職員チャットは作成・停止に連動する。基本設計書「チャット」(5-5)）
 *   クラス・個人チャット … そのクラスの当年度の担任と、管理者（要件定義書「チャットツール」(4-3)）
 *   目的別グループ       … ここでは決めない。グループ編成画面で手で編成する
 *
 * 停止した職員は、自動構成のチャンネルからすべて外れる。外れるときは left_at を入れ、戻るときは入れ直す。
 * アーカイブ（過年度のクラスグループ）は動かさない。
 * 【仮置き】個人チャットの担任は、ルームの class_id（園児のクラス）で決める（名前で引くと同じ氏名の園児を取り違えるため）。
 * Go サーバ（server/chat_membership.go の syncStaffChatRooms）と同じ規則にしてある。片方だけ直すと食い違う。
 */
function syncStaffChatRooms(accountId: number): void {
  const a = findAccount(accountId);
  if (!a || (a.role !== '1' && a.role !== '2')) return;
  const staffId = db.staff.find((s) => s.account_id === accountId)?.staff_id;
  const myClasses = new Set(db.classStaff
    .filter((cs) => cs.staff_id === staffId
      && db.classes.some((c) => c.class_id === cs.class_id && c.fiscal_year === db.FISCAL_YEAR))
    .map((cs) => cs.class_id));
  const auto = db.chatRooms.filter((r) => !r.is_archived && ['1', '2', '4', '5'].includes(r.room_type));
  const wanted = new Set(a.status !== '1' ? [] : auto
    .filter((r) => r.room_type === '1' || r.room_type === '5' || a.role === '1'
      || (r.class_id !== null && myClasses.has(r.class_id)))
    .map((r) => r.chat_room_id));

  for (const r of auto) {
    const cur = db.chatMembers.find((m) => m.chat_room_id === r.chat_room_id && m.account_id === accountId);
    if (wanted.has(r.chat_room_id)) {
      if (!cur) db.chatMembers.push({ chat_room_id: r.chat_room_id, account_id: accountId, joined_at: now(), left_at: null });
      else if (cur.left_at) { cur.left_at = null; cur.joined_at = now(); }
    } else if (cur && cur.left_at === null) {
      cur.left_at = now();
    }
  }
}

/**
 * 目的別グループへ入れられない相手が含まれていれば、その理由を返す（server/api_chat.go の groupMemberError と同じ）。
 * 入れられるのは職員だけで、保護者は入れない（基本設計書「チャット」(5-5)、図/画面詳細図.md 4-3 No.6）。
 * 新しく加えるのは有効な職員に限る。【仮置き】すでに参加している職員は、停止していてもそのまま残せる
 */
function groupMemberError(ids: Iterable<number>, current: Set<number>): string | null {
  for (const id of ids) {
    const a = findAccount(id);
    if (!a) return '存在しないアカウントが含まれています';
    if (a.role !== '1' && a.role !== '2') return '目的別グループに入れられるのは職員だけです。保護者は入れられません';
    if (a.status !== '1' && !current.has(id)) return '停止している職員は加えられません';
  }
  return null;
}

/** 保護者アカウントの続柄。有効な紐づけのものを、重複を除いて並べる */
function relationshipOf(accountId: number): string | null {
  const g = db.guardians.find((x) => x.account_id === accountId);
  if (!g) return null;
  const list = Array.from(new Set(db.guardianChildren
    .filter((gc) => gc.guardian_id === g.guardian_id && gc.link_status === '1' && gc.relationship)
    .map((gc) => gc.relationship))).sort();
  return list.length > 0 ? list.join('・') : null;
}

/** メッセージに付いたリアクションを種別ごとに数える */
function reactionSummary(messageId: number, accountId: number) {
  const rows = db.chatReactions.filter((r) => r.chat_message_id === messageId);
  return Object.keys(REACTION)
    .map((type) => ({
      reaction_type: type,
      count: rows.filter((r) => r.reaction_type === type).length,
      mine: rows.some((r) => r.reaction_type === type && r.account_id === accountId),
    }))
    .filter((x) => x.count > 0);
}

const chatApi2 = {
  /** 目的別グループの作成とメンバーの編成（グループ編成画面） */
  async createGroup(user: SessionUser, name: string, accountIds: number[]): Promise<ChatRoom> {
    if (user.role === '3') return fail('グループの編成は職員のみが行えます');
    if (!name.trim()) return fail('グループ名を入力してください');
    if (tooLong(name, 50)) return fail('グループ名は50文字以内で入力してください');
    const ids = new Set([...accountIds, user.account_id]);
    // 入れられるのは有効な職員だけ。保護者は入れない（GitHub Issue #161）
    const invalid = groupMemberError(ids, new Set());
    if (invalid) return fail(invalid);
    const room: ChatRoom = {
      chat_room_id: nextId(), room_type: '3', class_id: null,
      room_name: name, is_archived: false, thread_status: null,
    };
    db.chatRooms.push(room);
    ids.forEach((account_id) => db.chatMembers.push({
      chat_room_id: room.chat_room_id, account_id, joined_at: now(), left_at: null,
    }));
    log(user.account_id, '2', '1', 'm_chat_room', room.chat_room_id, null, null, `グループ「${name}」を作成`);
    return ok(room);
  },

  /**
   * メンバーの追加・退出。退出は left_at を入れて所属期間を残す（基本設計書 5-5）。
   * 編成できるのは目的別グループだけ。クラス・個人・職員・園全体のチャンネルの参加者は、担任の割り当てと
   * アカウントから自動で決まる（要件定義書「チャットツール」(4-3) 機能一覧・(a)、syncStaffChatRooms）。
   * 【仮置き】一般は、いま参加している目的別グループだけを編成できる。参加していないグループに自分を
   * 加えられると、所属したことのないグループの過去ログが読めてしまう（同 (c)）。管理者はすべて。
   * server/api_chat.go の handleUpdateGroupMembers と同じ規則（GitHub Issue #161）
   */
  async updateGroupMembers(user: SessionUser, roomId: number, accountIds: number[]): Promise<void> {
    if (user.role === '3') return fail('グループの編成は職員のみが行えます');
    const room = db.chatRooms.find((r) => r.chat_room_id === roomId);
    if (!room) return fail('グループが見つかりません');
    if (room.room_type !== '3') {
      return fail('メンバーを編成できるのは目的別グループだけです。クラス・個人・職員・園全体のチャンネルの参加者は、担任の割り当てとアカウントから自動で決まります');
    }
    if (user.role !== '1' && !isParticipant(user, roomId)) return fail('参加していないグループは編成できません');
    const target = new Set(accountIds);
    const current = new Set(db.chatMembers
      .filter((m) => m.chat_room_id === roomId && m.left_at === null).map((m) => m.account_id));
    const invalid = groupMemberError(target, current);
    if (invalid) return fail(invalid);
    db.chatMembers
      .filter((m) => m.chat_room_id === roomId && m.left_at === null && !target.has(m.account_id))
      .forEach((m) => { m.left_at = now(); });
    target.forEach((account_id) => {
      const cur = db.chatMembers.find((m) => m.chat_room_id === roomId && m.account_id === account_id);
      if (!cur) db.chatMembers.push({ chat_room_id: roomId, account_id, joined_at: now(), left_at: null });
      else if (cur.left_at) { cur.left_at = null; cur.joined_at = now(); }
    });
    log(user.account_id, '2', '2', 't_chat_member', roomId, null, null, 'メンバーを編成');
    return ok(undefined);
  },

  /**
   * グループ編成画面に並べる目的別グループ。管理者にはすべて（要件定義書「チャットツール」(4-3) (c)）、
   * 一般には、いま参加しているグループだけを返す。編成できるのはそれだけであり、参加していないグループの
   * メンバーは返さないため（図/画面詳細図.md「グループ編成画面」(4-3)。GitHub Issue #172）。
   * server/api_chat.go の handleChatGroups と同じ規則
   */
  async groups(user: SessionUser): Promise<ChatRoom[]> {
    if (user.role === '3') return fail('グループの編成は職員のみが行えます');
    return ok(db.chatRooms.filter((r) => r.room_type === '3'
      && (user.role === '1' || isParticipant(user, r.chat_room_id))));
  },

  /**
   * 目的別グループへ入れられる相手（有効な職員）。
   * グループの編成は一般（保育士）にも認めている（基本設計書の権限一覧）。管理者向けのアカウント一覧は
   * 一般には返さないため、候補を別に用意する。目的別グループは職員だけのものなので、保護者は含めない
   */
  async groupCandidates(user: SessionUser) {
    if (user.role === '3') return fail('グループの編成は職員のみが行えます');
    return ok(db.accounts.filter((a) => a.role !== '3' && a.status === '1')
      .map((a) => ({ account_id: a.account_id, name: accountName(a.account_id), role: a.role })));
  },

  /** 誤送信への対応の記録。管理者のみ（画面詳細図 3-2 の一覧に対応） */
  async misdeliveryRecords(user: SessionUser) {
    if (user.role !== '1') return fail('誤送信対応の記録は管理者のみが参照できます');
    return ok(db.misdeliveryRecords.map((r) => {
      const m = db.chatMessages.find((x) => x.chat_message_id === r.chat_message_id);
      const room = m ? db.chatRooms.find((x) => x.chat_room_id === m.chat_room_id) : undefined;
      return { ...r, room_name: room?.room_name ?? '―', staff_name: staffName(r.staff_id) };
    }));
  },

  async addMisdeliveryRecord(
    user: SessionUser,
    input: { chat_message_id: number; occurred_at: string; was_read: boolean; response: string },
  ): Promise<void> {
    if (user.role !== '1') return fail('誤送信対応の記録は管理者のみが行えます');
    if (!input.response.trim()) return fail('とった対応を入力してください');
    if (tooLong(input.response, 1000)) return fail('とった対応は1,000文字以内で入力してください');
    // 発生日時は必須（図/画面詳細図.md「誤送信対応記録画面（管理者）」(4-4) 項目3）。記録した時刻で埋めない
    // （GitHub Issue #178 の 1。server/api_chat.go の handleAddMisdeliveryRecord と同じ）
    if (!input.occurred_at) return fail('発生日時を入力してください');
    if (!isISODateTime(input.occurred_at)) return fail('発生日時の形式が正しくありません');
    db.misdeliveryRecords.unshift({
      misdelivery_record_id: nextId(), staff_id: user.staff_id!, ...input,
    });
    log(user.account_id, '2', '1', 't_misdelivery_record', input.chat_message_id, null, null, '誤送信への対応を記録');
    return ok(undefined);
  },

  /**
   * 取消済みで、まだ対応を記録していないメッセージ。誤送信への対応の記録と同じく管理者に限る
   * （基本設計書「権限と利用可能機能」(6-1)「誤送信への対応の記録｜管理者のみ」。GitHub Issue #177 の 3）。
   * 【仮置き】並びは送信の新しい順、同じ時刻はあとで送ったもの（メッセージの番号の大きいもの）を先にする
   * （web/仮置き値.md「一覧の並び順」。サーバ側の server/api_chat.go の handleRetractedWithoutRecord と同じ。GitHub Issue #177 の 7）
   */
  async retractedWithoutRecord(user: SessionUser) {
    if (user.role !== '1') return fail('誤送信対応の記録は管理者のみが参照できます');
    const recorded = new Set(db.misdeliveryRecords.map((r) => r.chat_message_id));
    return ok([...db.chatMessages]
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at) || b.chat_message_id - a.chat_message_id)
      // 配布物の掲載の知らせ（source_type = 4）は対象にしない。取り下げとして操作ログに残る
      // （基本設計書「誤送信への対応」(4-6)。GitHub Issue #98）
      // 【仮置き】保護者が送ったメッセージも対象にしない。誤送信への対応は、園が誤って送ったときのもの（同 (4-6) の
      // 利用タイミング）であり、保護者の打ちまちがいの取消は当たらない（GitHub Issue #171。api_chat.go と同じ）
      .filter((m) => m.is_deleted && m.source_type !== '4' && findAccount(m.sender_account_id)?.role !== '3'
        && !recorded.has(m.chat_message_id))
      .map((m) => ({
        chat_message_id: m.chat_message_id,
        room_name: db.chatRooms.find((r) => r.chat_room_id === m.chat_room_id)?.room_name ?? '―',
        sent_at: m.sent_at,
        deleted_at: m.deleted_at,
        sender_name: accountName(m.sender_account_id),
      })));
  },
};

/* ============ 午睡チェック（基本設計書「午睡チェック」(4-7)） ============ */

/**
 * 解除の時刻を過ぎた実施中の午睡チェックを終了にする（基本設計書「午睡チェックの実施」(4-7)）
 * 終了した職員はいないため ended_staff_id は空のままにし、自動で解除した印を立てる
 */
function autoCloseNapSessions(): void {
  const range = settingText('nap.time_range', '13:00-15:00');
  for (const s of db.napSessions) {
    if (s.ended_at !== null) continue;
    const closeAt = napAutoCloseAt(s.session_date, s.started_at, range);
    if (now() <= closeAt) continue;
    s.ended_at = closeAt;
    s.is_auto_closed = true;
  }
}

export const napApi = {
  /** 実施中のセッション。開いたまま運用するため、開始済みかを常に確認する */
  // 画面からは必ず user を渡す。渡さない呼び出しはテストのためだけに残している
  async activeSession(classId: number, date: string, user?: SessionUser): Promise<NapSession | null> {
    // 一般（保育士）は自クラスに限る（GitHub Issue #96）
    if (user && !canUseClass(user, classId)) return fail('このクラスの午睡チェックを参照する権限がありません');
    autoCloseNapSessions();
    return ok(db.napSessions.find((s) => s.class_id === classId && s.session_date === date && s.ended_at === null) ?? null);
  },

  async startSession(user: SessionUser, classId: number, date: string): Promise<NapSession> {
    if (user.role === '3') return fail('午睡チェックは職員のみが行えます');
    if (!canUseClass(user, classId)) return fail('このクラスの午睡チェックを開始する権限がありません');
    // 【仮置き】開始できるのは当日だけとする（GitHub Issue #97）。記録は起きたときに付けるものである
    if (date !== today()) return fail('午睡チェックは当日のぶんだけ開始できます');
    autoCloseNapSessions();
    const existing = db.napSessions.find((s) => s.class_id === classId && s.session_date === date && s.ended_at === null);
    if (existing) return ok(existing);
    const s: NapSession = {
      nap_session_id: nextId(), class_id: classId, session_date: date,
      started_staff_id: user.staff_id!, started_at: now(),
      ended_staff_id: null, ended_at: null, is_auto_closed: false,
    };
    db.napSessions.push(s);
    log(user.account_id, '3', '1', 't_nap_session', s.nap_session_id, null, null, `午睡チェックを開始（${className(classId)}）`);
    return ok(s);
  },

  /**
   * 終了。そのクラスを扱える職員が、実施中の実施を終了するときに限る（基本設計書「午睡チェックの実施」(4-7)
   * 「午睡チェックの開始・参照・記録は、一般（保育士）は自クラスに限る」。GitHub Issue #158）。
   * 終了した実施（自動で解除されたものを含む）は、終了時刻と終了した職員を書き換えない。
   * サーバ側は server/api_nap.go の handleEndNapSession
   */
  async endSession(user: SessionUser, sessionId: number): Promise<void> {
    autoCloseNapSessions();
    const s = db.napSessions.find((x) => x.nap_session_id === sessionId);
    if (!s) return fail('午睡チェックが見つかりません');
    if (!canUseClass(user, s.class_id)) return fail('このクラスの午睡チェックを終了する権限がありません');
    if (s.ended_at !== null) return fail('この午睡チェックはすでに終了しています。画面を読み込み直してください');
    s.ended_staff_id = user.staff_id;
    s.ended_at = now();
    log(user.account_id, '3', '2', 't_nap_session', sessionId, null, '実施中', '終了');
    return ok(undefined);
  },

  /** クラス全体の状況。平熱は比較の材料として並べて表示するのみ（画面詳細図 5-1） */
  async classState(user: SessionUser, classId: number, sessionId: number | null): Promise<NapChildState[]> {
    if (!canUseClass(user, classId)) return fail('このクラスの午睡チェックを参照する権限がありません');
    const ids = db.classChildren.filter((cc) => cc.class_id === classId).map((cc) => cc.child_id);
    const rows = ids
      .map((id) => findChild(id))
      .filter((c): c is Child => !!c && !c.is_deleted && c.enrollment_status === '1')
      .filter((c) => canSeeChild(user, c.child_id))
      .sort((a, b) => a.child_name_kana.localeCompare(b.child_name_kana, 'ja'))
      .map((child) => {
        const recs = sessionId
          ? db.napRecords.filter((r) => r.nap_session_id === sessionId && r.child_id === child.child_id)
          : [];
        recs.sort((a, b) => b.checked_at.localeCompare(a.checked_at));
        return { child, latest: recs[0] ?? null };
      });
    return ok(rows);
  },

  /**
   * 記録。確認画面を挟まず1件ずつ保存する（基本設計書「画面の洗い出しの考え方」(3-1) 基準2）
   * うつ伏せの警告は注意喚起であって判定ではない。記録自体は妨げない（画面詳細図 5-1）
   */
  async record(
    user: SessionUser, sessionId: number,
    input: { child_id: string; body_position: NapRecord['body_position']; breathing: NapRecord['breathing'];
             complexion: NapRecord['complexion']; temperature: number | null },
  ): Promise<NapRecord> {
    if (user.role === '3') return fail('午睡チェックは職員のみが行えます');
    // 体位・呼吸・顔色は、保育士が見て選んだ値だけを受け取る。空のまま既定値で埋めない
    if (!(input.body_position in BODY_POSITION)) return fail('体位を選んでください');
    if (!(input.breathing in BREATHING)) return fail('呼吸を選んでください');
    if (!(input.complexion in COMPLEXION)) return fail('顔色を選んでください');
    // 体温は小数第1位まで。範囲（30.0〜43.0℃）の外は画面で確かめるだけで、記録は妨げない
    // （基本設計書「入力項目の制約値」(4-9)。GitHub Issue #165）。サーバ側は server/api_nap.go の handleNapRecord
    if (input.temperature !== null && !isOneDecimal(input.temperature)) return fail('体温は小数第1位までで入力してください');
    if (!canSeeChild(user, input.child_id)) return fail('この園児を記録する権限がありません');
    // 終了した実施へは記録しない。自動で解除された直後に、開いたままの画面から記録が付くのを防ぐ
    // （GitHub Issue #97）
    autoCloseNapSessions();
    const session = db.napSessions.find((x) => x.nap_session_id === sessionId);
    if (!session) return fail('午睡チェックが見つかりません');
    if (!canUseClass(user, session.class_id)) return fail('このクラスの午睡チェックを記録する権限がありません');
    // 記録は、その園児のクラスの実施に付ける。管理者でも、ほかのクラスの園児を付けさせない（異常時の記録と同じ。GitHub Issue #158）
    if (!db.classChildren.some((cc) => cc.class_id === session.class_id && cc.child_id === input.child_id)) {
      return fail('この園児のクラスの午睡チェックではありません。園児のクラスの午睡チェックへ記録してください');
    }
    if (session.ended_at !== null) return fail('この午睡チェックは終了しています。画面を読み込み直してください');
    const r: NapRecord = {
      nap_record_id: nextId(), nap_session_id: sessionId, child_id: input.child_id,
      checked_at: now(), saved_at: now(),
      body_position: input.body_position, breathing: input.breathing,
      complexion: input.complexion, temperature: input.temperature, staff_id: user.staff_id!,
    };
    db.napRecords.push(r);
    log(user.account_id, '3', '1', 't_nap_record', r.nap_record_id, input.child_id, null,
      `体位=${input.body_position} 呼吸=${input.breathing} 顔色=${input.complexion}`);
    return ok(r);
  },

  /**
   * 異常時の記録。ヒヤリハットの起票は別操作（基本設計書「異常時の記録」(4-7)）
   *
   * 記録は、その園児のクラスの、実施中の午睡チェックにつなぐ（GitHub Issue #158）。起票するヒヤリハットの
   * 「対象のクラス」は実施のクラスから引くため。終了した実施へは記録しない（午睡の記録と同じ）。
   * 【仮置き】実施中の午睡チェックが無いときは記録できない。記録の操作で午睡チェックを開始しない（web/仮置き値.md）。
   * サーバ側は server/api_nap.go の handleRecordNapAbnormal
   */
  async recordAbnormal(
    user: SessionUser, sessionId: number,
    input: { child_id: string; found_at: string; situation: string; response: string },
  ): Promise<NapAbnormal> {
    if (!input.situation.trim()) return fail('発見時の状況を入力してください');
    if (!input.response.trim()) return fail('とった対応を入力してください');
    if (tooLong(input.situation, 1000) || tooLong(input.response, 1000)) {
      return fail('発見時の状況と、とった対応は、それぞれ1,000文字以内で入力してください');
    }
    const foundAt = input.found_at || now();
    const problem = foundAtProblem(foundAt);
    if (problem) return fail(problem);
    if (!canSeeChild(user, input.child_id)) return fail('この園児を記録する権限がありません');
    autoCloseNapSessions();
    const session = db.napSessions.find((x) => x.nap_session_id === sessionId);
    if (!session) return fail('午睡チェックが見つかりません');
    if (!canUseClass(user, session.class_id)) return fail('このクラスの午睡チェックへ記録する権限がありません');
    if (!db.classChildren.some((cc) => cc.class_id === session.class_id && cc.child_id === input.child_id)) {
      return fail('この園児のクラスの午睡チェックではありません。園児のクラスの午睡チェックへ記録してください');
    }
    if (session.ended_at !== null) return fail('この午睡チェックは終了しています。画面を読み込み直してください');
    const a: NapAbnormal = {
      nap_abnormal_id: nextId(), nap_session_id: sessionId, staff_id: user.staff_id!,
      diary_id: null, ...input, found_at: foundAt,
    };
    db.napAbnormals.unshift(a);
    log(user.account_id, '3', '1', 't_nap_abnormal', a.nap_abnormal_id, input.child_id, null, '異常時の記録');
    return ok(a);
  },

  /** 異常時の記録からヒヤリハットを起票し、相互に参照させる（基本設計書 5-6） */
  async raiseIncidentDiary(user: SessionUser, abnormalId: number): Promise<Diary> {
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    const a = db.napAbnormals.find((x) => x.nap_abnormal_id === abnormalId);
    if (!a) return fail('異常時の記録が見つかりません');
    // 起票できるのは、その園児を参照できる職員に限る。拒否するときは中身も起票済みかどうかも返さない
    // （基本設計書 6-1「異常時の記録 一般 ※1」。GitHub Issue #158。サーバ側は handleRaiseIncidentDiary）
    if (!canSeeChild(user, a.child_id)) return fail('この園児の記録からヒヤリハットを起票する権限がありません');
    if (a.diary_id) return fail('この記録からはすでにヒヤリハットを起票しています');
    const session = db.napSessions.find((s) => s.nap_session_id === a.nap_session_id);
    // 記録日は発見時刻の日付。検査を入れる前の崩れた値では、その実施の日にする（サーバ側と同じ）
    const head = a.found_at.slice(0, 10);
    const diaryDate = isISODate(head) ? head
      : session && isISODate(session.session_date) ? session.session_date : today();
    const d: Diary = {
      diary_id: nextId(), record_type: '4', child_id: a.child_id,
      class_id: session?.class_id ?? null, diary_date: diaryDate,
      body: `【発生日時】\n${a.found_at.replace('T', ' ')}\n\n【状況】\n${a.situation}\n\n【とった対応】\n${a.response}\n\n【今後の対策】\n`,
      status: '1', created_staff_id: user.staff_id!, approved_staff_id: null, approved_at: null,
      is_shared_to_guardian: false, shared_at: null, nap_abnormal_id: abnormalId,
      returned_reason: null, is_deleted: false, created_at: now(), updated_at: now(),
    };
    db.diaries.unshift(d);
    a.diary_id = d.diary_id;
    log(user.account_id, '1', '1', 't_diary', d.diary_id, a.child_id, null, '異常時の記録からヒヤリハットを起票');
    return ok(d);
  },

  /**
   * 異常時の記録の一覧。職員に限り、一般は自クラスの園児の記録に限る
   * （基本設計書「権限と利用可能機能」(6-1)「異常時の記録｜保護者 ×・一般 ※1」。GitHub Issue #177 の 3）。
   * 【仮置き】並びは発見時刻の新しい順、同じ時刻はあとで記録したものを先にする
   * （web/仮置き値.md「一覧の並び順」。GitHub Issue #177 の 7）。サーバ側は server/api_nap.go の handleNapAbnormals
   */
  async abnormals(user: SessionUser) {
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    return ok(db.napAbnormals
      .filter((a) => canSeeChild(user, a.child_id))
      .sort((a, b) => b.found_at.localeCompare(a.found_at) || b.nap_abnormal_id - a.nap_abnormal_id)
      .map((a) => ({ ...a, child_name: childName(a.child_id), staff_name: staffName(a.staff_id) })));
  },
};

const napApi2 = {
  /** 午睡記録検索。日付・園児名・クラスで絞り込む（基本設計書「画面の一覧」(3-2)） */
  async searchRecords(
    user: SessionUser,
    f: { from?: string; to?: string; classId?: number | ''; childName?: string; page?: number },
  ): Promise<Paged<NapRecord & { child_name: string; class_name: string; staff_name: string; session_date: string }>> {
    // 職員に限る（基本設計書「権限と利用可能機能」(6-1)「午睡チェックの実施・記録｜保護者 ×」。
    // サーバ側の server/api_nap.go の handleSearchNapRecords と同じ。GitHub Issue #177 の 3）
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    const perPage = settingNumber('paging.nap_search_per_page', 50);
    const visible = new Set(visibleChildren(user).map((c) => c.child_id));

    let rows = db.napRecords
      .filter((r) => visible.has(r.child_id))
      .map((r) => {
        const s = db.napSessions.find((x) => x.nap_session_id === r.nap_session_id);
        return {
          ...r,
          child_name: childName(r.child_id),
          class_name: className(s?.class_id ?? null),
          staff_name: staffName(r.staff_id),
          session_date: s?.session_date ?? r.checked_at.slice(0, 10),
          _class_id: s?.class_id ?? null,
        };
      });

    if (f.from) rows = rows.filter((r) => r.session_date >= f.from!);
    if (f.to) rows = rows.filter((r) => r.session_date <= f.to!);
    if (f.classId) rows = rows.filter((r) => r._class_id === f.classId);
    if (f.childName) rows = rows.filter((r) => r.child_name.includes(f.childName!.trim()));

    rows.sort((a, b) => b.checked_at.localeCompare(a.checked_at));
    const page = f.page ?? 1;
    return ok({ rows: rows.slice((page - 1) * perPage, page * perPage), total: rows.length, page, per_page: perPage });
  },

  /** 年齢に応じたチェック間隔。マスタ値を用いる（基本設計書 5-8） */
  intervalMinutesFor(classId: number): number {
    // 年齢はクラスの年齢児から引く。2歳児以上は age2 を使う（基本設計書「クラスと紐づけ」(5-3)）
    const ageClass = db.classes.find((c) => c.class_id === classId)?.age_class ?? 2;
    if (ageClass === 0) return settingNumber('nap.interval_minutes.age0', 5);
    if (ageClass === 1) return settingNumber('nap.interval_minutes.age1', 10);
    return settingNumber('nap.interval_minutes.age2', 15);
  },
};

/* ============ 発達チェック（基本設計書「発達チェック・身体測定」(4-8)） ============ */

/**
 * 確定した実施が予定を満たしたときに、次回の予定日を作る
 *
 * 次回の予定日は、実施日にマスタの推奨頻度（m_development_frequency）の日数を足した日とする。
 * すでに実施日より先の予定があるとき（園児単位で手動上書きした予定を含む）は、それを残す。
 *
 * 【仮置き】次回の予定日をいつ・何から計算し直すかは基本設計書が定めていない（web/仮置き値.md）。
 * Go サーバ（server/api_dev_write.go の advanceDevelopmentSchedule）と同じ規則にしてある。
 */
function advanceDevelopmentSchedule(user: SessionUser, check: DevelopmentCheck, childId: string, checkedOn: string): void {
  const cur = db.developmentSchedules
    .filter((s) => s.child_id === childId)
    .sort((a, b) => b.scheduled_on.localeCompare(a.scheduled_on))[0];
  if (cur && cur.scheduled_on > checkedOn) return;
  if (cur) check.development_schedule_id = cur.development_schedule_id;

  const child = findChild(childId);
  if (!child) return;
  const ageM = ageInMonths(child.birth_date, checkedOn);
  const freq = db.developmentFrequencies.find((f) => ageM >= f.age_month_from && ageM <= f.age_month_to);
  // 推奨頻度がマスタに無い月齢では、予定日を提案しない
  if (!freq) return;
  const next = addDays(checkedOn, freq.interval_days);
  db.developmentSchedules.push({
    development_schedule_id: nextId(), child_id: childId,
    scheduled_on: next, is_manual_override: false, created_staff_id: user.staff_id!,
  });
  log(user.account_id, '4', '1', 't_development_schedule', null, childId, null, `次回予定日=${next}（実施日から算出）`);
}

/** 園児の最新の予定 */
function latestSchedule(childId: string) {
  return db.developmentSchedules
    .filter((s) => s.child_id === childId)
    .sort((a, b) => b.scheduled_on.localeCompare(a.scheduled_on))[0] ?? null;
}

/** 園児の、いちばん新しい確定した実施 */
function lastConfirmedCheck(childId: string) {
  return db.developmentChecks
    .filter((c) => c.child_id === childId && c.status === '2')
    .sort((a, b) => b.checked_on.localeCompare(a.checked_on))[0] ?? null;
}

/** 園児の、いちばん新しい記録（下書きを含む） */
function latestCheck(childId: string) {
  return db.developmentChecks
    .filter((c) => c.child_id === childId)
    .sort((a, b) => b.checked_on.localeCompare(a.checked_on))[0] ?? null;
}

/**
 * 確定した記録を最後に確定した日時。下書きのときは null。
 *
 * 確定したあとに開き直したとき、確定済みであることと、いつ・誰が確定したかを入力画面に出すために使う
 * （GitHub Issue #143）。誰が確定したかは記録の staff_id（確定した記録は確定でしか保存できないため、最後に確定した職員）。
 * 【仮置き】確定の日時を持つ列は基本設計書「発達チェック・身体測定」(5-7) の定義に無いため、
 * 操作ログ（基本設計書「操作ログ」(5-8)）の「確定」から引く（web/仮置き値.md）。操作ログの無い記録（デモデータ）は null。
 * サーバ側は server/api_dev.go の confirmedAt
 */
function confirmedAt(check: DevelopmentCheck): string | null {
  if (check.status !== '2') return null;
  const logs = db.operationLogs
    .filter((l) => l.target_table === 't_development_check' && l.target_id === check.development_check_id
      && l.after_value === '確定')
    .sort((a, b) => b.operated_at.localeCompare(a.operated_at) || b.operation_log_id - a.operation_log_id);
  return logs[0]?.operated_at ?? null;
}

/**
 * 発達チェックが「未実施」か。園児の最新の予定日を過ぎていて、その予定日以降に確定した実施が無ければ未実施とする。
 * 予定日の当日は、まだ未実施にしない（基本設計書「発達チェックの実施」(4-8)「実施予定日を過ぎて」。GitHub Issue #164）。
 * 発達チェック一覧（list）と職員ダッシュボード（staffSummary）が同じ判定を使い、件数を食い違わせない。
 * サーバ側は server/api_dev.go の devOverdue
 */
function isDevOverdue(scheduledOn: string | null, lastCheckedOn: string | null): boolean {
  if (!scheduledOn || scheduledOn >= today()) return false;
  return !lastCheckedOn || lastCheckedOn < scheduledOn;
}

export const devApi = {
  /** 月齢から発達過程区分を引く。区分はマスタから読む（画面詳細図 6-1） */
  categoryFor(ageMonths: number) {
    return db.developmentCategories.find((c) => ageMonths >= c.age_month_from && ageMonths <= c.age_month_to) ?? null;
  },

  async itemsFor(ageMonths: number): Promise<DevelopmentItem[]> {
    const cat = devApi.categoryFor(ageMonths);
    if (!cat) return ok([]);
    return ok(db.developmentItems
      .filter((i) => i.development_category_id === cat.development_category_id)
      .sort((a, b) => a.display_order - b.display_order));
  },

  /** 一覧。チェック漏れを強調するため未実施を判定して返す（基本設計書「画面の一覧」(3-2)） */
  async list(user: SessionUser, classId: number): Promise<DevListRow[]> {
    // 職員に限る（基本設計書「権限と利用可能機能」(6-1)「発達チェックの入力｜保護者 ×」。
    // サーバ側の server/api_dev.go の handleDevelopmentList と同じ。GitHub Issue #177 の 3）
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    const ids = new Set(db.classChildren.filter((cc) => cc.class_id === classId).map((cc) => cc.child_id));
    const rows = visibleChildren(user)
      .filter((c) => ids.has(c.child_id))
      .sort((a, b) => a.child_name_kana.localeCompare(b.child_name_kana, 'ja'))
      .map((child) => {
        const sch = latestSchedule(child.child_id);
        // 前回の実施日と「未実施」の判定は、確定した記録で見る。下書きは実施にならない
        const last = lastConfirmedCheck(child.child_id);
        const scheduledOn = sch?.scheduled_on ?? null;
        const overdue = isDevOverdue(scheduledOn, last?.checked_on ?? null);
        /*
         * 未入力は、いちばん新しい記録（下書きを含む）について、その実施日の月齢に対応する項目のうち、
         * 結果のレコードが無いものを数える。入力画面の「未入力の項目」と同じ数になる。
         * 典拠：要件定義書「チェック漏れの強調」(4-5-2)「下書き保存された記録は、保存されていない項目を未入力として扱う」。
         * 確定した記録だけで数えていたため、下書きを保存しても一覧の件数が変わらず、入力画面と食い違っていた（GitHub Issue #143）。
         * サーバ側は server/api_dev.go の handleDevelopmentList
         */
        const latest = latestCheck(child.child_id);
        let unfilled = 0;
        if (latest) {
          const cat = devApi.categoryFor(ageInMonths(child.birth_date, latest.checked_on));
          const itemIds = db.developmentItems
            .filter((i) => i.development_category_id === cat?.development_category_id)
            .map((i) => i.development_item_id);
          const filled = db.developmentResults.filter((r) =>
            r.development_check_id === latest.development_check_id && itemIds.includes(r.development_item_id)).length;
          unfilled = Math.max(0, itemIds.length - filled);
        }
        return {
          child,
          ageMonths: ageInMonths(child.birth_date, scheduledOn ?? today()),
          scheduledOn,
          lastCheckedOn: last?.checked_on ?? null,
          overdue,
          unfilled,
        };
      });
    return ok(rows);
  },

  /**
   * 前回の記録。並べて表示するために使う（画面詳細図 6-1）。
   * その園児を参照できる職員に限る。一般は自クラスの園児に限る（要件定義書「対象権限列の読み方」(4-2 冒頭)、
   * 基本設計書「権限と利用可能機能」(6-1)「発達チェックの入力｜保護者 ×・一般 ※1」。GitHub Issue #177 の 3）。
   * サーバ側は server/api_dev.go の handlePreviousCheck
   */
  async previousCheck(user: SessionUser, childId: string, beforeDate: string) {
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    const prev = db.developmentChecks
      .filter((c) => c.child_id === childId && c.status === '2' && c.checked_on < beforeDate)
      .sort((a, b) => b.checked_on.localeCompare(a.checked_on))[0];
    if (!prev) return ok(null);
    return ok({
      check: prev,
      results: db.developmentResults.filter((r) => r.development_check_id === prev.development_check_id),
    });
  },

  /**
   * 当日の下書き。あれば読み直す。確定した記録なら、いつ確定したか（confirmedAt）も返す。
   * 参照できる人は previousCheck と同じ（GitHub Issue #177 の 3。サーバ側は server/api_dev.go の handleDraftCheck）
   */
  async draftFor(user: SessionUser, childId: string, checkedOn: string): Promise<DevDraftView | null> {
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    const c = db.developmentChecks.find((x) => x.child_id === childId && x.checked_on === checkedOn);
    if (!c) return ok(null);
    return ok({
      check: c,
      results: db.developmentResults.filter((r) => r.development_check_id === c.development_check_id),
      confirmedAt: confirmedAt(c),
    });
  },

  /**
   * 保存。status='1' が下書き、'2' が確定
   * 「未入力」はレコードを作らないことで表す。「未確認」は result='3' として保持する（基本設計書 5-7）
   */
  async saveCheck(
    user: SessionUser, childId: string, checkedOn: string,
    results: { development_item_id: number; result: DevelopmentResultRecord['result'] | null }[],
    note: string, status: DevelopmentCheck['status'],
  ): Promise<DevelopmentCheck> {
    if (user.role === '3') return fail('発達チェックの入力は職員のみが行えます');
    if (!canSeeChild(user, childId)) return fail('この園児を記録する権限がありません');
    if (tooLong(note, 1000)) return fail('所見は1,000文字以内で入力してください');
    // 実施日は、形の崩れた値と未来日を断る（基本設計書「入力項目の制約値」(4-9)「記録日・測定日 未来日は認めない」、
    // 画面詳細図 6-2 項目3。GitHub Issue #164）。サーバ側は server/api_dev_write.go の handleSaveDevelopmentCheck
    if (!isISODate(checkedOn)) return fail('実施日の形式が正しくありません');
    if (checkedOn > today()) return fail('実施日に未来日は指定できません');

    let check = db.developmentChecks.find((c) => c.child_id === childId && c.checked_on === checkedOn);
    // 初めての保存か。操作ログの操作区分（1:作成 2:変更）に使う（基本設計書「操作ログ（t_operation_log）」(5-8)）。
    // 下で記録を作ったあとに check を見ると、いつも「変更」になっていた（GitHub Issue #177 の 6。
    // サーバ側は server/api_dev_write.go の handleSaveDevelopmentCheck の isNew）
    const isNew = !check;
    // 確定した記録は、下書きに戻さない。確定のまま直すことはできる。下書きに戻すと、確定で作った次回の予定日だけが残り、
    // 一覧とダッシュボードの「未実施」が食い違うため（GitHub Issue #164）。【仮置き】確定を取り消す操作は設けない
    if (check && check.status === '2' && status === '1') {
      return fail('確定した発達チェックは下書きに戻せません。直すときは「確定する」で保存してください');
    }
    if (!check) {
      check = {
        development_check_id: nextId(), child_id: childId, development_schedule_id: null,
        checked_on: checkedOn, status, staff_id: user.staff_id!, share_status: '1',
      };
      db.developmentChecks.push(check);
    } else {
      check.status = status;
      check.staff_id = user.staff_id!;
    }
    /*
     * 【設計の穴】所見（チェック単位の自由記述）を保持する列が t_development_check にない（GitHub Issue #58）。
     * Go サーバと同じく、チェックの側に note として持つ。設計の決定ではない。
     */
    check.note = note.trim() ? note : null;

    // 既存の結果を入れ替える
    for (let i = db.developmentResults.length - 1; i >= 0; i--) {
      if (db.developmentResults[i].development_check_id === check.development_check_id) {
        db.developmentResults.splice(i, 1);
      }
    }
    results.forEach((r) => {
      // null は未入力。レコードを作らない
      if (r.result === null) return;
      db.developmentResults.push({
        development_result_id: nextId(),
        development_check_id: check!.development_check_id,
        development_item_id: r.development_item_id,
        result: r.result,
        note: null,
      });
    });
    log(user.account_id, '4', isNew ? '1' : '2', 't_development_check', check.development_check_id, childId,
      null, status === '2' ? '確定' : '下書き保存');

    if (status === '2') advanceDevelopmentSchedule(user, check, childId, checkedOn);
    return ok(check);
  },
};

const devApi2 = {
  /**
   * 園児単位の推奨スケジュールの上書き（スケジュール設定画面。上書きは管理者のみ）。
   * 一覧の取得は職員に限る（サーバ側の server/api_dev.go の handleDevelopmentSchedules と同じ。GitHub Issue #177 の 3）。
   * 【仮置き】並びは園児のよみ順。発達チェック一覧と同じ（web/仮置き値.md「一覧の並び順」。GitHub Issue #177 の 7）
   */
  async schedules(user: SessionUser, classId: number) {
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    const ids = new Set(db.classChildren.filter((cc) => cc.class_id === classId).map((cc) => cc.child_id));
    return ok(visibleChildren(user).filter((c) => ids.has(c.child_id))
      .sort((a, b) => a.child_name_kana.localeCompare(b.child_name_kana, 'ja')).map((child) => {
      const sch = db.developmentSchedules
        .filter((s) => s.child_id === child.child_id)
        .sort((a, b) => b.scheduled_on.localeCompare(a.scheduled_on))[0] ?? null;
      const ageM = ageInMonths(child.birth_date, today());
      const freq = db.developmentFrequencies.find((f) => ageM >= f.age_month_from && ageM <= f.age_month_to);
      const lastCheck = db.developmentChecks
        .filter((c) => c.child_id === child.child_id && c.status === '2')
        .sort((a, b) => b.checked_on.localeCompare(a.checked_on))[0] ?? null;
      return {
        child,
        ageMonths: ageM,
        /** システムが提案する予定日。マスタの推奨頻度から算出する */
        suggested: lastCheck && freq ? addDays(lastCheck.checked_on, freq.interval_days) : today(),
        intervalDays: freq?.interval_days ?? null,
        scheduledOn: sch?.scheduled_on ?? null,
        isManualOverride: sch?.is_manual_override ?? false,
      };
    }));
  },

  async setSchedule(user: SessionUser, childId: string, scheduledOn: string, manual: boolean): Promise<void> {
    if (user.role !== '1') return fail('スケジュールの設定は管理者のみが行えます');
    // 予定日は 'YYYY-MM-DD' の形の、実在する日付に限る（GitHub Issue #164。サーバ側は handleSetSchedule）
    if (!isISODate(scheduledOn)) return fail('次回の予定日の形式が正しくありません');
    // 手で決める予定日に、過ぎた日は入れさせない。「提案に戻す」は、予定日を過ぎた園児では
    // 提案そのものが過去の日になるため、対象にしない
    if (manual && scheduledOn < today()) return fail('次回の予定日に、過ぎた日は指定できません');
    const cur = db.developmentSchedules
      .filter((s) => s.child_id === childId)
      .sort((a, b) => b.scheduled_on.localeCompare(a.scheduled_on))[0];
    if (cur) {
      cur.scheduled_on = scheduledOn;
      cur.is_manual_override = manual;
    } else {
      db.developmentSchedules.push({
        development_schedule_id: nextId(), child_id: childId,
        scheduled_on: scheduledOn, is_manual_override: manual, created_staff_id: user.staff_id!,
      });
    }
    log(user.account_id, '4', '2', 't_development_schedule', null, childId, null,
      `次回予定日=${scheduledOn}${manual ? '（手動上書き）' : ''}`);
    return ok(undefined);
  },

  /** 共有範囲設定。項目ごとの保護者への共有可否（要件定義書「発達チェック」(4-5)） */
  async shareSettings(user: SessionUser) {
    if (user.role !== '1') return fail('共有範囲の設定は管理者のみが行えます');
    return ok(db.developmentItems
      .sort((a, b) => a.development_category_id - b.development_category_id || a.display_order - b.display_order)
      .map((item) => ({
        item,
        categoryName: db.developmentCategories.find((c) => c.development_category_id === item.development_category_id)?.category_name ?? '―',
        isShareable: db.shareSettings.find((s) => s.development_item_id === item.development_item_id)?.is_shareable ?? true,
      })));
  },

  async setShareable(user: SessionUser, itemId: number, shareable: boolean): Promise<void> {
    if (user.role !== '1') return fail('共有範囲の設定は管理者のみが行えます');
    const s = db.shareSettings.find((x) => x.development_item_id === itemId);
    if (s) {
      s.is_shareable = shareable;
      s.updated_staff_id = user.staff_id!;
      s.updated_at = now();
    } else {
      db.shareSettings.push({
        share_setting_id: nextId(), development_item_id: itemId, is_shareable: shareable,
        updated_staff_id: user.staff_id!, updated_at: now(),
      });
    }
    log(user.account_id, '4', '2', 'm_share_setting', itemId, null, null, shareable ? '共有する' : '共有しない');
    return ok(undefined);
  },
};

/* ============ 身体測定（基本設計書「身体測定の記録」(4-8)） ============ */

export const physicalApi = {
  /**
   * クラスの実施状況。誰が残っているかを数えさせない（画面詳細図 6-2）
   * 入力済みは、選んだ測定日と同じ年月に未削除の記録があるかで見る。測定日が数日ずれても同じ回として扱う
   * （基本設計書「身体測定の記録」(4-8)「選択中の測定日と同一の年月」・「測定回の単位は年月とする」。GitHub Issue #47・#165）。
   * サーバ側は server/api_physical.go の handlePhysicalClassStatus
   */
  async classStatus(user: SessionUser, classId: number, measuredOn: string) {
    // 職員に限る（基本設計書「権限と利用可能機能」(6-1)「身体測定の記録｜保護者 ×」。
    // サーバ側の handlePhysicalClassStatus と同じ。GitHub Issue #177 の 3）
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    const day = measuredOn || today();
    if (!isISODate(day)) return fail('測定日の形式が正しくありません');
    const ids = new Set(db.classChildren.filter((cc) => cc.class_id === classId).map((cc) => cc.child_id));
    const target = visibleChildren(user)
      .filter((c) => ids.has(c.child_id))
      .sort((a, b) => a.child_name_kana.localeCompare(b.child_name_kana, 'ja'));
    const month = day.slice(0, 7);
    const done = target.filter((c) => db.physicalRecords.some(
      (r) => !r.is_deleted && r.child_id === c.child_id && r.measured_on.slice(0, 7) === month));
    const pending = target.filter((c) => !done.includes(c));
    return ok({ target, done, pending });
  },

  /**
   * 園児の測定値。保護者に見せるのは、共有した（連携済の）測定値だけ（基本設計書 6-1「成長グラフの閲覧｜保護者 ※3」、
   * 5-7 share_status＝2:連携済。GitHub Issue #157）。サーバ側は server/api_physical.go の handlePhysicalRecords
   */
  async recordsOf(user: SessionUser, childId: string): Promise<PhysicalRecord[]> {
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    return ok(db.physicalRecords
      .filter((r) => !r.is_deleted && r.child_id === childId)
      .filter((r) => user.role !== '3' || r.share_status === '2')
      .sort((a, b) => b.measured_on.localeCompare(a.measured_on)));
  },

  /**
   * 登録・修正。確認画面を挟まず連続して入力できる（画面詳細図 6-2）
   * 範囲外の値は警告して確認を求めるが、記録自体は妨げない（判定ではないため）
   *
   * 登録済みの記録を黙って書き換えない。同一園児・同一測定日の記録は、上書きの承諾（confirm_overwrite）があるときだけ
   * 書き換える（基本設計書「身体測定の記録」(4-8)「上書き確認を表示する」）。
   * 【仮置き】同じ年月の別の測定日に記録があるときは、同じ月の別の記録としての承諾（confirm_same_month）があるときだけ
   * 登録する（web/仮置き値.md、GitHub Issue #165）。承諾は確認の種類ごとに受け付け、一方の承諾で他方を通さない
   * （同 (4-8)「確認の種類ごとに、対応する承諾だけを受け付ける」）。サーバ側は server/api_physical.go の handleSavePhysical
   */
  async save(
    user: SessionUser,
    input: {
      child_id: string; measured_on: string; height_cm: number; weight_kg: number;
      confirm_overwrite?: boolean; confirm_same_month?: boolean;
    },
  ): Promise<PhysicalRecord> {
    if (user.role === '3') return fail('身体測定の記録は職員のみが行えます');
    if (!canSeeChild(user, input.child_id)) return fail('この園児を記録する権限がありません');
    // 崩れた測定日を保存すると、年月で数える実施状況や月齢の計算が狂う（基本設計書「入力項目の制約値」(4-9)）
    if (!input.measured_on) return fail('測定日は必須項目です');
    if (!isISODate(input.measured_on)) return fail('測定日の形式が正しくありません');
    if (input.measured_on > today()) return fail('測定日に未来日は指定できません');
    if (!(input.height_cm > 0) || !(input.weight_kg > 0)) return fail('身長と体重を入力してください');

    // child_id + measured_on は is_deleted=false の行のみを対象に一意（基本設計書 5-7）
    const existing = db.physicalRecords.find(
      (r) => !r.is_deleted && r.child_id === input.child_id && r.measured_on === input.measured_on);
    if (existing && !input.confirm_overwrite) {
      return fail('この測定日の記録は登録済みです。内容を確かめ、上書きするときはもう一度「登録する」を押してください');
    }
    if (!existing && !input.confirm_same_month) {
      const month = input.measured_on.slice(0, 7);
      const other = db.physicalRecords
        .filter((r) => !r.is_deleted && r.child_id === input.child_id && r.measured_on.slice(0, 7) === month)
        .sort((a, b) => b.measured_on.localeCompare(a.measured_on))[0];
      if (other) {
        return fail(`${formatYM(input.measured_on)}の記録は登録済みです（測定日 ${other.measured_on.replace(/-/g, '/')}）。`
          + '内容を確かめ、別の記録として登録するときはもう一度「登録する」を押してください');
      }
    }

    if (existing) {
      const before = `身長=${existing.height_cm} 体重=${existing.weight_kg}`;
      existing.height_cm = input.height_cm;
      existing.weight_kg = input.weight_kg;
      // staff_id は初回登録者。更新時に書き換えない（基本設計書 5-7）
      existing.updated_at = now();
      log(user.account_id, '5', '2', 't_physical_record', existing.physical_record_id, input.child_id,
        before, `身長=${input.height_cm} 体重=${input.weight_kg}`);
      return ok(existing);
    }

    const row: PhysicalRecord = {
      physical_record_id: nextId(), child_id: input.child_id, measured_on: input.measured_on,
      height_cm: input.height_cm, weight_kg: input.weight_kg, staff_id: user.staff_id!,
      share_status: '1', is_deleted: false, created_at: now(), updated_at: now(),
    };
    db.physicalRecords.push(row);
    log(user.account_id, '5', '1', 't_physical_record', row.physical_record_id, input.child_id,
      null, `身長=${input.height_cm} 体重=${input.weight_kg}`);
    return ok(row);
  },

  /**
   * 範囲チェック。しきい値は設定マスタから読む（基本設計書 5-8）
   * 返すのは注意喚起であって、登録の可否ではない
   */
  rangeWarning(heightCm: number, weightKg: number): string | null {
    const hMin = settingNumber('physical.height_min', 40);
    const hMax = settingNumber('physical.height_max', 140);
    const wMin = settingNumber('physical.weight_min', 2);
    const wMax = settingNumber('physical.weight_max', 40);
    const msgs: string[] = [];
    if (heightCm && (heightCm < hMin || heightCm > hMax)) msgs.push(`身長が想定の範囲（${hMin}〜${hMax}cm）の外です`);
    if (weightKg && (weightKg < wMin || weightKg > wMax)) msgs.push(`体重が想定の範囲（${wMin}〜${wMax}kg）の外です`);
    return msgs.length ? `${msgs.join('。')}。入力をお確かめください` : null;
  },

  /** 成長曲線の帯。性別が未回答の園児には基準値を持たない（基本設計書 5-7） */
  async growthBand(sex: Child['sex'], measureType: '1' | '2'): Promise<GrowthStandard[] | null> {
    if (sex === '9') return ok(null);
    return ok(db.growthStandards
      .filter((g) => g.sex === sex && g.measure_type === measureType)
      .sort((a, b) => a.age_in_months - b.age_in_months || a.percentile - b.percentile));
  },

  async remove(user: SessionUser, recordId: number): Promise<void> {
    if (user.role !== '1') return fail('測定値の削除は管理者のみが行えます');
    const r = db.physicalRecords.find((x) => x.physical_record_id === recordId);
    if (!r) return fail('記録が見つかりません');
    r.is_deleted = true;
    r.updated_at = now();
    log(user.account_id, '5', '4', 't_physical_record', recordId, r.child_id,
      `身長=${r.height_cm} 体重=${r.weight_kg}`, '削除');
    return ok(undefined);
  },

  /** PDF出力。管理者のみ。出力種別に既定値を置かず毎回選ばせる（画面詳細図 6-2） */
  async exportPdf(user: SessionUser, childId: string, purpose: 'internal' | 'guardian'): Promise<void> {
    if (user.role !== '1') return fail('PDF出力は管理者のみが行えます');
    log(user.account_id, '5', '5', 't_physical_record', null, childId, null,
      `PDF出力（${purpose === 'internal' ? '園内利用' : '保護者引き渡し'}）`);
    return ok(undefined);
  },
};

/* ============ アカウント管理・監査（基本設計書「共通基盤：ログインとアカウント」(4-3)） ============ */

export const adminApi = {
  /** 職員アカウントの一覧（職員アカウント管理画面。管理者のみ） */
  async staffAccounts(user: SessionUser) {
    if (user.role !== '1') return fail('アカウント管理は管理者のみが行えます');
    return ok(db.staff.map((s) => {
      const a = findAccount(s.account_id)!;
      const cs = db.classStaff.find((x) => x.staff_id === s.staff_id
        && db.classes.some((c) => c.class_id === x.class_id && c.fiscal_year === db.FISCAL_YEAR));
      return {
        staff: s, account: a,
        className: cs ? className(cs.class_id) : '―',
        locked: !!a.locked_until && a.locked_until > now(),
      };
    }));
  },

  /** 一時パスワードの再発行（基本設計書「一時パスワードの再発行」(4-3)） */
  async reissueTempPassword(user: SessionUser, accountId: number): Promise<string> {
    if (user.role !== '1') return fail('一時パスワードの再発行は管理者のみが行えます');
    const a = findAccount(accountId);
    if (!a) return fail('アカウントが見つかりません');
    const hours = settingNumber('auth.temp_password_hours', 48);
    const temp = `temp${Math.floor(1000 + Math.random() * 9000)}`;
    a.password_hash = temp;
    a.is_temp_password = true;
    a.temp_password_expires_at = fromNowMinutes(hours * 60);
    a.failed_login_count = 0;
    a.locked_until = null;
    a.updated_at = now();
    log(user.account_id, '7', '2', 'm_account', accountId, null, null, '一時パスワードを再発行');
    return ok(temp);
  },

  /** ロックの解除。管理者は経過を待たず解除できる（基本設計書 5-2） */
  async unlock(user: SessionUser, accountId: number): Promise<void> {
    if (user.role !== '1') return fail('ロックの解除は管理者のみが行えます');
    const a = findAccount(accountId);
    if (!a) return fail('アカウントが見つかりません');
    // ロックされていないアカウントの解除を通すと、操作ログに事実と違う「変更前：ロック中」が残る（GitHub Issue #166 の 6）
    if (!a.locked_until || a.locked_until <= now()) return fail('このアカウントはロックされていません');
    a.locked_until = null;
    a.failed_login_count = 0;
    log(user.account_id, '7', '2', 'm_account', accountId, null, 'ロック中', 'ロックを解除');
    return ok(undefined);
  },

  async setAccountStatus(user: SessionUser, accountId: number, status: Account['status']): Promise<void> {
    if (user.role !== '1') return fail('アカウントの停止・再開は管理者のみが行えます');
    const a = findAccount(accountId);
    if (!a) return fail('アカウントが見つかりません');
    if (a.account_id === user.account_id) return fail('自分のアカウントは停止できません');
    if (status !== '1' && status !== '2') return fail('状態の指定が正しくありません');
    // 保護者のアカウントは、有効な紐づけがゼロになった時点で停止する（基本設計書 5-3）。
    // 紐づけが無いまま再開すると、その規則と合わない状態になる（GitHub Issue #118）
    if (status === '1' && a.role === '3') {
      const g = db.guardians.find((x) => x.account_id === a.account_id);
      const active = db.guardianChildren.filter((x) => x.guardian_id === g?.guardian_id && x.link_status === '1').length;
      if (active === 0) return fail('有効な紐づけが無いため再開できません。先に紐づけを戻してください');
    }
    const before = a.status;
    a.status = status;
    a.updated_at = now();
    // 職員は、停止で園全体・職員・クラス・個人チャットから外れ、再開で戻る。職員チャットの参加は
    // 職員アカウントの作成・停止に連動する（基本設計書「チャット」(5-5)、GitHub Issue #162）
    syncStaffChatRooms(accountId);
    log(user.account_id, '7', '2', 'm_account', accountId, null,
      before === '1' ? '有効' : '停止', status === '1' ? '有効' : '停止');
    return ok(undefined);
  },

  /** 職員アカウントの発行。職員は管理者が発行する（画面詳細図 2-1） */
  async createStaffAccount(
    user: SessionUser,
    input: { staff_id: string; staff_name: string; email: string; role: Role; class_id: number | null },
  ): Promise<string> {
    if (user.role !== '1') return fail('職員アカウントの発行は管理者のみが行えます');
    if (input.role === '3') return fail('保護者アカウントは招待コードによる自己登録で作成します');
    /*
     * 前後の空白を除いてから、必須・桁数・形式を確かめる（基本設計書「入力項目の制約値」(4-9)。GitHub Issue #167 の 1）。
     * サーバ側は server/api_admin.go の handleCreateStaffAccount・validateStaffAccountInput
     */
    input = { ...input, staff_id: input.staff_id.trim(), staff_name: input.staff_name.trim(), email: input.email.trim() };
    const inputError = validateStaffAccountInput(input.staff_id, input.staff_name, input.email, input.role);
    if (inputError) return fail(inputError);
    if (input.class_id !== null && !currentClassExists(input.class_id)) return fail('担当クラスの指定が正しくありません');
    // ログインIDはロールをまたいで園内で一意（基本設計書 5-2）。大文字・小文字だけが違うものも同じとみなす
    if (emailTaken(input.email)) return fail('そのログインIDはすでに使われています');
    if (db.staff.some((s) => s.staff_id === input.staff_id)) return fail('その職員IDはすでに使われています');

    const hours = settingNumber('auth.temp_password_hours', 48);
    const temp = `temp${Math.floor(1000 + Math.random() * 9000)}`;
    const accountId = nextId();
    db.accounts.push({
      account_id: accountId, email: input.email, password_hash: temp, role: input.role, status: '1',
      is_temp_password: true, temp_password_expires_at: fromNowMinutes(hours * 60),
      failed_login_count: 0, locked_until: null, terms_version: null, terms_agreed_at: null,
      created_at: now(), updated_at: now(),
    });
    db.staff.push({ staff_id: input.staff_id, account_id: accountId, staff_name: input.staff_name, created_at: now(), updated_at: now() });
    if (input.class_id) db.classStaff.push({ class_id: input.class_id, staff_id: input.staff_id });
    // 園全体・職員チャットと、担当クラスのチャンネルへ入れる。職員チャットは作成に連動する
    // （基本設計書「チャット」(5-5)、GitHub Issue #162）
    syncStaffChatRooms(accountId);
    // 何を発行したか（ロール・担当クラスを含む）を {"項目名": 値} で残す（GitHub Issue #166 の 5）。一時パスワードは残さない
    log(user.account_id, '7', '1', 'm_account', accountId, null, null, fieldsJSON([
      ['職員ID', input.staff_id],
      ['氏名', input.staff_name],
      ['ログインID', input.email],
      ['ロール', roleLabel(input.role)],
      ['担当クラス', staffClassName(input.staff_id)],
    ]));
    return ok(temp);
  },

  /**
   * 発行済みの職員の氏名・ロール・担当クラスを変える。
   * 年度の途中の担任の交代と、発行の誤りの訂正を受ける（GitHub Issue #112）。
   * ログインIDと職員IDは変えない。記録の作成者として各所から参照されているため
   */
  async updateStaffAccount(
    user: SessionUser, staffId: string,
    input: { staff_name: string; role: Role; class_id: number | null },
  ): Promise<void> {
    if (user.role !== '1') return fail('職員アカウントの変更は管理者のみが行えます');
    const name = input.staff_name.trim();
    if (!name) return fail('氏名を入力してください');
    if (tooLong(name, 50)) return fail('氏名は50文字以内で入力してください');
    if (input.role !== '1' && input.role !== '2') return fail('ロールの指定が正しくありません');
    if (input.class_id !== null && !currentClassExists(input.class_id)) return fail('担当クラスの指定が正しくありません');
    const s = findStaff(staffId);
    const a = s ? findAccount(s.account_id) : undefined;
    if (!s || !a) return fail('職員が見つかりません');
    // 自分のロールは変えられない。管理者が自分を一般へ下げると、戻せる人がいなくなることがある
    if (a.account_id === user.account_id && input.role !== a.role) return fail('自分のロールは変更できません');

    const fields = (): Field[] => [
      ['氏名', s.staff_name], ['ロール', roleLabel(a.role)], ['担当クラス', staffClassName(staffId)],
    ];
    const before = fields();

    s.staff_name = name;
    s.updated_at = now();
    a.role = input.role;
    a.updated_at = now();
    // 担当クラスの付け替え。当年度ぶんだけを外し、過年度の割り当ては残す（基本設計書 5-3）
    for (let i = db.classStaff.length - 1; i >= 0; i--) {
      const x = db.classStaff[i];
      if (x.staff_id === staffId && db.classes.some((c) => c.class_id === x.class_id && c.fiscal_year === db.FISCAL_YEAR)) {
        db.classStaff.splice(i, 1);
      }
    }
    if (input.class_id) db.classStaff.push({ class_id: input.class_id, staff_id: staffId });
    // クラスのチャンネルと個人チャットを、新しい担当クラス・ロールに合わせる。前のクラスからは外れ、
    // 外れるまでの過去ログだけを読める（要件定義書「チャットツール」(4-3) (a)、GitHub Issue #162）
    syncStaffChatRooms(a.account_id);

    // 変更のあった項目だけを {"項目名": 値} で残す（基本設計書「操作ログ（t_operation_log）」(5-8)、GitHub Issue #166 の 5）
    const [b, af] = changedFields(before, fields());
    log(user.account_id, '7', '2', 'm_account', a.account_id, null, b, af);
    return ok(undefined);
  },
};

/** ロールの表示名（操作ログ用） */
const roleLabel = (r: Role) => (r === '1' ? '管理者' : '一般');

/** 当年度の担当クラス名。無ければ「担当クラスなし」（サーバ側は server/api_admin.go の staffClassName） */
function staffClassName(staffId: string): string {
  const cs = db.classStaff.find((x) => x.staff_id === staffId
    && db.classes.some((c) => c.class_id === x.class_id && c.fiscal_year === db.FISCAL_YEAR));
  return cs ? className(cs.class_id) : '担当クラスなし';
}

/** 当年度のクラスか。担当クラスに割り当てられるのは当年度のクラスだけ */
const currentClassExists = (classId: number) =>
  db.classes.some((c) => c.class_id === classId && c.fiscal_year === db.FISCAL_YEAR);

/**
 * ログインIDがすでに使われているか。ロールをまたいで園内で一意（基本設計書 5-2）。
 * 【仮置き】大文字・小文字だけが違うものも同じとみなす（web/仮置き値.md。GitHub Issue #167 の 1）。
 * 保護者の自己登録も同じ判定を使う。サーバ側は server/api_admin.go の emailTaken
 */
const emailTaken = (email: string) => db.accounts.some((a) => a.email.toLowerCase() === email.toLowerCase());

const adminApi2 = {
  /** 招待コードの一覧。同じ園児に複数枚が並ぶため園児名でまとめて見せる（画面詳細図 7-3） */
  async invitationCodes(user: SessionUser, f: { classId?: number | ''; status?: InvitationCode['status'] | '' } = {}) {
    if (user.role !== '1') return fail('招待コードの管理は管理者のみが行えます');
    let rows = db.invitationCodes.map((c) => ({
      ...c,
      child_name: childName(c.child_id),
      class_id: db.classChildren.find((cc) => cc.child_id === c.child_id)?.class_id ?? null,
      issued_staff_name: staffName(c.issued_staff_id),
      expired: c.status === '1' && c.expires_on < today(),
    }));
    if (f.classId) rows = rows.filter((r) => r.class_id === f.classId);
    if (f.status) rows = rows.filter((r) => r.status === f.status);
    // 【仮置き】園児のよみ順にまとめ（よみが同じなら園児IDの順）、同じ園児の中は発行の古い順にする
    // （web/仮置き値.md「一覧の並び順」）。漢字の氏名の順では、よみの順にも発行の順にもならず、
    // サーバ（並びを決めていなかった）とも食い違っていた（GitHub Issue #177 の 7）。
    // サーバ側は server/api_admin.go の handleInvitationCodes
    const kanaOf = (childId: string) => findChild(childId)?.child_name_kana ?? '';
    rows.sort((a, b) => kanaOf(a.child_id).localeCompare(kanaOf(b.child_id), 'ja')
      || a.child_id.localeCompare(b.child_id) || a.invitation_code_id - b.invitation_code_id);
    return ok(rows);
  },

  /** 1枚＝1アカウント。園児ごとに必要枚数を発行する（要件定義書「招待コードの発行」(4-1-2)） */
  /**
   * @param includeExisting 使えるコード（未使用・期限内）をすでに持つ園児にも発行するか。
   *   既定では飛ばす。配り直しのつもりが無いのに枚数が増えるのを防ぐ（GitHub Issue #122）
   */
  async issueInvitationCodes(
    user: SessionUser, classId: number, perChild: number, validDays: number, includeExisting = false,
  ): Promise<{ issued: number; skipped: number }> {
    if (user.role !== '1') return fail('招待コードの発行は管理者のみが行えます');
    // 園児1名あたりの枚数は 1〜5 枚（図/画面詳細図.md「招待コード管理画面」(7-7) 項目10。GitHub Issue #167 の 3）
    if (!validPerChild(perChild)) return fail(PER_CHILD_MESSAGE);
    if (!validInvitationDays(validDays)) return fail(INVITATION_DAYS_MESSAGE);
    const ids = db.classChildren.filter((cc) => cc.class_id === classId).map((cc) => cc.child_id)
      .filter((id) => { const c = findChild(id); return c && !c.is_deleted && c.enrollment_status === '1'; });

    let issued = 0;
    let skipped = 0;
    ids.forEach((child_id) => {
      const usable = db.invitationCodes.some((c) => c.child_id === child_id && c.status === '1' && c.expires_on >= today());
      if (!includeExisting && usable) { skipped++; return; }
      for (let i = 0; i < perChild; i++) {
        db.invitationCodes.push({
          invitation_code_id: nextId(),
          code: randomCode(),
          child_id,
          expires_on: addDays(today(), validDays),
          status: '1', used_account_id: null, used_at: null,
          issued_staff_id: user.staff_id!, created_at: now(),
        });
        issued++;
      }
    });
    log(user.account_id, '7', '1', 't_invitation_code', null, null, null,
      `${className(classId)} へ ${issued} 枚を一括発行`);
    return ok({ issued, skipped });
  },

  async issueOneInvitationCode(user: SessionUser, childId: string, validDays: number): Promise<string> {
    if (user.role !== '1') return fail('招待コードの発行は管理者のみが行えます');
    if (!validInvitationDays(validDays)) return fail(INVITATION_DAYS_MESSAGE);
    // 取り消した・在籍していない園児には発行しない。一括発行と同じ条件（GitHub Issue #166 の 4）
    const target = childIssuable(childId);
    if (!target.found) return fail('園児が見つかりません');
    if (!target.issuable) return fail('在籍していない園児には招待コードを発行できません');
    const code = randomCode();
    db.invitationCodes.push({
      invitation_code_id: nextId(), code, child_id: childId,
      expires_on: addDays(today(), validDays), status: '1',
      used_account_id: null, used_at: null, issued_staff_id: user.staff_id!, created_at: now(),
    });
    log(user.account_id, '7', '1', 't_invitation_code', null, childId, null, '招待コードを発行');
    return ok(code);
  },

  async revokeInvitationCode(user: SessionUser, codeId: number): Promise<void> {
    if (user.role !== '1') return fail('招待コードの失効は管理者のみが行えます');
    const c = db.invitationCodes.find((x) => x.invitation_code_id === codeId);
    if (!c) return fail('招待コードが見つかりません');
    if (c.status === '2') return fail('使用済みの招待コードは失効できません');
    // 失効済みのコードを重ねて失効させない。操作ログに事実と違う「変更前：未使用」が残る（GitHub Issue #166 の 6）
    if (c.status === '3') return fail('この招待コードはすでに失効しています');
    c.status = '3';
    log(user.account_id, '7', '2', 't_invitation_code', codeId, c.child_id, '未使用', '失効');
    return ok(undefined);
  },

  /** 保護者アカウントの一覧（保護者アカウント管理画面。管理者のみ） */
  async guardianAccounts(user: SessionUser) {
    if (user.role !== '1') return fail('アカウント管理は管理者のみが行えます');
    return ok(db.guardians.map((g) => {
      const a = findAccount(g.account_id)!;
      const links = db.guardianChildren.filter((gc) => gc.guardian_id === g.guardian_id).map((gc) => ({
        ...gc, child_name: childName(gc.child_id),
      }));
      return {
        guardian: g, account: a, links,
        activeLinks: links.filter((l) => l.link_status === '1').length,
        // 未同意者の確認（画面詳細図 3-2 の一覧に対応）
        termsAgreed: a.terms_version === CURRENT_TERMS_VERSION,
      };
    }));
  },

  /**
   * 紐づけの解除。紐づけ単位で終了させ、有効な紐づけがゼロになった時点でアカウントを停止する
   * （基本設計書 5-3）
   */
  async endGuardianLink(user: SessionUser, guardianId: string, childId: string): Promise<void> {
    if (user.role !== '1') return fail('紐づけの解除は管理者のみが行えます');
    const gc = db.guardianChildren.find((x) => x.guardian_id === guardianId && x.child_id === childId && x.link_status === '1');
    if (!gc) return fail('有効な紐づけが見つかりません');
    gc.link_status = '2';
    gc.ended_at = now();

    const remaining = db.guardianChildren.filter((x) => x.guardian_id === guardianId && x.link_status === '1').length;
    const g = db.guardians.find((x) => x.guardian_id === guardianId);
    if (remaining === 0 && g) {
      const a = findAccount(g.account_id);
      if (a) { a.status = '2'; a.updated_at = now(); }
    }
    /*
     * 解除するとその園児の記録を参照できなくなる（画面詳細図 7-8 項目6）。保護者は left_at が入った時点で
     * 参照できなくなる（基本設計書「チャット」(5-5)）。その園児の個人チャットと、ほかに有効な紐づけのある園児が
     * 在籍していないクラスのクラスグループに left_at を入れる（GitHub Issue #159。server/api_admin.go の leaveRoomsOfChild）。
     * サーバはあわせてログイン中のセッションを切る。モックはセッションを持たないため、有効な紐づけがゼロに
     * なって停止したアカウントを、呼ばれるたびに断る（下の guardProcedure）
     */
    if (g) leaveRoomsOfChild(g.account_id, guardianId, childId);

    // 紐づけの表は数値の主キーを持たない。相手が分かるよう、保護者のアカウントを対象として残す
    log(user.account_id, '7', '2', 't_guardian_child', g?.account_id ?? null, childId, '有効',
      remaining === 0 ? '終了（有効な紐づけがゼロのためアカウントを停止）' : '終了');
    return ok(undefined);
  },

  /**
   * 解除した紐づけを戻す。誤って解除したときの戻し先。
   * 解除によってアカウントが停止していた場合は、あわせて再開する（GitHub Issue #118）
   */
  async restoreGuardianLink(user: SessionUser, guardianId: string, childId: string): Promise<void> {
    if (user.role !== '1') return fail('紐づけの変更は管理者のみが行えます');
    const gc = db.guardianChildren.find((x) => x.guardian_id === guardianId && x.child_id === childId && x.link_status === '2');
    if (!gc) return fail('終了した紐づけが見つかりません');
    gc.link_status = '1';
    gc.ended_at = null;

    const g = db.guardians.find((x) => x.guardian_id === guardianId);
    const a = g ? findAccount(g.account_id) : undefined;
    let after = '有効';
    if (a && a.status === '2') {
      a.status = '1';
      a.updated_at = now();
      after = '有効（アカウントを再開）';
    }
    if (a) rejoinRoomsOfChild(a.account_id, childId);
    log(user.account_id, '7', '2', 't_guardian_child', g?.account_id ?? null, childId, '終了', after);
    return ok(undefined);
  },
};

/** その園児が在籍するクラス */
const classIdsOfChild = (childId: string) =>
  new Set(db.classChildren.filter((cc) => cc.child_id === childId).map((cc) => cc.class_id));

/**
 * 紐づけを解除した保護者を、その園児の個人チャットと、ほかに有効な紐づけのある園児が在籍していないクラスの
 * クラスグループから外す（left_at を入れる）。所属していた期間の記録は残す（基本設計書 5-5）。
 * サーバ側（server/api_admin.go の leaveRoomsOfChild）と同じ規則
 */
function leaveRoomsOfChild(accountId: number, guardianId: string, childId: string): void {
  const classes = classIdsOfChild(childId);
  const stillLinkedClasses = new Set(db.classChildren
    .filter((cc) => db.guardianChildren.some((gc) =>
      gc.guardian_id === guardianId && gc.child_id === cc.child_id && gc.link_status === '1'))
    .map((cc) => cc.class_id));
  const leave = new Set(db.chatRooms
    .filter((r) => (r.room_type === '4' && r.child_id === childId)
      || (r.room_type === '2' && r.class_id !== null && classes.has(r.class_id) && !stillLinkedClasses.has(r.class_id)))
    .map((r) => r.chat_room_id));
  db.chatMembers
    .filter((m) => m.account_id === accountId && m.left_at === null && leave.has(m.chat_room_id))
    .forEach((m) => { m.left_at = now(); });
}

/**
 * 紐づけを戻した保護者を、その園児の個人チャットとクラスグループへ戻す（left_at を空にする）。
 * 誤って解除したときの戻し先であり、解除の前の状態へ戻す（GitHub Issue #118・#159。server/api_admin.go の rejoinRoomsOfChild）
 */
function rejoinRoomsOfChild(accountId: number, childId: string): void {
  const classes = classIdsOfChild(childId);
  const rooms = new Set(db.chatRooms
    .filter((r) => (r.room_type === '4' && r.child_id === childId)
      || (r.room_type === '2' && r.class_id !== null && classes.has(r.class_id)))
    .map((r) => r.chat_room_id));
  db.chatMembers
    .filter((m) => m.account_id === accountId && m.left_at !== null && rooms.has(m.chat_room_id))
    .forEach((m) => { m.left_at = null; });
}

/** 続柄の選択肢（画面詳細図「新規登録画面（保護者）」(2-3) 項目11。server/api_auth.go の guardianRelationships） */
const GUARDIAN_RELATIONSHIPS: readonly string[] = ['母', '父', '祖母', '祖父', 'その他'];

/** 推測困難な値とする（基本設計書 5-2）。モックのため乱数の強度は本実装で見直す */
function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return `${block()}-${block()}-${block()}`;
}

const adminApi3 = {
  /** 保護者アカウントの自己登録（基本設計書「保護者アカウントの自己登録」(4-3)） */
  async verifyInvitationCode(code: string): Promise<{ ok: true } | never> {
    // 園児名を返さない。誰の保護者かを名乗る前の段階であるため（画面詳細図 2-3）
    const normalized = normalizeInvitationCode(code);
    const c = db.invitationCodes.find((x) => normalizeInvitationCode(x.code) === normalized);
    if (!c) return fail('招待コードが確認できません。園から配布されたコードをお確かめください');
    if (c.status === '2') return fail('この招待コードはすでに使われています');
    if (c.status === '3') return fail('この招待コードは失効しています');
    if (c.expires_on < today()) return fail('この招待コードは有効期限が切れています');
    // 取り消した・在籍していない園児のコードでは登録させない。園児の状態は言わず、無いコードと同じ文言にする
    // （GitHub Issue #166 の 4。サーバ側は server/api_auth.go の lookupUsableCode）
    if (!childIssuable(c.child_id).issuable) return fail('招待コードが確認できません。園から配布されたコードをお確かめください');
    return ok({ ok: true as const });
  },

  async signUpGuardian(
    input: {
      code: string; email: string; password: string; guardian_name: string; relationship: string;
      /** 利用規約に同意したか（画面の「利用規約に同意します」）と、画面に出して同意を得た規約の版 */
      terms_agreed: boolean; terms_version: string;
    },
  ): Promise<SessionUser> {
    /*
     * この関数は、コードが未使用かを確かめてから使用済みにするまで、待たずに（await を挟まずに）進める。
     * あいだに同じコードでの別の登録が割り込まないようにするため。1枚のコードは1アカウントの登録にのみ使える
     * （基本設計書 5-2。GitHub Issue #163）。サーバ側は取引の中の条件付きの更新で同じことを守る（server/api_auth.go）
     */
    const normalized = normalizeInvitationCode(input.code);
    const c = db.invitationCodes.find((x) => normalizeInvitationCode(x.code) === normalized);
    if (!c || c.status !== '1' || c.expires_on < today() || !childIssuable(c.child_id).issuable) {
      return fail('招待コードが確認できません');
    }
    /*
     * 規約への同意を受け取ってから登録する。同意しなかった場合は登録を完了しない
     * （基本設計書「保護者アカウントの自己登録」(4-3)、画面詳細図 2-3 項目5。GitHub Issue #170）。
     * 同意した版は、画面に出した版といま有効な版が同じときだけ記録する（同「同意履歴（t_terms_agreement）」(5-2)）。
     * 文言は server/api_auth.go と同じ
     */
    if (input.terms_agreed !== true) return fail('利用規約に同意いただけない場合、ご利用いただけません。');
    // 【仮置き】画面に出していた規約が、送るまでのあいだに改定されたときの文言（web/仮置き値.md）
    if (input.terms_version !== CURRENT_TERMS_VERSION) {
      return fail('利用規約が改定されました。改定後の利用規約をお読みいただき、あらためて同意してください。');
    }
    // ログインIDはメールアドレス。空や形式の誤りを受け付けない（要件定義書「ログインIDの定義」(4-1-1)）
    input = { ...input, email: input.email.trim(), guardian_name: (input.guardian_name ?? '').trim() };
    const emailError = validateEmail(input.email);
    if (emailError) return fail(emailError);
    // ログインIDはロールをまたいで園内で一意（基本設計書 5-2）。大文字・小文字だけの違いは同じ宛先として扱う
    // （GitHub Issue #170。判定は職員アカウントの発行と同じ emailTaken。GitHub Issue #167 の 1）
    if (emailTaken(input.email)) return fail('このメールアドレスはすでに登録されています');
    // 8〜128文字（文字数で数える）。よく使われるパスワードは拒否する（server/password.go と同じ規則。GitHub Issue #159）
    const passwordError = validateNewPassword(input.password);
    if (passwordError) return fail(passwordError);
    // 氏名は前後の空白を落として、50文字以内（基本設計書「入力項目の制約値」(4-9)）
    if (!input.guardian_name) return fail('保護者の氏名を入力してください');
    if (tooLong(input.guardian_name, 50)) return fail('保護者の氏名は50文字以内で入力してください');
    // 続柄は必須で、選択肢のどれか（画面詳細図 2-3 項目11）
    if (!GUARDIAN_RELATIONSHIPS.includes(input.relationship)) {
      return fail('続柄は 母・父・祖母・祖父・その他 から選んでください');
    }

    const accountId = nextId();
    db.accounts.push({
      account_id: accountId, email: input.email, password_hash: input.password, role: '3', status: '1',
      is_temp_password: false, temp_password_expires_at: null, failed_login_count: 0, locked_until: null,
      terms_version: CURRENT_TERMS_VERSION, terms_agreed_at: now(), created_at: now(), updated_at: now(),
    });
    // 登録のときの同意も履歴へ残す（基本設計書「同意履歴（t_terms_agreement）」(5-2)）
    recordTermsAgreement(accountId, now());
    const guardianId = `G${String(db.guardians.length + 1).padStart(3, '0')}`;
    db.guardians.push({
      guardian_id: guardianId, account_id: accountId, guardian_name: input.guardian_name,
      phone_number: null, created_at: now(), updated_at: now(),
    });
    db.guardianChildren.push({
      guardian_id: guardianId, child_id: c.child_id, relationship: input.relationship,
      link_status: '1', linked_at: now(), ended_at: null,
    });

    // 使用と同時に status を使用済みにする。1枚のコードは1アカウントの登録にのみ使える（基本設計書 5-2）
    c.status = '2';
    c.used_account_id = accountId;
    c.used_at = now();

    // 自児の個人チャットへ参加させる。個人チャットは園児ID で引く。部屋の名前（園児名＋「の保護者」）で探すと、
    // 同じ氏名の別の園児がいるとき、別の家庭の個人チャットに入ってしまう（GitHub Issue #163。#140）
    const room = db.chatRooms.find((r) => r.room_type === '4' && r.child_id === c.child_id);
    if (room) db.chatMembers.push({ chat_room_id: room.chat_room_id, account_id: accountId, joined_at: now(), left_at: null });
    const classId = db.classChildren.find((cc) => cc.child_id === c.child_id)?.class_id ?? null;
    const classRoom = classId ? db.chatRooms.find((r) => r.room_type === '2' && r.class_id === classId) : null;
    if (classRoom) db.chatMembers.push({ chat_room_id: classRoom.chat_room_id, account_id: accountId, joined_at: now(), left_at: null });
    const zenRoom = db.chatRooms.find((r) => r.room_type === '1');
    if (zenRoom) db.chatMembers.push({ chat_room_id: zenRoom.chat_room_id, account_id: accountId, joined_at: now(), left_at: null });

    log(accountId, '7', '1', 'm_account', accountId, c.child_id, null, '保護者アカウントを自己登録');
    return ok(buildSessionUser(db.accounts.find((a) => a.account_id === accountId)!));
  },

  /** 操作ログの参照。管理者のみ（基本設計書「監査への対応」(6-4)） */
  async operationLogs(
    user: SessionUser,
    f: { from?: string; to?: string; accountId?: number | ''; functionType?: FunctionType | ''; childId?: string; page?: number } = {},
  ): Promise<Paged<OperationLog & { account_name: string; child_name: string; target_label: string }>> {
    if (user.role !== '1') return fail('操作ログの参照は管理者のみが行えます');
    const perPage = settingNumber('paging.operation_log_per_page', 100);
    let rows = db.operationLogs.map((l) => ({
      ...l, account_name: accountName(l.account_id), child_name: l.target_child_id ? childName(l.target_child_id) : '―',
      target_label: targetLabel(l.target_table, l.target_id),
    }));
    if (f.from) rows = rows.filter((l) => l.operated_at.slice(0, 10) >= f.from!);
    if (f.to) rows = rows.filter((l) => l.operated_at.slice(0, 10) <= f.to!);
    if (f.accountId) rows = rows.filter((l) => l.account_id === f.accountId);
    if (f.functionType) rows = rows.filter((l) => l.function_type === f.functionType);
    if (f.childId) rows = rows.filter((l) => l.target_child_id === f.childId);
    rows.sort((a, b) => b.operated_at.localeCompare(a.operated_at));
    const page = f.page ?? 1;
    return ok({ rows: rows.slice((page - 1) * perPage, page * perPage), total: rows.length, page, per_page: perPage });
  },

  /**
   * 画面側で組み立てた出力（CSV）を操作ログへ記録する。
   * 出力は目的を問わず操作ログへ記録する（基本設計書「発達チェック・身体測定」(4-8) と同じ扱い。
   * GitHub Issue #115・#117）
   */
  async recordExport(
    user: SessionUser, kind: ExportKind, from: string, to: string, count: number,
  ): Promise<void> {
    if (user.role === '3') return fail('出力は職員のみが行えます');
    const period = `期間 ${from}〜${to}・${count} 件`;
    if (kind === 'operation_log') {
      if (user.role !== '1') return fail('操作ログの出力は管理者のみが行えます');
      log(user.account_id, '7', '5', 't_operation_log', null, null, null, `操作ログをCSV出力（${period}）`);
    } else if (kind === 'nap_record') {
      log(user.account_id, '3', '5', 't_nap_record', null, null, null, `午睡記録をCSV出力（${period}）`);
    } else if (kind === 'allergy_list') {
      /*
       * 要配慮個人情報の一覧。印刷できるのは管理者・一般（保護者は上で断る）。担任でない職員も、受け入れや
       * 合同保育で子を見る場面で配膳に使うため（基本設計書「権限と利用可能機能」(6-1)「アレルギー一覧の印刷」、
       * 画面詳細図「アレルギー一覧画面」(7-4) の項目2。設計の直しは PR #216 の直-16・直-24）。
       * サーバ側は server/api_audit.go の handleRecordExport
       */
      log(user.account_id, '6', '5', 'm_allergy', null, null, null, `アレルギー一覧を印刷（${count} 名）`);
    } else {
      if (user.role !== '1') return fail('招待コードの出力は管理者のみが行えます');
      log(user.account_id, '7', '5', 't_invitation_code', null, null, null, `招待コードを配布用に出力（${count} 枚）`);
    }
    return ok(undefined);
  },

  async allAccounts(user: SessionUser) {
    if (user.role !== '1') return fail('アカウント一覧は管理者のみが参照できます');
    return ok(db.accounts.map((a) => ({ account_id: a.account_id, name: accountName(a.account_id), role: a.role })));
  },
};

/* ============ CSV一括登録・年度更新（基本設計書 4-4） ============ */

const CSV_HEADER = ['園児ID', '氏名', '氏名かな', '生年月日', '性別', 'クラス名', '平熱'];
const CSV_HEADER_MESSAGE = `見出しの並びが取込の様式と違います。1行目を「${CSV_HEADER.join(',')}」の順にしてください（平熱の列は省けます）`;

/** 見出しの並びが取込の様式と同じか。平熱の列は省いてよい。BOM 付きでも読む（server/api_bulk.go の checkCsvHeader） */
function isCsvHeader(line: string): boolean {
  const cols = line.replace(/^﻿/, '').split(',').map((c) => c.trim());
  if (cols.length < CSV_HEADER.length - 1 || cols.length > CSV_HEADER.length) return false;
  return cols.every((c, i) => c === CSV_HEADER[i]);
}

/** 園児IDの上限（基本設計書「入力項目の制約値」(4-9)「園児ID・職員ID｜20文字以内」） */
const CHILD_ID_MAX_LENGTH = 20;

/**
 * 平熱として受け取る書き方。小数第1位までの数（基本設計書「入力項目の制約値」(4-9)「体温｜30.0〜43.0℃、
 * 小数第1位まで」）。平熱が数値でない行は誤りとする（同「CSV一括登録」(4-4)）。範囲の外は誤りとせず確認を促す。
 * 【仮置き】整数部は3桁まで（web/仮置き値.md）。サーバ側（server/api_bulk.go の temperatureRe）と同じ規則（GitHub Issue #160）
 */
const TEMPERATURE_FORMAT = /^\d{1,3}(\.\d)?$/;

const bulkApi = {
  /** 取込内容とエラー行の確認。取り込む前に全行を検証して返す（画面詳細図の様式に合わせる） */
  parseChildCsv(text: string): { header: string[]; rows: CsvRow[] } {
    const header = CSV_HEADER;
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    // 見出しの並びが違うときは、行を読まずにファイルごと断る。行を読み進めると、別の列の値を
    // 園児ID や氏名として取り込んでしまうため（GitHub Issue #160。server/api_bulk.go の checkCsvHeader）
    if (lines[0]?.includes('園児ID') && !isCsvHeader(lines[0])) throw new Error(CSV_HEADER_MESSAGE);
    const body = lines[0]?.includes('園児ID') ? lines.slice(1) : lines;

    // 同じ取込の中での重複も弾く。ファイル内で同じ園児IDが2度出ることがある
    const seen = new Set<string>();
    // 同じ氏名・生年月日の行が、このファイルの何行目に先に出たか。重ねて登録していないかを知らせる（GitHub Issue #144 の 2）
    const seenPerson = new Map<string, number>();
    const rows: CsvRow[] = body.map((line, i) => {
      const values = line.split(',').map((v) => v.trim());
      // 誤りは1行の中でまとめて示す。1つ直すたびに次の誤りが出る作りにしない（GitHub Issue #121）
      const errors: string[] = [];
      // 取り込みは妨げないが、確かめてほしいこと。誤りと同じく1行の中でまとめて示す
      const warnings: string[] = [];
      let personKey = '';

      if (values.length < 6) {
        errors.push('列が足りません（園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱）');
      } else {
        if (!values[0]) errors.push('園児IDが空です');
        else if (tooLong(values[0], CHILD_ID_MAX_LENGTH)) errors.push('園児IDは20文字以内で入力してください');
        else if (seen.has(values[0])) errors.push('同じ園児IDがこのファイル内で重複しています');
        else if (db.children.some((c) => c.child_id === values[0])) errors.push('その園児IDはすでに登録されています');
        if (!values[1]) errors.push('氏名が空です');
        if (!values[2]) errors.push('氏名かなが空です');
        else if (!isKana(values[2])) errors.push('氏名かなは、ひらがなで入力してください');
        if (tooLong(values[1], 50) || tooLong(values[2], 50)) errors.push('氏名と氏名かなは、それぞれ50文字以内で入力してください');
        // 実在する日付に限る（2025-02-30 を通さない）。生年月日は月齢算出の唯一の根拠（基本設計書 5-3。GitHub Issue #160）
        if (!isRealDate(values[3])) errors.push('生年月日の形式が正しくありません。YYYY-MM-DD の形で、実在する日付を入力してください');
        else if (values[3] > today()) errors.push('生年月日に未来日は指定できません');
        if (!['1', '2', '9'].includes(values[4])) errors.push('性別は 1:男 2:女 9:未回答 で入力してください');
        if (!db.classes.some((c) => c.fiscal_year === db.FISCAL_YEAR && c.class_name === values[5])) errors.push('クラス名が見つかりません');
        if (values[6]) {
          // Number() は Infinity・0x24・1e2 も数にする。数字と小数点だけの書き方に限る（TEMPERATURE_FORMAT）
          const t = Number(values[6]);
          if (!TEMPERATURE_FORMAT.test(values[6]) || !Number.isFinite(t)) errors.push('平熱は数値（小数第1位まで。例：36.5）で入力してください');
          else if (t < TEMPERATURE_MIN || t > TEMPERATURE_MAX) warnings.push('平熱が想定の範囲（30.0〜43.0℃）の外です。値を確かめてください');
        }

        /*
         * 同じ氏名・生年月日の園児が登録済みか、このファイルの前の行にあれば、確認を促す。止めはしない
         * （GitHub Issue #144 の 2。【仮置き】web/仮置き値.md「同じ氏名・生年月日の園児の知らせ」）。
         * 園児IDは別の番号が振られるため、ID の重複では同じ子の二重登録に気づけない。server/api_bulk.go と同じ
         */
        if (childNameKey(values[1]) && isRealDate(values[3])) {
          personKey = `${childNameKey(values[1])}|${values[3]}`;
          const same = findSameNameBirthChildren(values[1], values[3]);
          if (same.length > 0) {
            warnings.push(`同じ氏名・生年月日の園児がいます（${same.map((c) => c.child_id).join('・')}）。同じ子を重ねて登録していないか確かめてください`);
          }
          const first = seenPerson.get(personKey);
          if (first !== undefined) {
            warnings.push(`同じ氏名・生年月日の行がこのファイル内にあります（${first} 行目）。同じ子を重ねて登録していないか確かめてください`);
          }
        }
      }
      if (errors.length === 0) {
        seen.add(values[0]);
        if (personKey && !seenPerson.has(personKey)) seenPerson.set(personKey, i + 1);
      }

      return {
        line: i + 1, values, error: errors.length > 0 ? errors.join('／') : null,
        warning: warnings.length > 0 ? warnings.join('／') : null,
      };
    });
    return { header, rows };
  },

  /**
   * エラー行があるときは1件も取り込まない。中途半端な状態を作らないため。
   * 取り込む直前にもう一度検証する。画面が確認したときの原文（text）を、サーバ実装（http.ts）と同じく読み直す
   * （server/api_bulk.go の handleImportChildCsv と同じ。GitHub Issue #160 の 3）
   */
  async importChildCsv(user: SessionUser, confirmed: CsvRow[], text?: string): Promise<number> {
    if (user.role !== '1') return fail('CSV一括登録は管理者のみが行えます');
    let rows: CsvRow[];
    try {
      rows = bulkApi.parseChildCsv(text ?? confirmed.map((r) => r.values.join(',')).join('\n')).rows;
    } catch (e) {
      return fail((e as Error).message);
    }
    if (rows.some((r) => r.error)) return fail('エラー行があるため取り込めません。すべて解消してから実行してください');
    if (rows.length === 0) return fail('取り込む行がありません');

    rows.forEach((r) => {
      const [id, name, kana, birth, sex, clsName, temp] = r.values;
      db.children.push({
        child_id: id, child_name: name, child_name_kana: kana, birth_date: birth,
        sex: sex as Child['sex'], normal_temperature: temp ? Number(temp) : null,
        enrollment_status: '1', photo_consent_level: '2', is_deleted: false,
        created_at: now(), updated_at: now(),
      });
      const cls = db.classes.find((c) => c.fiscal_year === db.FISCAL_YEAR && c.class_name === clsName)!;
      db.classChildren.push({ class_id: cls.class_id, child_id: id });
    });
    // 登録した園児ごとに、対象園児つきで残す。件数だけの 1 行では、対象園児で絞り込んだときに出ない
    // （基本設計書「操作ログ（t_operation_log）」(5-8)、GitHub Issue #166 の 5。サーバ側は handleImportChildCsv）
    rows.forEach((r) => {
      const id = r.values[0];
      log(user.account_id, '6', '1', 'm_child', null, id, null,
        fieldsJSON([['登録', 'CSV一括登録'], ...childFields(id)]));
    });
    return ok(rows.length);
  },

  /** 年度更新。実行前に更新内容を一覧で確認させる（基本設計書「年度更新」(4-4)） */
  async previewFiscalYearUpdate(user: SessionUser) {
    if (user.role !== '1') return fail('年度更新は管理者のみが行えます');
    const next = db.FISCAL_YEAR + 1;
    const current = db.classes.filter((c) => c.fiscal_year === db.FISCAL_YEAR);
    return ok({
      nextFiscalYear: next,
      classes: current.map((c) => ({
        className: c.class_name,
        childCount: db.classChildren.filter((cc) => cc.class_id === c.class_id).length,
        staffNames: db.classStaff.filter((cs) => cs.class_id === c.class_id).map((cs) => staffName(cs.staff_id)),
      })),
      // 年度更新の実行（進級先の割り当て・卒園の処理）は、モックアップでは実装していない
      note: 'このモックアップでは、年度更新の実行を実装していません。現在の年度の内訳だけを表示しています',
    });
  },
};

/* ============ ダッシュボード（画面詳細図 2-4） ============ */

const dashboardApi = {
  /** 未対応の件数を最上部に置く。出勤直後に何が残っているかを1画面で把握させる */
  async staffSummary(user: SessionUser) {
    // 職員ダッシュボードは職員に限る（サーバ側の server/api_dashboard.go の handleStaffSummary と同じ。GitHub Issue #177 の 3）
    if (user.role === '3') return fail(STAFF_ONLY_MESSAGE);
    const visible = new Set(visibleChildren(user).map((c) => c.child_id));
    const myClasses = new Set(selectableClasses(user).map((c) => c.class_id));

    // 自分が書いて差し戻された日誌。開いた先の日誌一覧（状態＝差し戻し・自分が書いたもの）と同じ範囲を数える
    // （GitHub Issue #174。サーバ側は server/api_dashboard.go）
    const returned = db.diaries.filter((d) => canSeeDiary(user, d) && d.status === '4'
      && d.created_staff_id === user.staff_id).length;

    const rooms = db.chatMembers.filter((m) => m.account_id === user.account_id).map((m) => m.chat_room_id);
    // 外れたチャンネルの、外れたあとの投稿は数えない（読めないため。GitHub Issue #161）
    const unreadChat = db.chatMessages.filter((m) =>
      rooms.includes(m.chat_room_id) && !m.is_deleted && m.sender_account_id !== user.account_id
      && !hiddenAfterLeft(user, m)
      && !db.chatReads.some((r) => r.chat_message_id === m.chat_message_id && r.account_id === user.account_id)).length;

    // 未対応のままの、保護者との個人チャット。チャット画面の見出しの「未対応 n 件」と同じ範囲を数え、
    // 一覧と同じ並び（チャンネルの番号順）で先頭のものを「開く」の行き先にする（server/api_dashboard.go と同じ）。
    // 外れた個人チャット（担任を付け替える前のクラスの家庭など）は数えない。返信も状態の切り替えもできないため
    const unhandledRooms = db.chatRooms
      .filter((r) => r.room_type === '4' && r.thread_status === '1' && isParticipant(user, r.chat_room_id))
      .sort((a, b) => a.chat_room_id - b.chat_room_id);
    const unhandledChat = unhandledRooms.length;
    const unhandledChatRoom = unhandledRooms[0]
      ? { chat_room_id: unhandledRooms[0].chat_room_id, room_name: unhandledRooms[0].room_name }
      : null;

    // 発達チェックの未実施。園児ごとに最新の予定日で判定し、発達チェック一覧の「未実施」と同じ数にする
    // （過去の予定をすべて数えると一覧と食い違う。GitHub Issue #164。サーバ側は server/api_dashboard.go）
    const devOverdue = [...visible].filter((childId) =>
      isDevOverdue(latestSchedule(childId)?.scheduled_on ?? null, lastConfirmedCheck(childId)?.checked_on ?? null)).length;

    // 承認待ちの区画は管理者にのみ表示する
    const pending = user.role === '1' ? db.diaries.filter((d) => !d.is_deleted && d.status === '2').length : 0;

    // 異常時の記録のうち、ヒヤリハットを起票していないもの
    const abnormalWithoutDiary = db.napAbnormals.filter((a) => !a.diary_id && visible.has(a.child_id)).length;

    // 実施中の午睡チェック
    autoCloseNapSessions();
    const activeNap = db.napSessions.find((s) => s.ended_at === null && myClasses.has(s.class_id)) ?? null;

    return ok({ returned, unreadChat, unhandledChat, unhandledChatRoom, devOverdue, pending, abnormalWithoutDiary, activeNap });
  },

  /** 保護者ホーム。自児の情報とチャットへの導線（基本設計書「画面の一覧」(3-2)） */
  async guardianHome(user: SessionUser) {
    // 保護者ホームは保護者のためのもの。職員が呼ぶと、参照範囲の園児すべてが「自児」として並ぶ
    // （GitHub Issue #159 の 3。server/api_dashboard.go の handleGuardianHome と同じ）
    if (user.role !== '3') return fail('保護者ホームは保護者のみが利用できます');
    const mine = user.guardian_id ? childrenOfGuardian(user.guardian_id) : [];
    const rooms = db.chatMembers.filter((m) => m.account_id === user.account_id && m.left_at === null).map((m) => m.chat_room_id);
    const unread = db.chatMessages.filter((m) =>
      rooms.includes(m.chat_room_id) && !m.is_deleted && m.sender_account_id !== user.account_id
      && !hiddenBeforeJoined(user, m)
      && !db.chatReads.some((r) => r.chat_message_id === m.chat_message_id && r.account_id === user.account_id)).length;

    return ok(mine.map((child) => ({
      child,
      ageMonths: ageInMonths(child.birth_date, today()),
      className: className(db.classChildren.find((cc) => cc.child_id === child.child_id)?.class_id ?? null),
      // 共有された個人日誌のみ。承認と共有の指定が済んだものだけが保護者に見える（canSeeDiary と同じ条件）
      sharedDiaries: db.diaries
        .filter((d) => d.child_id === child.child_id && canSeeDiary(user, d))
        .sort((a, b) => b.diary_date.localeCompare(a.diary_date)),
      unread,
    })));
  },
};

/* ============ 園からの配布物（基本設計書「配布物の掲載と閲覧」(4-6)） ============
 *
 * 園だより・献立表など、保護者があとから見返すものを、種類と月で並べて置く。
 * Go サーバ（server/api_handout.go）と同じ規則にしてある。片方だけ直すと食い違う。
 */

/**
 * その利用者が見られる配布物か
 *
 * 園全体向けは全員が見られる。クラス向けは、管理者はすべて、一般は自クラス、
 * 保護者は自児がいま在籍するクラスのものだけを見られる。
 */
function canSeeHandout(user: SessionUser, h: Handout): boolean {
  if (h.class_id === null || user.role === '1') return true;
  if (user.role === '2') return user.class_id === h.class_id;
  const mine = user.guardian_id ? childrenOfGuardian(user.guardian_id).map((c) => c.child_id) : [];
  return db.classChildren.some((cc) => cc.class_id === h.class_id && mine.includes(cc.child_id)
    && db.classes.find((c) => c.class_id === cc.class_id)?.fiscal_year === db.FISCAL_YEAR);
}

const handoutApi = {
  /** 見られる配布物を、対象の月の新しい順に返す */
  async handouts(user: SessionUser, f: { type?: string; month?: string } = {}): Promise<Handout[]> {
    return ok(db.handouts
      .filter((h) => !h.is_deleted && canSeeHandout(user, h))
      .filter((h) => !f.type || h.handout_type === f.type)
      .filter((h) => !f.month || h.target_month === f.month)
      .sort((a, b) => b.target_month.localeCompare(a.target_month)
        || b.posted_at.localeCompare(a.posted_at) || b.handout_id - a.handout_id)
      .map((h) => ({
        ...h,
        class_name: h.class_id === null ? '園全体' : className(h.class_id),
        posted_staff_name: staffName(h.posted_staff_id),
      })));
  },

  /**
   * 配布物を掲載する。管理者のみ
   * 掲載したことは、園全体向けなら園チャット、クラス向けならそのクラスグループへ知らせる
   */
  async postHandout(
    user: SessionUser,
    input: { handout_type: string; title: string; target_month: string; class_id: number | null;
             file_name: string; file_type: string; file_size: number },
  ): Promise<Handout> {
    if (user.role !== '1') return fail('この操作は管理者のみが行えます');
    const title = input.title.trim();
    if (!(input.handout_type in HANDOUT_TYPE)) return fail('種類を選んでください');
    if (!title) return fail('題名を入力してください');
    if ([...title].length > 50) return fail('題名は50文字以内で入力してください');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.target_month)) return fail('対象の月を選んでください');
    if (!input.file_name.trim()) return fail('ファイルを選んでください');
    const allowed = settingText('handout.allowed_types', 'application/pdf,image/jpeg,image/png').split(',');
    if (!allowed.includes(input.file_type)) return fail('掲載できるのは PDF・JPEG・PNG のファイルです');
    const maxMB = settingNumber('attachment.max_size_mb', 10);
    if (!(input.file_size > 0) || input.file_size > maxMB * 1024 * 1024) return fail(`ファイルは${maxMB}MB までです`);
    if (input.class_id !== null
      && !db.classes.some((c) => c.class_id === input.class_id && c.fiscal_year === db.FISCAL_YEAR)) {
      return fail('対象のクラスが見つかりません');
    }

    const h: Handout = {
      handout_id: nextId(), handout_type: input.handout_type as Handout['handout_type'], title,
      target_month: input.target_month, class_id: input.class_id,
      file_name: input.file_name, file_type: input.file_type, file_size: input.file_size,
      posted_staff_id: user.staff_id!, posted_at: now(), is_deleted: false,
    };
    db.handouts.push(h);
    log(user.account_id, '2', '1', 't_handout', h.handout_id, null, null, `配布物を掲載（${title}）`);

    const room = input.class_id === null
      ? db.chatRooms.find((r) => r.room_type === '1')
      : db.chatRooms.find((r) => r.room_type === '2' && r.class_id === input.class_id);
    if (room) {
      db.chatMessages.push({
        chat_message_id: nextId(), chat_room_id: room.chat_room_id, sender_account_id: user.account_id,
        body: `「${title}」を掲載しました。`, source_type: '4', source_id: h.handout_id, sent_at: now(),
        edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null,
      });
    }
    return ok(h);
  },

  /** 配布物を取り下げる。論理削除とし、一覧から消す。掲載の知らせも取り消す。管理者のみ */
  async withdrawHandout(user: SessionUser, handoutId: number): Promise<void> {
    if (user.role !== '1') return fail('この操作は管理者のみが行えます');
    const h = db.handouts.find((x) => x.handout_id === handoutId && !x.is_deleted);
    if (!h) return fail('配布物が見つかりません');
    h.is_deleted = true;
    // 掲載の知らせも取り消す。知らせだけが残ると、開いても見つからない配布物へ案内し続けることになる
    db.chatMessages
      .filter((m) => m.source_type === '4' && m.source_id === handoutId && !m.is_deleted)
      .forEach((m) => { m.is_deleted = true; m.body = ''; m.deleted_at = now(); m.deleted_account_id = user.account_id; });
    log(user.account_id, '2', '4', 't_handout', handoutId, null, h.title, '取り下げ');
    return ok(undefined);
  },
};

/* ============ 手続きを終えるまでの拒否（基本設計書「画面遷移」(3-4)） ============
 *
 * 一時パスワード中と規約の再同意が必要な間は、手続きの API 以外を拒否する（api/procedure.ts）。
 * サーバ側は server/session.go の requireUser。サーバはセッションから利用者を引いて判定するが、
 * モックでは引数に渡された利用者がセッションの代わりのため、その利用者の状態で判定する。
 * 利用者を受け取らない関数（allergiesOf など）は、モックでは判定できない（参照範囲の判定も同じ）。
 */

/** 手続きの途中でも呼べるもの。手続きの画面（TopScreen・PasswordChangeScreen・TermsAgreeScreen）と新規登録が呼ぶ */
const PROCEDURE_APIS = new Set([
  'login', 'logout', 'bootstrap', 'reloadSession', 'changePassword', 'agreeTerms', 'currentTerms',
  'verifyInvitationCode', 'signUpGuardian',
]);

function isSessionUser(v: unknown): v is SessionUser {
  return typeof v === 'object' && v !== null && 'account_id' in v && 'is_temp_password' in v && 'terms_agreed' in v;
}

/*
 * 停止中のアカウントは、ログイン中であっても通さない（GitHub Issue #159）。
 * サーバはアカウントの停止・紐づけの解除のときにセッションを切り、要求のたびにアカウントの状態も読む
 * （server/session.go の requireLogin・destroyAccount）。モックはセッションを持たないため、引数の利用者の
 * アカウントの状態を、呼ばれるたびに読む。パスワードの変更・一時パスワードの再発行で「ほかの端末」を切る扱いは、
 * 端末を区別できないため、モックには無い。
 */
function sessionAlive(u: SessionUser): boolean {
  return findAccount(u.account_id)?.status !== '2';
}

function guardProcedure<T extends Record<string, unknown>>(apis: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(apis)) {
    if (typeof fn !== 'function' || PROCEDURE_APIS.has(name)) { out[name] = fn; continue; }
    out[name] = (...args: unknown[]) => {
      const caller = args.find(isSessionUser);
      if (caller && !sessionAlive(caller)) return sessionEnded();
      const kind = caller ? pendingProcedure(caller) : null;
      if (!kind) return fn(...args);
      notifyProcedureRequired(kind);
      return new Promise((_, reject) => setTimeout(() => reject(new ProcedureRequiredError(kind)), 60));
    };
  }
  return out as T;
}

/* ============ 画面が使う入口 ============ */
export const api = guardProcedure({
  ...authApi, ...childApi, ...diaryApi, ...diaryApi2,
  ...chatApi, ...chatApi2, ...napApi, ...napApi2,
  ...devApi, ...devApi2, ...physicalApi, ...adminApi, ...adminApi2, ...adminApi3,
  ...bulkApi, ...dashboardApi, ...handoutApi,
});

/* ============ 入力の検査の補助（Go サーバの httpx.go と同じ規則） ============ */

/** 出力の記録の種別 */
export type ExportKind = 'operation_log' | 'nap_record' | 'allergy_list' | 'invitation_sheet';

/** 文字数（符号位置の数）が上限を超えているか。上限の正は基本設計書「入力項目の制約値」(4-9) */
function tooLong(v: string, max: number): boolean {
  return [...v].length > max;
}

/**
 * 'YYYY-MM-DD' の形で、実在する日付か。月日を1桁で書いた値（2026-10-1）や 2月30日は受け取らない
 * （GitHub Issue #164。server/httpx.go の isISODate と同じ）
 */
function isISODate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 'YYYY-MM-DDTHH:MM:SS' の形で、実在する日時か（server/httpx.go の isISODateTime と同じ） */
function isISODateTime(v: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(v);
  if (!m || !isISODate(m[1])) return false;
  return Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 60;
}

/**
 * 発見時刻を確かめ、受け付けられないときは利用者に見せる文言を返す（GitHub Issue #158）。
 * 未来の日時は認めない（基本設計書「入力項目の制約値」(4-9)）。
 * 【仮置き】未来かどうかは分の単位で比べる（web/仮置き値.md）。サーバ側は server/api_nap.go の foundAtProblem
 */
function foundAtProblem(v: string): string | null {
  if (!isISODateTime(v)) return '発見時刻の形式が正しくありません';
  if (v.slice(0, 16) > now().slice(0, 16)) return '発見時刻に未来の日時は指定できません';
  return null;
}

/** よみとして受け取れる文字だけで出来ているか。ひらがな・長音・姓と名のあいだの空白を受け取る */
function isKana(v: string): boolean {
  return /^[ぁ-ゖー 　]*$/.test(v);
}
