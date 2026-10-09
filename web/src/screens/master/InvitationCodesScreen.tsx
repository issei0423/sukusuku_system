/*
 * 招待コード管理画面（管理者）
 * 典拠：図/画面詳細図.md「招待コード管理画面（管理者）」(7-3)
 *
 * 1枚＝1アカウントであり、園児ごとに必要枚数を発行する。両親それぞれに配るなら2枚。
 * 同じ園児に複数枚が並ぶため、園児名でまとめて見られるようにする。
 * 配布用の出力は、コードと園児名の対応を取り違えないことを優先した様式にする。
 */
import { useState } from 'react';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Modal, Tag } from '../../components/ui';
import { INVITATION_STATUS } from '../../api/codes';
import { formatYMD } from '../../api/util';
import type { InvitationStatus } from '../../api/types';

export default function InvitationCodesScreen() {
  const { user } = useSession();
  const classesForUser = selectableClasses(user!);
  const [tick, setTick] = useState(0);

  const [classId, setClassId] = useState<number | ''>('');
  const [status, setStatus] = useState<InvitationStatus | ''>('');
  const [applied, setApplied] = useState(0);

  const { data, error: loadError, loading } = useAsync(
    () => api.invitationCodes(user!, { classId, status }),
    [tick, applied],
  );

  const [error, setError] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkClass, setBulkClass] = useState<number>(classesForUser[0]?.class_id ?? 1);
  const [perChild, setPerChild] = useState(2);
  const [validDays, setValidDays] = useState(30);
  const [printOpen, setPrintOpen] = useState(false);

  // 1枚だけの発行。祖父母の分を足す、紛失や期限切れで出し直す、といった場面で使う
  const [oneOpen, setOneOpen] = useState(false);
  const [oneClass, setOneClass] = useState<number>(classesForUser[0]?.class_id ?? 1);
  const [oneChild, setOneChild] = useState('');
  const [oneDays, setOneDays] = useState(30);
  const [issuedCode, setIssuedCode] = useState<{ code: string; childName: string } | null>(null);
  const oneChildren = useAsync(() => api.listChildren(user!, { classId: oneClass }), [oneClass]);

  const issueOne = async () => {
    if (!oneChild) return;
    setError(null);
    try {
      const code = await api.issueOneInvitationCode(user!, oneChild, oneDays);
      const childName = oneChildren.data?.find((c) => c.child_id === oneChild)?.child_name ?? '';
      setOneOpen(false);
      setOneChild('');
      setIssuedCode({ code, childName });
      setTick((t) => t + 1);
    } catch (e) { setError((e as Error).message); }
  };

  const childCount = useAsync(
    () => api.listChildren(user!, { classId: bulkClass }),
    [bulkClass],
  );

  const bulkIssue = async () => {
    setError(null);
    try {
      const n = await api.issueInvitationCodes(user!, bulkClass, perChild, validDays);
      setBulkOpen(false);
      setTick((t) => t + 1);
      alert(`${n} 枚を発行しました`);
    } catch (e) { setError((e as Error).message); }
  };

  const revoke = async (id: number) => {
    setError(null);
    try { await api.revokeInvitationCode(user!, id); setTick((t) => t + 1); }
    catch (e) { setError((e as Error).message); }
  };

  // 園児名でまとめる
  const grouped = new Map<string, NonNullable<typeof data>>();
  data?.forEach((r) => {
    const list = grouped.get(r.child_name) ?? [];
    list.push(r);
    grouped.set(r.child_name, list);
  });

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <h1>招待コード</h1>
        <div className="spacer" />
        <button onClick={() => setOneOpen(true)}>1枚発行</button>
        <button onClick={() => setBulkOpen(true)}>一括発行</button>
        <button onClick={() => setPrintOpen(true)}>配布用に出力</button>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      {issuedCode && (
        <div style={{ marginBottom: 16 }}>
          <Alert soft>
            {issuedCode.childName} の招待コードを1枚発行しました：
            <strong style={{ fontFamily: 'monospace', letterSpacing: '.08em' }}> {issuedCode.code}</strong>
          </Alert>
        </div>
      )}

      <section className="card">
        <div className="filterbar">
          <Field label="クラス">
            <select value={classId} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">すべて</option>
              {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
            </select>
          </Field>
          <Field label="状態">
            <select value={status} onChange={(e) => setStatus(e.target.value as InvitationStatus | '')}>
              <option value="">すべて</option>
              {Object.entries(INVITATION_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <button onClick={() => setApplied((n) => n + 1)}>絞り込む</button>
        </div>
      </section>

      <section className="card">
        {loading && <Loading />}
        {loadError && <ErrorBox text={loadError} />}
        {data?.length === 0 && <Empty text="該当する招待コードはありません。" />}
        {data && data.length > 0 && (
          <table className="list">
            <thead>
              <tr><th scope="col">園児</th><th scope="col">コード</th><th scope="col">発行日</th><th scope="col">有効期限</th><th scope="col">状態</th><th scope="col">操作</th></tr>
            </thead>
            <tbody>
              {Array.from(grouped.entries()).map(([childName, rows]) =>
                rows.map((r, i) => (
                  <tr key={r.invitation_code_id}>
                    {/* 同じ園児に複数枚が並ぶため、園児名をまとめて見せる */}
                    {i === 0 && <td className="nowrap" rowSpan={rows.length}><strong>{childName}</strong></td>}
                    <td className="nowrap" style={{ fontFamily: 'monospace' }}>{r.code}</td>
                    <td className="nowrap">{r.created_at.slice(0, 10).replace(/-/g, '/')}</td>
                    <td className="nowrap">{formatYMD(r.expires_on)}</td>
                    <td className="nowrap">
                      <Tag label={INVITATION_STATUS[r.status]}
                        className={r.status === '2' ? 'tag-approved' : r.status === '3' ? 'tag-draft' : 'tag-applied'} />
                      {r.expired && <> <Tag label="期限切れ" className="tag-returned" /></>}
                    </td>
                    <td className="nowrap">
                      {r.status === '1' && (
                        <button className="btn-sm" onClick={() => revoke(r.invitation_code_id)}>失効</button>
                      )}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          1枚のコードは1つのアカウントの登録にのみ使えます。両親それぞれに配る場合は、
          その園児に2枚を発行してください（要件定義書「招待コードの発行」(4-1-2)）。
          <br />
          コードは推測しにくい値にしています。配布物の取り違えにご注意ください。
        </div>
      </section>

      {oneOpen && (
        <Modal title="招待コードの発行（1枚）" onClose={() => setOneOpen(false)}
          footer={<>
            <button onClick={() => setOneOpen(false)}>やめる</button>
            <button className="btn-primary" onClick={issueOne} disabled={!oneChild}>発行する</button>
          </>}>
          <div className="stack">
            <Field label="クラス" required>
              <select value={oneClass} onChange={(e) => { setOneClass(Number(e.target.value)); setOneChild(''); }}>
                {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
              </select>
            </Field>
            <Field label="園児" required>
              <select value={oneChild} onChange={(e) => setOneChild(e.target.value)}>
                <option value="">選んでください</option>
                {oneChildren.data?.map((c) => <option key={c.child_id} value={c.child_id}>{c.child_name}</option>)}
              </select>
            </Field>
            <Field label="有効期限" required>
              <div className="row">
                <input type="number" min={1} max={365} value={oneDays} style={{ maxWidth: 100 }}
                  onChange={(e) => setOneDays(Number(e.target.value))} />
                <span>日</span>
              </div>
            </Field>
            <div className="muted">
              選んだ園児に1枚だけ発行します。ほかの園児のコードは変わりません。
            </div>
          </div>
        </Modal>
      )}

      {bulkOpen && (
        <Modal title="招待コードの一括発行" onClose={() => setBulkOpen(false)}
          footer={<>
            <button onClick={() => setBulkOpen(false)}>やめる</button>
            <button className="btn-primary" onClick={bulkIssue}>発行する</button>
          </>}>
          <div className="stack">
            <Field label="クラス" required>
              <select value={bulkClass} onChange={(e) => setBulkClass(Number(e.target.value))}>
                {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
              </select>
            </Field>
            <Field label="園児1名あたりの枚数" required>
              <div className="row">
                <input type="number" min={1} max={5} value={perChild} style={{ maxWidth: 100 }}
                  onChange={(e) => setPerChild(Number(e.target.value))} />
                <span>枚</span>
              </div>
            </Field>
            <Field label="有効期限" required>
              <div className="row">
                <input type="number" min={1} max={365} value={validDays} style={{ maxWidth: 100 }}
                  onChange={(e) => setValidDays(Number(e.target.value))} />
                <span>日</span>
              </div>
            </Field>
            <Alert soft>
              {classesForUser.find((c) => c.class_id === bulkClass)?.class_name}
              {' '}{childCount.data?.length ?? 0} 名 × {perChild} 枚 ＝ {(childCount.data?.length ?? 0) * perChild} 枚を発行します
            </Alert>
          </div>
        </Modal>
      )}

      {printOpen && (
        <Modal title="配布用の出力" onClose={() => setPrintOpen(false)}
          footer={<>
            <button onClick={() => setPrintOpen(false)}>閉じる</button>
            <button className="btn-primary" onClick={() => window.print()}>印刷する</button>
          </>}>
          <div className="muted" style={{ marginBottom: 12 }}>
            コードと園児名の対応を取り違えないよう、1枚ずつ切り分けられる様式にしています。
            未使用のコードのみを載せています。
          </div>
          <div className="stack">
            {data?.filter((r) => r.status === '1' && !r.expired).map((r) => (
              <div key={r.invitation_code_id} className="card" style={{ margin: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--c-text-sub)' }}>お子さまのお名前</div>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{r.child_name}</div>
                <div style={{ fontSize: 13, color: 'var(--c-text-sub)' }}>招待コード</div>
                <div style={{ fontSize: 22, fontFamily: 'monospace', letterSpacing: '.08em' }}>{r.code}</div>
                <div className="muted" style={{ marginTop: 8 }}>
                  有効期限：{formatYMD(r.expires_on)}　／　このコードは1名分の登録にのみ使えます
                </div>
              </div>
            ))}
            {data?.filter((r) => r.status === '1' && !r.expired).length === 0 && (
              <Empty text="配布できる未使用のコードがありません。" />
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
