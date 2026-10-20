/*
 * 連絡帳（クラス）画面（職員・タブレット横向き）
 * 典拠：詳細設計書「連絡帳（クラス）画面」(2-2)、図/画面詳細図「連絡帳（クラス）画面」(8-1)、
 *      基本設計書「家庭からの確認」(4-5)
 *
 * 行＝園児、列＝項目の表。園児名の列を左に止め、表の中だけを横に送る。
 * 家庭からは内容の全部をセルに出し、読んでから「確認しました」を押す（1タップ）。外す操作は持たない。
 * 午睡は表示だけ（記録は午睡チェック画面の行で行う）。食事・排せつ・体温・ひとこと・園からは、
 * それを記録する段で押せるようにする（本版は表示だけ。詳細設計書「実装の順番」(1-6) の 6・7）。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { ContactClassRow, ContactClassView, HomeState } from '../../api/shapes';
import { useSession } from '../../session';
import { useAsync, AUTO_REFRESH_MS } from '../../hooks';
import { onContactClass } from '../../live';
import { addDays, formatHM, today } from '../../api/util';
import { Alert, Empty, ErrorBox, Loading } from '../../components/ui';
import { notify } from '../../components/feedback';
import { useReachable } from '../../api/reachability';
import { TEXT } from '../../messages';
import { dayLabel, eventText, homeLines, latestSleepText } from './contactText';

const HOME_STATE_TEXT: Record<HomeState, string> = { none: 'まだ', unconfirmed: '未確認', revised: '更新', confirmed: '確認済み' };
/** sort=home の並び：「更新」「未確認」「まだ」「確認済み」（詳細設計書 (2-2 (2))） */
const HOME_ORDER: Record<HomeState, number> = { revised: 0, unconfirmed: 1, none: 2, confirmed: 3 };

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

function summary(row: ContactClassRow, type: '1' | '2' | '3'): string {
  const list = row.events.filter((e) => e.event_type === type);
  if (list.length === 0) return '―';
  const last = list[list.length - 1];
  if (type === '2') return `${list.length}回／${eventText(last)} ${formatHM(last.recorded_at)}`;
  return `${eventText(last)}（${formatHM(last.recorded_at)}）`;
}

export default function ContactClassScreen() {
  const { user } = useSession();
  const [params, setParams] = useSearchParams();
  const classes = useAsync(() => api.contactClasses(user!), [user?.account_id]);
  const classId = Number(params.get('class') ?? user?.class_id ?? classes.data?.[0]?.class_id ?? 0);
  const date = params.get('date') ?? today();
  const sort = params.get('sort') === 'home' ? 'home' : 'kana';
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reachable = useReachable();
  // 知らせは、このクラスか、このクラスの園児のものだけで読み直す（詳細設計書「画面ごとの読み直し」(6-5)）
  const childIds = useRef<string[]>([]);
  const view = useAsync(async (): Promise<ContactClassView | null> => (classId ? api.contactClass(user!, classId, date) : null),
    [user?.account_id, classId, date], { refreshMs: AUTO_REFRESH_MS, live: (e) => onContactClass(classId, childIds.current)(e) });
  const data = view.data;
  useEffect(() => { childIds.current = data?.rows.map((r) => r.child.child_id) ?? []; }, [data]);

  const go = (next: { class?: number; date?: string; sort?: string }) => {
    const p: Record<string, string> = {};
    const c = next.class ?? classId;
    const d = next.date ?? date;
    const s = next.sort ?? sort;
    if (c) p.class = String(c);
    if (d !== today()) p.date = d;
    if (s === 'home') p.sort = 'home';
    setError(null);
    setParams(p);
  };

  const confirm = async (row: ContactClassRow) => {
    if (!row.home || busyId !== null) return;
    setBusyId(row.home.contact_home_id); setError(null);
    try {
      await api.confirmHome(user!, row.home.contact_home_id, row.home.updated_at);
      notify(`${row.child.child_name}さんの家庭からを確認しました。保護者に「園が確認しました」と出ます。`);
    } catch (e) {
      // 読んだあとに保護者が直していたら 409。読み直して、新しい内容を読んでから押してもらう
      setError(`${row.child.child_name}さん：${(e as Error).message}`);
    } finally {
      setBusyId(null);
      view.refresh();
    }
  };

  if (classes.loading) return <Loading />;
  if (classes.error) return <ErrorBox text={classes.error} />;
  if (!classes.data || classes.data.length === 0) {
    return <div><div className="page-head"><h1>連絡帳</h1></div><section className="card"><Empty text={TEXT.noClass} /></section></div>;
  }

  const rows = [...(data?.rows ?? [])];
  if (sort === 'home') rows.sort((a, b) => HOME_ORDER[a.home_state] - HOME_ORDER[b.home_state]);
  const isToday = date === today();

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
          </select>
        </label>
      </div>

      {!isToday && <Alert soft>{TEXT.pastDayPage}</Alert>}
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
          {rows.length === 0 ? <Empty text={TEXT.noChildren} /> : (
            <div className="contact-table-wrap">
              <table className="list contact-class-table">
                <thead>
                  <tr>
                    <th scope="col" className="contact-col-child">園児</th>
                    <th scope="col" className="contact-col-home">家庭から</th>
                    <th scope="col">食事</th>
                    <th scope="col">排せつ</th>
                    <th scope="col">体温</th>
                    <th scope="col">午睡</th>
                    <th scope="col">ひとこと</th>
                    <th scope="col">園から</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const nap = row.exclusion
                      ? `対象外（${row.exclusion.reason === '1' ? '欠席' : '午睡なし'}）`
                      : latestSleepText(row.sleeps.at(-1), isToday, 'staff');
                    const comments = row.events.filter((e) => e.event_type === '4' || e.event_type === '5').length;
                    return (
                      <tr key={row.child.child_id}>
                        <th scope="row" className="contact-col-child">{row.child.child_name}</th>
                        <td className="contact-col-home">
                          <HomeCell row={row} canConfirm={data.can_write} busy={busyId === row.home?.contact_home_id}
                            onConfirm={() => confirm(row)} />
                        </td>
                        <td>{summary(row, '1')}</td>
                        <td>{summary(row, '2')}</td>
                        <td>{summary(row, '3')}{row.child.normal_temperature !== null && <div className="muted">平熱 {row.child.normal_temperature.toFixed(1)}</div>}</td>
                        <td>{nap ? <Link to="/staff/nap">{nap}</Link> : <span className="muted">―</span>}</td>
                        <td className="num">{comments > 0 ? `${comments} 件` : '―'}</td>
                        <td>{row.facility ? `送った ${formatHM(row.facility.recorded_at)}` : <span className="muted">未送信</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
