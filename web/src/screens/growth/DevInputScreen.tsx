/*
 * 発達チェック入力画面
 * 典拠：図/画面詳細図.md「発達チェック入力画面」(6-1)
 *
 * 免責表示を保存操作の直上に固定する。比較を見ながら入力する画面であり、
 * 判断と取り違えられやすいため。
 * 「未入力」と「未確認」は別の状態。未確認は結果として保持し、未入力はチェック漏れの対象となる。
 * 区分は月齢から自動で表示するが、項目はマスタから読む。園が調整できるため。
 */
import { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, staffName } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Disclaimer, Modal } from '../../components/ui';
import { DEVELOPMENT_RESULT } from '../../api/codes';
import { ageInMonths, formatAge, formatHM, formatYMD, today } from '../../api/util';
import type { DevelopmentResult } from '../../api/types';

const DISCLAIMER = '本機能は発達の判定・診断を行うものではありません。';

export default function DevInputScreen() {
  const { user } = useSession();
  const { childId } = useParams();
  const navigate = useNavigate();

  const [checkedOn, setCheckedOn] = useState(today());
  const child = useAsync(() => api.getChild(user!, childId!), [childId]);

  // 基準日は実施日。現在日ではない（基本設計書「月齢の算出」(4-8)）
  const ageM = child.data ? ageInMonths(child.data.birth_date, checkedOn) : 0;
  const category = api.categoryFor(ageM);

  const items = useAsync(() => api.itemsFor(ageM), [ageM]);
  const draft = useAsync(() => api.draftFor(childId!, checkedOn), [childId, checkedOn]);
  const previous = useAsync(() => api.previousCheck(childId!, checkedOn), [childId, checkedOn]);

  const [results, setResults] = useState<Record<number, DevelopmentResult | null>>({});
  const [note, setNote] = useState('');
  const [compare, setCompare] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const noteHintId = useId();

  // 下書きがあれば読み直す
  useEffect(() => {
    const d = draft.data;
    if (!d) { setResults({}); setNote(''); return; }
    const map: Record<number, DevelopmentResult | null> = {};
    d.results.filter((r) => r.development_item_id !== 0).forEach((r) => { map[r.development_item_id] = r.result; });
    setResults(map);
    // 所見はチェックの側が持つ。結果（項目単位）の側には無い
    setNote(d.check.note ?? '');
  }, [draft.data?.check.development_check_id, checkedOn]);

  const save = async (status: '1' | '2') => {
    setBusy(true); setError(null);
    try {
      await api.saveCheck(
        user!, childId!, checkedOn,
        (items.data ?? []).map((it) => ({
          development_item_id: it.development_item_id,
          result: results[it.development_item_id] ?? null,
        })),
        note, status,
      );
      navigate('/staff/growth');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (child.loading) return <Loading />;
  if (child.error) return <ErrorBox text={child.error} />;
  const c = child.data;
  if (!c) return null;

  // 領域ごとにまとめる
  const domains = Array.from(new Set((items.data ?? []).map((i) => i.domain)));
  const prevResults = previous.data?.results ?? [];
  const prevOf = (itemId: number) => prevResults.find((r) => r.development_item_id === itemId)?.result ?? null;

  const unfilled = (items.data ?? []).filter((it) => !results[it.development_item_id]).length;
  // 確定した記録は下書きに戻さない。直すときは「確定する」で保存する（GitHub Issue #164。web/仮置き値.md）
  const confirmed = draft.data?.check.status === '2';

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/growth">&lt; 発達チェック一覧へ</Link>
        <h1>{c.child_name}（{formatAge(c.birth_date, checkedOn)}）</h1>
        <div className="spacer" />
        <Field label="実施日">
          <input type="date" value={checkedOn} max={today()} onChange={(e) => setCheckedOn(e.target.value)} />
        </Field>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      <section className="card card-sub">
        <div>
          発達過程区分：<strong>{category?.category_name ?? '該当する区分がありません'}</strong>
          <span className="muted">（月齢 {ageM} か月・実施日を基準に算出）</span>
        </div>
      </section>

      {items.data?.length === 0 && <Empty text="この月齢に対応するチェック項目がマスタに登録されていません。" />}

      {domains.map((domain) => (
        <section className="card" key={domain}>
          <h2>{domain}</h2>
          {items.data!.filter((i) => i.domain === domain).map((it) => {
            const before = prevOf(it.development_item_id);
            const nowVal = results[it.development_item_id] ?? null;
            return (
              <div className="dev-item" key={it.development_item_id}>
                <div>
                  <div>{it.item_name}</div>
                  {/* 前回との比較。変化を示すだけで、良し悪しの判定はしない */}
                  {compare && before && (
                    <div className="dev-diff">
                      前回：{DEVELOPMENT_RESULT[before]}
                      {nowVal && nowVal !== before && <> → <span className="to">{DEVELOPMENT_RESULT[nowVal]}</span></>}
                    </div>
                  )}
                </div>
                <div className="choices" role="radiogroup" aria-label={it.item_name}>
                  {(Object.keys(DEVELOPMENT_RESULT) as DevelopmentResult[]).map((k) => (
                    <label key={k}>
                      <input type="radio" name={`item-${it.development_item_id}`}
                        checked={nowVal === k}
                        onChange={() => setResults({ ...results, [it.development_item_id]: k })} />
                      {DEVELOPMENT_RESULT[k]}
                    </label>
                  ))}
                  {nowVal && (
                    <button className="btn-sm btn-quiet"
                      onClick={() => setResults({ ...results, [it.development_item_id]: null })}>
                      未入力に戻す
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      ))}

      <section className="card">
        <Field label="所見">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-describedby={noteHintId}
            placeholder="気づいたことを記録してください（判定ではありません）" />
        </Field>
        {/*
          所見は園内限定であり、保護者へは共有しない（画面詳細図「発達チェック入力画面」(6-2) 項目6、
          基本設計書「発達チェック・身体測定」(5-7)）。書く前に分かるよう、欄に添える（GitHub Issue #178 の 8）。
          【仮置き】文言（web/仮置き値.md）
        */}
        <div className="muted" id={noteHintId} style={{ marginTop: 4 }}>
          所見は園内限定の記録です。保護者へは共有しません。
        </div>
        <label style={{ marginTop: 8 }}>
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          前回の記録と並べて表示する
        </label>
        {previous.data && (
          <div className="muted" style={{ marginTop: 4 }}>
            前回：{formatYMD(previous.data.check.checked_on)}
            （{formatAge(c.birth_date, previous.data.check.checked_on)}）
          </div>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          {/* 「未確認」は結果として残す状態で、チェック漏れの対象にしない（基本設計書「発達チェック・身体測定」(5-7)） */}
          未入力の項目：{unfilled} 件。未入力のままにするとチェック漏れの対象になります。
          確認できなかった項目は「未確認」を選んで残してください。
        </div>
      </section>

      {/* 免責表示を保存操作の直上に固定する（画面詳細図 6-1） */}
      <Disclaimer text={DISCLAIMER} />

      {/*
        確定したあとに開き直したとき、確定済みであることと、誰が・いつ確定したか、「確定する」で何が起きるかを示す
        （GitHub Issue #143）。記録は園児と実施日で1件であり、「確定する」は同じ記録を書き換える。
        確定の前に確かめるダイアログは、未入力が残るときだけ出す（基本設計書「画面の洗い出しの考え方」(3-1)。
        連続入力を前提とする発達チェックには、1件ごとの確認を挟まない）
      */}
      {confirmed && draft.data && (
        <div className="muted" style={{ marginTop: 12 }}>
          <div>
            この日の記録は確定しています（確定した職員：{staffName(draft.data.check.staff_id)}
            {draft.data.confirmedAt && (
              <>、確定した日時：{formatYMD(draft.data.confirmedAt.slice(0, 10))} {formatHM(draft.data.confirmedAt)}</>
            )}）。
          </div>
          <div>
            直すときは、内容を変えて「確定する」を押すと、この記録を書き換えます（新しい記録は増えません。下書きには戻せません）。
          </div>
        </div>
      )}
      <div className="row-end" style={{ marginTop: 12 }}>
        {!confirmed && <button onClick={() => save('1')} disabled={busy}>下書き保存</button>}
        {/* 未入力が残っているときは、確定の前に確かめる。確定そのものは妨げない */}
        <button className="btn-primary" disabled={busy}
          onClick={() => (unfilled > 0 ? setConfirming(true) : save('2'))}>確定する</button>
      </div>

      {confirming && (
        <Modal title="未入力の項目があります" onClose={() => setConfirming(false)}
          footer={<>
            <button onClick={() => setConfirming(false)} disabled={busy}>戻って入力する</button>
            <button className="btn-primary" disabled={busy}
              onClick={() => { setConfirming(false); save('2'); }}>このまま確定する</button>
          </>}>
          <div className="stack">
            <div>未入力の項目が {unfilled} 件あります。</div>
            <div className="muted">
              未入力のまま確定すると、チェック漏れとして一覧に表示されます。
              確認できなかった項目は「未確認」を選んで残してください。
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
