/*
 * 園児情報確認画面（管理者）
 * 典拠：図/画面詳細図.md「園児情報入力画面／園児情報確認画面（管理者）」(7-2)
 *
 * 生年月日は月齢の算出の根拠であり、後から直すと過去の記録の月齢表示が変わる。
 * 確認画面で強調する。
 *
 * 新規登録では、同じ氏名・生年月日の園児がいれば知らせる。園児IDは使われている番号の次が自動で入るため、
 * 同じ子を重ねて登録するまちがいは園児IDの重複では防げない（GitHub Issue #144 の 2）。
 * 【仮置き】知らせるだけで、登録は止めない。同じ氏名・生年月日の別の子もありうる
 * （web/仮置き値.md「同じ氏名・生年月日の園児の知らせ」）。
 */
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, className } from '../../api/client';
import { Alert, Empty } from '../../components/ui';
import { notify } from '../../components/feedback';
import { SEX, PHOTO_CONSENT, ENROLLMENT_STATUS } from '../../api/codes';
import { formatYMD, formatAge, today } from '../../api/util';
import type { ChildInput } from '../../api/client';
import type { Child } from '../../api/types';
import { BackIcon, SaveIcon } from '../../components/icons';

export default function ChildConfirmScreen() {
  const { user } = useSession();
  const navigate = useNavigate();
  const state = useLocation().state as { form: ChildInput; mode: 'create' | 'edit'; before: Child | null } | null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const same = useAsync(
    async () => (state?.mode === 'create'
      ? api.sameNameBirthChildren(user!, state.form.child_name, state.form.birth_date) : []),
    [state?.mode, state?.form.child_name, state?.form.birth_date],
  );
  // 「C001 西田 太郎」。在籍でない園児は「C001 西田 太郎・退園」のように状態を添える
  const sameChildren = (same.data ?? []).map((c) => `${c.child_id} ${c.child_name}`
    + (c.enrollment_status !== '1' ? `・${ENROLLMENT_STATUS[c.enrollment_status]}` : ''));

  if (!state) return <Empty text="確認する内容がありません。園児情報の入力画面から進んでください。" />;
  const { form, mode, before } = state;

  const birthChanged = mode === 'edit' && before && before.birth_date !== form.birth_date;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await api.saveChild(user!, form, mode);
      notify(mode === 'create' ? `登録しました。${form.child_name}さんの個人チャットも用意しました。` : `${form.child_name} の情報を更新しました`);
      navigate('/staff/children');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <div className="page-head"><h1>この内容で{mode === 'create' ? '登録' : '更新'}します</h1></div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      {/* 生年月日の変更は過去の記録の月齢表示に波及する。確認画面で強調する */}
      {birthChanged && (
        <div style={{ marginBottom: 16 }}>
          <Alert>
            生年月日を {formatYMD(before!.birth_date)} から {formatYMD(form.birth_date)} へ変更します。
            生年月日は月齢の算出の唯一の根拠です。変更すると、過去の記録の月齢表示もすべて変わります。
          </Alert>
        </div>
      )}

      {/* 新規登録でも、生年月日は月齢の算出の根拠なので確かめてもらう（図/画面詳細図 (7-2) 項目3「確認画面で強調する」。GitHub Issue #279） */}
      {mode === 'create' && (
        <div style={{ marginBottom: 16 }}>
          <Alert soft>
            生年月日は月齢の算出の根拠です。日付に誤りがないか確かめてください。登録したあとに直すと、過去の記録の月齢表示が変わります。
          </Alert>
        </div>
      )}

      {/* 同じ子を重ねて登録していないかを確かめてもらう。登録するボタンは止めない（GitHub Issue #144 の 2） */}
      {sameChildren.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Alert>
            同じ氏名・生年月日の園児がいます（{sameChildren.join('、')}）。同じ子を重ねて登録していないか確かめてください。
            別の子であれば、このまま登録できます。
          </Alert>
        </div>
      )}

      <section className="card">
        <table className="list">
          <tbody>
            <tr><th scope="col" style={{ width: 150 }}>園児ID</th><td>{form.child_id}</td></tr>
            <tr><th scope="col">氏名</th><td>{form.child_name}</td></tr>
            <tr><th scope="col">よみ</th><td>{form.child_name_kana || '―'}</td></tr>
            <tr><th scope="col">呼び名</th><td>{form.nickname || '―'}</td></tr>
            <tr>
              <th scope="col">生年月日</th>
              <td>
                <strong>{formatYMD(form.birth_date)}</strong>
                <span className="muted">（{formatAge(form.birth_date, today())}）</span>
              </td>
            </tr>
            <tr><th scope="col">性別</th><td>{SEX[form.sex]}</td></tr>
            <tr><th scope="col">クラス</th><td>{className(form.class_id)}</td></tr>
            <tr><th scope="col">平熱</th><td>{form.normal_temperature != null ? `${form.normal_temperature} ℃` : '―'}</td></tr>
            <tr><th scope="col">写真の利用同意</th><td>{PHOTO_CONSENT[form.photo_consent_level]}</td></tr>
            <tr>
              <th scope="col">アレルギー</th>
              <td>
                {form.allergies.filter((a) => a.target_food.trim()).length === 0 ? '―' : (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {form.allergies.filter((a) => a.target_food.trim()).map((a, i) => (
                      <li key={i}>{a.target_food}／{a.symptom || '―'}／{a.response || '―'}</li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
            <tr>
              <th scope="col">既往歴</th>
              <td>
                {form.medical_histories.filter((m) => m.trim()).length === 0 ? '―'
                  : form.medical_histories.filter((m) => m.trim()).join('／')}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <div className="row-end">
        {/* 入力していた内容を持って戻る。戻るたびに打ち直させない（GitHub Issue #120） */}
        <button disabled={busy}
          onClick={() => navigate(
            mode === 'create' ? '/staff/children/new' : `/staff/children/${form.child_id}/edit`,
            { state: { form }, replace: true },
          )}>
          <BackIcon />戻る
        </button>
        <button className="btn-primary" onClick={submit} disabled={busy}>
          <SaveIcon />{mode === 'create' ? '登録する' : '更新する'}
        </button>
      </div>
    </div>
  );
}
