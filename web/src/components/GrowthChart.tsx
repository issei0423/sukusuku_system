/*
 * 成長グラフ
 * 典拠：図/画面詳細図.md「身体記録画面」(6-2)「身長の推移（基準値の帯を背景に）」
 *
 * 基準値の帯を背景に、その子の測定値を折れ線で重ねる。
 * 帯は分布を示すものであり、はみ出したことをもって異常と判定するものではない。
 * 性別が未回答の園児には基準値を持たないため、帯を描かず測定値のみを示す（基本設計書 5-7）。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { GrowthStandard, PhysicalRecord, Child } from '../api/types';
import { ageInMonths } from '../api/util';

/** viewBox の大きさ。グラフは幅いっぱいに伸び縮みして描く（styles/screens.css の .growth-chart） */
const W = 640;
const H = 300;
/*
 * 【仮置き】目盛りと文の字の、描いたあとの大きさ（CSS px）。表と補足の 14px にそろえる。14px より小さい字は使わない
 * （web/仮置き値.md の「文字の大きさ」。DADS は 14 CSS px 未満を原則として認めない）。
 * SVG は描く幅に合わせて縮むので、字と余白は描いた幅から逆算して viewBox の単位に直す
 */
const FONT_PX = 14;
/** 目盛りの字のための余白（描いたあとの CSS px）。上は単位（cm・kg）を、いちばん上の目盛りの字と重ならない高さに置く分 */
const PAD_PX = { top: 28, right: 16, bottom: 30, left: 46 };
/** 縦の目盛りの数の上限と、目盛りどうしの最小の間隔（字の高さの何倍か） */
const Y_TICKS_MAX = 5;
const TICK_GAP_EM = 1.5;

/** 帯として描くパーセンタイルの組。中央値は線で示す */
const BANDS: [number, number][] = [[3, 97], [10, 90], [25, 75]];
const BAND_OPACITY = [0.10, 0.16, 0.24];

/**
 * 描いた幅（CSS px）を測る。測れない環境（テストの jsdom など）や、まだ描いていないときは null。
 * 幅が変わったら（画面の向き・窓の大きさ）測り直す
 */
function useRenderedWidth() {
  const ref = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = (w: number) => setWidth((prev) => {
      const next = w > 0 ? w : null;
      return prev != null && next != null && Math.abs(prev - next) < 0.5 ? prev : next;
    });
    // 出たときにすぐ測る（ResizeObserver の最初の知らせは次の描画の前まで来ない）。枠線を除いた幅が viewBox に当たる
    apply(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * 文を、1 行 maxChars 字に収まるように折る。読点の後ろ・「ため」の後ろで折ることを先に試し、無ければ字数で折る
 */
function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let rest = text;
  while (rest.length > maxChars && maxChars > 0) {
    let cut = -1;
    for (const m of rest.matchAll(/、|ため/g)) {
      const end = (m.index ?? 0) + m[0].length;
      if (end <= maxChars && end < rest.length) cut = end;
    }
    if (cut <= 0) cut = maxChars;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  lines.push(rest);
  return lines;
}

/*
 * 保護者の成長の記録画面も同じ部品で描く（基本設計書「成長グラフの表示」(4-9)）。保護者の応答には園児と測定記録の
 * 全項目が無いため、描くのに使う項目だけを受け取る（詳細設計書「成長の記録画面（保護者）」(2-11 (1))）
 */
export default function GrowthChart({ child, records, standards, measureType, noBandText }: {
  child: Pick<Child, 'child_name' | 'birth_date'>;
  records: Pick<PhysicalRecord, 'measured_on' | 'height_cm' | 'weight_kg'>[];
  standards: GrowthStandard[] | null;
  measureType: '1' | '2';
  /** 帯を描かないときにグラフの中へ出す文。既定は職員の身体記録画面の文 */
  noBandText?: string;
}) {
  const [svgRef, renderedWidth] = useRenderedWidth();
  // 描いたあとの 1 CSS px が、viewBox の何単位にあたるか。測れないときは viewBox のとおり（1 単位 = 1px）に描くとみなす
  const scale = renderedWidth ? W / renderedWidth : 1;
  const fontSize = FONT_PX * scale;
  const PAD = { top: PAD_PX.top * scale, right: PAD_PX.right * scale, bottom: PAD_PX.bottom * scale, left: PAD_PX.left * scale };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

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

  const x = (m: number) => PAD.left + (m / maxMonth) * plotW;
  const y = (v: number) => H - PAD.bottom - ((v - yLo) / (yHi - yLo)) * plotH;

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
  // 縦の目盛り：字が重ならないよう、描いた高さに入る数まで減らす（狭い画面では 5 より少なくなる）
  const yTicks = Math.max(2, Math.min(Y_TICKS_MAX, Math.floor(plotH / scale / (FONT_PX * TICK_GAP_EM))));
  // 横の目盛り（歳）：字の幅（数字は 0.6 字、「歳」は 1 字とみなす）に半字の間をあけて入らないなら、間引く
  const years = maxMonth / 12;
  const yearLabelPx = (String(years).length * 0.6 + 1) * FONT_PX;
  const yearStep = Math.max(1, Math.ceil((yearLabelPx + FONT_PX / 2) / (plotW / scale / years)));
  // 帯を描かないときの文：グラフの描く範囲の幅に収まるように折る
  const noBandLines = standards
    ? []
    : wrapText(noBandText ?? '性別が未回答のため、基準値の帯は表示しません', Math.floor((plotW / scale - FONT_PX) / FONT_PX));

  return (
    <svg ref={svgRef} className="growth-chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`${child.child_name}の${measureType === '1' ? '身長' : '体重'}の推移`}>
      {/* 目盛 */}
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const v = yLo + ((yHi - yLo) * i) / yTicks;
        return (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--c-border)" strokeWidth={scale} />
            <text x={PAD.left - 6 * scale} y={y(v) + fontSize * 0.35} textAnchor="end" fontSize={fontSize} fill="var(--c-text-sub)">
              {v.toFixed(measureType === '1' ? 0 : 1)}
            </text>
          </g>
        );
      })}
      {Array.from({ length: years + 1 }, (_, i) => i).filter((i) => i % yearStep === 0).map((i) => (
        <text key={i} x={x(i * 12)} y={H - PAD.bottom + 20 * scale} textAnchor="middle" fontSize={fontSize} fill="var(--c-text-sub)">
          {i}歳
        </text>
      ))}
      <text x={PAD.left - 6 * scale} y={PAD.top - 10 * scale} textAnchor="end" fontSize={fontSize} fill="var(--c-text-sub)">{unit}</text>

      {/* 基準値の帯 */}
      {standards
        ? BANDS.map(([lo, hi], i) => {
            const d = bandPath(lo, hi);
            return d ? <path key={`${lo}-${hi}`} d={d} fill="var(--c-primary-deep)" opacity={BAND_OPACITY[i]} /> : null;
          })
        : (
          <text x={PAD.left + plotW / 2} textAnchor="middle" fontSize={fontSize} fill="var(--c-text-weak)">
            {noBandLines.map((line, i) => (
              <tspan key={i} x={PAD.left + plotW / 2}
                y={PAD.top + plotH / 2 + (i - (noBandLines.length - 1) / 2) * fontSize * 1.5 + fontSize * 0.35}>
                {line}
              </tspan>
            ))}
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
