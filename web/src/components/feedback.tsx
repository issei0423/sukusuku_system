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
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal } from './ui';
import { useOverlayInset } from '../stickyInset';
import { focusAfter, focusedNow } from '../focusAfter';

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
  /*
   * 「閉じる」を押したとき・確認の窓で取り消したときは、知らせ（と知らせの「取り消す」）が消え、押したボタンからフォーカスが外れて
   * body に落ちていた。知らせへフォーカスが入る前にいた部品（cameFrom）へ戻す。消えた・押せなくなったなどで戻せなければ、本文（main）へ移す
   * （WCAG 2.4.3 フォーカス順序、GitHub Issue #213。共通の決まりは src/focusAfter.ts。押したときにフォーカスが無ければ動かさない）
   */
  const cameFrom = useRef<HTMLElement | null>(null);
  const backTo = (back: HTMLElement | null) => () =>
    (back?.isConnected && !back.matches(':disabled') ? back : document.querySelector<HTMLElement>('main'));
  const close = () => {
    const pressed = focusedNow();
    const back = cameFrom.current;
    publish(null);
    focusAfter(pressed, backTo(back));
  };
  /*
   * 確認の窓の「取り消す」。取り消せると知らせが結果の文に差し替わって知らせの「取り消す」が消え、窓の部品（Modal）が戻す先を失う。
   * 「閉じる」と同じ先へ移す。取り消せなかったときは窓が残るので、押した「取り消す」へ戻す
   */
  const runConfirmed = () => {
    if (!confirming || confirming.busy) return;
    const { action } = confirming;
    const pressed = focusedNow();
    const back = cameFrom.current;
    setConfirming({ ...confirming, busy: true, error: null });
    action.run()
      .then((message) => { setConfirming(null); notify(message); focusAfter(pressed, backTo(back)); })
      .catch((e: Error) => { setConfirming((c) => (c ? { ...c, busy: false, error: e.message } : c)); focusAfter(pressed); });
  };

  /*
   * 時間が来たら自分で消える。ただし、フォーカスがあるあいだ・ポインタが乗っているあいだは消すまでの時間を止め、
   * 離れたら残りの時間から数え直す。キーボードで「取り消す」へ移るあいだや、読んでいるあいだに消えて、
   * フォーカスと取り消す機会を失わないようにする（WCAG 2.2.1 タイミング調整可能、GitHub Issue #210 の 2）
   */
  const [hold, setHold] = useState({ focus: false, pointer: false });
  const box = useRef<HTMLDivElement | null>(null);
  const left = useRef<{ seq: number; ms: number } | null>(null);
  /*
   * 表示は画面の下端に重ねて固定する。出ている間、スクロールする枠（職員は .main、保護者は .guardian-main）の下端を
   * 覆う高さを --toast-cover として渡し、枠はそのぶんを scroll-padding-bottom に取る（styles/app.css）。
   * 下のほうでフォーカスした部品（「確認しました」のあとの「園が確認しました」など）が、表示の下に隠れないようにする
   * （WCAG 2.4.11 フォーカスの非隠蔽、GitHub Issue #212）
   */
  const cover = useOverlayInset('.main, .guardian-main', '--toast-cover');
  const toastRef = useCallback((el: HTMLDivElement | null) => {
    box.current = el;
    const release = cover(el);
    return () => { box.current = null; release?.(); };
  }, [cover]);

  useEffect(() => {
    // 知らせが消えたら、止めていたことも忘れる（消えた表示からは、離れた知らせが届かないため）
    const onToast = (next: Toast | null) => { setToast(next); if (!next) setHold({ focus: false, pointer: false }); };
    listeners.add(onToast);
    return () => { listeners.delete(onToast); };
  }, []);

  useEffect(() => {
    if (!toast) return;
    // フォーカスのあった部品が知らせの差し替えで消えると、離れた知らせが届かない。いまも中にあるかを見る
    const held = hold.pointer || (hold.focus && !!box.current?.contains(document.activeElement));
    if (held) {
      // 止めた時点の残りを覚える（同じ知らせのあいだに何度止めても、残りから数える）
      if (left.current?.seq !== toast.seq) left.current = { seq: toast.seq, ms: Math.max(0, toast.until - Date.now()) };
      return;
    }
    const rest = left.current?.seq === toast.seq ? left.current.ms : Math.max(0, toast.until - Date.now());
    const startedAt = Date.now();
    const t = setTimeout(() => { if (current?.seq === toast.seq) publish(null); }, rest);
    return () => {
      clearTimeout(t);
      left.current = { seq: toast.seq, ms: Math.max(0, rest - (Date.now() - startedAt)) };
    };
  }, [toast, hold]);

  if (!toast && !confirming) return null;
  return (
    <>
      {toast && (
        <div ref={toastRef} className="toast" role="status" aria-live="polite"
          onFocus={(e) => {
            // 外から入ってきたときだけ、入る前にいた部品を覚える（知らせの中で「取り消す」から「閉じる」へ移ったときは覚え直さない）
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) cameFrom.current = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
            setHold((h) => ({ ...h, focus: true }));
          }}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHold((h) => ({ ...h, focus: false })); }}
          onPointerEnter={() => setHold((h) => ({ ...h, pointer: true }))}
          onPointerLeave={() => setHold((h) => ({ ...h, pointer: false }))}>
          <span>{toast.text}</span>
          {toast.action && (
            <button className="btn-sm btn-quiet" onClick={() => openConfirm(toast.action!)}>{toast.action.label}</button>
          )}
          <button className="btn-sm btn-quiet" onClick={close}>閉じる</button>
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
export function ConfirmDialog({ title, children, confirmLabel, danger, busy, confirmDisabled, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; confirmDisabled?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}
      footer={<>
        <button onClick={onCancel} disabled={busy}>やめる</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy || confirmDisabled}>
          {confirmLabel}
        </button>
      </>}>
      {children}
    </Modal>
  );
}
