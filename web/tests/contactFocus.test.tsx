// @vitest-environment jsdom
/*
 * 押したあと・窓を開いたときのフォーカスの置き場所
 * 典拠：WCAG 2.4.3 フォーカス順序、GitHub Issue #213
 * 画面の上での動き（キーボードだけで通す道）は tests/responsive/a11y-keyboard-contact.spec.ts で確かめる
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';
import { api } from '../src/api/client';
import { today } from '../src/api/util';
import { clearNotice } from '../src/components/feedback';
import { focusAfter, focusedNow } from '../src/focusAfter';
import TemperaturePicker from '../src/components/TemperaturePicker';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = { ...teacher, account_id: 1, role: '1', staff_id: 'S001', class_id: null, class_name: null, display_name: '野原 一誠' };

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
 * ブラウザ（Chromium）は、送っている間に押せなくなった（disabled）ボタンからフォーカスを外して body に落とす。
 * jsdom は外さず、押せないボタンの blur() も効かないので、いったん押せるようにして外す
 */
function dropFocus(el: HTMLButtonElement) {
  expect(el.disabled, '送っている間は押せない').toBe(true);
  act(() => { el.disabled = false; el.blur(); el.disabled = true; });
  expect(document.activeElement).toBe(document.body);
}

afterEach(() => {
  vi.restoreAllMocks();
  act(() => clearNotice());
  cleanup();
  document.body.innerHTML = '';
});

/** MutationObserver の知らせ（マイクロタスク）を待つ */
const settle = () => act(async () => { await Promise.resolve(); });

function button(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  document.body.append(b);
  return b;
}

describe('押したあとのフォーカス（src/focusAfter.ts、GitHub Issue #213）', () => {
  it('送っている間に押せなくなったボタンは、押せるようになったらそこへフォーカスを戻す', async () => {
    const send = button('送る');
    send.focus();
    const pressed = focusedNow();
    expect(pressed).toBe(send);
    // ブラウザは押せなくなったボタンからフォーカスを外して body に落とす（jsdom は落とさないので、外してから押せなくする）
    send.blur();
    send.disabled = true;
    focusAfter(pressed);
    await settle();
    expect(document.activeElement).toBe(document.body);
    send.disabled = false;
    await settle();
    expect(document.activeElement).toBe(send);
  });

  it('押したボタンが消えるときは、決めた場所が現れたらそこへ移す', async () => {
    const confirm = button('確認しました');
    confirm.focus();
    const pressed = focusedNow();
    focusAfter(pressed, () => document.querySelector<HTMLElement>('[data-done]'));
    confirm.remove();
    await settle();
    const done = document.createElement('p');
    done.tabIndex = -1;
    done.dataset.done = '';
    document.body.append(done);
    await settle();
    expect(document.activeElement).toBe(done);
  });

  it('待つ間に利用者がほかへフォーカスを移したら、動かさない', async () => {
    const confirm = button('確認しました');
    const other = button('ほか');
    confirm.focus();
    const pressed = focusedNow();
    focusAfter(pressed, () => document.querySelector<HTMLElement>('[data-done]'));
    confirm.remove();
    other.focus();
    const done = document.createElement('p');
    done.tabIndex = -1;
    done.dataset.done = '';
    document.body.append(done);
    await settle();
    expect(document.activeElement).toBe(other);
  });

  it('押したときにフォーカスが無ければ（body）、何もしない', async () => {
    const send = button('送る');
    const pressed = focusedNow();
    expect(pressed).toBeNull();
    focusAfter(pressed, () => send);
    await settle();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('体温の一覧の窓（GitHub Issue #213）', () => {
  it('開くと平熱の値にフォーカスが入る', () => {
    render(<TemperaturePicker title="伊藤 葵の体温" start={36.8} onSelect={() => {}} onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '36.8', exact: true }));
  });

  it('平熱が無ければ 36.5 にフォーカスが入る', () => {
    render(<TemperaturePicker title="体温" start={null} onSelect={() => {}} onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '36.5', exact: true }));
  });

  /*
   * 値を押すと窓が閉じてそのまま送る。窓の部品（Modal）は開いた元へフォーカスを戻すが、開いた元は送っている間は押せないので戻らず、
   * 押した値のボタンは窓ごと消える。応答のあと、開いた元（押せるようになった「＋体温」）へ移す
   */
  it('連絡帳（クラス）画面：値を選んで記録したあと、開いた元の「＋体温」へフォーカスを戻す', async () => {
    open('/staff/contact', teacher);
    const add = await screen.findByRole('button', { name: '上園 花子の体温を記録する' }, { timeout: 3000 });
    press(add);
    const dialog = screen.getByRole('dialog', { name: '上園 花子の体温' });
    const value = within(dialog).getByRole('button', { name: '36.8', exact: true });
    expect(document.activeElement).toBe(value);
    fireEvent.click(value);
    await waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain('上園 花子さんの「36.8℃」を記録しました。'), { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '上園 花子の体温を記録する' })), { timeout: 3000 });
  });

  it('連絡帳（園児）画面：値を選んで記録したあと、開いた元の「体温を記録する」へフォーカスを戻す', async () => {
    open('/staff/contact/C001', teacher);
    const add = await screen.findByRole('button', { name: '体温を記録する' }, { timeout: 3000 });
    press(add);
    const dialog = screen.getByRole('dialog', { name: '野原 太郎の体温' });
    const value = document.activeElement as HTMLElement;
    expect(dialog.contains(value)).toBe(true);
    fireEvent.click(value);
    await waitFor(() => expect(document.querySelector('.toast')?.textContent).toMatch(/野原 太郎さんの「\d{2}\.\d℃」（\d{2}:\d{2}）を記録しました。/), { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '体温を記録する' })), { timeout: 3000 });
  });
});

describe('午睡チェック画面の「対象外」の窓と、行の「戻す」（GitHub Issue #213）', () => {
  /** デモの実施（13:00 開始）は 18:00 には自動で終わっている。新しく始める */
  async function startNap() {
    const active = await api.activeSession(1, today(), admin);
    if (active) await api.endSession(admin, active.nap_session_id);
    return api.startSession(teacher, 1, today());
  }

  it('開くと最初の理由「欠席」にフォーカスが入り、「やめる」で閉じると開いた元の「対象外」へ戻る', async () => {
    await startNap();
    open('/staff/nap', teacher);
    const opener = await screen.findByRole('button', { name: '加藤 大和をきょうは対象外にする' }, { timeout: 3000 });
    press(opener);
    const dialog = screen.getByRole('dialog', { name: '加藤 大和をきょうは対象外にする' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '欠席' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  /*
   * 理由を押すとそのまま送り、窓が閉じる。窓の部品は開いた元の「対象外」へフォーカスを戻すが、「対象外」は読み直すと消える。
   * 応答のあと、同じ行に現れる「戻す」へ移す（「ねた」が同じ場所の「おきた」に替わるのと同じ）
   */
  it('理由を選んで対象外にしたら、窓が閉じたあと、同じ行の「戻す」へフォーカスが移る', async () => {
    await startNap();
    open('/staff/nap', teacher);
    const opener = await screen.findByRole('button', { name: '加藤 大和をきょうは対象外にする' }, { timeout: 3000 });
    const row = opener.closest('.nap-record-row') as HTMLElement;
    press(opener);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '欠席' }));
    const restore = await within(row).findByRole('button', { name: '加藤 大和の対象外を戻す' }, { timeout: 3000 });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(restore), { timeout: 3000 });
  });

  it('理由を選んで送れなかったときは、窓を開いたまま、押した理由のボタンへフォーカスを戻す', async () => {
    const session = await startNap();
    open('/staff/nap', teacher);
    const opener = await screen.findByRole('button', { name: '野原 太郎をきょうは対象外にする' }, { timeout: 3000 });
    press(opener);
    const dialog = screen.getByRole('dialog', { name: '野原 太郎をきょうは対象外にする' });
    // 窓を開いている間に、ほかの職員が「ねた」を記録した（ねたあとは対象外にできない）
    await api.sleep(teacher, session.nap_session_id, 'C001');
    const noNap = within(dialog).getByRole('button', { name: '午睡なし' }) as HTMLButtonElement;
    press(noNap);
    dropFocus(noNap);
    await waitFor(() => expect(document.querySelector('.nap-sleep-error')?.textContent).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByRole('dialog', { name: '野原 太郎をきょうは対象外にする' })).toBe(dialog);
    await waitFor(() => expect(document.activeElement).toBe(noNap), { timeout: 3000 });
  });

  /*
   * 行の「戻す」は送っている間に押せなくなり、戻すと「戻す」が消えて「ねた」「対象外」に替わる。
   * 応答のあと、同じ行に現れる「対象外」へ移す（対象外にしたら「戻す」へ移すのと対になる）
   */
  it('「戻す」を押して対象外を戻したら、同じ行に現れる「対象外」へフォーカスが移る', async () => {
    const session = await startNap();
    await api.exclude(teacher, session.nap_session_id, 'C001', '1');
    open('/staff/nap', teacher);
    const restore = await screen.findByRole('button', { name: '野原 太郎の対象外を戻す' }, { timeout: 3000 }) as HTMLButtonElement;
    const row = restore.closest('.nap-record-row') as HTMLElement;
    press(restore);
    dropFocus(restore);
    const opener = await within(row).findByRole('button', { name: '野原 太郎をきょうは対象外にする' }, { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(opener), { timeout: 3000 });
  });

  it('「戻す」が送れなかったときは、「戻す」へフォーカスを戻す', async () => {
    const session = await startNap();
    await api.exclude(teacher, session.nap_session_id, 'C001', '1');
    open('/staff/nap', teacher);
    const restore = await screen.findByRole('button', { name: '野原 太郎の対象外を戻す' }, { timeout: 3000 }) as HTMLButtonElement;
    vi.spyOn(api, 'cancelExclusion').mockRejectedValueOnce(new Error('この実施は終わっています。'));
    press(restore);
    dropFocus(restore);
    await waitFor(() => expect(document.querySelector('.nap-sleep-error')?.textContent).toBe('この実施は終わっています。'), { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).toBe(restore), { timeout: 3000 });
  });
});
