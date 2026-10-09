/*
 * 共有範囲設定画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)「項目ごとの保護者への共有可否の設定」
 *      要件定義書「発達チェック」(4-5)「保護者への共有範囲は項目単位の粒度でフラグ管理」
 *
 * 共有しない設定にした項目は、保護者へ渡す記録から落ちる。
 * 記録そのものは園内に残る（共有の可否と、記録の有無は別）。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Alert } from '../../components/ui';

export default function ShareSettingScreen() {
  const { user } = useSession();
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { data, error: loadError, loading } = useAsync(() => api.shareSettings(user!), [tick]);

  const toggle = async (itemId: number, shareable: boolean) => {
    setError(null);
    try {
      await api.setShareable(user!, itemId, shareable);
      setTick((n) => n + 1);
    } catch (e) { setError((e as Error).message); }
  };

  // 区分ごとにまとめる
  const groups = new Map<string, typeof data>();
  data?.forEach((r) => {
    const list = groups.get(r.categoryName) ?? [];
    list.push(r);
    groups.set(r.categoryName, list);
  });

  const hidden = data?.filter((r) => !r.isShareable).length ?? 0;

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/growth">&lt; 発達チェック一覧へ</Link>
        <h1>共有範囲の設定</h1>
        <div className="spacer" />
        <span className="muted">共有しない項目：{hidden} 件</span>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      <section className="card card-sub">
        <div className="muted">
          チェックを外した項目は、保護者へ渡す記録に含めません。園内の記録としては残ります。
          <br />
          受け取り方に配慮が要る項目（自我の芽生え、かんしゃくなど）を落とす想定です。
          共有の可否は、その項目の重要性の評価ではありません。
        </div>
      </section>

      {loading && <Loading />}
      {loadError && <ErrorBox text={loadError} />}
      {data?.length === 0 && <Empty text="チェック項目がマスタに登録されていません。" />}

      {Array.from(groups.entries()).map(([categoryName, rows]) => (
        <section className="card" key={categoryName}>
          <h2>{categoryName}</h2>
          <table className="list">
            <thead><tr><th scope="col" style={{ width: 120 }}>領域</th><th scope="col">項目</th><th scope="col" style={{ width: 160 }}>保護者へ共有</th></tr></thead>
            <tbody>
              {rows!.map((r) => (
                <tr key={r.item.development_item_id}>
                  <td className="nowrap">{r.item.domain}</td>
                  <td>{r.item.item_name}</td>
                  <td>
                    <label>
                      <input type="checkbox" checked={r.isShareable}
                        onChange={(e) => toggle(r.item.development_item_id, e.target.checked)} />
                      {r.isShareable ? '共有する' : '共有しない'}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
