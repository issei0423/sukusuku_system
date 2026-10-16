export interface Finding {
  severity: 'error' | 'review' | 'info';
  rule: string;
  selector: string;
  label: string;
  detail: string;
}
export interface Audit {
  viewport: { width: number; height: number };
  findings: Finding[];
  controlsChecked: number;
}

/** page.evaluate へ渡すため、外部変数には依存しない。値は CSS px。 */
export function auditLayout(): Audit {
  const findings: Finding[] = [];
  const width = document.documentElement.clientWidth;
  const height = window.innerHeight;
  const visible = (el: Element) => {
    const style = getComputedStyle(el);
    return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const selector = (el: Element): string => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const siblings = Array.from(current.parentElement?.children ?? []).filter((s) => s.tagName === current!.tagName);
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
      if (current.parentElement?.id) { parts.unshift(`#${CSS.escape(current.parentElement.id)}`); break; }
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const add = (el: Element, severity: Finding['severity'], rule: string, detail: string) => {
    findings.push({ severity, rule, selector: selector(el), label: (el.getAttribute('aria-label') || el.textContent || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 100), detail });
  };
  const roots = [document.documentElement, ...document.querySelectorAll('main, .app-header, .guardian-header, [role="dialog"]')];
  for (const el of roots) {
    if (visible(el) && el.scrollWidth > el.clientWidth + 2) {
      add(el, 'error', 'horizontal-overflow', `領域 ${el.clientWidth}px に内容 ${el.scrollWidth}px（${el.scrollWidth - el.clientWidth}px 超過）`);
    }
  }
  const scope = document.querySelector('[role="dialog"]') ?? document.body;
  const controls = Array.from(scope.querySelectorAll<HTMLElement>(
    'button, input:not([type="hidden"]), select, textarea, summary, a.btn, nav a, [role="button"], [role="tab"]',
  ));
  const seen = new Set<Element>();
  let controlsChecked = 0;
  for (const control of controls) {
    let target: HTMLElement = control;
    // 1px に隠したネイティブ radio を押す領域と誤認しない。関連 label を測る。
    if (control instanceof HTMLInputElement && ['radio', 'checkbox'].includes(control.type)) {
      target = control.labels?.[0] ?? control;
    }
    if (!visible(target) || seen.has(target)) continue;
    seen.add(target);
    controlsChecked += 1;
    const rect = target.getBoundingClientRect();
    const minimum = target.closest('.nap-choice, .nap-row-actions, .nap-temp-grid') ? 52 : 44;
    if (rect.width < minimum - 0.5 || rect.height < minimum - 0.5) {
      add(target, 'review', 'small-target', `${Math.round(rect.width)} × ${Math.round(rect.height)}px。レビュー目安 ${minimum} × ${minimum}px`);
    }
    let xScrollable = false;
    let clippedX = false;
    let onScreen = rect.left >= 0 && rect.right <= width + 1 && rect.top >= 0 && rect.bottom <= height;
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const p = parent.getBoundingClientRect();
      if (/(auto|scroll)/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth + 2 && !parent.matches('main, body, html')) xScrollable = true;
      if (/(hidden|clip)/.test(style.overflowX) && (rect.left < p.left - 2 || rect.right > p.right + 2)) clippedX = true;
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.top < p.top || rect.bottom > p.bottom)) onScreen = false;
    }
    if (!xScrollable && (rect.left < -2 || rect.right > width + 2 || clippedX)) {
      add(target, 'error', 'clipped-control', '操作領域が画面またはクリップ領域の横幅からはみ出しています');
    }
    if (control.matches('button, a.btn') && control.scrollWidth > control.clientWidth + 2) {
      add(control, 'review', 'clipped-label', '操作部品の文字が内側の幅に収まっていません');
    }
    if (onScreen && !control.matches(':disabled')) {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit && hit !== target && !target.contains(hit) && !hit.contains(target)) {
        add(target, 'review', 'covered-target', `中央が別の要素（${hit.tagName.toLowerCase()}）に隠れています。画像で確認してください`);
      }
    }
  }
  for (const table of scope.querySelectorAll('table')) {
    if (!visible(table)) continue;
    for (let parent = table.parentElement; parent && !parent.matches('main, body'); parent = parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowX) && parent.scrollWidth > parent.clientWidth + 2) {
        add(table, 'info', 'scrollable-table', '表の内側で横スクロールできます。列名・操作列の見つけやすさは目視で確認してください');
        break;
      }
    }
  }
  return { viewport: { width, height }, findings, controlsChecked };
}
