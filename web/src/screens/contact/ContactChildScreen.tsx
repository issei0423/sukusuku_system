/*
 * 連絡帳（園児）画面（職員・タブレット横向き）
 * 典拠：詳細設計書「連絡帳（園児）画面」(2-3)、図/画面詳細図「連絡帳（園児）画面」(8-2)、
 *      基本設計書「連絡帳の閲覧（職員）」「排せつ・体温の記録」「取り消し・訂正」(4-5)
 *
 * 1人・1日の1ページを、保護者と同じ並び（家庭から → きょうのようす → 園から）で見る。
 * 職員だけの表示（家庭からを書いた続柄、確認した職員、記録した職員、訂正の有無、保護者に出さない設定の印）を足す。
 * 右の欄で、排せつ・体温・食事を足す（排せつは2タップ、体温は2タップ。時刻を後から付けるときは＋1）。
 * 記録の行の「直す・取り消す」は、その日はその園児のクラスの担任（記録した職員に限らない）、管理者はいつでも。
 * 午睡チェックを終えたあとの「ねた」「おきた」の直しもここで行う。
 * 前の日のページ・書けない職員（フリー）には、足す部品を出さず、その旨を示す。
 *
 * 活動のひとことと園からのひとことは段2：「送る」のすぐ上に宛先を大きく示し、サーバが他児の名前を照合する
 * （詳細設計書「園からのひとことを送る」(2-3 (3))）。園からは園児・日に1件。送ったあとは送った文と「直す」「取り消す」。
 */
import { useEffect, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { api, className, findChild } from '../../api/client';
import type { ContactEventInput, ContactPage, MealAmount } from '../../api/shapes';
import { useSession } from '../../session';
import { useAsync, AUTO_REFRESH_MS } from '../../hooks';
import { onContactChild } from '../../live';
import { addDays, formatHM, today } from '../../api/util';
import { Alert, ErrorBox, Loading } from '../../components/ui';
import { notify } from '../../components/feedback';
import { useReachable } from '../../api/reachability';
import ChildAvatar from '../../components/ChildAvatar';
import TemperaturePicker from '../../components/TemperaturePicker';
import { MEAL_AMOUNT_STAFF_TEXT, MEAL_KIND_TEXT, TEXT } from '../../messages';
import TodayTimeline from './TodayTimeline';
import type { TimelineFix } from './TodayTimeline';
import { dayLabel, eventText, homeLines } from './contactText';
import FixDialog, { cancelAction, timeOptions, toiletChoices } from './FixDialog';
import Composer from './Composer';
import type { FixTarget } from './FixDialog';

const HOME_STATE_TEXT = { unconfirmed: '未確認', revised: '更新', confirmed: '確認済み' } as const;

export default function ContactChildScreen() {
  const { childId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { user } = useSession();
  const date = params.get('date') ?? today();
  const [classId, setClassId] = useState<number | null>(null);
  const page = useAsync(async (): Promise<ContactPage> => {
    const p = await api.contactPage(user!, childId, date);
    setClassId(p.class_id);
    return p;
  }, [user?.account_id, childId, date], { refreshMs: AUTO_REFRESH_MS, live: onContactChild(childId, classId) });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [time, setTime] = useState('');
  const [mealKind, setMealKind] = useState<'1' | '2'>('1');
  const [tempOpen, setTempOpen] = useState(false);
  const [fix, setFix] = useState<{ target: FixTarget; mode: 'edit' | 'cancel' } | null>(null);
  const [editingFacility, setEditingFacility] = useState(false);
  const reachable = useReachable();
  // 連絡帳（クラス）画面の「園から」の列から来たときは、園からの欄を見せる
  const { hash } = useLocation();
  const loaded = !!page.data;
  useEffect(() => {
    if (loaded && hash === '#facility') document.getElementById('facility')?.scrollIntoView?.({ block: 'start' });
  }, [loaded, hash]);

  if (page.loading) return <Loading />;
  if (page.error) return <ErrorBox text={page.error} />;
  const data = page.data;
  if (!data) return null;
  const name = data.child_name;
  const isToday = date === today();
  const canRecord = isToday && !!data.can_write;
  // 直せるのは、その日はその園児のクラスの担任、管理者はいつでも（基本設計書「取り消し・訂正」(4-2)）
  const canFix = !!data.can_write && (isToday || user?.role === '1');
  const classPath = `/staff/contact${data.class_id ? `?class=${data.class_id}` : ''}${!isToday ? `${data.class_id ? '&' : '?'}date=${date}` : ''}`;
  const moveTo = (d: string) => { setError(null); setTime(''); setEditingFacility(false); setParams(d === today() ? {} : { date: d }); };
  const childClass = data.class_id ? className(data.class_id) : null;
  // 段2を送ったあとの文（基本設計書「メッセージ一覧」(4-12)）。保護者が未登録なら「登録すると読めます」
  const sentText = data.recipient && data.recipient.relationships.length === 0 ? TEXT.sentUnregistered : TEXT.sentToGuardian;

  /** 活動のひとことを送る（段2。POST /api/contact/events の種類 4） */
  const sendComment = async (body: string, acknowledged: string[]) => {
    const res = await api.recordEvents(user!, [{ child_id: childId, event_type: '4', body }], acknowledged);
    const saved = res.events[0];
    notify(`${name}さんへのひとこと：${sentText}`, saved ? cancelAction(user!, { kind: 'event', event: saved, childName: name }) : undefined);
    page.refresh();
  };
  /** 園からのひとことを送る・直す（段2。園児・日に1件） */
  const sendFacility = async (body: string, acknowledged: string[]) => {
    const f = data.facility;
    if (f && editingFacility) {
      await api.correctFacility(user!, f.contact_facility_id, { body, acknowledged_names: acknowledged, updated_at: f.updated_at ?? '' });
      setEditingFacility(false);
      notify(`${name}さんの園からを直しました。保護者の画面に「訂正しました」と出ます。`);
    } else {
      const saved = await api.sendFacility(user!, childId, body, acknowledged);
      notify(`${name}さんの園から：${sentText}`, cancelAction(user!, { kind: 'facility', facility: saved, childName: name }));
    }
    page.refresh();
  };

  const act = async (key: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(key); setError(null);
    try {
      await work();
      setFailed(false);
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      notify(message);
      setFailed(true);
    } finally {
      setBusy(null);
      page.refresh();
    }
  };

  /** 1件を記録する。排せつ・体温は「時刻を変える」で選んだ時刻を付ける（選んでいなければ今） */
  const record = (key: string, input: ContactEventInput) => act(key, async () => {
    const withTime = time && (input.event_type === '2' || input.event_type === '3') ? { ...input, recorded_at: `${date}T${time}:00` } : input;
    const res = await api.recordEvents(user!, [withTime]);
    const saved = res.events[0];
    if (!saved) {
      notify(`${name}さんの${MEAL_KIND_TEXT[mealKind]}は、すでに記録されていました。直すときは記録の行から直してください。`);
      return;
    }
    setTime('');
    notify(`${name}さんの「${eventText(saved)}」（${formatHM(saved.recorded_at)}）を記録しました。保護者が見られる状態です。`,
      cancelAction(user!, { kind: 'event', event: saved, childName: name }));
  });

  const confirmHome = () => {
    const h = data.home;
    if (!h) return;
    void act('home', async () => {
      await api.confirmHome(user!, h.contact_home_id, h.updated_at);
      notify(`${name}さんの家庭からを確認しました。保護者に「園が確認しました」と出ます。`);
    });
  };

  const openFix = (t: TimelineFix) => setFix({
    target: t.kind === 'event' ? { kind: 'event', event: t.event, childName: name } : { kind: 'sleep', sleep: t.sleep, childName: name, date },
    mode: 'edit',
  });
  const h = data.home;
  const homeState = !h ? null : h.confirmed_at ? 'confirmed' : h.revised_at ? 'revised' : 'unconfirmed';
  const label = (key: string, text: string) => (busy === key ? TEXT.sending : failed && !reachable ? TEXT.resend : text);

  return (
    <div className="contact-child">
      <div className="page-head contact-child-head">
        <Link className="contact-back" to={classPath}>‹ クラスへ戻る</Link>
        <div className="contact-child-name">
          <ChildAvatar name={name} size="lg" />
          <div>
            <h1>{name}</h1>
            <span className="muted">{data.class_id ? `${className(data.class_id)}・` : ''}連絡帳</span>
          </div>
        </div>
        <nav className="contact-date" aria-label="連絡帳の日付">
          <button type="button" onClick={() => moveTo(addDays(date, -1))}>‹ 前の日</button>
          <strong>{dayLabel(date)}</strong>
          <button type="button" onClick={() => moveTo(addDays(date, 1))} disabled={isToday}>次の日 ›</button>
          {!isToday && <button type="button" onClick={() => moveTo(today())}>今日</button>}
        </nav>
      </div>
      {error && <div role="alert"><Alert>{error}</Alert></div>}

      <div className="contact-child-body">
        <div className="contact-child-page">
          <section className="card contact-section" aria-labelledby="child-home-title">
            <h2 id="child-home-title">家庭から</h2>
            {!h ? <p className="empty">{TEXT.noHomeYet}</p> : (
              <div className={`contact-home-cell is-${homeState}`}>
                <p>
                  <span className={`tag ${homeState === 'confirmed' ? 'tag-approved' : 'tag-returned'}`}>{HOME_STATE_TEXT[homeState!]}</span>
                  {' '}{h.guardian_relationship || h.guardian_name}が {formatHM(h.submitted_at)} に送りました
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
                  : data.can_write && (
                    <button type="button" className="btn-primary contact-confirm-button" onClick={confirmHome} disabled={busy !== null}
                      aria-busy={busy === 'home'}>{busy === 'home' ? TEXT.sending : '確認しました'}</button>
                  )}
              </div>
            )}
          </section>

          <section className="card contact-section" aria-labelledby="child-today-title">
            <h2 id="child-today-title">{isToday ? 'きょうのようす' : 'この日のようす'}（朝から）</h2>
            <TodayTimeline page={data} viewer="staff" onFix={canFix ? openFix : undefined} />
            {!canFix && data.can_write && <p className="muted">{TEXT.fixAskAdmin}</p>}
          </section>

          <section className="card contact-section" id="facility" aria-labelledby="child-facility-title">
            <h2 id="child-facility-title">園から</h2>
            {data.facility && !editingFacility && (
              <>
                <p><span className="tag tag-approved">送った {formatHM(data.facility.recorded_at)} {data.facility.staff_name}</span>
                  {' '}{data.facility.body}{data.facility.corrected_at && <span className="muted">　訂正しました（{formatHM(data.facility.corrected_at)}）</span>}</p>
                {canFix && (
                  <div className="contact-composer-actions">
                    <button type="button" onClick={() => setEditingFacility(true)}>直す</button>
                    <button type="button" className="btn-quiet" onClick={() => setFix({ target: { kind: 'facility', facility: data.facility!, childName: name }, mode: 'cancel' })}>取り消す</button>
                  </div>
                )}
              </>
            )}
            {!data.facility && !canRecord && <p className="muted">{isToday ? '未送信' : 'この日の園からはありません'}</p>}
            {((!data.facility && canRecord) || (data.facility && editingFacility)) && (
              <Composer key={editingFacility ? `fix-${data.facility?.contact_facility_id}` : 'new'} label={editingFacility ? '園から（直して送る）' : '園からのひとこと'}
                max={500} scope="1" recipient={data.recipient} className={childClass} initial={editingFacility ? data.facility?.body : ''}
                submitLabel={editingFacility ? '直して送る' : '送る'} onSend={sendFacility}
                onCancel={editingFacility ? () => setEditingFacility(false) : undefined} />
            )}
          </section>
        </div>

        <aside className="card contact-child-record" aria-labelledby="child-record-title">
          <h2 id="child-record-title">記録する</h2>
          {!canRecord ? (
            <p className="muted">
              {!data.can_write ? 'この園児の連絡帳は読むだけです。記録はクラスの担任が行います。' : '前の日のページには記録を足せません。'}
            </p>
          ) : (
            <>
              <label className="contact-field">
                <span>時刻（排せつ・体温）</span>
                <select value={time} onChange={(e) => setTime(e.target.value)}>
                  <option value="">いま</option>
                  {timeOptions(date).reverse().map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <div className="contact-field">
                <span>排せつ</span>
                <div className="contact-picks is-toilet" role="group" aria-label="排せつ">
                  {toiletChoices().map((choice) => (
                    <button key={choice} type="button" className="contact-pick" disabled={busy !== null}
                      onClick={() => record('toilet', { child_id: childId, event_type: '2', toilet_label: choice })}>{choice}</button>
                  ))}
                </div>
              </div>
              <div className="contact-field">
                <span>体温</span>
                <button type="button" className="contact-pick" onClick={() => setTempOpen(true)} disabled={busy !== null}>
                  {label('temp', '体温を記録する')}
                </button>
              </div>
              <div className="contact-field">
                <span>食事（ふだんはクラスの画面で記録します）</span>
                <div className="contact-picks" role="group" aria-label="食事の区分">
                  {(['1', '2'] as const).map((k) => (
                    <button key={k} type="button" className="contact-pick" aria-pressed={mealKind === k} onClick={() => setMealKind(k)}>{MEAL_KIND_TEXT[k]}</button>
                  ))}
                </div>
                <div className="contact-picks is-meal" role="group" aria-label={`${MEAL_KIND_TEXT[mealKind]}の量`}>
                  {(['1', '2', '3', '4'] as const).map((v) => (
                    <button key={v} type="button" className="contact-pick" disabled={busy !== null}
                      onClick={() => record('meal', { child_id: childId, event_type: '1', meal_kind: mealKind, meal_amount: v as MealAmount,
                        // 記録の行が無ければ1回目、あれば次の回（おやつの2回目）として記録する
                        meal_round: data.events.some((e) => e.event_type === '1' && e.meal_kind === mealKind) && mealKind === '2' ? 2 : 1 })}>
                      {MEAL_AMOUNT_STAFF_TEXT[v]}
                    </button>
                  ))}
                </div>
              </div>
              <Composer label="活動のひとこと" max={200} scope="2" recipient={data.recipient} className={childClass}
                submitLabel="ひとことを送る" onSend={sendComment} />
            </>
          )}
        </aside>
      </div>

      {tempOpen && (
        <TemperaturePicker title={`${name}の体温`} start={findChild(childId)?.normal_temperature ?? null} busy={busy !== null} onClose={() => setTempOpen(false)}
          onSelect={(value) => { setTempOpen(false); void record('temp', { child_id: childId, event_type: '3', temperature: value }); }} />
      )}
      {fix && (
        <FixDialog target={fix.target} startMode={fix.mode} normalTemperature={findChild(childId)?.normal_temperature ?? null} onClose={() => setFix(null)} onDone={(message) => { setFix(null); notify(message); page.refresh(); }} />
      )}
    </div>
  );
}
