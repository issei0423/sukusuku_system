/*
 * シート 02 連絡帳（テスト仕様書 兼 成績書 第2.0版）
 *
 * ケースは docs ブランチの設計書から書いたシート（sheet-02.md）による。期待する結果は設計書から書き、コードを読んで決めない
 * （README.md「期待は設計書から」）。典拠は各テストのコメントに、名前を主に書く。
 *
 * 前提の記号（sheet-02.md「共通の前提」）
 *   【窓2】職員の窓（既定の page。タブレット）と保護者の窓（browser.newContext()。スマートフォン）を同時に開き、保護者の窓は読み込み直さない
 *   【葵】管理者で、さくら組に園児「検査 葵」（呼び名「あおいちゃん」、写真の利用同意「他の保護者にも見える場へ掲載」）を登録する
 *   【同意n】管理者で、西田 太郎（C001）の写真の利用同意を変える
 *   【実施中】さくら組の午睡チェックを実施中にする（夜中の扱いは undecided.md U-01）
 *
 * 職員A＝staffSakura（鈴木 浩之）、保護者P＝guardian（西田 太郎の父）、保護者Q＝guardianMurata（村田 美咲の父）、管理者＝admin。
 * 夜中に回すので、デモデータの「今日」の記録には頼らず、テストの中で記録を作って確かめる（README.md「夜中の注意」）。
 */
import type { Locator, Page } from '@playwright/test';
import { ACCOUNTS, evidence, expect, jstToday, login, test } from './harness';
import {
  ALL_SHOW_ITEMS,
  GIF_1PX,
  SHOW_ITEMS_UNAVAILABLE,
  KENSA,
  api,
  closeWindows,
  dashboardCount,
  ensureKensaAoi,
  ensureNapRunning,
  jstYesterday,
  makePicture,
  openPhotoPicker,
  openWindow,
  postPhoto,
  setConsent,
  setShowItems,
  watchDialogs,
} from './02-contact.helpers';

const TARO = ACCOUNTS.guardian.children[0].name; // 西田 太郎（C001）
const STAFF = ACCOUNTS.staffSakura.name; // 鈴木 浩之
/** 午睡に常に添える文（基本設計書「メッセージ一覧」(4-12) の連絡帳） */
const NAP_NOTE = 'おひるねの間は、決められた間隔で呼吸や体の向きを確かめています。いつもと違うことがあれば、園からお電話します。';
const T = String.raw`\d{1,2}:\d{2}`;

/**
 * from から to までの JST の分（H:MM）を並べた正規表現の断片。自分が記録した時刻の行に絞るために使う
 * （昼に回すと、デモのきょうの記録（09:40 おしっこ など）と同じ種類の行が並ぶため。照合 T14 の V16。T15b）
 */
function minutesBetween(from: Date, to: Date): string {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const out = new Set<string>();
  for (let t = Math.floor(from.getTime() / 60_000) * 60_000; t <= to.getTime(); t += 60_000) {
    const parts = fmt.formatToParts(new Date(t));
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = parts.find((p) => p.type === 'minute')?.value ?? '';
    out.add(`0?${h}:${m}`);
  }
  return `(?:${[...out].join('|')})`;
}
/** 判定の言葉（設計原則1。要件定義書「判断を行わないことの担保」(7-1 No.5)） */
const JUDGE = /平熱より|発熱|熱がある|微熱|高熱|よく眠れ|ぐっすり|順調|元気に/;
const XSS = `<script>alert('xss')</script><b>太字</b><img src=x onerror=alert(1)>`;
/** クラスのようすは次の版（rules.md「次の版の機能」） */
const CLASS_NOTE_NEXT = '実装対象の外（詳細設計書「本版で詳しくする範囲」(1-2) でクラスのようすは要点（次の版）。連絡帳（クラス）画面に欄が無い）';

test.afterEach(async () => {
  await closeWindows();
});

// ---- 画面を開く手助け（spec の中だけ） ----

async function openClass(page: Page) {
  await page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '連絡帳', exact: true }).click();
  await expect(page.getByRole('heading', { name: '連絡帳', level: 1 })).toBeVisible();
  await expect(taroRow(page)).toBeVisible();
}
async function openChild(page: Page, name: string = TARO) {
  await openClass(page);
  await page.getByRole('row', { name: new RegExp(`^${name}`) }).getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await settleChild(page);
}
/** 連絡帳（園児）画面が読み込みを終えるまで待つ（宛先と、その日の記録の欄が出るまで） */
async function settleChild(page: Page) {
  await expect(page.getByRole('main').getByRole('note', { name: '宛先' }).first()).toContainText(/届きます|まだ保護者が登録していません/);
  await expect(sToday(page).getByRole('listitem').first().or(sToday(page).getByText(/まだ(きょう|この日)の記録はありません/))).toBeVisible();
  await page.waitForTimeout(500);
}
function taroRow(page: Page) {
  return page.getByRole('row', { name: new RegExp(`^${TARO}`) });
}
/** 連絡帳（クラス）画面の行の「家庭から」のセル */
function homeCell(page: Page) {
  return taroRow(page).getByRole('cell').first();
}
/** 保護者の窓で、園児の連絡帳画面（きょう）を開く */
async function guardianContact(browser: import('@playwright/test').Browser, testInfo: import('@playwright/test').TestInfo, who: 'guardian' | 'guardianMurata' | 'guardianKubota' = 'guardian') {
  const g = await openWindow(browser, testInfo, who);
  await g.getByRole('link', { name: '連絡帳を開く' }).first().click();
  await expect(g.getByRole('heading', { name: /の連絡帳$/, level: 1 })).toBeVisible();
  return g;
}
/** 保護者の連絡帳画面のきょうのようす（前の日のページでは「この日のようす」） */
function gToday(g: Page) {
  return g.getByRole('region', { name: /^(きょう|この日)のようす$/ });
}
/** 職員の連絡帳（園児）画面のきょうのようす（前の日のページでは「この日のようす（朝から）」） */
function sToday(page: Page) {
  return page.getByRole('region', { name: /^(きょう|この日)のようす（朝から）$/ });
}
/** 保護者の画面の写真（押すと大きく出る） */
function gPhotos(g: Page) {
  return gToday(g).getByRole('button', { name: /の写真を大きく見る$/ });
}
/** 午睡チェック画面の体温の窓：整数の部分を選んでから小数を選ぶ */
async function napTemp(page: Page, value: string) {
  const [int, dec] = value.split('.');
  const dialog = page.getByRole('dialog', { name: new RegExp('の体温$') }).last();
  await dialog.getByRole('button', { name: `${int}℃`, exact: true }).click();
  await dialog.getByRole('button', { name: new RegExp(`^(${int}\\.${dec}|\\.${dec}|${dec})(℃)?$`) }).first().click();
}
/** ラジオの選択肢は、文字（ラベル）を押して選ぶ */
async function pick(scope: Locator | Page, group: string, label: string) {
  await scope.getByRole('group', { name: group }).getByText(label, { exact: true }).click();
}
async function pickupChange(home: Locator, person: string, time: string) {
  await pick(home, 'お迎え', '変更あり');
  await home.getByText(person, { exact: true }).click();
  await home.getByRole('combobox', { name: /お迎えの時刻/ }).selectOption(time);
}
async function guardianTemp(g: Page, value: string, other = false) {
  await g.getByRole('region', { name: '家庭から' }).getByRole('button', { name: '体温を入れる' }).click();
  const dialog = g.getByRole('dialog', { name: '体温' });
  if (other) {
    await dialog.getByRole('button', { name: 'ほかの値' }).click();
    await dialog.getByRole('spinbutton', { name: 'ほかの値（℃）' }).fill(value);
    await dialog.getByRole('button', { name: '記録する' }).click();
  } else {
    await dialog.getByRole('button', { name: value, exact: true }).click();
  }
}
async function sendHome(g: Page) {
  await g.getByRole('region', { name: '家庭から' }).getByRole('button', { name: '家庭からを送る' }).click();
}
/** 定型文の候補の最初の1つ。窓は候補を読み込むまで「閉じる」だけを出すので、候補（文の終わりが「。」）が出るまで待つ */
function phraseButton(page: Page) {
  return page.getByRole('dialog', { name: '定型文を選ぶ' }).getByRole('button', { name: /。$/ }).first();
}
function toast(page: Page, text: string | RegExp) {
  return page.getByRole('status').filter({ hasText: text }).first();
}
function nameCheckDialog(page: Page) {
  return page.getByRole('dialog', { name: 'ほかのお子さんの名前の注意' });
}
async function sendComment(page: Page, body: string) {
  const side = page.getByRole('complementary', { name: '記録する' });
  await side.getByRole('textbox', { name: '活動のひとこと' }).fill(body);
  await side.getByRole('button', { name: 'ひとことを送る' }).click();
}
function facility(page: Page) {
  return page.getByRole('region', { name: '園から' });
}
async function cancelTimelineItem(page: Page, text: string | RegExp) {
  await sToday(page).getByRole('listitem').filter({ hasText: text }).getByRole('button', { name: /を直す・取り消す$/ }).click();
  await page.getByRole('dialog', { name: '記録を直す' }).getByRole('button', { name: 'この記録を取り消す' }).click();
  const confirm = page.getByRole('dialog', { name: 'この記録を取り消しますか' });
  await expect(confirm).toBeVisible();
  return confirm;
}
/** 写っている子の窓で選び、「決める」で写真の窓へ戻る */
async function choose(picker: Locator, names: string[]) {
  for (const n of names) await picker.getByRole('button', { name: new RegExp(`^${n}`) }).click();
  await picker.getByRole('button', { name: '決める' }).click();
  await expect(picker).toBeHidden();
}

// =====================================================================
// 家庭から（保護者が送り、園が確認する）
// =====================================================================
test.describe('家庭から（保護者が送り、園が確認する）', () => {
  test.describe.configure({ mode: 'serial' });

  /*
   * 典拠：要件定義書「家庭から」(4-2-2)、基本設計書「家庭からの記入」(4-5)・「届いていない家庭の一覧（職員ダッシュボード）」(4-5)、
   *   図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目11・12、「連絡帳（クラス）画面」(8-1) 項目6・7、詳細設計書「家庭から」(3-1)
   */
  test('02-001 家庭からを選ぶだけで送る', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    const before = await dashboardCount(page, '家庭からの連絡', '未確認');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const home = g.getByRole('region', { name: '家庭から' });
    await pick(home, '朝ごはん', 'ぜんぶ');
    await pick(home, 'きげん', 'ふつう');
    await sendHome(g);

    await expect(toast(g, '送りました。園が確認するとここに出ます。')).toBeVisible();
    await expect(home).toContainText('急ぎはお電話でお願いします。');
    // 職員の画面は読み込み直さずに変わる
    await expect(homeCell(page)).toContainText('未確認');
    await expect(homeCell(page)).toContainText(new RegExp(`父 ${T}`));
    await expect(homeCell(page)).toContainText(/朝ごはん\s*ぜんぶ/);
    await expect(homeCell(page)).toContainText(/きげん\s*ふつう/);
    await expect(taroRow(page).getByRole('button', { name: `${TARO}の家庭からを確認しました` })).toBeVisible();
    await evidence(page, '02-001');
    expect(await dashboardCount(page, '家庭からの連絡', '未確認')).toBe(before + 1);
  });

  /*
   * 典拠：要件定義書「保護者へ届けるときの関所」(4-1-6) 段1、基本設計書「家庭からの確認（「確認しました」）」(4-5)・「保護者へ届けるときの関所」(2-4)、
   *   図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目7、詳細設計書「家庭から」(3-1)・「連絡帳画面（保護者）」(2-6 (4))
   */
  test('02-002 確認しました（段1）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const home = g.getByRole('region', { name: '家庭から' });
    await expect(home).toContainText('急ぎはお電話でお願いします。');

    const confirm = taroRow(page).getByRole('button', { name: `${TARO}の家庭からを確認しました` });
    await confirm.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(homeCell(page)).toContainText(new RegExp(`園が確認しました ${T} ${STAFF}`));
    await expect(confirm).toHaveCount(0);
    await expect(taroRow(page).getByRole('button', { name: /外す|確認を取り消/ })).toHaveCount(0);
    // 保護者の画面は読み込み直さずに変わる。押した職員の名前は出さない
    await expect(home).toContainText(new RegExp(`園が確認しました（${T}）`));
    await expect(home).not.toContainText('急ぎはお電話で');
    await expect(home).not.toContainText(STAFF);
    await evidence(g, '02-002');
  });

  /*
   * 典拠：基本設計書「家庭からの記入」(4-5)・「家庭からの確認（「確認しました」）」(4-5)、図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目6、
   *   詳細設計書「家庭から」(3-1)・「連絡帳（クラス）画面」(2-2 (3))・「連絡帳画面（保護者）」(2-6 (3))
   */
  test('02-003 確認のあとに直すと「更新」', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    const before = await dashboardCount(page, '家庭からの連絡', '更新');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const home = g.getByRole('region', { name: '家庭から' });
    await home.getByRole('button', { name: '直す', exact: true }).click();
    await expect(home).toContainText('直すと、園の確認がいったん外れます。');
    await pick(home, 'きげん', 'ごきげん');
    await guardianTemp(g, '37.8');
    await pickupChange(home, '祖母', '17:30');
    await sendHome(g);

    await expect(home).toContainText('急ぎはお電話でお願いします。');
    await expect(homeCell(page)).toContainText('更新');
    await expect(taroRow(page).getByRole('button', { name: `${TARO}の家庭からを確認しました` })).toBeVisible();
    await expect(homeCell(page)).toContainText(/きげん\s*ごきげん/);
    await expect(homeCell(page)).toContainText('祖母');
    await expect(homeCell(page)).toContainText('17:30');
    await expect(homeCell(page)).toContainText('37.8℃');
    expect(await homeCell(page).innerText()).not.toMatch(JUDGE);
    await evidence(page, '02-003');
    expect(await dashboardCount(page, '家庭からの連絡', '更新')).toBe(before + 1);
  });

  /*
   * 典拠：基本設計書「同時編集の検出」(4-2)、詳細設計書「`POST /api/contact/home/{id}/confirm`（確認しました）」(4-3 (6))
   * 職員の画面を古い版のまま止めるため、知らせ（/api/events）を止め、連絡帳（クラス）画面の読み直しには最初に読んだ中身を返す
   */
  test('02-004 読んだ版が古い「確認しました」', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    let stale: string | null = null;
    await page.route('**/api/events', (route) => route.abort());
    await page.route('**/api/contact/classes/**', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      if (stale === null) {
        const res = await route.fetch();
        stale = await res.text();
        return route.fulfill({ response: res, body: stale });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: stale });
    });
    await openClass(page);
    const confirm = taroRow(page).getByRole('button', { name: `${TARO}の家庭からを確認しました` });
    await expect(confirm).toBeVisible();

    const g = await guardianContact(browser, testInfo);
    const home = g.getByRole('region', { name: '家庭から' });
    await home.getByRole('button', { name: '直す', exact: true }).click();
    await pick(home, '朝ごはん', '半分');
    await sendHome(g);
    await expect(toast(g, '送りました')).toBeVisible();

    await confirm.click();
    await expect(page.getByText('家庭からの連絡が更新されました。読み直してから確認してください。').first()).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await expect(home).toContainText('急ぎはお電話でお願いします。');
    await expect(home).not.toContainText('園が確認しました');
    await evidence(page, '02-004');
  });

  /* 典拠：基本設計書「家庭からの記入」(4-5)、図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目11、詳細設計書「連絡帳画面（保護者）」(2-6 (3)) */
  test('02-005 前の日のページには書けない', async ({ browser }, testInfo) => {
    const g = await guardianContact(browser, testInfo);
    await g.getByRole('navigation', { name: '連絡帳の日付' }).getByRole('button', { name: /前の日/ }).click();
    await expect(g.getByText('前の日の連絡は直せません。急ぎはお電話でお願いします。').first()).toBeVisible();
    await expect(g.getByRole('button', { name: '家庭からを送る' })).toHaveCount(0);
    await expect(g.getByRole('region', { name: '家庭から' }).getByRole('button', { name: '直す', exact: true })).toHaveCount(0);
    await evidence(g, '02-005');
  });

  /* 典拠：授業の雛形「テスト対象」(1.5) の二重送信の防止、基本設計書「家庭からの記入」(4-5)（すでに今日の家庭からがあれば上書き） */
  test('02-057 二重送信：家庭からを送ったあとの再読み込み（保護者）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const dialogs = watchDialogs(g);
    const home = g.getByRole('region', { name: '家庭から' });
    await home.getByRole('button', { name: '直す', exact: true }).click();
    await pick(home, 'きげん', 'ふつう');
    await sendHome(g);
    await expect(toast(g, '送りました。園が確認するとここに出ます。')).toBeVisible();
    await expect(homeCell(page)).toContainText(/きげん\s*ふつう/);
    const sentAt = /(?:未確認|更新) 父 (\d{1,2}:\d{2})/.exec(await homeCell(page).innerText())?.[1];
    expect(sentAt).toBeTruthy();

    await g.reload();
    await expect(g.getByRole('heading', { name: /の連絡帳$/, level: 1 })).toBeVisible();
    await expect(home.getByRole('button', { name: '直す', exact: true })).toHaveCount(1);
    await page.waitForTimeout(3_000);
    expect(dialogs).toEqual([]);
    expect(/(?:未確認|更新) 父 (\d{1,2}:\d{2})/.exec(await homeCell(page).innerText())?.[1]).toBe(sentAt);
    await evidence(g, '02-057');
  });

  /* 典拠：授業の雛形「テスト対象」(1.5) のクロスサイトスクリプティング対策、基本設計書「入力項目の制約値」(4-12)（連絡事項500文字・迎えの人50文字） */
  test('02-058 XSS：家庭から', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const dialogs = watchDialogs(page, g);
    const home = g.getByRole('region', { name: '家庭から' });
    await home.getByRole('button', { name: '直す', exact: true }).click();
    await home.getByRole('textbox', { name: /連絡事項/ }).fill(XSS);
    await pick(home, 'お迎え', '変更あり');
    await home.getByText('その他', { exact: true }).click();
    await home.getByRole('textbox', { name: /その他|お迎えの人/ }).fill('<i>祖母</i>');
    await home.getByRole('combobox', { name: /お迎えの時刻/ }).selectOption('17:30');
    await sendHome(g);
    await expect(toast(g, '送りました')).toBeVisible();

    for (const scope of [home, homeCell(page)]) {
      await expect(scope).toContainText(XSS);
      await expect(scope).toContainText('<i>祖母</i>');
      await expect(scope.locator('b', { hasText: '太字' })).toHaveCount(0);
      await expect(scope.locator('i', { hasText: '祖母' })).toHaveCount(0);
      await expect(scope.locator('img[src="x"]')).toHaveCount(0);
    }
    await expect(page.getByRole('columnheader', { name: '家庭から' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '園から' })).toBeVisible();
    await openChild(page);
    await expect(page.getByRole('region', { name: '家庭から' })).toContainText(XSS);
    expect(dialogs).toEqual([]);
    await evidence(page, '02-058');
  });
});

// =====================================================================
// きょうのようす：選ぶだけの記録（段1）と訂正
// =====================================================================
test.describe('きょうのようす（段1）', () => {
  test.describe.configure({ mode: 'serial' });

  /* 典拠：要件定義書「きょうのようす」(4-2-3)、基本設計書「食事の記録」(4-5)・「保護者へ届けるときの関所」(2-4) 段1、図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目11 */
  test('02-006 食事を1人ずつ記録（段1）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    await page.getByRole('group', { name: '食事の区分' }).getByRole('button', { name: 'おやつ', exact: true }).click();
    await page.getByRole('button', { name: `${TARO}のおやつをぜんぶ` }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const done = toast(page, '保護者が見られる状態です');
    await expect(done).toBeVisible();
    await expect(done.getByRole('button', { name: '取り消す' })).toBeVisible();
    await expect(gToday(g).getByRole('listitem').filter({ hasText: new RegExp(`${T}\\s*おやつ\\s*ぜんぶ`) })).toBeVisible();
    await evidence(g, '02-006');
  });

  /*
   * 典拠：基本設計書「食事の記録」(4-5)・「画面基本構成」(3-5) の「誰でも使える操作の条件」②、図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目8・9、
   *   詳細設計書「連絡帳（クラス）画面」(2-2 (4))・「きょうのようすの出来事・クラスのようす・園から」(3-2)
   */
  test('02-007 全員ぜんぶ（仮）は届かない', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const meal = page.getByRole('region', { name: '食事を記録する' });
    await meal.getByRole('button', { name: 'おやつ（2回目）' }).click();
    await meal.getByRole('button', { name: '全員ぜんぶ' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(meal).toContainText(/\d+人に「ぜんぶ」が入っています。違う子・お休みの子を行で直してから「記録する」を押してください。/);
    await expect(meal.getByRole('button', { name: '記録する' })).toBeVisible();
    await page.waitForTimeout(3_000);
    await expect(gToday(g).getByRole('listitem').filter({ hasText: 'おやつ' })).toHaveCount(1);
    await evidence(page, '02-007');
  });

  /* 典拠：基本設計書「食事の記録」(4-5)、図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目9・10、詳細設計書「連絡帳（クラス）画面」(2-2 (4)) */
  test('02-008 違う子を直し、お休みの子を外して記録する', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const meal = page.getByRole('region', { name: '食事を記録する' });
    await meal.getByRole('button', { name: 'おやつ（2回目）' }).click();
    await meal.getByRole('button', { name: '全員ぜんぶ' }).click();
    const n = Number(/(\d+)人に「ぜんぶ」/.exec(await meal.innerText())?.[1]);
    expect(n).toBeGreaterThan(1);
    // お休みの子（伊藤 葵）は仮の「ぜんぶ」を外し、違う子（西田 太郎）は「半分」に直す
    await page.getByRole('button', { name: '伊藤 葵のおやつ（2回目）をぜんぶ（仮）' }).click();
    await page.getByRole('button', { name: `${TARO}のおやつ（2回目）を半分` }).click();
    await meal.getByRole('button', { name: '記録する' }).click();
    const done = toast(page, /人の.+を記録しました。保護者が見られる状態です。/);
    await expect(done).toBeVisible();
    expect(Number(/(\d+)人の/.exec(await done.innerText())?.[1])).toBe(n - 1);
    await expect(gToday(g).getByRole('listitem').filter({ hasText: /おやつ.*半分/ })).toBeVisible();
    await evidence(g, '02-008');
    await openChild(page, '伊藤 葵');
    await expect(sToday(page).getByRole('listitem').filter({ hasText: 'おやつ' })).toHaveCount(0);
  });

  /* 典拠：基本設計書「排せつ・体温の記録」(4-5)、図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目12、詳細設計書「連絡帳（クラス）画面」(2-2 (5)) */
  test('02-009 排せつを1タップで記録（段1）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const pressedAt = new Date();
    await page.getByRole('button', { name: `${TARO}の排せつ おしっこ` }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const cell = taroRow(page).getByRole('cell', { name: new RegExp(`${TARO}の排せつ`) });
    await expect(cell).toContainText(/\d+\s*回/);
    await expect(cell).toContainText(new RegExp(`おしっこ\\s*${T}`));
    // 保護者の画面では、自分が押した時刻の行に絞る（デモのきょうの記録と見分ける。T15b）
    const mine = minutesBetween(pressedAt, new Date());
    await expect(gToday(g).getByRole('listitem').filter({ hasText: new RegExp(`${mine}\\s*おしっこ`) })).toBeVisible();
    await evidence(g, '02-009');
  });

  /*
   * 典拠：要件定義書「判断を行わないことの担保」(7-1 No.5)、基本設計書「排せつ・体温の記録」(4-5)、図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目13、
   *   詳細設計書「連絡帳（クラス）画面」(2-2 (5))・「連絡帳画面（保護者）」(2-6 (5))。固定の文は【仮置き】のため、電話のことを示す文があるところまで見る
   */
  test('02-010 体温を記録（段1・判定しない）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    await page.getByRole('button', { name: `${TARO}の体温を記録する` }).click();
    const dialog = page.getByRole('dialog', { name: `${TARO}の体温` });
    await expect(dialog).toContainText(/電話/);
    await dialog.getByRole('button', { name: '36.8', exact: true }).click();
    const item = gToday(g).getByRole('listitem').filter({ hasText: '36.8℃' });
    await expect(item).toBeVisible();
    expect(await item.innerText()).not.toMatch(JUDGE);
    await evidence(g, '02-010');
  });

  /*
   * 典拠：要件定義書「取り消し・訂正」(4-2-5)、基本設計書「取り消し・訂正」(4-2)・「食事の記録」(4-5)、詳細設計書「連絡帳（クラス）画面」(2-2 (4))・
   *   「訂正・取り消しのまとめ」(3-5)・「誰が直したかの表示（職員の応答だけ）」(4-7 (4))
   */
  test('02-049 記録した値を直す（訂正）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    await page.getByRole('group', { name: '食事の区分' }).getByRole('button', { name: 'おやつ', exact: true }).click();
    await page.getByRole('button', { name: `${TARO}のおやつを少し` }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const item = gToday(g).getByRole('listitem').filter({ hasText: /おやつ\s*少し/ });
    await expect(item).toBeVisible();
    await expect(item).toContainText(new RegExp(`訂正しました（${T}）`));
    await evidence(g, '02-049');
    await openChild(page);
    await expect(sToday(page).getByRole('listitem').filter({ hasText: /おやつ\s*少し/ })).toContainText(new RegExp(`訂正しました（${T} ${STAFF}）`));
  });
});

// =====================================================================
// 訂正の表示：記録した職員と直した職員が別の人（02-049 の変種。T13 で足した）
// =====================================================================
test.describe('訂正の表示（記録した職員と直した職員が別）', () => {
  /*
   * 典拠：基本設計書「取り消し・訂正」(4-2)（その日はその園児のクラスの担任、管理者はいつでも。誰が直したかは操作ログに残る）、
   *   図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目11・「連絡帳（園児）画面」(8-2) 項目6（記録した職員・訂正の有無）・「連絡帳画面（保護者）」(8-3) 項目14 と出さないもの、
   *   詳細設計書「誰が直したかの表示（職員の応答だけ）」(4-7 (4))（決めたこと D-28：職員の画面に直した職員と時刻を添え、保護者の画面には出さない）
   */
  test('02-061 別の職員が直した訂正の表示', async ({ page, browser }, testInfo) => {
    const ADMIN = ACCOUNTS.admin.name; // 西田 拓也
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    await page.getByRole('group', { name: '食事の区分' }).getByRole('button', { name: 'おやつ', exact: true }).click();
    await page.getByRole('button', { name: `${TARO}のおやつをぜんぶ` }).click();
    await expect(gToday(g).getByRole('listitem').filter({ hasText: /おやつ\s*ぜんぶ/ })).toBeVisible();
    // 管理者が、さくら組の連絡帳（クラス）画面で選び直して訂正する（管理者はいつでも直せる）
    const admin = await openWindow(browser, testInfo, 'admin');
    await admin.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '連絡帳', exact: true }).click();
    await admin.getByRole('combobox', { name: 'クラス' }).selectOption({ label: 'さくら組' });
    await expect(taroRow(admin)).toBeVisible();
    await admin.getByRole('group', { name: '食事の区分' }).getByRole('button', { name: 'おやつ', exact: true }).click();
    await admin.getByRole('button', { name: `${TARO}のおやつを少し` }).click();
    await expect(admin.getByRole('dialog')).toHaveCount(0);
    // 保護者：読み込み直さずに訂正が出て、職員の名前は出ない
    const gItem = gToday(g).getByRole('listitem').filter({ hasText: /おやつ\s*少し/ });
    await expect(gItem).toContainText(new RegExp(`訂正しました（${T}）`));
    await expect.soft(gItem, '保護者の画面に直した職員の名前を出さない').not.toContainText(ADMIN);
    await expect.soft(gItem, '保護者の画面に記録した職員の名前を出さない').not.toContainText(STAFF);
    // 記録した職員（鈴木 浩之）の連絡帳（園児）画面：記録した職員はそのまま、「訂正しました（時刻 直した職員）」
    await openChild(page);
    const sItem = sToday(page).getByRole('listitem').filter({ hasText: /おやつ\s*少し/ });
    await expect(sItem).toBeVisible();
    await sItem.scrollIntoViewIfNeeded();
    await expect.soft(sItem, '記録した職員は鈴木 浩之のまま').toContainText(STAFF);
    await expect(sItem, '括弧の中に直した職員（西田 拓也）').toContainText(new RegExp(`訂正しました（${T}\\s*${ADMIN}）`));
    await evidence(page, '02-061');
  });
});

// =====================================================================
// 午睡の「ねた・おきた」（段1）と、届けない監査の層（段3）
// =====================================================================
test.describe('午睡（段1・段3）', () => {
  test.describe.configure({ mode: 'serial' });

  /* 典拠：基本設計書「きょうは対象外」(4-8)・「届いていない家庭の一覧（職員ダッシュボード）」(4-5)、図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目16、詳細設計書「午睡の園児」(3-4) */
  test('02-011 きょうは対象外（欠席）は保護者に出さない', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    const before = await dashboardCount(page, '園からのひとことを送っていない園児');
    if (!(await ensureNapRunning(page))) test.skip(true, '夜中のため午睡チェックを開始できない（U-01）');
    const g = await guardianContact(browser, testInfo);
    const row = page.getByRole('region', { name: `${TARO}の午睡チェック` });
    await row.getByRole('button', { name: `${TARO}をきょうは対象外にする` }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: '欠席', exact: true }).click();
    await expect(row).toContainText('対象外（欠席）');

    await page.waitForTimeout(2_000);
    await expect(g.getByRole('main')).not.toContainText('欠席');
    await expect(gToday(g)).not.toContainText(/おひるね|対象外/);
    await evidence(g, '02-011');
    expect(await dashboardCount(page, '園からのひとことを送っていない園児')).toBe(before - 1);
    await openClass(page);
    await expect(taroRow(page).getByRole('cell').last()).toContainText('欠席');
    // 確かめたら戻す
    await page.goto('/staff/nap');
    await row.getByRole('button', { name: /戻す/ }).click();
    await expect(row.getByRole('button', { name: `${TARO}のねた` })).toBeVisible();
  });

  /*
   * 典拠：要件定義書「きょうのようす」(4-2-3)、基本設計書「ねた・おきた」(4-8)・「保護者の一日と保育士の一日」(2-3)、
   *   図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目15・「保護者ホーム」(2-7) 項目4、詳細設計書「午睡の園児」(3-4)
   */
  test('02-012 ねた（段1）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    if (!(await ensureNapRunning(page))) test.skip(true, '夜中のため午睡チェックを開始できない（U-01）');
    const g = await guardianContact(browser, testInfo);
    const gh = await g.context().newPage();
    await gh.goto('/guardian');
    const row = page.getByRole('region', { name: `${TARO}の午睡チェック` });
    await row.getByRole('button', { name: `${TARO}のねた` }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row).toContainText(new RegExp(`${T}\\s*ねた`));
    await expect(gToday(g).getByRole('listitem').filter({ hasText: new RegExp(`${T}\\s*おひるね中`) })).toBeVisible();
    await expect(gToday(g)).toContainText(NAP_NOTE);
    const today = gh.getByRole('region', { name: `${TARO}さんのきょう` });
    await expect(today).toContainText(new RegExp(`${T}\\s*おひるね中`));
    await expect(today).toContainText(NAP_NOTE);
    await evidence(g, '02-012');
  });

  /*
   * 典拠：要件定義書「保護者へ届けるときの関所」(4-1-6) 段3・「品質要求一覧」(7-1 No.10)、基本設計書「保護者へ届けるときの関所」(2-4) の (3)・「ねた・おきた」(4-8)、
   *   詳細設計書「`GET /api/contact/children/{childID}`」(4-3 (1)) の午睡
   */
  test('02-013 5分ごとの確認と入眠時の体温は届かない（段3）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    if (!(await ensureNapRunning(page))) test.skip(true, '夜中のため午睡チェックを開始できない（U-01）');
    const g = await guardianContact(browser, testInfo);
    const gh = await g.context().newPage();
    await gh.goto('/guardian');
    const row = page.getByRole('region', { name: `${TARO}の午睡チェック` });
    await row.getByRole('button', { name: new RegExp(`^${TARO}の体温`) }).click();
    await napTemp(page, '37.1');
    await pick(row, '体位', '仰向け');
    await pick(row, '呼吸', 'あり');
    await pick(row, '顔色', '通常');
    await row.getByRole('button', { name: `${TARO}を記録する` }).click();
    await expect(row).toContainText('37.1');

    await page.waitForTimeout(3_000);
    for (const scope of [g.getByRole('main'), gh.getByRole('main')]) {
      // 「呼吸」は常に添える文（「呼吸や体の向きを確かめています」）にあるため、記録の値（呼吸 あり）で見る
      for (const word of ['37.1', '仰向け', /呼吸\s*あり/, '顔色', 'チェック']) await expect(scope).not.toContainText(word);
    }
    await expect(gToday(g).getByRole('listitem').filter({ hasText: 'おひるね中' })).toBeVisible();
    await expect(gToday(g)).toContainText(NAP_NOTE);
    await evidence(g, '02-013');
  });

  /* 典拠：基本設計書「ねた・おきた」(4-8)、要件定義書「きょうのようす」(4-2-3)、詳細設計書「午睡の園児」(3-4) */
  test('02-014 おきた（段1）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    if (!(await ensureNapRunning(page))) test.skip(true, '夜中のため午睡チェックを開始できない（U-01）');
    const g = await guardianContact(browser, testInfo);
    const row = page.getByRole('region', { name: `${TARO}の午睡チェック` });
    await row.getByRole('button', { name: `${TARO}のおきた` }).click();
    await expect(row).toContainText(/おきた|〜/);
    await expect(gToday(g).getByRole('listitem').filter({ hasText: new RegExp(`${T}\\s*おきた（[^）]+）`) })).toBeVisible();
    await expect(gToday(g)).toContainText(NAP_NOTE);
    expect(await gToday(g).innerText()).not.toMatch(JUDGE);
    await evidence(g, '02-014');
  });

  /* 典拠：要件定義書「保護者の画面に届くまでの時間」(7-2 No.5)、基本設計書「開いている画面への即時の反映（SSE）」(4-10)、詳細設計書「3秒の目標を計る」(6-7) */
  test('02-015 開いている保護者の画面に3秒以内に出る', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    if (!(await ensureNapRunning(page))) test.skip(true, '夜中のため午睡チェックを開始できない（U-01）');
    const k = await guardianContact(browser, testInfo, 'guardianKubota');
    const g = await guardianContact(browser, testInfo, 'guardian');
    const before = await gToday(g).getByRole('listitem').count();
    const row = page.getByRole('region', { name: '久保田 陸の午睡チェック' });
    await row.getByRole('button', { name: '久保田 陸のねた' }).click();
    const t0 = Date.now();
    await expect(gToday(k).getByRole('listitem').filter({ hasText: 'おひるね中' })).toBeVisible({ timeout: 10_000 });
    const elapsed = Date.now() - t0;
    testInfo.annotations.push({ type: 'note', description: `保護者の画面に出るまで ${elapsed} ms` });
    expect(elapsed).toBeLessThanOrEqual(3_000);
    await page.waitForTimeout(2_000);
    await expect(gToday(g).getByRole('listitem')).toHaveCount(before);
    await expect(g.getByRole('main')).not.toContainText('久保田');
    await evidence(k, '02-015');
  });

  /* 典拠：要件定義書「保護者へ届けるときの関所」(4-1-6) 段3・「品質要求一覧」(7-1 No.10)、基本設計書「保護者へ届けるときの関所」(2-4) の (3)・「午睡チェック」(4-8) の層の表 */
  test('02-042 異常時の記録は届かない（段3）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    if (!(await ensureNapRunning(page))) test.skip(true, '夜中のため午睡チェックを開始できない（U-01）');
    const g = await guardianContact(browser, testInfo);
    await page.getByRole('link', { name: '異常を記録する' }).click();
    await page.getByRole('combobox', { name: '園児 必須' }).selectOption({ label: TARO });
    await page.getByRole('textbox', { name: '発見時の状況 必須' }).fill('段3確認用の状況');
    await page.getByRole('textbox', { name: 'とった対応 必須' }).fill('段3確認用の対応');
    await pick(page, '保護者への連絡', 'しない');
    await page.getByRole('button', { name: '記録する' }).click();
    await expect(page.getByRole('row', { name: /段3確認用の状況/ })).toBeVisible();

    await page.waitForTimeout(3_000);
    await expect(g.getByRole('main')).not.toContainText('段3確認用');
    await expect(g.getByRole('main')).not.toContainText('異常');
    const gh = await g.context().newPage();
    await gh.goto('/guardian');
    await expect(gh.getByRole('main')).not.toContainText('段3確認用');
    await gh.getByRole('link', { name: 'チャットを開く' }).click();
    await expect(gh.getByRole('main')).not.toContainText('段3確認用');
    await evidence(g, '02-042');
  });
});

// =====================================================================
// 文と写真（段2）：宛先、園から、ひとこと、他児の名前の注意、取り消し、二重送信、XSS
// =====================================================================
test.describe('文を送る（段2）', () => {
  test.describe.configure({ mode: 'serial' });

  /*
   * 典拠：要件定義書「保護者へ届けるときの関所」(4-1-6) の (2)・「誰でも使える操作」(7-1 No.9) ⑥、基本設計書「送る時点の守り」(4-2)、
   *   図/画面詳細図「共通のダイアログと部品」(1-3 (1))・「連絡帳（園児）画面」(8-2) 項目15
   */
  test('02-016 送る前の宛先の表示（段2の守り）', async ({ page }) => {
    await login(page, 'staffSakura');
    await openChild(page);
    for (const note of [facility(page).getByRole('note', { name: '宛先' }), page.getByRole('complementary', { name: '記録する' }).getByRole('note', { name: '宛先' })]) {
      await expect(note).toContainText(`${TARO}（さくら組）`);
      await expect(note).toContainText(/父(?:・[^に]+)?に届きます/);
      // 顔写真が無い園児は、名前の1文字目を丸で示す
      expect((await note.innerText()).split(/\s+/)).toContain(TARO[0]);
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await evidence(page, '02-016');
  });

  /*
   * 典拠：要件定義書「園から」(4-2-4)・「誰でも使える操作」(7-1 No.9) ①③、基本設計書「園からのひとこと」(4-5)・「届いていない家庭の一覧（職員ダッシュボード）」(4-5)、
   *   図/画面詳細図「連絡帳（園児）画面」(8-2) 項目21・23、詳細設計書「連絡帳（園児）画面」(2-3 (3))・「連絡帳画面（保護者）」(2-6 (5))
   */
  test('02-017 園からを定型文で送る（段2）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    const before = await dashboardCount(page, '園からのひとことを送っていない園児');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    await facility(page).getByRole('button', { name: '定型文' }).click();
    const phrase = phraseButton(page);
    const text = (await phrase.innerText()).trim();
    await phrase.click();
    await facility(page).getByRole('button', { name: '送る', exact: true }).click();
    const done = toast(page, '送りました。保護者が見られる状態です。');
    await expect(done).toBeVisible();
    await expect(done.getByRole('button', { name: '取り消す' })).toBeVisible();
    await expect(nameCheckDialog(page)).toHaveCount(0);
    await expect(facility(g)).toContainText(text);
    await expect(facility(g)).not.toContainText(STAFF);
    await evidence(g, '02-017');
    await openClass(page);
    await expect(taroRow(page).getByRole('cell').last()).toContainText(new RegExp(`送った\\s*${T}`));
    expect(await dashboardCount(page, '園からのひとことを送っていない園児')).toBe(before - 1);
  });

  /*
   * 典拠：要件定義書「文章の下書き（AI）」(4-1-8) の守り・「品質要求一覧」(7-1 No.10)、基本設計書「使えないとき（AI 無しで動くこと）」(4-11)、
   *   図/画面詳細図「共通のダイアログと部品」(1-3 (6))。サーバに ANTHROPIC_API_KEY を渡していない（ハーネス）
   */
  test('02-018 AI が無くても届けられる', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    async function setAi(label: '使う' | '使わない') {
      await admin.goto('/staff/admin/settings');
      await pick(admin, 'AI の下書きを使う', label);
      await admin.getByRole('button', { name: '保存する' }).click();
      await admin.getByRole('dialog', { name: '設定を保存しますか' }).getByRole('button', { name: '保存する' }).click();
      await expect(admin.getByRole('dialog', { name: '設定を保存しますか' })).toBeHidden();
    }
    await setAi('使う');
    try {
      await login(page, 'staffSakura');
      await openChild(page);
      const aiButtons = page.getByRole('main').getByRole('button', { name: /AI|下書き|言い換え|続きの候補/ });
      // 園からは 02-017 で送ったあとなので、書く欄の定型文はひとことの欄で見る
      await expect(page.getByRole('complementary', { name: '記録する' }).getByRole('button', { name: '定型文' })).toBeVisible();
      await expect(aiButtons).toHaveCount(0);
      await evidence(page, '02-018');
      await openClass(page);
      await expect(aiButtons).toHaveCount(0);
    } finally {
      await setAi('使わない');
    }
  });

  /*
   * 典拠：要件定義書「外部の AI へ送る情報の最小化」(8 No.12)・「品質要求一覧」(7-1 No.10)、基本設計書「送る項目と置き換え」(4-11)・「使えないとき（AI 無しで動くこと）」(4-11)
   * 画面から見える範囲で確かめる：AI のボタンが無く、送るあいだに AI の経路（POST /api/ai/…）へ何も送られず、AI 無しで届く
   */
  test('02-019 AI に氏名が送られない（画面から見える範囲）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    const aiPosts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/ai/')) aiPosts.push(r.url());
    });
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    const side = page.getByRole('complementary', { name: '記録する' });
    await expect(page.getByRole('main').getByRole('button', { name: /AI|下書き|言い換え|続きの候補/ })).toHaveCount(0);
    await side.getByRole('button', { name: '定型文' }).click();
    const phrase = phraseButton(page);
    const text = (await phrase.innerText()).trim();
    await phrase.click();
    await side.getByRole('button', { name: 'ひとことを送る' }).click();
    await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
    await expect(gToday(g).getByRole('listitem').filter({ hasText: text })).toBeVisible();
    expect(aiPosts).toEqual([]);
    await evidence(g, '02-019');
  });

  /*
   * 典拠：基本設計書「活動のひとこと・写真」(4-5)・「保護者へ届けるときの関所」(2-4) 段2、図/画面詳細図「連絡帳（園児）画面」(8-2) 項目13・16・
   *   「連絡帳画面（保護者）」(8-3) の出さないもの、詳細設計書「連絡帳（園児）画面」(2-3 (4))
   */
  test('02-020 活動のひとことを送る（段2）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    await sendComment(page, '砂場でスコップを使って遊びました。');
    await expect(nameCheckDialog(page)).toHaveCount(0);
    await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
    const staffItem = sToday(page).getByRole('listitem').filter({ hasText: '砂場でスコップを使って遊びました。' });
    await expect(staffItem).toContainText(new RegExp(T));
    await expect(staffItem).toContainText(STAFF);
    const item = gToday(g).getByRole('listitem').filter({ hasText: '砂場でスコップを使って遊びました。' });
    await expect(item).toContainText(new RegExp(T));
    await expect(item).not.toContainText(STAFF);
    await evidence(g, '02-020');
  });

  /* 典拠：基本設計書「送る時点の守り」(4-2)、図/画面詳細図「共通のダイアログと部品」(1-3 (1)) 項目3、詳細設計書「連絡帳（園児）画面」(2-3 (3)) */
  test('02-022 保護者がまだ登録していない園児', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    await ensureKensaAoi(admin);
    await login(page, 'staffSakura');
    await openChild(page, KENSA.name);
    await expect(facility(page).getByRole('note', { name: '宛先' })).toContainText('まだ保護者が登録していません（登録すると読めます）');
    await facility(page).getByRole('button', { name: '定型文' }).click();
    await page.getByRole('dialog', { name: '定型文を選ぶ' }).getByRole('button', { name: '明日もよろしくお願いします。' }).click();
    await facility(page).getByRole('button', { name: '送る', exact: true }).click();
    await expect(toast(page, '送りました。保護者が登録すると読めます。')).toBeVisible();
    await evidence(page, '02-022');
  });

  /*
   * 典拠：要件定義書「データ参照範囲の制限」(8 No.6)・「保護者へ届けるときの関所」(4-1-6)、基本設計書「権限と参照範囲の判定」(4-2)・「連絡帳の閲覧（保護者）」(4-5)
   * 保護者Q の子（村田 美咲）もさくら組のため、クラスのようすは見ない
   */
  test('02-023 ほかの家庭には届かない', async ({ browser }, testInfo) => {
    const q = await openWindow(browser, testInfo, 'guardianMurata');
    await expect(q.getByRole('region', { name: `${ACCOUNTS.guardianMurata.children[0].name}さんのきょう` })).toBeVisible();
    await expect(q.getByRole('region', { name: new RegExp(TARO) })).toHaveCount(0);
    await expect(q.getByRole('main')).not.toContainText(TARO);
    await q.getByRole('link', { name: '連絡帳を開く' }).first().click();
    await expect(q.getByRole('heading', { name: /の連絡帳$/, level: 1 })).toBeVisible();
    for (const text of ['砂場でスコップを使って遊びました。', TARO, 'おひるね中']) await expect(q.getByRole('main')).not.toContainText(text);
    await evidence(q, '02-023');
  });

  /*
   * 典拠：要件定義書「保護者へ届けるときの関所」(4-1-6) の (2)・「品質要求一覧」(7-1 No.10)、基本設計書「送る時点の守り」(4-2)、
   *   図/画面詳細図「共通のダイアログと部品」(1-3 (3))、詳細設計書「他児の名前の照合」(4-5 (2))
   */
  test('02-024 他児の名前の注意（ひとこと）', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    await ensureKensaAoi(admin);
    await login(page, 'staffSakura');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    await sendComment(page, 'あおいちゃんと砂場で遊びました。');
    const dialog = nameCheckDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(new RegExp(`ほかのお子さんの名前（[^）]*${KENSA.name}[^）]*）が入っています。このまま送りますか。`));
    await expect(dialog.locator('mark', { hasText: 'あおいちゃん' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '直す' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'このまま送る' })).toBeVisible();
    await expect(gToday(g)).not.toContainText('あおいちゃん');
    await evidence(page, '02-024');
  });

  /* 典拠：図/画面詳細図「共通のダイアログと部品」(1-3 (3)) 項目3、図/画面遷移図「連絡帳」(3) */
  test('02-025 注意から「直す」', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    await sendComment(page, 'あおいちゃんと砂場で遊びました。');
    await nameCheckDialog(page).getByRole('button', { name: '直す' }).click();
    await expect(nameCheckDialog(page)).toBeHidden();
    const box = page.getByRole('complementary', { name: '記録する' }).getByRole('textbox', { name: '活動のひとこと' });
    await expect(box).toHaveValue('あおいちゃんと砂場で遊びました。');
    await expect(gToday(g)).not.toContainText('あおいちゃん');
    await sendComment(page, '砂場で遊びました。');
    await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
    await expect(nameCheckDialog(page)).toHaveCount(0);
    await expect(gToday(g).getByRole('listitem').filter({ hasText: new RegExp(`${T}\\s*砂場で遊びました。`) })).toBeVisible();
    await evidence(g, '02-025');
  });

  /* 典拠：基本設計書「送る時点の守り」(4-2)、図/画面詳細図「共通のダイアログと部品」(1-3 (3)) 項目4、詳細設計書「他児の名前の照合」(4-5 (2)) ⑥ */
  test('02-026 注意から「このまま送る」', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    await sendComment(page, 'あおいちゃんと砂場で遊びました。');
    await nameCheckDialog(page).getByRole('button', { name: 'このまま送る' }).click();
    await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
    await expect(gToday(g).getByRole('listitem').filter({ hasText: 'あおいちゃんと砂場で遊びました。' })).toBeVisible();
    await evidence(g, '02-026');
  });

  /* 典拠：詳細設計書「他児の名前の照合」(4-5 (2)) ④（宛先の子の名前に当たった部分を数えない）。C001 の呼び名は「たっくん」（【呼び名】） */
  test('02-027 宛先の子の呼び名だけなら注意を出さない', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    await admin.goto('/staff/children/C001/edit');
    const nickname = await admin.getByRole('group', { name: '呼び名' }).getByRole('textbox').inputValue();
    expect(nickname, '【呼び名】C001 の呼び名が空').not.toBe('');
    await login(page, 'staffSakura');
    await openChild(page);
    await sendComment(page, `${nickname}が自分で手を洗いました。`);
    await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
    await expect(nameCheckDialog(page)).toHaveCount(0);
    await evidence(page, '02-027');
  });

  /* 典拠：基本設計書「園からのひとこと」(4-5)・「取り消し・訂正」(4-2)、詳細設計書「連絡帳（園児）画面」(2-3 (3))・「`POST /api/contact/{kind}/{id}/correct`」(4-7 (1)) */
  test('02-028 園からを直すときも照合を通る', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    await facility(page).getByRole('button', { name: '直す', exact: true }).click();
    const box = facility(page).getByRole('textbox');
    const current = await box.inputValue();
    await box.fill(`${current}${KENSA.name}さんとも遊びました。`);
    await facility(page).getByRole('button', { name: '直して送る' }).click();
    await expect(nameCheckDialog(page)).toContainText(KENSA.name);
    await nameCheckDialog(page).getByRole('button', { name: 'このまま送る' }).click();
    await expect(facility(g)).toContainText(`${KENSA.name}さんとも遊びました。`);
    await expect(facility(g)).toContainText(new RegExp(`訂正しました（${T}）`));
    await evidence(g, '02-028');
  });

  /*
   * 典拠：要件定義書「取り消し・訂正」(4-2-5)、基本設計書「取り消し・訂正」(4-2)・「メッセージ一覧」(4-12)、図/画面詳細図「共通のダイアログと部品」(1-3 (4))、
   *   詳細設計書「きょうのようすの出来事・クラスのようす・園から」(3-2)
   */
  test('02-050 送ったひとことを取り消す', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openChild(page);
    // 保護者Pが 02-020 より後に連絡帳画面を開いている
    const g = await guardianContact(browser, testInfo);
    await expect(gToday(g).getByRole('listitem').filter({ hasText: '砂場でスコップを使って遊びました。' })).toBeVisible();
    const confirm = await cancelTimelineItem(page, '砂場でスコップを使って遊びました。');
    // 読んでいる家庭の数は、確認の窓が開いたあとに読み込まれて出る（T13 の試しの回で、開いた直後の文字には無かった）。出るまで待ってから読む
    const readers = /いま保護者\s*(\d+)\s*家庭（(\d+)\s*名）が読んでいます。\s*取り消しても、読まれた内容は取り消せません。/;
    await expect(confirm, '読んでいる家庭の数の文').toContainText(readers);
    const m = readers.exec(await confirm.innerText());
    expect(m, '読んでいる家庭の数の文').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1);
    await confirm.getByRole('button', { name: '取り消す' }).click();
    await expect(gToday(g).getByRole('listitem').filter({ hasText: '砂場でスコップを使って遊びました。' })).toHaveCount(0);
    await expect(sToday(page).getByRole('listitem').filter({ hasText: '砂場でスコップを使って遊びました。' })).toHaveCount(0);
    const gh = await g.context().newPage();
    await gh.goto('/guardian');
    await expect(gh.getByRole('main')).not.toContainText('砂場でスコップを使って遊びました。');
    await evidence(g, '02-050');
  });

  /*
   * 典拠：基本設計書「園からのひとこと」(4-5)・「取り消し・訂正」(4-2)、図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目17・「連絡帳（クラス）画面」(8-1) 項目16、
   *   詳細設計書「きょうのようすの出来事・クラスのようす・園から」(3-2) の園から
   */
  test('02-051 園からを取り消すと未送信に戻る', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    const before = await dashboardCount(page, '園からのひとことを送っていない園児');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    await facility(page).getByRole('button', { name: '取り消す', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'この記録を取り消しますか' });
    await confirm.getByRole('button', { name: '取り消す' }).click();
    await expect(facility(g)).toContainText('まだ届いていません');
    await expect(facility(page).getByRole('textbox', { name: '園からのひとこと' })).toBeVisible();
    await evidence(g, '02-051');
    await openClass(page);
    await expect(taroRow(page).getByRole('link', { name: `${TARO}の園からを書く` })).toBeVisible();
    expect(await dashboardCount(page, '園からのひとことを送っていない園児')).toBe(before + 1);
  });

  /*
   * 典拠：授業の雛形「テスト対象」(1.5) の二重送信の防止、基本設計書「園からのひとこと」(4-5)（園児・日に1件）、
   *   詳細設計書「押したときの処理の型（楽観的更新はしない）」(2-0 (2))・「`PUT /api/contact/children/{childID}/facility`」(4-5 (1))
   */
  test('02-054 二重送信：園からの「送る」の連打', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    await facility(page).getByRole('textbox', { name: '園からのひとこと' }).fill('今日も一日ありがとうございました。');
    await facility(page).getByRole('button', { name: '送る', exact: true }).dblclick();
    await expect(facility(page)).toContainText(new RegExp(`送った\\s*${T}`));
    await page.waitForTimeout(3_000);
    await expect(facility(page).getByText(/送った/)).toHaveCount(1);
    await expect(facility(g).getByText('今日も一日ありがとうございました。')).toHaveCount(1);
    await evidence(g, '02-054');
  });

  /* 典拠：授業の雛形「テスト対象」(1.5) のクロスサイトスクリプティング対策、基本設計書「園からのひとこと」(4-5) */
  test('02-059 XSS：園から', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    const dialogs = watchDialogs(page, g);
    const xss = `<script>alert('xss')</script><b>太字</b>`;
    await facility(page).getByRole('button', { name: '直す', exact: true }).click();
    await facility(page).getByRole('textbox').fill(xss);
    await facility(page).getByRole('button', { name: '直して送る' }).click();
    await expect(facility(g)).toContainText(xss);
    await expect(facility(g)).toContainText(new RegExp(`訂正しました（${T}）`));
    await expect(facility(page)).toContainText(xss);
    for (const scope of [facility(g), facility(page)]) await expect(scope.locator('b', { hasText: '太字' })).toHaveCount(0);
    const gh = await g.context().newPage();
    await gh.goto('/guardian');
    await expect(gh.getByRole('region', { name: `${TARO}さんのきょう` })).toContainText('<script>');
    expect(dialogs).toEqual([]);
    await evidence(g, '02-059');
  });

  /* 典拠：授業の雛形「テスト対象」(1.5) の二重送信の防止、詳細設計書「押したときの処理の型（楽観的更新はしない）」(2-0 (2)) */
  test('02-055 二重送信：ひとことの「送る」の連打', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    const side = page.getByRole('complementary', { name: '記録する' });
    await side.getByRole('textbox', { name: '活動のひとこと' }).fill('二重送信の確認です。');
    await side.getByRole('button', { name: 'ひとことを送る' }).dblclick();
    await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
    await page.waitForTimeout(3_000);
    await expect(sToday(page).getByRole('listitem').filter({ hasText: '二重送信の確認です。' })).toHaveCount(1);
    await expect(gToday(g).getByRole('listitem').filter({ hasText: '二重送信の確認です。' })).toHaveCount(1);
    await evidence(g, '02-055');
  });

  /* 典拠：授業の雛形「テスト対象」(1.5) の二重送信の防止 */
  test('02-056 二重送信：送ったあとの再読み込み（職員）', async ({ page }) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const dialogs = watchDialogs(page);
    await expect(sToday(page).getByRole('listitem').filter({ hasText: '二重送信の確認です。' })).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: TARO, level: 1 })).toBeVisible();
    await page.waitForTimeout(3_000);
    await expect(sToday(page).getByRole('listitem').filter({ hasText: '二重送信の確認です。' })).toHaveCount(1);
    expect(dialogs).toEqual([]);
    await evidence(page, '02-056');
  });
});

// =====================================================================
// クラスのようす（段2。クラスあて）
// =====================================================================
test.describe('クラスのようす（段2）', () => {
  /**
   * 連絡帳（クラス）画面のクラスのようすの欄（図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目18）。
   * クラスのようすは詳細設計書「本版で詳しくする範囲」(1-2) で「要点（次の版）」。画面に欄が無ければ未実施にする（rules.md「次の版の機能」）
   */
  async function classNoteBox(page: Page) {
    const box = page.getByRole('textbox', { name: /クラスのようす/ });
    await page.waitForTimeout(1_000);
    if ((await box.count()) === 0) test.skip(true, CLASS_NOTE_NEXT);
    await expect(box).toBeVisible();
    return box;
  }

  /*
   * 典拠：要件定義書「きょうのようす」(4-2-3)、基本設計書「クラスのようす」(4-5)・「送る時点の守り」(4-2)、
   *   図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目18・21・22、詳細設計書「連絡帳（クラス）画面」(2-2 (8))
   */
  test('02-021 クラスのようすを送る（段2）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const box = await classNoteBox(page);
    await box.fill('園庭でしゃぼん玉をしました。');
    await expect(page.getByRole('main')).toContainText(/さくら組の \d+ 家庭に届きます/);
    await page.getByRole('main').getByRole('button', { name: '送る', exact: true }).click();
    await expect(toast(page, /さくら組の \d+ 家庭に送りました/)).toBeVisible();
    await expect(gToday(g)).toContainText('クラスのようす');
    await expect(gToday(g)).toContainText('園庭でしゃぼん玉をしました。');
    await evidence(g, '02-021');
  });

  /* 典拠：基本設計書「送る時点の守り」(4-2)（クラスあて・園全体では在籍園児の全員）、詳細設計書「他児の名前の照合」(4-5 (2)) ④ */
  test('02-029 クラスのようすは在籍全員が照合の相手', async ({ page }) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const box = await classNoteBox(page);
    await box.fill('たっくんがしゃぼん玉を追いかけました。');
    await page.getByRole('main').getByRole('button', { name: '送る', exact: true }).click();
    await expect(nameCheckDialog(page)).toContainText(TARO);
    await nameCheckDialog(page).getByRole('button', { name: '直す' }).click();
    await expect(nameCheckDialog(page)).toBeHidden();
    await evidence(page, '02-029');
  });

  /* 典拠：授業の雛形「テスト対象」(1.5) のクロスサイトスクリプティング対策、基本設計書「クラスのようす」(4-5) */
  test('02-060 XSS：クラスのようす', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const dialogs = watchDialogs(page, g);
    const box = await classNoteBox(page);
    await box.fill(XSS);
    await page.getByRole('main').getByRole('button', { name: '送る', exact: true }).click();
    await expect(gToday(g)).toContainText(XSS);
    await expect(gToday(g).locator('b', { hasText: '太字' })).toHaveCount(0);
    await expect(gToday(g).locator('img[src="x"]')).toHaveCount(0);
    expect(dialogs).toEqual([]);
    await evidence(g, '02-060');
  });
});

// =====================================================================
// 写真（段2）：写っている子を選ぶ・写真の同意で止める
// =====================================================================
test.describe('写真（段2）', () => {
  test.describe.configure({ mode: 'serial' });

  /*
   * 典拠：基本設計書「写真の同意で止める規則」(4-2)・「メッセージ一覧」(4-12)、図/画面詳細図「共通のダイアログと部品」(1-3 (2)) 項目2・3・8、詳細設計書「写真」(3-3)
   */
  test('02-030 写っている子を選ぶまで送れない', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    await ensureKensaAoi(admin);
    await login(page, 'staffSakura');
    await openClass(page);
    const { picker } = await openPhotoPicker(page, await makePicture(page, 'jpeg'));
    const kids = picker.getByRole('group', { name: '写っている子' });
    await expect(kids.getByRole('button', { name: TARO })).toBeVisible();
    await expect(kids.getByRole('button', { name: KENSA.name })).toBeVisible();
    // 顔写真が無い園児は、名前の1文字目を丸で示す
    expect((await kids.getByRole('button', { name: TARO }).innerText()).replace(/\s+/g, '')).toBe(`${TARO[0]}${TARO.replace(/\s/g, '')}`);
    await expect(picker.getByRole('button', { name: '子どもは写っていない' })).toBeVisible();
    await expect(picker).toContainText(/写っている子を選んでください。子どもが写っていないときは[「『]子どもは写っていない[」』]を選んでください。/);
    await expect(picker.getByRole('button', { name: '決める' })).toBeDisabled();
    await evidence(page, '02-030');
  });

  /*
   * 典拠：要件定義書「写真の利用同意」(4-1-3)・「保護者へ届けるときの関所」(4-1-6) の (2)・「品質要求一覧」(7-1 No.10)、基本設計書「写真の同意で止める規則」(4-2)、
   *   詳細設計書「連絡帳（クラス）画面」(2-2 (7)) ②
   */
  test('02-031 同意が「園内記録」の子だけが写る写真は送れない', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    await setConsent(admin, 'C001', '園内記録のみ');
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const { dialog, picker } = await openPhotoPicker(page, await makePicture(page, 'jpeg'));
    await picker.getByRole('button', { name: new RegExp(`^${TARO}`) }).click();
    await expect(picker.getByRole('button', { name: new RegExp(`^${TARO}`) })).toContainText('園内記録のみ');
    const decide = picker.getByRole('button', { name: '決める' });
    if (await decide.isEnabled()) {
      await decide.click();
      await expect(dialog.getByRole('button', { name: '送る', exact: true })).toBeDisabled();
    }
    await expect(gPhotos(g)).toHaveCount(0);
    await evidence(page, '02-031');
  });

  /* 典拠：基本設計書「写真の同意で止める規則」(4-2)・「メッセージ一覧」(4-12)、詳細設計書「`POST /api/contact/photos`（写真）」(4-4 (2))。画面の確かめを通さずに経路へ送る */
  test('02-032 同意が足りない写真はサーバが止める', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    await setConsent(admin, 'C001', '園内記録のみ');
    await login(page, 'staffSakura');
    const g = await guardianContact(browser, testInfo);
    const picture = (await makePicture(page, 'jpeg')).toString('base64');
    const res = await postPhoto(page, { subject_child_ids: 'C001' }, { name: 'plain.jpg', type: 'image/jpeg', base64: picture });
    expect(res.status).toBe(400);
    expect((res.json as { message?: string } | null)?.message ?? '').toMatch(
      new RegExp(`${TARO}さんは写真の同意が[『「]園内記録として保持[』」]のため送れません。写真を外すか、写っている子を見直してください。`),
    );
    await g.reload();
    await expect(gPhotos(g)).toHaveCount(0);
    await evidence(g, '02-032');
  });

  /*
   * 典拠：基本設計書「写真の同意で止める規則」(4-2)・「活動のひとこと・写真」(4-5)、図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目16、
   *   詳細設計書「連絡帳（クラス）画面」(2-2 (7)) ③・「`GET /api/contact/children/{childID}`」(4-3 (1))
   */
  test('02-033 1人が写る写真（同意2）を送る', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    await setConsent(admin, 'C001', '自児保護者へ共有まで');
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const { dialog, picker } = await openPhotoPicker(page, await makePicture(page, 'jpeg'));
    await choose(picker, [TARO]);
    await dialog.getByRole('button', { name: '送る', exact: true }).click();
    await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
    await expect(taroRow(page).getByRole('cell', { name: new RegExp(`${TARO}のひとこと`) })).toContainText(/\d+\s*件/);
    const photo = gPhotos(g).first();
    await expect(photo).toBeVisible();
    await expect(gToday(g).getByRole('listitem').filter({ has: g.getByRole('button', { name: /の写真を大きく見る$/ }) }).first()).not.toContainText(TARO);
    await photo.click();
    await expect(g.getByRole('dialog').last()).toBeVisible();
    await evidence(g, '02-033');
  });

  /* 典拠：要件定義書「保護者へ届けるときの関所」(4-1-6) の (2)、基本設計書「写真の同意で止める規則」(4-2)、詳細設計書「連絡帳（クラス）画面」(2-2 (7)) ② */
  test('02-034 2人が写る写真は全員の同意が要る', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    await ensureKensaAoi(admin);
    await setConsent(admin, 'C001', '自児保護者へ共有まで');
    await login(page, 'staffSakura');
    await openClass(page);
    const { dialog, picker } = await openPhotoPicker(page, await makePicture(page, 'jpeg'));
    await picker.getByRole('button', { name: new RegExp(`^${TARO}`) }).click();
    await picker.getByRole('button', { name: new RegExp(`^${KENSA.name}`) }).click();
    await expect(picker.getByRole('button', { name: new RegExp(`^${TARO}`) })).toContainText('ほかの家庭には出せない');
    const decide = picker.getByRole('button', { name: '決める' });
    if (await decide.isEnabled()) {
      await decide.click();
      await expect(dialog.getByRole('button', { name: '送る', exact: true })).toBeDisabled();
    }
    await evidence(page, '02-034');
  });

  /* 典拠：基本設計書「写真の同意で止める規則」(4-2)、図/画面詳細図「共通のダイアログと部品」(1-3 (2)) 項目4 */
  test('02-035 2人とも同意3なら、選んだ全員の連絡帳に出る', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    const kensaId = await ensureKensaAoi(admin);
    await setConsent(admin, 'C001', '他保護者にも見える場まで');
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const before = await gPhotos(g).count();
    const { dialog, picker } = await openPhotoPicker(page, await makePicture(page, 'jpeg'));
    await choose(picker, [TARO, KENSA.name]);
    await expect(dialog).toContainText(TARO);
    await expect(dialog).toContainText(KENSA.name);
    await dialog.getByRole('button', { name: '送る', exact: true }).click();
    await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
    await expect(gPhotos(g)).toHaveCount(before + 1);
    await evidence(g, '02-035');
    await page.goto(`/staff/contact/${kensaId}`);
    await expect(sToday(page).getByRole('listitem').filter({ hasText: '写真' }).first()).toBeVisible();
  });

  /* 典拠：基本設計書「写真の同意で止める規則」(4-2)（子どもは写っていない：条件なし）、図/画面詳細図「共通のダイアログと部品」(1-3 (2)) 項目3 */
  test('02-036 子どもが写っていない写真', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    await setConsent(admin, 'C001', '園内記録のみ');
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const before = await gPhotos(g).count();
    const { dialog, picker } = await openPhotoPicker(page, await makePicture(page, 'jpeg'));
    await picker.getByRole('button', { name: '子どもは写っていない' }).click();
    await picker.getByRole('button', { name: `${TARO}に届ける` }).click();
    await picker.getByRole('button', { name: '決める' }).click();
    await dialog.getByRole('button', { name: '送る', exact: true }).click();
    await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
    await expect(gPhotos(g)).toHaveCount(before + 1);
    await evidence(g, '02-036');
  });

  /*
   * 典拠：基本設計書「送る時点の守り」(4-2)、詳細設計書「`POST /api/contact/photos`（写真）」(4-4 (2))・「連絡帳（クラス）画面」(2-2 (7))・「他児の名前の照合」(4-5 (2)) ④
   */
  test('02-037 写真に添える文も、届く家庭ごとに照合する', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    await ensureKensaAoi(admin);
    await setConsent(admin, 'C001', '他保護者にも見える場まで');
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const before = await gPhotos(g).count();
    const { dialog, picker } = await openPhotoPicker(page, await makePicture(page, 'jpeg'));
    await choose(picker, [TARO, KENSA.name]);
    await dialog.getByRole('textbox', { name: /添える文/ }).fill('あおいちゃんと一緒に遊びました。');
    await dialog.getByRole('button', { name: '送る', exact: true }).click();
    await expect(nameCheckDialog(page)).toContainText(KENSA.name);
    await nameCheckDialog(page).getByRole('button', { name: '直す' }).click();
    await expect(nameCheckDialog(page)).toBeHidden();
    await expect(dialog.getByRole('textbox', { name: /添える文/ })).toHaveValue('あおいちゃんと一緒に遊びました。');
    await page.waitForTimeout(2_000);
    await expect(gPhotos(g)).toHaveCount(before);
    await evidence(page, '02-037');
  });

  /* 典拠：基本設計書「権限と参照範囲の判定」(4-2)、詳細設計書「`GET /api/contact/photos/{id}`（写真の実体）」(4-4 (3))・「本書で足す文言」(4-1 (6)) */
  test('02-038 写真の実体は写っている子の家庭だけが読める', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    await setConsent(admin, 'C001', '自児保護者へ共有まで');
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const q = await openWindow(browser, testInfo, 'guardianMurata');
    const before = await gPhotos(g).count();
    const { dialog, picker } = await openPhotoPicker(page, await makePicture(page, 'jpeg'));
    await choose(picker, [TARO]);
    await dialog.getByRole('textbox', { name: /添える文/ }).fill('実体の確かめの写真です。');
    await dialog.getByRole('button', { name: '送る', exact: true }).click();
    await expect(gPhotos(g)).toHaveCount(before + 1);
    const item = gToday(g).getByRole('listitem').filter({ hasText: '実体の確かめの写真です。' });
    const src = await item.locator('img').first().getAttribute('src');
    expect(src).toMatch(/\/api\/contact\/photos\//);
    expect((await api(g, 'GET', src!)).status).toBe(200);
    const other = await api(q, 'GET', src!);
    expect(other.status).toBe(403);
    expect(other.text).toContain('この写真は開けません。');
    // 取り消すと、写っている子の家庭も読めなくなる
    await openChild(page);
    const confirm = await cancelTimelineItem(page, '実体の確かめの写真です。');
    await confirm.getByRole('button', { name: '取り消す' }).click();
    await expect(item).toHaveCount(0);
    expect((await api(g, 'GET', src!)).status).toBe(403);
    await evidence(g, '02-038');
  });
});

// =====================================================================
// 保護者の閲覧（保護者ホームの「きょう」、新着、園にたずねる）
// =====================================================================
test.describe('保護者の閲覧', () => {
  // 3つのケースはどれも自分で前提を作るので、前のケースに頼らない（serial にしない）

  /*
   * 典拠：要件定義書「連絡帳」(4-2) の保護者ホームの「きょう」、基本設計書「画面基本構成」(3-5) の「保護者ホームの「きょう」」、
   *   図/画面詳細図「保護者ホーム」(2-7) 項目1〜5、詳細設計書「保護者ホーム（「きょう」）」(2-5 (2))
   * 前提はこのテストの中で作る（家庭から→確認しました、おやつ、ねた、園から）
   */
  test('02-039 保護者ホームの「きょう」', async ({ page, browser }, testInfo) => {
    const g = await guardianContact(browser, testInfo);
    const home = g.getByRole('region', { name: '家庭から' });
    await pick(home, '朝ごはん', 'ぜんぶ');
    await sendHome(g);
    await expect(toast(g, '送りました')).toBeVisible();
    await login(page, 'staffSakura');
    await openClass(page);
    await taroRow(page).getByRole('button', { name: `${TARO}の家庭からを確認しました` }).click();
    await page.getByRole('group', { name: '食事の区分' }).getByRole('button', { name: 'おやつ', exact: true }).click();
    await page.getByRole('button', { name: `${TARO}のおやつをぜんぶ` }).click();
    await expect(toast(page, '保護者が見られる状態です')).toBeVisible();
    const napped = await ensureNapRunning(page);
    if (napped) await page.getByRole('region', { name: `${TARO}の午睡チェック` }).getByRole('button', { name: `${TARO}のねた` }).click();
    await openChild(page);
    await facility(page).getByRole('textbox', { name: '園からのひとこと' }).fill('今日も一日ありがとうございました。');
    await facility(page).getByRole('button', { name: '送る', exact: true }).click();
    await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();

    await g.goto('/guardian');
    const today = g.getByRole('region', { name: `${TARO}さんのきょう` });
    const [, mm, dd] = jstToday().split('-').map(Number);
    await expect(today).toContainText('さくら組');
    await expect(today).toContainText(`${mm}月${dd}日`);
    await expect(today).toContainText(new RegExp(`園が確認しました（${T}）`));
    if (napped) {
      await expect(today).toContainText(new RegExp(`${T}\\s*おひるね中`));
      await expect(today).toContainText(NAP_NOTE);
    }
    await expect(today).toContainText(/おやつ\s*ぜんぶ/);
    await expect(today).toContainText('今日も一日ありがとうございました。');
    await expect(today.getByRole('link', { name: /続きを読む/ }).or(today.getByRole('button', { name: /続きを読む/ }))).toBeVisible();
    await expect(today.getByRole('img')).toHaveCount(0);
    const text = await today.innerText();
    expect(text).not.toMatch(JUDGE);
    expect(text).not.toContain(STAFF);
    await evidence(g, '02-039');
    if (!napped) testInfo.annotations.push({ type: 'note', description: '午睡チェックを開始できず、午睡の行は見ていない（U-01）' });
  });

  /*
   * 典拠：基本設計書「画面基本構成」(3-5) の「保護者ホームの「きょう」」、図/画面詳細図「保護者ホーム」(2-7) 項目6・「連絡帳画面（保護者）」(8-3) 項目14、
   *   詳細設計書「保護者ホーム（「きょう」）」(2-5 (1))・「連絡帳画面（保護者）」(2-6 (5))。新着の数の文言は U-08 のため、数だけを見る
   */
  test('02-040 新着の印', async ({ page, browser }, testInfo) => {
    const g = await openWindow(browser, testInfo, 'guardian');
    const today = g.getByRole('region', { name: `${TARO}さんのきょう` });
    await expect(today).toBeVisible();
    await login(page, 'staffSakura');
    await openClass(page);
    // 保護者が開いた時刻より後の記録にする（同じ秒に記録すると、開いた時刻と前後が付かない）
    await page.waitForTimeout(2_000);
    await page.getByRole('button', { name: `${TARO}の排せつ うんち` }).click();
    await expect(today).toContainText(/(?:新着|新しく)\s*1(?:\s*件)?/);
    await today.getByRole('link', { name: '連絡帳を開く' }).click();
    await expect(gToday(g).getByRole('listitem').filter({ hasText: 'うんち' })).toContainText('新');
    await evidence(g, '02-040');
    await g.getByRole('link', { name: /ホームへ/ }).click();
    await expect(today).toBeVisible();
    await expect(today).not.toContainText(/(?:新着|新しく)\s*\d/);
  });

  /* 典拠：基本設計書「園にたずねる」(4-5)、図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目18、図/画面遷移図「連絡帳」(3)、詳細設計書「連絡帳画面（保護者）」(2-6 (7)) */
  test('02-041 この日の連絡帳について園にたずねる', async ({ page, browser }, testInfo) => {
    const g = await guardianContact(browser, testInfo);
    const ask = g.getByRole('button', { name: 'この日の連絡帳について園にたずねる' }).or(g.getByRole('link', { name: 'この日の連絡帳について園にたずねる' }));
    await expect(ask, '連絡帳画面に「この日の連絡帳について園にたずねる」が見つからない').toBeVisible();
    await ask.click();
    const [, mm, dd] = jstToday().split('-').map(Number);
    await expect(g.getByRole('main')).toContainText(`${mm}月${dd}日の連絡帳について`);
    await g.getByRole('textbox').last().fill('テストの質問です。');
    await g.getByRole('button', { name: /送る|送信/ }).last().click();
    await login(page, 'staffSakura');
    await page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: 'チャット' }).click();
    await page.getByText(`${TARO}の保護者`).first().click();
    const quote = page.getByText(`${mm}月${dd}日の連絡帳について`).last();
    await expect(quote).toBeVisible();
    await quote.click();
    await expect(page.getByRole('heading', { name: TARO, level: 1 })).toBeVisible();
    await evidence(page, '02-041');
  });
});

// =====================================================================
// 園内に留めるもの（段3）：日誌・ヒヤリハット・保護者の応答
// =====================================================================
test.describe('園内に留めるもの（段3）', () => {
  /*
   * 典拠：要件定義書「保護者へ届けるときの関所」(4-1-6) 段3・「連絡帳」(4-2)、基本設計書「保護者へ届けるときの関所」(2-4) の (3)・(4)、「システムと業務の関係」(2-1)
   */
  test('02-043 日誌は承認しても届かない（段3）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await page.goto('/staff/diary/new');
    await page.getByRole('combobox', { name: '対象の園児 必須' }).selectOption({ label: TARO });
    await page.getByRole('textbox', { name: '本文 必須' }).fill('段3確認用の日誌本文');
    await page.getByRole('button', { name: '確認へ進む' }).click();
    await page.getByRole('button', { name: '申請する' }).click();
    await expect(page.getByRole('heading', { name: 'この内容で申請します' })).toBeHidden();

    const admin = await openWindow(browser, testInfo, 'admin');
    await admin.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '承認待ち' }).click();
    await admin.getByRole('row', { name: new RegExp(`個人日誌.*${TARO}.*${STAFF}`) }).getByRole('link', { name: '承認へ' }).click();
    await admin.getByRole('button', { name: /^承認/ }).first().click();
    const confirm = admin.getByRole('dialog');
    if ((await confirm.count()) > 0) await confirm.last().getByRole('button', { name: /承認/ }).click();
    await expect(admin.getByText(/承認しました|承認済み/).first()).toBeVisible();

    const g = await openWindow(browser, testInfo, 'guardian');
    await expect(g.getByRole('main')).not.toContainText('段3確認用');
    for (const link of ['連絡帳を開く', /成長の記録/, 'チャットを開く']) {
      await g.goto('/guardian');
      await g.getByRole('link', { name: link }).first().click();
      await expect(g.getByRole('main')).not.toContainText('段3確認用');
      await expect(g.getByRole('main')).not.toContainText(/申請|承認/);
    }
    await g.goto('/guardian');
    await g.getByRole('link', { name: '連絡帳を開く' }).first().click();
    await evidence(g, '02-043');
  });

  /* 典拠：要件定義書「保護者へ届けるときの関所」(4-1-6) 段3、基本設計書「保護者へ届けるときの関所」(2-4) の (3) */
  test('02-044 ヒヤリハットは届かない（段3）', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await page.goto('/staff/diary/new');
    await page.getByRole('radiogroup', { name: '記録種別' }).getByText('ヒヤリハット', { exact: true }).click();
    await page.getByRole('combobox', { name: '対象の園児 必須' }).selectOption({ label: TARO });
    await page.getByRole('textbox', { name: '発生日時 必須' }).fill(`${jstToday()}T00:00`);
    await page.getByRole('textbox', { name: '場所 必須' }).fill('園庭');
    await page.getByRole('textbox', { name: '状況 必須' }).fill('段3確認用のヒヤリハット');
    await page.getByRole('textbox', { name: 'とった対応 必須' }).fill('段3確認用の対応');
    await page.getByRole('radiogroup', { name: '保護者へ伝えたこと' }).getByText('伝えていない', { exact: true }).click();
    await page.getByRole('button', { name: '確認へ進む' }).click();
    await page.getByRole('button', { name: /申請する|保存する|記録する/ }).click();
    await expect(page.getByRole('button', { name: /申請する|保存する|記録する/ })).toBeHidden();

    const g = await openWindow(browser, testInfo, 'guardian');
    await expect(g.getByRole('main')).not.toContainText('段3確認用');
    for (const link of ['連絡帳を開く', 'チャットを開く']) {
      await g.goto('/guardian');
      await g.getByRole('link', { name: link }).first().click();
      await expect(g.getByRole('main')).not.toContainText('段3確認用');
      await expect(g.getByRole('main')).not.toContainText('ヒヤリハット');
    }
    await evidence(g, '02-044');
  });

  /*
   * 典拠：基本設計書「保護者へ届けるときの関所」(2-4) の (3)・「画面とサーバの間のインタフェース」(4-2)、
   *   詳細設計書「`GET /api/contact/children/{childID}`」(4-3 (1)) の保護者の応答から落とすもの・「判定の関数」(4-1 (2))
   * 前提として、家庭から→確認しました、ひとこと、ねた・入眠時の体温（午睡チェックが実施中にできるとき）を作る
   */
  test('02-045 保護者の応答に段3が入らない', async ({ page, browser }, testInfo) => {
    const g = await guardianContact(browser, testInfo);
    await pick(g.getByRole('region', { name: '家庭から' }), '朝ごはん', 'ぜんぶ');
    await sendHome(g);
    await expect(toast(g, '送りました')).toBeVisible();
    await login(page, 'staffSakura');
    await openClass(page);
    await taroRow(page).getByRole('button', { name: `${TARO}の家庭からを確認しました` }).click();
    await openChild(page);
    await sendComment(page, '応答の確かめのひとことです。');
    await expect(toast(page, '送りました')).toBeVisible();
    if (await ensureNapRunning(page)) {
      const row = page.getByRole('region', { name: `${TARO}の午睡チェック` });
      await row.getByRole('button', { name: `${TARO}のねた` }).click();
      await row.getByRole('button', { name: new RegExp(`^${TARO}の体温`) }).click();
      await napTemp(page, '37.1');
    }

    const own = await api(g, 'GET', '/api/contact/children/C001');
    expect(own.status).toBe(200);
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
    };
    walk(own.json);
    for (const k of ['sleep_temperature', 'nap_session_id', 'staff_name', 'confirmed_staff_name', 'guardian_name', 'last_change', 'recipient', 'source_diary_id', 'subject_child_ids']) {
      expect(keys.has(k), `保護者の応答に ${k} が入っている`).toBe(false);
    }
    expect(own.text).not.toContain(STAFF);
    for (const other of ['C004', 'C999']) {
      const res = await api(g, 'GET', `/api/contact/children/${other}`);
      expect(res.status).toBe(403);
      expect(res.text).toContain('この園児の連絡帳は開けません。');
    }
    await evidence(g, '02-045');
  });
});

// =====================================================================
// 保護者へ出す項目の設定
// =====================================================================
test.describe('保護者へ出す項目の設定', () => {
  test.describe.configure({ mode: 'serial' });

  /*
   * 典拠：要件定義書「きょうのようす」(4-2-3)、基本設計書「出す項目と選択肢の設定」(4-5)、図/画面詳細図「連絡帳（クラス）画面」(8-1) の箇条・「連絡帳（園児）画面」(8-2) 項目6
   * 設定画面に連絡帳の区画が無いため、設定の経路で切り替える（02-contact.helpers.ts の setShowItems）
   */
  test('02-046 保護者へ出す項目から排せつを外す', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    await page.getByRole('button', { name: `${TARO}の排せつ おしっこ` }).click();
    await expect(toast(page, '保護者が見られる状態です')).toBeVisible();
    const admin = await openWindow(browser, testInfo, 'admin');
    const set = await setShowItems(admin, ALL_SHOW_ITEMS.filter((i) => i !== 'toilet'));
    if (!set.ok) test.skip(true, SHOW_ITEMS_UNAVAILABLE);

    const g = await guardianContact(browser, testInfo);
    await expect(gToday(g)).not.toContainText('おしっこ');
    await page.reload();
    await expect(page.getByRole('columnheader', { name: /排せつ/ })).toContainText('保護者には出していません');
    await page.getByRole('button', { name: `${TARO}の排せつ うんち` }).click();
    await page.waitForTimeout(3_000);
    await expect(gToday(g)).not.toContainText('うんち');
    await openChild(page);
    await expect(sToday(page).getByRole('listitem').filter({ hasText: 'おしっこ' })).toContainText('保護者には出していません');
    await evidence(page, '02-046');
  });

  /* 典拠：基本設計書「出す項目と選択肢の設定」(4-5)（出すかどうかは保護者が開いた時点の設定で決める） */
  test('02-047 出す項目を戻すと、過去の分も出る', async ({ browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    if (!(await setShowItems(admin, ALL_SHOW_ITEMS)).ok) test.skip(true, SHOW_ITEMS_UNAVAILABLE);
    const g = await guardianContact(browser, testInfo);
    await expect(gToday(g).getByRole('listitem').filter({ hasText: 'おしっこ' })).toBeVisible();
    await expect(gToday(g).getByRole('listitem').filter({ hasText: 'うんち' })).toBeVisible();
    await evidence(g, '02-047');
  });

  /* 典拠：詳細設計書「知らせの種類と送り先」(6-2)（`contact.show_items` で外した種類は送らない）・「送る形」(6-3) */
  test('02-048 出さない種類は知らせも送らない', async ({ page, browser }, testInfo) => {
    const admin = await openWindow(browser, testInfo, 'admin');
    if (!(await setShowItems(admin, ALL_SHOW_ITEMS.filter((i) => i !== 'toilet'))).ok) test.skip(true, SHOW_ITEMS_UNAVAILABLE);
    try {
      const g = await guardianContact(browser, testInfo);
      // 保護者の窓で、知らせの受け取り口を別に開いて、届いた知らせを数える
      await g.evaluate(() => {
        const w = window as unknown as { __ev: string[] };
        w.__ev = [];
        const es = new EventSource('/api/events');
        es.onmessage = (e) => w.__ev.push(String(e.data));
      });
      await g.waitForTimeout(1_500);
      const contactFor = async () =>
        (await g.evaluate(() => (window as unknown as { __ev: string[] }).__ev)).filter((d) => /"type":"contact"/.test(d) && /C001/.test(d)).length;

      await login(page, 'staffSakura');
      await openClass(page);
      await page.getByRole('button', { name: `${TARO}の排せつ トイレでできた` }).click();
      await page.waitForTimeout(3_000);
      expect(await contactFor()).toBe(0);
      // 出す種類（食事）なら知らせが届く（受け取り口が働いていることの確かめ）
      await page.getByRole('group', { name: '食事の区分' }).getByRole('button', { name: '給食', exact: true }).click();
      await page.getByRole('button', { name: `${TARO}の給食をぜんぶ` }).click();
      await expect.poll(contactFor, { timeout: 10_000 }).toBeGreaterThan(0);
      await evidence(g, '02-048');
    } finally {
      await setShowItems(admin, ALL_SHOW_ITEMS);
    }
  });
});

// =====================================================================
// 訂正の権限と、管理者があとから読むこと
// =====================================================================
test.describe('訂正の権限と管理者の閲覧', () => {
  /*
   * 典拠：要件定義書「取り消し・訂正」(4-2-5)、基本設計書「取り消し・訂正」(4-2)・「メッセージ一覧」(4-12)、図/画面詳細図「連絡帳（園児）画面」(8-2) 項目7、
   *   詳細設計書「訂正・取り消しのまとめ」(3-5)・「`POST /api/contact/{kind}/{id}/correct`」(4-7 (1))
   * 前の日の記録は画面から作れないため、デモデータの前の日の記録を使う（無ければ未実施）
   */
  test('02-052 担任でも翌日以降は直せない', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    const yesterday = jstYesterday(jstToday());
    const pageRes = await api(page, 'GET', `/api/contact/children/C001?date=${yesterday}`);
    expect(pageRes.status).toBe(200);
    const events = ((pageRes.json as { events?: Record<string, unknown>[] }).events ?? []).filter((e) => e.event_type === '1' || e.event_type === '2');
    if (events.length === 0) test.skip(true, '前の日の記録（食事・排せつ）がデモデータに無い');
    const ev = events[0];
    const change = ev.event_type === '1' ? { meal_amount: ev.meal_amount === '1' ? '2' : '1' } : { toilet_label: ev.toilet_label === 'うんち' ? 'おしっこ' : 'うんち' };
    const res = await api(page, 'POST', `/api/contact/events/${ev.contact_event_id}/correct`, { ...change, updated_at: ev.updated_at });
    expect(res.status).toBe(403);
    expect(res.text).toContain('この記録を直せるのは、その日はクラスの担任、翌日以降は管理者です。管理者へご依頼ください。');

    await openChild(page);
    await page.getByRole('navigation', { name: '連絡帳の日付' }).getByRole('button', { name: /前の日/ }).click();
    await expect(sToday(page).getByRole('listitem').first()).toBeVisible();
    await expect(sToday(page).getByRole('button', { name: /直す・取り消す/ })).toHaveCount(0);
    const admin = await openWindow(browser, testInfo, 'admin');
    await admin.goto('/staff/contact/C001');
    await admin.getByRole('navigation', { name: '連絡帳の日付' }).getByRole('button', { name: /前の日/ }).click();
    await expect(sToday(admin).getByRole('button', { name: /直す・取り消す/ }).first()).toBeVisible();
    await evidence(admin, '02-052');
  });

  /*
   * 典拠：要件定義書「保護者へ届けるときの関所」(4-1-6) の (2) 管理者があとから読める、基本設計書「連絡帳の閲覧（職員）」(4-5)、図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目1
   */
  test('02-053 管理者はあとから全クラスを読める', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    await page.getByRole('button', { name: `${TARO}の排せつ おしっこ` }).click();
    await expect(toast(page, '保護者が見られる状態です')).toBeVisible();
    const admin = await openWindow(browser, testInfo, 'admin');
    await admin.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '連絡帳', exact: true }).click();
    const klass = admin.getByRole('combobox', { name: 'クラス' });
    for (const c of ['さくら組', 'ひまわり組', 'もも組']) await expect(klass.getByRole('option', { name: c })).toHaveCount(1);
    await klass.selectOption({ label: 'さくら組' });
    await expect(taroRow(admin).getByRole('cell', { name: new RegExp(`${TARO}の排せつ`) })).toContainText('おしっこ');
    await expect(admin.getByRole('columnheader', { name: /承認/ })).toHaveCount(0);
    await expect(admin.getByRole('main').getByRole('button', { name: /承認/ })).toHaveCount(0);
    await evidence(admin, '02-053');
  });
});

// =====================================================================
// 入力チェック：家庭から（連絡帳画面（保護者））
// =====================================================================
test.describe('入力チェック：家庭から', () => {
  test.use({ serverScope: 'test' });

  async function form(browser: import('@playwright/test').Browser, testInfo: import('@playwright/test').TestInfo) {
    const g = await guardianContact(browser, testInfo);
    return { g, home: g.getByRole('region', { name: '家庭から' }) };
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の連絡帳・「メッセージ一覧」(4-12) の連絡帳、詳細設計書「連絡帳画面（保護者）」(2-6 (3)) */
  test('02-I001 家庭から（全体）：0項目', async ({ page, browser }, testInfo) => {
    const { g, home } = await form(browser, testInfo);
    await sendHome(g);
    await expect(g.getByText('1つ以上の項目を入れてください。').first()).toBeVisible();
    await expect(home.getByRole('button', { name: '家庭からを送る' })).toBeVisible();
    await evidence(g, '02-I001');
    await login(page, 'staffSakura');
    await openClass(page);
    await expect(homeCell(page)).toContainText('まだ');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)・「家庭からの記入」(4-5) */
  test('02-I002 家庭から（全体）：1項目', async ({ browser }, testInfo) => {
    const { g, home } = await form(browser, testInfo);
    await pick(home, '朝ごはん', 'ぜんぶ');
    await sendHome(g);
    await expect(toast(g, '送りました。園が確認するとここに出ます。')).toBeVisible();
    await evidence(g, '02-I002');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)、図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目10・「連絡帳（クラス）画面」(8-1) 項目6 */
  test('02-I003 連絡事項：500文字', async ({ page, browser }, testInfo) => {
    const { g, home } = await form(browser, testInfo);
    const text = 'あ'.repeat(500);
    await home.getByRole('textbox', { name: /連絡事項/ }).fill(text);
    await expect(home).toContainText(/あと\s*0\s*文字/);
    await sendHome(g);
    await expect(toast(g, '送りました。園が確認するとここに出ます。')).toBeVisible();
    await login(page, 'staffSakura');
    await openClass(page);
    await expect(homeCell(page)).toContainText(text);
    await evidence(page, '02-I003');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)、詳細設計書「`PUT /api/contact/children/{childID}/home`（家庭から）」(4-3 (5))。画面での止め方は U-05 */
  test('02-I004 連絡事項：501文字', async ({ browser }, testInfo) => {
    const { g, home } = await form(browser, testInfo);
    const box = home.getByRole('textbox', { name: /連絡事項/ });
    await box.fill('あ'.repeat(501));
    const typed = (await box.inputValue()).length;
    if (typed > 500) {
      await sendHome(g);
      await expect(g.getByText('連絡事項は500文字以内で入力してください。').first()).toBeVisible();
      await expect(box).toHaveValue('あ'.repeat(501));
    } else {
      expect(typed).toBe(500);
    }
    // サーバに届いたとき
    const res = await api(g, 'PUT', '/api/contact/children/C001/home', {
      temperature: null, night_sleep_from: null, night_sleep_to: null, breakfast: null, mood_label: null,
      pickup_type: null, pickup_person: null, pickup_time: null, message: 'あ'.repeat(501), updated_at: null,
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('連絡事項は500文字以内で入力してください。');
    await evidence(g, '02-I004');
  });

  for (const [id, value, inRange] of [
    ['02-I005', '30.0', true],
    ['02-I006', '29.9', false],
    ['02-I007', '43.0', true],
    ['02-I008', '43.1', false],
  ] as const) {
    /* 典拠：基本設計書「入力項目の制約値」(4-12)（30.0〜43.0℃。範囲外でも入力を妨げず、確認を促すだけ）、図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目5 */
    test(`${id} 体温：${value}`, async ({ page, browser }, testInfo) => {
      const { g } = await form(browser, testInfo);
      await guardianTemp(g, value, true);
      const dialog = g.getByRole('dialog', { name: '体温' });
      // 範囲外は確認を促す（文言は U-06 のため、範囲・誤りに触れる文が出ることだけを見る）。確かめれば入れられる
      const prompt = g.getByText(/範囲|誤りがないか/).first();
      if (inRange) {
        await expect(dialog).toBeHidden();
        await expect(prompt).toHaveCount(0);
      } else {
        await expect(prompt).toBeVisible();
        await g.getByRole('button', { name: /このまま|記録する|入れる|はい|確定/ }).last().click();
        await expect(dialog).toBeHidden();
      }
      await sendHome(g);
      await expect(toast(g, '送りました')).toBeVisible();
      await login(page, 'staffSakura');
      await openClass(page);
      await expect(homeCell(page)).toContainText(`${value}℃`);
      expect(await homeCell(page).innerText()).not.toMatch(JUDGE);
      await evidence(page, id);
    });
  }

  /* 典拠：詳細設計書「`PUT /api/contact/children/{childID}/home`（家庭から）」(4-3 (5))・「本書で足す文言」(4-1 (6)) */
  test('02-I009 体温：小数第2位（36.55）', async ({ browser }, testInfo) => {
    const { g } = await form(browser, testInfo);
    await g.getByRole('region', { name: '家庭から' }).getByRole('button', { name: '体温を入れる' }).click();
    const dialog = g.getByRole('dialog', { name: '体温' });
    await dialog.getByRole('button', { name: 'ほかの値' }).click();
    const box = dialog.getByRole('spinbutton', { name: 'ほかの値（℃）' });
    await box.fill('36.55');
    const record = dialog.getByRole('button', { name: '記録する' });
    if (await record.isEnabled()) {
      // 打てる作りなら、保存されずに文言が出る
      await record.click();
      await expect(g.getByText('体温は数値で、小数第1位まで入力してください。').first()).toBeVisible();
    } else {
      // 小数第2位を入れると「記録する」を押せない（打てない作り）。保存されない
      await expect(record).toBeDisabled();
    }
    await evidence(g, '02-I009');
    // サーバに届いたとき
    const res = await api(g, 'PUT', '/api/contact/children/C001/home', {
      temperature: 36.55, night_sleep_from: null, night_sleep_to: null, breakfast: null, mood_label: null,
      pickup_type: null, pickup_person: null, pickup_time: null, message: null, updated_at: null,
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('体温は数値で、小数第1位まで入力してください。');
  });

  for (const [id, person, time] of [
    ['02-I010', null, '17:30'],
    ['02-I011', '祖母', null],
  ] as const) {
    /* 典拠：基本設計書「入力項目の制約値」(4-12)、詳細設計書「連絡帳画面（保護者）」(2-6 (3))・「本書で足す文言」(4-1 (6)) */
    test(`${id} お迎え：変更あり・${person ? '時刻なし' : '迎えの人なし'}`, async ({ browser }, testInfo) => {
      const { g, home } = await form(browser, testInfo);
      await pick(home, 'お迎え', '変更あり');
      if (person) await home.getByText(person, { exact: true }).click();
      if (time) await home.getByRole('combobox', { name: /お迎えの時刻/ }).selectOption(time);
      await sendHome(g);
      await expect(g.getByText('お迎えの人と時刻を入れてください。').first()).toBeVisible();
      await expect(home.getByRole('button', { name: '家庭からを送る' })).toBeVisible();
      await evidence(g, id);
    });
  }

  for (const [id, len] of [
    ['02-I012', 50],
    ['02-I013', 51],
  ] as const) {
    /* 典拠：基本設計書「入力項目の制約値」(4-12)、図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目9、詳細設計書「`PUT /api/contact/children/{childID}/home`」(4-3 (5)) */
    test(`${id} お迎え（その他）：${len}文字`, async ({ page, browser }, testInfo) => {
      const { g, home } = await form(browser, testInfo);
      await pick(home, 'お迎え', '変更あり');
      await home.getByText('その他', { exact: true }).click();
      const box = home.getByRole('textbox', { name: /その他|お迎えの人/ });
      await box.fill('あ'.repeat(len));
      await home.getByRole('combobox', { name: /お迎えの時刻/ }).selectOption('17:30');
      const typed = (await box.inputValue()).length;
      if (len === 50) {
        await sendHome(g);
        await expect(toast(g, '送りました')).toBeVisible();
        await login(page, 'staffSakura');
        await openClass(page);
        await expect(homeCell(page)).toContainText('あ'.repeat(50));
        await evidence(page, id);
        return;
      }
      if (typed > 50) {
        await sendHome(g);
        await expect(home.getByRole('button', { name: '家庭からを送る' })).toBeVisible();
        await expect(g.getByText('送りました。園が確認するとここに出ます。')).toHaveCount(0);
      } else {
        expect(typed).toBe(50);
      }
      const res = await api(g, 'PUT', '/api/contact/children/C001/home', {
        temperature: null, night_sleep_from: null, night_sleep_to: null, breakfast: null, mood_label: null,
        pickup_type: '2', pickup_person: 'あ'.repeat(51), pickup_time: '17:30', message: null, updated_at: null,
      });
      expect(res.status).toBe(400);
      await evidence(g, id);
    });
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12)、図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目6 */
  test('02-I014 夜の睡眠：夜をまたぐ（21:00〜6:30）', async ({ page, browser }, testInfo) => {
    const { g, home } = await form(browser, testInfo);
    const from = home.getByRole('combobox', { name: '夜に寝た時刻' });
    const to = home.getByRole('combobox', { name: '朝に起きた時刻' });
    const minutes = (await from.locator('option').allInnerTexts()).concat(await to.locator('option').allInnerTexts()).filter((t) => /^\d{2}:\d{2}$/.test(t)).map((t) => Number(t.slice(3)));
    expect(minutes.every((m) => m % 10 === 0)).toBe(true);
    await from.selectOption('21:00');
    await to.selectOption('06:30');
    await sendHome(g);
    await expect(toast(g, '送りました')).toBeVisible();
    await login(page, 'staffSakura');
    await openClass(page);
    await expect(homeCell(page)).toContainText('21:00');
    await expect(homeCell(page)).toContainText(/0?6:30/);
    await evidence(page, '02-I014');
  });
});

// =====================================================================
// 入力チェック：きょうのようす・園から（連絡帳（園児）画面）
// =====================================================================
test.describe('入力チェック：きょうのようす・園から', () => {
  test.use({ serverScope: 'test' });

  for (const [id, len] of [
    ['02-I015', 200],
    ['02-I016', 201],
  ] as const) {
    /* 典拠：基本設計書「入力項目の制約値」(4-12)、図/画面詳細図「連絡帳（園児）画面」(8-2) 項目13、詳細設計書「`POST /api/contact/events`」(4-4 (1)) */
    test(`${id} 活動のひとこと：${len}文字`, async ({ page, browser }, testInfo) => {
      await login(page, 'staffSakura');
      await openChild(page);
      const side = page.getByRole('complementary', { name: '記録する' });
      const box = side.getByRole('textbox', { name: '活動のひとこと' });
      await box.fill('あ'.repeat(len));
      const typed = (await box.inputValue()).length;
      if (len === 200) {
        const g = await guardianContact(browser, testInfo);
        await side.getByRole('button', { name: 'ひとことを送る' }).click();
        await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
        await expect(gToday(g)).toContainText('あ'.repeat(200));
        await evidence(g, id);
        return;
      }
      if (typed > 200) {
        await side.getByRole('button', { name: 'ひとことを送る' }).click();
        await expect(page.getByText('ひとことは200文字以内で入力してください。').first()).toBeVisible();
        await expect(box).toHaveValue('あ'.repeat(201));
      } else {
        expect(typed).toBe(200);
      }
      const res = await api(page, 'POST', '/api/contact/events', { items: [{ child_id: 'C001', event_type: '4', body: 'あ'.repeat(201) }] });
      expect(res.status).toBe(400);
      expect(res.text).toContain('ひとことは200文字以内で入力してください。');
      await evidence(page, id);
    });
  }

  /* 典拠：図/画面詳細図「連絡帳（園児）画面」(8-2) 項目13、詳細設計書「検査の共通の規則」(4-1 (5))・「`POST /api/contact/events`」(4-4 (1)) */
  test('02-I017 活動のひとこと：空白だけ', async ({ page }) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const side = page.getByRole('complementary', { name: '記録する' });
    const items = sToday(page).getByRole('listitem');
    const before = await items.count();
    await side.getByRole('textbox', { name: '活動のひとこと' }).fill('　　　');
    const send = side.getByRole('button', { name: 'ひとことを送る' });
    if (await send.isEnabled()) {
      await send.click();
      await expect(toast(page, '送りました')).toHaveCount(0);
    } else {
      await expect(send).toBeDisabled();
    }
    await page.waitForTimeout(1_500);
    await expect(items).toHaveCount(before);
    await evidence(page, '02-I017');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)、詳細設計書「連絡帳（クラス）画面」(2-2 (5)) */
  test('02-I018 体温（職員）：29.9', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    await page.getByRole('complementary', { name: '記録する' }).getByRole('button', { name: '体温を記録する' }).click();
    const dialog = page.getByRole('dialog', { name: `${TARO}の体温` });
    await dialog.getByRole('button', { name: 'ほかの値' }).click();
    await dialog.getByRole('spinbutton', { name: 'ほかの値（℃）' }).fill('29.9');
    await dialog.getByRole('button', { name: '記録する' }).click();
    await expect(page.getByText('入力値が通常の範囲外です。測定値に誤りがないか確認してください。').first()).toBeVisible();
    await page.getByRole('button', { name: /このまま|記録する|はい|確定/ }).last().click();
    const item = gToday(g).getByRole('listitem').filter({ hasText: '29.9℃' });
    await expect(item).toBeVisible();
    expect(await item.innerText()).not.toMatch(JUDGE);
    await evidence(g, '02-I018');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)・「排せつ・体温の記録」(4-5)、詳細設計書「連絡帳（園児）画面」(2-3 (4)) */
  test('02-I019 きょうのようすの時刻（排せつ）：その日の 0:00', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const g = await guardianContact(browser, testInfo);
    const side = page.getByRole('complementary', { name: '記録する' });
    await side.getByRole('combobox', { name: '時刻（排せつ・体温）' }).selectOption('00:00');
    await side.getByRole('group', { name: '排せつ' }).getByRole('button', { name: 'おしっこ' }).click();
    await expect(sToday(page).getByRole('listitem').first()).toContainText(/0?0:00\s*.*おしっこ/);
    await expect(gToday(g).getByRole('listitem').first()).toContainText(/0?0:00\s*おしっこ/);
    await evidence(g, '02-I019');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)、詳細設計書「連絡帳（園児）画面」(2-3 (4))・「`POST /api/contact/events`」(4-4 (1))・「本書で足す文言」(4-1 (6)) */
  test('02-I020 きょうのようすの時刻（排せつ）：いまより後・前の日', async ({ page }) => {
    await login(page, 'staffSakura');
    await openChild(page);
    const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }).format(new Date());
    const options = (await page.getByRole('combobox', { name: '時刻（排せつ・体温）' }).locator('option').allInnerTexts()).filter((t) => /^\d{2}:\d{2}$/.test(t));
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((t) => t <= now)).toBe(true);
    const today = jstToday();
    for (const at of [`${today}T23:59:00`, `${jstYesterday(today)}T23:55:00`]) {
      const res = await api(page, 'POST', '/api/contact/events', { items: [{ child_id: 'C001', event_type: '2', toilet_label: 'おしっこ', recorded_at: at }] });
      expect(res.status, at).toBe(400);
      expect(res.text).toContain('時刻は、その日の0時からいままでで選んでください。');
    }
    await evidence(page, '02-I020');
  });

  for (const [id, body, label] of [
    ['02-I021', '', '空'],
    ['02-I022', '　　　', '空白だけ'],
  ] as const) {
    /* 典拠：基本設計書「入力項目の制約値」(4-12)、詳細設計書「`PUT /api/contact/children/{childID}/facility`」(4-5 (1))・「検査の共通の規則」(4-1 (5))・「本書で足す文言」(4-1 (6)) */
    test(`${id} 園からのひとこと：${label}`, async ({ page }) => {
      await login(page, 'staffSakura');
      await openChild(page);
      await facility(page).getByRole('textbox', { name: '園からのひとこと' }).fill(body);
      const send = facility(page).getByRole('button', { name: '送る', exact: true });
      if (await send.isEnabled()) {
        await send.click();
        await expect(page.getByText('園からのひとことを入力してください。').first()).toBeVisible();
      } else {
        await expect(send).toBeDisabled();
      }
      const res = await api(page, 'PUT', '/api/contact/children/C001/facility', { body });
      expect(res.status).toBe(400);
      expect(res.text).toContain('園からのひとことを入力してください。');
      await expect(facility(page).getByRole('textbox', { name: '園からのひとこと' })).toBeVisible();
      await evidence(page, id);
    });
  }

  for (const [id, len] of [
    ['02-I023', 500],
    ['02-I024', 501],
  ] as const) {
    /* 典拠：基本設計書「入力項目の制約値」(4-12)、詳細設計書「`PUT /api/contact/children/{childID}/facility`」(4-5 (1)) */
    test(`${id} 園からのひとこと：${len}文字`, async ({ page, browser }, testInfo) => {
      await login(page, 'staffSakura');
      await openChild(page);
      const box = facility(page).getByRole('textbox', { name: '園からのひとこと' });
      await box.fill('あ'.repeat(len));
      const typed = (await box.inputValue()).length;
      if (len === 500) {
        const g = await guardianContact(browser, testInfo);
        await facility(page).getByRole('button', { name: '送る', exact: true }).click();
        await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
        await expect(facility(g)).toContainText('あ'.repeat(500));
        await evidence(g, id);
        return;
      }
      if (typed > 500) {
        await facility(page).getByRole('button', { name: '送る', exact: true }).click();
        await expect(page.getByText('園からのひとことは500文字以内で入力してください。').first()).toBeVisible();
        await expect(box).toHaveValue('あ'.repeat(501));
      } else {
        expect(typed).toBe(500);
      }
      const res = await api(page, 'PUT', '/api/contact/children/C001/facility', { body: 'あ'.repeat(501) });
      expect(res.status).toBe(400);
      expect(res.text).toContain('園からのひとことは500文字以内で入力してください。');
      await evidence(page, id);
    });
  }
});

// =====================================================================
// 入力チェック：クラスのようす・写真（連絡帳（クラス）画面）
// =====================================================================
test.describe('入力チェック：クラスのようす・写真', () => {
  test.use({ serverScope: 'test' });

  for (const [id, len] of [
    ['02-I025', 500],
    ['02-I026', 501],
  ] as const) {
    /* 典拠：基本設計書「入力項目の制約値」(4-12)、図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目18、詳細設計書「`POST /api/contact/class-notes`」(4-4 (4))・「本書で足す文言」(4-1 (6)) */
    test(`${id} クラスのようす：${len}文字`, async ({ page }) => {
      await login(page, 'staffSakura');
      await openClass(page);
      const box = page.getByRole('textbox', { name: /クラスのようす/ });
      await page.waitForTimeout(1_000);
      if ((await box.count()) === 0) test.skip(true, CLASS_NOTE_NEXT);
      await box.fill('あ'.repeat(len));
      await page.getByRole('main').getByRole('button', { name: '送る', exact: true }).click();
      if (len === 500) await expect(toast(page, /家庭に送りました/)).toBeVisible();
      else await expect(page.getByText(/クラスのようすは\s*500\s*文字以内で入力してください。/).first()).toBeVisible();
      await evidence(page, id);
    });
  }

  for (const [id, label] of [
    ['02-I027', 'GIF のファイル'],
    ['02-I028', '10MB を超える JPEG'],
  ] as const) {
    /* 典拠：基本設計書「入力項目の制約値」(4-12)、詳細設計書「連絡帳（クラス）画面」(2-2 (7)) ①・「本書で足す文言」(4-1 (6)) */
    test(`${id} 写真：${label}`, async ({ page }) => {
      await login(page, 'staffSakura');
      await openClass(page);
      const file =
        id === '02-I027'
          ? { name: 'plain.gif', mimeType: 'image/gif', buffer: GIF_1PX }
          : { name: 'large.jpg', mimeType: 'image/jpeg', buffer: Buffer.concat([await makePicture(page, 'jpeg'), Buffer.alloc(10 * 1024 * 1024 + 1024)]) };
      await page.getByRole('button', { name: '写真を送る' }).click();
      const dialog = page.getByRole('dialog', { name: '写真を送る' });
      await dialog.locator('input[type=file]').setInputFiles(file);
      await expect(page.getByText('写真は JPEG・PNG で、10MB までです。').first()).toBeVisible();
      await expect(dialog.getByRole('button', { name: '送る', exact: true })).toBeDisabled();
      await evidence(page, id);
    });
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12) */
  test('02-I029 写真：PNG', async ({ page, browser }, testInfo) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const g = await guardianContact(browser, testInfo);
    const { dialog, picker } = await openPhotoPicker(page, await makePicture(page, 'png'), 'plain.png', 'image/png');
    await picker.getByRole('button', { name: '子どもは写っていない' }).click();
    await picker.getByRole('button', { name: `${TARO}に届ける` }).click();
    await picker.getByRole('button', { name: '決める' }).click();
    await dialog.getByRole('button', { name: '送る', exact: true }).click();
    await expect(toast(page, '送りました。保護者が見られる状態です。')).toBeVisible();
    await expect(gPhotos(g).first()).toBeVisible();
    await evidence(g, '02-I029');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12)、図/画面詳細図「共通のダイアログと部品」(1-3 (2)) 項目5 */
  test('02-I030 写真に添える文：201文字', async ({ page }) => {
    await login(page, 'staffSakura');
    await openClass(page);
    const { dialog, picker } = await openPhotoPicker(page, await makePicture(page, 'jpeg'));
    await picker.getByRole('button', { name: '子どもは写っていない' }).click();
    await picker.getByRole('button', { name: `${TARO}に届ける` }).click();
    await picker.getByRole('button', { name: '決める' }).click();
    const box = dialog.getByRole('textbox', { name: /添える文/ });
    await box.fill('あ'.repeat(201));
    const typed = (await box.inputValue()).length;
    if (typed > 200) {
      await dialog.getByRole('button', { name: '送る', exact: true }).click();
      await expect(toast(page, '送りました')).toHaveCount(0);
    } else {
      expect(typed).toBe(200);
    }
    const res = await postPhoto(page, { target_child_id: 'C001', body: 'あ'.repeat(201) }, { name: 'plain.jpg', type: 'image/jpeg', base64: (await makePicture(page, 'jpeg')).toString('base64') });
    expect(res.status).toBe(400);
    await evidence(page, '02-I030');
  });
});
