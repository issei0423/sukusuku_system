/*
 * 職員アカウント管理画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)
 *      「職員アカウントの発行・停止、一時パスワードの再発行、ロックの解除」
 *
 * 職員アカウントは管理者が発行する。自己登録の導線は職員側に置かない
 * （画面詳細図 2-1、要件定義書「アカウントの管理」(4-1-2)）。
 *
 * アカウントの操作は、保存前に確認ダイアログを挟む（基本設計書「画面の洗い出しの考え方」(3-1)）。
 * 停止・再開・一時パスワードの再発行を1回押すだけで確定させない（GitHub Issue #107）。
 */
import { useState } from 'react';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Field, Alert, Modal, Tag } from '../../components/ui';
import { ConfirmDialog, notify } from '../../components/feedback';
import { ROLE, ACCOUNT_STATUS } from '../../api/codes';
import type { Role } from '../../api/types';

type Row = Awaited<ReturnType<typeof api.staffAccounts>>[number];
type Pending = { kind: 'stop' | 'resume' | 'reissue'; row: Row };

const EMPTY_FORM = { staff_id: '', staff_name: '', email: '', role: '2' as Role, class_id: '' as number | '' };

/** 使われている職員IDの次の番号。S001 の形だけを数える */
function nextStaffId(rows: Row[]): string {
  const max = rows.reduce((m, r) => {
    const hit = /^S(\d+)$/.exec(r.staff.staff_id);
    return hit ? Math.max(m, Number(hit[1])) : m;
  }, 0);
  return `S${String(max + 1).padStart(3, '0')}`;
}

export default function StaffAccountsScreen() {
  const { user } = useSession();
  const [tick, setTick] = useState(0);
  const { data, error: loadError, loading } = useAsync(() => api.staffAccounts(user!), [tick]);
  const classesForUser = selectableClasses(user!);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 続けて発行しても、前の人の一時パスワードを消さない（GitHub Issue #123）
  const [issued, setIssued] = useState<{ name: string; password: string }[]>([]);
  const remember = (name: string, password: string) =>
    setIssued((list) => [...list.filter((x) => x.name !== name), { name, password }]);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  // ダイアログの中で起きた誤りは、ダイアログの中に出す。後ろに出すと隠れて読めない（GitHub Issue #123）
  const [formError, setFormError] = useState<string | null>(null);

  const [editing, setEditing] = useState<{ staffId: string; accountId: number; name: string; role: Role; classId: number | '' } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const reload = () => setTick((n) => n + 1);

  const openCreate = () => {
    setFormError(null);
    setForm({ ...EMPTY_FORM, staff_id: data ? nextStaffId(data) : '' });
    setCreating(true);
  };

  const create = async () => {
    setFormError(null); setBusy(true);
    try {
      const temp = await api.createStaffAccount(user!, {
        ...form, class_id: form.class_id === '' ? null : form.class_id,
      });
      remember(form.staff_name, temp);
      setCreating(false);
      notify(`${form.staff_name} さんのアカウントを発行しました`);
      reload();
    } catch (e) { setFormError((e as Error).message); } finally { setBusy(false); }
  };

  const openEdit = (r: Row) => {
    setEditError(null);
    setEditing({
      staffId: r.staff.staff_id, accountId: r.account.account_id, name: r.staff.staff_name, role: r.account.role,
      classId: classesForUser.find((c) => c.class_name === r.className)?.class_id ?? '',
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditError(null); setBusy(true);
    try {
      await api.updateStaffAccount(user!, editing.staffId, {
        staff_name: editing.name, role: editing.role, class_id: editing.classId === '' ? null : editing.classId,
      });
      notify(`${editing.name} さんの情報を変更しました`);
      setEditing(null);
      reload();
    } catch (e) { setEditError((e as Error).message); } finally { setBusy(false); }
  };

  const run = async () => {
    if (!pending) return;
    const { kind, row } = pending;
    const name = row.staff.staff_name;
    setError(null); setBusy(true);
    try {
      if (kind === 'reissue') {
        remember(name, await api.reissueTempPassword(user!, row.account.account_id));
        notify(`${name} さんの一時パスワードを再発行しました`);
      } else {
        await api.setAccountStatus(user!, row.account.account_id, kind === 'stop' ? '2' : '1');
        notify(kind === 'stop' ? `${name} さんのアカウントを停止しました` : `${name} さんのアカウントを再開しました`);
      }
      reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); setPending(null); }
  };

  const unlock = async (r: Row) => {
    setError(null);
    try {
      await api.unlock(user!, r.account.account_id);
      notify(`${r.staff.staff_name} さんのロックを解除しました`);
      reload();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <h1>職員アカウント</h1>
        <div className="spacer" />
        <button className="btn-primary" onClick={openCreate}>＋ アカウントを発行</button>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}
      {issued.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Alert soft>
            一時パスワードを本人へ口頭または書面で伝えてください。この表示を閉じると再表示できません。
            <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
              {issued.map((x) => (
                <li key={x.name}>{x.name} さん：<strong style={{ fontFamily: 'monospace' }}>{x.password}</strong></li>
              ))}
            </ul>
            <button className="btn-sm btn-quiet" onClick={() => setIssued([])}>閉じる</button>
          </Alert>
        </div>
      )}

      <section className="card">
        {loading && <Loading />}
        {loadError && <ErrorBox text={loadError} />}
        {data && (
          <table className="list">
            <thead>
              <tr><th scope="col">職員ID</th><th scope="col">氏名</th><th scope="col">ログインID</th><th scope="col">ロール</th><th scope="col">担当クラス</th><th scope="col">状態</th><th scope="col">操作</th></tr>
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
                    {r.locked && <button className="btn-sm" onClick={() => unlock(r)}>ロック解除</button>}
                    <button className="btn-sm" onClick={() => openEdit(r)}>変更</button>
                    <button className="btn-sm" onClick={() => setPending({ kind: 'reissue', row: r })}>
                      一時パスワード再発行
                    </button>
                    {r.account.account_id !== user!.account_id && (
                      <button className="btn-sm"
                        onClick={() => setPending({ kind: r.account.status === '1' ? 'stop' : 'resume', row: r })}>
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
          停止したアカウントのログインIDも、別のアカウントには使えません。
          <br />
          氏名・ロール・担当クラスは「変更」から直せます。職員IDとログインIDは変えられません。
          <br />
          一時パスワードには有効期限があります。期限切れはロックとは別の状態として扱います。
        </div>
      </section>

      {creating && (
        <Modal title="職員アカウントの発行" onClose={() => setCreating(false)}
          footer={<>
            <button onClick={() => setCreating(false)} disabled={busy}>やめる</button>
            <button className="btn-primary" onClick={create}
              disabled={busy || !form.staff_id || !form.staff_name || !form.email}>発行する</button>
          </>}>
          {formError && <Alert>{formError}</Alert>}
          <div className="stack">
            <Field label="職員ID" required>
              <input type="text" value={form.staff_id}
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
                <option value="2">一般（保育士）</option>
                <option value="1">管理者（園長・主任）</option>
              </select>
            </Field>
            <Field label="担当クラス">
              <select value={form.class_id}
                onChange={(e) => setForm({ ...form, class_id: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">割り当てない</option>
                {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
              </select>
            </Field>
            {/* 一般で担当クラスが無いと、園児も日誌も見えない。発行の時点で知らせる（GitHub Issue #127） */}
            {form.role === '2' && form.class_id === '' && (
              <Alert soft>
                一般（保育士）で担当クラスを割り当てないと、この職員には園児・日誌・チャットが表示されません。
              </Alert>
            )}
            <div className="muted">
              職員IDには、使われている番号の次を入れてあります。
              発行すると一時パスワードが表示されます。本人が初回ログインで変更するまで、ほかの機能は使えません。
            </div>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title="職員の情報の変更" onClose={() => setEditing(null)}
          footer={<>
            <button onClick={() => setEditing(null)} disabled={busy}>やめる</button>
            <button className="btn-primary" onClick={saveEdit} disabled={busy || !editing.name.trim()}>変更する</button>
          </>}>
          {editError && <Alert>{editError}</Alert>}
          <div className="stack">
            <Field label="職員ID">
              <input type="text" value={editing.staffId} disabled />
            </Field>
            <Field label="氏名" required>
              <input type="text" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="ロール" required>
              <select value={editing.role} disabled={editing.accountId === user!.account_id}
                onChange={(e) => setEditing({ ...editing, role: e.target.value as Role })}>
                <option value="2">一般（保育士）</option>
                <option value="1">管理者（園長・主任）</option>
              </select>
            </Field>
            {editing.accountId === user!.account_id && (
              <div className="muted">自分のロールは変更できません。</div>
            )}
            {/* 管理者が1名になる操作には警告する（画面詳細図「職員アカウント管理画面」(7-6)） */}
            {editing.role === '2'
              && data?.find((r) => r.account.account_id === editing.accountId)?.account.role === '1'
              && data.filter((r) => r.account.role === '1' && r.account.status === '1').length <= 2 && (
              <Alert>
                この変更で、管理者が1名になります。管理者がパスワードを忘れたときに、再発行できる人が居なくなります。
                管理者は2名以上にしておいてください。
              </Alert>
            )}
            <Field label="担当クラス">
              <select value={editing.classId}
                onChange={(e) => setEditing({ ...editing, classId: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">割り当てない</option>
                {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
              </select>
            </Field>
            <div className="muted">
              担当クラスを変えると、その職員が参照できる園児・日誌・チャットが切り替わります。
              変更の前後は操作ログに残ります。
            </div>
          </div>
        </Modal>
      )}

      {pending?.kind === 'stop' && (
        <ConfirmDialog title="アカウントの停止" confirmLabel="停止する" danger busy={busy}
          onConfirm={run} onCancel={() => setPending(null)}>
          <p>{pending.row.staff.staff_name} さん（{ROLE[pending.row.account.role]}）のアカウントを停止します。</p>
          <p className="muted">停止すると、{pending.row.staff.staff_name} さんはログインできなくなります。「再開」で戻せます。</p>
          {pending.row.account.role === '1' && (
            <Alert soft>管理者のアカウントです。停止すると、承認やアカウント管理を行える人が1人減ります。</Alert>
          )}
        </ConfirmDialog>
      )}
      {pending?.kind === 'resume' && (
        <ConfirmDialog title="アカウントの再開" confirmLabel="再開する" busy={busy}
          onConfirm={run} onCancel={() => setPending(null)}>
          <p>{pending.row.staff.staff_name} さんのアカウントを再開します。再開すると、ふたたびログインできるようになります。</p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'reissue' && (
        <ConfirmDialog title="一時パスワードの再発行" confirmLabel="再発行する" danger busy={busy}
          onConfirm={run} onCancel={() => setPending(null)}>
          <p>{pending.row.staff.staff_name} さんの一時パスワードを再発行します。</p>
          <p className="muted">
            いまのパスワードは、再発行した時点で使えなくなります。元には戻せません。
            本人が次にログインするときに、パスワードの変更が必要になります。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
