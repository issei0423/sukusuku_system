/*
 * 操作の結果と確認を伝える部品
 * 典拠：基本設計書.md「画面の洗い出しの考え方」(3-1)
 *      「マスタの設定変更やアカウントの操作は…保存前の確認ダイアログで足りる」
 *
 * 完了の表示（notify）：押したあとに、できたのかどうかが分かるようにする（GitHub Issue #108）。
 *   画面を移っても消えないよう、職員の共通レイアウトに置いた ToastHost が出す。
 * 確認ダイアログ（ConfirmDialog）：1回押すだけで確定させない（GitHub Issue #107）。
 *   何が起きるかは呼び出し側が文章で書く。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal } from './ui';

// 表示する時間。読み上げに拾わせるため、すぐには消さない
const SHOW_MS = 6000;

interface Toast { text: string; seq: number; until: number }
type Listener = (toast: Toast | null) => void;
const listeners = new Set<Listener>();
/*
 * 表示中の1件は部品の外に持つ。
 * 管理者に限る画面とそれ以外の画面とで共通レイアウトが作り直されるため、部品の中に持つと、
 * 登録のあと一覧へ移ったとき（園児情報確認画面 → 園児一覧）に表示が消える。
 */
let current: Toast | null = null;
let seq = 0;

function publish(toast: Toast | null): void {
  current = toast;
  listeners.forEach((l) => l(toast));
}

/** 操作が完了したことを知らせる */
export function notify(message: string): void {
  publish({ text: message, seq: ++seq, until: Date.now() + SHOW_MS });
}

/** 完了の表示の置き場所。共通レイアウトに1つだけ置く */
export function ToastHost() {
  const [toast, setToast] = useState<Toast | null>(() => (current && current.until > Date.now() ? current : null));

  useEffect(() => {
    listeners.add(setToast);
    return () => { listeners.delete(setToast); };
  }, []);

  // 時間が来たら自分で消える
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => { if (current?.seq === toast.seq) publish(null); }, Math.max(0, toast.until - Date.now()));
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{toast.text}</span>
      <button className="btn-sm btn-quiet" onClick={() => publish(null)}>閉じる</button>
    </div>
  );
}

/** 確定する前に、何が起きるかを確かめる */
export function ConfirmDialog({ title, children, confirmLabel, danger, busy, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}
      footer={<>
        <button onClick={onCancel} disabled={busy}>やめる</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </button>
      </>}>
      {children}
    </Modal>
  );
}
