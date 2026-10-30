/*
 * 園児の行の「ねた」「おきた」「きょうは対象外」（5分ごとの確認と同じ行。別の画面へ移らせない）
 * 典拠：詳細設計書「午睡チェック画面（ねた・おきた・きょうは対象外）」(2-4)・「午睡の園児」(3-4)、
 *      基本設計書「ねた・おきた」(4-8)
 *
 * | 行の状態 | 表示 | 押せるもの |
 * | まだ | ― | 「ねた」「対象外」 |
 * | おひるね中 | 「13:05 ねた」 | 「おきた」 |
 * | おきた | 「13:05〜14:40（1時間35分）」 | 「もう一度ねた」 |
 * | 対象外 | 「対象外（欠席）」 | 「戻す」 |
 *
 * 時刻はサーバが打つ（画面は端末の時計で記録の時刻を作らない）。押したら応答を待ち、結果を出す（楽観的更新をしない）。
 * 5分ごとの確認（この子を記録）は今までどおりで、ここは監査の記録を弱めない。
 */
import { useEffect, useRef, useState } from 'react';
import type { NapChildState } from '../../api/shapes';
import { api } from '../../api/client';
import { useSession } from '../../session';
import { notify } from '../../components/feedback';
import { formatHM } from '../../api/util';
import { useReachable } from '../../api/reachability';
import { focusAfter, focusedNow } from '../../focusAfter';
import { TEXT } from '../../messages';
import { durationText } from '../contact/contactText';
import ExclusionDialog from './ExclusionDialog';
import FixDialog, { cancelAction } from '../contact/FixDialog';
import type { FixTarget } from '../contact/FixDialog';
import { today } from '../../api/util';

const EXCLUSION_REASON: Record<'1' | '2', string> = { '1': '欠席', '2': '午睡なし' };

export default function SleepControls({ row, sessionId, onSaved }: {
  row: NapChildState; sessionId: number; onSaved: () => void;
}) {
  const { user } = useSession();
  const reachable = useReachable();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [excluding, setExcluding] = useState(false);
  // 押し間違いを直す・取り消す（その日はその園児のクラスの担任、管理者はいつでも。詳細設計書「行の状態ごとの表示」(2-4 (2))）
  const [fixing, setFixing] = useState<FixTarget | null>(null);
  const name = row.child.child_name;
  const open = row.sleeps.find((s) => !s.woke_at) ?? null;
  const last = row.sleeps.at(-1) ?? null;

  const press = async () => {
    if (busy) return;
    /*
     * 送っている間はボタンが押せなくなり、フォーカスが外れる。応答のあと、同じボタンへ戻す。
     * 「ねた」は記録すると同じボタンが「おきた」に、「おきた」は「もう一度ねた」に替わる（WCAG 2.4.3、GitHub Issue #213）
     */
    const pressed = focusedNow();
    setBusy(true); setError(null);
    try {
      // 結果の表示に「取り消す」を添える（図/画面詳細図「午睡チェック画面」(5-1) 項目22・27）
      if (open) {
        const s = await api.wake(user!, open.nap_sleep_id);
        notify(`${name}さんの「おきた」（${formatHM(s.woke_at ?? s.slept_at)}）を記録しました。保護者が見られる状態です。`,
          cancelAction(user!, { kind: 'sleep', sleep: s, childName: name, date: today() }));
      } else {
        const s = await api.sleep(user!, sessionId, row.child.child_id);
        notify(`${name}さんの「ねた」（${formatHM(s.slept_at)}）を記録しました。保護者が見られる状態です。`,
          cancelAction(user!, { kind: 'sleep', sleep: s, childName: name, date: today() }));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      // 成功でも 409（ほかの職員が先に押した・終了した）でも、今の状態を読み直す
      onSaved();
      focusAfter(pressed);
    }
  };

  /*
   * 「対象外」の窓のフォーカス（WCAG 2.4.3、GitHub Issue #213。共通の決まりは src/focusAfter.ts）
   *   - 開く：「やめる」へ入れる（ExclusionDialog.tsx。Enter の押しすぎで記録しないよう、いちばん弱い操作へ）。
   *     やめる・Esc：開いた元の「対象外」へ戻す（窓の部品のまま）
   *   - 理由を押して対象外にした：窓が閉じ、窓の部品が「対象外」へ戻すが、「対象外」は読み直すと消える。
   *     窓を片付けたあと（下の useEffect）に、同じ行に現れる「戻す」へ移す（「ねた」が同じ場所の「おきた」に替わるのと同じ）
   *   - 送れなかった：窓は開いたまま。送っている間に外れたフォーカスを、押した理由のボタンへ戻す
   * 行の「戻す」も、送っている間に押せなくなり、戻すと「戻す」が消えて「ねた」「対象外」に替わる。
   *   - 戻した：同じ行に現れる「対象外」へ移す（対象外にしたら「戻す」へ移すのと対になる）
   *   - 送れなかった：「戻す」が残るので、押せるようになった「戻す」へ戻す
   */
  const restoreButton = useRef<HTMLButtonElement>(null);
  const excludeButton = useRef<HTMLButtonElement>(null);
  const excludedFrom = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // 窓の部品が閉じるときの後片付け（開いた元へ戻す）は、この effect より先に済んでいる
    if (excluding || !excludedFrom.current) return;
    const from = excludedFrom.current;
    excludedFrom.current = null;
    focusAfter(focusedNow() ?? from, () => restoreButton.current);
  }, [excluding]);

  /** 対象外にする・戻す（監査の層。保護者へは届かない） */
  const exclude = async (reason: '1' | '2' | null) => {
    if (busy) return;
    const pressed = focusedNow();
    let restored = false;
    setBusy(true); setError(null);
    try {
      if (reason) {
        await api.exclude(user!, sessionId, row.child.child_id, reason);
        notify(`${name}さんを、きょうは対象外（${EXCLUSION_REASON[reason]}）にしました。`);
        excludedFrom.current = pressed;
      } else if (row.exclusion) {
        await api.cancelExclusion(user!, row.exclusion.nap_exclusion_id);
        notify(`${name}さんの対象外を戻しました。`);
        restored = true;
      }
      setExcluding(false);
    } catch (e) {
      setError((e as Error).message);
      // 窓の中の理由、または行の「戻す」。どちらも残るので、押したボタンへ戻す
      focusAfter(pressed);
    } finally {
      setBusy(false);
      onSaved();
      if (restored) focusAfter(pressed, () => excludeButton.current);
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
      {/*
        行の状態（「13:30 ねた」など）は読み上げへ伝えない。午睡チェック画面の園児の行ごとの role="status" は外す
        （詳細設計書 (2-0) の (6) の③、GitHub Issue #209）。自分で押した結果は notify() で読み、ほかの職員の記録は読まない
      */}
      {state && <span className="nap-sleep-state">{state}</span>}
      {/* 「おきた」は行ごとにくり返す操作なので塗らない（DADS のプライマリーボタンは1画面に原則1つ）。寝ていることは左の「13:06 ねた」の文で示す */}
      {!row.exclusion && (
        <button type="button" className="nap-sleep-button" onClick={press}
          disabled={busy} aria-busy={busy} aria-label={`${name}の${label}`}>
          {busy ? TEXT.sending : !reachable && error ? TEXT.resend : label}
        </button>
      )}
      {!row.exclusion && row.sleeps.length === 0 && (
        <button ref={excludeButton} type="button" className="btn-quiet nap-exclude-button" onClick={() => setExcluding(true)} disabled={busy}
          aria-label={`${name}をきょうは対象外にする`}>
          対象外
        </button>
      )}
      {row.exclusion && (
        <button ref={restoreButton} type="button" className="nap-exclude-button" onClick={() => exclude(null)} disabled={busy} aria-busy={busy}
          aria-label={`${name}の対象外を戻す`}>
          {busy ? TEXT.sending : '戻す'}
        </button>
      )}
      {last && !row.exclusion && (
        <button type="button" className="btn-quiet nap-fix-button" disabled={busy}
          onClick={() => setFixing({ kind: 'sleep', sleep: last, childName: name, date: today() })}
          aria-label={`${name}のねた・おきたを直す・取り消す`}>
          直す・取り消す
        </button>
      )}
      {error && <span className="nap-sleep-error" role="alert">{error}</span>}
      {fixing && (
        <FixDialog target={fixing} onClose={() => setFixing(null)}
          onDone={(message) => { setFixing(null); notify(message); onSaved(); }} />
      )}
      {excluding && <ExclusionDialog name={name} busy={busy} onSelect={(r) => exclude(r)} onClose={() => setExcluding(false)} />}
    </div>
  );
}
