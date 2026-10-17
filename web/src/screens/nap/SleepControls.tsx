/*
 * 園児の行の「ねた」「おきた」（5分ごとの確認と同じ行。別の画面へ移らせない）
 * 典拠：詳細設計書「午睡チェック画面（ねた・おきた・きょうは対象外）」(2-4)・「午睡の園児」(3-4)、
 *      基本設計書「ねた・おきた」(4-8)
 *
 * | 行の状態 | 表示 | 押せるもの |
 * | まだ | ― | 「ねた」 |
 * | おひるね中 | 「13:05 ねた」 | 「おきた」 |
 * | おきた | 「13:05〜14:40（1時間35分）」 | 「もう一度ねた」 |
 * | 対象外 | 「対象外（欠席）」 | ― |
 *
 * 時刻はサーバが打つ（画面は端末の時計で記録の時刻を作らない）。押したら応答を待ち、結果を出す（楽観的更新をしない）。
 * 5分ごとの確認（この子を記録）は今までどおりで、ここは監査の記録を弱めない。
 */
import { useState } from 'react';
import type { NapChildState } from '../../api/shapes';
import { api } from '../../api/client';
import { useSession } from '../../session';
import { notify } from '../../components/feedback';
import { formatHM } from '../../api/util';
import { useReachable } from '../../api/reachability';
import { TEXT } from '../../messages';
import { durationText } from '../contact/contactText';

const EXCLUSION_REASON: Record<'1' | '2', string> = { '1': '欠席', '2': '午睡なし' };

export default function SleepControls({ row, sessionId, onSaved }: {
  row: NapChildState; sessionId: number; onSaved: () => void;
}) {
  const { user } = useSession();
  const reachable = useReachable();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = row.child.child_name;
  const open = row.sleeps.find((s) => !s.woke_at) ?? null;
  const last = row.sleeps.at(-1) ?? null;

  const press = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (open) {
        const s = await api.wake(user!, open.nap_sleep_id);
        notify(`${name}さんの「おきた」（${formatHM(s.woke_at ?? s.slept_at)}）を記録しました。保護者が見られる状態です。`);
      } else {
        const s = await api.sleep(user!, sessionId, row.child.child_id);
        notify(`${name}さんの「ねた」（${formatHM(s.slept_at)}）を記録しました。保護者が見られる状態です。`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      // 成功でも 409（ほかの職員が先に押した・終了した）でも、今の状態を読み直す
      onSaved();
    }
  };

  let state: string;
  if (row.exclusion) state = `対象外（${EXCLUSION_REASON[row.exclusion.reason]}）`;
  else if (open) state = `${formatHM(open.slept_at)} ねた`;
  else if (last?.woke_at) state = `${formatHM(last.slept_at)}〜${formatHM(last.woke_at)}（${durationText(last.slept_at, last.woke_at)}）`;
  else state = '';
  const label = open ? 'おきた' : last ? 'もう一度ねた' : 'ねた';

  return (
    <div className="nap-sleep-controls">
      {state && <span className="nap-sleep-state" role="status">{state}</span>}
      {!row.exclusion && (
        <button type="button" className={open ? 'btn-primary nap-sleep-button' : 'nap-sleep-button'} onClick={press}
          disabled={busy} aria-busy={busy} aria-label={`${name}の${label}`}>
          {busy ? TEXT.sending : !reachable && error ? TEXT.resend : label}
        </button>
      )}
      {error && <span className="nap-sleep-error" role="alert">{error}</span>}
    </div>
  );
}
