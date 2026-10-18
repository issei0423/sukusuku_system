/*
 * 連絡帳のデモの道を、キーボードだけ（Tab・Shift+Tab・矢印・Enter・Space・Esc と文字の入力）で通す
 * 典拠：詳細設計書「実装の順番（デモの道）」(1-6) のデモ①②③、図/画面詳細図「職員（タブレット／PC）」(1-1) の項目8「本文へ移動」、
 *      GitHub Issue #104・#105（キーボードでの移動とモーダルのフォーカス）
 *
 *   ① 保護者が「家庭から」を選んで送る → 職員が連絡帳（クラス）画面で「確認しました」を押す
 *   ② 職員が午睡チェック画面の園児の行で「ねた」「おきた」を記録する
 *   ③ 職員が連絡帳（園児）画面の「園から」で定型文を選ぶ → 宛先を確かめる → 他児の名前の注意 → 送る
 *
 * 各キーのあとに、フォーカスのある要素に :focus-visible が当たり、見える印（outline か輪）を持ち、
 * 固定の帯などにすっかり隠れていないことを確かめる。
 * ダイアログを開いたらフォーカスが中に入り、閉じたら開いた元へ戻ることを確かめる。
 * モックは画面ごとにデータを持つため、職員の操作が保護者の画面に届くところまでは見ない（操作した画面の上で結果を見る）。
 * キー操作の既定の動き（ラジオの矢印・select の矢印）はブラウザで違うため、chromium（desktop）だけで回す。
 *
 * 止めた見出し・列・帯の下に、Tab で止まった部品がすっかり隠れないこと（WCAG 2.4.11、GitHub Issue #212）は、各キーのあとの確かめに加えて、
 * 表が横に送られる幅（iPad の横向き 1024×768）の連絡帳（クラス）画面と、保護者の幅（390×844）の連絡帳画面を、
 * Tab で最後まで進み Shift+Tab で戻って確かめる。
 *
 * 送る・記録するボタンは、送っている間に押せなくなる（disabled）・送ったあとに消えるため、押したボタンからフォーカスが外れる。
 * 応答のあとに、押したボタンが残っていればそこへ、消えていれば決めた場所へフォーカスが移ることを確かめる
 * （WCAG 2.4.3 フォーカス順序、GitHub Issue #213。共通の決まりは src/focusAfter.ts）。
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { REVIEW_TIME } from './scenarios';

test.skip(({ browserName }) => browserName !== 'chromium', 'キーボードの道は chromium（desktop）で確かめる');

/** review.spec.ts と同じ待ち方（API の読み込みが静まり、字形がそろうまで） */
async function ready(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-review-ready', 'true');
  await expect(page.getByText('読み込んでいます…', { exact: true })).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

/** 場面を開く。時計はレビューと同じ時刻に止める（デモデータの「今日」と午睡の実施中をそろえる） */
async function open(page: Page, scene: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    errors.push(`HTTP API が呼ばれました: ${route.request().url()}`);
    await route.abort();
  });
  await page.clock.setFixedTime(new Date(REVIEW_TIME));
  await page.goto(`/tests/responsive/harness.html?scene=${scene}`);
  await ready(page);
  return errors;
}

/**
 * いまフォーカスのある要素と、その見える印。隠したラジオは、隣の見えている枠（.nap-choice span）で見る。
 * covered は、要素の中央と四隅のどこにも要素自身が出ていない（固定の帯や結果の表示にすっかり隠れている。WCAG 2.4.11）
 */
async function focusState(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return { where: 'body', visible: false, focusVisible: false, covered: false };
    const shown = el.matches('.nap-choice input') && el.nextElementSibling instanceof HTMLElement ? el.nextElementSibling : el;
    const style = getComputedStyle(shown);
    const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
    const ring = style.boxShadow !== 'none';
    const box = shown.getBoundingClientRect();
    const points = [[box.left + box.width / 2, box.top + box.height / 2], [box.left + 2, box.top + 2], [box.right - 2, box.top + 2],
      [box.left + 2, box.bottom - 2], [box.right - 2, box.bottom - 2]];
    const covered = !points.some(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return !!hit && (shown.contains(hit) || hit.contains(shown));
    });
    const label = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 30);
    return {
      where: `${el.tagName.toLowerCase()}${el.getAttribute('type') ? `[type=${el.getAttribute('type')}]` : ''} 「${label}」`,
      visible: outline || ring,
      focusVisible: el.matches(':focus-visible'),
      covered,
    };
  });
}

/** フォーカスが見えていること（:focus-visible が当たり、outline か輪が描かれ、ほかの要素にすっかり隠れていない） */
async function expectFocusVisible(page: Page) {
  const state = await focusState(page);
  expect(state.where, 'フォーカスが行き先を失っている').not.toBe('body');
  expect(state.focusVisible, `${state.where} に :focus-visible が当たっていない`).toBe(true);
  expect(state.visible, `${state.where} のフォーカスの印が見えない`).toBe(true);
  expect(state.covered, `${state.where} がほかの要素に隠れている`).toBe(false);
}

/** キーを押し、押したあとのフォーカスが見えることを確かめる */
async function key(page: Page, name: string) {
  await page.keyboard.press(name);
  await expectFocusVisible(page);
}

/**
 * 送る・記録するボタンを押し、応答を待つ。押したボタンは送っている間 disabled になり、いったんフォーカスが外れる。
 * 応答のあとに、フォーカスが moved（押したボタンが残るなら同じボタン）へ移り、見えることを確かめる（GitHub Issue #213）
 */
async function pressAndExpectFocus(page: Page, name: string, moved: Locator) {
  await page.keyboard.press(name);
  await ready(page);
  await expect(moved, '押したあと、決めた場所へフォーカスが移っていない').toBeFocused();
  await expectFocusVisible(page);
}

const isFocused = (target: Locator) => target.evaluate((el) => el === document.activeElement);

/** Tab（shift なら Shift+Tab）を押して target まで進む。途中の1歩ごとにフォーカスが見えることを確かめる */
async function tabTo(page: Page, target: Locator, { shift = false, max = 120 }: { shift?: boolean; max?: number } = {}) {
  await expect(target).toBeVisible();
  for (let i = 0; i < max; i++) {
    if (await isFocused(target)) return;
    await key(page, shift ? 'Shift+Tab' : 'Tab');
  }
  if (await isFocused(target)) return;
  throw new Error(`${max} 回の${shift ? ' Shift+Tab' : ' Tab'} で届かない：${await target.evaluate((el) => el.outerHTML.slice(0, 120))}`);
}

/**
 * first から Tab で within（CSS のセレクタ）の外へ出るまで進み、Shift+Tab で first まで戻る。1歩ごとに key と同じ確かめをする
 * （止めた見出し・列・帯の下にすっかり隠れる部品が無いこと。WCAG 2.4.11、GitHub Issue #212）。Tab で止まった部品を順に返す
 */
async function walkThrough(page: Page, first: Locator, within: string) {
  const inside = () => page.evaluate((sel) => !!document.activeElement?.closest(sel), within);
  await tabTo(page, first);
  const visited: string[] = [];
  while (visited.length < 300) {
    await page.keyboard.press('Tab');
    if (!(await inside())) break;
    await expectFocusVisible(page);
    visited.push((await focusState(page)).where);
  }
  await tabTo(page, first, { shift: true, max: visited.length + 2 });
  return visited;
}

/** ダイアログを開いたあと、フォーカスがその中にあり、見えること */
async function expectFocusInside(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement)), { message: 'ダイアログの中にフォーカスが入っていない' }).toBe(true);
  await expectFocusVisible(page);
}

/** ダイアログを閉じたあと、フォーカスが開いた元へ戻ったこと */
async function expectFocusBack(page: Page, opener: Locator) {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => isFocused(opener), { message: 'ダイアログを閉じたあと、開いた元へフォーカスが戻っていない' }).toBe(true);
  await expectFocusVisible(page);
}

/**
 * root（CSS のセレクタ）の中の押せるもの（リンク・ボタン・入力欄。隠したラジオは包む label）のうち、
 * 44×44px に届かないものと、いちばん近い押せるものとの間が 8px に満たないものを返す
 * （詳細設計書「全画面に共通する部品と決まり」(2-0) の「タッチの条件」(4)、GitHub Issue #215）。重なっているもの（包む label と中の input）は比べない
 */
async function touchProblems(page: Page, root: string) {
  return page.evaluate((root) => {
    const items = [...document.querySelectorAll<HTMLElement>(`${root} :is(a[href], button, input, select, textarea)`)].map((el) => {
      const target = el.matches('input[type="radio"]') ? el.closest('label') ?? el : el;
      return { name: (el.getAttribute('aria-label') ?? target.textContent ?? '').trim().slice(0, 30), box: target.getBoundingClientRect() };
    }).filter(({ box }) => box.width > 0 && box.height > 0);
    const small = items.filter(({ box }) => box.width < 44 || box.height < 44).map(({ name, box }) => `${name} ${Math.round(box.width)}×${Math.round(box.height)}`);
    const close: string[] = [];
    for (const a of items) {
      for (const b of items) {
        const dx = Math.max(0, Math.max(a.box.left, b.box.left) - Math.min(a.box.right, b.box.right));
        const dy = Math.max(0, Math.max(a.box.top, b.box.top) - Math.min(a.box.bottom, b.box.bottom));
        if ((dx > 0 || dy > 0) && Math.max(dx, dy) < 8) close.push(`${a.name} と ${b.name} の間 ${Math.max(dx, dy).toFixed(1)}px`);
      }
    }
    return { small, close };
  }, root);
}

test.describe('[guardian] contact キーボードだけで通す', () => {
  test('① 保護者が家庭からを選んで送る（体温の一覧・朝ごはん・きげん → 送る）', async ({ page }) => {
    const errors = await open(page, 'guardian-contact');
    const home = page.getByRole('region', { name: '家庭から' });
    await expect(home.getByRole('button', { name: '家庭からを送る' })).toBeVisible();

    // 体温：一覧のダイアログを開くと、36.5（保護者の画面の開く位置）にフォーカスが入る（GitHub Issue #213）。Esc で閉じると開いた元へ戻る
    const pick = home.getByRole('button', { name: '体温を入れる' });
    await tabTo(page, pick);
    await key(page, 'Enter');
    const picker = page.getByRole('dialog', { name: '体温' });
    const origin = picker.getByRole('button', { name: '36.5', exact: true });
    await expectFocusInside(page, picker);
    await expect(origin).toBeFocused();
    await key(page, 'Escape');
    await expectFocusBack(page, pick);
    // もう一度開き、フォーカスの入った 36.5 をそのまま Enter。開いた元のボタンは、値が入ると「入れ直す」になる（同じボタン）
    await key(page, 'Enter');
    await expectFocusInside(page, picker);
    await expect(origin).toBeFocused();
    await key(page, 'Enter');
    await expectFocusBack(page, home.getByRole('button', { name: '入れ直す' }));
    await expect(home).toContainText('36.5℃');

    // 朝ごはん：Tab でラジオの組へ入り（何も選んでいなければ先頭）、Space で選ぶ
    const breakfast = home.getByRole('group', { name: '朝ごはん' });
    await tabTo(page, breakfast.getByRole('radio').first());
    await key(page, 'Space');
    await expect(breakfast.getByRole('radio', { name: 'ぜんぶ' })).toBeChecked();
    // きげん：Tab で組へ入り、矢印で隣を選ぶ
    const mood = home.getByRole('group', { name: 'きげん' });
    await tabTo(page, mood.getByRole('radio').first());
    await key(page, 'ArrowRight');
    await expect(mood.getByRole('radio', { name: 'ふつう', exact: true })).toBeChecked();

    // 送る（Enter）。送ったあとは書く欄が送った内容と「急ぎはお電話でお願いします。」の短い表示に替わり、
    // フォーカスは送った内容の「直す」へ移る（押したボタンは書く欄ごと消える。GitHub Issue #213）。
    // 「直す」は上へ戻る位置にあるが、画面の上に止めた見出しの下には隠れない（GitHub Issue #212）
    await tabTo(page, home.getByRole('button', { name: '家庭からを送る' }));
    await pressAndExpectFocus(page, 'Enter', home.getByRole('button', { name: '直す', exact: true }));
    await expect(home).toContainText('送りました');
    await expect(home.getByRole('status')).toHaveText('急ぎはお電話でお願いします。');
    const lines = home.locator('.contact-home-lines');
    await expect(lines).toContainText('体温36.5℃');
    await expect(lines).toContainText('朝ごはんぜんぶ');
    await expect(lines).toContainText('きげんふつう');
    expect(errors, 'ブラウザ実行エラー').toEqual([]);
  });
});

test.describe('[guardian] contact 保護者の幅（390×844）', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('連絡帳画面を Tab で最後まで進み、Shift+Tab で戻っても、上に止めた見出し・下に止めた送る帯の下に隠れない', async ({ page }) => {
    // WCAG 2.4.11 フォーカスの非隠蔽（最低限）。GitHub Issue #212
    const errors = await open(page, 'guardian-contact');
    const visited = await walkThrough(page, page.getByRole('link', { name: '‹ ホームへ' }), '.contact-page');
    expect(visited.at(-1), '家庭からの書く欄を通って、下に止めた「家庭からを送る」まで進んだ').toContain('家庭からを送る');
    expect(errors, 'ブラウザ実行エラー').toEqual([]);
  });

  test('連絡帳画面の押せるものは 44×44px 以上で、隣との間は 8px 以上', async ({ page }) => {
    // 詳細設計書「全画面に共通する部品と決まり」(2-0) の「タッチの条件」(4)。GitHub Issue #215（直す前は「‹ ホームへ」が高さ 27px、選択肢の間が 4px）
    await open(page, 'guardian-contact');
    expect(await touchProblems(page, '.contact-page')).toEqual({ small: [], close: [] });
  });
});

test.describe('[staff] contact キーボードだけで通す', () => {
  test('① 職員が連絡帳（クラス）画面で家庭からを読み、確認しました を押す', async ({ page }) => {
    const errors = await open(page, 'contact-class');
    // 最初の Tab で「本文へ移動」に止まり、Enter で本文へ移る
    await key(page, 'Tab');
    await expect(page.getByRole('link', { name: '本文へ移動' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    // 並べ方を「家庭からの未確認を上に」へ（select は矢印で選び直す）
    const sort = page.getByRole('combobox', { name: '並べ方' });
    await tabTo(page, sort, { max: 10 });
    await key(page, 'ArrowDown');
    await expect(sort).toHaveValue('home');
    await ready(page);
    await expect(page.getByRole('rowheader').first()).toHaveText('上園 花子');

    const confirm = page.getByRole('button', { name: '金城 陸の家庭からを確認しました' });
    await tabTo(page, confirm);
    // 押したボタンは消え、確認した行は「未確認を上に」の並びで下へ移る。フォーカスはその行の「園が確認しました」へ移る（GitHub Issue #213）
    const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '金城 陸' }) });
    await pressAndExpectFocus(page, 'Enter', row.locator('.contact-confirmed'));
    await expect(row).toContainText('園が確認しました 13:30 高梨 倫太朗');
    await expect(confirm).toHaveCount(0);
    // 次の Tab は表の中の続き（同じ行の食事）へ進み、ページの先頭へ戻らない
    await key(page, 'Tab');
    await expect.poll(() => page.locator('.contact-class-table').evaluate((el) => el.contains(document.activeElement)),
      { message: '確認したあとの Tab が表の外へ出た' }).toBe(true);
    expect(errors, 'ブラウザ実行エラー').toEqual([]);
  });

  test('連絡帳（クラス）画面で食事の量を Enter で記録したあと、押したボタンにフォーカスが残る', async ({ page }) => {
    // 送っている間は表のボタンがすべて押せなくなる。応答のあと、押したボタンへ戻す（GitHub Issue #213）
    const errors = await open(page, 'contact-class');
    // まだ記録していない行の「ぜんぶ」。記録すると絞り込みに当たらなくなるので、名前で指し直す
    const unrecorded = page.locator('.contact-picks.is-meal').filter({ hasNot: page.locator('[aria-pressed="true"]') }).first();
    const name = await unrecorded.getByRole('button').first().getAttribute('aria-label');
    const zenbu = page.getByRole('button', { name: name!, exact: true });
    await tabTo(page, zenbu);
    await pressAndExpectFocus(page, 'Enter', zenbu);
    await expect(zenbu).toHaveAttribute('aria-pressed', 'true');
    expect(errors, 'ブラウザ実行エラー').toEqual([]);
  });

  test.describe('表が横に送られる幅（iPad の横向き 1024×768）', () => {
    test.use({ viewport: { width: 1024, height: 768 } });

    test('連絡帳（クラス）画面の表を Tab で最後まで進み、Shift+Tab で戻っても、左に止めた園児名の列の下に隠れない', async ({ page }) => {
      // WCAG 2.4.11 フォーカスの非隠蔽（最低限）。GitHub Issue #212（直す前は Tab で 20 か所、Shift+Tab で 22 か所がすっかり隠れた）
      const errors = await open(page, 'contact-class');
      const wrap = page.locator('.contact-table-wrap');
      expect(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth), 'この幅では表が横に送られる').toBe(true);
      const visited = await walkThrough(page, page.getByRole('rowheader').first().getByRole('link'), '.contact-table-wrap');
      expect(visited.at(-1), '表の最後の行の、右端の列（園から）まで進んだ').toContain('吉田 心春の園から');
      expect(errors, 'ブラウザ実行エラー').toEqual([]);
    });

    test('連絡帳（クラス）・連絡帳（園児）画面の押せるものは 44×44px 以上で、隣との間は 8px 以上', async ({ page }) => {
      // 「タッチの条件」(2-0 (4))。GitHub Issue #215（直す前は表のリンクの高さが 20px、排せつのボタンと「（時刻）を直す」の間が 4px、
      // 連絡帳（園児）画面の食事の区分と量の間が 4px）
      await open(page, 'contact-class');
      expect(await touchProblems(page, '.contact-class')).toEqual({ small: [], close: [] });
      await open(page, 'contact-child');
      expect(await touchProblems(page, '.contact-child')).toEqual({ small: [], close: [] });
    });
  });

  test('② 職員が午睡チェック画面の園児の行で ねた・おきた を記録する', async ({ page }) => {
    const errors = await open(page, 'nap');
    const row = page.getByRole('region', { name: '野原 太郎の午睡チェック' });
    const state = row.locator('.nap-sleep-state');
    await tabTo(page, row.getByRole('button', { name: '野原 太郎のねた' }));
    // 同じボタンが「おきた」になり、フォーカスはそのボタンに残る（GitHub Issue #213）。続けて Enter で「おきた」を記録できる
    await pressAndExpectFocus(page, 'Enter', row.getByRole('button', { name: '野原 太郎のおきた' }));
    await expect(state).toHaveText('13:30 ねた');
    await pressAndExpectFocus(page, 'Enter', row.getByRole('button', { name: '野原 太郎のもう一度ねた' }));
    await expect(state).toContainText('13:30〜13:30');

    // 押し間違いを直す窓：Tab で「直す・取り消す」へ。開くと中へ、Esc で閉じると開いた元へ
    const fix = row.getByRole('button', { name: '野原 太郎のねた・おきたを直す・取り消す' });
    await key(page, 'Tab');
    await expect(fix).toBeFocused();
    await key(page, 'Enter');
    await expectFocusInside(page, page.getByRole('dialog', { name: '記録を直す' }));
    await key(page, 'Escape');
    await expectFocusBack(page, fix);
    expect(errors, 'ブラウザ実行エラー').toEqual([]);
  });

  test('③ 職員が連絡帳（園児）画面の園からで、定型文を選び、宛先を確かめ、他児の名前の注意を経て送る', async ({ page }) => {
    const errors = await open(page, 'contact-child');
    const facility = page.getByRole('region', { name: '園から' });
    const text = facility.getByRole('textbox', { name: '園からのひとこと' });
    await tabTo(page, text);
    // 他児の呼び名（伊藤 葵＝あおちゃん）を入れて、注意が出る文にする
    await page.keyboard.type('あおちゃんとしゃぼん玉を追いかけていました。');
    await expectFocusVisible(page);

    // 定型文：開くと中へ入り、候補を読み込めたら最初の候補へフォーカスが移る（GitHub Issue #213）。
    // Tab で候補へ進めて Enter。閉じると「定型文」へ戻り、入力欄の末尾に足される
    const phraseButton = facility.getByRole('button', { name: '定型文', exact: true });
    await tabTo(page, phraseButton, { max: 3 });
    await key(page, 'Enter');
    const phrases = page.getByRole('dialog', { name: '定型文を選ぶ' });
    await expectFocusInside(page, phrases);
    await expect(phrases.locator('.phrase-list button').first()).toBeFocused();
    await expectFocusVisible(page);
    await tabTo(page, phrases.getByRole('button', { name: '明日もよろしくお願いします。' }), { max: 6 });
    await key(page, 'Enter');
    await expectFocusBack(page, phraseButton);
    await expect(text).toHaveValue('あおちゃんとしゃぼん玉を追いかけていました。明日もよろしくお願いします。');

    // 宛先：「送る」のすぐ上に、園児名・クラス・届く保護者
    const recipient = facility.getByRole('note', { name: '宛先' });
    await expect(recipient).toContainText('野原 太郎（さくら組）');
    await expect(recipient).toContainText('父に届きます');

    // 送る → 他児の名前の注意（フォーカスは窓の中）。Esc（直す）で閉じると「送る」へ戻り、入力は残る
    const send = facility.getByRole('button', { name: '送る', exact: true });
    await tabTo(page, send, { max: 3 });
    await page.keyboard.press('Enter');
    const check = page.getByRole('dialog', { name: 'ほかのお子さんの名前の注意' });
    await expectFocusInside(page, check);
    await expect(check.locator('mark')).toHaveText('あおちゃん');
    await key(page, 'Escape');
    await expectFocusBack(page, send);
    await expect(text).toHaveValue(/^あおちゃんと/);

    // もう一度送り、注意の中で「このまま送る」へ Tab で進めて Enter。
    // 送ったあとは窓も書く欄も消え、フォーカスは送った文の「直す」へ移る（GitHub Issue #213）
    await page.keyboard.press('Enter');
    await expectFocusInside(page, check);
    await tabTo(page, check.getByRole('button', { name: 'このまま送る' }), { max: 3 });
    await pressAndExpectFocus(page, 'Enter', facility.getByRole('button', { name: '直す', exact: true }));
    await expect(check).toHaveCount(0);
    await expect(facility).toContainText('送った 13:30 高梨 倫太朗');
    await expect(facility).toContainText('あおちゃんとしゃぼん玉を追いかけていました。明日もよろしくお願いします。');
    expect(errors, 'ブラウザ実行エラー').toEqual([]);
  });
});
