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
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api, selectableClasses, settingNumber, staffName } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Disclaimer, Modal, Radios } from '../../components/ui';
import { ConfirmDialog, notify } from '../../components/feedback';
import GrowthChart from '../../components/GrowthChart';
import { formatAge, formatYM, formatYMD, today } from '../../api/util';
import { SaveIcon, SelectedIcon, AddIcon, CloseIcon, PrintIcon } from '../../components/icons';

const DISCLAIMER = '本グラフは発育の判定・診断を行うものではありません。';

export default function PhysicalRecordScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);
  const [classId, setClassId] = useState<number>(user!.class_id ?? classesForUser[0]?.class_id ?? 1);
  const [measuredOn, setMeasuredOn] = useState(today());
  const [tick, setTick] = useState(0);

  /*
   * クラスの実施状況は、ほかの職員の登録があったら開いたままでも読み直す（live.ts）。
   * 園児ごとの記録（records）は入力欄の初期値に使うため、知らせでは読み直さない（入力中の値を動かさない）
   */
  const status = useAsync(() => api.classStatus(user!, classId, measuredOn), [classId, measuredOn, tick],
    { live: onLive('physical') });
  const [childId, setChildId] = useState<string | null>(null);

  useEffect(() => {
    const t = status.data?.target ?? [];
    if (t.length > 0 && (!childId || !t.some((c) => c.child_id === childId))) setChildId(t[0].child_id);
  }, [status.data]);

  const child = status.data?.target.find((c) => c.child_id === childId) ?? null;
  // どの園児の記録かを添えて持つ。園児を切り替えた直後は前の園児の記録が残っているため、入力欄の初期値の判断に使う
  const records = useAsync(
    async () => ({ childId, rows: childId ? await api.recordsOf(user!, childId) : [] }),
    [childId, tick],
  );
  const recordRows = records.data?.rows ?? [];
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
  // 開いている確認。範囲外の警告（warned）とは別に持ち、承諾も別に受け付ける
  const [confirming, setConfirming] = useState<'overwrite' | 'same_month' | null>(null);

  /*
   * 園児・測定日を切り替えたら、その日の記録があれば読み込む。
   * 読み直し（保存に失敗したあとなど）では、打ちかけの値を消さない。
   *
   * 入力欄は、その園児の記録（「この月は〜に記録済みです」など）を出すのと同じ描画の中で入れ替える。
   * useEffect で描画のあとに入れ替えると、記録は新しい園児・測定日のものを出しているのに、
   * 入力欄だけが前の値のまま、という描画が一度画面に出る。その間に打った値は、あとから走る
   * effect に消される（負荷の高いときに、身体記録の画面のテストで身長だけが空に戻って落ちた）
   */
  const formKey = childId ? `${childId}|${measuredOn}` : null;
  const [formFor, setFormFor] = useState<string | null>(null);
  if (formKey !== null && formFor !== formKey && !records.loading && records.data?.childId === childId) {
    setFormFor(formKey);
    const existing = records.data.rows.find((r) => r.measured_on === measuredOn);
    setHeight(existing ? String(existing.height_cm) : '');
    setWeight(existing ? String(existing.weight_kg) : '');
    setWarned(false);
    setError(null);
  }

  const previous = recordRows.filter((r) => r.measured_on < measuredOn)[0] ?? null;
  const warning = api.rangeWarning(Number(height), Number(weight));

  /*
   * 同じ測定日の記録（上書きになる）と、同じ年月の別の日の記録（同じ回の2件目になる）。
   * 測定回の単位は年月（基本設計書「身体測定の記録」(4-8)）
   */
  const sameDay = recordRows.find((r) => r.child_id === childId && r.measured_on === measuredOn) ?? null;
  const sameMonth = sameDay ? null : recordRows.find((r) => r.child_id === childId
    && r.measured_on.slice(0, 7) === measuredOn.slice(0, 7)) ?? null;

  /*
   * 登録する。範囲外の警告・上書きの確認・同じ月の記録の確認を、この順に1つずつ確かめる。
   * 確認の種類ごとに、対応する承諾だけを受け付ける。範囲外の警告と上書き確認を一括で承諾扱いにしない
   * （基本設計書「身体測定の記録」(4-8)。GitHub Issue #165）
   */
  const save = () => {
    if (!childId) return;
    // 範囲外は確認を求めるが、記録自体は妨げない
    if (warning && !warned) { setWarned(true); return; }
    if (sameDay) { setConfirming('overwrite'); return; }
    if (sameMonth) { setConfirming('same_month'); return; }
    void submit({});
  };

  const submit = async (approval: { confirm_overwrite?: boolean; confirm_same_month?: boolean }) => {
    if (!childId || !child) return;
    setConfirming(null);
    setBusy(true); setError(null);
    try {
      await api.save(user!, {
        child_id: childId, measured_on: measuredOn,
        height_cm: Number(height), weight_kg: Number(weight), ...approval,
      });
      // 登録完了を表示する。上書きしたときは、上書きしたことが分かるようにする（同 (4-8) 処理内容 5）。
      // 【仮置き】文言は設計が定めていない（web/仮置き値.md）
      notify(`${child.child_name}の測定値を${approval.confirm_overwrite ? '上書きしました' : '登録しました'}`);
      setTick((n) => n + 1);
      setWarned(false);
      // 連続入力を助けるため、未実施の次の園児へ自動で進む
      const pending = status.data?.pending.filter((c) => c.child_id !== childId) ?? [];
      if (pending.length > 0) setChildId(pending[0].child_id);
    } catch (e) {
      // ほかの職員が先に登録したときなどは、読み直して今の記録を出す。打ちかけの値は残す
      setError((e as Error).message);
      setTick((n) => n + 1);
    } finally { setBusy(false); }
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
                {sameDay && (
                  <div className="muted" style={{ marginBottom: 12 }}>
                    この測定日の記録は登録済みです。登録し直すときは、上書きの確認を出します。
                  </div>
                )}
                {sameMonth && (
                  <div className="muted" style={{ marginBottom: 12 }}>
                    この月は{formatYMD(sameMonth.measured_on)}に記録済みです（身長 {sameMonth.height_cm}cm・体重 {sameMonth.weight_kg}kg）。
                    測定回は年月で数えます。
                  </div>
                )}

                <div className="row">
                  <Field label="身長" required>
                    <div className="row">
                      <input type="number" step="0.1" value={height} style={{ maxWidth: 130 }}
                        aria-label="身長（cm）" aria-required="true"
                        onChange={(e) => { setHeight(e.target.value); setWarned(false); }} />
                      <span>cm</span>
                      <span className="muted">前回 {previous ? previous.height_cm : '―'}</span>
                    </div>
                  </Field>
                  <Field label="体重" required>
                    <div className="row">
                      <input type="number" step="0.01" value={weight} style={{ maxWidth: 130 }}
                        aria-label="体重（kg）" aria-required="true"
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
                    <SaveIcon />{warning && warned ? 'このまま登録する' : '登録する'}
                  </button>
                </div>
              </section>

              <section className="card">
                <div className="page-head">
                  <h2>成長グラフ</h2>
                  <div className="row">
                    {/* 【仮置き】選んでいる側は、塗りの色に加えて ✓ の印（SelectedIcon）と太字で示す（保護者の成長の記録画面と同じ。WCAG 1.4.1、GitHub Issue #211。web/仮置き値.md） */}
                    <button className={measureType === '1' ? 'measure-toggle btn-primary btn-sm' : 'measure-toggle btn-sm'} aria-pressed={measureType === '1'}
                      onClick={() => setMeasureType('1')}>{measureType === '1' && <SelectedIcon />}身長</button>
                    <button className={measureType === '2' ? 'measure-toggle btn-primary btn-sm' : 'measure-toggle btn-sm'} aria-pressed={measureType === '2'}
                      onClick={() => setMeasureType('2')}>{measureType === '2' && <SelectedIcon />}体重</button>
                  </div>
                  <div className="spacer" />
                  {/* PDF出力は管理者のみ */}
                  {user!.role === '1' && (
                    <button className="btn-sm" onClick={() => { setPurpose(null); setPdfOpen(true); }}>PDF出力</button>
                  )}
                </div>

                <GrowthChart child={child} records={recordRows}
                  standards={standards.data ?? null} measureType={measureType} />

                <div className="muted" style={{ marginTop: 8 }}>
                  背景の帯は 3〜97 パーセンタイルの分布です。破線は中央値です。
                  <br />
                  基準値は、厚生労働省「平成22年乳幼児身体発育調査」の公表値です。
                  2歳以上は6か月ごとの公表値を、月ごとに補間しています。
                </div>

                {/* 免責はグラフの直下に固定する（画面詳細図 6-2） */}
                <Disclaimer text={DISCLAIMER} />
              </section>

              <section className="card">
                <h2>過去の記録</h2>
                {records.data && recordRows.length === 0 && <Empty text="記録はありません。" />}
                {recordRows.length > 0 && (
                  <table className="list">
                    <thead><tr><th scope="col">測定日</th><th scope="col">月齢</th><th scope="col">身長</th><th scope="col">体重</th><th scope="col">記録者</th></tr></thead>
                    <tbody>
                      {recordRows.slice(0, historyLimit).map((r) => (
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
                {recordRows.length > historyLimit && (
                  <div className="muted">直近 {historyLimit} 件を表示しています。</div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {confirming === 'overwrite' && sameDay && (
        <ConfirmDialog title="上書きの確認" confirmLabel="上書きする" confirmIcon={<SaveIcon />} busy={busy}
          onConfirm={() => void submit({ confirm_overwrite: true })} onCancel={() => setConfirming(null)}>
          {/* 文言は基本設計書「メッセージ一覧」(4-9)「上書き確認」 */}
          <p>この測定日の記録は登録済みです。上書きしますか。</p>
          <p className="muted">
            {formatYMD(measuredOn)}：身長 {sameDay.height_cm}cm・体重 {sameDay.weight_kg}kg → 身長 {height}cm・体重 {weight}kg
          </p>
        </ConfirmDialog>
      )}
      {/* 【仮置き】同じ回（年月）の2件目を登録する前に確かめる（web/仮置き値.md、GitHub Issue #165） */}
      {confirming === 'same_month' && sameMonth && (
        <ConfirmDialog title="同じ月の記録があります" confirmLabel="別の記録として登録する" confirmIcon={<AddIcon />} busy={busy}
          onConfirm={() => void submit({ confirm_same_month: true })} onCancel={() => setConfirming(null)}>
          <p>
            {formatYM(measuredOn)}の記録は、{formatYMD(sameMonth.measured_on)}に登録済みです。
            {formatYMD(measuredOn)}の記録として、別に登録しますか。
          </p>
          <p className="muted">
            測定回は年月で数えます。同じ回の値を直すときは、測定日を{formatYMD(sameMonth.measured_on)}にしてから登録してください。
          </p>
        </ConfirmDialog>
      )}

      {pdfOpen && (
        <Modal title="PDF出力" onClose={() => setPdfOpen(false)}
          footer={<>
            <button onClick={() => setPdfOpen(false)}><CloseIcon />やめる</button>
            <button className="btn-primary" onClick={exportPdf} disabled={!purpose}><PrintIcon />出力する</button>
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
            出力の目的は操作ログに残ります。持ち出しの経緯を後から追えるようにするためです。
            {/* 出力の目的を操作ログに残す（基本設計書「監査への対応」(6-4)） */}
          </div>
        </Modal>
      )}
    </div>
  );
}
