/*
 * 連絡帳画面（保護者・スマートフォン）
 * 典拠：詳細設計書「連絡帳画面（保護者）」(2-6)、図/画面詳細図「連絡帳画面」(8-3)、基本設計書「連絡帳の閲覧（保護者）」(4-5)
 *
 * 本文は「家庭から」→「きょうのようす」→「園から」の順。上端に園児名と日付（前の日・次の日。次の日は今日まで）。
 * 園で記録されたものは、記録した時点で知らせ（contact）を受けて読み直す。
 * 開いたときに、そのページを開いた時刻を残す（POST .../read）。知らせを受けた読み直しでは残さない（決めたこと D-23）。
 *
 * 月の一覧は「月の一覧」で同じ画面の中に出す（MonthList.tsx。詳細設計書 (2-6 (6))）。園にたずねる・写真の表示は、それを作る段で足す（同 (7)）。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { ContactHomeInput } from '../../api/shapes';
import { useSession } from '../../session';
import { useAsync, AUTO_REFRESH_MS } from '../../hooks';
import { onContactChild } from '../../live';
import { addDays, formatHM, today } from '../../api/util';
import { ErrorBox, Loading } from '../../components/ui';
import { notify } from '../../components/feedback';
import { useStickyInset } from '../../stickyInset';
import { focusAfter, focusedNow } from '../../focusAfter';
import { TEXT } from '../../messages';
import HomeForm from './HomeForm';
import TodayTimeline from './TodayTimeline';
import MonthList from './MonthList';
import { dayLabel, homeLines } from './contactText';

export default function GuardianContactScreen() {
  const { childId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { user } = useSession();
  const date = params.get('date') ?? today();
  const [editing, setEditing] = useState(params.get('write') === '1');
  const [showMonth, setShowMonth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 知らせのクラス（クラスのようす）は、読んだページから分かる
  const [classId, setClassId] = useState<number | null>(null);
  const page = useAsync(() => api.contactPage(user!, childId, date), [user?.account_id, childId, date],
    { refreshMs: AUTO_REFRESH_MS, live: onContactChild(childId, classId) });
  const data = page.data;
  useEffect(() => { if (data) setClassId(data.class_id); }, [data]);
  /*
   * 上に止めた見出し（園児名と日付）の高さを、スクロールする枠（.guardian-main）へ --contact-head-h として渡す。
   * 枠はその高さぶんを scroll-padding-top に取り、キーボードで上へ戻ったとき・送ったあとの「直す」へ移ったときに、
   * フォーカスした部品が見出しの下に隠れないようにする（WCAG 2.4.11 フォーカスの非隠蔽、GitHub Issue #212）
   */
  const head = useStickyInset('.guardian-main', '--contact-head-h');
  const fixButton = useRef<HTMLButtonElement>(null);

  /*
   * 「新」の印は、この画面を開く前に読んだ時刻と比べる。開いた直後に開いた時刻を残すため、
   * 読み直しの応答の last_read_at は新しくなる。最初の値を持っておき、開いている間に届いたものにも印を残す
   */
  const firstRead = useRef<{ key: string; at: string | null } | null>(null);
  const key = `${childId}/${date}`;
  if (data && data.child_id === childId && data.contact_date === date && firstRead.current?.key !== key) {
    firstRead.current = { key, at: data.last_read_at ?? null };
  }
  useEffect(() => {
    if (!user || !data || data.child_id !== childId || data.contact_date !== date) return;
    void api.markContactRead(user, childId, date).catch(() => undefined);
    // 開いたとき・日付を移ったときに1回。知らせの読み直しでは呼ばない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.account_id, childId, date, !!data]);

  const moveTo = (d: string) => {
    setEditing(false); setError(null);
    setParams(d === today() ? {} : { date: d });
  };

  const save = async (input: ContactHomeInput) => {
    /*
     * 「家庭からを送る」は送っている間に押せなくなり、送ったあとは書く欄ごと消えて、フォーカスが外れる。
     * 送れたら送った内容の「直す」へ、送れなかったら（書く欄が残る）押したボタンへ移す（src/focusAfter.ts、WCAG 2.4.3、GitHub Issue #213）
     */
    const pressed = focusedNow();
    setBusy(true); setError(null);
    try {
      await api.saveHome(user!, childId, input);
      setEditing(false);
      notify(TEXT.homeSent);
      page.refresh();
      focusAfter(pressed, () => fixButton.current);
    } catch (e) {
      // 入力は残し、近くと結果の表示に出す。版が古ければ読み直す（詳細設計書「押したときの処理の型」(2-0 (2))）
      const message = (e as Error).message;
      setError(message);
      notify(message);
      page.refresh();
      focusAfter(pressed);
    } finally {
      setBusy(false);
    }
  };

  if (page.loading) return <Loading />;
  if (page.error) return <ErrorBox text={page.error} />;
  if (!data) return null;
  const h = data.home;
  const isToday = date === today();

  return (
    <div className="contact-page">
      <div ref={head} className="contact-page-head">
        <Link to="/guardian">‹ ホームへ</Link>
        <h1>{data.child_name}の連絡帳</h1>
        <nav className="contact-date" aria-label="連絡帳の日付">
          <button type="button" onClick={() => moveTo(addDays(date, -1))}>‹ 前の日</button>
          <strong>{dayLabel(date)}</strong>
          <button type="button" onClick={() => moveTo(addDays(date, 1))} disabled={isToday}>次の日 ›</button>
          <button type="button" aria-expanded={showMonth} onClick={() => setShowMonth((v) => !v)}>月の一覧</button>
        </nav>
      </div>

      {showMonth && (
        <MonthList childId={childId} initialMonth={date.slice(0, 7)} onClose={() => setShowMonth(false)}
          onPick={(d) => { setShowMonth(false); moveTo(d); }} />
      )}

      <section className="card contact-section" aria-labelledby="contact-home-title">
        <h2 id="contact-home-title">家庭から</h2>
        {h && !editing && (
          <div className="contact-home-summary">
            <p><strong>{formatHM(h.submitted_at)} 送りました</strong></p>
            <dl className="contact-home-lines">
              {homeLines(h).map((l) => <div key={l.label}><dt>{l.label}</dt><dd>{l.text}</dd></div>)}
            </dl>
            {/*
              職員の名前は出さない（詳細設計書「確認の状態の表示」(2-6 (4))）。
              園が確認して書き換わっても読み上げへ伝えない（相手の操作で読むのは3つだけ。詳細設計書 (2-0) の (6)、GitHub Issue #209）。
              送った結果は notify() で読む
            */}
            <p className={h.confirmed_at ? 'contact-confirmed' : 'contact-call'}>
              {h.confirmed_at ? `園が確認しました（${formatHM(h.confirmed_at)}）` : TEXT.callIfUrgent}
            </p>
            {data.can_write_home && <button ref={fixButton} type="button" className="contact-wide-button" onClick={() => { setError(null); setEditing(true); }}>直す</button>}
          </div>
        )}
        {!h && !editing && !data.can_write_home && <p className="empty">{TEXT.noHomeYet}</p>}
        {data.can_write_home && (editing || !h) && (
          <HomeForm home={h} busy={busy} error={error} onSubmit={save} onCancel={h ? () => { setEditing(false); setError(null); } : undefined} />
        )}
        {!isToday && <p className="muted">{TEXT.pastDayNoEdit}</p>}
      </section>

      <section className="card contact-section" aria-labelledby="contact-today-title">
        <h2 id="contact-today-title">{isToday ? 'きょうのようす' : 'この日のようす'}</h2>
        <TodayTimeline page={data} viewer="guardian" lastReadAt={firstRead.current?.at ?? null} />
      </section>

      <section className="card contact-section" aria-labelledby="contact-facility-title">
        <h2 id="contact-facility-title">園から</h2>
        {data.facility
          ? <p><time dateTime={data.facility.recorded_at}>{formatHM(data.facility.recorded_at)}</time>　{data.facility.body}
            {data.facility.corrected_at && <span className="muted">　訂正しました（{formatHM(data.facility.corrected_at)}）</span>}</p>
          : <p className="empty">まだ届いていません</p>}
      </section>
    </div>
  );
}
