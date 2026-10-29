/*
 * API の HTTP 実装
 *
 * Go サーバ（server/）へ問い合わせる。api/mock.ts と同じ関数名・同じ戻り値の形を持ち、
 * どちらを使うかは api/client.ts が決める。
 *
 * 画面には、描画のたびに必要になる小さな参照（園児名・クラス名・設定値）がある。
 * これらを毎回サーバへ問い合わせると往復が増えるため、ログイン直後に /api/reference で
 * まとめて取得し、本ファイルの参照表に保持する。同期の補助関数はその表を読む。
 */
import type {
  Child, ClassRoom, Diary, SessionUser, Role, NapRecord, NapSession,
  PhysicalRecord, GrowthStandard, DevelopmentCheck, DevelopmentResultRecord,
  DevelopmentItem, DevelopmentCategory, ChatRoom, ChatMessage, Allergy, Paged, Sex, Handout,
} from './types';
import type {
  LoginError, ChildInput, DiaryFilter, DiaryInput, DiaryTemplate, ChatRoomView,
  MisdeliveryRow, RetractedRow, NapChildState, NapAbnormalRow, NapSearchRow,
  DevListRow, DevScheduleRow, CsvRow, FiscalClassRow, StaffAccountRow,
  GuardianAccountRow, InvitationCodeRow, OperationLogRow, StaffSummary, GuardianHomeRow,
  DevDraftView, GuardianDiary,
  ContactPage, ContactClassView, ContactHome, ContactHomeInput, NapSleep, NapExclusion, GrowthRecord,
} from './shapes';
import type { SendPhotoInput, SendPhotoResult } from './shapes';
import type {
  ContactEvent, ContactEventInput, RecordEventsResult, ContactEventCorrection, NapSleepCorrection, CancelResult, Readers,
  ContactFacility, FacilityCorrection, Phrase, NameMatch, AiTarget, AiDraftInput, AiDraftResult, SettingsView,
} from './shapes';
import type { InvitationPreview, AddChildResult } from './shapes';
import type { AbnormalGuardianNoticeInput } from './shapes';
import {
  ProcedureRequiredError, isProcedureKind, notifyProcedureRequired, notifySessionEnded, pendingProcedure,
} from './procedure';
import { startLive } from '../live';
import {
  ACCOUNT_CHANGED_KIND, ACCOUNT_HEADER, ACCOUNT_QUERY, notifyAccountChanged, sessionAccount, setSessionAccount,
} from './sessionAccount';
import { setReachable } from './reachability';
import { TEXT } from '../messages';
import type { NapReportFilter } from './napReport';
import type { NapAbnormalCorrectInput, NapRecordCorrectInput } from './napCorrect';
import { AUTO_REFRESH_HEADER, isAutomatic } from './automatic';
import type { SessionStatus } from './shapes';

// 画面はこれまでどおり client 経由で型を参照する。定義の実体は shapes.ts が持つ
export type {
  LoginError, ChildInput, DiaryFilter, DiaryInput, ChatRoomView, NapChildState, DevListRow, CsvRow,
};

/* ============ 通信 ============ */

/**
 * 開いている画面への知らせ（server/events.go の GET /api/events。SSE）につなぐ。返す関数で切る。
 * App.tsx がログイン中に1か所で呼ぶ。だれの知らせかはサーバがセッションで決める。
 * 画面が思っている利用者は、EventSource がヘッダを付けられないのでクエリで添える（api/sessionAccount.ts）
 */
export function connectLive(accountId: number): () => void {
  return startLive(`/api/events?${ACCOUNT_QUERY}=${accountId}`);
}

class ApiError extends Error {
  kind?: string;
  remaining?: number;
  correct?: string;
  /** 他児の名前の注意（409 other_child_names）の、当たった園児の氏名と本文の中の位置（詳細設計書「誤りの応答」(4-1 (3))） */
  names?: string[];
  matches?: NameMatch[];
  /** 設定の保存で、誤りのあった設定のキー（詳細設計書「設定」(4-10 (2))） */
  field?: string;
  constructor(body: { message: string; kind?: string; remaining?: number; correct?: string; names?: string[]; matches?: NameMatch[]; field?: string }) {
    super(body.message);
    this.kind = body.kind;
    this.remaining = body.remaining;
    this.correct = body.correct;
    this.names = body.names;
    this.matches = body.matches;
    this.field = body.field;
  }
}

/** 画面からサーバへの要求の上限（詳細設計書「押したときの処理の型」(2-0 (2))、決めたこと D-19） */
const REQUEST_TIMEOUT_MS = 15_000;
/** AI の下書きの要求の上限（決めたこと D-19。サーバは再試行を含めて10秒で諦める） */
const AI_REQUEST_TIMEOUT_MS = 20_000;
/** 画面に出す文（サーバに届かないとき。詳細設計書「つながっているかの表示」(2-8)） */
const UNREACHABLE_MESSAGE = `${TEXT.unreachableBanner}。つながったら、もう一度送ってください。`;

/** ログインの失敗理由（LoginError）。画面（TopScreen）が JSON にして分岐に使う */
const LOGIN_KINDS = new Set(['credential', 'locked', 'suspended', 'wrong_entrance', 'temp_expired', 'already_logged_in', 'too_many_attempts']);

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS, withAccount = true): Promise<T> {
  let res: Response;
  // 写真（multipart/form-data）は FormData のまま送る。境界の入った Content-Type はブラウザが付ける
  const form = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers: Record<string, string> = {};
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  /*
   * 裏の読み直しには印を付け、職員の自動ログアウトの「操作」に数えさせない（api/automatic.ts。GitHub Issue #210）。
   * await より前に読む。読み直しの関数がその場で始めた要求だけに付けるため
   */
  if (isAutomatic()) headers[AUTO_REFRESH_HEADER] = '1';
  /*
   * 画面が思っている利用者を添える。サーバは Cookie のセッションの利用者と違えば止める（api/sessionAccount.ts）。
   * セッションを読み直す GET /api/me（bootstrap）は、いまの Cookie の利用者を知るためのものなので添えない
   */
  const expected = sessionAccount();
  if (withAccount && expected !== null) headers[ACCOUNT_HEADER] = String(expected);
  try {
    res = await fetch(path, {
      method,
      // セッションの Cookie を送る。認証情報の保持方式は未確定（要決定事項.md 優先度A）
      credentials: 'same-origin',
      // 編集ロックの解除は、タブを閉じる・読み込み直す途中にも送る。途中で打ち切られないようにする
      keepalive: method === 'DELETE',
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // 通信の失敗・時間切れは「サーバに届かない」（詳細設計書「画面の受け取り」(6-4)）。貯めて後から送ることはしない
    setReachable(false);
    throw new ApiError({ message: UNREACHABLE_MESSAGE, kind: 'unreachable' });
  }
  // 502・503（AI が下書きを返さなかったものを除く）・504 も「サーバに届かない」。ほかの応答はサーバに届いている
  if (res.status === 502 || res.status === 504 || res.status === 503) {
    const retryBody = await res.clone().json().catch(() => null);
    if (res.status !== 503 || retryBody?.kind !== 'ai_unavailable') {
      setReachable(false);
      throw new ApiError({ message: UNREACHABLE_MESSAGE, kind: 'unreachable' });
    }
  } else {
    setReachable(true);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = new ApiError(data ?? { message: '通信に失敗しました' });
    /*
     * 手続き（パスワードの変更・規約への同意）を終えるまで拒否された（server/session.go の requireUser）。
     * 文言はそのまま見せられる形で投げ、画面（App.tsx）へ知らせて手続きの画面へ案内させる（api/procedure.ts）
     */
    if (res.status === 403 && isProcedureKind(err.kind)) {
      notifyProcedureRequired(err.kind);
      throw new ProcedureRequiredError(err.kind, err.message);
    }
    /*
     * 別のタブで別のアカウントにログインし直されていた（api/sessionAccount.ts）。サーバは何もしていない。
     * 画面（App.tsx）へ知らせ、セッションを読み直していまのアカウントの画面へ切り替えさせる
     */
    if (res.status === 409 && err.kind === ACCOUNT_CHANGED_KIND) {
      notifyAccountChanged();
      throw err;
    }
    /*
     * セッションが無い・切られた（停止・紐づけの解除・ほかの端末でのパスワードの変更など。GitHub Issue #159）。
     * 参照表（園児名・職員名）を捨て、画面（App.tsx）へ知らせて入口へ戻させる。
     * ログインそのものの失敗は、まだログインしていないため知らせない
     */
    if (res.status === 401 && path !== '/api/login') {
      clearReference();
      notifySessionEnded();
    }
    // 送信元の失敗が続いて止めているとき（server/attempts.go。GitHub Issue #236 の 6）。
    // 招待コードの確認・新規登録の画面は文言をそのまま出すので、ログイン以外では文言で投げる
    if (err.kind === 'too_many_attempts' && path !== '/api/login') {
      throw new Error(err.message);
    }
    // ログインの失敗理由は画面が分岐に使う。mock 実装と同じ形（JSON 文字列）で投げる。
    // ほかの kind（version_conflict など）は文言をそのまま見せる
    if (err.kind && LOGIN_KINDS.has(err.kind)) {
      throw new Error(JSON.stringify({ kind: err.kind, remaining: err.remaining, correct: err.correct }));
    }
    throw err;
  }
  return data as T;
}

/**
 * 本文を文字列のまま受け取る（サーバで作るファイル。GET /api/nap/report）。失敗の扱いは request と同じにする：
 * 届かない・時間切れは「サーバに届かない」、401 は入口へ戻す、手続きの途中の 403 は手続きの画面へ案内する、
 * ほかの失敗はサーバの文言を投げる。fetch の text() は先頭の BOM を外す。残っていても外す（保存する画面が付け直す）
 */
async function requestText(path: string): Promise<string> {
  let res: Response;
  try {
    const expected = sessionAccount();
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: expected !== null ? { [ACCOUNT_HEADER]: String(expected) } : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    setReachable(false);
    throw new ApiError({ message: UNREACHABLE_MESSAGE, kind: 'unreachable' });
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    setReachable(false);
    throw new ApiError({ message: UNREACHABLE_MESSAGE, kind: 'unreachable' });
  }
  setReachable(true);
  const text = await res.text();
  if (!res.ok) {
    let body: { message: string; kind?: string } | null = null;
    try { body = JSON.parse(text); } catch { body = null; }
    const err = new ApiError(body ?? { message: '通信に失敗しました' });
    if (res.status === 403 && isProcedureKind(err.kind)) {
      notifyProcedureRequired(err.kind);
      throw new ProcedureRequiredError(err.kind, err.message);
    }
    if (res.status === 409 && err.kind === ACCOUNT_CHANGED_KIND) notifyAccountChanged();
    if (res.status === 401) {
      clearReference();
      notifySessionEnded();
    }
    throw err;
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const del = <T>(path: string) => request<T>('DELETE', path);
const put = <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {});

/** クエリ文字列を組み立てる。空の値は落とす */
function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === null || v === undefined || v === '') return;
    p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : '';
}

/* ============ 参照表 ============
 * ログイン直後に /api/reference で受け取り、同期の補助関数がここを読む。
 */
interface Reference {
  classes: ClassRoom[];
  children: Child[];
  staff: { staff_id: string; staff_name: string }[];
  accounts: { account_id: number; name: string; role: Role }[];
  class_names: Record<string, string>;
  settings: Record<string, string>;
  categories: DevelopmentCategory[];
}

const empty: Reference = {
  classes: [], children: [], staff: [], accounts: [],
  class_names: {}, settings: {}, categories: [],
};
let ref: Reference = empty;

/** ログイン直後と、ページを開き直したときに呼ぶ */
export async function loadReference(): Promise<void> {
  /*
   * 本文が空（null）のまま参照表にすると、どの画面も ref.classes を読めずに真っ白になる（GitHub Issue #160）。
   * サーバは JSON にできない値のとき空の 200 ではなく 500 を返す（server/httpx.go の writeJSON）が、
   * 画面の側でも、空のときは前の参照表を残して失敗として扱う
   */
  const r = await get<Reference | null>('/api/reference');
  if (!r) throw new Error('参照する情報を読み込めませんでした。もう一度お試しください');
  ref = r;
}

export function clearReference(): void {
  ref = empty;
}

/**
 * 利用者に合わせて参照表を読み込む。手続き（パスワードの変更・規約への同意）の途中は読み込まず、空にしておく。
 * 参照表には園児名・職員名が載るため、サーバは手続きを終えるまで渡さない（server/session.go の requireUser）。
 * 手続きを終えたあとの reloadSession で読み込む
 */
async function loadReferenceFor(u: SessionUser): Promise<void> {
  if (pendingProcedure(u)) {
    clearReference();
    return;
  }
  await loadReference();
}

/* ============ 同期の補助関数 ============ */

export const findChild = (id: string) => ref.children.find((c) => c.child_id === id);
export const findStaff = (id: string) => ref.staff.find((s) => s.staff_id === id);
export const findAccount = (id: number) => ref.accounts.find((a) => a.account_id === id);

export const childName = (id: string | null) =>
  (id ? findChild(id)?.child_name ?? id : '―');
export const staffName = (id: string | null) =>
  (id ? findStaff(id)?.staff_name ?? id : '―');
export const className = (id: number | null) =>
  (id ? ref.class_names[String(id)] ?? '―' : '―');
export const accountName = (accountId: number) =>
  findAccount(accountId)?.name ?? `アカウント${accountId}`;

/** 設定マスタの値。数値として解釈できなければ既定値へフォールバックし警告を出す（基本設計書 5-8） */
export function settingNumber(key: string, fallback: number): number {
  const raw = ref.settings[key];
  const n = Number(raw);
  if (raw === undefined && Object.keys(ref.settings).length === 0) return fallback;
  if (raw === undefined || Number.isNaN(n)) {
    console.warn(`[設定マスタ] ${key} を数値として解釈できません。既定値 ${fallback} を用います`);
    return fallback;
  }
  return n;
}

export function settingText(key: string, fallback: string): string {
  return ref.settings[key] ?? fallback;
}

/*
 * 参照範囲の判定
 *
 * ここでの判定は画面の出し分けのためであり、権限の担保ではない。
 * 担保はサーバ側が行う（基本設計書「権限チェックの実装方針」(6-2)）。
 * 参照表はサーバが利用者の参照範囲で絞って返しているため、含まれるかどうかで判定できる。
 */
export function canSeeChild(_user: SessionUser, childId: string): boolean {
  return ref.children.some((c) => c.child_id === childId);
}

export function visibleChildren(_user: SessionUser): Child[] {
  return ref.children;
}

export function selectableClasses(_user: SessionUser): ClassRoom[] {
  return ref.classes;
}

export function childrenOfGuardian(_guardianId: string): Child[] {
  return ref.children;
}

/* ============ 画面が呼ぶ API ============ */

const apiAuth = {
  /* ---- 認証 ---- */
  async login(email: string, password: string, entrance: 'staff' | 'guardian'): Promise<SessionUser> {
    const u = await post<SessionUser>('/api/login', { email, password, entrance });
    await loadReferenceFor(u);
    return u;
  },

  async logout(): Promise<void> {
    await post('/api/logout');
    clearReference();
  },

  /** ページを開き直したときにセッションを復元する。未ログインなら null */
  async bootstrap(): Promise<SessionUser | null> {
    try {
      // いまの Cookie の利用者を知るためのものなので、画面が思っている利用者を添えない（api/sessionAccount.ts）
      const u = await request<SessionUser>('GET', '/api/me', undefined, REQUEST_TIMEOUT_MS, false);
      // 続く参照表の読み込みには、いまの Cookie の利用者を添える。別のタブで入れ替わったあとの読み直しで、
      // 前の利用者を添えて止められないようにするため（呼んだ側は、続けてこの利用者を setUser する）
      setSessionAccount(u.account_id);
      await loadReferenceFor(u);
      return u;
    } catch {
      return null;
    }
  },

  async reloadSession(_accountId: number): Promise<SessionUser> {
    const u = await get<SessionUser>('/api/me');
    await loadReferenceFor(u);
    return u;
  },

  /**
   * ログインの期限（GitHub Issue #210）。期限はサーバが決める。尋ねるだけでは延びない
   * （server/api_session.go、server/session.go の countsAsOperation）。切れていれば 401 になり、画面へ知らせる（request）
   */
  sessionStatus: (_user: SessionUser) => get<SessionStatus>('/api/session'),

  /** 予告の「続ける」。操作の1つとして期限を延ばし、延びた期限を返す */
  extendSession: (_user: SessionUser) => post<SessionStatus>('/api/session/extend'),

  async changePassword(_accountId: number, current: string, next: string): Promise<void> {
    await post('/api/password', { current, next });
  },

  async agreeTerms(_accountId: number): Promise<void> {
    await post('/api/terms/agree');
  },

  currentTerms: () => get<{ terms_version: string; body: string; published_on: string }>('/api/terms'),

  /**
   * 招待コードの確認。ログインしている保護者（お子さまの追加）には園児名も返る（詳細設計書「お子さまの追加」(4-15 (1))）。
   * だれが呼んだかはサーバがセッションで見るため、利用者は使わない（モックと同じ形にするための引数）
   */
  verifyInvitationCode: (code: string, _u?: SessionUser | null) => post<InvitationPreview>('/api/invitation/verify', { code }),

  async signUpGuardian(input: {
    code: string; email: string; password: string; guardian_name: string; relationship: string;
    /** 利用規約に同意したかと、画面に出して同意を得た規約の版（GitHub Issue #170） */
    terms_agreed: boolean; terms_version: string;
  }): Promise<SessionUser> {
    const u = await post<SessionUser>('/api/signup', input);
    await loadReferenceFor(u);
    return u;
  },

  /* ---- 園児マスター ---- */
  listChildren: (_u: SessionUser, f: { classId?: number | ''; name?: string } = {}) =>
    get<Child[]>('/api/children' + qs({ class_id: f.classId ?? '', name: f.name ?? '' })),

  getChild: (_u: SessionUser, childId: string) => get<Child>(`/api/children/${childId}`),

  /** 園児IDがすでに使われているか。入力の時点で重複を知らせるために使う（GitHub Issue #121） */
  async childIdExists(_u: SessionUser, childId: string): Promise<boolean> {
    const r = await get<{ exists: boolean }>(`/api/children/${encodeURIComponent(childId.trim())}/exists`);
    return r.exists;
  },

  /** 氏名と生年月日が同じ園児。登録の確認画面で、重ねて登録していないかを知らせるために使う（GitHub Issue #144 の 2） */
  sameNameBirthChildren: (_u: SessionUser, childName: string, birthDate: string) =>
    get<Child[]>('/api/children/same-name-birth' + qs({ child_name: childName, birth_date: birthDate })),
  // 第1引数はモック実装（mock.ts）が権限の判定に使う。サーバはセッションから利用者を引く
  allergiesOf: (_u: SessionUser, childId: string) => get<Allergy[]>(`/api/children/${childId}/allergies`),
  medicalHistoriesOf: (_u: SessionUser, childId: string) =>
    get<{ medical_history_id: number; child_id: string; content: string }[]>(
      `/api/children/${childId}/medical-histories`),
  classOf: (_u: SessionUser, childId: string) => get<number | null>(`/api/children/${childId}/class`),
  allAllergies: (_u: SessionUser) =>
    get<{ child: Child; className: string; allergies: Allergy[] }[]>('/api/children/allergies'),

  async saveChild(_u: SessionUser, input: ChildInput, mode: 'create' | 'edit'): Promise<Child> {
    const c = await post<Child>('/api/children', { ...input, mode });
    await loadReference();
    return c;
  },

  async removeChild(_u: SessionUser, childId: string): Promise<void> {
    await del(`/api/children/${childId}`);
    await loadReference();
  },

  /* ---- 日誌システム ---- */
  listDiaries: (_u: SessionUser, f: DiaryFilter = {}) =>
    get<Paged<Diary>>('/api/diaries' + qs({
      record_type: f.recordType ?? '', class_id: f.classId ?? '', status: f.status ?? '',
      from: f.from ?? '', to: f.to ?? '', page: f.page ?? 1, mine: f.mine ? 1 : '',
    })),

  getDiary: (_u: SessionUser, diaryId: number) => get<Diary>(`/api/diaries/${diaryId}`),
  templates: () => get<DiaryTemplate[]>('/api/diaries/templates'),
  phrases: () => get<string[]>('/api/diaries/phrases'),
  attachmentsOf: (_u: SessionUser, diaryId: number) =>
    get<{ diary_attachment_id: number; diary_id: number; file_path: string; file_type: string }[]>(
      `/api/diaries/${diaryId}/attachments`),
  // いま開いている日誌そのものは除く（GitHub Issue #139・#174）。サーバが除く日誌を受け取る
  pastDiariesOf: (_u: SessionUser, childId: string, exclude?: number) =>
    get<Diary[]>(`/api/children/${childId}/diaries${qs({ exclude })}`),
  timelineOf: (_u: SessionUser, childId: string) => get<Diary[]>(`/api/children/${childId}/timeline`),
  pendingDiaries: (_u: SessionUser) => get<Diary[]>('/api/diaries/pending'),

  saveDiary: (_u: SessionUser, input: DiaryInput, status: '1' | '2') =>
    post<Diary>('/api/diaries', { ...input, status }),

  approveDiary: (_u: SessionUser, diaryId: number) =>
    post<Diary>(`/api/diaries/${diaryId}/approve`, {}),
  withdrawDiary: (_u: SessionUser, diaryId: number, updatedAt: string) =>
    post<Diary>(`/api/diaries/${diaryId}/withdraw`, { updated_at: updatedAt }),
  revokeDiaryApproval: (_u: SessionUser, diaryId: number, reason: string, updatedAt: string) =>
    post<Diary>(`/api/diaries/${diaryId}/revoke-approval`, { reason, updated_at: updatedAt }),

  returnDiary: (_u: SessionUser, diaryId: number, reason: string) =>
    post<Diary>(`/api/diaries/${diaryId}/return`, { reason }),

  async acquireLock(_u: SessionUser, diaryId: number): Promise<{ token: string } | { heldBy: string }> {
    const r = await post<{ token?: string; held_by?: string }>(`/api/diaries/${diaryId}/lock`);
    return r.token ? { token: r.token } : { heldBy: r.held_by! };
  },

  // 本人の解除は、取得のときに受け取った識別子を添える。一致するときだけ外れる（GitHub Issue #166）
  releaseLock: (_u: SessionUser, diaryId: number, force = false, token?: string) =>
    del<void>(`/api/diaries/${diaryId}/lock${force ? '?force=true' : token ? `?token=${encodeURIComponent(token)}` : ''}`),

  // 編集画面での操作を知らせ、無操作の判定を最後の操作から数えさせる（GitHub Issue #166 の 3）
  touchLock: (_u: SessionUser, diaryId: number, token: string) =>
    put<void>(`/api/diaries/${diaryId}/lock`, { lock_token: token }),

  // ロックの識別子は返らない。誰が編集中かと最終操作時刻だけ（GitHub Issue #166 の 2）
  lockOf: (_u: SessionUser, diaryId: number) =>
    get<{ diary_id: number; locked_staff_id: string; locked_at: string; last_active_at: string; staff_name: string } | null>(
      `/api/diaries/${diaryId}/lock`),
};

const apiChatNap = {
  /* ---- チャットツール ---- */
  rooms: (_u: SessionUser) => get<ChatRoomView[]>('/api/chat/rooms'),
  messages: (_u: SessionUser, roomId: number) => get<ChatMessage[]>(`/api/chat/rooms/${roomId}/messages`),
  markRead: (_u: SessionUser, roomId: number) => post<void>(`/api/chat/rooms/${roomId}/read`),
  members: (roomId: number, _viewer?: SessionUser) =>
    get<{ account_id: number; name: string; role: string; relationship: string | null }[]>(
      `/api/chat/rooms/${roomId}/members`),
  toggleReaction: (_u: SessionUser, messageId: number, reactionType: string) =>
    post<void>(`/api/chat/messages/${messageId}/reactions`, { reaction_type: reactionType }),
  setThreadStatus: (_u: SessionUser, roomId: number, status: '1' | '2') =>
    post<void>(`/api/chat/rooms/${roomId}/thread-status`, { status }),
  send: (_u: SessionUser, roomId: number, body: string) =>
    post<{ chat_message_id: number }>(`/api/chat/rooms/${roomId}/messages`, { body }),
  retract: (_u: SessionUser, messageId: number) => post<void>(`/api/chat/messages/${messageId}/retract`),
  edit: (_u: SessionUser, messageId: number, body: string) =>
    post<void>(`/api/chat/messages/${messageId}/edit`, { body }),
  // 一般の職員には、いま参加しているグループだけが返る（GitHub Issue #172）。第1引数はモックが判定に使う
  groups: (_u: SessionUser) => get<ChatRoom[]>('/api/chat/groups'),
  // 目的別グループへ入れられる相手（有効な職員）。一般の職員も取得できる
  groupCandidates: (_u: SessionUser) =>
    get<{ account_id: number; name: string; role: Role }[]>('/api/chat/group-candidates'),
  createGroup: (_u: SessionUser, name: string, accountIds: number[]) =>
    post<ChatRoom>('/api/chat/groups', { name, account_ids: accountIds }),
  updateGroupMembers: (_u: SessionUser, roomId: number, accountIds: number[]) =>
    post<void>(`/api/chat/groups/${roomId}/members`, { account_ids: accountIds }),
  misdeliveryRecords: (_u: SessionUser) => get<MisdeliveryRow[]>('/api/chat/misdelivery'),
  retractedWithoutRecord: (_u: SessionUser) => get<RetractedRow[]>('/api/chat/misdelivery/pending'),
  addMisdeliveryRecord: (
    _u: SessionUser,
    input: { chat_message_id: number; occurred_at: string; was_read: boolean; response: string },
  ) => post<void>('/api/chat/misdelivery', input),

  /*
   * 既読の人数はメッセージ側が持つ（read_count）。
   * 1件ずつ問い合わせると往復が増えるため、メッセージの取得にまとめている。
   */
  readCount: async (_messageId: number) => 0,

  /* ---- 午睡チェック ---- */
  // 第3引数はモック実装（mock.ts）が権限の判定に使う。サーバはセッションから利用者を引く
  activeSession: (classId: number, date: string, _u?: SessionUser) =>
    get<NapSession | null>('/api/nap/session' + qs({ class_id: classId, date })),
  startSession: (_u: SessionUser, classId: number, date: string) =>
    post<NapSession>('/api/nap/session', { class_id: classId, date }),
  endSession: (_u: SessionUser, sessionId: number) => post<void>(`/api/nap/session/${sessionId}/end`),
  classState: (_u: SessionUser, classId: number, sessionId: number | null) =>
    get<NapChildState[]>('/api/nap/state' + qs({ class_id: classId, session_id: sessionId ?? '' })),
  record: (
    _u: SessionUser, sessionId: number,
    input: { child_id: string; body_position: string; breathing: string; complexion: string; temperature: number | null },
  ) => post<NapRecord>(`/api/nap/session/${sessionId}/records`, input),
  recordAbnormal: (
    _u: SessionUser, sessionId: number,
    input: { child_id: string; found_at: string; situation: string; response: string } & AbnormalGuardianNoticeInput,
  ) => post<{ nap_abnormal_id: number }>(`/api/nap/session/${sessionId}/abnormals`, input),
  abnormals: (_u: SessionUser) => get<NapAbnormalRow[]>('/api/nap/abnormals'),
  raiseIncidentDiary: (_u: SessionUser, abnormalId: number) =>
    post<Diary>(`/api/nap/abnormals/${abnormalId}/incident`),
  searchRecords: (
    _u: SessionUser,
    f: { from?: string; to?: string; classId?: number | ''; childName?: string; page?: number },
  ) => get<Paged<NapSearchRow>>('/api/nap/records' + qs({
    from: f.from ?? '', to: f.to ?? '', class_id: f.classId ?? '',
    child_name: f.childName ?? '', page: f.page ?? 1,
  })),
  /**
   * 午睡チェック表（帳票）をサーバで作って受け取る（GET /api/nap/report。管理者だけ）。返すのは CSV の本文（BOM を外す）。
   * 出力したことと期間・件数は、サーバが操作ログへ記録する（基本設計書「帳票の出力」(4-8)）
   */
  napReport: (_u: SessionUser, f: NapReportFilter) => requestText('/api/nap/report' + qs({
    from: f.from, to: f.to, class_id: f.classId ?? '', format: f.format,
  })),
  /**
   * 午睡チェックの記録を修正する（POST /api/nap/records/{id}/correct）。変える項目と理由を送る。直せる人の判定はサーバが行う
   * （server/api_nap_correct.go。基本設計書「記録の修正と改ざん防止」(4-8)）
   */
  correctNapRecord: (_u: SessionUser, recordId: number, input: NapRecordCorrectInput) =>
    post<NapRecord>(`/api/nap/records/${recordId}/correct`, input),
  /**
   * 異常時の記録を修正する（POST /api/nap/abnormals/{id}/correct）。変える項目（発見時刻・状況・とった対応）と理由を送る。
   * 直せる人と発見時刻の前後の判定はサーバが行う（server/api_nap_abnormal_correct.go。基本設計書「記録の修正と改ざん防止」(4-8)）
   */
  correctNapAbnormal: (_u: SessionUser, abnormalId: number, input: NapAbnormalCorrectInput) =>
    post<NapAbnormalRow>(`/api/nap/abnormals/${abnormalId}/correct`, input),

  /**
   * 年齢に応じたチェック間隔。マスタ値を用いる（基本設計書 5-8）
   *
   * 年齢はクラスの年齢児（m_class.age_class）から引く。2歳児以上は age2 を使う
   * （基本設計書「クラスと紐づけ」(5-3)）
   */
  intervalMinutesFor(classId: number): number {
    const ageClass = ref.classes.find((c) => c.class_id === classId)?.age_class ?? 2;
    if (ageClass === 0) return settingNumber('nap.interval_minutes.age0', 5);
    if (ageClass === 1) return settingNumber('nap.interval_minutes.age1', 10);
    return settingNumber('nap.interval_minutes.age2', 15);
  },
};

const apiGrowth = {
  /* ---- 発達チェック ---- */

  /** 月齢から発達過程区分を引く。区分はマスタから読む（画面詳細図 6-1） */
  categoryFor(ageMonths: number): DevelopmentCategory | null {
    return ref.categories.find(
      (c) => ageMonths >= c.age_month_from && ageMonths <= c.age_month_to) ?? null;
  },

  async itemsFor(ageMonths: number): Promise<DevelopmentItem[]> {
    const r = await get<{ category: DevelopmentCategory | null; items: DevelopmentItem[] }>(
      '/api/development/items' + qs({ age_months: ageMonths }));
    return r.items;
  },

  list: (_u: SessionUser, classId: number) =>
    get<DevListRow[]>('/api/development/list' + qs({ class_id: classId })),

  // 第1引数はモック実装（mock.ts）が権限の判定に使う。サーバはセッションから利用者を引く（GitHub Issue #177 の 3）
  previousCheck: (_u: SessionUser, childId: string, beforeDate: string) =>
    get<{ check: DevelopmentCheck; results: DevelopmentResultRecord[] } | null>(
      `/api/children/${childId}/development/previous` + qs({ before: beforeDate })),

  draftFor: (_u: SessionUser, childId: string, checkedOn: string) =>
    get<DevDraftView | null>(
      `/api/children/${childId}/development/draft` + qs({ checked_on: checkedOn })),

  saveCheck: (
    _u: SessionUser, childId: string, checkedOn: string,
    results: { development_item_id: number; result: string | null }[],
    note: string, status: '1' | '2', guardianMessage: string | null = null,
  ) => post<DevelopmentCheck>('/api/development/checks', {
    child_id: childId, checked_on: checkedOn, results, note, status, guardian_message: guardianMessage,
  }),

  schedules: (_u: SessionUser, classId: number) =>
    get<DevScheduleRow[]>('/api/development/schedules' + qs({ class_id: classId })),

  setSchedule: (_u: SessionUser, childId: string, scheduledOn: string, manual: boolean) =>
    post<void>('/api/development/schedules', { child_id: childId, scheduled_on: scheduledOn, manual }),

  /** 予定の無い在籍園児に推奨スケジュールを当てる（管理者のみ。server/dev_schedule.go） */
  applyRecommendedSchedules: (_u: SessionUser) =>
    post<{ applied: number }>('/api/development/schedules/apply', {}),

  shareSettings: (_u: SessionUser) =>
    get<{ item: DevelopmentItem; categoryName: string; isShareable: boolean }[]>(
      '/api/development/share-settings'),

  setShareable: (_u: SessionUser, itemId: number, shareable: boolean) =>
    post<void>('/api/development/share-settings', {
      development_item_id: itemId, is_shareable: shareable,
    }),

  /* ---- 身体測定 ---- */
  classStatus: (_u: SessionUser, classId: number, measuredOn: string) =>
    get<{ target: Child[]; done: Child[]; pending: Child[] }>(
      '/api/physical/class-status' + qs({ class_id: classId, measured_on: measuredOn })),

  recordsOf: (_u: SessionUser, childId: string) => get<PhysicalRecord[]>(`/api/children/${childId}/physical`),

  /** 上書き・同じ月の別の記録は、画面で確かめた承諾を添えて送る（server/api_physical.go の handleSavePhysical） */
  save: (_u: SessionUser, input: {
    child_id: string; measured_on: string; height_cm: number; weight_kg: number;
    confirm_overwrite?: boolean; confirm_same_month?: boolean;
  }) =>
    post<PhysicalRecord>('/api/physical/records', input),

  growthBand: (sex: Sex, measureType: '1' | '2') =>
    get<GrowthStandard[] | null>('/api/physical/growth-band' + qs({ sex, measure_type: measureType })),

  remove: (_u: SessionUser, recordId: number) => del<void>(`/api/physical/records/${recordId}`),

  exportPdf: (_u: SessionUser, childId: string, purpose: 'internal' | 'guardian') =>
    post<void>('/api/physical/export', { child_id: childId, purpose }),

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
};

const apiAdmin = {
  /* ---- アカウント管理・監査 ---- */
  allAccounts: (_u: SessionUser) =>
    get<{ account_id: number; name: string; role: Role }[]>('/api/admin/accounts'),

  staffAccounts: (_u: SessionUser) => get<StaffAccountRow[]>('/api/admin/staff-accounts'),

  createStaffAccount: async (
    _u: SessionUser,
    input: { staff_id: string; staff_name: string; email: string; role: Role; class_id: number | null },
  ): Promise<string> => {
    const r = await post<{ password: string }>('/api/admin/staff-accounts', input);
    return r.password;
  },

  reissueTempPassword: async (_u: SessionUser, accountId: number): Promise<string> => {
    const r = await post<{ password: string }>(`/api/admin/accounts/${accountId}/temp-password`);
    return r.password;
  },

  unlock: (_u: SessionUser, accountId: number) => post<void>(`/api/admin/accounts/${accountId}/unlock`),

  updateStaffAccount: (
    _u: SessionUser, staffId: string,
    input: { staff_name: string; role: Role; class_id: number | null },
  ) => post<void>(`/api/admin/staff-accounts/${encodeURIComponent(staffId)}`, input),

  setAccountStatus: (_u: SessionUser, accountId: number, status: '1' | '2') =>
    post<void>(`/api/admin/accounts/${accountId}/status`, { status }),

  guardianAccounts: (_u: SessionUser) => get<GuardianAccountRow[]>('/api/admin/guardian-accounts'),

  endGuardianLink: (_u: SessionUser, guardianId: string, childId: string) =>
    post<void>('/api/admin/guardian-links/end', { guardian_id: guardianId, child_id: childId }),

  restoreGuardianLink: (_u: SessionUser, guardianId: string, childId: string) =>
    post<void>('/api/admin/guardian-links/restore', { guardian_id: guardianId, child_id: childId }),

  invitationCodes: (_u: SessionUser, f: { classId?: number | ''; status?: string } = {}) =>
    get<InvitationCodeRow[]>('/api/admin/invitations' + qs({
      class_id: f.classId ?? '', status: f.status ?? '',
    })),

  issueInvitationCodes: (
    _u: SessionUser, classId: number, perChild: number, validDays: number, includeExisting = false,
  ) => post<{ issued: number; skipped: number }>('/api/admin/invitations/bulk', {
    class_id: classId, per_child: perChild, valid_days: validDays, include_existing: includeExisting,
  }),

  issueOneInvitationCode: async (_u: SessionUser, childId: string, validDays: number): Promise<string> => {
    const r = await post<{ code: string }>('/api/admin/invitations', {
      child_id: childId, valid_days: validDays,
    });
    return r.code;
  },

  revokeInvitationCode: (_u: SessionUser, codeId: number) =>
    post<void>(`/api/admin/invitations/${codeId}/revoke`),

  operationLogs: (
    _u: SessionUser,
    f: { from?: string; to?: string; accountId?: number | ''; functionType?: string; childId?: string; page?: number } = {},
  ) => get<Paged<OperationLogRow>>('/api/admin/logs' + qs({
    from: f.from ?? '', to: f.to ?? '', account_id: f.accountId ?? '',
    function_type: f.functionType ?? '', child_id: f.childId ?? '', page: f.page ?? 1,
  })),

  /** 画面側で組み立てた出力（CSV）を操作ログへ記録する（GitHub Issue #115・#117） */
  recordExport: (
    _u: SessionUser, kind: 'operation_log' | 'allergy_list' | 'invitation_sheet',
    from: string, to: string, count: number,
  ) => post<void>('/api/exports', { kind, from, to, count }),

  /* ---- CSV一括登録・年度更新 ---- */
  parseChildCsv: (text: string) =>
    post<{ header: string[]; rows: CsvRow[] }>('/api/children/csv/parse', { text }),

  importChildCsv: async (_u: SessionUser, rows: CsvRow[], text?: string): Promise<number> => {
    // サーバ側で取り込み直前にもう一度検証する。画面の判定だけに頼らない
    const body = text ?? rows.map((r) => r.values.join(',')).join('\n');
    const r = await post<{ imported: number }>('/api/children/csv/import', { text: body });
    await loadReference();
    return r.imported;
  },

  previewFiscalYearUpdate: (_u: SessionUser) =>
    get<{ nextFiscalYear: number; classes: FiscalClassRow[]; note: string }>('/api/fiscal-year/preview'),

  /* ---- ダッシュボード ---- */
  staffSummary: (_u: SessionUser) => get<StaffSummary>('/api/dashboard/staff'),
  guardianHome: (_u: SessionUser) => get<GuardianHomeRow[]>('/api/dashboard/guardian'),
  // 保護者に共有された日誌（server/api_diary_share.go）
  guardianDiaries: (_u: SessionUser) => get<GuardianDiary[]>('/api/guardian/diaries'),
};

/* ---- 園からの配布物 ---- */
const apiHandout = {
  handouts: (_u: SessionUser, f: { type?: string; month?: string } = {}) =>
    get<Handout[]>('/api/handouts' + qs({ type: f.type ?? '', month: f.month ?? '' })),
  postHandout: async (
    _u: SessionUser,
    input: { handout_type: string; title: string; target_month: string; class_id: number | null;
             file_name: string; file_type: string; file_size: number },
  ) => post<{ handout_id: number }>('/api/handouts', input),
  withdrawHandout: (_u: SessionUser, handoutId: number) => post<void>(`/api/handouts/${handoutId}/withdraw`),
};

/* ============ 画面が使う入口 ============ */
/* 連絡帳の写真（詳細設計書「きょうのようす」(4-4 (2))・(4-4 (3))。名前はモック（api/mock.ts の contactPhotoApi）と同じ） */
const contactPhotoApi = {
  /** 写真を送る（multipart/form-data）。写っている子・承諾した名前はカンマ区切りで送る */
  sendPhoto: (_u: SessionUser, input: SendPhotoInput) => {
    const form = new FormData();
    form.append('file', input.file);
    form.append('subject_child_ids', input.subject_child_ids.join(','));
    if (input.target_child_id) form.append('target_child_id', input.target_child_id);
    if (input.body) form.append('body', input.body);
    form.append('keep_in_growth', input.keep_in_growth ? '1' : '0');
    form.append('acknowledged_names', (input.acknowledged_names ?? []).join(','));
    return post<SendPhotoResult>('/api/contact/photos', form);
  },
  /**
   * 写真の実体の URL。画面は <img src> に使う（Cookie が送られる）。見てよいかの判定は、サーバが実体を返すときに行う
   * （取り消した写真・条件に合わない写真は 403「この写真は開けません。」）
   */
  photoUrl: (_u: SessionUser, photoId: number) => Promise.resolve(`/api/contact/photos/${photoId}`),
};

/* 連絡帳と、ねた・おきた（詳細設計書「経路の一覧」(4-2)。名前はモック（api/mock.ts の contactApi）と同じ） */
const contactApi = {
  // 写真の2つ（上の contactPhotoApi）も、連絡帳の経路として画面へ出す
  ...contactPhotoApi,
  contactPage: (_u: SessionUser, childId: string, date?: string) =>
    get<ContactPage>(`/api/contact/children/${encodeURIComponent(childId)}${date ? qs({ date }) : ''}`),
  markContactRead: (_u: SessionUser, childId: string, date: string) =>
    post<{ ok: true }>(`/api/contact/children/${encodeURIComponent(childId)}/read`, { date }),
  contactClasses: (_u: SessionUser) => get<{ class_id: number; class_name: string }[]>('/api/contact/classes'),
  contactClass: (_u: SessionUser, classId: number, date?: string) =>
    get<ContactClassView>(`/api/contact/classes/${classId}${date ? qs({ date }) : ''}`),
  saveHome: (_u: SessionUser, childId: string, input: ContactHomeInput) =>
    put<ContactHome>(`/api/contact/children/${encodeURIComponent(childId)}/home`, input),
  confirmHome: (_u: SessionUser, homeId: number, updatedAt: string) =>
    post<ContactHome>(`/api/contact/home/${homeId}/confirm`, { updated_at: updatedAt }),
  sleep: (_u: SessionUser, sessionId: number, childId: string) =>
    post<NapSleep>(`/api/nap/session/${sessionId}/sleeps`, { child_id: childId }),
  wake: (_u: SessionUser, sleepId: number) => post<NapSleep>(`/api/nap/sleeps/${sleepId}/wake`),
  exclude: (_u: SessionUser, sessionId: number, childId: string, reason: '1' | '2') =>
    post<NapExclusion>(`/api/nap/session/${sessionId}/exclusions`, { child_id: childId, reason }),
  cancelExclusion: (_u: SessionUser, exclusionId: number) => post<{ ok: true }>(`/api/nap/exclusions/${exclusionId}/cancel`),
  /* きょうのようすの記録と、訂正・取り消し（詳細設計書「経路の一覧」(4-2)） */
  recordEvents: (_u: SessionUser, items: ContactEventInput[], acknowledgedNames?: string[]) =>
    post<RecordEventsResult>('/api/contact/events', { items, acknowledged_names: acknowledgedNames ?? [] }),
  correctEvent: (_u: SessionUser, eventId: number, input: ContactEventCorrection) =>
    post<ContactEvent>(`/api/contact/events/${eventId}/correct`, input),
  cancelEvent: (_u: SessionUser, eventId: number) => post<CancelResult>(`/api/contact/events/${eventId}/cancel`),
  eventReaders: (_u: SessionUser, eventId: number) => get<Readers>(`/api/contact/events/${eventId}/readers`),
  correctSleep: (_u: SessionUser, sleepId: number, input: NapSleepCorrection) =>
    post<NapSleep>(`/api/nap/sleeps/${sleepId}/correct`, input),
  cancelSleep: (_u: SessionUser, sleepId: number) => post<CancelResult>(`/api/nap/sleeps/${sleepId}/cancel`),
  sleepReaders: (_u: SessionUser, sleepId: number) => get<Readers>(`/api/nap/sleeps/${sleepId}/readers`),
  /* 園からのひとこと・他児の名前の照合・定型文（詳細設計書「園からのひとことと他児の名前」(4-5)） */
  sendFacility: (_u: SessionUser, childId: string, body: string, acknowledgedNames?: string[]) =>
    put<ContactFacility>(`/api/contact/children/${encodeURIComponent(childId)}/facility`, { body, acknowledged_names: acknowledgedNames ?? [] }),
  correctFacility: (_u: SessionUser, facilityId: number, input: FacilityCorrection) =>
    post<ContactFacility>(`/api/contact/facility/${facilityId}/correct`, input),
  cancelFacility: (_u: SessionUser, facilityId: number) => post<CancelResult>(`/api/contact/facility/${facilityId}/cancel`),
  facilityReaders: (_u: SessionUser, facilityId: number) => get<Readers>(`/api/contact/facility/${facilityId}/readers`),
  nameCheck: (_u: SessionUser, input: { child_ids?: string[]; class_id?: number; text: string }) =>
    post<{ names: string[] }>('/api/contact/name-check', input),
  contactPhrases: (_u: SessionUser, scope: Phrase['phrase_scope']) => get<Phrase[]>(`/api/phrases${qs({ scope })}`),
  /* 文章の下書き（AI）（詳細設計書「経路」(8-2)。名前はモック（api/mock.ts の aiApi）と同じ） */
  aiStatus: (_u: SessionUser, target: AiTarget) =>
    get<{ available: boolean }>(`/api/ai/status${qs({ child_id: target.child_id, class_id: target.class_id })}`),
  aiDrafts: (_u: SessionUser, input: AiDraftInput) =>
    request<AiDraftResult>('POST', '/api/ai/drafts', input, AI_REQUEST_TIMEOUT_MS),
  /* 設定画面（詳細設計書「設定」(4-10)。本版は AI の区画だけ。名前はモックの settingsApi と同じ） */
  settings: (_u: SessionUser) => get<SettingsView>('/api/settings'),
  saveSettings: (_u: SessionUser, changes: Record<string, string>, readAt: string) =>
    post<SettingsView>('/api/settings', { changes, read_at: readAt }),
  /** 「成長の記録に残す」の付け外し（詳細設計書 (4-12 (3))）。updated_at は読んだ版 */
  keepInGrowth: (_u: SessionUser, eventId: number, keep: boolean, updatedAt: string) =>
    post<ContactEvent>(`/api/contact/events/${eventId}/keep-in-growth`, { keep_in_growth: keep, updated_at: updatedAt }),
  /** 成長の記録（詳細設計書「成長の記録」(4-12 (1))）。before は前の応答の next_before */
  growthRecord: (_u: SessionUser, childId: string, before?: string | null) =>
    get<GrowthRecord>(`/api/children/${encodeURIComponent(childId)}/growth${before ? qs({ before }) : ''}`),
};

/* 保護者のメニュー（詳細設計書「保護者のメニュー」(4-15)。名前はモック（api/mock.ts の guardianApi）と同じ） */
const guardianApi = {
  /**
   * お子さまの追加（詳細設計書「お子さまの追加」(4-15 (1))）。紐づけ・招待コードの使用済み・個人チャットとクラスグループへの参加を1つの処理で行う。
   * 参照表（園児名・自児の一覧）に加わった園児が載るよう、園児の登録と同じく読み直す
   */
  async addChild(_u: SessionUser, code: string, relationship: string): Promise<AddChildResult> {
    const r = await post<AddChildResult>('/api/guardian/children', { code, relationship });
    await loadReference();
    return r;
  },
  /** AI の下書きを使わない・使う（4-15 (3)）。自分の紐づけの値だけを変える */
  aiOptOut: (_u: SessionUser, childId: string, optOut: boolean) =>
    post<{ ok: true }>(`/api/guardian/children/${encodeURIComponent(childId)}/ai-opt-out`, { opt_out: optOut }),
};

export const api = { ...apiAuth, ...apiChatNap, ...apiGrowth, ...apiAdmin, ...apiHandout, ...contactApi, ...guardianApi };
