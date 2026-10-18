/*
 * 押したあとのフォーカスの移し先（共通の決まり）
 * 典拠：WCAG 2.4.3 フォーカス順序（レベル A）、GitHub Issue #213
 *
 * 送っている間に押せなくする（disabled）ボタンや、応答のあとに消えるボタンを押すと、ブラウザがフォーカスを外して body に落とす。
 * 次の Tab は元の位置の続きから進むが、読み上げでは今いる場所を見失う。そこで応答のあとに
 *   - 押したボタンが残っていれば、そのボタンへ戻す（フォーカスを残す）
 *   - 消えていれば、画面ごとに決めた場所へ移す（送ったあと → 送った内容の「直す」など）
 * 押したときにフォーカスがあった（キーボードで押したときなど）場合だけ移す。午睡チェックの「この子を記録」と同じ決まり。
 *
 * 移す先は、応答のあとの読み直し・描き直しで現れることがあるので、現れて押せるようになるまで待つ。
 * 待つ間に利用者が次の操作をした（キーを押した・画面を押した・ほかへフォーカスが入った）ら、待つのをやめる。
 */

/** 押した時点で呼ぶ。いまフォーカスのある要素を返す（body なら null）。応答のあとに focusAfter へ渡す */
export function focusedNow(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

/**
 * 応答のあとに呼ぶ。from は押した時点の focusedNow() の値で、null なら何もしない。
 * to を渡せば、to が返す要素が現れて押せるようになったら、そこへフォーカスを移す。渡さなければ from へ戻す
 */
export function focusAfter(from: HTMLElement | null, to?: () => HTMLElement | null | undefined): void {
  if (!from || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  // 押したものが消えていて、ほかの移し先も無い（窓の中の部品を押して窓が閉じたなど）
  if (!to && !from.isConnected) return;
  const find = to ?? (() => from);
  let done = false;
  const observer = new MutationObserver(() => tryMove());
  const stop = () => {
    done = true;
    observer.disconnect();
    for (const type of ['focusin', 'keydown', 'pointerdown'] as const) document.removeEventListener(type, stop, true);
  };
  function tryMove(): void {
    if (done) return;
    const active = document.activeElement;
    // 押したものから、まだフォーカスが外れていない（外れる前）か、body に落ちているときだけ動かす
    if (active && active !== document.body && active !== from) { stop(); return; }
    const target = find();
    if (!target || !target.isConnected || target.matches(':disabled')) return;
    stop();
    if (target === active) return;
    /*
     * 移した先が、止めた部品や結果の表示（トースト）の下にあっても見えるよう、枠の scroll-padding の内側まで送る（GitHub Issue #212）。
     * focus() だけでは、枠の中にすでに入っている部品は、止めた部品に覆われていても送られない（Chromium）
     */
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  // 利用者の次の操作か、ほかの要素へフォーカスが入ったら（窓が開いてその中へ入ったなど）、待つのをやめる
  for (const type of ['focusin', 'keydown', 'pointerdown'] as const) document.addEventListener(type, stop, true);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
  tryMove();
}
