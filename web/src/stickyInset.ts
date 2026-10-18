/*
 * 止めた部品（position: sticky）の大きさを測り、スクロールする枠へ CSS の変数として渡す
 * 典拠：WCAG 2.4.11 フォーカスの非隠蔽（最低限）（レベル AA）、GitHub Issue #212
 *
 * 枠はその値を scroll-padding に取り、キーボードで移ったフォーカスが、止めた見出し・列・帯の下に隠れないようにする
 * （値を使う CSS は styles/screens.css）。止めた部品は幅や中身で大きさが変わるので、決めた値でなく測った値を使う。
 * 午睡チェックのタイマー（screens/nap/NapCheckScreen.tsx の NapTimer が --nap-timer-h を測る）と同じ形。
 */
import { useCallback } from 'react';

/**
 * 止めた部品に付ける ref を返す。部品が出ている間、その高さ（side が 'width' なら幅）を測り、
 * いちばん近い scroller（CSS のセレクタ）の要素に name の変数として入れる。部品が消えたら変数を外す
 */
export function useStickyInset(scroller: string, name: string, side: 'height' | 'width' = 'height') {
  return useCallback((el: HTMLElement | null) => {
    const box = el?.closest<HTMLElement>(scroller);
    if (!el || !box || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      box.style.setProperty(name, `${side === 'width' ? rect.width : rect.height}px`);
    });
    observer.observe(el);
    return () => { observer.disconnect(); box.style.removeProperty(name); };
  }, [scroller, name, side]);
}
