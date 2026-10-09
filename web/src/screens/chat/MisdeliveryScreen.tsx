/*
 * 誤送信対応記録画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)「誤送信の発生日時・対象・既読の有無・とった対応を記録する」
 *      基本設計書.md「誤送信への対応」(4-6)、5-5 t_misdelivery_record
 *
 * 取消済みで、まだ対応を記録していないメッセージを上に出す。
 * 「取り消した」だけで終わらせず、既読の有無と対応を残させるため。
 */
import { useState } from 'react';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Modal, Radios } from '../../components/ui';
import { formatMDHM, now } from '../../api/util';

export default function MisdeliveryScreen() {
  const { user } = useSession();
  const [tick, setTick] = useState(0);
  const records = useAsync(() => api.misdeliveryRecords(user!), [user?.account_id, tick]);
  const pending = useAsync(() => api.retractedWithoutRecord(), [tick]);

  const [target, setTarget] = useState<{ chat_message_id: number; room_name: string; sent_at: string } | null>(null);
  const [wasRead, setWasRead] = useState<'yes' | 'no' | null>(null);
  const [response, setResponse] = useState('');
  const [occurredAt, setOccurredAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const open = (p: { chat_message_id: number; room_name: string; sent_at: string }) => {
    setTarget(p);
    setWasRead(null);
    setResponse('');
    setOccurredAt(p.sent_at.slice(0, 16));
    setError(null);
  };

  const save = async () => {
    if (!target || wasRead === null) return;
    setError(null);
    try {
      await api.addMisdeliveryRecord(user!, {
        chat_message_id: target.chat_message_id,
        occurred_at: occurredAt.length === 16 ? `${occurredAt}:00` : now(),
        was_read: wasRead === 'yes',
        response,
      });
      setTarget(null);
      setTick((n) => n + 1);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="page-head"><h1>誤送信対応の記録</h1></div>

      {/* 未記録のもの */}
      <section className="card">
        <h2>対応の記録がない取消メッセージ</h2>
        {pending.loading && <Loading />}
        {pending.data?.length === 0 && <Empty text="対応の記録がない取消メッセージはありません。" />}
        {pending.data && pending.data.length > 0 && (
          <>
            <Alert>
              取り消したメッセージのうち、対応を記録していないものがあります。
              既読の有無ととった対応を残してください。
            </Alert>
            <table className="list" style={{ marginTop: 12 }}>
              <thead><tr><th scope="col">送信</th><th scope="col">取消</th><th scope="col">チャンネル</th><th scope="col">送信者</th><th scope="col">操作</th></tr></thead>
              <tbody>
                {pending.data.map((p) => (
                  <tr key={p.chat_message_id}>
                    <td className="nowrap">{formatMDHM(p.sent_at)}</td>
                    <td className="nowrap">{p.deleted_at ? formatMDHM(p.deleted_at) : '―'}</td>
                    <td>{p.room_name}</td>
                    <td className="nowrap">{p.sender_name}</td>
                    <td className="nowrap">
                      <button className="btn-sm btn-primary" onClick={() => open(p)}>対応を記録する</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {/* 記録済みのもの */}
      <section className="card">
        <h2>記録済み</h2>
        {records.loading && <Loading />}
        {records.error && <ErrorBox text={records.error} />}
        {records.data?.length === 0 && <Empty text="記録はありません。" />}
        {records.data && records.data.length > 0 && (
          <table className="list">
            <thead><tr><th scope="col">発生日時</th><th scope="col">チャンネル</th><th scope="col">既読</th><th scope="col">とった対応</th><th scope="col">記録者</th></tr></thead>
            <tbody>
              {records.data.map((r) => (
                <tr key={r.misdelivery_record_id}>
                  <td className="nowrap">{formatMDHM(r.occurred_at)}</td>
                  <td className="nowrap">{r.room_name}</td>
                  <td className="nowrap">
                    <span className={`tag ${r.was_read ? 'tag-returned' : 'tag-plain'}`}>
                      {r.was_read ? '既読あり' : '既読なし'}
                    </span>
                  </td>
                  <td>{r.response}</td>
                  <td className="nowrap">{r.staff_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {target && (
        <Modal title="誤送信への対応を記録する" onClose={() => setTarget(null)}
          footer={<>
            <button onClick={() => setTarget(null)}>やめる</button>
            <button className="btn-primary" onClick={save} disabled={wasRead === null || !response.trim()}>記録する</button>
          </>}>
          <div className="stack">
            {error && <Alert>{error}</Alert>}
            <div className="muted">対象：{target.room_name}（{formatMDHM(target.sent_at)} 送信）</div>
            <Field label="発生日時" required>
              <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
            </Field>
            <Field label="既読の有無" required>
              <Radios name="wasRead" value={wasRead}
                options={[{ value: 'no', label: '既読は付いていなかった' }, { value: 'yes', label: '既読が付いていた' }]}
                onChange={setWasRead} />
            </Field>
            {wasRead === 'yes' && (
              <Alert>
                既読が付いている場合は、取消だけでは相手の目に触れた事実が消えません。
                相手への連絡を含めて対応を記録してください。
              </Alert>
            )}
            <Field label="とった対応" required>
              <textarea value={response} onChange={(e) => setResponse(e.target.value)}
                placeholder="いつ取り消したか、相手へ何を連絡したか、送り直したかを書いてください" />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
