/*
 * 保護者アカウント管理画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)
 *      「紐づけの解除、アカウントの停止、未同意者の確認」
 *
 * 紐づけ単位で終了させる。アカウントの停止は有効な紐づけがゼロになった時点（基本設計書 5-3）。
 */
import { useState } from 'react';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Alert, Tag, Modal } from '../../components/ui';
import { ACCOUNT_STATUS, LINK_STATUS } from '../../api/codes';
import { formatYMD } from '../../api/util';

export default function GuardianAccountsScreen() {
  const { user } = useSession();
  const [tick, setTick] = useState(0);
  const { data, error: loadError, loading } = useAsync(() => api.guardianAccounts(user!), [tick]);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ guardianId: string; childId: string; guardianName: string; childName: string; last: boolean } | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); setTick((n) => n + 1); }
    catch (e) { setError((e as Error).message); }
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
              <tr><th>保護者</th><th>ログインID</th><th>電話番号</th><th>紐づく園児</th><th>規約</th><th>状態</th><th></th></tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.guardian.guardian_id}>
                  <td className="nowrap">{r.guardian.guardian_name}</td>
                  <td className="nowrap muted">{r.account.email}</td>
                  <td className="nowrap">{r.guardian.phone_number ?? '―'}</td>
                  <td>
                    {r.links.length === 0 && <span className="muted">―</span>}
                    {r.links.map((l) => (
                      <div key={l.child_id} className="row" style={{ gap: 6 }}>
                        <span>{l.child_name}（{l.relationship}）</span>
                        <Tag label={LINK_STATUS[l.link_status]}
                          className={l.link_status === '1' ? 'tag-approved' : 'tag-draft'} />
                        {l.link_status === '1' && (
                          <button className="btn-sm btn-quiet"
                            onClick={() => setConfirm({
                              guardianId: r.guardian.guardian_id, childId: l.child_id,
                              guardianName: r.guardian.guardian_name, childName: l.child_name,
                              last: r.activeLinks === 1,
                            })}>
                            解除
                          </button>
                        )}
                        {l.ended_at && <span className="weak">（{formatYMD(l.ended_at.slice(0, 10))} 終了）</span>}
                      </div>
                    ))}
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
                    <button className="btn-sm"
                      onClick={() => act(() => api.setAccountStatus(user!, r.account.account_id, r.account.status === '1' ? '2' : '1'))}>
                      {r.account.status === '1' ? '停止' : '再開'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          紐づけは園児ごとに終了させます。有効な紐づけがゼロになった時点で、アカウントは自動的に停止されます
          （基本設計書 5-3）。
          <br />
          紐づけを終了しても、その保護者が参加していた期間のやりとりは記録として残ります。
          ただし保護者側からは参照できなくなります（同 5-5）。
          <br />
          電話番号の保持先は未確定です（要決定事項.md 優先度A「保護者への緊急連絡先」）。
        </div>
      </section>

      {confirm && (
        <Modal title="紐づけの解除" onClose={() => setConfirm(null)}
          footer={<>
            <button onClick={() => setConfirm(null)}>やめる</button>
            <button className="btn-danger"
              onClick={() => { act(() => api.endGuardianLink(user!, confirm.guardianId, confirm.childId)); setConfirm(null); }}>
              解除する
            </button>
          </>}>
          <p>{confirm.guardianName} さんと {confirm.childName} の紐づけを終了します。</p>
          <p>解除すると、{confirm.guardianName} さんは {confirm.childName} の記録とチャットを参照できなくなります。</p>
          {confirm.last && (
            <Alert>
              これが最後の有効な紐づけです。解除すると {confirm.guardianName} さんのアカウントは停止されます。
            </Alert>
          )}
        </Modal>
      )}
    </div>
  );
}
