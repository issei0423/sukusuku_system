// @vitest-environment jsdom
/*
 * 「取り消す」を添えた知らせ（結果の表示）は、フォーカスがあるあいだ・ポインタが乗っているあいだは消えない
 * 典拠：WCAG 2.2.1 タイミング調整可能、GitHub Issue #210 の 2。表示の時間（12 秒）は【仮置き】（web/仮置き値.md）
 * 「閉じる」を押したあとのフォーカスの移し先（WCAG 2.4.3、GitHub Issue #213）も、この部品のテストとしてここに置く
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
