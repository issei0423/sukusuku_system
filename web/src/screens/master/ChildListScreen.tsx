/*
 * 園児一覧画面
 * 典拠：図/画面詳細図.md「園児一覧画面」(7-1)
 *
 * 一般（保育士）は閲覧のみ。登録・編集・一括登録のボタンを表示しない。
 * アレルギーは一覧に出す。全園児が対象のアレルギー一覧画面とは別（同画面は印刷用）。
 * 管理者にだけ、記録も保護者も紐づいていない園児の行に「取消」を出し、「退園した園児も出す」を置く（同 項目10・11。GitHub Issue #279）。
 * 担当クラスの無い一般（フリー）は全クラスを閲覧のみで見られるので、クラスは「すべて」から選べる。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses, className } from '../../api/client';
import { ConfirmDialog, notify } from '../../components/feedback';
import { ENROLLMENT_STATUS } from '../../api/codes';
import type { Child } from '../../api/types';
import { Loading, ErrorBox, Empty, Field, Tag } from '../../components/ui';
import { formatYMD, formatAge, today } from '../../api/util';
import { SearchIcon, UndoIcon } from '../../components/icons';

export default function ChildListScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);
  const isAdmin = user!.role === '1';
  // 一般は自クラスに固定。担当クラスの無い一般（フリー）は全クラスから選べる
  const fixedClass = user!.role === '2' && user!.class_id != null;

  const [classId, setClassId] = useState<number | ''>(fixedClass ? user!.class_id! : '');
  const [name, setName] = useState('');
  const [withdrawn, setWithdrawn] = useState(false);
  const [applied, setApplied] = useState(0);
  const [removing, setRemoving] = useState<Child | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const { data, error, loading } = useAsync(
    () => api.listChildren(user!, { classId: classId === '' ? undefined : classId, name, includeWithdrawn: isAdmin && withdrawn }),
    [user?.account_id, applied],
  );
  // 取り消せる園児（記録も保護者も紐づいていない）。管理者だけが読む
  const removable = useAsync(async () => (isAdmin ? api.removableChildren(user!) : []), [user?.account_id, applied]);
  const removableIds = new Set(removable.data ?? []);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await api.removeChild(user!, removing.child_id);
      notify(`${removing.child_name} の登録を取り消しました`);
      setRemoving(null);
      setApplied((n) => n + 1);
    } catch (e) {
      setRemoveError((e as Error).message);
    } finally { setBusy(false); }
  };

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
              disabled={fixedClass}>
              {!fixedClass && <option value="">すべて</option>}
              {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
            </select>
          </Field>
          <Field label="氏名">
            <input type="search" value={name} onChange={(e) => setName(e.target.value)} placeholder="氏名・かな" />
          </Field>
          {/* 管理者にだけ置く。退園した園児は職員の参照から外れ、管理者だけが読む（在籍へ戻すため） */}
          {isAdmin && (
            <label>
              <input type="checkbox" checked={withdrawn} onChange={(e) => setWithdrawn(e.target.checked)} />
              退園した園児も出す
            </label>
          )}
          <button onClick={() => setApplied((n) => n + 1)}><SearchIcon />絞り込む</button>
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
                  <td className="nowrap">
                    {c.child_name}
                    {c.enrollment_status !== '1' && <> <Tag label={ENROLLMENT_STATUS[c.enrollment_status]} /></>}
                  </td>
                  <td className="nowrap muted">{c.child_name_kana}</td>
                  <td className="nowrap">{formatYMD(c.birth_date)}</td>
                  <td className="nowrap">{formatAge(c.birth_date, today())}</td>
                  <td className="nowrap"><ClassCell childId={c.child_id} /></td>
                  <td><AllergyCell childId={c.child_id} /></td>
                  <td className="nowrap">
                    <Link className="btn btn-sm" to={`/staff/diary/timeline/${c.child_id}`}>記録</Link>
                    {isAdmin && <Link className="btn btn-sm" to={`/staff/children/${c.child_id}/edit`}>編集</Link>}
                    {isAdmin && removableIds.has(c.child_id) && (
                      <button className="btn-sm" onClick={() => { setRemoveError(null); setRemoving(c); }}>取消</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* ページングなし。1クラス最大30名程度で、連続入力の作業性を優先する（基本設計書 3-7） */}
        {data && data.length > 0 && <div className="muted" style={{ marginTop: 8 }}>全 {data.length} 名</div>}
      </section>

      {removing && (
        <ConfirmDialog title="園児の登録の取消" confirmLabel="取り消す" confirmIcon={<UndoIcon />} danger busy={busy}
          onConfirm={() => void remove()} onCancel={() => setRemoving(null)}>
          <p>{removing.child_name} の登録を取り消します。誤って登録した園児を一覧から外します。</p>
          <p className="muted">個人チャットも使えなくなり、未使用の招待コードは失効します。記録や保護者が紐づいている園児は取り消せません。</p>
          {removeError && <ErrorBox text={removeError} />}
        </ConfirmDialog>
      )}

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
