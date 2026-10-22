/*
 * 記録した値を直す・取り消す（職員の連絡帳の画面と、午睡チェック画面の行）
 * 典拠：詳細設計書「共通の部品」(2-0 (1)) の CorrectionMenu・「訂正・取り消しのまとめ」(3-5)・「訂正・取り消し」(4-7)・(4-6 (4))、
 *      図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目17・「連絡帳（園児）画面」(8-2) 項目7・「午睡チェック画面」(5-1) 項目27・
 *      「取り消し・削除の確認」(1-3 (4))
 *
 * 直す：同じダイアログの中で値・時刻を選び直して「直す」（訂正。保護者に「訂正しました（時刻）」が出る）。
 * 取り消す：確認のダイアログに、いま読んでいる家庭の数を出してから取り消す（保護者の全画面から消える）。
 * 誤りはダイアログの中に出す（図/画面詳細図「全画面に共通する規定」(0-2) のダイアログの中の誤り）。
 * 直せる人かはサーバが確かめる。画面は直せない人にこのダイアログを開く部品を出さない。
 */
import { useEffect, useState } from 'react';
import { api, settingText } from '../../api/client';
import type { ContactEvent, ContactFacility, MealAmount, NameMatch, NapSleep, Readers } from '../../api/shapes';
import NameCheckDialog from '../../components/NameCheckDialog';
import type { ToastAction } from '../../components/feedback';
import { useSession } from '../../session';
import { Modal } from '../../components/ui';
import { formatHM, now, today } from '../../api/util';
import { MEAL_AMOUNT_STAFF_TEXT, TEXT } from '../../messages';
import { TEMPERATURE_CHOICES } from '../../components/TemperaturePicker';
import { eventText, sleepLines } from './contactText';
import type { SessionUser } from '../../api/types';

export type FixTarget =
  | { kind: 'event'; event: ContactEvent; childName: string }
  | { kind: 'sleep'; sleep: NapSleep; childName: string; date: string }
  | { kind: 'facility'; facility: ContactFacility; childName: string };

/** 排せつの選択肢（設定。サーバの defaultToiletChoices と同じ既定） */
export function toiletChoices(): string[] {
  return settingText('contact.toilet_choices', 'おしっこ,うんち,おむつ交換,トイレでできた').split(',').map((v) => v.trim()).filter(Boolean);
}

/** その日の 0:00 から、今日ならいままで（前の日は 23:55 まで）の5分刻みの時刻。今の値が刻みに無ければ足す */
export function timeOptions(date: string, current?: string): string[] {
  const end = date === today() ? now().slice(11, 16) : '23:59';
  const out: string[] = [];
  for (let m = 0; m < 24 * 60; m += 5) {
    const hm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    if (hm > end) break;
    out.push(hm);
  }
  if (current && !out.includes(current)) out.push(current);
  return out.sort();
}

/** 取り消しの確認に出す要約（「12:10 給食 ぜんぶ（野原 太郎）」） */
export function targetSummary(t: FixTarget): string {
  if (t.kind === 'event') return `${formatHM(t.event.recorded_at)} ${eventText(t.event).slice(0, 30)}（${t.childName}）`;
  if (t.kind === 'facility') return `${formatHM(t.facility.recorded_at)} 園から「${t.facility.body.slice(0, 20)}${[...t.facility.body].length > 20 ? '…' : ''}」（${t.childName}）`;
  const lines = sleepLines(t.sleep, false, 'staff').map((l) => l.text).join('・');
  return `${lines}（${t.childName}）`;
}

async function readersOf(user: SessionUser, t: FixTarget): Promise<Readers> {
  if (t.kind === 'facility') return api.facilityReaders(user, t.facility.contact_facility_id);
  return t.kind === 'event' ? api.eventReaders(user, t.event.contact_event_id) : api.sleepReaders(user, t.sleep.nap_sleep_id);
}

async function cancelTarget(user: SessionUser, t: FixTarget): Promise<void> {
  if (t.kind === 'event') await api.cancelEvent(user, t.event.contact_event_id);
  else if (t.kind === 'facility') await api.cancelFacility(user, t.facility.contact_facility_id);
  else await api.cancelSleep(user, t.sleep.nap_sleep_id);
}

/** 【仮置き】取り消したあとの結果の文。設計に文言が無い（web/仮置き値.md） */
const cancelledText = (summary: string) => `取り消しました（${summary}）。保護者の画面からも消えました。`;

/** 結果の表示に添える「取り消す」（図/画面詳細図「全画面に共通する規定」(0-2) の完了の表示） */
export function cancelAction(user: SessionUser, t: FixTarget): ToastAction {
  const summary = targetSummary(t);
  return {
    label: '取り消す',
    confirmTitle: 'この記録を取り消しますか',
    describe: async () => {
      const r = await readersOf(user, t);
      return `${summary}\n${TEXT.cancelReaders(r.family_count, r.guardian_count)}`;
    },
    run: async () => {
      await cancelTarget(user, t);
      return cancelledText(summary);
    },
  };
}

export default function FixDialog({ target, normalTemperature, startMode = 'edit', onDone, onClose, returnWithin }: {
  target: FixTarget;
  /** 「取り消す」から開いたときは、取り消しの確認から始める */
  startMode?: 'edit' | 'cancel';
  /** 体温を直すときの一覧の位置（平熱） */
  normalTemperature?: number | null;
  /** 直した・取り消したあと。結果の文を受け取る */
  onDone: (message: string) => void;
  onClose: () => void;
  /** 開いた元（「直す」など）を囲む範囲（狭い順）。取り消して記録が消えたあとの読み直しで開いた元が消えたときの移し先（窓の部品 Modal の returnWithin。GitHub Issue #213） */
  returnWithin?: string[];
}) {
  const { user } = useSession();
  const [mode, setMode] = useState<'edit' | 'cancel'>(startMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readers, setReaders] = useState<Readers | null>(null);
  const summary = targetSummary(target);
  const e = target.kind === 'event' ? target.event : null;
  const s = target.kind === 'sleep' ? target.sleep : null;
  const date = e ? e.contact_date : target.kind === 'sleep' ? target.date : target.kind === 'facility' ? target.facility.contact_date : today();
  // 活動のひとことの文を直す（訂正も他児の名前の照合を通る。当たれば注意を出して承諾を付けて送り直す）
  const [body, setBody] = useState(e?.body ?? '');
  const [check, setCheck] = useState<{ names: string[]; matches: NameMatch[] } | null>(null);
  const [toilet, setToilet] = useState(e?.toilet_label ?? '');
  const [temperature, setTemperature] = useState(e?.temperature ?? normalTemperature ?? 36.5);
  const [time, setTime] = useState(e ? formatHM(e.recorded_at) : '');
  const [slept, setSlept] = useState(s ? formatHM(s.slept_at) : '');
  const [woke, setWoke] = useState(s?.woke_at ? formatHM(s.woke_at) : '');

  useEffect(() => {
    if (mode !== 'cancel' || !user) return;
    let alive = true;
    readersOf(user, target).then((r) => { if (alive) setReaders(r); }).catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [mode, user, target]);

  const run = async (work: () => Promise<string>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const message = await work();
      // 空の文は「他児の名前の注意を開いた」（まだ送っていない）
      if (message) onDone(message);
    } catch (err) {
      // 入力は残し、ダイアログの中に何が違うかと次にすることを出す
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fixedText = `直しました（${target.childName}）。保護者の画面に「訂正しました」と出ます。`;
  const correctMeal = (amount: MealAmount) => run(async () => {
    await api.correctEvent(user!, e!.contact_event_id, { meal_amount: amount, updated_at: e!.updated_at ?? '' });
    return fixedText;
  });
  const correctOther = () => run(async () => {
    const at = `${date}T${time}:00`;
    await api.correctEvent(user!, e!.contact_event_id, {
      ...(e!.event_type === '2' && toilet !== e!.toilet_label ? { toilet_label: toilet } : {}),
      ...(e!.event_type === '3' && temperature !== e!.temperature ? { temperature } : {}),
      ...(time !== formatHM(e!.recorded_at) ? { recorded_at: at } : {}),
      updated_at: e!.updated_at ?? '',
    });
    return fixedText;
  });
  const correctBody = (acknowledged: string[]) => run(async () => {
    try {
      await api.correctEvent(user!, e!.contact_event_id, { body, acknowledged_names: acknowledged, updated_at: e!.updated_at ?? '' });
    } catch (err) {
      const x = err as Error & { kind?: string; names?: string[]; matches?: NameMatch[] };
      if (x.kind === 'other_child_names' && x.names) { setCheck({ names: x.names, matches: x.matches ?? [] }); return ''; }
      throw err;
    }
    setCheck(null);
    return fixedText;
  });
  const correctSleep = () => run(async () => {
    await api.correctSleep(user!, s!.nap_sleep_id, {
      ...(slept !== formatHM(s!.slept_at) ? { slept_at: `${date}T${slept}:00` } : {}),
      ...(woke && woke !== (s!.woke_at ? formatHM(s!.woke_at) : '') ? { woke_at: `${date}T${woke}:00` } : {}),
      updated_at: s!.updated_at ?? '',
    });
    return fixedText;
  });

  if (mode === 'cancel') {
    return (
      <Modal title="この記録を取り消しますか" onClose={onClose} returnWithin={returnWithin}
        footer={<>
          <button type="button" onClick={() => { if (startMode === 'cancel') onClose(); else { setMode('edit'); setError(null); } }} disabled={busy}>やめる</button>
          <button type="button" className="btn-danger" onClick={() => run(async () => { await cancelTarget(user!, target); return cancelledText(summary); })}
            disabled={busy || readers === null} aria-busy={busy}>{busy ? TEXT.sending : '取り消す'}</button>
        </>}>
        <p><strong>{summary}</strong></p>
        <p>{readers === null ? '読み込んでいます…' : TEXT.cancelReaders(readers.family_count, readers.guardian_count)}</p>
        {error && <p className="contact-error" role="alert">{error}</p>}
      </Modal>
    );
  }

  const editable = target.kind === 'sleep' || (!!e && ['1', '2', '3', '4'].includes(e.event_type));
  return (
    <Modal title="記録を直す" onClose={onClose} returnWithin={returnWithin}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}>閉じる</button>
        <button type="button" className="btn-danger btn-quiet" onClick={() => { setMode('cancel'); setError(null); }} disabled={busy}>この記録を取り消す</button>
      </>}>
      <div className="fix-dialog">
        <p><strong>{summary}</strong></p>
        {e?.event_type === '1' && (
          <div className="contact-picks" role="group" aria-label="食べた量を選び直す">
            {(['1', '2', '3', '4'] as const).map((v) => (
              <button key={v} type="button" className="contact-pick" aria-pressed={e.meal_amount === v}
                onClick={() => v !== e.meal_amount && correctMeal(v)} disabled={busy}>{MEAL_AMOUNT_STAFF_TEXT[v]}</button>
            ))}
          </div>
        )}
        {e?.event_type === '2' && (
          <div className="contact-picks" role="group" aria-label="排せつを選び直す">
            {[...new Set([...toiletChoices(), e.toilet_label ?? ''])].filter(Boolean).map((label) => (
              <button key={label} type="button" className="contact-pick" aria-pressed={toilet === label}
                onClick={() => setToilet(label)} disabled={busy}>{label}</button>
            ))}
          </div>
        )}
        {e?.event_type === '3' && (
          <label className="contact-field">
            <span>体温（℃）</span>
            <select value={temperature.toFixed(1)} onChange={(ev) => setTemperature(Number(ev.target.value))} disabled={busy}>
              {[...new Set([...TEMPERATURE_CHOICES, temperature])].sort((a, b) => a - b).map((t) => (
                <option key={t} value={t.toFixed(1)}>{t.toFixed(1)}</option>
              ))}
            </select>
          </label>
        )}
        {(e?.event_type === '2' || e?.event_type === '3') && (
          <label className="contact-field">
            <span>時刻</span>
            <select value={time} onChange={(ev) => setTime(ev.target.value)} disabled={busy}>
              {timeOptions(date, formatHM(e.recorded_at)).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        )}
        {(e?.event_type === '2' || e?.event_type === '3') && (
          <button type="button" className="btn-primary contact-wide-button" onClick={correctOther} disabled={busy} aria-busy={busy}>
            {busy ? TEXT.sending : '直す'}
          </button>
        )}
        {e?.event_type === '4' && (
          <>
            <label className="contact-field">
              <span>ひとこと（200文字まで）</span>
              <textarea value={body} maxLength={200} onChange={(ev) => setBody(ev.target.value)} disabled={busy} />
            </label>
            <button type="button" className="btn-primary contact-wide-button" onClick={() => correctBody([])}
              disabled={busy || body.trim() === '' || body === e.body} aria-busy={busy}>{busy ? TEXT.sending : '直して送る'}</button>
            {check && (
              <NameCheckDialog names={check.names} matches={check.matches} text={body.trim()} busy={busy}
                onFix={() => setCheck(null)} onSend={() => correctBody(check.names)} />
            )}
          </>
        )}
        {s && (
          <>
            <div className="contact-field-row">
              <label className="contact-field">
                <span>ねた時刻</span>
                <input type="time" value={slept} onChange={(ev) => setSlept(ev.target.value)} disabled={busy} />
              </label>
              <label className="contact-field">
                <span>おきた時刻{s.woke_at ? '' : '（記録されていません）'}</span>
                <input type="time" value={woke} onChange={(ev) => setWoke(ev.target.value)} disabled={busy} />
              </label>
            </div>
            <button type="button" className="btn-primary contact-wide-button" onClick={correctSleep} disabled={busy || !slept} aria-busy={busy}>
              {busy ? TEXT.sending : '直す'}
            </button>
          </>
        )}
        {!editable && <p className="muted">この記録は、取り消して送り直します。</p>}
        {error && <p className="contact-error" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
