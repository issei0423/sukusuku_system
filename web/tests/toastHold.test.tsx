// @vitest-environment jsdom
/*
 * 「取り消す」を添えた知らせ（結果の表示）は、フォーカスがあるあいだ・ポインタが乗っているあいだは消えない
 * 典拠：WCAG 2.2.1 タイミング調整可能、GitHub Issue #210 の 2。表示の時間（12 秒）は【仮置き】（web/仮置き値.md）
 * 「閉じる」を押したあと・「取り消す」の確認の窓で取り消したあとのフォーカスの移し先（WCAG 2.4.3、GitHub Issue #213）も、
 * この部品のテストとしてここに置く
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { clearNotice, notify, ToastHost } from '../src/components/feedback';
import type { ToastAction } from '../src/components/feedback';

afterEach(() => {
  act(() => clearNotice());
  cleanup();
  vi.useRealTimers();
});

describe('「取り消す」を添えた知らせ（GitHub Issue #210 の 2）', () => {
  const undo: ToastAction = { label: '取り消す', confirmTitle: '取り消しますか', describe: async () => '', run: async () => '取り消しました' };

  it('触れなければ 12 秒で消える', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => notify('おしっこを記録しました', undo));
    expect(screen.getByText('おしっこを記録しました')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(12_100); });
    expect(screen.queryByText('おしっこを記録しました')).toBeNull();
  });

  it('フォーカスがあるあいだは消えず、離れたら残りの時間で消える', () => {
    vi.useFakeTimers();
    render(<><ToastHost /><button>ほか</button></>);
    act(() => notify('おしっこを記録しました', undo));
    act(() => { vi.advanceTimersByTime(4_000); });
    act(() => screen.getByRole('button', { name: '取り消す' }).focus());
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('おしっこを記録しました')).toBeTruthy();
    // 知らせの中で「閉じる」へ移っても止めたまま
    act(() => screen.getByRole('button', { name: '閉じる' }).focus());
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('おしっこを記録しました')).toBeTruthy();
    // 知らせの外へ移ると、止めたときの残り（約 8 秒）から数え直す
    act(() => screen.getByRole('button', { name: 'ほか' }).focus());
    act(() => { vi.advanceTimersByTime(7_500); });
    expect(screen.getByText('おしっこを記録しました')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.queryByText('おしっこを記録しました')).toBeNull();
  });

  it('ポインタが乗っているあいだは消えず、離れたら残りの時間で消える', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => notify('おしっこを記録しました', undo));
    const toast = screen.getByRole('status');
    fireEvent.pointerEnter(toast);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('おしっこを記録しました')).toBeTruthy();
    fireEvent.pointerLeave(toast);
    act(() => { vi.advanceTimersByTime(11_500); });
    expect(screen.getByText('おしっこを記録しました')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.queryByText('おしっこを記録しました')).toBeNull();
  });
});

/*
 * 「閉じる」を押すと知らせごと消え、押したボタンからフォーカスが外れて body に落ちていた。
 * 知らせへ入る前にいた部品へ戻し、戻せなければ本文（main）へ移す（WCAG 2.4.3、GitHub Issue #213。共通の決まりは src/focusAfter.ts）
 */
describe('結果の表示の「閉じる」を押したあとのフォーカス（GitHub Issue #213）', () => {
  it('知らせへ入る前にいた部品へ戻す', () => {
    render(<><main tabIndex={-1}><button>おしっこ</button></main><ToastHost /></>);
    const before = screen.getByRole('button', { name: 'おしっこ' });
    act(() => before.focus());
    act(() => notify('おしっこを記録しました'));
    // Tab で知らせの中へ進み、「閉じる」を押す
    const close = screen.getByRole('button', { name: '閉じる' });
    act(() => close.focus());
    fireEvent.click(close);
    expect(screen.queryByText('おしっこを記録しました')).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it('知らせの中の「取り消す」から「閉じる」へ移って押しても、知らせへ入る前にいた部品へ戻す', () => {
    const undo: ToastAction = { label: '取り消す', confirmTitle: '取り消しますか', describe: async () => '', run: async () => '取り消しました' };
    render(<><main tabIndex={-1}><button>おしっこ</button></main><ToastHost /></>);
    const before = screen.getByRole('button', { name: 'おしっこ' });
    act(() => before.focus());
    act(() => notify('おしっこを記録しました', undo));
    act(() => screen.getByRole('button', { name: '取り消す' }).focus());
    const close = screen.getByRole('button', { name: '閉じる' });
    act(() => close.focus());
    fireEvent.click(close);
    expect(document.activeElement).toBe(before);
  });

  it('入る前にいた部品が消えていれば、本文（main）へ移す', () => {
    render(<><main tabIndex={-1}><button>確認しました</button></main><ToastHost /></>);
    const before = screen.getByRole('button', { name: '確認しました' });
    act(() => before.focus());
    act(() => notify('家庭からを確認しました'));
    const close = screen.getByRole('button', { name: '閉じる' });
    act(() => close.focus());
    before.remove();
    fireEvent.click(close);
    expect(document.activeElement).toBe(document.querySelector('main'));
  });

  it('押したときにフォーカスが無ければ（ポインタで押して、フォーカスが移らない端末）、動かさない', () => {
    render(<><main tabIndex={-1}><button>おしっこ</button></main><ToastHost /></>);
    act(() => notify('おしっこを記録しました'));
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByText('おしっこを記録しました')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

/**
 * ブラウザ（Chromium）は、送っている間に押せなくなった（disabled）ボタンからフォーカスを外して body に落とす。
 * jsdom は外さず、押せないボタンの blur() も効かないので、いったん押せるようにして外す
 */
function dropFocus(el: HTMLButtonElement) {
  expect(el.disabled, '送っている間は押せない').toBe(true);
  act(() => { el.disabled = false; el.blur(); el.disabled = true; });
  expect(document.activeElement).toBe(document.body);
}

/*
 * 知らせの「取り消す」→ 確認の窓 →「取り消す」。取り消せると知らせが結果の文に差し替わり、知らせの「取り消す」が消える。
 * 窓の部品（Modal）は開いた元（知らせの「取り消す」）へ戻そうとするが、もう無いので body に落ちていた。
 * 「閉じる」と同じく、知らせへ入る前にいた部品へ戻す（WCAG 2.4.3、GitHub Issue #213）
 */
describe('「取り消す」の確認の窓で取り消したあとのフォーカス（GitHub Issue #213）', () => {
  /** 知らせへ入る前にいた部品にフォーカスを置き、知らせの「取り消す」から確認の窓を開く。窓の「取り消す」を返す */
  async function openConfirm(run: () => Promise<string>) {
    const undo: ToastAction = { label: '取り消す', confirmTitle: 'この記録を取り消しますか', describe: async () => 'いま保護者 1 家庭（1 名）が読んでいます。', run };
    render(<><main tabIndex={-1}><button>おしっこ</button></main><ToastHost /></>);
    const before = screen.getByRole('button', { name: 'おしっこ' });
    act(() => before.focus());
    act(() => notify('おしっこを記録しました', undo));
    const opener = screen.getByRole('button', { name: '取り消す' });
    act(() => opener.focus());
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'この記録を取り消しますか' });
    await within(dialog).findByText('いま保護者 1 家庭（1 名）が読んでいます。');
    const confirm = within(dialog).getByRole('button', { name: '取り消す' }) as HTMLButtonElement;
    act(() => confirm.focus());
    return { before, dialog, confirm };
  }

  it('取り消せたら、知らせへ入る前にいた部品へ戻す', async () => {
    const { before, confirm } = await openConfirm(async () => '「おしっこ」を取り消しました。');
    fireEvent.click(confirm);
    dropFocus(confirm);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('「おしっこ」を取り消しました。'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: '取り消す' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(before));
  });

  it('取り消せなかったときは、窓を開いたまま、押した「取り消す」へ戻す', async () => {
    const { dialog, confirm } = await openConfirm(async () => { throw new Error('取り消せませんでした。'); });
    fireEvent.click(confirm);
    dropFocus(confirm);
    await within(dialog).findByText('取り消せませんでした。');
    expect(screen.getByRole('dialog', { name: 'この記録を取り消しますか' })).toBe(dialog);
    await waitFor(() => expect(document.activeElement).toBe(confirm));
  });
});
