/*
 * 行事カレンダー画面（職員・タブレット／PC）
 * 典拠：設計書に定め無し。配布物の形に合わせた【仮置き】（web/仮置き値.md「行事カレンダーの動き」）
 *
 * 月の格子と、選んだ日の予定の一覧を出す。書けるのは、園全体は管理者だけ、クラスは管理者かそのクラスの一般職員。
 * 書ける人には「予定を足す」を出し、書ける予定には「直す」「消す」を出す（can_edit。判定はサーバ）。
 * 消すときは画面の中の確認を挟む。ほかの職員が足した・直した・消したときも、開いたままで読み直す（live.ts）。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Modal, Tag } from '../../components/ui';
import { ConfirmDialog, notify } from '../../components/feedback';
import MonthCalendar from '../../components/MonthCalendar';
import { dayLabel } from '../contact/contactText';
import { today } from '../../api/util';
import type { CalendarEvent } from '../../api/types';
import { BackIcon, AddIcon, EditIcon, DeleteIcon, CloseIcon, SaveIcon } from '../../components/icons';
import { EVENT_TITLE_MAX, EVENT_NOTE_MAX, eventTimeText, eventTargetText, countByDate } from './calendarText';

/** 入力の途中の値。対象は '' が園全体、それ以外はクラスの ID の文字 */
interface Form {
  eventId: number | null;
  date: string;
  start: string;
  end: string;
  title: string;
  note: string;
  target: string;
}

export default function StaffCalendarScreen() {
  const { user } = useSession();
  const [month, setMonth] = useState(today().slice(0, 7));
  const [selected, setSelected] = useState<string | null>(today());
  const [tick, setTick] = useState(0);
  // ほかの職員の足す・直す・消すも、開いたままで読み直す
  const { data, error: loadError, loading } = useAsync(() => api.calendarEvents(user!, month),
    [user?.account_id, month, tick], { live: onLive('calendar') });

  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<CalendarEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const writableIds = data?.writable_class_ids ?? [];
  const canWriteAll = data?.can_write_all ?? false;
  const canWrite = canWriteAll || writableIds.length > 0;
  // 対象の選択肢は、書ける範囲だけ。園全体は管理者のときだけ
  const targetClasses = selectableClasses(user!).filter((c) => writableIds.includes(c.class_id));

  const dayEvents = (data?.events ?? []).filter((e) => e.event_date === selected);

  const changeMonth = (m: string) => {
    setMonth(m);
    setSelected(m === today().slice(0, 7) ? today() : null);
  };

  const defaultTarget = () => (canWriteAll ? '' : String(targetClasses[0]?.class_id ?? ''));
  const openAdd = () => {
    setFormError(null);
    setForm({ eventId: null, date: selected ?? `${month}-01`, start: '', end: '', title: '', note: '', target: defaultTarget() });
  };
  const openEdit = (e: CalendarEvent) => {
    setFormError(null);
    setForm({
      eventId: e.event_id, date: e.event_date, start: e.start_time ?? '', end: e.end_time ?? '',
      title: e.title, note: e.note, target: e.class_id === null ? '' : String(e.class_id),
    });
  };

  const save = async () => {
    if (!form) return;
    setFormError(null);
    setBusy(true);
    const input = {
      event_date: form.date, start_time: form.start || null, end_time: form.end || null,
      title: form.title, note: form.note, class_id: form.target === '' ? null : Number(form.target),
    };
    try {
      if (form.eventId === null) await api.addCalendarEvent(user!, input);
      else await api.updateCalendarEvent(user!, form.eventId, input);
      // 足した・直した日を見せる
      setMonth(form.date.slice(0, 7));
      setSelected(form.date);
      setTick((n) => n + 1);
      notify(`「${form.title.trim()}」を${form.eventId === null ? '足しました' : '直しました'}`);
      setForm(null);
    } catch (e) { setFormError((e as Error).message); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!deleting) return;
    setError(null);
    try {
      await api.deleteCalendarEvent(user!, deleting.event_id);
      setTick((n) => n + 1);
      notify(`「${deleting.title}」を消しました`);
    } catch (e) { setError((e as Error).message); }
    setDeleting(null);
  };

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="adm cal-page">
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff"><BackIcon />ダッシュボードへ</Link>
        <h1>行事カレンダー</h1>
        <div className="spacer" />
        {canWrite && <button className="btn-primary" onClick={openAdd}><AddIcon />予定を足す</button>}
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}
      {loadError && <ErrorBox text={loadError} />}

      {/* 左に月の格子、右に選んだ日の予定。幅が足りないとき（900px 未満）は縦に重ねる */}
      <div className="cal-split">
      <section className="card cal-month">
        {loading && !data && <Loading />}
        <MonthCalendar month={month} selected={selected} today={today()}
          counts={countByDate(data?.events ?? [])} onMonthChange={changeMonth} onSelect={setSelected} />
      </section>

      <section className="card cal-day-panel" aria-labelledby="cal-day-title">
        <h2 id="cal-day-title">{selected ? `${dayLabel(selected)}の予定` : '予定'}</h2>
        {!selected && <Empty text="日を選ぶと、その日の予定が出ます。" />}
        {selected && data && dayEvents.length === 0 && <Empty text="この日の予定はありません。" />}
        {dayEvents.length > 0 && (
          <ul className="cal-events">
            {dayEvents.map((e) => (
              <li key={e.event_id} className="cal-event">
                <div className="cal-event-head">
                  <span className="cal-event-time">{eventTimeText(e)}</span>
                  <Tag label={eventTargetText(e)} />
                  <span className="cal-event-title">{e.title}</span>
                </div>
                {e.note && <p className="cal-event-note">{e.note}</p>}
                {e.can_edit && (
                  <div className="cal-event-actions">
                    <button className="btn-sm" onClick={() => openEdit(e)} aria-label={`「${e.title}」を直す`}><EditIcon />直す</button>
                    <button className="btn-sm btn-quiet btn-danger" onClick={() => setDeleting(e)} aria-label={`「${e.title}」を消す`}><DeleteIcon />消す</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      </div>

      <section className="note">
        <div className="muted">
          園の行事や予定を、月のカレンダーで見られます。保護者は、園全体の予定と、お子さまのクラスの予定を見られます。
          <br />
          園全体の予定は管理者が、クラスの予定は管理者とそのクラスの担任が書けます。
          {!canWrite && <><br />予定を書けるのは、管理者と担任の職員です。</>}
        </div>
      </section>

      {form && (
        <Modal title={form.eventId === null ? '予定を足す' : '予定を直す'} onClose={() => setForm(null)}
          footer={<>
            <button onClick={() => setForm(null)} disabled={busy}><CloseIcon />やめる</button>
            <button className="btn-primary" onClick={save} disabled={busy || !form.title.trim() || !form.date}>
              <SaveIcon />{form.eventId === null ? '足す' : '直す'}
            </button>
          </>}>
          <div className="stack">
            {formError && <Alert>{formError}</Alert>}
            <Field label="日付" required>
              <input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} style={{ maxWidth: 220 }} />
            </Field>
            <div className="cal-time-row">
              <Field label="開始の時刻">
                <input type="time" value={form.start} onChange={(e) => set({ start: e.target.value })} />
              </Field>
              <Field label="終了の時刻">
                <input type="time" value={form.end} onChange={(e) => set({ end: e.target.value })} />
              </Field>
            </div>
            <div className="muted">時刻を入れないと「終日」になります。</div>
            <Field label="題名" required>
              <input type="text" value={form.title} maxLength={EVENT_TITLE_MAX} placeholder="例：運動会" aria-label="題名"
                onChange={(e) => set({ title: e.target.value })} />
              <div className="muted">残り {EVENT_TITLE_MAX - [...form.title].length} 文字</div>
            </Field>
            <Field label="内容">
              <textarea value={form.note} rows={3} maxLength={EVENT_NOTE_MAX} placeholder="例：持ち物・集合の場所"
                onChange={(e) => set({ note: e.target.value })} />
            </Field>
            <Field label="対象" required>
              <select value={form.target} onChange={(e) => set({ target: e.target.value })}>
                {canWriteAll && <option value="">園全体</option>}
                {targetClasses.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
              </select>
            </Field>
            <Alert reach>
              {form.target === ''
                ? 'すべての保護者に表示されます。'
                : `${targetClasses.find((c) => String(c.class_id) === form.target)?.class_name ?? 'このクラス'} の保護者に表示されます。`}
            </Alert>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog title="予定を消す" confirmLabel="消す" confirmIcon={<DeleteIcon />} danger
          onConfirm={remove} onCancel={() => setDeleting(null)} returnWithin={['li', 'section']}>
          <div className="stack">
            <div>「{deleting.title}」（{dayLabel(deleting.event_date)}）を消します。</div>
            <div className="muted">保護者の画面からも消えます。</div>
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
