/*
 * CSV 出力のセルの無害化（GitHub Issue #153）
 *
 * 出力した CSV は Excel などの表計算ソフトで開かれる。先頭が = + - @ などのセルは式として扱われうる。
 * 保護者が自己登録で入れた氏名は操作ログの操作者としてそのまま出るため、無害化してから出す。
 * 【仮置き】設計に定めが無い（web/仮置き値.md）。
 */
import { describe, it, expect } from 'vitest';
import { csvCell, toCsv } from '../src/csv';

describe('CSV 出力のセル（表計算ソフトで式として扱わせない）', () => {
  it.each(['=2+5+cmd|calc', '+81 90', '-1+1', '@SUM(A1:A2)', '\t=1', '\r=1', '\n=1'])(
    '先頭が式の始まりになる文字のセル %j は、先頭に \' を付ける', (v) => {
      expect(csvCell(v)).toBe(`"'${v}"`);
    },
  );

  it('それ以外はそのまま囲み、" は二重にする', () => {
    expect(csvCell('野原 太郎')).toBe('"野原 太郎"');
    expect(csvCell('a=1')).toBe('"a=1"');
    expect(csvCell('「"引用"」')).toBe('"「""引用""」"');
    expect(csvCell('="1"')).toBe('"\'=""1"""');
    expect(csvCell(36.5)).toBe('"36.5"');
    expect(csvCell(null)).toBe('""');
  });

  it('見出しと行をつないで、1行1レコードにする', () => {
    expect(toCsv(['操作者', '変更後'], [['=2+5+cmd|calc', '申請'], ['野原 一誠', '-']]))
      .toBe(['"操作者","変更後"', '"\'=2+5+cmd|calc","申請"', '"野原 一誠","\'-"'].join('\n'));
  });
});
