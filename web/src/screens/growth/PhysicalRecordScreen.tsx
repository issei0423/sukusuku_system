/*
 * 身体記録画面
 * 典拠：図/画面詳細図.md「身体記録画面」(6-2)
 *
 * クラスの実施状況を上部に置き、未実施の園児名を出す。誰が残っているかを数えさせないため。
 * 園児を選ぶと右側だけが入れ替わる。確認画面を挟まず連続して入力できる。
 * 免責はグラフの直下に固定する。
 * PDF出力は管理者のみ。出力種別に既定値を置かず、毎回選ばせる。
 */
import { useEffect, useState } from 'react';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses, settingNumber, staffName } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Disclaimer, Modal, Radios } from '../../components/ui';
import GrowthChart from '../../components/GrowthChart';
import { formatAge, formatYMD, today } from '../../api/util';

const DISCLAIMER = '本グラフは発育の判定・診断を行うものではありません。';

export default function PhysicalRecordScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);
  const [classId, setClassId] = useState<number>(user!.class_id ?? classesForUser[0]?.class_id ?? 1);
  const [measuredOn, setMeasuredOn] = useState(today());
  const [tick, setTick] = useState(0);

  const status = useAsync(() => api.classStatus(user!, classId, measuredOn), [classId, measuredOn, tick]);
  const [childId, setChildId] = useState<string | null>(null);

  useEffect(() => {
    const t = status.data?.target ?? [];
    if (t.length > 0 && (!childId || !t.some((c) => c.child_id === childId))) setChildId(t[0].child_id);
  }, [status.data]);

  const child = status.data?.target.find((c) => c.child_id === childId) ?? null;
  const records = useAsync(async () => (childId ? api.recordsOf(user!, childId) : []), [childId, tick]);
  const [measureType, setMeasureType] = useState<'1' | '2'>('1');
  const standards = useAsync(
    async () => (child ? api.growthBand(child.sex, measureType) : null),
    [child?.child_id, measureType],
  );

  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [warned, setWarned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [purpose, setPurpose] = useState<'internal' | 'guardian' | null>(null);

  // 園児を切り替えたら、その日の記録があれば読み込む
  useEffect(() => {
    const existing = records.data?.find((r) => r.measured_on === measuredOn);
    setHeight(existing ? String(existing.height_cm) : '');
    setWeight(existing ? String(existing.weight_kg) : '');
    setWarned(false);
    setError(null);
  }, [childId, measuredOn, records.data]);

  const previous = records.data?.filter((r) => r.measured_on < measuredOn)[0] ?? null;
  const warning = api.rangeWarning(Number(height), Number(weight));

  const save = async () => {
    if (!childId) return;
    // 範囲外は確認を求めるが、記録自体は妨げない
    if (warning && !warned) { setWarned(true); return; }
    setBusy(true); setError(null);
    try {
      await api.save(user!, {
        child_id: childId, measured_on: measuredOn,
        height_cm: Number(height), weight_kg: Number(weight),
      });
      setTick((n) => n + 1);
      setWarned(false);
      // 連続入力を助けるため、未実施の次の園児へ自動で進む
      const pending = status.data?.pending.filter((c) => c.child_id !== childId) ?? [];
      if (pending.length > 0) setChildId(pending[0].child_id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const exportPdf = async () => {
    if (!childId || !purpose) return;
    try {
      await api.exportPdf(user!, childId, purpose);
      setPdfOpen(false);
      setPurpose(null);
      alert('PDF出力の操作を記録しました（モックのためファイルは生成しません）');
    } catch (e) { setError((e as Error).message); }
  };

  const historyLimit = settingNumber('paging.physical_history_count', 12);

  return (
    <div>
      <div className="page-head">
        <h1>身体記録</h1>
        <Field label="クラス">
          <select value={classId} onChange={(e) => setClassId(Number(e.target.value))}>
            {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
          </select>
        </Field>
        <Field label="測定日">
          <input type="date" value={measuredOn} max={today()} onChange={(e) => setMeasuredOn(e.target.value)} />
        </Field>
      </div>

      {/* クラスの実施状況。未実施の園児名を出す */}
      <section className="card card-sub">
        {status.loading && <Loading />}
        {status.error && <ErrorBox text={status.error} />}
        {status.data && (
          <>
            <div>
              対象 {status.data.target.length} 名 ／ 記録済み {status.data.done.length} 名 ／ 未実施 {status.data.pending.length} 名
            </div>
            {status.data.pending.length > 0 && (
              <div className="muted">未実施：{status.data.pending.map((c) => c.child_name).join('、')}</div>
            )}
          </>
        )}
      </section>

      <div className="split">
        {/* 園児の選択。選ぶと右側だけが入れ替わる */}
        <div className="picker">
          {status.data?.target.map((c) => {
            const done = status.data!.done.some((d) => d.child_id === c.child_id);
            return (
              <button key={c.child_id} className={c.child_id === childId ? 'current' : ''}
                onClick={() => setChildId(c.child_id)}>
                <span>{done ? '[x]' : '[ ]'}</span>
                <span>{c.child_name}</span>
                {done && <span className="done">済</span>}
              </button>
            );
          })}
          {status.data?.target.length === 0 && <Empty text="対象の園児がいません。" />}
        </div>

        <div>
          {!child && <Empty text="園児を選んでください。" />}
          {child && (
            <>
              <section className="card">
                <h2>{child.child_name}（{formatAge(child.birth_date, measuredOn)}）</h2>
                {error && <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div>}

                <div className="row">
                  <Field label="身長" required>
                    <div className="row">
                      <input type="number" step="0.1" value={height} style={{ maxWidth: 130 }}
                        onChange={(e) => { setHeight(e.target.value); setWarned(false); }} />
                      <span>cm</span>
                      <span className="muted">前回 {previous ? previous.height_cm : '―'}</span>
                    </div>
                  </Field>
                  <Field label="体重" required>
                    <div className="row">
                      <input type="number" step="0.1" value={weight} style={{ maxWidth: 130 }}
                        onChange={(e) => { setWeight(e.target.value); setWarned(false); }} />
                      <span>kg</span>
                      <span className="muted">前回 {previous ? previous.weight_kg : '―'}</span>
                    </div>
                  </Field>
                </div>

                {/* 範囲外は注意喚起。もう一度押せば登録できる（判定ではないため） */}
                {warning && (
                  <div style={{ marginTop: 12 }}>
                    <Alert>{warning}</Alert>
                    {warned && <div className="muted" style={{ marginTop: 4 }}>
                      このまま登録する場合は、もう一度「登録する」を押してください。
                    </div>}
                  </div>
                )}

                <div className="row-end" style={{ marginTop: 12 }}>
                  <button className="btn-primary" onClick={save}
                    disabled={busy || !height || !weight}>
                    {warning && warned ? 'このまま登録する' : '登録する'}
                  </button>
                </div>
              </section>

              <section className="card">
                <div className="page-head">
                  <h2>成長グラフ</h2>
                  <div className="row">
                    <button className={measureType === '1' ? 'btn-primary btn-sm' : 'btn-sm'}
                      onClick={() => setMeasureType('1')}>身長</button>
                    <button className={measureType === '2' ? 'btn-primary btn-sm' : 'btn-sm'}
                      onClick={() => setMeasureType('2')}>体重</button>
                  </div>
                  <div className="spacer" />
                  {/* PDF出力は管理者のみ */}
                  {user!.role === '1' && (
                    <button className="btn-sm" onClick={() => { setPurpose(null); setPdfOpen(true); }}>PDF出力</button>
                  )}
                </div>

                <GrowthChart child={child} records={records.data ?? []}
                  standards={standards.data ?? null} measureType={measureType} />

                <div className="muted" style={{ marginTop: 8 }}>
                  背景の帯は 3〜97 パーセンタイルの分布です。破線は中央値です。
                  <br />
                  基準値は仮置きの値であり、実装時に厚生労働省の公表値へ差し替えます。
                </div>

                {/* 免責はグラフの直下に固定する（画面詳細図 6-2） */}
                <Disclaimer text={DISCLAIMER} />
              </section>

              <section className="card">
                <h2>過去の記録</h2>
                {records.data?.length === 0 && <Empty text="記録はありません。" />}
                {records.data && records.data.length > 0 && (
                  <table className="list">
                    <thead><tr><th scope="col">測定日</th><th scope="col">月齢</th><th scope="col">身長</th><th scope="col">体重</th><th scope="col">記録者</th></tr></thead>
                    <tbody>
                      {records.data.slice(0, historyLimit).map((r) => (
                        <tr key={r.physical_record_id}>
                          <td className="nowrap">{formatYMD(r.measured_on)}</td>
                          <td className="nowrap">{formatAge(child.birth_date, r.measured_on)}</td>
                          <td className="num">{r.height_cm}</td>
                          <td className="num">{r.weight_kg}</td>
                          <td className="nowrap">{staffName(r.staff_id)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {records.data && records.data.length > historyLimit && (
                  <div className="muted">直近 {historyLimit} 件を表示しています。</div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {pdfOpen && (
        <Modal title="PDF出力" onClose={() => setPdfOpen(false)}
          footer={<>
            <button onClick={() => setPdfOpen(false)}>やめる</button>
            <button className="btn-primary" onClick={exportPdf} disabled={!purpose}>出力する</button>
          </>}>
          {/* 出力種別に既定値を置かず、毎回選ばせる（画面詳細図 6-2） */}
          <Field label="出力の目的" required>
            <Radios name="purpose" value={purpose}
              options={[
                { value: 'internal', label: '園内利用' },
                { value: 'guardian', label: '保護者引き渡し' },
              ]}
              onChange={setPurpose} />
          </Field>
          <div className="muted" style={{ marginTop: 8 }}>
            出力の目的は操作ログに残ります。持ち出しの経緯を後から追えるようにするためです
            （基本設計書「監査への対応」(6-4)）。
          </div>
        </Modal>
      )}
    </div>
  );
}
