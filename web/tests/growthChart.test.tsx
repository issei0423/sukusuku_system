// @vitest-environment jsdom
/*
 * 成長グラフの字は、描いたあとの大きさで 14px 以上にする（身体記録画面・保護者の成長の記録画面で同じ部品）
 * 典拠：DADS「タイポグラフィ」（14 CSS px 未満は原則として使わない）、web/仮置き値.md の「14px より小さい文字は使わない」
 *
 * SVG は viewBox（幅 640）を描く幅に合わせて縮めるので、字の大きさは描いた幅から逆算する。
 * jsdom は幅を測れない（0 を返す）ので、幅は clientWidth と ResizeObserver を差し替えて与える。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import GrowthChart from '../src/components/GrowthChart';

const VIEWBOX_W = 640;
const child = { child_name: '西田 太郎', birth_date: '2025-06-01' };
const records = [
  { measured_on: '2025-12-01', height_cm: 67.8, weight_kg: 7.6 },
  { measured_on: '2026-03-01', height_cm: 71.2, weight_kg: 8.4 },
  { measured_on: '2026-06-01', height_cm: 74.5, weight_kg: 9.1 },
];

/** 字の、描いたあとの大きさ（CSS px）。viewBox の単位の字の大きさ × 描いた幅 / viewBox の幅 */
function renderedFontPx(width: number) {
  return Array.from(document.querySelectorAll('svg.growth-chart text')).map((t) =>
    Number(t.getAttribute('font-size')) * (width / VIEWBOX_W));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('成長グラフの字の大きさ', () => {
  it('幅を測れないときは、viewBox のとおりに 14 で描く', () => {
    render(<GrowthChart child={child} records={records} standards={null} measureType="1" />);
    const sizes = Array.from(document.querySelectorAll('svg.growth-chart text')).map((t) => t.getAttribute('font-size'));
    expect(sizes.length).toBeGreaterThan(0);
    expect(new Set(sizes)).toEqual(new Set(['14']));
  });

  it('スマートフォンの幅（322px）でも、描いたあとの字は 14px。帯を描かない文は描く範囲に収まるように折る', () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(322);
    render(<GrowthChart child={child} records={records} standards={null} measureType="2"
      noBandText="性別が未回答のため成長曲線を表示できません" />);
    for (const px of renderedFontPx(322)) expect(px).toBeCloseTo(14, 5);
    // 縦の目盛りは、字の高さの 1.5 倍より詰めない（描く高さ 322 × 300 / 640 ≒ 151px、余白を除いて 93px → 間は 4 つ）
    const yLabels = Array.from(document.querySelectorAll('svg.growth-chart g text'));
    expect(yLabels).toHaveLength(5);
    const lines = Array.from(document.querySelectorAll('svg.growth-chart tspan')).map((t) => t.textContent);
    expect(lines).toEqual(['性別が未回答のため', '成長曲線を表示できません']);
  });

  it('描く幅が変わったら測り直す（PC の広い幅でも、描いたあとの字は 14px のまま）', () => {
    let notify: ((entries: { contentRect: { width: number } }[]) => void) | null = null;
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: (entries: { contentRect: { width: number } }[]) => void) { notify = cb; }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(362);
    render(<GrowthChart child={child} records={records} standards={null} measureType="1" />);
    for (const px of renderedFontPx(362)) expect(px).toBeCloseTo(14, 5);
    act(() => notify?.([{ contentRect: { width: 1000 } }]));
    for (const px of renderedFontPx(1000)) expect(px).toBeCloseTo(14, 5);
    // 広い幅では縦の目盛りを 5 つの間で描く
    expect(document.querySelectorAll('svg.growth-chart g text')).toHaveLength(6);
  });
});
