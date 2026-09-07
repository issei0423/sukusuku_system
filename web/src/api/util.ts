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
