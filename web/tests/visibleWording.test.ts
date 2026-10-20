/*
 * 画面に出す文言に、設計書の名前や章番号を出さない（GitHub Issue #144 の 1）
 *
 * 職員や保護者には「（基本設計書 5-7）」のような参照は意味が通じず、園へ見せるデモでも説明が要る。
 * どの定めに基づく文言かは、コードのコメントに書く（AGENTS.md「設計書」）。
 *
 * web/src の .ts・.tsx を TypeScript の構文木で読み、文字列（'…'・"…"・`…`）と JSX の地の文だけを調べる。
 * コメントは構文木に入らないので、典拠を書いたコメントは引っかからない。画面へ出ない文字列（import の
 * パスなど）も調べるが、設計書の名前を書く理由が無いので、そのまま見張りの対象にしている。
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

describe('画面に出す文言に、設計書の名前を出さない', () => {
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

  it('web/src の文字列と JSX の地の文に、設計書の名前が無い', () => {
    const files = sourceFiles(SRC);
    // 読む場所を誤って 0 件で通ってしまわないように
    expect(files.length).toBeGreaterThan(50);
    const hits = files.flatMap((file) =>
      textsIn(file, readFileSync(file, 'utf8'))
        .filter((t) => FORBIDDEN.test(t.text))
        .map((t) => `${relative(WEB, file).replaceAll('\\', '/')}:${t.line} ${t.text.trim()}`));
    expect(hits).toEqual([]);
  });
});
