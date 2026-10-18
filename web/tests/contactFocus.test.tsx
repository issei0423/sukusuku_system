// @vitest-environment jsdom
/*
 * 押したあと・窓を開いたときのフォーカスの置き場所
 * 典拠：WCAG 2.4.3 フォーカス順序、GitHub Issue #213
 * 画面の上での動き（キーボードだけで通す道）は tests/responsive/a11y-keyboard-contact.spec.ts で確かめる
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';
import { clearNotice } from '../src/components/feedback';
import { focusAfter, focusedNow } from '../src/focusAfter';
import TemperaturePicker from '../src/components/TemperaturePicker';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
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

/** キーボードで押したときと同じく、フォーカスを入れてから押す（jsdom はクリックでフォーカスを移さない） */
function press(el: HTMLElement) {
  act(() => el.focus());
  fireEvent.click(el);
}

afterEach(() => {
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
