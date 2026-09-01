/*
 * アレルギー一覧画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)
 *      「アレルギーが登録された園児の一覧。全園児が対象。印刷に対応する」
 *
 * 園児一覧のアレルギー列とは別。こちらは全園児が対象で、給食室・調理室に掲示する用途を想定する。
 * 参照範囲を自クラスに絞らない理由：誤食は担任以外が配膳する場面でも起こるため。
 */
import { useAsync } from '../../hooks';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty } from '../../components/ui';
import { formatYMD } from '../../api/util';

export default function AllergyListScreen() {
  const { data, error, loading } = useAsync(() => api.allAllergies(), []);

  return (
    <div>
      <div className="page-head">
        <h1>アレルギー一覧（全園児）</h1>
        <div className="spacer" />
        <button onClick={() => window.print()}>印刷する</button>
      </div>

      <section className="card card-sub">
        <div className="muted">
          この一覧は<strong>全園児</strong>が対象です。担当するクラスに関係なく表示します。
          誤食は担任以外が配膳する場面でも起こるためです。
          <br />
          アレルギー・既往歴は要配慮個人情報です。印刷したものの取り扱いにご注意ください。
        </div>
      </section>

      <section className="card">
        {loading && <Loading />}
        {error && <ErrorBox text={error} />}
        {data?.length === 0 && <Empty text="アレルギーが登録された園児はいません。" />}
        {data && data.length > 0 && (
          <table className="list">
            <thead>
              <tr><th>クラス</th><th>氏名</th><th>生年月日</th><th>対象</th><th>症状</th><th>対応</th></tr>
            </thead>
            <tbody>
              {data.map((r) =>
                r.allergies.map((a, i) => (
                  <tr key={a.allergy_id}>
                    {i === 0 && <td className="nowrap" rowSpan={r.allergies.length}>{r.className}</td>}
                    {i === 0 && <td className="nowrap" rowSpan={r.allergies.length}><strong>{r.child.child_name}</strong></td>}
                    {i === 0 && <td className="nowrap" rowSpan={r.allergies.length}>{formatYMD(r.child.birth_date)}</td>}
                    <td className="nowrap"><span className="tag tag-returned">{a.target_food}</span></td>
                    <td>{a.symptom}</td>
                    <td>{a.response}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        )}
        {data && <div className="muted" style={{ marginTop: 8 }}>対象 {data.length} 名</div>}
      </section>
    </div>
  );
}
