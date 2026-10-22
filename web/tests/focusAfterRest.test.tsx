// @vitest-environment jsdom
/*
 * 押したあと・窓を閉じたあとに、フォーカスが body に落ちないこと（連絡帳の層・午睡チェックのほかの残り）
 * 典拠：WCAG 2.4.3 フォーカス順序、GitHub Issue #213。共通の決まりは src/focusAfter.ts
 *   1. AI の下書き（components/AiDraftPanel.tsx）の「言い換え」「続き」「この文を使う」「下書きを作る」
 *   2. 日誌・チャット・管理画面の「送る」「保存する」
 *   3. 窓の部品（components/ui.tsx の Modal）：閉じるとき、開いた元が押せない・消えている
 *
 * jsdom は、押せなくなった（disabled）ボタンからフォーカスを外さない。ブラウザ（Chromium）と同じく body に落としてから確かめる。
 * 相手はモック（api/mock.ts）。mockDb はこのファイルのテストで使い回す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';
import { api } from '../src/api/client';
import { mockAi } from '../src/api/mock';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import { clearNotice } from '../src/components/feedback';
import { Modal } from '../src/components/ui';
import { AI_TEXT } from '../src/messages';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const miyagi: SessionUser = {
  account_id: 9, email: 'miyagi.r@example.jp', role: '3', display_name: '宮城 蓮',
  staff_id: null, guardian_id: 'G004', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 園長',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
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

/** キーボードで押したときと同じく、フォーカスを入れてから押す（jsdom はクリックでフォーカスを移さない） */
function press(el: HTMLElement) {
  act(() => el.focus());
  fireEvent.click(el);
}

/**
 * ブラウザ（Chromium）は、押せなくなった（disabled）ボタンからフォーカスを外して body に落とす。
 * jsdom は外さず、押せないボタンの blur() も効かないので、いったん押せるようにして外す
 */
function dropFocus(el: HTMLButtonElement) {
  expect(el.disabled, '作っている間・送っている間は押せない').toBe(true);
  act(() => { el.disabled = false; el.blur(); el.disabled = true; });
  expect(document.activeElement).toBe(document.body);
}

/** MutationObserver の知らせ（マイクロタスク）を待つ */
const settle = () => act(async () => { await Promise.resolve(); });

const setSetting = (key: string, value: string) => { db.settings.find((s) => s.setting_key === key)!.setting_value = value; };

beforeEach(() => {
  Object.assign(mockAi, { mode: 'ok', keyPresent: true, keyRejected: false, lastSent: null, calls: 0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => clearNotice());
  cleanup();
  document.body.innerHTML = '';
  setSetting('ai.enabled', '0');
});

describe('AI の下書き：押したあとのフォーカス（GitHub Issue #213）', () => {
  const recordAside = () => screen.getByRole('complementary', { name: '記録する' });
  async function openChild() {
    setSetting('ai.enabled', '1');
    open('/staff/contact/C001', teacher);
    await screen.findByRole('heading', { name: '野原 太郎' }, { timeout: 3000 });
  }

  it('「言い換え」：作っている間に外れたフォーカスを、作り終えたら押した「言い換え」へ戻す', async () => {
    await openChild();
    const aside = recordAside();
    const box = within(aside).getByLabelText('活動のひとこと') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'たっくんは砂場で遊んでいました。スコップで型抜きをしました。' } });
    const rephrase = await within(aside).findByRole('button', { name: AI_TEXT.rephraseButton }, { timeout: 3000 }) as HTMLButtonElement;
    press(rephrase);
    dropFocus(rephrase);
    await within(aside).findAllByRole('button', { name: AI_TEXT.useThis }, { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(rephrase));
  });

  it('「続き」：作れなかったときも、押した「続き」へ戻す', async () => {
    await openChild();
    const aside = recordAside();
    const box = within(aside).getByLabelText('活動のひとこと') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '砂場で遊びました。' } });
    mockAi.mode = 'fail';
    const cont = await within(aside).findByRole('button', { name: AI_TEXT.continueButton }, { timeout: 3000 }) as HTMLButtonElement;
    press(cont);
    dropFocus(cont);
    await waitFor(() => expect(cont.disabled).toBe(false), { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(cont));
  });

  it('「この文を使う」：候補のカードが消えるので、文を入れた入力欄へ移す', async () => {
    await openChild();
    const aside = recordAside();
    const box = within(aside).getByLabelText('活動のひとこと') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'たっくんは砂場で遊んでいました。スコップで型抜きをしました。' } });
    fireEvent.click(await within(aside).findByRole('button', { name: AI_TEXT.rephraseButton }, { timeout: 3000 }));
    const cards = await within(aside).findAllByRole('button', { name: AI_TEXT.useThis }, { timeout: 3000 });
    press(cards[1]);
    expect(box.value).toBe('たっくんは砂場で遊んでいました。');
    expect(within(aside).queryByRole('button', { name: AI_TEXT.useThis })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it('メモの「下書きを作る」：作れたらメモの欄が閉じるので、欄を開いた「AI で下書き」へ移す', async () => {
    for (const f of db.contactFacilities) if (f.child_id === 'C001' && f.contact_date === today()) f.is_deleted = true;
    await openChild();
    const section = document.getElementById('facility') as HTMLElement;
    const opener = await within(section).findByRole('button', { name: AI_TEXT.draftButton }, { timeout: 3000 }) as HTMLButtonElement;
    press(opener);
    fireEvent.change(within(section).getByLabelText(/^メモ/), { target: { value: 'しゃぼん玉を追いかけた' } });
    const make = within(section).getByRole('button', { name: AI_TEXT.makeDraft }) as HTMLButtonElement;
    press(make);
    dropFocus(make);
    const box = within(section).getByLabelText('園からのひとこと') as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).not.toBe(''), { timeout: 3000 });
    expect(make.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe('日誌・チャット・管理画面の「送る」「保存する」（GitHub Issue #213）', () => {
  const composer = () => screen.getByPlaceholderText('メッセージを入力') as HTMLTextAreaElement;
  const rowOf = (body: string) => Array.from(document.querySelectorAll<HTMLElement>('.msg'))
    .find((m) => m.querySelector('.bubble')?.textContent?.includes(body)) ?? null;

  it('チャット（職員）：送れたら欄が空になって「送信」が押せなくなるので、入力欄へ移す。編集の「保存」は吹き出しへ戻す', async () => {
    open('/staff/chat?room=8', teacher);
    await waitFor(() => expect(document.querySelector('.channel.current')?.textContent).toContain('宮城 美咲の園とのやりとり'), { timeout: 3000 });
    fireEvent.change(composer(), { target: { value: 'F1 お迎えは17時の予定です。' } });
    const send = screen.getByRole('button', { name: '送信' }) as HTMLButtonElement;
    press(send);
    await waitFor(() => expect(rowOf('F1 お迎えは17時の予定です。')).toBeTruthy(), { timeout: 3000 });
    expect(send.disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(composer()));

    const row = rowOf('F1 お迎えは17時の予定です。')!;
    const bubble = row.querySelector<HTMLElement>('.bubble')!;
    fireEvent.contextMenu(bubble, { button: 2, clientX: 120, clientY: 90 });
    fireEvent.click(within(row).getByRole('button', { name: '編集' }));
    fireEvent.change(row.querySelector('textarea')!, { target: { value: 'F1 お迎えは17時30分の予定です。' } });
    const save = within(row).getByRole('button', { name: '保存' });
    press(save);
    // 編集の欄の文も吹き出しの textContent に入るので、欄が消えるのを待ってから本文を見る
    await waitFor(() => expect(row.querySelector('textarea')).toBeNull(), { timeout: 3000 });
    expect(save.isConnected).toBe(false);
    await waitFor(() => expect(bubble.textContent).toContain('F1 お迎えは17時30分の予定です。'), { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(bubble));
  });

  it('チャット（保護者）：送れたら入力欄へ、編集の「保存」は吹き出しへ移す', async () => {
    open('/guardian/chat', miyagi);
    fireEvent.click((await screen.findByText('担任の先生とのやりとり', undefined, { timeout: 3000 })).closest('button')!);
    const input = await screen.findByRole('textbox', { name: 'メッセージを入力' }, { timeout: 3000 }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'G1 あしたは9時に登園します。' } });
    const send = screen.getByRole('button', { name: '送信' }) as HTMLButtonElement;
    press(send);
    await waitFor(() => expect(rowOf('G1 あしたは9時に登園します。')).toBeTruthy(), { timeout: 3000 });
    expect(send.disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(input));

    const row = rowOf('G1 あしたは9時に登園します。')!;
    const bubble = row.querySelector<HTMLElement>('.bubble')!;
    fireEvent.contextMenu(bubble, { button: 2, clientX: 120, clientY: 90 });
    fireEvent.click(within(row).getByRole('button', { name: '編集' }));
    fireEvent.change(within(row).getByRole('textbox', { name: 'メッセージの編集' }), { target: { value: 'G1 あしたは9時30分に登園します。' } });
    const save = within(row).getByRole('button', { name: '保存' });
    press(save);
    await waitFor(() => expect(row.querySelector('textarea')).toBeNull(), { timeout: 3000 });
    await waitFor(() => expect(bubble.textContent).toContain('G1 あしたは9時30分に登園します。'), { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(bubble));
  });

  it('日誌：「下書き保存」が保存できなかったときは、押せるようになった「下書き保存」へ戻す', async () => {
    vi.spyOn(api, 'saveDiary').mockRejectedValue(new Error('保存できませんでした（テスト）'));
    open('/staff/diary/new', teacher);
    const save = await screen.findByRole('button', { name: '下書き保存' }, { timeout: 3000 }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false), { timeout: 3000 });
    press(save);
    dropFocus(save);
    await screen.findByText('保存できませんでした（テスト）', undefined, { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(save));
  });

  it('管理画面（設定）：確認の窓で「保存する」を押すと区画が描き直されて開いた元が消えるので、本文（main）へ移す', async () => {
    open('/staff/admin/settings', admin);
    await screen.findByRole('heading', { name: 'AI の下書き' }, { timeout: 3000 });
    fireEvent.click(screen.getByRole('radio', { name: '使う' }));
    const opener = screen.getByRole('button', { name: '保存する' });
    press(opener);
    const dialog = await screen.findByRole('dialog', { name: '設定を保存しますか' });
    // 区画は読んだ時刻（秒まで）を key にして描き直す。テストの時計は止まっているので、1秒進めて読み直しと同じ形にする
    vi.setSystemTime(Date.now() + 1000);
    press(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '設定を保存しますか' })).toBeNull(), { timeout: 3000 });
    expect(opener.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('main')));
  });
});

describe('窓の部品（Modal）：閉じたときのフォーカス（GitHub Issue #213）', () => {
  /** 開いた元を、押せなくする・消すことができる画面 */
  function Screen({ withReturnTo }: { withReturnTo?: boolean }) {
    const [opened, setOpened] = useState(false);
    const [state, setState] = useState<'ok' | 'disabled' | 'gone'>('ok');
    return (
      <main tabIndex={-1}>
        {state !== 'gone' && <button disabled={state === 'disabled'} onClick={() => setOpened(true)}>開く</button>}
        <p tabIndex={-1} data-return>戻り先</p>
        {opened && (
          <Modal title="窓" onClose={() => setOpened(false)}
            returnTo={withReturnTo ? () => document.querySelector<HTMLElement>('[data-return]') : undefined}
            footer={<>
              <button onClick={() => { setState('disabled'); setOpened(false); }}>押せなくして閉じる</button>
              <button onClick={() => { setState('gone'); setOpened(false); }}>消して閉じる</button>
            </>}>
            <p>中身</p>
          </Modal>
        )}
      </main>
    );
  }

  it('押せる開いた元へは、これまでどおりすぐ戻す', () => {
    render(<Screen />);
    press(screen.getByRole('button', { name: '開く' }));
    expect(screen.getByRole('dialog', { name: '窓' }).contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '開く' }));
  });

  it('開いた元が押せないときは、押せるようになるのを待って戻す', async () => {
    render(<Screen />);
    const opener = screen.getByRole('button', { name: '開く' }) as HTMLButtonElement;
    press(opener);
    press(screen.getByRole('button', { name: '押せなくして閉じる' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener.disabled).toBe(true);
    await settle();
    expect(document.activeElement).toBe(document.body);
    // 押せるようにする（送り終えたなど）。利用者の操作ではないので、キーやポインタの知らせを出さずに属性を変える
    act(() => { opener.disabled = false; });
    await settle();
    expect(document.activeElement).toBe(opener);
  });

  it('開いた元が消えたら、本文（main）へ移す', async () => {
    render(<Screen />);
    press(screen.getByRole('button', { name: '開く' }));
    press(screen.getByRole('button', { name: '消して閉じる' }));
    expect(screen.queryByRole('button', { name: '開く' })).toBeNull();
    await settle();
    expect(document.activeElement).toBe(document.querySelector('main'));
  });

  it('開いた元が消えたら、呼んだ側が渡した戻り先（returnTo）へ移す', async () => {
    render(<Screen withReturnTo />);
    press(screen.getByRole('button', { name: '開く' }));
    press(screen.getByRole('button', { name: '消して閉じる' }));
    await settle();
    expect(document.activeElement).toBe(document.querySelector('[data-return]'));
  });
});
