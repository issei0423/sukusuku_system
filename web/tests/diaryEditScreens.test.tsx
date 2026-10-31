// @vitest-environment jsdom
/*
 * 日誌作成・編集画面と配布物管理画面の操作（GitHub Issue #175・#178 の 2）
 * 典拠：基本設計書.md「日誌の作成から保護者への共有」(4-5)「雛形を選んだとき、本文が空なら雛形の内容を入れる。
 *      すでに入力があるときは末尾へ足す」「定型文は、本文の末尾へ足す」・「雛形・添付」(5-4)
 *      図/画面詳細図.md「全画面に共通する規定」(0-2)「完了の表示」・「日誌作成・編集画面」(3-2) 項目1・4・7・8・10・17・
 *      「日誌確認画面」(3-3) 項目3
 *
 * 写真の保存の規則は web/tests/diaryEdit.test.ts（モック）と server/api_diary_attach_test.go（Go サーバ）が確かめる。
 * ここでは画面の操作を確かめる。時計は tests/setup-clock.ts の 18:00 のまま使う。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import { clearNotice } from '../src/components/feedback';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

function open(path: string, user: SessionUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function settled() {
  await waitFor(() => {
    expect(document.body.textContent).not.toContain('読み込んでいます');
  }, { timeout: 3000 });
}

/** 日誌作成・編集画面の雛形と定型文の選択肢が読み込まれるまで待つ */
async function editorReady() {
  await settled();
  await waitFor(() => {
    expect((screen.getByLabelText('定型文を入れる') as HTMLSelectElement).options.length).toBeGreaterThan(1);
    expect((screen.getByLabelText('雛形を呼び出す') as HTMLSelectElement).options.length).toBeGreaterThan(1);
  }, { timeout: 3000 });
}

// 完了の表示は画面の外に持ち、止めた時計では消えない。前のテストの「下書きを保存しました」を次へ持ち越さない
afterEach(() => { cleanup(); act(() => clearNotice()); });

const bodyArea = () => document.querySelector('textarea') as HTMLTextAreaElement;
const phraseSelect = () => screen.getByLabelText('定型文を入れる') as HTMLSelectElement;
const templateSelect = () => screen.getByLabelText('雛形を呼び出す') as HTMLSelectElement;
const optionLabels = (s: HTMLSelectElement) => Array.from(s.options).map((o) => o.textContent);
const radio = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const button = (label: string) => screen.getByRole('button', { name: label }) as HTMLButtonElement;
const backToList = async () => fireEvent.click(await screen.findByRole('link', { name: '日誌一覧へ' }, { timeout: 3000 }));
const leaveDialog = () => screen.queryByRole('dialog', { name: '保存していない内容があります' });

/** 一覧へ戻ったこと（日誌一覧画面の見出し）を待つ */
async function onList() {
  await screen.findByRole('heading', { level: 1, name: '日誌' }, { timeout: 3000 });
}

/** 下書き保存し、保存できたことの表示を待つ */
async function saveDraft() {
  act(() => clearNotice());
  fireEvent.click(button('下書き保存'));
  await screen.findByText('下書きを保存しました', {}, { timeout: 3000 });
}

/** 保存した日誌の編集画面が開き直り、鈴木が編集ロックを取り直すまで待つ */
async function reopened(diaryId: number) {
  await waitFor(() => {
    expect(db.diaryLocks.some((l) => l.diary_id === diaryId && l.locked_staff_id === teacher.staff_id)).toBe(true);
  }, { timeout: 3000 });
  await waitFor(() => {
    expect(document.body.textContent).not.toContain('読み込んでいます');
    expect(screen.getByRole('heading', { level: 1, name: '日誌の編集' })).toBeTruthy();
    expect(button('下書き保存').disabled).toBe(false);
  }, { timeout: 3000 });
}

/** 担任の西田 太郎（C001）の個人日誌を書き始める */
async function startPersonal() {
  open('/staff/diary/new', teacher);
  await editorReady();
  fireEvent.change(screen.getByLabelText('対象の園児'), { target: { value: 'C001' } });
}

describe('定型文を入れる（#175 の 1）', () => {
  it('選んだ定型文を本文の末尾へ足す。書いてある本文の後ろは行を改めて足し、同じ定型文をもう一度選べる', async () => {
    await startPersonal();
    fireEvent.change(phraseSelect(), { target: { value: 'よく食べ、おかわりをしていました。' } });
    expect(bodyArea().value).toBe('よく食べ、おかわりをしていました。');
    // 選んだあとは「定型文を入れる」へ戻す。同じ定型文を続けて選べるようにする
    expect(phraseSelect().value).toBe('');

    fireEvent.change(bodyArea(), { target: { value: '園庭で遊びました。' } });
    fireEvent.change(phraseSelect(), { target: { value: '午睡は落ち着いて入眠できました。' } });
    expect(bodyArea().value).toBe('園庭で遊びました。\n午睡は落ち着いて入眠できました。');
    fireEvent.change(phraseSelect(), { target: { value: '午睡は落ち着いて入眠できました。' } });
    expect(bodyArea().value).toBe('園庭で遊びました。\n午睡は落ち着いて入眠できました。\n午睡は落ち着いて入眠できました。');
  });
});

describe('保存していない内容の確かめ（#175 の 3 とコメント）', () => {
  it('定型文を選んだだけでも、一覧へ戻る前に確かめる', async () => {
    await startPersonal();
    fireEvent.change(phraseSelect(), { target: { value: 'よく食べ、おかわりをしていました。' } });
    await backToList();
    expect(leaveDialog()).toBeTruthy();
  });

  it('写真を足しただけでも、記録種別を変えただけでも、一覧へ戻る前に確かめる', async () => {
    open('/staff/diary/new', teacher);
    await settled();
    fireEvent.click(button('追加'));
    await backToList();
    expect(leaveDialog()).toBeTruthy();
    cleanup();

    open('/staff/diary/new', teacher);
    await settled();
    fireEvent.click(radio('クラス日誌'));
    await backToList();
    expect(leaveDialog()).toBeTruthy();
  });

  it('新しく書いて下書き保存した直後は、確かめずに一覧へ戻る', async () => {
    await startPersonal();
    fireEvent.change(bodyArea(), { target: { value: '下書き保存してから戻る' } });
    await saveDraft();
    await reopened(db.diaries.find((d) => d.body === '下書き保存してから戻る')!.diary_id);
    await backToList();
    expect(leaveDialog()).toBeNull();
    await onList();
  });

  it('既存の日誌を直して下書き保存した直後は、確かめずに一覧へ戻る。保存のあとにまた直したら確かめる', async () => {
    open('/staff/diary/1', teacher);
    await settled();
    await waitFor(() => expect(button('下書き保存').disabled).toBe(false));
    fireEvent.change(bodyArea(), { target: { value: `${bodyArea().value}\n直した一文。` } });
    await saveDraft();
    await reopened(1);

    fireEvent.change(bodyArea(), { target: { value: `${bodyArea().value}\nもう一文。` } });
    await backToList();
    expect(leaveDialog()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));

    await saveDraft();
    expect(db.diaries.find((d) => d.diary_id === 1)?.body).toContain('もう一文。');
    await backToList();
    expect(leaveDialog()).toBeNull();
    await onList();
  });
});

describe('写真（#175 の 2）', () => {
  it('足した写真は下書き保存で日誌に付き、確認画面の枚数のまま申請される', async () => {
    await startPersonal();
    fireEvent.change(bodyArea(), { target: { value: '写真を付けた日誌' } });
    fireEvent.click(button('追加'));
    fireEvent.click(button('追加'));
    // 時計が止まっていても、足した写真は別々のものとして並ぶ
    expect(screen.getAllByRole('button', { name: '削除' })).toHaveLength(2);
    await saveDraft();
    const saved = db.diaries.find((d) => d.body === '写真を付けた日誌')!;
    expect(db.diaryAttachments.filter((a) => a.diary_id === saved.diary_id)).toHaveLength(2);

    // 開き直した画面にも 2 枚。もう 1 枚足して確認へ進み、申請する
    await reopened(saved.diary_id);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '削除' })).toHaveLength(2));
    await waitFor(() => expect(button('確認へ進む').disabled).toBe(false));
    fireEvent.click(button('追加'));
    fireEvent.click(button('確認へ進む'));
    await screen.findByText('この内容で申請します');
    const photoRow = screen.getByText('写真', { selector: 'th' }).closest('tr')!;
    expect(within(photoRow).getByText('3 枚')).toBeTruthy();
    await waitFor(() => expect(button('申請する').disabled).toBe(false));
    fireEvent.click(button('申請する'));
    await onList();
    expect(db.diaryAttachments.filter((a) => a.diary_id === saved.diary_id)).toHaveLength(3);
    expect(db.diaries.find((d) => d.diary_id === saved.diary_id)?.status).toBe('2');
  });
});

describe('雛形を呼び出す（#178 の 2）', () => {
  it('いまの記録種別の雛形だけを並べ、選んでも記録種別を変えない', async () => {
    open('/staff/diary/new', teacher);
    await editorReady();
    expect(optionLabels(templateSelect())).toEqual(['雛形を呼び出す', '個人日誌（標準）']);

    fireEvent.click(radio('クラス日誌'));
    expect(optionLabels(templateSelect())).toEqual(['雛形を呼び出す', 'クラス日誌（標準）']);
    expect(optionLabels(templateSelect())).not.toContain('ヒヤリハット');
    const tpl = db.diaryTemplates.find((t) => t.template_name === 'クラス日誌（標準）')!;
    fireEvent.change(templateSelect(), { target: { value: String(tpl.diary_template_id) } });
    expect(bodyArea().value).toBe(tpl.body);
    expect(radio('クラス日誌').checked).toBe(true);
    expect(screen.queryByLabelText('対象の園児')).toBeNull();
    // 選んだあとは「雛形を呼び出す」へ戻す
    expect(templateSelect().value).toBe('');

    // 入力済みなら末尾へ足す（基本設計書 4-5）
    fireEvent.change(templateSelect(), { target: { value: String(tpl.diary_template_id) } });
    expect(bodyArea().value).toBe(`${tpl.body.trimEnd()}\n\n${tpl.body}`);
  });
});

describe('編集できない日誌の部品（#175 の 4）', () => {
  it('申請中の日誌では、記録種別・雛形・定型文・写真を動かせない', async () => {
    open('/staff/diary/7', teacher);
    await settled();
    await screen.findByText('申請中のため編集できません。');
    for (const label of ['個人日誌', 'クラス日誌', '週案・月案', 'ヒヤリハット']) {
      expect(radio(label).disabled).toBe(true);
    }
    // 押しても記録種別は変わらない（個人日誌の「対象の園児」の欄が残る）
    fireEvent.click(radio('クラス日誌'));
    expect(screen.getByLabelText('対象の園児')).toBeTruthy();
    expect(templateSelect().disabled).toBe(true);
    expect(phraseSelect().disabled).toBe(true);
    expect(button('追加').disabled).toBe(true);
  });

  it('ほかの職員が編集中の日誌では、記録種別・園児・クラス・記録日・雛形・定型文・写真を動かせない', async () => {
    const lock = await api.acquireLock(admin, 1);
    if (!('token' in lock)) throw new Error('園長がロックを取れませんでした');
    try {
      open('/staff/diary/1', teacher);
      await settled();
      await screen.findByText(/西田 拓也さんが編集中です。/);
      const before = bodyArea().value;
      expect(radio('クラス日誌').disabled).toBe(true);
      expect((screen.getByLabelText('対象の園児') as HTMLSelectElement).disabled).toBe(true);
      expect((screen.getByLabelText('対象のクラス') as HTMLSelectElement).disabled).toBe(true);
      expect((screen.getByLabelText('記録日') as HTMLInputElement).disabled).toBe(true);
      expect(templateSelect().disabled).toBe(true);
      expect(phraseSelect().disabled).toBe(true);
      expect(button('追加').disabled).toBe(true);
      expect(bodyArea().value).toBe(before);
    } finally {
      await api.releaseLock(admin, 1, false, lock.token);
    }
  });
});

describe('配布物の掲載・取り下げの完了の表示（#175 の 5）', () => {
  // 題は月の名前にしない。モックの配布物は「今月の献立表」を実行した月の名前で作るので、月の名前だと同じ題が2つになる（11月に落ちた）
  const TITLE = '冬休み中の献立表（試し）';

  it('掲載したあと・取り下げたあとに、画面の下端に完了を出す', async () => {
    open('/staff/handouts', admin);
    await settled();
    fireEvent.click(button('配布物を掲載する'));
    const form = await screen.findByRole('dialog', { name: '配布物の掲載' });
    fireEvent.change(within(form).getByLabelText('種類'), { target: { value: '2' } });
    fireEvent.change(within(form).getByPlaceholderText('例：10月の献立表'), { target: { value: TITLE } });
    fireEvent.change(form.querySelector('input[type="file"]')!, {
      target: { files: [new File(['%PDF'], 'kondate-test.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(within(form).getByRole('button', { name: '掲載する' }));
    expect(await screen.findByText(`「${TITLE}」を掲載しました`, {}, { timeout: 3000 })).toBeTruthy();

    const row = (await screen.findByText(TITLE, { selector: 'td' })).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: '取り下げ' }));
    const confirm = await screen.findByRole('dialog', { name: '配布物の取り下げ' });
    fireEvent.click(within(confirm).getByRole('button', { name: '取り下げる' }));
    expect(await screen.findByText(`「${TITLE}」を取り下げました`, {}, { timeout: 3000 })).toBeTruthy();
  });
});

/*
 * きょうのようすから入れる・確認画面からの「戻る」（GitHub Issue #278 の 2・コメントで足された 3。PR #334 の review の 1）
 * 典拠：詳細設計書「日誌の画面（作り直し）」(2-13 (4))「新しく作る個人日誌は、園児と記録日が決まったら1回だけ自動で入れる」・
 *      (2-13 (9))「確認画面で「戻る」｜解除しない（編集画面がトークンを受け取って続ける）」
 */
describe('きょうのようすから入れる・確認画面から戻る（#278）', () => {
  it('新しい個人日誌で園児と記録日が決まると、その日の記録を本文へ1回だけ入れる。押せば末尾へもう一度足す', async () => {
    // デモデータの西田 太郎（C001）には、今日の連絡帳の記録がある。入る行は API の返す行と同じ
    const { lines } = await api.diaryLines(teacher, 'C001', today());
    expect(lines.length).toBeGreaterThan(0);
    const added = `【きょうのようす（連絡帳から）】\n${lines.join('\n')}`;
    await startPersonal();
    await waitFor(() => expect(bodyArea().value).toBe(added), { timeout: 3000 });
    // 自動は1画面で1回だけ。園児を選び直しても、もう入れない
    fireEvent.change(screen.getByLabelText('対象の園児'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('対象の園児'), { target: { value: 'C001' } });
    fireEvent.change(bodyArea(), { target: { value: '園庭で遊びました。' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(bodyArea().value).toBe('園庭で遊びました。');
    // 押したときは、書いてある本文の末尾へ行を改めて足す（置き換えない）
    fireEvent.click(button('きょうのようすから入れる'));
    await waitFor(() => expect(bodyArea().value).toBe(`園庭で遊びました。\n${added}`), { timeout: 3000 });
  });

  it('確認画面から「戻る」で戻ると、確認画面が持っていた編集ロックをそのまま続ける（取り直さない）', async () => {
    await startPersonal();
    fireEvent.change(bodyArea(), { target: { value: 'ロックを持ったまま確認から戻る' } });
    await saveDraft();
    const diaryId = db.diaries.find((d) => d.body === 'ロックを持ったまま確認から戻る')!.diary_id;
    await reopened(diaryId);
    const tokenNow = () => db.diaryLocks.find((l) => l.diary_id === diaryId)?.lock_token;
    const before = tokenNow();
    expect(before).toBeTruthy();

    await waitFor(() => expect(button('確認へ進む').disabled).toBe(false));
    fireEvent.click(button('確認へ進む'));
    fireEvent.click(await screen.findByRole('button', { name: '戻る' }, { timeout: 3000 }));
    await reopened(diaryId);
    // 取り直すと識別子が替わる（モックの acquireLock は取るたびに新しい識別子を出す）
    expect(tokenNow()).toBe(before);
    expect(bodyArea().value).toBe('ロックを持ったまま確認から戻る');
  });
});
