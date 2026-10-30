/*
 * 設定のキーごとの区画・既定値・検査（server/settings_spec.go と同じ表）。
 * 典拠：詳細設計書「設定ごとの検査」(4-10 (3))、基本設計書「設定マスタ（m_setting）」(5-9) の既定値の表。
 * 文言は「〇〇は△△で入力してください。」の形にそろえる（範囲は演習上の想定。決めたこと D-46）。
 * モックの settingsApi（mock.ts）が検査に使い、設定画面は SETTING_ORDER と SETTING_SPECS の editable を読む。
 */
import type { SettingRow } from './shapes';

export interface SettingSpec {
  group: SettingRow['group'];
  def: string;
  editable: boolean;
  /** 誤りの文言。正しければ null。editable が偽のキーは使わない */
  check: (v: string) => string | null;
  /**
   * 画面から保存できるが、この版ではその値を読む処理がまだ無い（「効くか」の印）。設定画面の行に「保存しても動きには効きません」を添える。
   * 読む処理を作ったら外す。server/settings_spec.go の settingNoEffect と同じ7つ（【仮置き】照合 c2a-X の推し。web/仮置き値.md）
   */
  noEffect?: true;
}

/** その設定の値を読む処理が、この版ではまだ無いことの印を付ける */
const noEffect = (s: SettingSpec): SettingSpec => ({ ...s, noEffect: true });

export const SETTING_MSG = {
  showItems: '保護者へ出す項目に、選べない値か重なった値が入っています。画面を読み込み直してください。',
  homeItems: '「家庭から」の項目は、1つ以上選んでください。',
  quietHoursFormat: '通知を送らない時間帯は、5分刻みの「開始-終了」（例 21:00-07:00）で入力してください。',
  quietHoursSame: '開始と終了は違う時刻にしてください。',
  heightOrder: '身長の下限は上限より小さくしてください。',
  weightOrder: '体重の下限は上限より小さくしてください。',
  badChoice: '選べない値が入っています。画面を読み込み直してください。',
} as const;

/** 符号・空白・先頭の0を許さない整数（server の strictInt。9桁まで） */
function strictInt(v: string): number | null {
  return /^(0|[1-9][0-9]{0,8})$/.test(v) ? Number(v) : null;
}

const intCheck = (label: string, lo: number, hi: number) => (v: string) => {
  const n = strictInt(v);
  return n === null || n < lo || n > hi ? `${label}は${lo}〜${hi}の整数で入力してください。` : null;
};

const intListCheck = (label: string, lo: number, hi: number) => (v: string) => {
  const seen = new Set<number>();
  for (const p of v.split(',')) {
    const n = strictInt(p);
    if (n === null || n < lo || n > hi || seen.has(n)) return `${label}は、${lo}〜${hi}の整数をカンマで区切って（重ねずに）入力してください。`;
    seen.add(n);
  }
  return null;
};

/** 小数は places 桁まで。符号・指数・先頭の0を許さない（server の parseDecimal） */
export function parseDecimal(v: string, places: number): number | null {
  const [whole, frac, ...rest] = v.split('.');
  if (rest.length > 0 || strictInt(whole) === null) return null;
  if (frac !== undefined && !(frac.length >= 1 && frac.length <= places && /^[0-9]+$/.test(frac))) return null;
  return Number(v);
}

const decimalCheck = (label: string, lo: number, hi: number, places: number) => (v: string) => {
  const n = parseDecimal(v, places);
  return n === null || n < lo || n > hi
    ? `${label}は${lo.toFixed(places)}〜${hi.toFixed(places)}の数値（小数第${places}位まで）で入力してください。` : null;
};

/** allowed のうちのいくつか（min 個以上）を重ねずにカンマで並べたものか。空は 0 個 */
const pickFrom = (v: string, allowed: string[], min: number) => {
  if (v === '') return min === 0;
  const seen = new Set<string>();
  for (const p of v.split(',')) {
    if (!allowed.includes(p) || seen.has(p)) return false;
    seen.add(p);
  }
  return seen.size >= min;
};

const len = (v: string) => [...v].length;

/** 排せつ・きげんの選択肢（1つ以上。1つ1〜20文字。カンマと改行を含めない。重ねない。全体100文字以内） */
const choicesCheck = (label: string) => (v: string) => {
  if (/[\r\n]/.test(v)) return `${label}に改行は入れられません。`;
  const seen = new Set<string>();
  for (const p of v.split(',')) {
    if (p !== p.trim() || len(p) < 1 || len(p) > 20) return `${label}は、1つ以上、1つ1〜20文字（前後に空白を入れない）で入力してください。`;
    if (seen.has(p)) return `${label}に同じ言葉があります。`;
    seen.add(p);
  }
  return len(v) > 100 ? `${label}は、つないで100文字以内にしてください。` : null;
};

/** 「HH:mm-HH:mm」を、その日の0時からの分に直す。形が違えば null */
export function parseHourRange(v: string): [number, number] | null {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  return [h1 * 60 + m1, h2 * 60 + m2];
}

/** 「MM-DD」が実在する月日か（2月29日は不可） */
function isMonthDay(v: string): boolean {
  const m = /^(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const mo = Number(m[1]), d = Number(m[2]);
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1];
}

const readOnly = (group: SettingRow['group'], def: string): SettingSpec => ({ group, def, editable: false, check: () => null });
const spec = (group: SettingRow['group'], def: string, check: SettingSpec['check']): SettingSpec => ({ group, def, editable: true, check });
const other = (def: string, check: SettingSpec['check']) => spec('other', def, check);

export const SETTING_SPECS: Record<string, SettingSpec> = {
  // 連絡帳
  'contact.show_items': spec('contact', 'nap,meal,toilet,temperature,comment,photo,class',
    (v) => (pickFrom(v, ['nap', 'meal', 'toilet', 'temperature', 'comment', 'photo', 'class'], 0) ? null : SETTING_MSG.showItems)),
  'contact.home_items': spec('contact', 'temperature,night_sleep,breakfast,mood,pickup,message',
    (v) => (pickFrom(v, ['temperature', 'night_sleep', 'breakfast', 'mood', 'pickup', 'message'], 1) ? null : SETTING_MSG.homeItems)),
  'contact.toilet_choices': spec('contact', 'おしっこ,うんち,おむつ交換,トイレでできた', choicesCheck('排せつの選択肢')),
  'contact.mood_choices': spec('contact', 'ごきげん,ふつう,ごきげんななめ', choicesCheck('きげんの選択肢')),
  // 通知
  'push.quiet_hours': noEffect(spec('notify', '21:00-07:00', (v) => {
    const r = parseHourRange(v);
    if (!r || r[0] % 5 !== 0 || r[1] % 5 !== 0) return SETTING_MSG.quietHoursFormat;
    return r[0] === r[1] ? SETTING_MSG.quietHoursSame : null;
  })),
  // AI
  'ai.enabled': spec('ai', '0', (v) => (v === '0' || v === '1' ? null : SETTING_MSG.badChoice)),
  'ai.daily_limit': spec('ai', '300', intCheck('1日の上限回数', 1, 10000)),
  // そのほか
  'facility.name': other('', (v) => (v.trim() === '' || len(v) > 50 ? '園の名称は1〜50文字で入力してください。' : null)),
  'facility.phone_number': other('', (v) => (len(v) > 20 || /[^0-9-]/.test(v) ? '園の電話番号は、数字とハイフンの20文字以内で入力してください。' : null)),
  'nap.interval_minutes.age0': other('5', intCheck('午睡のチェック間隔（0歳児）', 1, 15)),
  'nap.interval_minutes.age1': other('10', intCheck('午睡のチェック間隔（1歳児）', 1, 15)),
  'nap.interval_minutes.age2': other('15', intCheck('午睡のチェック間隔（2歳児以上）', 1, 15)),
  'nap.time_range': other('13:00-15:00', (v) => {
    const r = parseHourRange(v);
    return !r || r[0] >= r[1] ? '午睡の時間帯は、同じ日の中の「開始-終了」（開始より終了が後。例 13:00-15:00）で入力してください。' : null;
  }),
  'auth.max_failed_login': other('5', intCheck('ログイン失敗の上限回数', 3, 10)),
  'auth.lock_minutes': other('30', intCheck('ロックの待機時間', 1, 1440)),
  'auth.remember_days': other('30', intCheck('ログイン情報を覚えておく日数', 1, 90)),
  'auth.temp_password_hours': other('48', intCheck('一時パスワードの有効時間', 1, 168)),
  'ui.auto_logout_minutes': other('30', intCheck('自動ログアウトまでの無操作の時間', 5, 120)),
  'ui.diary_lock_minutes': other('15', intCheck('日誌の編集ロックの無操作の時間', 5, 60)),
  'scope.handover_grace_days': noEffect(other('30', intCheck('職員の引き継ぎ猶予期間', 1, 90))),
  'scope.guardian_grace_days': noEffect(other('30', intCheck('保護者の猶予期間', 1, 90))),
  'scope.fiscal_year_update_date': noEffect(other('04-01', (v) => (isMonthDay(v) ? null : '年度更新の実行日は、実在する月日の「MM-DD」（2月29日は不可）で入力してください。'))),
  'physical.measure_months': noEffect(other('4,8,12', intListCheck('身体測定を行う月', 1, 12))),
  'physical.height_min': other('40', decimalCheck('身長の下限', 20, 200, 1)),
  'physical.height_max': other('140', decimalCheck('身長の上限', 20, 200, 1)),
  'physical.weight_min': other('2', decimalCheck('体重の下限', 0.5, 100, 2)),
  'physical.weight_max': other('40', decimalCheck('体重の上限', 0.5, 100, 2)),
  'dev.milestone_months': other('18,36,60', intListCheck('乳幼児健診の節目の月齢', 1, 72)),
  'dev.notice_days_before': other('7', intCheck('発達チェックの予定日が近いとする日数', 1, 60)),
  'attachment.max_size_mb': other('10', intCheck('添付ファイルの上限サイズ', 1, 20)),
  'attachment.max_count_diary': other('3', intCheck('日誌の写真の上限枚数', 1, 3)),
  'retention.record_years': noEffect(other('5', intCheck('記録の保持年数', 1, 30))),
  'retention.attachment_years': noEffect(other('3', intCheck('添付ファイルの保持年数', 1, 30))),
  'approval.warn_days': other('3', intCheck('承認待ちの滞留を示す日数', 1, 30)),
  'paging.diary_per_page': other('50', intCheck('日誌一覧の1ページの件数', 10, 200)),
  'paging.nap_search_per_page': other('50', intCheck('午睡記録検索の1ページの件数', 10, 200)),
  'paging.operation_log_per_page': other('100', intCheck('操作ログの1ページの件数', 10, 500)),
  'paging.physical_history_count': other('12', intCheck('過去の測定値の表示件数', 6, 50)),
  // 読むだけ（editable を偽にする）
  'attachment.allowed_types': readOnly('other', 'image/jpeg,image/png'),
  'handout.allowed_types': readOnly('other', 'application/pdf,image/jpeg,image/png'),
  'retention.contact_years': readOnly('other', '5'), // 【要決定】決まるまでは記録の保持年数と同じ
  'growth.share_physical': readOnly('other', '1'),
  'nap.temperature_required': readOnly('other', '入眠時'),
};

/** GET が返すキーの並び（区画ごと、画面の並び） */
export const SETTING_ORDER = Object.keys(SETTING_SPECS);

/** 身長・体重のしきい値を、変えたあとの値で比べる（下限 < 上限）。誤りのキーと文言。無ければ null */
export function settingOrderProblem(after: (key: string) => string): { key: string; message: string } | null {
  for (const [lo, hi, message] of [
    ['physical.height_min', 'physical.height_max', SETTING_MSG.heightOrder],
    ['physical.weight_min', 'physical.weight_max', SETTING_MSG.weightOrder],
  ] as const) {
    const a = parseDecimal(after(lo), 2), b = parseDecimal(after(hi), 2);
    if (a !== null && b !== null && a >= b) return { key: lo, message };
  }
  return null;
}
