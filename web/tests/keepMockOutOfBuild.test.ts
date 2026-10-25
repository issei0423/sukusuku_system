// @vitest-environment node
/*
 * 本番のビルドへモックとデモデータを入れないプラグイン（build/keepMockOutOfBuild.ts）の切り替えと見張り
 *
 * PR #294 で足した見張りは、手で崩して確かめただけで自動のテストが無かった。ここで固める。
 * - 切り替え：mock でないビルドでは、mock.ts への読み込みだけを noMock.ts へ向ける
 * - 見張り：chunk に mock.ts・mockDb.ts が入る、または出力先のファイルにデモのパスワードかログインIDがあると、ビルドを落とす
 * - 印：mockDb.ts のアカウントから、パスワード（password_hash）とログインID（email）を取り出す。取れないときは投げる
 *
 * デモのパスワードやログインIDは、このファイルに文字で書かない（見張りの印を source に増やさないため）。
 * 要るときは mockDb.ts の accounts から取る。
 *
 * フックの this（resolve・error）はテストの中で作る。最後の「本物の Vite のビルド」だけは、
 * 一時フォルダに小さな画面を作って vite の build() を回す。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { build, normalizePath, type Plugin } from 'vite';
import { demoMarks, keepMockOutOfBuild } from '../build/keepMockOutOfBuild';
import { accounts } from '../src/api/mockDb';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mockFile = path.join(webRoot, 'src', 'api', 'mock.ts');
const mockDbFile = path.join(webRoot, 'src', 'api', 'mockDb.ts');
const stubFile = normalizePath(path.join(webRoot, 'src', 'api', 'noMock.ts'));
const clientFile = path.join(webRoot, 'src', 'api', 'client.ts');

const demoPasswords = [...new Set(accounts.map((a) => a.password_hash))];
const demoLoginIds = [...new Set(accounts.map((a) => a.email))];

/* ---------- 下ごしらえ ---------- */

type HookName = 'configResolved' | 'resolveId' | 'generateBundle' | 'writeBundle';
type AnyHook = (this: unknown, ...args: unknown[]) => unknown;

/** フックは関数のことも { handler } のこともあるので、関数を取り出す */
function hookOf(plugin: Plugin, name: HookName): AnyHook {
  const hook = plugin[name] as unknown;
  const fn = typeof hook === 'function' ? hook : (hook as { handler?: unknown } | undefined)?.handler;
  if (typeof fn !== 'function') throw new Error(`プラグインに ${name} が無い`);
  return fn as AnyHook;
}

/**
 * プラグインを作り、Vite が渡す設定の代わりを渡す（プラグインが読むのは env・root・build.outDir だけ）。
 * viteApi を省くと、VITE_API を置かない本番のビルド（npm run build）と同じになる。
 */
function setUp(opts: { viteApi?: string; root?: string; outDir?: string } = {}) {
  const plugin = keepMockOutOfBuild();
  const env: Record<string, string> = opts.viteApi === undefined ? {} : { VITE_API: opts.viteApi };
  hookOf(plugin, 'configResolved').call(undefined, { env, root: opts.root ?? webRoot, build: { outDir: opts.outDir ?? 'dist' } });
  return plugin;
}

/** Rollup の this.error と同じく、呼ばれたらそこで投げる。呼ばれた文も残す */
function errorContext() {
  const errors: string[] = [];
  return {
    errors,
    error(message: string): never {
      errors.push(message);
      throw new Error(message);
    },
  };
}

/** resolveId を呼ぶ。this.resolve は、渡した resolvedId（null なら見つからない）を返す */
async function resolveIdOf(plugin: Plugin, source: string, importer: string | undefined, resolvedId: string | null) {
  const calls: { source: string; importer: string | undefined; options: Record<string, unknown> }[] = [];
  const ctx = {
    async resolve(s: string, i: string | undefined, o: Record<string, unknown>) {
      calls.push({ source: s, importer: i, options: o });
      return resolvedId === null ? null : { id: resolvedId };
    },
  };
  const result = await hookOf(plugin, 'resolveId').call(ctx, source, importer, { isEntry: false });
  return { result, calls };
}

/** generateBundle に渡す bundle の chunk の代わり */
function chunk(fileName: string, moduleIds: string[]) {
  return { type: 'chunk', fileName, moduleIds };
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sukusuku-keep-mock-'));
  tempDirs.push(dir);
  return dir;
}
function writeUnder(dir: string, rel: string, body: string) {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* ---------- 1. 切り替え（resolveId） ---------- */

describe('切り替え：mock でないビルドでは、mock.ts への読み込みだけを noMock.ts へ向ける', () => {
  it('client.ts の ./mock は noMock.ts へ向く。見つけ直しは自分を飛ばして頼む（skipSelf）', async () => {
    const { result, calls } = await resolveIdOf(setUp(), './mock', clientFile, mockFile);
    expect(result).toBe(stubFile);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ source: './mock', importer: clientFile, options: { skipSelf: true } });
  });

  it('VITE_API が mock 以外の値でも向ける。別の書き方（../api/mock.ts）で読み込んでも向ける', async () => {
    const plugin = setUp({ viteApi: 'http' });
    const importer = path.join(webRoot, 'src', 'screens', 'Login.tsx');
    expect((await resolveIdOf(plugin, '../api/mock.ts', importer, mockFile)).result).toBe(stubFile);
    expect((await resolveIdOf(plugin, '../api/mock', importer, mockFile)).result).toBe(stubFile);
  });

  it('VITE_API=mock のときは向けない（見つけ直しもしない）', async () => {
    const { result, calls } = await resolveIdOf(setUp({ viteApi: 'mock' }), './mock', clientFile, mockFile);
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('mock という名前でも、src/api/mock.ts でないファイルは向けない', async () => {
    const plugin = setUp();
    const importer = path.join(webRoot, 'src', 'screens', 'demo', 'Demo.tsx');
    const otherMock = path.join(webRoot, 'src', 'screens', 'demo', 'mock.ts');
    expect((await resolveIdOf(plugin, './mock', importer, otherMock)).result).toBeNull();
    // パッケージの mock も向けない
    expect((await resolveIdOf(plugin, 'mock', importer, path.join(webRoot, 'node_modules', 'mock', 'index.js'))).result).toBeNull();
  });

  it('名前が mock でない読み込み（./mockDb・./http・./mockup）は、見つけ直しもせずそのまま通す', async () => {
    const plugin = setUp();
    for (const source of ['./mockDb', './http', './mockup', './mock.css']) {
      const { result, calls } = await resolveIdOf(plugin, source, clientFile, mockFile);
      expect(result, source).toBeNull();
      expect(calls, source).toHaveLength(0);
    }
  });

  it('読み込み元の無いもの（入口）と、見つからなかったものは、そのまま通す', async () => {
    const plugin = setUp();
    expect((await resolveIdOf(plugin, './mock', undefined, mockFile)).result).toBeNull();
    expect((await resolveIdOf(plugin, './mock', clientFile, null)).result).toBeNull();
  });
});

/* ---------- 2. 見張り：chunk（generateBundle） ---------- */

describe('見張り：書き出す chunk に mock.ts・mockDb.ts が入ったら、ビルドを落とす', () => {
  const cleanIds = [clientFile, path.join(webRoot, 'src', 'api', 'http.ts'), path.join(webRoot, 'src', 'api', 'noMock.ts')];

  it('mock.ts が入った chunk があると落ちる。chunk の名前とファイルの名前を出す', () => {
    const ctx = errorContext();
    const bundle = { 'assets/index.js': chunk('assets/index.js', cleanIds), 'assets/demo.js': chunk('assets/demo.js', [...cleanIds, mockFile]) };
    expect(() => hookOf(setUp(), 'generateBundle').call(ctx, {}, bundle)).toThrow();
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0]).toContain('assets/demo.js');
    expect(ctx.errors[0]).toContain('mock.ts');
  });

  it('mockDb.ts だけが入っても落ちる', () => {
    const ctx = errorContext();
    const bundle = { 'assets/index.js': chunk('assets/index.js', [...cleanIds, mockDbFile]) };
    expect(() => hookOf(setUp(), 'generateBundle').call(ctx, {}, bundle)).toThrow();
    expect(ctx.errors[0]).toContain('mockDb.ts');
  });

  it('どちらも入っていなければ落ちない（chunk でないもの、ほかの mock という名前のファイルは見ない）', () => {
    const ctx = errorContext();
    const bundle = {
      'assets/index.js': chunk('assets/index.js', [...cleanIds, path.join(webRoot, 'src', 'screens', 'demo', 'mock.ts')]),
      'assets/mock.css': { type: 'asset', fileName: 'assets/mock.css', source: '' },
    };
    expect(() => hookOf(setUp(), 'generateBundle').call(ctx, {}, bundle)).not.toThrow();
    expect(ctx.errors).toHaveLength(0);
  });

  it('VITE_API=mock のときは見ない（モックが入るのが正しい）', () => {
    const ctx = errorContext();
    const bundle = { 'assets/index.js': chunk('assets/index.js', [...cleanIds, mockFile, mockDbFile]) };
    expect(() => hookOf(setUp({ viteApi: 'mock' }), 'generateBundle').call(ctx, {}, bundle)).not.toThrow();
    expect(ctx.errors).toHaveLength(0);
  });
});

/* ---------- 3. 見張り：出力先のファイル（writeBundle） ---------- */

describe('見張り：出力先のファイルにデモのパスワードかログインIDがあったら、ビルドを落とす', () => {
  /** 出力先に、値の無いファイルを下の階層まで置く */
  function cleanOutDir(): string {
    const out = tempDir();
    writeUnder(out, 'index.html', '<!doctype html><title>すくすく</title>');
    writeUnder(out, 'assets/index.js', 'console.log("http");');
    writeUnder(out, 'assets/deep/more/chunk.js', 'export const a = 1;');
    return out;
  }

  it('値が無ければ落ちない', () => {
    const ctx = errorContext();
    expect(() => hookOf(setUp({ outDir: cleanOutDir() }), 'writeBundle').call(ctx)).not.toThrow();
    expect(ctx.errors).toHaveLength(0);
  });

  it('下の階層のファイルにデモのパスワードがあると落ちる（アカウントのパスワードを1つずつ）', () => {
    expect(demoPasswords.length).toBeGreaterThan(0);
    for (const [i, password] of demoPasswords.entries()) {
      const out = cleanOutDir();
      writeUnder(out, 'assets/deep/more/leak.js', `const p = ${JSON.stringify(password)};`);
      const ctx = errorContext();
      expect(() => hookOf(setUp({ outDir: out }), 'writeBundle').call(ctx), `パスワード ${i + 1} 個目`).toThrow();
      expect(ctx.errors[0]).toContain('assets/deep/more/leak.js');
      expect(ctx.errors[0]).toContain('デモのパスワード');
    }
  });

  it('デモのログインIDがあると落ちる（アカウントのログインIDを1つずつ。js でないファイルも見る）', () => {
    expect(demoLoginIds.length).toBeGreaterThan(0);
    for (const [i, loginId] of demoLoginIds.entries()) {
      const out = cleanOutDir();
      writeUnder(out, 'assets/notes.txt', `連絡先：${loginId}`);
      const ctx = errorContext();
      expect(() => hookOf(setUp({ outDir: out }), 'writeBundle').call(ctx), `ログインID ${i + 1} 個目`).toThrow();
      expect(ctx.errors[0]).toContain('assets/notes.txt');
      expect(ctx.errors[0]).toContain('デモのログインID');
    }
  });

  it('VITE_API=mock のときは見ない', () => {
    const out = cleanOutDir();
    writeUnder(out, 'assets/index.js', `const a = ${JSON.stringify(accounts[0])};`);
    const ctx = errorContext();
    expect(() => hookOf(setUp({ viteApi: 'mock', outDir: out }), 'writeBundle').call(ctx)).not.toThrow();
    expect(ctx.errors).toHaveLength(0);
  });

  it('mockDb.ts から印が取れないときは、黙って通さずに落ちる', () => {
    const root = tempDir();
    writeUnder(root, 'src/api/mockDb.ts', 'export const accounts = [];\n');
    writeUnder(root, 'dist/index.html', '<!doctype html>');
    expect(() => hookOf(setUp({ root }), 'writeBundle').call(errorContext())).toThrow('demoMarks');
  });
});

/* ---------- 4. 印（demoMarks） ---------- */

describe('印：mockDb.ts のアカウントから、パスワードとログインIDを取り出す', () => {
  it('アカウントのパスワードとログインIDが全部、印に入る', () => {
    const marks = demoMarks(mockDbFile);
    const passwords = marks.filter((m) => m.kind === 'デモのパスワード').map((m) => m.text);
    const loginIds = marks.filter((m) => m.kind === 'デモのログインID').map((m) => m.text);
    expect(passwords).toEqual(expect.arrayContaining(demoPasswords));
    expect(loginIds).toEqual(expect.arrayContaining(demoLoginIds));
    // 同じ値は1つにまとめる
    expect(new Set(marks.map((m) => `${m.kind}\t${m.text}`)).size).toBe(marks.length);
  });

  it.each([
    ['空のファイル', ''],
    ['パスワードが無い', "export const accounts = [{ email: 'someone@sample.invalid' }];\n"],
    ['ログインIDが無い', "export const accounts = [{ password_hash: 'not-a-demo-value' }];\n"],
    ['二重引用符で書いた', 'export const accounts = [{ email: "someone@sample.invalid", password_hash: "not-a-demo-value" }];\n'],
  ])('取れない形（%s）のときは投げる', (_label, body) => {
    const file = path.join(tempDir(), 'mockDb.ts');
    writeFileSync(file, body);
    expect(() => demoMarks(file)).toThrow('demoMarks');
  });

  it('いまの書き方（一重引用符・password_hash: と email:）なら、ほかの形のファイルからも取れる', () => {
    const file = path.join(tempDir(), 'mockDb.ts');
    writeFileSync(file, "export const accounts = [{ email: 'someone@sample.invalid', password_hash: 'not-a-demo-value' }];\n");
    expect(demoMarks(file)).toEqual([
      { kind: 'デモのパスワード', text: 'not-a-demo-value' },
      { kind: 'デモのログインID', text: 'someone@sample.invalid' },
    ]);
  });
});

/* ---------- 本物の Vite のビルド（一時フォルダの小さな画面） ---------- */

describe('本物の Vite のビルドで、切り替えと見張りが効く', () => {
  // 一時フォルダの mockDb.ts に置く、にせの印（本物のデモの値ではない）
  const fakePassword = 'fake-password-for-build-test';
  const fakeLoginId = 'fake-login@build-test.invalid';
  // mock.ts が入ったかどうかの目印
  const mockMarker = 'MOCK-MODULE-WAS-BUNDLED';

  /** client.ts と同じ形で http と mock を読み込む小さな画面を作る */
  function makeProject(main?: string): string {
    const root = tempDir();
    writeUnder(root, 'index.html', '<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>');
    writeUnder(root, 'src/main.ts', main ?? [
      "import * as http from './api/http';",
      "import * as mock from './api/mock';",
      "const impl = import.meta.env.VITE_API === 'mock' ? mock : http;",
      'document.title = impl.name;',
    ].join('\n'));
    writeUnder(root, 'src/api/http.ts', "export const name = 'http';\n");
    writeUnder(root, 'src/api/noMock.ts', "export * from './http';\n");
    // 読み込まれただけで残るよう、目印は副作用で置く（使われないからと木の刈り込みで落ちないように）
    writeUnder(root, 'src/api/mock.ts', [
      "import { accounts } from './mockDb';",
      `(globalThis as Record<string, unknown>).marker = '${mockMarker}' + JSON.stringify(accounts);`,
      "export const name = 'mock';",
    ].join('\n'));
    writeUnder(root, 'src/api/mockDb.ts', `export const accounts = [{ email: '${fakeLoginId}', password_hash: '${fakePassword}' }];\n`);
    return root;
  }

  /** VITE_API を決めてビルドする。vitest.config.ts が process.env に VITE_API=mock を入れているので、回すあいだだけ置き換える */
  async function viteBuild(root: string, viteApi: string | undefined) {
    const saved = process.env.VITE_API;
    if (viteApi === undefined) delete process.env.VITE_API;
    else process.env.VITE_API = viteApi;
    try {
      await build({
        root,
        configFile: false,
        envDir: root,
        logLevel: 'silent',
        plugins: [keepMockOutOfBuild()],
        build: { outDir: 'dist', emptyOutDir: true },
      });
    } finally {
      if (saved === undefined) delete process.env.VITE_API;
      else process.env.VITE_API = saved;
    }
  }

  /** dist/ のファイルを全部つないだ中身 */
  function distText(root: string): string {
    const dist = path.join(root, 'dist');
    return readdirSync(dist, { recursive: true, encoding: 'utf8' })
      .map((name) => path.join(dist, name))
      .filter((file) => statSync(file).isFile())
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
  }

  it('VITE_API を置かないビルドは通り、dist にモックもにせの印も入らない', async () => {
    const root = makeProject();
    await viteBuild(root, undefined);
    const text = distText(root);
    expect(text).toContain('http');
    expect(text).not.toContain(mockMarker);
    expect(text).not.toContain(fakePassword);
    expect(text).not.toContain(fakeLoginId);
  }, 30_000);

  it('VITE_API=mock のビルドは、モックを入れたまま通る', async () => {
    const root = makeProject();
    await viteBuild(root, 'mock');
    const text = distText(root);
    expect(text).toContain(mockMarker);
    expect(text).toContain(fakePassword);
  }, 30_000);

  it('画面が mockDb.ts を直に読み込むと、ビルドが落ちる', async () => {
    const root = makeProject([
      "import { accounts } from './api/mockDb';",
      'document.title = String(accounts.length);',
    ].join('\n'));
    await expect(viteBuild(root, undefined)).rejects.toThrow('mockDb.ts');
  }, 30_000);

  it('public/ に置いたファイルにログインIDがあると、ビルドが落ちる', async () => {
    const root = makeProject();
    writeUnder(root, 'public/docs/accounts.txt', `ログインID：${fakeLoginId}`);
    await expect(viteBuild(root, undefined)).rejects.toThrow('docs/accounts.txt');
  }, 30_000);
});
