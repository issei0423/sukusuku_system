/*
 * 園児一覧画面
 * 典拠：図/画面詳細図.md「園児一覧画面」(7-1)
 *
 * 一般（保育士）は閲覧のみ。登録・編集・一括登録のボタンを表示しない。
 * アレルギーは一覧に出す。全園児が対象のアレルギー一覧画面とは別（同画面は印刷用）。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses, className } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Tag } from '../../components/ui';
import { formatYMD, formatAge, today } from '../../api/util';

export default function ChildListScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);
  const isAdmin = user!.role === '1';

  const [classId, setClassId] = useState<number | ''>(user!.role === '2' ? (user!.class_id ?? '') : '');
  const [name, setName] = useState('');
  const [applied, setApplied] = useState(0);

  const { data, error, loading } = useAsync(
    () => api.listChildren(user!, { classId: classId === '' ? undefined : classId, name }),
    [user?.account_id, applied],
  );

  return (
    <div>
      <div className="page-head">
        <h1>園児</h1>
        <div className="spacer" />
        <Link className="btn btn-sm" to="/staff/children/allergies">アレルギー一覧</Link>
        {/* 登録・編集・一括登録は管理者のみ */}
        {isAdmin && <Link className="btn btn-sm" to="/staff/children/new">新規登録</Link>}
        {isAdmin && <Link className="btn btn-sm" to="/staff/children/csv">CSV一括登録</Link>}
      </div>

      <section className="card">
        <div className="filterbar">
          <Field label="クラス">
            <select value={classId} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : '')}
              disabled={user!.role === '2'}>
              {user!.role !== '2' && <option value="">すべて</option>}
              {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
            </select>
          </Field>
          <Field label="氏名">
            <input type="search" value={name} onChange={(e) => setName(e.target.value)} placeholder="氏名・かな" />
          </Field>
          <button onClick={() => setApplied((n) => n + 1)}>絞り込む</button>
        </div>
      </section>

      <section className="card">
        {loading && <Loading />}
        {error && <ErrorBox text={error} />}
        {data?.length === 0 && <Empty text="該当する園児はいません。" />}
        {data && data.length > 0 && (
          <table className="list">
            <thead>
              <tr><th scope="col">氏名</th><th scope="col">よみ</th><th scope="col">生年月日</th><th scope="col">月齢</th><th scope="col">クラス</th><th scope="col">アレルギー</th><th scope="col">操作</th></tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.child_id}>
                  <td className="nowrap">{c.child_name}</td>
                  <td className="nowrap muted">{c.child_name_kana}</td>
                  <td className="nowrap">{formatYMD(c.birth_date)}</td>
                  <td className="nowrap">{formatAge(c.birth_date, today())}</td>
                  <td className="nowrap"><ClassCell childId={c.child_id} /></td>
                  <td><AllergyCell childId={c.child_id} /></td>
                  <td className="nowrap">
                    <Link className="btn btn-sm" to={`/staff/diary/timeline/${c.child_id}`}>記録</Link>
                    {isAdmin && <Link className="btn btn-sm" to={`/staff/children/${c.child_id}/edit`}>編集</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* ページングなし。1クラス最大30名程度で、連続入力の作業性を優先する（基本設計書 3-7） */}
        {data && data.length > 0 && <div className="muted" style={{ marginTop: 8 }}>全 {data.length} 名</div>}
      </section>

      {!isAdmin && (
        <section className="card card-sub">
          <div className="muted">園児情報の登録・編集は管理者が行います。</div>
        </section>
      )}
    </div>
  );
}

function ClassCell({ childId }: { childId: string }) {
  const { user } = useSession();
  const c = useAsync(() => api.classOf(user!, childId), [childId]);
  return <>{c.data ? className(c.data) : '―'}</>;
}

function AllergyCell({ childId }: { childId: string }) {
  const { user } = useSession();
  const a = useAsync(() => api.allergiesOf(user!, childId), [childId]);
  if (!a.data || a.data.length === 0) return <span className="muted">―</span>;
  return (
    <>
      {a.data.map((x) => <Tag key={x.allergy_id} label={x.target_food} className="tag-returned" />)}
    </>
  );
}
