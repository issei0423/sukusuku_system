/*
 * 全機能が共有するユーティリティ
 * 月齢の算出は、機能ごとに実装せず必ずこの関数を呼ぶ（基本設計書.md「月齢の算出」(4-8)）
 */

/** 'YYYY-MM-DD' を年月日に分解する */
function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split('-').map(Number);
  return [y, m, d];
}

/** その年月の末日 */
export function lastDayOfMonth(year: number, month1to12: number): number {
  return new Date(year, month1to12, 0).getDate();
}

/**
 * 月齢を算出する（応当日基準）
 *
 * 基準日の時点で、生年月日の応当日を何回迎えたかを月齢とする。
 * 経過日数を 30 や 30.4375 で割る方式は採らない（要件定義書「月齢の算出規則」(7-1 No.6)）。
 * 応当日が存在しない月（1月31日生まれの2月など）は、その月の末日を応当日とみなす。
 *
 * @param birthDate 生年月日 'YYYY-MM-DD'。月齢算出の唯一の根拠
 * @param baseDate  基準日 'YYYY-MM-DD'。その記録が対象とする日付であり、現在日ではない
 */
export function ageInMonths(birthDate: string, baseDate: string): number {
  const [by, bm, bd] = parts(birthDate);
  const [ny, nm, nd] = parts(baseDate);

  let months = (ny - by) * 12 + (nm - bm);

  // 基準日の月に応当日が存在しなければ、その月の末日を応当日とみなす
  const anniversaryDay = Math.min(bd, lastDayOfMonth(ny, nm));
  if (nd < anniversaryDay) months -= 1;

  return months < 0 ? 0 : months;
}

/** 「1歳3か月」の形に整える。0歳台は「0歳11か月」と出す */
export function formatAge(birthDate: string, baseDate: string): string {
  const m = ageInMonths(birthDate, baseDate);
  return `${Math.floor(m / 12)}歳${m % 12}か月`;
}

/*
 * 日付と時刻は日本標準時（JST）で扱う
 *
 * 記録は日付そのものが意味を持つ（その日の日誌か、その日の午睡か）。
 * 端末の時計の設定で日付が変わると、同じ記録が別の日のものに見えてしまう。
 * 国内の園で使うシステムであり、JST に固定してよい。
 * サーバ側（server/model.go）も同じ扱いにしてある。
 */
const JST_OFFSET_MINUTES = 9 * 60;

/** JST での現在時刻。UTC からの差を足した Date を返すため、読むときは getUTC* を使う */
export function jstNow(): Date {
  const d = new Date();
  return new Date(d.getTime() + JST_OFFSET_MINUTES * 60 * 1000);
}

/** 今日を 'YYYY-MM-DD' で返す（JST） */
export function today(): string {
  const d = jstNow();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** '09/01(月)' の形 */
export function formatMD(iso: string): string {
  const [y, m, d] = parts(iso);
  const w = WEEK[new Date(y, m - 1, d).getDay()];
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}(${w})`;
}

/** '2026/09/01（月）' の形 */
export function formatYMD(iso: string): string {
  const [y, m, d] = parts(iso);
  const w = WEEK[new Date(y, m - 1, d).getDay()];
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}（${w}）`;
}

/** ISO 日時から 'HH:MM' を取り出す */
export function formatHM(isoDateTime: string): string {
  return isoDateTime.slice(11, 16);
}

/** ISO 日時から '09/01 17:20' を取り出す */
export function formatMDHM(isoDateTime: string): string {
  return `${isoDateTime.slice(5, 7)}/${isoDateTime.slice(8, 10)} ${isoDateTime.slice(11, 16)}`;
}

/** 日数を加算した 'YYYY-MM-DD' */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = parts(iso);
  return toISODate(new Date(y, m - 1, d + days));
}

/** サーバ時刻の代わり。モックでは端末の時計を JST に直して用いる */
export function now(): string {
  const d = jstNow();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${today()}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * ISO 日時に分を足す（現地時刻のまま返す）
 *
 * Date#toISOString は UTC を返すため、now() が返す現地時刻の文字列と
 * そのまま比較すると時差のぶんだけずれる。日時の比較は必ずこの関数を通す。
 */
export function plusMinutes(isoDateTime: string, minutes: number): string {
  return formatLocal(new Date(new Date(isoDateTime).getTime() + minutes * 60_000));
}

/** 現在時刻に分を足す（現地時刻） */
export function fromNowMinutes(minutes: number): string {
  return formatLocal(new Date(Date.now() + minutes * 60_000));
}

function formatLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${toISODate(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 終了操作を忘れた午睡チェックを、自動で解除する時刻
 *
 * 午睡の時間帯（マスタ値 nap.time_range）の終了時刻で解除する
 * （基本設計書「午睡チェックの実施」(4-7)）。
 *
 * 【仮置き】時間帯の終了時刻より後に開始した実施は、開始した時点で解除の時刻を過ぎている。
 * 開始した直後に解除しないよう、その日の終わりに解除する（web/仮置き値.md）。
 * サーバ側（server/api_nap.go の napAutoCloseAt）と同じ規則にしてある。
 */
export function napAutoCloseAt(sessionDate: string, startedAt: string, timeRange: string): string {
  const end = /-\s*(\d{2}:\d{2})\s*$/.exec(timeRange)?.[1] ?? '15:00';
  const rangeEnd = `${sessionDate}T${end}:00`;
  return startedAt < rangeEnd ? rangeEnd : `${sessionDate}T23:59:59`;
}

/**
 * 午睡チェックの次の時刻を数える起点
 *
 * いちばん長く確認していない園児を起点にする。未記録の園児がいるあいだは開始時刻が起点になる。
 * 1人を記録しただけでは次の間隔へ進まず、全員を確認し終えてはじめて進む。
 */
export function napTimerBase(startedAt: string, latestCheckedAts: (string | null)[]): string {
  let base: string | null = null;
  for (const at of latestCheckedAts) {
    if (!at) return startedAt;
    if (base === null || at < base) base = at;
  }
  return base ?? startedAt;
}

/**
 * 入力された招待コードを照合用の形に直す
 *
 * 大文字・小文字を区別せず、ハイフンは入力しても省略してもよい
 * （基本設計書「招待コード（t_invitation_code）」(5-2)）。打ち方の違いで失敗させない。
 * 空白は、配布物から書き写すときに紛れ込みやすいため、あわせて取り除く。
 * サーバ側（server/api_auth.go の normalizeInvitationCode）と同じ規則にしてある。
 */
export function normalizeInvitationCode(code: string): string {
  return code.toUpperCase().replace(/[-ー－‐\s]/g, '');
}

/**
 * ログインID（メールアドレス）の必須・桁数・形式を検査する（基本設計書「入力項目の制約値」(4-9)）
 * 問題が無ければ null を返す。届くかどうかまでは確かめない
 */
export function validateEmail(email: string): string | null {
  const v = email.trim();
  if (!v) return 'メールアドレスを入力してください';
  if ([...v].length > 254) return 'メールアドレスは254文字以内で入力してください';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'メールアドレスの形式が正しくありません';
  return null;
}
