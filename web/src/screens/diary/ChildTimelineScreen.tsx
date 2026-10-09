/*
 * 園児タイムライン画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)「特定の園児の過去の記録を時系列で表示」
 *
 * 日誌だけでなく、午睡・発達・身体測定の記録も同じ時間軸に並べる。
 * 「この子に何があったか」を1画面で追えるようにするため。
 */
import { Link, useParams } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, childName } from '../../api/client';
import { Loading, ErrorBox, Empty, Tag } from '../../components/ui';
import { DIARY_RECORD_TYPE, DIARY_STATUS, DIARY_STATUS_CLASS, BODY_POSITION } from '../../api/codes';
import { formatYMD, formatAge, formatHM, today } from '../../api/util';

type Entry =
  | { kind: 'diary'; date: string; label: string; status: string; statusClass: string; to: string; detail: string }
  | { kind: 'other'; date: string; label: string; detail: string };

export default function ChildTimelineScreen() {
  const { user } = useSession();
  const { childId } = useParams();

  const child = useAsync(() => api.getChild(user!, childId!), [childId]);
  const diaries = useAsync(() => api.timelineOf(user!, childId!), [childId]);
  const physical = useAsync(() => api.recordsOf(user!, childId!), [childId]);
  const naps = useAsync(() => api.searchRecords(user!, { childName: undefined }), [childId]);

  if (child.loading) return <Loading />;
  if (child.error) return <ErrorBox text={child.error} />;
  const c = child.data;
  if (!c) return null;

  const entries: Entry[] = [];

  diaries.data?.forEach((d) => entries.push({
    kind: 'diary',
    date: d.diary_date,
    label: DIARY_RECORD_TYPE[d.record_type],
    status: DIARY_STATUS[d.status],
    statusClass: DIARY_STATUS_CLASS[d.status],
    to: `/staff/diary/${d.diary_id}`,
    detail: d.body.split('\n').filter((l) => l.trim() && !l.startsWith('【'))[0] ?? '',
  }));

  physical.data?.forEach((p) => entries.push({
    kind: 'other',
    date: p.measured_on,
    label: '身体測定',
    detail: `身長 ${p.height_cm} cm ／ 体重 ${p.weight_kg} kg`,
  }));

  naps.data?.rows.filter((r) => r.child_id === childId).forEach((r) => entries.push({
    kind: 'other',
    date: r.session_date,
    label: '午睡チェック',
    detail: `${formatHM(r.checked_at)} ${BODY_POSITION[r.body_position]}${r.temperature ? ` ／ ${r.temperature}℃` : ''}`,
  }));

  entries.sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/children">&lt; 園児一覧へ</Link>
        <h1>{c.child_name} の記録</h1>
        <div className="spacer" />
        <span className="muted">{formatAge(c.birth_date, today())}</span>
      </div>

      <section className="card">
        {entries.length === 0 && <Empty text="記録はまだありません。" />}
        {entries.length > 0 && (
          <table className="list">
            <thead><tr><th scope="col" style={{ width: 160 }}>日付</th><th scope="col" style={{ width: 120 }}>種別</th><th scope="col">内容</th><th scope="col">操作</th></tr></thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.date}-${i}`}>
                  <td className="nowrap">{formatYMD(e.date)}</td>
                  <td className="nowrap">
                    {e.label}
                    {e.kind === 'diary' && <> <Tag label={e.status} className={e.statusClass} /></>}
                  </td>
                  <td>{e.detail}</td>
                  <td className="nowrap">
                    {e.kind === 'diary' && <Link className="btn btn-sm" to={e.to}>開く</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          この画面は記録を時系列に並べて示すものであり、発達の遅速や健康状態の判定を行うものではありません
          （{childName(c.child_id)}の評価・判断は保育士と園が行います）。
        </div>
      </section>
    </div>
  );
}
