/*
 * 画面に出す文言に、設計書の名前や章番号を出さない（GitHub Issue #144 の 1）
 *
 * 職員や保護者には「（基本設計書 5-7）」のような参照は意味が通じず、園へ見せるデモでも説明が要る。
 * どの定めに基づく文言かは、コードのコメントに書く（AGENTS.md「設計書」）。
 *
 * web/src の .ts・.tsx を TypeScript の構文木で読み、文字列（'…'・"…"・`…`）と JSX の地の文だけを調べる。
 * コメントは構文木に入らないので、典拠を書いたコメントは引っかからない。画面へ出ない文字列（import の
 * パスなど）も調べるが、設計書の名前を書く理由が無いので、そのまま見張りの対象にしている。
 *
 * 名前を書かずに章番号だけで指す形（「（同 5-5）」「（5-7）」「（3-6・4-13）」「第3.7版」）も見張る（CHAPTER_REF）。
 * 保護者アカウント管理画面に「（同 5-5）」が残り、名前だけの見張りでは引っかからなかったため（PR #348 で消した）。
 * 画面に出てよい数字は拾わないように、次の形だけを拾う。
 *   - 括弧の中が章番号だけのもの。章は 1 桁、節は 1〜2 桁（「4-1-2」「4-13 (6)」の形も）。前に「同」を置いたもの、
 *     「・」「、」でつないだものも拾う。括弧の中に単位や「例」などの語があれば拾わない
 *   - 括弧の外の「同 5-5」
 *   - 設計書の版「第3.7版」「第2.x版」（小数点のある版。利用規約の版は「現在の版：1.1」の形で出していて、拾わない）
 * 拾わない数字の形：日付（10-31・04-01・2026-10-31）、時刻（13:00-15:00）、電話番号（03-1234-5678）、
 * 単位の付いた範囲（「1-5 件」「0-2歳児」「2-4列目」）、体温（36.5）、「小数第1位」「第1条」、手順の番号「(1)」。
 * 括弧の中に数字の範囲だけを書くと章番号と見分けられないので、範囲は「1〜5 件」のように単位を付けて書く。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(WEB, 'src');

/** 画面に出てはいけない語。設計書の名前（docs ブランチのファイル名）と、開発の記録の名前 */
const FORBIDDEN = /設計書|要件定義書|画面詳細図|画面遷移図|要決定事項|決定事項\.md|GitHub Issue/;

/** 設計書の章番号 1 つ。「5-7」「4-1-2」「4-13 (6)」。ハイフンは全角・ダッシュも同じに扱う */
const HYPHEN = '[-‐－–]';
const ONE_REF = String.raw`\d${HYPHEN}\d{1,2}(?:${HYPHEN}\d{1,2})*(?:\s*[（(]\d{1,2}[）)])?`;

/** 設計書を章番号だけで指す形（頭のコメントの 3 つ） */
const CHAPTER_REF = new RegExp([
  // 括弧の中が章番号だけ：「（5-7）」「（同 5-5）」「（3-6・4-13）」
  String.raw`[（(]\s*(?:同\s*)?${ONE_REF}(?:\s*[・、,，]\s*${ONE_REF})*\s*[）)]`,
  // 括弧の外の「同 5-5」
  String.raw`同\s*\d${HYPHEN}\d{1,2}(?!\d)`,
  // 設計書の版：「第3.7版」「第2.x版」
  String.raw`第\d+\.(?:\d+|x)版`,
].join('|'));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** ソースの中の文字列と JSX の地の文を、行番号つきで返す。コメントは含まない */
function textsIn(fileName: string, code: string): { line: number; text: string }[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const out: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)
      || ts.isJsxText(node)) {
      out.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** web/src の文字列と JSX の地の文のうち、pattern に当たるものを「ファイル:行 文字列」で返す */
function hitsInSrc(pattern: RegExp): string[] {
  const files = sourceFiles(SRC);
  // 読む場所を誤って 0 件で通ってしまわないように
  expect(files.length).toBeGreaterThan(50);
  return files.flatMap((file) =>
    textsIn(file, readFileSync(file, 'utf8'))
      .filter((t) => pattern.test(t.text))
      .map((t) => `${relative(WEB, file).replaceAll('\\', '/')}:${t.line} ${t.text.trim()}`));
}

describe('画面に出す文言に、設計書の名前や章番号を出さない', () => {
  it('調べ方：文字列と JSX の地の文は拾い、コメントは拾わない', () => {
    const code = [
      '// 基本設計書「画面遷移」(3-4)',
      'const a = "要件定義書";',
      'const b = `画面詳細図 ${a} 基本設計書 5-7`;',
      'export const C = () => (',
      '  <div title=\'画面遷移図\'>',
      '    {/* 基本設計書 5-5 */}',
      '    実施中は自動ログアウトの対象外です（基本設計書 5-7）。',
      '  </div>',
      ');',
    ].join('\n');
    const hits = textsIn('sample.tsx', code).filter((t) => FORBIDDEN.test(t.text)).map((t) => t.line);
    expect(hits).toEqual([2, 3, 3, 5, 7]);
  });

  it('調べ方：章番号だけの参照は拾い、画面に出てよい数字は拾わない', () => {
    const refs = [
      'ただし保護者側からは参照できなくなります（同 5-5）。',
      '実施中は自動ログアウトの対象外です（5-7）。',
      '（同5-5）',
      '( 5-7 )',
      '（3-6・4-13）',
      '（3-6、4-13）',
      '（4-13 (6)）',
      '(4-1-2)',
      '（5－7）',
      '同 5-5 のとおり',
      '第3.7版の定めによる',
      '第2.x版',
    ];
    const allowed = [
      '10-31',
      '2026-10-31',
      '（10-31）',
      '月-日（例 04-01）',
      '（04-01）',
      '13:00-15:00',
      '開始-終了（例 21:00-07:00）',
      '03-1234-5678',
      '（03-1234-5678）',
      '（090-1234-5678）',
      '1-5 件',
      '（1-5 件）',
      '1〜2歳児',
      '（0-2歳児）',
      '0-2歳',
      '（2-4列目）',
      'C101,青木 陽菜,あおき ひな,2025-04-10,2,さくら組,36.6',
      '1〜12 の数をカンマで区切る（例 4,8,12）',
      '体温は小数第1位まで（例：34.9）で入力してください',
      '第1条（本規約について）',
      '現在の版：1.1',
      '(1) 招待コードの入力',
      '（2回目）',
      '（同上）',
      '同じ日の中',
      '乳幼児健診の節目（1歳6か月・3歳・5歳）',
    ];
    expect(refs.filter((s) => !CHAPTER_REF.test(s))).toEqual([]);
    expect(allowed.filter((s) => CHAPTER_REF.test(s))).toEqual([]);
  });

  it('web/src の文字列と JSX の地の文に、設計書の名前が無い', () => {
    expect(hitsInSrc(FORBIDDEN)).toEqual([]);
  });

  it('web/src の文字列と JSX の地の文に、設計書を章番号だけで指す参照が無い', () => {
    expect(hitsInSrc(CHAPTER_REF)).toEqual([]);
  });
});
