/*
 * スケジュール設定画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)「園児単位の推奨スケジュールの上書き」
 *      要件定義書「発達チェック」(4-5)
 *
 * チェック頻度は年齢・月齢に応じてシステムが提案するが、マスタデータで園が調整できる。
 * さらに園児単位の手動上書きに対応する。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Tag } from '../../components/ui';
import { ConfirmDialog, notify } from '../../components/feedback';
import { formatYMD, formatAge, today } from '../../api/util';
import { BackIcon } from '../../components/icons';

export default function DevScheduleScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);
  const [classId, setClassId] = useState<number>(classesForUser[0]?.class_id ?? 1);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [confirmingApply, setConfirmingApply] = useState(false);
  const [applying, setApplying] = useState(false);

  // ほかの職員の確定・ほかの管理者の予定日の変更があったら、開いたままでも読み直す（live.ts）
  const { data, error: loadError, loading } = useAsync(() => api.schedules(user!, classId), [classId, tick],
    { live: onLive('development') });

  const apply = async (childId: string, date: string, manual: boolean) => {
    setError(null);
    try {
      await api.setSchedule(user!, childId, date, manual);
      setEdits((e) => { const n = { ...e }; delete n[childId]; return n; });
      setTick((n) => n + 1);
    } catch (e) { setError((e as Error).message); }
  };

  /*
   * 予定の無い在籍園児に、推奨スケジュールを一括で当てる（基本設計書「推奨スケジュールの作り方」(4-9)
   * 「予定の無い在籍園児には、管理者が一括で規則を当てる操作を置く」。GitHub Issue #164 の 3）。
   * 【仮置き】すべてのクラスが対象。基準日は最後に確定した実施日、無ければ今日（web/仮置き値.md）
   */
  const applyRecommended = async () => {
    setError(null);
    setApplying(true);
    try {
      const { applied } = await api.applyRecommendedSchedules(user!);
      setConfirmingApply(false);
      notify(applied > 0 ? `${applied}名に予定日を当てました` : '予定日の無い園児はいませんでした');
      setTick((n) => n + 1);
    } catch (e) {
      setConfirmingApply(false);
      setError((e as Error).message);
    } finally { setApplying(false); }
  };

  return (
    <div style={{ maxWidth: 940 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/growth"><BackIcon />発達チェック一覧へ</Link>
        <h1>スケジュール設定</h1>
        <Field label="クラス">
          <select value={classId} onChange={(e) => setClassId(Number(e.target.value))}>
            {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
          </select>
        </Field>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      <section className="card">
        {loading && <Loading />}
        {loadError && <ErrorBox text={loadError} />}
        {data?.length === 0 && <Empty text="対象の園児がいません。" />}
        {data && data.length > 0 && (
          <table className="list">
            <thead>
              <tr>
                {/* 何の時点の月齢かを書く（GitHub Issue #124） */}
                <th scope="col">園児</th><th scope="col">月齢<span className="weak">（提案日の時点）</span></th><th scope="col">推奨間隔</th>
                <th scope="col">システムの提案</th><th scope="col">設定中の予定日</th><th scope="col">次回の予定日</th><th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => {
                /*
                 * 次回の予定日の初期値は、設定中の予定日。無ければシステムの提案（間隔から算出した日）。
                 * 「上書きする」は日付を変えるまで押せない（画面詳細図「スケジュール設定画面」(6-3) 項目5・8）。
                 * 予定の無い園児では、提案の日を初期値に出しながら空と比べていたため、初めから押せた（GitHub Issue #178 の 7）
                 */
                const initial = r.scheduledOn ?? r.suggested;
                const value = edits[r.child.child_id] ?? initial;
                const changed = value !== '' && value !== initial;
                return (
                  <tr key={r.child.child_id}>
                    <td className="nowrap">{r.child.child_name}</td>
                    <td className="nowrap">{formatAge(r.child.birth_date, r.suggested)}</td>
                    <td className="nowrap">{r.intervalDays ? `${r.intervalDays} 日` : '―'}</td>
                    <td className="nowrap muted">{formatYMD(r.suggested)}</td>
                    <td className="nowrap">
                      {r.scheduledOn ? formatYMD(r.scheduledOn) : '―'}
                      {r.isManualOverride && <> <Tag label="手動上書き" className="tag-applied" /></>}
                    </td>
                    <td className="nowrap">
                      <input type="date" value={value} min={today()} style={{ minWidth: 160 }}
                        aria-label={`${r.child.child_name}の次回の予定日`}
                        onChange={(e) => setEdits({ ...edits, [r.child.child_id]: e.target.value })} />
                    </td>
                    <td className="nowrap">
                      <button className="btn-sm" disabled={!changed}
                        onClick={() => apply(r.child.child_id, value, true)}>
                        上書きする
                      </button>
                      {r.isManualOverride && (
                        <button className="btn-sm btn-quiet"
                          onClick={() => apply(r.child.child_id, r.suggested, false)}>
                          提案に戻す
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card card-sub">
        <p style={{ marginTop: 0 }}>
          次回の予定日が無い園児には、推奨の間隔から予定日を当てられます。すべてのクラスの園児が対象です。
        </p>
        <button onClick={() => setConfirmingApply(true)}>予定の無い園児に推奨を当てる</button>
      </section>

      {confirmingApply && (
        <ConfirmDialog title="予定の無い園児に推奨を当てる" confirmLabel="当てる" busy={applying}
          onConfirm={applyRecommended} onCancel={() => setConfirmingApply(false)}>
          <p>
            すべてのクラスで、次回の予定日が無い在籍園児に、推奨の間隔から予定日を当てます。
            確定した発達チェックのある園児は最後の実施日から、無い園児は今日から数えます。
            あいだに健診の節目があれば、節目の日を予定日にします。
          </p>
          <p>予定日のある園児は変えません。</p>
        </ConfirmDialog>
      )}

      <section className="card card-sub">
        <div className="muted">
          推奨間隔は設定マスタ（m_development_frequency）から読んでいます。園の運用に合わせて変更できます。
          園児ごとの事情で予定をずらす場合は、この画面で手動上書きしてください。
          <br />
          スケジュールの上書きは、発達の遅速の判断とは無関係です。
        </div>
      </section>
    </div>
  );
}
