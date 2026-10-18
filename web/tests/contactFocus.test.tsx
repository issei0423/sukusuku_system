// @vitest-environment jsdom
/*
 * 押したあと・窓を開いたときのフォーカスの置き場所
 * 典拠：WCAG 2.4.3 フォーカス順序、GitHub Issue #213
 * 画面の上での動き（キーボードだけで通す道）は tests/responsive/a11y-keyboard-contact.spec.ts で確かめる
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { focusAfter, focusedNow } from '../src/focusAfter';
import TemperaturePicker from '../src/components/TemperaturePicker';

afterEach(() => {
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
});
