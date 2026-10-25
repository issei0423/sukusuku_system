/*
 * シート 01 共通基盤（ログイン・新規登録・パスワード変更・規約同意・ホーム）
 *
 * 期待する結果は設計書（docs ブランチ）から書く。コードを読んで決めない（README.md「期待は設計書から」）。
 * 01-001・01-002 は土台の係が置いた見本。続きのケースはシート 01 の係が 01-003 から足す。
 */
import { ACCOUNTS, PHONE, evidence, expect, fillLogin, gotoTop, test } from './harness';

test.describe('ログイン（職員）', () => {
  /*
   * 典拠
   *   図/画面詳細図「職員用トップ／保護者用トップ」(2-1) 項目5（ログイン：職員は職員ダッシュボードへ）・項目9（入口の見出し「職員用の入口」）
   *   図/画面遷移図「共通・認証」(2)（職員用トップ ─ログイン→ 職員ダッシュボード）
   *   図/画面詳細図「職員（タブレット／PC）」(1-1) 項目3（ログイン中の職員名と所属クラスを常時表示）・項目4（ログアウトはヘッダに常時表示）
   *   図/画面詳細図「職員ダッシュボード」(2-6) 項目3（未対応の個人チャット）・項目12（園からのひとことを送っていない園児）・項目13（午睡中の園児）
   *
   * ダッシュボードかどうかは、項目表の表示名で見る。ワイヤーフレームの区画の見出し（「届けること」など）は
   * 配置を示すものであり、仕様の正は項目表（図/画面詳細図「表記ルール」(0-1)）
   */
  test('01-001 職員のログイン：一般職員が職員用の入口からログインすると、職員ダッシュボードが開き、ヘッダに氏名と所属クラスが出る', async ({ page }) => {
    const account = ACCOUNTS.staffSakura;

    await gotoTop(page, 'staff');
    await expect(page.getByRole('heading', { name: '職員用の入口' })).toBeVisible();

    await fillLogin(page, account);
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();

    // 職員ダッシュボード：項目表の表示名が並ぶ（表示名のあとに相手の名前などが続くことがあるので、部分で探す）
    const main = page.getByRole('main');
    for (const item of ['園からのひとことを送っていない園児', '午睡中の園児', '未対応の個人チャット']) {
      await expect(main.getByText(item).first()).toBeVisible();
    }
    // ヘッダ：ログイン中の職員名と所属クラス、ログアウト
    const header = page.getByRole('banner');
    await expect(header).toContainText(account.name);
    await expect(header).toContainText(account.className);
    await expect(header.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();

    await evidence(page, '01-001');
  });
});

test.describe('ログイン（保護者）', () => {
  // 保護者はスマートフォンの縦向き（図/画面詳細図「全画面に共通する規定」(0-2) の「端末と向き」）
  test.use({ viewport: PHONE });

  /*
   * 典拠
   *   図/画面詳細図「職員用トップ／保護者用トップ」(2-1) 項目5（ログイン：保護者は保護者ホームへ）・項目9（入口の見出し「保護者用の入口」）
   *   図/画面遷移図「共通・認証」(2)（保護者用トップ ─ログイン→ 保護者ホーム）
   *   図/画面詳細図「保護者ホーム」(2-7) 項目1・2（紐づく園児ごとの区画。見出しに園児名・クラス）・項目16（緊急連絡の案内を常時表示）
   *   図/画面詳細図「保護者（スマートフォン）」(1-2) 項目1（メニュー。開いたメニューの中に「閉じる」を置く）・項目4（利用者名「〇〇 〇〇 保護者」をメニュー内に表示）
   */
  test('01-002 保護者のログイン：保護者が保護者用の入口からログインすると、保護者ホームが開き、自児の区画とメニューの利用者名が出る', async ({ page }) => {
    const account = ACCOUNTS.guardian;
    const child = account.children[0];

    await gotoTop(page, 'guardian');
    await expect(page.getByRole('heading', { name: '保護者用の入口' })).toBeVisible();

    await fillLogin(page, account);
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();

    // 保護者ホーム：自児の区画（見出しに園児名とクラス）と、緊急連絡の案内
    const main = page.getByRole('main');
    await expect(main.getByText(child.name, { exact: false }).first()).toBeVisible();
    await expect(main).toContainText(child.className);
    await expect(page.getByText('緊急のご連絡はお電話でお願いします', { exact: false })).toBeVisible();

    // メニューを開くと、その中に利用者名「西田 太郎 保護者」が出る。「閉じる」で閉じる
    await page.getByRole('banner').getByRole('button', { name: /メニュー/ }).click();
    const menu = page.getByRole('dialog', { name: 'メニュー' });
    await expect(menu.getByText(`${child.name} 保護者`, { exact: true })).toBeVisible();
    await menu.getByRole('button', { name: /閉じる/ }).click();
    await expect(menu).toBeHidden();

    // 証跡は保護者ホームの全体
    await evidence(page, '01-002');
  });
});
