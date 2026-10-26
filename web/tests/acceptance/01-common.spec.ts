/*
 * シート 01 共通基盤（ログイン・新規登録・パスワード変更・規約同意・ホーム）
 *
 * 期待する結果は設計書（docs ブランチ）から書く。コードを読んで決めない（README.md「期待は設計書から」）。
 * ケースは テスト仕様書 第2.0版 のシート01（T6 が抽出した sheet-01.md）の 01-001〜01-050・01-I001〜01-I025。
 * 土台の係が置いた見本の 01-001・01-002 は、シートの 01-001（保護者用トップ）・01-002（職員用トップ）に置き換えた
 * （見本が確かめていたログインとダッシュボードは 01-003・01-033 で確かめる）。
 *
 * サーバの分け方（sheet-01.md「サーバの分け方」）。describe ごとに新しいデータベースで立つ
 *   A 通常 / B ログインの失敗（失敗は多くて17回。送信元の上限 15分に20回に届かない）/ C ロック / D 待機時間
 * 時間を待つケース（01-045〜01-047 は6分、01-049 は1分）は、ACCEPTANCE_LONG=1 のときだけ回す（試しの回では未実施）。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ACCOUNTS, PHONE, evidence, expect, gotoTop, jstToday, login, passwordOf, test } from './harness';
import {
  adminApi,
  checkAllConsents,
  createChild,
  fillSignup,
  guardianAccountsByEmail,
  issueCode,
  jstParts,
  loginError,
  loginWith,
  logoutGuardian,
  logoutStaff,
  makeGuardian,
  makeStaff,
  makeStaffIssued,
  newApi,
  newWindow,
  origin,
  signupScreen,
  sqlRun,
} from './01-common.helpers';

const LONG = process.env.ACCEPTANCE_LONG === '1';
const LONG_REASON = '試しの回では回さない（時間の経過を待つため、重いコマンドの鍵を長く持つ）。全体の回で ACCEPTANCE_LONG=1 にして回す';

/** 基本設計書「メッセージ一覧」(4-12) の文言 */
const MSG = {
  credential: 'IDまたはパスワードが違います。',
  locked: 'ログインを一定時間受け付けません。しばらく待つか、管理者へご連絡ください。',
  suspended: 'このアカウントは使えません。園へご連絡ください。',
  wrongEntrance: 'このアカウントではこちらからログインできません。ご案内する入口からログインしてください。',
  tempExpired: '一時パスワードの有効期限が切れています。管理者へご連絡ください。',
  passwordFirst: 'パスワードの変更が完了するまで、他の機能はご利用いただけません。',
  codeUnknown: '招待コードが確認できません。園から配布されたコードをお確かめください',
  codeUsed: 'この招待コードはすでに使われています。園に新しい招待コードの発行をご依頼ください',
  codeRevoked: 'この招待コードは失効しています。園に新しい招待コードの発行をご依頼ください',
  codeExpired: 'この招待コードは有効期限が切れています。園に新しい招待コードの発行をご依頼ください',
  childAlready: 'このお子さまはすでに追加されています。',
  emailTaken: 'このメールアドレスは既に登録されています。',
  phone1Missing: '連絡先1（電話番号）を入力してください。急ぎのときに園からお電話するために使います。',
  samePassword: '現在と同じパスワードは使えません。別のパスワードを入力してください。',
  // 詳細設計書「本書で足す文言」(4-1 (6))
  phoneShape: '電話番号は、数字とハイフンで20文字以内で入力してください。',
  contactChanged: '連絡先を変えました。',
};

/** いまの画面が入口（ログインのフォーム）か */
async function expectAtTop(page: Page, entrance: 'staff' | 'guardian') {
  await expect(page.getByRole('heading', { name: entrance === 'staff' ? '職員用の入口' : '保護者用の入口' })).toBeVisible();
  await expect(page.getByLabel('ログインID', { exact: true })).toBeVisible();
}

/** 保護者ホームの、その園児の区画（「〇〇さんのきょう」） */
function todayRegion(page: Page, childName: string) {
  return page.getByRole('region', { name: `${childName}さんのきょう` });
}

// ======================================================================
// サーバA（通常）
// ======================================================================
test.describe('サーバA（通常）：入口・ログイン', () => {
  test.describe('保護者の画面', () => {
    test.use({ viewport: PHONE });

    /*
     * 典拠：要件定義書「アプリのログイン」(4-1-1) の入口の2系統（未ログインのトップに表示するのは認証の導線のみ）
     *       図/画面詳細図「職員用トップ／保護者用トップ」(2-1) 項目1〜6・9・10
     */
    test('01-001 入口の表示', async ({ page }) => {
      await gotoTop(page, 'guardian');
      const main = page.getByRole('main');
      await expect.soft(page.getByRole('heading', { name: '保護者用の入口' })).toBeVisible();
      await expect.soft(main).toContainText('すくすく保育園');
      await expect.soft(page.getByLabel('パスワード', { exact: true })).toBeVisible();
      await expect.soft(page.getByRole('checkbox', { name: 'ログイン状態を保持する' }), '保持の初期値はオン（2-1 項目4）').toBeChecked();
      await expect.soft(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible();
      await expect.soft(page.getByRole('link', { name: '招待コードで新規登録' })).toBeVisible();
      // ④ 実データを出さない（デモの園児の名前が出ていない）
      await expect.soft(main).not.toContainText(ACCOUNTS.guardian.children[0].name);
      await evidence(page, '01-001');
      // ③ もう一方の入口へ
      await page.getByRole('link', { name: '職員の方はこちら' }).click();
      await expect.soft(page.getByRole('heading', { name: '職員用の入口' })).toBeVisible();
    });

    /*
     * 典拠：要件定義書「アプリのログイン」(4-1-1) の機能要件・基本設計書「ログイン」(4-3)・図/画面遷移図「共通・認証」(2)
     */
    test('01-003 保護者のログイン', async ({ page, playwright }) => {
      const api = await adminApi(playwright);
      const g = await makeGuardian(page, api, '01-003');
      await logoutGuardian(page);
      await loginWith(page, 'guardian', g.email, g.password);
      await expect(todayRegion(page, g.childName)).toBeVisible();
      await evidence(page, '01-003');
    });
  });

  /*
   * 典拠：要件定義書「アプリのログイン」(4-1-1)（職員用トップに新規登録は設けない）
   *       図/画面詳細図「職員用トップ／保護者用トップ」(2-1) 項目4・6・9・10
   */
  test('01-002 入口の表示', async ({ page }) => {
    await gotoTop(page, 'staff');
    const main = page.getByRole('main');
    await expect.soft(page.getByRole('heading', { name: '職員用の入口' })).toBeVisible();
    await expect.soft(page.getByRole('checkbox', { name: 'ログイン状態を保持する' }), '保持の初期値はオフ（2-1 項目4）').not.toBeChecked();
    await expect.soft(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible();
    await expect.soft(main.getByRole('link', { name: /新規登録/ }), '職員用トップに新規登録は置かない').toHaveCount(0);
    await expect.soft(main).not.toContainText(ACCOUNTS.guardian.children[0].name);
    await evidence(page, '01-002');
    await page.getByRole('link', { name: '保護者の方はこちら' }).click();
    await expect.soft(page.getByRole('heading', { name: '保護者用の入口' })).toBeVisible();
  });
});

// ======================================================================
// サーバB（ログインの失敗）：わざと失敗させるケースを集める
// ======================================================================
test.describe('サーバB（ログインの失敗）', () => {
  /** 誤りの文言が設計書のとおりで、残りの回数を示さない */
  function expectCredentialError(text: string) {
    expect.soft(text, '文言（基本設計書「メッセージ一覧」(4-12)）').toContain(MSG.credential);
    expect.soft(text, '残りの試行回数を示さない（要件定義書「アプリのログイン」(4-1-1)）').not.toMatch(/残り/);
  }

  // 典拠：要件定義書「アプリのログイン」(4-1-1) のログイン試行の制限・基本設計書「ログイン」(4-3)・同「メッセージ一覧」(4-12)・図/画面詳細図 (2-1) 項目7
  test('01-004 パスワード違い', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaff(page, api, '01-004');
    await logoutStaff(page);
    const text = await loginError(page, 'staff', s.email, 'wrong-pass-01004');
    expectCredentialError(text);
    await expectAtTop(page, 'staff');
    await evidence(page, '01-004');
  });

  // 典拠：要件定義書「アプリのログイン」(4-1-1)・基本設計書「ログイン」(4-3)・図/インタフェース一覧「エラーの返し方」(0-2)
  test('01-005 登録の無いログインID', async ({ page }) => {
    const text = await loginError(page, 'staff', 'nobody01005@example.jp', 'ukeire-01005-pw');
    expectCredentialError(text);
    await expectAtTop(page, 'staff');
    await evidence(page, '01-005');
  });

  // 典拠：要件定義書「アプリのログイン」(4-1-1)・基本設計書「ログイン」(4-3)・同「メッセージ一覧」(4-12)・図/画面遷移図「共通・認証」(2)
  test('01-006 系統の違う入口（保護者が職員用から）', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const w = await newWindow(browser, { viewport: PHONE });
    const g = await makeGuardian(w.page, api, '01-006');
    await w.context.close();
    const text = await loginError(page, 'staff', g.email, g.password);
    expect.soft(text).toContain(MSG.wrongEntrance);
    await expect.soft(page.getByRole('heading', { name: 'ダッシュボード' })).toHaveCount(0);
    await evidence(page, '01-006');
    await page.getByRole('main').getByRole('link', { name: /保護者用/ }).first().click();
    await expectAtTop(page, 'guardian');
  });

  // 典拠：要件定義書「アプリのログイン」(4-1-1)（その逆もできない）・基本設計書「ログイン」(4-3)
  test('01-007 系統の違う入口（職員が保護者用から）', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const w = await newWindow(browser);
    const s = await makeStaff(w.page, api, '01-007');
    await w.context.close();
    await page.setViewportSize(PHONE);
    const text = await loginError(page, 'guardian', s.email, s.password);
    expect.soft(text).toContain(MSG.wrongEntrance);
    await expect.soft(page.getByRole('main').getByRole('link', { name: /職員用/ }).first()).toBeVisible();
    await evidence(page, '01-007');
  });

  // 典拠：基本設計書「ログイン」(4-3) の処理内容（照合のあとで系統を判定する）
  test('01-008 系統の違う入口で、パスワードも誤り', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const w = await newWindow(browser, { viewport: PHONE });
    const g = await makeGuardian(w.page, api, '01-008');
    await w.context.close();
    const text = await loginError(page, 'staff', g.email, 'wrong-pass-01008');
    expect.soft(text).toContain(MSG.credential);
    expect.soft(text, '系統の不一致の文言を出さない').not.toContain('こちらからログインできません');
    await evidence(page, '01-008');
  });

  /** 前提S+ の職員を作り、管理者が職員アカウント管理画面で停止する（確認ダイアログを経る）。page は入口に戻る */
  async function makeStoppedStaff(page: Page, browser: import('@playwright/test').Browser, api: import('@playwright/test').APIRequestContext, caseNo: string) {
    const w = await newWindow(browser);
    const s = await makeStaff(w.page, api, caseNo);
    await w.context.close();
    await login(page, 'admin');
    await page.goto('/staff/admin/staff-accounts');
    await page.getByRole('row', { name: new RegExp(s.email) }).getByRole('button', { name: '停止' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /停止する/ }).click();
    await expect(page.getByRole('row', { name: new RegExp(s.email) })).toContainText('停止');
    await logoutStaff(page);
    return s;
  }

  // 典拠：要件定義書「アカウントの管理」(4-1-2) のアカウントの停止・基本設計書「ログイン」(4-3)・同「メッセージ一覧」(4-12)・図/画面詳細図 (2-1) 項目11
  test('01-009 停止中のアカウント', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStoppedStaff(page, browser, api, '01-009');
    const text = await loginError(page, 'staff', s.email, s.password);
    expect.soft(text).toContain(MSG.suspended);
    await expectAtTop(page, 'staff');
    await evidence(page, '01-009');
  });

  // 典拠：基本設計書「ログイン」(4-3) の処理内容（照合のあとで停止を判定する）
  test('01-010 停止中のアカウントで、パスワードも誤り', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStoppedStaff(page, browser, api, '01-010');
    const text = await loginError(page, 'staff', s.email, 'wrong-pass-01010');
    expect.soft(text).toContain(MSG.credential);
    expect.soft(text, '停止中であることを明かさない').not.toMatch(/停止|使えません/);
    await evidence(page, '01-010');
  });

  // 典拠：授業の雛形 1.5（SQL インジェクション対策）・基本設計書「メッセージ一覧」(4-12)
  test('01-011 SQL インジェクション（ログインID）', async ({ page }) => {
    for (const id of [`'OR'1'='1'--@example.jp`, `nishida'--@hoiku.example.jp`, `x'/**/OR/**/'1'='1@example.jp`]) {
      const text = await loginError(page, 'staff', id, 'ukeire-01011-pw');
      expect.soft(text, id).toContain(MSG.credential);
      await expect.soft(page.getByRole('heading', { name: 'ダッシュボード' }), id).toHaveCount(0);
      await expectAtTop(page, 'staff');
    }
    await evidence(page, '01-011');
  });

  // 典拠：授業の雛形 1.5（SQL インジェクション対策）・基本設計書「メッセージ一覧」(4-12)
  test('01-012 SQL インジェクション（パスワード）', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const w = await newWindow(browser);
    const s = await makeStaff(w.page, api, '01-012');
    await w.context.close();
    for (const pw of [`' OR '1'='1' --`, `' OR 1=1; --`, `x' OR 'x'='x`]) {
      const text = await loginError(page, 'staff', s.email, pw);
      expect.soft(text, pw).toContain(MSG.credential);
      await expect.soft(page.getByRole('heading', { name: 'ダッシュボード' }), pw).toHaveCount(0);
      await expectAtTop(page, 'staff');
    }
    await evidence(page, '01-012');
  });

  // 典拠：要件定義書「パスワードの再設定と一時パスワードの扱い」(4-1-1)・基本設計書「ログイン」(4-3)・同「メッセージ一覧」(4-12)
  test('01-017 一時パスワードの期限切れ', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaffIssued(api, '01-017');
    sqlRun(`UPDATE m_account SET temp_password_expires_at = '2000-01-01T00:00:00' WHERE email = ?`, s.email);
    const text = await loginError(page, 'staff', s.email, s.tempPassword);
    expect.soft(text).toContain(MSG.tempExpired);
    expect.soft(text, 'ロックの案内とは別の案内').not.toContain(MSG.locked);
    await expectAtTop(page, 'staff');
    await evidence(page, '01-017');
  });

  // 典拠：基本設計書「ログイン」(4-3) の処理内容（照合のあとで期限を判定する）
  test('01-018 一時パスワードの期限切れで、パスワードも誤り', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaffIssued(api, '01-018');
    sqlRun(`UPDATE m_account SET temp_password_expires_at = '2000-01-01T00:00:00' WHERE email = ?`, s.email);
    const text = await loginError(page, 'staff', s.email, 'wrong-pass-01018');
    expect.soft(text).toContain(MSG.credential);
    expect.soft(text, '期限切れであることを明かさない').not.toContain('有効期限');
    await evidence(page, '01-018');
  });

  /** ログインの要求を送ったか（入力の誤りを画面で止めたか、送ってサーバが断ったかを見分ける） */
  async function pressLogin(page: Page): Promise<boolean> {
    let sent = false;
    const onReq = (r: { url(): string; method(): string }) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/login')) sent = true;
    };
    page.on('request', onReq);
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await page.waitForTimeout(1500);
    page.off('request', onReq);
    return sent;
  }

  // 典拠：図/画面詳細図「職員用トップ／保護者用トップ」(2-1) 項目2・要件定義書「品質要求一覧」(7-1 No.9 ⑤)
  test('01-I001 ログインID', async ({ page }) => {
    await gotoTop(page, 'staff');
    await page.getByLabel('パスワード', { exact: true }).fill('ukeire-I001-pw');
    const sent = await pressLogin(page);
    await expectAtTop(page, 'staff');
    const id = page.getByLabel('ログインID', { exact: true });
    const missing = await id.evaluate((el) => (el as HTMLInputElement).validity.valueMissing);
    if (sent) {
      // 送ったなら、誤りの文が「空であること」を示しているか（ID とパスワードの照合の失敗と同じ文ではない）
      const text = (await page.getByRole('alert').first().textContent()) ?? '';
      expect.soft(text, '空であることを示す').toMatch(/入力|入れて|必須/);
    } else {
      expect.soft(missing, '必須の欄が空であることを示す').toBe(true);
    }
    await evidence(page, '01-I001');
  });

  // 典拠：基本設計書「入力項目の制約値」(4-12)（ログインIDはメールアドレス形式）・図/画面詳細図 (2-1) 項目2
  test('01-I002 ログインID', async ({ page }) => {
    await gotoTop(page, 'staff');
    await page.getByLabel('ログインID', { exact: true }).fill('ukeire01i002');
    await page.getByLabel('パスワード', { exact: true }).fill('ukeire-I002-pw');
    const sent = await pressLogin(page);
    await expectAtTop(page, 'staff');
    if (sent) {
      const text = (await page.getByRole('alert').first().textContent()) ?? '';
      expect.soft(text, '形式が違うことを示す').toMatch(/形式|メールアドレス/);
    } else {
      const bad = await page.getByLabel('ログインID', { exact: true }).evaluate((el) => (el as HTMLInputElement).validity.typeMismatch);
      expect.soft(bad, '形式が違うことを示す').toBe(true);
    }
    await evidence(page, '01-I002');
  });
});

// ======================================================================
// サーバA（通常）：一時パスワード・パスワード変更
// ======================================================================
test.describe('サーバA（通常）：一時パスワードとパスワードの変更', () => {
  // 典拠：要件定義書「パスワードの再設定と一時パスワードの扱い」(4-1-1)・同「初回ログインの順番（職員）」(4-1-1)・図/画面詳細図「パスワード変更画面」(2-4) 項目1・7・8
  test('01-013 一時パスワードでの初回ログイン', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaffIssued(api, '01-013');
    await loginWith(page, 'staff', s.email, s.tempPassword);
    const main = page.getByRole('main');
    await expect(page.getByRole('heading', { name: 'パスワードの変更' })).toBeVisible();
    await expect.soft(main.getByRole('alert').first(), '変更を促す案内').toBeVisible();
    await expect.soft(page.getByRole('button', { name: 'やめる' }), '「やめる」は置かない').toHaveCount(0);
    await expect.soft(page.getByRole('navigation'), 'ほかの画面への導線を出さない').toHaveCount(0);
    const logout = main.getByRole('button', { name: /ログアウト/ });
    await expect.soft(logout).toBeVisible();
    await evidence(page, '01-013');
    await logout.click();
    await expectAtTop(page, 'staff');
  });

  // 典拠：要件定義書「パスワードの再設定と一時パスワードの扱い」(4-1-1)・基本設計書「画面遷移」(3-4)・同「メッセージ一覧」(4-12)
  test('01-014 一時パスワードの関所（画面）', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaffIssued(api, '01-014');
    await loginWith(page, 'staff', s.email, s.tempPassword);
    await page.goto('/staff'); // 管理者で職員ダッシュボードを開いて控えたアドレス
    await expect.soft(page.getByRole('heading', { name: 'ダッシュボード' })).toHaveCount(0);
    await expect.soft(page.getByRole('heading', { name: 'パスワードの変更' })).toBeVisible();
    await expect.soft(page.getByText(MSG.passwordFirst)).toBeVisible();
    await evidence(page, '01-014');
  });

  // 典拠：要件定義書「パスワードの再設定と一時パスワードの扱い」(4-1-1)・同「セキュリティ要求」(8 No.2)・基本設計書「メッセージ一覧」(4-12)・図/インタフェース一覧「知らせ（SSE）の形」(1-3)
  test('01-015 一時パスワードの関所（API）', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaffIssued(api, '01-015');
    await loginWith(page, 'staff', s.email, s.tempPassword);
    const headers = { Origin: origin() };
    for (const p of ['/api/children', '/api/reference', '/api/dashboard/staff']) {
      const res = await page.request.get(p);
      expect.soft(res.status(), p).toBe(403);
      expect.soft(((await res.json().catch(() => ({}))) as { message?: string }).message, `${p} の理由`).toBe(MSG.passwordFirst);
    }
    const out = await page.request.post('/api/logout', { headers });
    expect.soft(out.ok(), 'ログアウトはできる').toBe(true);
    expect.soft((await page.request.get('/api/me')).status(), 'ログアウトしている').toBe(401);
    await page.goto('/staff-top');
    await evidence(page, '01-015');
  });

  // 典拠：要件定義書「初回ログインの順番（職員）」(4-1-1)・基本設計書「ログイン」(4-3)・図/画面詳細図「パスワード変更画面」(2-4) 項目6・図/画面遷移図「共通・認証」(2)
  test('01-016 職員の初回ログインの順番', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaffIssued(api, '01-016');
    await loginWith(page, 'staff', s.email, s.tempPassword);
    await page.getByLabel(/現在のパスワード/).fill(s.tempPassword);
    await page.getByRole('textbox', { name: /^新しいパスワード\s*必須$/ }).fill(s.password);
    await page.getByLabel(/新しいパスワード（確認）/).fill(s.password);
    await page.getByRole('button', { name: '変更する' }).click();
    await expect(page.getByRole('button', { name: '同意して進む' }), '① 利用規約同意画面へ進む').toBeVisible();
    await checkAllConsents(page);
    await page.getByRole('button', { name: '同意して進む' }).click();
    await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), '② 職員ダッシュボード').toBeVisible();
    await logoutStaff(page);
    const text = await loginError(page, 'staff', s.email, s.tempPassword);
    expect.soft(text, '③ 一時パスワードは無効').toContain(MSG.credential);
    await loginWith(page, 'staff', s.email, s.password);
    await expect.soft(page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), '④ 手続きを通らずにダッシュボード').toBeVisible();
    await evidence(page, '01-016');
  });

  // 典拠：要件定義書「パスワードの再設定と一時パスワードの扱い」(4-1-1)・基本設計書「一時パスワードの再発行」(4-3)・図/画面詳細図「パスワード変更画面」(2-4) 項目6・同「保護者アカウント管理画面」(7-8) 項目7
  test('01-019 保護者の一時パスワード', async ({ page, playwright }) => {
    await page.setViewportSize(PHONE);
    const api = await adminApi(playwright);
    const g = await makeGuardian(page, api, '01-019');
    await logoutGuardian(page);
    // 管理者が保護者アカウント管理画面で一時パスワードを再発行する。画面に口が無ければ同じ経路の API で再発行する
    const [acc] = await guardianAccountsByEmail(api, g.email);
    const res = await api.post(`/api/admin/accounts/${acc.account.account_id}/temp-password`);
    expect(res.ok(), '一時パスワードの再発行').toBe(true);
    const body = (await res.json()) as { password?: string; temp_password?: string };
    const temp = body.password ?? body.temp_password ?? '';
    const old = await loginError(page, 'guardian', g.email, g.password);
    expect.soft(old, '① 元のパスワードは無効').toContain(MSG.credential);
    await loginWith(page, 'guardian', g.email, temp);
    await expect(page.getByRole('heading', { name: 'パスワードの変更' }), '② パスワード変更画面（強制）').toBeVisible();
    await page.getByLabel(/現在のパスワード/).fill(temp);
    await page.getByRole('textbox', { name: /^新しいパスワード\s*必須$/ }).fill('ukeire-01019-px');
    await page.getByLabel(/新しいパスワード（確認）/).fill('ukeire-01019-px');
    await page.getByRole('button', { name: '変更する' }).click();
    await expect.soft(todayRegion(page, g.childName), '③ 利用規約同意画面を通らずに保護者ホーム').toBeVisible();
    await evidence(page, '01-019');
  });

  // 典拠：図/画面詳細図「パスワード変更画面」(2-4) 項目1・5・6 と注記・同「職員（タブレット／PC）」(1-1) 項目12・同「保護者（スマートフォン）」(1-2) 項目7
  test('01-020 任意の変更（職員・保護者）', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaff(page, api, '01-020');
    await page.getByRole('navigation').getByRole('link', { name: 'パスワードの変更' }).click();
    await expect.soft(page.getByText('8文字以上。文字の種類の組み合わせは問わない'), '① 条件を入力の前に示す').toBeVisible();
    await expect.soft(page.getByRole('main').getByText(/一時パスワード/), '② 強制のときの案内を出さない').toHaveCount(0);
    await page.getByLabel(/現在のパスワード/).fill(s.password);
    await page.getByRole('textbox', { name: /^新しいパスワード\s*必須$/ }).fill('ukeire-01020-px');
    await page.getByLabel(/新しいパスワード（確認）/).fill('ukeire-01020-px');
    await page.getByRole('button', { name: '変更する' }).click();
    await expect.soft(page.getByRole('heading', { name: 'パスワードの変更' }), '③ 同じ画面に留まる').toBeVisible();
    await expect.soft(page.getByText(/変更しました|変えました/).first(), '③ 変更した旨').toBeVisible();
    await evidence(page, '01-020');
    await logoutStaff(page);
    await loginWith(page, 'staff', s.email, 'ukeire-01020-px');
    await expect.soft(page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), '④ 新しいパスワードでログインできる').toBeVisible();
    // 保護者（メニューから）
    const w = await newWindow(browser, { viewport: PHONE });
    const g = await makeGuardian(w.page, api, '01-020');
    await w.page.getByRole('banner').getByRole('button', { name: /メニュー/ }).click();
    await w.page.getByRole('dialog', { name: 'メニュー' }).getByRole('link', { name: 'パスワードの変更' }).click();
    await expect.soft(w.page.getByText('8文字以上。文字の種類の組み合わせは問わない'), '① 保護者').toBeVisible();
    await w.page.getByLabel(/現在のパスワード/).fill(g.password);
    await w.page.getByRole('textbox', { name: /^新しいパスワード\s*必須$/ }).fill('ukeire-g01020-px');
    await w.page.getByLabel(/新しいパスワード（確認）/).fill('ukeire-g01020-px');
    await w.page.getByRole('button', { name: '変更する' }).click();
    await expect.soft(w.page.getByRole('heading', { name: 'パスワードの変更' }), '③ 保護者').toBeVisible();
    await logoutGuardian(w.page);
    await loginWith(w.page, 'guardian', g.email, 'ukeire-g01020-px');
    await expect.soft(todayRegion(w.page, g.childName), '④ 保護者').toBeVisible();
    await w.context.close();
  });

  // 典拠：要件定義書「同時ログインの扱い」(4-1-1)・同「セキュリティ要求」(8 No.9)・基本設計書「認証情報の保持方式」(6-3)
  test('01-021 変更した端末以外のセッション', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaff(page, api, '01-021'); // A
    const b = await newWindow(browser); // B
    await loginWith(b.page, 'staff', s.email, s.password);
    await expect(b.page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), '① B も同時にログインできる').toBeVisible();
    await page.goto('/staff/password');
    await page.getByLabel(/現在のパスワード/).fill(s.password);
    await page.getByRole('textbox', { name: /^新しいパスワード\s*必須$/ }).fill('ukeire-01021-px');
    await page.getByLabel(/新しいパスワード（確認）/).fill('ukeire-01021-px');
    await page.getByRole('button', { name: '変更する' }).click();
    await page.waitForTimeout(1000);
    await b.page.goto('/staff');
    await expect.soft(b.page.getByLabel('ログインID', { exact: true }), '② B はログインしていない扱い').toBeVisible();
    await page.goto('/staff');
    await expect.soft(page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), '③ A はログインしたまま').toBeVisible();
    await evidence(page, '01-021');
    await b.context.close();
  });
});

// ======================================================================
// サーバA（通常）：規約の再同意（デモの規約の再同意の保護者を順に使う）
// ======================================================================
test.describe('サーバA（通常）：規約の再同意', () => {
  // デモの規約の再同意の保護者を使う。01-023・01-024・01-I024 は同意せずに終え、01-022 だけが同意する（最後に置く）。
  // 落ちたあとはワーカーが立ち直り、この describe のサーバも新しいデータベースで立ち直る
  test.use({ viewport: PHONE });

  // 典拠：要件定義書「利用規約に同意しなかった場合」(4-1-1)・図/画面詳細図「利用規約同意画面」(2-5) 項目8・図/画面遷移図「共通・認証」(2)
  test('01-023 同意せずログアウトする', async ({ page }) => {
    await login(page, 'guardianTermsStale');
    await expect(page.getByRole('button', { name: '同意して進む' })).toBeVisible();
    await page.getByRole('button', { name: '同意せずログアウトする' }).click();
    await expectAtTop(page, 'guardian');
    await evidence(page, '01-023');
    await login(page, 'guardianTermsStale');
    await expect.soft(page.getByRole('button', { name: '同意して進む' }), '② 同意は記録されない').toBeVisible();
    await page.getByRole('button', { name: '同意せずログアウトする' }).click();
  });

  // 典拠：要件定義書「利用規約に同意しなかった場合」(4-1-1)・基本設計書「画面遷移」(3-4)・図/インタフェース一覧「知らせ（SSE）の形」(1-3)
  test('01-024 規約の同意の関所', async ({ page }) => {
    await login(page, 'guardianTermsStale');
    await page.goto('/guardian'); // 保護者で保護者ホームを開いて控えたアドレス
    await expect.soft(page.getByRole('button', { name: '同意して進む' }), '① 利用規約同意画面から先へ進めない').toBeVisible();
    await expect.soft(page.getByRole('heading', { name: 'チャット・お知らせ' }), '① 保護者ホームを出さない').toHaveCount(0);
    for (const p of ['/api/dashboard/guardian', '/api/children']) {
      expect.soft((await page.request.get(p)).status(), p).toBe(403);
    }
    await evidence(page, '01-024');
    await page.getByRole('button', { name: '同意せずログアウトする' }).click();
  });

  // 典拠：要件定義書「利用規約への同意」(4-1-1)（両方への同意）・図/画面詳細図「利用規約同意画面」(2-5) 項目5〜7
  test('01-I024 利用規約・プライバシーポリシーの同意', async ({ page }) => {
    await login(page, 'guardianTermsStale');
    const terms = page.getByRole('checkbox', { name: /利用規約に同意/ });
    const privacy = page.getByRole('checkbox', { name: /プライバシーポリシーに同意/ });
    const next = page.getByRole('button', { name: '同意して進む' });
    await expect(privacy, 'プライバシーポリシーの同意のチェック（2-5 項目6）').toBeVisible();
    // ① 利用規約だけ
    await terms.check();
    await expect.soft(next, '① 利用規約だけでは進めない').toBeDisabled();
    // ② プライバシーポリシーだけ
    await terms.uncheck();
    await privacy.check();
    await expect.soft(next, '② プライバシーポリシーだけでは進めない').toBeDisabled();
    await evidence(page, '01-I024');
    await page.getByRole('button', { name: '同意せずログアウトする' }).click();
  });

  // 典拠：要件定義書「利用規約への同意」(4-1-1)・基本設計書「ログイン」(4-3) の画面表示 2・図/画面詳細図「利用規約同意画面」(2-5) 項目2〜7・図/画面遷移図「共通・認証」(2)
  test('01-022 規約の再同意', async ({ page }) => {
    await login(page, 'guardianTermsStale');
    const main = page.getByRole('main');
    await expect(page.getByRole('button', { name: '同意して進む' }), '① 利用規約同意画面（強制）').toBeVisible();
    await expect.soft(page.getByRole('checkbox', { name: /利用規約に同意/ })).toBeVisible();
    await expect.soft(page.getByRole('checkbox', { name: /プライバシーポリシーに同意/ }), '① 同意のチェックが2つ').toBeVisible();
    await expect.soft(main, '② 同意を求める画面に版と施行日を出さない').not.toContainText(/施行日[:：]|1\.1\s*版|版[:：]\s*1\.1/);
    await evidence(page, '01-022');
    await checkAllConsents(page);
    await page.getByRole('button', { name: '同意して進む' }).click();
    await expect.soft(todayRegion(page, ACCOUNTS.guardianTermsStale.children[0].name), '③ 保護者ホーム').toBeVisible();
    await logoutGuardian(page);
    await login(page, 'guardianTermsStale');
    await expect.soft(page.getByRole('button', { name: '同意して進む' }), '④ 次のログインでは出ない').toHaveCount(0);
  });
});

// ======================================================================
// サーバA（通常）：新規登録
// ======================================================================
test.describe('サーバA（通常）：新規登録', () => {
  test.use({ viewport: PHONE });

  // 典拠：図/画面詳細図「新規登録画面（保護者）」(2-3) 項目2〜16 と注記・要件定義書「利用規約への同意」(4-1-1)
  test('01-025 初期の状態と段階', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    await createChild(api, { id: 'C01025', name: '受入 01-025' });
    const code = await issueCode(api, 'C01025');
    await page.goto('/');
    await page.getByRole('link', { name: '招待コードで新規登録' }).click();
    const terms = page.getByRole('checkbox', { name: /利用規約に同意/ });
    const privacy = page.getByRole('checkbox', { name: /プライバシーポリシーに同意/ });
    const email = page.getByLabel(/メールアドレス/);
    // ①
    await expect.soft(page.getByRole('textbox', { name: /招待コード/ })).toBeEnabled();
    await expect.soft(terms, '① 規約の同意は操作できない').toBeDisabled();
    await expect.soft(email, '① アカウント情報は操作できない').toBeDisabled();
    // ②
    await page.getByRole('textbox', { name: /招待コード/ }).fill(code);
    await page.getByRole('button', { name: 'コードを確認する' }).click();
    await expect(terms).toBeEnabled();
    await expect.soft(privacy, '② プライバシーポリシーの同意（2-3 項目13）').toBeVisible();
    await expect.soft(page.getByRole('main'), '② 園児名を出さない').not.toContainText('受入 01-025');
    // ③
    await terms.check();
    await expect.soft(email, '③ 片方だけではアカウント情報を操作できない').toBeDisabled();
    // ④
    if (await privacy.count()) await privacy.check();
    await expect.soft(email, '④ 両方で操作できる').toBeEnabled();
    await expect.soft(page.getByLabel(/続柄/), '④ 続柄は未選択').toHaveValue('');
    await expect.soft(page.getByRole('checkbox', { name: 'ログイン状態を保持する' }), '④ 保持はオン（2-3 項目16）').toBeChecked();
    await evidence(page, '01-025');
  });

  // 典拠：要件定義書「アカウントの管理」(4-1-2)・基本設計書「保護者アカウントの自己登録」(4-3)・図/画面詳細図「新規登録画面（保護者）」(2-3) 項目9・同「招待コード管理画面」(7-7) 項目7
  test('01-026 新規登録の完了', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    await createChild(api, { id: 'C01026', name: '受入 01-026' });
    const code = await issueCode(api, 'C01026');
    await signupScreen(page, { code, name: '受入 保護者 01-026', email: 'g01026@example.jp', password: 'ukeire-01026-pw', phone: '090-0000-1026' });
    await expect.soft(todayRegion(page, '受入 01-026'), '① 保護者ホーム').toBeVisible();
    await expect.soft(page.getByText(/ホーム画面に追加/).first(), '② 初めての案内').toBeVisible();
    await evidence(page, '01-026');
    // ③ 招待コード管理画面で使用済み
    const a = await newWindow(browser);
    await loginWith(a.page, 'staff', ACCOUNTS.admin.email, passwordOf('admin'));
    await a.page.goto('/staff/admin/invitations');
    await expect.soft(a.page.getByRole('row', { name: new RegExp(code) }), '③ 使用済み').toContainText('使用済');
    await a.context.close();
    // ④
    await logoutGuardian(page);
    await loginWith(page, 'guardian', 'g01026@example.jp', 'ukeire-01026-pw');
    await expect.soft(todayRegion(page, '受入 01-026'), '④ ログインできる').toBeVisible();
  });

  // 典拠：基本設計書「保護者アカウントの自己登録」(4-3) の処理内容 6・同「メッセージ一覧」(4-12)
  test('01-027 確かめたあと、登録の前にコードが使われた', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    await createChild(api, { id: 'C01027', name: '受入 01-027' });
    const code = await issueCode(api, 'C01027');
    await fillSignup(page, { code, name: '受入 保護者 01-027a', email: 'g01027a@example.jp', password: 'ukeire-01027-pw' });
    const b = await newWindow(browser, { viewport: PHONE });
    await signupScreen(b.page, { code, name: '受入 保護者 01-027b', email: 'g01027b@example.jp', password: 'ukeire-01027-pw' });
    await b.context.close();
    await page.getByRole('button', { name: '登録する' }).click();
    await expect.soft(page.getByText(MSG.codeUsed), '① 登録できない').toBeVisible();
    expect.soft((await guardianAccountsByEmail(api, 'g01027a@example.jp')).length, '② A のアカウントは無い').toBe(0);
    expect.soft((await guardianAccountsByEmail(api, 'g01027b@example.jp')).length, '② B の1件だけ').toBe(1);
    await evidence(page, '01-027');
  });

  // 典拠：要件定義書「招待コードの発行」(4-1-2)・基本設計書「保護者アカウントの自己登録」(4-3)・同「メッセージ一覧」(4-12)
  test('01-028 同じコードで同時に登録', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    await createChild(api, { id: 'C01028', name: '受入 01-028' });
    const code = await issueCode(api, 'C01028');
    const b = await newWindow(browser, { viewport: PHONE });
    await fillSignup(page, { code, name: '受入 保護者 01-028a', email: 'g01028a@example.jp', password: 'ukeire-01028-pw' });
    await fillSignup(b.page, { code, name: '受入 保護者 01-028b', email: 'g01028b@example.jp', password: 'ukeire-01028-pw' });
    await Promise.all([page.getByRole('button', { name: '登録する' }).click(), b.page.getByRole('button', { name: '登録する' }).click()]);
    await page.waitForTimeout(2500);
    const done = [page, b.page].filter((p) => new URL(p.url()).pathname.startsWith('/guardian'));
    const refused = [page, b.page].filter((p) => !new URL(p.url()).pathname.startsWith('/guardian'));
    expect.soft(done.length, '① 通るのは1件だけ').toBe(1);
    const created = (await guardianAccountsByEmail(api, 'g01028a@example.jp')).length + (await guardianAccountsByEmail(api, 'g01028b@example.jp')).length;
    expect.soft(created, '① アカウントは1件').toBe(1);
    if (refused.length === 1) await expect.soft(refused[0].getByText(MSG.codeUsed), '② もう1件の文言').toBeVisible();
    await evidence(refused[0] ?? page, '01-028');
    await b.context.close();
  });

  // 典拠：授業の雛形 1.5（クロスサイトスクリプティング対策）・図/画面詳細図「保護者アカウント管理画面」(7-8) 項目3
  test('01-029 文字の中の HTML のタグ（XSS）', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    await createChild(api, { id: 'C01029', name: '受入 01-029' });
    const code = await issueCode(api, 'C01029');
    const tagged = '<b>受入01-029</b><script>alert(1)</script>';
    await signupScreen(page, { code, name: tagged, email: 'g01029@example.jp', password: 'ukeire-01029-pw' });
    const a = await newWindow(browser);
    const dialogs: string[] = [];
    a.page.on('dialog', async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    await loginWith(a.page, 'staff', ACCOUNTS.admin.email, passwordOf('admin'));
    await a.page.goto('/staff/admin/guardian-accounts');
    const row = a.page.getByRole('row', { name: /g01029@example\.jp/ });
    await expect.soft(row, '② タグのまま文字として出る').toContainText(tagged);
    await expect.soft(row.locator('b'), '② 太字にならない').toHaveCount(0);
    expect.soft(dialogs, '② スクリプトが動かない').toEqual([]);
    await row.scrollIntoViewIfNeeded();
    await evidence(a.page, '01-029');
    await a.context.close();
  });

  // 典拠：授業の雛形 1.5（二重送信の防止）・基本設計書「保護者アカウントの自己登録」(4-3)
  test('01-030 二重送信（登録のあとのリロード）', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    let signups = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/signup')) signups++;
    });
    const g = await makeGuardian(page, api, '01-030');
    const before = signups;
    await page.reload();
    await page.reload();
    await expect.soft(todayRegion(page, g.childName), '① 保護者ホームのまま').toBeVisible();
    expect.soft(signups, '① 登録の要求をもう一度送らない').toBe(before);
    expect.soft((await guardianAccountsByEmail(api, g.email)).length, '② 保護者は1件').toBe(1);
    await evidence(page, '01-030');
  });

  // 典拠：授業の雛形 1.5（二重送信の防止）・要件定義書「招待コードの発行」(4-1-2)
  test('01-031 二重送信（ボタンを続けて押す）', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    await createChild(api, { id: 'C01031', name: '受入 01-031' });
    const code = await issueCode(api, 'C01031');
    await fillSignup(page, { code, name: '受入 保護者 01-031', email: 'g01031@example.jp', password: 'ukeire-01031-pw' });
    await page.getByRole('button', { name: '登録する' }).dblclick();
    await page.waitForTimeout(2500);
    expect.soft((await guardianAccountsByEmail(api, 'g01031@example.jp')).length, '① 1件だけ').toBe(1);
    await expect.soft(todayRegion(page, '受入 01-031'), '② 保護者ホームが開く').toBeVisible();
    await evidence(page, '01-031');
  });

  // 典拠：授業の雛形 1.5（二重送信の防止）・要件定義書「同時ログインの扱い」(4-1-1)・図/画面詳細図「ログイン中に入口を開いたとき」(2-2)
  test('01-032 二重送信（ログインのあとのリロード）', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const g = await makeGuardian(page, api, '01-032');
    await logoutGuardian(page);
    let logins = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/login')) logins++;
    });
    await loginWith(page, 'guardian', g.email, g.password);
    const before = logins;
    await page.reload();
    await expect.soft(todayRegion(page, g.childName), '① 保護者ホームのまま').toBeVisible();
    expect.soft(logins, '① ログインの要求をもう一度送らない').toBe(before);
    await page.goBack();
    await page.waitForTimeout(800);
    if (new URL(page.url()).pathname === '/') {
      await expect.soft(page.getByLabel('ログインID', { exact: true }), '② ログインフォームを出さない').toHaveCount(0);
      await expect.soft(page.getByRole('button', { name: /ログアウト/ }), '② ログアウトの導線').toBeVisible();
    }
    await evidence(page, '01-032');
  });
});

// ======================================================================
// サーバA（通常）：ホーム・ログイン中・ログアウト・記憶
// ======================================================================
test.describe('サーバA（通常）：ホーム', () => {
  // 典拠：基本設計書「画面基本構成」(3-5)・図/画面詳細図「職員（タブレット／PC）」(1-1) 項目3・5・9・同「職員ダッシュボード」(2-6) の項目と注記
  test('01-033 一般のホーム', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaff(page, api, '01-033');
    const header = page.getByRole('banner');
    const nav = page.getByRole('navigation');
    const main = page.getByRole('main');
    await expect.soft(header).toContainText(s.name);
    await expect.soft(header).toContainText('さくら組');
    await expect.soft(header.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
    await expect.soft(header).toContainText('すぐに反映');
    for (const name of ['ダッシュボード', '連絡帳', '日誌', 'チャット', '午睡チェック', '発達・身体', '園児', 'パスワードの変更', '利用規約']) {
      await expect.soft(nav.getByRole('link', { name, exact: true }), `② サイドナビ ${name}`).toBeVisible();
    }
    await expect.soft(nav, '② 「管理」は出ない').not.toContainText('管理');
    await expect.soft(main, '③ 本日の日付').toContainText(jstParts(jstToday()).slash);
    for (const item of ['家庭からの連絡', '園からのひとことを送っていない園児', '未対応の個人チャット', '午睡中の園児', '差し戻された日誌', '発達チェックの予定日が近い', 'ヒヤリハット未起票の異常時の記録']) {
      await expect.soft(main.getByText(item).first(), `④ ${item}`).toBeVisible();
    }
    await expect.soft(main.getByRole('heading', { name: 'よく使う' }), '④ よく使う').toBeVisible();
    await expect.soft(main, '⑤ 承認待ちの日誌を出さない').not.toContainText('承認待ち');
    await expect.soft(main, '⑤ 異常時の記録（未確認）を出さない').not.toContainText('異常時の記録（未確認）');
    await expect.soft(main, '⑥ 範囲「担当クラス」').toContainText('担当クラス');
    await evidence(page, '01-033');
  });

  // 典拠：基本設計書「画面基本構成」(3-5)・図/画面詳細図「職員（タブレット／PC）」(1-1) 項目5・同「職員ダッシュボード」(2-6) 項目2・8 と注記
  test('01-034 管理者のホーム', async ({ page }) => {
    await login(page, 'admin');
    const nav = page.getByRole('navigation');
    const main = page.getByRole('main');
    await expect.soft(nav).toContainText('管理（管理者）');
    for (const name of ['承認待ち', '職員アカウント', '招待コード', '保護者アカウント', '年度更新', '操作ログ', '誤送信対応', '設定']) {
      await expect.soft(nav.getByRole('link', { name, exact: true }), `① ${name}`).toBeVisible();
    }
    await expect.soft(main.getByText('承認待ち').first(), '② 承認待ちの日誌').toBeVisible();
    await expect.soft(main.getByText('差し戻された日誌'), '② 差し戻された日誌を出さない').toHaveCount(0);
    await expect.soft(main, '③ 範囲「全クラス」').toContainText('全クラス');
    await evidence(page, '01-034');
  });

  test.describe('保護者の画面', () => {
    test.use({ viewport: PHONE });

    // 典拠：基本設計書「画面基本構成」(3-5)・同「保護者ホームの『きょう』」(3-5)・図/画面詳細図「保護者ホーム」(2-7) 項目1〜13・16・17・同「保護者（スマートフォン）」(1-2) 項目9・12
    test('01-035 園児1人・記録の無い日', async ({ page, playwright }) => {
      // 設定画面に園の電話番号の欄が無いため、設定マスタを SQL で書き換える（シート07 の範囲）
      sqlRun(`UPDATE m_setting SET setting_value = '03-0000-1035' WHERE setting_key = 'facility.phone_number'`);
      const api = await adminApi(playwright);
      const g = await makeGuardian(page, api, '01-035');
      await page.reload();
      const region = todayRegion(page, g.childName);
      await expect(region).toBeVisible();
      await expect.soft(page.getByRole('heading', { name: g.childName }).first(), '① 園児名').toBeVisible();
      await expect.soft(page.getByRole('main'), '① クラス').toContainText('さくら組');
      await expect.soft(region, '① きょうの日付').toContainText(jstParts(jstToday()).md);
      await expect.soft(page.getByRole('main').getByRole('img'), '② 顔写真を出さない').toHaveCount(0);
      await expect.soft(region, '③ まだ書いていません').toContainText('まだ書いていません');
      await expect.soft(region.getByRole('link', { name: '家庭からを書く' }), '③ 家庭からを書く').toBeVisible();
      await expect.soft(region, '④').toContainText('まだきょうの記録はありません');
      for (const name of ['連絡帳を開く', '成長の記録', `${g.childName}の園とのやりとり`]) {
        await expect.soft(region.getByRole('link', { name: new RegExp(name) }), `⑤ ${name}`).toBeVisible();
      }
      await expect.soft(page.getByRole('heading', { name: 'チャット・お知らせ' }), '⑥').toBeVisible();
      await expect.soft(page.getByRole('link', { name: '園からの配布物を見る' }), '⑥').toBeVisible();
      const footer = page.getByRole('contentinfo');
      await expect.soft(footer, '⑦').toContainText('緊急のご連絡はお電話でお願いします');
      await expect.soft(footer.getByRole('link', { name: '03-0000-1035' }), '⑦ 園の電話番号').toHaveAttribute('href', /^tel:/);
      await expect.soft(page.getByRole('navigation'), '⑧ サイドナビを持たない').toHaveCount(0);
      await evidence(page, '01-035');
      await page.getByRole('banner').getByRole('button', { name: /メニュー/ }).click();
      await expect.soft(page.getByRole('dialog', { name: 'メニュー' }).getByRole('button', { name: 'ログアウト', exact: true }), '⑧ メニューにログアウト').toBeVisible();
    });

    // 典拠：基本設計書「お子さまの追加（園児の追加紐づけ）」(4-3)・同「画面体系図」(3-3)・図/画面詳細図「お子さまの追加（保護者のメニュー）」(1-3 (7))・同「保護者ホーム」(2-7) 項目1・同「保護者（スマートフォン）」(1-2) 項目13・14・詳細設計書「本書で足す文言」(4-1 (6))
    test('01-036 お子さまの追加（きょうだい）', async ({ page, playwright }) => {
      const api = await adminApi(playwright);
      const g = await makeGuardian(page, api, '01-036');
      await createChild(api, { id: 'C01036b', name: '受入 01-036b', className: 'ひまわり組', birth: '2023-04-01' });
      const code = await issueCode(api, 'C01036b');
      await page.getByRole('banner').getByRole('button', { name: /メニュー/ }).click();
      await page.getByRole('dialog', { name: 'メニュー' }).getByRole('button', { name: 'お子さまの追加' }).click();
      const dlg = page.getByRole('dialog', { name: /お子さまの追加/ });
      await dlg.getByRole('textbox', { name: /招待コード/ }).fill(code);
      await dlg.getByRole('button', { name: 'コードを確認する' }).click();
      await expect.soft(dlg.getByText('受入 01-036bさんを追加します。'), '①').toBeVisible();
      await expect.soft(dlg.getByLabel(/続柄/), '① 続柄の初期値は最初の続柄').toHaveValue('母');
      await dlg.getByRole('button', { name: '追加する' }).click();
      await expect.soft(page.getByText('受入 01-036bさんを追加しました。'), '②').toBeVisible();
      const regions = page.getByRole('region', { name: /さんのきょう$/ });
      await expect.soft(regions, '③ 区画が2つ').toHaveCount(2);
      await expect.soft(regions.first(), '③ 上の子が上').toHaveAccessibleName('受入 01-036bさんのきょう');
      await evidence(page, '01-036');
      await page.getByRole('banner').getByRole('button', { name: /メニュー/ }).click();
      const menu = page.getByRole('dialog', { name: 'メニュー' });
      for (const name of [`受入 01-036bの連絡帳`, `${g.childName}の連絡帳`, `受入 01-036bの成長の記録`, `${g.childName}の成長の記録`]) {
        await expect.soft(menu.getByRole('link', { name: new RegExp(name.replace(/\s/g, '\\s*')) }), `④ ${name}`).toBeVisible();
      }
    });
  });
});

test.describe('サーバA（通常）：ログイン中・ログアウト・記憶', () => {
  // 典拠：要件定義書「同時ログインの扱い」(4-1-1)・基本設計書「ログイン」(4-3) の画面表示 1・図/画面詳細図「ログイン中に入口を開いたとき」(2-2)
  test('01-037 ログイン中に入口を開く', async ({ page, playwright }) => {
    await page.setViewportSize(PHONE);
    const api = await adminApi(playwright);
    const g = await makeGuardian(page, api, '01-037');
    await page.goto('/staff-top');
    const main = page.getByRole('main');
    await expect.soft(page.getByLabel('ログインID', { exact: true }), '① ログインフォームを出さない').toHaveCount(0);
    await expect.soft(main, '① すでにログインしている旨').toContainText('すでにログイン');
    await expect.soft(main, '② 氏名を出さない').not.toContainText('受入 保護者 01-037');
    await expect.soft(main, '② 園児名を出さない').not.toContainText(g.childName);
    await expect.soft(main, '② ロールを出さない').not.toContainText('保護者');
    await evidence(page, '01-037');
    await page.getByRole('button', { name: '前の画面へ戻る' }).click();
    await expect.soft(todayRegion(page, g.childName), '③ 保護者の画面へ戻る').toBeVisible();
    await page.goto('/staff-top');
    await page.getByRole('button', { name: 'ログアウトする' }).click();
    await expectAtTop(page, 'staff');
  });

  // 典拠：要件定義書「同時ログインの扱い」(4-1-1)（認証を成立させない、上書きログインを設けない）・基本設計書「ログイン」(4-3)
  test('01-038 ログイン中の別のログイン', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    await page.setViewportSize(PHONE);
    const g = await makeGuardian(page, api, '01-038');
    const res = await page.request.post('/api/login', { headers: { Origin: origin() }, data: { email: ACCOUNTS.admin.email, password: passwordOf('admin'), entrance: 'staff' } });
    expect.soft(res.ok(), '① ログインは成立しない').toBe(false);
    const me = (await (await page.request.get('/api/me')).json()) as { email?: string };
    expect.soft(me.email, '② 元の保護者のセッションのまま').toBe(g.email);
    await page.goto('/guardian');
    await expect.soft(todayRegion(page, g.childName), '② 保護者ホームが使える').toBeVisible();
    await evidence(page, '01-038');
  });

  // 典拠：要件定義書「アプリのログイン」(4-1-1) のログアウト（遷移先）・基本設計書「ログアウト」(4-3)・図/画面詳細図 (1-1) 項目4・(1-2) 項目9
  test('01-039 ログアウト', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    await makeStaff(page, api, '01-039');
    await logoutStaff(page);
    await expectAtTop(page, 'staff');
    await page.goBack();
    await page.waitForTimeout(800);
    await expect.soft(page.getByRole('heading', { name: 'ダッシュボード' }), '② 記録の中身を出さない').toHaveCount(0);
    await expect.soft(page.getByLabel('ログインID', { exact: true }), '② 入口へ戻る').toBeVisible();
    const w = await newWindow(browser, { viewport: PHONE });
    const g = await makeGuardian(w.page, api, '01-039');
    await logoutGuardian(w.page);
    await expectAtTop(w.page, 'guardian');
    await w.page.goBack();
    await w.page.waitForTimeout(800);
    await expect.soft(todayRegion(w.page, g.childName), '② 保護者の記録を出さない').toHaveCount(0);
    await expect.soft(w.page.getByLabel('ログインID', { exact: true }), '② 保護者用トップ').toBeVisible();
    await evidence(page, '01-039');
    await w.context.close();
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.9)・基本設計書「ログアウト」(4-3)・図/インタフェース一覧「エラーの返し方」(0-2)
  test('01-040 ログアウトのあとのセッション', async ({ context, page, playwright }) => {
    const api = await adminApi(playwright);
    await makeStaff(page, api, '01-040');
    const cookies = await context.cookies();
    const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await logoutStaff(page);
    const replay = await newApi(playwright, { headers: { Cookie: header } });
    const res = await replay.get('/api/me');
    expect(res.status(), '前のセッションの識別子では使えない').toBe(401);
    await evidence(page, '01-040');
  });

  // 典拠：要件定義書「アプリのログイン」(4-1-1) のログアウト（入力途中の記録）・基本設計書「ログアウト」(4-3)・図/画面詳細図「全画面に共通する規定」(0-2) のログアウト
  test('01-041 保存していない入力があるときのログアウト', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    await makeStaff(page, api, '01-041');
    await page.getByRole('navigation').getByRole('link', { name: 'パスワードの変更' }).click();
    const field = page.getByRole('textbox', { name: /^新しいパスワード\s*必須$/ });
    await field.fill('ukeire-01041-px');
    // 確認はブラウザの confirm か、画面の中のダイアログのどちらか
    let nativeConfirm = false;
    let answer: 'dismiss' | 'accept' = 'dismiss';
    page.on('dialog', async (d) => {
      nativeConfirm = true;
      await (answer === 'accept' ? d.accept() : d.dismiss());
    });
    await page.getByRole('banner').getByRole('button', { name: 'ログアウト', exact: true }).click();
    await page.waitForTimeout(800);
    const inPage = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    const shown = nativeConfirm || (await inPage.count()) > 0;
    expect(shown, '① 破棄される旨の確認が出る').toBe(true);
    await evidence(page, '01-041');
    if (!nativeConfirm) await inPage.first().getByRole('button', { name: /やめる|キャンセル|戻る/ }).click();
    await expect.soft(field, '② 入れた値が残る').toHaveValue('ukeire-01041-px');
    answer = 'accept';
    await page.getByRole('banner').getByRole('button', { name: 'ログアウト', exact: true }).click();
    if (!nativeConfirm) await page.getByRole('alertdialog').or(page.getByRole('dialog')).first().getByRole('button', { name: /ログアウト/ }).click();
    await expectAtTop(page, 'staff');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.9)・基本設計書「認証情報の保持方式」(6-3)
  test('01-042 セッションの Cookie', async ({ context, page, playwright }) => {
    const api = await adminApi(playwright);
    await makeStaff(page, api, '01-042');
    const cookies = (await context.cookies()).filter((c) => c.domain.includes('127.0.0.1'));
    expect(cookies.length, 'Cookie がある').toBeGreaterThan(0);
    for (const c of cookies) expect.soft(c.httpOnly, `① ${c.name} に HttpOnly`).toBe(true);
    const visible = await page.evaluate(() => document.cookie);
    for (const c of cookies) expect.soft(visible, '② document.cookie に識別子が出ない').not.toContain(c.value);
    const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    for (const c of cookies) expect.soft(stored, '③ localStorage に認証の情報を置かない').not.toContain(c.value);
    expect.soft(stored, '③ トークンらしい値が無い').not.toMatch(/token|session|password/i);
    await evidence(page, '01-042');
  });

  /** ブラウザを閉じて開き直した窓（期限のある Cookie だけを残す） */
  async function reopen(browser: import('@playwright/test').Browser, context: import('@playwright/test').BrowserContext, viewport = { width: 1024, height: 768 }) {
    const state = await context.storageState();
    const persisted = { ...state, cookies: state.cookies.filter((c) => c.expires > 0) };
    return newWindow(browser, { viewport, storageState: persisted });
  }

  // 典拠：要件定義書「アプリのログイン」(4-1-1) のログイン情報の記憶・図/画面詳細図「職員用トップ／保護者用トップ」(2-1) 項目4
  test('01-043 ログイン情報の記憶', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    // ① 保護者（既定のまま）
    const gw = await newWindow(browser, { viewport: PHONE });
    const g = await makeGuardian(gw.page, api, '01-043');
    await logoutGuardian(gw.page);
    await loginWith(gw.page, 'guardian', g.email, g.password);
    const g2 = await reopen(browser, gw.context, PHONE);
    await gw.context.close();
    await g2.page.goto('/guardian');
    await expect.soft(todayRegion(g2.page, g.childName), '① 保護者は再認証なしで保護者ホーム').toBeVisible();
    await g2.context.close();
    // ② 職員（既定のまま）
    const s = await makeStaff(page, api, '01-043');
    await logoutStaff(page);
    await loginWith(page, 'staff', s.email, s.password);
    const s2 = await reopen(browser, page.context());
    await s2.page.goto('/staff');
    await expect.soft(s2.page.getByLabel('ログインID', { exact: true }), '② 職員はログインを求められる').toBeVisible();
    await evidence(s2.page, '01-043');
    await s2.context.close();
  });

  // 典拠：要件定義書「アプリのログイン」(4-1-1) のログアウト（記憶の保存を破棄し、次回は再認証を求める）・基本設計書「ログアウト」(4-3)
  test('01-044 記憶を有効にしたあとのログアウト', async ({ browser, page, playwright }) => {
    await page.setViewportSize(PHONE);
    const api = await adminApi(playwright);
    const g = await makeGuardian(page, api, '01-044');
    await logoutGuardian(page);
    await gotoTop(page, 'guardian');
    await page.getByLabel('ログインID', { exact: true }).fill(g.email);
    await page.getByLabel('パスワード', { exact: true }).fill(g.password);
    await page.getByRole('checkbox', { name: 'ログイン状態を保持する' }).check();
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await expect(todayRegion(page, g.childName)).toBeVisible();
    await logoutGuardian(page);
    const r = await reopen(browser, page.context(), PHONE);
    await r.page.goto('/guardian');
    await expect(r.page.getByLabel('ログインID', { exact: true }), 'ログインを求められる').toBeVisible();
    await evidence(r.page, '01-044');
    await r.context.close();
  });
});

// ======================================================================
// サーバA（通常）：入力チェック
// ======================================================================
test.describe('サーバA（通常）：入力チェック（新規登録・パスワード・お子さまの追加）', () => {
  test.use({ viewport: PHONE });

  /** 園児と招待コードを用意し、新規登録画面で入れて「登録する」を押す。登録できたか（保護者ホームへ移ったか）を返す */
  async function trySignup(page: Page, api: import('@playwright/test').APIRequestContext, caseNo: string, fields: Partial<{ name: string; email: string; password: string; confirm: string; relationship: string | null }>): Promise<boolean> {
    // relationship: null は続柄を選ばない
    const digits = caseNo.replace(/[^0-9I]/g, '');
    await createChild(api, { id: `C${digits}`, name: `受入 ${caseNo}` });
    const code = await issueCode(api, `C${digits}`);
    const pw = fields.password ?? `ukeire-${digits.toLowerCase()}-pw`;
    await fillSignup(page, { code, name: fields.name ?? `受入 保護者 ${caseNo}`, email: fields.email ?? `g${digits.toLowerCase()}@example.jp`, password: pw, relationship: fields.relationship });
    if (fields.confirm !== undefined) await page.getByLabel(/パスワード（確認）/).fill(fields.confirm);
    const button = page.getByRole('button', { name: '登録する' });
    if (await button.isEnabled()) await button.click();
    await page.waitForTimeout(1500);
    return new URL(page.url()).pathname.startsWith('/guardian');
  }

  // 典拠：基本設計書「招待コード（t_invitation_code）」(5-2) のコードの形式・図/画面詳細図「新規登録画面（保護者）」(2-3) 項目2
  test('01-I003 招待コード', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    await createChild(api, { id: 'C01I003', name: '受入 01-I003' });
    const code = await issueCode(api, 'C01I003');
    await page.goto('/signup');
    await page.getByRole('textbox', { name: /招待コード/ }).fill(code.toLowerCase().replaceAll('-', ''));
    await page.getByRole('button', { name: 'コードを確認する' }).click();
    await expect(page.getByRole('checkbox', { name: /利用規約に同意/ }), '確かめられ、規約の同意へ進める').toBeEnabled();
    await evidence(page, '01-I003');
  });

  /** 新規登録画面でコードを確かめ、出た文を返す */
  async function verifyCode(page: Page, code: string): Promise<void> {
    await page.goto('/signup');
    await page.getByRole('textbox', { name: /招待コード/ }).fill(code);
    await page.getByRole('button', { name: 'コードを確認する' }).click();
    await page.waitForTimeout(800);
  }

  // 典拠：基本設計書「保護者アカウントの自己登録」(4-3) の処理内容 3・同「メッセージ一覧」(4-12)
  test('01-I004 招待コード', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    await verifyCode(page, 'ZZZZ-9999-ZZZZ');
    await expect.soft(page.getByText(MSG.codeUnknown), '① 発行していないコード').toBeVisible();
    await expect.soft(page.getByRole('checkbox', { name: /利用規約に同意/ }), '① 規約の同意へ進めない').toBeDisabled();
    await evidence(page, '01-I004');
    await createChild(api, { id: 'C01I004', name: '受入 01-I004' });
    const code = await issueCode(api, 'C01I004');
    const del = await api.delete('/api/children/C01I004');
    expect(del.ok(), '園児の取消（誤登録の削除）').toBe(true);
    await verifyCode(page, code);
    await expect.soft(page.getByText(MSG.codeUnknown), '② 取り消した園児のコード').toBeVisible();
  });

  // 典拠：要件定義書「招待コードの発行」(4-1-2)・基本設計書「メッセージ一覧」(4-12)
  test('01-I005 招待コード', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const w = await newWindow(browser, { viewport: PHONE });
    const g = await makeGuardian(w.page, api, '01-I005');
    await w.context.close();
    await verifyCode(page, g.code);
    await expect(page.getByText(MSG.codeUsed)).toBeVisible();
    await evidence(page, '01-I005');
  });

  // 典拠：要件定義書「アカウントの管理」(4-1-2) の招待コードの失効・基本設計書「メッセージ一覧」(4-12)・図/画面詳細図「招待コード管理画面」(7-7) 項目8
  test('01-I006 招待コード', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    await createChild(api, { id: 'C01I006', name: '受入 01-I006' });
    const code = await issueCode(api, 'C01I006');
    const a = await newWindow(browser);
    await loginWith(a.page, 'staff', ACCOUNTS.admin.email, passwordOf('admin'));
    await a.page.goto('/staff/admin/invitations');
    await a.page.getByRole('row', { name: new RegExp(code) }).getByRole('button', { name: '失効' }).click();
    const confirm = a.page.getByRole('dialog').getByRole('button', { name: /失効/ });
    if (await confirm.count()) await confirm.click();
    await expect(a.page.getByRole('row', { name: new RegExp(code) })).toContainText('失効');
    await a.context.close();
    await verifyCode(page, code);
    await expect(page.getByText(MSG.codeRevoked)).toBeVisible();
    await evidence(page, '01-I006');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.8)・基本設計書「メッセージ一覧」(4-12)
  test('01-I007 招待コード', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    await createChild(api, { id: 'C01I007', name: '受入 01-I007' });
    const code = await issueCode(api, 'C01I007');
    sqlRun(`UPDATE t_invitation_code SET expires_on = '2000-01-01' WHERE child_id = 'C01I007'`);
    await verifyCode(page, code);
    await expect(page.getByText(MSG.codeExpired)).toBeVisible();
    await evidence(page, '01-I007');
  });

  // 典拠：要件定義書「ログインIDの定義」(4-1-1)・基本設計書「保護者アカウントの自己登録」(4-3)・同「メッセージ一覧」(4-12)・同「アカウント（m_account）」(5-2)
  test('01-I008 メールアドレス', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const w = await newWindow(browser, { viewport: PHONE });
    const g = await makeGuardian(w.page, api, '01-I008');
    await w.context.close();
    const staff = await makeStaffIssued(api, '01-I008');
    for (const [i, email] of [g.email, staff.email].entries()) {
      const id = `C01I008x${i}`;
      await createChild(api, { id, name: `受入 01-I008x${i}` });
      const code = await issueCode(api, id);
      await fillSignup(page, { code, name: '受入 保護者 01-I008x', email, password: 'ukeire-I008-px' });
      await page.getByRole('button', { name: '登録する' }).click();
      await expect.soft(page.getByText(MSG.emailTaken), email).toBeVisible();
      const a = await newWindow(browser);
      await loginWith(a.page, 'staff', ACCOUNTS.admin.email, passwordOf('admin'));
      await a.page.goto('/staff/admin/invitations');
      await expect.soft(a.page.getByRole('row', { name: new RegExp(code) }), '招待コードは使われないまま').toContainText('未使用');
      await a.context.close();
      if (i === 0) await evidence(page, '01-I008');
    }
  });

  /** n 文字のメールアドレス（英数字@英数字.英数字。ローカル部64文字、ドメインのラベルは63文字以内） */
  function emailOfLength(n: number): string {
    let rest = n - 68; // 64文字＋「@」＋末尾の「.jp」
    const labels: string[] = [];
    while (rest > 0) {
      let take = Math.min(63, rest);
      if (rest - take === 1) take -= 1; // 次のラベルが空にならないように
      labels.push('b'.repeat(take));
      rest -= take;
      if (rest > 0) rest -= 1; // 区切りの「.」
    }
    return `${'a'.repeat(64)}@${labels.join('.')}.jp`;
  }

  // 典拠：基本設計書「入力項目の制約値」(4-12)（ログインID 254文字以内）
  test('01-I009 メールアドレス', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const email = emailOfLength(254);
    expect(email.length).toBe(254);
    const done = await trySignup(page, api, '01-I009', { email });
    expect(done, '254文字で登録できる').toBe(true);
    await evidence(page, '01-I009');
    await logoutGuardian(page);
    await loginWith(page, 'guardian', email, 'ukeire-01i009-pw');
    await expect.soft(todayRegion(page, '受入 01-I009'), 'そのメールアドレスでログインできる').toBeVisible();
  });

  // 典拠：基本設計書「入力項目の制約値」(4-12)
  test('01-I010 メールアドレス', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const email = emailOfLength(255);
    expect(email.length).toBe(255);
    await createChild(api, { id: 'C01I010', name: '受入 01-I010' });
    const code = await issueCode(api, 'C01I010');
    await fillSignup(page, { code, name: '受入 保護者 01-I010', email, password: 'ukeire-01i010-pw' });
    const typed = await page.getByLabel(/メールアドレス/).inputValue();
    // 入力欄が255文字目を受け付けないときも、255文字で登録されなければよい（sheet-01.md 01-I010 の備考）
    if (typed.length === 255) {
      await page.getByRole('button', { name: '登録する' }).click();
      await page.waitForTimeout(1500);
      expect.soft(new URL(page.url()).pathname.startsWith('/guardian'), '255文字では登録されない').toBe(false);
    }
    expect.soft((await guardianAccountsByEmail(api, email)).length, '255文字のアカウントは作られない').toBe(0);
    await evidence(page, '01-I010');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.11)・基本設計書「入力項目の制約値」(4-12)・同「パスワードの要件」(6-3)
  test('01-I011 パスワード', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const done = await trySignup(page, api, '01-I011', { password: 'ukeire7' });
    expect.soft(done, '7文字では登録しない').toBe(false);
    expect.soft((await guardianAccountsByEmail(api, 'g01i011@example.jp')).length).toBe(0);
    await evidence(page, '01-I011');
  });

  // 典拠：基本設計書「入力項目の制約値」(4-12)・同「パスワードの要件」(6-3)
  test('01-I012 パスワード', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const done = await trySignup(page, api, '01-I012', { password: 'ukeire08' });
    expect(done, '8文字で登録できる').toBe(true);
    await logoutGuardian(page);
    await loginWith(page, 'guardian', 'g01i012@example.jp', 'ukeire08');
    await expect.soft(todayRegion(page, '受入 01-I012')).toBeVisible();
    await evidence(page, '01-I012');
  });

  const pw128 = `ukeire-${'0123456789'.repeat(13)}`.slice(0, 128);

  // 典拠：基本設計書「入力項目の制約値」(4-12)
  test('01-I013 パスワード', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    expect(pw128.length).toBe(128);
    const done = await trySignup(page, api, '01-I013', { password: pw128 });
    expect(done, '128文字で登録できる').toBe(true);
    await logoutGuardian(page);
    await loginWith(page, 'guardian', 'g01i013@example.jp', pw128);
    await expect.soft(todayRegion(page, '受入 01-I013')).toBeVisible();
    await evidence(page, '01-I013');
  });

  // 典拠：基本設計書「入力項目の制約値」(4-12)・詳細設計書「本書で足す文言」(4-1 (6))
  test('01-I014 パスワード', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const done = await trySignup(page, api, '01-I014', { password: `${pw128}9` });
    expect.soft(done, '129文字では登録しない').toBe(false);
    await expect.soft(page.getByText(/128文字以内で入力してください。/), '文言の形').toBeVisible();
    await evidence(page, '01-I014');
  });

  // 典拠：要件定義書「セキュリティ要求」(8 No.11)・基本設計書「パスワードの要件」(6-3)
  test('01-I015 パスワード', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const done = await trySignup(page, api, '01-I015', { password: 'password' });
    expect.soft(done, 'よく使われるパスワードでは登録しない').toBe(false);
    expect.soft((await guardianAccountsByEmail(api, 'g01i015@example.jp')).length).toBe(0);
    await evidence(page, '01-I015');
  });

  // 典拠：図/画面詳細図「新規登録画面（保護者）」(2-3) 項目8
  test('01-I016 パスワード（確認）', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const done = await trySignup(page, api, '01-I016', { password: 'ukeire-I016-pw', confirm: 'ukeire-I016-px' });
    expect.soft(done, '一致しなければ登録しない').toBe(false);
    expect.soft((await guardianAccountsByEmail(api, 'g01i016@example.jp')).length).toBe(0);
    await evidence(page, '01-I016');
  });

  const name50 = `受入01I017${'あ'.repeat(42)}`;

  // 典拠：基本設計書「入力項目の制約値」(4-12)・図/画面詳細図「新規登録画面（保護者）」(2-3) 項目10
  test('01-I017 保護者の氏名', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    expect([...name50].length).toBe(50);
    const done = await trySignup(page, api, '01-I017', { name: name50 });
    expect(done, '50文字で登録できる').toBe(true);
    await evidence(page, '01-I017');
  });

  // 典拠：基本設計書「入力項目の制約値」(4-12)・詳細設計書「本書で足す文言」(4-1 (6))
  test('01-I018 保護者の氏名', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    await createChild(api, { id: 'C01I018', name: '受入 01-I018' });
    const code = await issueCode(api, 'C01I018');
    await fillSignup(page, { code, name: `${name50}あ`, email: 'g01i018@example.jp', password: 'ukeire-01i018-pw' });
    const typed = [...(await page.getByLabel(/保護者の氏名/).inputValue())].length;
    if (typed <= 50) {
      // 入力欄が51文字目を受け付けない（基本設計書「入力項目の制約値」(4-12)：保存しようとして初めて弾かれる作りにしない）
      expect(typed, '51文字目を入れられない').toBe(50);
    } else {
      await page.getByRole('button', { name: '登録する' }).click();
      await page.waitForTimeout(1500);
      expect.soft(new URL(page.url()).pathname.startsWith('/guardian'), '51文字では登録しない').toBe(false);
      await expect.soft(page.getByText(/50文字以内で入力してください。/), '文言の形').toBeVisible();
    }
    await evidence(page, '01-I018');
  });

  // 典拠：図/画面詳細図「新規登録画面（保護者）」(2-3) 項目11
  test('01-I019 続柄', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const done = await trySignup(page, api, '01-I019', { relationship: null });
    expect(done, '未選択では登録できない').toBe(false);
    expect.soft((await guardianAccountsByEmail(api, 'g01i019@example.jp')).length).toBe(0);
    await evidence(page, '01-I019');
  });

  // 典拠：基本設計書「保護者アカウントの自己登録」(4-3)（連絡先1は必須）・同「入力項目の制約値」(4-12)・同「メッセージ一覧」(4-12)・図/画面詳細図「新規登録画面（保護者）」(2-3) 項目14
  test('01-I020 連絡先1', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    await createChild(api, { id: 'C01I020', name: '受入 01-I020' });
    const code = await issueCode(api, 'C01I020');
    await fillSignup(page, { code, name: '受入 保護者 01-I020', email: 'g01i020@example.jp', password: 'ukeire-I020-pw' });
    const phone = page.getByLabel(/連絡先1/);
    await expect(phone, '連絡先1の欄（2-3 項目14）').toBeVisible();
    await phone.fill('');
    await page.getByRole('button', { name: '登録する' }).click();
    await expect.soft(page.getByText(MSG.phone1Missing)).toBeVisible();
    expect.soft((await guardianAccountsByEmail(api, 'g01i020@example.jp')).length).toBe(0);
    await evidence(page, '01-I020');
  });

  // 典拠：基本設計書「連絡先の変更」(4-3)・同「入力項目の制約値」(4-12)・図/画面詳細図「連絡先の変更（保護者のメニュー）」(1-3 (8))・詳細設計書「本書で足す文言」(4-1 (6))
  test('01-I021 連絡先1', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    await makeGuardian(page, api, '01-I021');
    await page.getByRole('banner').getByRole('button', { name: /メニュー/ }).click();
    const item = page.getByRole('dialog', { name: 'メニュー' }).getByRole('button', { name: '連絡先の変更' }).or(page.getByRole('dialog', { name: 'メニュー' }).getByRole('link', { name: '連絡先の変更' }));
    await expect(item, 'メニューの「連絡先の変更」（1-2 項目16）').toBeVisible();
    await item.click();
    const dlg = page.getByRole('dialog', { name: /連絡先の変更/ });
    const phone1 = dlg.getByLabel(/連絡先1/);
    for (const bad of ['090-1234-5678-9012345', '090-abcd-5678']) {
      await phone1.fill(bad);
      await dlg.getByRole('button', { name: '保存する' }).click();
      await expect.soft(dlg.getByText(MSG.phoneShape), bad).toBeVisible();
    }
    await phone1.fill('090-1234-5678-901234');
    await dlg.getByRole('button', { name: '保存する' }).click();
    await expect.soft(page.getByText(MSG.contactChanged), '③ 20文字は保存できる').toBeVisible();
    await evidence(page, '01-I021');
  });

  // 典拠：基本設計書「お子さまの追加（園児の追加紐づけ）」(4-3) の処理内容 2・同「メッセージ一覧」(4-12)・図/画面詳細図「お子さまの追加（保護者のメニュー）」(1-3 (7)) 項目2
  test('01-I025 招待コード', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const g = await makeGuardian(page, api, '01-I025');
    const code2 = await issueCode(api, g.childId);
    await page.getByRole('banner').getByRole('button', { name: /メニュー/ }).click();
    await page.getByRole('dialog', { name: 'メニュー' }).getByRole('button', { name: 'お子さまの追加' }).click();
    const dlg = page.getByRole('dialog', { name: /お子さまの追加/ });
    await dlg.getByRole('textbox', { name: /招待コード/ }).fill(code2);
    await dlg.getByRole('button', { name: 'コードを確認する' }).click();
    await expect(dlg.getByText(MSG.childAlready)).toBeVisible();
    await evidence(page, '01-I025');
  });
});

test.describe('サーバA（通常）：入力チェック（パスワード変更）', () => {
  // 典拠：要件定義書「セキュリティ要求」(8 No.11)・基本設計書「パスワードの要件」(6-3)・同「メッセージ一覧」(4-12)・図/画面詳細図「パスワード変更画面」(2-4) 項目3
  test('01-I022 新しいパスワード', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaffIssued(api, '01-I022');
    await loginWith(page, 'staff', s.email, s.tempPassword);
    await page.getByLabel(/現在のパスワード/).fill(s.tempPassword);
    await page.getByRole('textbox', { name: /^新しいパスワード\s*必須$/ }).fill(s.tempPassword);
    await page.getByLabel(/新しいパスワード（確認）/).fill(s.tempPassword);
    await page.getByRole('button', { name: '変更する' }).click();
    await expect.soft(page.getByText(MSG.samePassword)).toBeVisible();
    await expect.soft(page.getByRole('heading', { name: 'パスワードの変更' }), 'パスワード変更画面のまま').toBeVisible();
    await evidence(page, '01-I022');
  });

  // 典拠：図/画面詳細図「パスワード変更画面」(2-4) 項目2・6
  test('01-I023 現在のパスワード', async ({ page, playwright }) => {
    const api = await adminApi(playwright);
    const s = await makeStaff(page, api, '01-I023');
    await page.goto('/staff/password');
    await page.getByLabel(/現在のパスワード/).fill('wrong-current-pw');
    await page.getByRole('textbox', { name: /^新しいパスワード\s*必須$/ }).fill('ukeire-I023-px');
    await page.getByLabel(/新しいパスワード（確認）/).fill('ukeire-I023-px');
    await page.getByRole('button', { name: '変更する' }).click();
    await page.waitForTimeout(1000);
    await evidence(page, '01-I023');
    await logoutStaff(page);
    const text = await loginError(page, 'staff', s.email, 'ukeire-I023-px');
    expect.soft(text, '新しいパスワードではログインできない').toContain('違います');
    await loginWith(page, 'staff', s.email, s.password);
    await expect.soft(page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), '元のパスワードでログインできる').toBeVisible();
  });
});

// ======================================================================
// サーバC（専用：ロック）
// ======================================================================
test.describe('サーバC（専用：ロック）', () => {
  // 典拠：要件定義書「アプリのログイン」(4-1-1) のログイン試行の制限・基本設計書「ログイン」(4-3)・同「メッセージ一覧」(4-12)・同「設定マスタ」(5-9)・図/画面詳細図 (2-1) 項目7・8・同「職員アカウント管理画面」(7-6) 項目4
  test('01-048 ロック（5回の失敗）', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const a = await makeStaff(page, api, '01-048', { suffix: 'a' });
    await logoutStaff(page);
    const bw = await newWindow(browser);
    const b = await makeStaff(bw.page, api, '01-048', { suffix: 'b' });
    await logoutStaff(bw.page);
    const texts: string[] = [];
    for (let i = 1; i <= 5; i++) texts.push(await loginError(page, 'staff', a.email, 'wrong-pass-01048'));
    texts.slice(0, 4).forEach((t, i) => {
      expect.soft(t, `① ${i + 1}回目`).toContain(MSG.credential);
      expect.soft(t, `① ${i + 1}回目に残りの回数を示さない`).not.toMatch(/残り/);
    });
    const sixth = await loginError(page, 'staff', a.email, a.password);
    expect.soft(sixth, '② 正しいパスワードでもロック').toContain(MSG.locked);
    await expectAtTop(page, 'staff');
    await evidence(page, '01-048');
    await loginWith(bw.page, 'staff', b.email, b.password);
    await expect.soft(bw.page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), '③ b はログインできる').toBeVisible();
    await logoutStaff(bw.page);
    await loginWith(bw.page, 'staff', ACCOUNTS.admin.email, passwordOf('admin'));
    await bw.page.goto('/staff/admin/staff-accounts');
    await expect.soft(bw.page.getByRole('row', { name: new RegExp(a.email) }), '④ ロックとして示す').toContainText('ロック');
    await bw.context.close();
  });

  // 典拠：基本設計書「ログイン」(4-3) の注記・図/インタフェース一覧「経路ごとの要求と応答の補足」(1-1)
  test('01-050 ログインの失敗とロックの記録', async ({ browser, page, playwright }) => {
    const api = await adminApi(playwright);
    const w = await newWindow(browser);
    const a = await makeStaff(w.page, api, '01-050', { suffix: 'a' });
    await logoutStaff(w.page);
    const b = await makeStaff(w.page, api, '01-050', { suffix: 'b' }); // b はログインに成功する
    await w.context.close();
    const lockedName = a.name;
    for (let i = 1; i <= 5; i++) await loginError(page, 'staff', a.email, 'wrong-pass-01050');
    await loginError(page, 'staff', 'nobody01050@example.jp', 'ukeire-01050-pw');
    void b;
    await login(page, 'admin');
    await page.goto('/staff/admin/logs');
    const main = page.getByRole('main');
    await expect.soft(main.getByRole('row', { name: new RegExp(`${lockedName}.*(ログイン|失敗)`) }).first(), '① 失敗の行（操作者は a）').toBeVisible();
    await expect.soft(main.getByRole('row', { name: /ロック/ }).first(), '① ロックの行').toBeVisible();
    await expect.soft(main, '② 登録の無いログインIDへの試行は残らない').not.toContainText('nobody01050');
    await expect.soft(main.getByRole('row', { name: /ログインに成功/ }), '③ 成功は残らない').toHaveCount(0);
    await evidence(page, '01-050');
  });
});

// ======================================================================
// サーバD（専用：待機時間）。ACCEPTANCE_LONG=1 のときだけ回す
// ======================================================================
test.describe('サーバD（専用：待機時間）', () => {
  // 典拠：要件定義書「アプリのログイン」(4-1-1) のアカウントロックの解除・基本設計書「設定マスタ」(5-9)・詳細設計書「設定ごとの検査」(4-10 (3))
  test('01-049 ロックの解除（待機時間の経過）', async ({ page, playwright }) => {
    test.skip(!LONG, LONG_REASON);
    test.setTimeout(4 * 60_000);
    // 設定画面にロックの時間の欄が無いため、設定マスタを SQL で書き換える（シート07 の範囲）
    sqlRun(`UPDATE m_setting SET setting_value = '1' WHERE setting_key = 'auth.lock_minutes'`);
    const api = await adminApi(playwright);
    const s = await makeStaff(page, api, '01-049');
    await logoutStaff(page);
    for (let i = 1; i <= 5; i++) await loginError(page, 'staff', s.email, 'wrong-pass-01049');
    const locked = await loginError(page, 'staff', s.email, s.password);
    expect.soft(locked, '① 1分たつ前はロック').toContain(MSG.locked);
    await page.waitForTimeout(70_000);
    await loginWith(page, 'staff', s.email, s.password);
    await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), '② 1分を過ぎるとログインできる').toBeVisible();
    await evidence(page, '01-049');
  });

  /*
   * 01-045〜01-047 は、同じ6分の待ちで3つの窓を見る。01-045 が窓を用意して待ち、3つの結果と画面を一時ファイルに残す。
   * 01-046・01-047 はその結果で判定する（ケースごとにテストを分けるため。落ちたあとはワーカーが立ち直り、
   * 手元の変数は消えるので、ファイルで渡す）。証跡は 01-045 が撮った画面を、それぞれのテストで写して残す
   */
  const handoff = path.join(tmpdir(), `sukusuku-t6-01-045-${process.env.ACCEPTANCE_PORT ?? 'default'}.json`);
  type Seen = { atTop: boolean; shot: string };

  async function seen(p: Page, check: () => Promise<boolean>): Promise<Seen> {
    const atTop = await check();
    const shot = (await p.screenshot()).toString('base64');
    return { atTop, shot };
  }

  async function showShot(page: Page, shot: string) {
    await page.setContent(`<img alt="01-045 で撮った画面" src="data:image/png;base64,${shot}">`);
  }

  // 典拠：要件定義書「端末の利用形態と本人特定」(4-1-4 (4))・同「アプリのログイン」(4-1-1) のログアウト・基本設計書「ログイン」(4-3) の注記・同「設定マスタ」(5-9)
  test('01-045 自動ログアウト', async ({ browser, page, playwright }) => {
    test.skip(!LONG, LONG_REASON);
    test.setTimeout(10 * 60_000);
    rmSync(handoff, { force: true });
    // 設定画面に自動ログアウトの時間の欄が無いため、設定マスタを SQL で書き換える（最短の5分。詳細設計書「設定ごとの検査」(4-10 (3))）
    sqlRun(`UPDATE m_setting SET setting_value = '5' WHERE setting_key = 'ui.auto_logout_minutes'`);
    const api = await adminApi(playwright);
    await makeStaff(page, api, '01-045'); // 記憶はオフのまま
    // 01-046 の職員：「ログイン状態を保持する」をオンにしてログインし直す
    const on = await newWindow(browser);
    const s2 = await makeStaff(on.page, api, '01-046');
    await logoutStaff(on.page);
    await gotoTop(on.page, 'staff');
    await on.page.getByLabel('ログインID', { exact: true }).fill(s2.email);
    await on.page.getByLabel('パスワード', { exact: true }).fill(s2.password);
    await on.page.getByRole('checkbox', { name: 'ログイン状態を保持する' }).check();
    await on.page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await expect(on.page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
    // 01-047 の保護者
    const gw = await newWindow(browser, { viewport: PHONE });
    const g = await makeGuardian(gw.page, api, '01-047');
    // 6分、どの窓も操作しない
    await page.waitForTimeout(6 * 60_000);
    const loginForm = (p: Page) => async () => p.getByLabel('ログインID', { exact: true }).isVisible();
    await page.goto('/staff');
    await page.waitForTimeout(1500);
    const r45 = await seen(page, loginForm(page));
    await on.page.goto('/staff');
    await on.page.waitForTimeout(1500);
    const r46 = await seen(on.page, loginForm(on.page));
    await gw.page.reload();
    await gw.page.waitForTimeout(1500);
    const r47 = await seen(gw.page, async () => !(await todayRegion(gw.page, g.childName).isVisible()));
    writeFileSync(handoff, JSON.stringify({ r46, r47 }));
    await on.context.close();
    await gw.context.close();
    expect(r45.atTop, '最後の操作から時間を過ぎるとログイン状態が終わる（職員用トップへ戻る）').toBe(true);
    await evidence(page, '01-045');
  });

  function readHandoff(): { r46: Seen; r47: Seen } | null {
    return existsSync(handoff) ? (JSON.parse(readFileSync(handoff, 'utf8')) as { r46: Seen; r47: Seen }) : null;
  }

  // 典拠：要件定義書「『ログイン情報の記憶』と自動ログアウトの関係」(4-1-4 (4))（自動ログアウトを優先する）
  test('01-046 自動ログアウト（記憶を有効にしても）', async ({ page }) => {
    test.skip(!LONG, LONG_REASON);
    const h = readHandoff();
    test.skip(!h, '01-045 が窓を用意できなかった');
    await showShot(page, h!.r46.shot);
    await evidence(page, '01-046');
    expect(h!.r46.atTop, '記憶を有効にしていても、自動ログアウトが優先してログイン状態が終わる').toBe(true);
  });

  // 典拠：要件定義書「端末の利用形態と本人特定」(4-1-4 (4))・基本設計書「システムの利用方法」(2-2)
  test('01-047 保護者は自動ログアウトしない', async ({ page }) => {
    test.skip(!LONG, LONG_REASON);
    const h = readHandoff();
    test.skip(!h, '01-045 が窓を用意できなかった');
    await showShot(page, h!.r47.shot);
    await evidence(page, '01-047');
    expect(h!.r47.atTop, '保護者はログインしたまま').toBe(false);
  });
});
