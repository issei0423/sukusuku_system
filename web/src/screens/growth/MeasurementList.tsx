/*
 * 成長の記録画面（保護者）の測った値の一覧
 * 典拠：詳細設計書「成長の記録画面（保護者）」(2-11 (3))、図/画面詳細図「成長の記録画面（保護者・スマートフォン）」(6-6) の項目6・9
 *
 * 測った日・身長・体重を新しい順に並べる。判定の言葉（「やせ」「標準」など）と色を付けない。
 * その日に登録・上書きしたものに「きょう」を添える。
 */
import type { GrowthMeasurement } from '../../api/shapes';
import { monthDay } from './growthText';

export default function MeasurementList({ rows }: { rows: GrowthMeasurement[] }) {
  return (
    <table className="list growth-measurements">
      <thead><tr><th scope="col">測った日</th><th scope="col">身長</th><th scope="col">体重</th></tr></thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.physical_record_id}>
            <td className="nowrap">
              {monthDay(m.measured_on)}
              {m.is_today && <span className="growth-today">きょう</span>}
            </td>
            {/* 【仮置き】身長は小数第1位まで（web/仮置き値.md） */}
            <td className="num">{m.height_cm.toFixed(1)}cm</td>
            {/* 体重は小数第2位まで（詳細設計書 (2-11 (3))） */}
            <td className="num">{m.weight_kg.toFixed(2)}kg</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
