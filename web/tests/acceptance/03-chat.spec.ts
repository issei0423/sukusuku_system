/*
 * シート 03 チャットツール（配布物を含む）
 *
 * ケースは scratchpad の T8 の sheet-03.md（テスト仕様書 第2.0版の 3.3）。期待する結果は設計書（docs ブランチ）から書いた。
 * コードを読んで決めない（README.md「期待は設計書から」）。部品は設計書の表示名で探す。
 *
 *   - テストごとに新しいデータベース（serverScope: 'test'）。前提はテストの中で作り、前のテストに頼らない
 *   - 前提のうち、確かめる対象でないもの（ほかの人の送信・既読・園児と保護者の登録）は API（画面と同じ経路）で作る
 *   - 2つの窓（職員と保護者、職員どうし）は helpers の openAs で開く。相手の窓は再読み込みせずに待つ（LIVE_TIMEOUT）
 *   - 1つのケースの中で独立した確かめは expect.soft で並べ、どこが設計と違うかをまとめて残す
 */
import type { Locator, Page } from '@playwright/test';
import { ACCOUNTS, PHONE, evidence, expect, jstToday, login, test } from './harness';
import * as H from './03-chat.helpers';

// 押す・入れる操作は10秒で諦める（設計の部品が無いときに、テストの上限の60秒まで待たない）
test.use({ serverScope: 'test', actionTimeout: 10_000 });

test.beforeEach(async ({ page: _page }, testInfo) => {
  H.setNoteSink((text) => testInfo.annotations.push({ type: 'note', description: text }));
});

test.afterEach(async () => {
  await H.closeApis();
  await H.closeWindows();
});

/** 独立した確かめの待ち（設計と違うときに長く待たない） */
const SOFT = { timeout: 5_000 };
const LIVE = { timeout: H.LIVE_TIMEOUT };

const TARO = '西田 太郎';
/** 閲覧のみの場の案内（基本設計書「メッセージ一覧」(4-12)「閲覧のみの場（保護者）」） */
const READ_ONLY_NOTICE = 'こちらは園からのお知らせです。返信はできません。このお知らせについては「この連絡について園にたずねる」からお送りください。';
/** 取り消し・削除の確認（同「取り消し・削除の確認」）。数は 1 家庭（1 名） */
const READING_ONE = /いま保護者\s*1\s*家庭（\s*1\s*名）が読んでいます。\s*取り消しても、読まれた内容は取り消せません。/;
const NOT_ALLOWED_POST = 'このチャンネルへは投稿できません';

function messageOf(r: H.ApiResult): string {
  return (r.json as { message?: string } | null)?.message ?? '';
}

/** 本文を含み、指定の語を含む、いちばん近い祖先（吹き出し） */
function bubbleWith(page: Page, body: string, word: string): Locator {
  return page.getByRole('main').getByText(body, { exact: true }).last().locator(`xpath=ancestor::*[contains(normalize-space(.),"${word}")][1]`);
}

/** 要素とその中の title・aria-label を1つの文にする（リアクションをした家庭の名が属性にだけあることがあるため） */
async function fullText(loc: Locator): Promise<string> {
  if ((await loc.count()) === 0) return '';
  return loc.first().evaluate((el) => {
    const parts = [el.textContent ?? ''];
    for (const n of Array.from(el.querySelectorAll('[title],[aria-label]'))) parts.push(n.getAttribute('title') ?? '', n.getAttribute('aria-label') ?? '');
    return parts.join(' ');
  });
}

/** 操作の一覧を閉じる（「閉じる」があれば押し、無ければ Esc） */
async function closeOps(page: Page) {
  const close = H.opButton(page, '閉じる');
  if (await close.isVisible().catch(() => false)) await close.click();
  else await page.keyboard.press('Escape');
}

/** 編集の入力欄（いまの値が value のもの） */
async function editorWith(page: Page, value: string): Promise<Locator> {
  const boxes = page.getByRole('main').getByRole('textbox');
  await expect.poll(async () => {
    for (const b of await boxes.all()) if ((await b.inputValue().catch(() => '')) === value) return true;
    return false;
  }, { timeout: 5_000, message: `編集の入力欄（初期値「${value}」）が出る` }).toBe(true);
  for (const b of await boxes.all()) if ((await b.inputValue().catch(() => '')) === value) return b;
  throw new Error('編集の入力欄が見つかりません');
}

/** 確認のダイアログが出たら、肯定のボタンを押す（保護者の取消など、ダイアログの有無が設計で決まっていないところ） */
async function confirmIfAsked(page: Page, name: RegExp) {
  const d = page.getByRole('dialog').last();
  if (await d.isVisible({ timeout: 2_000 }).catch(() => false)) await d.getByRole('button', { name }).last().click();
}

async function status(res: Promise<import('@playwright/test').APIResponse>): Promise<{ status: number; text: string }> {
  const r = await res;
  return { status: r.status(), text: await r.text() };
}

/** 職員の窓で西田 太郎の個人チャットを開く */
async function staffOpenTaro(page: Page) {
  await H.staffChat(page);
  await H.openChannel(page, `${TARO}の園とのやりとり`);
  await expect(H.composer(page)).toBeVisible();
}

/** 保護者（nishida.t）の窓で、個人チャットを開く */
async function guardianOpenTaro(g: Page) {
  await H.guardianChat(g);
  await H.openGuardianPersonal(g, TARO);
}

async function roomsOf(pw: H.RequestFactory) {
  const staff = await H.apiAs(pw, 'staffSakura');
  const taroId = H.childIdOf(TARO);
  return {
    staff,
    taroId,
    personal: await H.roomId({ type: '4', childId: taroId }),
    sakura: await H.roomId({ type: '2', nameIncludes: 'さくら' }),
  };
}

// =====================================================================
// チャンネル一覧と宛先の表示
// =====================================================================

test.describe('チャンネル一覧と宛先の表示', () => {
  /*
   * 典拠：基本設計書「メッセージの送受信」(4-7) 処理1、同「権限と参照範囲の判定」(4-2)、要件定義書「個人チャットの作成と参加者」(4-4)・
   *       同「グループの種別」(4-4 (a))、図/画面詳細図「チャット画面（職員・タブレット／PC）」(4-1) 項目1、図/画面遷移図「チャットツール」(5)
   */
  test('03-001 職員のチャンネル一覧（一般・管理者）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await H.staffChat(page);
    const main = page.getByRole('main');
    for (const n of ['園全体', '職員', 'さくら組']) await expect.soft(H.channelButton(page, n).first(), `一般の一覧に「${n}」`).toBeVisible(SOFT);
    await expect.soft(main.getByRole('button', { name: /の園とのやりとり/ }), 'さくら組の在籍園児12名の個人チャット').toHaveCount(12);
    for (const n of ['ひまわり組', 'もも組']) await expect.soft(H.channelButton(page, n), `一般の一覧に「${n}」のクラスグループは出ない`).toHaveCount(0);
    for (const id of ['C013', 'C019']) {
      const name = H.childNameOf(id);
      await expect.soft(H.channelButton(page, `${name}の園とのやりとり`), `ほかのクラスの園児（${name}）の個人チャットは出ない`).toHaveCount(0);
    }
    // ③ 選んでも画面は移らない
    const path = new URL(page.url()).pathname;
    await H.openChannel(page, 'さくら組');
    await expect.soft(main.getByRole('heading', { level: 2 }).filter({ hasText: 'さくら組' }).first(), 'さくら組に入れ替わる').toBeVisible(SOFT);
    await H.openChannel(page, `${TARO}の園とのやりとり`);
    await expect.soft(main.getByRole('heading', { level: 2 }).filter({ hasText: TARO }).first(), '個人チャットに入れ替わる').toBeVisible(SOFT);
    expect.soft(new URL(page.url()).pathname, 'チャンネルを選んでも画面は移らない').toBe(path);

    // ② 管理者
    const admin = await H.openAs(browser, testInfo, 'admin');
    await H.staffChat(admin);
    await expect.soft(admin.getByRole('main').getByRole('button', { name: /の園とのやりとり/ }), '管理者には全園児22名の個人チャット').toHaveCount(22);
    for (const n of ['さくら組', 'ひまわり組', 'もも組']) await expect.soft(H.channelButton(admin, n).first(), `管理者の一覧に今年度の「${n}」のクラスグループ`).toBeVisible(SOFT);
    await evidence(admin, '03-001');
  });

  /*
   * 典拠：図/画面詳細図「チャット画面（保護者・スマートフォン）」(4-2) 項目1・2・21・注記、同「保護者ホーム」(2-7) 項目10・13、
   *       図/画面遷移図「保護者の画面」(9)、要件定義書「チャンネル別の権限」(4-4)
   */
  test('03-002 保護者のチャンネル一覧と入口', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page, 'guardian');
    const main = page.getByRole('main');
    // ① ホームの園児の区画「西田 太郎の園とのやりとり」→ その子の個人チャットを開いた状態
    await main.getByRole('link', { name: new RegExp(`${TARO}の園とのやりとり`) }).or(main.getByRole('button', { name: new RegExp(`${TARO}の園とのやりとり`) })).first().click();
    await expect.soft(H.composer(page), '個人チャットを開いた状態（投稿欄がある）').toBeVisible(SOFT);
    await expect.soft(main.getByRole('heading').filter({ hasText: TARO }).first(), '先頭に園児名').toBeVisible(SOFT);
    // ② もどる → 同じ画面の中のチャンネル一覧
    const back = main.getByRole('button', { name: /もどる/ });
    if (await back.isVisible().catch(() => false)) await back.click();
    for (const n of ['園からのお知らせ', 'さくら組', `${TARO}の園とのやりとり`]) await expect.soft(H.channelButton(page, n).first(), `一覧に「${n}」`).toBeVisible(SOFT);
    await expect.soft(main.getByRole('button', { name: /(の園とのやりとり|担任の先生とのやりとり)/ }), '個人チャットは自児の1つだけ').toHaveCount(1);
    for (const n of ['職員', '運動会実行委員', 'ひまわり組', 'もも組']) await expect.soft(H.channelButton(page, n), `「${n}」は出ない`).toHaveCount(0);
    await expect.soft(main.getByRole('link', { name: '園からの配布物' }).or(main.getByRole('button', { name: '園からの配布物' })).first(), '一覧の上に「園からの配布物」').toBeVisible(SOFT);
    await expect.soft(main.getByRole('heading', { name: 'メンバー' }), 'メンバー一覧は出ない').toHaveCount(0);
    await evidence(page, '03-002');
    // ③ 保護者ホームの「チャット・お知らせ」から
    await page.goto('/guardian');
    await main
      .getByRole('heading', { name: 'チャット・お知らせ' })
      .locator('xpath=following::*[(self::a or self::button) and contains(normalize-space(.),"開く")][1]')
      .click();
    await expect.soft(H.channelButton(page, '園からのお知らせ').first(), '「チャット・お知らせ」からチャンネル一覧が出る').toBeVisible(SOFT);
  });

  /*
   * 典拠：基本設計書「送る時点の守り」(4-2) 処理1、図/画面詳細図「共通のダイアログと部品」(1-3) (1)、同 (4-1) 項目19・25、
   *       要件定義書「品質要求一覧」(7-1 No.9 ⑥)
   */
  test('03-003 宛先の表示（個人チャット）', async ({ page }) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const rel = H.relationshipOf(ACCOUNTS.guardian.email, H.childIdOf(TARO));
    const main = page.getByRole('main');
    await expect.soft(main.getByText(`${TARO}（さくら組）`).first(), '宛先の園児名とクラス').toBeVisible(SOFT);
    await expect.soft(main.getByText(new RegExp(`${H.esc(rel)}に届きます`)).first(), `届く保護者の続柄「${rel}に届きます」`).toBeVisible(SOFT);
    await expect.soft(page.getByRole('dialog'), '送る前の別の確認ダイアログは無い').toHaveCount(0);
    await H.composer(page).scrollIntoViewIfNeeded();
    await evidence(page, '03-003');
  });

  /*
   * 典拠：基本設計書「送る時点の守り」(4-2) 処理1、詳細設計書「チャット画面（職員・保護者）」(2-9 (5))、同「本書で決めたこと」(10) D-27、
   *       図/画面詳細図 (4-1) 項目19・25
   */
  test('03-004 宛先の表示（クラスグループ・園チャット）と職員だけのチャンネル', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await H.staffChat(page);
    await H.openChannel(page, 'さくら組');
    await expect.soft(page.getByRole('main').getByText(/さくら組の\s*4\s*家庭に届きます/).first(), '「さくら組の 4 家庭に届きます」').toBeVisible(SOFT);

    const admin = await H.openAs(browser, testInfo, 'admin');
    await H.staffChat(admin);
    await H.openChannel(admin, '園全体');
    await expect.soft(admin.getByRole('main').getByText(/園全体の\s*4\s*家庭に届きます/).first(), '「園全体の 4 家庭に届きます」').toBeVisible(SOFT);

    await H.openChannel(page, '職員');
    await expect.soft(page.getByRole('main').getByText('このチャンネルは職員だけが読みます。'), '職員だけのチャンネルの案内').toBeVisible(SOFT);
    const body = `受入テスト 03-004 ${TARO}`;
    await H.sendUi(page, body);
    await expect(H.msgText(page, body), '名前が入っていても、そのまま送られる').toBeVisible();
    await expect.soft(H.nameCheckDialog(page), '職員だけのチャンネルでは他児の名前の注意を出さない').toHaveCount(0);
    await evidence(page, '03-004');
  });
});

// =====================================================================
// 送受信と参照範囲
// =====================================================================

test.describe('送受信と参照範囲', () => {
  /*
   * 典拠：基本設計書「メッセージの送受信」(4-7) 処理5〜7、同「送る時点の守り」(4-2) 処理4、同「メッセージ一覧」(4-12)「送ったあと」、
   *       同「開いている画面への即時の反映（SSE）」(4-10)、図/画面詳細図「全画面に共通する規定」(0-2) 完了の表示、同 (4-2) 項目1・3
   */
  test('03-005 個人チャット：職員が送ると保護者の画面に出る', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianChat(g);
    const personal = g.getByRole('main').getByRole('button', { name: /(の園とのやりとり|担任の先生とのやりとり)/ }).first();
    const before = (await personal.getAttribute('aria-label')) ?? (await personal.innerText());

    const body = '受入テスト 03-005';
    await H.sendUi(page, body);
    await expect(H.msgText(page, body)).toBeVisible();
    await expect.soft(H.notice(page, '送りました。保護者が見られる状態です。'), '送ったあとの結果の表示').toBeVisible(SOFT);
    await expect.soft(page.getByRole('button', { name: '取り消す', exact: true }).first(), '結果の表示に「取り消す」').toBeVisible(SOFT);

    // 保護者の一覧：表記と未読の数（再読み込みなし）
    await expect.soft(H.channelButton(g, `${TARO}の園とのやりとり`).first(), '表記「西田 太郎の園とのやりとり」').toBeVisible(SOFT);
    await expect.soft(personal, '未読の数が付く').toHaveAccessibleName(/\d+\s*$/, LIVE);
    testInfo.annotations.push({ type: 'note', description: `保護者の一覧の個人チャットの表示（送る前）：${before.trim()}` });
    await H.openGuardianPersonal(g, TARO);
    await expect(H.msgText(g, body)).toBeVisible();
    await expect.soft(g.getByRole('main'), '保護者の画面に既読の表示は無い').not.toContainText('既読');
    await evidence(g, '03-005');
  });

  /*
   * 典拠：基本設計書「メッセージの送受信」(4-7) 処理6（保護者が個人チャットへ送ったら未対応に戻す）、詳細設計書「チャット」(4-14 (3))
   *       （保護者が送るメッセージは照合しない）、基本設計書「個人チャットの運用（未対応の管理）」(4-7)、同 (4-10)
   */
  test('03-006 個人チャット：保護者が送ると職員の画面に出る', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    // 前提：対応済みにしておく（送られて未対応に戻るのを見るため）
    const done = page.getByRole('main').getByRole('button', { name: '対応済みにする' });
    if (await done.isVisible().catch(() => false)) await done.click();
    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);

    const body = '受入テスト 03-006 村田 美咲さんのことで';
    await H.sendUi(g, body);
    await expect(H.msgText(g, body)).toBeVisible();
    await expect.soft(H.nameCheckDialog(g), '保護者の送信には他児の名前の注意を出さない').toHaveCount(0);
    await expect(H.msgText(page, body), '職員の画面に再読み込みなしで出る').toBeVisible(LIVE);
    await expect.soft(page.getByRole('main').getByRole('button', { name: '対応済みにする' }), '未対応に戻る（「対応済みにする」が出る）').toBeVisible(LIVE);
    await expect.soft(H.channelButton(page, `${TARO}の園とのやりとり`).first(), '一覧で「未対応」').toHaveAccessibleName(/未対応/, LIVE);
    await evidence(page, '03-006');
  });

  /*
   * 典拠：要件定義書「参照範囲の全体規定」(4-1-5)、同「セキュリティ要求」(8 No.6)、基本設計書「権限と参照範囲の判定」(4-2)、
   *       同「画面とサーバの間のインタフェース」(4-2)、図/インタフェース一覧「エラーの返し方」(0-2)
   */
  test('03-007 個人チャット：ほかの家庭のやりとりは見えない', async ({ page, playwright }) => {
    const { staff, personal } = await roomsOf(playwright);
    const gApi = await H.apiAs(playwright, 'guardian');
    await H.post(staff, personal, '受入テスト 03-007 園から');
    await H.post(gApi, personal, '受入テスト 03-007 家庭から');

    await page.setViewportSize(PHONE);
    await login(page, 'guardianMurata');
    await H.guardianChat(page);
    const main = page.getByRole('main');
    await expect.soft(H.channelButton(page, '村田 美咲の園とのやりとり').first(), '一覧に「村田 美咲の園とのやりとり」').toBeVisible(SOFT);
    await expect.soft(main.getByRole('button', { name: new RegExp(TARO) }), '西田 太郎の個人チャットは出ない').toHaveCount(0);
    await evidence(page, '03-007');
    await H.openGuardianPersonal(page, '村田 美咲');
    await expect.soft(main, 'ほかの家庭のやりとりの本文が出ない').not.toContainText('受入テスト 03-007');

    const r1 = await H.api(page, 'GET', `/api/chat/rooms/${personal}/messages`);
    const r2 = await H.api(page, 'GET', '/api/chat/rooms/999999/messages');
    expect.soft(r1.status, 'ほかの家庭の個人チャットを読む API は 403').toBe(403);
    expect.soft(r1.text, '本文を返さない').not.toContain('受入テスト 03-007');
    expect.soft(r2.status, '存在しない ID と同じ状態コード').toBe(r1.status);
    expect.soft(messageOf(r2), '存在しない ID と同じ文言').toBe(messageOf(r1));
  });

  /*
   * 典拠：要件定義書「参照範囲の全体規定」(4-1-5)、基本設計書「権限と参照範囲の判定」(4-2)、同「権限と利用可能機能」(6-1) ※10、
   *       同「メッセージの送受信」(4-7) 処理3・6
   */
  test('03-008 個人チャット：ほかのクラスの担任には見えない', async ({ page, playwright }) => {
    const { staff, personal } = await roomsOf(playwright);
    await H.post(staff, personal, '受入テスト 03-008 園から');

    await login(page, 'staffHimawari');
    await H.staffChat(page);
    await expect.soft(H.channelButton(page, `${TARO}の園とのやりとり`), '西田 太郎の個人チャットは出ない').toHaveCount(0);
    await expect.soft(H.channelButton(page, 'さくら組'), 'さくら組のクラスグループは出ない').toHaveCount(0);
    await evidence(page, '03-008');

    const r1 = await H.api(page, 'GET', `/api/chat/rooms/${personal}/messages`);
    const r2 = await H.api(page, 'GET', '/api/chat/rooms/999999/messages');
    expect.soft(r1.status, '読む API は 403').toBe(403);
    expect.soft(r1.text, '本文を返さない').not.toContain('受入テスト 03-008');
    expect.soft(messageOf(r2), '存在しない ID と同じ文言').toBe(messageOf(r1));
    const body = '受入テスト 03-008';
    const r3 = await H.api(page, 'POST', `/api/chat/rooms/${personal}/messages`, { body });
    expect.soft(r3.status, '送る API は 403').toBe(403);
    expect.soft(H.messageCount(body), '保存しない').toBe(0);
  });

  /*
   * 典拠：要件定義書「個人チャットの作成と参加者」(4-4)、同「過去ログの参照範囲」(4-4 (c))、基本設計書「個人チャットの作成と参加者」(4-7)、
   *       同「チャット」(5-6)、同「送る時点の守り」(4-2) 処理1・4、同「メッセージ一覧」(4-12)「保護者が未登録」
   */
  test('03-009 保護者がまだいない個人チャットに園が書いたものは、登録した保護者が読める', async ({ page, browser, playwright }, testInfo) => {
    const admin = await H.apiAs(playwright, 'admin');
    await H.createChild(admin, { ...H.KAKUU, className: 'さくら組' });

    await login(page, 'staffSakura');
    await H.staffChat(page);
    const label = `${H.KAKUU.name}の園とのやりとり`;
    await expect(H.channelButton(page, label).first(), '登録した時点で個人チャットがある').toBeVisible();
    await H.openChannel(page, label);
    await expect.soft(page.getByRole('main').getByText('まだ保護者が登録していません（登録すると読めます）').first(), '宛先の表示').toBeVisible(SOFT);
    const body = '受入テスト 03-009 入園の前のご案内';
    await H.sendUi(page, body);
    await expect(H.msgText(page, body)).toBeVisible();
    await expect.soft(H.notice(page, '送りました。保護者が登録すると読めます。'), '保護者が未登録のときの結果の表示').toBeVisible(SOFT);

    const ga = await H.signUp(playwright, await H.issueCode(admin, H.KAKUU.id), '009a');
    const g = await H.openAsNew(browser, testInfo, ga);
    await H.guardianChat(g);
    await expect.soft(H.channelButton(g, label).first(), `一覧に「${label}」`).toBeVisible(SOFT);
    await H.openGuardianPersonal(g, H.KAKUU.name);
    await expect(H.msgText(g, body), '登録した保護者が、登録の前に園が書いたものを読める').toBeVisible();
    await evidence(g, '03-009');
  });

  /*
   * 典拠：要件定義書「過去ログの参照範囲」(4-4 (c))、同「参照範囲の全体規定」(4-1-5)、基本設計書「チャット」(5-6)、
   *       同「メッセージの送受信」(4-7) 処理3、図/画面詳細図 (4-2) 項目3、同「保護者ホーム」(2-7) 項目10
   */
  test('03-010 後から加わった保護者には、先の保護者と園のやりとりを見せない', async ({ page, browser, playwright }, testInfo) => {
    const admin = await H.apiAs(playwright, 'admin');
    const staff = await H.apiAs(playwright, 'staffSakura');
    await H.createChild(admin, { ...H.KAKUU, className: 'さくら組' });
    const room = await H.roomId({ type: '4', childId: H.KAKUU.id });
    const m0 = '受入テスト 03-010 入園の前のご案内';
    const m1 = '受入テスト 03-010 先の保護者の相談';
    const m2 = '受入テスト 03-010 先の保護者への返事';
    const m3 = '受入テスト 03-010 登録のあと';
    // 投稿と保護者の参加が同じ秒に重なると、境（参加した時点・保護者がまだいなかった間）が回によって分かれうる（推測）。
    // ケースが見たいのは境の秒ではないので、それぞれの間を1秒あける（期待は変えない。T13）
    const gap = () => new Promise((r) => setTimeout(r, 1_100));
    await H.post(staff, room, m0);
    await gap();
    const a = await H.signUp(playwright, await H.issueCode(admin, H.KAKUU.id), '010a');
    await gap();
    await H.post(await H.apiLoginAs(playwright, a.email, a.password, 'guardian'), room, m1);
    await H.post(staff, room, m2);
    await gap();
    const b = await H.signUp(playwright, await H.issueCode(admin, H.KAKUU.id), '010b');

    const gB = await H.openAsNew(browser, testInfo, b);
    await H.guardianChat(gB);
    const btnB = gB.getByRole('main').getByRole('button', { name: /(の園とのやりとり|担任の先生とのやりとり)/ }).first();
    await expect.soft(btnB, '後から加わった保護者の未読は、保護者がまだいなかった間の1件だけ').toHaveAccessibleName(/\D1\s*$/, SOFT);
    await H.openGuardianPersonal(gB, H.KAKUU.name);
    await expect(H.msgText(gB, m0), '保護者がまだいなかった間の園のメッセージは読める').toBeVisible();
    await expect.soft(H.msgText(gB, m1), '先の保護者の書いたものは出ない').toHaveCount(0);
    await expect.soft(H.msgText(gB, m2), '先の保護者への園の返事も出ない').toHaveCount(0);

    const gA = await H.openAsNew(browser, testInfo, a);
    await H.guardianChat(gA);
    await H.openGuardianPersonal(gA, H.KAKUU.name);
    for (const m of [m0, m1, m2]) await expect.soft(H.msgText(gA, m), `先の保護者にはすべて出る（${m}）`).toBeVisible(SOFT);

    await login(page, 'staffSakura');
    await H.staffChat(page);
    await H.openChannel(page, `${H.KAKUU.name}の園とのやりとり`);
    for (const m of [m0, m1, m2]) await expect.soft(H.msgText(page, m), `職員にはすべて出る（${m}）`).toBeVisible(SOFT);
    await H.sendUi(page, m3);
    await expect.soft(H.msgText(gA, m3), '先の保護者の窓に再読み込みなしで出る').toBeVisible(LIVE);
    await expect.soft(H.msgText(gB, m3), '後の保護者の窓に再読み込みなしで出る').toBeVisible(LIVE);
    await evidence(gB, '03-010');
  });
});

// =====================================================================
// 閲覧のみの場（園チャット・クラスグループ）
// =====================================================================

test.describe('閲覧のみの場', () => {
  /*
   * 典拠：要件定義書「チャンネル別の権限」(4-4)、同「チャンネルの種別と使い分け」(4-4)、基本設計書「チャットツール」(4-7) の表、
   *       同「メッセージ一覧」(4-12)「閲覧のみの場（保護者）」、詳細設計書「チャット」(4-14 (3))、図/画面詳細図 (4-1) 項目7、同 (4-2) 項目5・15・16
   */
  test('03-011 園チャット：管理者のお知らせが保護者に届き、一般と保護者は送れない', async ({ page, browser }, testInfo) => {
    await login(page, 'admin');
    await H.staffChat(page);
    await H.openChannel(page, '園全体');
    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianChat(g);
    await H.openChannel(g, '園からのお知らせ');

    const body = '受入テスト 03-011';
    await H.sendUi(page, body);
    await expect(H.msgText(page, body)).toBeVisible();
    await expect(H.msgText(g, body), '保護者の画面に再読み込みなしで出る').toBeVisible(LIVE);
    await expect.soft(H.composer(g), '保護者の画面に投稿欄は無い').toHaveCount(0);
    await expect.soft(g.getByRole('main').getByText(READ_ONLY_NOTICE), '閲覧のみの場の案内').toBeVisible(SOFT);
    await expect.soft(H.bubbleWithButton(g, body, 'この連絡について園にたずねる'), 'メッセージに「この連絡について園にたずねる」').toHaveCount(1, SOFT);
    await evidence(g, '03-011');
    await H.openOps(g, body);
    await expect.soft(H.opButton(g, '読みました'), 'メッセージにリアクション（読みました）').toBeVisible(SOFT);
    await closeOps(g);

    const s = await H.openAs(browser, testInfo, 'staffSakura');
    await H.staffChat(s);
    await H.openChannel(s, '園全体');
    await expect.soft(H.msgText(s, body), '一般もメッセージは読める').toBeVisible(SOFT);
    await expect.soft(H.composer(s), '一般には投稿欄が出ない（閲覧のみ）').toHaveCount(0);
    const room = await H.roomId({ type: '1' });
    const r = await H.api(s, 'POST', `/api/chat/rooms/${room}/messages`, { body: '受入テスト 03-011 一般' });
    expect.soft(r.status, '一般が園チャットへ送る API は 403').toBe(403);
    expect.soft(messageOf(r), '文言').toBe(NOT_ALLOWED_POST);
    expect.soft(H.messageCount('受入テスト 03-011 一般'), '保存しない').toBe(0);
  });

  /*
   * 典拠：要件定義書「チャンネル別の権限」(4-4)、同「グループの種別」(4-4 (a))、基本設計書「チャットツール」(4-7)、
   *       同「メッセージの送受信」(4-7) 処理6、図/画面詳細図 (4-2) 項目5・15
   */
  test('03-012 クラスグループ：担任のお知らせがクラスの保護者に届き、保護者は送れない', async ({ page, browser, playwright }, testInfo) => {
    await login(page, 'staffSakura');
    await H.staffChat(page);
    await H.openChannel(page, 'さくら組');
    const g1 = await H.openAs(browser, testInfo, 'guardian');
    const g2 = await H.openAs(browser, testInfo, 'guardianMurata');
    for (const g of [g1, g2]) {
      await H.guardianChat(g);
      await H.openChannel(g, 'さくら組');
    }
    const body = '受入テスト 03-012';
    await H.sendUi(page, body);
    await expect(H.msgText(page, body)).toBeVisible();
    await expect.soft(H.msgText(g1, body), '西田 太郎の保護者の画面に再読み込みなしで出る').toBeVisible(LIVE);
    await expect.soft(H.msgText(g2, body), '村田 美咲の保護者の画面に再読み込みなしで出る').toBeVisible(LIVE);
    await expect.soft(H.composer(g1), '保護者の画面に投稿欄は無い').toHaveCount(0);
    await expect.soft(g1.getByRole('main').getByText(READ_ONLY_NOTICE), '閲覧のみの場の案内').toBeVisible(SOFT);
    await evidence(g1, '03-012');

    const { sakura } = await roomsOf(playwright);
    const r = await H.api(g1, 'POST', `/api/chat/rooms/${sakura}/messages`, { body: '受入テスト 03-012 保護者' });
    expect.soft(r.status, '保護者がクラスグループへ送る API は 403').toBe(403);
    expect.soft(messageOf(r), '文言').toBe(NOT_ALLOWED_POST);
    expect.soft(H.messageCount('受入テスト 03-012 保護者'), '保存しない').toBe(0);

    const k = await H.openAs(browser, testInfo, 'staffHimawari');
    await H.staffChat(k);
    await expect.soft(H.channelButton(k, 'さくら組'), 'ひまわり組の担任の一覧にさくら組のクラスグループは出ない').toHaveCount(0);
  });

  /*
   * 典拠：要件定義書「リアクション」(4-4 機能一覧)、基本設計書「リアクション」(4-7)、同「チャット」(5-6)（t_chat_reaction）、
   *       図/インタフェース一覧「チャットツール」(1)（reactions）、図/画面詳細図 (4-2) 項目12・13
   */
  test('03-013 リアクション「読みました」', async ({ page, browser, playwright }, testInfo) => {
    const { staff, sakura } = await roomsOf(playwright);
    const body = '受入テスト 03-013 お知らせ';
    await H.post(staff, sakura, body);
    await login(page, 'staffSakura');
    await H.staffChat(page);
    await H.openChannel(page, 'さくら組');
    const g1 = await H.openAs(browser, testInfo, 'guardian');
    const g2 = await H.openAs(browser, testInfo, 'guardianMurata');
    for (const g of [g1, g2]) {
      await H.guardianChat(g);
      await H.openChannel(g, 'さくら組');
      await expect(H.msgText(g, body)).toBeVisible();
    }
    await H.openOps(g1, body);
    const read = H.opButton(g1, '読みました');
    await expect(read, '保護者のリアクションは「読みました」').toBeVisible();
    for (const other of ['了解', 'ありがとう', 'うれしい']) await expect.soft(H.opButton(g1, other), `保護者に「${other}」は出ない（1種類）`).toHaveCount(0);
    await read.click();

    await expect.poll(async () => fullText(bubbleWith(page, body, '読みました')), { ...LIVE, message: '職員の画面に再読み込みなしで出る' }).toContain('読みました');
    expect.soft(await fullText(bubbleWith(page, body, '読みました')), '職員の画面では、どの家庭が反応したかが分かる').toMatch(/西田/);
    await expect.poll(async () => fullText(bubbleWith(g2, body, '読みました')), { ...LIVE, message: 'ほかの家庭の画面に数が出る' }).toMatch(/1/);
    expect.soft(await fullText(bubbleWith(g2, body, '読みました')), 'ほかの家庭の画面には、誰が反応したかを出さない').not.toMatch(/西田/);
    await evidence(page, '03-013');

    await H.openOps(g1, body);
    await H.opButton(g1, '読みました').click();
    await expect.poll(async () => fullText(bubbleWith(g1, body, '読みました')), { ...SOFT, message: 'もう一度押すと外れる' }).toBe('');
  });

  /*
   * 典拠：基本設計書「園にたずねる（閲覧のみの場から）」(4-7)、詳細設計書「チャット画面（職員・保護者）」(2-9 (4)・(7))、
   *       同「チャット」(4-14 (1)・(3))、同「本書で決めたこと」(10) D-36、図/画面詳細図 (4-1) 項目27、同 (4-2) 項目16・18、図/画面遷移図「チャットツール」(5)
   */
  test('03-014 園にたずねる（閲覧のみの場から）', async ({ page, browser, playwright }, testInfo) => {
    const { staff, sakura } = await roomsOf(playwright);
    const body = '受入テスト 03-014 持ち物のお知らせ';
    await H.post(staff, sakura, body);
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianChat(g);
    await H.openChannel(g, 'さくら組');
    await expect(H.msgText(g, body)).toBeVisible();
    await H.bubbleWithButton(g, body, 'この連絡について園にたずねる').getByRole('button', { name: 'この連絡について園にたずねる' }).click();

    // ② 同じ画面の中で個人チャットに切り替わり、入力欄の上に引用
    await expect(H.composer(g), '個人チャットに切り替わる').toBeVisible();
    await expect.soft(g.getByRole('dialog'), '自児が1人なので、園児を選ぶダイアログは出ない').toHaveCount(0);
    await expect.soft(g.getByRole('main'), '入力欄の上に元のお知らせの冒頭の引用').toContainText('持ち物のお知らせ', SOFT);
    await expect.soft(g.getByRole('main').getByRole('button', { name: '引用を外す' }), '「引用を外す」').toBeVisible(SOFT);
    const q = '受入テスト 03-014 質問';
    await H.sendUi(g, q);

    // ③ 職員の画面
    await expect(H.msgText(page, q), '職員の画面に再読み込みなしで出る').toBeVisible(LIVE);
    const bubble = bubbleWith(page, q, 'のお知らせについて');
    await expect.soft(bubble, 'メッセージの上に「（チャンネル名）のお知らせについて」').toContainText('のお知らせについて', SOFT);
    await expect.soft(bubble, '元の本文の冒頭').toContainText('持ち物のお知らせ', SOFT);
    await expect.soft(page.getByRole('main').getByRole('button', { name: '対応済みにする' }), '個人チャットは未対応になる').toBeVisible(SOFT);
    await evidence(page, '03-014');

    // ④ 引用を押すと、元のチャンネルのそのメッセージへ
    if ((await bubble.count()) > 0) {
      await bubble.getByText(/のお知らせについて/).first().click();
      await expect.soft(page.getByRole('main').getByRole('heading', { level: 2 }).filter({ hasText: 'さくら組' }).first(), '元のチャンネル（さくら組）へ移る').toBeVisible(SOFT);
      await expect.soft(H.msgText(page, body), '元のメッセージが出る').toBeVisible(SOFT);
    }
  });

  /*
   * 典拠：基本設計書「園にたずねる（閲覧のみの場から）」(4-7)、詳細設計書「チャットの「確認しました」と引用」(3-8)、同「チャット」(4-14 (3))、
   *       同「チャット画面（職員・保護者）」(2-9 (7))、同「本書で足す文言」(4-1 (6))
   */
  test('03-015 園にたずねる：引用したお知らせが取り消されたとき', async ({ page, browser, playwright }, testInfo) => {
    const { staff, sakura, personal } = await roomsOf(playwright);
    const gApi = await H.apiAs(playwright, 'guardian');
    const m = await H.post(staff, sakura, '受入テスト 03-015 お知らせ');
    const q = '受入テスト 03-015 質問';
    await H.post(gApi, personal, q, { quote_message_id: m.chat_message_id });

    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianChat(g);
    await H.openChannel(g, 'さくら組');
    await expect(H.msgText(g, '受入テスト 03-015 お知らせ')).toBeVisible();
    const asks = g.getByRole('main').getByRole('button', { name: 'この連絡について園にたずねる' });
    const before = await asks.count();

    await H.retract(staff, m.chat_message_id);

    await guardianOpenTaro(g);
    await expect(H.msgText(g, q)).toBeVisible();
    await expect.soft(g.getByRole('main'), '保護者の画面で引用が「取り消されたメッセージ」').toContainText('取り消されたメッセージ', SOFT);
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    await expect.soft(page.getByRole('main'), '職員の画面で引用が「取り消されたメッセージ」').toContainText('取り消されたメッセージ', SOFT);
    await evidence(page, '03-015');

    await H.guardianChat(g);
    await H.openChannel(g, 'さくら組');
    await expect.soft(asks, '取り消されたメッセージには「この連絡について園にたずねる」が出ない').toHaveCount(Math.max(0, before - 1), SOFT);

    const r = await H.api(g, 'POST', `/api/chat/rooms/${personal}/messages`, { body: '受入テスト 03-015', quote_message_id: m.chat_message_id });
    expect.soft(r.status, '取り消したお知らせの引用は 400').toBe(400);
    expect.soft(messageOf(r), '文言').toBe('引用したお知らせは取り消されました。引用を外して送ってください。');
    expect.soft(H.messageCount('受入テスト 03-015'), '保存しない').toBe(0);
  });

  /*
   * 典拠：基本設計書「園にたずねる」(4-5)、同「園にたずねる（閲覧のみの場から）」(4-7)、詳細設計書「チャット画面（職員・保護者）」(2-9 (4)・(7))、
   *       図/画面遷移図「チャットツール」(5)、図/画面詳細図 (4-1) 項目27、同 (4-2) 項目5・18
   */
  test('03-016 園にたずねる（連絡帳から）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const g = await H.openAs(browser, testInfo, 'guardian');
    const taroId = H.childIdOf(TARO);
    await g.goto(`/guardian/contact/${taroId}`);
    const ask = g.getByRole('button', { name: 'この日の連絡帳について園にたずねる' }).or(g.getByRole('link', { name: 'この日の連絡帳について園にたずねる' }));
    await expect(ask.first(), '連絡帳画面に「この日の連絡帳について園にたずねる」').toBeVisible();
    await ask.first().click();

    const [, mm, dd] = jstToday().split('-').map(Number);
    const chip = `${mm}月${dd}日の連絡帳について`;
    await expect(H.composer(g), 'チャット画面（保護者）の個人チャットが開く').toBeVisible();
    await expect.soft(g.getByRole('main'), `入力欄の上に「${chip}」`).toContainText(chip, SOFT);
    await expect.soft(g.getByRole('main').getByRole('button', { name: '引用を外す' }), '「引用を外す」').toBeVisible(SOFT);
    const q = '受入テスト 03-016';
    await H.sendUi(g, q);
    await expect(H.msgText(page, q), '職員の画面に再読み込みなしで出る').toBeVisible(LIVE);
    await expect.soft(bubbleWith(page, q, '連絡帳について'), `メッセージの上に「${chip}」`).toContainText(chip, SOFT);

    await g.reload();
    await expect(H.composer(g)).toBeVisible();
    await expect.soft(g.getByRole('main').getByRole('button', { name: '引用を外す' }), '再読み込みで引用が入力欄に付き直さない').toHaveCount(0);
    await evidence(page, '03-016');

    const link = bubbleWith(page, q, '連絡帳について').getByText(chip).first();
    if ((await link.count()) > 0) {
      await link.click();
      await expect.soft(page.getByRole('main').getByRole('region', { name: /(きょう|この日)のようす/ }).first(), '連絡帳（園児）画面へ移る').toBeVisible(SOFT);
      await expect.soft(page.getByRole('main'), 'その園児').toContainText(TARO, SOFT);
    }
  });
});

// =====================================================================
// 確認しました・既読確認
// =====================================================================

test.describe('確認しました・既読確認', () => {
  /*
   * 典拠：要件定義書「確認しました」(4-4 機能一覧)、基本設計書「確認しました」(4-7)、詳細設計書「チャット画面（職員・保護者）」(2-9 (2)・(6))、
   *       同「チャットの「確認しました」と引用」(3-8)、同「本書で足す文言」(4-1 (6))、図/画面詳細図 (4-1) 項目21、同 (4-2) 項目17
   */
  test('03-017 確認しました', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);
    const body = '受入テスト 03-017';
    await H.sendUi(g, body);
    await expect(H.msgText(page, body)).toBeVisible(LIVE);

    await H.openOps(page, body);
    await H.opButton(page, '確認しました').click();
    await expect.soft(page.getByRole('dialog'), '確認のダイアログを挟まない').toHaveCount(0);
    await expect.soft(H.notice(page, '確認しました。保護者の画面に「園が確認しました」が出ます。'), '結果の表示').toBeVisible(SOFT);
    await expect.soft(bubbleWith(page, body, '園が確認しました'), '職員の画面に「園が確認しました（時刻 押した職員）」').toContainText(/園が確認しました（\d{1,2}:\d{2}\s*鈴木/, SOFT);
    await expect.soft(bubbleWith(g, body, '園が確認しました'), '保護者の画面に再読み込みなしで「園が確認しました（時刻）」').toContainText(/園が確認しました（\d{1,2}:\d{2}）/, LIVE);
    expect.soft(await fullText(bubbleWith(g, body, '園が確認しました')), '保護者の画面には押した職員の名前を出さない').not.toMatch(/園が確認しました（[^）]*鈴木/);
    await expect.soft(page.getByRole('main').getByRole('button', { name: '対応済みにする' }), 'スレッドは未対応のまま').toBeVisible(SOFT);
    await evidence(g, '03-017');
  });

  /*
   * 典拠：基本設計書「確認しました」(4-7)、同「チャット」(5-6)、詳細設計書「チャット」(4-14 (5))、同「チャットの「確認しました」と引用」(3-8)、
   *       図/画面詳細図 (4-1) 項目15・21、図/インタフェース一覧「チャットツール」(1)（confirm）
   */
  test('03-018 確認しました：付けられないもの・外せないもの', async ({ page, playwright }) => {
    const { staff, personal } = await roomsOf(playwright);
    const gApi = await H.apiAs(playwright, 'guardian');
    const gm = await H.post(gApi, personal, '受入テスト 03-018 家庭から');
    const sm = await H.post(staff, personal, '受入テスト 03-018');
    const first = await status(staff.post(`/api/chat/messages/${gm.chat_message_id}/confirm`, { data: {} }));
    expect(first.status, `前提：鈴木が「確認しました」を付ける（${first.text}）`).toBe(200);

    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    await H.openOps(page, '受入テスト 03-018');
    await expect.soft(H.opButton(page, '確認しました'), '職員のメッセージに「確認しました」は出ない').toHaveCount(0);
    await closeOps(page);
    await H.openOps(page, '受入テスト 03-018 家庭から');
    await expect.soft(page.getByRole('main').getByRole('button', { name: /外す/ }), '外す操作は無い').toHaveCount(0);
    await evidence(page, '03-018');
    await closeOps(page);

    const admin = await H.apiAs(playwright, 'admin');
    const again = await status(admin.post(`/api/chat/messages/${gm.chat_message_id}/confirm`, { data: {} }));
    expect.soft(again.status, '確認済みに押しても 200').toBe(200);
    const after = (await H.messages(staff, personal)).find((x) => x.chat_message_id === gm.chat_message_id);
    expect.soft(String(after?.confirmed_staff_name ?? ''), '確認した職員は最初に押した鈴木のまま').toContain('鈴木');
    const own = await status(staff.post(`/api/chat/messages/${sm.chat_message_id}/confirm`, { data: {} }));
    expect.soft(own.status, '職員のメッセージには 400').toBe(400);
    expect.soft(own.text, '文言').toContain('「確認しました」は保護者のメッセージにだけ付けられます。');
    const kubota = await H.apiAs(playwright, 'staffHimawari');
    const other = await status(kubota.post(`/api/chat/messages/${gm.chat_message_id}/confirm`, { data: {} }));
    expect.soft(other.status, 'ほかのクラスの担任は 403').toBe(403);
    expect.soft(other.text, '文言').toContain('このチャンネルを参照する権限がありません');
  });

  /*
   * 典拠：要件定義書「既読確認」(4-4)、基本設計書「既読確認」(4-7)、同「個人チャットの運用（未対応の管理）」(4-7)、
   *       詳細設計書「チャット」(4-14 (2))、図/画面詳細図 (4-1) 項目4、同 (4-2) 注記
   */
  test('03-019 保護者の既読の人数（保護者には既読を出さない）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianChat(g);
    const body = '受入テスト 03-019';
    await H.sendUi(page, body);
    await expect(H.msgText(page, body)).toBeVisible();
    await expect.soft(bubbleWith(page, body, '保護者の既読'), '送った直後「保護者の既読 0／1 名」').toContainText(/保護者の既読\s*0\s*／\s*1\s*名/, SOFT);

    await H.openGuardianPersonal(g, TARO);
    await expect(H.msgText(g, body)).toBeVisible();
    await expect.soft(bubbleWith(page, body, '保護者の既読'), '再読み込みなしで「保護者の既読 1／1 名」').toContainText(/保護者の既読\s*1\s*／\s*1\s*名/, LIVE);
    await evidence(page, '03-019');

    const admin = await H.openAs(browser, testInfo, 'admin');
    await staffOpenTaro(admin);
    await expect.soft(bubbleWith(admin, body, '保護者の既読'), '送った本人でない職員にも同じ人数').toContainText(/保護者の既読\s*1\s*／\s*1\s*名/, SOFT);

    const gm = g.getByRole('main');
    await expect.soft(gm, '保護者の画面に既読は出ない').not.toContainText('既読');
    await expect.soft(gm, '保護者の画面にスレッドの未対応は出ない').not.toContainText('未対応');
    await expect.soft(gm, '保護者の画面にスレッドの対応済みは出ない').not.toContainText('対応済み');
    const personal = Number(H.sqlAll(`SELECT chat_room_id FROM m_chat_room WHERE room_type = '4' AND child_id = ?`, H.childIdOf(TARO))[0]?.chat_room_id);
    const r = await H.api(g, 'GET', `/api/chat/rooms/${personal}/messages`);
    expect.soft(r.text, '保護者の応答に既読の人数・分母・確認した職員の名前を入れない').not.toMatch(/guardian_read_count|guardian_total|"read_count"|confirmed_staff_name/);
  });

  /*
   * 典拠：要件定義書「既読確認」(4-4)、同「緊急連絡の扱い」(4-4)、基本設計書「既読確認」(4-7)、詳細設計書「チャット画面（職員・保護者）」(2-9 (3))、
   *       同「チャット」(4-14 (6))、同「本書で決めたこと」(10) D-37・D-38、図/画面詳細図 (4-1) 項目22
   */
  test('03-020 まだ読んでいない家庭（クラスグループ）', async ({ page, playwright }) => {
    const { staff, sakura } = await roomsOf(playwright);
    const body = '受入テスト 03-020';
    const m = await H.post(staff, sakura, body);
    await H.markRead(await H.apiAs(playwright, 'guardian'), sakura);
    await H.waitGuardianRead(m.chat_message_id);

    await login(page, 'staffSakura');
    await H.staffChat(page);
    await H.openChannel(page, 'さくら組');
    const bubble = bubbleWith(page, body, '保護者の既読');
    await expect.soft(bubble, '「保護者の既読 1／4 名」（停止中の保護者は分母に入れない）').toContainText(/保護者の既読\s*1\s*／\s*4\s*名/, SOFT);
    await bubble.getByText(/保護者の既読/).first().click(SOFT);
    const dialog = page.getByRole('dialog').filter({ hasText: 'まだ読んでいない家庭' });
    await expect(dialog, '「まだ読んでいない家庭」が開く').toBeVisible();
    for (const n of ['遠藤 花子', '村田 美咲', '久保田 陸']) await expect.soft(dialog, `${n}の家庭が出る`).toContainText(n);
    for (const n of [TARO, '鈴木 健']) await expect.soft(dialog, `${n}の家庭は出ない`).not.toContainText(n);
    await expect.soft(dialog.locator('a[href^="tel:"]').first(), '連絡先は電話をかけられるリンク').toBeVisible(SOFT);
    const text = await dialog.innerText();
    const pos = ['遠藤 花子', '久保田 陸', '村田 美咲'].map((n) => text.indexOf(n));
    expect.soft(pos.every((p, i) => p >= 0 && (i === 0 || pos[i - 1] < p)), '園児のよみの順（えんどう・くぼた・むらた）').toBe(true);
    await expect.soft(dialog.getByRole('button', { name: /再送|催促/ }), '再送・催促の操作は無い').toHaveCount(0);
    await evidence(page, '03-020');
  });

  /*
   * 典拠：基本設計書「既読確認」(4-7)（一般は自クラスの園児の家庭に限る）、要件定義書「緊急連絡先の保持」(4-1-1)、詳細設計書「チャット」(4-14 (6))、
   *       同「本書で足す文言」(4-1 (6))、図/画面詳細図 (4-1) 項目22
   */
  test('03-021 まだ読んでいない家庭：一般は自クラスの家庭だけ', async ({ page, browser, playwright }, testInfo) => {
    const admin = await H.apiAs(playwright, 'admin');
    await H.signUp(playwright, await H.issueCode(admin, 'C013'), '021');
    const himawariChild = H.childNameOf('C013');
    const room = await H.roomId({ type: '1' });
    const body = '受入テスト 03-021';
    await H.post(admin, room, body);

    await login(page, 'staffSakura');
    await H.staffChat(page);
    await H.openChannel(page, '園全体');
    await bubbleWith(page, body, '保護者の既読').getByText(/保護者の既読/).first().click(SOFT);
    const dialog = page.getByRole('dialog').filter({ hasText: 'まだ読んでいない家庭' });
    await expect(dialog, '「まだ読んでいない家庭」が開く').toBeVisible();
    await expect.soft(dialog, 'さくら組の家庭が出る').toContainText(TARO);
    await expect.soft(dialog, 'ひまわり組の家庭は出ない').not.toContainText(himawariChild);
    await expect.soft(dialog, '案内の文').toContainText('ほかのクラスの家庭は、そのクラスの担任か管理者が確かめられます。');
    await evidence(page, '03-021');

    const a = await H.openAs(browser, testInfo, 'admin');
    await H.staffChat(a);
    await H.openChannel(a, '園全体');
    await bubbleWith(a, body, '保護者の既読').getByText(/保護者の既読/).first().click(SOFT);
    await expect.soft(a.getByRole('dialog').filter({ hasText: 'まだ読んでいない家庭' }), '管理者にはひまわり組の家庭も出る').toContainText(himawariChild, SOFT);
  });
});

// =====================================================================
// 編集
// =====================================================================

test.describe('編集', () => {
  /* 典拠：基本設計書「メッセージの編集」(4-7)、図/画面詳細図 (4-1) 項目10〜13・15・注記、同 (4-2) 項目11、図/画面遷移図「チャットツール」(5) */
  test('03-022 編集（職員）', async ({ page, browser, playwright }, testInfo) => {
    const { staff, personal } = await roomsOf(playwright);
    const body = '受入テスト 03-022';
    await H.post(staff, personal, body);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);
    await expect(H.msgText(g, body)).toBeVisible();
    // 前提：保護者がリアクションを付ける（設計の「読みました」。無ければ出ている最初のもの）
    await H.openOps(g, body);
    let reaction = '読みました';
    if ((await H.opButton(g, reaction).count()) === 0) {
      const any = g.getByRole('main').getByRole('group').getByRole('button').first();
      const shown = (await any.innerText()).trim();
      const label = (await any.getAttribute('aria-label')) ?? '';
      reaction = shown || label;
      testInfo.annotations.push({ type: 'note', description: `前提のリアクションに「読みました」が無いため「${label || shown}」を付けた` });
      await any.click();
    } else {
      await H.opButton(g, reaction).click();
    }

    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    await expect.soft(H.bubbleWithButton(page, body, '操作'), 'メッセージに「操作」ボタン').toHaveCount(1, SOFT);
    const path = new URL(page.url()).pathname;
    await H.openOps(page, body);
    await H.opButton(page, '編集').click();
    const editor = await editorWith(page, body);
    expect.soft(new URL(page.url()).pathname, '画面は移らない').toBe(path);
    await editor.fill('受入テスト 03-022 途中');
    await page.getByRole('main').getByRole('button', { name: 'やめる' }).click();
    await expect(H.msgText(page, body), 'やめると編集前の本文に戻る').toBeVisible();

    await H.openOps(page, body);
    await H.opButton(page, '編集').click();
    const next = '受入テスト 03-022 直した';
    await (await editorWith(page, body)).fill(next);
    await page.getByRole('main').getByRole('button', { name: /^(保存|保存する)$/ }).click();
    await expect(H.msgText(page, next)).toBeVisible();
    await expect.soft(bubbleWith(page, next, '編集済み'), '職員の画面に「（編集済み）」').toContainText('（編集済み）', SOFT);
    await expect.soft(H.msgText(g, next), '保護者の画面に再読み込みなしで新しい本文').toBeVisible(LIVE);
    await expect.soft(bubbleWith(g, next, '編集済み'), '保護者の画面に「（編集済み）」').toContainText('（編集済み）', SOFT);
    await expect.soft(bubbleWith(page, next, '保護者の既読'), '既読の人数はそのまま').toContainText(/保護者の既読\s*1\s*／\s*1\s*名/, SOFT);
    expect.soft(await fullText(bubbleWith(page, next, reaction)), 'リアクションはそのまま').toContain(reaction);
    await evidence(page, '03-022');
  });

  /* 典拠：基本設計書「メッセージの編集」(4-7)（保護者も自分のものは編集できる・確認しましたは維持）、詳細設計書「チャットの「確認しました」と引用」(3-8)、図/画面詳細図 (4-2) 項目8〜12・注記 */
  test('03-023 編集（保護者）', async ({ page, browser, playwright }, testInfo) => {
    const { staff, personal } = await roomsOf(playwright);
    const gApi = await H.apiAs(playwright, 'guardian');
    const body = '受入テスト 03-023';
    const gm = await H.post(gApi, personal, body);
    const c = await status(staff.post(`/api/chat/messages/${gm.chat_message_id}/confirm`, { data: {} }));
    if (c.status !== 200) testInfo.annotations.push({ type: 'note', description: `前提の「確認しました」を付けられなかった（${c.status} ${c.text}）` });
    const fromStaff = '受入テスト 03-023 園から';
    await H.post(staff, personal, fromStaff);

    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);
    await H.openOps(g, body);
    await H.opButton(g, '編集').click();
    const next = '受入テスト 03-023 直した';
    await (await editorWith(g, body)).fill(next);
    await g.getByRole('main').getByRole('button', { name: /^(保存|保存する)$/ }).click();
    await expect(H.msgText(g, next)).toBeVisible();
    await expect.soft(H.msgText(page, next), '職員の画面に再読み込みなしで新しい本文').toBeVisible(LIVE);
    await expect.soft(bubbleWith(page, next, '編集済み'), '職員の画面に「（編集済み）」').toContainText('（編集済み）', SOFT);
    await expect.soft(bubbleWith(page, next, '園が確認しました'), '職員の画面に「園が確認しました」が残る').toContainText('園が確認しました', SOFT);
    await expect.soft(bubbleWith(g, next, '園が確認しました'), '保護者の画面に「園が確認しました」が残る').toContainText('園が確認しました', SOFT);
    await evidence(page, '03-023');
    await H.openOps(g, fromStaff);
    await expect.soft(H.opButton(g, '編集'), '園から送られたメッセージに「編集」は無い').toHaveCount(0);
  });

  /* 典拠：要件定義書「メッセージの編集・送信取消」(4-4 機能一覧)、基本設計書「メッセージの編集」(4-7)、同「権限と利用可能機能」(6-1) ※6、図/画面詳細図 (4-1) 項目10・15 */
  test('03-024 他者のメッセージは編集できない', async ({ page, playwright }) => {
    const { staff, personal, sakura } = await roomsOf(playwright);
    const admin = await H.apiAs(playwright, 'admin');
    const gApi = await H.apiAs(playwright, 'guardian');
    const a = await H.post(admin, personal, '受入テスト 03-024a');
    await H.post(gApi, personal, '受入テスト 03-024b');
    const c = await H.post(staff, sakura, '受入テスト 03-024c');
    const d = await H.post(staff, personal, '受入テスト 03-024d');
    await H.retract(staff, d.chat_message_id);

    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    for (const b of ['受入テスト 03-024a', '受入テスト 03-024b']) {
      await H.openOps(page, b);
      await expect.soft(H.opButton(page, '編集'), `${b} に「編集」は無い`).toHaveCount(0);
      await closeOps(page);
    }
    await evidence(page, '03-024');
    const bodyOf = (id: number) => String(H.sqlAll('SELECT body FROM t_chat_message WHERE chat_message_id = ?', id)[0]?.body ?? '');
    const r2 = await status(staff.post(`/api/chat/messages/${a.chat_message_id}/edit`, { data: { body: '受入テスト 03-024a 書き換え' } }));
    expect.soft(r2.status, `一般が管理者のメッセージを編集する API は拒む（${r2.text}）`).toBeGreaterThanOrEqual(400);
    expect.soft(bodyOf(a.chat_message_id), '本文は変わらない').toBe('受入テスト 03-024a');
    const r3 = await status(admin.post(`/api/chat/messages/${c.chat_message_id}/edit`, { data: { body: '受入テスト 03-024c 書き換え' } }));
    expect.soft(r3.status, `管理者でもクラスグループの他者のメッセージは編集できない（${r3.text}）`).toBeGreaterThanOrEqual(400);
    expect.soft(bodyOf(c.chat_message_id), '本文は変わらない').toBe('受入テスト 03-024c');
    const r4 = await status(staff.post(`/api/chat/messages/${d.chat_message_id}/edit`, { data: { body: '受入テスト 03-024d 書き換え' } }));
    expect.soft(r4.status, `取り消したメッセージは編集できない（${r4.text}）`).toBeGreaterThanOrEqual(400);
    expect.soft(bodyOf(d.chat_message_id), '取り消された痕跡のまま').not.toBe('受入テスト 03-024d 書き換え');
  });

  /* 典拠：要件定義書「メッセージの編集・送信取消」(4-4 機能一覧)、基本設計書「メッセージの編集」(4-7)、同「権限と利用可能機能」(6-1) ※6、図/画面詳細図 (4-1) 項目10・14・15 */
  test('03-025 園チャットは管理者どうしで編集できる', async ({ page, browser, playwright }, testInfo) => {
    const admin = await H.apiAs(playwright, 'admin');
    const room = await H.roomId({ type: '1' });
    const body = '受入テスト 03-025';
    await H.post(admin, room, body);
    await login(page, 'admin2');
    await H.staffChat(page);
    await H.openChannel(page, '園全体');
    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianChat(g);
    await H.openChannel(g, '園からのお知らせ');
    await expect(H.msgText(g, body)).toBeVisible();

    await H.openOps(page, body);
    await expect.soft(H.opButton(page, '取消'), 'ほかの管理者の投稿に「取消」は出ない').toHaveCount(0);
    await expect(H.opButton(page, '編集'), 'ほかの管理者の園チャットの投稿に「編集」が出る').toBeVisible();
    await H.opButton(page, '編集').click();
    const next = '受入テスト 03-025 直した';
    await (await editorWith(page, body)).fill(next);
    await page.getByRole('main').getByRole('button', { name: /^(保存|保存する)$/ }).click();
    await expect(H.msgText(page, next)).toBeVisible();
    await expect.soft(bubbleWith(page, next, '編集済み'), '「（編集済み）」').toContainText('（編集済み）', SOFT);
    await expect.soft(H.msgText(g, next), '保護者の画面に再読み込みなしで出る').toBeVisible(LIVE);
    await evidence(g, '03-025');
  });

  /* 典拠：基本設計書「メッセージの編集」(4-7) 処理5、同「送る時点の守り」(4-2)、同「メッセージ一覧」(4-12)「他児の名前の注意」、詳細設計書「チャット」(4-14 (4))、図/画面詳細図「共通のダイアログと部品」(1-3) (3) */
  test('03-026 編集でも他児の名前の注意を通す', async ({ page, playwright }) => {
    const { staff, personal } = await roomsOf(playwright);
    const body = '受入テスト 03-026';
    const m = await H.post(staff, personal, body);
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    await H.openOps(page, body);
    await H.opButton(page, '編集').click();
    const next = '受入テスト 03-026 村田 美咲さんと';
    const editor = await editorWith(page, body);
    await editor.fill(next);
    const save = page.getByRole('main').getByRole('button', { name: /^(保存|保存する)$/ });
    await save.click();
    const dialog = H.nameCheckDialog(page);
    await expect(dialog, '他児の名前の注意が出る').toBeVisible();
    await expect.soft(dialog, '注意の文').toContainText('ほかのお子さんの名前（村田 美咲）が入っています。このまま送りますか。');
    await expect.soft(dialog.locator('mark, strong, em, b').first(), '当たった語を強調する').toBeVisible(SOFT);
    await evidence(page, '03-026');
    await dialog.getByRole('button', { name: '直す' }).click();
    await expect(dialog).toBeHidden();
    await expect.soft(editor, '編集の入力欄に書いた文が残る').toHaveValue(next, SOFT);
    expect.soft(String(H.sqlAll('SELECT body FROM t_chat_message WHERE chat_message_id = ?', m.chat_message_id)[0]?.body), '本文は変わらない').toBe(body);
    await save.click();
    await dialog.getByRole('button', { name: 'このまま送る' }).click();
    await expect(H.msgText(page, next), 'このまま送ると保存される').toBeVisible();
    await expect.soft(bubbleWith(page, next, '編集済み'), '「（編集済み）」').toContainText('（編集済み）', SOFT);
  });

  /* 典拠：基本設計書「送る時点の守り」(4-2) 処理3、同「メッセージ一覧」(4-12)、詳細設計書「他児の名前の照合」(4-5 (2) ④)、同「チャット」(4-14 (3))、要件定義書「保護者へ届けるときの関所」(4-1-6) (2)、図/画面詳細図「共通のダイアログと部品」(1-3) (3) */
  test('03-027 送るときの他児の名前の注意', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);

    const a = '受入テスト 03-027a 村田 美咲さんと';
    await H.sendUi(page, a);
    const dialog = H.nameCheckDialog(page);
    await expect(dialog, '他児の名前の注意が出る').toBeVisible();
    await expect.soft(dialog, '注意の文').toContainText('ほかのお子さんの名前（村田 美咲）が入っています。このまま送りますか。');
    await expect.soft(dialog.locator('mark, strong, em, b').first(), '当たった語を強調する').toBeVisible(SOFT);
    expect.soft(H.messageCount(a), '初めの送信は保存されない').toBe(0);
    await evidence(page, '03-027');
    await dialog.getByRole('button', { name: '直す' }).click();
    await expect.soft(H.composer(page), '「直す」で入力が残る').toHaveValue(a, SOFT);
    await H.sendButton(page).click();
    await dialog.getByRole('button', { name: 'このまま送る' }).click();
    await expect(H.msgText(page, a)).toBeVisible();
    await expect.soft(H.msgText(g, a), '保護者の画面に再読み込みなしで出る').toBeVisible(LIVE);

    const b = `受入テスト 03-027b ${TARO}さん`;
    await H.sendUi(page, b);
    await expect.soft(H.msgText(page, b), '宛先の子の名前は注意を出さずに送られる').toBeVisible(SOFT);
    await expect.soft(dialog, '宛先の子の名前では注意が出ない').toHaveCount(0);

    await H.openChannel(page, 'さくら組');
    await H.sendUi(page, `受入テスト 03-027c ${TARO}さん`);
    await expect.soft(dialog, 'クラスグループでは在籍園児の全員が照合の相手').toBeVisible(SOFT);
  });
});

// =====================================================================
// 取消・削除・誤送信への対応
// =====================================================================

test.describe('取消・削除・誤送信への対応', () => {
  /* 典拠：要件定義書「メッセージの編集・送信取消」(4-4 機能一覧)、基本設計書「メッセージの送受信」(4-7)、同「メッセージ一覧」(4-12)「取り消し・削除の確認」、詳細設計書「チャット」(4-14 (5))、図/画面詳細図「共通のダイアログと部品」(1-3) (4)、同 (4-1) 項目14 */
  test('03-028 取消（職員）', async ({ page, browser, playwright }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);
    const body = '受入テスト 03-028';
    await H.sendUi(page, body);
    await expect(H.msgText(g, body)).toBeVisible(LIVE);
    const id = H.messageIdOf(body);
    // 前提：保護者が開いた記録を入れる（届いたあとにチャットを開き直す。既読は開いた時点で付く。基本設計書「既読確認」(4-7) 処理1）
    await guardianOpenTaro(g);
    await H.waitGuardianRead(id);

    await H.openOps(page, body);
    await H.opButton(page, '取消').click();
    const confirm = page.getByRole('dialog').last();
    await expect(confirm, '確認のダイアログ').toBeVisible();
    await expect.soft(confirm, '対象の要約').toContainText(body, SOFT);
    await expect.soft(confirm, 'いま読んでいる家庭の数').toContainText(READING_ONE, SOFT);
    await evidence(page, '03-028');
    await confirm.getByRole('button', { name: 'やめる' }).click();
    await expect(H.msgText(page, body), 'やめると何も変わらない').toBeVisible();

    await H.openOps(page, body);
    await H.opButton(page, '取消').click();
    await page.getByRole('dialog').last().getByRole('button', { name: /^(取り消す|取消)$/ }).click();
    await expect(H.msgText(page, body), '職員の画面で本文が消える').toHaveCount(0);
    await expect.soft(H.msgText(g, body), '保護者の画面で再読み込みなしで本文が消える').toHaveCount(0, LIVE);

    const staff = await H.apiAs(playwright, 'staffSakura');
    const personal = Number(H.sqlAll(`SELECT chat_room_id FROM m_chat_room WHERE room_type = '4' AND child_id = ?`, H.childIdOf(TARO))[0]?.chat_room_id);
    const r = await H.api(g, 'GET', `/api/chat/rooms/${personal}/messages`);
    expect.soft(r.text, '保護者の応答に本文を返さない').not.toContain(body);
    const again = await status(staff.post(`/api/chat/messages/${id}/retract`, { data: {} }));
    expect.soft(again.status, 'もう一度は取り消せない（409）').toBe(409);
    expect.soft(again.text, '文言').toContain('このメッセージはすでに取り消されています');
  });

  /* 典拠：基本設計書「誤送信への対応」(4-7)（保護者が自分で取り消したものは載せない）、要件定義書「誤送信が発生した場合の扱い」(4-4)、図/画面詳細図 (4-2) 項目14、同 (4-4) 項目9 */
  test('03-029 取消（保護者）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);
    const body = '受入テスト 03-029';
    await H.sendUi(g, body);
    await expect(H.msgText(page, body)).toBeVisible(LIVE);
    await H.openOps(g, body);
    await H.opButton(g, '取消').click();
    await confirmIfAsked(g, /^(取り消す|取消|はい)$/);
    await expect(H.msgText(g, body)).toHaveCount(0);
    await expect.soft(H.msgText(page, body), '職員の画面で再読み込みなしで痕跡だけになる').toHaveCount(0, LIVE);
    await evidence(page, '03-029');

    const a = await H.openAs(browser, testInfo, 'admin');
    await H.staffMisdelivery(a);
    await expect.soft(H.pendingRows(a).filter({ hasText: '西田 拓也' }), '保護者の取消は「対応の記録がない取り消し」に出ない').toHaveCount(0);
  });

  /* 典拠：要件定義書「メッセージの削除」(4-4 機能一覧)、同「誤送信が発生した場合の扱い」(4-4)、基本設計書「誤送信への対応」(4-7) 処理1〜4、同「権限と利用可能機能」(6-1)、図/画面詳細図 (4-1) 項目15・26、同 (4-4) 項目9 */
  test('03-030 削除（管理者が他者のメッセージを消す）', async ({ page, browser, playwright }, testInfo) => {
    const { staff, personal } = await roomsOf(playwright);
    const gApi = await H.apiAs(playwright, 'guardian');
    const body = '受入テスト 03-030';
    const m = await H.post(staff, personal, body);
    await H.post(gApi, personal, '受入テスト 03-030 家庭から');
    await H.markRead(gApi, personal);
    await H.waitGuardianRead(m.chat_message_id);

    await login(page, 'admin');
    await staffOpenTaro(page);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);
    await expect(H.msgText(g, body)).toBeVisible();
    await H.openOps(page, body);
    await H.opButton(page, '削除').click();
    const confirm = page.getByRole('dialog').last();
    await expect(confirm, '確認のダイアログ').toBeVisible();
    await expect.soft(confirm, 'いま読んでいる家庭の数').toContainText(READING_ONE, SOFT);
    await evidence(page, '03-030');
    await confirm.getByRole('button', { name: /^(削除する|削除|取り消す)$/ }).click();
    await expect.soft(H.msgText(g, body), '保護者の画面から再読み込みなしで消える').toHaveCount(0, LIVE);

    const s = await H.openAs(browser, testInfo, 'staffSakura');
    await staffOpenTaro(s);
    await H.openOps(s, '受入テスト 03-030 家庭から');
    await expect.soft(H.opButton(s, '削除'), '一般には「削除」が無い').toHaveCount(0);

    await H.staffMisdelivery(page);
    const row = H.pendingRows(page).filter({ hasText: TARO }).first();
    await expect.soft(row, '「対応の記録がない取り消し」に行が出る').toBeVisible(SOFT);
    await expect.soft(row, '種類「チャット」').toContainText('チャット', SOFT);
    await expect.soft(row, '送信者（鈴木 浩之）').toContainText('鈴木 浩之', SOFT);
    await expect.soft(row, '読んでいた家庭の数 1').toContainText('1', SOFT);
  });

  /* 典拠：要件定義書「誤送信への対応の記録」(4-4 機能一覧)、同「誤送信が発生した場合の扱い」(4-4)、基本設計書「誤送信への対応」(4-7) 処理5、図/画面詳細図「誤送信対応記録画面（管理者）」(4-4) 項目1〜11、同「職員（タブレット／PC）」(1-1) 項目5、図/画面遷移図「チャットツール」(5) */
  test('03-031 誤送信への対応の記録（チャット）', async ({ page, browser, playwright }, testInfo) => {
    const { staff, personal } = await roomsOf(playwright);
    const gApi = await H.apiAs(playwright, 'guardian');
    const body = '受入テスト 03-031 誤送信';
    const m = await H.post(staff, personal, body);
    await H.markRead(gApi, personal);
    await H.waitGuardianRead(m.chat_message_id);
    await H.retract(staff, m.chat_message_id);
    const sentAt = String(H.sqlAll('SELECT sent_at FROM t_chat_message WHERE chat_message_id = ?', m.chat_message_id)[0]?.sent_at ?? '');

    const s = await H.openAs(browser, testInfo, 'staffSakura');
    await expect.soft(s.getByRole('navigation').getByRole('link', { name: /誤送信対応/ }), '一般には「誤送信対応」が無い').toHaveCount(0);

    await login(page, 'admin');
    await H.staffMisdelivery(page);
    const row = H.pendingRows(page).first();
    await expect(row, '「対応の記録がない取り消し」の行').toBeVisible();
    await row.getByRole('button', { name: /対応を記録/ }).click();
    const d = page.getByRole('dialog').last();
    await expect(d).toBeVisible();
    await expect.soft(d, '本文は出さない').not.toContainText(body);
    await expect.soft(d, '対象のチャンネル').toContainText(TARO, SOFT);
    const occurred = d.getByLabel(/発生日時/).first();
    const minute = sentAt.replace(' ', 'T').slice(0, 16);
    await expect.soft(occurred, `発生日時の初期値は送信日時（${minute}）`).toHaveValue(new RegExp(`^${H.esc(minute)}`), SOFT);
    await expect.soft(d, '取り消した時点で読んでいた家庭「1 家庭（1 名）」').toContainText(/1\s*家庭（\s*1\s*名）/, SOFT);
    await expect.soft(d, '情報が含まれていた園児の家庭への連絡を記録する注意').toContainText('情報が含まれていた園児の家庭', SOFT);
    await expect.soft(d, '漏えいの判断と報告の要否をシステムは行わない旨').toContainText(/漏えい/, SOFT);
    await evidence(page, '03-031');
    const resp = '受入テスト 03-031 家庭へ電話で説明した';
    await H.answerReadRadioIfAsked(d, true);
    await d.getByRole('textbox', { name: /とった対応/ }).fill(resp);
    await d.getByRole('button', { name: /^記録する$/ }).click();
    await expect(d).toBeHidden();
    const recorded = page.getByRole('main').getByRole('row').filter({ hasText: resp });
    await expect.soft(recorded, '「記録済み」に出る').toBeVisible(SOFT);
    await expect.soft(recorded, '記録者（西田 拓也）').toContainText('西田 拓也', SOFT);
    await expect.soft(H.pendingRows(page), '「対応の記録がない取り消し」から消える').toHaveCount(0, SOFT);
  });

  /* 典拠：要件定義書「誤送信が発生した場合の扱い」(4-4)（連絡帳も対象）、基本設計書「誤送信への対応」(4-7)、同「チャット」(5-6)（t_misdelivery_record）、図/画面詳細図 (4-4) 項目1・5・9 */
  test('03-032 誤送信への対応の記録（連絡帳の取り消し）', async ({ page, browser, playwright }, testInfo) => {
    const staff = await H.apiAs(playwright, 'staffSakura');
    const taroId = H.childIdOf(TARO);
    const ev = await staff.post('/api/contact/events', { data: { items: [{ child_id: taroId, event_type: '2', toilet_label: 'おしっこ' }] } });
    expect(ev.ok(), `前提：排せつを記録する（${ev.status()} ${await ev.text()}）`).toBe(true);
    const readsBefore = H.sqlCount('SELECT COUNT(*) AS n FROM t_contact_read');
    const g = await H.openAs(browser, testInfo, 'guardian');
    await g.goto(`/guardian/contact/${taroId}`);
    await expect(g.getByRole('main')).toContainText('おしっこ');
    await expect.poll(() => H.sqlCount('SELECT COUNT(*) AS n FROM t_contact_read'), { timeout: H.LIVE_TIMEOUT, message: '保護者が開いた記録が入る' }).toBeGreaterThan(readsBefore);

    await login(page, 'staffSakura');
    await page.goto(`/staff/contact/${taroId}`);
    const today = page.getByRole('region', { name: /^(きょう|この日)のようす（朝から）$/ });
    await today.getByRole('listitem').filter({ hasText: 'おしっこ' }).getByRole('button', { name: /を直す・取り消す$/ }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: /取り消す/ }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: '読んでいます' }).last();
    await expect(confirm, '取り消しの確認').toBeVisible();
    await expect.soft(confirm, 'いま読んでいる家庭の数').toContainText(READING_ONE, SOFT);
    await confirm.getByRole('button', { name: '取り消す', exact: true }).click();
    await expect(confirm).toBeHidden();

    const a = await H.openAs(browser, testInfo, 'admin');
    await H.staffMisdelivery(a);
    const row = H.pendingRows(a).filter({ hasText: '連絡帳' }).first();
    await expect(row, '「対応の記録がない取り消し」に連絡帳の行').toBeVisible();
    await expect.soft(row, '園児').toContainText(TARO, SOFT);
    await expect.soft(row, '読んでいた家庭の数 1').toContainText('1', SOFT);
    await evidence(a, '03-032');
    await row.getByRole('button', { name: /対応を記録/ }).click();
    const d = a.getByRole('dialog').last();
    await H.answerReadRadioIfAsked(d, true);
    const resp = '受入テスト 03-032';
    await d.getByRole('textbox', { name: /とった対応/ }).fill(resp);
    await d.getByRole('button', { name: /^記録する$/ }).click();
    await expect.soft(a.getByRole('main').getByRole('row').filter({ hasText: resp }), '「記録済み」へ移る').toBeVisible(SOFT);
  });
});

// =====================================================================
// 個人チャットの運用・メンバー
// =====================================================================

test.describe('個人チャットの運用・メンバー', () => {
  /* 典拠：要件定義書「個人チャットの運用」(4-4)、基本設計書「個人チャットの運用（未対応の管理）」(4-7)、図/画面詳細図 (4-1) 項目17・18・23・24、同「職員ダッシュボード」(2-6) 項目3、図/画面遷移図「チャットツール」(5) */
  test('03-033 未対応／対応済み', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const done = page.getByRole('main').getByRole('button', { name: '対応済みにする' });
    if (await done.isVisible().catch(() => false)) await done.click();
    await H.openChannel(page, '職員');
    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);

    await H.sendUi(g, '受入テスト 03-033a');
    const personalButtons = page.getByRole('main').getByRole('button', { name: /の園とのやりとり/ });
    await expect.soft(H.channelButton(page, `${TARO}の園とのやりとり`).first(), '一覧で「未対応」').toHaveAccessibleName(/未対応/, LIVE);
    await expect.soft(personalButtons.first(), '未対応の個人チャットが上に並ぶ').toHaveAccessibleName(new RegExp(`^${TARO}`), SOFT);

    await page.getByRole('navigation').getByRole('link', { name: 'ダッシュボード' }).click();
    const dashRow = page.getByRole('main').getByRole('row', { name: /^未対応の個人チャット/ });
    await expect.soft(dashRow, 'ダッシュボードの「未対応の個人チャット」に件数').toContainText(/[1-9]/, SOFT);
    const toChat = dashRow.getByRole('button', { name: 'チャットへ' }).or(dashRow.getByRole('link', { name: 'チャットへ' }));
    await expect.soft(toChat, '「チャットへ」').toHaveCount(1, SOFT);
    if ((await toChat.count()) > 0) await toChat.first().click();
    else await dashRow.getByRole('link').first().click();
    await expect(page.getByRole('main').getByRole('heading', { name: 'チャット', level: 1 })).toBeVisible();
    await expect.soft(personalButtons.first(), 'チャット画面で未対応のものが上に並ぶ').toHaveAccessibleName(new RegExp(`^${TARO}`), SOFT);

    await H.openChannel(page, `${TARO}の園とのやりとり`);
    await page.getByRole('main').getByRole('button', { name: '対応済みにする' }).click();
    const head = page.getByRole('main').getByRole('heading', { level: 2 }).filter({ hasText: TARO }).first();
    await expect.soft(head, '見出しが「対応済み」').toContainText('対応済み', SOFT);
    await expect.soft(page.getByRole('main'), '最後に切り替えた職員（鈴木 浩之）と日時').toContainText(/鈴木 浩之[^\n]*\d{1,2}:\d{2}|\d{1,2}:\d{2}[^\n]*鈴木 浩之/, SOFT);
    await evidence(page, '03-033');

    await H.sendUi(g, '受入テスト 03-033b');
    await expect.soft(page.getByRole('main').getByRole('button', { name: '対応済みにする' }), '保護者から届くと再読み込みなしで「未対応」に戻る').toBeVisible(LIVE);

    // ⑥ 個人チャットの絞り込み（プルダウン＋テキスト入力。表示名は設計に無いので、クラス・園児名・絞り込みの語で探す）
    const filter = page.getByRole('main').getByRole('combobox', { name: /クラス|絞り込/ }).first();
    if ((await filter.count()) > 0) await filter.selectOption({ label: 'さくら組' }).catch(() => {});
    const nameBox = page.getByRole('main').getByRole('textbox', { name: /園児|名前|よみ|絞り込/ }).first();
    await expect.soft(nameBox, '個人チャットの絞り込み（園児名）').toBeVisible(SOFT);
    if ((await nameBox.count()) > 0) {
      await nameBox.fill('にしだ').catch(() => {});
      await expect.soft(personalButtons, '西田 太郎だけに絞られる').toHaveCount(1, SOFT);
    }
    const gm = g.getByRole('main');
    await expect.soft(gm, '保護者の画面に未対応は出ない').not.toContainText('未対応');
    await expect.soft(gm, '保護者の画面に対応済みは出ない').not.toContainText('対応済み');
  });

  /* 典拠：要件定義書「メンバー一覧の表示」(4-4 機能一覧)、同「セキュリティ要求」(8 No.6)、基本設計書「メッセージの送受信」(4-7)、同「チャット」(5-6)（続柄は職員の一覧にだけ）、図/画面詳細図 (4-1) 項目5、同 (4-2) 注記、図/インタフェース一覧「チャットツール」(1)（members） */
  test('03-034 メンバー一覧', async ({ page, browser, playwright }, testInfo) => {
    await login(page, 'staffSakura');
    await H.staffChat(page);
    await H.openChannel(page, 'さくら組');
    const rel = H.relationshipOf(ACCOUNTS.guardian.email, H.childIdOf(TARO));
    const main = page.getByRole('main');
    await expect.soft(main.getByRole('heading', { name: 'メンバー' }), 'メンバー一覧').toBeVisible(SOFT);
    await expect.soft(main, '職員と保護者を分けて並べる（職員）').toContainText(/職員\s*\d+\s*名/, SOFT);
    await expect.soft(main, '職員と保護者を分けて並べる（保護者）').toContainText(/保護者\s*\d+\s*名/, SOFT);
    await expect.soft(main, `保護者に続柄（${ACCOUNTS.guardian.name}（${rel}））`).toContainText(`${ACCOUNTS.guardian.name}（${rel}）`, SOFT);
    await evidence(page, '03-034');

    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianChat(g);
    await H.openChannel(g, 'さくら組');
    await expect.soft(g.getByRole('main').getByRole('heading', { name: 'メンバー' }), '保護者の画面にメンバー一覧は出ない').toHaveCount(0);
    await expect.soft(g.getByRole('main'), '保護者の画面に続柄は出ない').not.toContainText(`（${rel}）`);
    const { sakura } = await roomsOf(playwright);
    const r = await H.api(g, 'GET', `/api/chat/rooms/${sakura}/members`);
    expect.soft(r.status, '保護者がメンバーを読む API は拒む').toBeGreaterThanOrEqual(400);
    expect.soft(r.text, '氏名を返さない').not.toContain('遠藤');
  });
});

// =====================================================================
// グループ編成
// =====================================================================

test.describe('グループ編成', () => {
  /* 典拠：要件定義書「グループの作成・メンバー編成」(4-4 機能一覧)、同「グループの種別」(4-4 (a))、基本設計書「チャット」(5-6)（保護者は目的別グループへ入れない）、図/画面詳細図「グループ編成画面」(4-3) 項目1・2・5〜8、同 (4-1) 項目2・19、図/画面遷移図「チャットツール」(5) */
  test('03-035 目的別グループを作る', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await H.staffGroups(page);
    const main = page.getByRole('main');
    for (const c of ['さくら組', 'ひまわり組']) await expect.soft(main.getByRole('row').filter({ hasText: new RegExp(`^${c}`) }), `一覧にクラスグループ（${c}）は出ない`).toHaveCount(0);
    const name = '受入テスト 03-035';
    const d = await H.fillGroup(page, name, ['久保田 和也', '鈴木 浩之']);
    const staffCount = H.sqlCount(`SELECT COUNT(*) AS n FROM m_account WHERE role IN ('1','2') AND status = '1'`);
    await expect.soft(d.getByRole('checkbox'), `候補は職員だけ（有効な職員 ${staffCount} 名）`).toHaveCount(staffCount);
    await H.groupSubmit(d).click();
    await expect(d).toBeHidden();
    const row = main.getByRole('row').filter({ hasText: name });
    await expect(row, '一覧にグループ名').toBeVisible();
    await expect.soft(row, 'メンバー').toContainText('久保田 和也', SOFT);
    await evidence(page, '03-035');

    const k = await H.openAs(browser, testInfo, 'staffHimawari');
    await H.staffChat(k);
    await expect(H.channelButton(k, name).first(), '久保田の一覧にグループが出る').toBeVisible();
    await H.openChannel(k, name);
    await expect.soft(k.getByRole('main').getByText('このチャンネルは職員だけが読みます。'), '職員だけのチャンネルの案内').toBeVisible(SOFT);
    await H.staffChat(page);
    await H.openChannel(page, name);
    const body = '受入テスト 03-035 連絡';
    await H.sendUi(page, body);
    await expect.soft(H.msgText(k, body), '久保田の画面に再読み込みなしで出る').toBeVisible(LIVE);

    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianChat(g);
    await expect.soft(H.channelButton(g, name), '保護者の一覧には出ない').toHaveCount(0);
  });

  /* 典拠：要件定義書「過去ログの参照範囲」(4-4 (c))、基本設計書「チャット」(5-6) の「グループの過去ログ」、同「メッセージの送受信」(4-7)、図/画面詳細図「グループ編成画面」(4-3) 項目8 */
  test('03-036 目的別グループのメンバーを外す', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    const name = '受入テスト 03-036';
    await H.createGroup(page, name, ['久保田 和也', '鈴木 浩之']);
    // 加わった時刻・外した時刻と投稿の時刻が同じ秒に重なると、所属していた間かどうかの境が回によって分かれうる（推測。T8 の回で結果が分かれた）。
    // ケースが見たいのは境の秒ではなく「所属していた間の投稿」なので、操作の間を1秒あける（期待は変えない）
    await page.waitForTimeout(1_100);
    await H.staffChat(page);
    await H.openChannel(page, name);
    const m1 = '受入テスト 03-036 外す前';
    await H.sendUi(page, m1);
    await expect(H.msgText(page, m1)).toBeVisible();
    await page.waitForTimeout(1_100);

    await H.staffGroups(page);
    await page.getByRole('main').getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'メンバーを編成' }).click();
    const area = page.getByRole('dialog').last();
    await area.getByRole('checkbox', { name: /^久保田 和也/ }).uncheck();
    await area.getByRole('button', { name: /^(保存する|保存)$/ }).click();
    await expect(area).toBeHidden();
    await page.waitForTimeout(1_100);
    await H.staffChat(page);
    await H.openChannel(page, name);
    const m2 = '受入テスト 03-036 外したあと';
    await H.sendUi(page, m2);
    await expect(H.msgText(page, m2)).toBeVisible();

    const k = await H.openAs(browser, testInfo, 'staffHimawari');
    await H.staffChat(k);
    const btn = H.channelButton(k, name);
    await expect.soft(btn.first(), '外された職員も、所属していた間の過去ログを開ける').toBeVisible(SOFT);
    if ((await btn.count()) > 0) {
      await btn.first().click();
      await expect.soft(H.msgText(k, m1), '外す前の投稿は読める').toBeVisible(SOFT);
      await expect.soft(H.msgText(k, m2), '外したあとの投稿は出ない').toHaveCount(0);
    }
    await evidence(k, '03-036');
    const room = Number(H.sqlAll('SELECT chat_room_id FROM m_chat_room WHERE room_name = ?', name)[0]?.chat_room_id);
    const r = await H.api(k, 'POST', `/api/chat/rooms/${room}/messages`, { body: '受入テスト 03-036 外された人' });
    expect.soft(r.status, '外された職員は送れない').toBeGreaterThanOrEqual(400);
    expect.soft(H.messageCount('受入テスト 03-036 外された人'), '保存しない').toBe(0);
  });

  /* 典拠：図/画面詳細図「グループ編成画面」(4-3) 項目3・4、基本設計書「チャット」(5-6)（目的別グループは用途ごとに作り、終われば閉じる）、要件定義書「チャットツール」(4-4) の職員チャットの注記 */
  test('03-037 目的別グループを終了する', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    const name = '受入テスト 03-037';
    await H.createGroup(page, name, ['久保田 和也', '鈴木 浩之']);
    await H.staffChat(page);
    await H.openChannel(page, name);
    const m = '受入テスト 03-037 連絡';
    await H.sendUi(page, m);
    await expect(H.msgText(page, m)).toBeVisible();

    await H.staffGroups(page);
    const row = page.getByRole('main').getByRole('row').filter({ hasText: name });
    await row.getByRole('button', { name: '終了' }).click();
    await confirmIfAsked(page, /^(終了する|終了|はい)$/);
    await expect.soft(row.getByRole('button', { name: 'メンバーを編成' }), '終了したグループに「メンバーを編成」は出ない').toHaveCount(0);
    for (const p of [page, await H.openAs(browser, testInfo, 'staffHimawari')]) {
      await H.staffChat(p);
      await H.openChannel(p, name);
      await expect.soft(H.msgText(p, m), '過去ログは読める').toBeVisible(SOFT);
      await expect.soft(H.composer(p), '投稿欄は出ない').toHaveCount(0);
    }
    await evidence(page, '03-037');
    const room = Number(H.sqlAll('SELECT chat_room_id FROM m_chat_room WHERE room_name = ?', name)[0]?.chat_room_id);
    const r = await H.api(page, 'POST', `/api/chat/rooms/${room}/messages`, { body: '受入テスト 03-037 終了のあと' });
    expect.soft(r.status, '終了したグループへは送れない').toBeGreaterThanOrEqual(400);
    expect.soft(H.messageCount('受入テスト 03-037 終了のあと'), '保存しない').toBe(0);
  });
});

// =====================================================================
// 配布物
// =====================================================================

test.describe('配布物', () => {
  const pdf = (name: string, size?: number) => ({ name, mimeType: 'application/pdf', buffer: H.makePdf(size) });

  /* 典拠：要件定義書「配布物の掲載と閲覧」(4-4)、基本設計書「配布物の掲載と閲覧」(4-7) 処理1〜6、同「既読確認」(4-7)（配布物の知らせを含む）、図/画面詳細図「配布物管理画面」(4-5) 項目1〜13・注記、同「配布物一覧画面（保護者・スマートフォン）」(4-6)、同 (4-1) 項目16・20、同 (4-2) 項目19、図/画面遷移図「チャットツール」(5) */
  test('03-038 配布物の掲載（園全体）', async ({ page, browser }, testInfo) => {
    await login(page, 'admin');
    await H.staffHandouts(page);
    await page.getByRole('main').getByRole('button', { name: '配布物を掲載する' }).click();
    const d = page.getByRole('dialog').last();
    await expect(d, '掲載の入力はダイアログで開く').toBeVisible();
    const month = jstToday().slice(0, 7);
    expect.soft(await d.getByRole('combobox', { name: /^種類/ }).evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? ''), '種類の初期値「園だより」').toBe('園だより');
    await expect.soft(d.getByRole('textbox', { name: /^対象の月/ }), `対象の月の初期値「当月」（${month}）`).toHaveValue(month, SOFT);
    expect.soft(await d.getByRole('combobox', { name: /^対象(\s|$)/ }).evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? ''), '対象の初期値「園全体」').toBe('園全体');
    await expect.soft(d, '届く範囲の案内（園チャットへ知らせが流れる）').toContainText('園チャット', SOFT);
    await d.getByRole('button', { name: 'やめる' }).click();

    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianChat(g);
    await H.openChannel(g, '園からのお知らせ');
    const title = '受入テスト 03-038';
    const d2 = await H.fillHandout(page, { title, file: pdf('ukeire03-038.pdf') });
    await d2.getByRole('button', { name: '掲載する', exact: true }).click();
    await expect(d2).toBeHidden();
    await expect.soft(page.getByRole('dialog'), '別の確認ダイアログを挟まない').toHaveCount(0);
    const row = page.getByRole('main').getByRole('row').filter({ hasText: title });
    await expect(row, '一覧に出る').toBeVisible();
    for (const t of [H.monthLabel(month), '園だより', '園全体', 'PDF', '西田 拓也']) await expect.soft(row, `一覧の行に「${t}」`).toContainText(t, SOFT);
    await evidence(page, '03-038');

    const card = g.getByRole('main').getByText(new RegExp(H.esc(title))).first();
    await expect(card, '保護者の画面に再読み込みなしで掲載の知らせ').toBeVisible(LIVE);
    await expect.soft(card.locator('xpath=ancestor::*[contains(normalize-space(.),"園だより")][1]'), '知らせに種類').toHaveCount(1, SOFT);
    await card.click();
    await expect.soft(g.getByRole('main').getByRole('heading', { name: H.monthLabel(month) }), '配布物一覧画面（保護者）の月の見出し').toBeVisible(SOFT);
    const item = g.getByRole('main').getByRole('button', { name: new RegExp(H.esc(title)) }).or(g.getByRole('main').getByRole('link', { name: new RegExp(H.esc(title)) })).first();
    await expect(item, '配布物が出る').toBeVisible();
    const opened = await H.openedHandout(g, () => item.click());
    expect.soft(opened.ok, `行を押すと配布物が出る（${opened.url ?? 'なし'}）`).toBe(true);

    await H.staffChat(page);
    await H.openChannel(page, '園全体');
    const notice = page.getByRole('main').getByText(new RegExp(H.esc(title))).last().locator('xpath=ancestor::*[contains(normalize-space(.),"既読")][1]');
    await expect.soft(page.getByRole('main').getByRole('link', { name: '園からの配布物を開く' }).or(page.getByRole('main').getByRole('button', { name: '園からの配布物を開く' })).first(), '知らせに「園からの配布物を開く」').toBeVisible(SOFT);
    await expect.soft(notice, '知らせに「保護者の既読 n／m 名」').toContainText(/保護者の既読\s*\d+\s*／\s*\d+\s*名/, SOFT);
  });

  /* 典拠：要件定義書「配布物の掲載と閲覧」(4-4)、同「配布物の閲覧」(4-4 機能一覧)、基本設計書「配布物の掲載と閲覧」(4-7) 処理2・5、図/画面詳細図「配布物管理画面」(4-5) 項目4・12、同 (4-6) 項目4 */
  test('03-039 配布物の掲載（自クラス向け）', async ({ page, browser }, testInfo) => {
    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianChat(g);
    await H.openChannel(g, 'さくら組');
    await login(page, 'admin');
    await H.staffHandouts(page);
    const title = '受入テスト 03-039';
    const picture = await H.makePicture(page, 'png');
    const d = await H.fillHandout(page, { type: 'クラスだより', title, target: 'さくら組', file: { name: 'ukeire03-039.png', mimeType: 'image/png', buffer: picture } });
    await expect.soft(d, '届く範囲の案内がさくら組向け').toContainText('さくら組', SOFT);
    await d.getByRole('button', { name: '掲載する', exact: true }).click();
    await expect(d).toBeHidden();
    await expect.soft(g.getByRole('main').getByText(new RegExp(H.esc(title))).first(), 'さくら組のクラスグループに再読み込みなしで知らせ').toBeVisible(LIVE);
    await evidence(g, '03-039');
    await H.staffChat(page);
    await H.openChannel(page, '園全体');
    await expect.soft(page.getByRole('main').getByText(new RegExp(H.esc(title))), '園チャットには流れない').toHaveCount(0);

    await H.guardianHandouts(g);
    await expect.soft(g.getByRole('main').getByText(new RegExp(H.esc(title))).first(), '保護者の配布物一覧に出る').toBeVisible(SOFT);
    const s = await H.openAs(browser, testInfo, 'staffSakura');
    await H.staffHandouts(s);
    const row = s.getByRole('main').getByRole('row').filter({ hasText: title });
    await expect.soft(row, '一般の一覧に出る').toBeVisible(SOFT);
    if ((await row.count()) > 0) {
      const opened = await H.openedHandout(s, () => row.getByRole('button', { name: '開く' }).click());
      expect.soft(opened.ok, `一般も開ける（${opened.url ?? 'なし'}）`).toBe(true);
    }
  });

  /* 典拠：要件定義書「配布物の閲覧」(4-4 機能一覧)、基本設計書「配布物の掲載と閲覧」(4-7) 処理5、同「添付ファイルの実体の保存先」(5-6)、図/画面詳細図 (4-5) 項目4、同 (4-6) 項目4、図/インタフェース一覧「チャットツール」(1)（handouts） */
  test('03-040 配布物：ほかのクラス向けは見えない', async ({ page, browser }, testInfo) => {
    await login(page, 'admin');
    const title = '受入テスト 03-040';
    await H.postHandout(page, { title, target: 'ひまわり組', file: pdf('ukeire03-040.pdf') });
    const row = page.getByRole('main').getByRole('row').filter({ hasText: title });
    await expect(row).toBeVisible();
    const opened = await H.openedHandout(page, () => row.getByRole('button', { name: '開く' }).click());

    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianHandouts(g);
    await expect.soft(g.getByRole('main').getByText(new RegExp(H.esc(title))), '保護者の配布物一覧に出ない').toHaveCount(0);
    await evidence(g, '03-040');
    for (const ch of ['園からのお知らせ', 'さくら組']) {
      await H.guardianChat(g);
      await H.openChannel(g, ch);
      await expect.soft(g.getByRole('main').getByText(new RegExp(H.esc(title))), `「${ch}」に掲載の知らせは出ない`).toHaveCount(0);
    }
    const r = await H.api(g, 'GET', '/api/handouts');
    expect.soft(r.text, 'API の応答に含まれない').not.toContain(title);
    if (opened.url && opened.url.startsWith('http')) {
      const res = await g.request.get(opened.url);
      expect.soft(res.ok() && (res.headers()['content-type'] ?? '').includes('pdf'), `ファイルを返さない（${res.status()}）`).toBe(false);
    } else {
      testInfo.annotations.push({ type: 'note', description: '管理者の画面で開いたファイルの URL が取れず、保護者が直に開く確かめはしていない' });
    }
    const s = await H.openAs(browser, testInfo, 'staffSakura');
    await H.staffHandouts(s);
    await expect.soft(s.getByRole('main').getByRole('row').filter({ hasText: title }), 'さくら組の担任の一覧には出ない').toHaveCount(0);
    const k = await H.openAs(browser, testInfo, 'staffHimawari');
    await H.staffHandouts(k);
    await expect.soft(k.getByRole('main').getByRole('row').filter({ hasText: title }), 'ひまわり組の担任の一覧には出る').toBeVisible(SOFT);
  });

  /* 典拠：要件定義書「配布物の掲載・取り下げ」(4-4 機能一覧)、基本設計書「配布物の掲載と閲覧」(4-7)、同「権限と利用可能機能」(6-1)、図/画面詳細図 (4-5) 項目2・6、図/インタフェース一覧「チャットツール」(1) */
  test('03-041 配布物：一般は掲載・取り下げできない', async ({ page }) => {
    const target = H.sqlAll('SELECT handout_id FROM t_handout WHERE class_id IS NULL AND is_deleted = 0 ORDER BY handout_id LIMIT 1')[0];
    expect(target, '前提：園全体向けの配布物がある').toBeTruthy();
    const id = Number(target?.handout_id);
    await login(page, 'staffSakura');
    await H.staffHandouts(page);
    const main = page.getByRole('main');
    await expect.soft(main.getByRole('button', { name: '配布物を掲載する' }), '「配布物を掲載する」が無い').toHaveCount(0);
    await expect.soft(main.getByRole('button', { name: '取り下げ' }), '「取り下げ」が無い').toHaveCount(0);
    await expect.soft(main.getByRole('button', { name: '開く' }).first(), '一覧と「開く」はある').toBeVisible(SOFT);
    await evidence(page, '03-041');
    const r1 = await page.evaluate(async () => {
      const form = new FormData();
      form.append('handout_type', '1');
      form.append('title', '受入テスト 03-041');
      form.append('target_month', '2026-10');
      form.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'ukeire03-041.pdf');
      const res = await fetch('/api/handouts', { method: 'POST', body: form, credentials: 'same-origin' });
      return res.status;
    });
    expect.soft(r1, '一般が掲載する API は 403').toBe(403);
    expect.soft(H.handoutCount('受入テスト 03-041'), '掲載されない').toBe(0);
    const r2 = await H.api(page, 'POST', `/api/handouts/${id}/withdraw`, {});
    expect.soft(r2.status, '一般が取り下げる API は 403').toBe(403);
    expect.soft(H.sqlCount('SELECT COUNT(*) AS n FROM t_handout WHERE handout_id = ? AND is_deleted = 0', id), '取り下げられない').toBe(1);
  });

  /* 典拠：要件定義書「配布物の掲載と閲覧」(4-4)、同「誤送信が発生した場合の扱い」(4-4)、基本設計書「配布物の掲載と閲覧」(4-7)、同「誤送信への対応」(4-7)、図/画面詳細図 (4-5) 項目6、同 (4-4) 注記 */
  test('03-042 配布物の取り下げ', async ({ page, browser }, testInfo) => {
    await login(page, 'admin');
    const title = '受入テスト 03-042';
    await H.postHandout(page, { title, file: pdf('ukeire03-042.pdf') });
    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianHandouts(g);
    await expect(g.getByRole('main').getByText(new RegExp(H.esc(title))).first()).toBeVisible();

    const row = page.getByRole('main').getByRole('row').filter({ hasText: title });
    await row.getByRole('button', { name: '取り下げ' }).click();
    const confirm = page.getByRole('dialog').last();
    await expect(confirm, '確かめてから取り下げる').toBeVisible();
    await confirm.getByRole('button', { name: /取り下げ/ }).last().click();
    await expect(row, '配布物管理画面の一覧から消える').toHaveCount(0);
    await expect.soft(g.getByRole('main').getByText(new RegExp(H.esc(title))), '保護者の一覧から再読み込みなしで消える').toHaveCount(0, LIVE);
    await evidence(page, '03-042');

    await H.guardianChat(g);
    await H.openChannel(g, '園からのお知らせ');
    await expect.soft(g.getByRole('main').getByText(new RegExp(H.esc(title))), '掲載の知らせが取り消されている').toHaveCount(0);
    await H.staffMisdelivery(page);
    await expect.soft(H.pendingRows(page), '取り下げで取り消された知らせは「対応の記録がない取り消し」に出ない').toHaveCount(0);
  });

  /* 典拠：要件定義書「配布物の掲載と閲覧」(4-4)、基本設計書「配布物の掲載と閲覧」(4-7)、図/画面詳細図「配布物一覧画面（保護者・スマートフォン）」(4-6) 項目2〜5・注記、同「配布物管理画面」(4-5) 項目3・4 */
  test('03-043 配布物の一覧の並びと絞り込み', async ({ page, browser }, testInfo) => {
    // 前提：配布物を0件にする（デモデータに配布物がある。テスト仕様書「テストデータの準備」(2.1) の「削除フラグで件数を調整」）
    H.sqlRun('UPDATE t_handout SET is_deleted = 1');
    const g = await H.openAs(browser, testInfo, 'guardian');
    await H.guardianHandouts(g);
    await expect.soft(g.getByRole('alert'), '配布物が無い状態を誤りの表示にしない').toHaveCount(0);
    await expect.soft(g.getByRole('main').getByRole('heading', { level: 2 }), '配布物は出ない').toHaveCount(0);

    await login(page, 'admin');
    const cur = jstToday().slice(0, 7);
    const prev = H.prevMonth(cur);
    const A = '受入テスト 03-043a';
    const B = '受入テスト 03-043b';
    const C = '受入テスト 03-043c';
    await H.postHandout(page, { type: '園だより', title: A, month: cur, file: pdf('a.pdf') });
    await H.postHandout(page, { type: '献立表', title: B, month: cur, file: pdf('b.pdf') });
    await H.postHandout(page, { type: '園だより', title: C, month: prev, file: pdf('c.pdf') });

    await g.reload();
    const gm = g.getByRole('main');
    const y = async (loc: Locator) => (await loc.first().boundingBox())?.y ?? -1;
    const hCur = gm.getByRole('heading', { name: H.monthLabel(cur) });
    const hPrev = gm.getByRole('heading', { name: H.monthLabel(prev) });
    await expect(hCur, '当月の見出し').toBeVisible();
    await expect(hPrev, '前月の見出し').toBeVisible();
    const [yc, yp, ya, yb, yC] = [await y(hCur), await y(hPrev), await y(gm.getByText(A)), await y(gm.getByText(B)), await y(gm.getByText(C))];
    expect.soft(yc < yp, '新しい月が上').toBe(true);
    expect.soft(yc < ya && ya < yp && yc < yb && yb < yp, '当月の下に a・b').toBe(true);
    expect.soft(yp < yC, '前月の下に c').toBe(true);
    await evidence(g, '03-043');
    await gm.getByRole('combobox', { name: /種類/ }).selectOption({ label: '献立表' });
    await expect.soft(gm.getByText(B), '献立表だけになる（b）').toBeVisible(SOFT);
    await expect.soft(gm.getByText(A), '献立表だけになる（a は出ない）').toHaveCount(0);
    await expect.soft(gm.getByText(C), '献立表だけになる（c は出ない）').toHaveCount(0);

    await H.staffHandouts(page);
    const pm = page.getByRole('main');
    const [ra, rb, rc] = [await y(pm.getByRole('row').filter({ hasText: A })), await y(pm.getByRole('row').filter({ hasText: B })), await y(pm.getByRole('row').filter({ hasText: C }))];
    expect.soft(ra < rc && rb < rc, '配布物管理画面は対象の月の新しい順').toBe(true);
    await pm.getByRole('combobox', { name: /種類/ }).first().selectOption({ label: '献立表' });
    await expect.soft(pm.getByRole('row').filter({ hasText: A }), '配布物管理画面も種類で絞り込める').toHaveCount(0);
    await expect.soft(pm.getByRole('row').filter({ hasText: B }), '献立表は出る').toBeVisible(SOFT);
  });
});

// =====================================================================
// 写真の添付（詳細設計書は次の版。画面に機能が無ければ未実施）
// =====================================================================

const NEXT_VERSION = '実装対象の外（詳細設計書「チャット画面（職員・保護者）」(2-9 (5))・「次の版で詳しくする画面」(2-10 (4)) で次の版。画面に機能が無い）';
const NO_FILE_PICK = '実装対象の外（詳細設計書「チャット画面（職員・保護者）」(2-9 (5))・「次の版で詳しくする画面」(2-10 (4)) で次の版。画面に機能が無い：「添付」のボタンはあるが、押してもファイルを選べない）';

test.describe('写真の添付', () => {
  /* 典拠：要件定義書「画像の添付」(4-4 機能一覧)、同「添付ファイルの制限」(4-4)、同「保護者へ届けるときの関所」(4-1-6) (2)、基本設計書「写真の同意で止める規則」(4-2)、同「メッセージ一覧」(4-12)「写真の同意で送れない（1人）」、図/画面詳細図 (4-1) 項目8、同「共通のダイアログと部品」(1-3) (2) */
  test('03-044 写真の添付（職員。写っている子を選び、同意で止める）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const attach = page.getByRole('main').getByRole('button', { name: '添付' });
    test.skip((await attach.count()) === 0, NEXT_VERSION);
    test.skip(!(await H.attachWorks(page, attach)), NO_FILE_PICK);
    testInfo.annotations.push({ type: 'note', description: '【次の版】画面に添付がある。基本設計書の期待で確かめた' });
    // 前提：管理者が園児情報入力画面で、西田 太郎の写真の利用同意を「園内記録として保持」にする
    const taroId = H.childIdOf(TARO);
    const admin = await H.openAs(browser, testInfo, 'admin');
    await H.setConsentUi(admin, taroId, /園内記録/);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);

    await staffOpenTaro(page);
    const picture = await H.makePicture(page, 'png');
    const pick = async () => {
      const chooser = page.waitForEvent('filechooser');
      await attach.click();
      await (await chooser).setFiles({ name: 'ukeire03-044.png', mimeType: 'image/png', buffer: picture });
      return page.getByRole('dialog').filter({ hasText: '写っている子' });
    };
    const picker = await pick();
    await expect(picker, '「写っている子を選ぶ」ダイアログが開く').toBeVisible();
    await expect.soft(picker, '園児名と顔写真の一覧に西田 太郎').toContainText(TARO, SOFT);
    await expect.soft(picker, '「子どもは写っていない」がある').toContainText('子どもは写っていない', SOFT);
    const send = picker.getByRole('button', { name: /^送る$/ });
    await expect.soft(send, '選ぶまで「送る」を押せない').toBeDisabled(SOFT);
    const taro = picker.getByRole('checkbox', { name: new RegExp(TARO) }).or(picker.getByRole('button', { name: new RegExp(`^${TARO}`) })).first();
    await taro.click();
    await send.click();
    await expect.soft(picker, '同意が足りず送れない理由').toContainText(`${TARO}さんは写真の同意が「園内記録として保持」のため送れません。写真を外すか、写っている子を見直してください。`, SOFT);
    expect.soft(H.sqlCount('SELECT COUNT(*) AS n FROM t_chat_attachment'), '送られない').toBe(0);
    await evidence(page, '03-044');

    // ④ 同意を「自児の保護者へ共有」に変えて送り直すと送られ、⑤ 保護者の画面に写真が出る
    await H.setConsentUi(admin, taroId, /自児/);
    await page.keyboard.press('Escape');
    await staffOpenTaro(page);
    const again = await pick();
    await again.getByRole('checkbox', { name: new RegExp(TARO) }).or(again.getByRole('button', { name: new RegExp(`^${TARO}`) })).first().click();
    await again.getByRole('button', { name: /^送る$/ }).click();
    await expect.soft(again, '送られてダイアログが閉じる').toBeHidden(SOFT);
    await expect.soft(g.getByRole('main').getByRole('img').last(), '保護者の画面に写真が出る').toBeVisible(LIVE);
  });

  /* 典拠：要件定義書「画像の添付」(4-4 機能一覧)（保護者は個人チャットのみ）、基本設計書「メッセージの送受信」(4-7) 注記、図/画面詳細図 (4-2) 項目6 */
  test('03-045 写真の添付（保護者）', async ({ page, browser }, testInfo) => {
    await page.setViewportSize(PHONE);
    await login(page, 'guardian');
    await guardianOpenTaro(page);
    const attach = page.getByRole('main').getByRole('button', { name: '添付' });
    test.skip((await attach.count()) === 0, NEXT_VERSION);
    test.skip(!(await H.attachWorks(page, attach)), NO_FILE_PICK);
    testInfo.annotations.push({ type: 'note', description: '【次の版】画面に添付がある。基本設計書の期待で確かめた' });
    const s = await H.openAs(browser, testInfo, 'staffSakura');
    await staffOpenTaro(s);
    const chooser = page.waitForEvent('filechooser');
    await attach.click();
    await (await chooser).setFiles({ name: 'ukeire03-045.jpg', mimeType: 'image/jpeg', buffer: await H.makePicture(page, 'jpeg') });
    await expect.soft(page.getByRole('dialog').filter({ hasText: '写っている子' }), '写っている子を選ぶダイアログは出ない').toHaveCount(0);
    await H.sendButton(page).click().catch(() => {});
    await expect.soft(s.getByRole('main').getByRole('img').last(), '職員の画面に再読み込みなしで写真が出る').toBeVisible(LIVE);
    await evidence(page, '03-045');
  });
});

// =====================================================================
// クロスサイトスクリプティング・二重送信（授業の雛形 1.5）
// =====================================================================

test.describe('クロスサイトスクリプティング・二重送信', () => {
  /** レイアウトが崩れていない：投稿欄と「送信」が見えていて、画面の幅に収まる */
  async function layoutKept(page: Page, label: string) {
    const box = await H.composer(page).boundingBox();
    const btn = await H.sendButton(page).boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    expect.soft(box !== null && btn !== null && box.x >= 0 && btn.x + btn.width <= width + 1, `${label}：投稿欄と「送信」が画面の幅に収まる`).toBe(true);
  }

  /* 典拠：授業の雛形 1.5、テスト仕様書「テスト対象の機能」(1.5) のセキュリティ要求に関するテスト */
  test('03-046 クロスサイトスクリプティング：チャットの本文', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);
    const dialogs = H.watchDialogs(page, g);
    const A = '<script>alert(1)</script><b>太字</b>"><img src=x onerror=alert(1)> 受入テスト 03-046';
    const B = '<i>斜体</i> 受入テスト 03-046 直した';
    const C = '<b>保護者</b> 受入テスト 03-046';
    const check = async (p: Page, text: string, label: string) => {
      await expect.soft(H.msgText(p, text), `${label}：タグが文字のまま出る`).toBeVisible(LIVE);
      const m = p.getByRole('main');
      await expect.soft(m.locator('b', { hasText: /^(太字|保護者)$/ }).or(m.locator('i', { hasText: /^斜体$/ })), `${label}：太字・斜体にならない`).toHaveCount(0);
      await expect.soft(m.locator('img[src="x"]'), `${label}：画像の要素ができない`).toHaveCount(0);
    };
    await H.sendUi(page, A);
    await check(page, A, '職員');
    await check(g, A, '保護者');
    await H.openOps(page, A);
    await H.opButton(page, '編集').click();
    await (await editorWith(page, A)).fill(B);
    await page.getByRole('main').getByRole('button', { name: /^(保存|保存する)$/ }).click();
    await check(page, B, '職員（編集のあと）');
    await check(g, B, '保護者（編集のあと）');
    await H.sendUi(g, C);
    await check(page, C, '職員（保護者の送信）');
    await page.reload();
    await staffOpenTaro(page);
    await g.reload();
    await guardianOpenTaro(g);
    for (const [p, label] of [[page, '職員'], [g, '保護者']] as const) {
      await check(p, B, `${label}（再読み込みのあと）`);
      await check(p, C, `${label}（再読み込みのあと）`);
      await layoutKept(p, label);
    }
    expect.soft(dialogs, 'ダイアログ（alert）が開かない').toEqual([]);
    expect.soft(H.sqlCount('SELECT COUNT(*) AS n FROM t_chat_message WHERE body = ?', C), 'データベースには送った文字がそのまま入る').toBe(1);
    await evidence(page, '03-046');
  });

  /* 典拠：授業の雛形 1.5、テスト仕様書「テスト対象の機能」(1.5) のセキュリティ要求に関するテスト */
  test('03-047 クロスサイトスクリプティング：グループ名・配布物の題名・誤送信のとった対応', async ({ page, browser, playwright }, testInfo) => {
    const { staff, personal } = await roomsOf(playwright);
    const m = await H.post(staff, personal, '受入テスト 03-047 取消');
    await H.retract(staff, m.chat_message_id);
    const D = '<b>受入</b>03-047';
    const E = '<script>alert(1)</script>03-047';
    const F = '<img src=x onerror=alert(1)>03-047';
    const s = await H.openAs(browser, testInfo, 'staffSakura');
    await login(page, 'admin');
    const g = await H.openAs(browser, testInfo, 'guardian');
    const dialogs = H.watchDialogs(page, s, g);
    const noTags = async (p: Page, label: string) => {
      const m = p.getByRole('main');
      await expect.soft(m.locator('b', { hasText: /^受入$/ }).or(m.locator('img[src="x"]')), `${label}：タグが要素にならない`).toHaveCount(0);
    };

    await H.createGroup(s, D, ['鈴木 浩之']);
    await expect.soft(s.getByRole('main').getByRole('row').filter({ hasText: D }), 'グループ編成画面にグループ名が文字のまま').toBeVisible(SOFT);
    await noTags(s, 'グループ編成画面');
    await H.staffChat(s);
    await expect.soft(s.getByRole('main').getByRole('button', { name: new RegExp(H.esc(D)) }), 'チャンネル一覧にグループ名が文字のまま').toBeVisible(SOFT);
    await noTags(s, 'チャンネル一覧');

    await H.postHandout(page, { title: E, file: { name: 'e.pdf', mimeType: 'application/pdf', buffer: H.makePdf() } });
    await expect.soft(page.getByRole('main').getByRole('row').filter({ hasText: E }), '配布物管理画面に題名が文字のまま').toBeVisible(SOFT);
    await H.guardianHandouts(g);
    await expect.soft(g.getByRole('main').getByText(E).first(), '配布物一覧画面（保護者）に題名が文字のまま').toBeVisible(SOFT);
    await H.guardianChat(g);
    await H.openChannel(g, '園からのお知らせ');
    await expect.soft(g.getByRole('main').getByText(new RegExp(H.esc(E))).first(), '掲載の知らせに題名が文字のまま').toBeVisible(SOFT);

    await H.staffMisdelivery(page);
    await H.pendingRows(page).first().getByRole('button', { name: /対応を記録/ }).click();
    const d = page.getByRole('dialog').last();
    await H.answerReadRadioIfAsked(d, false);
    await d.getByRole('textbox', { name: /とった対応/ }).fill(F);
    await d.getByRole('button', { name: /^記録する$/ }).click();
    await expect(d).toBeHidden();
    await expect.soft(page.getByRole('main').getByRole('row').filter({ hasText: F }), '「記録済み」にとった対応が文字のまま').toBeVisible(SOFT);
    await noTags(page, '誤送信対応記録画面');
    await evidence(page, '03-047');
    expect.soft(dialogs, 'ダイアログ（alert）が開かない').toEqual([]);
  });

  /* 典拠：授業の雛形 1.5、テスト仕様書「テスト対象の機能」(1.5) のセキュリティ要求に関するテスト */
  test('03-048 二重送信：チャットの送信（連打・完了後のリロード）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await staffOpenTaro(page);
    const a = '受入テスト 03-048a';
    await H.composer(page).fill(a);
    await H.sendButton(page).click({ clickCount: 2 });
    await expect(H.msgText(page, a).first()).toBeVisible();
    await page.waitForTimeout(1_500);
    expect.soft(H.messageCount(a), '続けて2回押しても1件').toBe(1);
    await page.reload();
    await staffOpenTaro(page);
    await page.waitForTimeout(1_000);
    expect.soft(H.messageCount(a), '再読み込みでもう一度送られない').toBe(1);
    await expect.soft(H.msgText(page, a), '画面の一覧も1件').toHaveCount(1);
    await evidence(page, '03-048');

    const g = await H.openAs(browser, testInfo, 'guardian');
    await guardianOpenTaro(g);
    const b = '受入テスト 03-048b';
    await H.composer(g).fill(b);
    await H.sendButton(g).click({ clickCount: 2 });
    await expect(H.msgText(g, b).first()).toBeVisible();
    await g.waitForTimeout(1_500);
    await g.reload();
    await guardianOpenTaro(g);
    await g.waitForTimeout(1_000);
    expect.soft(H.messageCount(b), '保護者も1件').toBe(1);
  });

  /* 典拠：授業の雛形 1.5、テスト仕様書「テスト対象の機能」(1.5) のセキュリティ要求に関するテスト */
  test('03-049 二重送信：配布物の掲載・グループの作成・誤送信の記録', async ({ page, browser, playwright }, testInfo) => {
    const { staff, personal } = await roomsOf(playwright);
    const m = await H.post(staff, personal, '受入テスト 03-049 取消');
    await H.retract(staff, m.chat_message_id);
    await login(page, 'admin');

    const a = '受入テスト 03-049a';
    await H.staffHandouts(page);
    const d = await H.fillHandout(page, { title: a, file: { name: 'a.pdf', mimeType: 'application/pdf', buffer: H.makePdf() } });
    await d.getByRole('button', { name: '掲載する', exact: true }).click({ clickCount: 2 });
    await expect(d).toBeHidden();
    await page.waitForTimeout(1_500);
    await page.reload();
    await page.waitForTimeout(1_000);
    expect.soft(H.handoutCount(a), '配布物は1件').toBe(1);
    const hid = Number(H.sqlAll('SELECT handout_id FROM t_handout WHERE title = ?', a)[0]?.handout_id ?? 0);
    expect.soft(H.sqlCount(`SELECT COUNT(*) AS n FROM t_chat_message WHERE source_type = '4' AND source_id = ?`, hid), '掲載の知らせも1件').toBe(1);
    await expect.soft(page.getByRole('main').getByRole('row').filter({ hasText: a }), '一覧に1行').toHaveCount(1);

    const s = await H.openAs(browser, testInfo, 'staffSakura');
    const b = '受入テスト 03-049b';
    await H.staffGroups(s);
    const gd = await H.fillGroup(s, b, ['久保田 和也', '鈴木 浩之']);
    await H.groupSubmit(gd).click({ clickCount: 2 });
    await expect(gd).toBeHidden();
    await s.waitForTimeout(1_500);
    await s.reload();
    expect.soft(H.sqlCount(`SELECT COUNT(*) AS n FROM m_chat_room WHERE room_type = '3' AND room_name = ?`, b), 'グループは1件').toBe(1);
    await expect.soft(s.getByRole('main').getByRole('row').filter({ hasText: b }), '一覧に1行').toHaveCount(1);

    const c = '受入テスト 03-049c';
    await H.staffMisdelivery(page);
    await H.pendingRows(page).first().getByRole('button', { name: /対応を記録/ }).click();
    const md = page.getByRole('dialog').last();
    await H.answerReadRadioIfAsked(md, false);
    await md.getByRole('textbox', { name: /とった対応/ }).fill(c);
    await md.getByRole('button', { name: /^記録する$/ }).click({ clickCount: 2 });
    await expect(md).toBeHidden();
    await page.waitForTimeout(1_500);
    await page.reload();
    expect.soft(H.sqlCount('SELECT COUNT(*) AS n FROM t_misdelivery_record WHERE response = ?', c), '誤送信の記録は1件').toBe(1);
    await expect.soft(page.getByRole('main').getByRole('row').filter({ hasText: c }), '「記録済み」に1行').toHaveCount(1);
    await evidence(page, '03-049');
  });
});

// =====================================================================
// 入力チェック
// =====================================================================

test.describe('入力チェック：チャットのメッセージ', () => {
  async function staffRoom(page: Page): Promise<number> {
    await login(page, 'staffSakura');
    await H.staffChat(page);
    await H.openChannel(page, '職員');
    await expect(H.composer(page)).toBeVisible();
    return Number(H.sqlAll(`SELECT chat_room_id FROM m_chat_room WHERE room_type = '5'`)[0]?.chat_room_id);
  }
  const countIn = (room: number) => H.sqlCount('SELECT COUNT(*) AS n FROM t_chat_message WHERE chat_room_id = ?', room);
  async function trySend(page: Page) {
    const btn = H.sendButton(page);
    if (await btn.isEnabled().catch(() => false)) await btn.click();
    await page.waitForTimeout(1_000);
  }

  /* 典拠：基本設計書「メッセージの送受信」(4-7) 処理6、同「入力項目の制約値」(4-12)、詳細設計書「チャット」(4-14 (3))（本文1〜1,000文字） */
  test('03-I001 メッセージを入力：空', async ({ page }) => {
    const room = await staffRoom(page);
    const before = countIn(room);
    await H.composer(page).fill('');
    await trySend(page);
    expect.soft(countIn(room), '送られない').toBe(before);
    await evidence(page, '03-I001');
  });

  /* 典拠：詳細設計書「検査の共通の規則」(4-1 (5))、同「チャット」(4-14 (3)) */
  test('03-I002 メッセージを入力：空白だけ', async ({ page }) => {
    const room = await staffRoom(page);
    const before = countIn(room);
    const blank = ' 　\n 　';
    await H.composer(page).fill(blank);
    await trySend(page);
    expect.soft(countIn(room), '送られない').toBe(before);
    await expect.soft(H.composer(page), '入力欄の内容は消えない').toHaveValue(blank, SOFT);
    await evidence(page, '03-I002');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)、詳細設計書「チャット」(4-14 (3)) */
  test('03-I003 メッセージを入力：1文字', async ({ page }) => {
    await staffRoom(page);
    await H.sendUi(page, '〇');
    await expect(H.msgText(page, '〇').first(), '送られ、一覧に出る').toBeVisible();
    expect.soft(H.messageCount('〇'), '保存される').toBe(1);
    await evidence(page, '03-I003');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)（チャットのメッセージ 1,000文字以内）、図/画面詳細図 (4-1) 項目7 */
  test('03-I004 メッセージを入力：1,000文字', async ({ page }) => {
    await staffRoom(page);
    const text = H.fill('受入テスト 03-I004 ', 1000);
    await H.sendUi(page, text);
    await expect(H.msgText(page, text), '本文が欠けずに出る').toBeVisible();
    expect.soft(H.sqlCount('SELECT length(body) AS n FROM t_chat_message WHERE body = ?', text), '1,000文字で保存される').toBe(1000);
    await evidence(page, '03-I004');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)（残り文字数を示す）、詳細設計書「本書で足す文言」(4-1 (6))、図/画面詳細図 (4-1) 項目7、図/インタフェース一覧「エラーの返し方」(0-2) */
  test('03-I005 メッセージを入力：1,001文字', async ({ page }) => {
    const room = await staffRoom(page);
    const text = H.fill('受入テスト 03-I005 ', 1001);
    await H.composer(page).fill(text);
    await expect.soft(page.getByRole('main').getByText(/残り/).first(), '入力欄に残りの文字数が出る').toBeVisible(SOFT);
    await trySend(page);
    expect.soft(H.messageCount(text), '1,001文字は保存されない').toBe(0);
    await evidence(page, '03-I005');
    const r = await H.api(page, 'POST', `/api/chat/rooms/${room}/messages`, { body: text });
    expect.soft(r.status, 'API に直に送っても 400').toBe(400);
    expect.soft(messageOf(r), '「〇〇は n 文字以内で入力してください。」の形').toMatch(/1,?000\s*文字以内で入力してください。$/);
    expect.soft(H.messageCount(text), '保存しない').toBe(0);
  });

  /* 典拠：詳細設計書「検査の共通の規則」(4-1 (5))（文字数は文字（符号位置）で数える） */
  test('03-I006 メッセージを入力：4バイトの字を含む1,000文字', async ({ page }) => {
    await staffRoom(page);
    const text = H.fill(`受入テスト 03-I006 ${'𠮷'.repeat(100)}`, 1000);
    expect([...text].length).toBe(1000);
    await H.composer(page).fill(text);
    const typed = await H.composer(page).inputValue();
    expect.soft([...typed].length, `入力欄に符号位置で1,000文字が入る（入ったのは ${[...typed].length} 文字。UTF-16 では ${typed.length}）`).toBe(1000);
    await H.sendButton(page).click();
    await expect(H.msgText(page, text), '送られ、本文が欠けずに出る').toBeVisible();
    expect.soft(H.messageCount(text), '保存される').toBe(1);
    await evidence(page, '03-I006');
  });

  async function editOwn(page: Page, playwright: H.RequestFactory, body: string): Promise<{ id: number; editor: Locator }> {
    const room = await staffRoom(page);
    const staff = await H.apiAs(playwright, 'staffSakura');
    const m = await H.post(staff, room, body);
    await expect(H.msgText(page, body)).toBeVisible(LIVE);
    await H.openOps(page, body);
    await H.opButton(page, '編集').click();
    return { id: m.chat_message_id, editor: await editorWith(page, body) };
  }
  const bodyOf = (id: number) => String(H.sqlAll('SELECT body FROM t_chat_message WHERE chat_message_id = ?', id)[0]?.body ?? '');

  /* 典拠：基本設計書「メッセージの編集」(4-7) 処理5、図/画面詳細図 (4-1) 項目11 */
  test('03-I007 編集の入力欄：空', async ({ page, playwright }) => {
    const body = '受入テスト 03-I007';
    const { id, editor } = await editOwn(page, playwright, body);
    await editor.fill('');
    const save = page.getByRole('main').getByRole('button', { name: /^(保存|保存する)$/ });
    if (await save.isEnabled().catch(() => false)) await save.click();
    await page.waitForTimeout(1_000);
    expect.soft(bodyOf(id), '保存されず、本文は編集前のまま').toBe(body);
    await evidence(page, '03-I007');
  });

  /* 典拠：基本設計書「メッセージの編集」(4-7) 処理5（文字数の上限は新規送信と同じ）、図/画面詳細図 (4-1) 項目11 */
  test('03-I008 編集の入力欄：1,001文字', async ({ page, playwright }) => {
    const body = '受入テスト 03-I008';
    const { id, editor } = await editOwn(page, playwright, body);
    const text = H.fill('受入テスト 03-I008 ', 1001);
    await editor.fill(text);
    const save = page.getByRole('main').getByRole('button', { name: /^(保存|保存する)$/ });
    if (await save.isEnabled().catch(() => false)) await save.click();
    await page.waitForTimeout(1_000);
    expect.soft(bodyOf(id), '保存されず、本文は編集前のまま').toBe(body);
    await evidence(page, '03-I008');
    const r = await H.api(page, 'POST', `/api/chat/messages/${id}/edit`, { body: text });
    expect.soft(r.status, 'API に直に送っても 400').toBe(400);
    expect.soft(bodyOf(id), '本文は変わらない').toBe(body);
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)、図/画面詳細図 (4-2) 項目5 */
  test('03-I009 保護者のメッセージを入力：1,001文字', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page, 'guardian');
    await guardianOpenTaro(page);
    const text = H.fill('受入テスト 03-I009 ', 1001);
    await H.composer(page).fill(text);
    await trySend(page);
    expect.soft(H.messageCount(text), '送られない').toBe(0);
    await evidence(page, '03-I009');
    const room = Number(H.sqlAll(`SELECT chat_room_id FROM m_chat_room WHERE room_type = '4' AND child_id = ?`, H.childIdOf(TARO))[0]?.chat_room_id);
    const r = await H.api(page, 'POST', `/api/chat/rooms/${room}/messages`, { body: text });
    expect.soft(r.status, 'API に直に送っても 400').toBe(400);
    expect.soft(H.messageCount(text), '保存しない').toBe(0);
  });
});

test.describe('入力チェック：グループ名', () => {
  const groups = () => H.sqlCount(`SELECT COUNT(*) AS n FROM m_chat_room WHERE room_type = '3'`);
  const named = (n: string) => H.sqlCount(`SELECT COUNT(*) AS n FROM m_chat_room WHERE room_type = '3' AND room_name = ?`, n);

  /* 典拠：基本設計書「入力項目の制約値」(4-12)（グループ名）、図/画面詳細図「グループ編成画面」(4-3) 項目5 */
  test('03-I010 グループ名：空', async ({ page }) => {
    await login(page, 'staffSakura');
    await H.staffGroups(page);
    const before = groups();
    const d = await H.fillGroup(page, '', ['久保田 和也']);
    const submit = H.groupSubmit(d);
    if (await submit.isEnabled().catch(() => false)) await submit.click();
    await page.waitForTimeout(1_000);
    expect.soft(groups(), '作られない').toBe(before);
    await evidence(page, '03-I010');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)（グループ名）、図/画面詳細図「グループ編成画面」(4-3) 項目5 */
  test('03-I011 グループ名：50文字', async ({ page }) => {
    await login(page, 'staffSakura');
    const name = H.fill('受入テスト 03-I011 ', 50);
    await H.createGroup(page, name, ['久保田 和也', '鈴木 浩之']);
    await expect.soft(page.getByRole('main').getByRole('row').filter({ hasText: name }), '一覧に名前が欠けずに出る').toBeVisible(SOFT);
    expect.soft(named(name), '50文字で作られる').toBe(1);
    await evidence(page, '03-I011');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)（グループ名）、図/画面詳細図「グループ編成画面」(4-3) 項目5、詳細設計書「本書で足す文言」(4-1 (6)) */
  test('03-I012 グループ名：51文字', async ({ page }, testInfo) => {
    await login(page, 'staffSakura');
    await H.staffGroups(page);
    const n51 = H.fill('受入テスト 03-I012 ', 51);
    const d = await H.fillGroup(page, n51, ['久保田 和也', '鈴木 浩之']);
    const box = d.getByRole('textbox', { name: /^グループ名/ });
    const typed = await box.inputValue();
    if ([...typed].length > 50) {
      await H.groupSubmit(d).click();
    } else {
      // 画面が50文字で止めるときは、送る要求の中で51文字に書き換え、サーバの検査を確かめる
      testInfo.annotations.push({ type: 'note', description: '入力欄が50文字で止まるため、送る要求の中で51文字に書き換えて確かめた' });
      const n50 = [...n51].slice(0, 50).join('');
      await box.fill(n50);
      await H.rewriteNextRequest(page, /\/api\/chat\/groups/, n50, n51);
      await H.groupSubmit(d).click();
    }
    await page.waitForTimeout(1_500);
    expect.soft(named(n51), '51文字のグループは作られない').toBe(0);
    expect.soft(named([...n51].slice(0, 50).join('')), '切り詰めた名前でも作られない').toBe(0);
    await evidence(page, '03-I012');
  });
});

test.describe('入力チェック：誤送信の記録', () => {
  async function openRecord(page: Page, playwright: H.RequestFactory) {
    const { staff, personal } = await roomsOf(playwright);
    const m = await H.post(staff, personal, '受入テスト 03-I 取消');
    await H.retract(staff, m.chat_message_id);
    await login(page, 'admin');
    await H.staffMisdelivery(page);
    await H.pendingRows(page).first().getByRole('button', { name: /対応を記録/ }).click();
    const d = page.getByRole('dialog').last();
    await expect(d).toBeVisible();
    await H.answerReadRadioIfAsked(d, false);
    return { d, messageId: m.chat_message_id };
  }
  const records = () => H.sqlCount('SELECT COUNT(*) AS n FROM t_misdelivery_record');
  async function tryRecord(d: Locator) {
    const b = d.getByRole('button', { name: /^記録する$/ });
    if (await b.isEnabled().catch(() => false)) await b.click();
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12)（誤送信のとった対応）、詳細設計書「本書で足す文言」(4-1 (6))、図/画面詳細図 (4-4) 項目6、同「全画面に共通する規定」(0-2)（ダイアログの中の誤り） */
  test('03-I013 とった対応：空', async ({ page, playwright }) => {
    const { d } = await openRecord(page, playwright);
    const before = records();
    await d.getByRole('textbox', { name: /とった対応/ }).fill('');
    await tryRecord(d);
    await page.waitForTimeout(1_000);
    expect.soft(records(), '記録されない').toBe(before);
    await expect.soft(d, 'ダイアログの中に「とった対応を入力してください。」').toContainText('とった対応を入力してください。', SOFT);
    await evidence(page, '03-I013');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)、図/画面詳細図 (4-4) 項目6 */
  test('03-I014 とった対応：1,000文字', async ({ page, playwright }) => {
    const { d } = await openRecord(page, playwright);
    const text = H.fill('受入テスト 03-I014 ', 1000);
    await d.getByRole('textbox', { name: /とった対応/ }).fill(text);
    await tryRecord(d);
    await expect(d).toBeHidden();
    expect.soft(H.sqlCount('SELECT length(response) AS n FROM t_misdelivery_record WHERE response = ?', text), '1,000文字で記録される').toBe(1000);
    await expect.soft(page.getByRole('main').getByRole('row').filter({ hasText: '受入テスト 03-I014' }), '「記録済み」に出る').toBeVisible(SOFT);
    await evidence(page, '03-I014');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)、図/画面詳細図 (4-4) 項目6 */
  test('03-I015 とった対応：1,001文字', async ({ page, playwright }, testInfo) => {
    const { d } = await openRecord(page, playwright);
    const t1001 = H.fill('受入テスト 03-I015 ', 1001);
    const box = d.getByRole('textbox', { name: /とった対応/ });
    await box.fill(t1001);
    if ([...(await box.inputValue())].length <= 1000) {
      testInfo.annotations.push({ type: 'note', description: '入力欄が1,000文字で止まるため、送る要求の中で1,001文字に書き換えて確かめた' });
      const t1000 = [...t1001].slice(0, 1000).join('');
      await box.fill(t1000);
      await H.rewriteNextRequest(page, /\/api\/chat\/misdelivery/, t1000, t1001);
    }
    await tryRecord(d);
    await page.waitForTimeout(1_500);
    expect.soft(H.sqlCount('SELECT COUNT(*) AS n FROM t_misdelivery_record WHERE response = ?', t1001), '1,001文字は記録されない').toBe(0);
    await evidence(page, '03-I015');
  });

  /* 典拠：図/画面詳細図 (4-4) 項目3、基本設計書「誤送信への対応」(4-7) 処理5 */
  test('03-I016 発生日時：空', async ({ page, playwright }) => {
    const { d } = await openRecord(page, playwright);
    const before = records();
    await d.getByLabel(/発生日時/).first().fill('');
    await d.getByRole('textbox', { name: /とった対応/ }).fill('受入テスト 03-I016');
    await tryRecord(d);
    await page.waitForTimeout(1_000);
    expect.soft(records(), '記録されない').toBe(before);
    await evidence(page, '03-I016');
  });
});

test.describe('入力チェック：配布物の掲載', () => {
  const pdfOf = (size?: number) => ({ name: 'ukeire.pdf', mimeType: 'application/pdf', buffer: H.makePdf(size) });
  const total = () => H.sqlCount('SELECT COUNT(*) AS n FROM t_handout WHERE is_deleted = 0');
  async function trySubmit(d: Locator) {
    const b = d.getByRole('button', { name: '掲載する', exact: true });
    if (await b.isEnabled().catch(() => false)) await b.click();
  }
  async function open(page: Page) {
    await login(page, 'admin');
    await H.staffHandouts(page);
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12)（配布物の題名）、同「配布物の掲載と閲覧」(4-7) 処理2、図/画面詳細図 (4-5) 項目8 */
  test('03-I017 配布物の題名：空', async ({ page }) => {
    await open(page);
    const before = total();
    const d = await H.fillHandout(page, { title: '', file: pdfOf() });
    await trySubmit(d);
    await page.waitForTimeout(1_000);
    expect.soft(total(), '掲載されない').toBe(before);
    await evidence(page, '03-I017');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)（配布物の題名）、同「配布物の掲載と閲覧」(4-7) 処理2、図/画面詳細図 (4-5) 項目8 */
  test('03-I018 配布物の題名：50文字', async ({ page }) => {
    await open(page);
    const title = H.fill('受入テスト 03-I018 ', 50);
    const d = await H.fillHandout(page, { title, file: pdfOf() });
    await trySubmit(d);
    await expect(d).toBeHidden();
    expect.soft(H.handoutCount(title), '50文字で掲載される').toBe(1);
    await expect.soft(page.getByRole('main').getByRole('row').filter({ hasText: title }), '一覧に題名が欠けずに出る').toBeVisible(SOFT);
    await evidence(page, '03-I018');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)（配布物の題名）、同「配布物の掲載と閲覧」(4-7) 処理2、図/画面詳細図 (4-5) 項目8（残り文字数を示す） */
  test('03-I019 配布物の題名：51文字', async ({ page }, testInfo) => {
    await open(page);
    const t51 = H.fill('受入テスト 03-I019 ', 51);
    const d = await H.fillHandout(page, { title: t51, file: pdfOf() });
    await expect.soft(d.getByText(/残り/).first(), '入力欄に残りの文字数が出る').toBeVisible(SOFT);
    const box = d.getByRole('group', { name: /^題名/ }).getByRole('textbox');
    if ([...(await box.inputValue())].length <= 50) {
      testInfo.annotations.push({ type: 'note', description: '入力欄が50文字で止まるため、送る要求の中で51文字に書き換えて確かめた' });
      const t50 = [...t51].slice(0, 50).join('');
      await box.fill(t50);
      await H.rewriteNextRequest(page, /\/api\/handouts/, t50, t51);
    }
    await trySubmit(d);
    await page.waitForTimeout(1_500);
    expect.soft(H.handoutCount(t51), '51文字は掲載されない').toBe(0);
    await evidence(page, '03-I019');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)（配布物の対象の月）、同「配布物の掲載と閲覧」(4-7) 処理2、図/画面詳細図 (4-5) 項目9 */
  test('03-I020 配布物の対象の月：空', async ({ page }) => {
    await open(page);
    const before = total();
    const d = await H.fillHandout(page, { title: '受入テスト 03-I020', month: '', file: pdfOf() });
    await trySubmit(d);
    await page.waitForTimeout(1_000);
    expect.soft(total(), '掲載されない').toBe(before);
    await evidence(page, '03-I020');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)（配布物のファイル）、図/画面詳細図 (4-5) 項目11 */
  test('03-I021 配布物のファイル：未選択', async ({ page }) => {
    await open(page);
    const before = total();
    const d = await H.fillHandout(page, { title: '受入テスト 03-I021' });
    await trySubmit(d);
    await page.waitForTimeout(1_000);
    expect.soft(total(), '掲載されない').toBe(before);
    await evidence(page, '03-I021');
  });

  /* 典拠：基本設計書「メッセージ一覧」(4-12)「配布物の形式が対象外」、同「配布物の掲載と閲覧」(4-7) 処理2 */
  test('03-I022 配布物のファイル：形式の外', async ({ page }) => {
    await open(page);
    const d = await H.fillHandout(page, { title: '受入テスト 03-I022', file: { name: 'ukeire03-I022.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: H.DOCX } });
    await trySubmit(d);
    await expect.soft(page.getByText('掲載できるのは PDF・JPEG・PNG のファイルです。').first(), '形式の誤りの文言').toBeVisible(SOFT);
    expect.soft(H.handoutCount('受入テスト 03-I022'), '掲載されない').toBe(0);
    await evidence(page, '03-I022');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)、同「設定マスタ」(5-9)（attachment.max_size_mb） */
  test('03-I023 配布物のファイル：10,000,000 バイト', async ({ page }) => {
    await open(page);
    const d = await H.fillHandout(page, { title: '受入テスト 03-I023', file: pdfOf(10_000_000) });
    await trySubmit(d);
    await expect(d).toBeHidden({ timeout: 30_000 });
    expect.soft(H.handoutCount('受入テスト 03-I023'), '掲載される').toBe(1);
    await evidence(page, '03-I023');
  });

  /* 典拠：基本設計書「メッセージ一覧」(4-12)「配布物の大きさが上限を超える」 */
  test('03-I024 配布物のファイル：10,485,761 バイト', async ({ page }) => {
    await open(page);
    const d = await H.fillHandout(page, { title: '受入テスト 03-I024', file: pdfOf(10_485_761) });
    await trySubmit(d);
    await expect.soft(page.getByText('ファイルは10MB までです。').first(), '大きさの誤りの文言').toBeVisible({ timeout: 15_000 });
    expect.soft(H.handoutCount('受入テスト 03-I024'), '掲載されない').toBe(0);
    await evidence(page, '03-I024');
  });
});

test.describe('入力チェック：チャットの添付', () => {
  /* 典拠：要件定義書「添付ファイルの制限」(4-4)、図/画面詳細図 (4-2) 項目6 */
  test('03-I025 保護者の添付：GIF', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await login(page, 'guardian');
    await guardianOpenTaro(page);
    const attach = page.getByRole('main').getByRole('button', { name: '添付' });
    test.skip((await attach.count()) === 0, NEXT_VERSION);
    test.skip(!(await H.attachWorks(page, attach)), NO_FILE_PICK);
    test.info().annotations.push({ type: 'note', description: '【次の版】画面に添付がある。基本設計書の期待で確かめた' });
    const before = H.sqlCount('SELECT COUNT(*) AS n FROM t_chat_attachment');
    const chooser = page.waitForEvent('filechooser');
    await attach.click();
    await (await chooser).setFiles({ name: 'ukeire03-I025.gif', mimeType: 'image/gif', buffer: H.GIF_1PX });
    await H.sendButton(page).click().catch(() => {});
    await page.waitForTimeout(1_500);
    expect.soft(H.sqlCount('SELECT COUNT(*) AS n FROM t_chat_attachment'), 'GIF は送られない').toBe(before);
    await evidence(page, '03-I025');
  });
});

