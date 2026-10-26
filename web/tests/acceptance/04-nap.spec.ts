/*
 * シート 04 午睡チェック（午睡チェック画面・異常時記録画面・午睡記録検索画面）
 *
 * ケースは sheet-04.md（テスト仕様書 第2.0版の下書き）による。期待する結果は設計書（docs ブランチ）から書く。
 * コードを読んで決めない（README.md「期待は設計書から」）。典拠は各テストのコメントに書く。
 *
 * - テストごとに新しいデータベースでサーバを立てる（serverScope: 'test'）。落ちたテストのあとはワーカーが替わり、
 *   前のテストのデータが残らないため。前提はテストの中で作る（sheet-04.md の「入力データ・前提」）
 * - 設計書の細かい見え方は expect.soft で見る（違っても先へ進み、違ったところをまとめて NG に出す）
 * - 2分以上待つケースは ACCEPTANCE_LONG=1 のときだけ回す（04-nap.helpers.ts の LONG）
 * - 【次の版】のケースは、画面に機能が無ければ未実施（実装対象の外）、あれば基本設計書の期待で OK か NG にする
 */
import { evidence, expect, fillLogin, gotoTop, jstToday, login, passwordOf, test } from './harness';
import type { Locator, Page } from '@playwright/test';
import {
  LONG,
  LONG_REASON,
  abnormalRow,
  addMinutesHM,
  anyHm,
  chooseClass,
  choose,
  clickAndWaitNap,
  countSounds,
  endButton,
  endIfRunning,
  enterTemperature,
  exclude,
  freshSession,
  headerText,
  hmNear,
  jstHM,
  jstIso,
  jstMinutesOfDay,
  loginIn,
  newWindow,
  napMain,
  napRow,
  notImplemented,
  openNap,
  openSearch,
  openSession,
  pressSleep,
  recordAbnormal,
  recordButton,
  recordCheck,
  searchBy,
  sessionsOf,
  setSetting,
  shiftDate,
  soundCount,
  sqlAll,
  sqlOne,
  sqlRun,
  staffId,
  childId,
  startButton,
  stopEvents,
  classSelect,
} from './04-nap.helpers';

test.use({ serverScope: 'test' });

/*
 * 【時間帯】夜中や夕方に回しても、実施が時間帯の終わりで自動で解除されないように、午睡の時間帯を 00:00-23:59 にする
 * （sheet-04.md「前提の記号」・undecided.md U-01）。設計書は設定画面で変えるとするが、設定画面と設定の API に午睡の値が無いため、
 * 設定マスタを書き換えて作る。23:50 より後は、時間帯が同じ日の中で終わるため回さない
 */
test.beforeEach(() => {
  test.skip(jstMinutesOfDay() > 23 * 60 + 50, '実施の時刻が 23:50 より後（午睡の時間帯は同じ日の中で終わるため、実施を使うケースを回さない）');
  setSetting('nap.time_range', '00:00-23:59');
});

/* 判定の言葉（sheet-04.md「期待する結果の読み方」。設計書の例は「平熱」「発熱」で、一覧は無い。U-21） */
const JUDGMENT_WORDS = ['発熱', '熱がある', '高い', '低い', '異常', 'よく眠れ', '短い', '長い', '十分'];

async function expectNoJudgment(target: Locator, what: string, allow: string[] = []) {
  const text = (await target.innerText()).replace(/異常を記録する|異常時の記録/g, '');
  for (const w of JUDGMENT_WORDS) {
    if (allow.includes(w)) continue;
    expect.soft(text.includes(w), `${what}に判定の言葉「${w}」が出ている`).toBe(false);
  }
}

/** 画面に出ている園児の行の名前（並びの順） */
async function rowNames(page: Page): Promise<string[]> {
  const labels = await page.getByRole('region', { name: /の午睡チェック$/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  return labels.map((l) => l.replace(/の午睡チェック$/, ''));
}

/** そのクラスの在籍の園児の数（データベースから） */
function enrolledCount(className: string): number {
  const row = sqlOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM t_class_child cc JOIN m_class c ON c.class_id = cc.class_id JOIN m_child ch ON ch.child_id = cc.child_id
      WHERE c.class_name = ? AND c.fiscal_year = (SELECT MAX(fiscal_year) FROM m_class) AND ch.is_deleted = 0 AND ch.enrollment_status = '1'`,
    className,
  );
  return Number(row?.n ?? 0);
}

function sleepsOf(child: string) {
  return sqlAll<{ nap_sleep_id: number; nap_session_id: number; slept_at: string; woke_at: string | null; sleep_temperature: number | null; slept_staff_id: string; woke_staff_id: string | null; corrected_at: string | null; is_deleted: number }>(
    'SELECT * FROM t_nap_sleep WHERE child_id = ? ORDER BY nap_sleep_id',
    childId(child),
  );
}

function recordsOf(child: string, sessionId?: number) {
  return sqlAll<{ nap_record_id: number; nap_session_id: number; checked_at: string; saved_at: string; body_position: string; breathing: string; complexion: string; temperature: number | null; staff_id: string; corrected_at: string | null }>(
    `SELECT * FROM t_nap_record WHERE child_id = ? ${sessionId ? 'AND nap_session_id = ?' : ''} ORDER BY nap_record_id`,
    ...(sessionId ? [childId(child), sessionId] : [childId(child)]),
  );
}

function abnormalsOf(child: string) {
  return sqlAll<{ nap_abnormal_id: number; nap_session_id: number; found_at: string; recorded_at: string | null; situation: string; response: string; staff_id: string; diary_id: number | null; guardian_notice: string | null; guardian_noticed_at: string | null; guardian_notice_method: string | null; guardian_notice_person: string | null; corrected_at: string | null }>(
    'SELECT * FROM t_nap_abnormal WHERE child_id = ? ORDER BY nap_abnormal_id',
    childId(child),
  );
}

/** データベースの時刻（YYYY-MM-DDTHH:MM:SS）の「時:分」 */
const dbHM = (v: string | null | undefined) => (v ?? '').slice(11, 16);

/** 一覧の行の「修正」で開く編集の領域（同じ画面の中に開く。図/画面詳細図 5-2 項目17・5-3 項目12）。理由の欄と「やめる」を持ついちばん内側の領域 */
function editArea(page: Page): Locator {
  const main = page.getByRole('main');
  return main
    .getByRole('dialog')
    .or(main.locator('tr, form, section, div, td').filter({ has: page.getByText(/理由/) }).filter({ has: page.getByRole('button', { name: /やめる/ }) }).last());
}

/** 編集の領域で体位を選ぶ（プルダウンでもラジオボタンでも） */
async function setPosition(area: Locator, label: string) {
  const combo = area.getByRole('combobox', { name: /体位/ });
  if (await combo.count()) await combo.first().selectOption({ label });
  else await area.getByRole('group', { name: '体位' }).getByText(label, { exact: true }).click();
}

/** 編集の領域の保存のボタン（「やめる」でないもの） */
const saveButton = (area: Locator) => area.getByRole('button').filter({ hasNotText: /やめる|閉じる/ }).last();

/** 一時パスワードの職員がパスワードを変え、規約の同意まで済ませる（【村田】【フリー】） */
async function finishFirstLogin(page: Page, tempPassword: string, newPassword: string) {
  await expect(page.getByRole('heading', { name: 'パスワードの変更' })).toBeVisible();
  await page.getByRole('textbox', { name: /現在のパスワード/ }).fill(tempPassword);
  await page.getByRole('textbox', { name: /^新しいパスワード 必須$|^新しいパスワード$/ }).fill(newPassword);
  await page.getByRole('textbox', { name: /新しいパスワード（確認）/ }).fill(newPassword);
  await page.getByRole('button', { name: '変更する' }).click();
  await page.waitForURL((u) => !u.pathname.includes('password'), { timeout: 15_000 });
  if (/terms/.test(new URL(page.url()).pathname)) {
    for (const box of await page.getByRole('checkbox').all()) await box.check();
    await page.getByRole('button', { name: /同意/ }).first().click();
    await page.waitForURL((u) => !u.pathname.includes('terms'), { timeout: 15_000 });
  }
  await expect(page.getByRole('navigation', { name: '職員メニュー' })).toBeVisible();
}

/** 【村田】一般M（一時パスワード中）でログインし、パスワードを変えてから使う */
async function loginMurata(page: Page) {
  await gotoTop(page, 'staff');
  await fillLogin(page, 'staffTempPassword');
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await finishFirstLogin(page, passwordOf('staffTempPassword'), 'Accept-04-Murata-2026');
}

/** 「ねた」のボタンが出ているか（終わった実施の画面に切り替わったあとは出ない） */
async function pressSleepVisible(page: Page, child: string): Promise<boolean> {
  return page.getByRole('button', { name: `${child}のねた`, exact: true }).isVisible();
}

/** 職員ダッシュボードの「午睡中の園児」の人数 */
async function sleepingOnDashboard(page: Page): Promise<number> {
  // ダッシュボードの項目が出るまで待つ。「午睡中の園児」の行が無いときは 0 人として読む（0 人の行を出すかは設計書が決めていない）
  await expect(page.getByRole('main').getByRole('row').first()).toBeVisible();
  const row = page.getByRole('main').getByRole('row').filter({ hasText: '午睡中の園児' });
  if ((await row.count()) === 0) return 0;
  const text = await row.first().innerText();
  if (/ありません/.test(text)) return 0; // 0 人のときの画面の書き方（「午睡中の園児 ありません」）
  return Number(/(\d+)\s*名/.exec(text)?.[1] ?? 'NaN');
}

/** 管理者のヘッダの「異常時の記録（未確認）」の件数（出ていなければ 0） */
async function unconfirmedInHeader(page: Page): Promise<number> {
  const text = (await page.getByRole('banner').innerText()).replace(/\s+/g, ' ');
  const m = /異常時の記録（未確認）\s*(\d+)\s*件/.exec(text);
  return m ? Number(m[1]) : 0;
}

// =====================================================================
// 午睡チェック画面：開始と出し分け
// =====================================================================
test.describe('午睡チェック画面：開始と出し分け', () => {
  /*
   * 典拠：基本設計書「午睡チェックの実施」(4-8)・「一覧表示とページング」(3-7)・「午睡チェック」(5-7)、
   *   図/画面詳細図「午睡チェック画面」(5-1) 項目1〜7・18、詳細設計書「午睡チェック画面」(2-4) の (2)、
   *   要件定義書「端末の利用形態と本人特定」(4-1-4 (4))
   */
  test('04-001 開始する 一般・自クラス', async ({ page }) => {
    await login(page, 'staffSakura');
    await openNap(page);
    await endIfRunning(page); // 前提：さくら組のきょうの実施が無い（デモの今日の実施は終えておく）

    // 開始の前
    const options = (await classSelect(page).locator('option').allTextContents()).map((s) => s.trim());
    expect.soft(options, 'クラスは自クラスだけ').toEqual(['さくら組']);
    await expect.soft(napMain(page), '開始の前の行に「午睡チェックを開始すると押せます」').toContainText('午睡チェックを開始すると押せます');

    const t0 = new Date();
    await startButton(page).click();
    await expect(endButton(page)).toBeVisible();
    const head = await headerText(page);
    expect.soft(head, '記録者').toContain('鈴木 浩之');
    expect.soft(head, '開始時刻（サーバの時刻）').toMatch(new RegExp(`開始\\s*${anyHm(hmNear(t0)).source}`));
    expect.soft(head, '経過時間').toContain('経過');
    expect.soft(head, '次の確認').toContain('次の確認');

    // 1人1行、ページを分けずに並ぶ
    const n = enrolledCount('さくら組');
    await expect(page.getByRole('region', { name: /の午睡チェック$/ })).toHaveCount(n);
    const names = await rowNames(page);
    const row = napRow(page, names[0]);
    await expect.soft(row.getByText(names[0], { exact: true }).first()).toBeVisible();
    await expect.soft(row, '平熱').toContainText('平熱');
    await expect.soft(row, '最後の確認').toContainText('最後の確認');
    await expect.soft(row, '次の確認').toContainText('次の確認');
    await expect.soft(row.getByRole('button', { name: /ねた$/ })).toBeVisible();
    for (const g of ['体位', '呼吸', '顔色']) await expect.soft(row.getByRole('group', { name: g })).toBeVisible();
    await expect.soft(row.getByRole('button', { name: /体温/ })).toBeVisible();
    await expect.soft(row, 'チェックした時刻').toContainText('チェックした時刻');
    await expect.soft(row.getByRole('button', { name: '記録する', exact: true }), '「記録する」').toBeVisible();
    await expect.soft(row.getByRole('button', { name: /きょうは対象外/ })).toBeVisible();

    await expect.soft(startButton(page)).toBeHidden();
    await expect.soft(napMain(page).getByRole('link', { name: '記録を検索' }).or(napMain(page).getByRole('button', { name: '記録を検索' }))).toBeVisible();
    await expect.soft(napMain(page).getByRole('link', { name: '異常を記録する' }).or(napMain(page).getByRole('button', { name: '異常を記録する' }))).toBeVisible();
    await expect.soft(endButton(page)).toBeVisible();

    const s = openSession('さくら組');
    expect(s, '実施の行').toBeTruthy();
    expect.soft(s?.session_date).toBe(jstToday());
    expect.soft(s?.started_staff_id).toBe(staffId('鈴木 浩之'));
    expect.soft(hmNear(t0)).toContain(dbHM(s?.started_at));
    await evidence(page, '04-001');
  });

  /* 典拠：要件定義書「午睡チェック」(4-5)、基本設計書「午睡チェックの実施」(4-8)・「権限と利用可能機能」(6-1) の ※1、図/画面詳細図「午睡チェック画面」(5-1) 項目1 */
  test('04-002 クラスの選び方', async ({ page, browser }) => {
    await login(page, 'admin');
    await openNap(page);
    await endIfRunning(page); // 前提：デモの今日の実施（さくら組）は終えておく（実施中は切り替えられないため。U-17）
    const options = (await classSelect(page).locator('option').allTextContents()).map((s) => s.trim());
    for (const c of ['もも組', 'さくら組', 'ひまわり組']) expect.soft(options, `管理者は ${c} を選べる`).toContain(c);
    await expect.soft(classSelect(page)).toBeEnabled();
    await classSelect(page).selectOption({ label: 'もも組' });
    await expect.soft(classSelect(page).locator('option:checked')).toHaveText('もも組');

    const k = await loginIn(browser, 'staffHimawari');
    await openNap(k.page);
    const kOptions = (await classSelect(k.page).locator('option').allTextContents()).map((s) => s.trim());
    expect.soft(kOptions, '一般K はひまわり組だけ').toEqual(['ひまわり組']);
    await evidence(page, '04-002');
    await k.context.close();
  });

  /* 典拠：基本設計書「午睡チェックの実施」(4-8)（フリーの職員は閲覧のみ）・「権限と利用可能機能」(6-1) の ※1、図/画面詳細図「職員（タブレット／PC）」(1-1) 項目3 と注記、「午睡チェック画面」(5-1) の注記 */
  test('04-003 フリーの職員は閲覧のみ', async ({ page, browser }) => {
    // 前提：さくら組の実施中
    const s = await loginIn(browser, 'staffSakura');
    await freshSession(s.page);
    // 前提【フリー】：担当クラスの無い一般の職員を発行し、初回ログインを済ませる
    await login(page, 'admin');
    await page.goto('/staff/admin/staff-accounts');
    await page.getByRole('button', { name: /アカウントを発行/ }).click();
    const dialog = page.getByRole('dialog', { name: /職員アカウントの発行/ });
    await dialog.getByRole('textbox', { name: /氏名/ }).fill('受入テスト フリー');
    await dialog.getByRole('textbox', { name: /ログインID/ }).fill('free04003@hoiku.example.jp');
    await dialog.getByRole('combobox', { name: /ロール/ }).selectOption({ label: '一般（保育士）' });
    await dialog.getByRole('combobox', { name: /担当クラス/ }).selectOption({ label: '割り当てない' });
    await dialog.getByRole('button', { name: '発行する' }).click();
    await expect(dialog.getByRole('button', { name: '発行する' })).toHaveCount(0, { timeout: 15_000 }).catch(() => undefined);
    const dialogs = page.getByRole('dialog').or(page.getByRole('alertdialog'));
    const shown = ((await dialogs.count()) ? await dialogs.last().innerText() : await page.getByRole('main').innerText()).replace(/\s+/g, ' ');
    const candidates = [
      ...[...shown.matchAll(/受入テスト フリー\s*さん[：:]\s*([!-~]{8,})/g)].map((m) => m[1]),
      ...[...shown.matchAll(/一時パスワード[^A-Za-z0-9]{0,12}([A-Za-z0-9!-~]{8,})/g)].map((m) => m[1]),
    ].filter((t) => !t.includes('@'));
    const codeText = (await page.locator('code, kbd, samp, output').allInnerTexts()).map((t) => t.trim()).filter((t) => /^[!-~]{8,}$/.test(t));
    const temp = candidates[0] ?? codeText[0];
    test.skip(!temp, `前提を作れなかった：発行した一時パスワードを画面から読めなかった（${shown.slice(0, 300)}）`);

    const f = await newWindow(browser);
    await f.page.goto('/staff-top');
    await f.page.getByLabel('ログインID', { exact: true }).fill('free04003@hoiku.example.jp');
    await f.page.getByLabel('パスワード', { exact: true }).fill(temp!);
    await f.page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await finishFirstLogin(f.page, temp!, 'Accept-04-Free-2026');

    await expect.soft(f.page.getByRole('banner'), 'ヘッダに「フリー」').toContainText('フリー');
    await openNap(f.page).catch(() => undefined);
    const main = f.page.getByRole('main');
    await expect.soft(main, '全クラスを閲覧のみで見られることを示す').toContainText(/閲覧/);
    await expect.soft(main, 'さくら組の実施の状況が見られる').toContainText(/さくら組/);
    for (const name of ['午睡チェックを開始する', '午睡チェックを終了', '異常を記録する']) {
      await expect.soft(main.getByRole('button', { name }).or(main.getByRole('link', { name })), `「${name}」が出ない`).toHaveCount(0);
    }
    await expect.soft(main.getByRole('button', { name: /ねた$|おきた$|対象外|^記録する$|この子を記録/ }), '行の記録のボタンが出ない').toHaveCount(0);
    await evidence(f.page, '04-003');
    await f.context.close();
    await s.context.close();
  });
});

// =====================================================================
// 午睡チェック画面：タイマー
// =====================================================================
test.describe('午睡チェック画面：タイマー', () => {
  /* 典拠：要件定義書「午睡チェック」(4-5)（タイマー・アラーム）、基本設計書「午睡チェックの実施」(4-8) のタイマーの決め方・「設定マスタ（m_setting）」(5-9)、図/画面詳細図「午睡チェック画面」(5-1) 項目3 */
  test('04-004 年齢児ごとの確認の間隔', async ({ page, browser }) => {
    await login(page, 'admin');
    const s = await loginIn(browser, 'staffSakura');
    const k = await loginIn(browser, 'staffHimawari');
    const cases: { p: Page; cls?: string; minutes: number; label: string }[] = [
      { p: page, cls: 'もも組', minutes: 5, label: 'もも組（0歳児）' },
      { p: s.page, minutes: 10, label: 'さくら組（1歳児）' },
      { p: k.page, minutes: 15, label: 'ひまわり組（2歳児）' },
    ];
    for (const c of cases) {
      if (c.cls) {
        await openNap(c.p);
        await endIfRunning(c.p).catch(() => undefined);
      }
      const t0 = await freshSession(c.p, c.cls);
      const expected = anyHm([addMinutesHM(t0, c.minutes - 1), addMinutesHM(t0, c.minutes), addMinutesHM(t0, c.minutes + 1)]);
      const head = await headerText(c.p);
      expect.soft(head, `${c.label}：「次の確認」に開始時刻＋${c.minutes}分`).toMatch(new RegExp(`次の確認.*${expected.source}`));
      const names = await rowNames(c.p);
      expect.soft(head, `${c.label}：「次の確認」に対象の園児の名前`).toContain(names[0]);
      expect.soft(head, `${c.label}：残り時間（あと）`).toMatch(/あと/);
      await expect.soft(napRow(c.p, names[0]), `${c.label}：行の「次の確認」も同じ時刻`).toContainText(new RegExp(`次の確認.*${expected.source}`));
    }
    await evidence(s.page, '04-004');
    await s.context.close();
    await k.context.close();
  });

  /* 【次の版】典拠：要件定義書「午睡チェック」(4-5)、基本設計書「午睡チェックの実施」(4-8)・「入力項目の制約値」(4-12) の午睡の確認の間隔（園児ごと）、図/画面詳細図「午睡チェック画面」(5-1) 項目3 */
  test('04-005 園児ごとの間隔の上書き', async ({ page, browser }) => {
    await login(page, 'admin');
    await page.goto('/staff/children');
    await page.getByRole('main').getByRole('row').filter({ hasText: '村田 美咲' }).getByRole('link', { name: '編集' }).click();
    await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
    const field = page.getByRole('main').getByRole('spinbutton', { name: /午睡.*間隔|確認の間隔/ }).or(page.getByRole('main').getByRole('textbox', { name: /午睡.*間隔|確認の間隔/ }));
    test.skip((await field.count()) === 0, notImplemented('園児情報入力画面に、園児ごとの午睡の間隔の欄が無い'));
    await field.first().fill('3');
    await page.getByRole('main').getByRole('button', { name: /確認|保存|登録|次へ/ }).first().click();
    const confirm = page.getByRole('main').getByRole('button', { name: /登録|保存|確定/ });
    if (await confirm.count()) await confirm.first().click();

    const s = await loginIn(browser, 'staffSakura');
    const t0 = await freshSession(s.page);
    const plus3 = anyHm([addMinutesHM(t0, 2), addMinutesHM(t0, 3), addMinutesHM(t0, 4)]);
    const plus10 = anyHm([addMinutesHM(t0, 9), addMinutesHM(t0, 10), addMinutesHM(t0, 11)]);
    const head = await headerText(s.page);
    expect.soft(head).toMatch(new RegExp(`次の確認.*${plus3.source}`));
    expect.soft(head).toContain('村田 美咲');
    await expect.soft(napRow(s.page, '村田 美咲')).toContainText(new RegExp(`次の確認.*${plus3.source}`));
    await expect.soft(napRow(s.page, '西田 太郎')).toContainText(new RegExp(`次の確認.*${plus10.source}`));
    await evidence(s.page, '04-005');
    await s.context.close();
  });

  /*
   * 典拠：要件定義書「午睡チェック」(4-5)・「品質要求一覧」(7-1 No.7)、基本設計書「午睡チェックの実施」(4-8) の処理 4 とタイマーの決め方、
   *   図/画面詳細図「午睡チェック画面」(5-1) 項目3・7・20 と読み上げの注記、詳細設計書「全画面に共通する部品と決まり」(2-0) の (6)
   * 前提：0歳児の間隔を1分にする。設計書は設定画面で変えるとするが、設定画面に午睡の欄が無いので、設定マスタを書き換えて作る
   */
  test('04-006 設定で変えた間隔と時刻を過ぎたとき', async ({ page }) => {
    test.skip(!LONG, LONG_REASON);
    test.setTimeout(5 * 60_000);
    setSetting('nap.interval_minutes.age0', '1');
    await countSounds(page.context());
    await login(page, 'admin');
    const t0 = await freshSession(page, 'もも組');
    const plus1 = anyHm([addMinutesHM(t0, 0), addMinutesHM(t0, 1), addMinutesHM(t0, 2)]);
    expect.soft(await headerText(page), '「次の確認」が開始時刻＋1分').toMatch(new RegExp(`次の確認.*${plus1.source}`));
    const names = await rowNames(page);
    const before = await napRow(page, names[0]).evaluate((el) => `${el.className}|${getComputedStyle(el).backgroundColor}|${getComputedStyle(el).borderColor}`);
    const sounds0 = await soundCount(page);
    await page.waitForTimeout(125_000);
    const after = await napRow(page, names[0]).evaluate((el) => `${el.className}|${getComputedStyle(el).backgroundColor}|${getComputedStyle(el).borderColor}`);
    expect.soft(after, '時刻を過ぎた行が警告色になる').not.toBe(before);
    await expect.soft(napMain(page)).toContainText(`チェックの時刻を過ぎています（未確認 ${names.length} 名）`);
    await expect.soft(napMain(page).getByRole('status').filter({ hasText: 'チェックの時刻を過ぎています' })).toHaveCount(1);
    expect.soft(await soundCount(page), '時刻になったら通知音').toBeGreaterThan(sounds0);
    await evidence(page, '04-006');
  });
});

// =====================================================================
// 午睡チェック画面：5分ごとの確認
// =====================================================================
test.describe('午睡チェック画面：5分ごとの確認', () => {
  /*
   * 典拠：基本設計書「午睡チェックの実施」(4-8) の処理 5・6 とタイマーの決め方・「午睡チェック」(5-7)・「画面の洗い出しの考え方」(3-1) の基準2、
   *   図/画面詳細図「午睡チェック画面」(5-1) 項目5・9〜11・15 と注記、詳細設計書「全画面に共通する部品と決まり」(2-0) の (6)
   */
  test('04-007 5分ごとの確認を行の上で記録する', async ({ page }) => {
    test.skip(!LONG, LONG_REASON);
    test.setTimeout(4 * 60_000);
    await login(page, 'admin');
    const t0 = await freshSession(page, 'もも組');
    const names = await rowNames(page);
    await page.waitForTimeout(62_000);
    const url = page.url();
    const pressed = new Date();
    const res = await recordCheck(page, names[0]);
    expect(res.ok(), '保存される').toBe(true);
    await expect.soft(page.getByRole('dialog'), '確認のダイアログを出さない').toHaveCount(0);
    expect.soft(page.url(), '別の画面へ移らない').toBe(url);
    const row = napRow(page, names[0]);
    await expect.soft(row.getByRole('status'), '行の見えない status に「保存しました」').toHaveText('保存しました');
    await expect.soft(row, '「最後の確認」が押した時刻').toContainText(new RegExp(`最後の確認.*${anyHm(hmNear(pressed)).source}`));
    await expect.soft(row, '「次の確認」がその5分後').toContainText(new RegExp(`次の確認.*${anyHm([addMinutesHM(pressed, 4), addMinutesHM(pressed, 5), addMinutesHM(pressed, 6)]).source}`));
    const head = await headerText(page);
    expect.soft(head, '上部の「次の確認」は開始時刻＋5分').toMatch(new RegExp(`次の確認.*${anyHm([addMinutesHM(t0, 4), addMinutesHM(t0, 5), addMinutesHM(t0, 6)]).source}`));
    expect.soft(head, '上部の「次の確認」の名前から1人目が外れる').not.toContain(names[0]);
    expect.soft(head, '記録済みが 1').toMatch(/記録済み\s*1\s*\//);
    await expect.soft(row.getByRole('button', { name: '記録する', exact: true }), 'ボタンの表示名「記録する」').toBeVisible();
    const rec = recordsOf(names[0]).at(-1);
    expect(rec, '確認の行').toBeTruthy();
    expect.soft(hmNear(pressed)).toContain(dbHM(rec?.checked_at));
    expect.soft(hmNear(pressed)).toContain(dbHM(rec?.saved_at));
    expect.soft([rec?.body_position, rec?.breathing, rec?.complexion]).toEqual(['1', '1', '1']);
    expect.soft(rec?.staff_id).toBe(staffId('西田 拓也'));
    await evidence(page, '04-007');
  });

  /* 【次の版】典拠：要件定義書「記録時刻の扱いと改ざん防止」(4-5)、基本設計書「午睡チェックの実施」(4-8)・「記録の修正と改ざん防止」(4-8)、図/画面詳細図「午睡チェック画面」(5-1) 項目26・「午睡記録検索画面」(5-3) 項目6・7 */
  test('04-008 チェックした時刻の後追い入力', async ({ page }) => {
    test.skip(!LONG, LONG_REASON);
    test.setTimeout(5 * 60_000);
    await login(page, 'staffSakura');
    const t0 = await freshSession(page);
    const input = napRow(page, '西田 太郎').getByLabel(/チェックした時刻/);
    test.skip((await input.count()) === 0, notImplemented('午睡チェック画面の行に「チェックした時刻」の欄が無い'));
    await page.waitForTimeout(185_000);
    await input.fill(addMinutesHM(t0, 1));
    const pressed = new Date();
    const res = await recordCheck(page, '西田 太郎');
    expect(res.ok()).toBe(true);
    const row = napRow(page, '西田 太郎');
    await expect.soft(row).toContainText(new RegExp(`最後の確認.*${anyHm([addMinutesHM(t0, 1)]).source}`));
    await expect.soft(row).toContainText(new RegExp(`次の確認.*${anyHm([addMinutesHM(t0, 11)]).source}`));
    const rec = recordsOf('西田 太郎').at(-1);
    expect.soft(dbHM(rec?.checked_at)).toBe(addMinutesHM(t0, 1));
    expect.soft(hmNear(pressed)).toContain(dbHM(rec?.saved_at));
    await openSearch(page);
    const line = page.getByRole('main').getByRole('row').filter({ hasText: '西田 太郎' }).filter({ hasText: addMinutesHM(t0, 1) });
    await expect.soft(line.first()).toContainText(dbHM(rec?.saved_at));
    await evidence(page, '04-008');
  });

  /* 典拠：図/画面詳細図「午睡チェック画面」(5-1) 項目14 と注記、詳細設計書「本書で足す文言」(4-1 (6))、要件定義書「品質要求一覧」(7-1 No.5) */
  test('04-009 うつ伏せの注意喚起', async ({ page }) => {
    await login(page, 'admin');
    await freshSession(page, 'もも組');
    const child = (await rowNames(page))[1];
    const row = napRow(page, child);
    await choose(row, '体位', 'うつ伏せ');
    await expect.soft(row).toContainText('うつ伏せです。このまま記録し、仰向けに直したら、直したあとの向きをもう一度記録してください。');
    await expectNoJudgment(row, 'うつ伏せの注意喚起');
    await choose(row, '呼吸', 'あり');
    await choose(row, '顔色', '通常');
    const res = await clickAndWaitNap(page, recordButton(row));
    expect(res.ok(), '記録は妨げられない').toBe(true);
    expect.soft(recordsOf(child).at(-1)?.body_position).toBe('2');
    await evidence(page, '04-009');
  });

  /* 典拠：図/画面詳細図「午睡チェック画面」(5-1) 項目10、要件定義書「午睡チェック」(4-5)（救急要請や保護者への連絡の要否はシステムが判断しない） */
  test('04-010 呼吸 確認できず', async ({ page }) => {
    await login(page, 'admin');
    await freshSession(page, 'もも組');
    const child = (await rowNames(page))[2];
    const row = napRow(page, child);
    await choose(row, '呼吸', '確認できず');
    const text = (await row.innerText()).replace(/\s+/g, '');
    expect.soft(text, '子どもへの対応を促す').toMatch(/子ども.*対応/);
    expect.soft(text, '応援の要請を促す').toContain('応援');
    expect.soft(text, '異常時の記録はそのあとでよい').toMatch(/異常時の記録.*(あと|後)/);
    expect.soft(text, '救急要請の要否をシステムが言わない').not.toMatch(/救急車を呼んで|119/);
    await choose(row, '体位', '仰向け');
    await choose(row, '顔色', '通常');
    const res = await clickAndWaitNap(page, recordButton(row));
    expect(res.ok(), '記録は妨げられない').toBe(true);
    expect.soft(recordsOf(child).at(-1)?.breathing).toBe('2');
    await evidence(page, '04-010');
  });

  /* 典拠：要件定義書「品質要求一覧」(7-1 No.5)・「午睡チェック」(4-5)（体調の記録）、基本設計書「午睡チェックの実施」(4-8)・「画面基本構成」(3-5)、図/画面詳細図「午睡チェック画面」(5-1) 項目12・13 */
  test('04-011 体温と平熱を並べるだけで判定しない', async ({ page }) => {
    await login(page, 'admin');
    await freshSession(page, 'もも組');
    const names = await rowNames(page);
    const [a, b] = [names[0], names[3]];
    for (const [child, temp] of [[a, '38.5'], [b, '36.0']] as const) {
      const res = await recordCheck(page, child, { temp });
      expect(res.ok(), `${child} の確認が保存される`).toBe(true);
      await expect.soft(page.getByRole('dialog'), '範囲の中の値なので確認を促さない').toHaveCount(0);
    }
    const ra = napRow(page, a);
    const rb = napRow(page, b);
    await expect.soft(ra).toContainText('38.5');
    await expect.soft(rb).toContainText('36.0');
    await expect.soft(ra, '平熱が並ぶ').toContainText('平熱');
    await expect.soft(rb, '平熱が並ぶ').toContainText('平熱');
    const look = (r: Locator) => r.evaluate((el) => `${el.className.replace(/\b(saved|recorded|done)\b/g, '')}|${getComputedStyle(el).backgroundColor}|${getComputedStyle(el).color}`);
    expect.soft(await look(ra), '値が違うだけで同じ見え方').toBe(await look(rb));
    await expectNoJudgment(ra, '38.5 の行');
    await expectNoJudgment(rb, '36.0 の行');
    expect.soft(recordsOf(a).at(-1)?.temperature).toBe(38.5);
    expect.soft(recordsOf(b).at(-1)?.temperature).toBe(36);
    await evidence(page, '04-011');
  });

  /* 典拠：基本設計書「午睡チェックの実施」(4-8) の処理 6・「開いている画面への即時の反映（SSE）」(4-10) */
  test('04-012 複数の職員が別々の園児を同時に記録する', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    const a = await loginIn(browser, 'admin');
    await openNap(a.page);
    await expect(endButton(a.page)).toBeVisible();
    const choosing = async (p: Page, child: string) => {
      const row = napRow(p, child);
      await choose(row, '体位', '仰向け');
      await choose(row, '呼吸', 'あり');
      await choose(row, '顔色', '通常');
      return row;
    };
    const rs = await choosing(page, '西田 太郎');
    const ra = await choosing(a.page, '村田 美咲');
    const [r1, r2] = await Promise.all([clickAndWaitNap(page, recordButton(rs)), clickAndWaitNap(a.page, recordButton(ra))]);
    expect(r1.ok() && r2.ok(), 'どちらも保存される').toBe(true);
    const t = recordsOf('西田 太郎').at(-1);
    const m = recordsOf('村田 美咲').at(-1);
    expect.soft(t?.staff_id).toBe(staffId('鈴木 浩之'));
    expect.soft(m?.staff_id).toBe(staffId('西田 拓也'));
    await expect.soft(napRow(page, '村田 美咲'), '一般S の窓に美咲の記録が読み込み直さずに出る').toContainText(new RegExp(anyHm([dbHM(m?.checked_at)]).source));
    await expect.soft(napRow(a.page, '西田 太郎'), '管理者A の窓に太郎の記録が読み込み直さずに出る').toContainText(new RegExp(anyHm([dbHM(t?.checked_at)]).source));
    await evidence(page, '04-012');
    await a.context.close();
  });
});

// =====================================================================
// 午睡チェック画面：ねた・おきた・対象外
// =====================================================================
test.describe('午睡チェック画面：ねた・おきた・対象外', () => {
  /*
   * 典拠：要件定義書「午睡チェック」(4-5) のねた・おきた、基本設計書「ねた・おきた」(4-8)・「入力項目の制約値とメッセージ一覧」(4-12) の末尾（段1の記録・完了の表示）・
   *   「届いていない家庭の一覧（職員ダッシュボード）」(4-5)、図/画面詳細図「午睡チェック画面」(5-1) 項目22、「職員ダッシュボード」(2-6) 項目13
   */
  test('04-013 ねた 1タップ・サーバの時刻', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    const a = await loginIn(browser, 'admin');
    const dashText = async () => (await a.page.getByRole('main').getByRole('row').filter({ hasText: '午睡中の園児' }).allInnerTexts()).join(' / ').replace(/\s+/g, ' ');
    await expect.poll(() => sleepingOnDashboard(a.page).catch(() => Number.NaN), { message: `職員ダッシュボードの「午睡中の園児」を読む（行：${await dashText().catch(() => '読めない')}）` }).not.toBeNaN();
    const before = await sleepingOnDashboard(a.page);
    const pressed = new Date();
    const res = await pressSleep(page, '西田 太郎');
    expect(res.ok()).toBe(true);
    await expect.soft(page.getByRole('dialog'), '確認のダイアログを挟まない').toHaveCount(0);
    const row = napRow(page, '西田 太郎');
    await expect.soft(row, '行に「H:MM ねた」').toContainText(new RegExp(`${anyHm(hmNear(pressed)).source}\\s*ねた`));
    await expect.soft(row.getByRole('button', { name: /^西田 太郎のねた$/ })).toHaveCount(0);
    await expect.soft(row.getByRole('button', { name: /対象外/ })).toHaveCount(0);
    await expect.soft(row.getByRole('button', { name: /おきた$/ })).toBeVisible();
    await expect.soft(page.getByText('保護者が見られる状態です'), '完了の表示（U-02）').toBeVisible();
    await expect.soft(page.getByRole('button', { name: '取り消す', exact: true }), '完了の表示の「取り消す」').toBeVisible();
    expect.soft(await headerText(page), 'クラス全体の状況の「ねた」').toMatch(/ねた\s*1\s*名/);
    const live = await expect.poll(() => sleepingOnDashboard(a.page), { timeout: 10_000 }).toBe(before + 1).then(() => true, () => false);
    if (!live) {
      await a.page.reload();
      const afterReload = await sleepingOnDashboard(a.page);
      expect.soft(live, `職員ダッシュボードの「午睡中の園児」が読み込み直さずに1つ増える（前 ${before}・読み込み直すと ${afterReload}）`).toBe(true);
    }
    const sl = sleepsOf('西田 太郎').at(-1);
    expect(sl).toBeTruthy();
    expect.soft(sl?.nap_session_id).toBe(openSession('さくら組')?.nap_session_id);
    expect.soft(hmNear(pressed)).toContain(dbHM(sl?.slept_at));
    expect.soft(sl?.slept_staff_id).toBe(staffId('鈴木 浩之'));
    expect.soft(sl?.woke_at).toBeNull();
    await evidence(page, '04-013');
    await a.context.close();
  });

  /*
   * 典拠：要件定義書「午睡チェック」(4-5)（体調の記録）、基本設計書「ねた・おきた」(4-8) の処理 2・「メッセージ一覧」(4-12) の体温の入力待ち・「設定マスタ」(5-9) の nap.temperature_required、
   *   図/画面詳細図「午睡チェック画面」(5-1) 項目12・24、詳細設計書「午睡チェック画面」(2-4) の (2)・「午睡（ねた・おきた・対象外）」(4-6) の (2)
   */
  test('04-014 入眠時の体温', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    const g = await loginIn(browser, 'guardian');
    await g.page.goto(`/guardian/contact/${childId('西田 太郎')}`);
    await pressSleep(page, '西田 太郎');
    const slept = sleepsOf('西田 太郎').at(-1);
    const row = napRow(page, '西田 太郎');
    await expect.soft(row, '「ねた」の直後から「体温を入れてください。」').toContainText('体温を入れてください');
    await expect.poll(async () => (await g.page.getByRole('main').innerText()).includes('おひるね中'), { message: '体温の前でも保護者に「おひるね中」が出ている' }).toBe(true);
    const prompt = row.getByText('体温を入れてください');
    if ((await prompt.count()) > 0) {
      await enterTemperature(page, row, '西田 太郎', '36.8');
      await expect.soft(prompt, '体温を入れると消える').toHaveCount(0);
      const after = sleepsOf('西田 太郎').at(-1);
      expect.soft(after?.sleep_temperature).toBe(36.8);
      expect.soft(after?.slept_at, '「ねた」の時刻は変わらない').toBe(slept?.slept_at);
      expect.soft(after?.corrected_at, '訂正の印を付けない').toBeNull();
    }
    await evidence(page, '04-014');
    await g.context.close();
  });

  /* 典拠：要件定義書「午睡チェック」(4-5)、基本設計書「ねた・おきた」(4-8) の処理 4〜6・「ねた・おきた（t_nap_sleep）」(5-7)、図/画面詳細図「午睡チェック画面」(5-1) 項目23、詳細設計書「午睡の園児」(3-4) */
  test('04-015 おきたと もう一度ねた', async ({ page, browser }) => {
    test.skip(!LONG, LONG_REASON);
    test.setTimeout(4 * 60_000);
    await login(page, 'staffSakura');
    await freshSession(page);
    const g = await loginIn(browser, 'guardian');
    await g.page.goto(`/guardian/contact/${childId('西田 太郎')}`);
    await pressSleep(page, '西田 太郎');
    await page.waitForTimeout(62_000);
    const row = napRow(page, '西田 太郎');
    const woke = new Date();
    const res = await clickAndWaitNap(page, row.getByRole('button', { name: /おきた$/ }));
    expect(res.ok()).toBe(true);
    await expect.soft(page.getByRole('dialog')).toHaveCount(0);
    await expect.soft(row, 'おきたの時刻').toContainText(anyHm(hmNear(woke)));
    await expect.soft(row, '寝た長さ（分で切り捨て）').toContainText(/（?1分）?/);
    await expectNoJudgment(row, 'おきたの行');
    expect.soft(await headerText(page), 'クラス全体の状況の「おきた」').toMatch(/おきた\s*1\s*名/);
    const again = row.getByRole('button', { name: /(もう一度)?ねた$/ });
    await expect(again).toBeVisible();
    const second = new Date();
    await clickAndWaitNap(page, again);
    await expect.soft(row).toContainText(new RegExp(`${anyHm(hmNear(second)).source}\\s*ねた`));
    const gm = g.page.getByRole('main');
    await expect.poll(async () => (await gm.innerText()).includes('おひるね中'), { message: '保護者：2組目の「おひるね中」' }).toBe(true);
    await expect.soft(gm, '保護者：1組目のおきたと寝た長さ').toContainText(/おきた（1分）/);
    const rows = sleepsOf('西田 太郎').filter((r) => !r.is_deleted);
    expect.soft(rows.length).toBe(2);
    expect.soft(rows[0]?.woke_at).not.toBeNull();
    expect.soft(rows[0]?.woke_staff_id).toBe(staffId('鈴木 浩之'));
    expect.soft(rows[1]?.woke_at).toBeNull();
    await evidence(page, '04-015');
    await g.context.close();
  });

  /* 典拠：要件定義書「午睡チェック」(4-5) のねた・おきた（「14:40 おきた（1時間35分）」）、基本設計書「ねた・おきた」(4-8) の処理 5・6、図/画面詳細図「午睡チェック画面」(5-1) 項目23 */
  test('04-016 1時間を超える寝た長さ', async ({ page, browser }) => {
    test.skip(jstMinutesOfDay() < 100, '実施の時刻が 01:40 より前のため、95分前が前の日にまたがる');
    await login(page, 'staffSakura');
    await freshSession(page);
    const g = await loginIn(browser, 'guardianKubota');
    await pressSleep(page, '久保田 陸');
    // 【SQL】(W1) 寝た長さを95分にする（読んで同じ形で書く）
    const now = new Date();
    const sl = sleepsOf('久保田 陸').at(-1)!;
    expect(sl.slept_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    sqlRun('UPDATE t_nap_session SET started_at = ? WHERE nap_session_id = ?', jstIso(new Date(now.getTime() - 100 * 60_000)), sl.nap_session_id);
    sqlRun('UPDATE t_nap_sleep SET slept_at = ? WHERE nap_sleep_id = ?', jstIso(new Date(now.getTime() - 95 * 60_000)), sl.nap_sleep_id);
    const row = napRow(page, '久保田 陸');
    const woke = new Date();
    await clickAndWaitNap(page, row.getByRole('button', { name: /おきた$/ }));
    await expect.soft(row).toContainText('1時間35分');
    await g.page.goto(`/guardian/contact/${childId('久保田 陸')}`);
    await expect.soft(g.page.getByRole('main')).toContainText(new RegExp(`${anyHm(hmNear(woke)).source}\\s*おきた（1時間35分）`));
    await expectNoJudgment(g.page.getByRole('main'), '保護者の連絡帳');
    await evidence(page, '04-016');
    await g.context.close();
  });

  /*
   * 典拠：基本設計書「ねた・おきた」(4-8)（押し間違いは連絡帳の取り消し・訂正と同じ規則。その日はその園児のクラスの担任）・「メッセージ一覧」(4-12) の取り消し・削除の確認・
   *   「操作ログ（t_operation_log）」(5-9)、図/画面詳細図「午睡チェック画面」(5-1) 項目27、詳細設計書「訂正・取り消しのまとめ」(3-5)・「午睡」(4-6) の (4)
   */
  test('04-017 ねた・おきたを直す・取り消す', async ({ page, browser }) => {
    test.setTimeout(2 * 60_000);
    await login(page, 'staffSakura');
    await freshSession(page);
    const g = await loginIn(browser, 'guardian');
    await g.page.goto(`/guardian/contact/${childId('西田 太郎')}`);
    const row = napRow(page, '西田 太郎');
    // 前提：1組目（ねた・おきた）
    await pressSleep(page, '西田 太郎');
    await clickAndWaitNap(page, row.getByRole('button', { name: /おきた$/ }));
    const first = sleepsOf('西田 太郎').at(-1)!;
    // 一般M（押した職員ではない担任）が直す：ねたを1分早める
    const m = await newWindow(browser);
    await loginMurata(m.page);
    await openNap(m.page);
    const mrow = napRow(m.page, '西田 太郎');
    await mrow.getByRole('button', { name: /直す・取り消す|直す/ }).first().click();
    const fix = m.page.getByRole('dialog', { name: /直す/ });
    await expect(fix).toBeVisible();
    const newSlept = jstHM(new Date(Date.parse(`${first.slept_at}+09:00`) - 60_000));
    await fix.getByRole('textbox', { name: /ねた時刻/ }).fill(newSlept);
    const r1 = await clickAndWaitNap(m.page, fix.getByRole('button', { name: '直す', exact: true }));
    expect.soft(r1.ok(), '押した職員ではない担任が直せる').toBe(true);
    await expect.soft(mrow).toContainText(newSlept);
    await expect.poll(async () => (await g.page.getByRole('main').innerText()).includes(newSlept), { message: '保護者の連絡帳が新しい時刻になる' }).toBe(true);
    await expect.soft(g.page.getByRole('main'), '保護者に「訂正しました（H:MM）」').toContainText(/訂正しました（\d{1,2}:\d{2}）/);
    await expect.soft(g.page.getByRole('main'), '押した職員の名前は保護者に出ない').not.toContainText(/鈴木|村田 真一/);
    // 2組目を作って、一般M が取り消す
    await clickAndWaitNap(page, row.getByRole('button', { name: /(もう一度)?ねた$/ }));
    await expect.poll(async () => (await g.page.getByRole('main').innerText()).includes('おひるね中')).toBe(true);
    await m.page.reload();
    await mrow.getByRole('button', { name: /直す・取り消す|取り消す/ }).first().click();
    const fix2 = m.page.getByRole('dialog').first();
    await fix2.getByRole('button', { name: /取り消す/ }).first().click();
    const confirm = m.page.getByRole('dialog').filter({ hasText: /読んでいます|取り消/ }).last();
    await expect.soft(confirm, '取り消しの確認の文').toContainText(/いま保護者 \d+ 家庭（\d+ 名）が読んでいます。取り消しても、読まれた内容は取り消せません。/);
    const r2 = await clickAndWaitNap(m.page, confirm.getByRole('button', { name: /取り消す/ }).last());
    expect.soft(r2.ok()).toBe(true);
    await expect.poll(async () => (await g.page.getByRole('main').innerText()).includes('おひるね中'), { message: '保護者の連絡帳から2組目の「おひるね中」が消える' }).toBe(false);
    const rows = sleepsOf('西田 太郎');
    const p1 = rows.find((r) => r.nap_sleep_id === first.nap_sleep_id);
    const p2 = rows.at(-1);
    expect.soft(p1?.corrected_at, '1組目に訂正の時刻').not.toBeNull();
    expect.soft(p1?.slept_staff_id, '押した職員は書き換えない').toBe(staffId('鈴木 浩之'));
    expect.soft(p2?.is_deleted).toBe(1);
    const logs = sqlAll<{ operation_type: string; target_table: string; before_value: string | null }>(
      "SELECT operation_type, target_table, before_value FROM t_operation_log WHERE function_type = '3' AND target_table = 't_nap_sleep' ORDER BY operation_log_id",
    );
    expect.soft(logs.some((l) => l.operation_type === '2' && (l.before_value ?? '').length > 0), '訂正の操作ログ（元の値）').toBe(true);
    expect.soft(logs.some((l) => l.operation_type === '4'), '取り消しの操作ログ').toBe(true);
    await evidence(m.page, '04-017');
    await m.context.close();
    await g.context.close();
  });

  /* 典拠：要件定義書「午睡チェック」(4-5)（きょうは対象外）、基本設計書「きょうは対象外」(4-8)・「きょうは対象外（t_nap_exclusion）」(5-7)、図/画面詳細図「午睡チェック画面」(5-1) 項目5・25、詳細設計書「午睡チェック画面」(2-4) の (2)（D-41） */
  test('04-018 きょうは対象外と 戻す', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    const n = enrolledCount('さくら組');
    const row = napRow(page, '村田 美咲');
    const res = await exclude(page, '村田 美咲', '欠席');
    expect(res.ok()).toBe(true);
    await expect.soft(row, '「きょうは対象外（欠席）」').toContainText(/きょうは対象外/);
    await expect.soft(row).toContainText('欠席');
    await expect.soft(row.getByRole('button', { name: /のねた$/ })).toHaveCount(0);
    await expect.soft(row.getByRole('button', { name: /きょうは対象外にする/ })).toHaveCount(0);
    const back = row.getByRole('button', { name: /戻す/ });
    await expect(back).toBeVisible();
    let head = await headerText(page);
    expect.soft(head, 'クラス全体の状況の対象外（欠席 1）').toMatch(/対象外\s*1\s*名/);
    expect.soft(head, '対象人数が1つ減る').toMatch(new RegExp(`/\\s*${n - 1}\\s*名`));
    expect.soft(head, '「次の確認」の名前から外れる').not.toContain('村田 美咲');
    // 対象外の行でも確認を記録できる（D-41）
    const rec = await recordCheck(page, '村田 美咲');
    expect.soft(rec.ok(), '対象外の行で記録できる').toBe(true);
    expect.soft(recordsOf('村田 美咲', openSession('さくら組')?.nap_session_id).length).toBe(1);
    expect.soft(await headerText(page), '美咲は「次の確認」の名前に戻らない').not.toContain('村田 美咲');
    const ex = sqlOne<{ reason: string; staff_id: string; is_deleted: number; nap_exclusion_id: number }>('SELECT * FROM t_nap_exclusion WHERE child_id = ? ORDER BY nap_exclusion_id DESC LIMIT 1', childId('村田 美咲'));
    expect.soft(ex?.reason).toBe('1');
    expect.soft(ex?.staff_id).toBe(staffId('鈴木 浩之'));
    // 戻す
    await clickAndWaitNap(page, back);
    await expect.soft(row.getByRole('button', { name: /のねた$/ })).toBeVisible();
    await expect.soft(row.getByRole('button', { name: /きょうは対象外にする/ })).toBeVisible();
    head = await headerText(page);
    expect.soft(head, '対象人数が戻る').toMatch(new RegExp(`/\\s*${n}\\s*名`));
    expect.soft(sqlOne<{ is_deleted: number }>('SELECT is_deleted FROM t_nap_exclusion WHERE nap_exclusion_id = ?', ex?.nap_exclusion_id ?? 0)?.is_deleted).toBe(1);
    await evidence(page, '04-018');
  });

  /* 典拠：基本設計書「きょうは対象外」(4-8)・「メッセージ一覧」(4-12)、図/画面詳細図「午睡チェック画面」(5-1) 項目22・25、詳細設計書「午睡の園児」(3-4)・「午睡」(4-6) の (1)・「本書で足す文言」(4-1 (6)) */
  test('04-019 行き違い ねたと対象外', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    const a = await loginIn(browser, 'admin');
    await openNap(a.page);
    await stopEvents(page);
    await page.reload();
    await expect(endButton(page)).toBeVisible();
    // (a) 対象外の理由を選ぶ前に、別の窓で「ねた」
    await page.getByRole('button', { name: /^遠藤 花子をきょうは対象外/ }).click();
    const dlg = page.getByRole('dialog', { name: /遠藤 花子/ });
    await expect(dlg).toBeVisible();
    await pressSleep(a.page, '遠藤 花子');
    const ra = await clickAndWaitNap(page, dlg.getByRole('button', { name: '欠席', exact: true }));
    const bodyA = await ra.text().catch(() => '');
    const shownA = await page.getByText(/[「『]ねた[」』]を記録した園児は対象外にできません/).filter({ visible: true }).allInnerTexts();
    await expect.soft(page.getByText('「ねた」を記録した園児は対象外にできません。').first(), `(a) 画面に文言が出る（応答 ${ra.status()} ${bodyA.slice(0, 160)}。画面に出た近い文：${JSON.stringify(shownA)}）`).toBeVisible();
    expect.soft(sqlAll("SELECT 1 FROM t_nap_exclusion WHERE child_id = ? AND is_deleted = 0", childId('遠藤 花子')).length, '花子は対象外にならない').toBe(0);
    await page.keyboard.press('Escape');
    // (b) 対象外になった子に、古い画面から「ねた」
    await page.reload();
    await expect(endButton(page)).toBeVisible();
    await exclude(a.page, '久保田 陸', '欠席');
    const rb = await pressSleep(page, '久保田 陸');
    const bodyB = await rb.text().catch(() => '');
    const shownB = await page.getByText(/対象外になっています/).filter({ visible: true }).allInnerTexts();
    await expect.soft(page.getByText('この園児は対象外になっています。戻してから押してください。').first(), `(b) 画面に文言が出る（応答 ${rb.status()} ${bodyB.slice(0, 160)}。画面に出た近い文：${JSON.stringify(shownB)}）`).toBeVisible();
    expect.soft(sleepsOf('久保田 陸').filter((r) => !r.is_deleted).length, '陸のねたは記録されない').toBe(0);
    await page.unroute('**/api/events**');
    await page.reload();
    await expect.soft(napRow(page, '遠藤 花子')).toContainText('ねた');
    await expect.soft(napRow(page, '久保田 陸')).toContainText('対象外');
    await evidence(page, '04-019');
    await a.context.close();
  });

  /* 典拠：授業の雛形 1.5（二重送信の防止）、基本設計書「ねた・おきた（t_nap_sleep）」(5-7) の一意制約、詳細設計書「全画面に共通する部品と決まり」(2-0) の (2)・「午睡の園児」(3-4)・「本書で足す文言」(4-1 (6)) */
  test('04-020 二重のねた', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    // (a) すばやく2回押す
    await page.getByRole('button', { name: '久保田 陸のねた', exact: true }).dblclick();
    await page.waitForTimeout(1500);
    expect.soft(sleepsOf('久保田 陸').filter((r) => !r.is_deleted && !r.woke_at).length, '陸の「ねた」は1つだけ').toBe(1);
    // (b) 2つの窓でほぼ同時に
    const a = await loginIn(browser, 'admin');
    await stopEvents(page);
    await stopEvents(a.page);
    await page.reload();
    await openNap(a.page);
    const b1 = page.getByRole('button', { name: '遠藤 花子のねた', exact: true });
    const b2 = a.page.getByRole('button', { name: '遠藤 花子のねた', exact: true });
    await Promise.all([b1.click(), b2.click()]);
    const msg = 'すでに「ねた」が記録されています。画面を読み込み直してください。';
    await expect.poll(async () => (await page.getByText(msg).count()) + (await a.page.getByText(msg).count()), { message: 'もう片方に文言が出る' }).toBeGreaterThan(0);
    expect.soft(sleepsOf('遠藤 花子').filter((r) => !r.is_deleted && !r.woke_at).length, '花子の「ねた」は1つだけ').toBe(1);
    await evidence(page, '04-020');
    await a.context.close();
  });
});

// =====================================================================
// 午睡チェック画面：終了・担当交代・ログアウト
// =====================================================================
test.describe('午睡チェック画面：終了・担当交代・ログアウト', () => {
  /* 典拠：基本設計書「午睡チェックの実施」(4-8) の処理 7〜9・「メッセージ一覧」(4-12)・「午睡チェック」(5-7)、図/画面詳細図「午睡チェック画面」(5-1) 項目6、詳細設計書「午睡チェック画面」(2-4) の (2)・「午睡の園児」(3-4) */
  test('04-021 終了の確かめ', async ({ page }) => {
    await login(page, 'admin');
    await freshSession(page, 'もも組');
    const [c1, c2, c3, c4] = await rowNames(page);
    await pressSleep(page, c1);
    await recordCheck(page, c1);
    await recordCheck(page, c2);
    await exclude(page, c3, '午睡なし');
    await exclude(page, c4, '午睡なし');
    await endButton(page).click();
    const dlg = page.getByRole('dialog').first();
    await expect(dlg).toBeVisible();
    await expect.soft(dlg).toContainText(`「おきた」が記録されていない園児がいます（${c1}）。このまま終了しますか。`);
    await dlg.getByRole('button', { name: 'やめる' }).click();
    await expect.soft(endButton(page), 'やめると実施中のまま').toBeVisible();
    await endButton(page).click();
    const ended = new Date();
    await clickAndWaitNap(page, page.getByRole('dialog').first().getByRole('button', { name: /終了/ }).last());
    await expect(startButton(page), '「午睡チェックを開始する」が出る').toBeVisible();
    await expect.soft(page.getByRole('button', { name: /のねた$|おきた$|きょうは対象外にする/ }), '行の記録のボタンが消える').toHaveCount(0);
    await expect.soft(napMain(page), '1人目の行は「H:MM ねた（おきたが未記録）」').toContainText(/ねた（おきたが未記録）/);
    const s = sessionsOf('もも組', jstToday()).at(-1);
    expect.soft(hmNear(ended)).toContain(dbHM(s?.ended_at));
    expect.soft(s?.ended_staff_id).toBe(staffId('西田 拓也'));
    expect.soft(s?.is_auto_closed).toBe(0);
    expect.soft(sleepsOf(c1).at(-1)?.woke_at, 'おきたは推測で入らない').toBeNull();
    await evidence(page, '04-021');
  });

  /* 典拠：要件定義書「記録時刻の扱いと改ざん防止」(4-5)、基本設計書「午睡チェックの実施」(4-8)・「メッセージ一覧」(4-12)・「午睡チェック」(5-7)、図/画面詳細図「午睡チェック画面」(5-1) の注記、詳細設計書「午睡チェック画面」(2-4) の (2) */
  test('04-022 終了した実施へは記録できない', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await stopEvents(page);
    await page.reload();
    await expect(endButton(page)).toBeVisible();
    const a = await loginIn(browser, 'admin');
    await openNap(a.page);
    await endIfRunning(a.page);
    const msg = '午睡チェックは終了しています。画面を読み込み直してください。';
    const row = napRow(page, '西田 太郎');
    await choose(row, '体位', '仰向け');
    await choose(row, '呼吸', 'あり');
    await choose(row, '顔色', '通常');
    const r1 = await clickAndWaitNap(page, recordButton(row));
    const b1 = await r1.text().catch(() => '');
    expect.soft(r1.ok(), '確認は保存されない').toBe(false);
    const alerts1 = await page.getByRole('alert').filter({ visible: true }).allInnerTexts();
    await expect.soft(page.getByText(msg).first(), `確認：文言が出る（応答 ${r1.status()} ${b1.slice(0, 160)}。画面の警告：${JSON.stringify(alerts1)}）`).toBeVisible();
    if (await pressSleepVisible(page, '久保田 陸')) {
      const r2 = await pressSleep(page, '久保田 陸');
      const b2 = await r2.text().catch(() => '');
      expect.soft(r2.ok(), '「ねた」は記録されない').toBe(false);
      await expect.soft(page.getByText(msg).first(), `ねた：文言が出る（応答 ${r2.status()} ${b2.slice(0, 160)}）`).toBeVisible();
    }
    const sid = sessionsOf('さくら組', jstToday()).at(-1)?.nap_session_id ?? 0;
    expect.soft(recordsOf('西田 太郎', sid).length).toBe(0);
    expect.soft(sleepsOf('久保田 陸').filter((r) => r.nap_session_id === sid).length).toBe(0);
    await evidence(page, '04-022');
    await page.unroute('**/api/events**');
    await page.reload();
    await expect.soft(startButton(page), '読み込み直すと終わった表示').toBeVisible();
    await a.context.close();
  });

  /*
   * 典拠：基本設計書「午睡チェックの実施」(4-8)（終了操作を忘れた場合は時間帯の終了時刻で自動的に解除する。「おきた」は推測で入れない）・「設定マスタ」(5-9) の nap.time_range・「午睡チェック」(5-7)、
   *   図/画面詳細図「午睡チェック画面」(5-1) 項目21、詳細設計書「午睡の園児」(3-4)
   * 前提：時間帯の終わりを2分後にする。設定画面に午睡の欄が無いので、設定マスタを書き換えて作る
   */
  test('04-023 時間帯の終わりで自動で終了する', async ({ page, browser }) => {
    test.skip(!LONG, LONG_REASON);
    test.skip(jstMinutesOfDay() > 23 * 60 + 55, '実施の時刻が 23:55 より後（時間帯は同じ日の中で終わる）');
    test.setTimeout(8 * 60_000);
    const end = addMinutesHM(new Date(), 2);
    setSetting('nap.time_range', `00:00-${end}`);
    await login(page, 'staffSakura');
    await freshSession(page);
    const g = await loginIn(browser, 'guardian');
    await g.page.goto(`/guardian/contact/${childId('西田 太郎')}`);
    await pressSleep(page, '西田 太郎');
    const sl = sleepsOf('西田 太郎').at(-1)!;
    await expect.poll(async () => {
      await page.reload();
      return startButton(page).isVisible();
    }, { timeout: 5 * 60_000, intervals: [20_000], message: '時間帯の終わりを過ぎると実施が解除される' }).toBe(true);
    await expect.soft(napMain(page), '自動で終了した旨').toContainText(/自動/);
    await expect.soft(napMain(page), '太郎の行は「H:MM ねた（おきたが未記録）」').toContainText(/ねた（おきたが未記録）/);
    const r = await page.getByRole('button', { name: '村田 美咲のねた', exact: true }).count();
    expect.soft(r, '終わった実施へは記録できない（ボタンが出ない）').toBe(0);
    await g.page.reload();
    const gm = g.page.getByRole('main');
    await expect.soft(gm).toContainText(new RegExp(`${anyHm([dbHM(sl.slept_at)]).source}\\s*ねた`));
    await expect.soft(gm, '「おひるね中」は出ない').not.toContainText('おひるね中');
    await expect.soft(gm, '常に添える文').toContainText('おひるねの間は、決められた間隔で呼吸や体の向きを確かめています。いつもと違うことがあれば、園からお電話します');
    const s = sessionsOf('さくら組', jstToday()).at(-1);
    expect.soft(s?.is_auto_closed).toBe(1);
    expect.soft(dbHM(s?.ended_at)).toBe(end);
    expect.soft(sleepsOf('西田 太郎').at(-1)?.woke_at).toBeNull();
    await evidence(page, '04-023');
    await g.context.close();
  });

  /* 典拠：基本設計書「午睡チェックの実施」(4-8)（担当を交代する場合は、終了→ログアウト→次の職員がログイン→開始）、要件定義書「端末の利用形態と本人特定」(4-1-4 (4))、図/画面詳細図「午睡チェック画面」(5-1) 項目2 */
  test('04-024 担当交代', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await endIfRunning(page);
    await page.getByRole('banner').getByRole('button', { name: 'ログアウト' }).click();
    const ok = page.getByRole('dialog').getByRole('button', { name: /ログアウト/ });
    if (await ok.isVisible().catch(() => false)) await ok.click();
    await expect(page.getByLabel('ログインID', { exact: true }), '終了のあとはログアウトできる').toBeVisible();
    await login(page, 'admin');
    await openNap(page);
    await chooseClass(page, 'さくら組');
    await expect(startButton(page), '「午睡チェックを開始する」が出る').toBeVisible();
    await startButton(page).click();
    await expect(endButton(page)).toBeVisible();
    expect.soft(await headerText(page), '記録者が「西田 拓也」').toMatch(/記録者[：:]\s*西田 拓也/);
    const ss = sessionsOf('さくら組', jstToday());
    const [prev, cur] = ss.slice(-2);
    expect.soft(prev?.started_staff_id).toBe(staffId('鈴木 浩之'));
    expect.soft(prev?.ended_at).not.toBeNull();
    expect.soft(cur?.started_staff_id).toBe(staffId('西田 拓也'));
    expect.soft(cur?.ended_at).toBeNull();
    await evidence(page, '04-024');
  });

  /* 典拠：基本設計書「ログアウト」(4-3)、図/画面詳細図「全画面に共通する規定」(0-2) のログアウト・「職員（タブレット／PC）」(1-1) 項目4 */
  test('04-025 実施中のログアウトは止める', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.getByRole('banner').getByRole('button', { name: 'ログアウト' }).click();
    await page.waitForTimeout(1500);
    await expect.soft(page.getByText(/午睡チェック.*終了/).first(), '先に午睡チェックを終了するよう示す').toBeVisible();
    await expect.soft(page.getByLabel('ログインID', { exact: true }), 'ログアウトしない').toHaveCount(0);
    await expect.soft(endButton(page), '午睡チェック画面のまま、実施中のまま').toBeVisible();
    expect.soft(openSession('さくら組')?.ended_at ?? null).toBeNull();
    await evidence(page, '04-025');
  });

  /*
   * 典拠：基本設計書「午睡チェックの実施」(4-8) の処理 2・9・「ログイン」(4-3)（自動ログアウトは職員の画面に限る）・「設定マスタ」(5-9) の ui.auto_logout_minutes、図/画面遷移図「午睡チェック」(6)
   * 前提：自動ログアウトまでの時間を5分にする。設定画面に欄が無いので、設定マスタを書き換えて作る
   */
  test('04-026 実施中は自動ログアウトしない', async ({ page }) => {
    test.skip(!LONG, LONG_REASON);
    test.setTimeout(16 * 60_000);
    setSetting('ui.auto_logout_minutes', '5');
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.waitForTimeout(6 * 60_000);
    await expect.soft(endButton(page), '実施中の6分のあともログイン中').toBeVisible();
    const res = await recordCheck(page, '西田 太郎');
    expect.soft(res.ok(), '「記録する」で保存される').toBe(true);
    await endIfRunning(page);
    await page.waitForTimeout(6 * 60_000);
    await page.reload();
    await expect.soft(page.getByLabel('ログインID', { exact: true }), '終了してからの6分のあとは自動でログアウトされる').toBeVisible({ timeout: 20_000 });
    await evidence(page, '04-026');
  });
});

// =====================================================================
// 午睡チェック画面：つながり・時刻
// =====================================================================
test.describe('午睡チェック画面：つながり・時刻', () => {
  /* 典拠：基本設計書「つながっているかの表示」(3-5)・「メッセージ一覧」(4-12)、図/画面詳細図「午睡チェック画面」(5-1) 項目28、詳細設計書「全画面に共通する部品と決まり」(2-0) の (2) */
  test('04-027 サーバに届かないとき', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    const timerBefore = await headerText(page);
    await page.context().setOffline(true);
    await page.getByRole('button', { name: '久保田 陸のねた', exact: true }).click();
    await expect.soft(page.getByText(/サーバにつながりません。?記録は保存されていません/).first(), '警告の文').toBeVisible({ timeout: 20_000 });
    const tops = await page.getByText(/サーバにつながりません/).evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => ({ y: r.y, h: r.height })));
    expect.soft(tops.some((r) => r.y < 160 && r.h >= 24), `画面の上端に大きく出す（出ている位置と高さ：${JSON.stringify(tops)}）`).toBe(true);
    const again = page.getByRole('button', { name: /もう一度送る/ }).or(page.getByText('もう一度送る', { exact: true }));
    await expect.soft(again.first(), '「もう一度送る」').toBeVisible();
    await expect.soft(napRow(page, '久保田 陸'), '行の状態は変わらない').not.toContainText(/\d{1,2}:\d{2}\s*ねた/);
    await page.waitForTimeout(30_000);
    expect.soft(await headerText(page), 'タイマーの残り時間は減り続ける').not.toBe(timerBefore);
    await evidence(page, '04-027');
    await page.context().setOffline(false);
    if (await again.count()) await again.first().click();
    await expect.poll(() => sleepsOf('久保田 陸').filter((r) => !r.is_deleted).length, { message: '戻して「もう一度送る」で1件だけ記録される' }).toBe(1);
    await expect.soft(page.getByText('サーバにつながりません。記録は保存されていません')).toHaveCount(0);
  });

  /* 典拠：要件定義書「品質要求一覧」(7-1 No.8)・「記録時刻の扱いと改ざん防止」(4-5)、基本設計書「時刻と日付の扱い」(4-2)・「日付と時刻の扱い」(6-3)、図/画面詳細図「全画面に共通する規定」(0-2) の時刻・「午睡チェック画面」(5-1) 項目4 */
  test('04-028 記録の時刻はサーバの時刻', async ({ browser }) => {
    const w = await newWindow(browser, 'staff', { timezoneId: 'UTC' });
    await w.page.clock.setSystemTime(new Date(Date.now() + 3 * 3600_000));
    await login(w.page, 'admin');
    const t0 = await freshSession(w.page, 'もも組');
    const child = (await rowNames(w.page))[0];
    await pressSleep(w.page, child);
    const head = await headerText(w.page);
    expect.soft(head, '開始時刻はサーバの時刻（JST）').toMatch(new RegExp(`開始\\s*${anyHm(hmNear(t0)).source}`));
    expect.soft(head, '経過時間は0分台').toMatch(/経過\s*0:0\d/);
    expect.soft(head, '次の確認は開始時刻＋5分').toMatch(new RegExp(`次の確認.*${anyHm([addMinutesHM(t0, 4), addMinutesHM(t0, 5), addMinutesHM(t0, 6)]).source}`));
    await expect.soft(napRow(w.page, child)).toContainText(new RegExp(`${anyHm(hmNear(t0)).source}\\s*ねた`));
    expect.soft(hmNear(t0)).toContain(dbHM(openSession('もも組')?.started_at));
    expect.soft(hmNear(t0)).toContain(dbHM(sleepsOf(child).at(-1)?.slept_at));
    await evidence(w.page, '04-028');
    await w.context.close();
  });
});

// =====================================================================
// 異常時記録画面
// =====================================================================
test.describe('異常時記録画面', () => {
  /* 典拠：要件定義書「午睡チェック」(4-5)（異常時の記録）、基本設計書「異常時の記録」(4-8)・「足した列」(5-7)、図/画面詳細図「異常時記録画面」(5-2) 項目2〜8・11、「午睡チェック画面」(5-1) 項目5・17、図/画面遷移図「午睡チェック」(6) */
  test('04-029 異常時の記録を残す', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    const diariesBefore = sqlAll("SELECT 1 FROM t_diary WHERE record_type = '4' AND is_deleted = 0").length;
    await napMain(page).getByRole('link', { name: '異常を記録する' }).or(napMain(page).getByRole('button', { name: '異常を記録する' })).click();
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: /異常時の記録/ }).first()).toBeVisible();
    const found = await main.getByRole('textbox', { name: /発見時刻/ }).inputValue();
    expect.soft(hmNear()).toContain(found.slice(11, 16));
    await expect.soft(main, '注意書き：通知の到達は保証されない').toContainText(/届かない|保証/);
    await expect.soft(main, '注意書き：口頭の応援要請を並行する').toContainText('応援');
    const res = await recordAbnormal(page, '村田 美咲', '受入テスト 04-029 状況', '受入テスト 04-029 対応');
    expect(res.ok()).toBe(true);
    await expect.soft(main.getByRole('textbox', { name: /発見時の状況/ }), '入力が空に戻る').toHaveValue('');
    const row = abnormalRow(page, '受入テスト 04-029 状況');
    await expect(row).toHaveCount(1);
    await expect.soft(row).toContainText('村田 美咲');
    await expect.soft(row).toContainText('受入テスト 04-029 対応');
    await expect.soft(row).toContainText('鈴木 浩之');
    await expect.soft(row.getByRole('button', { name: '起票する' })).toBeVisible();
    const ab = abnormalsOf('村田 美咲').at(-1)!;
    await expect.soft(main, '保存時刻が発見時刻と別に出る').toContainText('保存時刻');
    await main.getByRole('link', { name: /午睡チェックへ/ }).click();
    await expect.soft(endButton(page), '午睡チェック画面は実施中のまま').toBeVisible();
    const mr = napRow(page, '村田 美咲');
    const emphasized = ((await mr.innerText()) + (await headerText(page))).includes('異常');
    expect.soft(emphasized, 'クラス全体の状況に異常時の記録が強調して出る').toBe(true);
    expect.soft(sqlAll("SELECT 1 FROM t_diary WHERE record_type = '4' AND is_deleted = 0").length, 'ヒヤリハットは自動では作られない').toBe(diariesBefore);
    expect.soft(ab.found_at).toBeTruthy();
    expect.soft(ab.recorded_at).toBeTruthy();
    expect.soft(ab.staff_id).toBe(staffId('鈴木 浩之'));
    expect.soft(ab.diary_id).toBeNull();
    expect.soft([ab.guardian_notice, ab.guardian_noticed_at, ab.guardian_notice_method, ab.guardian_notice_person]).toEqual([null, null, null, null]);
    await evidence(page, '04-029');
  });

  /* 【次の版】典拠：要件定義書「午睡チェック」(4-5) の異常時の記録の受け手、基本設計書「異常時の記録の受け手」(4-8)・「画面基本構成」(3-5)、図/画面詳細図「職員（タブレット／PC）」(1-1) 項目10、「職員ダッシュボード」(2-6) 項目14 */
  test('04-030 管理者のヘッダの件数と通知音', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    const a = await newWindow(browser);
    await countSounds(a.context);
    await login(a.page, 'admin');
    await a.page.goto('/staff/diary');
    const b = await newWindow(browser);
    await countSounds(b.context);
    await login(b.page, 'admin2');
    const c = await unconfirmedInHeader(a.page);
    const sA = await soundCount(a.page);
    await page.goto('/staff/nap/abnormal');
    await recordAbnormal(page, '村田 美咲', '受入テスト 04-030 状況', '受入テスト 04-030 対応');
    const appeared = await expect.poll(() => unconfirmedInHeader(a.page), { timeout: 15_000 }).toBe(c + 1).then(() => true, () => false);
    if (!appeared) {
      await a.page.reload();
      const afterReload = await unconfirmedInHeader(a.page);
      test.skip(afterReload === 0 && !(await a.page.getByRole('banner').innerText()).includes('異常時の記録'), notImplemented('管理者のヘッダに「異常時の記録（未確認）」が出ない'));
      expect.soft(afterReload, '読み込み直さずに件数が出る').toBe(c + 1);
    }
    await expect.poll(() => unconfirmedInHeader(b.page), { message: '管理者B のヘッダにも出る' }).toBe(c + 1);
    expect.soft(await soundCount(a.page), '通知音を鳴らす').toBeGreaterThan(sA);
    expect.soft(await unconfirmedInHeader(page), '一般のヘッダには出ない').toBe(0);
    await a.page.getByRole('banner').getByRole('button', { name: /異常時の記録/ }).or(a.page.getByRole('banner').getByRole('link', { name: /異常時の記録/ })).first().click();
    await expect.soft(a.page.getByRole('heading', { name: /異常時の記録/ }).first(), '異常時記録画面へ移る').toBeVisible();
    await evidence(a.page, '04-030');
    await a.context.close();
    await b.context.close();
  });

  /* 【次の版】典拠：要件定義書「午睡チェック」(4-5)、基本設計書「異常時の記録の受け手」(4-8) の処理 3・4・「権限と利用可能機能」(6-1)、図/画面詳細図「異常時記録画面」(5-2) 項目14 */
  test('04-031 管理者の確認した', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.goto('/staff/nap/abnormal');
    await recordAbnormal(page, '村田 美咲', '受入テスト 04-031 状況', '受入テスト 04-031 対応');
    const b = await loginIn(browser, 'admin2');
    await b.page.goto('/staff/nap/abnormal');
    await expect(abnormalRow(b.page, '受入テスト 04-031 状況')).toHaveCount(1);
    const confirmBtn = abnormalRow(b.page, '受入テスト 04-031 状況').getByRole('button', { name: /確認した/ });
    test.skip((await confirmBtn.count()) === 0, notImplemented('異常時記録画面に、管理者の「確認した」が無い'));
    const a = await loginIn(browser, 'admin');
    const c = await unconfirmedInHeader(a.page);
    await clickAndWaitNap(b.page, confirmBtn);
    await expect.soft(abnormalRow(b.page, '受入テスト 04-031 状況')).toContainText(/確認した（.*遠藤.*\d{1,2}:\d{2}）/);
    await expect.poll(() => unconfirmedInHeader(a.page), { message: 'ほかの管理者のヘッダからも外れる' }).toBe(Math.max(c - 1, 0));
    await page.reload();
    await expect.soft(page.getByRole('main').getByRole('button', { name: /確認した/ }), '一般には「確認した」が出ない').toHaveCount(0);
    const ab = abnormalsOf('村田 美咲').at(-1);
    expect.soft(ab && (ab as unknown as { confirmed_staff_id?: string }).confirmed_staff_id).toBe(staffId('遠藤 直人'));
    await evidence(b.page, '04-031');
    await a.context.close();
    await b.context.close();
  });

  /* 【次の版】典拠：要件定義書「午睡チェック」(4-5)、基本設計書「異常時の記録」(4-8) の処理 1・「入力項目の制約値」(4-12) の保護者への連絡・「足した列」(5-7)、図/画面詳細図「異常時記録画面」(5-2) 項目13 */
  test('04-032 保護者への連絡を残す', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.goto('/staff/nap/abnormal');
    await recordAbnormal(page, '村田 美咲', '受入テスト 04-032 状況1', '受入テスト 04-032 対応1');
    const row = abnormalRow(page, '受入テスト 04-032 状況1');
    const add = row.getByRole('button', { name: /保護者への連絡|連絡/ });
    expect.soft(await add.count(), '記録のあとから保護者への連絡を足す口がある（あとから足してよい）').toBeGreaterThan(0);
    if (await add.count()) {
      await add.first().click();
      const area = page.getByRole('dialog').first();
      await area.getByText('した', { exact: true }).click();
      await area.getByLabel(/日時/).fill(jstIso(new Date(Date.now() - 4 * 60_000)).slice(0, 16));
      await area.getByLabel(/手段/).selectOption({ label: '電話' });
      await area.getByLabel(/相手/).fill('母（勤務先）');
      await clickAndWaitNap(page, area.getByRole('button', { name: /残す|保存|記録/ }).first());
      await expect.soft(abnormalRow(page, '受入テスト 04-032 状況1')).toContainText('母（勤務先）');
      const ab = abnormalsOf('村田 美咲').find((r) => r.situation.includes('状況1'));
      expect.soft([ab?.guardian_notice, ab?.guardian_notice_method, ab?.guardian_notice_person]).toEqual(['1', '1', '母（勤務先）']);
    }
    await recordAbnormal(page, '村田 美咲', '受入テスト 04-032 状況2', '受入テスト 04-032 対応2', 'しない');
    await expect.soft(abnormalRow(page, '受入テスト 04-032 状況2'), '「しない」が出る').toContainText('しない');
    const ab2 = abnormalsOf('村田 美咲').find((r) => r.situation.includes('状況2'));
    expect.soft([ab2?.guardian_notice, ab2?.guardian_noticed_at, ab2?.guardian_notice_method, ab2?.guardian_notice_person]).toEqual(['2', null, null, null]);
    await evidence(page, '04-032');
  });

  /* 典拠：要件定義書「午睡チェック」(4-5)、基本設計書「異常時の記録」(4-8) の処理 3〜5、図/画面詳細図「異常時記録画面」(5-2) 項目9・12、図/画面遷移図「午睡チェック」(6) */
  test('04-033 ヒヤリハットの下書きを起票する', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.goto('/staff/nap/abnormal');
    await recordAbnormal(page, '村田 美咲', '受入テスト 04-033 状況', '受入テスト 04-033 対応', 'しない');
    await abnormalRow(page, '受入テスト 04-033 状況').getByRole('button', { name: '起票する' }).click();
    await page.waitForURL(/\/staff\/diary/, { timeout: 15_000 });
    const main = page.getByRole('main');
    await expect.soft(main).toContainText('ヒヤリハット');
    await expect.soft(main).toContainText('村田 美咲');
    const body = await main.evaluate((el) => {
      const values = [...el.querySelectorAll('input, textarea, select')].map((e) => (e as HTMLInputElement).value);
      return `${el.textContent ?? ''} ${values.join(' ')}`;
    });
    expect.soft(body, '状況を引き継ぐ').toContain('受入テスト 04-033 状況');
    expect.soft(body, 'とった対応を引き継ぐ').toContain('受入テスト 04-033 対応');
    await expect.soft(main, '下書き').toContainText('下書き');
    const ab = abnormalsOf('村田 美咲').at(-1)!;
    expect.soft(ab.diary_id).not.toBeNull();
    const d = sqlOne<{ record_type: string; status: string; occurred_at: string }>('SELECT record_type, status, occurred_at FROM t_diary WHERE diary_id = ?', ab.diary_id ?? 0);
    expect.soft([d?.record_type, d?.status]).toEqual(['4', '1']);
    expect.soft(dbHM(d?.occurred_at), '発生日時＝発見時刻').toBe(dbHM(ab.found_at));
    await evidence(page, '04-033');
    await page.goto('/staff/nap/abnormal');
    const open = abnormalRow(page, '受入テスト 04-033 状況').getByRole('link', { name: /起票済み/ }).or(abnormalRow(page, '受入テスト 04-033 状況').getByRole('button', { name: /起票済み/ }));
    await expect.soft(open).toBeVisible();
    await open.click();
    await expect.soft(page).toHaveURL(new RegExp(`/staff/diary/${ab.diary_id}`));
  });

  /* 典拠：図/画面遷移図「午睡チェック」(6) の表と注記、図/画面詳細図「異常時記録画面」(5-2) 項目15・16、「午睡チェック画面」(5-1) 項目19、「午睡記録検索画面」(5-3) 項目11、基本設計書「異常時の記録」(4-8) */
  test('04-034 午睡の画面のつながり', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.goto('/staff/nap/abnormal');
    await recordAbnormal(page, '村田 美咲', '受入テスト 04-034 状況', '受入テスト 04-034 対応');
    const row = abnormalRow(page, '受入テスト 04-034 状況');
    const toContact = row.getByRole('button', { name: /この園児の連絡帳/ }).or(row.getByRole('link', { name: /この園児の連絡帳/ })).or(page.getByRole('main').getByRole('link', { name: /この園児の連絡帳/ }));
    await expect.soft(toContact.first(), '「この園児の連絡帳」').toBeVisible();
    if (await toContact.count()) {
      await toContact.first().click();
      await expect.soft(page.getByRole('main')).toContainText('村田 美咲');
      await page.goBack();
    }
    const toChat = row.getByRole('button', { name: /この園児の個人チャット/ }).or(row.getByRole('link', { name: /この園児の個人チャット/ })).or(page.getByRole('main').getByRole('link', { name: /この園児の個人チャット/ }));
    await expect.soft(toChat.first(), '「この園児の個人チャット」').toBeVisible();
    if (await toChat.count()) {
      await toChat.first().click();
      await expect.soft(page.getByRole('main')).toContainText('村田 美咲');
      await page.goBack();
    }
    await page.getByRole('main').getByRole('link', { name: /午睡チェックへ/ }).click();
    await expect.soft(endButton(page), '午睡チェック画面へ戻り、実施中のまま').toBeVisible();
    await napMain(page).getByRole('link', { name: '記録を検索' }).click();
    await expect(page.getByRole('main').getByRole('button', { name: '絞り込む' })).toBeVisible();
    const sameRange = page.getByRole('main').getByRole('row').filter({ hasText: '受入テスト 04-034 状況' });
    await expect.soft(sameRange.first(), '検索画面の「同じ期間の異常時の記録」に行が出る').toBeVisible();
    if (await sameRange.count()) {
      // 行の中の移る口（リンクかボタン）を押す。無ければ行そのものを押す
      const go = sameRange.first().getByRole('link').or(sameRange.first().getByRole('button'));
      if (await go.count()) await go.first().click();
      else await sameRange.first().click();
      await expect.soft(page.getByRole('heading', { name: '異常時の記録', exact: true }), '異常時記録画面へ移る').toBeVisible({ timeout: 5_000 });
      if (!page.url().includes('/nap/search')) await page.goBack();
    }
    await page.getByRole('main').getByRole('link', { name: /午睡チェックへ/ }).click();
    await expect.soft(endButton(page)).toBeVisible();
    await expect.soft(page.getByRole('navigation', { name: '職員メニュー' }).getByRole('link', { name: /午睡記録/ }), 'サイドナビに午睡記録検索画面の項目は無い').toHaveCount(0);
    await evidence(page, '04-034');
  });

  /* 【次の版】典拠：要件定義書「記録時刻の扱いと改ざん防止」(4-5)、基本設計書「記録の修正と改ざん防止」(4-8)・「操作ログ」(5-9)、図/画面詳細図「異常時記録画面」(5-2) 項目17 と注記、詳細設計書「訂正・取り消しのまとめ」(3-5) */
  test('04-035 異常時の記録の修正', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.goto('/staff/nap/abnormal');
    await recordAbnormal(page, '村田 美咲', '受入テスト 04-035 状況', '受入テスト 04-035 対応');
    const row = abnormalRow(page, '受入テスト 04-035 状況');
    await expect(row).toHaveCount(1);
    const fixBtn = row.getByRole('button', { name: /修正/ });
    test.skip((await fixBtn.count()) === 0, notImplemented('異常時記録画面の一覧に「修正」が無い'));
    const ab0 = abnormalsOf('村田 美咲').at(-1)!;
    await fixBtn.click();
    const area = editArea(page);
    await expect(area).toBeVisible();
    const foundInput = area.getByLabel(/発見時刻/);
    const earlier = jstIso(new Date(Date.parse(`${ab0.found_at}+09:00`) - 60_000)).slice(0, 16);
    await foundInput.fill(earlier);
    await area.getByLabel(/状況/).fill('受入テスト 04-035 直した状況');
    await area.getByLabel(/理由/).fill('受入テスト 04-035 書き間違い');
    const res = await clickAndWaitNap(page, saveButton(area));
    expect(res.ok(), '一般（担任）がその日のうちに直せる').toBe(true);
    const row2 = abnormalRow(page, '受入テスト 04-035 直した状況');
    await expect.soft(row2).toContainText('修正あり');
    await expect.soft(row2).toContainText(earlier.slice(11, 16));
    await expect.soft(page.getByRole('main').getByRole('button', { name: /削除/ }), '削除のボタンが無い').toHaveCount(0);
    const ab1 = abnormalsOf('村田 美咲').at(-1)!;
    expect.soft(ab1.corrected_at).not.toBeNull();
    expect.soft(ab1.recorded_at, '保存時刻は変わらない').toBe(ab0.recorded_at);
    const log = sqlOne<{ before_value: string; after_value: string }>(
      "SELECT before_value, after_value FROM t_operation_log WHERE function_type = '3' AND operation_type = '2' AND target_table = 't_nap_abnormal' ORDER BY operation_log_id DESC LIMIT 1",
    );
    expect.soft(log?.before_value ?? '', '修正前の値').toContain('受入テスト 04-035 状況');
    expect.soft(log?.after_value ?? '', '修正後の値と理由').toContain('受入テスト 04-035 書き間違い');
    // (b) 【SQL】(W2) 実施の日を前の日にする
    sqlRun("UPDATE t_nap_session SET session_date = date(session_date, '-1 day') WHERE nap_session_id = ?", ab1.nap_session_id);
    await page.reload();
    await expect.soft(abnormalRow(page, '受入テスト 04-035 直した状況').getByRole('button', { name: /修正/ }), '翌日以降、一般には「修正」が出ない').toHaveCount(0);
    const a = await loginIn(browser, 'admin');
    await a.page.goto('/staff/nap/abnormal');
    const aBtn = abnormalRow(a.page, '受入テスト 04-035 直した状況').getByRole('button', { name: /修正/ });
    await expect.soft(aBtn, '管理者には出る').toBeVisible();
    if (await aBtn.count()) {
      await aBtn.click();
      const aa = editArea(a.page);
      await aa.getByLabel(/状況/).fill('受入テスト 04-035 管理者が直した');
      await aa.getByLabel(/理由/).fill('受入テスト 04-035 管理者');
      const r2 = await clickAndWaitNap(a.page, saveButton(aa));
      expect.soft(r2.ok(), '管理者は直せる').toBe(true);
    }
    await evidence(page, '04-035');
    await a.context.close();
  });

  /* 典拠：授業の雛形 1.5（クロスサイトスクリプティング対策）、図/画面詳細図「異常時記録画面」(5-2) 項目11・「午睡記録検索画面」(5-3) 項目11 */
  test('04-036 タグを含む文', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.goto('/staff/nap/abnormal');
    const situation = '04-036 <script>alert(1)</script>';
    const response = '04-036 <b>太字</b>"><img src=x onerror=alert(1)>';
    await recordAbnormal(page, '村田 美咲', situation, response);
    const row = abnormalRow(page, '04-036');
    await expect(row).toHaveCount(1);
    await expect.soft(row).toContainText(situation);
    await expect.soft(row).toContainText(response);
    expect.soft(await row.locator('b, img, script').count(), 'タグが要素にならない').toBe(0);
    const header = page.getByRole('main').getByRole('row').first();
    expect.soft(await row.getByRole('cell').count(), '表の列が崩れない').toBe(await header.getByRole('columnheader').count());
    await openSearch(page);
    const sr = page.getByRole('main').getByRole('row').filter({ hasText: '04-036' });
    await expect.soft(sr.first(), '検索画面の同じ期間の異常時の記録にも文のまま出る').toContainText(situation);
    expect.soft(await page.getByRole('main').locator('img[src="x"], b:has-text("太字")').count()).toBe(0);
    expect.soft(dialogs, 'ダイアログが出ない').toEqual([]);
    await page.goto('/staff/nap/abnormal');
    await abnormalRow(page, '04-036').scrollIntoViewIfNeeded();
    await evidence(page, '04-036');
  });

  /* 典拠：授業の雛形 1.5（二重送信の防止）、詳細設計書「全画面に共通する部品と決まり」(2-0) の (2) */
  test('04-037 二重送信', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.goto('/staff/nap/abnormal');
    const main = page.getByRole('main');
    await main.getByRole('combobox', { name: /園児/ }).selectOption({ label: '村田 美咲' });
    await main.getByRole('textbox', { name: /発見時の状況/ }).fill('04-037 連打');
    await main.getByRole('textbox', { name: /とった対応/ }).fill('04-037 連打の対応');
    await main.getByRole('button', { name: '記録する', exact: true }).dblclick();
    await page.waitForTimeout(2000);
    await expect.soft(abnormalRow(page, '04-037 連打の対応'), '一覧に1つだけ').toHaveCount(1);
    await page.reload();
    await expect.soft(abnormalRow(page, '04-037 連打の対応'), '再読み込みしても増えない').toHaveCount(1);
    expect.soft(sqlAll("SELECT 1 FROM t_nap_abnormal WHERE situation = '04-037 連打'").length).toBe(1);
    // (b) 開始の連打
    const a = await loginIn(browser, 'admin');
    await openNap(a.page);
    await chooseClass(a.page, 'もも組');
    await endIfRunning(a.page);
    await startButton(a.page).dblclick();
    await expect(endButton(a.page)).toBeVisible();
    await a.page.waitForTimeout(1500);
    expect.soft(sessionsOf('もも組', jstToday()).filter((s) => !s.ended_at).length, 'もも組のきょうの実施は1つだけ').toBe(1);
    await evidence(page, '04-037');
    await a.context.close();
  });

  /* 入力チェック（異常時記録画面）典拠：基本設計書「入力項目の制約値」(4-12) の異常時の状況・とった対応、図/画面詳細図「異常時記録画面」(5-2) 項目5・6 */
  for (const c of [
    { no: '04-I011', item: '状況 空', situation: '', response: '04-I011 対応' },
    { no: '04-I012', item: 'とった対応 空', situation: '04-I012 状況', response: '' },
  ]) {
    test(`${c.no} ${c.item}`, async ({ page }) => {
      await login(page, 'staffSakura');
      await freshSession(page);
      await page.goto('/staff/nap/abnormal');
      const main = page.getByRole('main');
      await main.getByRole('combobox', { name: /園児/ }).selectOption({ label: '村田 美咲' });
      await main.getByRole('textbox', { name: /発見時の状況/ }).fill(c.situation);
      await main.getByRole('textbox', { name: /とった対応/ }).fill(c.response);
      const btn = main.getByRole('button', { name: '記録する', exact: true });
      if (await btn.isEnabled()) {
        await btn.click();
        await page.waitForTimeout(1000);
        await expect.soft(page.getByRole('alert').or(main.getByText(/入力|必須/)).first(), '誤りを示す').toBeVisible();
      }
      expect.soft(abnormalsOf('村田 美咲').filter((r) => r.situation.startsWith(c.no) || r.response.startsWith(c.no)).length, '保存されない').toBe(0);
      const kept = c.situation ? main.getByRole('textbox', { name: /発見時の状況/ }) : main.getByRole('textbox', { name: /とった対応/ });
      await expect.soft(kept, '入れた文は消えない').toHaveValue(c.situation || c.response);
      await evidence(page, c.no);
    });
  }

  test('04-I013 状況と対応 1000文字', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.goto('/staff/nap/abnormal');
    const s = `04-I013${'あ'.repeat(1000 - 7)}`;
    const r = `04-I013${'い'.repeat(1000 - 7)}`;
    const main = page.getByRole('main');
    await main.getByRole('combobox', { name: /園児/ }).selectOption({ label: '村田 美咲' });
    await main.getByRole('textbox', { name: /発見時の状況/ }).fill(s);
    await main.getByRole('textbox', { name: /とった対応/ }).fill(r);
    await expect.soft(main, '残りの文字数が示される').toContainText(/残り|\d+\s*\/\s*1,?000/);
    const res = await clickAndWaitNap(page, main.getByRole('button', { name: '記録する', exact: true }));
    expect(res.ok(), '1,000文字は保存される').toBe(true);
    const ab = abnormalsOf('村田 美咲').at(-1);
    expect.soft([ab?.situation.length, ab?.response.length]).toEqual([1000, 1000]);
    await evidence(page, '04-I013');
  });

  test('04-I014 状況 1001文字', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.goto('/staff/nap/abnormal');
    const s = `04-I014${'あ'.repeat(1001 - 7)}`;
    const main = page.getByRole('main');
    await main.getByRole('combobox', { name: /園児/ }).selectOption({ label: '村田 美咲' });
    const box = main.getByRole('textbox', { name: /発見時の状況/ });
    await box.fill(s);
    await main.getByRole('textbox', { name: /とった対応/ }).fill('04-I014 対応');
    const typed = (await box.inputValue()).length;
    const btn = main.getByRole('button', { name: '記録する', exact: true });
    if (typed > 1000 && (await btn.isEnabled())) {
      await btn.click();
      await page.waitForTimeout(1000);
      await expect.soft(main.getByText(/1,?000文字以内/).first(), '「〇〇は1,000文字以内で入力してください。」の形').toBeVisible();
    }
    expect.soft(abnormalsOf('村田 美咲').filter((r) => r.situation.startsWith('04-I014') && r.situation.length > 1000).length, '1,001文字は保存されない').toBe(0);
    await evidence(page, '04-I014');
  });

  /* 【次の版】入力チェック（保護者への連絡）典拠：基本設計書「入力項目の制約値」(4-12) の保護者への連絡、図/画面詳細図「異常時記録画面」(5-2) 項目13 */
  for (const c of [
    { no: '04-I015', item: '連絡の相手 空', person: '', ok: false },
    { no: '04-I016', item: '連絡の相手 50文字', person: `04-I016${'あ'.repeat(43)}`, ok: true },
    { no: '04-I017', item: '連絡の相手 51文字', person: `04-I017${'あ'.repeat(44)}`, ok: false },
  ]) {
    test(`${c.no} ${c.item}`, async ({ page }) => {
      await login(page, 'staffSakura');
      await freshSession(page);
      await page.goto('/staff/nap/abnormal');
      const main = page.getByRole('main');
      await main.getByRole('combobox', { name: /園児/ }).selectOption({ label: '村田 美咲' });
      await main.getByRole('textbox', { name: /発見時の状況/ }).fill(`${c.no} 状況`);
      await main.getByRole('textbox', { name: /とった対応/ }).fill(`${c.no} 対応`);
      await main.getByRole('radiogroup', { name: '保護者への連絡' }).getByText('した', { exact: true }).click();
      const when = main.getByLabel(/日時/);
      test.skip((await when.count()) === 0, notImplemented('「した」のときの日時・手段・相手の欄が無い'));
      // 連絡した日時は発見時刻と同じにする（未来でない、発見より前でない値。相手の欄だけを確かめるため）
      await when.first().fill(await main.getByRole('textbox', { name: /発見時刻/ }).inputValue());
      await main.getByLabel(/手段/).first().selectOption({ label: '電話' });
      const person = main.getByLabel(/相手/).first();
      await person.fill(c.person);
      const typed = (await person.inputValue()).length;
      const btn = main.getByRole('button', { name: '記録する', exact: true });
      if (await btn.isEnabled()) {
        await btn.click();
        await page.waitForTimeout(1200);
      }
      const saved = abnormalsOf('村田 美咲').filter((r) => r.situation === `${c.no} 状況`);
      if (c.ok) {
        expect.soft(saved.length, '保存される').toBe(1);
        expect.soft(saved[0]?.guardian_notice_person?.length).toBe(50);
      } else if (c.no === '04-I017' && typed <= 50) {
        expect.soft(saved.every((r) => (r.guardian_notice_person ?? '').length <= 50), '51文字目を打てない').toBe(true);
      } else {
        expect.soft(saved.length, '保存されない').toBe(0);
        await expect.soft(page.getByRole('alert').or(main.getByText(/相手|必須|50文字/)).first(), '誤りを示す').toBeVisible();
      }
      await evidence(page, c.no);
    });
  }

  /* 【次の版】典拠：基本設計書「入力項目の制約値」(4-12) の異常時の発見時刻（修正のとき）・「記録の修正と改ざん防止」(4-8)、図/画面詳細図「異常時記録画面」(5-2) 項目17 */
  test('04-I018 発見時刻 保存時刻より後', async ({ page }) => {
    test.skip(!LONG, LONG_REASON);
    test.setTimeout(5 * 60_000);
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.goto('/staff/nap/abnormal');
    await recordAbnormal(page, '村田 美咲', '04-I018 状況', '04-I018 対応');
    await expect(abnormalRow(page, '04-I018 状況')).toHaveCount(1);
    const fixBtn = abnormalRow(page, '04-I018 状況').getByRole('button', { name: /修正/ });
    test.skip((await fixBtn.count()) === 0, notImplemented('異常時記録画面の一覧に「修正」が無い'));
    await page.waitForTimeout(125_000);
    const ab0 = abnormalsOf('村田 美咲').at(-1)!;
    await fixBtn.click();
    const area = editArea(page);
    await area.getByLabel(/発見時刻/).fill(jstIso(new Date(Date.parse(`${ab0.recorded_at}+09:00`) + 60_000)).slice(0, 16));
    await area.getByLabel(/理由/).fill('04-I018 理由');
    await saveButton(area).click();
    await page.waitForTimeout(1200);
    const ab1 = abnormalsOf('村田 美咲').at(-1)!;
    expect.soft(ab1.found_at, '保存されない').toBe(ab0.found_at);
    expect.soft(ab1.recorded_at).toBe(ab0.recorded_at);
    await evidence(page, '04-I018');
  });
});

// =====================================================================
// 午睡チェック画面：入力チェック
// =====================================================================
test.describe('午睡チェック画面：入力チェック', () => {
  /* 【次の版】典拠：基本設計書「入力項目の制約値」(4-12) の午睡チェック・「記録の修正と改ざん防止」(4-8)、図/画面詳細図「午睡チェック画面」(5-1) 項目26 */
  for (const c of [
    { no: '04-I001', item: 'チェックした時刻 開始した時刻', long: true },
    { no: '04-I002', item: 'チェックした時刻 開始の1分前', long: false },
    { no: '04-I003', item: 'チェックした時刻 いまの1分後', long: false },
  ]) {
    test(`${c.no} ${c.item}`, async ({ page }) => {
      test.skip(c.long && !LONG, LONG_REASON);
      test.setTimeout(5 * 60_000);
      await login(page, 'admin');
      const t0 = await freshSession(page, 'もも組');
      const child = (await rowNames(page))[0];
      const input = napRow(page, child).getByLabel(/チェックした時刻/);
      test.skip((await input.count()) === 0, notImplemented('午睡チェック画面の行に「チェックした時刻」の欄が無い'));
      if (c.long) await page.waitForTimeout(125_000);
      const value = c.no === '04-I001' ? jstHM(t0) : c.no === '04-I002' ? addMinutesHM(t0, -1) : addMinutesHM(new Date(), 1);
      await input.fill(value);
      const row = napRow(page, child);
      await choose(row, '体位', '仰向け');
      await choose(row, '呼吸', 'あり');
      await choose(row, '顔色', '通常');
      if (await recordButton(row).isEnabled()) await recordButton(row).click();
      await page.waitForTimeout(1200);
      const saved = recordsOf(child).filter((r) => dbHM(r.checked_at) === value);
      if (c.no === '04-I001') expect.soft(saved.length, '保存される').toBe(1);
      else expect.soft(saved.length, '保存されない').toBe(0);
      await evidence(page, c.no);
    });
  }

  /* 典拠：図/画面詳細図「午睡チェック画面」(5-1) 項目9〜11 と注記、基本設計書「誰でも使える操作の条件」(3-5) の⑤ */
  test('04-I004 体位 未選択', async ({ page }) => {
    await login(page, 'admin');
    await freshSession(page, 'もも組');
    const child = (await rowNames(page))[0];
    const row = napRow(page, child);
    await choose(row, '呼吸', 'あり');
    await choose(row, '顔色', '通常');
    const btn = recordButton(row);
    if (await btn.isEnabled()) {
      await btn.click();
      await page.waitForTimeout(1000);
    }
    expect.soft(recordsOf(child).length, '保存されない').toBe(0);
    await expect.soft(row.getByRole('radio', { name: 'あり', exact: true }), '選んだ呼吸は消えない').toBeChecked();
    await expect.soft(row.getByRole('radio', { name: '通常', exact: true }), '選んだ顔色は消えない').toBeChecked();
    await evidence(page, '04-I004');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の体温・午睡の体温、図/画面詳細図「午睡チェック画面」(5-1) 項目12、要件定義書「品質要求一覧」(7-1 No.5) */
  for (const c of [
    { no: '04-I005', value: '29.9', inRange: false },
    { no: '04-I006', value: '30.0', inRange: true },
    { no: '04-I007', value: '43.0', inRange: true },
    { no: '04-I008', value: '43.1', inRange: false },
  ]) {
    test(`${c.no} 体温 ${c.value}`, async ({ page }) => {
      await login(page, 'admin');
      await freshSession(page, 'もも組');
      const child = (await rowNames(page))[0];
      const row = napRow(page, child);
      await choose(row, '体位', '仰向け');
      await choose(row, '呼吸', 'あり');
      await choose(row, '顔色', '通常');
      // 一覧（35〜40℃）に無い値なので「範囲外の値を入力」から入れる。確認を促す表示は、入れたときと「設定」のあとの両方で見る
      await row.getByRole('button', { name: new RegExp(`${child}の体温`) }).click();
      const picker = page.getByRole('dialog', { name: `${child}の体温` });
      await picker.getByRole('button', { name: '範囲外の値を入力' }).click();
      await picker.getByRole('spinbutton').fill(c.value);
      const promptRe = /範囲外です|範囲の外です|の外です|確認してください|誤りがないか|誤りがなければ/;
      const shownWhileTyping = await page.getByText(promptRe).filter({ visible: true }).count();
      await picker.getByRole('button', { name: '設定' }).click();
      await page.waitForTimeout(500);
      const shownAfterSet = await page.getByText(promptRe).filter({ visible: true }).count();
      // 「記録する」を押す。確認を促す表示が出たら、それに従ってもう一度押す（妨げないこと）
      await clickAndWaitNap(page, recordButton(row)).catch(() => null);
      await page.waitForTimeout(500);
      const shownOnRecord = await page.getByText(promptRe).filter({ visible: true }).count();
      const prompted = shownWhileTyping + shownAfterSet + shownOnRecord;
      if (c.inRange) {
        expect.soft(prompted, '範囲の中の値なので確認を促さない').toBe(0);
      } else {
        expect.soft(prompted, '確認を促す表示が出る').toBeGreaterThan(0);
        if (recordsOf(child).length === 0 && (await recordButton(row).isEnabled())) await clickAndWaitNap(page, recordButton(row)).catch(() => null);
      }
      expect.soft(recordsOf(child).at(-1)?.temperature, '保存される（妨げない）').toBe(Number(c.value));
      await expectNoJudgment(row, `${c.value} の行`);
      await evidence(page, c.no);
    });
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の体温、詳細設計書「本書で足す文言」(4-1 (6)) の体温の形・「検査の共通の規則」(4-1 (5)) */
  test('04-I009 体温 36.55', async ({ page }) => {
    await login(page, 'admin');
    await freshSession(page, 'もも組');
    const child = (await rowNames(page))[0];
    const row = napRow(page, child);
    await choose(row, '体位', '仰向け');
    await choose(row, '呼吸', 'あり');
    await choose(row, '顔色', '通常');
    await row.getByRole('button', { name: new RegExp(`${child}の体温`) }).click();
    const dialog = page.getByRole('dialog', { name: `${child}の体温` });
    await dialog.getByRole('button', { name: '範囲外の値を入力' }).click();
    const box = dialog.getByRole('spinbutton');
    await box.fill('36.55');
    const set = dialog.getByRole('button', { name: '設定' });
    if (await set.isEnabled()) {
      await set.click();
      if (await recordButton(row).isEnabled()) await recordButton(row).click();
      await page.waitForTimeout(1200);
      const msg = page.getByText('体温は数値で、小数第1位まで入力してください。');
      const stored = recordsOf(child).at(-1)?.temperature ?? null;
      expect.soft(stored === 36.55, '小数第2位は保存されない').toBe(false);
      if (stored === null) await expect.soft(msg.first(), '誤りの文').toBeVisible();
    }
    await evidence(page, '04-I009');
  });

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の「きょうは対象外」の理由・「きょうは対象外」(4-8)、図/画面詳細図「午睡チェック画面」(5-1) 項目25 */
  test('04-I010 対象外の理由 未選択', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await page.getByRole('button', { name: /^村田 美咲をきょうは対象外/ }).click();
    const dialog = page.getByRole('dialog', { name: /村田 美咲/ });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: /確定|対象外にする|OK/ });
    if (await confirm.count()) {
      if (await confirm.first().isEnabled()) await confirm.first().click();
    } else {
      await dialog.getByRole('button', { name: 'やめる' }).click();
    }
    await page.waitForTimeout(800);
    expect.soft(sqlAll('SELECT 1 FROM t_nap_exclusion WHERE child_id = ? AND is_deleted = 0', childId('村田 美咲')).length, '対象外にならない').toBe(0);
    await expect.soft(page.getByRole('button', { name: '村田 美咲のねた', exact: true })).toBeVisible();
    await expect.soft(page.getByRole('button', { name: /^村田 美咲をきょうは対象外/ })).toBeVisible();
    await evidence(page, '04-I010');
  });
});

// =====================================================================
// 午睡記録検索画面
// =====================================================================
test.describe('午睡記録検索画面', () => {
  /* 典拠：基本設計書「入力項目の制約値」(4-12) の検索の期間・「帳票の出力」(4-8)・「権限と利用可能機能」(6-1)、図/画面詳細図「午睡記録検索画面」(5-3) 項目1・2・3・10 */
  test('04-038 初期値と出し分け', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await openSearch(page);
    const main = page.getByRole('main');
    const today = jstToday();
    await expect.soft(main.getByRole('textbox', { name: /期間（開始）/ }), '期間の開始はきょうの30日前').toHaveValue(shiftDate(today, -30));
    await expect.soft(main.getByRole('textbox', { name: /期間（終了）/ }), '期間の終了はきょう').toHaveValue(today);
    const opts = (await main.getByRole('combobox', { name: 'クラス' }).locator('option').allTextContents()).map((s) => s.trim());
    expect.soft(opts, '一般はさくら組だけ').toEqual(['さくら組']);
    await expect.soft(main.getByRole('searchbox', { name: '園児名' })).toHaveValue('');
    await expect.soft(main.getByRole('button', { name: 'CSV出力' }), '一般には CSV出力のボタンが出ない').toHaveCount(0);
    const rows = main.getByRole('table').first().getByRole('row');
    const keys = (await rows.evaluateAll((els) => els.slice(1, 8).map((r) => [...r.querySelectorAll('td')].slice(0, 2).map((c) => c.textContent ?? '').join(' ')))).map((k) => k.replace(/\(.\)/, ''));
    const sorted = [...keys].sort().reverse();
    expect.soft(keys, '一覧は新しい順').toEqual(sorted);
    await evidence(page, '04-038');
    const a = await loginIn(browser, 'admin');
    await openSearch(a.page);
    const am = a.page.getByRole('main');
    await expect.soft(am.getByRole('combobox', { name: 'クラス' }).locator('option:checked'), '管理者のクラスの初期値は「すべて」').toHaveText('すべて');
    await am.getByRole('combobox', { name: 'クラス' }).selectOption({ label: 'ひまわり組' });
    await expect.soft(am.getByRole('button', { name: 'CSV出力' }), '管理者には CSV出力のボタンが出る').toBeVisible();
    await a.context.close();
  });

  /* 典拠：要件定義書「午睡チェック」(4-5)（検索・履歴閲覧）、図/画面詳細図「午睡記録検索画面」(5-3) 項目3・5 */
  test('04-039 園児名の部分一致', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await recordCheck(page, '西田 太郎');
    await recordCheck(page, '村田 美咲');
    await openSearch(page);
    await searchBy(page, { child: '美咲' });
    const rows = page.getByRole('main').getByRole('table').first().getByRole('row');
    const body = await rows.evaluateAll((els) => els.slice(1).map((r) => r.textContent ?? ''));
    expect.soft(body.length, '行がある').toBeGreaterThan(0);
    expect.soft(body.every((t) => t.includes('村田 美咲')), '村田 美咲の行だけ').toBe(true);
    await evidence(page, '04-039');
    await searchBy(page, { child: '' });
    await expect.soft(rows.filter({ hasText: '西田 太郎' }).first(), '空にすると太郎の行も出る').toBeVisible();
  });

  /* 典拠：要件定義書「午睡チェック」(4-5)、基本設計書「帳票の出力」(4-8)、図/画面詳細図「午睡記録検索画面」(5-3) 項目6・7・11 と注記 */
  test('04-040 一覧の列 並び 同じ期間の異常時の記録', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await recordCheck(page, '西田 太郎', { temp: '37.0' });
    await pressSleep(page, '西田 太郎');
    await clickAndWaitNap(page, napRow(page, '西田 太郎').getByRole('button', { name: /おきた$/ }));
    await exclude(page, '村田 美咲', '欠席');
    await page.goto('/staff/nap/abnormal');
    await recordAbnormal(page, '村田 美咲', '受入テスト 04-040 状況', '受入テスト 04-040 対応');
    const a = await loginIn(browser, 'admin');
    await openSearch(a.page);
    const today = jstToday();
    await searchBy(a.page, { from: today, to: today, className: 'さくら組' });
    const main = a.page.getByRole('main');
    const table = main.getByRole('table').first();
    const headers = (await table.getByRole('columnheader').allTextContents()).map((s) => s.trim());
    for (const h of ['日付', 'チェック時刻', '園児', 'クラス', '体位', '呼吸', '顔色', '体温', '記録者', '保存時刻']) expect.soft(headers, `列「${h}」`).toContain(h);
    expect.soft(headers.join(' '), '修正ありの印の列').toMatch(/修正/);
    const taro = table.getByRole('row').filter({ hasText: '西田 太郎' });
    await expect.soft(taro.filter({ has: a.page.getByRole('cell', { name: /^37(\.0)?℃?$/ }) }).first(), '太郎の確認（37.0）').toBeVisible();
    await expect.soft(taro.filter({ hasText: /ねた|入眠/ }).first(), '太郎の入眠（ねた）').toBeVisible();
    await expect.soft(taro.filter({ hasText: /おきた|起床/ }).first(), '太郎の起床（おきた）').toBeVisible();
    await expect.soft(table.getByRole('row').filter({ hasText: '村田 美咲' }).filter({ hasText: '欠席' }).first(), '美咲の対象外と理由').toBeVisible();
    await expectNoJudgment(table, '一覧');
    await expect.soft(main.getByText(/異常時の記録/).first(), '一覧の下に「同じ期間の異常時の記録」').toBeVisible();
    const abn = main.getByRole('row').filter({ hasText: '受入テスト 04-040 状況' });
    await expect.soft(abn.first()).toContainText('村田 美咲');
    await expect.soft(abn.first()).toContainText('受入テスト 04-040 対応');
    await expect.soft(abn.first()).toContainText('鈴木 浩之');
    await evidence(a.page, '04-040');
    await a.context.close();
  });

  /* 典拠：基本設計書「一覧表示とページング」(3-7)・「設定マスタ」(5-9) の paging.nap_search_per_page、図/画面詳細図「午睡記録検索画面」(5-3) 項目8。前提の1ページの件数は設定マスタを書き換えて作る（設定画面に欄が無い） */
  test('04-041 ページング', async ({ page }) => {
    test.skip(!LONG, LONG_REASON);
    test.setTimeout(6 * 60_000);
    setSetting('paging.nap_search_per_page', '10');
    await login(page, 'admin');
    await freshSession(page, 'もも組');
    const names = await rowNames(page);
    for (let round = 0; round < 3; round += 1) {
      const kids = round < 2 ? names : names.slice(0, 2);
      for (const k of kids) await recordCheck(page, k);
      if (round < 2) await page.waitForTimeout(61_000);
    }
    const today = jstToday();
    await openSearch(page);
    await searchBy(page, { from: today, to: today, className: 'もも組' });
    const main = page.getByRole('main');
    const bodyRows = () => main.getByRole('table').first().getByRole('row').evaluateAll((els) => els.length - 1);
    expect.soft(await bodyRows(), '10件のとき1ページに10件').toBe(10);
    await expect.soft(main, '総件数 10').toContainText(/10\s*件/);
    await expect.soft(main.getByRole('button', { name: /次/ }).or(main.getByRole('link', { name: /次/ })), '次のページへ移れない').toHaveCount(0);
    await page.goto('/staff/nap');
    await recordCheck(page, names[2]);
    await openSearch(page);
    await searchBy(page, { from: today, to: today, className: 'もも組' });
    expect.soft(await bodyRows(), '11件のとき1ページ目は10件').toBe(10);
    await expect.soft(main, '総件数 11').toContainText(/11\s*件/);
    const next = main.getByRole('button', { name: /次/ }).or(main.getByRole('link', { name: /次/ }));
    await expect.soft(next.first()).toBeVisible();
    if (await next.count()) {
      await next.first().click();
      await page.waitForTimeout(800);
      expect.soft(await bodyRows(), '2ページ目は1件').toBe(1);
    }
    await evidence(page, '04-041');
  });

  /* 【次の版】典拠：要件定義書「記録時刻の扱いと改ざん防止」(4-5)、基本設計書「記録の修正と改ざん防止」(4-8)・「足した列」(5-7)・「操作ログ」(5-9)、図/画面詳細図「午睡記録検索画面」(5-3) 項目6・12 */
  test('04-042 午睡チェックの記録の修正', async ({ page }) => {
    await login(page, 'staffSakura');
    await freshSession(page);
    await recordCheck(page, '西田 太郎', { pos: '仰向け' });
    const rec0 = recordsOf('西田 太郎').at(-1)!;
    await openSearch(page);
    await searchBy(page, { child: '西田 太郎' });
    const line = page.getByRole('main').getByRole('row').filter({ hasText: '西田 太郎' }).filter({ hasText: dbHM(rec0.checked_at) }).filter({ hasText: '仰向け' }).first();
    const fixBtn = line.getByRole('button', { name: /修正/ });
    test.skip((await fixBtn.count()) === 0, notImplemented('午睡記録検索画面の行に「修正」が無い'));
    await fixBtn.click();
    const area = editArea(page);
    await expect(area).toBeVisible();
    await setPosition(area, '左向き');
    await area.getByLabel(/理由/).fill('受入テスト 04-042 選び間違い');
    const res = await clickAndWaitNap(page, saveButton(area));
    expect(res.ok(), '保存できる').toBe(true);
    const fixed = page.getByRole('main').getByRole('row').filter({ hasText: '西田 太郎' }).filter({ hasText: dbHM(rec0.checked_at) }).first();
    await expect.soft(fixed).toContainText('左向き');
    await expect.soft(fixed, '「修正あり」').toContainText('修正あり');
    await expect.soft(page.getByRole('main').getByRole('button', { name: /削除/ }), '削除のボタンが無い').toHaveCount(0);
    const rec1 = recordsOf('西田 太郎').find((r) => r.nap_record_id === rec0.nap_record_id)!;
    expect.soft(rec1.body_position).toBe('3');
    expect.soft(rec1.corrected_at).not.toBeNull();
    expect.soft([rec1.checked_at, rec1.saved_at, rec1.staff_id], 'チェック時刻・保存時刻・記録者は変わらない').toEqual([rec0.checked_at, rec0.saved_at, rec0.staff_id]);
    const log = sqlOne<{ before_value: string; after_value: string }>(
      "SELECT before_value, after_value FROM t_operation_log WHERE function_type = '3' AND operation_type = '2' AND target_table = 't_nap_record' ORDER BY operation_log_id DESC LIMIT 1",
    );
    expect.soft(log?.before_value ?? '', '修正前の体位').toMatch(/body_position|体位/);
    expect.soft(log?.after_value ?? '', '修正後の値と理由').toContain('受入テスト 04-042 選び間違い');
    await evidence(page, '04-042');
  });

  /* 【次の版】典拠：要件定義書「記録時刻の扱いと改ざん防止」(4-5)、基本設計書「記録の修正と改ざん防止」(4-8)・「権限と利用可能機能」(6-1)、図/画面詳細図「午睡記録検索画面」(5-3) 項目12 */
  test('04-043 一般が直せない行', async ({ page, browser }) => {
    await login(page, 'staffSakura');
    // 前提：前の日の記録（陸の確認を1件記録した実施を終え、【SQL】(W2) で実施の日を前の日にする）
    await freshSession(page);
    await recordCheck(page, '久保田 陸');
    const prevSession = openSession('さくら組')!.nap_session_id;
    await endIfRunning(page);
    sqlRun("UPDATE t_nap_session SET session_date = date(session_date, '-1 day') WHERE nap_session_id = ?", prevSession);
    await freshSession(page);
    await recordCheck(page, '西田 太郎');
    await recordCheck(page, '村田 美咲');
    await page.goto('/staff/nap/abnormal');
    await recordAbnormal(page, '村田 美咲', '受入テスト 04-043 状況', '受入テスト 04-043 対応');
    const today = jstToday();
    const yesterday = shiftDate(today, -1);
    const ydisp = `${Number(yesterday.slice(5, 7))}/${yesterday.slice(8, 10)}`;
    test.skip(sqlAll('SELECT 1 FROM t_nap_record r JOIN t_nap_session s ON s.nap_session_id = r.nap_session_id WHERE s.session_date = ?', yesterday).length === 0, '前提を作れなかった：前の日の記録が無い');
    await openSearch(page);
    await searchBy(page, { from: yesterday, to: today });
    const main = page.getByRole('main');
    const t = recordsOf('西田 太郎').at(-1)!;
    const m = recordsOf('村田 美咲').at(-1)!;
    const lineOf = (p: Page, child: string, hhmm: string) => p.getByRole('main').getByRole('row').filter({ hasText: child }).filter({ hasText: hhmm }).first();
    const anyFix = main.getByRole('button', { name: /修正/ });
    test.skip((await anyFix.count()) === 0, notImplemented('午睡記録検索画面の行に「修正」が無い'));
    await expect.soft(lineOf(page, '西田 太郎', dbHM(t.checked_at)).getByRole('button', { name: /修正/ }), '太郎のきょうの行には「修正」').toBeVisible();
    await expect.soft(lineOf(page, '村田 美咲', dbHM(m.checked_at)).getByRole('button', { name: /修正/ }), '異常時の記録がある美咲の確認の行には出ない').toHaveCount(0);
    const yRows = main.getByRole('row').filter({ hasText: new RegExp(`0?${ydisp}`) });
    await expect.soft(yRows.first()).toBeVisible();
    expect.soft(await yRows.getByRole('button', { name: /修正/ }).count(), '前の日の行には出ない').toBe(0);
    const a = await loginIn(browser, 'admin');
    await openSearch(a.page);
    await searchBy(a.page, { from: yesterday, to: today, className: 'さくら組' });
    const am = lineOf(a.page, '村田 美咲', dbHM(m.checked_at)).getByRole('button', { name: /修正/ });
    await expect.soft(am, '管理者には美咲の行にも「修正」').toBeVisible();
    expect.soft(await a.page.getByRole('main').getByRole('row').filter({ hasText: new RegExp(`0?${ydisp}`) }).getByRole('button', { name: /修正/ }).count(), '管理者には前の日の行にも「修正」').toBeGreaterThan(0);
    if (await am.count()) {
      await am.click();
      const area = editArea(a.page);
      await setPosition(area, '右向き');
      await area.getByLabel(/理由/).fill('受入テスト 04-043 管理者');
      const r = await clickAndWaitNap(a.page, saveButton(area));
      expect.soft(r.ok(), '管理者は直して保存できる').toBe(true);
    }
    await evidence(page, '04-043');
    await a.context.close();
  });

  /* 【次の版】典拠：要件定義書「午睡チェック」(4-5)（自動帳票出力）、基本設計書「帳票の出力」(4-8)・「操作ログ」(5-9)・「権限と利用可能機能」(6-1)・「監査への対応」(6-4)、図/画面詳細図「午睡記録検索画面」(5-3) 項目10 */
  test('04-044 帳票 CSV の出力', async ({ page, browser }) => {
    test.setTimeout(2 * 60_000);
    await login(page, 'staffSakura');
    await freshSession(page);
    await recordCheck(page, '西田 太郎', { pos: '仰向け' });
    await pressSleep(page, '西田 太郎');
    await clickAndWaitNap(page, napRow(page, '西田 太郎').getByRole('button', { name: /おきた$/ }));
    await exclude(page, '村田 美咲', '欠席');
    await page.goto('/staff/nap/abnormal');
    await recordAbnormal(page, '久保田 陸', '受入テスト 04-044 状況', '受入テスト 04-044 対応');
    await abnormalRow(page, '受入テスト 04-044 状況').getByRole('button', { name: '起票する' }).click();
    await page.waitForURL(/\/staff\/diary/);
    // 修正あり を作る
    await openSearch(page);
    await searchBy(page, { child: '西田 太郎' });
    const rec0 = recordsOf('西田 太郎').at(-1)!;
    const fixBtn = page.getByRole('main').getByRole('row').filter({ hasText: dbHM(rec0.checked_at) }).filter({ hasText: '仰向け' }).first().getByRole('button', { name: /修正/ });
    if (await fixBtn.count()) {
      await fixBtn.click();
      const area = editArea(page);
      await setPosition(area, '左向き');
      await area.getByLabel(/理由/).fill('受入テスト 04-044 修正');
      await clickAndWaitNap(page, saveButton(area)).catch(() => null);
    }
    const a = await loginIn(browser, 'admin');
    await openSearch(a.page);
    const today = jstToday();
    await searchBy(a.page, { from: today, to: today, className: 'さくら組' });
    const csvBtn = a.page.getByRole('main').getByRole('button', { name: 'CSV出力' });
    test.skip((await csvBtn.count()) === 0, notImplemented('午睡記録検索画面に CSV出力が無い'));
    const logBefore = sqlOne<{ m: number }>('SELECT COALESCE(MAX(operation_log_id), 0) AS m FROM t_operation_log')?.m ?? 0;
    const [download] = await Promise.all([a.page.waitForEvent('download'), csvBtn.click()]);
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(path!, 'utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/);
    expect.soft(text, 'チェックした時刻と保存時刻の両方').toMatch(/チェック.*時刻[\s\S]*保存時刻|保存時刻[\s\S]*チェック.*時刻/);
    const taroCheck = lines.find((l) => l.includes('西田 太郎') && l.includes(dbHM(rec0.checked_at)) && /左向き|仰向け/.test(l));
    expect.soft(taroCheck, '太郎の確認の行').toBeTruthy();
    expect.soft(taroCheck ?? '', '直した行に「修正あり」').toContain('修正あり');
    expect.soft(taroCheck ?? '', '記録した職員').toContain('鈴木 浩之');
    expect.soft(lines.some((l) => l.includes('村田 美咲') && l.includes('欠席')), 'きょうは対象外と理由').toBe(true);
    expect.soft(lines.some((l) => l.includes('西田 太郎') && /ねた|入眠/.test(l)), '入眠（ねた）').toBe(true);
    expect.soft(lines.some((l) => l.includes('西田 太郎') && /おきた|起床/.test(l)), '起床（おきた）').toBe(true);
    const abLine = lines.find((l) => l.includes('久保田 陸') && l.includes('受入テスト 04-044'));
    expect.soft(abLine, '異常時の記録（ヒヤリハット側の文）').toBeTruthy();
    expect.soft(abLine ?? '', '起票済みの印').toMatch(/起票済/);
    const histAt = lines.findIndex((l) => l.includes('修正の履歴'));
    expect.soft(histAt, '末尾に「修正の履歴」の表').toBeGreaterThan(0);
    expect.soft(lines.slice(histAt).some((l) => l.includes('受入テスト 04-044 修正')), '修正の履歴に理由').toBe(true);
    const taroTimes = lines.filter((l) => l.includes('西田 太郎')).map((l) => /(\d{1,2}:\d{2})/.exec(l)?.[1] ?? '').filter(Boolean).slice(0, 3);
    expect.soft(taroTimes, '時刻の古い順').toEqual([...taroTimes].sort());
    const out = sqlOne<{ operation_type: string; after_value: string | null }>("SELECT operation_type, after_value FROM t_operation_log WHERE operation_log_id > ? AND function_type = '3' ORDER BY operation_log_id DESC LIMIT 1", logBefore);
    expect.soft(out?.operation_type, '出力を操作ログへ記録する').toBe('5');
    expect.soft(out?.after_value ?? '', '期間と件数').toMatch(/\d/);
    await evidence(a.page, '04-044');
    await a.context.close();
  });

  /* 【次の版】入力チェック（修正の理由）典拠：基本設計書「入力項目の制約値」(4-12) の午睡の記録の修正の理由、図/画面詳細図「午睡記録検索画面」(5-3) 項目12、詳細設計書「検査の共通の規則」(4-1 (5)) */
  for (const c of [
    { no: '04-I019', item: '修正の理由 空白だけ', reason: '　　　', ok: false },
    { no: '04-I020', item: '修正の理由 500文字', reason: `04-I020${'あ'.repeat(493)}`, ok: true },
    { no: '04-I021', item: '修正の理由 501文字', reason: `04-I021${'あ'.repeat(494)}`, ok: false },
  ]) {
    test(`${c.no} ${c.item}`, async ({ page }) => {
      await login(page, 'staffSakura');
      await freshSession(page);
      await recordCheck(page, '西田 太郎', { pos: '仰向け' });
      const rec0 = recordsOf('西田 太郎').at(-1)!;
      await openSearch(page);
      await searchBy(page, { child: '西田 太郎' });
      const fixBtn = page.getByRole('main').getByRole('row').filter({ hasText: dbHM(rec0.checked_at) }).filter({ hasText: '仰向け' }).first().getByRole('button', { name: /修正/ });
      test.skip((await fixBtn.count()) === 0, notImplemented('午睡記録検索画面の行に「修正」が無い'));
      await fixBtn.click();
      const area = editArea(page);
      await setPosition(area, '左向き');
      const reason = area.getByLabel(/理由/);
      await reason.fill(c.reason);
      const typed = (await reason.inputValue()).length;
      const save = saveButton(area);
      if (await save.isEnabled()) {
        await save.click();
        await page.waitForTimeout(1200);
      }
      const rec1 = recordsOf('西田 太郎').find((r) => r.nap_record_id === rec0.nap_record_id)!;
      if (c.ok) expect.soft(rec1.corrected_at, '保存され、「修正あり」が付く').not.toBeNull();
      else if (c.no === '04-I021' && typed <= 500) expect.soft(typed, '501文字目を打てない').toBeLessThanOrEqual(500);
      else expect.soft(rec1.corrected_at, '保存されない').toBeNull();
      await evidence(page, c.no);
    });
  }

  /* 典拠：基本設計書「入力項目の制約値」(4-12) の検索の期間、図/画面詳細図「午睡記録検索画面」(5-3) 項目1 */
  test('04-I022 期間 開始が終了より後', async ({ page }) => {
    await login(page, 'staffSakura');
    await openSearch(page);
    const main = page.getByRole('main');
    const records = main.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'チェック時刻' }) });
    await expect(records.getByRole('row').nth(1)).toBeVisible();
    const before = await records.innerText();
    const today = jstToday();
    await main.getByRole('textbox', { name: /期間（開始）/ }).fill(today);
    await main.getByRole('textbox', { name: /期間（終了）/ }).fill(shiftDate(today, -1));
    await main.getByRole('button', { name: '絞り込む' }).click();
    await page.waitForTimeout(1200);
    await expect.soft(page.getByRole('alert').or(main.getByText(/開始|終了|期間/).filter({ hasText: /前|後|以前|より/ })).first(), '誤りを示す').toBeVisible();
    expect.soft(await records.innerText(), '一覧は前の条件のまま').toBe(before);
    await evidence(page, '04-I022');
  });
});

