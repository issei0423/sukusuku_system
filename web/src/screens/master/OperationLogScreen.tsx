/*
 * 操作ログ参照画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)「日付・操作者・対象機能・対象園児での絞り込みと出力」
 *      基本設計書.md「監査への対応」(6-4)、5-8 t_operation_log
 *
 * 追記のみとし、更新・削除の手段を設けない。この画面からもログは編集できない。
 */
import { useState } from 'react';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Pager } from '../../components/ui';
import { FUNCTION_TYPE, OPERATION_TYPE } from '../../api/codes';
import { formatMDHM, today, addDays } from '../../api/util';
import type { FunctionType } from '../../api/types';

export default function OperationLogScreen() {
  const { user } = useSession();
  const accounts = useAsync(() => api.allAccounts(user!), [user?.account_id]);

  const [from, setFrom] = useState(addDays(today(), -30));
  const [to, setTo] = useState(today());
  const [accountId, setAccountId] = useState<number | ''>('');
  const [functionType, setFunctionType] = useState<FunctionType | ''>('');
  const [page, setPage] = useState(1);
  const [applied, setApplied] = useState(0);

  const { data, error, loading } = useAsync(
    () => api.operationLogs(user!, { from, to, accountId, functionType, page }),
    [page, applied],
  );

  const exportCsv = () => {
    if (!data) return;
    const header = ['操作日時', '操作者', '機能', '操作', '対象テーブル', '対象園児', '変更前', '変更後'];
    const lines = data.rows.map((l) => [
      l.operated_at, l.account_name, FUNCTION_TYPE[l.function_type], OPERATION_TYPE[l.operation_type],
      l.target_table, l.child_name, l.before_value ?? '', l.after_value ?? '',
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    // 出力の操作自体もログに残す必要があるが、モックでは記録していない。
    // 実装時は operation_type='5'（出力）で残すこと（基本設計書 5-8）
    const blob = new Blob([`﻿${[header.join(','), ...lines].join('\n')}`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `操作ログ_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="page-head">
        <h1>操作ログ</h1>
        <div className="spacer" />
        <button onClick={exportCsv} disabled={!data || data.rows.length === 0}>CSV出力</button>
      </div>

      <section className="card">
        <div className="filterbar">
          <Field label="期間（開始）"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="期間（終了）"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="操作者">
            <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">すべて</option>
              {accounts.data?.map((a) => <option key={a.account_id} value={a.account_id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="対象機能">
            <select value={functionType} onChange={(e) => setFunctionType(e.target.value as FunctionType | '')}>
              <option value="">すべて</option>
              {Object.entries(FUNCTION_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <button onClick={() => { setPage(1); setApplied((n) => n + 1); }}>絞り込む</button>
        </div>
      </section>

      <section className="card">
        {loading && <Loading />}
        {error && <ErrorBox text={error} />}
        {data?.rows.length === 0 && <Empty text="該当する操作ログはありません。" />}
        {data && data.rows.length > 0 && (
          <>
            <table className="list">
              <thead>
                <tr>
                  <th>操作日時</th><th>操作者</th><th>機能</th><th>操作</th>
                  <th>対象テーブル</th><th>対象園児</th><th>変更前</th><th>変更後</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((l) => (
                  <tr key={l.operation_log_id}>
                    <td className="nowrap">{formatMDHM(l.operated_at)}</td>
                    <td className="nowrap">{l.account_name}</td>
                    <td className="nowrap">{FUNCTION_TYPE[l.function_type]}</td>
                    <td className="nowrap">{OPERATION_TYPE[l.operation_type]}</td>
                    <td className="nowrap muted">{l.target_table}</td>
                    <td className="nowrap">{l.child_name}</td>
                    <td className="muted">{l.before_value ?? '―'}</td>
                    <td>{l.after_value ?? '―'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={data.page} perPage={data.per_page} total={data.total} onChange={setPage} />
          </>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          操作ログは追記のみで、更新・削除の手段を設けていません（基本設計書 5-8）。
          操作日時にはサーバの時刻を入れます。
        </div>
      </section>
    </div>
  );
}
