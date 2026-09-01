/*
 * 園児情報入力画面（管理者）
 * 典拠：図/画面詳細図.md「園児情報入力画面／園児情報確認画面（管理者）」(7-2)
 *
 * 登録・編集は入力→確認→確定の3段階とする。園児マスターの誤りは全機能へ波及するため。
 * 生年月日は月齢の算出の根拠であり、後から直すと過去の記録の月齢表示が変わる。
 * アレルギー・既往歴は要配慮個人情報として扱う。
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Field, Alert, Radios } from '../../components/ui';
import { SEX, PHOTO_CONSENT } from '../../api/codes';
import { today } from '../../api/util';
import type { Sex, PhotoConsentLevel } from '../../api/types';
import type { ChildInput } from '../../api/client';

export default function ChildInputScreen() {
  const { user } = useSession();
  const { childId } = useParams();
  const navigate = useNavigate();
  const mode: 'create' | 'edit' = childId ? 'edit' : 'create';
  const classesForUser = selectableClasses(user!);

  const existing = useAsync(async () => (childId ? api.getChild(user!, childId) : null), [childId]);
  const existingAllergies = useAsync(async () => (childId ? api.allergiesOf(childId) : []), [childId]);
  const existingHistories = useAsync(async () => (childId ? api.medicalHistoriesOf(childId) : []), [childId]);
  const existingClass = useAsync(async () => (childId ? api.classOf(childId) : null), [childId]);

  const [form, setForm] = useState<ChildInput>({
    child_id: '', child_name: '', child_name_kana: '', birth_date: '',
    sex: '1', normal_temperature: null, photo_consent_level: '2',
    class_id: classesForUser[0]?.class_id ?? 1,
    allergies: [], medical_histories: [],
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = existing.data;
    if (!c) return;
    setForm({
      child_id: c.child_id, child_name: c.child_name, child_name_kana: c.child_name_kana,
      birth_date: c.birth_date, sex: c.sex, normal_temperature: c.normal_temperature,
      photo_consent_level: c.photo_consent_level,
      class_id: existingClass.data ?? classesForUser[0]?.class_id ?? 1,
      allergies: (existingAllergies.data ?? []).map((a) => ({
        target_food: a.target_food, symptom: a.symptom, response: a.response,
      })),
      medical_histories: (existingHistories.data ?? []).map((m) => m.content),
    });
  }, [existing.data?.child_id, existingClass.data, existingAllergies.data, existingHistories.data]);

  const set = <K extends keyof ChildInput>(k: K, v: ChildInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const next = () => {
    setError(null);
    if (!form.child_id.trim()) { setError('園児IDを入力してください'); return; }
    if (!form.child_name.trim()) { setError('氏名を入力してください'); return; }
    if (!form.birth_date) { setError('生年月日を入力してください'); return; }
    if (form.birth_date > today()) { setError('生年月日に未来日は指定できません'); return; }
    navigate('/staff/children/confirm', { state: { form, mode, before: existing.data } });
  };

  if (existing.loading) return <Loading />;
  if (existing.error) return <ErrorBox text={existing.error} />;

  return (
    <div style={{ maxWidth: 620 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/children">&lt; 園児一覧へ</Link>
        <h1>園児情報の{mode === 'create' ? '登録' : '編集'}</h1>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      <section className="card">
        <div className="stack">
          <Field label="園児ID" required>
            <input type="text" value={form.child_id} disabled={mode === 'edit'}
              onChange={(e) => set('child_id', e.target.value)} placeholder="C001" />
          </Field>
          <Field label="氏名" required>
            <input type="text" value={form.child_name} onChange={(e) => set('child_name', e.target.value)} />
          </Field>
          <Field label="よみ">
            <input type="text" value={form.child_name_kana} onChange={(e) => set('child_name_kana', e.target.value)} />
          </Field>
          <Field label="生年月日" required>
            <input type="date" value={form.birth_date} max={today()}
              onChange={(e) => set('birth_date', e.target.value)} />
          </Field>
          <Field label="性別" required>
            <Radios name="sex" value={form.sex}
              options={(Object.keys(SEX) as Sex[]).map((k) => ({ value: k, label: SEX[k] }))}
              onChange={(v) => set('sex', v)} />
          </Field>
          <div className="muted">
            性別は成長曲線の参照と帳票にのみ用います。未回答を選ぶと、成長グラフの基準値の帯を表示しません
            （基本設計書 5-3・5-7）。
          </div>
          <Field label="クラス" required>
            <select value={form.class_id} onChange={(e) => set('class_id', Number(e.target.value))}>
              {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
            </select>
          </Field>
          <Field label="平熱">
            <div className="row">
              <input type="number" step="0.1" style={{ maxWidth: 130 }}
                value={form.normal_temperature ?? ''}
                onChange={(e) => set('normal_temperature', e.target.value ? Number(e.target.value) : null)} />
              <span>℃</span>
              <span className="muted">午睡チェックで並べて表示します</span>
            </div>
          </Field>
          <Field label="写真の利用同意" required>
            <select value={form.photo_consent_level}
              onChange={(e) => set('photo_consent_level', e.target.value as PhotoConsentLevel)}>
              {Object.entries(PHOTO_CONSENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        </div>
      </section>

      {/* アレルギー・既往歴は要配慮個人情報として扱う（画面詳細図 7-2） */}
      <section className="card">
        <h2>アレルギー</h2>
        <div className="muted" style={{ marginBottom: 8 }}>要配慮個人情報です。参照できる範囲は権限で絞られます。</div>
        <div className="stack">
          {form.allergies.map((a, i) => (
            <div className="row" key={i}>
              <Field label="対象" style={{ flex: 1 }}>
                <input type="text" value={a.target_food} placeholder="卵"
                  onChange={(e) => set('allergies', form.allergies.map((x, j) => j === i ? { ...x, target_food: e.target.value } : x))} />
              </Field>
              <Field label="症状" style={{ flex: 1 }}>
                <input type="text" value={a.symptom} placeholder="発疹"
                  onChange={(e) => set('allergies', form.allergies.map((x, j) => j === i ? { ...x, symptom: e.target.value } : x))} />
              </Field>
              <Field label="対応" style={{ flex: 2 }}>
                <input type="text" value={a.response} placeholder="除去食"
                  onChange={(e) => set('allergies', form.allergies.map((x, j) => j === i ? { ...x, response: e.target.value } : x))} />
              </Field>
              <button className="btn-sm" onClick={() => set('allergies', form.allergies.filter((_, j) => j !== i))}>削除</button>
            </div>
          ))}
          <button onClick={() => set('allergies', [...form.allergies, { target_food: '', symptom: '', response: '' }])}>
            ＋ アレルギーを追加
          </button>
        </div>
      </section>

      <section className="card">
        <h2>既往歴</h2>
        <div className="stack">
          {form.medical_histories.map((m, i) => (
            <div className="row" key={i}>
              <input type="text" value={m} style={{ flex: 1 }}
                onChange={(e) => set('medical_histories', form.medical_histories.map((x, j) => j === i ? e.target.value : x))} />
              <button className="btn-sm" onClick={() => set('medical_histories', form.medical_histories.filter((_, j) => j !== i))}>削除</button>
            </div>
          ))}
          <button onClick={() => set('medical_histories', [...form.medical_histories, ''])}>＋ 既往歴を追加</button>
        </div>
      </section>

      <div className="row-end">
        <button onClick={() => navigate('/staff/children')}>やめる</button>
        <button className="btn-primary" onClick={next}>確認へ進む</button>
      </div>
    </div>
  );
}
