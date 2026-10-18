// @vitest-environment jsdom
/*
 * 「取り消す」を添えた知らせ（結果の表示）は、フォーカスがあるあいだ・ポインタが乗っているあいだは消えない
 * 典拠：WCAG 2.2.1 タイミング調整可能、GitHub Issue #210 の 2。表示の時間（12 秒）は【仮置き】（web/仮置き値.md）
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
