/*
 * API 抽象
 *
 * ここに並ぶ関数が、Go サーバが実装することになるエンドポイントの一覧である。
 * いまはブラウザ内の mockDb を読み書きしているが、Go 側ができたら
 * 本ファイルの中身だけを fetch に差し替える。画面側は変更しない。
 *
 * 権限の判定は本ファイル（＝サーバ側の担当）で行う。
 * 画面側での出し分けは操作性のためであって、権限の担保ではない
 * （基本設計書.md「権限チェックの実装方針」(6-2)）。
 */
import * as db from './mockDb';
import { CURRENT_TERMS_VERSION } from './mockDb';
import type {
  Account, Child, ClassRoom, Diary, DiaryStatus, DiaryRecordType, SessionUser, Role,
  InvitationCode, NapRecord, NapSession, NapAbnormal, PhysicalRecord, GrowthStandard,
  DevelopmentCheck, DevelopmentResultRecord, DevelopmentItem, ChatRoom, ChatMessage,
  OperationLog, Allergy, FunctionType, OperationType, Paged,
} from './types';
import { ageInMonths, now, today, addDays, plusMinutes, fromNowMinutes } from './util';

/** 通信の代わり。画面側が非同期を前提に書けるようにする */
function ok<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 60));
}
function fail<T = never>(message: string): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 60));
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

/* ============ 認証（基本設計書「共通基盤：ログインとアカウント」(4-3)） ============ */

/** ログインの結果。誤った系統でのログインは成立させず、正しい入口を案内する（画面詳細図 2-1） */
export type LoginError =
  | { kind: 'credential'; remaining: number }
  | { kind: 'locked'; until: string }
  | { kind: 'suspended' }
  | { kind: 'wrong_entrance'; correct: 'staff' | 'guardian' };

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
    if (a.status === '2') return fail(JSON.stringify({ kind: 'suspended' } satisfies LoginError));

    if (a.password_hash !== password) {
      a.failed_login_count += 1;
      if (a.failed_login_count >= max) {
        const mins = settingNumber('auth.lock_minutes', 30);
        a.locked_until = fromNowMinutes(mins);
        return fail(JSON.stringify({ kind: 'locked', until: a.locked_until } satisfies LoginError));
      }
      return fail(JSON.stringify({ kind: 'credential', remaining: max - a.failed_login_count } satisfies LoginError));
    }

    // 系統の判定。職員用トップからは保護者を、保護者用トップからは職員を通さない
    const isStaffAccount = a.role === '1' || a.role === '2';
    if (entrance === 'staff' && !isStaffAccount) {
      return fail(JSON.stringify({ kind: 'wrong_entrance', correct: 'guardian' } satisfies LoginError));
    }
    if (entrance === 'guardian' && isStaffAccount) {
      return fail(JSON.stringify({ kind: 'wrong_entrance', correct: 'staff' } satisfies LoginError));
    }

    a.failed_login_count = 0;
    a.locked_until = null;
    return ok(buildSessionUser(a));
  },

  /** パスワードの変更。一時パスワードの状態を解除する */
  async changePassword(accountId: number, current: string, next: string): Promise<void> {
    const a = findAccount(accountId);
    if (!a) return fail('アカウントが見つかりません');
    if (a.password_hash !== current) return fail('現在のパスワードが違います');
    if (next.length < 8) return fail('パスワードは8文字以上で入力してください');
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
    a.terms_version = CURRENT_TERMS_VERSION;
    a.terms_agreed_at = now();
    log(accountId, '7', '2', 'm_account', accountId, null, null, `規約 ${CURRENT_TERMS_VERSION} に同意`);
    return ok(undefined);
  },

  async currentTerms() {
    return ok(db.termsDocs.find((t) => t.terms_version === CURRENT_TERMS_VERSION)!);
  },

  /** ログイン中の利用者を組み直す。パスワード変更・規約同意のあと画面を進めるために使う */
  async reloadSession(accountId: number): Promise<SessionUser> {
    const a = findAccount(accountId);
    return a ? ok(buildSessionUser(a)) : fail('アカウントが見つかりません');
  },
};

/* ============ 園児マスター（基本設計書「共通基盤：園児マスターの管理」(4-4)） ============ */

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

  async getChild(user: SessionUser, childId: string): Promise<Child> {
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    const c = findChild(childId);
    return c ? ok(c) : fail('園児が見つかりません');
  },

  async allergiesOf(childId: string): Promise<Allergy[]> {
    return ok(db.allergies.filter((a) => a.child_id === childId));
  },

  /** アレルギー一覧画面は全園児が対象（画面詳細図 7-1 の補足） */
  async allAllergies(): Promise<{ child: Child; className: string; allergies: Allergy[] }[]> {
    const rows = db.children
      .filter((c) => !c.is_deleted && c.enrollment_status === '1')
      .map((c) => ({
        child: c,
        className: className(db.classChildren.find((cc) => cc.child_id === c.child_id)?.class_id ?? null),
        allergies: db.allergies.filter((a) => a.child_id === c.child_id),
      }))
      .filter((r) => r.allergies.length > 0);
    return ok(rows);
  },

  async medicalHistoriesOf(childId: string) {
    return ok(db.medicalHistories.filter((m) => m.child_id === childId));
  },

  async classOf(childId: string): Promise<number | null> {
    return ok(db.classChildren.find((cc) => cc.child_id === childId)?.class_id ?? null);
  },

  /** 登録・編集は管理者のみ（画面詳細図 7-1） */
  async saveChild(user: SessionUser, input: ChildInput, mode: 'create' | 'edit'): Promise<Child> {
    if (user.role !== '1') return fail('園児情報の登録・編集は管理者のみが行えます');
    if (input.birth_date > today()) return fail('生年月日に未来日は指定できません');

    const existing = findChild(input.child_id);
    if (mode === 'create' && existing) return fail('その園児IDはすでに使われています');
    if (mode === 'edit' && !existing) return fail('園児が見つかりません');

    const before = existing ? `${existing.child_name} / ${existing.birth_date}` : null;
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

    log(user.account_id, '6', mode === 'create' ? '1' : '2', 'm_child', null, input.child_id,
      before, `${row.child_name} / ${row.birth_date}`);
    return ok(row);
  },

  /** 誤登録の取消。論理削除とする（基本設計書 5-1） */
  async removeChild(user: SessionUser, childId: string): Promise<void> {
    if (user.role !== '1') return fail('園児情報の取消は管理者のみが行えます');
    const c = findChild(childId);
    if (!c) return fail('園児が見つかりません');
    c.is_deleted = true;
    c.updated_at = now();
    log(user.account_id, '6', '4', 'm_child', null, childId, c.child_name, '取消（論理削除）');
    return ok(undefined);
  },
};

/* ============ 日誌システム（基本設計書「日誌システム」(4-5)） ============ */

export interface DiaryFilter {
  recordType?: DiaryRecordType | '';
  classId?: number | '';
  status?: DiaryStatus | '';
  from?: string;
  to?: string;
  page?: number;
}

export const diaryApi = {
  async listDiaries(user: SessionUser, f: DiaryFilter = {}): Promise<Paged<Diary>> {
    const perPage = settingNumber('paging.diary_per_page', 50);
    const visible = new Set(visibleChildren(user).map((c) => c.child_id));
    const myClasses = new Set(selectableClasses(user).map((c) => c.class_id));

    let rows = db.diaries.filter((d) => !d.is_deleted).filter((d) => {
      // 個人日誌・ヒヤリハットは対象園児で、クラス日誌・週案は対象クラスで参照範囲を判定する
      if (d.child_id) return visible.has(d.child_id);
      return d.class_id != null && myClasses.has(d.class_id);
    });

    if (f.recordType) rows = rows.filter((d) => d.record_type === f.recordType);
    if (f.classId) rows = rows.filter((d) => d.class_id === f.classId);
    if (f.status) rows = rows.filter((d) => d.status === f.status);
    if (f.from) rows = rows.filter((d) => d.diary_date >= f.from!);
    if (f.to) rows = rows.filter((d) => d.diary_date <= f.to!);

    rows.sort((a, b) => b.diary_date.localeCompare(a.diary_date) || b.diary_id - a.diary_id);
    const page = f.page ?? 1;
    return ok({ rows: rows.slice((page - 1) * perPage, page * perPage), total: rows.length, page, per_page: perPage });
  },

  async getDiary(user: SessionUser, diaryId: number): Promise<Diary> {
    const d = db.diaries.find((x) => x.diary_id === diaryId && !x.is_deleted);
    if (!d) return fail('日誌が見つかりません');
    if (d.child_id && !canSeeChild(user, d.child_id)) return fail('この日誌を参照する権限がありません');
    return ok(d);
  },

  async templates(): Promise<typeof db.diaryTemplates> { return ok(db.diaryTemplates); },
  async phrases(): Promise<string[]> { return ok(db.fixedPhrases); },
  async attachmentsOf(diaryId: number) { return ok(db.diaryAttachments.filter((a) => a.diary_id === diaryId)); },

  /** その園児の過去の記録。前回の記述を見ながら書けるようにする（画面詳細図 3-2） */
  async pastDiariesOf(childId: string, excludeDiaryId?: number): Promise<Diary[]> {
    return ok(db.diaries
      .filter((d) => !d.is_deleted && d.child_id === childId && d.diary_id !== excludeDiaryId)
      .sort((a, b) => b.diary_date.localeCompare(a.diary_date)));
  },

  /**
   * 編集ロックの取得。取得のたびにトークンを発行し、保存時に照合する（基本設計書 5-4）
   * すでに他者が保持していれば、その職員名を返して画面に出す
   */
  async acquireLock(user: SessionUser, diaryId: number): Promise<{ token: string } | { heldBy: string }> {
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

  /** 管理者による強制解除。レコードを削除する（基本設計書「編集ロックの解除」(4-5)） */
  async releaseLock(user: SessionUser, diaryId: number, force = false): Promise<void> {
    const i = db.diaryLocks.findIndex((l) => l.diary_id === diaryId);
    if (i < 0) return ok(undefined);
    if (force && user.role !== '1') return fail('ロックの強制解除は管理者のみが行えます');
    if (!force && db.diaryLocks[i].locked_staff_id !== user.staff_id) return ok(undefined);
    db.diaryLocks.splice(i, 1);
    if (force) log(user.account_id, '1', '2', 't_diary_lock', diaryId, null, 'ロックあり', '管理者が強制解除');
    return ok(undefined);
  },

  async lockOf(diaryId: number) {
    const l = db.diaryLocks.find((x) => x.diary_id === diaryId);
    return ok(l ? { ...l, staff_name: staffName(l.locked_staff_id) } : null);
  },
};

export interface DiaryInput {
  diary_id?: number;
  record_type: DiaryRecordType;
  child_id: string | null;
  class_id: number | null;
  diary_date: string;
  body: string;
  lock_token?: string;
}

const diaryApi2 = {
  /** 下書き保存・申請。status は呼び出し側が指定する */
  async saveDiary(user: SessionUser, input: DiaryInput, status: '1' | '2'): Promise<Diary> {
    if (!input.body.trim()) return fail('本文を入力してください');
    if (input.record_type === '1' || input.record_type === '4') {
      if (!input.child_id) return fail('対象の園児を選んでください');
      if (!canSeeChild(user, input.child_id)) return fail('この園児の日誌を作成する権限がありません');
    }

    if (input.diary_id) {
      const d = db.diaries.find((x) => x.diary_id === input.diary_id);
      if (!d) return fail('日誌が見つかりません');
      // 保存時にロックのトークンを照合する（基本設計書 5-4）
      const lock = db.diaryLocks.find((l) => l.diary_id === d.diary_id);
      if (lock && lock.lock_token !== input.lock_token) {
        return fail('他の職員が編集中のため保存できません。日誌一覧へ戻って開き直してください');
      }
      const before = `${d.status}`;
      d.record_type = input.record_type;
      d.child_id = input.child_id;
      d.class_id = input.class_id;
      d.diary_date = input.diary_date;
      d.body = input.body;
      d.status = status;
      // 再申請したら差し戻し理由を消す
      if (status === '2') d.returned_reason = null;
      d.updated_at = now();
      log(user.account_id, '1', '2', 't_diary', d.diary_id, d.child_id, before, status === '2' ? '申請' : '下書き保存');
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
    log(user.account_id, '1', '1', 't_diary', row.diary_id, row.child_id, null, status === '2' ? '作成して申請' : '下書き作成');
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

    d.status = '3';
    d.approved_staff_id = user.staff_id;
    d.approved_at = now();
    d.returned_reason = null;
    d.is_shared_to_guardian = shareToGuardian;
    d.shared_at = shareToGuardian ? now() : null;
    d.updated_at = now();
    log(user.account_id, '1', '3', 't_diary', d.diary_id, d.child_id, '申請中',
      shareToGuardian ? '承認済み・保護者へ共有' : '承認済み・共有しない');

    // 共有する場合、個人チャットへ日誌の共有としてメッセージを流す（基本設計書 5-5 source_type=2）
    if (shareToGuardian && d.child_id) {
      const room = db.chatRooms.find((r) => r.room_type === '4' && r.room_name === `${childName(d.child_id)}の保護者`);
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

  /** 園児タイムライン。承認済みの記録を時系列で並べる */
  async timelineOf(user: SessionUser, childId: string): Promise<Diary[]> {
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    return ok(db.diaries
      .filter((d) => !d.is_deleted && d.child_id === childId)
      .sort((a, b) => b.diary_date.localeCompare(a.diary_date)));
  },
};

/* ============ チャットツール（基本設計書「チャットツール」(4-6)） ============ */

export interface ChatRoomView {
  room: ChatRoom;
  unread: number;
  /** 一般には園全体の投稿欄を表示しない（画面詳細図 4-1） */
  canPost: boolean;
}

export const chatApi = {
  /** 参加しているチャンネル。left_at が入っていても職員は参照できる（基本設計書 5-5） */
  async rooms(user: SessionUser): Promise<ChatRoomView[]> {
    const isStaff = user.role === '1' || user.role === '2';
    const mine = db.chatMembers.filter((m) => m.account_id === user.account_id
      && (isStaff || m.left_at === null));

    const views = mine.map((m) => {
      const room = db.chatRooms.find((r) => r.chat_room_id === m.chat_room_id)!;
      const unread = db.chatMessages.filter((msg) =>
        msg.chat_room_id === room.chat_room_id
        && !msg.is_deleted
        && msg.sender_account_id !== user.account_id
        && !db.chatReads.some((r) => r.chat_message_id === msg.chat_message_id && r.account_id === user.account_id),
      ).length;

      // 園全体は管理者のみ投稿できる。保護者は個人チャットのみ送受信できる
      let canPost = true;
      if (room.room_type === '1') canPost = user.role === '1';
      if (user.role === '3') canPost = room.room_type === '4';

      return { room, unread, canPost };
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
    return ok(db.chatMessages.filter((m) => m.chat_room_id === roomId)
      .sort((a, b) => a.sent_at.localeCompare(b.sent_at)));
  },

  /** 既読は人数で示す。保護者側には表示しない（基本設計書 5-5） */
  async readCount(messageId: number): Promise<number> {
    return ok(db.chatReads.filter((r) => r.chat_message_id === messageId).length);
  },

  async markRead(user: SessionUser, roomId: number): Promise<void> {
    db.chatMessages
      .filter((m) => m.chat_room_id === roomId && m.sender_account_id !== user.account_id && !m.is_deleted)
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
    const rooms = await chatApi.rooms(user);
    const view = rooms.find((r) => r.room.chat_room_id === roomId);
    if (!view) return fail('このチャンネルを参照する権限がありません');
    if (!view.canPost) return fail('このチャンネルへは投稿できません');

    const msg: ChatMessage = {
      chat_message_id: nextId(), chat_room_id: roomId, sender_account_id: user.account_id,
      body, source_type: '1', source_id: null, sent_at: now(),
      edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null,
    };
    db.chatMessages.push(msg);
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
    const before = m.body;
    m.is_deleted = true;
    m.body = '';
    m.deleted_at = now();
    m.deleted_account_id = user.account_id;
    log(user.account_id, '2', '4', 't_chat_message', messageId, null, before, '取消');
    return ok(undefined);
  },

  async edit(user: SessionUser, messageId: number, body: string): Promise<void> {
    const m = db.chatMessages.find((x) => x.chat_message_id === messageId);
    if (!m) return fail('メッセージが見つかりません');
    if (m.sender_account_id !== user.account_id) return fail('自分が送信したメッセージのみ編集できます');
    const before = m.body;
    m.body = body;
    m.edited_at = now();
    log(user.account_id, '2', '2', 't_chat_message', messageId, null, before, body);
    return ok(undefined);
  },

  async members(roomId: number) {
    return ok(db.chatMembers.filter((m) => m.chat_room_id === roomId && m.left_at === null)
      .map((m) => ({ account_id: m.account_id, name: accountName(m.account_id) })));
  },
};

const chatApi2 = {
  /** 目的別グループの作成とメンバーの編成（グループ編成画面） */
  async createGroup(user: SessionUser, name: string, accountIds: number[]): Promise<ChatRoom> {
    if (user.role === '3') return fail('グループの編成は職員のみが行えます');
    if (!name.trim()) return fail('グループ名を入力してください');
    const room: ChatRoom = {
      chat_room_id: nextId(), room_type: '3', class_id: null,
      room_name: name, is_archived: false, thread_status: null,
    };
    db.chatRooms.push(room);
    const ids = new Set([...accountIds, user.account_id]);
    ids.forEach((account_id) => db.chatMembers.push({
      chat_room_id: room.chat_room_id, account_id, joined_at: now(), left_at: null,
    }));
    log(user.account_id, '2', '1', 'm_chat_room', room.chat_room_id, null, null, `グループ「${name}」を作成`);
    return ok(room);
  },

  /** メンバーの追加・退出。退出は left_at を入れて所属期間を残す（基本設計書 5-5） */
  async updateGroupMembers(user: SessionUser, roomId: number, accountIds: number[]): Promise<void> {
    if (user.role === '3') return fail('グループの編成は職員のみが行えます');
    const target = new Set(accountIds);
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

  async groups(): Promise<ChatRoom[]> {
    return ok(db.chatRooms.filter((r) => r.room_type === '3'));
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
    db.misdeliveryRecords.unshift({
      misdelivery_record_id: nextId(), staff_id: user.staff_id!, ...input,
    });
    log(user.account_id, '2', '1', 't_misdelivery_record', input.chat_message_id, null, null, '誤送信への対応を記録');
    return ok(undefined);
  },

  /** 取消済みで、まだ対応を記録していないメッセージ */
  async retractedWithoutRecord() {
    const recorded = new Set(db.misdeliveryRecords.map((r) => r.chat_message_id));
    return ok(db.chatMessages
      .filter((m) => m.is_deleted && !recorded.has(m.chat_message_id))
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

export interface NapChildState {
  child: Child;
  /** 直近の記録。未記録なら null */
  latest: NapRecord | null;
}

export const napApi = {
  /** 実施中のセッション。開いたまま運用するため、開始済みかを常に確認する */
  async activeSession(classId: number, date: string): Promise<NapSession | null> {
    return ok(db.napSessions.find((s) => s.class_id === classId && s.session_date === date && s.ended_at === null) ?? null);
  },

  async startSession(user: SessionUser, classId: number, date: string): Promise<NapSession> {
    if (user.role === '3') return fail('午睡チェックは職員のみが行えます');
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

  async endSession(user: SessionUser, sessionId: number): Promise<void> {
    const s = db.napSessions.find((x) => x.nap_session_id === sessionId);
    if (!s) return fail('実施中の午睡チェックが見つかりません');
    s.ended_staff_id = user.staff_id;
    s.ended_at = now();
    log(user.account_id, '3', '2', 't_nap_session', sessionId, null, '実施中', '終了');
    return ok(undefined);
  },

  /** クラス全体の状況。平熱は比較の材料として並べて表示するのみ（画面詳細図 5-1） */
  async classState(user: SessionUser, classId: number, sessionId: number | null): Promise<NapChildState[]> {
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
    if (!canSeeChild(user, input.child_id)) return fail('この園児を記録する権限がありません');
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

  /** 異常時の記録。ヒヤリハットの起票は別操作（基本設計書「異常時の記録」(4-7)） */
  async recordAbnormal(
    user: SessionUser, sessionId: number,
    input: { child_id: string; found_at: string; situation: string; response: string },
  ): Promise<NapAbnormal> {
    if (!input.situation.trim()) return fail('発見時の状況を入力してください');
    if (!input.response.trim()) return fail('とった対応を入力してください');
    const a: NapAbnormal = {
      nap_abnormal_id: nextId(), nap_session_id: sessionId, staff_id: user.staff_id!,
      diary_id: null, ...input,
    };
    db.napAbnormals.unshift(a);
    log(user.account_id, '3', '1', 't_nap_abnormal', a.nap_abnormal_id, input.child_id, null, '異常時の記録');
    return ok(a);
  },

  /** 異常時の記録からヒヤリハットを起票し、相互に参照させる（基本設計書 5-6） */
  async raiseIncidentDiary(user: SessionUser, abnormalId: number): Promise<Diary> {
    const a = db.napAbnormals.find((x) => x.nap_abnormal_id === abnormalId);
    if (!a) return fail('異常時の記録が見つかりません');
    if (a.diary_id) return fail('この記録からはすでにヒヤリハットを起票しています');
    const session = db.napSessions.find((s) => s.nap_session_id === a.nap_session_id);
    const d: Diary = {
      diary_id: nextId(), record_type: '4', child_id: a.child_id,
      class_id: session?.class_id ?? null, diary_date: a.found_at.slice(0, 10),
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

  async abnormals(user: SessionUser) {
    return ok(db.napAbnormals
      .filter((a) => canSeeChild(user, a.child_id))
      .map((a) => ({ ...a, child_name: childName(a.child_id), staff_name: staffName(a.staff_id) })));
  },
};

const napApi2 = {
  /** 午睡記録検索。日付・園児名・クラスで絞り込む（基本設計書「画面の一覧」(3-2)） */
  async searchRecords(
    user: SessionUser,
    f: { from?: string; to?: string; classId?: number | ''; childName?: string; page?: number },
  ): Promise<Paged<NapRecord & { child_name: string; class_name: string; staff_name: string; session_date: string }>> {
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
    const name = className(classId);
    // クラスと年齢の対応は演習用の仮置き（web/仮置き値.md 参照）
    if (name === 'もも組') return settingNumber('nap.interval_minutes.age0', 5);
    if (name === 'さくら組') return settingNumber('nap.interval_minutes.age1', 10);
    return settingNumber('nap.interval_minutes.age2', 15);
  },
};

/* ============ 発達チェック（基本設計書「発達チェック・身体測定」(4-8)） ============ */

export interface DevListRow {
  child: Child;
  ageMonths: number;
  scheduledOn: string | null;
  lastCheckedOn: string | null;
  /** 未実施＝予定日を過ぎているのに確定した記録がない */
  overdue: boolean;
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
    const ids = new Set(db.classChildren.filter((cc) => cc.class_id === classId).map((cc) => cc.child_id));
    const rows = visibleChildren(user)
      .filter((c) => ids.has(c.child_id))
      .sort((a, b) => a.child_name_kana.localeCompare(b.child_name_kana, 'ja'))
      .map((child) => {
        const sch = db.developmentSchedules
          .filter((s) => s.child_id === child.child_id)
          .sort((a, b) => b.scheduled_on.localeCompare(a.scheduled_on))[0] ?? null;
        const last = db.developmentChecks
          .filter((c) => c.child_id === child.child_id && c.status === '2')
          .sort((a, b) => b.checked_on.localeCompare(a.checked_on))[0] ?? null;
        const scheduledOn = sch?.scheduled_on ?? null;
        const overdue = !!scheduledOn && scheduledOn <= today()
          && (!last || last.checked_on < scheduledOn);
        return {
          child,
          ageMonths: ageInMonths(child.birth_date, scheduledOn ?? today()),
          scheduledOn,
          lastCheckedOn: last?.checked_on ?? null,
          overdue,
        };
      });
    return ok(rows);
  },

  /** 前回の記録。並べて表示するために使う（画面詳細図 6-1） */
  async previousCheck(childId: string, beforeDate: string) {
    const prev = db.developmentChecks
      .filter((c) => c.child_id === childId && c.status === '2' && c.checked_on < beforeDate)
      .sort((a, b) => b.checked_on.localeCompare(a.checked_on))[0];
    if (!prev) return ok(null);
    return ok({
      check: prev,
      results: db.developmentResults.filter((r) => r.development_check_id === prev.development_check_id),
    });
  },

  /** 当日の下書き。あれば読み直す */
  async draftFor(childId: string, checkedOn: string) {
    const c = db.developmentChecks.find((x) => x.child_id === childId && x.checked_on === checkedOn);
    if (!c) return ok(null);
    return ok({ check: c, results: db.developmentResults.filter((r) => r.development_check_id === c.development_check_id) });
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

    let check = db.developmentChecks.find((c) => c.child_id === childId && c.checked_on === checkedOn);
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
    /*
     * 【設計の穴】所見（チェック単位の自由記述）を保持する列が t_development_check にない。
     * 画面詳細図 6-1 は所見の入力欄を持つが、基本設計書 5-7 の列定義に対応する列がなく、
     * t_development_result.note は項目単位である。
     * モックでは development_item_id=0 の行に退避しているが、これは仮の措置であり、
     * 本実装までに t_development_check へ note 列を足すか、所見の置き場を決める必要がある。
     */
    if (note.trim()) {
      db.developmentResults.push({
        development_result_id: nextId(), development_check_id: check.development_check_id,
        development_item_id: 0, result: '3', note,
      });
    }

    log(user.account_id, '4', check ? '2' : '1', 't_development_check', check.development_check_id, childId,
      null, status === '2' ? '確定' : '下書き保存');
    return ok(check);
  },
};

const devApi2 = {
  /** 園児単位の推奨スケジュールの上書き（スケジュール設定画面。管理者のみ） */
  async schedules(user: SessionUser, classId: number) {
    const ids = new Set(db.classChildren.filter((cc) => cc.class_id === classId).map((cc) => cc.child_id));
    return ok(visibleChildren(user).filter((c) => ids.has(c.child_id)).map((child) => {
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
  /** クラスの実施状況。誰が残っているかを数えさせない（画面詳細図 6-2） */
  async classStatus(user: SessionUser, classId: number, measuredOn: string) {
    const ids = new Set(db.classChildren.filter((cc) => cc.class_id === classId).map((cc) => cc.child_id));
    const target = visibleChildren(user)
      .filter((c) => ids.has(c.child_id))
      .sort((a, b) => a.child_name_kana.localeCompare(b.child_name_kana, 'ja'));
    const done = target.filter((c) => db.physicalRecords.some(
      (r) => !r.is_deleted && r.child_id === c.child_id && r.measured_on === measuredOn));
    const pending = target.filter((c) => !done.includes(c));
    return ok({ target, done, pending });
  },

  async recordsOf(user: SessionUser, childId: string): Promise<PhysicalRecord[]> {
    if (!canSeeChild(user, childId)) return fail('この園児を参照する権限がありません');
    return ok(db.physicalRecords
      .filter((r) => !r.is_deleted && r.child_id === childId)
      .sort((a, b) => b.measured_on.localeCompare(a.measured_on)));
  },

  /**
   * 登録・修正。確認画面を挟まず連続して入力できる（画面詳細図 6-2）
   * 範囲外の値は警告して確認を求めるが、記録自体は妨げない（判定ではないため）
   */
  async save(
    user: SessionUser,
    input: { child_id: string; measured_on: string; height_cm: number; weight_kg: number },
  ): Promise<PhysicalRecord> {
    if (user.role === '3') return fail('身体測定の記録は職員のみが行えます');
    if (!canSeeChild(user, input.child_id)) return fail('この園児を記録する権限がありません');
    if (input.measured_on > today()) return fail('測定日に未来日は指定できません');
    if (!(input.height_cm > 0) || !(input.weight_kg > 0)) return fail('身長と体重を入力してください');

    // child_id + measured_on は is_deleted=false の行のみを対象に一意（基本設計書 5-7）
    const existing = db.physicalRecords.find(
      (r) => !r.is_deleted && r.child_id === input.child_id && r.measured_on === input.measured_on);

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
    const before = a.status;
    a.status = status;
    a.updated_at = now();
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
    // ログインIDはロールをまたいで園内で一意（基本設計書 5-2）
    if (db.accounts.some((a) => a.email === input.email)) return fail('そのログインIDはすでに使われています');
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
    log(user.account_id, '7', '1', 'm_account', accountId, null, null, `職員アカウントを発行（${input.staff_name}）`);
    return ok(temp);
  },
};

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
    rows.sort((a, b) => a.child_name.localeCompare(b.child_name, 'ja') || a.code.localeCompare(b.code));
    return ok(rows);
  },

  /** 1枚＝1アカウント。園児ごとに必要枚数を発行する（要件定義書「招待コードの発行」(4-1-2)） */
  async issueInvitationCodes(
    user: SessionUser, classId: number, perChild: number, validDays: number,
  ): Promise<number> {
    if (user.role !== '1') return fail('招待コードの発行は管理者のみが行えます');
    if (perChild < 1) return fail('1名あたりの枚数は1以上で指定してください');
    const ids = db.classChildren.filter((cc) => cc.class_id === classId).map((cc) => cc.child_id)
      .filter((id) => { const c = findChild(id); return c && !c.is_deleted && c.enrollment_status === '1'; });

    let issued = 0;
    ids.forEach((child_id) => {
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
    return ok(issued);
  },

  async issueOneInvitationCode(user: SessionUser, childId: string, validDays: number): Promise<string> {
    if (user.role !== '1') return fail('招待コードの発行は管理者のみが行えます');
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
    log(user.account_id, '7', '2', 't_guardian_child', null, childId, '有効',
      remaining === 0 ? '終了（有効な紐づけがゼロのためアカウントを停止）' : '終了');
    return ok(undefined);
  },
};

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
    const normalized = code.trim().toUpperCase();
    const c = db.invitationCodes.find((x) => x.code.toUpperCase() === normalized);
    if (!c) return fail('招待コードが確認できません。園から配布されたコードをお確かめください');
    if (c.status === '2') return fail('この招待コードはすでに使われています');
    if (c.status === '3') return fail('この招待コードは失効しています');
    if (c.expires_on < today()) return fail('この招待コードは有効期限が切れています');
    return ok({ ok: true as const });
  },

  async signUpGuardian(
    input: { code: string; email: string; password: string; guardian_name: string; relationship: string },
  ): Promise<SessionUser> {
    const normalized = input.code.trim().toUpperCase();
    const c = db.invitationCodes.find((x) => x.code.toUpperCase() === normalized);
    if (!c || c.status !== '1' || c.expires_on < today()) return fail('招待コードが確認できません');
    if (db.accounts.some((a) => a.email === input.email)) return fail('このメールアドレスはすでに登録されています');
    if (input.password.length < 8) return fail('パスワードは8文字以上で入力してください');
    if (!input.guardian_name.trim()) return fail('保護者の氏名を入力してください');

    const accountId = nextId();
    db.accounts.push({
      account_id: accountId, email: input.email, password_hash: input.password, role: '3', status: '1',
      is_temp_password: false, temp_password_expires_at: null, failed_login_count: 0, locked_until: null,
      terms_version: CURRENT_TERMS_VERSION, terms_agreed_at: now(), created_at: now(), updated_at: now(),
    });
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

    // 自児の個人チャットへ参加させる
    const room = db.chatRooms.find((r) => r.room_type === '4' && r.room_name === `${childName(c.child_id)}の保護者`);
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
  ): Promise<Paged<OperationLog & { account_name: string; child_name: string }>> {
    if (user.role !== '1') return fail('操作ログの参照は管理者のみが行えます');
    const perPage = settingNumber('paging.operation_log_per_page', 100);
    let rows = db.operationLogs.map((l) => ({
      ...l, account_name: accountName(l.account_id), child_name: l.target_child_id ? childName(l.target_child_id) : '―',
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

  async allAccounts(user: SessionUser) {
    if (user.role !== '1') return fail('アカウント一覧は管理者のみが参照できます');
    return ok(db.accounts.map((a) => ({ account_id: a.account_id, name: accountName(a.account_id), role: a.role })));
  },
};

/* ============ CSV一括登録・年度更新（基本設計書 4-4） ============ */

export interface CsvRow {
  line: number;
  values: string[];
  error: string | null;
}

const bulkApi = {
  /** 取込内容とエラー行の確認。取り込む前に全行を検証して返す（画面詳細図の様式に合わせる） */
  parseChildCsv(text: string): { header: string[]; rows: CsvRow[] } {
    const header = ['園児ID', '氏名', '氏名かな', '生年月日', '性別', 'クラス名', '平熱'];
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    const body = lines[0]?.includes('園児ID') ? lines.slice(1) : lines;

    const rows: CsvRow[] = body.map((line, i) => {
      const values = line.split(',').map((v) => v.trim());
      let error: string | null = null;

      if (values.length < 6) error = '列が足りません（園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱）';
      else if (!values[0]) error = '園児IDが空です';
      else if (db.children.some((c) => c.child_id === values[0])) error = 'その園児IDはすでに登録されています';
      else if (!values[1]) error = '氏名が空です';
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(values[3])) error = '生年月日は YYYY-MM-DD で入力してください';
      else if (values[3] > today()) error = '生年月日に未来日は指定できません';
      else if (!['1', '2', '9'].includes(values[4])) error = '性別は 1:男 2:女 9:未回答 で入力してください';
      else if (!db.classes.some((c) => c.fiscal_year === db.FISCAL_YEAR && c.class_name === values[5])) error = 'クラス名が見つかりません';

      return { line: i + 1, values, error };
    });
    return { header, rows };
  },

  /** エラー行があるときは1件も取り込まない。中途半端な状態を作らないため */
  async importChildCsv(user: SessionUser, rows: CsvRow[]): Promise<number> {
    if (user.role !== '1') return fail('CSV一括登録は管理者のみが行えます');
    if (rows.some((r) => r.error)) return fail('エラー行があるため取り込めません。すべて解消してから実行してください');

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
    log(user.account_id, '6', '1', 'm_child', null, null, null, `CSV一括登録 ${rows.length} 件`);
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
      // 年度更新では在籍の判定と進級先の割り当てが要る。割り当ての規則は未確定
      note: '進級先クラスの割り当て規則と、卒園の判定条件が未確定のため、本モックでは実行できません',
    });
  },
};

/* ============ ダッシュボード（画面詳細図 2-4） ============ */

const dashboardApi = {
  /** 未対応の件数を最上部に置く。出勤直後に何が残っているかを1画面で把握させる */
  async staffSummary(user: SessionUser) {
    const visible = new Set(visibleChildren(user).map((c) => c.child_id));
    const myClasses = new Set(selectableClasses(user).map((c) => c.class_id));

    const returned = db.diaries.filter((d) => !d.is_deleted && d.status === '4'
      && d.created_staff_id === user.staff_id).length;

    const rooms = db.chatMembers.filter((m) => m.account_id === user.account_id).map((m) => m.chat_room_id);
    const unreadChat = db.chatMessages.filter((m) =>
      rooms.includes(m.chat_room_id) && !m.is_deleted && m.sender_account_id !== user.account_id
      && !db.chatReads.some((r) => r.chat_message_id === m.chat_message_id && r.account_id === user.account_id)).length;

    const devOverdue = db.developmentSchedules.filter((s) => {
      if (!visible.has(s.child_id)) return false;
      if (s.scheduled_on > today()) return false;
      const last = db.developmentChecks
        .filter((c) => c.child_id === s.child_id && c.status === '2')
        .sort((a, b) => b.checked_on.localeCompare(a.checked_on))[0];
      return !last || last.checked_on < s.scheduled_on;
    }).length;

    // 承認待ちの区画は管理者にのみ表示する
    const pending = user.role === '1' ? db.diaries.filter((d) => !d.is_deleted && d.status === '2').length : 0;

    // 異常時の記録のうち、ヒヤリハットを起票していないもの
    const abnormalWithoutDiary = db.napAbnormals.filter((a) => !a.diary_id && visible.has(a.child_id)).length;

    // 実施中の午睡チェック
    const activeNap = db.napSessions.find((s) => s.ended_at === null && myClasses.has(s.class_id)) ?? null;

    return ok({ returned, unreadChat, devOverdue, pending, abnormalWithoutDiary, activeNap });
  },

  /** 保護者ホーム。自児の情報とチャットへの導線（基本設計書「画面の一覧」(3-2)） */
  async guardianHome(user: SessionUser) {
    const mine = user.guardian_id ? childrenOfGuardian(user.guardian_id) : [];
    const rooms = db.chatMembers.filter((m) => m.account_id === user.account_id && m.left_at === null).map((m) => m.chat_room_id);
    const unread = db.chatMessages.filter((m) =>
      rooms.includes(m.chat_room_id) && !m.is_deleted && m.sender_account_id !== user.account_id
      && !db.chatReads.some((r) => r.chat_message_id === m.chat_message_id && r.account_id === user.account_id)).length;

    return ok(mine.map((child) => ({
      child,
      ageMonths: ageInMonths(child.birth_date, today()),
      className: className(db.classChildren.find((cc) => cc.child_id === child.child_id)?.class_id ?? null),
      // 共有された日誌のみ。承認と共有の指定が済んだものだけが保護者に見える
      sharedDiaries: db.diaries
        .filter((d) => !d.is_deleted && d.child_id === child.child_id && d.status === '3' && d.is_shared_to_guardian)
        .sort((a, b) => b.diary_date.localeCompare(a.diary_date)),
      unread,
    })));
  },
};

/* ============ 画面が使う入口 ============ */
export const api = {
  ...authApi, ...childApi, ...diaryApi, ...diaryApi2,
  ...chatApi, ...chatApi2, ...napApi, ...napApi2,
  ...devApi, ...devApi2, ...physicalApi, ...adminApi, ...adminApi2, ...adminApi3,
  ...bulkApi, ...dashboardApi,
};
