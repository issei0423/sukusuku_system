/*
 * 攻撃ケース（プローブ）の一覧
 *
 * 「画面からは正しく使える」ことは既存のテストが見ている。ここで見るのは、
 * 画面を通さず、攻撃者が要求を直接組み立てたときに、サーバ側で止まるかである
 * （基本設計書「権限チェックの実装方針」(6-2)：権限の担保はサーバ側で行う）。
 *
 * 1 つのプローブは、いくつかの「試したこと（Attempt）」を返す。
 * Attempt.guarded が
 *   true   … その試みは防がれていた
 *   false  … 防がれていなかった（重大な指摘）
 *   null   … 判定しない（記録だけ。セキュリティヘッダの有無など）
 * プローブ全体の判定は、1 つでも false があれば ng とする（http.ts の verdictOf）。
 *
 * 期待する状態は、設計書とサーバの実装から決めている。実装を読んで「こうなるはず」を
 * 書くのではなく、「守るべき姿」を書く。落ちたら、期待値を書き換える前にどちらが正しいか確かめる。
 */
import { apiRequest, ACCOUNTS, BASE, PORT, Session, brief, kindOf, messageOf, rowsOf, type Call, type Row } from './http';

/** テストの印。レポーター（reporter.ts）がこれを見て結果を集める */
export const ANNOTATION = 'sukusuku-security';

export type Category = '認証' | '認可' | 'セッション' | 'CSRF' | '入力' | '出力';
/** 守られていなかったときの重さ。'記録' は判定しない観点 */
export type Severity = '高' | '中' | '低' | '記録';
export type Verdict = 'ok' | 'ng' | 'info';

export interface Attempt {
  /** 何をしたか */
  what: string;
  /** サーバがどう答えたか（1 行） */
  result: string;
  guarded: boolean | null;
  /** なぜそう判定したか、何に気をつけるか */
  detail?: string;
}

export interface Probe {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  /** 典拠。設計書の項目名を主に、番号はカッコで添える（AGENTS.md） */
  basis: string;
  /** 守られていなかったとき、何が起きるか */
  why: string;
  run: () => Promise<Attempt[]>;
}

export interface ProbeResult extends Omit<Probe, 'run'> {
  attempts: Attempt[];
  verdict: Verdict;
}

export function verdictOf(attempts: Attempt[]): Verdict {
  if (attempts.some((a) => a.guarded === false)) return 'ng';
  if (attempts.every((a) => a.guarded === null)) return 'info';
  return 'ok';
}

// ---- 判定の書き方 ----

/** 期待した状態（おおむね 401・403）なら守れている */
function expectStatus(call: Call, wanted: number[], what: string, detail?: string): Attempt {
  return {
    what,
    result: brief(call),
    guarded: wanted.includes(call.status),
    detail: wanted.includes(call.status) ? detail : `期待は ${wanted.join(' か ')} だが ${call.status} だった`,
  };
}

const guarded = (what: string, result: string, detail?: string): Attempt => ({ what, result, guarded: true, detail });
const broken = (what: string, result: string, detail?: string): Attempt => ({ what, result, guarded: false, detail });
const noted = (what: string, result: string, detail?: string): Attempt => ({ what, result, guarded: null, detail });
/** true / false を自分で決める */
const judge = (what: string, result: string, ok: boolean, detail?: string): Attempt =>
  ok ? guarded(what, result, detail) : broken(what, result, detail);

/** 一覧 API はページングの包み（{ rows }）で返ることがある */
function pageRows(json: unknown): Row[] {
  if (Array.isArray(json)) return json as Row[];
  if (json && typeof json === 'object' && Array.isArray((json as { rows?: unknown }).rows)) {
    return (json as { rows: Row[] }).rows;
  }
  return [];
}

function ids(rows: Row[], key = 'child_id'): string[] {
  return rows.map((r) => String(r[key])).filter((v) => v !== 'undefined' && v !== 'null');
}

/** 日本時間の今日から offset 日ずらした日付（YYYY-MM-DD）。日誌の期間指定に使う */
function day(offset: number): string {
  return new Date(Date.now() + 9 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);
}

export const PROBES: Probe[] = [
  {
    id: 'auth.unauthenticated',
    title: 'ログインしていない端末では、どの API も使えない',
    category: '認証',
    severity: '高',
    basis: '基本設計書「権限チェックの実装方針」(6-2)',
    why: '認証の確認が漏れた API が 1 つでもあると、ログインを知らない相手に園児の記録が読まれる',
    async run() {
      const s = await Session.open();
      const targets: [string, string][] = [
        ['GET', '/api/children'],
        ['GET', '/api/classes'],
        ['GET', '/api/diaries'],
        ['GET', '/api/reference'],
        ['GET', '/api/admin/logs'],
        ['GET', '/api/dashboard/staff'],
        ['POST', '/api/diaries'],
        ['POST', '/api/children'],
        ['POST', '/api/exports'],
      ];
      const attempts: Attempt[] = [];
      for (const [method, path] of targets) {
        const call = await s.call(method, path, { data: {} });
        attempts.push(expectStatus(call, [401], `未ログインで ${method} ${path}`));
      }
      await s.close();
      return attempts;
    },
  },

  {
    id: 'auth.wrong-entrance',
    title: '系統の違う入口からはログインできない',
    category: '認証',
    severity: '中',
    basis: '画面詳細図「職員用トップ／保護者用トップ」(2-1)、基本設計書「ログイン」(4-3)',
    why: '保護者のアカウントで職員用の画面に入れると、扱える機能の範囲を取り違える',
    async run() {
      const s = await Session.open();
      const asStaff = await s.call('POST', '/api/login', {
        data: { email: ACCOUNTS.guardian.email, password: ACCOUNTS.guardian.password, entrance: 'staff', remember: false },
      });
      const asGuardian = await s.call('POST', '/api/login', {
        data: { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password, entrance: 'guardian', remember: false },
      });
      const attempts = [
        expectStatus(asStaff, [401], '保護者のアカウントで、職員用の入口からログイン'),
        noted('返ってきた理由', `${kindOf(asStaff.json) || '(なし)'} ／ ${messageOf(asStaff.json)}`),
        expectStatus(asGuardian, [401], '職員のアカウントで、保護者用の入口からログイン'),
        noted('返ってきた理由', `${kindOf(asGuardian.json) || '(なし)'} ／ ${messageOf(asGuardian.json)}`),
      ];
      const me = await s.get('/api/me');
      attempts.push(expectStatus(me, [401], '断られたあと、セッションができていないか'));
      await s.close();
      return attempts;
    },
  },

  {
    id: 'auth.suspended-account',
    title: '停止中のアカウントはログインできない',
    category: '認証',
    severity: '高',
    basis: '要件定義書、画面詳細図「保護者アカウント管理」(7-8 項目5)',
    why: '卒園・退職で止めたはずの相手が、そのまま園の記録に入れてしまう',
    async run() {
      const s = await Session.open();
      const res = await s.call('POST', '/api/login', {
        data: { email: ACCOUNTS.suspended.email, password: ACCOUNTS.suspended.password, entrance: 'guardian', remember: false },
      });
      const attempts = [
        expectStatus(res, [401], '停止中のアカウントでログイン'),
        noted('返ってきた理由', `${kindOf(res.json) || '(なし)'} ／ ${messageOf(res.json)}`),
      ];
      attempts.push(expectStatus(await s.get('/api/me'), [401], '断られたあと、セッションができていないか'));
      await s.close();
      return attempts;
    },
  },

  {
    id: 'auth.relogin-while-logged-in',
    title: 'ログイン中は、別のアカウントでログインし直せない',
    category: 'セッション',
    severity: '高',
    basis: '基本設計書「ログイン」(4-3)、要件定義書「同時ログインの扱い」(4-1-1)',
    why: '1 台の端末で上書きログインができると、共有端末で前の利用者の記録のまま操作してしまう（GitHub Issue #159）',
    async run() {
      const s = await Session.open(ACCOUNTS.admin);
      const hijack = await s.call('POST', '/api/login', {
        data: {
          email: ACCOUNTS.himawari.email,
          password: ACCOUNTS.himawari.password,
          entrance: 'staff',
          remember: false,
        },
      });
      const me = await s.me();
      const attempts = [
        // 断り方は 409（すでにログインしています）。401 ではないが、成立させないことが要点
        expectStatus(hijack, [401, 409], 'ログイン中に、別のアカウントでログインを送る'),
        noted('返ってきた理由', `${kindOf(hijack.json) || '(なし)'} ／ ${messageOf(hijack.json)}`),
        judge(
          'ログイン中の利用者が入れ替わっていないか',
          String(me?.email ?? '(なし)'),
          me?.email === ACCOUNTS.admin.email,
          '元の利用者のままであること',
        ),
      ];
      await s.close();
      return attempts;
    },
  },

  {
    id: 'auth.credential-response',
    title: 'ログインの失敗は、アカウントの有無を推測させない',
    category: '認証',
    severity: '中',
    basis: '基本設計書「ログイン」(4-3)、コードのコメント「存在しないアカウントでも、あるかどうかを推測させない文言に揃える」',
    why: '失敗の文言から在籍の有無が分かると、攻撃の的を絞られる',
    async run() {
      const s = await Session.open();
      const unknown = await s.call('POST', '/api/login', {
        data: { email: 'sonzai-shinai@example.jp', password: 'pass1234', entrance: 'staff', remember: false },
      });
      const existing = await s.call('POST', '/api/login', {
        data: { email: ACCOUNTS.spareAdmin.email, password: 'not-the-password', entrance: 'staff', remember: false },
      });
      const remaining = (call: Call) => {
        const v = (call.json as { remaining?: unknown } | null)?.remaining;
        return v === undefined ? '(なし)' : String(v);
      };
      const attempts = [
        expectStatus(unknown, [401], '存在しないログインID'), 
        expectStatus(existing, [401], '存在するログインID ＋ 誤ったパスワード'),
        judge(
          '失敗の文言がそろっているか',
          `${messageOf(unknown.json)} ／ ${messageOf(existing.json)}`,
          messageOf(unknown.json) !== '' && messageOf(unknown.json) === messageOf(existing.json),
        ),
        noted(
          '残り回数の違い（推測の手がかりになる）',
          `存在しないID: remaining=${remaining(unknown)} ／ 存在するID: remaining=${remaining(existing)}`,
          '文言はそろっていても、残り回数が違うため在籍の有無は分かる。設計上そう決めているのかを人が確かめる（AGENTS.md「推測で決めない」）',
        ),
      ];

      // 失敗が続いたときのロック。予備の管理者アカウントを 1 つ使い切る（データベースは使い捨て）
      let locked: Call | null = null;
      for (let i = 0; i < 6 && !locked; i++) {
        const res = await s.call('POST', '/api/login', {
          data: { email: ACCOUNTS.spareAdmin.email, password: `wrong-${i}`, entrance: 'staff', remember: false },
        });
        if (kindOf(res.json) === 'locked') locked = res;
      }
      attempts.push(
        judge(
          '失敗が続くとロックされるか',
          locked ? brief(locked) : '(ロックされなかった)',
          locked !== null,
          '総当たりを止められること',
        ),
      );
      await s.close();
      return attempts;
    },
  },

  {
    id: 'session.cookie',
    title: 'セッションは、盗まれにくく、切れやすい Cookie で持つ',
    category: 'セッション',
    severity: '高',
    basis: '要件定義書「セッションの保護」(8 No.9)、基本設計書「データ保護」(6-3)、「認証情報の保持方式」(6-3)',
    why: 'JavaScript から読めると XSS で盗まれる。ログアウトで無効にならないと共有端末で成り済まされる',
    async run() {
      const first = await Session.open(ACCOUNTS.admin);
      const cookie = (await first.cookies()).find((c) => c.name === 'sukusuku_session');
      const attempts: Attempt[] = [];

      if (!cookie) {
        attempts.push(broken('セッションの Cookie があるか', '(見つからない)'));
      } else {
        attempts.push(
          judge('セッションの Cookie があるか', `${cookie.name}（${cookie.value.length} 文字）`, true),
          judge('HttpOnly（JavaScript から読めない）', String(cookie.httpOnly), cookie.httpOnly === true, 'XSS があってもセッションを盗まれない'),
          judge('SameSite', String(cookie.sameSite), cookie.sameSite === 'Strict', '他サイトからの遷移では Cookie が送られない（CSRF の緩和）'),
          judge('値を推測できない長さか', `${cookie.value.length} 文字`, cookie.value.length >= 32),
          noted(
            'Secure',
            String(cookie.secure),
            '【設計どおり】本演習の動作検証環境は localhost のため false（server/session.go。要件定義書「想定運用環境」6-1・「本演習での動作検証環境」6-2）',
          ),
        );
      }

      // 2 台目。ログインのたびに別の値になっていること
      const second = await Session.open(ACCOUNTS.admin);
      const other = (await second.cookies()).find((c) => c.name === 'sukusuku_session');
      attempts.push(
        judge(
          'ログインのたびに別の値になるか',
          `${cookie?.value.slice(0, 6) ?? '(なし)'}… ／ ${other?.value.slice(0, 6) ?? '(なし)'}…`,
          !!cookie && !!other && cookie.value !== other.value,
          '値から他人のセッションを推測できないこと',
        ),
      );

      // ログアウトしたあと、古い Cookie をそのまま送りつけてみる
      if (cookie) {
        const old = cookie;
        await first.post('/api/logout');
        const replay = await apiRequest.newContext({
          baseURL: BASE,
          storageState: {
            cookies: [{ ...old, domain: '127.0.0.1', path: '/', expires: -1 }],
            origins: [],
          },
        });
        const res = await replay.fetch('/api/me', { headers: { Origin: BASE }, failOnStatusCode: false });
        attempts.push(
          judge(
            'ログアウト後、同じ Cookie を使い回せるか',
            `${res.status()} ${messageOf(await res.json().catch(() => null))}`,
            res.status() === 401,
            'サーバ側のセッションも捨てていること（server/session.go の destroy）',
          ),
        );
        await replay.dispose();
      }

      await first.close();
      await second.close();
      return attempts;
    },
  },

  {
    id: 'auth.temp-password-gate',
    title: '一時パスワードのままでは、手続き以外の機能を使えない',
    category: '認可',
    severity: '高',
    basis: '基本設計書「画面遷移」(3-4)・「アカウント（m_account）」(5-2)、「権限チェックの実装方針」(6-2)',
    why: '画面の出し分けだけだと、API を直接呼べば手続きを飛ばして使えてしまう（GitHub Issue #153）',
    async run() {
      const s = await Session.open();
      const login = await s.call('POST', '/api/login', {
        data: {
          email: ACCOUNTS.tempPassword.email,
          password: ACCOUNTS.tempPassword.password,
          entrance: 'staff',
          remember: false,
        },
      });
      const attempts = [
        expectStatus(login, [200], '一時パスワードでログイン'),
        judge('一時パスワード中として返るか', String((login.json as Row | null)?.is_temp_password), (login.json as Row | null)?.is_temp_password === true),
        expectStatus(await s.get('/api/children'), [403], '手続きの途中で園児の一覧'),
        expectStatus(await s.get('/api/reference'), [403], '手続きの途中で参照表'),
        expectStatus(await s.get('/api/me'), [200], '手続きの途中でも、自分の情報は取れる'),
      ];
      const refused = await s.get('/api/children');
      attempts.push(noted('拒否の理由', `${kindOf(refused.json) || '(なし)'} ／ ${messageOf(refused.json)}`));
      await s.close();
      return attempts;
    },
  },

  {
    id: 'auth.terms-gate',
    title: '規約に同意するまで、他の機能を使えない',
    category: '認可',
    severity: '中',
    basis: '基本設計書「画面遷移」(3-4)、要件定義書「利用規約」(8)',
    why: '規約の改定後に同意を取らないまま使い続けられると、同意の記録が実際の利用と食い違う',
    async run() {
      const s = await Session.open();
      const login = await s.call('POST', '/api/login', {
        data: {
          email: ACCOUNTS.termsStale.email,
          password: ACCOUNTS.termsStale.password,
          entrance: 'guardian',
          remember: false,
        },
      });
      const attempts = [
        expectStatus(login, [200], '規約の再同意が必要な保護者でも、ログインはできる'),
        judge('同意が済んでいないとして返るか', String((login.json as Row | null)?.terms_agreed), (login.json as Row | null)?.terms_agreed === false),
        expectStatus(await s.get('/api/children'), [403], '同意する前に園児の記録'),
        expectStatus(await s.get('/api/dashboard/guardian'), [403], '同意する前に保護者用トップの内容'),
      ];
      const refused = await s.get('/api/children');
      attempts.push(noted('拒否の理由', `${kindOf(refused.json) || '(なし)'} ／ ${messageOf(refused.json)}`));
      await s.close();
      return attempts;
    },
  },

  {
    id: 'auth.stop-cuts-session',
    title: 'アカウントを停止すると、その場でセッションが切れる',
    category: 'セッション',
    severity: '高',
    basis: '基本設計書「認証情報の保持方式」(6-3)、画面詳細図「保護者アカウント管理」(7-8 項目5)',
    why: '停止したはずの端末が、開いたままの画面で使い続けられてしまう（GitHub Issue #159）',
    async run() {
      const victim = await Session.open(ACCOUNTS.himawari);
      const me = await victim.me();
      const accountId = me?.account_id;
      if (accountId === undefined) throw new Error('停止の対象にするアカウントのIDが取れませんでした');

      const admin = await Session.open(ACCOUNTS.admin);
      const attempts: Attempt[] = [];
      try {
        const stop = await admin.post(`/api/admin/accounts/${accountId}/status`, { data: { status: '2' } });
        const cut = await victim.get('/api/children');
        const after = await victim.me();
        attempts.push(
          expectStatus(stop, [200], `管理者が ${ACCOUNTS.himawari.label} を停止する`),
          expectStatus(cut, [401], '停止されたアカウントの、停止前からのセッションで園児の一覧'),
          judge('セッションが切れているか', String(after?.email ?? '(切れた)'), after === null),
        );
      } finally {
        try {
          const restore = await admin.post(`/api/admin/accounts/${accountId}/status`, { data: { status: '1' } });
          attempts.push(expectStatus(restore, [200], '確かめたあと、状態を有効へ戻す'));
        } finally {
          await victim.close();
          await admin.close();
        }
      }
      return attempts;
    },
  },

  {
    id: 'authz.cross-class-child',
    title: '担当外のクラスの園児は参照できない',
    category: '認可',
    severity: '高',
    basis: '基本設計書「権限と利用可能機能」(6-1)・「権限チェックの実装方針」(6-2)、要件定義書「対象権限列の読み方」(4-2 冒頭)',
    why: '担任の違う園児の記録が読めると、保護者の同意なく他の家庭の情報が見える',
    async run() {
      const admin = await Session.open(ACCOUNTS.admin);
      const all = ids(rowsOf((await admin.get('/api/children')).json));
      const sakura = await Session.open(ACCOUNTS.sakura);
      const mine = ids(rowsOf((await sakura.get('/api/children')).json));
      const outside = all.filter((id) => !mine.includes(id));
      const classes = rowsOf((await admin.get('/api/classes')).json);
      const myClass = (await sakura.me())?.class_id;
      const otherClass = classes.find((c) => Number(c.class_id) !== Number(myClass));

      const attempts = [
        judge(
          '一般職員に見える園児が、全園児より少ないか',
          `${mine.length} 名 / 全 ${all.length} 名`,
          mine.length > 0 && mine.length < all.length,
        ),
      ];

      if (outside.length === 0) {
        attempts.push(broken('担当外の園児を試せるか', '(デモデータに担当外の園児がない)'));
      } else {
        const target = outside[0];
        attempts.push(
          expectStatus(await sakura.get(`/api/children/${target}`), [403], `担当外の園児（${target}）を開く`),
          expectStatus(await sakura.get(`/api/children/${target}/diaries`), [403], `担当外の園児（${target}）の日誌`),
          expectStatus(await sakura.get(`/api/children/${mine[0]}/diaries`), [200], `担当の園児（${mine[0]}）の日誌は開ける`),
        );
      }

      if (otherClass) {
        const got = ids(rowsOf((await sakura.get(`/api/children?class_id=${otherClass.class_id}`)).json));
        attempts.push(
          judge(
            `範囲外のクラス（${otherClass.class_name}）を指定しても出ないか`,
            `${got.length} 件`,
            got.length === 0,
            '絞り込みの指定から参照範囲をすり抜けられないこと',
          ),
        );
      }

      await admin.close();
      await sakura.close();
      return attempts;
    },
  },

  {
    id: 'authz.admin-only',
    title: '管理者に限る操作は、一般職員には通らない',
    category: '認可',
    severity: '高',
    basis: '基本設計書「権限と利用可能機能」(6-1)・「権限チェックの実装方針」(6-2)',
    why: 'マスター管理やアカウント管理が一般職員に通ると、記録を書き換えたりアカウントを作ったりできる',
    async run() {
      const s = await Session.open(ACCOUNTS.sakura);
      const targets: [string, string][] = [
        ['GET', '/api/admin/accounts'],
        ['GET', '/api/admin/staff-accounts'],
        ['GET', '/api/admin/guardian-accounts'],
        ['GET', '/api/admin/invitations'],
        ['GET', '/api/admin/logs'],
        ['POST', '/api/children'],
        ['POST', '/api/admin/invitations'],
        ['POST', '/api/admin/staff-accounts'],
      ];
      const attempts: Attempt[] = [];
      for (const [method, path] of targets) {
        const call = await s.call(method, path, { data: {} });
        attempts.push(expectStatus(call, [403], `一般職員で ${method} ${path}`));
      }
      attempts.push(expectStatus(await s.get('/api/diaries'), [200], '（対照）一般職員でも、日誌の一覧は使える'));
      await s.close();
      return attempts;
    },
  },

  {
    id: 'authz.cross-class-diary',
    title: '担当外の日誌は、開くことも編集ロックもできない',
    category: '認可',
    severity: '高',
    basis: '基本設計書「権限チェックの実装方針」(6-2)、GitHub Issue #153',
    why: '日誌のIDを直接指定されると、担当外の家庭の記録が読めたり、他人の編集を止めたりできてしまう',
    async run() {
      const admin = await Session.open(ACCOUNTS.admin);
      const listed = pageRows((await admin.get(`/api/diaries?from=${day(-90)}&to=${day(0)}`)).json);

      const himawari = await Session.open(ACCOUNTS.himawari);
      const mine = new Set(ids(rowsOf((await himawari.get('/api/children')).json)));
      const outside = listed.find((d) => typeof d.child_id === 'string' && !mine.has(d.child_id as string));
      const inside = listed.find((d) => typeof d.child_id === 'string' && mine.has(d.child_id as string));

      const attempts: Attempt[] = [];
      if (!outside) {
        attempts.push(broken('担当外の日誌を試せるか', '(期間内に、担当外の園児の日誌が見つからない)'));
      } else {
        const id = outside.diary_id;
        attempts.push(
          expectStatus(await himawari.get(`/api/diaries/${id}`), [403], `担当外の日誌（${id}）を開く`),
          expectStatus(await himawari.get(`/api/diaries/${id}/attachments`), [403], `担当外の日誌（${id}）の添付`),
          expectStatus(await himawari.post(`/api/diaries/${id}/lock`), [403], `担当外の日誌（${id}）の編集ロック`),
        );
      }
      if (inside) {
        attempts.push(expectStatus(await himawari.get(`/api/diaries/${inside.diary_id}`), [200], `担当の日誌（${inside.diary_id}）は開ける`));
      }

      await admin.close();
      await himawari.close();
      return attempts;
    },
  },

  {
    id: 'authz.guardian-staff-api',
    title: '保護者は、職員用の API を使えない',
    category: '認可',
    severity: '高',
    basis: '基本設計書「権限と利用可能機能」(6-1)・「権限チェックの実装方針」(6-2)',
    why: '保護者が職員の機能を直接叩けると、他の家庭の記録の閲覧や、記録の作成・変更ができてしまう',
    async run() {
      const s = await Session.open(ACCOUNTS.guardian);
      // GET /api/children はここに入れない。職員専用ではなく、保護者にも自児だけを返す
      // （server/api_child.go の handleListChildren は requireUser + visibleChildren）。
      // 紐づきの範囲そのものは authz.guardian-link-scope が見ている
      const targets: [string, string][] = [
        ['GET', '/api/nap/records'],
        ['GET', '/api/development/list'],
        ['GET', '/api/admin/logs'],
        ['POST', '/api/diaries'],
        ['POST', '/api/nap/session'],
      ];
      const attempts: Attempt[] = [];
      for (const [method, path] of targets) {
        const call = await s.call(method, path, { data: {} });
        attempts.push(expectStatus(call, [403], `保護者で ${method} ${path}`));
      }
      attempts.push(expectStatus(await s.get('/api/dashboard/guardian'), [200], '（対照）保護者用トップの内容は取れる'));
      await s.close();
      return attempts;
    },
  },

  {
    id: 'authz.guardian-link-scope',
    title: '保護者は、紐づいた園児の記録しか参照できない',
    category: '認可',
    severity: '高',
    basis: '基本設計書「権限と利用可能機能」(6-1)、「データベース設計」の紐づけ（5-5）、画面詳細図「保護者アカウント管理」(7-8 項目6)',
    why: '紐づけの外の園児が読めると、他の家庭の記録が保護者に渡ってしまう',
    async run() {
      // server/seed.sql: m_account(6) → m_guardian(G001) → t_guardian_child(C001, 有効)。
      // 検査対象の API 応答から期待値を作ると、同じ他児を複数の API が漏らしても通ってしまう。
      const expected = ['C001'];
      const admin = await Session.open(ACCOUNTS.admin);
      const all = ids(rowsOf((await admin.get('/api/children')).json));

      const s = await Session.open(ACCOUNTS.guardian);
      // 園児の詳細（GET /api/children/{id}）は職員専用で、保護者には常に 403 になるため
      // （server/api_child.go の handleGetChild）、範囲のすり抜けは
      // 「一覧に自児以外が出ないか」と「日誌の ID を直接指定できるか」で見る
      const home = rowsOf((await s.get('/api/dashboard/guardian')).json);
      const viaHome = home
        .map((row) => String((row.child as Row | undefined)?.child_id ?? ''))
        .filter((id) => id !== '');
      const viaList = ids(rowsOf((await s.get('/api/children')).json));
      const outside = all.filter((id) => !expected.includes(id));

      const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
      const attempts: Attempt[] = [
        judge('デモデータに期待する園児がいるか', `${expected.join('、')} ／ 全 ${all.join('、')}`, expected.every((id) => all.includes(id))),
        judge(
          '保護者ホームは、有効に紐づいた園児だけを返すか',
          `${viaHome.join('、') || '(なし)'} ／ 期待 ${expected.join('、')}`,
          sameSet(viaHome, expected),
        ),
        judge(
          '園児一覧は、有効に紐づいた園児だけを返すか',
          `${viaList.join('、') || '(なし)'} ／ 期待 ${expected.join('、')}`,
          sameSet(viaList, expected),
        ),
      ];

      // 自児の共有日誌は開ける。返る日誌が、すべて自児のものか
      const own = pageRows((await s.get(`/api/diaries?from=${day(-365)}&to=${day(0)}`)).json);
      attempts.push(
        judge(
          '共有日誌の一覧に、他児の日誌が混ざっていないか',
          `${own.length} 件`,
          own.every((d) => typeof d.child_id === 'string' && expected.includes(d.child_id as string)),
        ),
      );
      if (own.length > 0) {
        attempts.push(
          expectStatus(await s.get(`/api/diaries/${own[0].diary_id}`), [200], `共有された自児の日誌（${own[0].diary_id}）は開ける`),
        );
      }

      // 紐づきのない園児の日誌は、ID を直接指定しても開けない
      const listed = pageRows((await admin.get(`/api/diaries?from=${day(-365)}&to=${day(0)}`)).json);
      const unreachable = listed.find((d) => typeof d.child_id === 'string' && outside.includes(d.child_id as string));
      if (unreachable) {
        attempts.push(
          expectStatus(
            await s.get(`/api/diaries/${unreachable.diary_id}`),
            [403],
            `紐づきのない園児（${unreachable.child_id}）の日誌（${unreachable.diary_id}）を開く`,
          ),
          expectStatus(
            await s.get(`/api/diaries/${unreachable.diary_id}/attachments`),
            [403],
            `その日誌（${unreachable.diary_id}）の添付`,
          ),
        );
      } else {
        attempts.push(broken('紐づきのない園児の日誌を試せるか', '(期間内に見つからない)', '直接指定の拒否を試せるデモデータが必要'));
      }

      await admin.close();
      await s.close();
      return attempts;
    },
  },

  {
    id: 'csrf.origin-required',
    title: '状態を変える要求は、送信元を確かめてから通す',
    category: 'CSRF',
    severity: '高',
    basis: '要件定義書「セッションの保護」(8 No.9)、基本設計書「データ保護」(6-3)、server/csrf.go',
    why: '他サイトに置いた細工から、ログイン中の職員の権限で記録を書き換えられてしまう',
    async run() {
      const s = await Session.open(ACCOUNTS.admin);
      const evil = 'https://evil.example';
      const targets = ids(rowsOf((await s.get('/api/children')).json));
      const victim = targets[0];

      const attempts: Attempt[] = [
        expectStatus(await s.post('/api/diaries', { data: {}, origin: evil }), [403], '偽の Origin をつけた POST'),
        expectStatus(await s.post('/api/diaries', { data: {}, origin: null, referer: null }), [403], 'Origin も Referer も無い POST'),
        expectStatus(await s.post('/api/diaries', { data: {}, origin: null, referer: evil }), [403], 'Origin が無く、偽の Referer をつけた POST'),
      ];

      if (victim) {
        const before = ids(rowsOf((await s.get('/api/children')).json));
        attempts.push(
          expectStatus(await s.del(`/api/children/${victim}`, { origin: evil }), [403], `偽の Origin をつけた DELETE /api/children/${victim}`),
        );
        const after = ids(rowsOf((await s.get('/api/children')).json));
        attempts.push(judge('園児が消えていないか', `${after.length} 件（前 ${before.length} 件）`, after.length === before.length));
      }

      const control = await s.post('/api/diaries', { data: {} });
      attempts.push(judge('（対照）正しい Origin の要求は、CSRF の判定では止まらない', brief(control), control.status !== 403));
      await s.close();
      return attempts;
    },
  },

  {
    id: 'injection.sql',
    title: '入力に SQL の断片を入れても、組み立てた問い合わせにならない',
    category: '入力',
    severity: '高',
    basis: '基本設計書「権限チェックの実装方針」(6-2)、要件定義書「セキュリティ」(8)',
    why: '問い合わせを文字列で組み立てていると、入力から条件を書き換えられ、認証を素通りしたり全件を抜き取られたりする',
    async run() {
      const s = await Session.open();
      const fragment = "' OR '1'='1";
      const attempts: Attempt[] = [
        expectStatus(
          await s.call('POST', '/api/login', { data: { email: fragment, password: fragment, entrance: 'staff', remember: false } }),
          [401],
          'ログインIDに SQL の断片を入れる',
        ),
        expectStatus(
          await s.call('POST', '/api/login', {
            data: { email: ACCOUNTS.admin.email, password: fragment, entrance: 'staff', remember: false },
          }),
          [401],
          'パスワードに SQL の断片を入れる',
        ),
      ];

      const admin = await Session.open(ACCOUNTS.admin);
      const all = rowsOf((await admin.get('/api/children')).json);
      const filtered = await admin.get(`/api/children?name=${encodeURIComponent(fragment)}`);
      const hits = rowsOf(filtered.json).length;

      // 対照: 実在する園児名の 1 文字で絞り込むと、ちゃんと当たる（絞り込みが動いていること）。
      // これが 0 件だと「いつでも 0 件」を確かめただけになり、下の判定に意味が無くなる
      const sampleName = String(all[0]?.child_name ?? '').slice(0, 1);
      const control = sampleName === '' ? null : await admin.get(`/api/children?name=${encodeURIComponent(sampleName)}`);

      attempts.push(
        judge('一覧の絞り込みに断片を入れても壊れないか', brief(filtered), filtered.status === 200),
        judge(
          '断片で絞り込むと 1 件も出ないか（全件が返っていないか）',
          `${hits} 件 / 全 ${all.length} 件`,
          hits === 0,
          '断片はどの園児名にも含まれない。絞り込みが正しければ 1 件も出ない（件数が全件と一致していたら漏えい）',
        ),
      );
      if (control) {
        attempts.push(
          judge(
            '（対照）実在する名前で絞り込むと当たるか',
            `${rowsOf(control.json).length} 件`,
            rowsOf(control.json).length > 0,
            '絞り込みがいつでも 0 件になっているわけではないこと',
          ),
        );
      }
      await s.close();
      await admin.close();
      return attempts;
    },
  },

  {
    id: 'injection.path-traversal',
    title: '配信ディレクトリの外のファイルは読めない',
    category: '入力',
    severity: '高',
    basis: 'server/main.go の serveWeb、要件定義書「想定運用環境」(6-1)',
    why: '経路をさかのぼって読めると、サーバのソースやデータベース、設定が取られる',
    async run() {
      const s = await Session.open();
      const attempts: Attempt[] = [
        expectStatus(await s.get('/favicon.svg'), [200], '（対照）配信ディレクトリのファイルは取れる'),
      ];
      // ブラウザ・node は URL を正規化してから送るため、符号化した形（攻撃者が実際に送る形）で試す。
      // ねらうファイルごとに、返ってきたら分かる目印を決めておく。目印を 1 つにすると、
      // 別のファイルが返ったときに見逃す（テーブル定義の目印だけでは AGENTS.md や DB を見落とす）
      const targets: [string, RegExp, string][] = [
        ['/%2e%2e%2fserver%2fseed.sql', /CREATE TABLE|INSERT INTO m_account/i, 'テーブル定義の SQL（server/seed.sql）'],
        ['/%2e%2e%2f%2e%2e%2fserver%2fseed.sql', /CREATE TABLE|INSERT INTO m_account/i, 'テーブル定義の SQL（server/seed.sql）'],
        ['/%2e%2e%2f%2e%2e%2fAGENTS.md', /AGENTS\.md|すくすくシステム モックアップ/, 'リポジトリの決まり（AGENTS.md）'],
        ['/assets%2f%2e%2e%2f%2e%2e%2fserver%2fseed.sql', /CREATE TABLE|INSERT INTO m_account/i, 'テーブル定義の SQL（server/seed.sql）'],
        ['/%2e%2e%2fserver%2fsukusuku.db', /SQLite format 3/, 'データベースファイル（server/sukusuku.db）'],
      ];
      for (const [path, marker, what] of targets) {
        const call = await s.get(path);
        const leaked = marker.test(call.text);
        attempts.push(
          judge(
            `GET ${path}`,
            leaked ? `${call.status}（${what} が返った）` : String(call.status),
            !leaked,
            leaked ? `配信ディレクトリの外のファイルが読めている（探した内容: ${what}）` : undefined,
          ),
        );
      }
      await s.close();
      return attempts;
    },
  },

  {
    id: 'input.body-limit',
    title: '大きすぎる本文は受け取らず、サーバも止まらない',
    category: '入力',
    severity: '中',
    basis: 'server/httpx.go の readJSON（http.MaxBytesReader で 1MB）',
    why: '本文を無制限に読むと、メモリを使い切って他の利用者の応答が止まる',
    async run() {
      const s = await Session.open(ACCOUNTS.admin);
      const attempts: Attempt[] = [
        expectStatus(await s.get('/api/me'), [200], '（前提）送る前に、ログインできているか'),
      ];

      const huge = JSON.stringify({ body: 'あ'.repeat(1_200_000) });
      const res = await s.post('/api/diaries', { body: huge });
      // 401 は「ログインしていない」であり、大きさを断ったことにはならない。成功に数えない。
      // 400 は入力の検証でも返るが、そのときの文言は「本文を入力してください」など別である。
      // 読み取りの失敗（大きさの上限）で断られたことまで見る
      const refusedForSize = (res.status === 400 || res.status === 413) && /読み取れません/.test(messageOf(res.json));
      attempts.push(
        judge(
          '1MB を超える本文は、本文の読み取りで断られるか',
          brief(res),
          refusedForSize,
          refusedForSize
            ? '本文を受け取る前に断っている'
            : '受け取ったか、401（ログインしていない）や入力の検証として断った',
        ),
        expectStatus(await s.get('/api/me'), [200], '大きな本文のあとでも、サーバは応答する'),
      );
      await s.close();
      return attempts;
    },
  },

  {
    id: 'output.no-secret-leak',
    title: '応答に、パスワードのハッシュを載せない',
    category: '出力',
    severity: '高',
    basis: '基本設計書「データ保護」(6-3)、「アカウント（m_account）」(5-2)',
    why: 'ハッシュが画面へ出ると、オフラインで解析されてパスワードを割られる',
    async run() {
      const s = await Session.open(ACCOUNTS.admin);
      const paths = ['/api/me', '/api/admin/accounts', '/api/admin/staff-accounts', '/api/admin/guardian-accounts', '/api/reference'];
      const attempts: Attempt[] = [];
      for (const path of paths) {
        const call = await s.get(path);
        const leaked = /password_hash|\$2[aby]\$/i.test(call.text);
        attempts.push(judge(`GET ${path}`, leaked ? `${call.status}（ハッシュらしき値が含まれる）` : String(call.status), !leaked));
      }
      await s.close();
      return attempts;
    },
  },

  {
    id: 'output.headers',
    title: '【記録】応答のヘッダーに、どんな守りが付いているか',
    category: '出力',
    severity: '記録',
    basis: '要件定義書「想定運用環境（HTTPS公開）」(6-1)、基本設計書「データ保護」(6-3)',
    why: 'この演習のサーバは画面を配信しないため、ヘッダーの有無は判定しない。本番の構成を決めるときの材料として残す',
    async run() {
      const s = await Session.open();
      const names = [
        'content-type',
        'x-content-type-options',
        'content-security-policy',
        'x-frame-options',
        'referrer-policy',
        'strict-transport-security',
        'cache-control',
      ];
      const show = (call: Call) => names.map((n) => `${n}=${call.headers[n] ?? '(なし)'}`).join(' / ');
      const api = await s.get('/api/terms');
      const page = await s.get('/');
      const attempts = [
        noted('API の応答', show(api)),
        noted('画面（index.html）の応答', show(page)),
        noted(
          '読み方',
          'localhost の演習では Secure も HSTS も付かない。HTTPS で公開するときに、何を付けるかを決める（要決定事項.md）',
        ),
      ];
      await s.close();
      return attempts;
    },
  },

  // ---- ここから下は、状態を変える試みを含む。前のプローブに響かせないよう最後に置く ----

  {
    id: 'session.tamper',
    title: 'セッション ID を改ざんした Cookie は通らない',
    category: 'セッション',
    severity: '高',
    basis: '要件定義書「セッションの保護」(8 No.9)、基本設計書「認証情報の保持方式」(6-3)',
    why: '推測・改ざんした ID を受け付けると、他人のセッションに成りすませる',
    async run() {
      const real = await Session.open(ACCOUNTS.admin);
      const original = (await real.cookies()).find((c) => c.name === 'sukusuku_session')?.value ?? '';
      // 端末の Cookie を持たない Session を使い、送る Cookie を自分で決める
      const s = await Session.open();
      const attempts: Attempt[] = [];

      if (original === '') {
        attempts.push(broken('セッション ID を取れるか', '(取れない)'));
      } else {
        // 1 文字だけ変える（長さと形は元のまま）
        const flipped = (original[0] === 'A' ? 'B' : 'A') + original.slice(1);
        attempts.push(
          expectStatus(await s.call('GET', '/api/me', { cookie: `sukusuku_session=${original}` }), [200], '（対照）元のセッション ID'),
          expectStatus(await s.call('GET', '/api/me', { cookie: `sukusuku_session=${flipped}` }), [401], '1 文字だけ変えたセッション ID'),
          expectStatus(await s.call('GET', '/api/me', { cookie: `sukusuku_session=${original.slice(0, -1)}` }), [401], '末尾を 1 文字削ったセッション ID'),
          expectStatus(await s.call('GET', '/api/me', { cookie: 'sukusuku_session=' }), [401], '空のセッション ID'),
        );
      }

      await real.close();
      await s.close();
      return attempts;
    },
  },

  {
    id: 'session.fixation',
    title: 'ログイン前に外から決めたセッション ID を、そのまま使わない',
    category: 'セッション',
    severity: '中',
    basis: '要件定義書「セッションの保護」(8 No.9)、基本設計書「認証情報の保持方式」(6-3)',
    why: '外から決めた ID をログイン後も使い続けると、攻撃者が用意した ID で成りすませる（セッション固定）',
    async run() {
      const known = 'sukusuku-fixation-check-0000000000000000';
      const s = await Session.open();
      const attempts: Attempt[] = [
        expectStatus(await s.call('GET', '/api/me', { cookie: `sukusuku_session=${known}` }), [401], 'ログイン前に、外から決めた ID を送る'),
      ];

      const login = await s.call('POST', '/api/login', {
        data: { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password, entrance: 'staff', remember: false },
        cookie: `sukusuku_session=${known}`,
      });
      attempts.push(expectStatus(login, [200], 'その ID を持ったままログインする'));

      const issued = /sukusuku_session=([^;]*)/.exec(login.headers['set-cookie'] ?? '')?.[1] ?? '';
      attempts.push(
        judge(
          'ログイン後は、別のセッション ID が配られるか',
          issued === '' ? '(Set-Cookie がない)' : `${issued.slice(0, 6)}…`,
          issued !== '' && issued !== known,
          '外から決めた ID を採用していないこと',
        ),
      );

      await s.close();
      return attempts;
    },
  },

  {
    id: 'csrf.origin-variants',
    title: '送信元の書き方に抜け道がない（null・別ポート・別ホスト）',
    category: 'CSRF',
    severity: '中',
    basis: '基本設計書「データ保護」(6-3)、server/csrf.go の sameOrigin',
    why: 'Origin の比べ方が緩いと、細工したページから状態を変える要求を通せてしまう',
    async run() {
      const s = await Session.open(ACCOUNTS.admin);
      const send = (origin: string | null, referer?: string | null) => s.post('/api/diaries', { data: {}, origin, referer });
      const control = await send(null);

      const attempts: Attempt[] = [
        expectStatus(await send('null'), [403], 'Origin: null（サンドボックスや file 由来）'),
        expectStatus(await send(`http://127.0.0.1:${PORT + 1}`), [403], `別のポート（${PORT + 1}）の Origin`),
        expectStatus(await send(`http://127.0.0.1:${PORT}.evil.example`), [403], 'ホスト名を装った別ホストの Origin'),
        expectStatus(await send(null, `http://127.0.0.1:${PORT + 1}/`), [403], 'Origin 無し ＋ 別ポートの Referer'),
        judge('（対照）正しい Origin は CSRF では止まらない', brief(control), control.status !== 403),
      ];

      /*
       * sameOrigin はホストとポート（u.Host）だけを比べるため、同じホスト:ポートならスキームが違っても通る。
       * ブラウザは Origin を偽れないので、いまの使われ方では攻撃にならない。設計で決めるなら要決定事項
       */
      const scheme = await send(`https://127.0.0.1:${PORT}`);
      attempts.push(
        noted(
          'http の宛先へ https の Origin（同じホスト・ポート）',
          brief(scheme),
          scheme.status === 403
            ? '止めている'
            : 'ホストとポートが同じなので通る。ブラウザは Origin を偽れないため、いまは攻撃にならない',
        ),
      );

      await s.close();
      return attempts;
    },
  },

  {
    id: 'output.error-leak',
    title: 'エラーの応答から、内部の作りが読み取れない',
    category: '出力',
    severity: '中',
    basis: '基本設計書「データ保護」(6-3)、server/httpx.go の writeErr',
    why: '問い合わせの文・ファイルの経路・スタックの断片が出ると、攻撃の足がかりになる',
    async run() {
      const s = await Session.open(ACCOUNTS.admin);
      const paths = [
        '/api/diaries/not-a-number',
        '/api/diaries/99999999999999999999',
        '/api/children/%00',
        '/api/does-not-exist',
        '/api/children/C001/%2e%2e',
      ];
      const marker = /SELECT\s|INSERT\s+INTO|sqlite|goroutine|panic:|\.go:\d/i;
      const attempts: Attempt[] = [];

      for (const path of paths) {
        const call = await s.get(path);
        const leaked = marker.test(call.text);
        attempts.push(
          judge(
            `GET ${path}`,
            leaked ? `${call.status}（内部の情報らしき文字列が含まれる）` : `${call.status} ${messageOf(call.json)}`.trim(),
            !leaked,
            leaked ? 'エラーの本文に、内部の作りが現れている' : undefined,
          ),
        );
      }

      attempts.push(expectStatus(await s.get('/api/me'), [200], '壊れた要求のあとでも、サーバは応答する'));
      await s.close();
      return attempts;
    },
  },

  {
    id: 'authz.write-scope',
    title: '書き込みも参照範囲に従う（担当外の園児に記録できない）',
    category: '認可',
    severity: '高',
    basis: '基本設計書「権限チェックの実装方針」(6-2)、要件定義書「参照範囲の全体規定」(4-1-5)、GitHub Issue #153',
    why: '参照は絞れていても登録・更新が絞れていないと、担当外の家庭の記録を作ったり書き換えたりできる',
    async run() {
      const admin = await Session.open(ACCOUNTS.admin);
      const all = ids(rowsOf((await admin.get('/api/children')).json));
      const s = await Session.open(ACCOUNTS.himawari);
      const mine = ids(rowsOf((await s.get('/api/children')).json));
      const outside = all.find((id) => !mine.includes(id));
      const on = day(0);
      const attempts: Attempt[] = [];

      if (!outside) {
        attempts.push(broken('担当外の園児を試せるか', '(デモデータに担当外の園児がない)'));
      } else {
        attempts.push(
          expectStatus(
            await s.post('/api/diaries', {
              data: { record_type: '1', child_id: outside, diary_date: on, body: '担当外の園児への下書き', status: '1' },
            }),
            [403],
            `担当外の園児（${outside}）の日誌を作成`,
          ),
          expectStatus(
            await s.post('/api/development/checks', {
              data: { child_id: outside, checked_on: on, results: [], note: '', status: '1' },
            }),
            [403],
            `担当外の園児（${outside}）の発達チェックを保存`,
          ),
        );

        // 日誌 ID を直接指定した書き換え（基本設計書 4-5。GitHub Issue #153 の攻撃）。
        // 入力の園児は自分の担当にして園児の範囲を通過させ、日誌 ID だけを担当外にする。
        // これで「日誌そのものの範囲」を見ているかどうかだけを試せる
        const listed = pageRows((await admin.get(`/api/diaries?from=${day(-365)}&to=${day(0)}`)).json);
        const foreign = listed.find((d) => typeof d.child_id === 'string' && !mine.includes(d.child_id as string));
        if (foreign && mine[0]) {
          attempts.push(
            expectStatus(
              await s.post('/api/diaries', {
                data: { diary_id: foreign.diary_id, record_type: '1', child_id: mine[0], diary_date: on, body: '書き換え', status: '1' },
              }),
              [403],
              `担当外の日誌（${foreign.diary_id}）を、日誌 ID を指定して書き換え`,
            ),
          );
        }
      }

      if (mine[0]) {
        attempts.push(
          expectStatus(
            await s.post('/api/diaries', {
              data: { record_type: '1', child_id: mine[0], diary_date: on, body: '担当の園児への下書き（確認用）', status: '1' },
            }),
            [200],
            `（対照）担当の園児（${mine[0]}）の下書きは作成できる`,
          ),
        );
      }

      await admin.close();
      await s.close();
      return attempts;
    },
  },

  {
    id: 'authz.link-removal',
    title: '保護者の紐づけを解除すると、その場で参照できなくなる',
    category: '認可',
    severity: '高',
    basis: '画面詳細図「保護者アカウント管理」(7-8 項目6)、基本設計書「データベース設計」の紐づけ（5-5）、GitHub Issue #159',
    why: '解除してもセッションが生きていると、卒園・退会した家庭の端末が、開いたまま記録を読めてしまう',
    async run() {
      const admin = await Session.open(ACCOUNTS.admin);
      const guardian = await Session.open(ACCOUNTS.guardian);
      const me = await guardian.me();
      const guardianId = String(me?.guardian_id ?? '');
      const childId = ids(rowsOf((await guardian.get('/api/children')).json))[0];
      const attempts: Attempt[] = [];

      if (!guardianId || !childId) {
        attempts.push(broken('解除を試せるか', `保護者 ID=${guardianId || '(なし)'} / 園児=${childId || '(なし)'}`));
        await admin.close();
        await guardian.close();
        return attempts;
      }

      const end = await admin.post('/api/admin/guardian-links/end', { data: { guardian_id: guardianId, child_id: childId } });
      attempts.push(expectStatus(end, [200], `管理者が、保護者の紐づけ（${childId}）を解除する`));
      attempts.push(expectStatus(await guardian.get('/api/children'), [401], '解除された保護者の、解除前からのセッションで園児の一覧'));
      const after = await guardian.me();
      attempts.push(judge('セッションが切れているか', String(after?.email ?? '(切れた)'), after === null));

      // 確かめたあと、紐づけを戻す（このあとのプローブに響かせない）
      const restore = await admin.post('/api/admin/guardian-links/restore', { data: { guardian_id: guardianId, child_id: childId } });
      attempts.push(expectStatus(restore, [200], '確かめたあと、紐づけを戻す'));

      let relogin: Call | null = null;
      try {
        const again = await Session.open(ACCOUNTS.guardian);
        relogin = await again.get('/api/children');
        await again.close();
      } catch {
        relogin = null;
      }
      attempts.push(
        judge('戻したあと、保護者はまたログインして自児の一覧を取れるか', relogin ? brief(relogin) : '(ログインできない)', relogin?.status === 200),
      );

      await admin.close();
      await guardian.close();
      return attempts;
    },
  },
];
