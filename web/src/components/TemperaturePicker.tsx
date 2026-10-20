/*
 * 体温を 0.1℃刻みの一覧から選ぶ（連絡帳（クラス）画面・連絡帳（園児）画面・連絡帳画面（保護者）で使う共通の部品）
 * 典拠：詳細設計書「共通の部品」(2-0 (1)) の TemperaturePicker・「排せつ・体温の列」(2-2 (5))・「家庭からを書く」(2-6 (3))、
 *      基本設計書「入力項目の制約値」(4-12)（体温は 30.0〜43.0℃、小数第1位まで。範囲外でも入力を妨げず、確認を促すだけ）
 *
 * 一覧は 35.0〜39.9℃。開いた位置は、職員の画面は園児の平熱、保護者の画面は 36.5 から（ここを押すと記録する。2タップ）。
 * ほかの値は「ほかの値」から数字で入れる。30.0〜43.0℃の外は確かめを促すが、止めない（判定をしない）。
 * 値に判定の色や言葉を付けない。
 *
 * 午睡チェック画面の入眠時・5分ごとの体温（screens/nap/NapCheckScreen.tsx の TemperaturePicker）は、
 * 監査の層の画面を変えないため、本版ではまだこの部品へ移していない。
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal } from './ui';
import { isOneDecimal } from '../api/util';
import { MSG, TEXT } from '../messages';

/** 一覧に並べる値（35.0〜39.9℃） */
export const TEMPERATURE_CHOICES = Array.from({ length: 50 }, (_, i) => (350 + i) / 10);

export default function TemperaturePicker({ title, start, busy, error, onSelect, onClose, children }: {
  title: string;
  /** 開いた位置（平熱。無ければ 36.5） */
  start: number | null;
  busy?: boolean;
  /** 送れなかった理由（ダイアログの中に出す） */
  error?: string | null;
  onSelect: (value: number) => void;
  onClose: () => void;
  /** 一覧の上に添えるもの（時刻を変える欄など） */
  children?: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState('');
  const [outsideAck, setOutsideAck] = useState(false);
  const inputId = useId();
  const origin = Math.round((start ?? 36.5) * 10) / 10;

  // 開いたら、平熱（または 36.5）の位置を見せる
  useEffect(() => {
    const target = listRef.current?.querySelector<HTMLButtonElement>(`[data-value="${origin.toFixed(1)}"]`);
    target?.scrollIntoView?.({ block: 'center' });
  }, [origin]);

  const value = Number(manual);
  const problem = !manual ? null : !Number.isFinite(value) || !isOneDecimal(value) ? MSG.temperatureFormat : null;
  const outside = !problem && manual !== '' && (value < 30 || value > 43);
  const submitManual = () => {
    if (!manual || problem) return;
    // 範囲の外は確かめを促すが、止めない（2回目の「このまま記録する」で記録する）
    if (outside && !outsideAck) { setOutsideAck(true); return; }
    onSelect(Math.round(value * 10) / 10);
  };

  return (
    <Modal title={title} onClose={onClose} footer={<button type="button" onClick={onClose} disabled={busy}>閉じる</button>}>
      <div className="temperature-picker">
        {children}
        <p className="muted">体温計で測った値を押してください。</p>
        <div ref={listRef} className="temperature-grid" role="group" aria-label="体温の一覧">
          {TEMPERATURE_CHOICES.map((t) => (
            <button key={t} type="button" data-value={t.toFixed(1)} onClick={() => onSelect(t)} disabled={busy}
              className={t === origin ? 'is-origin' : undefined}>
              {t.toFixed(1)}
            </button>
          ))}
        </div>
        <div className="temperature-manual">
          {manualOpen ? (
            <>
              <label htmlFor={inputId}>ほかの値（℃）</label>
              <input id={inputId} type="number" inputMode="decimal" step="0.1" value={manual} placeholder="例：34.9"
                onChange={(e) => { setManual(e.target.value); setOutsideAck(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitManual(); } }} />
              <button type="button" onClick={submitManual} disabled={busy || !manual || !!problem}>
                {outsideAck ? 'このまま記録する' : '記録する'}
              </button>
              {problem && <p className="contact-error" role="alert">{problem}</p>}
              {outside && outsideAck && <p className="contact-error" role="alert">{TEXT.temperatureOutOfRange}</p>}
            </>
          ) : (
            <button type="button" className="btn-quiet" onClick={() => setManualOpen(true)} disabled={busy}>ほかの値</button>
          )}
        </div>
        {busy && <p className="muted" role="status">{TEXT.sending}</p>}
        {error && <p className="contact-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
