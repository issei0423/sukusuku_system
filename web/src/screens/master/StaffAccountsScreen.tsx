/*
 * 職員アカウント管理画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)
 *      「職員アカウントの発行・停止、一時パスワードの再発行、ロックの解除」
 *
 * 職員アカウントは管理者が発行する。自己登録の導線は職員側に置かない
 * （画面詳細図 2-1、要件定義書「アカウントの管理」(4-1-2)）。
 */
import { useState } from 'react';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Field, Alert, Modal, Tag } from '../../components/ui';
import { ROLE, ACCOUNT_STATUS } from '../../api/codes';
import type { Role } from '../../api/types';

export default function StaffAccountsScreen() {
  const { user } = useSession();
  const [tick, setTick] = useState(0);
  const { data, error: loadError, loading } = useAsync(() => api.staffAccounts(user!), [tick]);
  const classesForUser = selectableClasses(user!);

  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; password: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ staff_id: '', staff_name: '', email: '', role: '2' as Role, class_id: '' as number | '' });

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); setTick((n) => n + 1); }
    catch (e) { setError((e as Error).message); }
  };

  const create = async () => {
    setError(null);
    try {
      const temp = await api.createStaffAccount(user!, {
        ...form, class_id: form.class_id === '' ? null : form.class_id,
      });
      setIssued({ name: form.staff_name, password: temp });
      setCreating(false);
      setForm({ staff_id: '', staff_name: '', email: '', role: '2', class_id: '' });
      setTick((n) => n + 1);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <h1>職員アカウント</h1>
        <div className="spacer" />
        <button className="btn-primary" onClick={() => setCreating(true)}>＋ アカウントを発行</button>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}
      {issued && (
        <div style={{ marginBottom: 16 }}>
          <Alert soft>
            {issued.name} さんの一時パスワードは <strong>{issued.password}</strong> です。
            本人へ口頭または書面で伝えてください。この画面を閉じると再表示できません。
            <button className="btn-sm btn-quiet" onClick={() => setIssued(null)}>閉じる</button>
          </Alert>
        </div>
      )}

      <section className="card">
        {loading && <Loading />}
        {loadError && <ErrorBox text={loadError} />}
        {data && (
          <table className="list">
            <thead>
              <tr><th>職員ID</th><th>氏名</th><th>ログインID</th><th>ロール</th><th>担当クラス</th><th>状態</th><th></th></tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.staff.staff_id}>
                  <td className="nowrap">{r.staff.staff_id}</td>
                  <td className="nowrap">{r.staff.staff_name}</td>
                  <td className="nowrap muted">{r.account.email}</td>
                  <td className="nowrap">{ROLE[r.account.role]}</td>
                  <td className="nowrap">{r.className}</td>
                  <td className="nowrap">
                    <Tag label={ACCOUNT_STATUS[r.account.status]}
                      className={r.account.status === '1' ? 'tag-approved' : 'tag-draft'} />
                    {r.locked && <> <Tag label="ロック中" className="tag-returned" /></>}
                    {r.account.is_temp_password && <> <Tag label="一時パスワード" className="tag-applied" /></>}
                  </td>
                  <td className="nowrap">
                    {r.locked && (
                      <button className="btn-sm" onClick={() => act(() => api.unlock(user!, r.account.account_id))}>
                        ロック解除
                      </button>
                    )}
                    <button className="btn-sm" onClick={() => act(async () => {
                      const temp = await api.reissueTempPassword(user!, r.account.account_id);
                      setIssued({ name: r.staff.staff_name, password: temp });
                    })}>
                      一時パスワード再発行
                    </button>
                    {r.account.account_id !== user!.account_id && (
                      <button className="btn-sm"
                        onClick={() => act(() => api.setAccountStatus(user!, r.account.account_id, r.account.status === '1' ? '2' : '1'))}>
                        {r.account.status === '1' ? '停止' : '再開'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          ログインIDのメールアドレスは、ロールをまたいで園内で一意です（基本設計書 5-2）。
          <br />
          一時パスワードには有効期限があります。期限切れはロックとは別の状態として扱います。
        </div>
      </section>

      {creating && (
        <Modal title="職員アカウントの発行" onClose={() => setCreating(false)}
          footer={<>
            <button onClick={() => setCreating(false)}>やめる</button>
            <button className="btn-primary" onClick={create}
              disabled={!form.staff_id || !form.staff_name || !form.email}>発行する</button>
          </>}>
          <div className="stack">
            <Field label="職員ID" required>
              <input type="text" value={form.staff_id} placeholder="S006"
                onChange={(e) => setForm({ ...form, staff_id: e.target.value })} />
            </Field>
            <Field label="氏名" required>
              <input type="text" value={form.staff_name} onChange={(e) => setForm({ ...form, staff_name: e.target.value })} />
            </Field>
            <Field label="ログインID（メールアドレス）" required>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="ロール" required>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                <option value="1">管理者（園長・主任）</option>
                <option value="2">一般（保育士）</option>
              </select>
            </Field>
            <Field label="担当クラス">
              <select value={form.class_id}
                onChange={(e) => setForm({ ...form, class_id: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">割り当てない</option>
                {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
              </select>
            </Field>
            <div className="muted">
              発行すると一時パスワードが表示されます。本人が初回ログインで変更するまで、ほかの機能は使えません。
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
