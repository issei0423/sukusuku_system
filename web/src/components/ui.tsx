/*
 * 全画面で使い回す部品
 * 典拠：基本設計書.md「画面基本構成」(3-5)、図/画面詳細図.md「全画面に共通する規定」(0-2)
 */
import { Children, cloneElement, isValidElement, useEffect, useId, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';

export function Field({ label, required, children, style }: {
  label: string; required?: boolean; children: ReactNode; style?: React.CSSProperties;
}) {
  const id = useId();
  const control = Children.count(children) === 1 && isValidElement(children) &&
    typeof children.type === 'string' && ['input', 'select', 'textarea'].includes(children.type);
  const labelledChildren = Children.map(children, (child) => {
    if (!control || !isValidElement(child)) return child;
    return cloneElement(child as ReactElement<Record<string, unknown>>, {
      id, 'aria-required': required || undefined,
    });
  });
  const groupedChildren = Children.map(children, (child) =>
    isValidElement(child) && child.type === Radios
      ? cloneElement(child as ReactElement<{ label?: string; required?: boolean }>, { label, required }) : child);
  return (
    <div className={`field${required ? ' req' : ''}`} style={style}>
      {control ? <label className="lbl" htmlFor={id}>{label}</label> : <span className="lbl" id={id}>{label}</span>}
      {control ? labelledChildren : <div role="group" aria-labelledby={id}>{groupedChildren}</div>}
    </div>
  );
}

/** 警告・注意喚起。判定ではないことを明確にするため、文言は呼び出し側が持つ */
export function Alert({ children, soft }: { children: ReactNode; soft?: boolean }) {
  return <div className={`alert${soft ? ' alert-soft' : ''}`} role={soft ? 'status' : 'alert'}><span aria-hidden="true">(!)</span><span>{children}</span></div>;
}

/**
 * 免責表示
 * 成長グラフ・発達チェックの比較表示に常時表示し、スクロールしても視界から外れない位置に固定する
 * （基本設計書 3-5）
 */
export function Disclaimer({ text }: { text: string }) {
  return <div className="disclaimer"><span>(!)</span><span>{text}</span></div>;
}

/**
 * 通知のベル。ヘッダの通知ボタンに置く（基本設計書 3-5「通知アイコンと未対応件数」）
 * 絵だけでは読み上げられないため、ボタンの側に aria-label を必ず付ける
 */
export function BellIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function Tag({ label, className = 'tag-plain' }: { label: string; className?: string }) {
  return <span className={`tag ${className}`}>{label}</span>;
}

export function Card({ title, children, sub, actions }: {
  title?: string; children: ReactNode; sub?: boolean; actions?: ReactNode;
}) {
  return (
    <section className={`card${sub ? ' card-sub' : ''}`}>
      {(title || actions) && (
        <div className="page-head" style={{ marginBottom: 12 }}>
          {title && <h2>{title}</h2>}
          <div className="spacer" />
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** ダイアログで足りるものは画面として起こさない（基本設計書「画面の洗い出しの考え方」(3-1) 基準3） */
export function Modal({ title, children, onClose, footer }: {
  title: string; children: ReactNode; onClose: () => void; footer?: ReactNode;
}) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialog.current;
    const focusable = () => Array.from(root?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.getAttribute('aria-hidden') !== 'true' &&
      !(element instanceof HTMLInputElement && element.type === 'hidden'))
      // 複数のセレクタをまとめた検索は、環境によって画面上の順で返らない。Tab の折り返し先を誤らないよう並べ直す
      .sort((x, y) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    (root?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')
      ?? focusable()[0] ?? root)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); root?.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); before?.focus(); };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialog} className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        <h2 className="modal-head" id={id}>{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">{footer ?? <button onClick={onClose}>閉じる</button>}</div>
      </div>
    </div>
  );
}

/** ページングの様式（基本設計書「一覧表示とページング」(3-7)） */
export function Pager({ page, perPage, total, onChange }: {
  page: number; perPage: number; total: number; onChange: (p: number) => void;
}) {
  const last = Math.max(1, Math.ceil(total / perPage));
  if (total === 0) return null;
  return (
    <div className="pager">
      <button className="btn-sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>&lt; 前へ</button>
      <span>{page} / {last}</span>
      <button className="btn-sm" disabled={page >= last} onClick={() => onChange(page + 1)}>次へ &gt;</button>
      <span>全 {total} 件</span>
    </div>
  );
}

export function Loading() { return <div className="empty">読み込んでいます…</div>; }
export function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
export function ErrorBox({ text }: { text: string }) { return <Alert>{text}</Alert>; }

/** 選択肢。(*) が選択中、( ) が未選択（図/画面詳細図.md「表記ルール」(0-1)） */
export function Radios<T extends string>({ name, value, options, onChange, label, required }: {
  name: string; value: T | null; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string; required?: boolean;
}) {
  return (
    <div className="choices" role="radiogroup" aria-label={label ?? name} aria-required={required || undefined}>
      {options.map((o) => (
        <label key={o.value}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}
