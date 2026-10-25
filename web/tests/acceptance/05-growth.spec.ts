/*
 * シート 05 発達チェック・身体測定・成長の記録（T10b）。ケースは sheet-05.md（テスト仕様書 兼 成績書 第2.0版）。
 *
 * - 期待する結果は設計書（docs ブランチ dbf5da91）から書いた。コードは読んでいない。部品は設計書の表示名で探す
 * - テストごとに新しいデータベースで立てる（serverScope: 'test'）。前のケースの結果を使うケースは、その状態をテストの中で作り直す
 *   （前提の園児・家庭は、画面と同じ経路の API と新規登録画面で作る。05-growth.helpers.ts）
 * - 確認事項は1つのケースにいくつもあるので、続きを確かめられるものは expect.soft で確かめ、違ったところをすべて残す（1つでも違えば NG）
 * - 画面で作れない状態は、シートの【SQL】（W1・W2）のとおりにデータベースを書き換える
 */
import { readFileSync } from 'node:fs';
import { test, expect, login, evidence, jstToday } from './harness';
import {
  BODY_JUDGEMENT_WORDS, COMPARE_DISCLAIMER, DEV_JUDGEMENT_WORDS, GROWTH_DISCLAIMER,
  achievementItems, achievements, addDays, addMonths, addPhrase, ageInMonths, apiAs, categoryLabel,
  checksOf, clickAndWait, countIn, createChildren, dashboardRow, devCell, devRow, draftButton, finalize, finalizeButton,
  growthBody, historyRow, homeRegion, implDate, itemGroups, itemNames, judgementWords, lastOpLogId, latestSchedule, loginIn,
  main, makeFamily, makeFreeStaff, md, messageBox, monthsRe, nameCheckDialog, newWindow, noteBox, opLogsSince,
  openDevInput, openDevList, openGrowthFromHome, openPhysical, physChild, physDate, physicalOf, registerButton,
  registerPhysical, resultsOf, saveDraft, schedulesOf, selectPhysChild, setAll, setImplDate, setPhysDate, setResult, setting,
  slash, sqlAll, sqlRun, toast, unenteredDialog, w1MoveScheduleToYesterday, w2PreviousCheck, heightBox, weightBox,
  answerPhysicalChecks, childHeading, fillMeasure, overdueNotice, soonNotice, unrecordedLine,
  type ChildSpec, type RequestFactory,
} from './05-growth.helpers';
import type { Browser, Page } from '@playwright/test';

const REASON_U05 = 'デモデータに3歳以上の区分が無く、区分と項目を直す画面も無い（U-05）';
/** 待って確かめる soft の expect（expect.poll を soft で使う） */
const sexp = expect.configure({ soft: true });

/** そのページの main の文字（空白をまとめる） */
async function mainText(page: Page): Promise<string> {
  return (await main(page).innerText()).replace(/\s+/g, ' ');
}

/** 一覧の列の見出し（表が描き終わるのを待つ） */
async function headers(page: Page): Promise<string[]> {
  await expect(main(page).getByRole('columnheader').first()).toBeVisible();
  return (await main(page).getByRole('columnheader').allInnerTexts()).map((t) => t.trim());
}

/** 児B の下書きを開き直す（実施日は 05-014 の 2026-02-28。開き直すと実施日が今日に戻るため、もう一度入れる。戻ること自体は 05-014 が見る） */
async function reopenB(page: Page, b: ChildSpec) {
  await openDevInput(page, b.name);
  if ((await implDate(page).inputValue()) !== '2026-02-28') await setImplDate(page, '2026-02-28');
  await expect.poll(() => categoryLabel(page)).toMatch(/6か月/);
}

/** 一覧のクラスを選ぶ（「すべて」が無ければそのまま） */
async function chooseListClass(page: Page, name: string) {
  const cls = main(page).getByRole('combobox', { name: 'クラス' });
  if (await cls.locator('option', { hasText: name }).count()) await cls.selectOption({ label: name });
}

/** 画面に出た確かめのダイアログ（window.alert など）を数える（XSS のケース） */
function watchDialogs(...pages: Page[]): string[] {
  const seen: string[] = [];
  for (const p of pages) p.on('dialog', (d) => { seen.push(`${d.type()}: ${d.message()}`); void d.dismiss().catch(() => {}); });
  return seen;
}

/** 保護者の窓を開き、家庭を作る（新規登録画面）。終わったとき保護者ホーム */
async function family(browser: Browser, pw: RequestFactory, child: ChildSpec, label: 'A' | 'B') {
  const w = await newWindow(browser, 'guardian');
  const f = await makeFamily(w.page, pw, child, { label, relationship: label === 'A' ? '母' : '父', phone: label === 'A' ? '090-0000-0501' : '090-0000-0502' });
  return { ...w, ...f };
}

/** 児B の下書き（05-014 のあとの状態）：実施日 2026-02-28 で下書き保存する */
async function draftB(page: Page, b: ChildSpec) {
  await openDevInput(page, b.name);
  await setImplDate(page, '2026-02-28');
  await saveDraft(page);
}

/** 児B の下書き（05-015 のあとの状態）：項目1 未入力、項目2 未確認、項目3 一部、項目4 確認できた。項目の名前を返す */
async function draftB15(page: Page, b: ChildSpec): Promise<string[]> {
  await openDevInput(page, b.name);
  await setImplDate(page, '2026-02-28');
  const names = await itemNames(page);
  await setResult(page, 1, '未確認');
  await setResult(page, 2, '一部');
  await setResult(page, 3, '確認できた');
  await saveDraft(page);
  return names;
}

/**
 * 連絡帳の行の「成長の記録に残す」を切り替える。押すとサーバの応答を待ってから状態が変わる（楽観的更新をしない。
 * 詳細設計書「全画面に共通する部品と決まり」(2-0 (2))）ので、check() ではなく押して待つ
 */
async function toggleKeep(box: import('@playwright/test').Locator, on: boolean) {
  if ((await box.isChecked()) === on) return;
  await box.click();
  await expect(box).toBeChecked({ checked: on, timeout: 10_000 });
}

/** 児A の発達チェックの実施日（区分「1歳6か月頃〜1歳9か月頃」の時期。4項目あり、デモデータで共有しないにしてある項目を含まない） */
const A_CHECK_DATE = '2026-01-20';

/** 05-015 の状態（項目1 未入力、項目2 未確認、項目3 一部、項目4 確認できた）を、いま開いている入力画面に入れ直す */
async function reapplyB15(page: Page) {
  const back = itemGroups(page).nth(0).getByRole('button', { name: '未入力に戻す' });
  if (await back.count()) await back.click();
  await setResult(page, 1, '未確認');
  await setResult(page, 2, '一部');
  await setResult(page, 3, '確認できた');
}

/** 文字列を n 文字にする（頭に印を置き、残りを「あ」で埋める） */
function text(prefix: string, n: number): string {
  return prefix + 'あ'.repeat(Math.max(0, n - [...prefix].length));
}

test.describe('シート05 発達チェック・身体測定・成長の記録', () => {
  test.use({ serverScope: 'test' });

  // ---------------------------------------------------------------- 一覧とスケジュール

  test('05-001 一般の一覧', async ({ page, playwright }) => {
    // 典拠：図/画面詳細図「発達チェック一覧画面」(6-1) 項目1・3・4・7・9〜11、基本設計書「権限と利用可能機能」(6-1)
    const c = await createChildren(playwright, ['A', 'B', 'D', 'E', 'F']);
    await login(page, 'staffHimawari');
    await openDevList(page);
    const opts = (await main(page).getByRole('combobox', { name: 'クラス' }).locator('option').allInnerTexts()).map((s) => s.trim());
    expect.soft(opts, 'クラスは「ひまわり組」だけ（さくら組・もも組を選べない）').toEqual(['ひまわり組']);
    await expect(devRow(page, c.A.name)).toBeVisible();
    for (const k of ['B', 'D', 'E', 'F'] as const) await expect.soft(devRow(page, c[k].name), `${c[k].name}（ほかのクラス）は出ない`).toHaveCount(0);
    const h = await headers(page);
    for (const col of ['園児', '月齢', '前回の実施日', '次回の予定日', '状態', '項目の漏れ', '操作']) expect.soft(h.some((x) => x.startsWith(col)), `列「${col}」`).toBe(true);
    const monthHeader = h.find((x) => x.startsWith('月齢')) ?? '';
    expect.soft(monthHeader, '月齢の列に「予定日の時点」').toContain('予定日の時点');
    expect.soft(monthHeader, '月齢の列に「目安」').toContain('目安');
    await expect.soft(devRow(page, c.A.name).getByRole('link', { name: '入力' }).or(devRow(page, c.A.name).getByRole('button', { name: '入力' }))).toBeVisible();
    await expect.soft(main(page).getByRole('link', { name: '身体記録へ' }).or(main(page).getByRole('button', { name: '身体記録へ' }))).toBeVisible();
    await expect.soft(main(page).getByRole('link', { name: 'スケジュール設定' }).or(main(page).getByRole('button', { name: 'スケジュール設定' })), '一般にスケジュール設定は出ない').toHaveCount(0);
    await expect.soft(main(page).getByRole('link', { name: '共有範囲の設定' }).or(main(page).getByRole('button', { name: '共有範囲の設定' })), '一般に共有範囲の設定は出ない').toHaveCount(0);
    await expect.soft(main(page).getByRole('button', { name: '絞り込む' })).toHaveCount(0);
    expect.soft(judgementWords(await mainText(page), DEV_JUDGEMENT_WORDS), '判定の言葉').toEqual([]);
    await evidence(page, '05-001');
  });

  test('05-002 管理者の一覧', async ({ page, playwright }) => {
    // 典拠：図/画面詳細図「発達チェック一覧画面」(6-1) 項目1・3・10・11 と注記
    const c = await createChildren(playwright, ['A', 'B', 'D', 'E', 'F']);
    await login(page, 'admin');
    await openDevList(page);
    const cls = main(page).getByRole('combobox', { name: 'クラス' });
    await expect.soft(cls.locator('option:checked'), '初期値は「すべて」').toHaveText('すべて');
    expect.soft((await headers(page)).some((x) => x.startsWith('クラス')), '「すべて」のときクラスの列').toBe(true);
    for (const k of ['A', 'B', 'D', 'E', 'F'] as const) await expect.soft(devRow(page, c[k].name)).toBeVisible();
    await cls.selectOption({ label: 'さくら組' });
    for (const k of ['B', 'D', 'E'] as const) await expect.soft(devRow(page, c[k].name)).toBeVisible();
    for (const k of ['A', 'F'] as const) await expect.soft(devRow(page, c[k].name), 'さくら組に絞るとすぐ消える').toHaveCount(0);
    for (const name of ['スケジュール設定', '共有範囲の設定', '身体記録へ']) {
      await expect.soft(main(page).getByRole('link', { name }).or(main(page).getByRole('button', { name }))).toBeVisible();
    }
    await evidence(page, '05-002');
  });

  test('05-003 最初の予定日', async ({ page, playwright }) => {
    // 典拠：基本設計書「推奨スケジュールの作り方」(4-9)・「発達チェック・身体測定」(5-8) の推奨頻度の既定値、図/画面詳細図「スケジュール設定画面（管理者）」(6-3) 項目2
    const R = jstToday();
    const c = await createChildren(playwright, ['A', 'F']);
    await login(page, 'admin');
    await openDevList(page);
    expect.soft(await devCell(page, c.A.name, '次回の予定日'), '児A：R＋120日').toContain(slash(addDays(R, 120)));
    expect.soft(await devCell(page, c.F.name, '次回の予定日'), '児F：R＋90日').toContain(slash(addDays(R, 90)));
    for (const k of ['A', 'F'] as const) {
      expect.soft(await devCell(page, c[k].name, '前回の実施日'), '前回の実施日は空').toMatch(/^(|―|-|－)$/);
      expect.soft(await devCell(page, c[k].name, '状態')).toBe('予定どおり');
      const s = schedulesOf(c[k].id);
      expect.soft(s.length, `${c[k].name} の予定は1行`).toBe(1);
      expect.soft(Number(s[0]?.is_manual_override ?? 0)).toBe(0);
    }
    await evidence(page, '05-003');
    await main(page).getByRole('link', { name: 'スケジュール設定' }).click();
    await expect(page.getByRole('heading', { name: 'スケジュール設定', level: 1 })).toBeVisible();
    const t = await mainText(page);
    expect.soft(t, '園の推奨：0〜11か月 90日').toMatch(/0\s*[〜~～-]\s*11\s*か月[^0-9]*90\s*日/);
    expect.soft(t, '園の推奨：12〜35か月 120日').toMatch(/12\s*[〜~～-]\s*35\s*か月[^0-9]*120\s*日/);
    expect.soft(t, '園の推奨：36か月〜 180日').toMatch(/36\s*か月\s*[〜~～-]?[^0-9]*180\s*日/);
  });

  test('05-004 健診の節目を優先', async ({ page, playwright }) => {
    // 典拠：基本設計書「推奨スケジュールの作り方」(4-9)・「月齢の算出」(4-9)、図/画面詳細図「発達チェック一覧画面」(6-1) 項目4 と注記
    const c = await createChildren(playwright, ['D']);
    const milestone = addMonths(c.D.birth, 18);
    await login(page, 'admin');
    await openDevList(page);
    expect.soft(await devCell(page, c.D.name, '次回の予定日'), '1歳6か月の応当日').toContain(slash(milestone));
    expect.soft(await devCell(page, c.D.name, '月齢'), '予定日の時点の月齢 18').toMatch(monthsRe(18));
    expect.soft(await mainText(page), '園児一覧の月齢は今日の時点という注記').toMatch(/園児一覧の月齢は今日の時点/);
    expect.soft(latestSchedule(c.D.id)?.scheduled_on).toBe(milestone);
    await evidence(page, '05-004');
    await page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: '園児', exact: true }).click();
    const row = main(page).getByRole('row').filter({ hasText: c.D.name });
    await expect(row).toBeVisible();
    await expect.soft(row, '園児一覧画面の月齢は今日の時点の 17').toContainText(monthsRe(17));
  });

  test('05-005 スケジュール設定画面の構成', async ({ page, playwright }) => {
    // 典拠：図/画面詳細図「スケジュール設定画面（管理者）」(6-3) 項目1〜11 と注記
    const R = jstToday();
    const c = await createChildren(playwright, ['A']);
    await login(page, 'admin');
    await page.goto('/staff/growth/schedule');
    await expect(page.getByRole('heading', { name: 'スケジュール設定', level: 1 })).toBeVisible();
    await main(page).getByRole('combobox', { name: 'クラス' }).selectOption({ label: 'ひまわり組' });
    const h = await headers(page);
    for (const col of ['園児', '月齢', '推奨間隔', 'システムの提案', '設定中の予定日', '次回の予定日', '操作']) expect.soft(h.some((x) => x.startsWith(col)), `列「${col}」`).toBe(true);
    expect.soft(h.find((x) => x.startsWith('月齢')) ?? '').toContain('提案日の時点');
    const row = main(page).getByRole('row').filter({ hasText: c.A.name });
    await expect(row).toBeVisible();
    await expect.soft(row).toContainText(/120\s*日/);
    await expect.soft(row.getByRole('textbox')).toHaveValue(addDays(R, 120));
    await expect.soft(row.getByRole('button', { name: '上書きする' }), '日付を変えるまで押せない').toBeDisabled();
    await expect.soft(main(page).getByRole('button', { name: 'マスタを編集' }).or(main(page).getByRole('link', { name: 'マスタを編集' })), '「マスタを編集」').toBeVisible();
    await expect.soft(main(page).getByRole('button', { name: /^(保存する|やめる)$/ })).toHaveCount(0);
    await evidence(page, '05-005');
  });

  /** スケジュール設定画面で、児A の次回の予定日を上書きする（理由の欄があれば理由を入れる）。理由の欄があったかを返す */
  async function overrideA(page: Page, a: ChildSpec, ymd: string, reason: string): Promise<boolean> {
    await page.goto('/staff/growth/schedule');
    await expect(page.getByRole('heading', { name: 'スケジュール設定', level: 1 })).toBeVisible();
    await main(page).getByRole('combobox', { name: 'クラス' }).selectOption({ label: a.className });
    const row = main(page).getByRole('row').filter({ hasText: a.name });
    await row.getByRole('textbox', { name: /次回の予定日/ }).fill(ymd);
    let reasonBox = row.getByRole('textbox', { name: /理由/ }).or(main(page).getByRole('textbox', { name: /理由/ }));
    const hadReason = (await reasonBox.count()) > 0;
    if (hadReason) await reasonBox.first().fill(reason);
    await row.getByRole('button', { name: '上書きする' }).click();
    const dlg = page.getByRole('dialog');
    if (await dlg.isVisible().catch(() => false)) {
      reasonBox = dlg.getByRole('textbox', { name: /理由/ });
      if (await reasonBox.count()) await reasonBox.fill(reason);
      await dlg.getByRole('button', { name: /上書き|保存|はい/ }).last().click();
    }
    await expect(row).toContainText(slash(ymd));
    return hadReason;
  }

  test('05-006 上書きする', async ({ page, browser, playwright }) => {
    // 典拠：基本設計書「推奨スケジュールの作り方」(4-9) の手動でのスケジュール上書き、図/画面詳細図「スケジュール設定画面（管理者）」(6-3) 項目4・5・8・9、
    //       「発達チェック一覧画面」(6-1) 項目5・6・13、「職員ダッシュボード」(2-6) 項目4
    test.setTimeout(120_000);
    const T = jstToday();
    const c = await createChildren(playwright, ['A']);
    const k = await loginIn(browser, 'staffHimawari');
    const before = await dashboardRow(k.page, /発達チェック/);
    await login(page, 'admin');
    const log0 = lastOpLogId();
    const hadReason = await overrideA(page, c.A, addDays(T, 3), '05-006 園の行事のため');
    expect.soft(hadReason, '理由の欄がある').toBe(true);
    const srow = main(page).getByRole('row').filter({ hasText: c.A.name });
    await expect.soft(srow).toContainText('手動上書き');
    await openDevList(page);
    expect.soft(await devCell(page, c.A.name, '次回の予定日')).toMatch(new RegExp(`${slash(addDays(T, 3))}.*手動上書き`));
    expect.soft(await devCell(page, c.A.name, '状態')).toBe('予定日が近い');
    expect.soft(await soonNotice(page), '予定日が近い園児の知らせ').toContain(c.A.name);
    await evidence(page, '05-006');
    await openDevList(k.page);
    expect.soft(await devCell(k.page, c.A.name, '次回の予定日'), '一般K にも手動上書き').toMatch(/手動上書き/);
    expect.soft(await devCell(k.page, c.A.name, '状態')).toBe('予定日が近い');
    const after = await dashboardRow(k.page, /発達チェック/);
    expect.soft(after, 'ダッシュボードに「予定日が近い」と「過ぎた」を分けて出す').toMatch(/予定日が近い.*過ぎた|過ぎた.*予定日が近い/);
    expect.soft(countIn(after, '予定日が近い'), '「予定日が近い」が1人多い').toBe(countIn(before, '予定日が近い') + 1);
    const s = latestSchedule(c.A.id);
    expect.soft(s?.scheduled_on).toBe(addDays(T, 3));
    expect.soft(Number(s?.is_manual_override)).toBe(1);
    expect.soft(s?.override_reason, '理由が残る').toBe('05-006 園の行事のため');
    expect.soft(opLogsSince(log0).some((l) => l.function_type === '4'), '操作ログ function_type＝4').toBe(true);
    await k.page.goto('/staff');
    await main(k.page).getByRole('row').filter({ hasText: /発達チェック/ }).getByRole('link', { name: '開く' }).click();
    await expect.soft(k.page.getByRole('heading', { name: '発達チェック', level: 1 })).toBeVisible();
    await k.context.close();
  });

  test('05-007 提案に戻す', async ({ page, playwright }) => {
    // 典拠：図/画面詳細図「スケジュール設定画面（管理者）」(6-3) 項目6、基本設計書「推奨スケジュールの作り方」(4-9)
    const R = jstToday();
    const c = await createChildren(playwright, ['A']);
    await login(page, 'admin');
    await overrideA(page, c.A, addDays(R, 3), '05-007 前提');
    const row = main(page).getByRole('row').filter({ hasText: c.A.name });
    await row.getByRole('button', { name: '提案に戻す' }).click();
    const dlg = page.getByRole('dialog');
    if (await dlg.isVisible().catch(() => false)) await dlg.getByRole('button', { name: /戻す|はい/ }).last().click();
    await expect.soft(row).not.toContainText('手動上書き');
    await openDevList(page);
    expect.soft(await devCell(page, c.A.name, '次回の予定日')).toContain(slash(addDays(R, 120)));
    expect.soft(await devCell(page, c.A.name, '次回の予定日')).not.toContain('手動上書き');
    expect.soft(await devCell(page, c.A.name, '状態')).toBe('予定どおり');
    expect.soft(await soonNotice(page)).not.toContain(c.A.name);
    const s = latestSchedule(c.A.id);
    expect.soft(Number(s?.is_manual_override)).toBe(0);
    expect.soft(s?.scheduled_on).toBe(addDays(R, 120));
    await evidence(page, '05-007');
  });

  test('05-008 予定日を過ぎた園児', async ({ page, playwright }) => {
    // 典拠：基本設計書「発達チェックの実施」(4-9) の表示名と数え方、図/画面詳細図「発達チェック一覧画面」(6-1) 項目2・4・5・12、「職員ダッシュボード」(2-6) 項目4
    const c = await createChildren(playwright, ['B', 'D', 'E']);
    await login(page, 'staffSakura');
    const before = await dashboardRow(page, /発達チェック/);
    w1MoveScheduleToYesterday(c.D.id); // 【SQL】(W1)
    const after = await dashboardRow(page, /発達チェック/);
    expect.soft(after, 'ダッシュボードに「過ぎた」').toMatch(/過ぎた/);
    expect.soft(countIn(after, '過ぎた'), '「過ぎた」が1人多い').toBe(countIn(before, '過ぎた') + 1);
    await openDevList(page);
    expect.soft(await devCell(page, c.D.name, '状態'), '状態の表示名').toBe('園児の未実施');
    expect.soft(await overdueNotice(page), '予定日を過ぎた園児の知らせ').toContain(c.D.name);
    const only = main(page).getByRole('checkbox', { name: '未実施のみ' });
    await expect.soft(only, '「未実施のみ」').toBeVisible();
    if (await only.count()) {
      await only.check();
      await expect.soft(devRow(page, c.D.name)).toBeVisible();
      await expect.soft(devRow(page, c.B.name)).toHaveCount(0);
      await expect.soft(devRow(page, c.E.name)).toHaveCount(0);
      await only.uncheck();
      await expect.soft(devRow(page, c.B.name)).toBeVisible();
    }
    await evidence(page, '05-008');
  });

  test('05-009 下書きだけの園児も未実施', async ({ page, playwright }) => {
    // 典拠：要件定義書「チェック漏れの強調」(4-6-2)、基本設計書「発達チェックの実施」(4-9)、詳細設計書「本書で足す文言」(4-1 (6))
    const c = await createChildren(playwright, ['D']);
    w1MoveScheduleToYesterday(c.D.id);
    await login(page, 'staffSakura');
    await openDevInput(page, c.D.name);
    await setResult(page, 0, '確認できた');
    await draftButton(page).click();
    await expect.soft(toast(page, '下書きを保存しました。保護者には届いていません。')).toBeVisible();
    await expect.soft(page.getByRole('heading', { name: '発達チェック', level: 1 }), '一覧へ戻る').toBeVisible();
    await page.goto('/staff/growth');
    expect.soft(await devCell(page, c.D.name, '状態'), '下書きだけでも園児の未実施').toBe('園児の未実施');
    expect.soft(await devCell(page, c.D.name, '状態')).toMatch(/未実施/);
    expect.soft(await overdueNotice(page)).toContain(c.D.name);
    const ch = checksOf(c.D.id);
    expect.soft(ch.length).toBe(1);
    expect.soft(ch[0]?.status).toBe('1');
    expect.soft(ch[0]?.finalized_at ?? null).toBeNull();
    expect.soft(resultsOf(ch[0]?.development_check_id ?? 0).map((r) => r.result)).toEqual(['1']);
    await evidence(page, '05-009');
  });

  test('05-010 未入力の確認', async ({ page, playwright }) => {
    // 典拠：基本設計書「発達チェックの実施」(4-9) の処理 7、図/画面詳細図「発達チェック入力画面」(6-2) 項目11・13、詳細設計書「職員の画面から成長の記録へ届けるもの」(2-12 (2))
    const c = await createChildren(playwright, ['D']);
    w1MoveScheduleToYesterday(c.D.id);
    await login(page, 'staffSakura');
    await openDevInput(page, c.D.name);
    await setResult(page, 0, '確認できた');
    await saveDraft(page);
    await openDevInput(page, c.D.name);
    await setResult(page, 1, '未確認');
    expect(await finalize(page, { acceptUnentered: false })).toBe('unentered');
    const dlg = unenteredDialog(page);
    await expect.soft(dlg.getByRole('button', { name: '戻って入力する' })).toBeVisible();
    await expect.soft(dlg.getByRole('button', { name: 'このまま確定する' })).toBeVisible();
    await dlg.getByRole('button', { name: '戻って入力する' }).click();
    await expect(dlg).toBeHidden();
    await expect.soft(itemGroups(page).nth(0).getByRole('radio', { name: '確認できた' })).toBeChecked();
    await expect.soft(itemGroups(page).nth(1).getByRole('radio', { name: '未確認' })).toBeChecked();
    expect.soft(checksOf(c.D.id)[0]?.status, '確定されない').toBe('1');
    await finalizeButton(page).click();
    await unenteredDialog(page).getByRole('button', { name: 'このまま確定する' }).click();
    const t = toast(page, /確定しました/);
    await expect(t).toBeVisible();
    await expect.soft(t, '保護者のいない園児').toHaveText(/確定しました。保護者が登録すると読めます。/);
    await expect.soft(t.getByRole('button', { name: '取り消す' }), '「取り消す」は添えない').toHaveCount(0);
    await expect.soft(page.getByRole('heading', { name: '発達チェック', level: 1 }), '一覧へ戻る').toBeVisible();
    await evidence(page, '05-010');
  });

  test('05-011 確定のあとの一覧', async ({ page, playwright }) => {
    // 典拠：基本設計書「発達チェックの実施」(4-9) の処理 8 と表示名・「推奨スケジュールの作り方」(4-9)、図/画面詳細図「発達チェック一覧画面」(6-1) 項目4・5
    const T = jstToday();
    const c = await createChildren(playwright, ['D']);
    w1MoveScheduleToYesterday(c.D.id);
    await login(page, 'staffSakura');
    const before = await dashboardRow(page, /発達チェック/);
    await openDevInput(page, c.D.name);
    const k = await itemGroups(page).count();
    await setResult(page, 0, '確認できた');
    await setResult(page, 1, '未確認');
    expect(await finalize(page)).toBe('done');
    await page.goto('/staff/growth');
    expect.soft(await devCell(page, c.D.name, '状態'), '園児の未実施でなくなる').not.toMatch(/未実施/);
    expect.soft(await overdueNotice(page)).not.toContain(c.D.name);
    expect.soft(await devCell(page, c.D.name, '前回の実施日')).toContain(slash(T));
    expect.soft(await devCell(page, c.D.name, '次回の予定日'), '次の予定日は1歳6か月の応当日').toContain(slash(addMonths(c.D.birth, 18)));
    expect.soft(await devCell(page, c.D.name, '項目の漏れ'), `項目の漏れ ${k - 2} 件`).toMatch(new RegExp(`項目の漏れ\\s*${k - 2}\\s*件|^${k - 2}\\s*件?$`));
    await evidence(page, '05-011');
    const after = await dashboardRow(page, /発達チェック/);
    expect.soft(countIn(after, '過ぎた'), '「過ぎた」が1人少ない').toBe(Math.max(0, countIn(before, '過ぎた') - 1));
    const ch = checksOf(c.D.id);
    expect.soft(ch[0]?.status).toBe('2');
    expect.soft(ch[0]?.finalized_at ?? '').toMatch(new RegExp(`^${T}`));
    expect.soft(schedulesOf(c.D.id).some((s) => s.scheduled_on === addMonths(c.D.birth, 18) && s.development_schedule_id !== ch[0]?.development_schedule_id), '次の予定の行').toBe(true);
  });

  // ---------------------------------------------------------------- 入力画面

  test('05-012 記録が無いときの成長の記録', async ({ browser, playwright }) => {
    // 典拠：基本設計書「成長の記録の閲覧（保護者）」(4-9)、図/画面詳細図「保護者ホーム」(2-7) 項目7・9、「成長の記録画面（保護者・スマートフォン）」(6-6) 項目1・2・5・8・10・12、
    //       詳細設計書「成長の記録画面（保護者）」(2-11 (3))
    const c = await createChildren(playwright, ['B']);
    const g = await family(browser, playwright, c.B, 'B');
    const region = homeRegion(g.page, c.B.name);
    await expect(region).toBeVisible();
    await expect.soft(region.getByRole('link', { name: /成長の記録/ })).toBeVisible();
    await expect.soft(region, '「新しい記録があります」は出ない').not.toContainText('新しい記録があります');
    await openGrowthFromHome(g.page, c.B.name);
    await expect.soft(growthBody(g.page), '身長・体重の区画').toContainText('まだ測った値はありません');
    await expect.soft(achievements(g.page)).toContainText('まだ成長の記録はありません。身体測定や発達チェックのあとに届きます');
    await expect.soft(g.page.getByRole('button', { name: 'さらに読み込む' })).toHaveCount(0);
    await expect.soft(g.page.getByText(GROWTH_DISCLAIMER)).toBeVisible();
    await evidence(g.page, '05-012');
    await g.context.close();
  });

  test('05-013 入力画面の構成', async ({ page, playwright }) => {
    // 典拠：図/画面詳細図「発達チェック入力画面」(6-2) 項目2〜7・9・14〜16、基本設計書「文章の下書き（AI）」(4-11) の使わないところ・「保護者へのひとこと」(4-9)
    const T = jstToday();
    const c = await createChildren(playwright, ['A']);
    await login(page, 'staffHimawari');
    await openDevInput(page, c.A.name);
    await expect.soft(page.getByRole('heading', { level: 1 })).toContainText(c.A.name);
    await expect.soft(page.getByRole('heading', { level: 1 })).toContainText(monthsRe(ageInMonths(c.A.birth, T)));
    await expect.soft(implDate(page)).toHaveValue(T);
    expect.soft(await implDate(page).getAttribute('max'), '明日より後を選べない').toBe(T);
    expect.soft(await categoryLabel(page), '区分の表示').not.toBe('');
    expect.soft(await main(page).getByRole('radio', { checked: true }).count(), 'すべて未入力').toBe(0);
    await expect.soft(main(page).getByRole('button', { name: '未入力に戻す' })).toHaveCount(0);
    await expect.soft(noteBox(page)).toHaveValue('');
    await expect.soft(messageBox(page)).toHaveValue('');
    await expect.soft(main(page).getByRole('button', { name: /AI|言い換え|続きの候補|下書きを作る/ }), 'AI のボタンが無い').toHaveCount(0);
    await expect.soft(main(page).getByRole('button', { name: '定型文' }), '保護者へのひとことに「定型文」').toBeVisible();
    await expect.soft(main(page).getByRole('note', { name: '宛先' }), 'ひとことが空の間は宛先を出さない').toHaveCount(0);
    await expect.soft(main(page).getByRole('checkbox', { name: '前回の記録と並べて表示する' })).toBeChecked();
    await expect.soft(main(page).getByText(COMPARE_DISCLAIMER), '免責表示').toBeVisible();
    await expect.soft(main(page).getByText('確定すると、共有する項目のうち『確認できた』ものと、保護者へのひとことが、保護者の成長の記録に届きます。所見・『一部』『未確認』は届きません')).toBeVisible();
    expect.soft(judgementWords(await mainText(page), DEV_JUDGEMENT_WORDS), '判定の言葉').toEqual([]);
    await evidence(page, '05-013');
  });

  test('05-014 区分は実施日の月齢で決まる', async ({ page, playwright }) => {
    // 典拠：要件定義書「年齢・月齢別テンプレート表示」(4-6-2)・「月齢の算出規則」(7-1)、基本設計書「月齢の算出」(4-9)、図/画面詳細図「発達チェック入力画面」(6-2) 項目3・4
    const c = await createChildren(playwright, ['B']);
    await login(page, 'staffSakura');
    await openDevInput(page, c.B.name);
    await setImplDate(page, '2026-02-27');
    await expect.poll(() => categoryLabel(page), { message: '2026-02-27 は5か月（3か月〜の区分）' }).toMatch(/3か月/);
    const items27 = await itemNames(page);
    await setImplDate(page, '2026-02-28');
    await expect.poll(() => categoryLabel(page), { message: '2026-02-28 は6か月（6か月〜の区分）' }).toMatch(/6か月/);
    const items28 = await itemNames(page);
    expect.soft(items28.join('|'), '区分が替わると項目も替わる').not.toBe(items27.join('|'));
    await saveDraft(page);
    await openDevInput(page, c.B.name);
    await expect.soft(implDate(page)).toHaveValue('2026-02-28');
    expect.soft(await categoryLabel(page)).toMatch(/6か月/);
    const ch = checksOf(c.B.id);
    expect.soft(ch[0]?.status).toBe('1');
    expect.soft(ch[0]?.checked_on).toBe('2026-02-28');
    await evidence(page, '05-014');
  });

  test('05-015 未入力と未確認は別の状態', async ({ page, playwright }) => {
    // 典拠：要件定義書「チェック入力」(4-6-2)・「入力状態の定義」(4-6-2)、基本設計書「発達チェック・身体測定」(5-8)、図/画面詳細図「発達チェック入力画面」(6-2) 項目5・12
    const c = await createChildren(playwright, ['B']);
    await login(page, 'staffSakura');
    await draftB(page, c.B);
    await reopenB(page, c.B);
    await setResult(page, 0, '未確認');
    const back = itemGroups(page).nth(0).getByRole('button', { name: '未入力に戻す' }).or(main(page).getByRole('button', { name: '未入力に戻す' }));
    await expect.soft(back.first(), '「未入力に戻す」が出る').toBeVisible();
    await back.first().click();
    expect.soft(await itemGroups(page).nth(0).getByRole('radio', { checked: true }).count(), '項目1 は未入力に戻る').toBe(0);
    await setResult(page, 1, '未確認');
    await setResult(page, 2, '一部');
    await setResult(page, 3, '確認できた');
    await saveDraft(page);
    await reopenB(page, c.B);
    expect.soft(await itemGroups(page).nth(0).getByRole('radio', { checked: true }).count()).toBe(0);
    await expect.soft(itemGroups(page).nth(1).getByRole('radio', { name: '未確認' })).toBeChecked();
    await expect.soft(itemGroups(page).nth(2).getByRole('radio', { name: '一部' })).toBeChecked();
    await expect.soft(itemGroups(page).nth(3).getByRole('radio', { name: '確認できた' })).toBeChecked();
    const names = await itemNames(page);
    const res = resultsOf(checksOf(c.B.id)[0]?.development_check_id ?? 0);
    expect.soft(res.find((r) => r.item_name === names[0]), '項目1 の行が無い').toBeUndefined();
    expect.soft(res.find((r) => r.item_name === names[1])?.result).toBe('3');
    expect.soft(res.find((r) => r.item_name === names[2])?.result).toBe('2');
    expect.soft(res.find((r) => r.item_name === names[3])?.result).toBe('1');
    await evidence(page, '05-015');
  });

  test('05-016 定型文で書く', async ({ page, browser, playwright }) => {
    // 典拠：基本設計書「保護者へのひとこと」(4-9)・「共通の処理」(4-2) の送る時点の守り、図/画面詳細図「発達チェック入力画面」(6-2) 項目14・15、「共通のダイアログと部品」(1-3) の (1)・(5)
    test.setTimeout(120_000);
    const c = await createChildren(playwright, ['B']);
    const api = await apiAs(playwright, 'admin');
    await addPhrase(api, '05-016 きょうも元気に遊びました'); // 【定型文】
    await api.dispose();
    const g = await family(browser, playwright, c.B, 'B');
    await login(page, 'staffSakura');
    await draftB(page, c.B);
    await reopenB(page, c.B);
    await messageBox(page).fill('05-016 ');
    const phrase = main(page).getByRole('button', { name: '定型文' });
    await expect.soft(phrase, '「定型文」のボタン').toBeVisible();
    if (await phrase.count()) {
      await phrase.click();
      const pick = page.getByRole('dialog').getByRole('button', { name: '05-016 きょうも元気に遊びました' });
      await expect.soft(pick).toBeVisible();
      if (await pick.count()) {
        await pick.click();
        await expect.soft(messageBox(page), '末尾へ足す').toHaveValue('05-016 05-016 きょうも元気に遊びました');
      }
    }
    const recipient = main(page).getByRole('note', { name: '宛先' }).or(main(page).getByText(/宛先/).locator('..'));
    await expect.soft(recipient.first(), '宛先の表示').toContainText(c.B.name);
    await expect.soft(recipient.first()).toContainText('父に届きます');
    await evidence(page, '05-016');
    await g.context.close();
  });

  test('05-017 他児の名前の注意（直す）', async ({ page, playwright }) => {
    // 典拠：要件定義書「保護者へ届けるときの関所」(4-1-6) の (2)、基本設計書「共通の処理」(4-2) の送る時点の守り・「メッセージ一覧」(4-12)、図/画面詳細図「共通のダイアログと部品」(1-3) の (3)
    const c = await createChildren(playwright, ['A', 'B']);
    await login(page, 'staffSakura');
    await draftB15(page, c.B);
    await reopenB(page, c.B);
    await reapplyB15(page); // 開き直すと結果が戻らない（05-015）ため、05-015 の状態を入れ直す
    await messageBox(page).fill('05-017 あさひくんと砂場で遊びました');
    const r = await finalize(page, { acceptNames: false });
    expect.soft(r, '他児の名前の注意が出る').toBe('names');
    if (r === 'names') {
      const dlg = nameCheckDialog(page);
      await expect.soft(dlg).toContainText(/ほかのお子さんの名前（.*(受入 あさひ|あさひ).*）が入っています。このまま送りますか。/);
      await expect.soft(dlg.locator('mark, strong, b').filter({ hasText: 'あさひ' }).first(), '当たった語の強調').toBeVisible();
      await evidence(page, '05-017');
      await dlg.getByRole('button', { name: '直す' }).click();
      await expect(dlg).toBeHidden();
      await expect.soft(messageBox(page)).toHaveValue('05-017 あさひくんと砂場で遊びました');
      await expect.soft(itemGroups(page).nth(3).getByRole('radio', { name: '確認できた' })).toBeChecked();
    } else {
      await evidence(page, '05-017');
    }
    expect.soft(checksOf(c.B.id).every((x) => x.status === '1'), '確定されない').toBe(true);
  });

  test('05-018 他児の名前を承知して確定する', async ({ page, browser, playwright }) => {
    // 典拠：授業の雛形 1.5（クロスサイトスクリプティング対策）、要件定義書「保護者への共有と成長の記録」(4-6-5)、基本設計書「成長の記録の閲覧（保護者）」(4-9)、
    //       図/画面詳細図「共通のダイアログと部品」(1-3) の (3)、「成長の記録画面（保護者・スマートフォン）」(6-6) 項目7・9、詳細設計書「成長の記録画面（保護者）」(2-11 (3))
    test.setTimeout(150_000);
    const T = jstToday();
    const c = await createChildren(playwright, ['A', 'B']);
    const g = await family(browser, playwright, c.B, 'B');
    await openGrowthFromHome(g.page, c.B.name);
    const dialogs = watchDialogs(page, g.page);
    await login(page, 'staffSakura');
    const names = await draftB15(page, c.B);
    await reopenB(page, c.B);
    await reapplyB15(page); // 開き直すと結果が戻らない（05-015）ため、05-015 の状態を入れ直す
    const xss = '05-018 <b>あさひくん</b>と<script>alert(1)</script>"><img src=x onerror=alert(1)>遊びました';
    await messageBox(page).fill(xss);
    const r = await finalize(page, { acceptNames: false });
    expect.soft(r, '他児の名前の注意が出る').toBe('names');
    if (r === 'names') {
      const dlg = nameCheckDialog(page);
      await expect.soft(dlg, 'タグが文字のまま').toContainText('<script>alert(1)</script>');
      await expect.soft(dlg.locator('img')).toHaveCount(0);
      await dlg.getByRole('button', { name: 'このまま送る' }).click();
    }
    const t = toast(page, /確定しました/);
    await expect(t).toBeVisible();
    await expect.soft(t).toHaveText(/確定しました。保護者が見られる状態です。/);
    const item = achievementItems(g.page).first();
    await expect(item, '読み込み直さずに届く').toContainText('発達チェック', { timeout: 10_000 });
    await expect.soft(item, '日付は確定した日').toContainText(md(T));
    await expect.soft(item).not.toContainText('2月28日');
    await expect.soft(item).toContainText(names[3]);
    for (const i of [0, 1, 2]) await expect.soft(item, `項目${i + 1} の名前は出ない`).not.toContainText(names[i]);
    await expect.soft(item, '「先生から」に文字のまま').toContainText(xss);
    await expect.soft(item.locator('img')).toHaveCount(0);
    await expect.soft(item.locator('b')).toHaveCount(0);
    await expect.soft(item).toContainText('きょう');
    expect.soft(dialogs, 'スクリプトが動かない').toEqual([]);
    await evidence(g.page, '05-018');
    await g.page.goto('/guardian');
    await expect.soft(homeRegion(g.page, c.B.name)).toContainText('新しい記録があります');
    const ch = checksOf(c.B.id).filter((x) => x.status === '2').pop() ?? checksOf(c.B.id).pop();
    expect.soft(ch?.status).toBe('2');
    expect.soft(ch?.finalized_at ?? '').toMatch(new RegExp(`^${T}`));
    expect.soft(ch?.guardian_message).toBe(xss);
    await g.context.close();
  });

  test('05-019 過去記録との比較', async ({ page, playwright }) => {
    // 典拠：要件定義書「過去記録との比較」(4-6-2)、基本設計書「発達チェックの実施」(4-9) の処理 9・「メッセージ一覧」(4-12) の免責表示、図/画面詳細図「発達チェック入力画面」(6-2) 項目7〜9
    const T = jstToday();
    const c = await createChildren(playwright, ['E']);
    const prev = w2PreviousCheck(c.E); // 【SQL】(W2)
    await login(page, 'staffSakura');
    await openDevInput(page, c.E.name);
    await expect.soft(implDate(page), '新しい記録が開く').toHaveValue(T);
    if ((await implDate(page).inputValue()) !== T) test.skip(true, '「入力」で W2 の確定した記録が開いた（実施済みの記録も「入力」から開く。U-01）ため、比較の部分を回せない');
    expect.soft(await main(page).getByRole('radio', { checked: true }).count(), 'すべて未入力').toBe(0);
    const t0 = await mainText(page);
    expect.soft(t0, '前回の実施日').toContain(slash(prev.checkedOn));
    expect.soft(t0, '前回の月齢').toMatch(monthsRe(prev.months));
    const names = await itemNames(page);
    const row = (i: number) => itemGroups(page).nth(i).locator('xpath=..');
    expect.soft(await row(0).innerText(), '項目ごとの前回の結果').toContain('確認できた');
    const before1 = (await row(1).innerText()).replace(/\s+/g, ' ');
    const before0 = (await row(0).innerText()).replace(/\s+/g, ' ');
    await setResult(page, 0, '未確認');
    for (let i = 1; i < names.length; i++) await setResult(page, i, '確認できた');
    const after0 = (await row(0).innerText()).replace(/\s+/g, ' ');
    const after1 = (await row(1).innerText()).replace(/\s+/g, ' ');
    expect.soft(after0, '項目1 に前回から変わったことの表示').not.toBe(before0);
    expect.soft(after1, 'ほかの項目には出ない').toBe(before1);
    expect.soft(judgementWords(await mainText(page), DEV_JUDGEMENT_WORDS), '判定の言葉').toEqual([]);
    await expect.soft(main(page).getByText(COMPARE_DISCLAIMER), '免責表示').toBeVisible();
    await evidence(page, '05-019');
    const toggle = main(page).getByRole('checkbox', { name: '前回の記録と並べて表示する' });
    await toggle.uncheck();
    expect.soft(await mainText(page), '外すと前回の記録が消える').not.toContain(slash(prev.checkedOn));
    await toggle.check();
    expect.soft(await mainText(page), '入れると戻る').toContain(slash(prev.checkedOn));
  });

  test('05-020 確定の二重送信', async ({ page, playwright }) => {
    // 典拠：授業の雛形 1.5（二重送信の防止）、基本設計書「発達チェックの実施」(4-9)、詳細設計書「本書で足す文言」(4-1 (6))
    const T = jstToday();
    const c = await createChildren(playwright, ['F']);
    await login(page, 'admin');
    await openDevInput(page, c.F.name);
    await setAll(page, '未確認');
    await finalizeButton(page).dblclick();
    const t = toast(page, /確定しました/);
    await expect(t).toBeVisible();
    await expect.soft(t, '届くものが無い').toHaveText(/^確定しました。\s*(閉じる)?$/);
    expect.soft(checksOf(c.F.id).length, '1件だけ').toBe(1);
    const first = checksOf(c.F.id)[0]?.finalized_at;
    await page.reload();
    await page.goto('/staff/growth');
    expect.soft(checksOf(c.F.id).length, '再読み込みしても増えない').toBe(1);
    expect.soft(checksOf(c.F.id)[0]?.status).toBe('2');
    expect.soft(checksOf(c.F.id)[0]?.finalized_at).toBe(first);
    expect.soft(await devCell(page, c.F.name, '前回の実施日')).toContain(slash(T));
    expect.soft(await devCell(page, c.F.name, '状態')).not.toMatch(/未実施/);
    expect.soft(await devCell(page, c.F.name, '項目の漏れ'), '項目の漏れは 0').toMatch(/^(|0|0\s*件|項目の漏れ\s*0\s*件|―)$/);
    await evidence(page, '05-020');
  });

  // ---------------------------------------------------------------- 身体記録

  test('05-021 身体記録画面の構成', async ({ page, playwright }) => {
    // 典拠：基本設計書「身体測定の記録」(4-9) の処理 1・2・「成長曲線基準値（m_growth_standard）」(5-8)、図/画面詳細図「身体記録画面」(6-4) 項目1〜13・15 と注記
    const T = jstToday();
    const c = await createChildren(playwright, ['B']);
    await login(page, 'staffSakura');
    await page.goto('/staff');
    await main(page).getByRole('link', { name: '身体測定を入力' }).or(main(page).getByRole('button', { name: '身体測定を入力' })).first().click();
    await expect(page.getByRole('heading', { name: '身体記録', level: 1 })).toBeVisible();
    const opts = (await main(page).getByRole('combobox', { name: 'クラス' }).locator('option').allInnerTexts()).map((s) => s.trim());
    expect.soft(opts, 'さくら組だけ').toEqual(['さくら組']);
    await expect.soft(physDate(page)).toHaveValue(T);
    expect.soft(await physDate(page).getAttribute('max'), '明日より後を選べない').toBe(T);
    const t = await mainText(page);
    expect.soft(t).toMatch(/対象\s*\d+\s*名/);
    expect.soft(t).toMatch(/記録済み\s*\d+\s*名/);
    expect.soft(t).toMatch(/未実施\s*\d+\s*名/);
    expect.soft(await unrecordedLine(page), '未実施の園児名').toContain(c.B.name);
    await selectPhysChild(page, c.B.name);
    await expect.soft(childHeading(page)).toContainText(monthsRe(ageInMonths(c.B.birth, T)));
    await expect.soft(heightBox(page)).toHaveValue('');
    await expect.soft(weightBox(page)).toHaveValue('');
    await expect.soft(main(page).getByText('登録すると、保護者の成長の記録に届きます')).toBeVisible();
    await expect.soft(main(page).getByText(GROWTH_DISCLAIMER), '免責表示').toBeVisible();
    expect.soft(await mainText(page), '出典').toMatch(/厚生労働省「平成22年乳幼児身体発育調査」/);
    expect.soft(await mainText(page), '2歳以上は補間').toMatch(/2歳以上[^。]*補間/);
    await expect.soft(main(page).getByRole('button', { name: 'PDF出力' }), '一般に PDF出力は出ない').toHaveCount(0);
    await evidence(page, '05-021');
    // 過去の記録の列は、記録のある園児（デモの西田 太郎）で見る（児B はまだ記録が無く、表が出ない）
    await selectPhysChild(page, '西田 太郎');
    const h = await headers(page);
    for (const col of ['測定日', '月齢', '身長', '体重', '記録者']) expect.soft(h.some((x) => x.startsWith(col)), `列「${col}」`).toBe(true);
  });

  test('05-022 登録', async ({ page, browser, playwright }) => {
    // 典拠：要件定義書「身体測定の記録」(4-6-4)・「成長の記録への引き渡し」(4-6-5)、基本設計書「身体測定の記録」(4-9) の処理 3〜5、図/画面詳細図「身体記録画面」(6-4) 項目3・4・9・11・15、
    //       「成長の記録画面（保護者・スマートフォン）」(6-6) 項目6・9、詳細設計書「職員の画面から成長の記録へ届けるもの」(2-12 (3))・「知らせの種類と送り先」(6-2)
    test.setTimeout(120_000);
    const T = jstToday();
    const c = await createChildren(playwright, ['B']);
    const g = await family(browser, playwright, c.B, 'B');
    await openGrowthFromHome(g.page, c.B.name);
    await login(page, 'staffSakura');
    await openPhysical(page);
    const t0 = await mainText(page);
    const done0 = Number(/記録済み\s*(\d+)\s*名/.exec(t0)?.[1] ?? NaN);
    const left0 = Number(/未実施\s*(\d+)\s*名/.exec(t0)?.[1] ?? NaN);
    const log0 = lastOpLogId();
    await selectPhysChild(page, c.B.name);
    await fillMeasure(page, '75.0', '9.50');
    await clickAndWait(page, registerButton(page), '/api/physical/records');
    await expect.soft(page.getByRole('dialog'), '確認の画面を挟まない').toHaveCount(0);
    await expect.soft(toast(page, /登録しました/)).toHaveText(/登録しました。保護者が見られる状態です。/);
    await expect.soft(physChild(page, c.B.name)).toHaveAccessibleName(/^\[x\]/);
    const t1 = await mainText(page);
    expect.soft(Number(/記録済み\s*(\d+)\s*名/.exec(t1)?.[1] ?? NaN)).toBe(done0 + 1);
    expect.soft(Number(/未実施\s*(\d+)\s*名/.exec(t1)?.[1] ?? NaN)).toBe(left0 - 1);
    await sexp.poll(() => unrecordedLine(page)).not.toContain(c.B.name);
    await expect.soft(childHeading(page), '未実施の次の園児へ移る').not.toContainText(c.B.name);
    await selectPhysChild(page, c.B.name);
    const hrow = historyRow(page, T);
    await expect.soft(hrow).toContainText(monthsRe(ageInMonths(c.B.birth, T)));
    await expect.soft(hrow).toContainText('75');
    await expect.soft(hrow).toContainText('9.5');
    await expect.soft(hrow).toContainText('鈴木 浩之');
    const grow = growthBody(g.page).getByRole('row').filter({ hasText: md(T) });
    await expect(grow, '保護者に読み込み直さずに届く').toBeVisible({ timeout: 10_000 });
    await expect.soft(grow).toContainText('75.0cm');
    await expect.soft(grow).toContainText('9.50kg');
    await expect.soft(grow).toContainText('きょう');
    await evidence(g.page, '05-022');
    await g.page.goto('/guardian');
    await expect.soft(homeRegion(g.page, c.B.name)).toContainText('新しい記録があります');
    const p = physicalOf(c.B.id);
    expect.soft(p.length).toBe(1);
    expect.soft(p[0]?.measured_on).toBe(T);
    expect.soft(p[0]?.height_cm).toBe(75);
    expect.soft(p[0]?.weight_kg).toBe(9.5);
    expect.soft(p[0]?.is_deleted).toBe(0);
    expect.soft(opLogsSince(log0).some((l) => l.function_type === '5' && l.operation_type === '1'), '操作ログ 5・1').toBe(true);
    await g.context.close();
  });

  test('05-023 月齢は測定日の時点', async ({ page, browser, playwright }) => {
    // 典拠：要件定義書「月齢の算出規則」(7-1)・「品質要求一覧」(7-1 No.6)、基本設計書「月齢の算出」(4-9)、図/画面詳細図「身体記録画面」(6-4) 項目5・7・8・11
    test.setTimeout(120_000);
    const c = await createChildren(playwright, ['A', 'B']);
    await login(page, 'staffSakura');
    await openPhysical(page);
    await registerPhysical(page, c.B.name, '2026-02-27', '65.0', '7.00');
    await setPhysDate(page, '2026-02-28');
    await selectPhysChild(page, c.B.name);
    await sexp.poll(() => mainText(page), { message: '前回値に1つ目の値' }).toMatch(/前回\s*65/);
    await registerPhysical(page, c.B.name, '2026-02-28', '65.5', '7.10');
    await selectPhysChild(page, c.B.name);
    await expect.soft(historyRow(page, '2026-02-27'), '2026-02-27 は5か月').toContainText(monthsRe(5));
    await expect.soft(historyRow(page, '2026-02-28'), '2026-02-28 は6か月').toContainText(monthsRe(6));
    expect.soft(judgementWords(await mainText(page), BODY_JUDGEMENT_WORDS)).toEqual([]);
    await evidence(page, '05-023');
    const k = await loginIn(browser, 'staffHimawari');
    await openPhysical(k.page);
    await registerPhysical(k.page, c.A.name, '2026-05-19', '85.0', '11.50');
    await registerPhysical(k.page, c.A.name, '2026-05-20', '85.1', '11.52');
    await selectPhysChild(k.page, c.A.name);
    await expect.soft(historyRow(k.page, '2026-05-19'), '2026-05-19 は23か月').toContainText(monthsRe(23));
    await expect.soft(historyRow(k.page, '2026-05-20'), '2026-05-20 は24か月').toContainText(monthsRe(24));
    await expect.soft(historyRow(k.page, '2026-05-20'), '体重は丸めない').toContainText('11.52');
    const w = (id: string) => physicalOf(id).map((r) => r.weight_kg);
    expect.soft(w(c.B.id)).toEqual([7, 7.1]);
    expect.soft(w(c.A.id)).toEqual([11.5, 11.52]);
    await k.context.close();
  });

  test('05-024 範囲外と上書きの確認は別々', async ({ page, playwright }) => {
    // 典拠：要件定義書「機能間・画面間のインタフェース」(4-7-2) の 4、基本設計書「身体測定の記録」(4-9) の処理 4・「メッセージ一覧」(4-12)・「身体測定記録（t_physical_record）」(5-8)
    const T = jstToday();
    const c = await createChildren(playwright, ['B']);
    await login(page, 'staffSakura');
    await openPhysical(page);
    await registerPhysical(page, c.B.name, '2026-02-28', '65.5', '7.10');
    // 1回目：範囲外の確認を承諾し、上書きの確認で「やめる」
    await selectPhysChild(page, c.B.name);
    await fillMeasure(page, '150.0', '7.10');
    await registerButton(page).click();
    const again = main(page).getByRole('button', { name: 'このまま登録する' });
    const ow = page.getByRole('dialog', { name: /上書き/ });
    await expect(again.or(ow)).toBeVisible();
    const rangeFirst = await again.isVisible();
    if (rangeFirst) {
      expect.soft(await mainText(page), '範囲外の文言').toContain('入力値が通常の範囲外です。測定値に誤りがないか確認してください。');
      await again.click();
    }
    await expect(ow, '範囲外を承諾しても上書きの確認は飛ばされない').toBeVisible();
    await expect.soft(ow).toContainText('この測定日の記録は登録済みです。上書きしますか。');
    await evidence(page, '05-024');
    await ow.getByRole('button', { name: 'やめる' }).click();
    await expect(ow).toBeHidden();
    await page.waitForTimeout(500);
    expect.soft(physicalOf(c.B.id).find((r) => r.measured_on === '2026-02-28')?.height_cm, '「やめる」で保存されない').toBe(65.5);
    // 2回目：両方を承諾する（上書きが先に出たときは、上書きを承諾しても範囲外が飛ばされないことを見る）
    await registerButton(page).click();
    const s2 = await answerPhysicalChecks(page);
    expect.soft(rangeFirst || s2.range, '範囲外の確認が出る').toBe(true);
    expect.soft(s2.overwrite, '2回目も上書きの確認が出る').toBe(true);
    await expect(toast(page, /登録しました/)).toBeVisible();
    const rows = physicalOf(c.B.id).filter((r) => r.measured_on === '2026-02-28' && Number(r.is_deleted) === 0);
    expect.soft(rows.length).toBe(1);
    expect.soft(rows[0]?.height_cm).toBe(150);
    expect.soft(rows[0]?.staff_id).toBe(sqlAll<{ staff_id: string }>("SELECT staff_id FROM m_staff WHERE staff_name = '鈴木 浩之'")[0]?.staff_id);
    expect.soft(rows[0]?.updated_at ?? '').toMatch(new RegExp(`^${T}`));
  });

  test('05-025 上書きが保護者に届く', async ({ page, browser, playwright }) => {
    // 典拠：要件定義書「成長グラフ表示」(4-6-4)・「品質要求一覧」(7-1 No.5)、基本設計書「成長グラフの表示」(4-9)・「入力項目の制約値」(4-12)、
    //       図/画面詳細図「成長の記録画面（保護者・スマートフォン）」(6-6) 項目6・9、詳細設計書「成長の記録画面（保護者）」(2-11 (3))・「成長の記録に届くもの」(3-7)
    test.setTimeout(150_000);
    const T = jstToday();
    const c = await createChildren(playwright, ['B']);
    const g = await family(browser, playwright, c.B, 'B');
    await login(page, 'staffSakura');
    await openPhysical(page);
    await registerPhysical(page, c.B.name, T, '75.0', '9.50');
    await registerPhysical(page, c.B.name, '2026-02-27', '65.0', '7.00');
    await registerPhysical(page, c.B.name, '2026-02-28', '65.5', '7.10');
    await openGrowthFromHome(g.page, c.B.name);
    await registerPhysical(page, c.B.name, '2026-02-28', '150.0', '7.10');
    const row = growthBody(g.page).getByRole('row').filter({ hasText: md('2026-02-28') });
    await expect(row, '読み込み直さずに届く').toContainText('150.0cm', { timeout: 10_000 });
    await expect.soft(row).toContainText('7.10kg');
    await expect.soft(row).toContainText('きょう');
    const dates = (await growthBody(g.page).getByRole('row').allInnerTexts()).slice(1).map((s) => s.replace(/\s+/g, ' '));
    expect.soft(dates.map((d) => /^(\d+月\d+日)/.exec(d)?.[1] ?? d), '新しい順').toEqual([md(T), md('2026-02-28'), md('2026-02-27')]);
    expect.soft(judgementWords((await growthBody(g.page).innerText()).replace(/\s+/g, ' '), BODY_JUDGEMENT_WORDS)).toEqual([]);
    const color = async (needle: string) => growthBody(g.page).getByRole('row').filter({ hasText: needle }).first().evaluate((el) => getComputedStyle(el).color + '|' + getComputedStyle(el).backgroundColor);
    expect.soft(await color('150.0cm'), '範囲外の行も同じ見た目').toBe(await color('75.0cm'));
    await evidence(g.page, '05-025');
    await selectPhysChild(page, c.B.name);
    expect.soft(judgementWords(await mainText(page), BODY_JUDGEMENT_WORDS)).toEqual([]);
    await g.context.close();
  });

  test('05-026 実施状況は年月で数える', async ({ page, playwright }) => {
    // 典拠：要件定義書「身体測定の実施状況の確認」(4-6-4)・「測定回の単位」(4-6-4)、基本設計書「身体測定の記録」(4-9) の処理 1、図/画面詳細図「身体記録画面」(6-4) 項目2〜4
    const T = jstToday();
    const c = await createChildren(playwright, ['B']);
    await login(page, 'staffSakura');
    await openPhysical(page);
    await registerPhysical(page, c.B.name, T, '75.0', '9.50');
    const first = `${T.slice(0, 8)}01`;
    if (first !== T) {
      await setPhysDate(page, first);
      await expect.soft(physChild(page, c.B.name), '同じ年月の別の日でも [x]').toHaveAccessibleName(/^\[x\]/);
      await sexp.poll(() => unrecordedLine(page), { message: '同じ年月の別の日なら未実施に出ない' }).not.toContain(c.B.name);
    }
    const prevMonth = addMonths(first, -1);
    await setPhysDate(page, prevMonth);
    await expect.soft(physChild(page, c.B.name), '前月は [x] が外れる').toHaveAccessibleName(/^\[ ?\]/);
    await sexp.poll(() => unrecordedLine(page), { message: '前月は未実施に出る' }).toContain(c.B.name);
    await evidence(page, '05-026');
  });

  test('05-027 性別が未回答なら帯を描かない', async ({ page, playwright }) => {
    // 典拠：授業の雛形 1.5（二重送信の防止）、要件定義書「成長グラフ表示」(4-6-4)、基本設計書「成長グラフの表示」(4-9) の縮退動作、図/画面詳細図「身体記録画面」(6-4) 項目10
    const T = jstToday();
    const c = await createChildren(playwright, ['F']);
    await login(page, 'admin');
    await openPhysical(page, 'もも組');
    await selectPhysChild(page, c.F.name);
    await fillMeasure(page, '65.0', '7.00');
    await registerButton(page).dblclick();
    await answerPhysicalChecks(page, { acceptOverwrite: false });
    await page.waitForTimeout(1000);
    expect.soft(physicalOf(c.F.id).filter((r) => Number(r.is_deleted) === 0).length, '1件だけ').toBe(1);
    await selectPhysChild(page, c.F.name);
    await expect.soft(main(page).getByText('性別が未回答のため成長曲線を表示できません')).toBeVisible();
    await expect.soft(historyRow(page, T)).toBeVisible();
    await evidence(page, '05-027');
  });

  test('05-028 PDF出力', async ({ page, playwright }) => {
    // 典拠：要件定義書「発達記録のPDF出力」(4-6-5)、基本設計書「記録の出力」(4-9)・「権限と利用可能機能」(6-1)、図/画面詳細図「身体記録画面」(6-4) 項目13 と注記
    const c = await createChildren(playwright, ['A']);
    await login(page, 'admin');
    await openPhysical(page, 'ひまわり組');
    await registerPhysical(page, c.A.name, '2026-05-19', '85.0', '11.50');
    await selectPhysChild(page, c.A.name);
    const log0 = lastOpLogId();
    await main(page).getByRole('button', { name: 'PDF出力' }).click();
    const dlg = page.getByRole('dialog', { name: /PDF/ });
    await expect(dlg).toBeVisible();
    expect.soft(await dlg.getByRole('radio', { checked: true }).count(), '既定値が無い').toBe(0);
    await expect.soft(dlg.getByRole('radio', { name: '園内利用' })).toBeVisible();
    await expect.soft(dlg.getByRole('radio', { name: '保護者引き渡し' })).toBeVisible();
    const out = dlg.getByRole('button', { name: /出力/ });
    await expect.soft(out, '選ぶまで出力できない').toBeDisabled();
    await dlg.getByRole('radio', { name: '園内利用' }).check();
    await evidence(page, '05-028');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), out.click()]);
    const file = await dl.path();
    const head = file ? readFileSync(file).subarray(0, 4).toString('latin1') : '';
    expect.soft(head, 'PDF のファイル').toBe('%PDF');
    const logs = opLogsSince(log0);
    expect.soft(logs.some((l) => l.operation_type === '5' && l.target_child_id === c.A.id), '操作ログ operation_type＝5').toBe(true);
  });

  // ---------------------------------------------------------------- 保護者A（児A）

  /** 児A の身体測定を 05-023 のとおりに入れる（一般K） */
  async function physA(page: Page, a: ChildSpec) {
    await openPhysical(page);
    await registerPhysical(page, a.name, '2026-05-19', '85.0', '11.50');
    await registerPhysical(page, a.name, '2026-05-20', '85.1', '11.52');
  }

  test('05-029 後から登録した保護者も前の記録を読める', async ({ page, browser, playwright }) => {
    // 典拠：要件定義書「成長の記録の閲覧」(4-6-5)、基本設計書「成長の記録の閲覧（保護者）」(4-9)・「画面基本構成」(3-5)、図/画面詳細図「成長の記録画面（保護者・スマートフォン）」(6-6) 項目1・2・4〜6・12、
    //       「保護者ホーム」(2-7) 項目7・9、図/画面遷移図「保護者の画面」(9)
    test.setTimeout(120_000);
    const c = await createChildren(playwright, ['A']);
    await login(page, 'staffHimawari');
    await physA(page, c.A);
    const g = await family(browser, playwright, c.A, 'A');
    const region = homeRegion(g.page, c.A.name);
    await expect.soft(region).toContainText('新しい記録があります');
    await openGrowthFromHome(g.page, c.A.name);
    await expect.soft(g.page.getByRole('main').getByRole('img', { name: /顔/ }), '顔写真は出ない').toHaveCount(0);
    await expect.soft(g.page.getByRole('main').getByRole('combobox'), '別の園児へ切り替える操作が無い').toHaveCount(0);
    const rows = (await growthBody(g.page).getByRole('row').allInnerTexts()).slice(1).map((s) => s.replace(/\s+/g, ' '));
    expect.soft(rows[0] ?? '').toMatch(new RegExp(`${md('2026-05-20')}.*85\\.1cm.*11\\.52kg`));
    expect.soft(rows[1] ?? '').toMatch(new RegExp(`${md('2026-05-19')}.*85\\.0cm.*11\\.50kg`));
    expect.soft(judgementWords((await g.page.getByRole('main').innerText()).replace(/\s+/g, ' '), BODY_JUDGEMENT_WORDS)).toEqual([]);
    const disc = g.page.getByText(GROWTH_DISCLAIMER);
    await expect.soft(disc).toBeVisible();
    await g.page.mouse.wheel(0, 2000);
    await expect.soft(disc, 'スクロールしても見える').toBeInViewport();
    await evidence(g.page, '05-029');
    await g.page.getByRole('link', { name: /ホームへ/ }).click();
    await expect.soft(homeRegion(g.page, c.A.name)).toBeVisible();
    await g.page.getByRole('banner').getByRole('button', { name: /メニュー/ }).click();
    await g.page.getByRole('link', { name: /成長の記録$/ }).first().click();
    await expect.soft(g.page.getByRole('heading', { name: `${c.A.name}の成長の記録`, level: 1 })).toBeVisible();
    await g.context.close();
  });

  test('05-030 成長グラフ', async ({ page, browser, playwright }) => {
    // 典拠：要件定義書「成長グラフ表示」(4-6-4)、基本設計書「成長グラフの表示」(4-9)、図/画面詳細図「身体記録画面」(6-4) 項目10・12、「成長の記録画面（保護者・スマートフォン）」(6-6) 項目3・4
    test.setTimeout(120_000);
    const c = await createChildren(playwright, ['A']);
    await login(page, 'staffHimawari');
    await physA(page, c.A);
    await selectPhysChild(page, c.A.name);
    const g = await family(browser, playwright, c.A, 'A');
    await openGrowthFromHome(g.page, c.A.name);
    for (const p of [page, g.page]) {
      const scope = p === page ? main(page) : growthBody(g.page);
      await expect.soft(scope.getByRole('img', { name: /身長の推移/ })).toBeVisible();
      await expect.soft(scope.getByText('性別が未回答のため成長曲線を表示できません'), '帯を描く（性別 男）').toHaveCount(0);
      await scope.getByRole('button', { name: '体重', exact: true }).click();
      await expect.soft(scope.getByRole('img', { name: /体重の推移/ })).toBeVisible();
      await expect.soft(scope.getByRole('button', { name: '体重', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await scope.getByRole('button', { name: '身長', exact: true }).click();
      await expect.soft(scope.getByRole('img', { name: /身長の推移/ })).toBeVisible();
      expect.soft((await p.getByRole('main').innerText()).replace(/\s+/g, ' '), '出典').toMatch(/平成22年乳幼児身体発育調査[^。]*。?[^。]*2歳以上[^。]*補間/);
      await expect.soft(p.getByText(GROWTH_DISCLAIMER), '免責表示').toBeVisible();
      expect.soft(judgementWords((await p.getByRole('main').innerText()).replace(/\s+/g, ' '), BODY_JUDGEMENT_WORDS)).toEqual([]);
    }
    await evidence(g.page, '05-030');
    await g.context.close();
  });

  test('05-031 下書き保存は保護者に届かない', async ({ page, browser, playwright }) => {
    // 典拠：要件定義書「成長の記録への引き渡し」(4-6-5)、基本設計書「成長の記録の閲覧（保護者）」(4-9)、図/画面詳細図「発達チェック入力画面」(6-2) 項目14・15、詳細設計書「知らせの種類と送り先」(6-2)
    test.setTimeout(150_000);
    const c = await createChildren(playwright, ['A']);
    const g = await family(browser, playwright, c.A, 'A');
    await openGrowthFromHome(g.page, c.A.name);
    await login(page, 'staffHimawari');
    await openDevInput(page, c.A.name);
    await setImplDate(page, A_CHECK_DATE);
    const names = await itemNames(page);
    await setResult(page, 0, '確認できた');
    await setResult(page, 1, '確認できた');
    await messageBox(page).fill('05-031 下書きのひとこと');
    const recipient = main(page).getByRole('note', { name: '宛先' });
    await expect.soft(recipient, '宛先の表示').toContainText(c.A.name);
    await expect.soft(recipient).toContainText('母に届きます');
    await draftButton(page).click();
    await expect.soft(toast(page, '下書きを保存しました。保護者には届いていません。')).toBeVisible();
    await g.page.waitForTimeout(35_000);
    await expect.soft(achievements(g.page), '開いた窓に届かない').not.toContainText('05-031 下書きのひとこと');
    await g.page.reload();
    await expect.soft(achievements(g.page), '再読み込みしても届かない').not.toContainText('05-031 下書きのひとこと');
    for (const n of names.slice(0, 2)) await expect.soft(achievements(g.page)).not.toContainText(n);
    await evidence(g.page, '05-031');
    const ch = checksOf(c.A.id)[0];
    expect.soft(ch?.status).toBe('1');
    expect.soft(ch?.guardian_message).toBe('05-031 下書きのひとこと');
    expect.soft(ch?.finalized_at ?? null).toBeNull();
    await g.context.close();
  });

  test('05-032 確定で確認できたとひとことだけが届く', async ({ page, browser, playwright }) => {
    // 典拠：要件定義書「保護者への共有と成長の記録」(4-6-5)・「入力状態の定義」(4-6-2)・「品質要求一覧」(7-1 No.10)、基本設計書「発達チェック・身体測定・成長の記録」(4-9) の冒頭の表・
    //       「成長の記録の閲覧（保護者）」(4-9)、図/画面詳細図「成長の記録画面（保護者・スマートフォン）」(6-6) 項目7・9、詳細設計書「成長の記録」(4-12 (1))
    test.setTimeout(150_000);
    const T = jstToday();
    const c = await createChildren(playwright, ['A']);
    const g = await family(browser, playwright, c.A, 'A');
    await openGrowthFromHome(g.page, c.A.name);
    await login(page, 'staffHimawari');
    await openDevInput(page, c.A.name);
    await setImplDate(page, A_CHECK_DATE);
    const names = await itemNames(page);
    await setResult(page, 0, '確認できた');
    await setResult(page, 1, '確認できた');
    await messageBox(page).fill('05-031 下書きのひとこと');
    await saveDraft(page);
    await openDevInput(page, c.A.name);
    // 開き直すと実施日と結果が戻らない（05-014・05-015）ため、05-031 の状態を入れ直す
    if ((await implDate(page).inputValue()) !== A_CHECK_DATE) await setImplDate(page, A_CHECK_DATE);
    await setResult(page, 0, '確認できた');
    await setResult(page, 1, '確認できた');
    const log0 = lastOpLogId();
    await setResult(page, 2, '一部');
    await setResult(page, 3, '未確認');
    await noteBox(page).fill('05-032 所見は園内に留める');
    await messageBox(page).fill('05-032 砂場でお山を作りました');
    expect(await finalize(page)).toBe('done');
    const t = toast(page, /確定しました/);
    await expect.soft(t).toHaveText(/確定しました。保護者が見られる状態です。/);
    await expect.soft(t.getByRole('button', { name: '取り消す' })).toHaveCount(0);
    const item = achievementItems(g.page).first();
    await expect(item, '読み込み直さずに届く').toContainText('05-032 砂場でお山を作りました', { timeout: 10_000 });
    await expect.soft(item).toContainText('発達チェック');
    await expect.soft(item).toContainText(md(T));
    await expect.soft(item).toContainText(names[0]);
    await expect.soft(item).toContainText(names[1]);
    for (const n of names.slice(2)) await expect.soft(item, `${n} は出ない`).not.toContainText(n);
    const whole = (await g.page.getByRole('main').innerText()).replace(/\s+/g, ' ');
    expect.soft(whole, '所見は出ない').not.toContain('05-032 所見は園内に留める');
    expect.soft(whole).not.toMatch(/一部|未確認/);
    expect.soft(whole, '記録した職員の名前は出ない').not.toContain('久保田 和也');
    await expect.soft(item).toContainText('きょう');
    await evidence(g.page, '05-032');
    await g.page.goto('/guardian');
    await expect.soft(homeRegion(g.page, c.A.name)).toContainText('新しい記録があります');
    const ch = checksOf(c.A.id)[0];
    expect.soft(ch?.status).toBe('2');
    expect.soft(ch?.finalized_at ?? '').toMatch(new RegExp(`^${T}`));
    expect.soft(ch?.note).toBe('05-032 所見は園内に留める');
    expect.soft(opLogsSince(log0).some((l) => l.function_type === '4'), '操作ログ function_type＝4').toBe(true);
    await g.context.close();
  });

  test('05-033 削除すると成長の記録から消える', async ({ page, browser, playwright }) => {
    // 典拠：基本設計書「身体測定の記録」(4-9)・「身体測定記録（t_physical_record）」(5-8) の一意制約、図/画面詳細図「身体記録画面」(6-4) 項目14、詳細設計書「成長の記録に届くもの」(3-7)
    test.setTimeout(150_000);
    const c = await createChildren(playwright, ['A']);
    const k = await loginIn(browser, 'staffHimawari');
    await physA(k.page, c.A);
    await k.context.close();
    const g = await family(browser, playwright, c.A, 'A');
    await openGrowthFromHome(g.page, c.A.name);
    await login(page, 'admin');
    await openPhysical(page, 'ひまわり組');
    await selectPhysChild(page, c.A.name);
    const log0 = lastOpLogId();
    const del = historyRow(page, '2026-05-19').getByRole('button', { name: /削除/ });
    await expect(del, '過去の記録の行に「削除」').toBeVisible();
    await del.click();
    const dlg = page.getByRole('dialog');
    await expect(dlg, '削除の前に確認ダイアログ').toBeVisible();
    await dlg.getByRole('button', { name: /削除/ }).last().click();
    await expect.soft(historyRow(page, '2026-05-19')).toHaveCount(0);
    await expect.soft(growthBody(g.page).getByRole('row').filter({ hasText: md('2026-05-19') }), '保護者の画面からも消える').toHaveCount(0, { timeout: 10_000 });
    await evidence(g.page, '05-033');
    const s = await registerPhysical(page, c.A.name, '2026-05-19', '85.0', '11.50');
    expect.soft(s.overwrite, '上書きの確認を出さずに登録し直せる').toBe(false);
    const rows = physicalOf(c.A.id).filter((r) => r.measured_on === '2026-05-19');
    expect.soft(rows.map((r) => Number(r.is_deleted))).toEqual([1, 0]);
    expect.soft(opLogsSince(log0).some((l) => l.function_type === '5' && l.operation_type === '4'), '操作ログ 5・4').toBe(true);
    await g.context.close();
  });

  /** 連絡帳（園児）画面（その園児・きょう）を開く */
  async function openContactChild(page: Page, childId: string) {
    await page.goto(`/staff/contact/${childId}`);
    await expect(page.getByRole('complementary', { name: '記録する' })).toBeVisible();
  }

  test('05-034 連絡帳の「成長の記録に残す」', async ({ page, browser, playwright }) => {
    // 典拠：要件定義書「成長の記録に残す」(4-6-5)、基本設計書「成長の記録の閲覧（保護者）」(4-9)、図/画面詳細図「連絡帳（園児）画面」(8-2) 項目8、
    //       詳細設計書「職員の画面から成長の記録へ届けるもの」(2-12 (1))・「成長の記録に届くもの」(3-7)・「成長の記録」(4-12 (3))・「本書で足す文言」(4-1 (6))
    test.setTimeout(150_000);
    const body = '05-034 砂場で山を作りました';
    const c = await createChildren(playwright, ['A']);
    const g = await family(browser, playwright, c.A, 'A');
    await openGrowthFromHome(g.page, c.A.name);
    const gc = await g.context.newPage();
    await login(page, 'staffHimawari');
    await openContactChild(page, c.A.id);
    const side = page.getByRole('complementary', { name: '記録する' });
    await side.getByRole('textbox', { name: '活動のひとこと' }).fill(body);
    const keepInForm = side.getByRole('checkbox', { name: '成長の記録に残す' });
    await expect.soft(keepInForm, 'ひとことの欄の下に「成長の記録に残す」').toBeVisible();
    if (await keepInForm.count()) {
      await expect.soft(keepInForm, '初期値はオフ').not.toBeChecked();
      await keepInForm.check();
    }
    await side.getByRole('button', { name: 'ひとことを送る' }).click();
    await expect.soft(toast(page, /送りました/)).toHaveText(/送りました。保護者が見られる状態です。/);
    const keepInRow = main(page).getByRole('listitem').filter({ hasText: body }).getByRole('checkbox', { name: '成長の記録に残す' });
    if (!(await keepInForm.count())) await toggleKeep(keepInRow, true);
    const entry = achievements(g.page).getByRole('listitem').filter({ hasText: body });
    await expect.soft(entry, '成長の記録に並ぶ').toBeVisible({ timeout: 10_000 });
    await toggleKeep(keepInRow, false);
    await expect.soft(toast(page, '成長の記録から外しました。')).toBeVisible();
    await expect.soft(entry, '外すと消える').toHaveCount(0, { timeout: 10_000 });
    await gc.goto(`/guardian/contact/${c.A.id}`);
    await expect.soft(gc.getByRole('main').getByRole('listitem').filter({ hasText: body })).toBeVisible();
    await expect.soft(gc.getByRole('main').getByRole('listitem').filter({ hasText: body }), '「訂正しました」が付かない').not.toContainText('訂正しました');
    await toggleKeep(keepInRow, true);
    await expect.soft(toast(page, '成長の記録に残しました。')).toBeVisible();
    await expect.soft(entry, '入れ直すとまた並ぶ').toBeVisible({ timeout: 10_000 });
    await evidence(g.page, '05-034');
    const ev = () => sqlAll<{ keep_in_growth: number; corrected_at: string | null; is_deleted: number }>('SELECT keep_in_growth, corrected_at, is_deleted FROM t_contact_event WHERE child_id = ? AND body = ?', c.A.id, body)[0];
    expect.soft(Number(ev()?.keep_in_growth)).toBe(1);
    expect.soft(ev()?.corrected_at ?? null, '訂正の時刻は空のまま').toBeNull();
    await main(page).getByRole('listitem').filter({ hasText: body }).getByRole('button', { name: /を直す・取り消す$/ }).click();
    await page.getByRole('dialog', { name: '記録を直す' }).getByRole('button', { name: 'この記録を取り消す' }).click();
    await page.getByRole('dialog', { name: 'この記録を取り消しますか' }).getByRole('button', { name: '取り消す' }).click();
    await expect.soft(entry, '取り消すと成長の記録から消える').toHaveCount(0, { timeout: 10_000 });
    await gc.reload();
    await expect.soft(gc.getByRole('main').getByRole('listitem').filter({ hasText: body }), '連絡帳からも消える').toHaveCount(0);
    expect.soft(Number(ev()?.is_deleted)).toBe(1);
    await g.context.close();
  });

  test('05-035 さらに読み込む', async ({ page, browser, playwright }) => {
    // 典拠：基本設計書「一覧表示とページング」(3-7)・「設定マスタ（m_setting）」(5-9) の paging.physical_history_count、図/画面詳細図「成長の記録画面（保護者・スマートフォン）」(6-6) 項目7・8、
    //       詳細設計書「成長の記録画面（保護者）」(2-11 (2))・「成長の記録」(4-12 (1))
    test.setTimeout(240_000);
    const c = await createChildren(playwright, ['A']);
    await login(page, 'staffHimawari');
    await physA(page, c.A);
    await openDevInput(page, c.A.name);
    await setResult(page, 0, '確認できた');
    await messageBox(page).fill('05-035 発達チェックのひとこと');
    expect(await finalize(page)).toBe('done');
    await openContactChild(page, c.A.id);
    const side = page.getByRole('complementary', { name: '記録する' });
    for (let i = 1; i <= 13; i++) {
      const body = `05-035-${String(i).padStart(2, '0')}`;
      await side.getByRole('textbox', { name: '活動のひとこと' }).fill(body);
      const keep = side.getByRole('checkbox', { name: '成長の記録に残す' });
      if (await keep.count()) await keep.check();
      await clickAndWait(page, side.getByRole('button', { name: 'ひとことを送る' }), '/api/contact/events');
      if (!(await keep.count())) await toggleKeep(main(page).getByRole('listitem').filter({ hasText: body }).getByRole('checkbox', { name: '成長の記録に残す' }), true);
      await page.waitForTimeout(1100); // 記録した時刻（秒）の並びを分ける
    }
    const g = await family(browser, playwright, c.A, 'A');
    await openGrowthFromHome(g.page, c.A.name);
    const list = () => achievementItems(g.page).allInnerTexts();
    const first = await list();
    expect.soft(first.length, '12件').toBe(12);
    expect.soft(first[0] ?? '').toContain('05-035-13');
    expect.soft(first[11] ?? '').toContain('05-035-02');
    const more = g.page.getByRole('button', { name: 'さらに読み込む' });
    await expect.soft(more).toBeVisible();
    if (await more.count()) {
      await more.click();
      await expect.poll(async () => (await list()).length).toBe(14);
      const all = await list();
      expect.soft(all[12] ?? '').toContain('05-035-01');
      expect.soft(all[13] ?? '').toContain('05-035 発達チェックのひとこと');
      await expect.soft(more, '続きが無ければ消える').toHaveCount(0);
    }
    expect.soft((await growthBody(g.page).getByRole('row').allInnerTexts()).length - 1, '身長・体重は全件').toBe(2);
    await evidence(g.page, '05-035');
    await g.context.close();
  });

  // ---------------------------------------------------------------- 共有範囲

  test('05-036 共有範囲設定画面の構成', async ({ page }) => {
    // 典拠：要件定義書「共有範囲のチェックリスト設定」(4-6-3)、基本設計書「共有範囲の設定」(4-9)、図/画面詳細図「共有範囲設定画面（管理者）」(6-5) 項目1〜4・7〜9
    await login(page, 'admin');
    await openDevList(page);
    await main(page).getByRole('link', { name: '共有範囲の設定' }).click();
    await expect(page.getByRole('heading', { name: /共有範囲/, level: 1 })).toBeVisible();
    const firstRow = main(page).getByRole('row').nth(1);
    await expect.soft(firstRow, '先頭に身体測定の行').toContainText('身体測定');
    const phys = main(page).getByRole('row').filter({ hasText: '身体測定' }).getByRole('checkbox');
    await expect.soft(phys, '身体測定の行は既定の「共有する」').toBeChecked();
    // 発達の項目：項目ごとに共有の可否のチェックボックスがある（項目の既定の「共有する」は、項目を足す画面が無く確かめられない。
    // デモデータは2項目を「共有しない」にしてある。case-fixes.md）
    const itemRows = main(page).getByRole('row').filter({ has: page.getByRole('checkbox') }).filter({ hasNotText: '身体測定' });
    expect.soft(await itemRows.count(), '項目ごとのチェックボックス').toBeGreaterThan(0);
    const t = await mainText(page);
    expect.soft(t).toContain('共有する項目でも、保護者に届くのは『確認できた』だけです。『一部』『未確認』と所見は園内に留まります');
    expect.soft(t, '開いた時点の設定で判定する').toMatch(/開いた時点の設定/);
    expect.soft(t, '共有しないに戻すと届いた分も出なくなる').toMatch(/すでに届いた分も[^。]*出なくな/);
    await expect.soft(main(page).getByRole('combobox', { name: 'クラス' })).toHaveCount(0);
    await expect.soft(main(page).getByRole('button', { name: '保存する' })).toHaveCount(0);
    await evidence(page, '05-036');
  });

  test('05-037 項目を共有しないにする', async ({ page, browser, playwright }) => {
    // 典拠：要件定義書「共有範囲のチェックリスト設定」(4-6-3)・「機能間のデータの引き渡し」(4-7-3)、基本設計書「共有範囲の設定」(4-9)・「メッセージ一覧」(4-12) の末尾、
    //       図/画面詳細図「共有範囲設定画面（管理者）」(6-5) 項目3・4・7、詳細設計書「成長の記録に届くもの」(3-7)
    test.setTimeout(150_000);
    const c = await createChildren(playwright, ['A']);
    const g = await family(browser, playwright, c.A, 'A');
    const k = await loginIn(browser, 'staffHimawari');
    await openDevInput(k.page, c.A.name);
    await setImplDate(k.page, A_CHECK_DATE);
    const names = await itemNames(k.page);
    await setResult(k.page, 0, '確認できた');
    await setResult(k.page, 1, '確認できた');
    await messageBox(k.page).fill('05-037 ひとこと');
    expect(await finalize(k.page)).toBe('done');
    await k.context.close();
    const itemId = sqlAll<{ development_item_id: number }>('SELECT development_item_id FROM m_development_item WHERE item_name = ?', names[0])[0]?.development_item_id;
    const shareable = () => sqlAll<{ is_shareable: number }>('SELECT is_shareable FROM m_share_setting WHERE development_item_id = ?', itemId ?? 0)[0]?.is_shareable;
    await login(page, 'admin');
    await page.goto('/staff/growth/share');
    const row = main(page).getByRole('row').filter({ hasText: names[0] }).first();
    const box = row.getByRole('checkbox');
    await box.click();
    const dlg = page.getByRole('dialog');
    await expect(dlg, '保存の前に確認ダイアログ').toBeVisible();
    await dlg.getByRole('button', { name: 'やめる' }).click();
    await expect.soft(box, '「やめる」で入ったまま').toBeChecked();
    expect.soft(shareable() === undefined || Number(shareable()) === 1, '保存されない').toBe(true);
    const log0 = lastOpLogId();
    await box.click();
    await page.getByRole('dialog').getByRole('button', { name: /共有しない/ }).click();
    await expect.soft(box).not.toBeChecked();
    expect.soft(Number(shareable())).toBe(0);
    await openGrowthFromHome(g.page, c.A.name);
    const item = achievementItems(g.page).filter({ hasText: '発達チェック' }).first();
    await expect(item).toBeVisible();
    await expect.soft(item, '共有しない項目は出ない').not.toContainText(names[0]);
    await expect.soft(item).toContainText(names[1]);
    await expect.soft(item).toContainText('05-037 ひとこと');
    await evidence(g.page, '05-037');
    await box.click();
    await page.getByRole('dialog').getByRole('button', { name: /共有する/ }).click();
    await expect.soft(box).toBeChecked();
    await openGrowthFromHome(g.page, c.A.name);
    await expect.soft(achievementItems(g.page).filter({ hasText: '発達チェック' }).first(), '戻すと出る').toContainText(names[0]);
    expect.soft(Number(shareable())).toBe(1);
    expect.soft(opLogsSince(log0).filter((l) => l.function_type === '4' && l.operation_type === '2').length, '操作ログ 4・2 が2つ').toBe(2);
    await g.context.close();
  });

  test('05-038 身体測定の行を共有しない', async ({ page, browser, playwright }) => {
    // 典拠：要件定義書「共有範囲のチェックリスト設定」(4-6-3)、基本設計書「共有範囲の設定」(4-9)・「発達チェック・身体測定」(5-8)、図/画面詳細図「共有範囲設定画面（管理者）」(6-5) 項目8、
    //       「身体記録画面」(6-4) 項目15、「成長の記録画面（保護者・スマートフォン）」(6-6) 項目5・6、詳細設計書「成長の記録画面（保護者）」(2-11 (3))・「本書で足す文言」(4-1 (6))
    test.setTimeout(150_000);
    const T = jstToday();
    const c = await createChildren(playwright, ['A']);
    const k = await loginIn(browser, 'staffHimawari');
    await physA(k.page, c.A);
    const g = await family(browser, playwright, c.A, 'A');
    await login(page, 'admin');
    await page.goto('/staff/growth/share');
    const row = main(page).getByRole('row').filter({ hasText: '身体測定' }).first();
    await expect(row, '身体測定の行').toBeVisible();
    await row.getByRole('checkbox').click();
    const dlg = page.getByRole('dialog');
    await expect.soft(dlg).toContainText('共有しないにすると、保護者が次に開いたときから、すでに届いた分も含めて見えなくなります。切り替えますか。');
    await dlg.getByRole('button').filter({ hasNotText: 'やめる' }).last().click();
    expect.soft(setting('growth.share_physical')).toBe('0');
    await openGrowthFromHome(g.page, c.A.name);
    await expect.soft(growthBody(g.page), '身長・体重の区画を出さない').toHaveCount(0);
    await expect.soft(g.page.getByText(GROWTH_DISCLAIMER)).toBeVisible();
    await openPhysical(k.page);
    await selectPhysChild(k.page, c.A.name);
    await expect.soft(main(k.page).getByText('保護者には届きません（共有範囲の設定）')).toBeVisible();
    await registerPhysical(k.page, c.A.name, T, '86.0', '11.80');
    await expect.soft(toast(k.page, /登録しました/)).toHaveText(/^登録しました。\s*(閉じる)?$/);
    await g.page.waitForTimeout(5_000);
    expect.soft((await g.page.getByRole('main').innerText()), '開いた窓に出ない').not.toContain('86.0cm');
    await evidence(g.page, '05-038');
    await row.getByRole('checkbox').click();
    await expect.soft(page.getByRole('dialog')).toContainText('保護者が次に開いたときから見えるようになります。切り替えますか。');
    await page.getByRole('dialog').getByRole('button').filter({ hasNotText: 'やめる' }).last().click();
    expect.soft(setting('growth.share_physical')).toBe('1');
    await openGrowthFromHome(g.page, c.A.name);
    await expect.soft(growthBody(g.page)).toContainText('86.0cm');
    await k.context.close();
    await g.context.close();
  });

  // ---------------------------------------------------------------- 権限

  test('05-039 フリーの職員は記録できない', async ({ page, playwright }) => {
    // 典拠：要件定義書「参照範囲の全体規定」(4-1-5)、基本設計書「権限と利用可能機能」(6-1) の ※1、詳細設計書「職員の画面から成長の記録へ届けるもの」(2-12 (2))・「成長の記録」(4-12 (2))
    const c = await createChildren(playwright, ['A', 'B', 'D', 'E', 'F']);
    await makeFreeStaff(page, playwright); // 【フリー】
    await openDevList(page);
    await chooseListClass(page, 'すべて');
    for (const k of ['A', 'B', 'D', 'E', 'F'] as const) await expect.soft(devRow(page, c[k].name), '全クラスの園児').toBeVisible();
    if (await devRow(page, c.B.name).count()) await openDevInput(page, c.B.name);
    else await page.goto(`/staff/growth/dev/${c.B.id}`); // 一覧に出ないときは、入力画面を直に開いて、記録の操作が出ないかを見る
    await page.waitForTimeout(1500);
    const writable = (await draftButton(page).count()) + (await finalizeButton(page).count()) + (await messageBox(page).count());
    if (writable > 0) {
      await setResult(page, 0, '確認できた').catch(() => {});
      if (await draftButton(page).count()) await draftButton(page).click();
      await expect.soft(page.getByText('この園児を記録する権限がありません'), '押しても保存されない').toBeVisible();
    }
    expect.soft(checksOf(c.B.id).length, '発達チェックの行が増えない').toBe(0);
    await evidence(page, '05-039');
    await openPhysical(page);
    const cls = main(page).getByRole('combobox', { name: 'クラス' });
    if (await cls.locator('option', { hasText: 'さくら組' }).count()) await cls.selectOption({ label: 'さくら組' });
    await page.waitForTimeout(1000);
    await expect.soft(physChild(page, c.B.name), '全クラスを閲覧できる').toBeVisible();
    if (await physChild(page, c.B.name).count()) {
      await selectPhysChild(page, c.B.name);
      if (await registerButton(page).count()) {
        await fillMeasure(page, '75.0', '9.50');
        await registerButton(page).click();
        await expect.soft(page.getByText('この園児を記録する権限がありません')).toBeVisible();
      }
    }
    expect.soft(physicalOf(c.B.id).length, '身体測定の行が増えない').toBe(0);
  });

  test('05-040 ほかの家庭の園児の成長の記録は開けない', async ({ page, playwright }) => {
    // 典拠：要件定義書「データ参照範囲の制限」(8 No.6)、基本設計書「権限と利用可能機能」(6-1) の ※3、詳細設計書「成長の記録画面（保護者）」(2-11 (3))・「本書で足す文言」(4-1 (6))
    const c = await createChildren(playwright, ['A']);
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, 'guardian');
    await page.getByRole('banner').getByRole('button', { name: /メニュー/ }).click();
    await expect.soft(page.getByRole('link', { name: new RegExp(`${c.A.name}の成長の記録`) })).toHaveCount(0);
    await page.goto(`/guardian/growth/${c.A.id}`);
    await expect.soft(page.getByText('この園児の成長の記録は開けません。')).toBeVisible();
    expect.soft((await page.locator('body').innerText()), '児A の名前を出さない').not.toContain(c.A.name);
    await evidence(page, '05-040');
  });

  test('05-042 観点（領域）別の整理', async () => {
    // 典拠：要件定義書「観点（領域）別の整理」(4-6-2)
    test.skip(true, REASON_U05);
  });

  test('05-043 3歳以上の区分の表示', async () => {
    // 典拠：要件定義書「年齢・月齢別テンプレート表示」(4-6-2)（年齢が上がると表示項目が切り替わる。3歳以上は5領域と10の姿）
    test.skip(true, REASON_U05);
  });
});

test.describe('シート05 設定（予定日が近いとする日数）', () => {
  test.use({ serverScope: 'test' });

  test('05-041 予定日が近いとする日数を設定で変える', async ({ page, playwright }) => {
    // 典拠：要件定義書「推奨スケジュール提示」(4-6-3)・「品質要求一覧」(7-1 No.7)、基本設計書「推奨スケジュールの作り方」(4-9)・「設定マスタ（m_setting）」(5-9)、
    //       図/画面詳細図「スケジュール設定画面（管理者）」(6-3) 項目3、「設定画面（管理者）」(7-10) 項目12・13、「発達チェック一覧画面」(6-1) 項目13
    test.setTimeout(120_000);
    const T = jstToday();
    const c = await createChildren(playwright, ['A']);
    await login(page, 'admin');
    await page.goto('/staff/growth/schedule');
    await main(page).getByRole('combobox', { name: 'クラス' }).selectOption({ label: 'ひまわり組' });
    const row = main(page).getByRole('row').filter({ hasText: c.A.name });
    await row.getByRole('textbox', { name: /次回の予定日/ }).fill(addDays(T, 3));
    const reason = row.getByRole('textbox', { name: /理由/ });
    if (await reason.count()) await reason.fill('05-041 境界の確認');
    await row.getByRole('button', { name: '上書きする' }).click();
    await expect(row).toContainText(slash(addDays(T, 3)));
    const master = main(page).getByRole('button', { name: 'マスタを編集' }).or(main(page).getByRole('link', { name: 'マスタを編集' }));
    await expect.soft(master, '「マスタを編集」').toBeVisible();
    let viaScreen = false;
    if (await master.count()) {
      await master.first().click();
      const field = main(page).getByRole('row').filter({ hasText: /予定日が近い/ }).getByRole('spinbutton').or(main(page).getByRole('spinbutton', { name: /予定日が近い/ }));
      await expect.soft(field.first(), '設定画面に「予定日が近いとする日数」').toBeVisible();
      viaScreen = (await field.count()) > 0;
    } else {
      await page.goto('/staff/admin/settings');
      await expect.soft(main(page).getByText(/予定日が近い/), '設定画面に「予定日が近いとする日数」').toBeVisible();
    }
    await evidence(page, '05-041');
    // 画面で変えられないときは、境目の動きだけを設定マスタの書き換えで確かめる（その部分は NG の分析の材料。期待は画面で変えること）
    const set = (v: string) => sqlRun("UPDATE m_setting SET setting_value = ? WHERE setting_key = 'dev.notice_days_before'", v);
    if (!viaScreen) {
      set('3');
      await page.goto('/staff/growth');
      expect.soft(await devCell(page, c.A.name, '状態'), '3日以内（3日ちょうどを含む）は近い').toBe('予定日が近い');
      set('2');
      await page.goto('/staff/growth');
      expect.soft(await devCell(page, c.A.name, '状態'), '2日以内でなければ近くない').not.toBe('予定日が近い');
      set('7');
    }
  });
});

// ==================================================================== 入力チェック

test.describe('シート05 入力チェック', () => {
  test.use({ serverScope: 'test' });

  /** 身体記録画面で児F を選び、測定日・身長・体重を入れて「登録する」を押す（確かめは呼んだ側） */
  async function tryPhys(page: Page, f: ChildSpec, ymd: string | null, height: string | null, weight: string | null) {
    await openPhysical(page, 'もも組');
    if (ymd !== null) await setPhysDate(page, ymd);
    await selectPhysChild(page, f.name);
    await fillMeasure(page, height ?? '', weight ?? '');
    if (await registerButton(page).isEnabled()) await registerButton(page).click();
    else expect.soft(false, '「登録する」が押せず、何が違うかが示されない').toBe(true);
  }
  async function physPrep(page: Page, playwright: RequestFactory) {
    const c = await createChildren(playwright, ['F']);
    await login(page, 'admin');
    return c.F;
  }
  const rowsOn = (f: ChildSpec, ymd: string) => physicalOf(f.id).filter((r) => r.measured_on === ymd && Number(r.is_deleted) === 0);

  test('05-I001 身長 空', async ({ page, playwright }) => {
    // 典拠：基本設計書「身体測定の記録」(4-9) の処理 4・「メッセージ一覧」(4-12)、図/画面詳細図「身体記録画面」(6-4) 項目6
    const f = await physPrep(page, playwright);
    const d = addDays(jstToday(), -1);
    await tryPhys(page, f, d, '', '7.00');
    await expect.soft(page.getByText('身長・体重は必須項目です。')).toBeVisible();
    await expect.soft(weightBox(page)).toHaveValue('7.00');
    expect.soft(rowsOn(f, d).length).toBe(0);
    await evidence(page, '05-I001');
  });

  test('05-I002 体重 空', async ({ page, playwright }) => {
    const f = await physPrep(page, playwright);
    const d = addDays(jstToday(), -1);
    await tryPhys(page, f, d, '65.0', '');
    await expect.soft(page.getByText('身長・体重は必須項目です。')).toBeVisible();
    expect.soft(rowsOn(f, d).length).toBe(0);
    await evidence(page, '05-I002');
  });

  test('05-I003 身長 数値以外', async ({ page, playwright }) => {
    // 典拠：基本設計書「メッセージ一覧」(4-12) の数値以外、図/画面詳細図「身体記録画面」(6-4) 項目6（数値入力）
    const f = await physPrep(page, playwright);
    const d = addDays(jstToday(), -1);
    await openPhysical(page, 'もも組');
    await setPhysDate(page, d);
    await selectPhysChild(page, f.name);
    let typed = true;
    await heightBox(page).fill('ろくじゅう').catch(() => { typed = false; });
    await weightBox(page).fill('7.00');
    if (await registerButton(page).isEnabled()) await registerButton(page).click();
    if (typed && (await heightBox(page).inputValue()) !== '') await expect.soft(page.getByText('身長・体重は数値で入力してください。')).toBeVisible();
    expect.soft(rowsOn(f, d).length, '登録されない').toBe(0);
    await evidence(page, '05-I003');
  });

  test('05-I004 身長 小数第1位', async ({ page, playwright }) => {
    // 典拠：基本設計書「入力項目の制約値」(4-12) の身長・体重・「身体測定記録（t_physical_record）」(5-8)
    const f = await physPrep(page, playwright);
    const d = addDays(jstToday(), -2);
    await tryPhys(page, f, d, '65.5', '7.00');
    await expect.soft(main(page).getByRole('button', { name: 'このまま登録する' }), '範囲外の確認は出ない').toHaveCount(0);
    await expect.soft(toast(page, /登録しました/)).toBeVisible();
    expect.soft(rowsOn(f, d)[0]?.height_cm).toBe(65.5);
    await evidence(page, '05-I004');
  });

  test('05-I005 身長 小数第2位', async ({ page, playwright }) => {
    const f = await physPrep(page, playwright);
    const d = addDays(jstToday(), -2);
    await tryPhys(page, f, d, '65.55', '7.00');
    const again = main(page).getByRole('button', { name: 'このまま登録する' });
    if (await again.isVisible().catch(() => false)) await again.click();
    await page.waitForTimeout(800);
    expect.soft(rowsOn(f, d).length, '登録されない（丸めて保存しない）').toBe(0);
    await evidence(page, '05-I005');
  });

  test('05-I006 体重 小数第2位', async ({ page, playwright }) => {
    const f = await physPrep(page, playwright);
    const d = addDays(jstToday(), -3);
    await tryPhys(page, f, d, '65.0', '7.25');
    await expect.soft(toast(page, /登録しました/)).toBeVisible();
    expect.soft(rowsOn(f, d)[0]?.weight_kg).toBe(7.25);
    await evidence(page, '05-I006');
  });

  test('05-I007 体重 小数第3位', async ({ page, playwright }) => {
    const f = await physPrep(page, playwright);
    const d = addDays(jstToday(), -3);
    await tryPhys(page, f, d, '65.0', '7.255');
    const again = main(page).getByRole('button', { name: 'このまま登録する' });
    if (await again.isVisible().catch(() => false)) await again.click();
    await page.waitForTimeout(800);
    expect.soft(rowsOn(f, d).length, '登録されない（丸めて保存しない）').toBe(0);
    await evidence(page, '05-I007');
  });

  test('05-I008 身長 下限', async ({ page, playwright }) => {
    // 典拠：要件定義書「品質要求一覧」(7-1 No.5)、基本設計書「入力項目の制約値」(4-12)・「設定マスタ（m_setting）」(5-9) の physical.height_min
    const f = await physPrep(page, playwright);
    const d = addDays(jstToday(), -4);
    await tryPhys(page, f, d, '40.0', '7.00');
    await expect.soft(main(page).getByRole('button', { name: 'このまま登録する' }), '範囲外の確認は出ない').toHaveCount(0);
    await expect.soft(toast(page, /登録しました/)).toBeVisible();
    expect.soft(rowsOn(f, d)[0]?.height_cm).toBe(40);
    await evidence(page, '05-I008');
  });

  /** 範囲外の確認が出て、「このまま登録する」で登録されること */
  async function outOfRange(page: Page, f: ChildSpec, d: string, h: string, w: string, id: string, expect1: (r: { height_cm: number; weight_kg: number } | undefined) => void) {
    await tryPhys(page, f, d, h, w);
    const again = main(page).getByRole('button', { name: 'このまま登録する' });
    await expect.soft(again, 'ボタンが「このまま登録する」になる').toBeVisible();
    expect.soft(await mainText(page), '範囲外の文言').toContain('入力値が通常の範囲外です。測定値に誤りがないか確認してください。');
    expect.soft(await mainText(page), '「異常値です」のような判定の言葉を出さない').not.toMatch(/異常値/);
    expect.soft(rowsOn(f, d).length, '確かめる前は保存されない').toBe(0);
    await evidence(page, id);
    if (await again.count()) await again.click();
    await expect.soft(toast(page, /登録しました/)).toBeVisible();
    expect1(rowsOn(f, d)[0]);
  }

  test('05-I009 身長 下限より下', async ({ page, playwright }) => {
    const f = await physPrep(page, playwright);
    await outOfRange(page, f, addDays(jstToday(), -5), '39.9', '7.00', '05-I009', (r) => expect.soft(r?.height_cm).toBe(39.9));
  });

  test('05-I010 身長 上限より上', async ({ page, playwright }) => {
    const f = await physPrep(page, playwright);
    await outOfRange(page, f, addDays(jstToday(), -6), '140.1', '7.00', '05-I010', (r) => expect.soft(r?.height_cm).toBe(140.1));
  });

  test('05-I011 体重 下限より下', async ({ page, playwright }) => {
    const f = await physPrep(page, playwright);
    await outOfRange(page, f, addDays(jstToday(), -7), '65.0', '1.99', '05-I011', (r) => expect.soft(r?.weight_kg).toBe(1.99));
  });

  test('05-I012 体重 上限より上', async ({ page, playwright }) => {
    const f = await physPrep(page, playwright);
    await outOfRange(page, f, addDays(jstToday(), -8), '65.0', '40.01', '05-I012', (r) => expect.soft(r?.weight_kg).toBe(40.01));
  });

  test('05-I013 測定日 未来', async ({ page, playwright }) => {
    // 典拠：基本設計書「身体測定の記録」(4-9) の処理 4・「入力項目の制約値」(4-12)・「メッセージ一覧」(4-12)、図/画面詳細図「身体記録画面」(6-4) 項目2
    const f = await physPrep(page, playwright);
    const d = addDays(jstToday(), 1);
    await openPhysical(page, 'もも組');
    await physDate(page).fill(d);
    await physDate(page).blur();
    const accepted = (await physDate(page).inputValue()) === d;
    if (accepted) {
      await selectPhysChild(page, f.name);
      await fillMeasure(page, '65.0', '7.00');
      await registerButton(page).click();
      await expect.soft(page.getByText('測定日に未来の日付は指定できません。')).toBeVisible();
    }
    expect.soft(rowsOn(f, d).length, '登録されない').toBe(0);
    await evidence(page, '05-I013');
  });

  test('05-I014 測定日 空', async ({ page, playwright }) => {
    // 典拠：基本設計書「メッセージ一覧」(4-12) の測定日の欠落、図/画面詳細図「身体記録画面」(6-4) 項目2
    const f = await physPrep(page, playwright);
    await openPhysical(page, 'もも組');
    await selectPhysChild(page, f.name);
    await physDate(page).fill('');
    await fillMeasure(page, '65.0', '7.00');
    if (await registerButton(page).isEnabled()) await registerButton(page).click();
    else expect.soft(false, '「登録する」が押せず、何が違うかが示されない').toBe(true);
    await expect.soft(page.getByText('測定日は必須項目です。')).toBeVisible();
    await page.waitForTimeout(500);
    expect.soft(physicalOf(f.id).length, '登録されない').toBe(0);
    await evidence(page, '05-I014');
  });

  // 発達チェック入力画面（児E・一般S・下書き保存）

  async function devPrep(page: Page, playwright: RequestFactory) {
    const c = await createChildren(playwright, ['E']);
    await login(page, 'staffSakura');
    await openDevInput(page, c.E.name);
    await setResult(page, 0, '確認できた');
    return c.E;
  }
  async function draftAndCheck(page: Page) {
    const res = await saveDraft(page).catch(() => null);
    return res;
  }

  test('05-I015 所見 1000文字', async ({ page, playwright }) => {
    // 典拠：基本設計書「入力項目の制約値」(4-12) の所見・「発達チェック・身体測定」(5-8)、図/画面詳細図「発達チェック入力画面」(6-2) 項目6
    const e = await devPrep(page, playwright);
    const v = text('05-I015', 1000);
    await noteBox(page).fill(v);
    expect.soft(await mainText(page), '残りの文字数 0').toMatch(/残り\s*0\s*文字/);
    await draftAndCheck(page);
    await evidence(page, '05-I015');
    expect.soft(checksOf(e.id)[0]?.note).toBe(v);
  });

  test('05-I016 所見 1001文字', async ({ page, playwright }) => {
    const e = await devPrep(page, playwright);
    const v = text('05-I016', 1001);
    await noteBox(page).fill(v);
    const typed = (await noteBox(page).inputValue()).length;
    await draftButton(page).click();
    await page.waitForTimeout(1000);
    if (typed > 1000) await expect.soft(page.getByText(/所見は\s*1,?000\s*文字以内で入力してください。/)).toBeVisible();
    expect.soft(checksOf(e.id)[0]?.note ?? '', '1,001文字では保存されない').not.toBe(v);
    await evidence(page, '05-I016');
  });

  test('05-I017 ひとこと 500文字', async ({ page, playwright }) => {
    // 典拠：基本設計書「入力項目の制約値」(4-12) の保護者へのひとこと（発達チェック）、図/画面詳細図「発達チェック入力画面」(6-2) 項目14、詳細設計書「成長の記録」(4-12 (2))
    const e = await devPrep(page, playwright);
    const v = text('05-I017', 500);
    await messageBox(page).fill(v);
    await draftAndCheck(page);
    expect.soft(checksOf(e.id)[0]?.guardian_message).toBe(v);
    await openDevInput(page, e.name);
    await expect.soft(messageBox(page)).toHaveValue(v);
    await evidence(page, '05-I017');
  });

  test('05-I018 ひとこと 501文字', async ({ page, playwright }) => {
    const e = await devPrep(page, playwright);
    const v = text('05-I018', 501);
    await messageBox(page).fill(v);
    const typed = (await messageBox(page).inputValue()).length;
    await draftButton(page).click();
    await page.waitForTimeout(1000);
    if (typed > 500) await expect.soft(page.getByText('保護者へのひとことは500文字以内で入力してください。')).toBeVisible();
    expect.soft(checksOf(e.id)[0]?.guardian_message ?? '', '501文字では保存されない').not.toBe(v);
    await evidence(page, '05-I018');
  });

  test('05-I019 ひとこと 前後の空白', async ({ page, playwright }) => {
    // 典拠：詳細設計書「成長の記録」(4-12 (2))・「検査の共通の規則」(4-1 (5))
    const e = await devPrep(page, playwright);
    const v = ` ${text('05-I019', 500)} `;
    await messageBox(page).fill(v);
    if ((await messageBox(page).inputValue()) !== v) test.skip(true, '入力欄が500文字で止まり、前後の空白を含めた502文字を打ち込めない（U-15）');
    await draftAndCheck(page);
    expect.soft(checksOf(e.id)[0]?.guardian_message?.trim(), '保存される').toBe(v.trim());
    await evidence(page, '05-I019');
  });

  test('05-I020 ひとこと 空白だけ', async ({ page, playwright }) => {
    // 典拠：詳細設計書「成長の記録」(4-12 (2))・「成長の記録に届くもの」(3-7)
    const e = await devPrep(page, playwright);
    await messageBox(page).fill('   ');
    await draftAndCheck(page);
    expect.soft(checksOf(e.id).length, '下書き保存される').toBe(1);
    expect.soft(checksOf(e.id)[0]?.guardian_message ?? null, '空白だけは NULL').toBeNull();
    await evidence(page, '05-I020');
  });

  test('05-I021 実施日 未来', async ({ page, playwright }) => {
    // 典拠：基本設計書「入力項目の制約値」(4-12) の記録日・測定日、図/画面詳細図「発達チェック入力画面」(6-2) 項目3
    const e = await devPrep(page, playwright);
    const d = addDays(jstToday(), 1);
    await implDate(page).fill(d);
    await implDate(page).blur();
    if ((await implDate(page).inputValue()) === d) {
      await draftButton(page).click();
      await page.waitForTimeout(1000);
    }
    expect.soft(checksOf(e.id).filter((c) => c.checked_on === d).length, '未来の実施日では保存されない').toBe(0);
    await evidence(page, '05-I021');
  });

  // スケジュール設定画面（児B・管理者A）

  async function schedPrep(page: Page, playwright: RequestFactory) {
    const c = await createChildren(playwright, ['B']);
    await login(page, 'admin');
    await page.goto('/staff/growth/schedule');
    await main(page).getByRole('combobox', { name: 'クラス' }).selectOption({ label: 'さくら組' });
    const row = main(page).getByRole('row').filter({ hasText: c.B.name });
    await expect(row).toBeVisible();
    return { b: c.B, row };
  }

  test('05-I022 次回予定日 過去', async ({ page, playwright }) => {
    // 典拠：基本設計書「推奨スケジュールの作り方」(4-9)、図/画面詳細図「スケジュール設定画面（管理者）」(6-3) 項目5・8
    const { b, row } = await schedPrep(page, playwright);
    const before = latestSchedule(b.id)?.scheduled_on;
    const d = addDays(jstToday(), -1);
    const box = row.getByRole('textbox', { name: /次回の予定日/ });
    await box.fill(d);
    await box.blur();
    const btn = row.getByRole('button', { name: '上書きする' });
    if ((await box.inputValue()) === d && (await btn.isEnabled())) {
      const reason = row.getByRole('textbox', { name: /理由/ });
      if (await reason.count()) await reason.fill('05-I022 過去の日');
      await btn.click();
      await page.waitForTimeout(1000);
    }
    expect.soft(latestSchedule(b.id)?.scheduled_on, '上書きされない').toBe(before);
    await evidence(page, '05-I022');
  });

  test('05-I023 次回予定日 当日', async ({ page, playwright }) => {
    const { b, row } = await schedPrep(page, playwright);
    const T = jstToday();
    await row.getByRole('textbox', { name: /次回の予定日/ }).fill(T);
    const reason = row.getByRole('textbox', { name: /理由/ });
    if (await reason.count()) await reason.fill('05-I023 園の都合');
    await row.getByRole('button', { name: '上書きする' }).click();
    await expect.soft(row).toContainText('手動上書き');
    await expect.soft(row).toContainText(slash(T));
    expect.soft(latestSchedule(b.id)?.scheduled_on).toBe(T);
    expect.soft(Number(latestSchedule(b.id)?.is_manual_override)).toBe(1);
    await evidence(page, '05-I023');
  });

  test('05-I024 理由 空', async ({ page, playwright }) => {
    // 典拠：要件定義書「手動でのスケジュール上書き」(4-6-3)、基本設計書「推奨スケジュールの作り方」(4-9)・「入力項目の制約値」(4-12)、図/画面詳細図「スケジュール設定画面（管理者）」(6-3) 項目9
    const { b, row } = await schedPrep(page, playwright);
    const before = latestSchedule(b.id)?.scheduled_on;
    await row.getByRole('textbox', { name: /次回の予定日/ }).fill(addDays(jstToday(), 10));
    await row.getByRole('button', { name: '上書きする' }).click();
    await page.waitForTimeout(1000);
    expect.soft(latestSchedule(b.id)?.scheduled_on, '理由が空なら上書きされない').toBe(before);
    await evidence(page, '05-I024');
  });

  test('05-I025 理由 501文字', async ({ page, playwright }) => {
    const { b, row } = await schedPrep(page, playwright);
    const before = latestSchedule(b.id)?.scheduled_on;
    await row.getByRole('textbox', { name: /次回の予定日/ }).fill(addDays(jstToday(), 10));
    const reason = row.getByRole('textbox', { name: /理由/ }).or(main(page).getByRole('textbox', { name: /理由/ }));
    await expect.soft(reason.first(), '理由の欄').toBeVisible();
    if (await reason.count()) await reason.first().fill(text('05-I025', 501));
    await row.getByRole('button', { name: '上書きする' }).click();
    await page.waitForTimeout(1000);
    expect.soft(latestSchedule(b.id)?.scheduled_on, '501文字の理由では上書きされない').toBe(before);
    await evidence(page, '05-I025');
  });
});
