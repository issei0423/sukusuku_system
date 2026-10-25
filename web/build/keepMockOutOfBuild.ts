import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { normalizePath, type Plugin } from 'vite';

/*
 * 本番のビルドへモック（src/api/mock.ts と、デモデータの mockDb.ts）を入れない
 *
 * client.ts は VITE_API で http と mock を切り替えるため、両方を読み込んでいる。そのままでは
 * 本番の JS にもデモのパスワードとログインIDが入り、公開先からだれでも読める
 * （持ち主の「開発者ログインを無くして」。ログイン画面の欄は PR #289 で外した。その残り）。
 * dist/ に置いたファイルはだれでも取れるので、別の chunk に分けるだけでは足りない。
 *
 * - 切り替え：VITE_API が mock でないビルドでは、mock.ts への読み込みを noMock.ts（http をそのまま渡す）へ向ける
 * - 見張り：書き出した chunk に mock.ts・mockDb.ts が入っていたら、また dist/ のどれかのファイルに
 *   mockDb.ts のアカウントのパスワードかログインIDがあったら、ビルドを落とす。
 *   印は mockDb.ts からその場で取り出す（パスワードの文字を別の source に増やさないため。デモデータを変えても追いつく）
 *
 * VITE_API の値は、Vite が import.meta.env に入れるのと同じもの（config.env。.env.mock や環境変数から読む）で見る。
 * npm run dev:mock（--mode mock）と VITE_API=mock でのビルドには効かない。
 * vitest は vitest.config.ts だけを読むので、テストにも効かない（相手はモックのまま）。
 *
 * vite.config.ts が読み込む。切り替えと見張りが効くことは tests/keepMockOutOfBuild.test.ts が確かめる。
 */
export function keepMockOutOfBuild(): Plugin {
  let active = false;
  let mockFile = '';
  let mockDbFile = '';
  let stubFile = '';
  let outDir = '';
  return {
    name: 'sukusuku:keep-mock-out-of-build',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      active = config.env.VITE_API !== 'mock';
      mockFile = normalizePath(path.resolve(config.root, 'src/api/mock.ts'));
      mockDbFile = normalizePath(path.resolve(config.root, 'src/api/mockDb.ts'));
      stubFile = normalizePath(path.resolve(config.root, 'src/api/noMock.ts'));
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async resolveId(source, importer, options) {
      if (!active || !importer || !/(^|\/)mock(\.ts)?$/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || normalizePath(resolved.id) !== mockFile) return null;
      return stubFile;
    },
    generateBundle(_options, bundle) {
      if (!active) return;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const leaked = chunk.moduleIds.map((id) => normalizePath(id)).filter((id) => id === mockFile || id === mockDbFile);
        if (leaked.length > 0) {
          this.error(`本番のビルドの ${chunk.fileName} にモックが入った（${leaked.map((id) => path.basename(id)).join('・')}）。web/src からモックを直に読み込んでいないか確かめる`);
        }
      }
    },
    writeBundle() {
      if (!active) return;
      const marks = demoMarks(mockDbFile);
      const hits: string[] = [];
      for (const file of filesUnder(outDir)) {
        const body = readFileSync(file);
        for (const mark of marks) {
          if (body.includes(mark.text)) hits.push(`${normalizePath(path.relative(outDir, file))}：${mark.kind}「${mark.text}」`);
        }
      }
      if (hits.length > 0) {
        this.error(`本番のビルドの dist/ に、モックにしかないデモのアカウントの値がある。\n${hits.join('\n')}`);
      }
    },
  };
}

/** mockDb.ts のアカウントから、見張りの印（パスワードとログインID）を取り出す */
export function demoMarks(mockDbFile: string): { kind: string; text: string }[] {
  const source = readFileSync(mockDbFile, 'utf8');
  const pick = (key: string, kind: string) =>
    [...new Set([...source.matchAll(new RegExp(`\\b${key}: '([^']+)'`, 'g'))].map((m) => m[1]))].map((text) => ({ kind, text }));
  const passwords = pick('password_hash', 'デモのパスワード');
  const loginIds = pick('email', 'デモのログインID');
  if (passwords.length === 0 || loginIds.length === 0) {
    // 印が取れないまま通すと、見張りが黙って効かなくなる。mockDb.ts の書き方が変わったら、ここを合わせる
    throw new Error('mockDb.ts のアカウントから、パスワード（password_hash）とログインID（email）を取り出せなかった。build/keepMockOutOfBuild.ts の demoMarks を合わせる');
  }
  return [...passwords, ...loginIds];
}

/** フォルダの下のファイルを、下の階層まで全部挙げる */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((name) => path.join(dir, name))
    .filter((file) => statSync(file).isFile());
}
