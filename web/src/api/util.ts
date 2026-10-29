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

/**
 * 日本時間の日時の文字列 'YYYY-MM-DDTHH:MM:SS' を、その時刻のエポックミリ秒にする
 *
 * サーバ・モックが返す日時は時差の印を持たない日本時間である。new Date(文字列) で読むと端末の現地時刻として
 * 読まれ、日本時間以外の端末では時差のぶんだけずれる（MOCKUP.md「日本標準時（JST）に固定している」、GitHub Issue #165）。
 * 端末の時計（Date.now()）と比べるときは、必ずこの関数を通す。
 */
export function jstMs(isoDateTime: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(isoDateTime);
  if (!m) return NaN;
  const [y, mo, d, h, mi, sec] = m.slice(1).map((v) => Number(v ?? 0));
  return Date.UTC(y, mo - 1, d, h, mi, sec) - JST_OFFSET_MINUTES * 60 * 1000;
}

/** 'YYYY-MM-DD' を「2026年10月」の形にする。身体測定の測定回（年月）を示すときに使う */
export function formatYM(iso: string): string {
  const [y, m] = parts(iso);
  return `${y}年${m}月`;
}

/**
 * 小数第1位までで表せる数か（体温。基本設計書「入力項目の制約値」(4-9)「小数第1位まで」）。
 * 浮動小数の誤差（36.7 が 36.700000000000003 になるなど）は許す。サーバ側（server/api_nap.go の oneDecimal）と同じ規則
 */
export function isOneDecimal(v: number): boolean {
  return Number.isFinite(v) && Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
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

/**
 * 現在時刻（now() と同じ JST）に分を足す。
 * 端末の時計の時刻のまま作ると、JST でない端末（UTC で回る CI など）では now() と時差のぶんずれ、
 * ロックの期限（locked_until）がはじめから過ぎていることになる（GitHub Issue #166 の 6 の確かめで見つけた）
 */
export function fromNowMinutes(minutes: number): string {
  return plusMinutes(now(), minutes);
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
 * 入力の文字数を、上限まで符号位置で切る。入力欄の maxLength は UTF-16 の単位で数えるため、4バイトの字（「𠮷」など）を含むと
 * 上限より早く止まる。文字数は文字（符号位置）で数える（詳細設計書「検査の共通の規則」(4-1 (5))。GitHub Issue #310）
 */
export function clampChars(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? chars.slice(0, max).join('') : value;
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

/**
 * 職員アカウントの発行の入力を確かめ、誤りがあれば利用者に見せる文言を返す。問題が無ければ null。
 * 値は前後の空白を除いてから渡す（基本設計書「入力項目の制約値」(4-9)「ログインID（メールアドレス）254文字以内、
 * メールアドレス形式」「氏名 各50文字以内」「園児ID・職員ID 20文字以内」。GitHub Issue #167 の 1）。
 * 画面（職員アカウント管理画面）とモックが使う。サーバ側は server/api_admin.go の validateStaffAccountInput
 */
export function validateStaffAccountInput(staffId: string, staffName: string, email: string, role: string): string | null {
  const length = (v: string) => [...v].length;
  if (!staffId) return '職員IDを入力してください';
  if (length(staffId) > 20) return '職員IDは20文字以内で入力してください';
  if (!staffName) return '氏名を入力してください';
  if (length(staffName) > 50) return '氏名は50文字以内で入力してください';
  if (role !== '1' && role !== '2') return 'ロールの指定が正しくありません';
  const emailError = validateEmail(email);
  return emailError ? emailError.replace('メールアドレス', 'ログインID（メールアドレス）') : null;
}

/**
 * よく使われるため拒否するパスワード。大文字・小文字を区別せずに照らす
 * （基本設計書「パスワードの要件」(6-3)「password などは拒否する」）。
 * 【仮置き】設計は一覧を定めていない（web/仮置き値.md）。サーバ側（server/password.go の commonPasswords）と同じ一覧
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd',
  '12345678', '123456789', '1234567890', '87654321', '11111111',
  '00000000', '88888888', 'qwertyui', 'qwertyuiop', 'asdfghjk',
  'abcd1234', 'abcdefgh', 'iloveyou', '1q2w3e4r', '1qaz2wsx',
  'zaq12wsx', 'sunshine', 'princess', 'football', 'baseball',
]);

/**
 * 新しく設定するパスワードを検査する。問題が無ければ null を返す
 * （基本設計書「入力項目の制約値」(4-9)「パスワード｜8〜128文字。文字種の組み合わせは求めない」）。
 * 長さは文字数（符号位置の数）で数える。サーバ側（server/password.go の validateNewPassword）と同じ規則（GitHub Issue #159）
 */
export function validateNewPassword(p: string): string | null {
  const n = [...p].length;
  if (n < 8) return 'パスワードは8文字以上で入力してください';
  if (n > 128) return 'パスワードは128文字以内で入力してください';
  if (COMMON_PASSWORDS.has(p.toLowerCase())) return 'よく使われるパスワードは使えません。別のパスワードを入力してください';
  return null;
}

/**
 * 'YYYY-MM-DD' の形で、実在する日付か（2025-02-30 や 2025-13-45 を通さない）。
 * 生年月日は月齢算出の唯一の根拠である（基本設計書 5-3）。サーバ側（server/api_bulk.go の validBirthDate）と同じ規則
 * （GitHub Issue #160）
 */
export function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = parts(v);
  return m >= 1 && m <= 12 && d >= 1 && d <= lastDayOfMonth(y, m);
}

/**
 * 平熱・体温を表示する形にする。値が無いときと、数でない値（Infinity・NaN）のときは「―」。
 * サーバは数でない値を返さない（server/model.go の nullFloat）が、表示の側でも崩れないようにしておく
 * （GitHub Issue #160。直す前の CSV 一括登録で平熱に inf が入ったデータベースがありうる）
 */
export function formatTemperature(t: number | null | undefined): string {
  return t != null && Number.isFinite(t) ? t.toFixed(1) : '―';
}

/** 'YYYY-MM' を '2026年10月' の形に整える */
export function formatMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split('-').map(Number);
  return `${y}年${m}月`;
}

/** 今月を 'YYYY-MM' で返す（JST）。days を足した日の月も引ける */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** ファイルの大きさを読みやすい形に整える */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
