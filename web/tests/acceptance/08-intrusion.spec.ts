/*
 * シート 08 不正アクセス（異常系）
 *
 * 期待する結果は設計書（docs ブランチ）から書く。コードを読んで決めない（README.md「期待は設計書から」）。
 * ケースは テスト仕様書 第2.0版 のシート08（T6 が抽出した sheet-08.md）の 08-001〜08-037。
 *
 * 準備（sheet-08.md「このシートの前提の作り方」）は、サーバごとに1回だけ行う（prepare()）。
 * 同じ describe のテストは同じサーバを使う。落ちたあとはワーカーが立ち直り、サーバも新しいデータベースで立つので、
 * 準備は立ち直ったサーバで、もう一度行う。
 * 状態を変える要求には、ことわりの無いかぎり同じサイトの Origin を付ける（CSRF の拒否と区別するため）。
 */
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { ACCOUNTS, PHONE, evidence, expect, jstToday, login, passwordOf, serverInfo, test } from './harness';
import {
  adminApi,
  apiAs,
  apiLogin,
  classIdOf,
  createChild,
  currentTermsVersion,
  issueCode,
  issueStaff,
  loginWith,
  newApi,
  newWindow,
  origin,
  pngOf,
  sqlAll,
  sqlRun,
  type RequestFactory,
} from './01-common.helpers';

const EVIL = 'http://evil.example';

interface Person {
  email: string;
  password: string;
  entrance: 'staff' | 'guardian';
}

interface Prep {
  X: string;
  Y: string;
  Z: string;
  W: string;
  names: Record<'X' | 'Y' | 'Z' | 'W' | 'V', string>;
  codeV: string;
  GX: Person;
  GY: Person;
  GZ: Person;
  GW: Person;
  F: Person;
  T: Person & { accountId: number };
  sakura: number;
  himawari: number;
  R_X: number;
  R_Y: number;
  R_Z: number;
  R_W: number;
  E_Y: { id: number; updated_at: string };
  P_Y: number;
  H_X: { id: number; updated_at: string };
  H_Y: { id: number; updated_at: string };
  D_Y: number;
  withdrawnZ: boolean;
}

let prepared: { db: string; prep: Prep } | null = null;

async function json<T>(label: string, resP: Promise<APIResponse>): Promise<T> {
  const res = await resP;
  if (!res.ok()) throw new Error(`準備：${label} に失敗しました（${res.status()} ${await res.text()}）`);
  return (await res.json()) as T;
}

/** API の文脈（同じサイトの Origin つき）で、その人としてログインしたもの */
async function sessionOf(pw: RequestFactory, who: Person): Promise<APIRequestContext> {
  const api = await newApi(pw);
  await apiLogin(api, who.email, who.password, who.entrance);
  return api;
}

/** ログインしたセッションの Cookie だけを写した文脈（ヘッダは headers だけ。Origin を付けないときに使う） */
async function cloneSession(pw: RequestFactory, api: APIRequestContext, headers: Record<string, string>): Promise<APIRequestContext> {
  const state = await api.storageState();
  return pw.request.newContext({ baseURL: origin(), storageState: state, extraHTTPHeaders: headers });
}

/** 職員の初回ログイン（パスワードの変更と規約の同意）を API で済ませる */
async function firstLoginApi(pw: RequestFactory, email: string, temp: string, next: string) {
  const api = await newApi(pw);
  await apiLogin(api, email, temp, 'staff');
  await json('パスワードの変更', api.post('/api/password', { data: { current: temp, next } }));
  await json('規約の同意', api.post('/api/terms/agree', { data: {} }));
}

/** 準備（sheet-08.md「このシートの前提の作り方」1〜5）。サーバごとに1回 */
async function prepare(pw: RequestFactory, page: Page): Promise<Prep> {
  const db = serverInfo()?.dbPath ?? '';
  if (prepared?.db === db) return prepared.prep;
  const admin = await adminApi(pw);
  const names = { X: '受入 08 えっくす', Y: '受入 08 わい', Z: '受入 08 ぜっと', W: '受入 08 だぶりゅ', V: '受入 08 ぶい' };
  const ids = { X: 'C08X01', Y: 'C08Y01', Z: 'C08Z01', W: 'C08W01', V: 'C08V01' };
  // 1. 園児
  await createChild(admin, { id: ids.X, name: names.X });
  await createChild(admin, {
    id: ids.Y,
    name: names.Y,
    className: 'ひまわり組',
    allergies: [{ target_food: '受入08 たまご', symptom: '受入08 じんましん', response: '受入08 除去' }],
    medicalHistories: ['受入08 既往'],
  });
  await createChild(admin, { id: ids.Z, name: names.Z });
  await createChild(admin, { id: ids.W, name: names.W });
  await createChild(admin, { id: ids.V, name: names.V });
  // 2. 招待コードと保護者の登録（新規登録画面と同じ経路 POST /api/signup）
  const version = await currentTermsVersion(admin);
  const guardians: Record<'GX' | 'GY' | 'GZ' | 'GW', Person> = {
    GX: { email: 'g08x@example.jp', password: 'ukeire-08-pw', entrance: 'guardian' },
    GY: { email: 'g08y@example.jp', password: 'ukeire-08-pw', entrance: 'guardian' },
    GZ: { email: 'g08z@example.jp', password: 'ukeire-08-pw', entrance: 'guardian' },
    GW: { email: 'g08w@example.jp', password: 'ukeire-08-pw', entrance: 'guardian' },
  };
  for (const [key, child] of [['GX', 'X'], ['GY', 'Y'], ['GZ', 'Z'], ['GW', 'W']] as const) {
    const code = await issueCode(admin, ids[child]);
    const anon = await newApi(pw);
    await json(`${key} の新規登録`, anon.post('/api/signup', {
      data: { code, email: guardians[key].email, password: guardians[key].password, guardian_name: `受入 保護者 08 ${key}`, relationship: '母', terms_agreed: true, terms_version: version, phone_number1: '090-0000-0008' },
    }));
  }
  const codeV = await issueCode(admin, ids.V);
  // 3. 職員 F（フリー）・T（さくら組）
  const F: Person = { email: 's08f@hoiku.example.jp', password: 'ukeire-08f-pw', entrance: 'staff' };
  const T: Person = { email: 's08t@hoiku.example.jp', password: 'ukeire-08t-pw', entrance: 'staff' };
  const tempF = await issueStaff(admin, { id: 'S08F01', name: '受入 職員 08 F', email: F.email, className: null });
  const tempT = await issueStaff(admin, { id: 'S08T01', name: '受入 職員 08 T', email: T.email, className: 'さくら組' });
  await firstLoginApi(pw, F.email, tempF, F.password);
  await firstLoginApi(pw, T.email, tempT, T.password);
  // 4. 記録
  const suzuki = await apiAs(pw, 'staffSakura');
  const kubota = await apiAs(pw, 'staffHimawari');
  await json('X の排せつ', suzuki.post('/api/contact/events', { data: { items: [{ child_id: ids.X, event_type: '2', toilet_label: 'おしっこ' }] } }));
  const ey = await json<{ events: { contact_event_id: number; updated_at: string }[] }>('Y の排せつ', kubota.post('/api/contact/events', { data: { items: [{ child_id: ids.Y, event_type: '2', toilet_label: 'おしっこ' }] } }));
  const photo = await json<{ photo: { contact_photo_id: number } }>('Y の写真', kubota.post('/api/contact/photos', {
    multipart: { file: { name: 'ukeire08.png', mimeType: 'image/png', buffer: await pngOf(page) }, subject_child_ids: '', target_child_id: ids.Y, body: '' },
  }));
  const sakura = await classIdOf(admin, 'さくら組');
  const himawari = await classIdOf(admin, 'ひまわり組');
  const diary = await json<{ diary_id: number }>('ひまわり組のクラス日誌', kubota.post('/api/diaries', {
    data: { record_type: '2', class_id: himawari, child_id: null, diary_date: jstToday(), body: '受入08 クラス日誌', status: '1' },
  }));
  const home = async (who: Person, child: string, text: string) => {
    const api = await sessionOf(pw, who);
    return json<{ contact_home_id: number; updated_at: string }>(`${child} の家庭から`, api.put(`/api/contact/children/${child}/home`, {
      data: { temperature: null, night_sleep_from: null, night_sleep_to: null, breakfast: null, mood_label: null, pickup_type: null, pickup_person: null, pickup_time: null, message: text, updated_at: null },
    }));
  };
  const hx = await home(guardians.GX, ids.X, '受入08 家庭から X');
  const hy = await home(guardians.GY, ids.Y, '受入08 家庭から Y');
  // 5. ID
  const rooms = await json<{ room: { chat_room_id: number; room_type: string; room_name: string } }[]>('部屋の一覧', admin.get('/api/chat/rooms'));
  const roomOf = (name: string) => {
    const r = rooms.find((x) => x.room.room_type === '4' && x.room.room_name.startsWith(name));
    if (!r) throw new Error(`準備：${name} の個人チャットがありません`);
    return r.room.chat_room_id;
  };
  const staffList = await json<{ account: { account_id: number; email: string } }[]>('職員の一覧', admin.get('/api/admin/staff-accounts'));
  const tAccount = staffList.find((x) => x.account.email === T.email)!.account.account_id;
  const prep: Prep = {
    ...ids,
    names,
    codeV,
    ...guardians,
    F,
    T: { ...T, accountId: tAccount },
    sakura,
    himawari,
    R_X: roomOf(names.X),
    R_Y: roomOf(names.Y),
    R_Z: roomOf(names.Z),
    R_W: roomOf(names.W),
    E_Y: { id: ey.events[0].contact_event_id, updated_at: ey.events[0].updated_at },
    P_Y: photo.photo.contact_photo_id,
    H_X: { id: hx.contact_home_id, updated_at: hx.updated_at },
    H_Y: { id: hy.contact_home_id, updated_at: hy.updated_at },
    D_Y: diary.diary_id,
    withdrawnZ: false,
  };
  prepared = { db, prep };
  return prep;
}

/** 状態コードを並べて確かめる */
async function expectStatuses(api: APIRequestContext, calls: [string, string, unknown?][], want: number | ((s: number) => boolean), label: string) {
  for (const [method, path, data] of calls) {
    const res = await api.fetch(path, { method, ...(data === undefined ? {} : { data }) });
    const ok = typeof want === 'number' ? res.status() === want : want(res.status());
    expect.soft(ok, `${label}：${method} ${path} → ${res.status()} ${(await res.text()).slice(0, 120)}`).toBe(true);
  }
}

async function messageOf(res: APIResponse): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return body.message ?? '';
}

/** 管理者が見た、その園児のきょうの連絡帳（ContactPage の JSON の文字） */
async function contactPageText(pw: RequestFactory, child: string): Promise<string> {
  const admin = await adminApi(pw);
  return (await admin.get(`/api/contact/children/${child}`)).text();
}

// 職員・保護者の画面のアドレス（管理者・保護者で開いて控えたもの。2026-10-26 の下見）
const STAFF_SCREENS: [string, string][] = [
  ['職員ダッシュボード', '/staff'],
  ['連絡帳（クラス）画面', '/staff/contact'],
  ['日誌一覧画面', '/staff/diary'],
  ['午睡チェック画面', '/staff/nap'],
  ['園児一覧画面', '/staff/children'],
  ['操作ログ参照画面', '/staff/admin/logs'],
  ['設定画面', '/staff/admin/settings'],
];
const ADMIN_SCREENS: [string, string][] = [
  ['承認待ち一覧画面', '/staff/admin/approval'],
  ['CSV一括登録画面', '/staff/children/csv'],
  ['年度更新画面', '/staff/admin/fiscal-year'],
  ['職員アカウント管理画面', '/staff/admin/staff-accounts'],
  ['招待コード管理画面', '/staff/admin/invitations'],
  ['保護者アカウント管理画面', '/staff/admin/guardian-accounts'],
  ['操作ログ参照画面', '/staff/admin/logs'],
  ['誤送信対応記録画面', '/staff/admin/misdelivery'],
  ['設定画面', '/staff/admin/settings'],
  ['スケジュール設定画面', '/staff/growth/schedule'],
  ['共有範囲設定画面', '/staff/growth/share'],
];

test.describe('不正アクセス', () => {
  // ---------------- 未ログイン ----------------

  // 典拠：要件定義書「セキュリティ要求」(8 No.1)・同「アプリのログイン」(4-1-1)
  test('08-001 未ログインで職員の画面を開く', async ({ page }) => {
    for (const [name, path] of STAFF_SCREENS) {
      await page.goto(path);
      await expect.soft(page.getByRole('heading', { name: '職員用の入口' }), `${name}：職員用トップ`).toBeVisible();
      await expect.soft(page.getByLabel('ログインID', { exact: true }), `${name}：ログインの導線`).toBeVisible();
      await expect.soft(page.getByRole('main'), `${name}：実データを出さない`).not.toContainText(ACCOUNTS.guardian.children[0].name);
    }
    await evidence(page, '08-001');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.1)・同「アプリのログイン」(4-1-1)
  test('08-002 未ログインで保護者の画面を開く', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    await page.setViewportSize(PHONE);
    for (const path of ['/guardian', `/guardian/contact/${p.X}`, `/guardian/growth/${p.X}`, '/guardian/chat', '/guardian/handouts']) {
      await page.goto(path);
      await expect.soft(page.getByRole('heading', { name: '保護者用の入口' }), `${path}：保護者用トップ`).toBeVisible();
      await expect.soft(page.getByRole('main'), `${path}：実データを出さない`).not.toContainText(p.names.X);
    }
    await evidence(page, '08-002');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.1)・図/インタフェース一覧「エラーの返し方」(0-2)・同「権限の担保」(0-3)・同「知らせ（SSE）の形」(1-3)
  test('08-003 未ログインで読む API', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const anon = await newApi(playwright);
    for (const path of ['/api/me', '/api/reference', '/api/children', `/api/children/${p.X}`, `/api/contact/children/${p.X}`, `/api/contact/classes/${p.sakura}`, '/api/dashboard/staff', '/api/dashboard/guardian', '/api/diaries', '/api/chat/rooms', '/api/nap/state', '/api/admin/logs', '/api/settings', '/api/events', `/api/contact/photos/${p.P_Y}`]) {
      const res = await anon.get(path, { timeout: 10_000 });
      expect.soft(res.status(), `${path}`).toBe(401);
      expect.soft(await res.text(), `${path}：記録の中身を返さない`).not.toContain(p.names.X);
    }
    await page.goto('/staff-top');
    await evidence(page, '08-003');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.1)・図/インタフェース一覧「エラーの返し方」(0-2)
  test('08-004 未ログインで書く API', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const before = { x: await contactPageText(playwright, p.X), staff: sqlAll('SELECT COUNT(*) AS n FROM m_staff')[0].n, msgs: sqlAll('SELECT COUNT(*) AS n FROM t_chat_message WHERE chat_room_id = ?', p.R_Y)[0].n };
    const anon = await newApi(playwright);
    await expectStatuses(anon, [
      ['POST', '/api/contact/events', { items: [{ child_id: p.X, event_type: '2', toilet_label: 'おしっこ' }] }],
      ['PUT', `/api/contact/children/${p.X}/home`, { message: '受入 08-004', updated_at: null }],
      ['POST', `/api/chat/rooms/${p.R_Y}/messages`, { body: '受入 08-004' }],
      ['POST', '/api/password', { current: 'x', next: 'ukeire-08004-px' }],
      ['POST', '/api/admin/staff-accounts', { staff_id: 'S08004', staff_name: '受入 08-004', email: 's08004@hoiku.example.jp', role: '2', class_id: null }],
    ], 401, '① 401');
    expect.soft(await contactPageText(playwright, p.X), '② X の連絡帳が変わらない').toBe(before.x);
    expect.soft(sqlAll('SELECT COUNT(*) AS n FROM m_staff')[0].n, '② 職員の数').toBe(before.staff);
    expect.soft(sqlAll('SELECT COUNT(*) AS n FROM t_chat_message WHERE chat_room_id = ?', p.R_Y)[0].n, '② R_Y のメッセージ').toBe(before.msgs);
    await page.goto('/staff-top');
    await evidence(page, '08-004');
  });

  // 典拠：図/インタフェース一覧「経路の一覧」(1) の対象権限（未ログイン可）・詳細設計書「お子さまの追加」(4-15 (1))・図/画面詳細図「新規登録画面（保護者）」(2-3)
  test('08-005 未ログインでも呼べる経路', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const anon = await newApi(playwright);
    const terms = await anon.get('/api/terms');
    expect.soft(terms.status(), '① 規約の本文').toBe(200);
    // 同じ版の2つの文書（m_terms の document_type 1:利用規約 2:プライバシーポリシー。基本設計書「利用規約（m_terms）」(5-2)）
    const body0 = (await terms.json().catch(() => null)) as unknown;
    const docs = (Array.isArray(body0) ? body0 : [body0]).flatMap((d) => (d && typeof d === 'object' && 'documents' in d ? (d as { documents: unknown[] }).documents : [d])) as { document_type?: string; terms_version?: string }[];
    const types = docs.map((d) => d?.document_type).sort();
    expect.soft(types, '① 利用規約とプライバシーポリシーの2つ').toEqual(['1', '2']);
    expect.soft(new Set(docs.map((d) => d?.terms_version)).size, '① 同じ版').toBe(1);
    const verify = await anon.post('/api/invitation/verify', { data: { code: p.codeV } });
    expect.soft(verify.status(), '② 有効').toBe(200);
    const body = await verify.text();
    expect.soft(body, '② 園児名を返さない').not.toContain(p.names.V);
    expect.soft(body, '② 続柄を返さない').not.toContain('relationship');
    await page.goto('/signup');
    await evidence(page, '08-005');
  });

  // ---------------- 一般 ----------------

  // 典拠：要件定義書「セキュリティ要求」(8 No.2)・基本設計書「権限と利用可能機能」(6-1)・図/画面詳細図「職員（タブレット／PC）」(1-1) の注記・詳細設計書「本書で足す文言」(4-1 (6))
  test('08-006 一般で管理者だけの画面を開く', async ({ page }) => {
    await login(page, 'staffSakura');
    for (const [name, path] of ADMIN_SCREENS) {
      await page.goto(path);
      await page.waitForTimeout(500);
      await expect.soft(page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), `${name}：職員ダッシュボードへ戻る`).toBeVisible();
      await expect.soft(page.getByText('この画面は管理者だけが使えます。'), `${name}：その旨を出す`).toBeVisible();
      await expect.soft(page.getByRole('heading', { name: name.replace(/画面$/, '').replace(/管理$/, ''), level: 1 }), `${name}：中身を出さない`).toHaveCount(0);
    }
    await evidence(page, '08-006');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.2)・基本設計書「権限と利用可能機能」(6-1)・同「権限チェックの実装方針」(6-2)・図/インタフェース一覧「経路の一覧」(1)
  test('08-007 一般で管理者だけの API', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const suzuki = await apiAs(playwright, 'staffSakura');
    const count = (sql: string, ...args: (string | number)[]) => sqlAll(sql, ...args)[0].n;
    const before = {
      facility: sqlAll(`SELECT setting_value AS v FROM m_setting WHERE setting_key = 'facility.name'`)[0]?.v,
      staff: count('SELECT COUNT(*) AS n FROM m_staff'),
      codes: count('SELECT COUNT(*) AS n FROM t_invitation_code'),
      diary: sqlAll('SELECT status FROM t_diary WHERE diary_id = ?', p.D_Y)[0]?.status,
    };
    await expectStatuses(suzuki, [
      ['GET', '/api/admin/logs'],
      ['GET', '/api/settings'],
      ['POST', '/api/settings', { changes: { 'facility.name': '受入 08-007' }, read_at: '2026-01-01T00:00:00' }],
      ['GET', '/api/admin/staff-accounts'],
      ['POST', '/api/admin/staff-accounts', { staff_id: 'S08007', staff_name: '受入 08-007', email: 's08007@hoiku.example.jp', role: '2', class_id: null }],
      ['POST', `/api/admin/accounts/${p.T.accountId}/temp-password`, {}],
      ['POST', `/api/admin/accounts/${p.T.accountId}/unlock`, {}],
      ['POST', `/api/admin/accounts/${p.T.accountId}/status`, { status: '2' }],
      ['GET', '/api/admin/guardian-accounts'],
      ['POST', '/api/admin/guardian-links/end', { guardian_id: 'G-unknown', child_id: p.X }],
      ['GET', '/api/admin/invitations'],
      ['POST', '/api/admin/invitations', { child_id: p.X, valid_days: 7 }],
      ['POST', '/api/children', { child_id: 'C08007', child_name: '受入 08-007', child_name_kana: 'うけいれ', nickname: '', birth_date: '2024-04-01', sex: '9', normal_temperature: null, photo_consent_level: '2', class_id: p.sakura, allergies: [], medical_histories: [], mode: 'create' }],
      ['DELETE', `/api/children/${p.X}`],
      ['POST', `/api/children/${p.X}/withdraw`, { withdrawn_on: jstToday(), undo: false }],
      ['POST', '/api/children/csv/import', { text: '' }],
      ['GET', '/api/fiscal-year/preview'],
      ['GET', '/api/diaries/pending'],
      ['POST', `/api/diaries/${p.D_Y}/approve`, {}],
      ['GET', '/api/nap/report?format=csv'],
      ['POST', '/api/handouts', { title: '受入 08-007' }],
      ['POST', '/api/development/share-settings', {}],
      ['POST', '/api/classes', { fiscal_year: 2026, class_name: '受入 08-007', age_class: 1, staff_ids: [] }],
      ['POST', '/api/phrases', { phrase_scope: '1', body: '受入 08-007' }],
      ['GET', '/api/chat/misdelivery'],
    ], 403, '① 403');
    // ② 状態が変わらない
    expect.soft(sqlAll(`SELECT setting_value AS v FROM m_setting WHERE setting_key = 'facility.name'`)[0]?.v, '園の名前').toBe(before.facility);
    expect.soft(count('SELECT COUNT(*) AS n FROM m_staff'), '職員の数').toBe(before.staff);
    expect.soft(count('SELECT COUNT(*) AS n FROM t_invitation_code'), '招待コードの数').toBe(before.codes);
    expect.soft(sqlAll('SELECT status FROM t_diary WHERE diary_id = ?', p.D_Y)[0]?.status, 'D_Y の状態').toBe(before.diary);
    const x = sqlAll('SELECT enrollment_status AS s, is_deleted AS d FROM m_child WHERE child_id = ?', p.X)[0];
    expect.soft(x, 'X の在籍').toEqual({ s: '1', d: 0 });
    const t = await newApi(playwright);
    expect.soft((await t.post('/api/login', { data: { email: p.T.email, password: p.T.password, entrance: 'staff' } })).status(), 'T はいまのパスワードでログインできる').toBe(200);
    expect.soft(sqlAll(`SELECT link_status AS s FROM t_guardian_child gc JOIN m_guardian g ON g.guardian_id = gc.guardian_id JOIN m_account a ON a.account_id = g.account_id WHERE a.email = ? AND gc.child_id = ?`, p.GX.email, p.X)[0]?.s, 'GX と X の紐づけ').toBe('1');
    await page.goto('/staff-top');
    await evidence(page, '08-007');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.6)・同「参照範囲の全体規定」(4-1-5)・基本設計書「権限チェックの実装方針」(6-2)
  test('08-008 一般で担当外の園児の記録を読む', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const suzuki = await apiAs(playwright, 'staffSakura');
    await expectStatuses(suzuki, [
      ['GET', `/api/children/${p.Y}`],
      ['GET', `/api/children/${p.Y}/class`],
      ['GET', `/api/children/${p.Y}/medical-histories`],
      ['GET', `/api/contact/children/${p.Y}`],
      ['GET', `/api/contact/children/${p.Y}/month?month=${jstToday().slice(0, 7)}`],
      ['GET', `/api/children/${p.Y}/physical`],
      ['GET', `/api/children/${p.Y}/timeline`],
      ['GET', `/api/children/${p.Y}/diaries`],
      ['GET', `/api/children/${p.Y}/development/previous`],
      ['GET', `/api/contact/children/${p.Y}/diary-lines?date=${jstToday()}`],
    ], 403, '① 403');
    const list = await (await suzuki.get('/api/children')).text();
    expect.soft(list, '② 一覧に Y を含めない').not.toContain(p.Y);
    await page.goto('/staff-top');
    await evidence(page, '08-008');
  });

  // 典拠：図/インタフェース一覧「エラーの返し方」(0-2)・基本設計書「権限チェックの実装方針」(6-2)・詳細設計書「本書で足す文言」(4-1 (6))
  test('08-009 拒むときの文言（一般）', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const suzuki = await apiAs(playwright, 'staffSakura');
    const a1 = await messageOf(await suzuki.get(`/api/children/${p.Y}`));
    const b1 = await messageOf(await suzuki.get('/api/children/NOSUCH08'));
    expect.soft(a1, '① 園児の詳細：同じ文言').toBe(b1);
    const a2 = await messageOf(await suzuki.get(`/api/contact/children/${p.Y}`));
    const b2 = await messageOf(await suzuki.get('/api/contact/children/NOSUCH08'));
    expect.soft(a2, '② 連絡帳：同じ文言').toBe(b2);
    expect.soft(a2, '② 文言').toBe('この園児の連絡帳は開けません。');
    await page.goto('/staff-top');
    await evidence(page, '08-009');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.2・No.6)・同「参照範囲の全体規定」(4-1-5)・基本設計書「権限チェックの実装方針」(6-2) の書き込みの判定
  test('08-010 一般で担当外の園児の記録を書く', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const before = await contactPageText(playwright, p.Y);
    const suzuki = await apiAs(playwright, 'staffSakura');
    await expectStatuses(suzuki, [
      ['POST', '/api/contact/events', { items: [{ child_id: p.Y, event_type: '2', toilet_label: 'おしっこ' }] }],
      ['PUT', `/api/contact/children/${p.Y}/facility`, { body: '受入 08-010' }],
      ['POST', '/api/contact/class-notes', { class_id: p.himawari, body: '受入 08-010' }],
      ['POST', `/api/contact/events/${p.E_Y.id}/correct`, { toilet_label: 'うんち', updated_at: p.E_Y.updated_at }],
      ['POST', `/api/contact/events/${p.E_Y.id}/cancel`, {}],
      ['POST', `/api/contact/home/${p.H_Y.id}/confirm`, { updated_at: p.H_Y.updated_at }],
      ['POST', '/api/physical/records', { child_id: p.Y, measured_on: jstToday(), height: 80.1, weight: 10.25 }],
      ['POST', '/api/diaries', { record_type: '1', child_id: p.Y, class_id: p.himawari, diary_date: jstToday(), body: '受入 08-010', status: '1' }],
    ], 403, '① 403');
    expect.soft(await contactPageText(playwright, p.Y), '② Y の連絡帳が変わらない（記録・訂正・取り消し・確認しました）').toBe(before);
    expect.soft(sqlAll('SELECT COUNT(*) AS n FROM t_physical_record WHERE child_id = ?', p.Y)[0].n, '③ 身体測定が増えない').toBe(0);
    expect.soft(sqlAll(`SELECT COUNT(*) AS n FROM t_diary WHERE child_id = ? AND body LIKE '%08-010%'`, p.Y)[0].n, '③ 日誌が増えない').toBe(0);
    await page.goto('/staff-top');
    await evidence(page, '08-010');
  });

  // 典拠：基本設計書「権限と参照範囲の判定」(4-2)・同「権限チェックの実装方針」(6-2) の①・同「権限と利用可能機能」(6-1) ※1・※10
  test('08-011 一般で担当外のクラスの連絡帳と個人チャット', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const msgs = () => sqlAll('SELECT COUNT(*) AS n FROM t_chat_message WHERE chat_room_id = ?', p.R_Y)[0].n;
    const before = msgs();
    const suzuki = await apiAs(playwright, 'staffSakura');
    await expectStatuses(suzuki, [
      ['GET', `/api/contact/classes/${p.himawari}`],
      ['GET', `/api/chat/rooms/${p.R_Y}/messages`],
      ['POST', `/api/chat/rooms/${p.R_Y}/messages`, { body: '受入 08-011' }],
    ], 403, '① 403');
    const rooms = (await (await suzuki.get('/api/chat/rooms')).json()) as { room: { chat_room_id: number } }[];
    expect.soft(rooms.map((r) => r.room.chat_room_id), '② 一覧に R_Y を含めない').not.toContain(p.R_Y);
    expect.soft(msgs(), '③ R_Y のメッセージが増えない').toBe(before);
    await page.goto('/staff-top');
    await evidence(page, '08-011');
  });

  // 典拠：基本設計書「権限と参照範囲の判定」(4-2)（園児を持たない日誌は対象のクラス）・同「権限チェックの実装方針」(6-2)
  test('08-012 一般で担当外のクラスの日誌', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const suzuki = await apiAs(playwright, 'staffSakura');
    await expectStatuses(suzuki, [
      ['GET', `/api/diaries/${p.D_Y}`],
      ['POST', `/api/diaries/${p.D_Y}/lock`, {}],
    ], 403, '① 403');
    const list = await (await suzuki.get('/api/diaries')).text();
    expect.soft(list, '② 一覧に D_Y を含めない').not.toMatch(new RegExp(`"diary_id"\\s*:\\s*${p.D_Y}[,}]`));
    await page.goto('/staff-top');
    await evidence(page, '08-012');
  });

  // 典拠：要件定義書「参照範囲の全体規定」(4-1-5) の例外・同「園児マスターの管理」(4-1-3)・基本設計書「権限と参照範囲の判定」(4-2) の例外の表・同「権限と利用可能機能」(6-1) ○※2
  test('08-013 一般でもアレルギー一覧は全園児（例外）', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    await login(page, 'staffSakura');
    await page.goto('/staff/children/allergies');
    await expect.soft(page.getByRole('main'), '① 担当外の Y も出る').toContainText(p.names.Y);
    await expect.soft(page.getByRole('main'), '② 既往歴を出さない').not.toContainText('受入08 既往');
    await evidence(page, '08-013');
    const suzuki = await apiAs(playwright, 'staffSakura');
    const res = await suzuki.get('/api/children/allergies');
    expect.soft(res.status(), '① API').toBe(200);
    const text = await res.text();
    expect.soft(text, '① API に Y').toContain(p.Y);
    expect.soft(text, '② 既往歴を含めない').not.toContain('受入08 既往');
    const rows = JSON.parse(text) as unknown[];
    const y = JSON.stringify(rows.filter((r) => JSON.stringify(r).includes(p.Y)));
    expect.soft(y, '② 生年月日を含めない').not.toContain('birth_date');
  });

  // 典拠：要件定義書「クラスと担任の紐づけ」(4-1-2)・同「参照範囲の全体規定」(4-1-5) の例外・基本設計書「権限と参照範囲の判定」(4-2)・同「権限と利用可能機能」(6-1) ※1・同「権限チェックの実装方針」(6-2)・図/画面詳細図「職員（タブレット／PC）」(1-1) 項目3 と注記
  test('08-014 フリーの職員は全クラスを読める', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    await loginWith(page, 'staff', p.F.email, p.F.password);
    await expect.soft(page.getByRole('banner'), '① ヘッダに「フリー」').toContainText('フリー');
    await expect.soft(page.getByRole('main'), '① 全クラスを閲覧のみで見られる旨').toContainText(/全クラス/);
    await evidence(page, '08-014');
    const f = await sessionOf(playwright, p.F);
    for (const child of [p.X, p.Y]) expect.soft((await f.get(`/api/contact/children/${child}`)).status(), `② ${child} の連絡帳を読める`).toBe(200);
  });

  // 典拠：基本設計書「権限チェックの実装方針」(6-2) の書き込みの判定・同「権限と参照範囲の判定」(4-2) の処理 4
  test('08-015 フリーの職員は書けない', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const before = await contactPageText(playwright, p.X);
    const f = await sessionOf(playwright, p.F);
    await expectStatuses(f, [
      ['POST', '/api/contact/events', { items: [{ child_id: p.X, event_type: '2', toilet_label: 'おしっこ' }] }],
      ['PUT', `/api/contact/children/${p.X}/facility`, { body: '受入 08-015' }],
      ['POST', `/api/contact/home/${p.H_X.id}/confirm`, { updated_at: p.H_X.updated_at }],
    ], 403, '① 403');
    expect.soft(await contactPageText(playwright, p.X), '② X の連絡帳が変わらない').toBe(before);
    await page.goto('/staff-top');
    await evidence(page, '08-015');
  });

  // 典拠：基本設計書「権限と利用可能機能」(6-1)・図/インタフェース一覧「経路の一覧」(1) の対象権限（保護者）・詳細設計書「本書で足す文言」(4-1 (6))
  test('08-016 職員が保護者だけの経路を呼ぶ', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const before = await contactPageText(playwright, p.X);
    const suzuki = await apiAs(playwright, 'staffSakura');
    for (const [method, path, data] of [
      ['PUT', `/api/contact/children/${p.X}/home`, { message: '受入 08-016', updated_at: p.H_X.updated_at }],
      ['POST', '/api/guardian/contact', { phone_number1: '090-0000-0816' }],
      ['POST', '/api/guardian/children', { code: 'ZZZZ-9999-ZZZZ', relationship: '母' }],
      ['POST', `/api/guardian/children/${p.X}/ai-opt-out`, { opt_out: true }],
      ['GET', '/api/dashboard/guardian', undefined],
    ] as [string, string, unknown][]) {
      const res = await suzuki.fetch(path, { method, ...(data === undefined ? {} : { data }) });
      expect.soft(res.status(), `① ${method} ${path}`).toBe(403);
      expect.soft(await messageOf(res), `① ${method} ${path} の文言`).toBe('保護者のみが行えます');
    }
    expect.soft(await contactPageText(playwright, p.X), '② X の家庭からが変わらない').toBe(before);
    await page.goto('/staff-top');
    await evidence(page, '08-016');
  });

  // 典拠：基本設計書「アカウントの停止と再開」(4-3)・同「権限チェックの実装方針」(6-2) の SSE
  test('08-017 停止した職員のログイン中のセッション', async ({ browser, page, playwright }) => {
    const p = await prepare(playwright, page);
    await loginWith(page, 'staff', p.T.email, p.T.password);
    await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
    const a = await newWindow(browser);
    await loginWith(a.page, 'staff', ACCOUNTS.admin.email, passwordOf('admin'));
    await a.page.goto('/staff/admin/staff-accounts');
    await a.page.getByRole('row', { name: new RegExp(p.T.email) }).getByRole('button', { name: '停止' }).click();
    await a.page.getByRole('dialog').getByRole('button', { name: /停止する/ }).click();
    await expect(a.page.getByRole('row', { name: new RegExp(p.T.email) })).toContainText('停止');
    await a.context.close();
    await page.goto('/staff');
    await expect.soft(page.getByLabel('ログインID', { exact: true }), '① 読み込み直すと職員用トップ').toBeVisible();
    expect.soft((await page.request.get('/api/dashboard/staff')).status(), '② API は 401').toBe(401);
    await evidence(page, '08-017');
  });

  // ---------------- 保護者 ----------------

  // 典拠：要件定義書「セキュリティ要求」(8 No.2)・基本設計書「システムの利用方法」(2-2)
  test('08-018 保護者で職員の画面を開く', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    await page.setViewportSize(PHONE);
    await loginWith(page, 'guardian', p.GX.email, p.GX.password);
    for (const [name, path] of STAFF_SCREENS.filter(([n]) => ['職員ダッシュボード', '連絡帳（クラス）画面', '園児一覧画面', '操作ログ参照画面'].includes(n))) {
      await page.goto(path);
      await page.waitForTimeout(800);
      await expect.soft(page.getByRole('navigation', { name: '職員メニュー' }), `${name}：職員の画面を出さない`).toHaveCount(0);
      await expect.soft(page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), `${name}：職員ダッシュボードを出さない`).toHaveCount(0);
      await expect.soft(page.locator('body'), `${name}：ほかの園児のデータを出さない`).not.toContainText(p.names.Y);
    }
    await evidence(page, '08-018');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.2)・基本設計書「権限と利用可能機能」(6-1)・同「権限と参照範囲の判定」(4-2)・図/インタフェース一覧「権限の担保」(0-3)
  test('08-019 保護者で職員用の API', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const before = await contactPageText(playwright, p.X);
    const gx = await sessionOf(playwright, p.GX);
    await expectStatuses(gx, [
      ['GET', '/api/dashboard/staff'],
      ['GET', '/api/diaries'],
      ['GET', `/api/diaries/${p.D_Y}`],
      ['GET', `/api/children/${p.X}/timeline`],
      ['GET', `/api/children/${p.X}/diaries`],
      ['GET', '/api/children/allergies'],
      ['GET', `/api/children/${p.X}/allergies`],
      ['GET', `/api/children/${p.X}/medical-histories`],
      ['GET', `/api/children/${p.X}/physical`],
      ['GET', `/api/contact/classes/${p.sakura}`],
      ['GET', '/api/nap/state'],
      ['GET', '/api/nap/records'],
      ['GET', '/api/development/list'],
      ['GET', `/api/chat/rooms/${p.R_X}/members`],
      ['GET', '/api/phrases?scope=1'],
      ['POST', '/api/contact/events', { items: [{ child_id: p.X, event_type: '2', toilet_label: 'おしっこ' }] }],
      ['POST', `/api/contact/home/${p.H_X.id}/confirm`, { updated_at: p.H_X.updated_at }],
    ], 403, '① 403');
    expect.soft(await contactPageText(playwright, p.X), '② X の連絡帳が変わらない').toBe(before);
    await page.goto('/');
    await evidence(page, '08-019');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.6)・基本設計書「権限チェックの実装方針」(6-2) の②・図/インタフェース一覧「経路の一覧」(1)
  test('08-020 保護者で他児の記録を読む', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const gx = await sessionOf(playwright, p.GX);
    for (const path of [`/api/contact/children/${p.Y}`, `/api/contact/children/${p.Y}/month?month=${jstToday().slice(0, 7)}`, `/api/children/${p.Y}/growth`, `/api/children/${p.Y}`, `/api/children/${p.Y}/class`]) {
      const res = await gx.get(path);
      expect.soft(res.status(), path).toBe(403);
      expect.soft(await res.text(), `${path}：Y の記録を返さない`).not.toContain('受入08 家庭から Y');
    }
    await page.goto('/');
    await evidence(page, '08-020');
  });

  // 典拠：図/インタフェース一覧「エラーの返し方」(0-2)・基本設計書「権限チェックの実装方針」(6-2)・詳細設計書「本書で足す文言」(4-1 (6))
  test('08-021 拒むときの文言（保護者）', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const gx = await sessionOf(playwright, p.GX);
    const c1 = await messageOf(await gx.get(`/api/contact/children/${p.Y}`));
    const c2 = await messageOf(await gx.get('/api/contact/children/NOSUCH08'));
    expect.soft(c1, '① 連絡帳').toBe('この園児の連絡帳は開けません。');
    expect.soft(c2, '① 連絡帳（存在しない園児）').toBe('この園児の連絡帳は開けません。');
    const g1 = await messageOf(await gx.get(`/api/children/${p.Y}/growth`));
    const g2 = await messageOf(await gx.get('/api/children/NOSUCH08/growth'));
    expect.soft(g1, '② 成長の記録').toBe('この園児の成長の記録は開けません。');
    expect.soft(g2, '② 成長の記録（存在しない園児）').toBe('この園児の成長の記録は開けません。');
    await page.goto('/');
    await evidence(page, '08-021');
  });

  // 典拠：要件定義書「参照範囲の全体規定」(4-1-5)・基本設計書「権限チェックの実装方針」(6-2) の保護者の書き込み
  test('08-022 保護者で他児の「家庭から」を書く', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const gx = await sessionOf(playwright, p.GX);
    const res = await gx.put(`/api/contact/children/${p.Y}/home`, { data: { message: '受入 08-022', updated_at: p.H_Y.updated_at } });
    expect.soft(res.status(), '① 403').toBe(403);
    const y = await contactPageText(playwright, p.Y);
    expect.soft(y, '② H_Y の中身が変わらない').toContain('受入08 家庭から Y');
    expect.soft(y, '② 書かれていない').not.toContain('受入 08-022');
    await page.goto('/');
    await evidence(page, '08-022');
  });

  // 典拠：基本設計書「権限チェックの実装方針」(6-2)（写真の ID だけで配らない）・同「データ保護」(6-3)・詳細設計書「本書で足す文言」(4-1 (6))
  test('08-023 保護者で他児の写真の実体を開く', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const gx = await sessionOf(playwright, p.GX);
    const res = await gx.get(`/api/contact/photos/${p.P_Y}`);
    expect.soft(res.status(), '① GX は 403').toBe(403);
    expect.soft(await messageOf(res), '① 文言').toBe('この写真は開けません。');
    const gy = await sessionOf(playwright, p.GY);
    const ok = await gy.get(`/api/contact/photos/${p.P_Y}`);
    expect.soft(ok.status(), '② GY は受け取れる').toBe(200);
    expect.soft(ok.headers()['content-type'], '② 画像').toMatch(/^image\//);
    await page.goto('/');
    await evidence(page, '08-023');
  });

  // 典拠：基本設計書「権限と参照範囲の判定」(4-2)・同「権限チェックの実装方針」(6-2) の③
  test('08-024 保護者で他児の個人チャット', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const msgs = () => sqlAll('SELECT COUNT(*) AS n FROM t_chat_message WHERE chat_room_id = ?', p.R_Y)[0].n;
    const before = msgs();
    const gx = await sessionOf(playwright, p.GX);
    await expectStatuses(gx, [
      ['GET', `/api/chat/rooms/${p.R_Y}/messages`],
      ['POST', `/api/chat/rooms/${p.R_Y}/messages`, { body: '受入 08-024' }],
    ], 403, '① 403');
    const rooms = (await (await gx.get('/api/chat/rooms')).json()) as { room: { chat_room_id: number } }[];
    expect.soft(rooms.map((r) => r.room.chat_room_id), '② 一覧に R_Y を含めない').not.toContain(p.R_Y);
    expect.soft(msgs(), '③ メッセージが増えない').toBe(before);
    await page.goto('/');
    await evidence(page, '08-024');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.6)・基本設計書「権限チェックの実装方針」(6-2)・詳細設計書「本書で足す文言」(4-1 (6))
  test('08-025 画面のアドレスの園児を他児に替える', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    await page.setViewportSize(PHONE);
    await loginWith(page, 'guardian', p.GX.email, p.GX.password);
    await page.goto(`/guardian/contact/${p.X}`);
    test.skip(!new URL(page.url()).pathname.includes(p.X), 'アドレスに園児の ID が入っていない（このケースは当たらない）');
    await page.goto(`/guardian/contact/${p.Y}`);
    await page.waitForTimeout(1000);
    await expect.soft(page.getByText('この園児の連絡帳は開けません。'), 'Y の連絡帳を出さない旨').toBeVisible();
    await expect.soft(page.locator('body'), 'Y の記録を出さない').not.toContainText('受入08 家庭から Y');
    await expect.soft(page.locator('body'), 'Y の名前を出さない').not.toContainText(p.names.Y);
    await evidence(page, '08-025');
  });

  // 典拠：図/インタフェース一覧「経路の一覧」(1) の GET /api/children・基本設計書「権限と利用可能機能」(6-1)
  test('08-026 保護者に返す園児の一覧', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const gx = await sessionOf(playwright, p.GX);
    for (const path of ['/api/children', `/api/children?class_id=${p.himawari}`]) {
      const res = await gx.get(path);
      expect.soft(res.status(), path).toBe(200);
      const list = (await res.json().catch(() => [])) as Record<string, unknown>[];
      const ids = (Array.isArray(list) ? list : []).map((c) => String((c.child as { child_id?: string } | undefined)?.child_id ?? c.child_id));
      if (path === '/api/children') expect.soft(ids, `① ${path}：X だけ`).toEqual([p.X]);
      // クラスを指定しても広がらない（ひまわり組の Y などを返さない。返すのは X のうちの条件に合うものだけ）
      else expect.soft(ids.filter((id) => id !== p.X), `① ${path}：広がらない`).toEqual([]);
      const text = JSON.stringify(list);
      for (const key of ['allergies', 'medical_histories', 'photo_consent_level', 'normal_temperature']) expect.soft(text, `② ${path}：${key} を含めない`).not.toContain(`"${key}"`);
    }
    await page.goto('/');
    await evidence(page, '08-026');
  });

  // 典拠：図/インタフェース一覧「経路の一覧」(1) の GET /api/reference・詳細設計書「参照データの設定の返し方」(4-10 (7))
  test('08-027 保護者に返す参照データ', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const gx = await sessionOf(playwright, p.GX);
    const ref = await (await gx.get('/api/reference')).text();
    expect.soft(ref, '① 午睡の間隔を返さない').not.toContain('nap.interval');
    expect.soft(ref, '① 自動ログアウトの時間を返さない').not.toContain('ui.auto_logout_minutes');
    const classes = (await (await gx.get('/api/classes')).json().catch(() => [])) as { class_name?: string }[];
    expect.soft(classes.map((c) => c.class_name), '② 自児のクラスだけ').toEqual(['さくら組']);
    await page.goto('/');
    await evidence(page, '08-027');
  });

  /** きょうから n 日後（JST の YYYY-MM-DD） */
  function daysLater(n: number): string {
    const [y, m, d] = jstToday().split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  }

  /**
   * Z を退園にする（退園日＝きょう）。園児情報入力画面の「退園にする」と同じ経路（POST /api/children/{childID}/withdraw）で行い、
   * 経路が無いとき（404）は、画面で作れない状態として SQL で退園と保護者の猶予期間を作る
   * （基本設計書「園児（m_child）」(5-3) の在籍状態 2:退園、「クラスと紐づけ」(5-3) の link_status 3:猶予中・grace_ends_on、
   *   「設定マスタ」(5-9) の scope.guardian_grace_days 30日）。サーバごとに1回
   */
  async function withdrawZ(pw: RequestFactory, p: Prep) {
    if (p.withdrawnZ) return;
    const admin = await adminApi(pw);
    const res = await admin.post(`/api/children/${p.Z}/withdraw`, { data: { withdrawn_on: jstToday(), undo: false } });
    if (res.status() === 404) {
      sqlRun(`UPDATE m_child SET enrollment_status = '2', withdrawn_on = ? WHERE child_id = ?`, jstToday(), p.Z);
      sqlRun(`UPDATE t_guardian_child SET link_status = '3', grace_ends_on = ? WHERE child_id = ?`, daysLater(30), p.Z);
    } else if (!res.ok()) {
      throw new Error(`準備：Z の退園に失敗しました（${res.status()} ${await res.text()}）`);
    }
    p.withdrawnZ = true;
  }

  // 典拠：要件定義書「保護者アカウントの停止単位」(4-1-2)・基本設計書「権限と参照範囲の判定」(4-2)・同「権限と利用可能機能」(6-1) ※3・同「設定マスタ」(5-9)・図/画面詳細図「保護者ホーム」(2-7) 項目12
  test('08-028 猶予中の保護者は読める', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    await withdrawZ(playwright, p);
    await page.setViewportSize(PHONE);
    await loginWith(page, 'guardian', p.GZ.email, p.GZ.password);
    const [y, m, d] = jstToday().split('-').map(Number);
    const end = new Date(Date.UTC(y, m - 1, d + 30));
    const mm = end.getUTCMonth() + 1;
    const dd = end.getUTCDate();
    // 読める期限の書き方は設計書では例（「11月16日まで読めます」。図/画面詳細図「保護者ホーム」(2-7) 項目12）なので、日付が合えばよい
    const until = new RegExp(`(${mm}月${dd}日|${mm}/${dd})[^。]*まで読`);
    const region = page.getByRole('region', { name: `${p.names.Z}さんのきょう` });
    await expect.soft(region, '① 猶予期間にある旨と読める期限').toContainText(until);
    await expect.soft(region.getByRole('link', { name: '家庭からを書く' }), '① 「家庭からを書く」を出さない').toHaveCount(0);
    await evidence(page, '08-028');
    const gz = await sessionOf(playwright, p.GZ);
    expect.soft((await gz.get(`/api/contact/children/${p.Z}`)).status(), '② Z の連絡帳を読める').toBe(200);
  });

  // 典拠：基本設計書「権限チェックの実装方針」(6-2) の書き込みの判定・同「メッセージ一覧」(4-12)
  test('08-029 猶予中の保護者は書けない', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    await withdrawZ(playwright, p);
    const msgs = () => sqlAll('SELECT COUNT(*) AS n FROM t_chat_message WHERE chat_room_id = ?', p.R_Z)[0].n;
    const before = msgs();
    const gz = await sessionOf(playwright, p.GZ);
    const h = await gz.put(`/api/contact/children/${p.Z}/home`, { data: { message: '受入 08-029', updated_at: null } });
    expect.soft(h.status(), '① 家庭からは 403').toBe(403);
    expect.soft(await messageOf(h), '① 文言').toBe('卒園・退園したお子さまの連絡帳は、読むことだけができます。');
    const c = await gz.post(`/api/chat/rooms/${p.R_Z}/messages`, { data: { body: '受入 08-029' } });
    expect.soft(c.status(), '② チャットは 403').toBe(403);
    expect.soft(await messageOf(c), '② 文言').toBe('卒園・退園したお子さまのやりとりは、読むことだけができます。');
    expect.soft(await contactPageText(playwright, p.Z), '③ 家庭からが増えない').not.toContain('受入 08-029');
    expect.soft(msgs(), '③ メッセージが増えない').toBe(before);
    await page.goto('/');
    await evidence(page, '08-029');
  });

  // 典拠：基本設計書「紐づけの解除」(4-3)・図/画面詳細図「保護者アカウント管理画面」(7-8) 項目6
  test('08-030 紐づけを解除された保護者', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const gw = await sessionOf(playwright, p.GW);
    expect((await gw.get(`/api/contact/children/${p.W}`)).status(), '解除の前は読める').toBe(200);
    const admin = await adminApi(playwright);
    const list = (await (await admin.get('/api/admin/guardian-accounts')).json()) as { guardian: { guardian_id: string }; account: { email: string } }[];
    const guardianId = list.find((g) => g.account.email === p.GW.email)!.guardian.guardian_id;
    await json('紐づけの解除', admin.post('/api/admin/guardian-links/end', { data: { guardian_id: guardianId, child_id: p.W } }));
    const c = await gw.get(`/api/contact/children/${p.W}`);
    expect.soft(c.ok(), '連絡帳を読めない').toBe(false);
    expect.soft(await c.text(), 'データを返さない').not.toContain(p.names.W);
    const m = await gw.get(`/api/chat/rooms/${p.R_W}/messages`);
    expect.soft(m.ok(), '個人チャットを読めない').toBe(false);
    await page.goto('/');
    await evidence(page, '08-030');
  });

  // ---------------- CSRF ----------------

  // 典拠：要件定義書「セキュリティ要求」(8 No.10)・基本設計書「CSRF対策の方式」(6-3) の 1
  test('08-031 CSRF：SameSite', async ({ context, page, playwright }) => {
    const p = await prepare(playwright, page);
    await page.setViewportSize(PHONE);
    await loginWith(page, 'guardian', p.GX.email, p.GX.password);
    const cookies = (await context.cookies()).filter((c) => c.domain.includes('127.0.0.1'));
    expect(cookies.length, 'Cookie がある').toBeGreaterThan(0);
    for (const c of cookies) expect.soft(c.sameSite, `${c.name} に SameSite=Strict`).toBe('Strict');
    await evidence(page, '08-031');
  });

  /*
   * CSRF の確かめに使う状態を変える要求は、保護者 GX の個人チャット（R_X）への送信（POST）と、家庭から（PUT）にした。
   * sheet-08.md の前半で置いた連絡先の変更（POST /api/guardian/contact）は、いまの実装に経路が無く（404）、
   * 送信元による拒否と見分けられないため（case-fixes.md）
   */
  const countBody = (room: number, body: string) => Number(sqlAll('SELECT COUNT(*) AS n FROM t_chat_message WHERE chat_room_id = ? AND body = ?', room, body)[0].n);

  // 典拠：要件定義書「セキュリティ要求」(8 No.10)・基本設計書「CSRF対策の方式」(6-3) の 2・図/インタフェース一覧「共通の規定」(0-1)
  test('08-032 CSRF：送信元が別のサイト', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const before = { x: await contactPageText(playwright, p.X), facility: sqlAll(`SELECT setting_value AS v FROM m_setting WHERE setting_key = 'facility.name'`)[0]?.v };
    const gx = await sessionOf(playwright, p.GX);
    const suzuki = await apiAs(playwright, 'staffSakura');
    const admin = await adminApi(playwright);
    const evil = { Origin: EVIL };
    const calls: [APIRequestContext, string, string, unknown][] = [
      [gx, 'POST', `/api/chat/rooms/${p.R_X}/messages`, { body: '受入 08-032' }],
      [gx, 'PUT', `/api/contact/children/${p.X}/home`, { message: '受入 08-032', updated_at: p.H_X.updated_at }],
      [suzuki, 'POST', '/api/contact/events', { items: [{ child_id: p.X, event_type: '2', toilet_label: 'おしっこ' }] }],
      [admin, 'POST', '/api/settings', { changes: { 'facility.name': '受入 08-032' }, read_at: '2026-01-01T00:00:00' }],
      [gx, 'POST', '/api/logout', {}],
    ];
    for (const [api, method, path, data] of calls) {
      const res = await api.fetch(path, { method, data, headers: evil });
      expect.soft(res.ok(), `① ${method} ${path} を拒否する（${res.status()}）`).toBe(false);
      expect.soft(res.status(), `① ${method} ${path}：経路はある`).not.toBe(404);
    }
    expect.soft(countBody(p.R_X, '受入 08-032'), '② 個人チャットに増えない').toBe(0);
    expect.soft(await contactPageText(playwright, p.X), '② X の連絡帳（家庭から・出来事）').toBe(before.x);
    expect.soft(sqlAll(`SELECT setting_value AS v FROM m_setting WHERE setting_key = 'facility.name'`)[0]?.v, '② 園の名前').toBe(before.facility);
    expect.soft((await gx.get('/api/me')).status(), '② GX はログインしたまま').toBe(200);
    await page.goto('/');
    await evidence(page, '08-032');
  });

  // 典拠：基本設計書「CSRF対策の方式」(6-3)（どちらも無ければ拒否する）
  test('08-033 CSRF：Origin も Referer も無い', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const bare = await cloneSession(playwright, await sessionOf(playwright, p.GX), {});
    const res = await bare.post(`/api/chat/rooms/${p.R_X}/messages`, { data: { body: '受入 08-033' } });
    expect.soft(res.ok(), `① 拒否する（${res.status()}）`).toBe(false);
    expect.soft(countBody(p.R_X, '受入 08-033'), '② 増えない').toBe(0);
    await page.goto('/');
    await evidence(page, '08-033');
  });

  // 典拠：基本設計書「CSRF対策の方式」(6-3)（Origin が無い要求は Referer で代替する）
  test('08-034 CSRF：Origin が無く、Referer が別のサイト', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const ref = await cloneSession(playwright, await sessionOf(playwright, p.GX), { Referer: `${EVIL}/page` });
    const res = await ref.post(`/api/chat/rooms/${p.R_X}/messages`, { data: { body: '受入 08-034' } });
    expect.soft(res.ok(), `① 拒否する（${res.status()}）`).toBe(false);
    expect.soft(countBody(p.R_X, '受入 08-034'), '② 増えない').toBe(0);
    await page.goto('/');
    await evidence(page, '08-034');
  });

  // 典拠：基本設計書「CSRF対策の方式」(6-3)
  test('08-035 CSRF：Origin が無く、Referer が同じサイト', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const ref = await cloneSession(playwright, await sessionOf(playwright, p.GX), { Referer: `${origin()}/` });
    const res = await ref.post(`/api/chat/rooms/${p.R_X}/messages`, { data: { body: '受入 08-035' } });
    expect.soft(res.ok(), `① 通る（${res.status()} ${(await res.text()).slice(0, 120)}）`).toBe(true);
    expect.soft(countBody(p.R_X, '受入 08-035'), '② 1件送られる').toBe(1);
    await page.goto('/');
    await evidence(page, '08-035');
  });

  // 典拠：基本設計書「CSRF対策の方式」(6-3)
  test('08-036 CSRF：Origin が同じサイト（対照）', async ({ page, playwright }) => {
    const p = await prepare(playwright, page);
    const gx = await sessionOf(playwright, p.GX);
    const res = await gx.post(`/api/chat/rooms/${p.R_X}/messages`, { data: { body: '受入 08-036' } });
    expect.soft(res.ok(), `① 通る（${res.status()} ${(await res.text()).slice(0, 120)}）`).toBe(true);
    expect.soft(countBody(p.R_X, '受入 08-036'), '② 1件送られる').toBe(1);
    await page.setViewportSize(PHONE);
    await loginWith(page, 'guardian', p.GX.email, p.GX.password);
    await page.goto('/guardian/chat');
    await page.waitForTimeout(800);
    await evidence(page, '08-036');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.10)・基本設計書「CSRF対策の方式」(6-3)（二段構え）
  test('08-037 CSRF：別のサイトのページから送らせる', async ({ browser, page, playwright }) => {
    const p = await prepare(playwright, page);
    const w = await newWindow(browser, { viewport: PHONE });
    await loginWith(w.page, 'guardian', p.GX.email, p.GX.password);
    const target = `${origin()}/api/chat/rooms/${p.R_X}/messages`;
    // 別のサイトのページ。外へは出さず、テストが中身を返す（ページの route は文脈の route より先に効く）
    await w.page.route(`${EVIL}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><title>別のサイト</title>
<form id="f" method="POST" action="${target}" enctype="text/plain"><input name='{"body":"受入 08-037","x":"' value='"}'></form>
<script>
fetch(${JSON.stringify(target)}, { method: 'POST', credentials: 'include', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ body: '受入 08-037' }) }).finally(() => document.getElementById('f').submit());
</script>`,
      }),
    );
    await w.page.goto(`${EVIL}/`);
    await w.page.waitForTimeout(2500);
    expect.soft(countBody(p.R_X, '受入 08-037'), '個人チャットに送られない（フォームと fetch のどちらも）').toBe(0);
    await evidence(w.page, '08-037');
    await w.context.close();
  });
});

