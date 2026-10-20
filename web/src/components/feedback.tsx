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
const SHOW_WITH_ACTION_MS = 12000;

/**
 * 結果の表示に添える操作（詳細設計書「押したときの処理の型」(2-0 (2))、図/画面詳細図「全画面に共通する規定」(0-2) の完了の表示）。
 * 保護者へ届く操作では「取り消す」を添え、押すと何が起きるか（いま読んでいる家庭の数）を確かめてから行う。
 * 確認と実行はこの表示の側で持つ（記録した画面を離れても、表示が残っている間は取り消せるようにするため）
 */
export interface ToastAction {
  label: string;
  /** 確認のダイアログの題 */
  confirmTitle: string;
  /** 確認に出す文（いま読んでいる家庭の数を数えてから作る） */
  describe: () => Promise<string>;
  /** 行う。結果の文を返す（それを新しい結果の表示に出す） */
  run: () => Promise<string>;
}

interface Toast { text: string; seq: number; until: number; action?: ToastAction }
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

/** 操作が完了したことを知らせる。保護者へ届く操作では、取り消しの操作（action）を添える */
export function notify(message: string, action?: ToastAction): void {
  // 取り消しを添えたものは、押す間があるよう長めに出す。【仮置き】12秒（web/仮置き値.md）
  publish({ text: message, seq: ++seq, until: Date.now() + (action ? SHOW_WITH_ACTION_MS : SHOW_MS), action });
}

/**
 * 出ている完了の表示を消す。前の操作の知らせが、次の操作を確かめる画面に残ると紛らわしいときに使う
 * （日誌確認画面の上に「下書きを保存しました」が残っていた。GitHub Issue #139）
 */
export function clearNotice(): void {
  publish(null);
}

/** 完了の表示の置き場所。共通レイアウトに1つだけ置く */
export function ToastHost() {
  const [toast, setToast] = useState<Toast | null>(() => (current && current.until > Date.now() ? current : null));
  // 添えた操作（取り消す）の確認。表示が消えても、開いた確認は残す
  const [confirming, setConfirming] = useState<{ action: ToastAction; text: string | null; busy: boolean; error: string | null } | null>(null);
  const openConfirm = (action: ToastAction) => {
    setConfirming({ action, text: null, busy: false, error: null });
    action.describe()
      .then((text) => setConfirming((c) => (c && c.action === action ? { ...c, text } : c)))
      .catch((e: Error) => setConfirming((c) => (c && c.action === action ? { ...c, text: '', error: e.message } : c)));
  };
  const runConfirmed = () => {
    if (!confirming || confirming.busy) return;
    const { action } = confirming;
    setConfirming({ ...confirming, busy: true, error: null });
    action.run()
      .then((message) => { setConfirming(null); notify(message); })
      .catch((e: Error) => setConfirming((c) => (c ? { ...c, busy: false, error: e.message } : c)));
  };

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

  if (!toast && !confirming) return null;
  return (
    <>
      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <span>{toast.text}</span>
          {toast.action && (
            <button className="btn-sm btn-quiet" onClick={() => openConfirm(toast.action!)}>{toast.action.label}</button>
          )}
          <button className="btn-sm btn-quiet" onClick={() => publish(null)}>閉じる</button>
        </div>
      )}
      {confirming && (
        <ConfirmDialog title={confirming.action.confirmTitle} confirmLabel={confirming.action.label} danger busy={confirming.busy}
          onCancel={() => setConfirming(null)} onConfirm={runConfirmed}>
          {confirming.text === null ? <p>読み込んでいます…</p> : <p className="pre-wrap">{confirming.text}</p>}
          {confirming.error && <p className="contact-error" role="alert">{confirming.error}</p>}
        </ConfirmDialog>
      )}
    </>
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
