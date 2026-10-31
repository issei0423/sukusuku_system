/*
 * 日誌一覧画面
 * 典拠：図/画面詳細図.md「日誌一覧画面」(3-1)
 *
 * 状態を列として持つ（下書き／申請中／差し戻し／承認済）。差し戻しは他と区別できる色にする。
 * 一般（保育士）の既定の絞り込みは自クラス。他クラスは選べない。
 * 自分が申請した申請中の行には「申請を取り下げる」を出す（詳細設計書「日誌の画面（作り直し）」(2-13 (2))）。
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api, selectableClasses, childName, className, staffName } from '../../api/client';
import { Loading, ErrorBox, Empty, Pager, Field, Tag } from '../../components/ui';
import { DIARY_RECORD_TYPE, DIARY_STATUS, DIARY_STATUS_CLASS } from '../../api/codes';
import { formatMD, today, addDays } from '../../api/util';
import type { Diary, DiaryRecordType, DiaryStatus } from '../../api/types';
import { ConfirmDialog, notify } from '../../components/feedback';
import { AddIcon, SearchIcon, UndoIcon } from '../../components/icons';

// 期間の開始の初期値は、当日の30日前（図/画面詳細図.md「日誌一覧画面」(3-1) 項目4「開始＝当日の30日前」。GitHub Issue #278）
const DEFAULT_RANGE_DAYS = 30;

export default function DiaryListScreen() {
  const { user } = useSession();
  const [params] = useSearchParams();
  const classesForUser = selectableClasses(user!);

  const [recordType, setRecordType] = useState<DiaryRecordType | ''>('');
  // 一般の既定は自クラス。管理者は「すべて」から始める
  const [classId, setClassId] = useState<number | ''>(user!.role === '2' ? (user!.class_id ?? '') : '');
  const [status, setStatus] = useState<DiaryStatus | ''>((params.get('status') as DiaryStatus) ?? '');
  /*
   * 【仮置き】職員ダッシュボードの「差し戻された日誌」から開いたとき（?mine=1）は、自分が書いた日誌に絞り、
   * 期間を問わない。ダッシュボードは自分が書いた差し戻しを期間によらず数えるため、既定の期間（直近1か月）のままだと
   * 数えた日誌が一覧に出ず、ほかの職員の差し戻しが出ていた（図/画面詳細図.md「職員ダッシュボード」(2-6) 項目2。
   * GitHub Issue #174。web/仮置き値.md）
   */
  const fromDashboard = params.get('mine') === '1';
  const [mine, setMine] = useState(fromDashboard);
  const [from, setFrom] = useState(fromDashboard ? '' : addDays(today(), -DEFAULT_RANGE_DAYS));
  const [to, setTo] = useState(fromDashboard ? '' : today());
  // 園児名・キーワード（図/画面詳細図.md「日誌一覧画面」(3-1) 項目10・11）。「絞り込む」で効かせる
  const [childQuery, setChildQuery] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [applied, setApplied] = useState(0);
  // 取り下げを確かめている行（申請の取り下げ。詳細設計書「日誌の画面（作り直し）」(2-13 (2))）
  const [withdrawing, setWithdrawing] = useState<Diary | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /*
   * 一覧で読んだ版を添えて取り下げる。承認・差し戻しが先に済んでいたら断られ、その文言を出す。
   * どちらの場合も一覧を読み直す（状態の列と、取り下げのボタンの有無を今に合わせる）
   */
  const withdraw = async () => {
    if (!withdrawing) return;
    setBusy(true); setActionError(null);
    try {
      await api.withdrawDiary(user!, withdrawing.diary_id, withdrawing.updated_at);
      notify('申請を取り下げました。下書きに戻っています');
    } catch (e) { setActionError((e as Error).message); }
    finally { setBusy(false); setWithdrawing(null); setApplied((n) => n + 1); }
  };

  // 同じ画面のままサイドナビから再訪した場合も、URL の条件を反映する。
  useEffect(() => {
    const dashboard = params.get('mine') === '1';
    setStatus((params.get('status') as DiaryStatus) ?? '');
    setMine(dashboard);
    setChildQuery('');
    setKeyword('');
    setFrom(dashboard ? '' : addDays(today(), -DEFAULT_RANGE_DAYS));
    setTo(dashboard ? '' : today());
    setPage(1);
    setApplied((n) => n + 1);
  }, [params]);

  // ほかの職員の保存・申請・承認・差し戻しがあったら、開いたままでも読み直す（live.ts）
  const { data, error, loading } = useAsync(
    () => api.listDiaries(user!, { recordType, classId, status, from, to, page, mine, child: childQuery, keyword }),
    [user?.account_id, page, applied],
    { live: onLive('diary') },
  );

  const [rangeError, setRangeError] = useState<string | null>(null);
  const search = () => {
    if (from && to && from > to) { setRangeError('期間の開始は、終了より後の日にできません'); return; }
    setRangeError(null); setPage(1); setApplied((n) => n + 1);
  };

  return (
    <div>
      <div className="page-head">
        <h1>日誌</h1>
        <div className="spacer" />
        <Link className="btn btn-primary" to="/staff/diary/new"><AddIcon />新しく書く</Link>
      </div>

      <section className="card">
        <div className="filterbar">
          <Field label="種別">
            <select value={recordType} onChange={(e) => setRecordType(e.target.value as DiaryRecordType | '')}>
              <option value="">すべて</option>
              {Object.entries(DIARY_RECORD_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="クラス">
            <select value={classId} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : '')}
              disabled={user!.role === '2'}>
              {user!.role !== '2' && <option value="">すべて</option>}
              {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
            </select>
          </Field>
          <Field label="状態">
            <select value={status} onChange={(e) => setStatus(e.target.value as DiaryStatus | '')}>
              <option value="">すべて</option>
              {Object.entries(DIARY_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="期間（開始）"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="期間（終了）"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="園児名">
            <input type="text" value={childQuery} placeholder="名前・よみ" onChange={(e) => setChildQuery(e.target.value)} />
          </Field>
          <Field label="キーワード">
            <input type="text" value={keyword} placeholder="本文" onChange={(e) => setKeyword(e.target.value)} />
          </Field>
          {/* ダッシュボードの「差し戻された日誌」から開いたときはオン（図/画面詳細図.md「日誌一覧画面」(3-1) 項目12） */}
          <label className="row" style={{ alignSelf: 'flex-end' }}>
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
            自分が作成したもの
          </label>
          <button onClick={search}><SearchIcon />絞り込む</button>
        </div>
        {rangeError && <ErrorBox text={rangeError} />}
        {user!.role === '2' && (
          <div className="muted" style={{ marginTop: 8 }}>
            担当するクラスの日誌のみ表示しています。
          </div>
        )}
      </section>

      <section className="card">
        {actionError && <div style={{ marginBottom: 12 }}><ErrorBox text={actionError} /></div>}
        {loading && <Loading />}
        {error && <ErrorBox text={error} />}
        {data && data.rows.length === 0 && <Empty text="該当する日誌はありません。" />}
        {data && data.rows.length > 0 && (
          <>
            <table className="list list-dense">
              <thead>
                <tr>
                  <th scope="col">記録日</th><th scope="col">種別</th><th scope="col">対象</th><th scope="col">作成者</th><th scope="col">状態</th><th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((d) => (
                  <tr key={d.diary_id}>
                    <td className="nowrap">{formatMD(d.diary_date)}</td>
                    <td className="nowrap">{DIARY_RECORD_TYPE[d.record_type]}</td>
                    <td>{d.child_id ? childName(d.child_id) : className(d.class_id)}</td>
                    <td className="nowrap">{staffName(d.created_staff_id)}</td>
                    <td className="nowrap"><Tag label={DIARY_STATUS[d.status]} className={DIARY_STATUS_CLASS[d.status]} /></td>
                    <td className="nowrap">
                      <Link className="btn btn-sm" to={`/staff/diary/${d.diary_id}`}>開く</Link>
                      {/* 申請した本人の、申請中の行だけ（サーバも本人以外を断る） */}
                      {d.status === '2' && !!d.applied_staff_id && d.applied_staff_id === user!.staff_id && (
                        <button className="btn-sm" style={{ marginLeft: 8 }} onClick={() => setWithdrawing(d)} disabled={busy}>
                          申請を取り下げる
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={data.page} perPage={data.per_page} total={data.total} onChange={setPage} />
          </>
        )}
      </section>
      {withdrawing && (
        /* 取り下げると、読み直しで行の「申請を取り下げる」が消える。同じ行の押せる最初のもの（「開く」）へ（GitHub Issue #213） */
        <ConfirmDialog title="申請の取り下げ" confirmLabel="取り下げる" confirmIcon={<UndoIcon />} busy={busy} returnWithin={['td', 'tr']}
          onConfirm={withdraw} onCancel={() => setWithdrawing(null)}>
          <p>申請を取り下げますか。下書きに戻り、承認待ちから外れます。</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
