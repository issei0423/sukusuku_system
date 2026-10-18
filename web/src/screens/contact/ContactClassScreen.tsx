/*
 * 連絡帳（クラス）画面（職員・タブレット横向き）
 * 典拠：詳細設計書「連絡帳（クラス）画面」(2-2)・「食事の列の画面の中の状態」(3-2)、図/画面詳細図「連絡帳（クラス）画面」(8-1)、
 *      基本設計書「家庭からの確認」「食事の記録」「排せつ・体温の記録」(4-5)
 *
 * 行＝園児、列＝項目の表。園児名の列を左に止め、表の中だけを横に送る。
 * よく使う記録と「確認しました」は行の上で終える（段1。確認のダイアログを挟まない。1件3タップ以内）。
 *   - 家庭から：内容の全部をセルに出し、読んでから「確認しました」（1タップ）。外す操作は持たない
 *   - 食事：行の量を押すとその場で記録（1タップ）。記録のある行で別の量を押すと訂正（1タップ）。
 *     「全員ぜんぶ」は、その回の記録が無い行に「ぜんぶ」を仮に入れ（保存しない）、違う子・お休みの子を行で直してから「記録する」
 *   - 排せつ：選択肢のボタンを押すと記録（1タップ）。体温：「＋体温」→ 値（2タップ）
 *   - 記録した値を押すと「直す」「取り消す」（その日はその園児のクラスの担任、管理者はいつでも。取り消しは確認のダイアログ）
 * 午睡は表示だけ（記録は午睡チェック画面の行で行う）。押したらサーバの応答を待って結果を出す（楽観的更新をしない。決めたこと D-3）。
 * ひとこと・園からは、連絡帳（園児）画面で書いて送る（段2。宛先を大きく示し、他児の名前を照合する）。この表は件数と
 * 「未送信」「欠席」（午睡で欠席にした子。未送信に数えない）「送った 17:05」を出し、押すとその園児の画面へ移る。
 * 体温に判定の色や言葉を付けない（平熱は比べる材料として並べてよい）。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { ContactClassRow, ContactClassView, ContactEvent, ContactEventInput, HomeState, MealAmount } from '../../api/shapes';
import { useSession } from '../../session';
import { useAsync, AUTO_REFRESH_MS } from '../../hooks';
import { onContactClass } from '../../live';
import { addDays, formatHM, today } from '../../api/util';
import { Alert, Empty, ErrorBox, Loading } from '../../components/ui';
import { notify } from '../../components/feedback';
import { useReachable } from '../../api/reachability';
import { useUnsavedInput } from '../../unsavedInput';
import { useStickyInset } from '../../stickyInset';
import TemperaturePicker from '../../components/TemperaturePicker';
import { MEAL_AMOUNT_STAFF_TEXT, MEAL_KIND_TEXT, TEXT } from '../../messages';
import { dayLabel, eventText, homeLines, latestSleepText } from './contactText';
import FixDialog, { cancelAction, toiletChoices } from './FixDialog';
import type { FixTarget } from './FixDialog';

const HOME_STATE_TEXT: Record<HomeState, string> = { none: 'まだ', unconfirmed: '未確認', revised: '更新', confirmed: '確認済み' };
/** sort=home の並び：「更新」「未確認」「まだ」「確認済み」（詳細設計書 (2-2 (2))） */
const HOME_ORDER: Record<HomeState, number> = { revised: 0, unconfirmed: 1, none: 2, confirmed: 3 };
const AMOUNTS = ['1', '2', '3', '4'] as const;

/** 食事の区分と回（給食・おやつ・おやつ（2回目）。決めたこと D-5） */
type MealSlot = { kind: '1' | '2'; round: 1 | 2 };
const slotLabel = (s: MealSlot) => `${MEAL_KIND_TEXT[s.kind]}${s.round === 2 ? '（2回目）' : ''}`;
/** 仮に入れた量。'off' は仮を外した（お休み）。保存していない（詳細設計書「食事の列の画面の中の状態」(3-2)） */
type Tentative = Map<string, MealAmount | 'off'>;

/** その行の、その区分・回の記録（回は記録の順で数える） */
function mealOf(row: ContactClassRow, slot: MealSlot): ContactEvent | undefined {
  return row.events.filter((e) => e.event_type === '1' && e.meal_kind === slot.kind)[slot.round - 1];
}

function HomeCell({ row, canConfirm, busy, onConfirm }: {
  row: ContactClassRow; canConfirm: boolean; busy: boolean; onConfirm: () => void;
}) {
  const h = row.home;
  if (!h) return <span className="muted">{HOME_STATE_TEXT.none}</span>;
  return (
    <div className={`contact-home-cell is-${row.home_state}`}>
      <p className="contact-home-state">
        <span className={`tag ${row.home_state === 'confirmed' ? 'tag-approved' : 'tag-returned'}`}>{HOME_STATE_TEXT[row.home_state]}</span>
        {' '}{h.guardian_relationship || h.guardian_name} {formatHM(h.submitted_at)}
      </p>
      <dl className="contact-home-lines">
        {homeLines(h).map((l) => (
          <div key={l.label} className={l.mark ? 'is-marked' : undefined}>
            <dt>{l.mark && <span aria-hidden="true">● </span>}{l.label}</dt><dd>{l.text}</dd>
          </div>
        ))}
      </dl>
      {h.confirmed_at
        ? <p className="contact-confirmed">園が確認しました {formatHM(h.confirmed_at)} {h.confirmed_staff_name}</p>
        : canConfirm && (
          <button type="button" className="btn-primary contact-confirm-button" onClick={onConfirm} disabled={busy} aria-busy={busy}
            aria-label={`${row.child.child_name}の家庭からを確認しました`}>
            {busy ? TEXT.sending : '確認しました'}
          </button>
        )}
    </div>
  );
}

/** 食事の列の1行。記録が無い行は押すと記録、記録のある行は別の量を押すと訂正。仮に入れた行は点線の枠 */
function MealCell({ row, slot, canRecord, tentative, busy, onRecord, onCorrect, onFix, onTentative }: {
  row: ContactClassRow; slot: MealSlot; canRecord: boolean; tentative: MealAmount | 'off' | undefined; busy: boolean;
  onRecord: (amount: MealAmount) => void; onCorrect: (e: ContactEvent, amount: MealAmount) => void;
  onFix: (e: ContactEvent) => void; onTentative: (value: MealAmount | 'off') => void;
}) {
  const name = row.child.child_name;
  const recorded = mealOf(row, slot);
  if (!canRecord) {
    return recorded ? <span>{MEAL_AMOUNT_STAFF_TEXT[recorded.meal_amount ?? '1']}{recorded.corrected_at && <span className="muted">（訂正）</span>}</span>
      : <span className="muted">―</span>;
  }
  return (
    <div className="contact-picks is-meal" role="group" aria-label={`${name}の${slotLabel(slot)}`}>
      {AMOUNTS.map((v) => {
        const chosen = recorded ? recorded.meal_amount === v : tentative === v;
        const press = () => {
          if (recorded) return v === recorded.meal_amount ? onFix(recorded) : onCorrect(recorded, v);
          // 仮に入れている間は、行で直す（仮の「ぜんぶ」をもう一度押すとお休み＝仮を外す）
          if (tentative !== undefined) return onTentative(tentative === v ? 'off' : v);
          return onRecord(v);
        };
        return (
          <button key={v} type="button" onClick={press} disabled={busy} aria-pressed={chosen}
            className={`contact-pick${!recorded && tentative === v ? ' is-tentative' : ''}`}
            aria-label={`${name}の${slotLabel(slot)}を${MEAL_AMOUNT_STAFF_TEXT[v]}${!recorded && tentative === v ? '（仮）' : ''}`}>
            {MEAL_AMOUNT_STAFF_TEXT[v]}
          </button>
        );
      })}
      {!recorded && tentative === 'off' && <span className="muted contact-pick-note">お休み（記録しない）</span>}
      {recorded?.corrected_at && <span className="muted contact-pick-note">訂正しました（{formatHM(recorded.corrected_at)}）</span>}
    </div>
  );
}

export default function ContactClassScreen() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const classes = useAsync(() => api.contactClasses(user!), [user?.account_id]);
  const classId = Number(params.get('class') ?? user?.class_id ?? classes.data?.[0]?.class_id ?? 0);
  const date = params.get('date') ?? today();
  const sort = params.get('sort') === 'home' ? 'home' : params.get('sort') === 'facility' ? 'facility' : 'kana';
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<MealSlot>({ kind: '1', round: 1 });
  const [tentative, setTentative] = useState<Tentative | null>(null);
  const [pendingSlot, setPendingSlot] = useState<MealSlot | null>(null);
  const [failed, setFailed] = useState(false);
  const [fix, setFix] = useState<{ target: FixTarget; normal: number | null } | null>(null);
  const [tempFor, setTempFor] = useState<ContactClassRow | null>(null);
  const reachable = useReachable();
  // 仮に入れた食事は保存していない。ログアウトの前に、破棄されることを確かめさせる
  useUnsavedInput(tentative !== null);
  // 知らせは、このクラスか、このクラスの園児のものだけで読み直す（詳細設計書「画面ごとの読み直し」(6-5)）
  const childIds = useRef<string[]>([]);
  const view = useAsync(async (): Promise<ContactClassView | null> => (classId ? api.contactClass(user!, classId, date) : null),
    [user?.account_id, classId, date], { refreshMs: AUTO_REFRESH_MS, live: (e) => onContactClass(classId, childIds.current)(e) });
  const data = view.data;
  useEffect(() => { childIds.current = data?.rows.map((r) => r.child.child_id) ?? []; }, [data]);
  /*
   * 左に止めた園児名の列の幅を、表を横に送る枠（.contact-table-wrap）へ --contact-col-child-w として渡す。
   * 枠はその幅ぶんを scroll-padding-left に取り、キーボードで表の中を移ったとき（iPad の横向き 1024px など、表が横に送られる幅）に、
   * フォーカスした部品が園児名の列の下に隠れないようにする（WCAG 2.4.11 フォーカスの非隠蔽、GitHub Issue #212）
   */
  const childColumn = useStickyInset('.contact-table-wrap', '--contact-col-child-w', 'width');

  const go = (next: { class?: number; date?: string; sort?: string }) => {
    const p: Record<string, string> = {};
    const c = next.class ?? classId;
    const d = next.date ?? date;
    const s = next.sort ?? sort;
    if (c) p.class = String(c);
    if (d !== today()) p.date = d;
    if (s === 'home' || s === 'facility') p.sort = s;
    setError(null); setTentative(null); setPendingSlot(null);
    setParams(p);
  };

  /** 押したら応答を待つ。成功でも失敗でも、今の状態を読み直す */
  const act = async (key: string, name: string, work: () => Promise<void>) => {
    if (busyKey !== null) return;
    setBusyKey(key); setError(null);
    try {
      await work();
      setFailed(false);
    } catch (e) {
      const message = (e as Error).message;
      setError(`${name}さん：${message}`);
      notify(message);
      setFailed(true);
    } finally {
      setBusyKey(null);
      view.refresh();
    }
  };

  const confirm = (row: ContactClassRow) => {
    if (!row.home) return;
    const home = row.home;
    // 読んだあとに保護者が直していたら 409。読み直して、新しい内容を読んでから押してもらう
    return act(`home-${home.contact_home_id}`, row.child.child_name, async () => {
      await api.confirmHome(user!, home.contact_home_id, home.updated_at);
      notify(`${row.child.child_name}さんの家庭からを確認しました。保護者に「園が確認しました」と出ます。`);
    });
  };

  /** 1件を記録する（段1。その場で保存）。結果の表示に「取り消す」を添える */
  const recordOne = (row: ContactClassRow, key: string, input: ContactEventInput) =>
    act(key, row.child.child_name, async () => {
      const res = await api.recordEvents(user!, [input]);
      const saved = res.events[0];
      if (!saved) {
        // ほかの職員が先に同じ回を記録していた（上書きしない）
        notify(`${row.child.child_name}さんの${slotLabel(slot)}は、すでに記録されていました。表を読み直しました。`);
        return;
      }
      // 【仮置き】記録したときの結果の文。園児名と記録したものを足した（web/仮置き値.md）
      notify(`${row.child.child_name}さんの「${eventText(saved)}」を記録しました。保護者が見られる状態です。`,
        cancelAction(user!, { kind: 'event', event: saved, childName: row.child.child_name }));
    });

  const correctMeal = (row: ContactClassRow, e: ContactEvent, amount: MealAmount) =>
    act(`meal-${row.child.child_id}`, row.child.child_name, async () => {
      await api.correctEvent(user!, e.contact_event_id, { meal_amount: amount, updated_at: e.updated_at ?? '' });
      notify(`${row.child.child_name}さんの${slotLabel(slot)}を「${MEAL_AMOUNT_STAFF_TEXT[amount]}」に直しました。保護者の画面に「訂正しました」と出ます。`);
    });

  /** 全員ぜんぶ：その回の記録が無い行に「ぜんぶ」を仮に入れる（保存しない。確認のダイアログは出さない） */
  const fillAll = () => {
    const next: Tentative = new Map();
    for (const row of data?.rows ?? []) if (!mealOf(row, slot)) next.set(row.child.child_id, '1');
    setTentative(next); setError(null);
  };
  const saveTentative = () => {
    if (!tentative) return;
    const items: ContactEventInput[] = [...tentative].filter(([, v]) => v !== 'off')
      .map(([childId, v]) => ({ child_id: childId, event_type: '1', meal_kind: slot.kind, meal_amount: v as MealAmount, meal_round: slot.round }));
    if (items.length === 0) { setTentative(null); return; }
    void act('meal-all', 'クラス', async () => {
      const res = await api.recordEvents(user!, items);
      setTentative(null);
      const skipped = res.skipped.length > 0 ? `${res.skipped.length}人はすでに記録されていたため飛ばしました。` : '';
      notify(`${res.events.length}人の${slotLabel(slot)}を記録しました。保護者が見られる状態です。${skipped}`);
    });
  };
  /** 区分を替える。仮に入れていれば、捨ててよいかを確かめる */
  const chooseSlot = (next: MealSlot) => {
    if (tentative && (next.kind !== slot.kind || next.round !== slot.round)) { setPendingSlot(next); return; }
    setSlot(next);
  };

  if (classes.loading) return <Loading />;
  if (classes.error) return <ErrorBox text={classes.error} />;
  if (!classes.data || classes.data.length === 0) {
    return <div><div className="page-head"><h1>連絡帳</h1></div><section className="card"><Empty text={TEXT.noClass} /></section></div>;
  }

  const rows = [...(data?.rows ?? [])];
  if (sort === 'home') rows.sort((a, b) => HOME_ORDER[a.home_state] - HOME_ORDER[b.home_state]);
  // 園からを送っていない園児を上に（欠席は未送信に数えない。詳細設計書 (2-2 (2))）
  const unsent = (r: ContactClassRow) => !r.facility && r.exclusion?.reason !== '1';
  if (sort === 'facility') rows.sort((a, b) => Number(unsent(b)) - Number(unsent(a)));
  const isToday = date === today();
  const canRecord = isToday && !!data?.can_write;
  // おやつを2回出す園のために、その日におやつの記録が1人でもあれば「おやつ（2回目）」を足す（決めたこと D-5）
  const hasSnack = rows.some((r) => r.events.some((e) => e.event_type === '1' && e.meal_kind === '2'));
  const slots: MealSlot[] = [{ kind: '1', round: 1 }, { kind: '2', round: 1 }, ...(hasSnack ? [{ kind: '2', round: 2 } as MealSlot] : [])];
  const tentativeCount = tentative ? [...tentative.values()].filter((v) => v !== 'off').length : 0;
  const choices = toiletChoices();
  // 選択肢が5つを超える園では、よく使う3つを並べて残りを「ほか」にまとめる（詳細設計書 (2-2 (5))）
  const [shownChoices, moreChoices] = choices.length > 5 ? [choices.slice(0, 3), choices.slice(3)] : [choices, []];
  const openFix = (row: ContactClassRow, e: ContactEvent) =>
    setFix({ target: { kind: 'event', event: e, childName: row.child.child_name }, normal: row.child.normal_temperature });

  return (
    <div className="contact-class">
      <div className="page-head contact-class-head">
        <h1>連絡帳</h1>
        <label className="contact-inline-field">
          <span>クラス</span>
          <select value={classId} onChange={(e) => go({ class: Number(e.target.value) })}>
            {classes.data.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
          </select>
        </label>
        <nav className="contact-date" aria-label="連絡帳の日付">
          <button type="button" onClick={() => go({ date: addDays(date, -1) })}>‹ 前の日</button>
          <strong>{dayLabel(date)}</strong>
          <button type="button" onClick={() => go({ date: addDays(date, 1) })} disabled={isToday}>次の日 ›</button>
          {!isToday && <button type="button" onClick={() => go({ date: today() })}>今日</button>}
        </nav>
        <label className="contact-inline-field">
          <span>並べ方</span>
          <select value={sort} onChange={(e) => go({ sort: e.target.value })}>
            <option value="kana">よみの順</option>
            <option value="home">家庭からの未確認を上に</option>
            <option value="facility">園からを送っていない園児を上に</option>
          </select>
        </label>
      </div>

      {!isToday && (
        <Alert soft>{TEXT.pastDayPage}{user?.role === '1' && ' 直す・取り消すは各園児のページから行えます。'}</Alert>
      )}
      {error && <div className="contact-class-error" role="alert"><Alert>{error}</Alert></div>}
      {!reachable && <p className="muted">サーバにつながると、もう一度押せます。</p>}
      {view.loading && <Loading />}
      {view.error && <ErrorBox text={view.error} />}
      {data && (
        <>
          <p className="muted">
            {data.class_name}：家庭 {data.family_count}
            {data.unregistered_count > 0 && `（まだ登録していない ${data.unregistered_count} 家庭は、登録すると読めます）`}
            {!data.can_write && '。このクラスは読むだけです'}
          </p>
          {canRecord && rows.length > 0 && (
            <section className="contact-meal-bar" aria-label="食事を記録する">
              <div className="contact-picks" role="group" aria-label="食事の区分">
                {slots.map((s) => (
                  <button key={`${s.kind}-${s.round}`} type="button" className="contact-pick"
                    aria-pressed={s.kind === slot.kind && s.round === slot.round} onClick={() => chooseSlot(s)}>{slotLabel(s)}</button>
                ))}
              </div>
              {!tentative ? (
                <button type="button" onClick={fillAll} disabled={busyKey !== null}>全員ぜんぶ</button>
              ) : (
                <>
                  <p className="contact-meal-tentative" role="status">{TEXT.mealTentative(tentativeCount)}</p>
                  <button type="button" className="btn-primary" onClick={saveTentative} disabled={busyKey !== null} aria-busy={busyKey === 'meal-all'}>
                    {busyKey === 'meal-all' ? TEXT.sending : failed && !reachable ? TEXT.resend : '記録する'}
                  </button>
                  <button type="button" onClick={() => setTentative(null)} disabled={busyKey !== null}>やめる</button>
                </>
              )}
              {pendingSlot && (
                <div className="contact-meal-confirm" role="alertdialog" aria-label="仮に入れた値を捨てるか">
                  <span>仮に入れた「ぜんぶ」は保存していません。捨てて{slotLabel(pendingSlot)}に切り替えますか。</span>
                  <button type="button" onClick={() => { setSlot(pendingSlot); setTentative(null); setPendingSlot(null); }}>捨てて切り替える</button>
                  <button type="button" onClick={() => setPendingSlot(null)}>戻る</button>
                </div>
              )}
            </section>
          )}
          {rows.length === 0 ? <Empty text={TEXT.noChildren} /> : (
            <div className="contact-table-wrap">
              <table className="list contact-class-table">
                <thead>
                  <tr>
                    <th ref={childColumn} scope="col" className="contact-col-child">園児</th>
                    <th scope="col" className="contact-col-home">家庭から</th>
                    <th scope="col" className="contact-col-meal">{slotLabel(slot)}</th>
                    <th scope="col" className="contact-col-toilet">排せつ</th>
                    <th scope="col" className="contact-col-temp">体温</th>
                    <th scope="col">午睡</th>
                    <th scope="col">ひとこと</th>
                    <th scope="col">園から</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const id = row.child.child_id;
                    const name = row.child.child_name;
                    const childPath = `/staff/contact/${encodeURIComponent(id)}${isToday ? '' : `?date=${date}`}`;
                    const nap = row.exclusion
                      ? `対象外（${row.exclusion.reason === '1' ? '欠席' : '午睡なし'}）`
                      : latestSleepText(row.sleeps.at(-1), isToday, 'staff');
                    const comments = row.events.filter((e) => e.event_type === '4' || e.event_type === '5').length;
                    const toilets = row.events.filter((e) => e.event_type === '2');
                    const temps = row.events.filter((e) => e.event_type === '3');
                    const lastToilet = toilets.at(-1);
                    const lastTemp = temps.at(-1);
                    const rowBusy = busyKey !== null;
                    // 見えている文字は、読み上げの名前にもそのまま入れる（WCAG 2.5.3。声で「未送信」と言って押せるように）
                    const toiletText = lastToilet ? `${toilets.length}回／${eventText(lastToilet)} ${formatHM(lastToilet.recorded_at)}` : '';
                    const tempText = lastTemp ? `${eventText(lastTemp)}（${formatHM(lastTemp.recorded_at)}）` : '';
                    const facilityText = row.facility ? `送った ${formatHM(row.facility.recorded_at)}`
                      : row.exclusion?.reason === '1' ? '欠席' : '未送信';
                    return (
                      <tr key={id}>
                        <th scope="row" className="contact-col-child"><Link to={childPath}>{name}</Link></th>
                        <td className="contact-col-home">
                          <HomeCell row={row} canConfirm={data.can_write} busy={busyKey === `home-${row.home?.contact_home_id}`}
                            onConfirm={() => confirm(row)} />
                        </td>
                        <td className="contact-col-meal">
                          <MealCell row={row} slot={slot} canRecord={canRecord} tentative={tentative?.get(id)} busy={rowBusy}
                            onRecord={(amount) => recordOne(row, `meal-${id}`, { child_id: id, event_type: '1', meal_kind: slot.kind, meal_amount: amount, meal_round: slot.round })}
                            onCorrect={(e, amount) => correctMeal(row, e, amount)} onFix={(e) => openFix(row, e)}
                            onTentative={(v) => setTentative((t) => new Map(t ?? []).set(id, v))} />
                        </td>
                        <td className="contact-col-toilet">
                          {canRecord && (
                            <div className="contact-picks is-toilet" role="group" aria-label={`${name}の排せつ`}>
                              {shownChoices.map((label) => (
                                <button key={label} type="button" className="contact-pick" disabled={rowBusy}
                                  aria-label={`${name}の排せつ ${label}`}
                                  onClick={() => recordOne(row, `toilet-${id}`, { child_id: id, event_type: '2', toilet_label: label })}>{label}</button>
                              ))}
                              {moreChoices.length > 0 && (
                                <select aria-label={`${name}の排せつ（ほか）`} value="" disabled={rowBusy}
                                  onChange={(e) => e.target.value && recordOne(row, `toilet-${id}`, { child_id: id, event_type: '2', toilet_label: e.target.value })}>
                                  <option value="">ほか</option>
                                  {moreChoices.map((label) => <option key={label} value={label}>{label}</option>)}
                                </select>
                              )}
                            </div>
                          )}
                          {lastToilet ? (
                            canRecord
                              ? <button type="button" className="btn-quiet contact-last" onClick={() => openFix(row, lastToilet)}
                                aria-label={`${name}の排せつ ${toiletText} を直す・取り消す`}>
                                {toiletText}</button>
                              : <span>{toiletText}</span>
                          ) : !canRecord && <span className="muted">―</span>}
                        </td>
                        <td className="contact-col-temp">
                          {lastTemp && (
                            canRecord
                              ? <button type="button" className="btn-quiet contact-last" onClick={() => openFix(row, lastTemp)}
                                aria-label={`${name}の体温 ${tempText} を直す・取り消す`}>
                                {tempText}</button>
                              : <span>{tempText}</span>
                          )}
                          {canRecord && (
                            <button type="button" className="contact-pick contact-temp-add" onClick={() => setTempFor(row)} disabled={rowBusy}
                              aria-label={`${name}の体温を記録する`}>＋体温</button>
                          )}
                          {!lastTemp && !canRecord && <span className="muted">―</span>}
                          {row.child.normal_temperature !== null && <div className="muted">平熱 {row.child.normal_temperature.toFixed(1)}</div>}
                        </td>
                        <td>{nap ? <Link to="/staff/nap">{nap}</Link> : <span className="muted">―</span>}</td>
                        <td className="num">
                          <Link to={childPath} aria-label={`${name}のひとこと・写真${comments > 0 ? ` ${comments} 件` : ''}`}>{comments > 0 ? `${comments} 件` : '―'}</Link>
                        </td>
                        {/* 園から：未送信・送った（時刻）。午睡で欠席にした子は「欠席」（未送信に数えない）。押すと連絡帳（園児）画面の園から */}
                        <td>
                          <Link to={`${childPath}#facility`} aria-label={`${name}の園から ${facilityText}`}>
                            {row.facility || row.exclusion?.reason === '1' ? facilityText : <span className="contact-unsent">{facilityText}</span>}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {tempFor && (
        <TemperaturePicker title={`${tempFor.child.child_name}の体温`} start={tempFor.child.normal_temperature}
          busy={busyKey !== null} error={null} onClose={() => setTempFor(null)}
          onSelect={(value) => {
            const row = tempFor;
            setTempFor(null);
            void recordOne(row, `temp-${row.child.child_id}`, { child_id: row.child.child_id, event_type: '3', temperature: value });
          }} />
      )}
      {fix && (
        <FixDialog target={fix.target} normalTemperature={fix.normal} onClose={() => setFix(null)}
          onDone={(message) => { setFix(null); notify(message); view.refresh(); }} />
      )}
    </div>
  );
}
