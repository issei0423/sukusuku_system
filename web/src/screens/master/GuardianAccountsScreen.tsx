/*
 * 保護者アカウント管理画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)
 *      「紐づけの解除、アカウントの停止、未同意者の確認」
 *
 * 紐づけ単位で終了させる。アカウントの停止は有効な紐づけがゼロになった時点（基本設計書 5-3）。
 * 有効な紐づけが無いアカウントは再開できない。誤って解除したときは、紐づけを戻す（GitHub Issue #118）。
 */
import { useState } from 'react';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Alert, Tag } from '../../components/ui';
import { ConfirmDialog, notify } from '../../components/feedback';
import { ACCOUNT_STATUS, LINK_STATUS } from '../../api/codes';
import { formatYMD } from '../../api/util';

type LinkTarget = { guardianId: string; childId: string; guardianName: string; childName: string; last: boolean; stopped: boolean };
type AccountTarget = { accountId: number; guardianName: string };
type Pending =
  | ({ kind: 'end' } & LinkTarget)
  | ({ kind: 'restore' } & LinkTarget)
  | ({ kind: 'stop' } & AccountTarget)
  | ({ kind: 'resume' } & AccountTarget);

export default function GuardianAccountsScreen() {
  const { user } = useSession();
  const [tick, setTick] = useState(0);
  const { data, error: loadError, loading } = useAsync(() => api.guardianAccounts(user!), [tick]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const run = async () => {
    if (!pending) return;
    setError(null); setBusy(true);
    try {
      if (pending.kind === 'end') {
        await api.endGuardianLink(user!, pending.guardianId, pending.childId);
        notify(`${pending.guardianName} さんと ${pending.childName} の紐づけを解除しました`);
      } else if (pending.kind === 'restore') {
        await api.restoreGuardianLink(user!, pending.guardianId, pending.childId);
        notify(`${pending.guardianName} さんと ${pending.childName} の紐づけを戻しました`);
      } else {
        await api.setAccountStatus(user!, pending.accountId, pending.kind === 'stop' ? '2' : '1');
        notify(pending.kind === 'stop'
          ? `${pending.guardianName} さんのアカウントを停止しました`
          : `${pending.guardianName} さんのアカウントを再開しました`);
      }
      setTick((n) => n + 1);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); setPending(null); }
  };

  const notAgreed = data?.filter((r) => !r.termsAgreed) ?? [];

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="page-head"><h1>保護者アカウント</h1></div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      {/* 未同意者の確認 */}
      {notAgreed.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Alert>
            最新版の利用規約に同意していない保護者が {notAgreed.length} 名います：
            {notAgreed.map((r) => r.guardian.guardian_name).join('、')}
            。次回のログイン時に同意画面を表示します。
          </Alert>
        </div>
      )}

      <section className="card">
        {loading && <Loading />}
        {loadError && <ErrorBox text={loadError} />}
        {data?.length === 0 && <Empty text="保護者アカウントはありません。" />}
        {data && data.length > 0 && (
          <table className="list">
            <thead>
              <tr><th scope="col">保護者</th><th scope="col">ログインID</th><th scope="col">電話番号</th><th scope="col">紐づく園児</th><th scope="col">規約</th><th scope="col">状態</th><th scope="col">操作</th></tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.guardian.guardian_id}>
                  <td className="nowrap">{r.guardian.guardian_name}</td>
                  <td className="nowrap muted">{r.account.email}</td>
                  <td className="nowrap">{r.guardian.phone_number ?? '―'}</td>
                  <td>
                    {r.links.length === 0 && <span className="muted">―</span>}
                    {r.links.map((l) => {
                      const base = {
                        guardianId: r.guardian.guardian_id, childId: l.child_id,
                        guardianName: r.guardian.guardian_name, childName: l.child_name,
                        last: r.activeLinks === 1, stopped: r.account.status === '2',
                      };
                      return (
                        <div key={l.child_id} className="row" style={{ gap: 6 }}>
                          <span>{l.child_name}（{l.relationship}）</span>
                          <Tag label={LINK_STATUS[l.link_status]}
                            className={l.link_status === '1' ? 'tag-approved' : 'tag-draft'} />
                          {l.link_status === '1' && (
                            <button className="btn-sm btn-quiet" onClick={() => setPending({ kind: 'end', ...base })}>
                              解除
                            </button>
                          )}
                          {l.ended_at && <span className="weak">（{formatYMD(l.ended_at.slice(0, 10))} 終了）</span>}
                          {l.link_status === '2' && (
                            <button className="btn-sm btn-quiet" onClick={() => setPending({ kind: 'restore', ...base })}>
                              紐づけを戻す
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </td>
                  <td className="nowrap">
                    {r.termsAgreed
                      ? <Tag label="同意済" className="tag-approved" />
                      : <Tag label="未同意" className="tag-returned" />}
                  </td>
                  <td className="nowrap">
                    <Tag label={ACCOUNT_STATUS[r.account.status]}
                      className={r.account.status === '1' ? 'tag-approved' : 'tag-draft'} />
                  </td>
                  <td className="nowrap">
                    {r.account.status === '1' ? (
                      <button className="btn-sm" onClick={() => setPending({
                        kind: 'stop', accountId: r.account.account_id, guardianName: r.guardian.guardian_name,
                      })}>
                        停止
                      </button>
                    ) : (
                      // 有効な紐づけが無いアカウントは再開できない。紐づけを戻すと再開される
                      <button className="btn-sm" disabled={r.activeLinks === 0}
                        title={r.activeLinks === 0 ? '有効な紐づけが無いため再開できません。「紐づけを戻す」を使ってください' : undefined}
                        onClick={() => setPending({
                          kind: 'resume', accountId: r.account.account_id, guardianName: r.guardian.guardian_name,
                        })}>
                        再開
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
          {/* 紐づけ単位で終了させ、有効な紐づけがゼロになった時点で停止する（基本設計書「クラスと紐づけ」(5-3)） */}
          紐づけは園児ごとに終了させます。有効な紐づけがゼロになった時点で、アカウントは自動的に停止されます。
          <br />
          有効な紐づけが無いアカウントは再開できません。誤って解除したときは「紐づけを戻す」を使ってください。
          紐づけを戻すと、停止していたアカウントも再開されます。
          <br />
          紐づけを終了しても、その保護者が参加していた期間のやりとりは記録として残ります。
          ただし保護者側からは参照できなくなります（同 5-5）。
        </div>
      </section>

      {pending?.kind === 'end' && (
        <ConfirmDialog title="紐づけの解除" confirmLabel="解除する" danger busy={busy}
          onConfirm={run} onCancel={() => setPending(null)}>
          <p>{pending.guardianName} さんと {pending.childName} の紐づけを終了します。</p>
          <p>解除すると、{pending.guardianName} さんは {pending.childName} の記録とチャットを参照できなくなります。</p>
          {pending.last && (
            <Alert>
              これが最後の有効な紐づけです。解除すると {pending.guardianName} さんのアカウントは停止されます。
            </Alert>
          )}
        </ConfirmDialog>
      )}
      {pending?.kind === 'restore' && (
        <ConfirmDialog title="紐づけを戻す" confirmLabel="戻す" busy={busy}
          onConfirm={run} onCancel={() => setPending(null)}>
          <p>{pending.guardianName} さんと {pending.childName} の紐づけを、有効に戻します。</p>
          <p>戻すと、{pending.guardianName} さんは {pending.childName} の記録とチャットを参照できるようになります。</p>
          {pending.stopped && (
            <Alert soft>{pending.guardianName} さんのアカウントは停止中です。紐づけを戻すと、あわせて再開されます。</Alert>
          )}
        </ConfirmDialog>
      )}
      {pending?.kind === 'stop' && (
        <ConfirmDialog title="アカウントの停止" confirmLabel="停止する" danger busy={busy}
          onConfirm={run} onCancel={() => setPending(null)}>
          <p>{pending.guardianName} さんのアカウントを停止します。</p>
          <p className="muted">停止すると、{pending.guardianName} さんはログインできなくなります。「再開」で戻せます。</p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'resume' && (
        <ConfirmDialog title="アカウントの再開" confirmLabel="再開する" busy={busy}
          onConfirm={run} onCancel={() => setPending(null)}>
          <p>{pending.guardianName} さんのアカウントを再開します。再開すると、ふたたびログインできるようになります。</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
