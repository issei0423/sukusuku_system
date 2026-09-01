/*
 * 年度更新画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)「更新内容の一覧確認と実行」
 *      基本設計書.md「年度更新」(4-4)、5-3（m_class は年度ごとに別レコード）
 *
 * 進級先クラスの割り当て規則と卒園の判定条件が未確定のため、本モックでは実行できない。
 * 未確定のまま実行できるようにすると、誤った割り当てが全機能へ波及する。
 */
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Alert } from '../../components/ui';

export default function FiscalYearScreen() {
  const { user } = useSession();
  const { data, error, loading } = useAsync(() => api.previewFiscalYearUpdate(user!), [user?.account_id]);

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="page-head"><h1>年度更新</h1></div>

      {loading && <Loading />}
      {error && <ErrorBox text={error} />}
      {data && (
        <>
          <section className="card">
            <h2>現在の年度の内訳</h2>
            <table className="list">
              <thead><tr><th>クラス</th><th>在籍</th><th>担任</th><th>更新後のクラス</th></tr></thead>
              <tbody>
                {data.classes.map((c) => (
                  <tr key={c.className}>
                    <td className="nowrap">{c.className}</td>
                    <td className="num">{c.childCount} 名</td>
                    <td>{c.staffNames.join('、') || '―'}</td>
                    <td className="muted">未定</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted" style={{ marginTop: 8 }}>
              {data.nextFiscalYear} 年度のクラスを新しいレコードとして作り、在籍と担任を割り当て直します。
              過年度のレコードは残るため、「過去にどのクラスの担任だったか」は判定できます（基本設計書 5-3）。
            </div>
          </section>

          <section className="card">
            <Alert>{data.note}</Alert>
            <div className="muted" style={{ marginTop: 12 }}>
              決めておく必要があること：
              <ul style={{ marginTop: 4 }}>
                <li>進級先クラスの割り当て規則（年齢で自動か、園が手で割り当てるか）</li>
                <li>卒園の判定条件（年齢か、園が個別に指定するか）</li>
                <li>年度更新の実行日時（設定マスタ scope.fiscal_year_update_date の既定は 04-01）</li>
                <li>引き継ぎ猶予期間の扱い（前担任がいつまで参照できるか）</li>
              </ul>
              これらは <code>要決定事項.md</code> に載せて、決まってから実装します。
            </div>
          </section>

          <div className="row-end">
            <button className="btn-primary" disabled title="未確定事項があるため実行できません">
              年度更新を実行する
            </button>
          </div>
        </>
      )}
    </div>
  );
}
