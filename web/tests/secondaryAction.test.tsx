// @vitest-environment jsdom
/*
 * 右クリック・長押しで、メッセージの操作の一覧を開く扱い（src/secondaryAction.ts）
 * 職員・保護者のチャット画面が共に使う。画面ごとの動きは screens.test.tsx が確かめる
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { useSecondaryAction, LONG_PRESS_MS } from '../src/secondaryAction';

afterEach(() => cleanup());

/** 吹き出し1つと、開いた回数・開いたときに出るボタン */
function Bubble({ onOpen }: { onOpen: (at?: { x: number; y: number }) => void }) {
  const secondary = useSecondaryAction();
  const [open, setOpen] = useState(false);
  const [pressed, setPressed] = useState(0);
  return (
    <div>
      <div data-testid="bubble" {...secondary((_el, at) => { onOpen(at); setOpen(true); })}>
        本文 <a href="#x">リンク</a>
      </div>
      {open && <button onClick={() => setPressed((n) => n + 1)}>取消</button>}
      <button onClick={() => setPressed((n) => n + 1)}>ほかのボタン</button>
      <output data-testid="pressed">{pressed}</output>
    </div>
  );
}

const pressed = () => Number(screen.getByTestId('pressed').textContent);

describe('右クリック・長押し', () => {
  it('右クリックで、右クリックした位置を添えて開き、既定のメニューを出さない', () => {
    const onOpen = vi.fn();
    render(<Bubble onOpen={onOpen} />);
    const notCancelled = fireEvent.contextMenu(screen.getByTestId('bubble'), { button: 2, clientX: 40, clientY: 70 });
    expect(onOpen).toHaveBeenCalledWith({ x: 40, y: 70 });
    expect(notCancelled).toBe(false);
  });

  it('キーボード：吹き出しを Tab で選べ、Enter・スペース・メニューキーで開く（位置は添えない）', () => {
    const onOpen = vi.fn();
    render(<Bubble onOpen={onOpen} />);
    const b = screen.getByTestId('bubble');
    expect(b.tabIndex).toBe(0);
    fireEvent.keyDown(b, { key: 'Enter' });
    fireEvent.keyDown(b, { key: ' ' });
    // メニューキー・Shift+F10 は button 0 の contextmenu として届く
    fireEvent.contextMenu(b, { button: 0 });
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen.mock.calls.every((c) => c[0] === undefined)).toBe(true);
    // 中のリンクで Enter を押したときは開かない
    fireEvent.keyDown(screen.getByText('リンク'), { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('指で押し続けると開き、すぐ離したときと指が動いたときは開かない', () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      render(<Bubble onOpen={onOpen} />);
      const b = screen.getByTestId('bubble');

      fireEvent.pointerDown(b, { pointerType: 'touch', clientX: 10, clientY: 10 });
      fireEvent.pointerUp(b);
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 100); });
      expect(onOpen).not.toHaveBeenCalled();

      fireEvent.pointerDown(b, { pointerType: 'touch', clientX: 10, clientY: 10 });
      fireEvent.pointerMove(b, { pointerType: 'touch', clientX: 10, clientY: 40 });
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 100); });
      expect(onOpen).not.toHaveBeenCalled();

      fireEvent.pointerDown(b, { pointerType: 'touch', clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('マウスは押し続けても開かない（左の長押しは文字の選択に使う）', () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      render(<Bubble onOpen={onOpen} />);
      fireEvent.pointerDown(screen.getByTestId('bubble'), { pointerType: 'mouse', button: 0 });
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS + 100); });
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('長押しで開いた直後のクリックは、指の下に来たボタンに当たっても無視する', () => {
    vi.useFakeTimers();
    try {
      render(<Bubble onOpen={() => {}} />);
      const b = screen.getByTestId('bubble');
      fireEvent.pointerDown(b, { pointerType: 'touch', clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
      fireEvent.pointerUp(b);
      fireEvent.click(screen.getByText('取消'));
      expect(pressed()).toBe(0);
      // 次に押したものは、普通に押せる
      fireEvent.pointerDown(screen.getByText('取消'));
      fireEvent.click(screen.getByText('取消'));
      expect(pressed()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('長押しのあとにクリックが来なくても、次の普通のタップを食べない', () => {
    vi.useFakeTimers();
    try {
      render(<Bubble onOpen={() => {}} />);
      const b = screen.getByTestId('bubble');
      fireEvent.pointerDown(b, { pointerType: 'touch', clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
      // 指を動かして離した（クリックにならなかった）。そのあと別のボタンをタップする
      fireEvent.pointerCancel(b);
      const other = screen.getByText('ほかのボタン');
      fireEvent.pointerDown(other, { pointerType: 'touch' });
      fireEvent.click(other);
      expect(pressed()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Android：長押しの途中で contextmenu が来ても、開くのは1回だけ', () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      render(<Bubble onOpen={onOpen} />);
      const b = screen.getByTestId('bubble');
      // contextmenu がタイマーより先に来る
      fireEvent.pointerDown(b, { pointerType: 'touch', clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(500); });
      fireEvent.contextMenu(b);
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
      expect(onOpen).toHaveBeenCalledTimes(1);
      // 指を離したときのクリックは無視する
      fireEvent.click(screen.getByText('取消'));
      expect(pressed()).toBe(0);

      // タイマーで開いたあとに contextmenu が続く
      onOpen.mockClear();
      fireEvent.pointerDown(b, { pointerType: 'touch', clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
      fireEvent.contextMenu(b);
      expect(onOpen).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('本文中のリンクの上では受け付けず、ブラウザの既定の動きを残す', () => {
    const onOpen = vi.fn();
    render(<Bubble onOpen={onOpen} />);
    const notCancelled = fireEvent.contextMenu(screen.getByText('リンク'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(notCancelled).toBe(true);
  });
});
