/*
 * 受け入れテスト（tests/acceptance）で共に使う値。設定・サーバの起動・レポーター・手助けが同じものを読む。
 *
 * ここを書き換えるのは土台の係だけ。シートの係は *.spec.ts だけを足す（tests/acceptance/README.md）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** web/ */
export const WEB_DIR = path.resolve(here, '..', '..');
/** リポジトリの根 */
export const REPO_DIR = path.resolve(WEB_DIR, '..');
export const SERVER_DIR = path.join(REPO_DIR, 'server');
/** 画面のビルドの置き場（npm run build が作る）。サーバの -web に渡す */
export const DIST_DIR = path.join(WEB_DIR, 'dist');
/**
 * レポートの置き場。Git に入れない（.gitignore）。
 * ハーネスそのものを試すときなど、成績に混ぜたくない回は ACCEPTANCE_REPORT_DIR で別の場所へ向ける
 */
export const REPORT_DIR = process.env.ACCEPTANCE_REPORT_DIR
  ? path.resolve(process.env.ACCEPTANCE_REPORT_DIR)
  : path.join(WEB_DIR, 'acceptance-report');
/** 証跡（スクリーンショット）。ファイル名はケースNo（01-001.png） */
export const SHOTS_DIR = path.join(REPORT_DIR, 'shots');

/** 相手のサーバは、この PC の中だけで待ち受ける */
export const HOST = '127.0.0.1';

/*
 * 【仮置き】受け入れテストの既定のポート。セキュリティ（8199）・レスポンシブ（5186・5187）と重ならない番号。
 * シートの係は自分の番号（T6=8191 … T12=8197）を ACCEPTANCE_PORT で渡す（README.md）
 */
export const DEFAULT_PORT = 8190;

/** @returns {number} */
export function acceptancePort() {
  const raw = process.env.ACCEPTANCE_PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`[acceptance:harness] ACCEPTANCE_PORT は 1024〜65535 の整数にしてください（いま: ${raw}）`);
  }
  return port;
}

/** @param {number} [port] */
export function baseURLFor(port = acceptancePort()) {
  return `http://${HOST}:${port}`;
}

/**
 * 相手が 127.0.0.1 でなければ止める。公開先（本番）や手元の開発サーバへ向けて回さないため
 * （テスト仕様書の決まり「外へ出さない」）。
 * @param {string | undefined | null} url
 */
export function assertLocalBaseURL(url) {
  let host = '';
  try {
    host = new URL(String(url)).hostname;
  } catch {
    // 読めない URL も止める
  }
  if (host !== HOST) {
    throw new Error(`[acceptance:harness] baseURL が ${HOST} ではありません（${url}）。受け入れテストは、ハーネスが自分で立てたサーバにだけ向けます`);
  }
}

/*
 * ケースNo。シート番号2桁と連番3桁（02-001）、入力チェックは I を付ける（02-I001）。
 * テスト名はケースNoと空白で始める（test('02-003 …')）
 */
export const CASE_NO = /^(\d{2}-I?\d{3})(?=\s)/;

/**
 * テスト名の頭のケースNo。無ければ null
 * @param {string} title
 * @returns {string | null}
 */
export function caseNoOf(title) {
  return CASE_NO.exec(title)?.[1] ?? null;
}

/** ハーネスが自分で起こした失敗の印。レポーターはこれが付いた失敗を NG ではなく「未実施」にする */
export const HARNESS_ERROR_MARK = '[acceptance:harness]';

/*
 * 画面の大きさ。職員はタブレットの横向き、保護者はスマートフォンの縦向き
 * （図/画面詳細図「全画面に共通する規定」(0-2) の「端末と向き」）。
 * 【仮置き】寸法は設計に定めが無い。レスポンシブレビュー（playwright.a11y.config.ts）と同じ値にした
 */
export const TABLET = { width: 1024, height: 768 };
export const PHONE = { width: 390, height: 844 };

/** 実施者（成績書の「実施者」）。人が回したときは ACCEPTANCE_TESTER で名前を渡す */
export const DEFAULT_TESTER = 'Claude（AI）';
