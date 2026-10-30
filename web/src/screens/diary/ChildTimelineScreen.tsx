/*
 * 園児タイムライン画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)「特定の園児の過去の記録を時系列で表示」
 *
 * 日誌だけでなく、午睡・発達・身体測定の記録も同じ時間軸に並べる。
 * 「この子に何があったか」を1画面で追えるようにするため。
 *
 * 日付ごとに時刻・種別・要約を並べる（図/画面詳細図「園児タイムライン画面」(3-6) 項目6。GitHub Issue #278 の 6）。
 * 時刻は記録が対象とする時刻。午睡チェックは確認した時刻を出す。日誌と身体測定は記録日だけを持ち
 * 時刻が無いので「―」とする（【仮置き】web/仮置き値.md「園児タイムラインの時刻」）。同じ日の中は時刻の新しい順、時刻の無いものは最後
 */
import { Link, useParams } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, childName } from '../../api/client';
import { Loading, ErrorBox, Empty, Tag } from '../../components/ui';
import { DIARY_RECORD_TYPE, DIARY_STATUS, DIARY_STATUS_CLASS, BODY_POSITION } from '../../api/codes';
import { formatYMD, formatAge, formatHM, today } from '../../api/util';
import { BackIcon } from '../../components/icons';

type Entry =
  | { kind: 'diary'; date: string; time: string | null; label: string; status: string; statusClass: string; to: string; detail: string }
  | { kind: 'other'; date: string; time: string | null; label: string; detail: string };

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
    time: null,
    label: DIARY_RECORD_TYPE[d.record_type],
    status: DIARY_STATUS[d.status],
    statusClass: DIARY_STATUS_CLASS[d.status],
    to: `/staff/diary/${d.diary_id}`,
    detail: d.body.split('\n').filter((l) => l.trim() && !l.startsWith('【'))[0] ?? '',
  }));

  physical.data?.forEach((p) => entries.push({
    kind: 'other',
    date: p.measured_on,
    time: null,
    label: '身体測定',
    detail: `身長 ${p.height_cm} cm ／ 体重 ${p.weight_kg} kg`,
  }));

  // 午睡記録検索は、ねた・おきたの行も返す（画面詳細図「午睡記録検索画面」(5-3) の項目6）。ここは5分ごとの確認だけを並べる
  naps.data?.rows.filter((r) => r.child_id === childId && r.kind === 'check' && r.body_position).forEach((r) => entries.push({
    kind: 'other',
    date: r.session_date,
    time: formatHM(r.checked_at),
    label: '午睡チェック',
    detail: `${BODY_POSITION[r.body_position!]}${r.temperature ? ` ／ ${r.temperature}℃` : ''}`,
  }));

  // formatHM は「9:05」のように時を詰めるので、並べ替えでは桁をそろえる
  const sortKey = (t: string | null) => (t ? t.padStart(5, '0') : '');
  entries.sort((a, b) => b.date.localeCompare(a.date) || sortKey(b.time).localeCompare(sortKey(a.time)));

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/children"><BackIcon />園児一覧へ</Link>
        <h1>{c.child_name} の記録</h1>
        <div className="spacer" />
        <span className="muted">{formatAge(c.birth_date, today())}</span>
      </div>

      <section className="card">
        {entries.length === 0 && <Empty text="記録はまだありません。" />}
        {entries.length > 0 && (
          <table className="list">
            <thead><tr><th scope="col" style={{ width: 160 }}>日付</th><th scope="col" style={{ width: 80 }}>時刻</th><th scope="col" style={{ width: 120 }}>種別</th><th scope="col">内容</th><th scope="col">操作</th></tr></thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.date}-${i}`}>
                  <td className="nowrap">{formatYMD(e.date)}</td>
                  <td className="nowrap">{e.time ?? '―'}</td>
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
