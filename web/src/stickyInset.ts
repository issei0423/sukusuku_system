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
    const measure = () => {
      const rect = el.getBoundingClientRect();
      box.style.setProperty(name, `${side === 'width' ? rect.width : rect.height}px`);
    };
    // 出たときにすぐ測る（ResizeObserver の最初の知らせは次の描画の前まで来ない。その前にフォーカスを移すことがある）
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => { observer.disconnect(); box.style.removeProperty(name); };
  }, [scroller, name, side]);
}

/**
 * 画面に重ねて固定した部品（結果の表示など。position: fixed）に付ける ref を返す。部品と同じ親にあるスクロールする枠
 * （scroller、CSS のセレクタ）の下端を、部品がどれだけ覆うかを測り、親の要素に name の変数として入れる（枠が受け継ぐ）。
 * 部品が枠の中に無いとき（結果の表示は components/feedback.tsx の ToastHost が枠の隣に置く）に使う。部品が消えたら変数を外す。
 * 出たときにフォーカスのある部品を覆ったら、その部品を枠の余白の内側まで送る
 */
export function useOverlayInset(scroller: string, name: string) {
  return useCallback((el: HTMLElement | null) => {
    const parent = el?.parentElement;
    const box = parent?.querySelector<HTMLElement>(`:scope > :is(${scroller})`);
    if (!el || !parent || !box || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const edge = el.getBoundingClientRect().top;
      const covered = Math.max(0, box.getBoundingClientRect().bottom - edge);
      parent.style.setProperty(name, `${covered}px`);
      // 出たとき・大きさが変わったときに、いまフォーカスのある部品を覆ったら、枠の余白の内側まで送る
      // （押したあとに移したフォーカスの上に、少し遅れて結果の表示が出ることがある）
      const active = document.activeElement;
      if (covered > 0 && active instanceof HTMLElement && box.contains(active) && active.getBoundingClientRect().bottom > edge) {
        active.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    };
    // 出たときにすぐ測る（ResizeObserver の最初の知らせは次の描画の前まで来ない）
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(box);
    return () => { observer.disconnect(); parent.style.removeProperty(name); };
  }, [scroller, name]);
}
