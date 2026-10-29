/*
 * 職員ダッシュボード
 * 典拠：図/画面詳細図.md「職員ダッシュボード」(2-6)、詳細設計書「職員ダッシュボード（「届ける」の項目）」(2-1)
 *
 * 「届けること」を上に、園内のこと（日誌・発達チェック・異常時の記録）をその下に置く。
 * 出勤直後に「何が残っているか」を1画面で把握させるため。各項目に、数えている範囲（担当クラス・全クラス）を添える。
 * 差し戻された日誌は一般にのみ、承認待ちの日誌は管理者にのみ表示する（同 項目2・8）。
 */
import { Link, useLocation } from 'react-router-dom';
import { useAsync, AUTO_REFRESH_MS } from '../../hooks';
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Alert } from '../../components/ui';
import { formatYMD, today } from '../../api/util';
import { ACCOUNT_CHANGED_TEXT } from '../../messages';

/** 項目に、数えている範囲を添える（「担当クラス」「全クラス」） */
const scopeNote = (scope: string) => <span className="muted">（{scope}）</span>;

export default function StaffDashboard() {
  const { user } = useSession();
  // 開いたままでも、保護者からのチャットや承認の結果がすぐに件数に表れるよう、知らせ（live.ts）を受けて読み直す
  // （知らせが切れている間は数秒ごとに読み直す）
  const { data, error, loading } = useAsync(() => api.staffSummary(user!), [user?.account_id],
    { refreshMs: AUTO_REFRESH_MS, live: onLive('chat', 'diary', 'nap', 'development', 'contact') });
  // 管理者に限る画面を開こうとして戻されたとき（App.tsx の RequireAdmin）
  const state = useLocation().state as { denied?: string; accountChanged?: boolean } | null;
  const denied = state?.denied === 'admin';
  // 別のタブで別のアカウントにログインし直されたため、このタブも切り替えたとき（App.tsx）
  const accountChanged = state?.accountChanged === true;

  if (loading) return <Loading />;
  if (error) return <ErrorBox text={error} />;
  if (!data || !user) return null;

  /*
   * 未対応のままの個人チャット。保護者からの連絡（欠席・お迎え時間の変更など）の対応漏れを防ぐ
   * （要件定義書「チャットツール」(4-3)）。「開く」は先頭のチャンネルを選んだ状態でチャット画面を開く。
   * 2件以上あるときは、どこが開くかが分かるよう、先頭のチャンネル名に残りの件数を添える
   */
  const firstUnhandled = data.unhandledChatRoom;
  // 数えている範囲。一般は自クラス、管理者は全クラス（同「数える範囲」。GitHub Issue #268 の 7）
  const scope = user.role === '1' ? '全クラス' : '担当クラス';
  const unhandledNote = firstUnhandled
    ? `${firstUnhandled.room_name}${data.unhandledChat > 1 ? ` ほか${data.unhandledChat - 1}件` : ''}`
    : undefined;

  /*
   * 件数が 0 の項目も行を残す。各項目は「ラベル＋ボタン／表示：件数」であり（画面詳細図「職員ダッシュボード」(2-6) 項目2〜4・9）、
   * 0 件の行を消すと、0 件なのか、その項目を見られないのかが分からない（GitHub Issue #178 の 6）。
   * 【仮置き】設計の表に無い「未対応の個人チャット」も、ほかの行にそろえて 0 件で出す（web/仮置き値.md）
   */
  const rows: { label: string; note?: string; count: number; unit: string; to: string; noScope?: boolean }[] = [
    // 一般にのみ表示する。数えるのは自分が書いて差し戻されたもの。開いた一覧も自分が書いたものに絞り、期間を問わない（GitHub Issue #174）
    // 旧「未読のチャット」の行は置かない（職員ダッシュボードの項目表 (2-6) に無い。同 項目3 の「旧『未読のチャット』」は未対応の個人チャットに替わった。GitHub Issue #268）
    ...(user.role !== '1'
      ? [{ label: '差し戻された日誌', count: data.returned, unit: '件', to: '/staff/diary?status=4&mine=1' }]
      : []),
    // 管理者にのみ表示する。自分が申請したものは、自分では承認できないため「ほかの管理者へ」と添える（同 項目8）
    ...(user.role === '1'
      ? [{ label: '承認待ちの日誌',
          note: data.pendingOwn > 0 ? `（うち自分の申請 ${data.pendingOwn}件：ほかの管理者へ）` : undefined,
          count: data.pending, unit: '件', to: '/staff/admin/approval' }]
      : []),
    { label: '未対応の個人チャット', note: unhandledNote, count: data.unhandledChat, unit: '件',
      to: firstUnhandled ? `/staff/chat?room=${firstUnhandled.chat_room_id}` : '/staff/chat' },
    // 数える範囲は、参照できる園児の全体。管理者は全クラス、一般は担当クラス（GitHub Issue #125）
    { label: '発達チェックの未実施', count: data.devOverdue, unit: '名', to: '/staff/growth' },
    // 【仮置き】起票したヒヤリハットが下書きのまま（申請していない）ものも数え、名前もそれに合わせる
    // （設計の名前は画面詳細図「職員ダッシュボード」(2-6) 項目9 の「ヒヤリハット未起票の異常時の記録」。web/仮置き値.md。GitHub Issue #142 の 5）
    { label: 'ヒヤリハット未起票・下書きのままの異常時の記録', count: data.abnormalWithoutDiary, unit: '件', to: '/staff/nap/abnormal' },
    /*
     * 誤送信への対応を記録していない取り消し。記録するのは管理者のため、管理者にのみ出す
     * （図/画面詳細図「誤送信対応記録画面（管理者）」(4-4)「この記録は管理者が行う」。GitHub Issue #141 の 3）。
     * 管理者が誤送信対応の画面を自分から開かないと気づけなかった。数える範囲は、同じ画面の「対応の記録がない取り消し」の一覧と同じ。
     * 【仮置き】行の名前と並び（未対応の末尾）は設計に無い。職員ダッシュボードの項目表 (2-6) に無い行である（web/仮置き値.md）
     */
    ...(user.role === '1'
      ? [{ label: '対応の記録がない取り消し', count: data.misdeliveryUnrecorded, unit: '件', to: '/staff/admin/misdelivery', noScope: true }]
      : []),
  ];

  return (
    <div>
      <div className="page-head">
        <h1>ダッシュボード</h1>
        <div className="spacer" />
        <span className="muted">今日 {formatYMD(today())}</span>
      </div>

      {accountChanged && (
        <div style={{ marginBottom: 16 }}>
          <Alert soft>{ACCOUNT_CHANGED_TEXT}</Alert>
        </div>
      )}
      {denied && (
        <div style={{ marginBottom: 16 }}>
          <Alert soft>開こうとした画面は、管理者のみが利用できます。必要な場合は管理者へ依頼してください。</Alert>
        </div>
      )}

      <div className="grid12">
        {/*
          届ける（詳細設計書「職員ダッシュボード（「届ける」の項目）」(2-1)）。デモの道に要る項目を先頭に置く。
          一般は自クラス、管理者は全クラスの数。0 のときも項目を消さず「ありません」と出す。
          園からのひとことを送っていない園児は、今日の午睡で「きょうは対象外（欠席）」にした子を数えない
        */}
        <section className="card col-12 dashboard-deliver" aria-labelledby="dashboard-deliver-title">
          <h2 id="dashboard-deliver-title">届けること</h2>
          <table className="list">
            <tbody>
              <tr>
                <td>家庭からの連絡{scopeNote(scope)}</td>
                <td className="nowrap">
                  {data.homeUnconfirmed + data.homeRevised === 0 ? 'ありません' : (
                    <>
                      <span className={data.homeUnconfirmed > 0 ? 'dashboard-count is-due' : 'dashboard-count'}>未確認 {data.homeUnconfirmed}</span>
                      {'　'}
                      <span className={data.homeRevised > 0 ? 'dashboard-count is-due' : 'dashboard-count'}>更新 {data.homeRevised}</span>
                    </>
                  )}
                </td>
                <td className="nowrap"><Link className="btn btn-sm" to="/staff/contact?sort=home">開く</Link></td>
              </tr>
              <tr>
                <td>園からのひとことを送っていない園児{scopeNote(scope)}</td>
                <td className="nowrap">{data.facilityUnsent === 0 ? 'ありません' : `${data.facilityUnsent} 名`}</td>
                <td className="nowrap"><Link className="btn btn-sm" to="/staff/contact?sort=facility">開く</Link></td>
              </tr>
              <tr>
                <td>午睡中の園児{scopeNote(scope)}</td>
                <td className="nowrap">{data.napSleeping === 0 ? 'ありません' : `${data.napSleeping} 名`}</td>
                <td className="nowrap"><Link className="btn btn-sm" to="/staff/nap">開く</Link></td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* 園内のこと（日誌・発達チェック・異常時の記録） */}
        <section className="card col-7">
          <h2>園内のこと</h2>
          <table className="list">
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>
                    {r.label}{!r.noScope && scopeNote(scope)}
                    {r.note && <div className="muted">{r.note}</div>}
                  </td>
                  <td className="num nowrap">{r.count} {r.unit}</td>
                  <td className="nowrap"><Link className="btn btn-sm" to={r.to}>開く</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* よく使う。先頭は連絡帳。実施中の午睡チェックがあれば、その次に出す（画面詳細図「職員ダッシュボード」(2-6) 項目5・15） */}
        <section className="card col-5">
          <h2>よく使う</h2>
          <div className="stack">
            <Link className="btn btn-block" to="/staff/contact">連絡帳</Link>
            {data.activeNap && (
              <Link className="btn btn-primary btn-block" to="/staff/nap">
                午睡チェックが実施中です（開く）
              </Link>
            )}
            {!data.activeNap && <Link className="btn btn-block" to="/staff/nap">午睡チェックを開始</Link>}
            <Link className="btn btn-block" to="/staff/diary/new">日誌を書く</Link>
            <Link className="btn btn-block" to="/staff/growth/physical">身体測定を入力</Link>
            <Link className="btn btn-block" to="/staff/growth">発達チェックを入力</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
