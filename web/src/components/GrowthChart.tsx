/*
 * 成長グラフ
 * 典拠：図/画面詳細図.md「身体記録画面」(6-2)「身長の推移（基準値の帯を背景に）」
 *
 * 基準値の帯を背景に、その子の測定値を折れ線で重ねる。
 * 帯は分布を示すものであり、はみ出したことをもって異常と判定するものではない。
 * 性別が未回答の園児には基準値を持たないため、帯を描かず測定値のみを示す（基本設計書 5-7）。
 */
import type { GrowthStandard, PhysicalRecord, Child } from '../api/types';
import { ageInMonths } from '../api/util';

const W = 640;
const H = 300;
const PAD = { top: 16, right: 16, bottom: 34, left: 46 };

/** 帯として描くパーセンタイルの組。中央値は線で示す */
const BANDS: [number, number][] = [[3, 97], [10, 90], [25, 75]];
const BAND_OPACITY = [0.10, 0.16, 0.24];

export default function GrowthChart({ child, records, standards, measureType }: {
  child: Child;
  records: PhysicalRecord[];
  standards: GrowthStandard[] | null;
  measureType: '1' | '2';
}) {
  const points = records
    .map((r) => ({
      m: ageInMonths(child.birth_date, r.measured_on),
      v: measureType === '1' ? r.height_cm : r.weight_kg,
      on: r.measured_on,
    }))
    .sort((a, b) => a.m - b.m);

  // 表示範囲。測定値が収まるだけの月齢幅にそろえる
  const maxMonth = Math.max(12, Math.ceil((points.at(-1)?.m ?? 12) / 12) * 12 + 12);
  const byMonth = (m: number, p: number) =>
    standards?.find((s) => s.age_in_months === m && s.percentile === p)?.standard_value;

  const values: number[] = [...points.map((p) => p.v)];
  if (standards) {
    for (let m = 0; m <= maxMonth; m++) {
      const lo = byMonth(m, 3); const hi = byMonth(m, 97);
      if (lo != null) values.push(lo);
      if (hi != null) values.push(hi);
    }
  }
  const vMin = values.length ? Math.min(...values) : 0;
  const vMax = values.length ? Math.max(...values) : 1;
  const pad = (vMax - vMin) * 0.08 || 1;
  const yLo = vMin - pad;
  const yHi = vMax + pad;

  const x = (m: number) => PAD.left + (m / maxMonth) * (W - PAD.left - PAD.right);
  const y = (v: number) => H - PAD.bottom - ((v - yLo) / (yHi - yLo)) * (H - PAD.top - PAD.bottom);

  const bandPath = (lo: number, hi: number) => {
    const up: string[] = []; const down: string[] = [];
    for (let m = 0; m <= maxMonth; m++) {
      const a = byMonth(m, hi); const b = byMonth(m, lo);
      if (a == null || b == null) continue;
      up.push(`${x(m)},${y(a)}`);
      down.unshift(`${x(m)},${y(b)}`);
    }
    if (up.length === 0) return '';
    return `M ${up.join(' L ')} L ${down.join(' L ')} Z`;
  };

  const medianPath = () => {
    const pts: string[] = [];
    for (let m = 0; m <= maxMonth; m++) {
      const v = byMonth(m, 50);
      if (v != null) pts.push(`${x(m)},${y(v)}`);
    }
    return pts.length ? `M ${pts.join(' L ')}` : '';
  };

  const unit = measureType === '1' ? 'cm' : 'kg';
  const yTicks = 5;

  return (
    <svg className="growth-chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`${child.child_name}の${measureType === '1' ? '身長' : '体重'}の推移`}>
      {/* 目盛 */}
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const v = yLo + ((yHi - yLo) * i) / yTicks;
        return (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--c-border)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--c-text-sub)">
              {v.toFixed(measureType === '1' ? 0 : 1)}
            </text>
          </g>
        );
      })}
      {Array.from({ length: maxMonth / 12 + 1 }, (_, i) => (
        <text key={i} x={x(i * 12)} y={H - PAD.bottom + 16} textAnchor="middle" fontSize={11} fill="var(--c-text-sub)">
          {i}歳
        </text>
      ))}
      <text x={PAD.left - 6} y={PAD.top - 4} textAnchor="end" fontSize={11} fill="var(--c-text-sub)">{unit}</text>

      {/* 基準値の帯 */}
      {standards
        ? BANDS.map(([lo, hi], i) => {
            const d = bandPath(lo, hi);
            return d ? <path key={`${lo}-${hi}`} d={d} fill="var(--c-primary-deep)" opacity={BAND_OPACITY[i]} /> : null;
          })
        : (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={13} fill="var(--c-text-weak)">
            性別が未回答のため、基準値の帯は表示しません
          </text>
        )}
      {standards && <path d={medianPath()} fill="none" stroke="var(--c-primary-deep)" strokeWidth={1.5} strokeDasharray="4 3" />}

      {/* 測定値 */}
      {points.length > 1 && (
        <path d={`M ${points.map((p) => `${x(p.m)},${y(p.v)}`).join(' L ')}`}
          fill="none" stroke="var(--c-text)" strokeWidth={2} />
      )}
      {points.map((p) => (
        <g key={p.on}>
          <circle cx={x(p.m)} cy={y(p.v)} r={4} fill="var(--c-surface)" stroke="var(--c-text)" strokeWidth={2} />
          <title>{p.on}　{p.v} {unit}（{p.m} か月）</title>
        </g>
      ))}
    </svg>
  );
}
