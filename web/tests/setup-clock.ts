/*
 * テストの時計を、日本時間の今日の 18:00 で止める（GitHub Issue #152）
 *
 * デモデータは「今日」の出来事を 07:40〜17:20 に置いている（src/api/mockDb.ts）。
 * 本物の時計のまま夜中や朝に回すと、それらが「いまより先」の出来事になり、
 * 「登録より前のメッセージは見せない」のように前後を比べるテストが落ちる。
 * 回した時刻で結果が変わらないよう、今日のデモの出来事がすべて済んだ 18:00 に時計を置く。
 *
 * - 日付は本物のまま（日本時間の今日）。デモデータは起動した日へ日付をずらすため
 * - 偽物にするのは Date だけ。setTimeout などのタイマーは本物のまま動く
 * - 時計は止まっている。時間の経過が要るテストは vi.advanceTimersByTime で進める
 *   （本物の時間を待っても Date は進まない）
 * - テストファイルを読み込む前（デモデータを組み立てる前）に掛かる。
 *   デモの編集ロックは読み込んだ時刻を使うため、あとから時計を動かすと食い違う
 *
 * 時計を自分で扱うテスト（screens.test.tsx・autoRefresh.test.tsx・integration.test.ts）は、
 * そのファイルの中で vi.useFakeTimers / vi.useRealTimers を呼ぶ。呼んだあとはそちらが優先される。
 *
 * 別の時刻で回して、時刻に頼っているテストを探すときは SUKUSUKU_TEST_CLOCK に HH:MM を渡す。
 *   SUKUSUKU_TEST_CLOCK=03:00 npx vitest run
 */
import { vi } from 'vitest';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const clock = process.env.SUKUSUKU_TEST_CLOCK || '18:00';
const hm = /^(\d{2}):(\d{2})$/.exec(clock);
if (!hm) throw new Error(`SUKUSUKU_TEST_CLOCK は HH:MM の形で渡す（受け取った値：${clock}）`);

// 日本時間の今日の日付は、本物の時計から取る
const jstToday = new Date(Date.now() + JST_OFFSET_MS);
const start = Date.UTC(
  jstToday.getUTCFullYear(), jstToday.getUTCMonth(), jstToday.getUTCDate(), Number(hm[1]), Number(hm[2]),
) - JST_OFFSET_MS;

vi.useFakeTimers({ toFake: ['Date'], now: start });
