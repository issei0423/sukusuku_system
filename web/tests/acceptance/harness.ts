/*
 * 受け入れテスト（画面のブラックボックス試験）の手助け。シートの *.spec.ts は、ここから import する。
 *
 *   import { test, expect, login, evidence, ACCOUNTS, PHONE } from './harness';
 *
 * ここがしていること
 *   - サーバ：describe ごとに、使い捨てのデータベースでサーバを立て直す（同じ describe のテストは同じサーバを使う）。
 *     ログインの失敗の数はサーバのメモリにだけあり（server/attempts.go）、立て直せば消えるため。
 *     テストごとに立て直したいときは、describe の中で test.use({ serverScope: 'test' })
 *   - 外へ出さない：baseURL が 127.0.0.1 でなければ止める。ブラウザから 127.0.0.1 以外への要求は止める
 *   - 落ちたとき：evidence() を呼ぶ前に落ちたら、その時点の画面を証跡（<ケースNo>.png）として残す
 *
 * 使い方は README.md。ここを書き換えるのは土台の係だけ（シートの係は *.spec.ts だけを足す）。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { accountOf, passwordOf, type AccountKey, type DemoAccount, type Entrance } from './accounts';
import { HARNESS_ERROR_MARK, HOST, SHOTS_DIR, assertLocalBaseURL, caseNoOf } from './paths.mjs';
import { startServer, type RunningServer } from './start-server.mjs';

export { expect };
export { ACCOUNTS, passwordOf, type AccountKey, type DemoAccount } from './accounts';
export { PHONE, TABLET } from './paths.mjs';

/** 証跡の印（レポーターが読む） */
export const EVIDENCE_ANNOTATION = 'evidence';

// ---- サーバ（ワーカーの中で1つ） ----

let current: { key: string; server: RunningServer } | null = null;

async function stopCurrent() {
  if (!current) return;
  const { server } = current;
  current = null;
  await server.stop();
}

async function serverFor(key: string): Promise<RunningServer> {
  if (current?.key === key) return current.server;
  await stopCurrent();
  const binary = process.env.ACCEPTANCE_BINARY;
  const workDir = process.env.ACCEPTANCE_WORK_DIR;
  if (!binary || !workDir) {
    throw new Error(`${HARNESS_ERROR_MARK} サーバの実行ファイルがありません。npm run test:acceptance（playwright.acceptance.config.ts）から回してください`);
  }
  const server = await startServer({ binary, workDir, label: key });
  current = { key, server };
  return server;
}

/** いま相手にしているサーバ（NG の原因を見るときに、データベースの場所を備考へ書くなど） */
export function serverInfo(): { baseURL: string; dbPath: string } | null {
  return current ? { baseURL: current.server.baseURL, dbPath: current.server.dbPath } : null;
}

/** 127.0.0.1 へ向かう要求か。data: や blob: はブラウザの中で済むので通す */
function isLocalRequest(url: URL): boolean {
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return true;
  return url.hostname === HOST;
}

type TestFixtures = {
  /** サーバを立て直す単位。既定は describe ごと。'test' にすると、テストごとに新しいデータベースで立てる */
  serverScope: 'describe' | 'test';
  /** 自動で効く：このテストの相手のサーバを用意する */
  acceptanceServer: RunningServer;
  /** 自動で効く：落ちたときの証跡 */
  acceptanceShot: void;
};
type WorkerFixtures = {
  /** 自動で効く：ワーカーが終わるときにサーバを止める（残さない） */
  acceptanceWorker: void;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  serverScope: ['describe', { option: true }],

  acceptanceWorker: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright のフィクスチャは、最初の引数を分割代入で書く決まり
    async ({}, provide) => {
      await provide();
      await stopCurrent();
    },
    { scope: 'worker', auto: true },
  ],

  acceptanceServer: [
    async ({ serverScope, baseURL }, provide, testInfo) => {
      assertLocalBaseURL(baseURL);
      // titlePath は [ファイル, describe…, テスト名]。テスト名を除いたものが「同じ describe」の印
      const describeKey = testInfo.titlePath.slice(0, -1).join(' › ');
      const key = serverScope === 'test' ? `${testInfo.titlePath.join(' › ')} #${testInfo.retry}` : describeKey;
      const server = await serverFor(key);
      if (server.baseURL !== new URL(baseURL!).origin) {
        throw new Error(`${HARNESS_ERROR_MARK} baseURL（${baseURL}）と立てたサーバ（${server.baseURL}）が違います。ACCEPTANCE_PORT を確かめてください`);
      }
      await provide(server);
    },
    { auto: true },
  ],

  context: async ({ context }, provide) => {
    /*
     * 公開先や外部のサービスへつながない。127.0.0.1 以外への要求は止め、テストを落とす（結果は「未実施」）。
     * 画面の中からの fetch は、サーバの CSP（default-src 'self'。server/headers.go）がここへ届く前に止める
     */
    const blocked: string[] = [];
    await context.route(
      (url) => !isLocalRequest(url),
      (route) => {
        blocked.push(route.request().url());
        return route.abort('blockedbyclient');
      },
    );
    await provide(context);
    if (blocked.length > 0) {
      throw new Error(`${HARNESS_ERROR_MARK} 127.0.0.1 以外への要求を止めました: ${[...new Set(blocked)].join(', ')}`);
    }
  },

  acceptanceShot: [
    async ({ page }, provide, testInfo) => {
      await provide();
      const caseNo = caseNoOf(testInfo.title);
      const failed = testInfo.status !== testInfo.expectedStatus;
      const taken = testInfo.annotations.some((a) => a.type === EVIDENCE_ANNOTATION);
      if (!failed || !caseNo || taken || page.isClosed()) return;
      try {
        await shoot(page, caseNo, testInfo, true, '落ちた時点の画面');
      } catch {
        // 画面が壊れていて撮れないときは、Playwright の test-results に任せる
      }
    },
    { auto: true },
  ],
});

// ---- 証跡 ----

async function shoot(page: Page, caseNo: string, testInfo: TestInfo, fullPage: boolean, note: string) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const file = `${caseNo}.png`;
  const target = path.join(SHOTS_DIR, file);
  await page.screenshot({ path: target, fullPage, animations: 'disabled', caret: 'hide' });
  await testInfo.attach(`証跡 ${file}`, { path: target, contentType: 'image/png' });
  if (!testInfo.annotations.some((a) => a.type === EVIDENCE_ANNOTATION)) {
    testInfo.annotations.push({ type: EVIDENCE_ANNOTATION, description: file });
  }
  if (note) testInfo.annotations.push({ type: 'evidence-note', description: note });
}

/**
 * 証跡を残す。acceptance-report/shots/<ケースNo>.png に、いまの画面を撮る。
 * 確認事項を確かめ終えたところ（期待する結果が画面に出ている状態）で呼ぶ。
 * 同じテストの中で何度呼んでも、最後の1枚が残る。
 *
 * @param id このテストのケースNo（テスト名の頭と同じもの。違えば止まる）
 * @param options.fullPage 既定は true。ただし、この画面は本文が内側でスクロールするため、
 *   見えている範囲しか写らないことが多い。下のほうを撮るときは、先に scrollIntoViewIfNeeded() で送る（README.md「証跡」）
 */
export async function evidence(page: Page, id: string, options: { fullPage?: boolean } = {}) {
  const testInfo = test.info();
  if (caseNoOf(`${id} `) !== id) {
    throw new Error(`${HARNESS_ERROR_MARK} ケースNoの形ではありません: ${id}（例: 02-003、02-I001）`);
  }
  const own = caseNoOf(testInfo.title);
  if (own !== id) {
    throw new Error(`${HARNESS_ERROR_MARK} 証跡のケースNo（${id}）が、テスト名の頭（${own ?? 'なし'}）と違います`);
  }
  await shoot(page, id, testInfo, options.fullPage ?? true, '');
}

// ---- ログイン ----

/*
 * 入口の URL。設計書は URL を決めていない（図/画面遷移図は画面名だけ）。画面に置いた経路をそのまま使う。
 * 職員用トップ／保護者用トップ（図/画面詳細図「職員用トップ／保護者用トップ」(2-1)）
 */
export const TOP_PATH: Record<Entrance, string> = { staff: '/staff-top', guardian: '/' };

/** 入口のトップを開く。ログインのフォームが出るまで待つ */
export async function gotoTop(page: Page, entrance: Entrance) {
  await page.goto(TOP_PATH[entrance]);
  await expect(page.getByLabel('ログインID', { exact: true })).toBeVisible();
}

/**
 * ログインのフォームに入れる（押さない）。ログインの失敗を確かめるケースで使う。
 * password を渡さなければ、そのアカウントの正しいパスワード（server/seed.sql）を入れる
 */
export async function fillLogin(page: Page, who: DemoAccount | AccountKey, options: { password?: string; email?: string } = {}) {
  const account = accountOf(who);
  await page.getByLabel('ログインID', { exact: true }).fill(options.email ?? account.email);
  await page.getByLabel('パスワード', { exact: true }).fill(options.password ?? passwordOf(account));
}

/**
 * デモアカウントでログインする。入口のトップを開き、ログインID・パスワードを入れて「ログイン」を押し、
 * トップから移るまで待つ。移った先の経路（/staff、/guardian、/password-change、/terms-agree など）を返す。
 * 移らずに誤りが出たら、その文を添えて止まる。
 *
 * @param options.via 開く入口。既定はそのアカウントの系統（誤った系統の入口を試すときに渡す）
 */
export async function login(page: Page, who: DemoAccount | AccountKey, options: { via?: Entrance } = {}): Promise<string> {
  const account = accountOf(who);
  const entrance = options.via ?? account.entrance;
  const top = TOP_PATH[entrance];
  await gotoTop(page, entrance);
  await fillLogin(page, account);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  const moved = page.waitForURL((url) => url.pathname !== top, { timeout: 15_000 }).then(() => true);
  const refused = page.getByRole('alert').first().waitFor({ timeout: 15_000 }).then(() => false);
  const ok = await Promise.race([moved, refused]).catch(() => false);
  if (!ok || new URL(page.url()).pathname === top) {
    const alert = await page.getByRole('alert').first().textContent({ timeout: 1_000 }).catch(() => null);
    throw new Error(`${account.label}でログインできませんでした${alert ? `：「${alert.trim()}」` : ''}`);
  }
  return new URL(page.url()).pathname;
}

// ---- 時刻 ----

/** いまの日本時間の日付（YYYY-MM-DD）。サーバも JST で日付を決める（server/model.go の today()） */
export function jstToday(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
