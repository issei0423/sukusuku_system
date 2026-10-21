/*
 * 右クリック・長押しで、メッセージの操作の一覧（リアクション・編集・取消）を開く
 *
 * PC の右クリックは contextmenu、スマートフォン・タブレットの長押しは Pointer Events とタイマーで判定する。
 * iPhone（Safari）は長押しで contextmenu を出さないため、contextmenu だけでは両方に効かない。
 * Android（Chrome）は長押しでも contextmenu を出すので、どちらが先に来ても一覧を1回だけ開く。
 * 職員のチャット画面と保護者のチャット画面で、同じ扱いにするために1か所にまとめた。
 *
 * 次の扱いをそろえている。
 *   - マウスは右クリックで開く。押し続けても開かない（左の長押しは文字の選択に使うため）
 *   - 指・ペンは LONG_PRESS_MS 押し続けると開く。LONG_PRESS_MOVE_PX を超えて動いたら、画面を送ろうとしたとみなして取り消す
 *   - 長押しで開いた直後に指を離したときのクリックは、どこに当たっても1回だけ無視する。
 *     一覧が指の下に出ると、離した瞬間に「取消」などが押されてしまうため。無視する指定は、次に押し始めたときに解く
 *     （クリックが来なかったときに残り、次の普通のタップを食べないようにする）
 *   - 本文中のリンク・ボタン・入力欄の上では受け付けず、ブラウザの既定の動きを残す
 *   - PC の右クリックでは、右クリックした位置（カーソルの所）に一覧を出す（at を渡す）。
 *     長押しとキーボードでは at を渡さず、画面がメッセージの上か下に出す
 *   - 「操作」ボタンは置かない。キーボード・読み上げで使う人のために、吹き出しを Tab で選べるようにし、
 *     Enter・スペース・メニューキー・Shift+F10 で同じ一覧を開く（WCAG 2.1.1）
 */
import { useEffect, useRef } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent,
} from 'react';

/** 長押しとみなすまでの時間（【仮置き】web/仮置き値.md） */
export const LONG_PRESS_MS = 800;
/** 長押しとみなす指のずれの上限（【仮置き】web/仮置き値.md） */
export const LONG_PRESS_MOVE_PX = 10;

const onControl = (target: EventTarget) => !!(target as HTMLElement).closest?.('a, button, input, textarea, select');

/** 一覧を出す位置（画面の左上からの px）。PC の右クリックのときだけ渡る */
export type MenuAt = { x: number; y: number };

export type SecondaryActionHandlers = {
  tabIndex: number;
  'aria-haspopup': 'true';
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
};

/**
 * 画面に1つ置き、返った bind をメッセージの吹き出しへ広げて付ける。
 * open には、押された吹き出しの要素が渡る（一覧を上下どちらへ出すかを決めるため）
 */
export function useSecondaryAction(): (open: (el: HTMLElement, at?: MenuAt) => void) => SecondaryActionHandlers {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  // 長押しで開き、まだ指を離したあとのクリックを無視していない
  const suppressClick = useRef(false);

  const cancel = () => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
    start.current = null;
  };

  useEffect(() => {
    const swallow = (e: Event) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    const reset = () => { suppressClick.current = false; };
    document.addEventListener('click', swallow, true);
    document.addEventListener('pointerdown', reset, true);
    return () => {
      document.removeEventListener('click', swallow, true);
      document.removeEventListener('pointerdown', reset, true);
      cancel();
    };
  }, []);

  return (open) => ({
    tabIndex: 0,
    'aria-haspopup': 'true',
    // 吹き出しそのものを選んでいるときだけ。中のリンク・入力欄の Enter はそのまま通す
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      open(e.currentTarget);
    },
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' || onControl(e.target)) return;
      cancel();
      start.current = { x: e.clientX, y: e.clientY };
      const el = e.currentTarget;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        suppressClick.current = true;
        open(el);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > LONG_PRESS_MOVE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: (e) => {
      if (onControl(e.target)) return;
      // 右クリック・長押しで端末が出す既定のメニューの代わりに開く
      e.preventDefault();
      // Android で、タイマーで開いたあとに contextmenu が続いたときは、開き直さない
      if (suppressClick.current) return;
      // Android で、タイマーより先に contextmenu が来たときも、指を離したあとのクリックは無視する
      if (timer.current !== null) suppressClick.current = true;
      cancel();
      // マウスの右クリックだけカーソルの位置に出す。メニューキー・Shift+F10 は button が 0 で届く
      open(e.currentTarget, e.button === 2 ? { x: e.clientX, y: e.clientY } : undefined);
    },
  });
}

/** 画面を送るキー。押されたあとに画面が動く */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']);

/**
 * 人が画面を送ろうとしたとき（ホイール・指での送り・送るキー）に close を呼ぶ。外すための関数を返す。
 * カーソルの位置に出した一覧は、画面を送るとメッセージから離れるので閉じる。
 * scroll イベントでは見ない。自動更新で新着が届き、いちばん下へ送られた（useFollowLatest）だけで
 * 操作の途中の一覧が消えてしまうため。スクロールバーをつかんだときは、一覧の外を押したとして閉じる
 */
export function closeOnUserScroll(close: () => void): () => void {
  const onKey = (e: KeyboardEvent) => { if (SCROLL_KEYS.has(e.key)) close(); };
  document.addEventListener('wheel', close, { passive: true });
  document.addEventListener('touchmove', close, { passive: true });
  document.addEventListener('keydown', onKey);
  return () => {
    document.removeEventListener('wheel', close);
    document.removeEventListener('touchmove', close);
    document.removeEventListener('keydown', onKey);
  };
}

/**
 * カーソルの位置に出した一覧（position: fixed）を、画面の外へはみ出さないよう寄せる。
 * 右へはみ出すときは左へ寄せ、下へはみ出すときはカーソルの上へ出す。開いた直後に1回呼ぶ
 */
export function keepInViewport(wrap: HTMLElement | null, at: MenuAt): void {
  if (!wrap) return;
  const margin = 8;
  const r = wrap.getBoundingClientRect();
  const left = Math.max(margin, Math.min(at.x, window.innerWidth - r.width - margin));
  const top = at.y + r.height + margin > window.innerHeight ? Math.max(margin, at.y - r.height) : at.y;
  wrap.style.left = `${left}px`;
  wrap.style.top = `${top}px`;
}
