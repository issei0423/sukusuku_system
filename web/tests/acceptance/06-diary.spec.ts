/*
 * シート 06 日誌システム（日誌一覧画面・日誌作成・編集画面・日誌確認画面・承認待ち一覧画面・日誌承認画面・園児タイムライン画面）
 *
 * ケースは sheet-06.md（テスト仕様書 第2.0版の下書き）による。期待する結果は設計書（docs ブランチ）から書く。
 * コードを読んで決めない（README.md「期待は設計書から」）。典拠は各テストのコメントに書く。
 *
 * - テストごとに新しいデータベースでサーバを立てる（serverScope: 'test'）。前のテストのデータに頼らず、前提はテストの中で作る
 *   （sheet-06.md の「入力データ・前提」。前のケースのあとと書いたものは、その状態をテストの中で作り直す）
 * - 前提の日誌は、画面と同じ経路（POST /api/diaries ほか。図/インタフェース一覧「日誌システム（園内の記録）」）で作る。
 *   確かめる操作そのものは画面で行う
 * - 設計書の細かい見え方は expect.soft で見る（違っても先へ進み、違ったところをまとめて NG に出す）
 * - 【12-1】の項目は、画面に機能が無ければ未実施（実装対象の外）、あれば設計書の期待で OK か NG にする（rules.md）
 */
import type { Browser, Page } from '@playwright/test';
import { ACCOUNTS, evidence, expect, jstToday, login, test } from './harness';
import {
  api,
  applyButton,
  applyDiary,
  approveDiary,
  appendBody,
  bodyBox,
  childIdOf,
  childSelect,
  childrenOf,
  classIdOf,
  classSelectOf,
  closeWindows,
  confirmAndApply,
  confirmButton,
  createDiary,
  dashPendingCount,
  dashRowCount,
  dateBox,
  diariesLike,
  diaryById,
  eventsSeen,
  gotoList,
  gotoPending,
  headerCount,
  jstLocal,
  listLink,
  listRow,
  lockNotice,
  lockOf,
  loginMurata,
  logsAfter,
  mainOf,
  maxLogId,
  newDiary,
  newWindow,
  nl,
  notIn121,
  openApproval,
  openDiary,
  openFreeStaff,
  openMurata,
  openWindow,
  pendingLink,
  pendingRow,
  returnDiary,
  revokeDiary,
  sameFormatShift,
  saveButton,
  saveDraft,
  setSettingBySql,
  shiftDate,
  sqlAll,
  sqlOne,
  sqlRun,
  staffIdOf,
  toast,
  watchDialogs,
  watchEvents,
} from './06-diary.helpers';

test.use({ serverScope: 'test' });
test.describe.configure({ timeout: 240_000 });
test.afterEach(async () => {
  await closeWindows();
});

const SUZUKI = ACCOUNTS.staffSakura.name; // 鈴木 浩之
const NISHIDA = ACCOUNTS.admin.name; // 西田 拓也
const ENDO = ACCOUNTS.admin2.name; // 遠藤 直人
const TARO = '西田 太郎';
const MISAKI = '村田 美咲';
const HANAKO = '遠藤 花子';

/** 備考を残す（Playwright の注記と、回したときのログ。ng.md と sheet の備考に写すため） */
function note(text: string) {
  test.info().annotations.push({ type: '備考', description: text });
  console.log(`[備考 ${test.info().title.slice(0, 7).trim()}] ${text}`);
}

/** 少し待つ（二重送信のあと、遅れて届く要求を待つ） */
const settle = (page: Page, ms = 1500) => page.waitForTimeout(ms);

/** 職員ダッシュボードを開き、項目の行が出るまで待つ */
async function gotoDashboard(page: Page) {
  await page.goto('/staff');
  await expect(mainOf(page).getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
  await expect(mainOf(page).getByRole('row').nth(1)).toBeVisible();
  await page.waitForTimeout(500);
}

/** 押せないこと（無いか、押せない） */
async function expectNotPressable(page: Page, name: string | RegExp, message: string) {
  const btn = mainOf(page).getByRole('button', { name });
  const n = await btn.count();
  for (let i = 0; i < n; i++) await expect.soft(btn.nth(i), message).toBeDisabled();
}

/**
 * 読み取り専用で開いていること（記録種別・対象・記録日・雛形・定型文・本文・写真を動かせない）。
 * buttons：'absent' は「下書き保存」「確認へ進む」が無いこと（フリーの職員。図/画面詳細図「職員（タブレット／PC）」(1-1) の注記
 * 「記録の作成・編集のボタンは出さない」。照合 T14 の判定で T11 の直しを戻した。T15b）、既定は押せない（無いか、押せない）こと
 */
async function expectReadOnly(page: Page, buttons: 'absent' | 'notPressable' = 'notPressable') {
  const main = mainOf(page);
  for (const r of await main.getByRole('radio').all()) await expect.soft(r, '記録種別を動かせない').toBeDisabled();
  for (const name of [/^対象の園児/, /^対象のクラス/, /雛形/, /定型文/]) {
    const c = main.getByRole('combobox', { name });
    if (await c.count()) await expect.soft(c.first(), `${name} を動かせない`).toBeDisabled();
  }
  await expect.soft(dateBox(page), '記録日を動かせない').toBeDisabled();
  if (await bodyBox(page).count()) await expect.soft(bodyBox(page), '本文を動かせない').toBeDisabled();
  const add = main.getByRole('button', { name: /追加/ });
  if (await add.count()) await expect.soft(add.first(), '写真を足せない').toBeDisabled();
  if (buttons === 'absent') {
    await expect.soft(main.getByRole('button', { name: '下書き保存' }), '「下書き保存」が無い').toHaveCount(0);
    await expect.soft(main.getByRole('button', { name: '確認へ進む' }), '「確認へ進む」が無い').toHaveCount(0);
    return;
  }
  await expectNotPressable(page, '下書き保存', '「下書き保存」を押せない');
  await expectNotPressable(page, '確認へ進む', '「確認へ進む」を押せない');
}

// =====================================================================
// 日誌の作成から承認まで
// =====================================================================

test.describe('日誌の作成から承認まで', () => {
  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（絞り込み検索・PDF出力は管理者）・「参照範囲の全体規定」(4-1-5)、基本設計書「絞り込みと出力」(4-6)・
     「入力項目の制約値」(4-12) の検索の期間・「一覧表示とページング」(3-7)、図/画面詳細図「日誌一覧画面」(3-1) 項目1〜14 と注記、図/画面遷移図「日誌システム」(4) */
  test('06-001 一覧の表示と既定の絞り込み', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    await gotoList(page);
    const main = mainOf(page);

    const type = main.getByRole('combobox', { name: '種別' });
    await expect.soft(type.locator('option:checked'), '種別の初期値「すべて」').toHaveText('すべて');
    const cls = main.getByRole('combobox', { name: 'クラス' });
    await expect.soft(cls.locator('option:checked'), 'クラスの初期値「さくら組」').toHaveText('さくら組');
    expect.soft((await cls.locator('option').allInnerTexts()).map((t) => t.trim()), 'ほかのクラスを選べない').toEqual(['さくら組']);
    await expect.soft(main.getByRole('combobox', { name: '状態' }).locator('option:checked'), '状態の初期値「すべて」').toHaveText('すべて');
    await expect.soft(main.getByRole('textbox', { name: /期間（開始）/ }), '期間の開始＝当日の30日前').toHaveValue(shiftDate(today, -30));
    await expect.soft(main.getByRole('textbox', { name: /期間（終了）/ }), '期間の終了＝当日').toHaveValue(today);
    await expect.soft(main.getByRole('textbox', { name: /園児名/ }), '園児名の絞り込み（項目10）が空で出る').toHaveValue('');
    await expect.soft(main.getByRole('textbox', { name: /キーワード/ }), 'キーワードの絞り込み（項目11）が空で出る').toHaveValue('');
    await expect.soft(main.getByRole('checkbox', { name: /自分が作成したもの/ }), '「自分が作成したもの」（項目12）がオフで出る').not.toBeChecked();

    const headers = (await main.getByRole('columnheader').allInnerTexts()).map((t) => t.trim());
    for (const h of ['記録日', '種別', '対象', '作成者', '状態']) expect.soft(headers, `一覧の列「${h}」`).toContain(h);
    expect.soft(headers.join(' '), '保護者への共有の列が無い').not.toMatch(/共有/);
    await expect.soft(main.getByRole('link', { name: /新しく書く/ }).or(main.getByRole('button', { name: /新しく書く/ })).first(), '「＋ 新しく書く」がある').toBeVisible();
    await expect.soft(main.getByRole('button', { name: /PDF/ }), '一般には「PDF 出力」が無い').toHaveCount(0);
    const text = (await main.innerText()).replace(/\s+/g, ' ');
    expect.soft(text, 'ページングに現在のページ').toMatch(/\d+\s*\/\s*\d+/);
    expect.soft(text, 'ページングに総件数').toMatch(/全\s*\d+\s*件/);
    await evidence(page, '06-001');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（下書き・作成・ステータス管理）、基本設計書「日誌の作成から承認まで」(4-6) の処理1〜4・「日誌（t_diary）」(5-5)・
     「操作ログの記録」(4-2)・「入力項目の制約値とメッセージ一覧」(4-12) の完了の表示、図/画面詳細図「日誌作成・編集画面」(3-2) 項目2・4〜6・9・12、
     図/画面遷移図「日誌システム」(4)（下書き保存は同じ画面に留まる）、詳細設計書「日誌の状態」(3-6) */
  test('06-002 個人日誌を下書き保存する', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    await newDiary(page);
    const main = mainOf(page);
    await expect.soft(main.getByRole('radio', { name: '個人日誌' }), '記録種別の初期値は個人日誌').toBeChecked();
    await expect.soft(classSelectOf(page).locator('option:checked'), '対象のクラスの初期値は担当クラス').toHaveText('さくら組');
    await expect.soft(dateBox(page), '記録日の初期値は当日').toHaveValue(today);

    const logBefore = maxLogId();
    await childSelect(page).selectOption({ label: TARO });
    await appendBody(page, '受入テスト 06-002 下書き');
    await saveDraft(page);
    await expect(toast(page, /保存/), '画面の下端に完了の表示').toBeVisible();
    await expect.soft(page.getByRole('heading', { name: /日誌の(編集|作成)/, level: 1 }), '同じ画面に留まる').toBeVisible();
    await expect.soft(main.getByText(/状態[：:]\s*下書き/), '状態は「下書き」').toBeVisible();

    const [d] = diariesLike('受入テスト 06-002 下書き');
    expect(d, 'SQL：日誌の行が1つ').toBeTruthy();
    expect.soft(diariesLike('受入テスト 06-002 下書き'), 'SQL：行は1つ').toHaveLength(1);
    expect.soft(d.record_type, "record_type＝'1'").toBe('1');
    expect.soft(d.status, "status＝'1'").toBe('1');
    expect.soft(d.child_id, 'child_id＝太郎').toBe(childIdOf(TARO));
    expect.soft(Number(d.class_id), 'class_id＝さくら組').toBe(classIdOf('さくら組'));
    expect.soft(d.diary_date, 'diary_date＝当日').toBe(today);
    expect.soft(d.created_staff_id, 'created_staff_id＝鈴木 浩之').toBe(staffIdOf(SUZUKI));
    expect.soft(d.applied_staff_id ?? null, 'applied_staff_id は空').toBeNull();
    expect.soft(d.applied_at ?? null, 'applied_at は空').toBeNull();
    const logs = logsAfter(logBefore).filter((l) => l.function_type === '1' && l.operation_type === '1' && Number(l.target_id) === d.diary_id);
    expect.soft(logs, '操作ログに 1・1 の行が1つ増える').toHaveLength(1);

    await main.getByRole('link', { name: /日誌一覧へ/ }).click();
    await expect(page.getByRole('heading', { name: '日誌', level: 1 })).toBeVisible();
    const row = listRow(page, d.diary_id);
    await expect.soft(row, '一覧の行：記録日・種別・対象・作成者・状態').toContainText('個人日誌');
    await expect.soft(row).toContainText(TARO);
    await expect.soft(row).toContainText(SUZUKI);
    await expect.soft(row).toContainText('下書き');
    await evidence(page, '06-002');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（申請）・「全機能に共通する扱い」(4-1-4 (1))、基本設計書「日誌の作成から承認まで」(4-6) の処理5〜7・
     「日誌（t_diary）」(5-5)・「開いている画面への即時の反映（SSE）」(4-10)・「画面基本構成」(3-5) の通知からの導線、図/画面詳細図「日誌確認画面」(3-3) 項目1〜4、
     「職員ダッシュボード」(2-6) 項目8、「職員（タブレット／PC）」(1-1) 項目2、詳細設計書「日誌」(4-13) の (1)・「画面ごとの読み直し」(6-5) */
  test('06-003 確認へ進んで申請する', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-002 下書き' }, today);
    const admin = await openWindow(browser, 'admin');
    await gotoDashboard(admin);
    const pendingBefore = await dashPendingCount(admin);
    const headBefore = await headerCount(admin);

    await openDiary(page, id);
    const logBefore = maxLogId();
    await confirmButton(page).click();
    const main = mainOf(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    for (const t of ['個人日誌', TARO, '受入テスト 06-002 下書き']) await expect.soft(main, `確認画面に ${t}`).toContainText(t);
    await expect.soft(main, '確認画面に記録日').toContainText(new RegExp(today.slice(0, 4)));
    await expect.soft(main, '写真の枚数（0）').toContainText(/写真\s*0\s*枚|写真の枚数\s*0/);
    await expect.soft(main.getByRole('textbox', { name: /差し戻/ }), '差し戻し理由の欄は無い').toHaveCount(0);
    await applyButton(page).click();
    await expect(page.getByRole('heading', { name: '日誌', level: 1 }), '日誌一覧画面へ戻る').toBeVisible();
    await expect.soft(listRow(page, id), '行の状態が「申請中」').toContainText('申請中');

    await expect.poll(() => dashPendingCount(admin), { message: '窓2：再読み込みせずに「承認待ちの日誌」が1つ増える', timeout: 10_000 }).toBe((pendingBefore ?? 0) + 1);
    await expect.poll(() => headerCount(admin), { message: '窓2：ヘッダの通知の件数が1つ増える', timeout: 10_000 }).toBe(headBefore + 1);

    const d = diaryById(id)!;
    expect.soft(d.status, "status＝'2'").toBe('2');
    expect.soft(d.applied_staff_id, 'applied_staff_id＝鈴木 浩之').toBe(staffIdOf(SUZUKI));
    expect.soft(d.applied_at, 'applied_at が入る').toBeTruthy();
    expect.soft(lockOf(id), 't_diary_lock に行が無い').toHaveLength(0);
    const logs = logsAfter(logBefore).filter((l) => l.function_type === '1' && Number(l.target_id) === id);
    expect.soft(logs.filter((l) => l.operation_type === '2' && /申請/.test(l.after_value ?? '')), "操作ログに 1・2 で after_value「申請」の行が1つ").toHaveLength(1);
    await evidence(page, '06-003');
  });

  /* 典拠：基本設計書「日誌の作成から承認まで」(4-6)（承認の経緯を表示する）・「編集ロックの解除」(4-6)（申請中・承認済みの日誌を開いたときはロックを取得しない）、
     図/画面詳細図「日誌一覧画面」(3-1) 項目8、「日誌作成・編集画面」(3-2) 項目15・17・26 と注記、詳細設計書「日誌の画面（作り直し）」(2-13) の (9) */
  test('06-004 申請中の日誌は読み取り専用で開く', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-004 申請中', status: '2' }, today);
    await gotoList(page);
    await listLink(page, id).click();
    await expect(page.getByRole('heading', { name: '日誌の編集', level: 1 })).toBeVisible();
    const main = mainOf(page);
    await expect.soft(main.getByText('申請中のため編集できません。'), '「申請中のため編集できません。」').toBeVisible();
    await expect.soft(main, '承認の経緯に申請者').toContainText(new RegExp(`申請[^\\n]*${SUZUKI}`));
    await expect.soft(main, '承認の経緯に申請日時').toContainText(/\d{1,2}:\d{2}/);
    await expectReadOnly(page);
    await expect.soft(main.getByRole('button', { name: '申請を取り下げる' }), '「申請を取り下げる」が出る').toBeVisible();
    expect.soft(lockOf(id), 'SQL：ロックの行ができない').toHaveLength(0);
    await evidence(page, '06-004');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（承認待ち一覧）、基本設計書「日誌の作成から承認まで」(4-6) の処理7、
     図/画面詳細図「承認待ち一覧画面（管理者）」(3-4) 項目4・6 と注記、詳細設計書「日誌の画面（作り直し）」(2-13) の (1) */
  test('06-005 申請日時・申請者と並び', async ({ page, browser }) => {
    const today = jstToday();
    const s = await openWindow(browser, 'staffSakura');
    const first = await createDiary(s, { type: '1', child: TARO, body: '受入テスト 06-003 先', status: '2' }, today);
    await settle(s, 1200); // 申請日時を1秒以上ずらす（秒で並ぶため）
    const second = await createDiary(s, { type: '1', child: MISAKI, body: '受入テスト 06-005 あと', status: '2' }, today);
    await login(page, 'admin');
    await gotoPending(page);
    const main = mainOf(page);
    const headers = (await main.getByRole('columnheader').allInnerTexts()).map((t) => t.trim());
    for (const h of ['申請日時', '記録日', '種別', 'クラス', '対象', '申請者', '操作']) expect.soft(headers, `列名「${h}」`).toContain(h);
    expect.soft(headers.join(' '), '保護者への共有の列が無い').not.toMatch(/共有/);
    await expect.soft(pendingRow(page, first), '申請者は鈴木 浩之').toContainText(SUZUKI);
    await expect.soft(pendingRow(page, second)).toContainText(SUZUKI);
    const rows = await main.getByRole('row').all();
    const index = async (id: number) => {
      for (let i = 0; i < rows.length; i++) if ((await rows[i].locator(`a[href="/staff/admin/approval/${id}"]`).count()) > 0) return i;
      return -1;
    };
    const i1 = await index(first);
    const i2 = await index(second);
    expect(i1, '06-003 の行がある').toBeGreaterThan(0);
    expect(i2, '06-005 の行がある').toBeGreaterThan(0);
    expect.soft(i1, '申請の古い順（06-003 が上）').toBeLessThan(i2);
    await expect.soft(pendingRow(page, first), '「ほかの管理者へ」が付かない').not.toContainText('ほかの管理者へ');
    await expect.soft(pendingRow(page, second)).not.toContainText('ほかの管理者へ');
    await evidence(page, '06-005');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（確認・承認・保管）、基本設計書「日誌の作成から承認まで」(4-6) の処理8〜10 と箇条・「日誌（t_diary）」(5-5)、
     図/画面詳細図「日誌承認画面（管理者）」(3-5) 項目1〜8 と注記、「日誌作成・編集画面」(3-2) 項目15・17・27、
     詳細設計書「日誌の画面（作り直し）」(2-13) の (1)（「承認する」は確認のダイアログを出さない）・「日誌の状態」(3-6)・「日誌」(4-13) の (2) */
  test('06-006 承認する', async ({ page, browser }) => {
    const today = jstToday();
    const s = await openWindow(browser, 'staffSakura');
    const id = await createDiary(s, { type: '1', child: TARO, body: '受入テスト 06-006 承認', status: '2' }, today);
    await login(page, 'admin');
    await gotoPending(page);
    await pendingLink(page, id).click();
    await expect(page.getByRole('heading', { name: '日誌の承認', level: 1 })).toBeVisible();
    const main = mainOf(page);
    await expect.soft(main, '申請者「鈴木 浩之」').toContainText(new RegExp(`申請者\\s*${SUZUKI}`));
    await expect.soft(main, '申請日時').toContainText(/申請\s*\d{1,2}\/\d{1,2}\s*\d{1,2}:\d{2}/);
    for (const t of ['個人日誌', TARO, '受入テスト 06-006 承認']) await expect.soft(main, `日誌の内容：${t}`).toContainText(t);
    await expect.soft(main.getByText(/保護者への共有|共有先/), '「保護者への共有」「共有先」が無い').toHaveCount(0);
    await expect.soft(main.getByRole('textbox', { name: /差し戻す理由/ }), '差し戻す理由がある').toBeVisible();
    await expect.soft(main.getByRole('button', { name: '差し戻す' }), '「差し戻す」がある').toBeVisible();
    const logBefore = maxLogId();
    await main.getByRole('button', { name: '承認する' }).click();
    await expect.soft(page.getByRole('dialog'), '確認のダイアログを出さない').toHaveCount(0);
    await expect(page.getByRole('heading', { name: '承認待ち', level: 1 }), '承認待ち一覧画面へ戻る').toBeVisible();
    await expect.soft(pendingLink(page, id), '行が消える').toHaveCount(0);

    await openDiary(s, id);
    await expect.soft(mainOf(s).getByText('承認済みのため編集できません。'), '一般S：「承認済みのため編集できません。」').toBeVisible();
    await expect.soft(mainOf(s), '承認の経緯に申請者').toContainText(new RegExp(`申請[^\\n]*${SUZUKI}`));
    await expect.soft(mainOf(s), '承認の経緯に承認者').toContainText(new RegExp(`承認[^\\n]*${NISHIDA}`));
    await expect.soft(mainOf(s).getByRole('button', { name: '承認を取り消して差し戻す' }), '一般には「承認を取り消して差し戻す」が出ない').toHaveCount(0);

    const d = diaryById(id)!;
    expect.soft(d.status, "status＝'3'").toBe('3');
    expect.soft(d.approved_staff_id, 'approved_staff_id＝西田 拓也').toBe(staffIdOf(NISHIDA));
    expect.soft(d.approved_at, 'approved_at が入る').toBeTruthy();
    expect.soft(d.returned_reason ?? null, 'returned_reason は空').toBeFalsy();
    expect.soft(lockOf(id), 'ロックの行は無い').toHaveLength(0);
    expect.soft(logsAfter(logBefore).filter((l) => l.function_type === '1' && l.operation_type === '3' && Number(l.target_id) === id), '操作ログに 1・3 の行が1つ').toHaveLength(1);
    await evidence(page, '06-006');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（確認・承認：修正差し戻し）、基本設計書「日誌の作成から承認まで」(4-6) の処理9・「日誌（t_diary）」(5-5)、
     図/画面詳細図「日誌承認画面（管理者）」(3-5) 項目6・7 と注記、詳細設計書「日誌の状態」(3-6)（差し戻しで approved_* を書かない。操作ログは 1・2）・「日誌」(4-13) の (3) */
  test('06-007 差し戻す', async ({ page, browser }) => {
    const today = jstToday();
    const s = await openWindow(browser, 'staffSakura');
    const id = await createDiary(s, { type: '1', child: MISAKI, body: '受入テスト 06-005 あと', status: '2' }, today);
    const reason = '受入テスト 06-007 理由：午睡の時刻を書き足してください';
    await login(page, 'admin');
    await gotoPending(page);
    await pendingLink(page, id).click();
    await expect(page.getByRole('heading', { name: '日誌の承認', level: 1 })).toBeVisible();
    const logBefore = maxLogId();
    await mainOf(page).getByRole('textbox', { name: /差し戻す理由/ }).fill(reason);
    await mainOf(page).getByRole('button', { name: '差し戻す' }).click();
    await expect(page.getByRole('heading', { name: '承認待ち', level: 1 }), '承認待ち一覧画面へ戻る').toBeVisible();
    await expect.soft(pendingLink(page, id), '行が消える').toHaveCount(0);
    const d = diaryById(id)!;
    expect.soft(d.status, "status＝'4'").toBe('4');
    expect.soft(d.returned_reason, 'returned_reason＝入れた理由').toBe(reason);
    expect.soft(d.approved_staff_id ?? null, 'approved_staff_id は空のまま').toBeNull();
    expect.soft(d.approved_at ?? null, 'approved_at は空のまま').toBeNull();
    const logs = logsAfter(logBefore).filter((l) => l.function_type === '1' && Number(l.target_id) === id);
    expect.soft(logs, '操作ログに差し戻しの行が1つ').toHaveLength(1);
    expect.soft(logs[0]?.operation_type, "操作ログの操作区分は '2'（変更。詳細設計書「日誌の状態」(3-6)）").toBe('2');
    expect.soft(`${logs[0]?.before_value ?? ''} ${logs[0]?.after_value ?? ''}`, '理由を含む').toContain(reason);
    await evidence(page, '06-007');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（承認待ち一覧・確認・承認）、基本設計書「画面基本構成」(3-5) の通知からの導線・「開いている画面への即時の反映（SSE）」(4-10)、
     図/画面詳細図「職員ダッシュボード」(2-6) 項目2・8 と注記、「日誌一覧画面」(3-1) 項目7・12 と注記、図/画面遷移図「日誌システム」(4)、詳細設計書「画面ごとの読み直し」(6-5) */
  test('06-008 差し戻しの知らせと差し戻された日誌', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const old = await createDiary(page, { type: '1', child: TARO, date: shiftDate(today, -40), body: '受入テスト 06-008 古い日誌', status: '2' }, today);
    const draft = await createDiary(page, { type: '1', child: HANAKO, body: '受入テスト 06-008 比べる下書き' }, today);
    await gotoDashboard(page);
    const before = (await dashRowCount(page, '差し戻された日誌')) ?? 0;
    const headBefore = await headerCount(page);
    await expect.soft(mainOf(page).getByText(/承認待ち/), '一般のダッシュボードに「承認待ちの日誌」が無い').toHaveCount(0);

    const admin = await openWindow(browser, 'admin');
    await openApproval(admin, old);
    await mainOf(admin).getByRole('textbox', { name: /差し戻す理由/ }).fill('受入テスト 06-008');
    await mainOf(admin).getByRole('button', { name: '差し戻す' }).click();
    await expect(admin.getByRole('heading', { name: '承認待ち', level: 1 })).toBeVisible();

    await expect.poll(() => dashRowCount(page, '差し戻された日誌'), { message: '再読み込みせずに「差し戻された日誌」が1つ増える', timeout: 10_000 }).toBe(before + 1);
    await expect.poll(() => headerCount(page), { message: '再読み込みせずにヘッダの通知の件数が1つ増える', timeout: 10_000 }).toBe(headBefore + 1);

    await gotoDashboard(admin);
    await expect.soft(mainOf(admin).getByRole('row', { name: /^差し戻された日誌/ }), '管理者のダッシュボードに「差し戻された日誌」が無い').toHaveCount(0);

    await mainOf(page).getByRole('row', { name: /^差し戻された日誌/ }).getByRole('link').first().click();
    await expect(page.getByRole('heading', { name: '日誌', level: 1 })).toBeVisible();
    const main = mainOf(page);
    await expect.soft(main.getByRole('combobox', { name: '状態' }).locator('option:checked'), '状態＝差し戻し').toHaveText('差し戻し');
    await expect.soft(main.getByRole('checkbox', { name: /自分が作成したもの/ }), '「自分が作成したもの」がオン（項目12）').toBeChecked();
    await expect.soft(main.getByRole('textbox', { name: /期間（開始）/ }), '期間の条件が外れている（開始）').toHaveValue('');
    await expect.soft(main.getByRole('textbox', { name: /期間（終了）/ }), '期間の条件が外れている（終了）').toHaveValue('');
    await expect.soft(listLink(page, old), '40日前の「06-008 古い日誌」の行が出る').toBeVisible();
    await evidence(page, '06-008');

    // 差し戻しの行は他の状態と区別できる色（状態「すべて」・期間を広げて、下書きの行と比べる）
    await main.getByRole('combobox', { name: '状態' }).selectOption({ label: 'すべて' });
    await main.getByRole('textbox', { name: /期間（開始）/ }).fill(shiftDate(today, -45));
    await main.getByRole('textbox', { name: /期間（終了）/ }).fill(today);
    await main.getByRole('button', { name: '絞り込む' }).click();
    await expect(listLink(page, draft)).toBeVisible();
    const look = async (id: number) =>
      (await listRow(page, id).count()) === 0 ? `行が無い（${id}）` : listRow(page, id).first().evaluate((tr) => {
        const cells = Array.from(tr.querySelectorAll('td, th')) as HTMLElement[];
        const one = (el: Element) => {
          const s = getComputedStyle(el);
          return `${s.color}|${s.backgroundColor}|${s.borderColor}`;
        };
        return [one(tr), ...cells.map(one), ...cells.flatMap((c) => Array.from(c.querySelectorAll('*')).map(one))].join(';');
      });
    expect.soft(await look(old), '差し戻しの行は下書きの行と色が違う').not.toBe(await look(draft));
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（ステータス管理）、基本設計書「日誌の作成から承認まで」(4-6) の箇条・「日誌（t_diary）」(5-5)、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目12・16、詳細設計書「日誌の状態」(3-6)・「日誌の画面（作り直し）」(2-13) の (9) */
  test('06-009 差し戻しの日誌を直して下書き保存する', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '1', child: MISAKI, body: '受入テスト 06-005 あと', status: '2' }, today);
    const reason = '受入テスト 06-007 理由：午睡の時刻を書き足してください';
    const admin = await openWindow(browser, 'admin');
    await returnDiary(admin, id, reason);
    await gotoDashboard(page);
    const before = await dashRowCount(page, '差し戻された日誌');

    await openDiary(page, id);
    const main = mainOf(page);
    await expect.soft(main, '差し戻しの理由が出る').toContainText(reason);
    await expect.soft(bodyBox(page), '編集できる').toBeEnabled();
    await expect.poll(() => lockOf(id)[0]?.locked_staff_id, { message: 'SQL：鈴木 浩之のロック' }).toBe(staffIdOf(SUZUKI));
    await appendBody(page, '受入テスト 06-009 書き足し');
    await saveDraft(page);
    await expect(toast(page, /保存/)).toBeVisible();
    await expect.soft(main.getByText(/状態[：:]\s*差し戻し/), '状態は「差し戻し」のまま').toBeVisible();
    const d = diaryById(id)!;
    expect.soft(d.status, "SQL：status＝'4' のまま").toBe('4');
    expect.soft(d.body, '本文が変わる').toContain('受入テスト 06-009 書き足し');
    expect.soft(d.returned_reason, 'returned_reason は残る').toBe(reason);
    await gotoList(page);
    await expect.soft(listRow(page, id), '一覧の行も「差し戻し」').toContainText('差し戻し');
    await gotoDashboard(page);
    expect.soft(await dashRowCount(page, '差し戻された日誌'), 'ダッシュボードの「差し戻された日誌」は減らない').toBe(before);
    await openDiary(page, id);
    await evidence(page, '06-009');
  });

  /* 典拠：基本設計書「日誌（t_diary）」(5-5) の状態の動きと「差し戻す理由は、最後の1件だけを日誌に持つ」、図/画面詳細図「日誌確認画面」(3-3) の注記、
     詳細設計書「日誌の状態」(3-6)（承認したときに消す） */
  test('06-010 再申請と差し戻す理由の保持', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '1', child: MISAKI, body: '受入テスト 06-010', status: '2' }, today);
    const reason = '受入テスト 06-010 理由';
    const admin = await openWindow(browser, 'admin');
    await returnDiary(admin, id, reason);
    const firstApplied = diaryById(id)!.applied_at;
    await settle(page, 1200);
    await openDiary(page, id);
    await appendBody(page, '受入テスト 06-010 直した');
    await confirmAndApply(page);
    const d = diaryById(id)!;
    expect.soft(d.status, '再申請で申請中').toBe('2');
    expect.soft(d.applied_at, 'applied_at が入れ直される').not.toBe(firstApplied);
    expect.soft(d.returned_reason, 'returned_reason は前の理由のまま').toBe(reason);
    await gotoPending(admin);
    await expect.soft(pendingLink(admin, id), '承認待ち一覧画面に再び並ぶ').toBeVisible();
    await openApproval(admin, id);
    await expect.soft(mainOf(admin), '日誌承認画面に前回の差し戻しの理由が出る').toContainText(reason);
    await evidence(admin, '06-010');
    await mainOf(admin).getByRole('button', { name: '承認する' }).click();
    await expect(admin.getByRole('heading', { name: '承認待ち', level: 1 })).toBeVisible();
    const after = diaryById(id)!;
    expect.soft(after.status, '承認されて status＝3').toBe('3');
    expect.soft(after.returned_reason ?? '', '承認で returned_reason が空になる').toBe('');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（申請の取り下げ）、基本設計書「申請の取り下げ」(4-6)・「入力項目の制約値とメッセージ一覧」(4-12) の確認ダイアログ、
     図/画面詳細図「日誌一覧画面」(3-1) 項目13、「承認待ち一覧画面（管理者）」(3-4) の注記、図/画面遷移図「日誌システム」(4)、
     詳細設計書「日誌の画面（作り直し）」(2-13) の (2)・「日誌の状態」(3-6)・「日誌」(4-13) の (4) */
  test('06-011 一覧から申請を取り下げる', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const mine = await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-011 取り下げ', status: '2' }, today);
    const draft = await createDiary(page, { type: '1', child: HANAKO, body: '受入テスト 06-011 下書き' }, today);
    const m = await openMurata(browser);
    const other = await createDiary(m, { type: '1', child: MISAKI, body: '受入テスト 06-011 村田の申請', status: '2' }, today);
    const admin = await openWindow(browser, 'admin');
    await gotoPending(admin);
    await expect(pendingLink(admin, mine)).toBeVisible();

    await gotoList(page);
    await expect.soft(listRow(page, mine).getByRole('button', { name: '申請を取り下げる' }), '自分の申請中の行に出る').toBeVisible();
    await expect.soft(listRow(page, other).getByRole('button', { name: '申請を取り下げる' }), 'ほかの職員の申請の行には出ない').toHaveCount(0);
    await expect.soft(listRow(page, draft).getByRole('button', { name: '申請を取り下げる' }), '下書きの行には出ない').toHaveCount(0);
    const logBefore = maxLogId();
    await listRow(page, mine).getByRole('button', { name: '申請を取り下げる' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect.soft(dialog, '確認のダイアログの文').toContainText('申請を取り下げますか。下書きに戻り、承認待ちから外れます。');
    await expect.soft(dialog.getByRole('button', { name: 'やめる' })).toBeVisible();
    await dialog.getByRole('button', { name: '取り下げる' }).click();
    await expect.soft(toast(page, '申請を取り下げました。下書きに戻っています'), '取り下げの結果の表示').toBeVisible();
    await expect.soft(listRow(page, mine), '行の状態が「下書き」').toContainText('下書き');
    await expect.poll(() => pendingLink(admin, mine).count(), { message: '窓2：再読み込みせずに承認待ち一覧画面から消える', timeout: 10_000 }).toBe(0);
    const d = diaryById(mine)!;
    expect.soft(d.status, "status＝'1'").toBe('1');
    expect.soft(d.applied_staff_id ?? null, 'applied_staff_id が空').toBeNull();
    expect.soft(d.applied_at ?? null, 'applied_at が空').toBeNull();
    const logs = logsAfter(logBefore).filter((l) => l.function_type === '1' && l.operation_type === '2' && Number(l.target_id) === mine);
    expect.soft(logs, '操作ログに 1・2 の行').toHaveLength(1);
    expect.soft(logs[0]?.before_value ?? '', 'before_value に申請者と申請日時').toMatch(/申請者|applied_staff/);
    expect.soft(logs[0]?.after_value ?? '', 'after_value に「取り下げ」').toContain('取り下げ');
    await evidence(page, '06-011');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（申請の取り下げ：自分の申請のみ）、基本設計書「申請の取り下げ」(4-6)・「権限と利用可能機能」(6-1)、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目26、詳細設計書「日誌の画面（作り直し）」(2-13) の (2) */
  test('06-012 編集画面から取り下げる', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-012', status: '2' }, today);
    const m = await openMurata(browser);
    await openDiary(m, id);
    await expect.soft(mainOf(m).getByRole('button', { name: '申請を取り下げる' }), '一般M には出ない').toHaveCount(0);
    const admin = await openWindow(browser, 'admin');
    await openDiary(admin, id);
    await expect.soft(mainOf(admin).getByRole('button', { name: '申請を取り下げる' }), '管理者A には出ない').toHaveCount(0);

    await openDiary(page, id);
    await mainOf(page).getByRole('button', { name: '申請を取り下げる' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取り下げる' }).click();
    await expect.soft(mainOf(page).getByText(/状態[：:]\s*下書き/), '下書きとして開き直る').toBeVisible();
    await expect.soft(bodyBox(page), '本文を直せる').toBeEnabled();
    await expect.poll(() => lockOf(id)[0]?.locked_staff_id, { message: 'SQL：鈴木 浩之のロック' }).toBe(staffIdOf(SUZUKI));
    await appendBody(page, '受入テスト 06-012 直した');
    await saveDraft(page);
    await expect.soft(toast(page, /保存/), '下書き保存できる').toBeVisible();
    expect.soft(diaryById(id)!.body, '保存された').toContain('受入テスト 06-012 直した');
    await evidence(page, '06-012');
  });

  /* 典拠：基本設計書「申請の取り下げ」(4-6)・「入力項目の制約値とメッセージ一覧」(4-12) の「取り下げの不可」、図/画面詳細図「日誌一覧画面」(3-1) 項目13、
     詳細設計書「日誌の画面（作り直し）」(2-13) の (2)（409 なら文を出し、読み直す）・「日誌の状態」(3-6) */
  test('06-013 取り下げと差し戻しが重なったとき', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-013', status: '2' }, today);
    await openDiary(page, id);
    await expect(mainOf(page).getByRole('button', { name: '申請を取り下げる' })).toBeVisible();
    const admin = await openWindow(browser, 'admin');
    await openApproval(admin, id);
    await mainOf(admin).getByRole('textbox', { name: /差し戻す理由/ }).fill('受入テスト 06-013');
    await mainOf(admin).getByRole('button', { name: '差し戻す' }).click();
    await expect(admin.getByRole('heading', { name: '承認待ち', level: 1 })).toBeVisible();

    const withdraw = mainOf(page).getByRole('button', { name: '申請を取り下げる' });
    if (await withdraw.isVisible().catch(() => false)) {
      await withdraw.click();
      const dialog = page.getByRole('dialog');
      if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) await dialog.getByRole('button', { name: '取り下げる' }).click();
      await expect.soft(page.getByText('すでに承認または差し戻しされたため、取り下げられません。').first(), '取り下げの不可の文').toBeVisible();
    } else {
      note('差し戻しの知らせで画面が先に読み直され、「申請を取り下げる」が消えていた（押す前に差し戻しになった）');
    }
    await expect.soft(mainOf(page).getByText(/状態[：:]\s*差し戻し/), '画面が読み直され状態が「差し戻し」').toBeVisible({ timeout: 10_000 });
    const d = diaryById(id)!;
    expect.soft(d.status, "status＝'4'（下書きに戻らない）").toBe('4');
    expect.soft(d.returned_reason, 'returned_reason のまま').toBe('受入テスト 06-013');
    await evidence(page, '06-013');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（取り下げた日誌は承認できない）、基本設計書「日誌の作成から承認まで」(4-6) の処理9・「申請の取り下げ」(4-6)・
     「入力項目の制約値とメッセージ一覧」(4-12) の「取り下げ後の承認」、図/画面詳細図「日誌承認画面（管理者）」(3-5) 項目8、詳細設計書「日誌の状態」(3-6)・「日誌」(4-13) の (2) */
  test('06-014 取り下げたあとに承認を押したとき', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-014', status: '2' }, today);
    const admin = await openWindow(browser, 'admin');
    await openApproval(admin, id);
    await expect(mainOf(admin).getByRole('button', { name: '承認する' })).toBeEnabled();

    await gotoList(page);
    await listRow(page, id).getByRole('button', { name: '申請を取り下げる' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取り下げる' }).click();
    await expect(toast(page, /取り下げました/)).toBeVisible();

    const logBefore = maxLogId();
    const approve = mainOf(admin).getByRole('button', { name: '承認する' });
    await admin.waitForTimeout(1500);
    if (await approve.isEnabled().catch(() => false)) await approve.click();
    await expect.soft(admin.getByText('この日誌は取り下げられました。').first(), '「この日誌は取り下げられました。」が出る').toBeVisible();
    const d = diaryById(id)!;
    expect.soft(d.status, "status＝'1'").toBe('1');
    expect.soft(d.approved_staff_id ?? null, 'approved_staff_id は空').toBeNull();
    expect.soft(logsAfter(logBefore).filter((l) => l.function_type === '1' && l.operation_type === '3' && Number(l.target_id) === id && !/差し戻/.test(l.after_value ?? '')), '承認の操作ログが増えない').toHaveLength(0);
    await evidence(admin, '06-014');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（自分が申請した日誌は承認できない。差し戻しはできる）、基本設計書「日誌の作成から承認まで」(4-6) の処理9 と箇条・
     「入力項目の制約値とメッセージ一覧」(4-12) の「自分の申請の承認」、図/画面詳細図「承認待ち一覧画面（管理者）」(3-4) 項目4、「日誌承認画面（管理者）」(3-5) 項目8 と注記、
     「職員ダッシュボード」(2-6) 項目8、詳細設計書「日誌」(4-13) の (2) */
  test('06-015 自分が申請した日誌は承認できない', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'admin');
    await gotoDashboard(page);
    const dashBefore = (await mainOf(page).innerText()).replace(/\s+/g, ' ');
    const ownBefore = Number(/うち自分の申請\s*(\d+)/.exec(dashBefore)?.[1] ?? 0);
    const a = await createDiary(page, { type: '2', className: 'さくら組', body: '受入テスト 06-015 承認できない', status: '2' }, today);
    const b = await createDiary(page, { type: '2', className: 'さくら組', body: '受入テスト 06-015 差し戻せる', status: '2' }, today);
    await gotoDashboard(page);
    const dash = (await mainOf(page).innerText()).replace(/\s+/g, ' ');
    expect.soft(dash, 'ダッシュボードの「承認待ちの日誌」に自分の申請の数と「ほかの管理者へ」').toMatch(/うち自分の申請\s*\d+\s*件[：:]\s*ほかの管理者へ/);
    expect.soft(Number(/うち自分の申請\s*(\d+)/.exec(dash)?.[1] ?? 0), '自分の申請の数が2つ増える').toBe(ownBefore + 2);

    await gotoPending(page);
    await expect.soft(pendingRow(page, a), '「ほかの管理者へ」が付く').toContainText('ほかの管理者へ');
    await expect.soft(pendingRow(page, b)).toContainText('ほかの管理者へ');
    await openApproval(page, a);
    await expect.soft(mainOf(page).getByText('自分が申請した日誌は承認できません。ほかの管理者に依頼してください。'), '承認できない旨の文（設計書の文言）').toBeVisible();
    await expect.soft(mainOf(page).getByRole('button', { name: '承認する' }), '「承認する」を押せない').toBeDisabled();
    await evidence(page, '06-015');

    await openApproval(page, b);
    await mainOf(page).getByRole('textbox', { name: /差し戻す理由/ }).fill('受入テスト 06-015');
    await mainOf(page).getByRole('button', { name: '差し戻す' }).click();
    await expect(page.getByRole('heading', { name: '承認待ち', level: 1 })).toBeVisible();
    expect.soft(diaryById(b)!.status, '自分の申請でも差し戻せる').toBe('4');

    const e = await openWindow(browser, 'admin2');
    await openApproval(e, a);
    await mainOf(e).getByRole('button', { name: '承認する' }).click();
    await expect(e.getByRole('heading', { name: '承認待ち', level: 1 })).toBeVisible();
    const da = diaryById(a)!;
    expect.soft(da.status, '管理者B は承認できる').toBe('3');
    expect.soft(da.approved_staff_id, 'approved_staff_id＝遠藤 直人').toBe(staffIdOf(ENDO));
  });

  /* 典拠：基本設計書「日誌の作成から承認まで」(4-6)（判定に使うのは申請者の列）・「日誌（t_diary）」(5-5)、図/画面詳細図「承認待ち一覧画面（管理者）」(3-4) の注記、
     「日誌承認画面（管理者）」(3-5) 項目2、詳細設計書「日誌の状態」(3-6) */
  test('06-016 作成者と申請者が違うとき', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'admin');
    const id = await createDiary(page, { type: '2', className: 'さくら組', body: '受入テスト 06-016' }, today);
    const s = await openWindow(browser, 'staffSakura');
    await openDiary(s, id);
    await appendBody(s, '（鈴木 直した）');
    await confirmAndApply(s);

    await gotoPending(page);
    await expect.soft(pendingRow(page, id), '申請者は鈴木 浩之').toContainText(SUZUKI);
    await expect.soft(pendingRow(page, id), '「ほかの管理者へ」が付かない').not.toContainText('ほかの管理者へ');
    await openApproval(page, id);
    await expect.soft(mainOf(page), '申請者「鈴木 浩之」').toContainText(new RegExp(`申請者\\s*${SUZUKI}`));
    await expect.soft(mainOf(page), '作成者「西田 拓也」').toContainText(new RegExp(`作成者\\s*${NISHIDA}`));
    await expect(mainOf(page).getByRole('button', { name: '承認する' }), '作成者の管理者が承認できる').toBeEnabled();
    await evidence(page, '06-016');
    await mainOf(page).getByRole('button', { name: '承認する' }).click();
    await expect(page.getByRole('heading', { name: '承認待ち', level: 1 })).toBeVisible();
    const d = diaryById(id)!;
    expect.soft(d.created_staff_id, 'created_staff_id＝西田').toBe(staffIdOf(NISHIDA));
    expect.soft(d.applied_staff_id, 'applied_staff_id＝鈴木').toBe(staffIdOf(SUZUKI));
    expect.soft(d.approved_staff_id, 'approved_staff_id＝西田').toBe(staffIdOf(NISHIDA));
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（承認の取り消し）、基本設計書「承認の取り消し」(4-6)・「日誌（t_diary）」(5-5)・「入力項目の制約値とメッセージ一覧」(4-12)、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目27 と注記、「日誌承認画面（管理者）」(3-5) の注記、図/画面遷移図「日誌システム」(4)、
     詳細設計書「日誌の画面（作り直し）」(2-13) の (3)・「日誌の状態」(3-6)・「日誌」(4-13) の (5) */
  test('06-017 承認の取り消し', async ({ page, browser }) => {
    const today = jstToday();
    const admin = await openWindow(browser, 'admin');
    const x = await createDiary(admin, { type: '2', className: 'さくら組', body: '受入テスト 06-016' }, today);
    const s = await openWindow(browser, 'staffSakura');
    await applyDiary(s, x);
    await approveDiary(admin, x);
    const y = await createDiary(admin, { type: '2', className: 'さくら組', body: '受入テスト 06-015 承認できない', status: '2' }, today);
    await login(page, 'admin2');
    await approveDiary(page, y);

    await gotoPending(page);
    await expect.soft(pendingLink(page, x), '承認済みの日誌は承認待ち一覧画面に並ばない').toHaveCount(0);
    await gotoList(page);
    await listLink(page, x).click();
    await expect(page.getByRole('heading', { name: '日誌の編集', level: 1 })).toBeVisible();
    const main = mainOf(page);
    await expect.soft(main.getByText('承認済みのため編集できません。'), '読み取り専用で開く').toBeVisible();
    const revoke = main.getByRole('button', { name: '承認を取り消して差し戻す' });
    await expect(revoke, '「承認を取り消して差し戻す」がある').toBeVisible();
    const logBefore = maxLogId();
    await revoke.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect.soft(dialog, 'ダイアログの文').toContainText('承認を取り消して差し戻します。作成者の一覧に差し戻しとして出ます。保護者へは何も届いていません。');
    const reasonBox = dialog.getByRole('textbox', { name: /理由/ });
    await expect.soft(reasonBox, '理由の欄').toBeVisible();
    await expect.soft(dialog, '残りの文字数').toContainText(/残り\s*500\s*文字/);
    await expect.soft(dialog.getByRole('button', { name: 'やめる' })).toBeVisible();
    const go = dialog.getByRole('button', { name: '取り消して差し戻す' });
    if (await go.count()) await expect.soft(go, '理由が空のうちは押せない').toBeDisabled();
    const reason = '受入テスト 06-017 記録日の誤り';
    await reasonBox.fill(reason);
    await expect(go).toBeEnabled();
    await go.click();
    await expect.soft(toast(page, '承認を取り消し、差し戻しました。'), '結果の表示').toBeVisible();
    await page.reload();
    await expect.soft(mainOf(page).getByText(/状態[：:]\s*差し戻し/), '読み直すと状態「差し戻し」').toBeVisible();
    await expect.soft(mainOf(page), '差し戻しの理由に入れた理由').toContainText(reason);
    await evidence(page, '06-017');

    const dx = diaryById(x)!;
    expect.soft(dx.status, "status＝'4'").toBe('4');
    expect.soft(dx.approved_staff_id ?? null, 'approved_staff_id が空').toBeNull();
    expect.soft(dx.approved_at ?? null, 'approved_at が空').toBeNull();
    expect.soft(dx.returned_reason, 'returned_reason＝理由').toBe(reason);
    const logs = logsAfter(logBefore).filter((l) => l.function_type === '1' && l.operation_type === '2' && Number(l.target_id) === x);
    expect.soft(logs, '操作ログに 1・2 の行').toHaveLength(1);
    expect.soft(logs[0]?.before_value ?? '', 'before_value に承認者・承認日時').toMatch(new RegExp(`${NISHIDA}|承認`));
    expect.soft(logs[0]?.after_value ?? '', 'after_value に「承認の取り消し」と理由').toContain(reason);

    // 自分（管理者B）が承認したものも取り消せる
    await openDiary(page, y);
    await mainOf(page).getByRole('button', { name: '承認を取り消して差し戻す' }).click();
    await page.getByRole('dialog').getByRole('textbox', { name: /理由/ }).fill('受入テスト 06-017 自分の承認');
    await page.getByRole('dialog').getByRole('button', { name: '取り消して差し戻す' }).click();
    await expect.poll(() => diaryById(y)!.status, { message: '自分が承認した日誌も取り消せる' }).toBe('4');

    // 作成者（管理者A）の一覧に差し戻しとして出る
    await gotoList(admin);
    await mainOf(admin).getByRole('combobox', { name: '状態' }).selectOption({ label: '差し戻し' });
    await mainOf(admin).getByRole('button', { name: '絞り込む' }).click();
    await expect.soft(listRow(admin, x), '作成者の一覧に差し戻しとして出る').toContainText('差し戻し');
    await expect.soft(listRow(admin, y)).toContainText('差し戻し');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（確認・承認・承認の取り消しは管理者）、基本設計書「権限と利用可能機能」(6-1)・「画面基本構成」(3-5) のサイドナビゲーション、
     図/画面詳細図「職員（タブレット／PC）」(1-1) 項目5 と注記、「承認待ち一覧画面（管理者）」(3-4) の注記、「日誌作成・編集画面」(3-2) 項目27 */
  test('06-018 一般には承認と承認の取り消しを出さない', async ({ page, browser }) => {
    const today = jstToday();
    const admin = await openWindow(browser, 'admin');
    await login(page, 'staffSakura');
    const approved = await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-018 承認済み', status: '2' }, today);
    await approveDiary(admin, approved);
    const pending = await createDiary(page, { type: '1', child: MISAKI, body: '受入テスト 06-018 申請中', status: '2' }, today);
    await gotoPending(admin);
    const pendingUrl = new URL(admin.url()).pathname;
    await openApproval(admin, pending);
    const approvalUrl = new URL(admin.url()).pathname;

    const nav = page.getByRole('navigation', { name: '職員メニュー' });
    await expect.soft(nav.getByText(/管理（管理者）/), 'サイドナビに「管理（管理者）」が無い').toHaveCount(0);
    await expect.soft(nav.getByRole('link', { name: '承認待ち' }), 'サイドナビに「承認待ち」が無い').toHaveCount(0);
    await openDiary(page, approved);
    await expect.soft(mainOf(page).getByRole('button', { name: '承認を取り消して差し戻す' }), '承認済みの日誌に「承認を取り消して差し戻す」が出ない').toHaveCount(0);

    for (const path of [pendingUrl, approvalUrl]) {
      await page.goto(path);
      await expect.soft(page.getByRole('heading', { name: 'ダッシュボード', level: 1 }), `${path}：職員ダッシュボードへ戻される`).toBeVisible();
      await expect.soft(page.getByText(/管理者/).filter({ hasText: /利用|使え|だけ|のみ/ }).first(), `${path}：管理者だけが使える画面である旨`).toBeVisible();
      await expect.soft(mainOf(page).getByRole('button', { name: /承認する|差し戻す/ }), `${path}：承認・差し戻しの部品が無い`).toHaveCount(0);
    }
    await evidence(page, '06-018');
  });
});

// =====================================================================
// 同時編集のロック（2つの窓）
// =====================================================================

test.describe('同時編集のロック', () => {
  /* 典拠：要件定義書「同時編集の扱い」(4-1-4 (3))、基本設計書「日誌の作成から承認まで」(4-6) の処理2・「同時編集の検出」(4-2)・「編集ロック（t_diary_lock）」(5-5)・
     「入力項目の制約値とメッセージ一覧」(4-12) の「他者が編集中」、図/画面詳細図「日誌作成・編集画面」(3-2) 項目3・14 と注記、
     詳細設計書「日誌の画面（作り直し）」(2-13) の (9)・「日誌の状態」(3-6) の編集ロック */
  test('06-019 他の職員が編集中', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '2', className: 'さくら組', body: '受入テスト 06-019' }, today);
    await gotoList(page);
    await listLink(page, id).click();
    await expect(bodyBox(page)).toBeEnabled();
    await expect.poll(() => lockOf(id).length, { message: '窓1 がロックを取る' }).toBe(1);

    const m = await openMurata(browser);
    await openDiary(m, id);
    const main = mainOf(m);
    await expect(lockNotice(m), '編集中の警告が出る').toBeVisible();
    await expect.soft(main.getByText('他の職員が編集しています。'), '設計書の文言「他の職員が編集しています。」').toBeVisible();
    await expect.soft(main.getByText(/ロックの解除は管理者へ依頼してください/), '「ロックの解除は管理者へ依頼してください」').toBeVisible();
    await expectReadOnly(m);
    await expect.soft(main.getByRole('button', { name: /強制解除/ }), '一般に「ロックを強制解除する」は出ない').toHaveCount(0);
    await evidence(m, '06-019');

    await appendBody(page, '受入テスト 06-019 一般S');
    await saveDraft(page);
    await expect.soft(toast(page, /保存/), '窓1 はそのまま下書き保存できる').toBeVisible();
    const locks = lockOf(id);
    expect.soft(locks, 'SQL：ロックの行は1つ').toHaveLength(1);
    expect.soft(locks[0]?.locked_staff_id, 'locked_staff_id＝鈴木 浩之').toBe(staffIdOf(SUZUKI));
  });

  /* 典拠：要件定義書「編集ロックの解除」(4-1-4 (3))、基本設計書「日誌の作成から承認まで」(4-6) の処理4・6・「編集ロックの解除」(4-6)・「画面遷移」(3-4)、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目13、「日誌確認画面」(3-3) 項目1・4 と注記、詳細設計書「日誌の画面（作り直し）」(2-13) の (9) */
  test('06-020 確認画面にいる間もロックを持ち続ける', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '2', className: 'さくら組', body: '受入テスト 06-019' }, today);
    await openDiary(page, id);
    await expect.poll(() => lockOf(id).length).toBe(1);
    const token = lockOf(id)[0].lock_token;
    await appendBody(page, '受入テスト 06-020 確認中');
    await confirmButton(page).click();
    await expect(applyButton(page)).toBeVisible();

    const m = await openMurata(browser);
    await openDiary(m, id);
    await expect.soft(lockNotice(m), '確認画面にいる間も、窓2 は編集中の警告').toBeVisible();
    await expect.soft(bodyBox(m), '窓2 は編集できない').toBeDisabled();
    expect.soft(lockOf(id)[0]?.lock_token, 'ロックの行は消えず、lock_token も同じ').toBe(token);

    await mainOf(page).getByRole('button', { name: '戻る' }).click();
    await expect(bodyBox(page)).toBeVisible();
    await expect.soft(bodyBox(page), '足した本文が残る').toHaveValue(/受入テスト 06-020 確認中/);
    await expect.soft(bodyBox(page), '続けて編集できる').toBeEnabled();
    await openDiary(m, id);
    await expect.soft(lockNotice(m), '戻ったあとも窓2 は編集できない').toBeVisible();
    expect.soft(lockOf(id)[0]?.lock_token, 'lock_token は同じ').toBe(token);

    await confirmAndApply(page);
    expect.soft(lockOf(id), '申請するとロックの行が消える').toHaveLength(0);
    expect.soft(diaryById(id)!.status, "status＝'2'").toBe('2');
    await openDiary(m, id);
    await expect.soft(mainOf(m).getByText('申請中のため編集できません。'), '窓2：申請中の読み取り専用').toBeVisible();
    await expect.soft(lockNotice(m), '「他の職員が編集しています。」は出ない').toHaveCount(0);
    expect.soft(lockOf(id), 'ロックの行はできない').toHaveLength(0);
    await evidence(m, '06-020');
  });

  /* 典拠：要件定義書「編集ロックの解除」(4-1-4 (3)) の管理者による強制解除・「同時編集の扱い」(4-1-4 (3))、基本設計書「編集ロックの解除」(4-6)・「同時編集の検出」(4-2)・
     「編集ロック（t_diary_lock）」(5-5)・「入力項目の制約値とメッセージ一覧」(4-12)、図/画面詳細図「日誌作成・編集画面」(3-2) 項目14、
     図/インタフェース一覧 DELETE /api/diaries/{id}/lock、詳細設計書「日誌の状態」(3-6) の編集ロック・「日誌」(4-13) の (1) */
  test('06-021 管理者による強制解除', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '2', className: 'さくら組', body: '受入テスト 06-021' }, today);
    await openDiary(page, id);
    await expect.poll(() => lockOf(id).length).toBe(1);
    const token = lockOf(id)[0].lock_token;
    await appendBody(page, '受入テスト 06-021 入力中');

    const admin = await openWindow(browser, 'admin');
    await openDiary(admin, id);
    await expect.soft(lockNotice(admin), '窓2 に編集中の警告').toBeVisible();
    const force = mainOf(admin).getByRole('button', { name: 'ロックを強制解除する' });
    await expect(force, '管理者にだけ「ロックを強制解除する」').toBeVisible();
    const logBefore = maxLogId();
    await force.click();
    const dialog = admin.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect.soft(dialog, '相手が編集を終えていることを確かめる旨').toContainText(/編集を終えて/);
    await dialog.getByRole('button', { name: /強制解除/ }).last().click();
    await expect.poll(() => lockOf(id).filter((l) => l.lock_token === token).length, { message: '一般S の lock_token の行が無くなる' }).toBe(0);
    const logs = logsAfter(logBefore).filter((l) => l.function_type === '1' && Number(l.target_id) === id);
    expect.soft(logs, '操作ログに解除の行が1つ増え、どの日誌かが分かる').toHaveLength(1);

    await saveDraft(page);
    await expect.soft(page.getByText(/編集ロックが解除されました。内容を再読み込みしてください/).first(), '解除された編集者の保存は断られる').toBeVisible();
    await expect.soft(bodyBox(page), '入力中の内容が残る').toHaveValue(/受入テスト 06-021 入力中/);
    expect.soft(diaryById(id)!.body, 'SQL：保存されていない').not.toContain('受入テスト 06-021 入力中');
    await evidence(page, '06-021');
  });

  /* 典拠：要件定義書「編集ロックの解除」(4-1-4 (3)) の無操作の経過、基本設計書「編集ロックの解除」(4-6)・「設定マスタ（m_setting）」(5-9) の ui.diary_lock_minutes・
     「編集ロック（t_diary_lock）」(5-5) の last_active_at、詳細設計書「日誌の状態」(3-6) の編集ロック・「日誌」(4-13) の (1) */
  test('06-022 無操作の経過で解除', async ({ page, browser, context }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '2', className: 'さくら組', body: '受入テスト 06-022' }, today);
    await openDiary(page, id);
    await expect.poll(() => lockOf(id).length).toBe(1);
    const token = lockOf(id)[0].lock_token;
    await appendBody(page, '受入テスト 06-022 一般S');

    // 窓1 を止める（端末が眠った状態）。延長の要求が出ないようにする
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    // 【SQL】(W1) ロックの最終操作の時刻を16分前にする（書く前に読み、同じ形で書く）
    const sample = lockOf(id)[0].last_active_at;
    sqlRun('UPDATE t_diary_lock SET last_active_at = ? WHERE diary_id = ?', sameFormatShift(sample, new Date(), -16), id);

    const m = await openMurata(browser);
    await openDiary(m, id);
    await expect.soft(lockNotice(m), '窓2 は編集中の警告を出さない').toHaveCount(0);
    await expect(bodyBox(m), '窓2 は編集できる').toBeEnabled();
    await expect.poll(() => lockOf(id)[0]?.locked_staff_id, { message: 'ロックが村田 真一に移る' }).toBe(staffIdOf('村田 真一'));
    expect.soft(lockOf(id)[0]?.lock_token, 'lock_token が窓1 と違う').not.toBe(token);
    await appendBody(m, '受入テスト 06-022 一般M');
    await saveDraft(m);
    await expect.soft(toast(m, /保存/), '窓2 の下書き保存が通る').toBeVisible();

    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await saveDraft(page);
    await expect.soft(page.getByText(/編集ロックが解除されました。内容を再読み込みしてください/).first(), '窓1 の保存は断られる').toBeVisible();
    await expect.soft(bodyBox(page), '窓1 の本文に入力中の内容が残る').toHaveValue(/受入テスト 06-022 一般S/);
    const body = diaryById(id)!.body;
    expect.soft(body, 'SQL：一般M の文を含む').toContain('受入テスト 06-022 一般M');
    expect.soft(body, 'SQL：一般S の文を含まない').not.toContain('受入テスト 06-022 一般S');
    await evidence(page, '06-022');
  });

  /* 典拠：要件定義書「編集ロックの解除」(4-1-4 (3)) の正常終了、基本設計書「編集ロックの解除」(4-6)・「ログアウト」(4-3)、図/画面詳細図「日誌作成・編集画面」(3-2) 項目1 と注記、
     「職員（タブレット／PC）」(1-1) 項目4、図/インタフェース一覧 POST /api/logout、詳細設計書「日誌の画面（作り直し）」(2-13) の (9) */
  test('06-023 画面を離れる・タブを閉じる・ログアウトで解除', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '2', className: 'さくら組', body: '受入テスト 06-023' }, today);
    const suzukiId = staffIdOf(SUZUKI);
    const muraId = staffIdOf('村田 真一');

    // ① 画面を離れる
    await openDiary(page, id);
    await expect.poll(() => lockOf(id)[0]?.locked_staff_id).toBe(suzukiId);
    await appendBody(page, '受入テスト 06-023 未保存');
    let nativeAsked = false;
    page.once('dialog', (d) => {
      nativeAsked = true;
      void d.dismiss();
    });
    await mainOf(page).getByRole('link', { name: /日誌一覧へ/ }).click();
    const ask = page.getByRole('dialog').or(page.getByRole('alertdialog'));
    let domAsked = false;
    if (await ask.isVisible({ timeout: 3000 }).catch(() => false)) {
      domAsked = true;
      await ask.getByRole('button', { name: /やめる|キャンセル|戻る|とどまる/ }).first().click();
    }
    expect.soft(nativeAsked || domAsked, '保存していない内容があるときは確かめが出る').toBe(true);
    await expect.soft(bodyBox(page), 'やめると内容が残る').toHaveValue(/受入テスト 06-023 未保存/);
    await saveDraft(page);
    await expect(toast(page, /保存/)).toBeVisible();
    await mainOf(page).getByRole('link', { name: /日誌一覧へ/ }).click();
    await expect.soft(page.getByRole('heading', { name: '日誌', level: 1 }), '保存したあとは確かめずに一覧へ戻る').toBeVisible();
    await expect.poll(() => lockOf(id).filter((l) => l.locked_staff_id === suzukiId).length, { message: '①のあと、鈴木のロックが残らない' }).toBe(0);
    const w2 = await newWindow(browser);
    await loginMurata(w2.page);
    await openDiary(w2.page, id);
    await expect.soft(bodyBox(w2.page), '①：窓2 は編集できる').toBeEnabled();
    await expect.poll(() => lockOf(id)[0]?.locked_staff_id).toBe(muraId);

    // ② タブを閉じる
    await w2.page.close({ runBeforeUnload: true });
    await expect.poll(() => lockOf(id).filter((l) => l.locked_staff_id === muraId).length, { message: '②のあと、村田のロックが残らない', timeout: 10_000 }).toBe(0);
    await openDiary(page, id);
    await expect.soft(bodyBox(page), '②：窓1 は編集できる').toBeEnabled();

    // ③ ログアウト
    await appendBody(page, '受入テスト 06-023 ログアウト前');
    let nativeLogout = false;
    page.once('dialog', (d) => {
      nativeLogout = true;
      void d.accept();
    });
    await page.getByRole('banner').getByRole('button', { name: 'ログアウト', exact: true }).click();
    const ask2 = page.getByRole('dialog').or(page.getByRole('alertdialog'));
    let domLogout = false;
    if (await ask2.isVisible({ timeout: 3000 }).catch(() => false)) {
      domLogout = true;
      await ask2.getByRole('button', { name: /ログアウト|破棄|進む|はい/ }).last().click();
    }
    expect.soft(nativeLogout || domLogout, 'ログアウトで破棄される旨の確かめが出る').toBe(true);
    await expect.soft(page.getByLabel('ログインID', { exact: true }), '職員用トップへ戻る').toBeVisible();
    await expect.poll(() => lockOf(id).filter((l) => l.locked_staff_id === suzukiId).length, { message: '③のあと、鈴木のロックが残らない', timeout: 10_000 }).toBe(0);
    const w3 = await newWindow(browser);
    await loginMurata(w3.page);
    await openDiary(w3.page, id);
    await expect.soft(bodyBox(w3.page), '③：一般M は編集できる').toBeEnabled();
    await evidence(w3.page, '06-023');
  });
});

// =====================================================================
// 雛形・定型文・写真・AI
// =====================================================================

test.describe('雛形・定型文・写真・AI', () => {
  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（テンプレート選択）、基本設計書「日誌の作成から承認まで」(4-6) の処理3・「雛形・添付」(5-5)、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目7、「設定画面（管理者）」(7-10) 項目7、詳細設計書「設定画面（管理者）」(2-14) の (3) */
  test('06-024 雛形を呼び出す', async ({ page }) => {
    // 前提：日誌の雛形を2つ足す。設定画面に「定型文・雛形」の区画が無く（2026-10-26 に画面で確かめた）、雛形を足す経路（POST /api/diaries/templates）も 404 のため、SQL で足す
    await login(page, 'staffSakura');
    sqlRun("INSERT INTO m_diary_template (record_type, template_name, body, is_deleted) VALUES ('2', ?, ?, 0)", '受入テスト 06-024 クラス', '【きょうの活動】\n【子どものようす】');
    sqlRun("INSERT INTO m_diary_template (record_type, template_name, body, is_deleted) VALUES ('1', ?, ?, 0)", '受入テスト 06-024 個人', '【個人のようす】');
    await newDiary(page);
    await mainOf(page).getByRole('radio', { name: 'クラス日誌' }).check();
    const tpl = mainOf(page).getByRole('combobox', { name: /雛形/ });
    const options = (await tpl.locator('option').allInnerTexts()).map((t) => t.trim());
    expect.soft(options, '雛形の一覧に「06-024 クラス」がある').toContain('受入テスト 06-024 クラス');
    expect.soft(options, '「06-024 個人」は無い（記録種別に応じた雛形）').not.toContain('受入テスト 06-024 個人');
    await tpl.selectOption({ label: '受入テスト 06-024 クラス' });
    await expect.soft(bodyBox(page), '本文が空のときは雛形の本文になる').toHaveValue(/^【きょうの活動】\r?\n【子どものようす】\s*$/);
    await appendBody(page, '受入テスト 06-024 書きかけ');
    if ((await tpl.locator('option:checked').innerText()).includes('受入テスト 06-024 クラス')) await tpl.selectOption({ index: 0 });
    await tpl.selectOption({ label: '受入テスト 06-024 クラス' });
    const body = nl(await bodyBox(page).inputValue());
    expect.soft(body, '置き換えず、書きかけの後ろ（本文の末尾）に足される').toMatch(/^【きょうの活動】\n【子どものようす】\s*受入テスト 06-024 書きかけ\s*【きょうの活動】\n【子どものようす】\s*$/);
    await expect.soft(mainOf(page).getByRole('radio', { name: 'クラス日誌' }), '記録種別はクラス日誌のまま').toBeChecked();
    await evidence(page, '06-024');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（定型文：候補から選んで入れる）、基本設計書「日誌の作成から承認まで」(4-6) の処理3・「定型文（m_phrase）」(5-9)、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目8、「共通のダイアログと部品」(1-3) の (5)、詳細設計書「日誌の画面（作り直し）」(2-13) の (1)・「日誌」(4-13) の (10) */
  test('06-025 定型文を候補から入れる', async ({ page }) => {
    // 前提：使う場所「日誌」と「園から」の定型文。設定画面に「定型文・雛形」の区画が無く、定型文を足す経路（POST /api/phrases）も 404 のため、
    // デモデータの定型文（m_phrase）を使う（SQL で足した行は画面の候補に出なかった。2026-10-26。case-fixes.md）
    await login(page, 'staffSakura');
    const diaryPhrases = sqlAll<{ body: string }>("SELECT body FROM m_phrase WHERE phrase_scope = '4' AND is_deleted = 0 ORDER BY display_order").map((r) => r.body);
    const facilityPhrases = sqlAll<{ body: string }>("SELECT body FROM m_phrase WHERE phrase_scope = '1' AND is_deleted = 0 ORDER BY display_order").map((r) => r.body);
    expect(diaryPhrases.length, '前提：使う場所「日誌」の定型文がある').toBeGreaterThan(0);
    const pick = diaryPhrases[0];
    await newDiary(page);
    await mainOf(page).getByRole('radio', { name: 'クラス日誌' }).check();
    await bodyBox(page).fill('受入テスト 06-025 本文');
    const phrase = mainOf(page).getByRole('combobox', { name: /定型文/ }).or(mainOf(page).getByRole('button', { name: /定型文/ })).first();
    await expect(phrase, '「定型文を入れる」がある').toBeVisible();
    const isSelect = (await phrase.evaluate((el) => el.tagName)) === 'SELECT';
    if (isSelect) {
      const options = (await phrase.locator('option').allInnerTexts()).map((t) => t.trim());
      for (const p of diaryPhrases) expect.soft(options, `候補に使う場所「日誌」の定型文「${p}」がある`).toContain(p);
      for (const p of facilityPhrases) expect.soft(options, `使う場所「園から」の定型文「${p}」は無い`).not.toContain(p);
      if (options.includes(pick)) await phrase.selectOption({ label: pick });
    } else {
      await phrase.click();
      await expect.soft(page.getByText(pick).first()).toBeVisible();
      for (const p of facilityPhrases) await expect.soft(page.getByText(p)).toHaveCount(0);
      await page.getByText(pick).first().click();
    }
    const body = nl(await bodyBox(page).inputValue());
    expect.soft(body.startsWith('受入テスト 06-025 本文'), 'もとの本文は消えない（置き換えない）').toBe(true);
    expect.soft(body.trimEnd().endsWith(pick), '本文の末尾に足される').toBe(true);
    await evidence(page, '06-025');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（写真添付：3枚まで）、基本設計書「日誌の作成から承認まで」(4-6) の処理3・「入力項目の制約値」(4-12) の日誌の写真・「雛形・添付」(5-5)、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目10 と注記、「日誌確認画面」(3-3) 項目3、「日誌承認画面（管理者）」(3-5) 項目3、「モックアップでは実装しないもの」(12-1) の「共通」 */
  test('06-026 写真を3枚まで添える', async ({ page }) => {
    await login(page, 'staffSakura');
    await newDiary(page);
    await mainOf(page).getByRole('radio', { name: 'クラス日誌' }).check();
    await bodyBox(page).fill('受入テスト 06-026');
    const add = mainOf(page).getByRole('button', { name: /追加/ });
    const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
    await add.click();
    const fc = await chooser;
    // 【12-1】写真のファイル選択（JPEG・PNG）が画面に無ければ、実装対象の外として未実施にする
    test.skip(!fc, notIn121('日誌の写真のファイル選択（「＋ 追加」はファイルを選ばずに仮の写真を足す）'));
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 60 });
    const png = await page.screenshot({ type: 'png' });
    await fc!.setFiles({ name: 'p1.jpg', mimeType: 'image/jpeg', buffer: jpeg });
    for (const f of [{ name: 'p2.jpg', mimeType: 'image/jpeg', buffer: jpeg }, { name: 'p3.png', mimeType: 'image/png', buffer: png }]) {
      const c = page.waitForEvent('filechooser');
      await add.click();
      await (await c).setFiles(f);
    }
    await expect.soft(add, '3枚に達すると追加の操作が無効').toBeDisabled();
    await expect.soft(page.getByRole('dialog', { name: /写っている子/ }), '写っている子を選ぶダイアログが出ない').toHaveCount(0);
    await saveDraft(page);
    await expect(toast(page, /保存/)).toBeVisible();
    await confirmButton(page).click();
    await expect.soft(mainOf(page), '日誌確認画面の写真の枚数が3').toContainText(/写真\s*3\s*枚/);
    await applyButton(page).click();
    const [d] = diariesLike('受入テスト 06-026');
    expect.soft(sqlAll('SELECT diary_attachment_id FROM t_diary_attachment WHERE diary_id = ?', d.diary_id), 'SQL：添付が3つ').toHaveLength(3);
    await evidence(page, '06-026');
  });

  /* 典拠：要件定義書「文章の下書き（AI）」(4-1-8) の守り、基本設計書「使えないとき（AI 無しで動くこと）」(4-11)・「権限と利用可能機能」(6-1) の ※11、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目24、「共通のダイアログと部品」(1-3) の (6)、テスト仕様書の下書き「テスト対象の機能」(1.5) */
  test('06-027 AI の下書きのボタンが出ない', async ({ page }) => {
    await login(page, 'staffSakura');
    await newDiary(page);
    const main = mainOf(page);
    for (const type of ['個人日誌', 'クラス日誌', '週案・月案', 'ヒヤリハット']) {
      await main.getByRole('radio', { name: type }).check();
      if (type === '個人日誌' || type === 'ヒヤリハット') await childSelect(page).selectOption({ label: TARO });
      await expect.soft(main.getByRole('button', { name: /AI の下書き|言い換え|続きの候補/ }), `${type}：AI のボタンが出ない`).toHaveCount(0);
      await expect.soft(main.getByRole('textbox', { name: /メモ/ }), `${type}：メモの欄が出ない`).toHaveCount(0);
      await expect.soft(main.getByText(/AI の下書きです/), `${type}：AI の下書きの注意が出ない`).toHaveCount(0);
    }
    await main.getByRole('radio', { name: 'クラス日誌' }).check();
    await bodyBox(page).fill('受入テスト 06-027');
    await saveDraft(page);
    await expect.soft(toast(page, /保存/), 'AI が無くても下書き保存できる').toBeVisible();
    await confirmAndApply(page);
    expect.soft(diariesLike('受入テスト 06-027')[0]?.status, 'AI が無くても申請できる').toBe('2');
    await evidence(page, '06-027');
  });
});

// =====================================================================
// ヒヤリハット
// =====================================================================

/** 日誌作成・編集画面でヒヤリハットの欄を入れる */
async function fillIncident(page: Page, v: { child?: string; occurred?: string; place?: string; situation?: string; response?: string; counter?: string; told?: { at: string; method: string; person: string } | 'no' }) {
  const main = mainOf(page);
  await main.getByRole('radio', { name: 'ヒヤリハット' }).check();
  if (v.child) await childSelect(page).selectOption({ label: v.child });
  if (v.occurred !== undefined) await main.getByRole('textbox', { name: /^発生日時/ }).fill(v.occurred);
  if (v.place !== undefined) await main.getByRole('textbox', { name: /^場所/ }).fill(v.place);
  if (v.situation !== undefined) await main.getByRole('textbox', { name: /^状況/ }).fill(v.situation);
  if (v.response !== undefined) await main.getByRole('textbox', { name: /^とった対応/ }).fill(v.response);
  if (v.counter !== undefined) await main.getByRole('textbox', { name: /^今後の対策/ }).fill(v.counter);
  if (v.told === 'no') await main.getByRole('radio', { name: '伝えていない' }).check();
  else if (v.told) {
    await main.getByRole('radio', { name: '伝えた', exact: true }).check();
    await main.getByRole('textbox', { name: /^伝えた日時/ }).fill(v.told.at);
    await main.getByRole('combobox', { name: /^伝えた手段/ }).selectOption({ label: v.told.method });
    await main.getByRole('textbox', { name: /^伝えた相手/ }).fill(v.told.person);
  }
}

/** いまより前の5分刻みの時刻（steps 個ぶん前）。datetime-local の値 */
function pastStep(steps: number): string {
  const step = 5 * 60_000;
  return jstLocal(new Date(Math.floor(Date.now() / step) * step - steps * step));
}

/** その園児の個人チャットのメッセージの数 */
function chatCount(child: string): number {
  return Number(
    sqlOne<{ n: number }>('SELECT COUNT(*) AS n FROM t_chat_message m JOIN m_chat_room r ON r.chat_room_id = m.chat_room_id WHERE r.child_id = ?', childIdOf(child))?.n ?? 0,
  );
}

/** 【保護者窓】保護者の窓で、保護者ホーム・連絡帳画面（きょう）・個人チャットを別々のタブで開く。【知らせ見張り】を入れる */
async function guardianWindows(browser: Browser, who: 'guardian' | 'guardianMurata', child: string) {
  const w = await newWindow(browser, true);
  await watchEvents(w.context);
  const home = w.page;
  await login(home, who);
  await expect(home.getByRole('heading', { name: `${child}さんのきょう` })).toBeVisible();
  const origin = new URL(home.url()).origin;
  const contactHref = await home.getByRole('link', { name: '連絡帳を開く' }).first().getAttribute('href');
  const chatHref = await home.getByRole('link', { name: `${child}の園とのやりとり` }).first().getAttribute('href');
  const contact = await w.context.newPage();
  await contact.goto(origin + contactHref);
  const chat = await w.context.newPage();
  await chat.goto(origin + chatHref);
  await contact.waitForTimeout(1500);
  const pages = [home, contact, chat];
  return {
    home,
    contact,
    chat,
    async homeCounts() {
      const t = (await home.getByRole('main').innerText()).replace(/\s+/g, ' ');
      return { 新着: /新着\s*(\d+)/.exec(t)?.[1] ?? '0', やりとり: new RegExp(`${child}の園とのやりとり\\s*(\\d+)`).exec(t)?.[1] ?? '0' };
    },
    async events() {
      return (await Promise.all(pages.map((p) => eventsSeen(p)))).flat();
    },
    async reloadAll() {
      for (const p of pages) await p.reload();
      await home.waitForTimeout(1500);
    },
    async expectNothing(words: string[], when: string) {
      for (const p of pages) {
        const t = await p.locator('body').innerText();
        for (const word of words) expect.soft(t, `${when}：保護者の画面（${new URL(p.url()).pathname}）に「${word}」が出ない`).not.toContain(word);
      }
    },
  };
}

test.describe('ヒヤリハット', () => {
  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（ヒヤリハットの記録）、基本設計書「ヒヤリハットの記録」(4-6)・「日誌（t_diary）」(5-5)・「入力項目の制約値」(4-12) の日誌、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目18〜21・28、「日誌承認画面（管理者）」(3-5) 項目3、
     詳細設計書「日誌の画面（作り直し）」(2-13) の (8)・「日誌」(4-13) の (1)・(6)・決めたこと D-33 */
  test('06-028 ヒヤリハットを記録する', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await newDiary(page);
    const occurred = pastStep(2);
    const told = pastStep(1);
    const v = {
      place: '園庭（受入テスト 06-028）',
      situation: '受入テスト 06-028 状況：すべり台の階段で足をすべらせかけた',
      response: '受入テスト 06-028 対応：そばで支え、けががないことを確かめた',
      counter: '受入テスト 06-028 対策：階段の上り下りに付き添う',
    };
    const main = mainOf(page);
    await main.getByRole('radio', { name: 'ヒヤリハット' }).check();
    for (const name of [/^発生日時/, /^場所/, /^状況/, /^とった対応/, /^今後の対策/]) await expect.soft(main.getByRole('textbox', { name }), `${name} の欄が出る`).toBeVisible();
    await expect.soft(main.getByRole('group', { name: '保護者へ伝えたこと' }), '保護者へ伝えたことの欄が出る').toBeVisible();
    await expect.soft(main.getByRole('combobox', { name: /定型文/ }).or(main.getByRole('button', { name: /定型文/ })), '定型文のボタンが無い').toHaveCount(0);
    await expect.soft(main.getByRole('button', { name: /AI/ }), 'AI のボタンが無い').toHaveCount(0);
    await expect.soft(main.getByText(/原因|過失/), '原因の判定・過失の評価の欄・表示が無い').toHaveCount(0);
    await fillIncident(page, { child: MISAKI, occurred, ...v, told: { at: told, method: 'お迎えのときに対面', person: '母' } });
    await saveDraft(page);
    await expect(toast(page, /保存/)).toBeVisible();
    const [d] = diariesLike('受入テスト 06-028 状況');
    expect(d, '保存された').toBeTruthy();
    await openDiary(page, d.diary_id);
    await expect.soft(main.getByRole('textbox', { name: /^発生日時/ }), '開き直すと発生日時').toHaveValue(occurred);
    await expect.soft(main.getByRole('textbox', { name: /^場所/ })).toHaveValue(v.place);
    await expect.soft(main.getByRole('textbox', { name: /^状況/ })).toHaveValue(v.situation);
    await expect.soft(main.getByRole('textbox', { name: /^とった対応/ })).toHaveValue(v.response);
    await expect.soft(main.getByRole('textbox', { name: /^今後の対策/ })).toHaveValue(v.counter);
    await expect.soft(main.getByRole('textbox', { name: /^伝えた相手/ })).toHaveValue('母');
    await confirmAndApply(page);

    const admin = await openWindow(browser, 'admin');
    await openApproval(admin, d.diary_id);
    for (const t of [v.place, v.situation, v.response, v.counter, '母', 'お迎えのときに対面']) await expect.soft(mainOf(admin), `日誌承認画面に ${t}`).toContainText(t);
    await expect.soft(mainOf(admin), '日誌承認画面に発生日時').toContainText(new RegExp(occurred.slice(11).replace(/^0/, '0?')));
    await evidence(admin, '06-028');

    const r = diaryById(d.diary_id)!;
    expect.soft(r.record_type, "record_type＝'4'").toBe('4');
    expect.soft(r.child_id, 'child_id＝美咲').toBe(childIdOf(MISAKI));
    expect.soft(Number(r.class_id), 'class_id＝さくら組').toBe(classIdOf('さくら組'));
    expect.soft((r.occurred_at ?? '').slice(0, 16), 'occurred_at＝入れた発生日時').toBe(occurred);
    expect.soft(r.place, 'place').toBe(v.place);
    expect.soft(r.guardian_notice, "guardian_notice＝'1'").toBe('1');
    expect.soft((r.guardian_noticed_at ?? '').slice(0, 16), 'guardian_noticed_at').toBe(told);
    expect.soft(r.guardian_notice_method, "guardian_notice_method＝'2'").toBe('2');
    expect.soft(r.guardian_notice_person, 'guardian_notice_person＝母').toBe('母');
    expect.soft(nl(r.body), 'body は見出しで3つの文をつないだもの').toMatch(new RegExp(`【状況】\\s*${v.situation}[\\s\\S]*【とった対応】\\s*${v.response}[\\s\\S]*【今後の対策】\\s*${v.counter}`));
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の記録種別ごとの表・「保護者へ届けるときの関所」(4-1-6) の段3、基本設計書「保護者へ届けるときの関所」(2-4) の (1) 段3・(3)・
     「ヒヤリハットの記録」(4-6)・「開いている画面への即時の反映（SSE）」(4-10)・「権限と利用可能機能」(6-1)、詳細設計書「知らせの種類と送り先」(6-2) */
  test('06-029 ヒヤリハットは保護者へ届かない', async ({ page, browser }) => {
    const today = jstToday();
    const g = await guardianWindows(browser, 'guardianMurata', MISAKI);
    const before = { home: await g.homeCounts(), chat: chatCount(MISAKI) };

    await login(page, 'staffSakura');
    const v = { place: '園庭（受入テスト 06-029）', situation: '受入テスト 06-029 状況', response: '受入テスト 06-029 対応' };
    const id = await createDiary(page, {
      type: '4', child: MISAKI, body: '', status: '2',
      incident: { occurred_at: `${pastStep(2)}:00`, ...v, guardian_notice: '1', guardian_noticed_at: `${pastStep(1)}:00`, guardian_notice_method: '1', guardian_notice_person: '母' },
    }, today);
    const admin = await openWindow(browser, 'admin');
    await approveDiary(admin, id);
    await g.home.waitForTimeout(4000);

    await g.expectNothing(['06-029', 'ヒヤリハット', '申請', '承認'], 'そのまま');
    expect.soft(await g.homeCounts(), '新着の数・未読の数が増えない').toEqual(before.home);
    expect.soft(await g.events(), '窓2 の知らせに diary の種類が来ない').not.toContain('diary');
    await g.reloadAll();
    await g.expectNothing(['06-029', 'ヒヤリハット'], '再読み込みのあと');
    expect.soft(chatCount(MISAKI), 'SQL：美咲の個人チャットのメッセージの数が変わらない').toBe(before.chat);
    await evidence(g.contact, '06-029');
  });

  /* 典拠：要件定義書「日誌システム」(4-3)・「保護者へ届けるときの関所」(4-1-6) の段3・「データ参照範囲の制限」(8 No.6)、基本設計書「保護者へ届けるときの関所」(2-4) の (1)・(3)・(4)・
     「日誌システム（園内の記録）」(4-6)・「承認の取り消し」(4-6)・「開いている画面への即時の反映（SSE）」(4-10)・「権限と利用可能機能」(6-1)、
     図/画面詳細図「日誌承認画面（管理者）」(3-5) 項目4・5・8、詳細設計書「日誌の画面（作り直し）」(2-13) の (1)・「日誌」(4-13) の (2)・(10)・「知らせの種類と送り先」(6-2) */
  test('06-030 個人日誌はどの操作でも保護者へ届かない', async ({ page, browser }) => {
    const today = jstToday();
    const g = await guardianWindows(browser, 'guardian', TARO);
    const before = { home: await g.homeCounts(), chat: chatCount(TARO) };

    await login(page, 'staffSakura');
    const text = '受入テスト 06-030 園内の記録：午睡前に少しぐずった';
    const id = await createDiary(page, { type: '1', child: TARO, body: text }, today);
    await applyDiary(page, id);
    const admin = await openWindow(browser, 'admin');
    await returnDiary(admin, id, '受入テスト 06-030 理由');
    await applyDiary(page, id);
    await approveDiary(admin, id);
    const admin2 = await openWindow(browser, 'admin2');
    await revokeDiary(admin2, id, '受入テスト 06-030 取り消し');
    await g.home.waitForTimeout(4000);

    await g.expectNothing(['06-030', 'ぐずった', '日誌を共有', '差し戻', '承認'], 'そのまま');
    expect.soft(await g.homeCounts(), '新着の数・未読の数が増えない').toEqual(before.home);
    expect.soft(await g.events(), '窓2 の知らせに diary の種類が来ない').not.toContain('diary');
    await g.reloadAll();
    await g.expectNothing(['06-030', 'ぐずった', '日誌を共有'], '再読み込みのあと');
    await g.home.goto(`/guardian/diary/${id}`);
    await g.home.waitForTimeout(1500);
    await expect.soft(g.home.getByText(/ぐずった|受入テスト 06-030/), '共有日誌のアドレスを開いても日誌の本文が出ない').toHaveCount(0);
    expect.soft(chatCount(TARO), 'SQL：太郎の個人チャットのメッセージの数が変わらない').toBe(before.chat);
    await evidence(g.home, '06-030');
  });
});

// =====================================================================
// きょうのようす・クラスのようす
// =====================================================================

/** そのクラスで、その日の食事・午睡の記録がまだ無い園児（園児IDの順） */
function freeChildren(className: string, today: string): { child_id: string; child_name: string }[] {
  return childrenOf(className).filter((c) => {
    const meals = sqlOne<{ n: number }>("SELECT COUNT(*) AS n FROM t_contact_event WHERE child_id = ? AND contact_date = ? AND event_type = '1'", c.child_id, today)?.n ?? 0;
    const naps = sqlOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM t_nap_sleep s JOIN t_nap_session ss ON ss.nap_session_id = s.nap_session_id WHERE s.child_id = ? AND ss.session_date = ?',
      c.child_id,
      today,
    )?.n ?? 0;
    return Number(meals) === 0 && Number(naps) === 0;
  });
}

/** 連絡帳の出来事を記録する（連絡帳（クラス）画面の食事・排せつの列と同じ経路 POST /api/contact/events） */
async function recordEvent(page: Page, item: Record<string, string>): Promise<{ id: number; hm: string; updated_at: string }> {
  const res = await api(page, 'POST', '/api/contact/events', { items: [item] });
  if (res.status !== 200) throw new Error(`下ごしらえ：連絡帳の記録ができません（${res.status} ${res.text}）`);
  const ev = (res.json as { events: { contact_event_id: number; recorded_at: string; updated_at?: string }[] }).events[0];
  return { id: ev.contact_event_id, hm: ev.recorded_at.slice(11, 16), updated_at: ev.updated_at ?? ev.recorded_at };
}

/** 【時間帯】と【実施中】：午睡の時間帯を広げ、そのクラスの午睡チェックを実施中にして、その子の「ねた」を押す。押した時刻（H:MM）を返す。夜中の 23:50 より後は null */
async function pressNeta(page: Page, child: string): Promise<string | null> {
  const [h, mi] = jstHMNow().split(':').map(Number);
  if (h * 60 + mi > 23 * 60 + 50) return null;
  setSettingBySql('nap.time_range', '00:00-23:59');
  await page.goto('/staff/nap');
  await expect(page.getByRole('heading', { name: '午睡チェック', level: 1 })).toBeVisible();
  const start = page.getByRole('button', { name: '午睡チェックを開始する' });
  const end = page.getByRole('button', { name: '午睡チェックを終了' });
  await expect(start.or(end).first()).toBeVisible();
  if (await start.isVisible()) await start.click();
  await expect(end).toBeVisible();
  await page.getByRole('button', { name: `${child}のねた`, exact: true }).click();
  await expect.poll(() => sqlOne<{ slept_at: string }>('SELECT slept_at FROM t_nap_sleep WHERE child_id = ? ORDER BY nap_sleep_id DESC LIMIT 1', childIdOf(child))?.slept_at ?? '').not.toBe('');
  return sqlOne<{ slept_at: string }>('SELECT slept_at FROM t_nap_sleep WHERE child_id = ? ORDER BY nap_sleep_id DESC LIMIT 1', childIdOf(child))!.slept_at.slice(11, 16);
}

function jstHMNow(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

/** 「11:40」を、画面の「11:40」「9:05」のどちらにも当たる形にする */
const hmRe = (hm: string) => `0?${Number(hm.slice(0, 2))}:${hm.slice(3, 5)}`;

/** 保護者へ出すきょうのようすの項目から食事を外す。設定画面に連絡帳の区画が無いため、設定の経路で変え、断られたら SQL で変える */
async function hideMealFromGuardians(admin: Page): Promise<string> {
  const view = await api(admin, 'GET', '/api/settings');
  const readAt = (view.json as { read_at?: string } | null)?.read_at;
  const res = await api(admin, 'POST', '/api/settings', { changes: { 'contact.show_items': 'nap,toilet,temperature,comment,photo,class' }, read_at: readAt });
  if (res.status === 200) return '設定の経路（POST /api/settings）で変えた';
  setSettingBySql('contact.show_items', 'nap,toilet,temperature,comment,photo,class');
  return `設定画面に連絡帳の区画が無く、設定の経路も断った（${res.status}）ため、SQL で変えた`;
}

const FROM_CONTACT = '【きょうのようす（連絡帳から）】';

test.describe('きょうのようす・クラスのようす', () => {
  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（下書き・作成）・「機能間のデータの引き渡し」(4-7-3)、基本設計書「きょうのようすから個人日誌の下書きへ」(4-6)、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目22、「設定画面（管理者）」(7-10) 項目2、詳細設計書「日誌の画面（作り直し）」(2-13) の (4)・「日誌」(4-13) の (8)・決めたこと D-35 */
  test('06-031 新しい個人日誌にきょうのようすが入る', async ({ page, browser }) => {
    const today = jstToday();
    const admin = await openWindow(browser, 'admin');
    const how = await hideMealFromGuardians(admin);
    note(`保護者へ出す項目から食事を外した方法：${how}`);
    await login(page, 'staffHimawari');
    const child = freeChildren('ひまわり組', today)[0];
    test.skip(!child, '前提を作れない：ひまわり組に、その日の食事・午睡の記録が無い園児がいない');
    const meal = await recordEvent(page, { child_id: child.child_id, event_type: '1', meal_kind: '1', meal_amount: '3' });
    const snack = await recordEvent(page, { child_id: child.child_id, event_type: '1', meal_kind: '2', meal_amount: '4' });
    const toiletChoice = (sqlOne<{ setting_value: string }>("SELECT setting_value FROM m_setting WHERE setting_key = 'contact.toilet_choices'")?.setting_value ?? 'おしっこ').split(',')[0];
    await recordEvent(page, { child_id: child.child_id, event_type: '2', toilet_label: toiletChoice });
    const cancel = await api(page, 'POST', `/api/contact/events/${snack.id}/cancel`, {});
    expect(cancel.status, `前提：おやつを取り消す（${cancel.text}）`).toBe(200);
    const neta = await pressNeta(page, child.child_name);

    await newDiary(page);
    await childSelect(page).selectOption({ label: child.child_name });
    await page.waitForTimeout(2000);
    const body = nl(await bodyBox(page).inputValue());
    expect.soft(body, `本文に見出し「${FROM_CONTACT}」が自動で入る`).toContain(FROM_CONTACT);
    expect.soft(body, '給食の行（保護者へ出さない設定の食事も入る）').toMatch(new RegExp(`${hmRe(meal.hm)}\\s*給食\\s*少し`));
    if (neta) expect.soft(body, '午睡の行（おきたが無い）').toMatch(new RegExp(`${hmRe(neta)}\\s*午睡（おきたは記録されていません）`));
    else note('23:50 より後のため、午睡の行は確かめていない（【時間帯】が作れない）');
    expect.soft(body, '取り消したおやつは入らない').not.toMatch(/おやつ\s*食べていない/);
    expect.soft(body, '排せつは入らない').not.toContain(toiletChoice);
    const iMeal = body.search(new RegExp(`${hmRe(meal.hm)}\\s*給食`));
    if (neta && iMeal >= 0) expect.soft(iMeal, '時刻の順').toBeLessThan(body.search(new RegExp(`${hmRe(neta)}\\s*午睡`)));
    await evidence(page, '06-031');

    await dateBox(page).fill(shiftDate(today, -1));
    await page.waitForTimeout(800);
    await dateBox(page).fill(today);
    await page.waitForTimeout(1500);
    const again = nl(await bodyBox(page).inputValue());
    expect.soft(again.split(FROM_CONTACT).length - 1, '記録日を替えて戻しても、もう一度は入らない').toBeLessThanOrEqual(1);
  });

  /* 典拠：基本設計書「きょうのようすから個人日誌の下書きへ」(4-6)、図/画面詳細図「日誌作成・編集画面」(3-2) 項目22、詳細設計書「日誌の画面（作り直し）」(2-13) の (4)・「日誌」(4-13) の (8) */
  test('06-032 きょうのようすから入れるを押す', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffHimawari');
    const [child, second] = freeChildren('ひまわり組', today);
    test.skip(!child || !second, '前提を作れない：ひまわり組に、その日の食事・午睡の記録が無い園児が2人いない');
    const meal = await recordEvent(page, { child_id: child.child_id, event_type: '1', meal_kind: '1', meal_amount: '3' });
    const neta = await pressNeta(page, child.child_name);
    const snack = await recordEvent(page, { child_id: child.child_id, event_type: '1', meal_kind: '2', meal_amount: '1' });

    await newDiary(page);
    await childSelect(page).selectOption({ label: child.child_name });
    await page.waitForTimeout(1500);
    await appendBody(page, '受入テスト 06-032 手で書いた行');
    const before = nl(await bodyBox(page).inputValue());
    const btn = mainOf(page).getByRole('button', { name: 'きょうのようすから入れる' });
    await expect.soft(btn, '「きょうのようすから入れる」がある（個人日誌のとき）').toBeVisible();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(1000);
      const after = nl(await bodyBox(page).inputValue());
      expect.soft(after.startsWith(before), 'それより前の本文は消えない（置き換えない）').toBe(true);
      const added = after.slice(before.length);
      expect.soft(added, '給食の行').toMatch(new RegExp(`${hmRe(meal.hm)}\\s*給食\\s*少し`));
      if (neta) expect.soft(added, '午睡の行').toMatch(new RegExp(`${hmRe(neta)}\\s*午睡（おきたは記録されていません）`));
      expect.soft(added, 'おやつの行').toMatch(new RegExp(`${hmRe(snack.hm)}\\s*おやつ\\s*ぜんぶ`));
    }
    await evidence(page, '06-032');

    await newDiary(page);
    await childSelect(page).selectOption({ label: second.child_name });
    await page.waitForTimeout(1500);
    await bodyBox(page).fill('受入テスト 06-032 2人目');
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await expect.soft(page.getByText('連絡帳に午睡・食事の記録がありません。').first(), '記録の無い子では文が出る').toBeVisible();
      await expect.soft(bodyBox(page), '本文は変わらない').toHaveValue('受入テスト 06-032 2人目');
    } else {
      expect.soft(false, '2人目：「きょうのようすから入れる」が無い').toBe(true);
    }
    await mainOf(page).getByRole('radio', { name: 'クラス日誌' }).check();
    await expect.soft(btn, 'クラス日誌には「きょうのようすから入れる」が無い').toHaveCount(0);
  });

  /* 典拠：基本設計書「きょうのようすから個人日誌の下書きへ」(4-6)・「入力項目の制約値とメッセージ一覧」(4-12) の「取り込んだ記録の訂正」、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目25、「日誌承認画面（管理者）」(3-5) 項目9、詳細設計書「日誌の画面（作り直し）」(2-13) の (5)・「日誌」(4-13) の (6) */
  test('06-033 取り込んだ記録の訂正の表示', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffHimawari');
    const child = freeChildren('ひまわり組', today)[0];
    test.skip(!child, '前提を作れない：ひまわり組に、その日の食事・午睡の記録が無い園児がいない');
    const meal = await recordEvent(page, { child_id: child.child_id, event_type: '1', meal_kind: '1', meal_amount: '3' });
    const snack = await recordEvent(page, { child_id: child.child_id, event_type: '1', meal_kind: '2', meal_amount: '4' });
    await api(page, 'POST', `/api/contact/events/${snack.id}/cancel`, {});
    await page.waitForTimeout(1100); // 日誌の作成を、取り消しより後の秒にする

    await newDiary(page);
    await childSelect(page).selectOption({ label: child.child_name });
    await page.waitForTimeout(1500);
    await appendBody(page, '受入テスト 06-033');
    await saveDraft(page);
    await expect(toast(page, /保存/)).toBeVisible();
    const [d] = diariesLike('受入テスト 06-033');
    const savedBody = d.body;
    await page.waitForTimeout(1100);
    const ev = sqlOne<{ updated_at: string }>('SELECT updated_at FROM t_contact_event WHERE contact_event_id = ?', meal.id);
    const fix = await api(page, 'POST', `/api/contact/events/${meal.id}/correct`, { meal_amount: '1', updated_at: ev?.updated_at });
    expect(fix.status, `前提：給食を「ぜんぶ」に訂正する（${fix.text}）`).toBe(200);

    await openDiary(page, d.diary_id);
    const band = page.getByText('取り込んだあとに連絡帳で訂正・取り消しされた記録があります。本文を確かめてください。').first();
    await expect.soft(band, '訂正の表示が出る').toBeVisible();
    await expect.soft(mainOf(page), 'どの記録か（給食が訂正された）').toContainText(new RegExp(`${hmRe(meal.hm)}\\s*給食[^\\n]*訂正`));
    expect.soft(nl(await bodyBox(page).inputValue()), '本文は自動で書き換わらない').toBe(nl(savedBody));
    await expect.soft(mainOf(page).getByText(/おやつ[^\n]*(取り消し|訂正)/), '日誌を作る前に取り消したおやつは出ない').toHaveCount(0);
    await evidence(page, '06-033');
    await confirmAndApply(page);
    const admin = await openWindow(browser, 'admin');
    await openApproval(admin, d.diary_id);
    await expect.soft(admin.getByText('取り込んだあとに連絡帳で訂正・取り消しされた記録があります。本文を確かめてください。').first(), '日誌承認画面にも同じ表示').toBeVisible();
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（クラスのようすへの引き写し）・「機能間のデータの引き渡し」(4-7-3)、基本設計書「クラスのようすへの引き写し」(4-6)・
     「クラスのようす」(4-5)・「保護者へ届けるときの関所」(2-4) の (1) 段2・「開いている画面への即時の反映（SSE）」(4-10)・「クラスのようす（t_contact_class）」(5-4)、
     図/画面詳細図「日誌作成・編集画面」(3-2) 項目23、図/画面遷移図「日誌システム」(4)・「連絡帳」(3)、詳細設計書「日誌の画面（作り直し）」(2-13) の (6)・「日誌」(4-13) の (9) */
  test('06-034 クラスのようすへ引き写す', async ({ page, browser }) => {
    const g = await guardianWindows(browser, 'guardian', TARO);
    const line1 = '受入テスト 06-034 きょうは園庭で砂遊びをしました。';
    const line2 = '受入テスト 06-034 園内向けのメモ';
    await login(page, 'staffSakura');
    await newDiary(page);
    await mainOf(page).getByRole('radio', { name: 'クラス日誌' }).check();
    await bodyBox(page).fill(`${line1}\n${line2}`);
    await saveDraft(page);
    await expect(toast(page, /保存/)).toBeVisible();
    const [d] = diariesLike('受入テスト 06-034 きょうは');
    await bodyBox(page).evaluate((el, n) => (el as HTMLTextAreaElement).setSelectionRange(0, n), line1.length);
    const copy = mainOf(page).getByRole('button', { name: /クラスのようすへ(写す|引き写す)/ });
    await expect.soft(copy, '「クラスのようすへ写す」がある（クラス日誌のとき）').toBeVisible();
    await evidence(page, '06-034');
    if (!(await copy.isVisible().catch(() => false))) return;
    await copy.click();
    await expect(page.getByRole('heading', { name: /連絡帳/, level: 1 })).toBeVisible();
    const note = mainOf(page).getByRole('textbox', { name: /クラスのようす/ });
    await expect.soft(note, '選んだ1行目だけが入る').toHaveValue(line1);
    await expect.soft(page.getByText('クラス日誌から写しました。送るかどうかを確かめてから送ってください。').first(), '写したことの文').toBeVisible();
    await expect.soft(mainOf(page), '宛先（さくら組と家庭の数）').toContainText(/さくら組[^\n]*家庭/);
    await g.contact.waitForTimeout(2000);
    expect.soft(await g.contact.locator('body').innerText(), '送る前は保護者の画面に出ない').not.toContain('06-034');
    await mainOf(page).getByRole('button', { name: /^送る/ }).first().click();
    await expect.poll(async () => (await g.contact.locator('body').innerText()).includes(line1), { message: '送ると保護者の画面に再読み込みせずに出る', timeout: 10_000 }).toBe(true);
    const rows = sqlAll<{ source_diary_id: number }>('SELECT source_diary_id FROM t_contact_class WHERE body LIKE ?', '%受入テスト 06-034%');
    expect.soft(rows, 'SQL：クラスのようすの行が1つ').toHaveLength(1);
    expect.soft(Number(rows[0]?.source_diary_id), 'source_diary_id＝その日誌').toBe(d.diary_id);
    await openDiary(page, d.diary_id);
    await mainOf(page).getByRole('button', { name: /クラスのようすへ(写す|引き写す)/ }).click();
    await expect.soft(mainOf(page).getByRole('textbox', { name: /クラスのようす/ }), '範囲を選ばずに写すと本文の全体').toHaveValue(new RegExp(`${line1}\\s*${line2}`));
  });

  /* 典拠：基本設計書「クラスのようすへの引き写し」(4-6)・「入力項目の制約値」(4-12) のクラスのようす、図/画面詳細図「日誌作成・編集画面」(3-2) 項目23、
     詳細設計書「日誌の画面（作り直し）」(2-13) の (6)・決めたこと D-32 */
  test('06-035 引き写せないとき・上限を超えるとき', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const personal = await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-035 個人' }, today);
    const yesterday = await createDiary(page, { type: '2', className: 'さくら組', date: shiftDate(today, -1), body: '受入テスト 06-035 前の日' }, today);
    const long = '受入テスト 06-035 長い' + 'あ'.repeat(520 - '受入テスト 06-035 長い'.length);
    const longId = await createDiary(page, { type: '2', className: 'さくら組', body: long }, today);
    const applied = await createDiary(page, { type: '2', className: 'さくら組', body: '受入テスト 06-035 申請中', status: '2' }, today);
    const copyBtn = () => mainOf(page).getByRole('button', { name: /クラスのようすへ(写す|引き写す)/ });

    await openDiary(page, personal);
    await expect.soft(copyBtn(), '①個人日誌には「クラスのようすへ写す」が無い').toHaveCount(0);
    await openDiary(page, yesterday);
    await expect.soft(copyBtn(), '②前の日のクラス日誌では押せない').toBeDisabled();
    await expect.soft(page.getByText('クラスのようすへ写せるのは、記録日がきょうの日誌だけです。').first(), '②その旨の文').toBeVisible();
    await openDiary(page, longId);
    if (await copyBtn().isVisible().catch(() => false)) {
      await copyBtn().click();
      const v = await mainOf(page).getByRole('textbox', { name: /クラスのようす/ }).inputValue();
      expect.soft(v.length, '③先頭の500文字だけが入る').toBe(500);
      await expect.soft(page.getByText('500文字を超えた分は入れていません。').first(), '③その旨の文').toBeVisible();
    } else expect.soft(false, '③「クラスのようすへ写す」が無い').toBe(true);
    await openDiary(page, applied);
    await expect.soft(mainOf(page).getByText('申請中のため編集できません。')).toBeVisible();
    await expect.soft(copyBtn(), '④申請中の日誌でも写せる').toBeEnabled();
    await evidence(page, '06-035');
  });
});

// =====================================================================
// 一覧の絞り込み・ページング・出力、承認待ち、過去の記録、タイムライン
// =====================================================================

/** 一覧の本体の行（見出しの行を除く） */
const bodyRows = (page: Page) => mainOf(page).getByRole('row').filter({ has: page.locator('td') });

test.describe('一覧・タイムライン', () => {
  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（絞り込み検索）、基本設計書「絞り込みと出力」(4-6)、図/画面詳細図「日誌一覧画面」(3-1) 項目1・3・5・10〜12、詳細設計書「日誌」(4-13) の (7) */
  test('06-036 絞り込み', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const a = await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-036 あおぞら' }, today);
    const c = await createDiary(page, { type: '2', className: 'さくら組', body: '受入テスト 06-036 あおぞら ひろば', status: '2' }, today);
    const m = await openMurata(browser);
    const b = await createDiary(m, { type: '1', child: MISAKI, body: '受入テスト 06-036 あおぞら' }, today);
    await gotoList(page);
    const main = mainOf(page);
    const keyword = main.getByRole('textbox', { name: /キーワード/ });
    const childName = main.getByRole('textbox', { name: /園児名/ });
    const mine = main.getByRole('checkbox', { name: /自分が作成したもの/ });
    await expect.soft(keyword, 'キーワードの絞り込みがある（項目11）').toBeVisible();
    await expect.soft(childName, '園児名の絞り込みがある（項目10）').toBeVisible();
    await expect.soft(mine, '「自分が作成したもの」がある（項目12）').toBeVisible();
    const hasKeyword = await keyword.isVisible().catch(() => false);
    const apply = () => main.getByRole('button', { name: '絞り込む' }).click();
    const shown = async (id: number) => (await listLink(page, id).count()) > 0;
    const expectShown = async (when: string, expected: Record<string, boolean>) => {
      await page.waitForTimeout(800);
      for (const [label, id] of [['太郎の個人日誌', a], ['美咲の個人日誌', b], ['クラス日誌', c]] as const) {
        if (label in expected) expect.soft(await shown(id), `${when}：${label}`).toBe(expected[label]);
      }
      if (hasKeyword) expect.soft(await bodyRows(page).count(), `${when}：行の数`).toBe(Object.values(expected).filter(Boolean).length);
    };
    if (hasKeyword) {
      await keyword.fill('06-036 あおぞら');
      await apply();
      await expectShown('キーワード', { 太郎の個人日誌: true, 美咲の個人日誌: true, クラス日誌: true });
    }
    await main.getByRole('combobox', { name: '種別' }).selectOption({ label: '個人日誌' });
    await apply();
    await expectShown('＋個人日誌', { 太郎の個人日誌: true, 美咲の個人日誌: true, クラス日誌: false });
    await main.getByRole('combobox', { name: '種別' }).selectOption({ label: 'すべて' });
    await main.getByRole('combobox', { name: '状態' }).selectOption({ label: '申請中' });
    await apply();
    await expectShown('状態 申請中', { 太郎の個人日誌: false, 美咲の個人日誌: false, クラス日誌: true });
    await main.getByRole('combobox', { name: '状態' }).selectOption({ label: 'すべて' });
    if (await mine.isVisible().catch(() => false)) {
      await mine.check();
      await apply();
      await expectShown('自分が作成したもの', { 太郎の個人日誌: true, 美咲の個人日誌: false, クラス日誌: true });
      await mine.uncheck();
    }
    if (hasKeyword && (await childName.isVisible().catch(() => false))) {
      await keyword.fill('06-036');
      for (const name of ['太郎', 'たろう']) {
        await childName.fill(name);
        await apply();
        await expectShown(`園児名「${name}」`, { 太郎の個人日誌: true, 美咲の個人日誌: false, クラス日誌: false });
      }
      await expect.soft(main.getByText(/1\s*\/\s*\d+/), '1ページ目から出る').toBeVisible();
    }
    await evidence(page, '06-036');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の検索の期間、図/画面詳細図「日誌一覧画面」(3-1) 項目4、テスト仕様書の下書き「テストデータの準備」(2.1) */
  test('06-037 期間の既定と境界', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const d30 = await createDiary(page, { type: '1', child: TARO, date: shiftDate(today, -30), body: '受入テスト 06-037 30日前' }, today);
    const d31 = await createDiary(page, { type: '1', child: TARO, date: shiftDate(today, -31), body: '受入テスト 06-037 31日前' }, today);
    await gotoList(page);
    await expect.soft(listLink(page, d30), '初期値では30日前が出る').toBeVisible();
    await expect.soft(listLink(page, d31), '初期値では31日前は出ない').toHaveCount(0);
    await mainOf(page).getByRole('textbox', { name: /期間（開始）/ }).fill(shiftDate(today, -31));
    await mainOf(page).getByRole('button', { name: '絞り込む' }).click();
    await expect.soft(listLink(page, d31), '開始を31日前にすると31日前も出る').toBeVisible();
    await expect.soft(listLink(page, d30)).toBeVisible();
    await evidence(page, '06-037');
  });

  /* 典拠：基本設計書「一覧表示とページング」(3-7)・「設定マスタ（m_setting）」(5-9) の paging.diary_per_page、図/画面詳細図「日誌一覧画面」(3-1) 項目9、
     「設定画面（管理者）」(7-10) 項目12、詳細設計書「設定ごとの検査」(4-10 (3)) */
  test('06-038 ページング', async ({ page, browser }) => {
    const today = jstToday();
    // 1ページの件数を10にする。設定画面に「そのほかの設定値」が無いため、設定の経路で変え、断られたら【SQL】(W2)
    const admin = await openWindow(browser, 'admin');
    const view = await api(admin, 'GET', '/api/settings');
    const res = await api(admin, 'POST', '/api/settings', { changes: { 'paging.diary_per_page': '10' }, read_at: (view.json as { read_at?: string } | null)?.read_at });
    if (res.status !== 200) setSettingBySql('paging.diary_per_page', '10');
    await login(page, 'staffSakura');
    // デモの日誌と混ざらないよう、200日前の日付で11件を作り、期間で絞る（キーワードの絞り込みが画面に無いため）
    const day = shiftDate(today, -200);
    const ids: number[] = [];
    for (let i = 1; i <= 11; i++) ids.push(await createDiary(page, { type: '1', child: TARO, date: day, body: `受入テスト 06-038 ${i}` }, today));
    await gotoList(page);
    const main = mainOf(page);
    await main.getByRole('textbox', { name: /期間（開始）/ }).fill(day);
    await main.getByRole('textbox', { name: /期間（終了）/ }).fill(day);
    const keyword = main.getByRole('textbox', { name: /キーワード/ });
    if (await keyword.isVisible().catch(() => false)) await keyword.fill('06-038');
    await main.getByRole('button', { name: '絞り込む' }).click();
    await expect.poll(() => bodyRows(page).count(), { message: '1ページ目に10行' }).toBe(10);
    await expect.soft(main, '総件数「11」').toContainText(/全\s*11\s*件/);
    const linksOf = async () => (await main.locator('a[href^="/staff/diary/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))).filter((h) => /\/staff\/diary\/\d+$/.test(h ?? ''));
    const page1 = await linksOf();
    await evidence(page, '06-038');
    await main.getByRole('button', { name: /次へ/ }).click();
    await expect.poll(() => bodyRows(page).count(), { message: '2ページ目に1行' }).toBe(1);
    const page2 = await linksOf();
    expect.soft(new Set([...page1, ...page2]).size, '合わせて11件で重ならない').toBe(11);
    expect.soft([...page1, ...page2].sort(), '作った11件').toEqual(ids.map((id) => `/staff/diary/${id}`).sort());
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（PDF出力）・「操作ログの参照」(4-1-4 (2))、基本設計書「絞り込みと出力」(4-6)・「操作ログの記録」(4-2)・「操作ログ（t_operation_log）」(5-9)、
     図/画面詳細図「日誌一覧画面」(3-1) 項目14、図/画面遷移図「日誌システム」(4) */
  test('06-039 PDF 出力', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-039' }, today);
    await page.context().clearCookies();
    await login(page, 'admin');
    await gotoList(page);
    const pdf = mainOf(page).getByRole('button', { name: /PDF/ });
    await expect.soft(pdf, '管理者の画面に「PDF 出力」がある').toBeVisible();
    await evidence(page, '06-039');
    if (!(await pdf.isVisible().catch(() => false))) return;
    const logBefore = maxLogId();
    await pdf.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (const name of [/期間/, /記録種別|種別/, /クラス/]) await expect.soft(dialog.getByText(name).first(), `ダイアログに ${name}`).toBeVisible();
    const download = page.waitForEvent('download', { timeout: 15_000 });
    await dialog.getByRole('button', { name: /出力/ }).last().click();
    const file = await download;
    expect.soft(file.suggestedFilename(), 'PDF のファイル').toMatch(/\.pdf$/i);
    expect.soft(logsAfter(logBefore).filter((l) => l.function_type === '1' && l.operation_type === '5'), '操作ログに 1・5 の行が1つ').toHaveLength(1);
  });

  /* 典拠：図/画面詳細図「承認待ち一覧画面（管理者）」(3-4) 項目1〜5・7 と注記・「モックアップでは実装しないもの」(12-1)、
     基本設計書「設定マスタ（m_setting）」(5-9) の approval.warn_days・「一覧表示とページング」(3-7) */
  test('06-040 承認待ち一覧の絞り込みと経過', async ({ page, browser }) => {
    const today = jstToday();
    const s = await openWindow(browser, 'staffSakura');
    const old = await createDiary(s, { type: '1', child: TARO, body: '受入テスト 06-040 4日前', status: '2' }, today);
    const inc = await createDiary(s, {
      type: '4', child: MISAKI, body: '', status: '2',
      incident: { occurred_at: `${pastStep(2)}:00`, place: '受入テスト 06-040', situation: '受入テスト 06-040 状況', response: '受入テスト 06-040 対応' },
    }, today);
    const k = await openWindow(browser, 'staffHimawari');
    const him = await createDiary(k, { type: '2', className: 'ひまわり組', body: '受入テスト 06-040 ひまわり', status: '2' }, today);
    // 【SQL】(W3) 申請日時を4日前にする（書く前に読み、同じ形で書く）
    sqlRun('UPDATE t_diary SET applied_at = ? WHERE diary_id = ?', sameFormatShift(diaryById(old)!.applied_at!, new Date(), -4 * 24 * 60), old);

    await login(page, 'admin');
    await gotoPending(page);
    const main = mainOf(page);
    const clsFilter = main.getByRole('combobox', { name: 'クラス' });
    const typeFilter = main.getByRole('combobox', { name: '種別' });
    const headers = (await main.getByRole('columnheader').allInnerTexts()).map((t) => t.trim());
    const hasFilters = (await clsFilter.count()) > 0 || (await typeFilter.count()) > 0;
    const hasElapsed = headers.some((h) => h.includes('経過'));
    const hasPaging = /全\s*\d+\s*件|\d+\s*\/\s*\d+/.test(await main.innerText()) && (await main.getByRole('button', { name: /次へ/ }).count()) > 0;
    await evidence(page, '06-040');
    test.skip(!hasFilters && !hasElapsed && !hasPaging, notIn121('承認待ち一覧画面のクラス・種別の絞り込み、経過、ヒヤリハットの色分け、ページング（3-4 項目1〜5・7）'));
    if (hasFilters) {
      await clsFilter.selectOption({ label: 'ひまわり組' });
      await main.getByRole('button', { name: '絞り込む' }).click();
      await expect.soft(pendingLink(page, him), 'ひまわり組で絞ると出る').toBeVisible();
      await expect.soft(pendingLink(page, old), 'さくら組の申請は出ない').toHaveCount(0);
      await clsFilter.selectOption({ label: 'すべて' });
      await typeFilter.selectOption({ label: 'ヒヤリハット' });
      await main.getByRole('button', { name: '絞り込む' }).click();
      await expect.soft(pendingLink(page, inc), 'ヒヤリハットで絞ると出る').toBeVisible();
      await expect.soft(pendingLink(page, him), 'クラス日誌は出ない').toHaveCount(0);
      await typeFilter.selectOption({ label: 'すべて' });
      await main.getByRole('button', { name: '絞り込む' }).click();
    } else note(notIn121('クラス・種別の絞り込み'));
    if (hasElapsed) {
      const style = async (id: number) => (await pendingRow(page, id).count()) === 0 ? `行が無い（${id}）` : pendingRow(page, id).first().evaluate((tr) => Array.from(tr.querySelectorAll('*')).concat(tr).map((e) => `${getComputedStyle(e).color}|${getComputedStyle(e).backgroundColor}`).join(';'));
      expect.soft(await style(old), '4日前の行に警告色が付き、今日の行と違う').not.toBe(await style(him));
      expect.soft(await style(inc), 'ヒヤリハットの行は他の種別と区別できる色').not.toBe(await style(him));
    } else note(notIn121('経過とヒヤリハットの色分け'));
    if (!hasPaging) note(notIn121('ページング'));
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（個人日誌との紐付け）、図/画面詳細図「日誌作成・編集画面」(3-2) 項目11 と注記 */
  test('06-041 この園児の過去の記録', async ({ page }) => {
    const today = jstToday();
    await login(page, 'admin');
    const child = childrenOf('もも組').find((c) => Number(sqlOne<{ n: number }>('SELECT COUNT(*) AS n FROM t_diary WHERE child_id = ?', c.child_id)?.n ?? 0) === 0);
    test.skip(!child, '前提を作れない：日誌の無いもも組の園児がいない');
    const ids: number[] = [];
    for (let i = 1; i <= 9; i++) ids.push(await createDiary(page, { type: '1', child: child!.child_name, date: shiftDate(today, -i), body: `受入テスト 06-041 ${i}日前` }, today));
    await newDiary(page);
    await childSelect(page).selectOption({ label: child!.child_name });
    await page.waitForTimeout(1500);
    const main = mainOf(page);
    const shown = async (id: number) => (await main.locator(`a[href="/staff/diary/${id}"]`).count()) > 0;
    for (let i = 1; i <= 8; i++) expect.soft(await shown(ids[i - 1]), `${i}日前が出る`).toBe(true);
    expect.soft(await shown(ids[8]), '9日前は出ない（8件まで）').toBe(false);
    await evidence(page, '06-041');
    await main.locator(`a[href="/staff/diary/${ids[0]}"]`).first().click();
    await expect.soft(page.getByRole('heading', { name: '日誌の編集', level: 1 }), '「開く」で日誌作成・編集画面へ移る').toBeVisible();
    await expect.soft(bodyBox(page), '1日前の日誌').toHaveValue(/受入テスト 06-041 1日前/);
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（個人日誌との紐付け）、基本設計書「画面の一覧」(3-2) の園児タイムライン画面、図/画面詳細図「園児タイムライン画面」(3-6) 項目2〜8 と注記・
     「モックアップでは実装しないもの」(12-1)、図/画面遷移図「日誌システム」(4) */
  test('06-042 園児の記録を時系列で追う', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const id = await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-042 日誌' }, today);
    const toiletChoice = (sqlOne<{ setting_value: string }>("SELECT setting_value FROM m_setting WHERE setting_key = 'contact.toilet_choices'")?.setting_value ?? 'おしっこ').split(',')[0];
    await recordEvent(page, { child_id: childIdOf(TARO), event_type: '2', toilet_label: toiletChoice });
    const room = sqlOne<{ chat_room_id: number }>('SELECT chat_room_id FROM m_chat_room WHERE child_id = ?', childIdOf(TARO));
    if (room) await api(page, 'POST', `/api/chat/rooms/${room.chat_room_id}/messages`, { body: '受入テスト 06-042 チャット' });

    await page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '園児', exact: true }).click();
    await mainOf(page).getByRole('row', { name: new RegExp(`^${TARO}`) }).getByRole('link', { name: /記録/ }).click();
    const main = mainOf(page);
    await expect(page.getByRole('heading', { name: new RegExp(TARO), level: 1 })).toBeVisible();
    await expect.soft(main, '月齢（今日の時点）').toContainText(/\d+\s*か月|\d+\s*歳/);
    const type = main.getByRole('combobox', { name: '種別' });
    if (await type.count()) await expect.soft(type.locator('option:checked'), '種別の初期値「すべて」').toHaveText('すべて');
    else note(notIn121('種別・期間の絞り込み、さらに読み込む（3-6 項目3〜5・8）'));
    const from = main.getByRole('textbox', { name: /期間（開始）/ });
    if (await from.count()) await expect.soft(from, '期間の開始＝当日の30日前').toHaveValue(shiftDate(today, -30));
    const row = main.getByRole('row').filter({ hasText: '受入テスト 06-042 日誌' });
    await expect.soft(row, '当日のところに日誌の行').toBeVisible();
    await expect.soft(row, '種別「日誌」').toContainText('日誌');
    await expect.soft(main.getByText('受入テスト 06-042 チャット'), 'チャットのメッセージは並ばない').toHaveCount(0);
    await expect.soft(main.getByRole('row').filter({ hasText: toiletChoice }), '連絡帳の排せつは並ばない').toHaveCount(0);
    expect.soft(await main.innerText(), '傾向の判定・要注意の指摘・判定の言葉が出ない').not.toMatch(/遅れ|心配|要注意|問題があります|傾向/);
    await evidence(page, '06-042');
    await row.getByRole('link', { name: '開く' }).click();
    await expect.soft(page.getByRole('heading', { name: '日誌の編集', level: 1 }), '「開く」で日誌作成・編集画面へ').toBeVisible();
    await expect.soft(bodyBox(page)).toHaveValue(/受入テスト 06-042 日誌/);
    expect(id).toBeGreaterThan(0);
  });
});

// =====================================================================
// 参照範囲
// =====================================================================

test.describe('参照範囲', () => {
  async function himawariDiaries(browser: Browser, today: string) {
    const k = await openWindow(browser, 'staffHimawari');
    const firstHimawari = childrenOf('ひまわり組')[0];
    const cls = await createDiary(k, { type: '2', className: 'ひまわり組', body: '受入テスト 06-043 クラス', status: '2' }, today);
    const per = await createDiary(k, { type: '1', child: firstHimawari.child_name, body: '受入テスト 06-043 個人', status: '2' }, today);
    const admin = await openWindow(browser, 'admin');
    await approveDiary(admin, cls);
    await approveDiary(admin, per);
    return { cls, per, admin, firstHimawari };
  }

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（保管）・「参照範囲の全体規定」(4-1-5)・「データ参照範囲の制限」(8 No.6)、基本設計書「権限と参照範囲の判定」(4-2)・
     「日誌の作成から承認まで」(4-6) の箇条・「権限と利用可能機能」(6-1) の ※1、図/画面詳細図「日誌一覧画面」(3-1) 項目2 と注記、「日誌作成・編集画面」(3-2) 項目5 */
  test('06-043 一般は自クラスの日誌だけ', async ({ page, browser }) => {
    const today = jstToday();
    const { cls, per, admin } = await himawariDiaries(browser, today);
    await login(page, 'staffSakura');
    await gotoList(page);
    const main = mainOf(page);
    expect.soft((await main.getByRole('combobox', { name: 'クラス' }).locator('option').allInnerTexts()).map((t) => t.trim()), 'クラスの選択肢は「さくら組」だけ').toEqual(['さくら組']);
    await expect.soft(listLink(page, cls), '承認済みでも、ひまわり組のクラス日誌は出ない').toHaveCount(0);
    await expect.soft(listLink(page, per), 'ひまわり組の園児の個人日誌は出ない').toHaveCount(0);
    await evidence(page, '06-043');
    await newDiary(page);
    const sakura = childrenOf('さくら組').map((c) => c.child_name).sort();
    const options = (await childSelect(page).locator('option').allInnerTexts()).map((t) => t.trim()).filter((t) => !/選んで/.test(t)).sort();
    expect.soft(options, '対象の園児はさくら組の園児だけ').toEqual(sakura);
    await mainOf(page).getByRole('radio', { name: 'クラス日誌' }).check();
    expect.soft((await classSelectOf(page).locator('option').allInnerTexts()).map((t) => t.trim()).filter((t) => !/選んで/.test(t)), '対象のクラスは「さくら組」だけ').toEqual(['さくら組']);
    await gotoList(admin);
    await expect.soft(listLink(admin, cls), '管理者には出る（クラス日誌）').toBeVisible();
    await expect.soft(listLink(admin, per), '管理者には出る（個人日誌）').toBeVisible();
  });

  /* 典拠：基本設計書「画面とサーバの間のインタフェース」(4-2)（権限または参照範囲の外は、存在しない場合と同じ文言にする）・「権限と参照範囲の判定」(4-2)、
     図/画面詳細図「園児タイムライン画面」(3-6) の注記、詳細設計書「日誌」(4-13) */
  test('06-044 担当外の日誌・園児をアドレスから開く', async ({ page, browser }) => {
    const today = jstToday();
    const { cls, firstHimawari } = await himawariDiaries(browser, today);
    await login(page, 'staffSakura');
    const own = await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-044 自分' }, today);
    await openDiary(page, own);
    const ownPath = new URL(page.url()).pathname;
    const textOf = async (path: string) => {
      await page.goto(path);
      await page.waitForTimeout(1200);
      return (await mainOf(page).innerText()).replace(/\s+/g, ' ').trim();
    };
    const other = await textOf(ownPath.replace(String(own), String(cls)));
    expect.soft(other, 'ひまわり組の日誌の本文が出ない').not.toContain('受入テスト 06-043');
    expect.soft(other, '状態・承認の経緯が出ない').not.toMatch(/承認[：:]/);
    await evidence(page, '06-044');
    const maxId = Number(sqlOne<{ m: number }>('SELECT MAX(diary_id) AS m FROM t_diary')?.m ?? 0);
    const none = await textOf(ownPath.replace(String(own), String(maxId + 100000)));
    expect.soft(other, '存在しない日誌IDのときと同じ表示・同じ文言').toBe(none);
    expect.soft(lockOf(cls), 'SQL：その日誌のロックができない').toHaveLength(0);

    await page.goto('/staff/children');
    await mainOf(page).getByRole('row', { name: new RegExp(`^${TARO}`) }).getByRole('link', { name: /記録/ }).click();
    await expect(page.getByRole('heading', { name: new RegExp(TARO), level: 1 })).toBeVisible();
    const tlPath = new URL(page.url()).pathname;
    const taroId = childIdOf(TARO);
    const tlOther = await textOf(tlPath.replace(taroId, firstHimawari.child_id));
    expect.soft(tlOther, 'ひまわり組の1人目の記録が出ない').not.toContain(firstHimawari.child_name);
    const tlNone = await textOf(tlPath.replace(taroId, 'C999999'));
    expect.soft(tlOther, '存在しない園児IDのときと同じ表示・同じ文言').toBe(tlNone);
  });

  /* 典拠：要件定義書「参照範囲の全体規定」(4-1-5) の例外、基本設計書「権限と参照範囲の判定」(4-2) のロールごとの表・「権限と利用可能機能」(6-1) の ※1、
     図/画面詳細図「職員（タブレット／PC）」(1-1) 項目3 と注記 */
  test('06-045 フリーの職員は閲覧のみ', async ({ page, browser }) => {
    const today = jstToday();
    const { cls, per, admin } = await himawariDiaries(browser, today);
    await login(page, 'staffSakura');
    const draft = await createDiary(page, { type: '2', className: 'さくら組', body: '受入テスト 06-045 下書き' }, today);
    const f = await openFreeStaff(browser, admin);
    await f.goto('/staff');
    await expect(mainOf(f).getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
    await expect.soft(f.getByRole('banner'), 'ヘッダに「フリー」').toContainText('フリー');
    await expect.soft(mainOf(f), '全クラスを閲覧のみで見られること').toContainText(/閲覧/);
    await expect.soft(mainOf(f), '割り当ての誤りなら管理者へ依頼すること').toContainText(/管理者/);
    await expect.soft(mainOf(f).getByRole('link', { name: '日誌を書く' }), 'ダッシュボードの「日誌を書く」が無い').toHaveCount(0);
    await gotoList(f);
    await expect.soft(mainOf(f).getByRole('link', { name: /新しく書く/ }).or(mainOf(f).getByRole('button', { name: /新しく書く/ })), '「＋ 新しく書く」が無い').toHaveCount(0);
    const options = (await mainOf(f).getByRole('combobox', { name: 'クラス' }).locator('option').allInnerTexts()).map((t) => t.trim());
    for (const c of ['もも組', 'さくら組', 'ひまわり組']) expect.soft(options, `クラスの選択肢に${c}`).toContain(c);
    for (const id of [cls, per, draft]) await expect.soft(listLink(f, id), `日誌 ${id} が出る`).toBeVisible();
    await evidence(f, '06-045');
    await openDiary(f, draft);
    await expectReadOnly(f, 'absent');
    await expect.soft(mainOf(f).getByRole('button', { name: '申請を取り下げる' }), '「申請を取り下げる」が無い').toHaveCount(0);
    expect.soft(lockOf(draft), 'SQL：ロックの行ができない').toHaveLength(0);
  });
});

// =====================================================================
// クロスサイトスクリプティング・二重送信
// =====================================================================

const XSS_A = '受入テスト 06-046 <script>alert(1)</script><b>太字</b>"><img src=x onerror=alert(1)>';
const XSS_B = '受入テスト 06-046 <b>理由</b><script>alert(2)</script>';

/** タグがそのまま文字として出て、要素にならず、レイアウトが崩れていないこと */
async function expectLiteral(page: Page, text: string, where: string) {
  const main = mainOf(page);
  const shown = (await main.innerText()) + (await main.locator('textarea, input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join('\n')));
  expect.soft(shown, `${where}：入れた文字がタグを含めてそのまま出る`).toContain(text.replace('受入テスト 06-046 ', ''));
  expect.soft(await main.locator('b', { hasText: /太字|理由/ }).count(), `${where}：太字の要素ができない`).toBe(0);
  expect.soft(await main.locator('img[src="x"]').count(), `${where}：画像の要素ができない`).toBe(0);
  await expect.soft(page.getByRole('banner'), `${where}：ヘッダが崩れない`).toBeVisible();
  await expect.soft(page.getByRole('navigation', { name: '職員メニュー' }), `${where}：サイドナビが崩れない`).toBeVisible();
}

test.describe('クロスサイトスクリプティング・二重送信', () => {
  /* 典拠：授業の雛形 1.5（クロスサイトスクリプティング対策）、テスト仕様書の下書き「テスト対象の機能」(1.5)・「テストデータの準備」(2.1) */
  test('06-046 クロスサイトスクリプティング', async ({ page, browser }) => {
    const admin = await openWindow(browser, 'admin');
    await login(page, 'staffSakura');
    const dialogs = watchDialogs(page, admin);
    await newDiary(page);
    await childSelect(page).selectOption({ label: TARO });
    await page.waitForTimeout(1000);
    await bodyBox(page).fill(XSS_A);
    await saveDraft(page);
    await expect(toast(page, /保存/)).toBeVisible();
    const [d] = diariesLike('受入テスト 06-046 <script>');
    await openDiary(page, d.diary_id);
    await expectLiteral(page, XSS_A, '日誌作成・編集画面');
    await confirmButton(page).click();
    await expect(applyButton(page)).toBeVisible();
    await expectLiteral(page, XSS_A, '日誌確認画面');
    await applyButton(page).click();
    await expect(page.getByRole('heading', { name: '日誌', level: 1 })).toBeVisible();
    await openApproval(admin, d.diary_id);
    await expectLiteral(admin, XSS_A, '日誌承認画面');
    await mainOf(admin).getByRole('textbox', { name: /差し戻す理由/ }).fill(XSS_B);
    await mainOf(admin).getByRole('button', { name: '差し戻す' }).click();
    await expect(admin.getByRole('heading', { name: '承認待ち', level: 1 })).toBeVisible();
    await openDiary(page, d.diary_id);
    await expectLiteral(page, XSS_B, '差し戻しの理由');
    await evidence(page, '06-046');
    await page.goto('/staff/children');
    await mainOf(page).getByRole('row', { name: new RegExp(`^${TARO}`) }).getByRole('link', { name: /記録/ }).click();
    await expect(page.getByRole('heading', { name: new RegExp(TARO), level: 1 })).toBeVisible();
    expect.soft(await mainOf(page).locator('img[src="x"]').count(), '園児タイムライン：画像の要素ができない').toBe(0);
    expect.soft(await mainOf(page).locator('b', { hasText: '太字' }).count(), '園児タイムライン：太字の要素ができない').toBe(0);

    await newDiary(page);
    await fillIncident(page, { child: MISAKI, occurred: pastStep(2), place: '<b>園庭</b>06-046', situation: XSS_A, response: '受入テスト 06-046 対応' });
    await saveDraft(page);
    await expect(toast(page, /保存/)).toBeVisible();
    const [inc] = diariesLike('受入テスト 06-046 対応');
    await confirmAndApply(page);
    await openApproval(admin, inc.diary_id);
    await expectLiteral(admin, XSS_A, '日誌承認画面（ヒヤリハット）');
    expect.soft(await mainOf(admin).getByText('<b>園庭</b>06-046').count(), '場所のタグがそのまま出る').toBeGreaterThan(0);
    expect.soft(dialogs, 'ダイアログ（alert）が出ない').toEqual([]);
    expect.soft(diaryById(d.diary_id)!.body, 'SQL：body にそのまま').toBe(XSS_A);
    expect.soft(diaryById(d.diary_id)!.returned_reason, 'SQL：returned_reason にそのまま').toBe(XSS_B);
    expect.soft(diaryById(inc.diary_id)!.place, 'SQL：place にそのまま').toBe('<b>園庭</b>06-046');
  });

  /* 典拠：授業の雛形 1.5（二重送信の防止）、テスト仕様書の下書き「テスト対象の機能」(1.5)、詳細設計書「押したときの処理の型」(2-0 (2)) */
  test('06-047 二重送信 ボタンの連打', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const withdrawId = await createDiary(page, { type: '1', child: HANAKO, body: '受入テスト 06-047 取り下げ', status: '2' }, today);
    const returnId = await createDiary(page, { type: '1', child: MISAKI, body: '受入テスト 06-047 差し戻し', status: '2' }, today);
    const logBefore = maxLogId();
    // ① 下書き保存を続けて2回
    await newDiary(page);
    await childSelect(page).selectOption({ label: TARO });
    await page.waitForTimeout(800);
    await appendBody(page, '受入テスト 06-047 下書き');
    await saveButton(page).dblclick();
    await settle(page);
    expect.soft(diariesLike('受入テスト 06-047 下書き'), '①下書き保存の連打で1件だけ').toHaveLength(1);
    // ② 申請するを続けて2回
    await newDiary(page);
    await childSelect(page).selectOption({ label: TARO });
    await page.waitForTimeout(800);
    await appendBody(page, '受入テスト 06-047 申請');
    await confirmButton(page).click();
    await applyButton(page).dblclick();
    await settle(page);
    const applied = diariesLike('受入テスト 06-047 申請');
    expect.soft(applied, '②申請の連打で1件だけ').toHaveLength(1);
    expect.soft(applied[0]?.status, '②申請中').toBe('2');
    const applyLogs = logsAfter(logBefore).filter((l) => l.function_type === '1' && Number(l.target_id) === applied[0]?.diary_id && /申請/.test(l.after_value ?? ''));
    expect.soft(applyLogs, '②申請の操作ログが1つ').toHaveLength(1);
    // ③ 取り下げるを続けて2回
    await gotoList(page);
    await listRow(page, withdrawId).getByRole('button', { name: '申請を取り下げる' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取り下げる' }).dblclick();
    await settle(page);
    expect.soft(logsAfter(logBefore).filter((l) => Number(l.target_id) === withdrawId && /取り下げ/.test(l.after_value ?? '')), '③取り下げの操作ログが1つ').toHaveLength(1);
    // ④ 承認するを続けて2回 ⑤ 差し戻すを続けて2回
    const admin = await openWindow(browser, 'admin');
    await openApproval(admin, applied[0].diary_id);
    await mainOf(admin).getByRole('button', { name: '承認する' }).dblclick();
    await settle(admin);
    expect.soft(logsAfter(logBefore).filter((l) => Number(l.target_id) === applied[0].diary_id && l.operation_type === '3' && !/差し戻/.test(l.after_value ?? '')), '④承認の操作ログが1つ').toHaveLength(1);
    await openApproval(admin, returnId);
    await mainOf(admin).getByRole('textbox', { name: /差し戻す理由/ }).fill('受入テスト 06-047');
    await mainOf(admin).getByRole('button', { name: '差し戻す' }).dblclick();
    await settle(admin);
    expect.soft(logsAfter(logBefore).filter((l) => Number(l.target_id) === returnId && /差し戻/.test(`${l.after_value ?? ''}`)), '⑤差し戻しの操作ログが1つ').toHaveLength(1);
    await evidence(page, '06-047');
  });

  /* 典拠：授業の雛形 1.5（二重送信の防止：完了後にリロードして再送信できないことを確かめる）、テスト仕様書の下書き「テスト対象の機能」(1.5) */
  test('06-048 二重送信 完了のあとのリロード', async ({ page, browser }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    const dialogs = watchDialogs(page);
    const withdrawId = await createDiary(page, { type: '1', child: HANAKO, body: '受入テスト 06-048 取り下げ', status: '2' }, today);
    const returnId = await createDiary(page, { type: '1', child: MISAKI, body: '受入テスト 06-048 差し戻し', status: '2' }, today);
    const logBefore = maxLogId();
    await newDiary(page);
    await childSelect(page).selectOption({ label: TARO });
    await page.waitForTimeout(800);
    await appendBody(page, '受入テスト 06-048 申請');
    await confirmAndApply(page);
    await page.reload();
    await page.reload();
    await settle(page);
    const [d] = diariesLike('受入テスト 06-048 申請');
    expect.soft(diariesLike('受入テスト 06-048 申請'), '「06-048 申請」の行が1つ').toHaveLength(1);
    expect.soft(logsAfter(logBefore).filter((l) => Number(l.target_id) === d.diary_id && /申請/.test(l.after_value ?? '')), '申請の操作ログが1つ').toHaveLength(1);
    await gotoList(page);
    await listRow(page, withdrawId).getByRole('button', { name: '申請を取り下げる' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取り下げる' }).click();
    await expect(toast(page, /取り下げました/)).toBeVisible();
    await page.reload();
    await settle(page);
    expect.soft(logsAfter(logBefore).filter((l) => Number(l.target_id) === withdrawId && /取り下げ/.test(l.after_value ?? '')), '取り下げの操作ログが1つ').toHaveLength(1);

    const admin = await openWindow(browser, 'admin');
    dialogs.push(...watchDialogs(admin));
    await openApproval(admin, d.diary_id);
    await mainOf(admin).getByRole('button', { name: '承認する' }).click();
    await expect(admin.getByRole('heading', { name: '承認待ち', level: 1 })).toBeVisible();
    await admin.reload();
    await settle(admin);
    expect.soft(logsAfter(logBefore).filter((l) => Number(l.target_id) === d.diary_id && l.operation_type === '3' && !/差し戻/.test(l.after_value ?? '')), '承認の操作ログが1つ').toHaveLength(1);
    await openApproval(admin, returnId);
    await mainOf(admin).getByRole('textbox', { name: /差し戻す理由/ }).fill('受入テスト 06-048');
    await mainOf(admin).getByRole('button', { name: '差し戻す' }).click();
    await expect(admin.getByRole('heading', { name: '承認待ち', level: 1 })).toBeVisible();
    await admin.reload();
    await settle(admin);
    expect.soft(logsAfter(logBefore).filter((l) => Number(l.target_id) === returnId && /差し戻/.test(l.after_value ?? '')), '差し戻しの操作ログが1つ').toHaveLength(1);
    expect.soft(dialogs, '再送信を求める確かめが出ない').toEqual([]);
    await evidence(admin, '06-048');
  });
});

// =====================================================================
// 入力チェック
// =====================================================================

/** 文字数の上限を超えた入力：打てない（上限で止まる）か、文字数の文が出て保存されないこと */
async function expectOverLimit(page: Page, box: import('@playwright/test').Locator, value: string, limit: number, message: RegExp, notSaved: () => boolean, label: string) {
  await box.fill(value);
  const len = (await box.inputValue()).length;
  if (len <= limit) {
    note(`${label}：${limit + 1}文字目は打てない（入力欄が${limit}文字で止める）`);
    expect.soft(len, `${label}：打てない`).toBeLessThanOrEqual(limit);
    return;
  }
  await saveDraft(page);
  await settle(page, 1200);
  await expect.soft(page.getByText(message).first(), `${label}：文字数の文が出る`).toBeVisible();
  expect.soft(notSaved(), `${label}：保存されない`).toBe(true);
}

/** 誤りの文が出て、保存されない（確認画面へ進まない）こと */
/**
 * 断られることを確かめる（下書き保存で文が出て保存されない。「確認へ進む」を押せれば、その先も見る）。
 * confirmScreen：'mustNotReach' は確認画面へ進まないこと（既定）。'either' は確認画面へ進むかを問わず、進んだら「申請する」で同じ文が出て
 * 保存されない（申請中にならない）ことを見る（確認事項は「文が出て保存されない」で、確認画面へ進むかは書いていない。照合 T14 の V58。T15b）
 */
async function expectRefused(page: Page, message: string | RegExp, notSaved: () => boolean, label: string, confirmScreen: 'mustNotReach' | 'either' = 'mustNotReach') {
  await saveDraft(page);
  await settle(page, 1200);
  const shown = await page.getByText(message).first().isVisible().catch(() => false);
  if (!shown) {
    // 設計書の文が出なかったとき、ブラウザの入力の制限（max・required など）で止まっていないかを備考に残す（NG の原因を見るため）
    const native = await mainOf(page).locator('input, textarea, select').evaluateAll((els) =>
      els.map((e) => (e as HTMLInputElement).validationMessage).filter((m) => m),
    );
    const alerts = await page.getByRole('alert').allInnerTexts().catch(() => []);
    note(`${label}：設計書の文が出ない。画面の表示：${alerts.join('／') || 'なし'}。ブラウザの入力の制限：${native.join('／') || 'なし'}`);
  }
  await expect.soft(page.getByText(message).first(), `${label}：誤りの文が出る`).toBeVisible();
  expect.soft(notSaved(), `${label}：保存されない`).toBe(true);
  const confirm = confirmButton(page);
  if (await confirm.isEnabled().catch(() => false)) {
    await confirm.click();
    await settle(page, 800);
    const reached = (await applyButton(page).count()) > 0;
    if (confirmScreen === 'mustNotReach') expect.soft(reached, `${label}：確認画面へ進まない`).toBe(false);
    else if (!reached) await expect.soft(page.getByText(message).first(), `${label}：「確認へ進む」で誤りの文が出る`).toBeVisible();
    if (reached) {
      await applyButton(page).click();
      await settle(page, 1200);
      const alerts = await page.getByRole('alert').allInnerTexts().catch(() => []);
      note(`${label}：確認画面へ進んだ。「申請する」のあとの表示：${alerts.join('／') || 'なし'}`);
      if (confirmScreen === 'either') await expect.soft(page.getByText(message).first(), `${label}：「申請する」で誤りの文が出る`).toBeVisible();
      expect.soft(notSaved(), `${label}：申請しても保存されない`).toBe(true);
    }
  }
}

test.describe('入力チェック（日誌作成・編集画面）', () => {
  const fillTo = (prefix: string, n: number) => prefix + 'あ'.repeat(n - prefix.length);

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の日誌の本文、図/画面詳細図「日誌作成・編集画面」(3-2) 項目9、詳細設計書「日誌」(4-13) の (1) */
  test('06-I001 本文 2000文字', async ({ page }) => {
    await login(page, 'staffSakura');
    await newDiary(page);
    await mainOf(page).getByRole('radio', { name: 'クラス日誌' }).check();
    await bodyBox(page).fill(fillTo('受入テスト 06-I001', 2000));
    await expect.soft(mainOf(page), '残り文字数（0）').toContainText(/残り\s*0\s*文字/);
    await saveDraft(page);
    await expect(toast(page, /保存/), '保存される').toBeVisible();
    const [d] = diariesLike('受入テスト 06-I001');
    expect.soft([...(d?.body ?? '')].length, 'SQL：body が2,000文字').toBe(2000);
    await evidence(page, '06-I001');
  });

  test('06-I002 本文 2001文字', async ({ page }) => {
    await login(page, 'staffSakura');
    await newDiary(page);
    await mainOf(page).getByRole('radio', { name: 'クラス日誌' }).check();
    await expectOverLimit(page, bodyBox(page), fillTo('受入テスト 06-I002', 2001), 2000, /本文は2,000文字以内で入力してください/, () => diariesLike('受入テスト 06-I002').every((d) => [...d.body].length <= 2000), '本文');
    await evidence(page, '06-I002');
  });

  /* 典拠：図/画面詳細図「日誌作成・編集画面」(3-2) 項目9、基本設計書「日誌（t_diary）」(5-5) の body・「誰でも使える操作の条件」(3-5) の⑤、詳細設計書「日誌」(4-13) の (1) */
  test('06-I003 本文 空', async ({ page }) => {
    await login(page, 'staffSakura');
    await newDiary(page);
    await mainOf(page).getByRole('radio', { name: 'クラス日誌' }).check();
    const before = maxDiaryId();
    await expectRefused(page, '本文を入力してください', () => maxDiaryId() === before, '本文が空');
    await expect.soft(mainOf(page).getByRole('radio', { name: 'クラス日誌' }), 'ほかの欄の値は消えない').toBeChecked();
    await evidence(page, '06-I003');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の日付の扱い、基本設計書「日付の扱い」(4-6)・「入力項目の制約値とメッセージ一覧」(4-12)、図/画面詳細図「日誌作成・編集画面」(3-2) 項目6 */
  test('06-I004 記録日 翌日', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    await newDiary(page);
    await childSelect(page).selectOption({ label: TARO });
    await page.waitForTimeout(800);
    await appendBody(page, '受入テスト 06-I004');
    await dateBox(page).fill(shiftDate(today, 1));
    await expectRefused(page, '記録日に未来の日付は指定できません。', () => diariesLike('受入テスト 06-I004').length === 0, '記録日が翌日');
    await evidence(page, '06-I004');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の日付の扱い、基本設計書「日付の扱い」(4-6)・「入力項目の制約値」(4-12) の記録日、図/画面詳細図「日誌作成・編集画面」(3-2) 項目6 */
  test('06-I005 週案・月案の記録日 365日先', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    await newDiary(page);
    await mainOf(page).getByRole('radio', { name: '週案・月案' }).check();
    await bodyBox(page).fill('受入テスト 06-I005');
    await dateBox(page).fill(shiftDate(today, 365));
    await saveDraft(page);
    await expect.soft(toast(page, /保存/), '保存される').toBeVisible();
    if (!(await toast(page, /保存/).isVisible().catch(() => false))) {
      const native = await dateBox(page).evaluate((e) => `${(e as HTMLInputElement).validationMessage}（max=${(e as HTMLInputElement).max}）`);
      note(`365日先が保存されない。記録日の入力の制限：${native}`);
    }
    const [d] = diariesLike('受入テスト 06-I005');
    expect.soft(d?.diary_date, 'SQL：diary_date＝当日の365日先').toBe(shiftDate(today, 365));
    expect.soft(d?.record_type, "SQL：record_type＝'3'").toBe('3');
    await evidence(page, '06-I005');
  });

  /* 典拠：同上、詳細設計書「日誌」(4-13) の (1) */
  test('06-I006 週案・月案の記録日 366日先', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    await newDiary(page);
    await mainOf(page).getByRole('radio', { name: '週案・月案' }).check();
    await bodyBox(page).fill('受入テスト 06-I006');
    await dateBox(page).fill(shiftDate(today, 366));
    await expectRefused(page, '週案・月案の記録日は365日先までです。', () => diariesLike('受入テスト 06-I006').length === 0, '366日先');
    await evidence(page, '06-I006');
  });

  /* 典拠：基本設計書「日誌の作成から承認まで」(4-6) の処理3・「入力項目の制約値」(4-12) のクラス・園児、図/画面詳細図「日誌作成・編集画面」(3-2) 項目5、詳細設計書「日誌」(4-13) の (1) */
  test('06-I007 対象の園児 未選択', async ({ page }) => {
    await login(page, 'staffSakura');
    await newDiary(page);
    await bodyBox(page).fill('受入テスト 06-I007');
    await expectRefused(page, '対象の園児を選んでください', () => diariesLike('受入テスト 06-I007').length === 0, '園児が未選択');
    await evidence(page, '06-I007');
  });

  /* 典拠：基本設計書「日誌（t_diary）」(5-5) の class_id・「入力項目の制約値」(4-12) のクラス・園児、詳細設計書「日誌」(4-13) の (1) */
  test('06-I008 対象のクラス 在籍と違うクラス', async ({ page }) => {
    await login(page, 'admin');
    await newDiary(page);
    await childSelect(page).selectOption({ label: TARO });
    await page.waitForTimeout(800);
    await appendBody(page, '受入テスト 06-I008');
    const options = (await classSelectOf(page).locator('option').allInnerTexts()).map((t) => t.trim());
    if (!options.includes('ひまわり組') || (await classSelectOf(page).isDisabled())) {
      note(`園児を選ぶと、対象のクラスを在籍と違うクラスに替えられない（選択肢：${options.join('・')}）。その形で制約を満たす`);
      expect.soft(options.filter((o) => !/選んで|すべて/.test(o)), '在籍と違うクラスを選べない').toEqual(['さくら組']);
      await evidence(page, '06-I008');
      return;
    }
    await classSelectOf(page).selectOption({ label: 'ひまわり組' });
    await expectRefused(page, '対象のクラスは、対象の園児が在籍するクラスを選んでください', () => diariesLike('受入テスト 06-I008').length === 0, '在籍と違うクラス', 'either');
    await evidence(page, '06-I008');
  });
});

test.describe('入力チェック（日誌承認画面・承認の取り消し）', () => {
  async function appliedForReturn(browser: Browser, no: string): Promise<{ admin: Page; id: number }> {
    const today = jstToday();
    const s = await openWindow(browser, 'staffSakura');
    const id = await createDiary(s, { type: '1', child: TARO, body: `受入テスト ${no}`, status: '2' }, today);
    const admin = await openWindow(browser, 'admin');
    await openApproval(admin, id);
    return { admin, id };
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の差し戻す理由・承認を取り消す理由・「日誌（t_diary）」(5-5) の returned_reason、図/画面詳細図「日誌承認画面（管理者）」(3-5) 項目6 */
  test('06-I009 差し戻す理由 500文字', async ({ browser }) => {
    const { admin, id } = await appliedForReturn(browser, '06-I009');
    const reason = '受入テスト 06-I009' + 'あ'.repeat(500 - '受入テスト 06-I009'.length);
    await mainOf(admin).getByRole('textbox', { name: /差し戻す理由/ }).fill(reason);
    await mainOf(admin).getByRole('button', { name: '差し戻す' }).click();
    await expect(admin.getByRole('heading', { name: '承認待ち', level: 1 }), '差し戻される').toBeVisible();
    const d = diaryById(id)!;
    expect.soft([...(d.returned_reason ?? '')].length, 'SQL：returned_reason が500文字').toBe(500);
    expect.soft(d.status, "status＝'4'").toBe('4');
    await evidence(admin, '06-I009');
  });

  test('06-I010 差し戻す理由 501文字', async ({ browser }) => {
    const { admin, id } = await appliedForReturn(browser, '06-I010');
    const box = mainOf(admin).getByRole('textbox', { name: /差し戻す理由/ });
    await box.fill('受入テスト 06-I010' + 'あ'.repeat(501 - '受入テスト 06-I010'.length));
    const len = (await box.inputValue()).length;
    if (len <= 500) note('501文字目は打てない（入力欄が500文字で止める）');
    else {
      await mainOf(admin).getByRole('button', { name: '差し戻す' }).click();
      await settle(admin, 1200);
      await expect.soft(admin.getByText(/500文字以内/).first(), '文字数の文が出る').toBeVisible();
    }
    expect.soft(diaryById(id)!.status, '差し戻されない（申請中のまま）').toBe('2');
    await evidence(admin, '06-I010');
  });

  /* 典拠：要件定義書「日誌システム」(4-3)、基本設計書「日誌の作成から承認まで」(4-6) の処理9・「入力項目の制約値」(4-12)、図/画面詳細図「日誌承認画面（管理者）」(3-5) 項目6・7 と注記 */
  test('06-I011 差し戻す理由 空', async ({ browser }) => {
    const { admin, id } = await appliedForReturn(browser, '06-I011');
    const btn = mainOf(admin).getByRole('button', { name: '差し戻す' });
    if (await btn.isEnabled()) {
      await btn.click();
      await settle(admin, 1200);
      await expect.soft(admin.getByText(/理由/).filter({ hasText: /入力|入れて|書いて/ }).first(), '理由を求める表示').toBeVisible();
    } else note('理由が空のうちは「差し戻す」を押せない');
    expect.soft(diaryById(id)!.status, '差し戻されない（申請中のまま）').toBe('2');
    await evidence(admin, '06-I011');
  });

  /* 典拠：基本設計書「承認の取り消し」(4-6)・「入力項目の制約値」(4-12)、図/画面詳細図「日誌作成・編集画面」(3-2) 項目27・「全画面に共通する規定」(0-2) のダイアログの中の誤り、
     詳細設計書「日誌の画面（作り直し）」(2-13) の (3)・「日誌」(4-13) の (5) */
  test('06-I012 承認を取り消す理由 空・空白だけ', async ({ page, browser }) => {
    const today = jstToday();
    const s = await openWindow(browser, 'staffSakura');
    const id = await createDiary(s, { type: '1', child: TARO, body: '受入テスト 06-I012', status: '2' }, today);
    await login(page, 'admin');
    await approveDiary(page, id);
    await openDiary(page, id);
    await mainOf(page).getByRole('button', { name: '承認を取り消して差し戻す' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const go = dialog.getByRole('button', { name: '取り消して差し戻す' });
    if (await go.count()) await expect.soft(go, '①空：押せない').toBeDisabled();
    await dialog.getByRole('textbox', { name: /理由/ }).fill('　　　');
    if ((await go.count()) && (await go.isEnabled())) {
      await go.click();
      await settle(page, 1200);
      await expect.soft(dialog.getByText('承認を取り消す理由を入力してください。'), '②空白だけ：ダイアログの中に文が出る').toBeVisible();
    } else note('空白だけでも「取り消して差し戻す」を押せない');
    expect.soft(diaryById(id)!.status, '取り消されない（承認済みのまま）').toBe('3');
    await evidence(page, '06-I012');
  });
});

test.describe('入力チェック（ヒヤリハット）', () => {
  const base = (no: string) => ({ child: MISAKI, occurred: pastStep(2), place: `園庭（受入テスト ${no}）`, situation: `受入テスト ${no} 状況`, response: `受入テスト ${no} 対応` });
  const notSavedIncident = (no: string) => () => diariesLike(`受入テスト ${no}`).length === 0;
  const start = async (page: Page) => {
    await login(page, 'staffSakura');
    await newDiary(page);
  };

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表（ヒヤリハットの記録）、基本設計書「ヒヤリハットの記録」(4-6)・「入力項目の制約値」(4-12)、図/画面詳細図「日誌作成・編集画面」(3-2) 項目18、
     詳細設計書「日誌」(4-13) の (1) */
  test('06-I013 発生日時 空', async ({ page }) => {
    await start(page);
    await fillIncident(page, { ...base('06-I013'), occurred: '' });
    await expectRefused(page, '発生日時を入力してください', notSavedIncident('06-I013'), '発生日時が空');
    await evidence(page, '06-I013');
  });

  /* 典拠：同上、詳細設計書「日誌の画面（作り直し）」(2-13) の (8)（5分刻み） */
  test('06-I014 発生日時 未来', async ({ page }) => {
    await start(page);
    const step = 5 * 60_000;
    await fillIncident(page, { ...base('06-I014'), occurred: jstLocal(new Date(Math.floor(Date.now() / step) * step + step)) });
    await expectRefused(page, '発生日時に未来の日時は指定できません。', notSavedIncident('06-I014'), '発生日時が未来', 'either');
    await evidence(page, '06-I014');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) のヒヤリハットの場所・状況・とった対応・今後の対策・保護者への連絡、「日誌（t_diary）」(5-5)、図/画面詳細図「日誌作成・編集画面」(3-2) 項目19〜21・28 */
  test('06-I015 ヒヤリハットの欄 上限ちょうど', async ({ page }) => {
    await start(page);
    const fill = (p: string, n: number) => p + 'あ'.repeat(n - p.length);
    const v = {
      child: MISAKI,
      occurred: pastStep(2),
      place: fill('受入テスト 06-I015 場所', 100),
      situation: fill('受入テスト 06-I015 状況', 1000),
      response: fill('受入テスト 06-I015 対応', 1000),
      counter: fill('受入テスト 06-I015 対策', 1000),
      told: { at: pastStep(1), method: '電話', person: fill('母', 50) },
    };
    await fillIncident(page, v);
    await saveDraft(page);
    await expect(toast(page, /保存/), '保存される').toBeVisible();
    const [d] = diariesLike('受入テスト 06-I015 状況');
    expect(d, '保存された').toBeTruthy();
    await openDiary(page, d.diary_id);
    for (const [name, n] of [[/^場所/, 100], [/^状況/, 1000], [/^とった対応/, 1000], [/^今後の対策/, 1000], [/^伝えた相手/, 50]] as const) {
      expect.soft((await mainOf(page).getByRole('textbox', { name }).inputValue()).length, `開き直すと ${name} が${n}文字`).toBe(n);
    }
    expect.soft([...(d.place ?? '')].length, 'SQL：place が100文字').toBe(100);
    expect.soft([...(d.guardian_notice_person ?? '')].length, 'SQL：guardian_notice_person が50文字').toBe(50);
    await evidence(page, '06-I015');
  });

  test('06-I016 場所 101文字', async ({ page }) => {
    await start(page);
    await fillIncident(page, base('06-I016'));
    await expectOverLimit(page, mainOf(page).getByRole('textbox', { name: /^場所/ }), '受入テスト 06-I016 場所' + 'あ'.repeat(101 - '受入テスト 06-I016 場所'.length), 100, /場所は100文字以内で入力してください。/, notSavedIncident('06-I016'), '場所');
    await evidence(page, '06-I016');
  });

  test('06-I017 場所 空', async ({ page }) => {
    await start(page);
    await fillIncident(page, { ...base('06-I017'), place: '' });
    await expectRefused(page, '場所を入力してください。', notSavedIncident('06-I017'), '場所が空');
    await evidence(page, '06-I017');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) のヒヤリハットの状況・とった対応、図/画面詳細図「日誌作成・編集画面」(3-2) 項目20、詳細設計書「日誌」(4-13) の (1) */
  test('06-I018 状況 1001文字', async ({ page }) => {
    await start(page);
    await fillIncident(page, base('06-I018'));
    await expectOverLimit(page, mainOf(page).getByRole('textbox', { name: /^状況/ }), '受入テスト 06-I018 状況' + 'あ'.repeat(1001 - '受入テスト 06-I018 状況'.length), 1000, /状況・とった対応は1,000文字以内で入力してください。/, notSavedIncident('06-I018'), '状況');
    await evidence(page, '06-I018');
  });

  /* 典拠：基本設計書「ヒヤリハットの記録」(4-6)・「入力項目の制約値」(4-12)、図/画面詳細図「日誌作成・編集画面」(3-2) 項目21、詳細設計書「日誌」(4-13) の (1) */
  test('06-I019 とった対応 空', async ({ page }) => {
    await start(page);
    await fillIncident(page, { ...base('06-I019'), response: '' });
    await expectRefused(page, 'とった対応を入力してください', notSavedIncident('06-I019'), 'とった対応が空');
    await evidence(page, '06-I019');
  });

  /* 典拠：要件定義書「日誌システム」(4-3) の機能の表、基本設計書「ヒヤリハットの記録」(4-6)・「入力項目の制約値」(4-12) の保護者への連絡、図/画面詳細図「日誌作成・編集画面」(3-2) 項目21、
     詳細設計書「日誌」(4-13) の (1) */
  test('06-I020 伝えた相手 空', async ({ page }) => {
    await start(page);
    await fillIncident(page, { ...base('06-I020'), told: { at: pastStep(1), method: '電話', person: '' } });
    await expectRefused(page, '保護者へ伝えた日時・手段・相手を入れてください。', notSavedIncident('06-I020'), '伝えた相手が空');
    await evidence(page, '06-I020');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の保護者への連絡（相手 50文字以内）、「日誌（t_diary）」(5-5) の guardian_notice_person */
  test('06-I021 伝えた相手 51文字', async ({ page }) => {
    await start(page);
    await fillIncident(page, { ...base('06-I021'), told: { at: pastStep(1), method: '電話', person: '母' } });
    await expectOverLimit(page, mainOf(page).getByRole('textbox', { name: /^伝えた相手/ }), '母' + 'あ'.repeat(50), 50, /50文字以内/, notSavedIncident('06-I021'), '伝えた相手');
    await evidence(page, '06-I021');
  });

  /* 典拠：詳細設計書「日誌」(4-13) の (1)（ヒヤリハットの本文）・決めたこと D-33 */
  test('06-I022 状況 見出しだけの行', async ({ page }) => {
    await start(page);
    await fillIncident(page, { ...base('06-I022'), situation: '受入テスト 06-I022 状況\n【状況】' });
    await expectRefused(page, '「【状況】」「【とった対応】」「【今後の対策】」だけの行は書けません。', notSavedIncident('06-I022'), '見出しだけの行', 'either');
    await evidence(page, '06-I022');
  });
});

test.describe('入力チェック（写真・一覧）', () => {
  /** 写真のファイル選択を開く。無ければ【12-1】で未実施にする */
  async function photoChooser(page: Page) {
    await login(page, 'staffSakura');
    await newDiary(page);
    await mainOf(page).getByRole('radio', { name: 'クラス日誌' }).check();
    await bodyBox(page).fill(`受入テスト ${test.info().title.slice(0, 7)}`);
    const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
    await mainOf(page).getByRole('button', { name: /追加/ }).click();
    const fc = await chooser;
    test.skip(!fc, notIn121('日誌の写真のファイル選択（「＋ 追加」はファイルを選ばずに仮の写真を足す）'));
    return fc!;
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の日誌の写真、図/画面詳細図「日誌作成・編集画面」(3-2) 項目10・「モックアップでは実装しないもの」(12-1) */
  test('06-I023 写真 GIF', async ({ page }) => {
    const fc = await photoChooser(page);
    await fc.setFiles({ name: 'p.gif', mimeType: 'image/gif', buffer: Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64') });
    await saveDraft(page);
    await settle(page, 1200);
    const [d] = diariesLike('受入テスト 06-I023');
    expect.soft(d ? sqlAll('SELECT 1 FROM t_diary_attachment WHERE diary_id = ?', d.diary_id) : [], '添付が増えない').toHaveLength(0);
    await evidence(page, '06-I023');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の日誌の写真・「設定マスタ（m_setting）」(5-9) の attachment.max_size_mb、図/画面詳細図「日誌作成・編集画面」(3-2) 項目10・(12-1) */
  test('06-I024 写真 11MB', async ({ page }) => {
    const fc = await photoChooser(page);
    const big = Buffer.alloc(11 * 1024 * 1024, 0);
    big.set([0xff, 0xd8, 0xff, 0xe0], 0);
    await fc.setFiles({ name: 'big.jpg', mimeType: 'image/jpeg', buffer: big });
    await saveDraft(page);
    await settle(page, 1500);
    const [d] = diariesLike('受入テスト 06-I024');
    expect.soft(d ? sqlAll('SELECT 1 FROM t_diary_attachment WHERE diary_id = ?', d.diary_id) : [], '添付が増えない').toHaveLength(0);
    await evidence(page, '06-I024');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の検索の期間、図/画面詳細図「日誌一覧画面」(3-1) 項目4・「モックアップを直したもの」(12-2) */
  test('06-I025 期間 開始が終了より後', async ({ page }) => {
    const today = jstToday();
    await login(page, 'staffSakura');
    await createDiary(page, { type: '1', child: TARO, body: '受入テスト 06-I025' }, today);
    await gotoList(page);
    const main = mainOf(page);
    const links = () => main.locator('a[href^="/staff/diary/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')).join(','));
    const before = await links();
    await main.getByRole('textbox', { name: /期間（開始）/ }).fill(today);
    await main.getByRole('textbox', { name: /期間（終了）/ }).fill(shiftDate(today, -1));
    await main.getByRole('button', { name: '絞り込む' }).click();
    await settle(page, 1200);
    await expect.soft(page.getByRole('alert').or(page.getByRole('status').filter({ hasText: /期間|開始|終了/ })).first(), '誤りを示す').toBeVisible();
    expect.soft(await links(), '検索しない（一覧が変わらない）').toBe(before);
    await evidence(page, '06-I025');
  });
});

/** いまの日誌IDの最大（保存されたかを見る） */
function maxDiaryId(): number {
  return Number(sqlOne<{ m: number }>('SELECT COALESCE(MAX(diary_id),0) AS m FROM t_diary')?.m ?? 0);
}
