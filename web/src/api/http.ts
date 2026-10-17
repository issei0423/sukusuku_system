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
} from './shapes';
import {
  ProcedureRequiredError, isProcedureKind, notifyProcedureRequired, notifySessionEnded, pendingProcedure,
} from './procedure';

// 画面はこれまでどおり client 経由で型を参照する。定義の実体は shapes.ts が持つ
export type {
  LoginError, ChildInput, DiaryFilter, DiaryInput, ChatRoomView, NapChildState, DevListRow, CsvRow,
};

/* ============ 通信 ============ */

class ApiError extends Error {
  kind?: string;
  remaining?: number;
  correct?: string;
  constructor(body: { message: string; kind?: string; remaining?: number; correct?: string }) {
    super(body.message);
    this.kind = body.kind;
    this.remaining = body.remaining;
    this.correct = body.correct;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    // セッションの Cookie を送る。認証情報の保持方式は未確定（要決定事項.md 優先度A）
    credentials: 'same-origin',
    // 編集ロックの解除は、タブを閉じる・読み込み直す途中にも送る。途中で打ち切られないようにする
    keepalive: method === 'DELETE',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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
     * セッションが無い・切られた（停止・紐づけの解除・ほかの端末でのパスワードの変更など。GitHub Issue #159）。
     * 参照表（園児名・職員名）を捨て、画面（App.tsx）へ知らせて入口へ戻させる。
     * ログインそのものの失敗は、まだログインしていないため知らせない
     */
    if (res.status === 401 && path !== '/api/login') {
      clearReference();
      notifySessionEnded();
    }
    // ログインの失敗理由は画面が分岐に使う。mock 実装と同じ形（JSON 文字列）で投げる
    if (err.kind) {
      throw new Error(JSON.stringify({ kind: err.kind, remaining: err.remaining, correct: err.correct }));
    }
    throw err;
  }
  return data as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const del = <T>(path: string) => request<T>('DELETE', path);

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
      const u = await get<SessionUser>('/api/me');
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

  async changePassword(_accountId: number, current: string, next: string): Promise<void> {
    await post('/api/password', { current, next });
  },

  async agreeTerms(_accountId: number): Promise<void> {
    await post('/api/terms/agree');
  },

  currentTerms: () => get<{ terms_version: string; body: string; published_on: string }>('/api/terms'),

  verifyInvitationCode: (code: string) => post<{ ok: true }>('/api/invitation/verify', { code }),

  async signUpGuardian(input: {
    code: string; email: string; password: string; guardian_name: string; relationship: string;
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
  allergiesOf: (childId: string) => get<Allergy[]>(`/api/children/${childId}/allergies`),
  medicalHistoriesOf: (childId: string) =>
    get<{ medical_history_id: number; child_id: string; content: string }[]>(
      `/api/children/${childId}/medical-histories`),
  classOf: (_u: SessionUser, childId: string) => get<number | null>(`/api/children/${childId}/class`),
  allAllergies: () =>
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
      from: f.from ?? '', to: f.to ?? '', page: f.page ?? 1,
    })),

  getDiary: (_u: SessionUser, diaryId: number) => get<Diary>(`/api/diaries/${diaryId}`),
  templates: () => get<DiaryTemplate[]>('/api/diaries/templates'),
  phrases: () => get<string[]>('/api/diaries/phrases'),
  attachmentsOf: (_u: SessionUser, diaryId: number) =>
    get<{ diary_attachment_id: number; diary_id: number; file_path: string; file_type: string }[]>(
      `/api/diaries/${diaryId}/attachments`),
  pastDiariesOf: (childId: string, _exclude?: number) => get<Diary[]>(`/api/children/${childId}/diaries`),
  timelineOf: (_u: SessionUser, childId: string) => get<Diary[]>(`/api/children/${childId}/timeline`),
  pendingDiaries: (_u: SessionUser) => get<Diary[]>('/api/diaries/pending'),

  saveDiary: (_u: SessionUser, input: DiaryInput, status: '1' | '2') =>
    post<Diary>('/api/diaries', { ...input, status }),

  approveDiary: (_u: SessionUser, diaryId: number, shareToGuardian: boolean) =>
    post<Diary>(`/api/diaries/${diaryId}/approve`, { share_to_guardian: shareToGuardian }),

  returnDiary: (_u: SessionUser, diaryId: number, reason: string) =>
    post<Diary>(`/api/diaries/${diaryId}/return`, { reason }),

  async acquireLock(_u: SessionUser, diaryId: number): Promise<{ token: string } | { heldBy: string }> {
    const r = await post<{ token?: string; held_by?: string }>(`/api/diaries/${diaryId}/lock`);
    return r.token ? { token: r.token } : { heldBy: r.held_by! };
  },

  releaseLock: (_u: SessionUser, diaryId: number, force = false) =>
    del<void>(`/api/diaries/${diaryId}/lock${force ? '?force=true' : ''}`),

  lockOf: (_u: SessionUser, diaryId: number) =>
    get<{ diary_id: number; lock_token: string; locked_staff_id: string; last_active_at: string; staff_name: string } | null>(
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
  groups: () => get<ChatRoom[]>('/api/chat/groups'),
  // 目的別グループへ入れられる相手（有効な職員）。一般の職員も取得できる
  groupCandidates: (_u: SessionUser) =>
    get<{ account_id: number; name: string; role: Role }[]>('/api/chat/group-candidates'),
  createGroup: (_u: SessionUser, name: string, accountIds: number[]) =>
    post<ChatRoom>('/api/chat/groups', { name, account_ids: accountIds }),
  updateGroupMembers: (_u: SessionUser, roomId: number, accountIds: number[]) =>
    post<void>(`/api/chat/groups/${roomId}/members`, { account_ids: accountIds }),
  misdeliveryRecords: (_u: SessionUser) => get<MisdeliveryRow[]>('/api/chat/misdelivery'),
  retractedWithoutRecord: () => get<RetractedRow[]>('/api/chat/misdelivery/pending'),
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
    input: { child_id: string; found_at: string; situation: string; response: string },
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

  previousCheck: (childId: string, beforeDate: string) =>
    get<{ check: DevelopmentCheck; results: DevelopmentResultRecord[] } | null>(
      `/api/children/${childId}/development/previous` + qs({ before: beforeDate })),

  draftFor: (childId: string, checkedOn: string) =>
    get<{ check: DevelopmentCheck; results: DevelopmentResultRecord[] } | null>(
      `/api/children/${childId}/development/draft` + qs({ checked_on: checkedOn })),

  saveCheck: (
    _u: SessionUser, childId: string, checkedOn: string,
    results: { development_item_id: number; result: string | null }[],
    note: string, status: '1' | '2',
  ) => post<DevelopmentCheck>('/api/development/checks', {
    child_id: childId, checked_on: checkedOn, results, note, status,
  }),

  schedules: (_u: SessionUser, classId: number) =>
    get<DevScheduleRow[]>('/api/development/schedules' + qs({ class_id: classId })),

  setSchedule: (_u: SessionUser, childId: string, scheduledOn: string, manual: boolean) =>
    post<void>('/api/development/schedules', { child_id: childId, scheduled_on: scheduledOn, manual }),

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

  save: (_u: SessionUser, input: { child_id: string; measured_on: string; height_cm: number; weight_kg: number }) =>
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
    _u: SessionUser, kind: 'operation_log' | 'nap_record' | 'allergy_list' | 'invitation_sheet',
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
export const api = { ...apiAuth, ...apiChatNap, ...apiGrowth, ...apiAdmin, ...apiHandout };
