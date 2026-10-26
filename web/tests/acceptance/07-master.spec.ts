/*
 * シート07 園児マスター・アカウント・運用（年度更新・操作ログ・設定）。テスト仕様書 兼 成績書（第2.0版）
 *
 * 期待する結果はシート07（T12a）の「確認事項」を、設計書（docs ブランチ dbf5da91）から書いたもの。コードからは書かない。
 * 部品は設計書の表示名で探す。表示名で見つからなければ NG の候補（README.md「期待は設計書から」）。
 *
 * サーバの分け方（シート07「サーバの分け方」）
 *   - A（通常）：describe ごとに使い捨ての DB。ケースは自分で作ったデータで確かめる
 *   - B（設定）：設定を変えるケースを1つの describe に集める（設定は園全体に効く）
 *   - D（ログインの失敗）：1つのアカウントを5回続けて失敗させる
 *   - 【使い捨て】：年度更新。テストごとに DB を作り直す（serverScope: 'test'）
 *
 * 【12-1】（図/画面詳細図「モックアップでは実装しないもの」(12-1)）と【次の版】（詳細設計書「本版で詳しくする範囲」(1-2)）は、
 * まず回し、画面に機能が無ければ test.skip（未実施・実装対象の外）、あれば設計書の期待で OK か NG（rules.md）。
 */
import { readFileSync } from 'node:fs';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { ACCOUNTS, PHONE, evidence, expect, jstToday, login, passwordOf, test } from './harness';
import {
  accountIdOf,
  addDays,
  apiAs,
  collectNativeDialogs,
  columnNames,
  dataRows,
  enrolledCount,
  esc,
  hasColumn,
  issueCode,
  jstDateTime,
  logBorder,
  loginError,
  loginWith,
  logoutStaff,
  logsAfter,
  mainOf,
  makeChild,
  makeGuardian,
  makeStaffIssued,
  makeStaffReady,
  newWindow,
  pageApi,
  ok,
  printCount,
  recordEvent,
  sampleValue,
  sideNav,
  slash,
  sqlAll,
  sqlRun,
  sqlValue,
  staffFirstLogin,
  stubPrint,
  toShiftJis,
  watchAlerts,
  type RequestFactory,
} from './07-master.helpers';

// ---- 文言（基本設計書「メッセージ一覧」(4-12)、詳細設計書「本書で足す文言」(4-1 (6)) ほか） ----
const MSG = {
  required: '入力が必要な項目が未入力です。',
  birthFuture: '生年月日に未来の日付は指定できません。',
  birthFormat: '生年月日の形式が正しくありません。',
  cancelNo: '記録または保護者が紐づいている園児は取り消せません。在籍状態を変更してください。',
  csvClass: 'クラス名が登録されていません。該当する行を確認してください。',
  csvSex: '性別が空欄です。「男」「女」「未回答」のいずれかを入れてください。',
  emailDup: 'このメールアドレスは既に登録されています。',
  credential: 'IDまたはパスワードが違います。',
  suspended: 'このアカウントは使えません。園へご連絡ください。',
  locked: 'ログインを一定時間受け付けません。しばらく待つか、管理者へご連絡ください。',
  revoked: 'この招待コードは失効しています。園に新しい招待コードの発行をご依頼ください',
  conflict: 'ほかの管理者が設定を変えました。読み直してから変えてください。',
  aiPolicy: 'プライバシーポリシーに外部の AI へ送ることを書いた版を施行してから有効にしてください',
  aiLimit: '1日の上限回数は1〜10000の整数で入力してください。',
  phraseLong: '定型文は100文字以内で入力してください。',
  classDup: '同じ年度に同じ名前のクラスがあります。',
  longInterval: '既定より長い間隔です。東京都の通知（平成30年）は、0歳児は5分に1回、1〜2歳児は10分に1回を望ましい間隔としています。',
  saved: '保存しました。',
  phraseDelete: 'この定型文を消しますか。候補に出なくなります。これまでに入れた文は変わりません。',
  templateDelete: 'この雛形を消しますか。呼び出しの一覧に出なくなります。これまでの日誌は変わりません。',
  childRegistered: (name: string) => `登録しました。${name}さんの個人チャットも用意しました。`,
  csvRegistered: (n: number) => `${n}名を登録し、個人チャットを用意しました。`,
} as const;

/** 未実施の理由（rules.md「次の版の機能」「12-1」） */
const OUT_121 = '実装対象の外（画面詳細図「モックアップでは実装しないもの」(12-1)）';
const OUT_NEXT = '実装対象の外（詳細設計書「本版で詳しくする範囲」(1-2) で次の版。画面に機能が無い）';

const XSS_SCRIPT = '<script>alert(1)</script>';
const XSS_IMG = '"><img src=x onerror=alert(1)>';

// ---- 画面の手助け（このシートだけ） ----

/** 値が want になるまで待つ（最大 5 秒）。なったか・最後の値を返す */
async function waitFor<T>(read: () => Promise<T>, want: T, timeoutMs = 5_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let v = await read();
  while (v !== want && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    v = await read();
  }
  return v;
}

async function adminApi(pw: RequestFactory): Promise<APIRequestContext> {
  return apiAs(pw, 'admin');
}

/** 職員メニューから画面を開き、その画面へ移るまで待つ */
async function goNav(page: Page, navName: string) {
  const link = sideNav(page).getByRole('link', { name: navName, exact: true });
  const href = await link.getAttribute('href');
  await link.click();
  if (href) await page.waitForURL((u) => u.pathname === href, { timeout: 15_000 });
  await expect(mainOf(page).getByRole('heading', { level: 1 })).toBeVisible();
}

/** ログインして、職員メニューから画面を開く */
async function openAs(page: Page, who: 'admin' | 'admin2' | 'staffSakura' | 'staffHimawari', navName: string) {
  await login(page, who);
  await goNav(page, navName);
}

/** 園児一覧画面で、氏名で絞り込む */
async function filterChildren(page: Page, text: string) {
  await mainOf(page).getByRole('searchbox', { name: '氏名' }).fill(text);
  await mainOf(page).getByRole('button', { name: '絞り込む' }).click();
}

/** 園児一覧画面の、その氏名の行（exact：氏名のセルがその文字と同じ行。偽なら部分一致） */
function childRow(page: Page, name: string, exact = true): Locator {
  const rows = dataRows(page);
  return exact ? rows.filter({ has: page.getByRole('cell', { name, exact: true }) }) : rows.filter({ hasText: name });
}

/** 園児情報入力画面の部品（図/画面詳細図「園児情報入力画面／園児情報確認画面」(7-2)） */
function childForm(page: Page) {
  const m = mainOf(page);
  return {
    id: m.getByRole('textbox', { name: /^園児ID/ }),
    name: m.getByRole('textbox', { name: /^氏名/ }),
    kana: m.getByRole('textbox', { name: /^よみ/ }),
    nickname: m.getByRole('group', { name: '呼び名' }).getByRole('textbox'),
    birth: m.getByRole('textbox', { name: /^生年月日/ }),
    sex: (label: '男' | '女' | '未回答') => m.getByRole('radio', { name: label, exact: true }),
    className: m.getByRole('combobox', { name: /^クラス/ }),
    temperature: m.getByRole('spinbutton', { name: /平熱/ }),
    consent: m.getByRole('combobox', { name: /^写真の利用同意/ }),
    addAllergy: m.getByRole('button', { name: /アレルギーを追加/ }),
    addHistory: m.getByRole('button', { name: /既往歴を追加/ }),
    target: m.getByRole('textbox', { name: '対象', exact: true }),
    symptom: m.getByRole('textbox', { name: '症状', exact: true }),
    response: m.getByRole('textbox', { name: '対応', exact: true }),
    toConfirm: m.getByRole('button', { name: '確認へ進む' }),
    cancel: m.getByRole('button', { name: 'やめる' }),
  };
}

/** 園児一覧画面の「新規登録」から入力画面を開く */
async function openNewChild(page: Page) {
  await mainOf(page).getByRole('link', { name: '新規登録' }).click();
  await expect(childForm(page).toConfirm).toBeVisible();
}

/** 入力画面で最小の値を入れる */
async function fillChildBasics(page: Page, v: { name: string; kana?: string; birth?: string; className?: string }) {
  const f = childForm(page);
  await f.name.fill(v.name);
  await f.kana.fill(v.kana ?? 'うけいれ');
  await f.birth.fill(v.birth ?? '2024-04-01');
  await f.sex('未回答').check();
  if (v.className) await f.className.selectOption({ label: v.className });
}

/** 確認画面へ進み、登録する（編集なら更新する） */
async function confirmAndSave(page: Page) {
  await childForm(page).toConfirm.click();
  const save = mainOf(page).getByRole('button', { name: /^(登録する|更新する)$/ });
  await expect(save).toBeVisible();
  await save.click();
  await page.waitForURL((u) => u.pathname === '/staff/children', { timeout: 15_000 });
}

/** 職員アカウント管理画面の、そのログインIDの行 */
function staffRow(page: Page, email: string): Locator {
  return mainOf(page).getByRole('row', { name: new RegExp(esc(email)) });
}

/** 画面から出た一時パスワード（「〇〇 さん：」に続く値）。読めなければ null */
async function shownTempPassword(page: Page, name: string): Promise<string | null> {
  const item = page.getByRole('status').getByRole('listitem').filter({ hasText: name });
  if ((await item.count()) === 0) return null;
  const strong = item.first().locator('strong, code, kbd, samp');
  if (await strong.count()) return (await strong.first().innerText()).trim();
  const m = /さん[：:]\s*(\S+)/.exec(await item.first().innerText());
  return m ? m[1] : null;
}

/** 職員アカウント管理画面の「＋ アカウントを発行」で発行する。一時パスワードを返す（読めなければ null） */
async function issueStaffOnScreen(page: Page, v: { name: string; email: string; role?: string; className?: string | 'free' }) {
  await mainOf(page).getByRole('button', { name: /アカウントを発行/ }).click();
  const d = page.getByRole('dialog', { name: /職員アカウントの発行/ });
  await d.getByRole('textbox', { name: /^氏名/ }).fill(v.name);
  await d.getByRole('textbox', { name: /^ログインID/ }).fill(v.email);
  if (v.role) await d.getByRole('combobox', { name: /^ロール/ }).selectOption({ label: v.role });
  if (v.className === 'free') await d.getByRole('combobox', { name: /^担当クラス/ }).selectOption({ index: 0 });
  else if (v.className) await d.getByRole('combobox', { name: /^担当クラス/ }).selectOption({ label: v.className });
  await d.getByRole('button', { name: '発行する' }).click();
  await expect(d).toHaveCount(0, { timeout: 15_000 });
  return shownTempPassword(page, v.name);
}

/** 保護者アカウント管理画面の、そのログインIDの行 */
function guardianRow(page: Page, email: string): Locator {
  return mainOf(page).getByRole('row', { name: new RegExp(esc(email)) });
}

/** 設定画面の区分（タブ・見出し・区画のどれでも） */
function settingsSection(page: Page, name: string | RegExp): Locator {
  const m = mainOf(page);
  return m.getByRole('tab', { name }).or(m.getByRole('region', { name })).or(m.getByRole('heading', { name, level: 2 }));
}

/** 設定画面の「そのほかの設定値」の、その説明（名前）の欄 */
function otherSettingField(page: Page, label: RegExp): Locator {
  const m = mainOf(page);
  return m.getByRole('spinbutton', { name: label }).or(m.getByRole('textbox', { name: label }));
}

async function openSettings(page: Page) {
  await goNav(page, '設定');
  await expect(mainOf(page).getByRole('heading', { name: '設定', level: 1 })).toBeVisible();
}

/** 設定の値（m_setting） */
function settingValue(key: string): string | undefined {
  const v = sqlValue('SELECT setting_value FROM m_setting WHERE setting_key = ?', key);
  return v === undefined ? undefined : String(v);
}

/** 設定画面の「保存する」→ 確認のダイアログの「保存する」 */
async function saveSettings(page: Page, region?: Locator) {
  await (region ?? mainOf(page)).getByRole('button', { name: '保存する' }).first().click();
  const d = page.getByRole('dialog', { name: /保存/ });
  if (await d.count()) {
    await d.getByRole('button', { name: '保存する' }).click();
  }
}

/** 操作ログ参照画面（図/画面詳細図「操作ログ参照画面（管理者）」(7-9)） */
function logScreen(page: Page) {
  const m = mainOf(page);
  return {
    from: m.getByRole('textbox', { name: '期間（開始）' }),
    to: m.getByRole('textbox', { name: '期間（終了）' }),
    operator: m.getByRole('combobox', { name: '操作者' }),
    func: m.getByRole('combobox', { name: '対象機能' }),
    child: m.getByRole('combobox', { name: '対象園児' }),
    filter: m.getByRole('button', { name: '絞り込む' }),
    csv: m.getByRole('button', { name: 'CSV出力' }),
    list: m.getByRole('region', { name: '操作ログの一覧' }).or(m),
  };
}

/** 操作ログの、その条件の件数（(R13)） */
function logCount(where: string, ...params: (string | number)[]): number {
  return Number(sqlValue(`SELECT COUNT(*) FROM t_operation_log WHERE ${where}`, ...params) ?? 0);
}

// =====================================================================
// 園児一覧画面・園児情報入力画面・園児情報確認画面（サーバA）
// =====================================================================

test.describe('園児一覧画面・園児情報入力画面（サーバA）', () => {
  /* 典拠：図/画面詳細図「園児一覧画面」(7-1) 項目1〜6・8、基本設計書「一覧表示とページング」(3-7)・「園児情報の登録・編集」(4-4) */
  test('07-001 管理者の園児一覧', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    await makeChild(api, '07-001', { kana: 'うけいれななぜろいち' });
    await openAs(page, 'admin', '園児');
    const m = mainOf(page);
    const cls = m.getByRole('combobox', { name: 'クラス', exact: true });
    await expect.soft(cls.locator('option:checked'), '①クラスの初期値が「すべて」').toHaveText('すべて');
    expect.soft(await columnNames(page), '②列').toEqual(['氏名', 'よみ', '生年月日', '月齢', 'クラス', 'アレルギー', '操作']);
    for (const name of ['新規登録', 'CSV一括登録', 'アレルギー一覧']) {
      await expect.soft(m.getByRole('link', { name }).or(m.getByRole('button', { name })), `③「${name}」`).toBeVisible();
    }
    await expect.soft(dataRows(page), '④ページングせず、在籍の園児が全員1画面に出る').toHaveCount(enrolledCount());
    await filterChildren(page, '07-001');
    await expect.soft(dataRows(page), '⑤氏名の部分一致で1行').toHaveCount(1);
    await expect.soft(dataRows(page).first()).toContainText('受入 07-001');
    await filterChildren(page, 'ななぜろいち');
    await expect.soft(dataRows(page), '⑥よみの部分一致で1行').toHaveCount(1);
    await expect.soft(dataRows(page).first()).toContainText('受入 07-001');
    await m.getByRole('searchbox', { name: '氏名' }).fill('');
    await cls.selectOption({ label: 'ひまわり組' });
    await m.getByRole('button', { name: '絞り込む' }).click();
    await expect.soft(dataRows(page), '⑦ひまわり組の園児だけ').toHaveCount(enrolledCount('ひまわり組'));
    const classes = (await dataRows(page).getByRole('cell').nth(4).allInnerTexts()).map((t) => t.trim());
    expect.soft(classes.every((c) => c === 'ひまわり組'), `⑦クラスの列：${classes.join('・')}`).toBe(true);
    await evidence(page, '07-001');
  });

  /* 典拠：図/画面詳細図「職員（タブレット／PC）」(1-1) 項目5・「全画面に共通する規定」(0-2)・「園児一覧画面」(7-1) 項目1・4・5・7・10・11、詳細設計書「保護者のメニュー」(2-15 (1))、基本設計書「権限と利用可能機能」(6-1) */
  test('07-002 一般・保護者の画面に管理者だけの導線が無い', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    const nav = sideNav(page);
    await expect.soft(nav.getByText('管理（管理者）'), '①見出し「管理（管理者）」が無い').toHaveCount(0);
    for (const name of ['承認待ち', '職員アカウント', '招待コード', '保護者アカウント', '年度更新', '操作ログ', '誤送信対応', '設定']) {
      await expect.soft(nav.getByRole('link', { name, exact: true }), `①サイドナビに「${name}」が無い`).toHaveCount(0);
    }
    await nav.getByRole('link', { name: '園児', exact: true }).click();
    const m = mainOf(page);
    const cls = m.getByRole('combobox', { name: 'クラス', exact: true });
    await expect.soft(cls.locator('option:checked'), '②自クラス').toHaveText('さくら組');
    const switchable = (await cls.isEnabled()) && (await cls.locator('option').count()) > 1;
    expect.soft(switchable, '②ほかのクラスへ切り替えられない').toBe(false);
    for (const name of ['新規登録', 'CSV一括登録', '編集', '取消']) {
      await expect.soft(m.getByRole('link', { name, exact: true }).or(m.getByRole('button', { name, exact: true })), `③「${name}」が無い`).toHaveCount(0);
    }
    await expect.soft(m.getByRole('checkbox', { name: /退園/ }), '③「退園した園児も出す」が無い').toHaveCount(0);
    await evidence(page, '07-002');

    const g = await newWindow(browser, PHONE);
    try {
      await loginWith(g.page, 'guardian', ACCOUNTS.guardian.email, passwordOf('guardian'));
      await expect.soft(g.page.getByRole('navigation', { name: '職員メニュー' }), '④保護者の画面にサイドナビが無い').toHaveCount(0);
      await g.page.getByRole('banner').getByRole('button', { name: /メニュー/ }).click();
      const menu = g.page.getByRole('dialog', { name: 'メニュー' });
      await expect(menu).toBeVisible();
      const item = (name: string | RegExp) => menu.getByRole('link', { name }).or(menu.getByRole('button', { name }));
      for (const name of ['ホーム', /連絡帳/, /成長の記録/, 'チャット・お知らせ', 'お子さまの追加', '連絡先の変更', 'パスワードの変更', '利用規約', 'ログアウト']) {
        await expect.soft(item(name).first(), `④メニューの「${String(name)}」`).toBeVisible();
      }
      for (const name of [/園児一覧|園児情報/, /職員アカウント|保護者アカウント|招待コード/, /操作ログ/, /^設定$/]) {
        await expect.soft(item(name), `④メニューに管理の導線「${String(name)}」が無い`).toHaveCount(0);
      }
      await expect.soft(item(/AI の下書き/), '④AI を使っていないので「AI の下書きの利用」が無い').toHaveCount(0);
    } finally {
      await g.context.close();
    }
  });

  /* 典拠：要件定義書「園児情報の登録・編集」(4-1-3)、基本設計書「園児情報の登録・編集」(4-4)、図/画面詳細図「園児一覧画面」(7-1) 項目7・(7-2) 項目22・23 */
  test('07-003 一般が園児の詳細を読み取り専用で開く', async ({ page, playwright, browser }) => {
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-003', {
      allergies: [{ target_food: '受入07 たまご', symptom: '受入07 じんましん', response: '受入07 除去' }],
      medicalHistories: ['受入 07-003 既往'],
    });
    await openAs(page, 'staffSakura', '園児');
    await filterChildren(page, child.childName);
    const row = childRow(page, child.childName);
    await expect(row).toHaveCount(1);
    const detail = row.getByRole('link', { name: '詳細' }).or(row.getByRole('button', { name: '詳細' }));
    test.skip((await detail.count()) === 0, `まず回した：一般の園児一覧の行に「詳細」が無い（「記録」だけ）。${OUT_121}の 7-1 項目7`);
    // 機能があるときの確かめ（前提G の保護者もここで作る）
    const g = await newWindow(browser, PHONE);
    try {
      await makeGuardian(g.page, api, '07-003', { child });
    } finally {
      await g.context.close();
    }
    await page.reload();
    await filterChildren(page, child.childName);
    await childRow(page, child.childName).getByRole('link', { name: '詳細' }).or(childRow(page, child.childName).getByRole('button', { name: '詳細' })).first().click();
    const m = mainOf(page);
    await expect.soft(m, '①「園児の詳細（閲覧のみ）」').toContainText('園児の詳細（閲覧のみ）');
    const editable = await m.locator('input:not([disabled]):not([readonly]):not([type=hidden]), textarea:not([disabled]):not([readonly]), select:not([disabled])').count();
    expect.soft(editable, '②入力欄がすべて読み取り専用').toBe(0);
    for (const name of ['確認へ進む', '退園にする', '在籍へ戻す', 'やめる']) {
      await expect.soft(m.getByRole('button', { name }), `③「${name}」が無い`).toHaveCount(0);
    }
    await expect.soft(m.getByRole('link', { name: /園児一覧へ/ }).or(m.getByRole('button', { name: /園児一覧へ/ })).first(), '③「園児一覧へ」').toBeVisible();
    await expect.soft(m, '④既往歴').toContainText('受入 07-003 既往');
    await expect.soft(m, '④アレルギー').toContainText('受入07 たまご');
    await expect.soft(m, '④保護者').toContainText('受入 保護者 07-003');
    await evidence(page, '07-003');
    await m.getByRole('link', { name: /園児一覧へ/ }).or(m.getByRole('button', { name: /園児一覧へ/ })).first().click();
    await expect.soft(page.getByRole('heading', { name: '園児', level: 1 }), '⑤園児一覧画面へ戻る').toBeVisible();
  });

  /* 典拠：要件定義書「園児情報の取消（誤登録の削除）」(4-1-3)、基本設計書「園児情報の取消（誤登録の削除）」(4-4)、図/画面詳細図「園児一覧画面」(7-1) 項目10、詳細設計書「園児の登録と個人チャット」(4-9) */
  test('07-004 誤登録の取消', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-004');
    await issueCode(api, child.childId);
    const border = logBorder();
    await openAs(page, 'admin', '園児');
    await filterChildren(page, child.childName);
    const row = childRow(page, child.childName);
    await expect(row).toHaveCount(1);
    const cancel = row.getByRole('button', { name: '取消' }).or(row.getByRole('link', { name: '取消' }));
    await expect(cancel, '①記録も保護者も紐づいていない園児の行に「取消」が出る').toBeVisible({ timeout: 5_000 });
    await cancel.click();
    const d = page.getByRole('dialog').or(page.getByRole('alertdialog')).last();
    await expect.soft(d, '②確認ダイアログ').toBeVisible();
    expect.soft(Number(sqlValue('SELECT is_deleted FROM m_child WHERE child_id = ?', child.childId)), '②確定の前は変わらない').toBe(0);
    await d.getByRole('button', { name: /取消|取り消す|確定/ }).last().click();
    await expect.soft(childRow(page, child.childName), '③一覧から消える').toHaveCount(0);
    expect.soft(Number(sqlValue('SELECT is_deleted FROM m_child WHERE child_id = ?', child.childId)), '④is_deleted').toBe(1);
    expect.soft(sqlAll("SELECT is_archived FROM m_chat_room WHERE child_id = ? AND room_type = '4'", child.childId).map((r) => Number(r.is_archived)), '④個人チャットの is_archived').toEqual([1]);
    expect.soft(sqlAll('SELECT status FROM t_invitation_code WHERE child_id = ?', child.childId).map((r) => String(r.status)), '④未使用のコードは失効').toEqual(['3']);
    expect.soft(logsAfter(border).some((l) => l.function_type === '6' && l.operation_type === '4' && l.target_child_id === child.childId), '⑤操作ログ 6:4').toBe(true);
    await evidence(page, '07-004');
  });

  /* 典拠：基本設計書「園児情報の取消（誤登録の削除）」(4-4)・「メッセージ一覧」(4-12) の取消の不可、図/画面詳細図「園児一覧画面」(7-1) 項目10 */
  test('07-005 記録か保護者が紐づく園児は取り消せない', async ({ page, playwright, browser }) => {
    const api = await adminApi(playwright);
    const g = await newWindow(browser, PHONE);
    let guardianChild: string;
    try {
      guardianChild = (await makeGuardian(g.page, api, '07-005')).childName;
    } finally {
      await g.context.close();
    }
    const withRecord = await makeChild(api, '07-005', { suffix: 'B' });
    await recordEvent(api, withRecord.childId, 'toilet');
    const dialogs = collectNativeDialogs(page);
    await openAs(page, 'admin', '園児');
    for (const name of [guardianChild, withRecord.childName]) {
      await filterChildren(page, name);
      const row = childRow(page, name);
      await expect(row).toHaveCount(1);
      const cancel = row.getByRole('button', { name: '取消' }).or(row.getByRole('link', { name: '取消' }));
      if ((await cancel.count()) > 0) {
        await cancel.click();
        const d = page.getByRole('dialog').or(page.getByRole('alertdialog')).last();
        if (await d.count()) await d.getByRole('button', { name: /取消|取り消す|確定/ }).last().click();
        const shown = `${await mainOf(page).innerText()} ${dialogs.join(' ')}`;
        expect.soft(shown, `②${name}：取り消せない旨`).toContain(MSG.cancelNo);
      }
      expect.soft(await cancel.count(), `①${name} の行に「取消」が出ない`).toBe(0);
    }
    for (const id of [withRecord.childId]) {
      expect.soft(Number(sqlValue('SELECT is_deleted FROM m_child WHERE child_id = ?', id)), '②取り消されない').toBe(0);
    }
    await evidence(page, '07-005');
  });

  /* 典拠：要件定義書「園児情報の登録・編集」(4-1-3)、基本設計書「園児情報の登録・編集」(4-4)、図/画面詳細図「園児情報入力画面／園児情報確認画面」(7-2) 項目1〜14・16・18、詳細設計書「園児情報の登録（個人チャットを作る）」(2-7)・「園児の登録と個人チャット」(4-9) */
  test('07-006 園児の登録', async ({ page }) => {
    const border = logBorder();
    const maxNo = Number(sqlValue("SELECT MAX(CAST(substr(child_id, 2) AS INTEGER)) FROM m_child WHERE child_id GLOB 'C[0-9]*'") ?? 0);
    await openAs(page, 'admin', '園児');
    await openNewChild(page);
    const f = childForm(page);
    // ① 初期値
    const idValue = await f.id.inputValue();
    expect.soft(Number(/^C0*(\d+)$/.exec(idValue)?.[1] ?? NaN), `①園児IDが使われている番号の次（${idValue}）`).toBe(maxNo + 1);
    await expect.soft(f.sex('男'), '①性別の初期値「男」').toBeChecked();
    const firstClass = await f.className.locator('option').first().innerText();
    await expect.soft(f.className.locator('option:checked'), '①クラスは選べるクラスの先頭').toHaveText(firstClass);
    await expect.soft(f.consent.locator('option:checked'), '①写真の利用同意の初期値「園内記録として保持」').toHaveText(/園内記録/);
    const nap = mainOf(page).getByRole('spinbutton', { name: /午睡/ }).or(mainOf(page).getByRole('textbox', { name: /午睡/ }));
    if (await nap.count()) await expect.soft(nap.first(), '①午睡の確認の間隔は空').toHaveValue('');
    // 入れる
    await f.name.fill('受入 07-006');
    await f.kana.fill('うけいれぜろろく');
    await f.nickname.fill('ろくちゃん');
    await f.birth.fill('2024-05-20');
    await f.sex('未回答').check();
    await f.className.selectOption({ label: 'さくら組' });
    await f.temperature.fill('36.5');
    await f.addAllergy.click();
    await f.target.last().fill('受入07 こむぎ');
    await f.symptom.last().fill('受入07 せき');
    await f.response.last().fill('受入07 除去');
    await f.addHistory.click();
    await mainOf(page).getByRole('textbox').last().fill('受入 07-006 既往');
    await f.toConfirm.click();
    // ② 確認画面
    const m = mainOf(page);
    await expect(m.getByRole('button', { name: '登録する' })).toBeVisible();
    for (const v of ['受入 07-006', 'うけいれぜろろく', 'ろくちゃん', '2024/05/20', '未回答', 'さくら組', '36.5', '受入07 こむぎ', '受入07 せき', '受入07 除去', '受入 07-006 既往']) {
      await expect.soft(m, `②確認画面に「${v}」`).toContainText(v);
    }
    const birthRow = m.getByRole('row', { name: /生年月日/ });
    const emphasized = (await birthRow.locator('strong, em, mark, b, [role=alert], [role=note]').count()) > 0 || (await m.getByText(/生年月日.*(確か|注意|変わ)/).count()) > 0;
    expect.soft(emphasized, '②生年月日が強調される').toBe(true);
    // ③ 戻る
    await m.getByRole('button', { name: '戻る' }).click();
    await expect.soft(f.name, '③戻っても値が残る（氏名）').toHaveValue('受入 07-006');
    await expect.soft(f.nickname, '③呼び名').toHaveValue('ろくちゃん');
    await expect.soft(f.temperature, '③平熱').toHaveValue('36.5');
    await expect.soft(f.target.last(), '③アレルギー').toHaveValue('受入07 こむぎ');
    // ④ 登録する
    await confirmAndSave(page);
    await expect.soft(page.getByRole('status').filter({ hasText: '登録しました' }).first(), '④完了の表示').toContainText(MSG.childRegistered('受入 07-006'));
    await filterChildren(page, '受入 07-006');
    await expect.soft(childRow(page, '受入 07-006'), '④行が増える').toHaveCount(1);
    // ⑤ SQL
    const row = sqlAll('SELECT child_id, photo_consent_level, nickname, sex, normal_temperature FROM m_child WHERE child_name = ?', '受入 07-006')[0];
    expect.soft(row, '⑤m_child').toBeTruthy();
    if (row) {
      expect.soft(String(row.photo_consent_level), '⑤photo_consent_level＝1').toBe('1');
      expect.soft(String(row.nickname), '⑤nickname').toBe('ろくちゃん');
      expect.soft(String(row.sex), '⑤sex＝9').toBe('9');
      expect.soft(Number(row.normal_temperature), '⑤normal_temperature').toBe(36.5);
      const id = String(row.child_id);
      expect.soft(Number(sqlValue('SELECT COUNT(*) FROM m_allergy WHERE child_id = ?', id)), '⑤m_allergy').toBe(1);
      expect.soft(Number(sqlValue('SELECT COUNT(*) FROM m_medical_history WHERE child_id = ?', id)), '⑤m_medical_history').toBe(1);
      const rooms = sqlAll("SELECT chat_room_id, room_name FROM m_chat_room WHERE child_id = ? AND room_type = '4'", id);
      expect.soft(rooms.map((r) => String(r.room_name)), '⑤個人チャット').toEqual(['受入 07-006の保護者']);
      if (rooms[0]) {
        const members = sqlAll('SELECT account_id FROM t_chat_member WHERE chat_room_id = ?', Number(rooms[0].chat_room_id)).map((r) => Number(r.account_id)).sort((a, b) => a - b);
        const expected = [ACCOUNTS.admin.email, ACCOUNTS.admin2.email, ACCOUNTS.staffSakura.email, ACCOUNTS.staffTempPassword.email].map(accountIdOf).sort((a, b) => a - b);
        expect.soft(members, '⑤職員の参加者がさくら組の担任と管理者全員').toEqual(expected);
      }
      expect.soft(logsAfter(border).some((l) => l.function_type === '6' && l.operation_type === '1' && l.target_child_id === id), '⑥操作ログ 6:1').toBe(true);
    }
    await evidence(page, '07-006');
  });

  /* 典拠：基本設計書「園児情報の登録・編集」(4-4)・「メッセージ一覧」(4-12) の必須項目の欠落・「誰でも使える操作の条件」(3-5) の⑤、図/画面詳細図 (7-2) 項目15 */
  test('07-007 入力の誤りをまとめて示す', async ({ page }) => {
    const before = Number(sqlValue('SELECT COUNT(*) FROM m_child') ?? 0);
    await openAs(page, 'admin', '園児');
    await openNewChild(page);
    const f = childForm(page);
    await f.id.fill('C001');
    await f.birth.fill('2024-05-20');
    await f.toConfirm.click();
    await expect.soft(mainOf(page).getByRole('button', { name: '登録する' }), '①確認画面へ進まない').toHaveCount(0);
    const alertText = (await mainOf(page).getByRole('alert').allInnerTexts()).join(' ');
    expect.soft(alertText, '②氏名とよみの必須（文言）').toContain(MSG.required);
    expect.soft(alertText, '②③園児IDの重複を確認の前に知らせる').toMatch(/園児ID/);
    expect.soft(alertText.includes('氏名') || alertText.includes(MSG.required), '②氏名').toBe(true);
    expect.soft(alertText.includes('よみ') || alertText.includes(MSG.required), '②よみ').toBe(true);
    await expect.soft(f.id, '④入れた値は消えない（園児ID）').toHaveValue('C001');
    await expect.soft(f.birth, '④生年月日').toHaveValue('2024-05-20');
    await evidence(page, '07-007');
    await f.cancel.click();
    await expect.soft(page.getByRole('heading', { name: '園児', level: 1 }), '⑤園児一覧画面へ戻る').toBeVisible();
    expect.soft(Number(sqlValue('SELECT COUNT(*) FROM m_child') ?? 0), '⑤登録されない').toBe(before);
  });

  /* 典拠：基本設計書「園児情報の登録・編集」(4-4)・「操作ログ（t_operation_log）」(5-9)、図/画面詳細図 (7-2) 項目12〜14 */
  test('07-008 園児情報の編集', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-008');
    const border = logBorder();
    await openAs(page, 'admin', '園児');
    await filterChildren(page, child.childName);
    await childRow(page, child.childName).getByRole('link', { name: '編集' }).click();
    const f = childForm(page);
    await expect.soft(f.id, '①園児IDは変えられない').toBeDisabled();
    await f.nickname.fill('ろっくん');
    const shareOption = (await f.consent.locator('option').allInnerTexts()).find((t) => /自児/.test(t));
    expect(shareOption, '写真の利用同意に「自児の保護者へ共有」の段階がある').toBeTruthy();
    await f.consent.selectOption({ label: shareOption! });
    await f.toConfirm.click();
    await expect.soft(mainOf(page).getByRole('button', { name: '更新する' }), '②ボタンの文言が「更新する」').toBeVisible();
    await mainOf(page).getByRole('button', { name: /^(更新する|登録する)$/ }).click();
    await page.waitForURL((u) => u.pathname === '/staff/children', { timeout: 15_000 }).catch(() => undefined);
    await expect.soft(page.getByRole('heading', { name: '園児', level: 1 }), '③園児一覧画面へ戻る').toBeVisible();
    const row = sqlAll('SELECT nickname, photo_consent_level FROM m_child WHERE child_id = ?', child.childId)[0];
    expect.soft(String(row?.nickname), '④nickname').toBe('ろっくん');
    expect.soft(String(row?.photo_consent_level), '④photo_consent_level＝2').toBe('2');
    const log = logsAfter(border).find((l) => l.function_type === '6' && l.operation_type === '2' && l.target_child_id === child.childId);
    expect.soft(log, '⑤操作ログ 6:2').toBeTruthy();
    if (log) {
      expect.soft(log.after_value ?? '', '⑤変更後に呼び名').toContain('ろっくん');
      expect.soft(`${log.before_value ?? ''}${log.after_value ?? ''}`, '⑤写真の利用同意の前後').toMatch(/写真|consent|同意/);
      expect.soft(`${log.before_value ?? ''}${log.after_value ?? ''}`, '⑤変わっていない項目（よみ）は入らない').not.toContain('うけいれ');
    }
    await evidence(page, '07-008');
  });

  /* 典拠：図/画面詳細図「園児情報入力画面／園児情報確認画面」(7-2) 項目22・(7-8) 項目11、要件定義書「緊急連絡先の保持」(4-1-1) */
  test('07-009 保護者と緊急連絡先の表示', async ({ page, playwright, browser }) => {
    const api = await adminApi(playwright);
    const g = await newWindow(browser, PHONE);
    let made;
    try {
      made = await makeGuardian(g.page, api, '07-009');
    } finally {
      await g.context.close();
    }
    await openAs(page, 'admin', '園児');
    await filterChildren(page, made.childName);
    await childRow(page, made.childName).getByRole('link', { name: '編集' }).click();
    await expect(childForm(page).toConfirm).toBeVisible();
    const m = mainOf(page);
    for (const v of [made.guardianName, '母', '090-0000-0007', '有効']) await expect.soft(m, `保護者の欄に「${v}」`).toContainText(v);
    await expect.soft(m, '連絡順').toContainText(/連絡順\s*1/);
    await expect.soft(m.getByRole('spinbutton', { name: /連絡順/ }), '連絡順はこの画面で変えられない').toHaveCount(0);
    await evidence(page, '07-009');
  });

  /* 典拠：授業の雛形 1.5（クロスサイトスクリプティング対策）、テスト仕様書「テストデータの準備」(2.1) */
  test('07-010 クロスサイトスクリプティング（園児の氏名・アレルギー）', async ({ page }) => {
    const alerts = await watchAlerts(page);
    const name = `受入07-010<b>太字</b>${XSS_SCRIPT}`;
    await openAs(page, 'admin', '園児');
    await openNewChild(page);
    await fillChildBasics(page, { name, className: 'さくら組' });
    const f = childForm(page);
    await f.addAllergy.click();
    await f.target.last().fill(XSS_IMG);
    await f.symptom.last().fill('受入07 せき');
    await f.response.last().fill('受入07 除去');
    await f.toConfirm.click();
    await expect.soft(mainOf(page).getByText(name, { exact: false }).first(), '①確認画面にタグが文字のまま').toBeVisible();
    await mainOf(page).getByRole('button', { name: '登録する' }).click();
    await page.waitForURL((u) => u.pathname === '/staff/children', { timeout: 15_000 });
    await filterChildren(page, '受入07-010');
    await expect.soft(childRow(page, '受入07-010', false).first(), '①一覧にタグが文字のまま').toContainText(name);
    await expect.soft(mainOf(page).locator('table b'), '①一覧で太字にならない').toHaveCount(0);
    await mainOf(page).getByRole('link', { name: 'アレルギー一覧' }).click();
    await expect.soft(mainOf(page).getByText(XSS_IMG).first(), '①アレルギー一覧にタグが文字のまま').toBeVisible();
    await expect.soft(mainOf(page).locator('img[src="x"]'), '①img が作られない').toHaveCount(0);
    expect.soft(alerts, '②alert が出ない').toEqual([]);
    const row = sqlAll('SELECT c.child_name, a.target_food FROM m_child c JOIN m_allergy a ON a.child_id = c.child_id WHERE c.child_name LIKE ?', '受入07-010%')[0];
    expect.soft(row?.child_name, '④SQL：氏名').toBe(name);
    expect.soft(row?.target_food, '④SQL：対象').toBe(XSS_IMG);
    await evidence(page, '07-010');
  });

  /* 典拠：授業の雛形 1.5（二重送信の防止）、テスト仕様書「テスト対象の機能」(1.5) */
  test('07-011 二重送信（園児の登録）', async ({ page }) => {
    await openAs(page, 'admin', '園児');
    await openNewChild(page);
    await fillChildBasics(page, { name: '受入 07-011', className: 'さくら組' });
    await childForm(page).toConfirm.click();
    const save = mainOf(page).getByRole('button', { name: '登録する' });
    await expect(save).toBeVisible();
    await save.dblclick().catch(() => undefined);
    await page.waitForURL((u) => u.pathname === '/staff/children', { timeout: 15_000 }).catch(() => undefined);
    await page.reload();
    await page.goBack().catch(() => undefined);
    const again = mainOf(page).getByRole('button', { name: '登録する' });
    if (await again.isVisible().catch(() => false)) await again.click().catch(() => undefined);
    await page.waitForTimeout(1_000);
    const ids = sqlAll('SELECT child_id FROM m_child WHERE child_name = ? AND is_deleted = 0', '受入 07-011').map((r) => String(r.child_id));
    expect.soft(ids.length, '①登録は1件だけ（再読み込み・戻って押し直しても増えない）').toBe(1);
    if (ids[0]) expect.soft(Number(sqlValue("SELECT COUNT(*) FROM m_chat_room WHERE child_id = ? AND room_type = '4'", ids[0])), '①個人チャットも1つ').toBe(1);
    await page.goto('/staff/children');
    await filterChildren(page, '受入 07-011');
    await evidence(page, '07-011');
  });

  /* 典拠：基本設計書「園児情報の登録・編集」(4-4)・「入力項目の制約値」(4-12)・「園児（m_child）」(5-3)、図/画面詳細図 (7-2) 項目18 */
  test('07-012 午睡の確認の間隔（園児ごと）', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-012');
    await openAs(page, 'admin', '園児');
    await filterChildren(page, child.childName);
    await childRow(page, child.childName).getByRole('link', { name: '編集' }).click();
    await expect(childForm(page).toConfirm).toBeVisible();
    const nap = mainOf(page).getByRole('spinbutton', { name: /午睡/ }).or(mainOf(page).getByRole('textbox', { name: /午睡/ }));
    test.skip((await nap.count()) === 0, `まず回した：園児情報入力画面に「午睡の確認の間隔」の欄が無い。${OUT_NEXT}`);
    const border = logBorder();
    await expect.soft(nap.first(), '①初期値が空').toHaveValue('');
    await expect.soft(mainOf(page), '①クラスの年齢児の値（1歳児 10分）').toContainText(/1歳児\s*10\s*分/);
    await nap.first().fill('5');
    await confirmAndSave(page);
    expect.soft(Number(sqlValue('SELECT nap_interval_minutes FROM m_child WHERE child_id = ?', child.childId)), '②SQL').toBe(5);
    expect.soft(logsAfter(border).some((l) => l.function_type === '6' && l.operation_type === '2'), '③操作ログ 6:2').toBe(true);
    await evidence(page, '07-012');
  });

  /* 典拠：要件定義書「呼び名と顔写真」(4-1-3)、基本設計書「園児（m_child）」(5-3)、図/画面詳細図 (7-2) 項目17・「共通のダイアログと部品」(1-3) の (1) */
  test('07-013 顔写真の登録', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-013');
    await openAs(page, 'admin', '園児');
    await filterChildren(page, child.childName);
    await childRow(page, child.childName).getByRole('link', { name: '編集' }).click();
    await expect(childForm(page).toConfirm).toBeVisible();
    const photo = mainOf(page).getByRole('button', { name: /写真を選ぶ/ }).or(mainOf(page).getByLabel(/顔写真/));
    test.skip((await photo.count()) === 0, `まず回した：園児情報入力画面に「顔写真」の欄が無い。${OUT_NEXT}（詳細設計書「園児情報の登録（個人チャットを作る）」(2-7)）。${OUT_121}の共通「写真・添付はファイル選択」`);
    await evidence(page, '07-013');
  });

  /* 典拠：要件定義書「退園の操作」(4-1-3)、基本設計書「退園の操作」(4-4)、図/画面詳細図 (7-2) 項目19・20・(7-1) 項目11 */
  test('07-014 退園の操作', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-014');
    await openAs(page, 'admin', '園児');
    await filterChildren(page, child.childName);
    await childRow(page, child.childName).getByRole('link', { name: '編集' }).click();
    await expect(childForm(page).toConfirm).toBeVisible();
    const withdraw = mainOf(page).getByRole('button', { name: /退園にする/ });
    test.skip((await withdraw.count()) === 0, `まず回した：園児情報入力画面に「退園にする」が無い（在籍状態の欄も無い）。${OUT_NEXT}（「次の版で詳しくする経路」(4-11) の退園の操作）`);
    await evidence(page, '07-014');
  });

  /* 典拠：基本設計書「退園の操作」(4-4) の在籍へ戻す、図/画面詳細図 (7-2) 項目21 */
  test('07-015 誤って退園にした園児を在籍へ戻す', async ({ page }) => {
    await openAs(page, 'admin', '園児');
    const shows = mainOf(page).getByRole('checkbox', { name: /退園した園児/ });
    const back = mainOf(page).getByRole('button', { name: /在籍へ戻す/ });
    test.skip((await shows.count()) === 0 && (await back.count()) === 0, `まず回した：退園の操作（07-014）が画面に無く、「退園した園児も出す」「在籍へ戻す」も無い。${OUT_NEXT}`);
    await evidence(page, '07-015');
  });
});

// =====================================================================
// 園児情報入力画面の入力チェック（サーバA）
// =====================================================================

test.describe('園児情報入力画面の入力チェック（サーバA）', () => {
  async function newChildForm(page: Page) {
    await openAs(page, 'admin', '園児');
    await openNewChild(page);
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の氏名・かな、図/画面詳細図 (7-2) 項目1、詳細設計書「本書で足す文言」(4-1 (6)) */
  test('07-I001 氏名 51文字', async ({ page }) => {
    await newChildForm(page);
    const long = `07-I001${'あ'.repeat(44)}`; // 51文字
    await fillChildBasics(page, { name: long, className: 'さくら組' });
    const f = childForm(page);
    const typed = await f.name.inputValue();
    await f.toConfirm.click();
    const onConfirm = (await mainOf(page).getByRole('button', { name: '登録する' }).count()) > 0;
    const msg = (await mainOf(page).getByRole('alert').allInnerTexts()).join(' ');
    expect.soft(onConfirm, '確認へ進めない').toBe(false);
    expect.soft(typed.length <= 50 || /氏名は\s*50\s*文字以内で入力してください。/.test(msg), `51文字目を打てないか、文字数の文（打てた長さ ${typed.length}、文「${msg}」）`).toBe(true);
    await expect.soft(mainOf(page).getByText(/残り/).first(), '入力欄に残りの文字数').toBeVisible();
    await evidence(page, '07-I001');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の園児のよみ・「メッセージ一覧」(4-12) の必須項目の欠落、図/画面詳細図 (7-2) 項目2 */
  test('07-I002 よみ 空', async ({ page }) => {
    await newChildForm(page);
    await fillChildBasics(page, { name: '受入 07-I002', kana: '', className: 'さくら組' });
    const f = childForm(page);
    await f.kana.fill('');
    await f.toConfirm.click();
    await expect.soft(mainOf(page).getByRole('button', { name: '登録する' }), '確認へ進めない').toHaveCount(0);
    expect.soft((await mainOf(page).getByRole('alert').allInnerTexts()).join(' '), '文言').toContain(MSG.required);
    await expect.soft(f.name, '入れたほかの値は消えない').toHaveValue('受入 07-I002');
    await evidence(page, '07-I002');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の園児の呼び名、図/画面詳細図 (7-2) 項目16、詳細設計書「園児の登録と個人チャット」(4-9) */
  test('07-I003 呼び名 21文字', async ({ page }) => {
    await newChildForm(page);
    await fillChildBasics(page, { name: '受入 07-I003', className: 'さくら組' });
    const f = childForm(page);
    await f.nickname.fill(`07-I003${'あ'.repeat(14)}`); // 21文字
    const typed = await f.nickname.inputValue();
    await f.toConfirm.click();
    const onConfirm = (await mainOf(page).getByRole('button', { name: '登録する' }).count()) > 0;
    const msg = (await mainOf(page).getByRole('alert').allInnerTexts()).join(' ');
    expect.soft(typed.length <= 20 || (!onConfirm && msg.includes('呼び名は20文字以内で入力してください。')), `21文字目を打てないか、文（打てた長さ ${typed.length}、確認へ進んだ ${onConfirm}、文「${msg}」）`).toBe(true);
    await evidence(page, '07-I003');
  });

  /* 典拠：基本設計書「園児情報の登録・編集」(4-4)・「メッセージ一覧」(4-12) の生年月日が未来日・「園児（m_child）」(5-3) */
  test('07-I004 生年月日 あす', async ({ page }) => {
    await newChildForm(page);
    await fillChildBasics(page, { name: '受入 07-I004', birth: addDays(jstToday(), 1), className: 'さくら組' });
    await childForm(page).toConfirm.click();
    await expect.soft(mainOf(page).getByRole('button', { name: '登録する' }), '確認へ進めない').toHaveCount(0);
    expect.soft((await mainOf(page).getByRole('alert').allInnerTexts()).join(' '), '文言').toContain(MSG.birthFuture);
    await evidence(page, '07-I004');
  });

  /** 平熱の範囲の外：確認を促し、同じ値でもう一度押すと進む（07-I005・07-I007） */
  async function outOfRangeTemperature(page: Page, caseNo: string, value: string) {
    await newChildForm(page);
    const name = `受入 ${caseNo}`;
    await fillChildBasics(page, { name, className: 'さくら組' });
    const f = childForm(page);
    await f.temperature.fill(value);
    await f.toConfirm.click();
    const save = mainOf(page).getByRole('button', { name: '登録する' });
    await expect.soft(save, '1回目は確認画面へ進まず、確認を促す').toHaveCount(0);
    const prompt = (await mainOf(page).getByRole('alert').allInnerTexts()).join(' ');
    expect.soft(prompt, '確認を促す表示').toContain(value);
    expect.soft(prompt, '判定の言葉が付かない').not.toMatch(/発熱|低体温|高熱|異常/);
    await f.toConfirm.click();
    await expect.soft(save, '同じ値でもう一度押すと確認画面へ進む').toBeVisible();
    if (await save.count()) {
      await save.click();
      await page.waitForURL((u) => u.pathname === '/staff/children', { timeout: 15_000 }).catch(() => undefined);
      expect.soft(Number(sqlValue('SELECT normal_temperature FROM m_child WHERE child_name = ?', name)), 'SQL：normal_temperature').toBe(Number(value));
    }
    await evidence(page, caseNo);
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の平熱・「園児情報の登録・編集」(4-4)、図/画面詳細図 (7-2) 項目6 と補足、要件定義書「品質要求一覧」(7-1 No.5) */
  test('07-I005 平熱 29.9', async ({ page }) => {
    await outOfRangeTemperature(page, '07-I005', '29.9');
  });

  /* 典拠：同上 */
  test('07-I006 平熱 30.0', async ({ page }) => {
    await newChildForm(page);
    await fillChildBasics(page, { name: '受入 07-I006', className: 'さくら組' });
    await childForm(page).temperature.fill('30.0');
    await childForm(page).toConfirm.click();
    await expect.soft(mainOf(page).getByRole('button', { name: '登録する' }), '確認を促さずに確認画面へ進む').toBeVisible();
    await evidence(page, '07-I006');
  });

  /* 典拠：同上 */
  test('07-I007 平熱 43.1', async ({ page }) => {
    await outOfRangeTemperature(page, '07-I007', '43.1');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) のアレルギーの症状・対応・「メッセージ一覧」(4-12) の必須項目の欠落、図/画面詳細図 (7-2) 項目7 */
  test('07-I008 アレルギー 対象だけ', async ({ page }) => {
    await newChildForm(page);
    await fillChildBasics(page, { name: '受入 07-I008', className: 'さくら組' });
    const f = childForm(page);
    await f.addAllergy.click();
    await f.target.last().fill('受入07 えび');
    await f.toConfirm.click();
    await expect.soft(mainOf(page).getByRole('button', { name: '登録する' }), '確認へ進めない').toHaveCount(0);
    expect.soft((await mainOf(page).getByRole('alert').allInnerTexts()).join(' '), '誤りを示す（文言）').toContain(MSG.required);
    await expect.soft(f.target.last(), '入れた対象は消えない').toHaveValue('受入07 えび');
    await evidence(page, '07-I008');
  });

  /** 午睡の確認の間隔（園児ごと）の欄（次の版）。無ければ未実施 */
  async function napIntervalField(page: Page, playwright: RequestFactory, caseNo: string): Promise<Locator> {
    const api = await adminApi(playwright);
    const child = await makeChild(api, caseNo);
    await openAs(page, 'admin', '園児');
    await filterChildren(page, child.childName);
    await childRow(page, child.childName).getByRole('link', { name: '編集' }).click();
    await expect(childForm(page).toConfirm).toBeVisible();
    const nap = mainOf(page).getByRole('spinbutton', { name: /午睡/ }).or(mainOf(page).getByRole('textbox', { name: /午睡/ }));
    test.skip((await nap.count()) === 0, `まず回した：園児情報入力画面に「午睡の確認の間隔」の欄が無い。${OUT_NEXT}`);
    return nap.first();
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の午睡の確認の間隔（園児ごと）、図/画面詳細図 (7-2) 項目18 */
  test('07-I009 午睡の確認の間隔 0', async ({ page, playwright }) => {
    const nap = await napIntervalField(page, playwright, '07-I009');
    await nap.fill('0');
    await childForm(page).toConfirm.click();
    await expect.soft(mainOf(page).getByRole('button', { name: /登録する|更新する/ }), '保存されない').toHaveCount(0);
    await evidence(page, '07-I009');
  });

  /* 典拠：同上 */
  test('07-I010 午睡の確認の間隔 10', async ({ page, playwright }) => {
    const nap = await napIntervalField(page, playwright, '07-I010');
    await nap.fill('10');
    await confirmAndSave(page);
    expect.soft(Number(sqlValue("SELECT nap_interval_minutes FROM m_child WHERE child_id = 'U07I010'")), 'SQL').toBe(10);
    await evidence(page, '07-I010');
  });

  /* 典拠：同上、基本設計書「園児（m_child）」(5-3) */
  test('07-I011 午睡の確認の間隔 11', async ({ page, playwright }) => {
    const nap = await napIntervalField(page, playwright, '07-I011');
    await nap.fill('11');
    await childForm(page).toConfirm.click();
    await expect.soft(mainOf(page).getByRole('button', { name: /登録する|更新する/ }), '保存されない').toHaveCount(0);
    await evidence(page, '07-I011');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の退園日・「メッセージ一覧」(4-12) の退園日が未来・「退園の操作」(4-4) */
  test('07-I012 退園日 あす', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-I012');
    await openAs(page, 'admin', '園児');
    await filterChildren(page, child.childName);
    await childRow(page, child.childName).getByRole('link', { name: '編集' }).click();
    await expect(childForm(page).toConfirm).toBeVisible();
    const withdraw = mainOf(page).getByRole('button', { name: /退園にする/ });
    test.skip((await withdraw.count()) === 0, `まず回した：園児情報入力画面に「退園にする」が無い。${OUT_NEXT}`);
    await evidence(page, '07-I012');
  });
});

// =====================================================================
// CSV一括登録画面・アレルギー一覧画面（サーバA）
// =====================================================================

/*
 * CSV の見出し。画面が示す列の並び（図/画面詳細図「CSV一括登録画面（管理者）」(7-3) 項目1「列の並びを画面に示し」）の名前で書く。
 * シート07 の前半は要件定義書の項目名（氏名（かな）・所属クラス）で書いていた（case-fixes.md）
 */
const CSV_HEADER = '園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱';

async function openCsv(page: Page) {
  await openAs(page, 'admin', '園児');
  await mainOf(page).getByRole('link', { name: 'CSV一括登録' }).click();
  await expect(mainOf(page).getByRole('heading', { name: 'CSV一括登録', level: 1 })).toBeVisible();
}

async function pasteCsv(page: Page, lines: string[]) {
  await mainOf(page).getByRole('textbox', { name: /貼り付ける/ }).fill(`${[CSV_HEADER, ...lines].join('\n')}\n`);
  await mainOf(page).getByRole('button', { name: '取込内容を確認する' }).click();
}

function csvRow(page: Page, text: string): Locator {
  return mainOf(page).getByRole('row').filter({ hasText: text });
}

test.describe('CSV一括登録画面・アレルギー一覧画面（サーバA）', () => {
  /* 典拠：要件定義書「園児情報の一括登録」「一括登録の取込項目」(4-1-3)、基本設計書「CSV一括登録」(4-4)、図/画面詳細図 (7-3) 項目3〜5・7〜10、詳細設計書 (2-7)、授業の雛形 1.5 */
  test('07-016 CSV の取込（正常）', async ({ page }) => {
    const alerts = await watchAlerts(page);
    const border = logBorder();
    const before = Number(sqlValue('SELECT COUNT(*) FROM m_child') ?? 0);
    const maxNo = Number(sqlValue("SELECT MAX(CAST(substr(child_id, 2) AS INTEGER)) FROM m_child WHERE child_id GLOB 'C[0-9]*'") ?? 0);
    await openCsv(page);
    await pasteCsv(page, [
      'U07016A,受入 07-016A,うけいれえー,2024-05-20,男,さくら組,',
      'U07016B,受入 07-016B,うけいれびー,2024/06/01,2,ひまわり組,36.8',
      ',受入 07-016C<b>太字</b>,うけいれしー,2025-01-31,9,もも組,',
    ]);
    const m = mainOf(page);
    await expect(csvRow(page, '受入 07-016A').first(), '①取込内容に行が出る').toBeVisible();
    await expect.soft(csvRow(page, '受入 07-016B').first()).toBeVisible();
    await expect.soft(csvRow(page, '受入 07-016C<b>太字</b>').first(), '⑦C の氏名のタグが文字のまま').toBeVisible();
    await expect.soft(m.getByRole('alert'), '①誤りの行は0').toHaveCount(0);
    expect.soft(Number(sqlValue('SELECT COUNT(*) FROM m_child') ?? 0), '②この時点では登録しない').toBe(before);
    await expect.soft(m, '③アレルギー・既往歴は対象外').toContainText(/アレルギー.*既往歴.*対象外|アレルギーと既往歴は、この取込の対象外/);
    const register = m.getByRole('button', { name: /3\s*件を登録する/ });
    await expect(register, '④「3 件を登録する」').toBeVisible();
    await register.click();
    await page.waitForURL((u) => u.pathname === '/staff/children', { timeout: 15_000 });
    await expect.soft(page.getByRole('status').filter({ hasText: '登録し' }).first(), '⑤完了の表示').toContainText(MSG.csvRegistered(3));
    const rows = sqlAll("SELECT child_id, child_name, sex, birth_date, photo_consent_level FROM m_child WHERE child_name LIKE '受入 07-016%' ORDER BY child_name");
    expect.soft(rows.length, '⑥3人').toBe(3);
    expect.soft(rows.map((r) => String(r.sex)), '⑥sex').toEqual(['1', '2', '9']);
    expect.soft(rows.map((r) => String(r.birth_date)).slice(0, 2), '⑥生年月日').toEqual(['2024-05-20', '2024-06-01']);
    expect.soft(rows.map((r) => String(r.photo_consent_level)), '⑥photo_consent_level＝1').toEqual(['1', '1', '1']);
    const cId = String(rows[2]?.child_id ?? '');
    expect.soft(Number(/^C0*(\d+)$/.exec(cId)?.[1] ?? NaN), `⑥園児IDを空にした行に番号の次（${cId}）`).toBe(maxNo + 1);
    for (const r of rows) {
      expect.soft(Number(sqlValue("SELECT COUNT(*) FROM m_chat_room WHERE child_id = ? AND room_type = '4'", String(r.child_id))), `⑥${String(r.child_name)} の個人チャット`).toBe(1);
    }
    await filterChildren(page, '07-016C');
    await expect.soft(childRow(page, '07-016C', false).first(), '⑦一覧でタグが文字のまま').toContainText('受入 07-016C<b>太字</b>');
    expect.soft(alerts, '⑦alert が出ない').toEqual([]);
    expect.soft(logsAfter(border).some((l) => l.function_type === '6'), '⑧操作ログ').toBe(true);
    await evidence(page, '07-016');
  });

  /* 典拠：要件定義書「園児情報の一括登録」(4-1-3)、基本設計書「CSV一括登録」(4-4)・「メッセージ一覧」(4-12)、図/画面詳細図 (7-3) 項目4・5・7 */
  test('07-017 誤りの行が1行でもあれば1件も登録しない', async ({ page }) => {
    await openCsv(page);
    await pasteCsv(page, [
      'U07017A,受入 07-017A,うけいれ,2024-05-20,1,さくら組,',
      'U07017B,受入 07-017B,うけいれ,2024-05-20,2,そら組,',
      'U07017C,受入 07-017C,うけいれ,2024-05-20,,さくら組,',
      'U07017D,受入 07-017D,,2024/13/01,1,さくら組,abc',
    ]);
    const m = mainOf(page);
    await expect.soft(csvRow(page, '受入 07-017B').first(), '①無いクラスの行').toContainText(MSG.csvClass);
    await expect.soft(csvRow(page, '受入 07-017C').first(), '②性別が空の行').toContainText(MSG.csvSex);
    const dText = (await csvRow(page, '受入 07-017D').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    expect.soft(dText, '③D の生年月日').toContain(MSG.birthFormat);
    expect.soft((dText.match(/[／/]|、|。/g) ?? []).length >= 2 && /よみ|かな/.test(dText) && /平熱/.test(dText), `③D に3つの誤りがまとめて出る（${dText}）`).toBe(true);
    await expect.soft(m, '④誤りのある行の数（3）').toContainText(/3\s*(行|件)/);
    const register = m.getByRole('button', { name: /件を登録する/ });
    if (await register.count()) await expect.soft(register, '⑤押せない').toBeDisabled();
    expect.soft(Number(sqlValue("SELECT COUNT(*) FROM m_child WHERE child_id LIKE 'U07017%'")), '⑥1件も登録されない').toBe(0);
    await evidence(page, '07-017');
  });

  /* 典拠：基本設計書「CSV一括登録」(4-4) の平熱・「入力項目の制約値」(4-12)、図/画面詳細図 (7-3) の補足、要件定義書「品質要求一覧」(7-1 No.5) */
  test('07-018 範囲の外の平熱は誤りとせず確認を促す', async ({ page }) => {
    await openCsv(page);
    await pasteCsv(page, ['U07018,受入 07-018,うけいれ,2024-05-20,1,さくら組,43.5']);
    const row = csvRow(page, '受入 07-018').first();
    await expect(row).toBeVisible();
    const text = await row.innerText();
    expect.soft(text, '①確認を促す表示が添えられる').toMatch(/確か|確認|範囲/);
    expect.soft(text, '③判定の言葉が付かない').not.toMatch(/高熱|発熱|異常/);
    const register = mainOf(page).getByRole('button', { name: /1\s*件を登録する/ });
    await expect.soft(register, '②「1 件を登録する」を押せる').toBeEnabled();
    await evidence(page, '07-018');
    if (await register.isEnabled().catch(() => false)) {
      await register.click();
      await page.waitForURL((u) => u.pathname === '/staff/children', { timeout: 15_000 }).catch(() => undefined);
    }
    expect.soft(Number(sqlValue("SELECT normal_temperature FROM m_child WHERE child_id = 'U07018'")), '②登録される（43.5）').toBe(43.5);
  });

  /* 典拠：図/画面詳細図「CSV一括登録画面（管理者）」(7-3) 項目2、基本設計書「CSV一括登録」(4-4) */
  test('07-019 ファイルの選択', async ({ page }) => {
    await openCsv(page);
    const choose = mainOf(page).getByRole('button', { name: 'ファイルを選ぶ' });
    test.skip((await choose.count()) === 0, `まず回した：「ファイルを選ぶ」が無い。${OUT_121}の 7-3 項目2`);
    const before = Number(sqlValue('SELECT COUNT(*) FROM m_child') ?? 0);
    const pick = async (name: string, buffer: Buffer) => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), choose.click()]);
      await chooser.setFiles({ name, mimeType: 'text/csv', buffer });
      await mainOf(page).getByRole('button', { name: '取込内容を確認する' }).click().catch(() => undefined);
      await page.waitForTimeout(800);
    };
    // ① BOM 付き UTF-8（ファイル選択は画面にある。基本設計書「CSV一括登録」(4-4) の UTF-8 の規則）
    await pick('utf8-bom.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${CSV_HEADER}\nU07019A,受入 07-019A,うけいれ,2024-05-20,1,さくら組,\n`, 'utf8')]));
    await expect(csvRow(page, '受入 07-019A').first(), '①BOM 付き UTF-8 が読める').toBeVisible();
    // ② Shift_JIS（12-1：文字コードの判別）
    await pick('sjis.csv', toShiftJis(`${CSV_HEADER}\r\nU07019B,受入 07-019B,うけいれ,2024-05-20,1,さくら組,\r\n`));
    const sjisOk = await csvRow(page, '受入 07-019B').first().isVisible().catch(() => false);
    const sjisNotice = (await mainOf(page).getByRole('alert').allInnerTexts()).join(' ');
    const sjisFeature = sjisOk || /文字コード|Shift_JIS|判別/.test(sjisNotice);
    // ③ 10MB を超えるもの（12-1：ファイルの容量の検査）
    const line = 'U07019X,受入 07-019X,うけいれ,2024-05-20,1,さくら組,\n';
    const big = Buffer.from(`${CSV_HEADER}\n${line.repeat(Math.ceil((10 * 1024 * 1024 + 1024) / Buffer.byteLength(line)))}`, 'utf8');
    await pick('big.csv', big);
    const bigNotice = (await mainOf(page).getByRole('alert').allInnerTexts()).join(' ');
    const sizeFeature = /10\s*MB|大き/.test(bigNotice);
    expect.soft(Number(sqlValue('SELECT COUNT(*) FROM m_child') ?? 0), '④どれもこの時点では登録しない').toBe(before);
    await evidence(page, '07-019');
    test.skip(
      !sjisFeature && !sizeFeature,
      `まず回した：①BOM 付き UTF-8 は読めた。②Shift_JIS のファイルは読めず、判別できない旨も出ない（「${sjisNotice.slice(0, 80)}」）③10MB を超えるファイルにも大きさの知らせが出ない（「${bigNotice.slice(0, 80)}」）。文字コードの判別と容量の検査が画面に無い。${OUT_121}の 7-3 項目2`,
    );
    expect.soft(sjisFeature, `②Shift_JIS が読めるか、判別できないと知らせる（${sjisNotice}）`).toBe(true);
    expect.soft(sjisOk, '②Shift_JIS も読める').toBe(true);
    expect.soft(sizeFeature, `③10MB を超えるファイルは取り込まずに知らせる（${bigNotice}）`).toBe(true);
  });

  /* 典拠：要件定義書「アレルギー一覧の参照」(4-1-3)・「参照範囲の全体規定」(4-1-5)、基本設計書「権限と利用可能機能」(6-1) の○※2、図/画面詳細図 (7-4) 項目1・3・4 */
  test('07-020 全園児のアレルギーの一覧', async ({ page, playwright, browser }) => {
    const api = await adminApi(playwright);
    await makeChild(api, '07-020', { suffix: 'S', allergies: [{ target_food: '受入07 こむぎ', symptom: '受入07 せき', response: '受入07 除去' }] });
    await makeChild(api, '07-020', { className: 'ひまわり組', allergies: [{ target_food: '受入07 そば', symptom: '受入07 ほっしん', response: '受入07 除去' }], medicalHistories: ['受入 07-020 既往'] });
    const expected = Number(sqlValue("SELECT COUNT(DISTINCT c.child_id) FROM m_allergy a JOIN m_child c ON c.child_id = a.child_id WHERE c.is_deleted = 0 AND c.enrollment_status = '1'"));
    await openAs(page, 'admin', '園児');
    await mainOf(page).getByRole('link', { name: 'アレルギー一覧' }).click();
    await expect(mainOf(page).getByRole('heading', { level: 1 })).toContainText('アレルギー一覧');
    // 1人に複数のアレルギーがあると行がまとめられる（氏名のセルが上の行にだけある）。列の数がそろった行の「氏名」の列で数える
    const nameCol = (await columnNames(page)).indexOf('氏名');
    const names = (await dataRows(page).evaluateAll((rows, col) => {
      const width = Math.max(...rows.map((r) => (r as HTMLTableRowElement).cells.length));
      return rows.filter((r) => (r as HTMLTableRowElement).cells.length === width).map((r) => (r as HTMLTableRowElement).cells[col]?.textContent?.trim() ?? '');
    }, nameCol)).filter(Boolean);
    expect.soft(new Set(names).size, `①アレルギーが登録された在籍の園児だけ（人数。${[...new Set(names)].join('・')}）`).toBe(expected);
    expect.soft(await columnNames(page), '②列が クラス・氏名・対象・症状・対応').toEqual(['クラス', '氏名', '対象', '症状', '対応']);
    await expect.soft(mainOf(page).getByText('受入 07-020 既往'), '②既往歴を出さない').toHaveCount(0);
    await expect.soft(mainOf(page), '③件数（対象の人数）').toContainText(new RegExp(`${expected}\\s*(名|人)`));
    await expect.soft(mainOf(page).getByRole('link', { name: /編集/ }).or(mainOf(page).getByRole('button', { name: /編集|保存/ })), '⑤この画面で編集できない').toHaveCount(0);
    await evidence(page, '07-020');
    const s = await newWindow(browser);
    try {
      await loginWith(s.page, 'staff', ACCOUNTS.staffSakura.email, passwordOf('staffSakura'));
      await s.page.goto('/staff/children/allergies');
      await expect.soft(s.page.getByRole('main').getByText('受入 07-020', { exact: true }), '④一般でもひまわり組の園児が出る').toBeVisible();
    } finally {
      await s.context.close();
    }
  });

  /* 典拠：基本設計書「権限と利用可能機能」(6-1)・「操作ログ（t_operation_log）」(5-9)、図/画面詳細図 (7-4) 項目2、インタフェース一覧「経路の一覧」(1) の POST /api/exports */
  test('07-021 アレルギー一覧の印刷', async ({ page, browser }) => {
    const exportsAt: number[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/exports') && r.method() === 'POST') exportsAt.push(Date.now());
    });
    await stubPrint(page);
    await page.addInitScript(() => {
      const orig = window.print;
      window.print = () => {
        (window as unknown as { __printAt?: number }).__printAt = Date.now();
        orig();
      };
    });
    const border = logBorder();
    await openAs(page, 'admin', '園児');
    await mainOf(page).getByRole('link', { name: 'アレルギー一覧' }).click();
    await mainOf(page).getByRole('button', { name: '印刷する' }).click();
    await expect.poll(() => printCount(page), { message: '①印刷が呼ばれる' }).toBe(1);
    const printAt = await page.evaluate(() => (window as unknown as { __printAt?: number }).__printAt ?? 0);
    expect.soft(exportsAt.length > 0 && exportsAt[0] <= printAt, '①印刷の前に出力の記録を呼ぶ').toBe(true);
    expect.soft(logsAfter(border).some((l) => l.operation_type === '5' && l.account_id === accountIdOf(ACCOUNTS.admin.email)), '①操作ログに 5:出力（管理者）').toBe(true);
    await evidence(page, '07-021');
    const s = await newWindow(browser);
    try {
      await stubPrint(s.page);
      await loginWith(s.page, 'staff', ACCOUNTS.staffSakura.email, passwordOf('staffSakura'));
      await s.page.goto('/staff/children/allergies');
      const btn = s.page.getByRole('main').getByRole('button', { name: '印刷する' });
      await expect.soft(btn, '②一般も印刷できる').toBeVisible();
      if (await btn.count()) {
        await btn.click();
        expect.soft(await waitFor(() => printCount(s.page), 1), '②印刷が呼ばれる').toBe(1);
      }
      expect.soft(logsAfter(border).some((l) => l.operation_type === '5' && l.account_id === accountIdOf(ACCOUNTS.staffSakura.email)), '②操作ログに 5:出力（一般）').toBe(true);
    } finally {
      await s.context.close();
    }
  });

  /* 典拠：図/画面詳細図「アレルギー一覧画面」(7-4) 項目1・5 */
  test('07-022 クラスでの絞り込みと出力日時', async ({ page }) => {
    await openAs(page, 'admin', '園児');
    await mainOf(page).getByRole('link', { name: 'アレルギー一覧' }).click();
    await expect(mainOf(page).getByRole('heading', { level: 1 })).toContainText('アレルギー一覧');
    const cls = mainOf(page).getByRole('combobox', { name: /クラス/ });
    test.skip((await cls.count()) === 0, `まず回した：アレルギー一覧画面にクラスの絞り込みと出力日時が無い。${OUT_121}の 7-4 項目1・5`);
    await evidence(page, '07-022');
  });

  /* 典拠：基本設計書「CSV一括登録」(4-4)、図/画面詳細図 (7-3) の補足 */
  test('07-I013 園児ID 同じ取込の中で重複', async ({ page }) => {
    await openCsv(page);
    await pasteCsv(page, ['U07I013,受入 07-I013A,うけいれ,2024-05-20,1,さくら組,', 'U07I013,受入 07-I013B,うけいれ,2024-05-20,1,さくら組,']);
    const rowsText = `${await csvRow(page, '受入 07-I013A').first().innerText().catch(() => '')} ${await csvRow(page, '受入 07-I013B').first().innerText().catch(() => '')}`;
    expect.soft(rowsText, '重なる行が誤りとされる').toMatch(/重複|重な|すでに|使われ/);
    const register = mainOf(page).getByRole('button', { name: /件を登録する/ });
    if (await register.count()) await expect.soft(register, '「n 件を登録する」が押せない').toBeDisabled();
    expect.soft(Number(sqlValue("SELECT COUNT(*) FROM m_child WHERE child_id = 'U07I013'")), '1件も登録しない').toBe(0);
    await evidence(page, '07-I013');
  });
});

// =====================================================================
// 年度更新画面（【使い捨て】）
// =====================================================================

const FISCAL_SKIP = `まず回した：年度更新画面に「更新内容を確認する」が無く、「年度更新を実行する」は押せない（画面に「このモックアップでは、年度更新の実行を実装していません」）。${OUT_121}の 7-5 全体`;

async function openFiscal(page: Page): Promise<boolean> {
  await openAs(page, 'admin', '年度更新');
  const preview = mainOf(page).getByRole('button', { name: /更新内容を確認する/ });
  return (await preview.count()) > 0;
}

test.describe('年度更新画面（使い捨ての DB）', () => {
  test.use({ serverScope: 'test' });

  /* 典拠：要件定義書「年度更新」(4-1-3)・「年度更新に伴う引き継ぎ猶予期間」(4-1-2)、基本設計書「年度更新」(4-4)、図/画面詳細図「年度更新画面（管理者）」(7-5) 項目1〜3・5〜9 */
  test('07-023 更新内容の確認', async ({ page }) => {
    test.skip(!(await openFiscal(page)), FISCAL_SKIP);
    await evidence(page, '07-023');
  });

  /* 典拠：要件定義書「年度更新」(4-1-3)、基本設計書「年度更新」(4-4)・「クラスと紐づけ」(5-3)、図/画面詳細図 (7-5) 項目4・10 */
  test('07-024 個別に修正して実行する', async ({ page }) => {
    test.skip(!(await openFiscal(page)), FISCAL_SKIP);
    await evidence(page, '07-024');
  });

  /* 典拠：要件定義書「保護者アカウントの停止単位」(4-1-2)・「過去ログの参照範囲」(4-4 (c))、基本設計書「年度更新」(4-4)・「メッセージ一覧」(4-12) */
  test('07-025 卒園児の保護者は読めるが書けない', async ({ page }) => {
    test.skip(!(await openFiscal(page)), `${FISCAL_SKIP}。前提（年度更新の実行）を作れない`);
    await evidence(page, '07-025');
  });

  /* 典拠：要件定義書「年度更新に伴う引き継ぎ猶予期間」(4-1-2)、基本設計書「年度更新」(4-4)・「権限と利用可能機能」(6-1) の※1 */
  test('07-026 前の担任の引き継ぎ猶予期間', async ({ page }) => {
    test.skip(!(await openFiscal(page)), `${FISCAL_SKIP}。あわせて ${OUT_NEXT}（詳細設計書「判定の関数」(4-1 (2)) で引き継ぎ猶予期間中の前のクラスの閲覧は次の版）`);
    await evidence(page, '07-026');
  });
});

// =====================================================================
// 過年度のクラスグループ（サーバA。SQL で作る）
// =====================================================================

test.describe('過年度のクラスグループ（サーバA）', () => {
  /* 典拠：要件定義書「年度更新時の再編」(4-4 (b))・「過去ログの参照範囲」(4-4 (c))、基本設計書「年度更新」(4-4)・「メッセージの送受信」(4-7)・「権限と利用可能機能」(6-1) の※4、図/画面詳細図「グループ編成画面」(4-3) の補足 */
  test('07-027 過年度のクラスグループの閲覧の範囲', async ({ page, browser }) => {
    // 【SQL】(W2)
    const pastClass = Number(sqlValue("SELECT class_id FROM m_class WHERE fiscal_year = 2025 AND class_name = 'さくら組'"));
    expect(pastClass, '前提：2025年度のさくら組がある（テスト仕様書 2.2）').toBeGreaterThan(0);
    const roomName = '受入テスト 07-027 2025年度さくら組';
    const room = sqlRun("INSERT INTO m_chat_room (room_type, class_id, child_id, room_name, is_archived) VALUES ('2', ?, NULL, ?, 1)", pastClass, roomName);
    const fmt = (s: string) => (/^\d{4}-\d{2}-\d{2}T/.test(sampleValue('t_chat_member', 'joined_at') ?? '') ? s : s.replace('T', ' '));
    for (const email of [ACCOUNTS.staffSakura.email, ACCOUNTS.guardian.email]) {
      sqlRun('INSERT INTO t_chat_member (chat_room_id, account_id, joined_at, left_at) VALUES (?, ?, ?, ?)', room, accountIdOf(email), fmt('2025-04-01T08:00:00'), fmt('2026-03-31T23:59:59'));
    }
    sqlRun("INSERT INTO t_chat_message (chat_room_id, sender_account_id, body, source_type, sent_at, is_deleted) VALUES (?, ?, ?, '1', ?, 0)", room, accountIdOf(ACCOUNTS.staffSakura.email), '受入テスト 07-027 過年度のお知らせ', fmt('2026-03-10T10:00:00'));
    const messages = () => Number(sqlValue('SELECT COUNT(*) FROM t_chat_message WHERE chat_room_id = ?', room));
    const channel = (p: Page) => p.getByRole('main').getByRole('button', { name: new RegExp(`^${esc(roomName)}`) });

    // ① 一般S（過去にメンバーだった職員）
    await login(page, 'staffSakura');
    await goNav(page, 'チャット');
    await expect.soft(channel(page).first(), '①一般S：一覧に出る').toBeVisible();
    if (await channel(page).count()) {
      await channel(page).first().click();
      await expect.soft(mainOf(page).getByText('受入テスト 07-027 過年度のお知らせ'), '①メッセージが読める').toBeVisible();
      const box = mainOf(page).getByRole('textbox', { name: /メッセージ|本文|入力/ });
      if ((await box.count()) && (await box.first().isEditable().catch(() => false))) {
        await box.first().fill('受入テスト 07-027 投稿');
        await mainOf(page).getByRole('button', { name: /^(送信|送る)$/ }).first().click().catch(() => undefined);
        await page.waitForTimeout(1_000);
      }
      expect.soft(messages(), '①投稿できない').toBe(1);
    }
    await evidence(page, '07-027');
    // ② 一般K（所属したことがない）
    const k = await newWindow(browser);
    try {
      await loginWith(k.page, 'staff', ACCOUNTS.staffHimawari.email, passwordOf('staffHimawari'));
      await k.page.goto('/staff/chat');
      await expect(k.page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
      await k.page.waitForTimeout(800);
      await expect.soft(channel(k.page), '②一般K：一覧に出ない').toHaveCount(0);
    } finally {
      await k.context.close();
    }
    // ③ 管理者A
    const a = await newWindow(browser);
    try {
      await loginWith(a.page, 'staff', ACCOUNTS.admin.email, passwordOf('admin'));
      await a.page.goto('/staff/chat');
      await expect.soft(channel(a.page).first(), '③管理者A：一覧に出る').toBeVisible();
      if (await channel(a.page).count()) {
        await channel(a.page).first().click();
        await expect.soft(a.page.getByRole('main').getByText('受入テスト 07-027 過年度のお知らせ'), '③読める').toBeVisible();
      }
    } finally {
      await a.context.close();
    }
    // ④ 保護者N（過去にメンバーだった保護者）
    const g = await newWindow(browser, PHONE);
    try {
      await loginWith(g.page, 'guardian', ACCOUNTS.guardian.email, passwordOf('guardian'));
      await g.page.goto('/guardian/chat');
      await expect(g.page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
      await g.page.waitForTimeout(800);
      await expect.soft(channel(g.page), '④保護者N：一覧に出ない').toHaveCount(0);
      await expect.soft(g.page.getByText('受入テスト 07-027 過年度のお知らせ'), '④過去ログを読めない').toHaveCount(0);
    } finally {
      await g.context.close();
    }
  });
});

// =====================================================================
// 職員アカウント管理画面（サーバA）
// =====================================================================

test.describe('職員アカウント管理画面（サーバA）', () => {
  async function openStaffAccounts(page: Page) {
    await openAs(page, 'admin', '職員アカウント');
    await expect(mainOf(page).getByRole('button', { name: /アカウントを発行/ })).toBeVisible();
  }

  /* 典拠：要件定義書「アカウントの管理」(4-1-2)・「パスワードの再設定と一時パスワードの扱い」(4-1-1)・「セキュリティ要求」(8 No.3)、基本設計書「ログイン」(4-3)・「設定マスタ（m_setting）」(5-9)、図/画面詳細図 (7-6) 項目3・4・11 と補足 */
  test('07-028 職員アカウントの発行', async ({ page, browser }) => {
    const border = logBorder();
    const maxNo = Number(sqlValue("SELECT MAX(CAST(substr(staff_id, 2) AS INTEGER)) FROM m_staff WHERE staff_id GLOB 'S[0-9]*'") ?? 0);
    await openStaffAccounts(page);
    await mainOf(page).getByRole('button', { name: /アカウントを発行/ }).click();
    const d = page.getByRole('dialog', { name: /職員アカウントの発行/ });
    for (const label of [/^職員ID/, /^氏名/, /^ログインID/]) await expect.soft(d.getByRole('textbox', { name: label }), `①${String(label)}`).toBeVisible();
    for (const label of [/^ロール/, /^担当クラス/]) await expect.soft(d.getByRole('combobox', { name: label }), `①${String(label)}`).toBeVisible();
    const idValue = await d.getByRole('textbox', { name: /^職員ID/ }).inputValue();
    expect.soft(Number(/^S0*(\d+)$/.exec(idValue)?.[1] ?? NaN), `①職員IDが使われている番号の次（${idValue}）`).toBe(maxNo + 1);
    await d.getByRole('button', { name: 'やめる' }).click();
    const t1 = Date.now();
    const p1 = await issueStaffOnScreen(page, { name: '受入 職員 07-028A', email: 's07028a@hoiku.example.jp', className: 'さくら組' });
    await expect.soft(page.getByRole('status').filter({ hasText: '一時パスワード' }).first(), '②口頭または手渡しで伝える旨').toContainText(/口頭または手渡し/);
    expect.soft(p1, '②一時パスワードが出る').toBeTruthy();
    const p2 = await issueStaffOnScreen(page, { name: '受入 職員 07-028B', email: 's07028b@hoiku.example.jp', className: 'ひまわり組' });
    expect.soft(p2, '②2人目の一時パスワード').toBeTruthy();
    expect.soft(await shownTempPassword(page, '受入 職員 07-028A'), '③1人目の表示が消えずに並ぶ').toBe(p1);
    await evidence(page, '07-028');
    await page.getByRole('status').filter({ hasText: '一時パスワード' }).getByRole('button', { name: '閉じる' }).first().click().catch(() => undefined);
    await expect.soft(page.getByText(p1 ?? '（なし）'), '④閉じたあと出し直す手段が無い').toHaveCount(0);
    await expect.soft(mainOf(page).getByRole('button', { name: /一時パスワードを(表示|見る)/ }), '④出し直すボタンが無い').toHaveCount(0);
    expect.soft(await columnNames(page), '⑤列').toEqual(['職員ID', '氏名', 'ログインID', 'ロール', '担当クラス', '状態', '操作']);
    await expect.soft(staffRow(page, 's07028a@hoiku.example.jp'), '⑤行').toContainText(/受入 職員 07-028A.*一般.*さくら組.*有効/);
    const acc = sqlAll("SELECT a.role, a.status, a.is_temp_password, a.temp_password_expires_at FROM m_account a WHERE a.email = 's07028a@hoiku.example.jp'")[0];
    expect.soft(String(acc?.role), '⑥role＝2').toBe('2');
    expect.soft(String(acc?.status), '⑥status＝1').toBe('1');
    expect.soft(Number(acc?.is_temp_password), '⑥is_temp_password').toBe(1);
    const expires = acc?.temp_password_expires_at ? new Date(`${String(acc.temp_password_expires_at).replace(' ', 'T')}+09:00`).getTime() : NaN;
    expect.soft(Math.abs(expires - (t1 + 48 * 3600_000)) < 10 * 60_000, `⑥期限が48時間後（${String(acc?.temp_password_expires_at)}）`).toBe(true);
    expect.soft(Number(sqlValue("SELECT COUNT(*) FROM t_class_staff cs JOIN m_staff s ON s.staff_id = cs.staff_id JOIN m_account a ON a.account_id = s.account_id JOIN m_class c ON c.class_id = cs.class_id WHERE a.email = 's07028a@hoiku.example.jp' AND c.class_name = 'さくら組' AND c.fiscal_year = (SELECT MAX(fiscal_year) FROM m_class)")), '⑥t_class_staff').toBe(1);
    expect.soft(logsAfter(border).filter((l) => l.function_type === '7' && l.operation_type === '1').length >= 2, '⑦操作ログ 7:1 が2つ').toBe(true);
    if (p1) {
      const w = await newWindow(browser);
      try {
        const path = await loginWith(w.page, 'staff', 's07028a@hoiku.example.jp', p1);
        await expect.soft(w.page.getByRole('heading', { level: 1 }), `⑧パスワード変更画面へ進む（${path}）`).toContainText(/パスワード/);
      } finally {
        await w.context.close();
      }
    }
  });

  /* 典拠：要件定義書「クラスと担任の紐づけ」(4-1-2)・「参照範囲の全体規定」(4-1-5)、基本設計書「職員の情報の変更」(4-3)、図/画面詳細図 (7-6) 項目4・8・(1-1) 項目3、詳細設計書「連絡帳（クラス）画面」(2-2 (9)) */
  test('07-029 担当クラスの無い一般（フリー）', async ({ page, browser }) => {
    await openStaffAccounts(page);
    await mainOf(page).getByRole('button', { name: /アカウントを発行/ }).click();
    const d = page.getByRole('dialog', { name: /職員アカウントの発行/ });
    const cls = d.getByRole('combobox', { name: /^担当クラス/ });
    await expect.soft(cls.locator('option').first(), '①先頭の選択肢が「割り当てない（フリー）」').toHaveText(/割り当てない（フリー）/);
    await cls.selectOption({ index: 0 });
    const guide = (await d.innerText()).replace(/\s+/g, ' ');
    expect.soft(guide, '②全クラスを閲覧のみで見られる旨').toMatch(/全クラス.*閲覧/);
    expect.soft(guide, '②「表示されません」の旨ではない').not.toMatch(/表示されません/);
    await d.getByRole('button', { name: 'やめる' }).click();
    const temp = await issueStaffOnScreen(page, { name: '受入 職員 07-029', email: 's07029@hoiku.example.jp', className: 'free' });
    await expect.soft(staffRow(page, 's07029@hoiku.example.jp'), '③「フリー」の印').toContainText('フリー');
    await evidence(page, '07-029');
    expect(temp, '前提：一時パスワードを画面から読めた').toBeTruthy();
    const w = await newWindow(browser);
    try {
      await staffFirstLogin(w.page, { email: 's07029@hoiku.example.jp', tempPassword: temp!, password: 'ukeire-s07029-pw' });
      await expect.soft(w.page.getByRole('banner'), '④ヘッダに「フリー」').toContainText('フリー');
      await expect.soft(w.page.getByRole('main'), '⑤全クラスを閲覧のみで見られる旨').toContainText(/全クラス.*閲覧/);
      await expect.soft(w.page.getByRole('main'), '⑤割り当ての誤りなら管理者へ').toContainText(/管理者/);
      await w.page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '園児', exact: true }).click();
      const wm = w.page.getByRole('main');
      const classOptions = await wm.getByRole('combobox', { name: 'クラス', exact: true }).locator('option').allInnerTexts().catch(() => [] as string[]);
      const rowsClasses = (await dataRows(w.page).evaluateAll((rows) => rows.map((r) => (r as HTMLTableRowElement).cells[4]?.textContent?.trim() ?? ''))).filter(Boolean);
      const seen = new Set([...classOptions, ...rowsClasses]);
      for (const c of ['さくら組', 'ひまわり組', 'もも組']) expect.soft(seen.has(c), `⑥園児一覧で${c}を見られる`).toBe(true);
      await expect.soft(wm.getByRole('link', { name: /新規登録|編集/ }), '⑥新規登録・編集が無い').toHaveCount(0);
      await w.page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '連絡帳', exact: true }).click();
      await w.page.waitForTimeout(800);
      const contactClasses = await wm.getByRole('combobox').first().locator('option').allInnerTexts().catch(() => [] as string[]);
      expect.soft(['さくら組', 'ひまわり組', 'もも組'].every((c) => contactClasses.some((o) => o.includes(c))), `⑦連絡帳（クラス）画面で全クラスを選べる（${contactClasses.join('・')}）`).toBe(true);
      await expect.soft(wm.getByRole('button', { name: /^記録する$|確認しました/ }), '⑦記録のボタンが出ない').toHaveCount(0);
    } finally {
      await w.context.close();
    }
  });

  /* 典拠：要件定義書「パスワードの再設定と一時パスワードの扱い」(4-1-1)、基本設計書「一時パスワードの再発行」(4-3)、図/画面詳細図 (7-6) 項目10・11・(0-2) の確認ダイアログ */
  test('07-030 一時パスワードの再発行', async ({ page, browser, playwright }) => {
    const api = await adminApi(playwright);
    const w = await newWindow(browser);
    try {
      const staff = await makeStaffReady(w.page, api, '07-030');
      await loginWith(w.page, 'staff', staff.email, staff.password);
      const border = logBorder();
      await openStaffAccounts(page);
      const t0 = Date.now();
      await staffRow(page, staff.email).getByRole('button', { name: /一時パスワード再発行/ }).click();
      const d = page.getByRole('dialog').last();
      await expect.soft(d, '①確認ダイアログ').toBeVisible();
      await d.getByRole('button', { name: /再発行する/ }).click();
      await expect(page.getByRole('dialog', { name: /再発行/ })).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByRole('status').getByRole('listitem').filter({ hasText: staff.name }).first()).toBeVisible({ timeout: 10_000 }).catch(() => undefined);
      const temp = await shownTempPassword(page, staff.name);
      expect.soft(temp, '②新しい一時パスワードが出る').toBeTruthy();
      await evidence(page, '07-030');
      await w.page.reload();
      await expect.soft(w.page.getByLabel('ログインID', { exact: true }), '③職員の文脈のセッションが無効になり、職員用トップへ戻る').toBeVisible({ timeout: 15_000 });
      const w2 = await newWindow(browser);
      try {
        expect.soft(await loginError(w2.page, 'staff', staff.email, staff.password), '④前のパスワードは使えない').toContain(MSG.credential);
        if (temp) {
          await loginWith(w2.page, 'staff', staff.email, temp);
          await expect.soft(w2.page.getByRole('heading', { level: 1 }), '⑤パスワード変更画面へ').toContainText(/パスワード/);
        }
      } finally {
        await w2.context.close();
      }
      const acc = sqlAll('SELECT is_temp_password, temp_password_expires_at, account_id FROM m_account WHERE email = ?', staff.email)[0];
      expect.soft(Number(acc?.is_temp_password), '⑥is_temp_password').toBe(1);
      const expires = acc?.temp_password_expires_at ? new Date(`${String(acc.temp_password_expires_at).replace(' ', 'T')}+09:00`).getTime() : NaN;
      expect.soft(Math.abs(expires - (t0 + 48 * 3600_000)) < 10 * 60_000, '⑥期限が再発行の48時間後').toBe(true);
      expect.soft(logsAfter(border).some((l) => l.function_type === '7' && (l.target_id === Number(acc?.account_id) || (l.after_value ?? '').includes(staff.name))), '⑦操作ログに再発行の行（対象がその職員）').toBe(true);
    } finally {
      await w.context.close();
    }
  });

  /* 典拠：要件定義書「アカウントの管理」(4-1-2)、基本設計書「アカウントの停止と再開」(4-3)・「メッセージ一覧」(4-12)、図/画面詳細図 (7-6) 項目9 */
  test('07-031 職員アカウントの停止と再開', async ({ page, browser, playwright }) => {
    const api = await adminApi(playwright);
    const w = await newWindow(browser);
    try {
      const staff = await makeStaffReady(w.page, api, '07-031');
      await loginWith(w.page, 'staff', staff.email, staff.password);
      const border = logBorder();
      await openStaffAccounts(page);
      await staffRow(page, staff.email).getByRole('button', { name: '停止' }).click();
      const d = page.getByRole('dialog').last();
      await expect.soft(d, '①確認ダイアログに対象の氏名').toContainText(staff.name);
      await expect.soft(d, '①停止すると何が起きるか').toContainText(/ログインできなく/);
      await d.getByRole('button', { name: /停止する/ }).click();
      await expect.soft(staffRow(page, staff.email), '②状態が「停止」').toContainText('停止');
      await w.page.reload();
      await expect.soft(w.page.getByLabel('ログインID', { exact: true }), '③職員の文脈のセッションが閉じる').toBeVisible({ timeout: 15_000 });
      const w2 = await newWindow(browser);
      try {
        expect.soft(await loginError(w2.page, 'staff', staff.email, staff.password), '④停止中').toContain(MSG.suspended);
        await staffRow(page, staff.email).getByRole('button', { name: '再開' }).click();
        const d2 = page.getByRole('dialog').last();
        if (await d2.count()) await d2.getByRole('button', { name: /再開する/ }).click();
        await expect.soft(staffRow(page, staff.email), '⑤状態が「有効」').toContainText('有効');
        await evidence(page, '07-031');
        await loginWith(w2.page, 'staff', staff.email, staff.password).catch(() => undefined);
        await expect.soft(w2.page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), '⑤ログインできる').toBeVisible();
      } finally {
        await w2.context.close();
      }
      const accountId = accountIdOf(staff.email);
      expect.soft(String(sqlValue('SELECT status FROM m_account WHERE account_id = ?', accountId)), '⑥status＝1').toBe('1');
      const rows = logsAfter(border).filter((l) => l.function_type === '7' && (l.target_id === accountId || `${l.before_value}${l.after_value}`.includes(staff.name)));
      expect.soft(rows.length >= 2, '⑦停止と再開の行（対象がその職員）').toBe(true);
    } finally {
      await w.context.close();
    }
  });

  /* 典拠：要件定義書「管理者アカウントの復旧経路」(4-1-1)、基本設計書「アカウントの停止と再開」(4-3)・「職員の情報の変更」(4-3)、図/画面詳細図 (7-6) 項目7・9 */
  test('07-032 自分の行・ほかの管理者の停止・管理者が1名になる警告', async ({ page }) => {
    await openStaffAccounts(page);
    const self = staffRow(page, ACCOUNTS.admin.email);
    await expect.soft(self.getByRole('button', { name: '停止' }), '①自分の行に「停止」が無い').toHaveCount(0);
    await self.getByRole('button', { name: '変更' }).click();
    const edit = page.getByRole('dialog', { name: /職員の情報の変更/ });
    const role = edit.getByRole('combobox', { name: /^ロール/ });
    await expect.soft(role, '②自分のロールは変えられない').toBeDisabled();
    await edit.getByRole('button', { name: 'やめる' }).click();
    await staffRow(page, ACCOUNTS.admin2.email).getByRole('button', { name: '停止' }).click();
    const stop = page.getByRole('dialog').last();
    await expect.soft(stop, '③管理者である旨').toContainText('管理者');
    await expect.soft(stop, '③管理者が1名になる警告').toContainText(/管理者が\s*1\s*名/);
    await evidence(page, '07-032');
    await stop.getByRole('button', { name: 'やめる' }).click();
    await staffRow(page, ACCOUNTS.admin2.email).getByRole('button', { name: '変更' }).click();
    const edit2 = page.getByRole('dialog', { name: /職員の情報の変更/ });
    await edit2.getByRole('combobox', { name: /^ロール/ }).selectOption({ label: '一般（保育士）' });
    await expect.soft(edit2, '④ロールを一般にすると、管理者が1名になる警告').toContainText(/管理者が\s*1\s*名/);
    await edit2.getByRole('button', { name: 'やめる' }).click();
    const b = sqlAll('SELECT role, status FROM m_account WHERE email = ?', ACCOUNTS.admin2.email)[0];
    expect.soft(`${String(b?.role)}/${String(b?.status)}`, '⑤何も変わらない').toBe('1/1');
  });

  /* 典拠：基本設計書「職員の情報の変更」(4-3)、図/画面詳細図 (7-6) 項目6〜8・12・13、インタフェース一覧「経路ごとの要求と応答の補足」(1-1) */
  test('07-033 職員の情報の変更', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const staff = await makeStaffIssued(api, '07-033');
    const border = logBorder();
    await openStaffAccounts(page);
    await staffRow(page, staff.email).getByRole('button', { name: '変更' }).click();
    const d = page.getByRole('dialog', { name: /職員の情報の変更/ });
    await expect.soft(d.getByRole('textbox', { name: /^職員ID/ }), '①職員IDは変えられない').toBeDisabled();
    const loginBox = d.getByRole('textbox', { name: /ログインID/ });
    if (await loginBox.count()) await expect.soft(loginBox, '①ログインIDは変えられない').toBeDisabled();
    await d.getByRole('textbox', { name: /^氏名/ }).fill('受入 職員 07-033 改');
    await d.getByRole('combobox', { name: /^担当クラス/ }).selectOption({ label: 'ひまわり組' });
    await d.getByRole('button', { name: '変更する' }).click();
    await expect.soft(staffRow(page, staff.email), '②一覧の氏名と担当クラス').toContainText(/受入 職員 07-033 改.*ひまわり組/);
    expect.soft(String(sqlValue('SELECT staff_name FROM m_staff WHERE staff_id = ?', staff.staffId)), '③staff_name').toBe('受入 職員 07-033 改');
    expect.soft(sqlAll('SELECT c.class_name FROM t_class_staff cs JOIN m_class c ON c.class_id = cs.class_id WHERE cs.staff_id = ? AND c.fiscal_year = (SELECT MAX(fiscal_year) FROM m_class)', staff.staffId).map((r) => String(r.class_name)), '③t_class_staff').toEqual(['ひまわり組']);
    const log = logsAfter(border).find((l) => l.function_type === '7' && l.operation_type === '2');
    expect.soft(`${log?.before_value ?? ''} ${log?.after_value ?? ''}`, '④変更の前後（氏名）').toMatch(/受入 職員 07-033[^改]*受入 職員 07-033 改|受入 職員 07-033 改/);
    expect.soft(log?.before_value ?? '', '④変更前').toContain('受入 職員 07-033');
    await evidence(page, '07-033');
  });

  /* 典拠：要件定義書「アプリのログイン」(4-1-1) のアカウントロックの解除、基本設計書「ログイン」(4-3)・「メッセージ一覧」(4-12)、図/画面詳細図 (7-6) 項目4・5 */
  test('07-034 ロックの解除', async ({ page, browser, playwright }) => {
    const api = await adminApi(playwright);
    const w = await newWindow(browser);
    try {
      const staff = await makeStaffReady(w.page, api, '07-034');
      // 【SQL】(W1)
      const until = jstDateTime(new Date(Date.now() + 30 * 60_000), sampleValue('m_account', 'created_at'));
      sqlRun('UPDATE m_account SET failed_login_count = 5, locked_until = ? WHERE email = ?', until, staff.email);
      expect.soft(await loginError(w.page, 'staff', staff.email, staff.password), '①ロック中').toContain(MSG.locked);
      const border = logBorder();
      await openStaffAccounts(page);
      const row = staffRow(page, staff.email);
      await expect.soft(row, '②ロックが強調される').toContainText('ロック');
      await row.getByRole('button', { name: 'ロック解除' }).click();
      const d = page.getByRole('dialog').last();
      if (await d.count()) await d.getByRole('button', { name: /解除/ }).last().click();
      await evidence(page, '07-034');
      await loginWith(w.page, 'staff', staff.email, staff.password).catch(() => undefined);
      await expect.soft(w.page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), '③すぐにログインできる').toBeVisible();
      const acc = sqlAll('SELECT failed_login_count, locked_until FROM m_account WHERE email = ?', staff.email)[0];
      expect.soft(`${Number(acc?.failed_login_count)}/${acc?.locked_until ?? ''}`, '④failed_login_count＝0、locked_until が空').toBe('0/');
      expect.soft(logsAfter(border).some((l) => l.function_type === '7'), '⑤操作ログに解除の行').toBe(true);
    } finally {
      await w.context.close();
    }
  });

  /* 典拠：図/画面詳細図「職員アカウント管理画面（管理者）」(7-6) 項目1・2・4 */
  test('07-035 状態での絞り込みと最終ログイン', async ({ page }) => {
    await openStaffAccounts(page);
    const state = mainOf(page).getByRole('combobox', { name: /状態/ });
    test.skip((await state.count()) === 0, `まず回した：職員アカウント管理画面に状態の絞り込みと最終ログインの列が無い。${OUT_121}の 7-6 項目1・2・4`);
    await evidence(page, '07-035');
  });

  /* 典拠：授業の雛形 1.5、基本設計書「操作ログ（t_operation_log）」(5-9) */
  test('07-036 クロスサイトスクリプティング（職員の氏名）', async ({ page }) => {
    const alerts = await watchAlerts(page);
    const name = `受入07-036<b>太字</b>${XSS_SCRIPT}`;
    await openStaffAccounts(page);
    await issueStaffOnScreen(page, { name, email: 's07036@hoiku.example.jp', className: 'もも組' });
    await expect.soft(staffRow(page, 's07036@hoiku.example.jp'), '①一覧でタグが文字のまま').toContainText(name);
    await expect.soft(mainOf(page).locator('table b'), '①太字にならない').toHaveCount(0);
    await evidence(page, '07-036');
    await goNav(page, '操作ログ');
    await expect.soft(mainOf(page).locator('table b'), '①操作ログでも太字にならない').toHaveCount(0);
    expect.soft(alerts, '②alert が出ない').toEqual([]);
    expect.soft(String(sqlValue("SELECT s.staff_name FROM m_staff s JOIN m_account a ON a.account_id = s.account_id WHERE a.email = 's07036@hoiku.example.jp'")), '④SQL').toBe(name);
  });

  /* 典拠：授業の雛形 1.5、要件定義書「ログインIDの定義」(4-1-1) */
  test('07-037 二重送信（職員の発行）', async ({ page }) => {
    await openStaffAccounts(page);
    await mainOf(page).getByRole('button', { name: /アカウントを発行/ }).click();
    const d = page.getByRole('dialog', { name: /職員アカウントの発行/ });
    await d.getByRole('textbox', { name: /^氏名/ }).fill('受入 職員 07-037');
    await d.getByRole('textbox', { name: /^ログインID/ }).fill('s07037@hoiku.example.jp');
    await d.getByRole('combobox', { name: /^担当クラス/ }).selectOption({ label: 'さくら組' });
    await d.getByRole('button', { name: '発行する' }).dblclick().catch(() => undefined);
    await page.waitForTimeout(1_500);
    expect.soft(Number(sqlValue("SELECT COUNT(*) FROM m_account WHERE email = 's07037@hoiku.example.jp'")), '①アカウントは1つだけ').toBe(1);
    expect.soft(await page.getByRole('status').getByRole('listitem').filter({ hasText: '受入 職員 07-037' }).count(), '②一時パスワードは1つだけ出る').toBe(1);
    await evidence(page, '07-037');
    await page.reload();
    expect.soft(Number(sqlValue("SELECT COUNT(*) FROM m_account WHERE email = 's07037@hoiku.example.jp'")), '③再読み込みで増えない').toBe(1);
  });

  /* 典拠：要件定義書「ログインIDの定義」(4-1-1)、基本設計書「アカウント（m_account）」(5-2)・「職員の情報の変更」(4-3)・「メッセージ一覧」(4-12)、図/画面詳細図 (0-2) のダイアログの中の誤り */
  test('07-I014 ログインID 停止中の保護者と同じ', async ({ page }) => {
    await openStaffAccounts(page);
    await mainOf(page).getByRole('button', { name: /アカウントを発行/ }).click();
    const d = page.getByRole('dialog', { name: /職員アカウントの発行/ });
    await d.getByRole('textbox', { name: /^氏名/ }).fill('受入 職員 07-I014');
    await d.getByRole('textbox', { name: /^ログインID/ }).fill(ACCOUNTS.guardianSuspended.email);
    await d.getByRole('button', { name: '発行する' }).click();
    await page.waitForTimeout(800);
    await expect.soft(d, '発行されない（ダイアログが残る）').toBeVisible();
    await expect.soft(d, 'ダイアログの中に文言').toContainText(MSG.emailDup);
    expect.soft(Number(sqlValue("SELECT COUNT(*) FROM m_staff WHERE staff_name = '受入 職員 07-I014'")), 'SQL：発行されない').toBe(0);
    await evidence(page, '07-I014');
  });
});

// =====================================================================
// 招待コード管理画面（サーバA）
// =====================================================================

test.describe('招待コード管理画面（サーバA）', () => {
  async function openInvitations(page: Page) {
    await openAs(page, 'admin', '招待コード');
    await expect(mainOf(page).getByRole('button', { name: '1枚発行' })).toBeVisible();
  }

  /** 「1枚発行」のダイアログで発行する */
  async function issueOne(page: Page, childLabel: RegExp, days: string, options: { dbl?: boolean; className?: string } = {}) {
    await mainOf(page).getByRole('button', { name: '1枚発行' }).click();
    const d = page.getByRole('dialog', { name: /招待コードの発行/ });
    await d.getByRole('combobox', { name: /クラス/ }).selectOption({ label: options.className ?? 'さくら組' });
    const opt = (await d.getByRole('combobox', { name: /園児/ }).locator('option').allInnerTexts()).find((t) => childLabel.test(t));
    expect(opt, `園児の選択肢に ${String(childLabel)}`).toBeTruthy();
    await d.getByRole('combobox', { name: /園児/ }).selectOption({ label: opt! });
    await d.getByRole('spinbutton', { name: /有効期限/ }).fill(days);
    const issue = d.getByRole('button', { name: '発行する' });
    if (options.dbl) await issue.dblclick().catch(() => undefined);
    else if (await issue.isEnabled()) await issue.click();
    return d;
  }

  const CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

  /* 典拠：要件定義書「招待コードの発行」(4-1-2)・「招待コードの保護」(8 No.8)、基本設計書「招待コード（t_invitation_code）」(5-2)、図/画面詳細図 (7-7) 項目4・7 */
  test('07-038 招待コードの1枚発行', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-038');
    await openInvitations(page);
    await mainOf(page).getByRole('button', { name: '1枚発行' }).click();
    const d0 = page.getByRole('dialog', { name: /招待コードの発行/ });
    await expect.soft(d0.getByRole('combobox', { name: /クラス/ }), '①クラス').toBeVisible();
    await expect.soft(d0.getByRole('combobox', { name: /園児/ }), '①園児').toBeVisible();
    await expect.soft(d0.getByRole('spinbutton', { name: /有効期限/ }), '①有効期限').toBeVisible();
    await d0.getByRole('button', { name: 'やめる' }).click();
    await issueOne(page, /受入 07-038/, '7');
    await expect(page.getByRole('dialog', { name: /招待コードの発行/ })).toHaveCount(0);
    await issueOne(page, /受入 07-038/, '7');
    await expect(page.getByRole('dialog', { name: /招待コードの発行/ })).toHaveCount(0);
    const codes = sqlAll('SELECT code, status, expires_on FROM t_invitation_code WHERE child_id = ? ORDER BY invitation_code_id', child.childId);
    expect.soft(codes.length, '⑤2行').toBe(2);
    const today = jstToday();
    for (const c of codes) {
      expect.soft(String(c.code), `③コードの形（0・O・1・I・l を含まない）：${String(c.code)}`).toMatch(CODE);
      expect.soft(String(c.status), '⑤status＝1').toBe('1');
      expect.soft(String(c.expires_on), '⑤expires_on＝きょう＋7日').toBe(addDays(today, 7));
    }
    expect.soft(new Set(codes.map((c) => String(c.code))).size, '⑤2つのコードが違う').toBe(2);
    const rows = mainOf(page).getByRole('row').filter({ hasText: String(codes[0]?.code ?? '----') });
    await expect.soft(rows.first(), '②発行日・有効期限・状態').toContainText(new RegExp(`${esc(slash(today))}.*${esc(slash(addDays(today, 7)))}.*未使用`));
    // ④ 同じ園児の2枚がまとめて見られる（並んで出る）
    const allCodes = (await dataRows(page).evaluateAll((rs) => rs.map((r) => r.textContent ?? ''))).map((t) => t.replace(/\s+/g, ' '));
    const idx = codes.map((c) => allCodes.findIndex((t) => t.includes(String(c.code))));
    expect.soft(idx.every((i) => i >= 0) && Math.abs(idx[0] - idx[1]) === 1, `④同じ園児の2枚が並ぶ（${idx.join(',')}）`).toBe(true);
    await rows.first().scrollIntoViewIfNeeded().catch(() => undefined);
    await evidence(page, '07-038');
  });

  /* 典拠：要件定義書「招待コードの一括発行・配布用出力」(4-1-2)、基本設計書「招待コード（t_invitation_code）」(5-2)、図/画面詳細図 (7-7) 項目5・9〜15、インタフェース一覧 (1-1) の POST /api/admin/invitations/bulk */
  test('07-039 一括発行', async ({ page }) => {
    const today = jstToday();
    const n = enrolledCount('さくら組');
    const usable = () =>
      Number(
        sqlValue(
          `SELECT COUNT(DISTINCT ic.child_id) FROM t_invitation_code ic
             JOIN t_class_child cc ON cc.child_id = ic.child_id JOIN m_class cl ON cl.class_id = cc.class_id
             JOIN m_child c ON c.child_id = ic.child_id
            WHERE cl.class_name = 'さくら組' AND cl.fiscal_year = (SELECT MAX(fiscal_year) FROM m_class)
              AND c.is_deleted = 0 AND c.enrollment_status = '1' AND ic.status = '1' AND ic.expires_on >= ?`,
          today,
        ) ?? 0,
      );
    const sakuraCodes = () => Number(sqlValue("SELECT COUNT(*) FROM t_invitation_code ic JOIN t_class_child cc ON cc.child_id = ic.child_id JOIN m_class cl ON cl.class_id = cc.class_id WHERE cl.class_name = 'さくら組' AND cl.fiscal_year = (SELECT MAX(fiscal_year) FROM m_class)") ?? 0);
    const k = usable();
    await openInvitations(page);
    await mainOf(page).getByRole('button', { name: '一括発行' }).click();
    const d = page.getByRole('dialog', { name: /一括発行/ });
    await d.getByRole('combobox', { name: /クラス/ }).selectOption({ label: 'さくら組' });
    await expect.soft(d.getByRole('spinbutton', { name: /枚数/ }), '①枚数の初期値2').toHaveValue('2');
    await expect.soft(d.getByRole('spinbutton', { name: /有効期限/ }), '①有効期限の初期値30日').toHaveValue('30');
    const plan = (await d.innerText()).replace(/\s+/g, ' ');
    expect.soft(plan, `②発行予定 (${n}−${k})×2`).toMatch(new RegExp(`${(n - k) * 2}\\s*枚`));
    expect.soft(plan, `②除いた人数 ${k}`).toMatch(new RegExp(`${k}\\s*名を除く|除[^0-9]*${k}\\s*名`));
    const before = sakuraCodes();
    await d.getByRole('button', { name: '発行する' }).click();
    await expect(d).toHaveCount(0, { timeout: 15_000 });
    const done = (await page.getByRole('status').allInnerTexts()).join(' ');
    expect.soft(done, `③完了の表示に飛ばした人数 ${k}`).toMatch(new RegExp(`${k}\\s*名`));
    expect.soft(sakuraCodes() - before, '③増えた枚数').toBe((n - k) * 2);
    expect.soft(Number(sqlValue('SELECT COUNT(*) FROM t_invitation_code WHERE expires_on = ? AND created_at >= ?', addDays(today, 30), today)), '③有効期限がきょう＋30日').toBe((n - k) * 2);
    await evidence(page, '07-039');
    await mainOf(page).getByRole('button', { name: '一括発行' }).click();
    const d2 = page.getByRole('dialog', { name: /一括発行/ });
    await d2.getByRole('combobox', { name: /クラス/ }).selectOption({ label: 'さくら組' });
    const plan2 = (await d2.innerText()).replace(/\s+/g, ' ');
    expect.soft(plan2, '④発行予定が0枚').toMatch(/(^|[^0-9])0\s*枚/);
    const check = d2.getByRole('checkbox', { name: /にも発行する/ });
    await expect.soft(check, `④「使えるコードをすでに持つ ${n} 名にも発行する」`).toHaveAccessibleName(new RegExp(`${n}\\s*名にも発行する`));
    await check.check();
    expect.soft((await d2.innerText()).replace(/\s+/g, ' '), `⑤発行予定が ${n * 2} 枚`).toMatch(new RegExp(`${n * 2}\\s*枚`));
    const before2 = sakuraCodes();
    await d2.getByRole('button', { name: 'やめる' }).click();
    expect.soft(sakuraCodes(), '⑥「やめる」で発行しない').toBe(before2);
  });

  /* 典拠：要件定義書「招待コードの失効」(4-1-2)、基本設計書「メッセージ一覧」(4-12) の招待コードが失効、図/画面詳細図 (7-7) 項目1〜3・8 */
  test('07-040 招待コードの失効と絞り込み', async ({ page, playwright, browser }) => {
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-040', { suffix: 'R' });
    const code = await issueCode(api, child.childId, 7);
    await makeChild(api, '07-040', { suffix: 'M', className: 'もも組' }).then((c) => issueCode(api, c.childId, 7)); // もも組のコード（絞り込みの相手）
    const g = await newWindow(browser, PHONE);
    let used: string;
    try {
      const made = await makeGuardian(g.page, api, '07-040');
      used = String(sqlValue("SELECT code FROM t_invitation_code WHERE child_id = ? AND status = '2'", made.childId));
    } finally {
      await g.context.close();
    }
    await openInvitations(page);
    const row = mainOf(page).getByRole('row').filter({ hasText: code });
    await row.getByRole('button', { name: '失効' }).click();
    const d = page.getByRole('dialog', { name: /失効/ });
    await expect.soft(d, '①元に戻せない旨').toContainText(/元には?戻せ/);
    await d.getByRole('button', { name: /失効する/ }).click();
    await expect.soft(row, '②状態が「失効」').toContainText('失効');
    expect.soft(String(sqlValue('SELECT status FROM t_invitation_code WHERE code = ?', code)), '②SQL').toBe('3');
    const m = mainOf(page);
    const rowTexts = async () => (await dataRows(page).evaluateAll((rs) => rs.map((r) => r.textContent ?? ''))).map((t) => t.replace(/\s+/g, ' '));
    await m.getByRole('combobox', { name: '状態' }).selectOption({ label: '失効' });
    await m.getByRole('button', { name: '絞り込む' }).click();
    const onlyRevoked = async () => {
      const t = await rowTexts();
      return t.length > 0 && t.every((x) => x.includes('失効')) && t.some((x) => x.includes(code));
    };
    expect.soft(await waitFor(onlyRevoked, true), `③状態「失効」で失効のコードだけ（${(await rowTexts()).join(' / ').slice(0, 300)}）`).toBe(true);
    await m.getByRole('combobox', { name: '状態' }).selectOption({ label: 'すべて' });
    await m.getByRole('combobox', { name: 'クラス' }).selectOption({ label: 'もも組' });
    await m.getByRole('button', { name: '絞り込む' }).click();
    const onlyMomo = async () => {
      const t = (await rowTexts()).filter((x) => /（[A-Z0-9]+・/.test(x));
      return t.length > 0 && t.every((x) => x.includes('もも組'));
    };
    expect.soft(await waitFor(onlyMomo, true), `③クラス「もも組」ではもも組の園児のコードだけ（${(await rowTexts()).join(' / ').slice(0, 300)}）`).toBe(true);
    await m.getByRole('combobox', { name: 'クラス' }).selectOption({ label: 'すべて' });
    await m.getByRole('button', { name: '絞り込む' }).click();
    await expect.soft(m.getByRole('row').filter({ hasText: used }).getByRole('button', { name: '失効' }), '④使用済のコードの行に「失効」が出ない').toHaveCount(0);
    await evidence(page, '07-040');
    const s = await newWindow(browser, PHONE);
    try {
      await s.page.goto('/signup');
      await s.page.getByRole('textbox', { name: /招待コード/ }).fill(code);
      await s.page.getByRole('button', { name: 'コードを確認する' }).click();
      await expect.soft(s.page.getByRole('main'), '⑤失効の文言').toContainText(MSG.revoked);
    } finally {
      await s.context.close();
    }
  });

  /* 典拠：要件定義書「招待コードの一括発行・配布用出力」(4-1-2)、基本設計書「招待コード（t_invitation_code）」(5-2)・「操作ログ（t_operation_log）」(5-9)、図/画面詳細図 (7-7) 項目6 */
  test('07-041 配布用に出力', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-041');
    const c1 = await issueCode(api, child.childId, 7);
    const c2 = await issueCode(api, child.childId, 7);
    await stubPrint(page);
    const border = logBorder();
    await openInvitations(page);
    await mainOf(page).getByRole('button', { name: '配布用に出力' }).click();
    const d = page.getByRole('dialog', { name: /配布用/ });
    const text = (await d.innerText()).replace(/\s+/g, ' ');
    expect.soft(text, '①園児名').toContain(child.childName);
    expect.soft(text.includes(c1) && text.includes(c2), '①同じ園児の2枚').toBe(true);
    // 「お子さまのお名前 〇〇 … 招待コード XXXX-XXXX-XXXX」の並び。同じ園児のコードが続けて出るか
    const cards = [...text.matchAll(/お子さまのお名前\s*(.+?)\s*招待コード\s*([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/g)].map((mm) => ({ name: mm[1], code: mm[2] }));
    const at = [cards.findIndex((cc) => cc.code === c1), cards.findIndex((cc) => cc.code === c2)];
    const grouped = cards.length > 0 ? at.every((i) => i >= 0) && Math.abs(at[0] - at[1]) === 1 : text.indexOf(child.childName) >= 0;
    expect.soft(grouped, `①園児ごとにまとめて並ぶ（${at.join(',')}）`).toBe(true);
    expect.soft(text, '①有効期限').toContain(slash(addDays(jstToday(), 7)));
    expect.soft(text, '①登録手順').toMatch(/手順|登録のしかた|新規登録/);
    await evidence(page, '07-041');
    await d.getByRole('button', { name: '印刷する' }).click();
    expect.soft(await waitFor(() => printCount(page), 1), '②印刷が呼ばれる').toBe(1);
    expect.soft(logsAfter(border).some((l) => l.operation_type === '5'), '②操作ログに 5:出力').toBe(true);
  });

  /* 典拠：授業の雛形 1.5 */
  test('07-042 二重送信（1枚発行）', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-042');
    await openInvitations(page);
    await issueOne(page, /受入 07-042/, '7', { dbl: true });
    await page.waitForTimeout(1_500);
    expect.soft(Number(sqlValue('SELECT COUNT(*) FROM t_invitation_code WHERE child_id = ?', child.childId)), 'コードが1枚だけ').toBe(1);
    await page.reload();
    expect.soft(Number(sqlValue('SELECT COUNT(*) FROM t_invitation_code WHERE child_id = ?', child.childId)), '再読み込みで増えない').toBe(1);
    await evidence(page, '07-042');
  });

  /** 有効期限の範囲（07-I015〜07-I017） */
  async function validDays(page: Page, playwright: RequestFactory, caseNo: string, days: string, shouldIssue: boolean) {
    const api = await adminApi(playwright);
    const child = await makeChild(api, caseNo);
    await openInvitations(page);
    const d = await issueOne(page, new RegExp(esc(child.childName)), days);
    await page.waitForTimeout(1_000);
    const count = Number(sqlValue('SELECT COUNT(*) FROM t_invitation_code WHERE child_id = ?', child.childId));
    if (shouldIssue) {
      expect.soft(count, '発行される').toBe(1);
      expect.soft(String(sqlValue('SELECT expires_on FROM t_invitation_code WHERE child_id = ?', child.childId)), 'expires_on').toBe(addDays(jstToday(), Number(days)));
    } else {
      expect.soft(count, '発行されない').toBe(0);
      const dialogText = (await d.innerText().catch(() => '')).replace(/\s+/g, ' ');
      const blocked = (await d.getByRole('button', { name: '発行する' }).isDisabled().catch(() => false)) || /1〜365|範囲/.test(dialogText);
      expect.soft(blocked, '誤りを示す（押せないか、範囲の文）').toBe(true);
    }
    await evidence(page, caseNo);
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の招待コードの有効日数、図/画面詳細図 (7-7) の補足、インタフェース一覧「経路の一覧」(1) の POST /api/admin/invitations */
  test('07-I015 有効期限 0日', async ({ page, playwright }) => {
    await validDays(page, playwright, '07-I015', '0', false);
  });

  /* 典拠：同上 */
  test('07-I016 有効期限 365日', async ({ page, playwright }) => {
    await validDays(page, playwright, '07-I016', '365', true);
  });

  /* 典拠：同上 */
  test('07-I017 有効期限 366日', async ({ page, playwright }) => {
    await validDays(page, playwright, '07-I017', '366', false);
  });

  /* 典拠：図/画面詳細図「招待コード管理画面（管理者）」(7-7) 項目10、インタフェース一覧 (1-1) の POST /api/admin/invitations/bulk */
  test('07-I018 一括発行の枚数 6', async ({ page }) => {
    const total = () => Number(sqlValue('SELECT COUNT(*) FROM t_invitation_code') ?? 0);
    const before = total();
    await openInvitations(page);
    await mainOf(page).getByRole('button', { name: '一括発行' }).click();
    const d = page.getByRole('dialog', { name: /一括発行/ });
    await d.getByRole('combobox', { name: /クラス/ }).selectOption({ label: 'もも組' });
    await d.getByRole('spinbutton', { name: /枚数/ }).fill('6');
    const issue = d.getByRole('button', { name: '発行する' });
    if (await issue.isEnabled()) await issue.click();
    await page.waitForTimeout(1_000);
    expect.soft(total(), '発行されない').toBe(before);
    await evidence(page, '07-I018');
  });
});

// =====================================================================
// 保護者アカウント管理画面（サーバA）
// =====================================================================

test.describe('保護者アカウント管理画面（サーバA）', () => {
  async function openGuardians(page: Page) {
    await openAs(page, 'admin', '保護者アカウント');
    await expect(mainOf(page).getByRole('table').first()).toBeVisible();
  }

  /* 典拠：要件定義書「アカウントの管理」(4-1-2)・「アプリのログイン」(4-1-1) の未同意者の確認、基本設計書「アカウントの停止と再開」(4-3)、図/画面詳細図 (7-8) 項目3〜6・10 と補足 */
  test('07-043 保護者アカウントの一覧', async ({ page, playwright, browser }) => {
    const api = await adminApi(playwright);
    const g = await newWindow(browser, PHONE);
    let made;
    try {
      made = await makeGuardian(g.page, api, '07-043');
    } finally {
      await g.context.close();
    }
    await openGuardians(page);
    expect.soft(await columnNames(page), '①列').toEqual(['保護者', 'ログインID', '連絡先1', '連絡先2', '紐づく園児', '規約', '状態', '操作']);
    const row = guardianRow(page, made.email);
    for (const v of [made.guardianName, made.email, '090-0000-0007', `${made.childName}（母）`, '同意済', '有効']) await expect.soft(row, `②「${v}」`).toContainText(v);
    await expect.soft(guardianRow(page, ACCOUNTS.guardianTermsStale.email), '③保護者E の規約が「未同意」').toContainText('未同意');
    const h = guardianRow(page, ACCOUNTS.guardianSuspended.email);
    await expect.soft(h, '④保護者H の状態が「停止」').toContainText('停止');
    await expect.soft(h, '④紐づけが「終了」と終了日').toContainText(/終了.*\d{4}\/\d{2}\/\d{2}/);
    await expect.soft(mainOf(page).getByRole('button', { name: /^(停止|再開|編集)$/ }), '⑤編集・停止・再開のボタンが無い').toHaveCount(0);
    await expect.soft(row.getByRole('button', { name: '解除' }), '⑤紐づけごとに「解除」').toBeVisible();
    await expect.soft(h.getByRole('button', { name: '紐づけを戻す' }), '⑤終了の紐づけに「紐づけを戻す」').toBeVisible();
    await expect.soft(row.getByRole('cell').first(), '⑥保護者の列に保護者アカウントの氏名').toHaveText(made.guardianName);
    await row.scrollIntoViewIfNeeded().catch(() => undefined);
    await evidence(page, '07-043');
  });

  /* 典拠：要件定義書「アカウントの管理」(4-1-2)、基本設計書「紐づけの解除」(4-3)・「アカウントの停止と再開」(4-3)・「操作ログの記録」(4-2)・「ログイン」(4-3)・「操作ログ（t_operation_log）」(5-9)、図/画面詳細図 (7-8) 項目6 */
  test('07-044 紐づけの解除（最後の紐づけ）', async ({ page, playwright, browser }) => {
    const api = await adminApi(playwright);
    const g = await newWindow(browser, PHONE);
    try {
      const made = await makeGuardian(g.page, api, '07-044');
      await loginWith(g.page, 'guardian', made.email, made.password);
      const accountId = accountIdOf(made.email);
      const border = logBorder();
      await openGuardians(page);
      await guardianRow(page, made.email).getByRole('button', { name: '解除' }).click();
      const d = page.getByRole('dialog', { name: /解除/ });
      await expect.soft(d, '①その園児の記録を参照できなくなる旨').toContainText(/参照できなく/);
      await expect.soft(d, '①アカウントが停止される旨').toContainText(/停止/);
      await d.getByRole('button', { name: /解除する/ }).click();
      const row = guardianRow(page, made.email);
      await expect.soft(row, '②紐づけが「終了」（終了日つき）').toContainText(/終了.*\d{4}\/\d{2}\/\d{2}/);
      await expect.soft(row, '②アカウントが「停止」').toContainText('停止');
      const link = sqlAll('SELECT * FROM t_guardian_child gc JOIN m_guardian g ON g.guardian_id = gc.guardian_id WHERE g.account_id = ?', accountId)[0];
      expect.soft(String(link?.link_status), '③link_status＝2').toBe('2');
      expect.soft(link?.ended_at, '③ended_at あり').toBeTruthy();
      if (link && 'grace_ends_on' in link) expect.soft(link.grace_ends_on, '③猶予期間に入れない').toBeNull();
      expect.soft(String(sqlValue('SELECT status FROM m_account WHERE account_id = ?', accountId)), '③アカウントの status＝2').toBe('2');
      const left = sqlAll("SELECT m.left_at FROM t_chat_member m JOIN m_chat_room r ON r.chat_room_id = m.chat_room_id WHERE m.account_id = ? AND r.room_type IN ('2', '4')", accountId);
      expect.soft(left.length > 0 && left.every((r) => r.left_at), '③個人チャット・クラスグループの参加に left_at').toBe(true);
      await evidence(page, '07-044');
      const w2 = await newWindow(browser, PHONE);
      try {
        expect.soft(await loginError(w2.page, 'guardian', made.email, made.password), '④ログインは停止中の文言').toContain(MSG.suspended);
      } finally {
        await w2.context.close();
      }
      const logs = logsAfter(border);
      expect.soft(logs.some((l) => l.target_child_id === made.childId && l.target_id === accountId), '⑤解除の行（対象レコードは保護者のアカウント、対象園児）').toBe(true);
      expect.soft(hasColumn('t_operation_log', 'operator_type') && logs.some((l) => l.operator_type === '2'), '⑤停止の行（操作者の種類 2:システム）').toBe(true);
    } finally {
      await g.context.close();
    }
  });

  /* 典拠：基本設計書「保護者と園児の紐づけを戻す」(4-3)、図/画面詳細図 (7-8) 項目10、インタフェース一覧「経路の一覧」(1) の POST /api/admin/guardian-links/restore */
  test('07-045 紐づけを戻す', async ({ page, playwright, browser }) => {
    const api = await adminApi(playwright);
    const g = await newWindow(browser, PHONE);
    try {
      const made = await makeGuardian(g.page, api, '07-045');
      const accountId = accountIdOf(made.email);
      const guardianId = String(sqlValue('SELECT guardian_id FROM m_guardian WHERE account_id = ?', accountId));
      const roomId = Number(sqlValue("SELECT chat_room_id FROM m_chat_room WHERE child_id = ? AND room_type = '4'", made.childId));
      const joined = String(sqlValue('SELECT joined_at FROM t_chat_member WHERE chat_room_id = ? AND account_id = ?', roomId, accountId));
      // 前提：07-044 と同じに紐づけを解除しておく（保護者アカウント管理画面の「解除」と同じ経路）
      await ok('紐づけの解除', api.post('/api/admin/guardian-links/end', { data: { guardian_id: guardianId, child_id: made.childId } }));
      const border = logBorder();
      await openGuardians(page);
      await guardianRow(page, made.email).getByRole('button', { name: '紐づけを戻す' }).click();
      const d = page.getByRole('dialog').last();
      await expect.soft(d, '①確認ダイアログ').toBeVisible();
      await d.getByRole('button', { name: /戻す/ }).last().click();
      await expect.soft(guardianRow(page, made.email), '②紐づけ「有効」・アカウント「有効」').toContainText(/有効/);
      expect.soft(String(sqlValue('SELECT link_status FROM t_guardian_child WHERE guardian_id = ? AND child_id = ?', guardianId, made.childId)), '②link_status＝1').toBe('1');
      expect.soft(String(sqlValue('SELECT status FROM m_account WHERE account_id = ?', accountId)), '②status＝1').toBe('1');
      await evidence(page, '07-045');
      await loginWith(g.page, 'guardian', made.email, made.password);
      await expect.soft(g.page.getByRole('main'), `③保護者ホームに ${made.childName} の区画`).toContainText(made.childName);
      const now = sqlAll('SELECT joined_at, first_joined_at FROM t_chat_member WHERE chat_room_id = ? AND account_id = ?', roomId, accountId)[0];
      expect.soft(String(now?.first_joined_at ?? now?.joined_at), '④参加の時刻が、はじめに参加した時刻のまま').toBe(joined);
      expect.soft(logsAfter(border).some((l) => l.target_id === accountId || l.target_child_id === made.childId), '⑤操作ログに復元の行').toBe(true);
    } finally {
      await g.context.close();
    }
  });

  /* 典拠：要件定義書「緊急連絡先の保持」(4-1-1)、基本設計書「連絡先の変更」(4-3)、図/画面詳細図 (7-8) 項目11・(7-2) 項目22・(1-3) の (8) */
  test('07-046 連絡順の設定', async ({ page, playwright, browser }) => {
    const api = await adminApi(playwright);
    const g = await newWindow(browser, PHONE);
    let mother;
    try {
      mother = await makeGuardian(g.page, api, '07-046');
      await makeGuardian(g.page, api, '07-046', { child: { childId: mother.childId, childName: mother.childName }, relationship: '父', guardianSuffix: 'B' });
    } finally {
      await g.context.close();
    }
    await openGuardians(page);
    const order = guardianRow(page, mother.email).getByRole('spinbutton', { name: /連絡順/ });
    await expect(order, '保護者アカウント管理画面に、紐づけごとの「連絡順」がある').toBeVisible({ timeout: 5_000 });
    await expect.soft(order, '①初期値が登録した順（母 1）').toHaveValue('1');
    await evidence(page, '07-046');
  });

  /* 典拠：要件定義書「アプリのログイン」(4-1-1) の未同意者の確認、図/画面詳細図 (7-8) 項目1〜3 */
  test('07-047 状態の絞り込み・規約に未同意の保護者', async ({ page }) => {
    await openGuardians(page);
    const state = mainOf(page).getByRole('combobox', { name: /状態/ });
    const stale = mainOf(page).getByRole('button', { name: /規約に未同意/ });
    test.skip((await state.count()) === 0 && (await stale.count()) === 0, `まず回した：保護者アカウント管理画面に状態の絞り込みと「規約に未同意の保護者」が無い（未同意の保護者は知らせる表示だけ）。${OUT_121}の 7-8 項目1・2・3`);
    await evidence(page, '07-047');
  });

  /* 典拠：要件定義書「パスワードの再設定と一時パスワードの扱い」(4-1-1)、基本設計書「一時パスワードの再発行」(4-3)、図/画面詳細図 (7-8) 項目7 */
  test('07-048 保護者の一時パスワードの再発行', async ({ page }) => {
    await openGuardians(page);
    const reissue = mainOf(page).getByRole('button', { name: /一時パスワード/ });
    test.skip((await reissue.count()) === 0, `まず回した：保護者アカウント管理画面に「一時パスワードを再発行」が無い。${OUT_121}の 7-8 項目7`);
    await evidence(page, '07-048');
  });
});

// =====================================================================
// 操作ログ参照画面（サーバA）
// =====================================================================

test.describe('操作ログ参照画面（サーバA）', () => {
  async function openLogs(page: Page) {
    await openAs(page, 'admin', '操作ログ');
    await expect(logScreen(page).filter).toBeVisible();
  }

  /* 典拠：要件定義書「操作ログの参照」(4-1-4 (2))、基本設計書「操作ログ（t_operation_log）」(5-9)・「監査への対応」(6-4)、図/画面詳細図 (7-9) 項目1・7・9 */
  test('07-050 操作ログの表示', async ({ page, playwright, browser }) => {
    const api = await adminApi(playwright);
    const staff = await makeStaffIssued(api, '07-050');
    const g = await newWindow(browser, PHONE);
    try {
      const made = await makeGuardian(g.page, api, '07-050');
      const guardianId = String(sqlValue('SELECT guardian_id FROM m_guardian WHERE account_id = ?', accountIdOf(made.email)));
      await ok('紐づけの解除', api.post('/api/admin/guardian-links/end', { data: { guardian_id: guardianId, child_id: made.childId } }));
    } finally {
      await g.context.close();
    }
    await openLogs(page);
    const s = logScreen(page);
    const today = jstToday();
    await expect.soft(s.from, '①開始＝30日前').toHaveValue(addDays(today, -30));
    await expect.soft(s.to, '①終了＝きょう').toHaveValue(today);
    expect.soft(await columnNames(page), '②列').toEqual(['操作日時', '操作者', '機能', '操作', '対象テーブル', '対象', '対象園児', '変更前', '変更後']);
    const rows = (await dataRows(page).evaluateAll((rs) => rs.map((r) => Array.from((r as HTMLTableRowElement).cells).map((c) => (c.textContent ?? '').trim()))));
    const issued = rows.find((r) => r.join(' ').includes('受入 職員 07-050') || (r[2] === 'アカウント' && r[3] === '作成' && r[4] === 'm_staff'));
    expect.soft(issued?.[5] ?? '', '④発行の行の「対象」に氏名').toContain(staff.name);
    expect.soft(rows.some((r) => r[1] === 'システム'), '⑤停止の行の操作者が「システム」').toBe(true);
    await expect.soft(mainOf(page).getByRole('button', { name: /削除|編集|直す|消す/ }), '⑥行を直す・消す操作が無い').toHaveCount(0);
    await expect.soft(mainOf(page), '⑦総件数').toContainText(/全\s*\d+\s*件/);
    const first = rows[0]?.[0] ?? '';
    expect.soft(first, '③操作日時').toMatch(/\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}|\d{4}[-/]\d{2}[-/]\d{2}/);
    await evidence(page, '07-050');
  });

  /* 典拠：要件定義書「操作ログの参照」(4-1-4 (2))、図/画面詳細図 (7-9) 項目1〜3・5・6 */
  test('07-051 操作ログの絞り込み', async ({ page, playwright }) => {
    const api2 = await apiAs(playwright, 'admin2');
    const child = await makeChild(api2, '07-051');
    await makeStaffIssued(await adminApi(playwright), '07-051');
    const today = jstToday();
    const from = addDays(today, -30);
    const period = "date(replace(operated_at, 'T', ' ')) BETWEEN ? AND ?";
    await openLogs(page);
    const s = logScreen(page);
    const shown = async () => dataRows(page).count();
    const endoId = accountIdOf(ACCOUNTS.admin2.email);
    await s.operator.selectOption(String(endoId));
    await s.filter.click();
    await page.waitForTimeout(800);
    expect.soft(await shown(), '①操作者「遠藤 直人」').toBe(Math.min(100, logCount(`${period} AND account_id = ?`, from, today, endoId)));
    const ops = (await dataRows(page).evaluateAll((rs) => rs.map((r) => (r as HTMLTableRowElement).cells[1]?.textContent?.trim() ?? '')));
    expect.soft(ops.every((o) => o === '遠藤 直人'), '②どの行の操作者も遠藤 直人').toBe(true);
    await s.operator.selectOption({ label: 'すべて' });
    await s.func.selectOption({ label: '園児' });
    await s.filter.click();
    await page.waitForTimeout(800);
    expect.soft(await shown(), '①対象機能「園児」').toBe(Math.min(100, logCount(`${period} AND function_type = '6'`, from, today)));
    const funcs = (await dataRows(page).evaluateAll((rs) => rs.map((r) => (r as HTMLTableRowElement).cells[2]?.textContent?.trim() ?? '')));
    expect.soft(funcs.every((f) => f === '園児'), '③どの行の機能も園児').toBe(true);
    await s.func.selectOption({ label: 'すべて' });
    await s.child.selectOption({ label: child.childName });
    await s.filter.click();
    await page.waitForTimeout(800);
    expect.soft(await shown(), '①対象園児「受入 07-051」').toBe(Math.min(100, logCount(`${period} AND target_child_id = ?`, from, today, child.childId)));
    await s.child.selectOption({ label: 'すべて' });
    await s.from.fill(today);
    await s.to.fill(today);
    await s.filter.click();
    await page.waitForTimeout(800);
    expect.soft(await shown(), '①期間をきょうに').toBe(Math.min(100, logCount(period, today, today)));
    const md = `${Number(today.slice(5, 7))}/${Number(today.slice(8, 10))}`;
    const dates = (await dataRows(page).evaluateAll((rs) => rs.map((r) => (r as HTMLTableRowElement).cells[0]?.textContent?.trim() ?? '')));
    expect.soft(dates.every((d) => d.startsWith(md) || d.startsWith(today) || d.startsWith(slash(today))), `⑤どの行の操作日時もきょう（${md}）`).toBe(true);
    await evidence(page, '07-051');
  });

  /* 典拠：図/画面詳細図「操作ログ参照画面（管理者）」(7-9) 項目4 */
  test('07-052 操作での絞り込み', async ({ page }) => {
    await openLogs(page);
    const op = mainOf(page).getByRole('combobox', { name: '操作', exact: true });
    test.skip((await op.count()) === 0, `まず回した：操作ログ参照画面に「操作」の絞り込みが無い（一覧の列にはある）。${OUT_121}の 7-9 項目4`);
    await evidence(page, '07-052');
  });

  /* 典拠：図/画面詳細図「操作ログ参照画面（管理者）」(7-9) 項目1・「モックアップを直したもの」(12-2) */
  test('07-I030 期間 開始が終了より後', async ({ page }) => {
    await openLogs(page);
    const s = logScreen(page);
    const before = await dataRows(page).allInnerTexts();
    await s.from.fill(jstToday());
    await s.to.fill(addDays(jstToday(), -1));
    await s.filter.click();
    await page.waitForTimeout(800);
    await expect.soft(mainOf(page).getByRole('alert').first(), '誤りを示す').toBeVisible();
    expect.soft(await dataRows(page).allInnerTexts(), '絞り込まれない（一覧が前の条件のまま）').toEqual(before);
    await expect.soft(s.from, '入れた値は消えない').toHaveValue(jstToday());
    await evidence(page, '07-I030');
  });
});

// =====================================================================
// 設定画面（サーバB。設定は園全体に効くため、1つの DB にまとめる）
// =====================================================================

test.describe('設定画面（サーバB）', () => {
  /** 設定画面にその区分があるか。無ければ NG（設計書は設定画面で変えるとする。期待を書き換えない） */
  async function requireSection(page: Page, name: string | RegExp, what: string) {
    await expect(settingsSection(page, name).first(), `設定画面に「${what}」の区分が無い（GET /api/settings の settings：${(await pageApiKeys(page)).join(',')}）`).toBeVisible({ timeout: 5_000 });
  }

  async function pageApiKeys(page: Page): Promise<string[]> {
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/settings', { credentials: 'same-origin' });
      return r.ok ? ((await r.json()) as { settings: { setting_key: string }[] }).settings.map((s) => s.setting_key) : [];
    });
    return res;
  }

  /* 典拠：要件定義書「園が変える設定」(4-1-4 (5))、基本設計書「画面の一覧」(3-2) の設定画面、図/画面詳細図「設定画面（管理者）」(7-10) 項目1・8、詳細設計書「設定画面（管理者）」(2-14 (1)・(4))・「設定」(4-10 (1)) */
  test('07-055 区分の表示と保存していない変更', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    const view = await page.evaluate(async () => (await fetch('/api/settings', { credentials: 'same-origin' })).json());
    expect.soft((view as { push_available?: boolean }).push_available, '②push_available が偽').toBe(false);
    await expect.soft(settingsSection(page, /^通知/), '②「通知」の区分が出ない').toHaveCount(0);
    for (const name of ['連絡帳', /定型文/, 'AI', 'クラス', 'そのほかの設定値']) {
      await expect.soft(settingsSection(page, name).first(), `①区分「${String(name)}」`).toBeVisible({ timeout: 3_000 });
    }
    await evidence(page, '07-055');
    await requireSection(page, '連絡帳', '連絡帳');
  });

  /* 典拠：要件定義書「園が変える設定」(4-1-4 (5))・「品質要求一覧」(7-1 No.7)、基本設計書「出す項目と選択肢の設定」(4-5)・「設定マスタ（m_setting）」(5-9)、図/画面詳細図 (7-10) 項目2・3・13、詳細設計書 (2-14 (1)・(2))・(4-10 (2)) */
  test('07-056 連絡帳：保護者へ出す項目・家庭からの項目', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-056');
    await requireSection(page, '連絡帳', '連絡帳（保護者へ出すきょうのようすの項目・「家庭から」の項目）');
    const m = mainOf(page);
    for (const name of ['午睡', '食事', '排せつ', '体温', '活動のひとこと', '写真', 'クラスのようす']) await expect.soft(m.getByRole('checkbox', { name, exact: true }).first(), `①${name}`).toBeChecked();
  });

  /* 典拠：基本設計書「出す項目と選択肢の設定」(4-5)・「設定マスタ（m_setting）」(5-9)、図/画面詳細図 (7-10) 項目4・5、詳細設計書 (2-14 (1)・(2)) */
  test('07-057 連絡帳：排せつ・きげんの選択肢', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-057');
    await requireSection(page, '連絡帳', '連絡帳（排せつ・きげんの選択肢）');
  });

  /* 典拠：要件定義書「園が変える設定」(4-1-4 (5))、基本設計書「定型文（m_phrase）」(5-9)・「雛形・添付」(5-5)、図/画面詳細図 (7-10) 項目6・7、詳細設計書 (2-14 (3))・(4-10 (4)・(5)) */
  test('07-058 定型文・日誌の雛形', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-058');
    await requireSection(page, /定型文/, '定型文・雛形');
  });

  /* 典拠：授業の雛形 1.5 */
  test('07-059 クロスサイトスクリプティング（定型文）', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-059');
    await requireSection(page, /定型文/, '定型文・雛形（定型文を足す）');
  });

  /* 典拠：要件定義書「外部の AI を使うことの同意」(8 No.13)、基本設計書「設定マスタ（m_setting）」(5-9)・「監査への対応」(6-4)・「権限と利用可能機能」(6-1) の※11、図/画面詳細図 (7-10) 項目9・10、詳細設計書「設定画面（管理者）」(2-14 (5)) */
  test('07-060 AI：文章の下書きを使う・1日の上限回数', async ({ page, browser }) => {
    const border = logBorder();
    await login(page, 'admin');
    await openSettings(page);
    const ai = settingsSection(page, /AI/).first();
    await expect(ai, '「AI」の区分').toBeVisible();
    const m = mainOf(page);
    await expect.soft(m.getByRole('radio', { name: '使わない' }), '①初期値「使わない」').toBeChecked();
    const limit = m.getByRole('spinbutton', { name: /上限回数/ });
    await expect.soft(limit, '①上限回数300').toHaveValue('300');
    await m.getByRole('radio', { name: '使う' }).check();
    await m.getByRole('button', { name: '保存する' }).click();
    const d = page.getByRole('dialog', { name: /保存/ });
    await expect.soft(d, '②有効にするときの確認').toContainText(MSG.aiPolicy);
    await d.getByRole('button', { name: '保存する' }).click();
    await expect(d).toHaveCount(0);
    await expect.soft(m, '③API キーが無いので使えない旨').toContainText(/API キー.*(ありません|無い)|使えません/);
    await limit.fill('200');
    await saveSettings(page);
    await page.waitForTimeout(800);
    expect.soft(settingValue('ai.enabled'), '④ai.enabled＝1').toBe('1');
    expect.soft(settingValue('ai.daily_limit'), '④ai.daily_limit＝200').toBe('200');
    const logs = logsAfter(border).filter((l) => l.function_type === '9' && l.operation_type === '2');
    expect.soft(logs.some((l) => (l.before_value ?? '').includes('ai.enabled') || (l.after_value ?? '').includes('ai.enabled')), '④操作ログ 9:2（ai.enabled の前後）').toBe(true);
    expect.soft(logs.some((l) => (l.after_value ?? '').includes('200')), '④操作ログ 9:2（上限回数の前後）').toBe(true);
    await evidence(page, '07-060');
    const s = await newWindow(browser);
    try {
      await loginWith(s.page, 'staff', ACCOUNTS.staffSakura.email, passwordOf('staffSakura'));
      await s.page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '連絡帳', exact: true }).click();
      await s.page.getByRole('main').getByRole('link', { name: '西田 太郎', exact: true }).first().click();
      await expect(s.page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
      await expect.soft(s.page.getByRole('main').getByRole('button', { name: /AI/ }), '⑤連絡帳（園児）画面に AI のボタンが出ない').toHaveCount(0);
    } finally {
      await s.context.close();
    }
  });

  /* 典拠：基本設計書「園の有効化と保護者の拒否」(4-11)・「保護者と園児の紐づけ（t_guardian_child）」(5-3)、図/画面詳細図 (7-8) 項目12 */
  test('07-049 AI の下書きを使わない', async ({ page }) => {
    await login(page, 'admin');
    // 前提：AI を有効にしておく（07-060 と同じ設定の経路。落ちたテストのあとはサーバが立て直されるため、ここでも入れる）
    if (settingValue('ai.enabled') !== '1') {
      const view = await pageApi(page, 'GET', '/api/settings');
      const readAt = (view.json as { read_at?: string } | null)?.read_at;
      await pageApi(page, 'POST', '/api/settings', { changes: { 'ai.enabled': '1' }, read_at: readAt });
    }
    expect(settingValue('ai.enabled'), '前提：AI が有効').toBe('1');
    await goNav(page, '保護者アカウント');
    const box = mainOf(page).getByRole('checkbox', { name: /AI の下書きを使わない/ });
    test.skip((await box.count()) === 0, `まず回した：AI を有効にした（07-060）あとも、保護者アカウント管理画面に「AI の下書きを使わない」が無い。${OUT_NEXT}（「次の版で詳しくする経路」(4-11)）`);
    await evidence(page, '07-049');
  });

  /* 典拠：要件定義書「園が変える設定」(4-1-4 (5))（年度ごとのクラスの作成と担任の割り当て）、基本設計書「クラスと紐づけ」(5-3)、図/画面詳細図 (7-10) 項目11、詳細設計書 (2-14 (6))・(4-10 (6)) */
  test('07-061 クラス：作る・過年度は読むだけ', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-061');
    await requireSection(page, 'クラス', 'クラス（年度ごとのクラスの作成と担任の割り当て）');
  });

  /* 典拠：詳細設計書「設定画面（管理者）」(2-14 (6))・「設定」(4-10 (6))、図/画面詳細図 (7-10) 項目11、基本設計書「職員の情報の変更」(4-3) */
  test('07-062 クラス：担任を割り当てる', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-062');
    await requireSection(page, 'クラス', 'クラス（担任を割り当てる）');
  });

  /* 典拠：要件定義書「園が変える設定」(4-1-4 (5))・「品質要求一覧」(7-1 No.7)、基本設計書「設定マスタ（m_setting）」(5-9)、図/画面詳細図 (7-10) 項目12、詳細設計書 (2-14 (7))・(4-10 (1)・(3)) */
  test('07-063 そのほかの設定値：一覧', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    const view = (await page.evaluate(async () => (await fetch('/api/settings', { credentials: 'same-origin' })).json())) as {
      settings?: { setting_key: string; group?: string; default_value?: string; editable?: boolean }[];
      read_at?: string;
      ai_key_present?: boolean;
      ai_key_rejected?: boolean;
      push_available?: boolean;
    };
    const keys = new Set((view.settings ?? []).map((s) => s.setting_key));
    const others = [
      'facility.name', 'facility.phone_number', 'nap.interval_minutes.age0', 'nap.interval_minutes.age1', 'nap.interval_minutes.age2', 'nap.time_range',
      'auth.max_failed_login', 'auth.lock_minutes', 'auth.remember_days', 'auth.temp_password_hours', 'ui.auto_logout_minutes', 'ui.diary_lock_minutes',
      'scope.handover_grace_days', 'scope.guardian_grace_days', 'scope.fiscal_year_update_date', 'physical.measure_months', 'physical.height_min',
      'physical.height_max', 'physical.weight_min', 'physical.weight_max', 'dev.milestone_months', 'dev.notice_days_before', 'attachment.max_size_mb',
      'attachment.max_count_diary', 'retention.record_years', 'retention.attachment_years', 'approval.warn_days', 'paging.diary_per_page',
      'paging.nap_search_per_page', 'paging.operation_log_per_page', 'paging.physical_history_count',
    ];
    const readOnly = ['attachment.allowed_types', 'handout.allowed_types', 'retention.contact_years', 'growth.share_physical', 'nap.temperature_required'];
    const missing = [...others, ...readOnly].filter((k) => !keys.has(k));
    expect.soft(missing, '④GET /api/settings に「そのほか」と読むだけのキーがある').toEqual([]);
    for (const s of view.settings ?? []) {
      expect.soft(s.group !== undefined && s.default_value !== undefined && s.editable !== undefined, `④${s.setting_key} に group・default_value・editable`).toBe(true);
    }
    for (const k of ['read_at', 'ai_key_present', 'ai_key_rejected', 'push_available'] as const) expect.soft(k in view, `④応答に ${k}`).toBe(true);
    await evidence(page, '07-063');
    await requireSection(page, 'そのほかの設定値', 'そのほかの設定値');
  });

  /* 典拠：要件定義書「園が変える設定」(4-1-4 (5))・「品質要求一覧」(7-1 No.7)、基本設計書「設定マスタ（m_setting）」(5-9)、図/画面詳細図 (7-10) 項目12・13、詳細設計書 (2-14 (1)・(7))・(4-10 (2)・(3)) */
  test('07-064 そのほかの設定値：値を変える', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-064');
    await requireSection(page, 'そのほかの設定値', 'そのほかの設定値（午睡のチェック間隔・午睡の時間帯・自動ログアウト・1ページの件数）');
  });

  /* 典拠：詳細設計書「設定画面（管理者）」(2-14 (1))・「設定」(4-10 (2))、要件定義書「同時編集の扱い」(4-1-4 (3)) */
  test('07-065 ほかの管理者が先に変えた', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-065');
    await requireSection(page, 'そのほかの設定値', 'そのほかの設定値（承認待ちの滞留を示す日数）');
  });

  /* 典拠：要件定義書「操作ログの参照」(4-1-4 (2))、基本設計書「一覧表示とページング」(3-7)・「設定マスタ（m_setting）」(5-9)・「操作ログ（t_operation_log）」(5-9)、図/画面詳細図 (7-9) 項目8・9 */
  test('07-053 ページングと CSV 出力', async ({ page, playwright }) => {
    test.info().annotations.push({ type: 'note', description: '設定画面に操作ログの1ページの件数の行が無いため、【SQL】(W3) で 10 にした（シート07 の (W3)）' });
    const api = await adminApi(playwright);
    const child = await makeChild(api, '07-053');
    for (let i = 0; i < 12; i++) await issueCode(api, child.childId, 7); // 操作ログを10件より多くする
    await login(page, 'admin');
    await openSettings(page);
    const field = otherSettingField(page, /操作ログ.*件数/);
    if ((await field.count()) > 0) {
      await field.first().fill('10');
      await saveSettings(page);
    } else {
      sqlRun("UPDATE m_setting SET setting_value = '10' WHERE setting_key = 'paging.operation_log_per_page'");
    }
    await goNav(page, '操作ログ');
    await expect(logScreen(page).filter).toBeVisible();
    const today = jstToday();
    const total = logCount("date(replace(operated_at, 'T', ' ')) BETWEEN ? AND ?", addDays(today, -30), today);
    expect(total, '前提：操作ログが10件より多い').toBeGreaterThan(10);
    await expect.soft(dataRows(page), '①1ページに10行').toHaveCount(10);
    await expect.soft(mainOf(page), '①総件数').toContainText(new RegExp(`全\\s*${total}\\s*件`));
    const next = mainOf(page).getByRole('button', { name: /次/ });
    await expect.soft(next, '②次のページへ移れる').toBeEnabled();
    if (await next.isEnabled().catch(() => false)) {
      await next.click();
      await expect.soft(dataRows(page), '②2ページ目に続きの行').toHaveCount(Math.min(10, total - 10));
    }
    const border = logBorder();
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), logScreen(page).csv.click()]);
    const csv = readFileSync(await download.path(), 'utf8').replace(/^﻿/, '');
    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
    expect.soft(lines.length - 1, '③CSV の行の数が総件数と同じ').toBe(total);
    expect.soft(logsAfter(border).some((l) => l.operation_type === '5'), '④出力の前に 5:出力の行が増える').toBe(true);
    await evidence(page, '07-053');
  });

  // ---- 入力チェック（設定画面）。欄が無ければ NG（設計書は設定画面で変えるとする） ----

  /** 「そのほかの設定値」のその欄に値を入れて保存し、保存されないことを見る */
  async function rejectOther(page: Page, caseNo: string, key: string, label: RegExp, value: string, what: string) {
    await login(page, 'admin');
    await openSettings(page);
    const before = settingValue(key);
    const field = otherSettingField(page, label);
    await evidence(page, caseNo);
    await expect(field.first(), `設定画面に「${what}」（${key}）の欄が無い`).toBeVisible({ timeout: 5_000 });
    await field.first().fill(value);
    await saveSettings(page);
    await page.waitForTimeout(800);
    expect.soft(settingValue(key), '保存されない').toBe(before);
    expect.soft((await mainOf(page).innerText()).replace(/\s+/g, ' '), '「〇〇は△△で入力してください。」の形の文').toMatch(/は.+で入力してください。/);
  }

  /* 典拠：詳細設計書「設定」(4-10 (2)・(3))・「本書で足す文言」(4-1 (6)) */
  test('07-I019 午睡のチェック間隔（0歳児） 0', async ({ page }) => {
    await rejectOther(page, '07-I019', 'nap.interval_minutes.age0', /午睡.*(0歳|間隔)/, '0', '午睡のチェック間隔（0歳児）');
  });

  /* 典拠：詳細設計書「設定画面（管理者）」(2-14 (7))・「設定」(4-10 (3)) */
  test('07-I020 午睡のチェック間隔（0歳児） 15', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    const field = otherSettingField(page, /午睡.*(0歳|間隔)/);
    await evidence(page, '07-I020');
    await expect(field.first(), '設定画面に「午睡のチェック間隔（0歳児）」（nap.interval_minutes.age0）の欄が無い').toBeVisible({ timeout: 5_000 });
    await field.first().fill('15');
    await mainOf(page).getByRole('button', { name: '保存する' }).first().click();
    const d = page.getByRole('dialog', { name: /保存/ });
    await expect.soft(d, '既定より長い間隔の注意').toContainText(MSG.longInterval);
    await d.getByRole('button', { name: '保存する' }).click();
    expect.soft(settingValue('nap.interval_minutes.age0'), '保存される').toBe('15');
  });

  /* 典拠：同上、基本設計書「園児（m_child）」(5-3) */
  test('07-I021 午睡のチェック間隔（0歳児） 16', async ({ page }) => {
    await rejectOther(page, '07-I021', 'nap.interval_minutes.age0', /午睡.*(0歳|間隔)/, '16', '午睡のチェック間隔（0歳児）');
  });

  /* 典拠：詳細設計書「設定」(4-10 (3))、基本設計書「設定マスタ（m_setting）」(5-9) の nap.time_range */
  test('07-I022 午睡の時間帯 15:00-13:00', async ({ page }) => {
    await rejectOther(page, '07-I022', 'nap.time_range', /午睡.*時間帯/, '15:00-13:00', '午睡の時間帯');
  });

  /* 典拠：詳細設計書「設定画面（管理者）」(2-14 (5))・「設定」(4-10 (3))・「本書で足す文言」(4-1 (6))、図/画面詳細図 (7-10) 項目10 */
  test('07-I023 AI の1日の上限回数 0', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    const before = settingValue('ai.daily_limit');
    const limit = mainOf(page).getByRole('spinbutton', { name: /上限回数/ });
    await expect(limit).toBeVisible();
    await limit.fill('0');
    const save = mainOf(page).getByRole('button', { name: '保存する' }).first();
    if (await save.isEnabled()) {
      await save.click();
      const d = page.getByRole('dialog', { name: /保存/ });
      if (await d.count()) await d.getByRole('button', { name: '保存する' }).click();
      await page.waitForTimeout(800);
    }
    expect.soft(settingValue('ai.daily_limit'), '保存されない').toBe(before);
    await expect.soft(mainOf(page), '文言').toContainText(MSG.aiLimit);
    await evidence(page, '07-I023');
  });

  /* 典拠：詳細設計書「設定」(4-10 (3))、基本設計書「設定マスタ（m_setting）」(5-9) の ui.auto_logout_minutes */
  test('07-I024 自動ログアウト 4', async ({ page }) => {
    await rejectOther(page, '07-I024', 'ui.auto_logout_minutes', /自動ログアウト/, '4', '自動ログアウトまでの無操作時間');
  });

  /* 典拠：詳細設計書「設定」(4-10 (3))、基本設計書「一覧表示とページング」(3-7)・「設定マスタ（m_setting）」(5-9) */
  test('07-I025 操作ログの1ページの件数 9', async ({ page }) => {
    await rejectOther(page, '07-I025', 'paging.operation_log_per_page', /操作ログ.*件数/, '9', '操作ログの1ページの件数');
  });

  /* 典拠：図/画面詳細図 (7-10) 項目4、詳細設計書「設定画面（管理者）」(2-14 (2))・「設定」(4-10 (3)) */
  test('07-I026 排せつの選択肢 21文字', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-I026');
    await requireSection(page, '連絡帳', '連絡帳（排せつの選択肢）');
  });

  /* 典拠：詳細設計書「設定画面（管理者）」(2-14 (2))・「設定」(4-10 (3))、基本設計書「出す項目と選択肢の設定」(4-5) */
  test('07-I027 家庭からの項目 0個', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-I027');
    await requireSection(page, '連絡帳', '連絡帳（「家庭から」の項目）');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の定型文・「定型文（m_phrase）」(5-9)、詳細設計書「設定」(4-10 (4)) */
  test('07-I028 定型文 101文字', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-I028');
    await requireSection(page, /定型文/, '定型文・雛形');
  });

  /* 典拠：詳細設計書「設定」(4-10 (6))・「本書で足す文言」(4-1 (6)) のクラス名 */
  test('07-I029 クラス名 同じ年度の重複', async ({ page }) => {
    await login(page, 'admin');
    await openSettings(page);
    await evidence(page, '07-I029');
    await requireSection(page, 'クラス', 'クラス');
  });
});

// =====================================================================
// ログインの失敗の記録（サーバD）
// =====================================================================

test.describe('ログインの失敗の記録（サーバD）', () => {
  /* 典拠：基本設計書「ログイン」(4-3)・「ログアウト」(4-3)、図/画面詳細図「操作ログ参照画面（管理者）」(7-9) の補足 */
  test('07-054 ログインの失敗とロックを記録する', async ({ page, browser, playwright }) => {
    const api = await adminApi(playwright);
    const w = await newWindow(browser);
    try {
      const staff = await makeStaffReady(w.page, api, '07-054');
      const accountId = accountIdOf(staff.email);
      const border = logBorder();
      await loginError(w.page, 'staff', staff.email, 'wrong-pass-07054');
      const afterFirst = logsAfter(border);
      expect.soft(afterFirst.filter((l) => l.account_id === accountId).length, '①1回目の失敗の行（操作者は試されたアカウント）').toBe(1);
      expect.soft(`${afterFirst[0]?.before_value ?? ''}${afterFirst[0]?.after_value ?? ''}`, '①続けて何回目の失敗か（1）').toMatch(/1/);
      const b2 = logBorder();
      await loginWith(w.page, 'staff', staff.email, staff.password);
      await logoutStaff(w.page);
      expect.soft(logsAfter(b2).filter((l) => l.account_id === accountId).length, '②成功したログインとログアウトの行は無い').toBe(0);
      const b3 = logBorder();
      for (let i = 0; i < 5; i++) await loginError(w.page, 'staff', staff.email, 'wrong-pass-07054');
      const fails = logsAfter(b3).filter((l) => l.account_id === accountId);
      expect.soft(fails.length, '③5回の失敗のそれぞれの行').toBeGreaterThanOrEqual(5);
      expect.soft(fails.some((l) => /ロック|lock/i.test(`${l.before_value ?? ''}${l.after_value ?? ''}`)), `③ロックしたことが残る（${fails.map((l) => l.after_value).join(' / ')}）`).toBe(true);
      const b4 = logBorder();
      await loginError(w.page, 'staff', 'nobody07054@example.jp', 'wrong-pass-07054');
      expect.soft(logsAfter(b4).length, '④登録の無いログインIDの行は無い').toBe(0);
      await login(page, 'admin');
      await goNav(page, '操作ログ');
      await expect(logScreen(page).filter).toBeVisible();
      await logScreen(page).operator.selectOption(String(accountId)).catch(() => undefined);
      await logScreen(page).filter.click();
      await page.waitForTimeout(800);
      expect.soft(await dataRows(page).count(), '⑤画面の一覧にもこれらの行が出る').toBeGreaterThanOrEqual(7);
      await evidence(page, '07-054');
    } finally {
      await w.context.close();
    }
  });
});

