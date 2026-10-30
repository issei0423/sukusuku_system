/*
 * 連絡帳の月の一覧（保護者の連絡帳画面の中に出す）
 * 典拠：図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目4、詳細設計書「連絡帳画面（保護者）」(2-6 (6))
 *
 * 1か月を1画面とし、日ごとに「家庭から」「園から」の有無と、きょうのようすの件数を出す。日を押すとその日のページを出す。
 * 前の月・次の月へ移れる。参照できる範囲（連絡帳に記録のある最初の月から今月まで）の外の月へは移れない（GitHub Issue #268 の 4）。
 */
import { useState } from 'react';
import { api } from '../../api/client';
import { useSession } from '../../session';
import { useAsync } from '../../hooks';
import { ErrorBox, Loading } from '../../components/ui';
import { dayLabel } from './contactText';
import { CloseIcon, PrevIcon, ForwardIcon } from '../../components/icons';

/** 「2026-10」の前の月・次の月 */
const shiftMonth = (month: string, delta: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (month: string) => `${month.slice(0, 4)}年${Number(month.slice(5))}月`;

export default function MonthList({ childId, initialMonth, onPick, onClose }: {
  childId: string;
  initialMonth: string;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  const { user } = useSession();
  const [month, setMonth] = useState(initialMonth);
  const { data, error, loading } = useAsync(() => api.contactMonth(user!, childId, month), [user?.account_id, childId, month]);

  return (
    <section className="card contact-section contact-month" aria-labelledby="contact-month-title">
      <div className="row">
        <h2 id="contact-month-title">月の一覧</h2>
        <div className="spacer" />
        <button type="button" onClick={onClose}><CloseIcon />閉じる</button>
      </div>
      {loading && !data && <Loading />}
      {error && <ErrorBox text={error} />}
      {data && (
        <>
          <nav className="contact-date" aria-label="月の移動">
            <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} disabled={month <= data.from_month}><PrevIcon />前の月</button>
            <strong>{monthLabel(month)}</strong>
            <button type="button" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= data.to_month}>次の月<ForwardIcon /></button>
          </nav>
          <ul className="contact-month-days">
            {[...data.days].reverse().map((d) => (
              <li key={d.date}>
                <button type="button" onClick={() => onPick(d.date)}>
                  <strong>{dayLabel(d.date)}</strong>
                  {'　'}
                  {d.has_home || d.has_facility || d.record_count > 0 ? (
                    <span>
                      {d.has_home && '家庭から　'}
                      {d.has_facility && '園から　'}
                      {d.record_count > 0 && `ようす ${d.record_count}件`}
                    </span>
                  ) : <span className="muted">記録なし</span>}
                  {d.unread && <span className="tag tag-applied contact-new">新</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
