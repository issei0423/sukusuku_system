/*
 * 月齢の算出のテスト
 * 典拠：要件定義書「月齢の算出規則」(7-1 No.6)、基本設計書「月齢の算出」(4-8)
 *
 * mockup ブランチの実装は応当日が存在しない月の扱いを持たなかった（GitHub Issue #54）。
 * ここではその境界を明示的に固定する。
 */
import { describe, it, expect } from 'vitest';
import { ageInMonths, formatAge, lastDayOfMonth } from '../src/api/util';

describe('ageInMonths（応当日基準）', () => {
  it('応当日を迎えた日に月齢が上がる', () => {
    expect(ageInMonths('2025-06-01', '2025-06-30')).toBe(0);
    expect(ageInMonths('2025-06-01', '2025-07-01')).toBe(1);
    expect(ageInMonths('2025-06-01', '2026-06-01')).toBe(12);
  });

  it('応当日の前日はまだ月齢が上がらない', () => {
    expect(ageInMonths('2025-06-15', '2025-07-14')).toBe(0);
    expect(ageInMonths('2025-06-15', '2025-07-15')).toBe(1);
  });

  it('応当日が存在しない月は、その月の末日を応当日とみなす（1月31日生まれの2月）', () => {
    // 2026年2月は28日まで。31日の応当日は存在しないため28日を応当日とみなす
    expect(lastDayOfMonth(2026, 2)).toBe(28);
    expect(ageInMonths('2026-01-31', '2026-02-27')).toBe(0);
    expect(ageInMonths('2026-01-31', '2026-02-28')).toBe(1);
    expect(ageInMonths('2026-01-31', '2026-03-30')).toBe(1);
    expect(ageInMonths('2026-01-31', '2026-03-31')).toBe(2);
  });

  it('うるう年の2月29日も同じ規則で扱う', () => {
    expect(lastDayOfMonth(2028, 2)).toBe(29);
    expect(ageInMonths('2028-01-31', '2028-02-28')).toBe(0);
    expect(ageInMonths('2028-01-31', '2028-02-29')).toBe(1);
  });

  it('経過日数を30や30.4375で割る方式は採らない', () => {
    // 30日割りなら 365/30 = 12.16 → 12 だが、31日周期の月が多い年は応当日基準と食い違う
    // 2025-01-31 生まれ、2025-12-31 時点。応当日基準では11か月
    expect(ageInMonths('2025-01-31', '2025-12-31')).toBe(11);
  });

  it('基準日が生年月日より前なら0を返す', () => {
    expect(ageInMonths('2026-01-01', '2025-12-31')).toBe(0);
  });
});

describe('formatAge', () => {
  it('歳と月に分けて表す', () => {
    expect(formatAge('2025-06-01', '2026-09-01')).toBe('1歳3か月');
    expect(formatAge('2025-06-01', '2026-05-31')).toBe('0歳11か月');
  });
});
