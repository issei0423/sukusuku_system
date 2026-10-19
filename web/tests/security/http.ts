/*
 * セキュリティレビュー・ハーネスから、Go サーバへ要求を送るための薄い道具。
 *
 * ブラウザの代わりをするが、ブラウザが勝手に付けるものは自動では付けない。
 *   - Cookie … APIRequestContext が自分で保持する
 *   - Origin／Referer … 既定ではこのサーバ自身（画面からの操作と同じ）。CSRF の検証をする
 *     プローブは、これを偽ったり省いたりして試す
 * これにより「画面から使う分には正しい」だけでなく「攻撃者が直接叩いたとき」を試せる。
 *
 * デモアカウントは server/seed.sql と web/src/api/mockDb.ts にある（パスワードはどれも pass1234）。
 * 一時パスワードだけは temp0901（MOCKUP.md「入口とデモアカウント」）。
 */
import { request as apiRequest, type APIRequestContext } from '@playwright/test';

/** 端末を増やすときにも使う（probes.ts の Cookie の使い回しの確認） */
export { apiRequest };

/* 【仮置き】ハーネスが自分で立てるサーバの番号。tests/security/start-server.mjs と同じ */
export const PORT = Number(process.env.SECURITY_PORT ?? 8199);
export const BASE = `http://127.0.0.1:${PORT}`;

export interface Account {
  /** 何者か（レポートに出す名前） */
  label: string;
  email: string;
  password: string;
  /** 開く入口。職員用と保護者用は同じ様式で、入口だけが異なる（画面詳細図 2-1） */
  entrance: 'staff' | 'guardian';
}

export const ACCOUNTS = {
  admin: { label: '管理者（園長）', email: 'nohara@hoiku.example.jp', password: 'pass1234', entrance: 'staff' },
  sakura: { label: '一般（さくら組担任）', email: 'takanashi@hoiku.example.jp', password: 'pass1234', entrance: 'staff' },
  himawari: { label: '一般（ひまわり組担任）', email: 'kinjo@hoiku.example.jp', password: 'pass1234', entrance: 'staff' },
  spareAdmin: { label: '管理者（予備）', email: 'uezono@hoiku.example.jp', password: 'pass1234', entrance: 'staff' },
  tempPassword: { label: '一時パスワード中の職員', email: 'miyagi@hoiku.example.jp', password: 'temp0901', entrance: 'staff' },
  termsStale: { label: '規約の再同意が必要な保護者', email: 'uezono.k@example.jp', password: 'pass1234', entrance: 'guardian' },
  suspended: { label: '停止中の保護者', email: 'takanashi.r@example.jp', password: 'pass1234', entrance: 'guardian' },
  guardian: { label: '保護者（野原 太郎の保護者）', email: 'nohara.i@example.jp', password: 'pass1234', entrance: 'guardian' },
} as const satisfies Record<string, Account>;

export interface Call {
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
}

export interface CallInit {
  data?: unknown;
  /** 送る本文をそのまま渡す（大きさの上限を試すとき） */
  body?: string;
  /** 既定は BASE（画面からの操作と同じ）。null なら付けない。文字列なら偽る */
  origin?: string | null;
  referer?: string | null;
  /**
   * Cookie を自分で決めて送る（セッションの改ざん・固定の確認用）。
   * 端末の Cookie を持たない Session（ログインしていないもの）と組み合わせて使う
   */
  cookie?: string;
  headers?: Record<string, string>;
}

/** 応答を1行にまとめる。レポートにそのまま載せる */
export function brief(call: Call): string {
  const message = messageOf(call.json);
  return message ? `${call.status} ${message}` : String(call.status);
}

/** サーバが返すエラーの本文（{ message, kind }）。http.ts はこれを画面の文言に使う */
export function messageOf(json: unknown): string {
  if (json && typeof json === 'object' && 'message' in json) {
    const m = (json as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

export function kindOf(json: unknown): string {
  if (json && typeof json === 'object' && 'kind' in json) {
    const k = (json as { kind?: unknown }).kind;
    if (typeof k === 'string') return k;
  }
  return '';
}

export interface Row {
  [key: string]: unknown;
}

export function rowsOf(json: unknown): Row[] {
  return Array.isArray(json) ? (json as Row[]) : [];
}

/** ログイン状態を1つ持つ。端末1台ぶんにあたる */
export class Session {
  readonly ctx: APIRequestContext;
  readonly who: Account | undefined;

  private constructor(ctx: APIRequestContext, who: Account | undefined) {
    this.ctx = ctx;
    this.who = who;
  }

  /** 端末を1台つくる。account を渡すと、そのままログインする */
  static async open(account?: Account): Promise<Session> {
    const ctx = await apiRequest.newContext({ baseURL: BASE });
    const session = new Session(ctx, account);
    if (account) {
      const res = await session.call('POST', '/api/login', {
        data: { email: account.email, password: account.password, entrance: account.entrance, remember: false },
      });
      if (res.status !== 200) {
        throw new Error(`${account.label} でログインできませんでした: ${brief(res)}`);
      }
    }
    return session;
  }

  async call(method: string, urlPath: string, init: CallInit = {}): Promise<Call> {
    const headers: Record<string, string> = { ...init.headers };
    if (init.origin !== null) headers['Origin'] = init.origin ?? BASE;
    if (init.referer !== null) headers['Referer'] = init.referer ?? `${BASE}/`;
    if (init.cookie !== undefined) headers['Cookie'] = init.cookie;
    if (init.body !== undefined) headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';

    const res = await this.ctx.fetch(urlPath, {
      method,
      headers,
      data: init.body ?? init.data,
      failOnStatusCode: false,
    });
    const text = await res.text();
    const lower: Record<string, string> = {};
    for (const { name, value } of res.headersArray()) lower[name.toLowerCase()] = value;
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { method, path: urlPath, status: res.status(), headers: lower, text, json };
  }

  get(urlPath: string, init: CallInit = {}) {
    return this.call('GET', urlPath, init);
  }

  post(urlPath: string, init: CallInit = {}) {
    return this.call('POST', urlPath, init);
  }

  del(urlPath: string, init: CallInit = {}) {
    return this.call('DELETE', urlPath, init);
  }

  /** ログイン中の利用者。未ログインなら 401（server/session.go の requireLogin） */
  async me(): Promise<Row | null> {
    const res = await this.get('/api/me');
    return res.status === 200 ? (res.json as Row) : null;
  }

  /** セッションの Cookie。属性（HttpOnly・SameSite・Secure）を調べるのに使う */
  async cookies() {
    const state = await this.ctx.storageState();
    return state.cookies;
  }

  async close(): Promise<void> {
    await this.ctx.dispose();
  }
}
