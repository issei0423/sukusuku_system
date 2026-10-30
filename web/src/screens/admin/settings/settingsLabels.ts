/*
 * 設定画面の、キーごとの名前・単位・入れ方・読むだけの理由
 * 典拠：詳細設計書「設定画面（管理者）」(2-14 (2)(7))・「設定ごとの検査」(4-10 (3))。
 * 名前は、サーバとモックの誤りの文言（server/settings_spec.go・web/src/api/settingSpecs.ts）の「〇〇は△△で入力してください。」の〇〇と同じにする。
 * 設定キーは画面に名前としては出さず、小さく添える。
 */

export type SettingKind = 'int' | 'decimal' | 'text';

export interface OtherSettingLabel {
  label: string;
  unit?: string;
  kind: SettingKind;
  /** 入れ方の目安（【仮置き】web/仮置き値.md） */
  hint?: string;
}

export const OTHER_SETTINGS: Record<string, OtherSettingLabel> = {
  'facility.name': { label: '園の名称', kind: 'text', hint: '1〜50文字' },
  'facility.phone_number': { label: '園の電話番号', kind: 'text', hint: '数字とハイフン。空にすると、保護者の画面の電話の案内は文言だけになります' },
  'nap.interval_minutes.age0': { label: '午睡のチェック間隔（0歳児）', unit: '分', kind: 'int', hint: '1〜15' },
  'nap.interval_minutes.age1': { label: '午睡のチェック間隔（1歳児）', unit: '分', kind: 'int', hint: '1〜15' },
  'nap.interval_minutes.age2': { label: '午睡のチェック間隔（2歳児以上）', unit: '分', kind: 'int', hint: '1〜15' },
  'nap.time_range': { label: '午睡の時間帯', kind: 'text', hint: '開始-終了（例 13:00-15:00）。同じ日の中' },
  'auth.max_failed_login': { label: 'ログイン失敗の上限回数', unit: '回', kind: 'int', hint: '3〜10' },
  'auth.lock_minutes': { label: 'ロックの待機時間', unit: '分', kind: 'int', hint: '1〜1440' },
  'auth.remember_days': { label: 'ログイン情報を覚えておく日数', unit: '日', kind: 'int', hint: '1〜90' },
  'auth.temp_password_hours': { label: '一時パスワードの有効時間', unit: '時間', kind: 'int', hint: '1〜168' },
  'ui.auto_logout_minutes': { label: '自動ログアウトまでの無操作の時間', unit: '分', kind: 'int', hint: '5〜120' },
  'ui.diary_lock_minutes': { label: '日誌の編集ロックの無操作の時間', unit: '分', kind: 'int', hint: '5〜60' },
  'scope.handover_grace_days': { label: '職員の引き継ぎ猶予期間', unit: '日', kind: 'int', hint: '1〜90' },
  'scope.guardian_grace_days': { label: '保護者の猶予期間', unit: '日', kind: 'int', hint: '1〜90' },
  'scope.fiscal_year_update_date': { label: '年度更新の実行日', kind: 'text', hint: '月-日（例 04-01）' },
  'physical.measure_months': { label: '身体測定を行う月', kind: 'text', hint: '1〜12 の数をカンマで区切る（例 4,8,12）' },
  'physical.height_min': { label: '身長の下限', unit: 'cm', kind: 'decimal', hint: '20.0〜200.0（小数第1位まで）' },
  'physical.height_max': { label: '身長の上限', unit: 'cm', kind: 'decimal', hint: '20.0〜200.0（小数第1位まで）' },
  'physical.weight_min': { label: '体重の下限', unit: 'kg', kind: 'decimal', hint: '0.50〜100.00（小数第2位まで）' },
  'physical.weight_max': { label: '体重の上限', unit: 'kg', kind: 'decimal', hint: '0.50〜100.00（小数第2位まで）' },
  'dev.milestone_months': { label: '乳幼児健診の節目の月齢', unit: 'か月', kind: 'text', hint: '1〜72 の数をカンマで区切る（例 18,36,60）' },
  'dev.notice_days_before': { label: '発達チェックの予定日が近いとする日数', unit: '日', kind: 'int', hint: '1〜60' },
  'attachment.max_size_mb': { label: '添付ファイルの上限サイズ', unit: 'MB', kind: 'int', hint: '1〜20' },
  'attachment.max_count_diary': { label: '日誌の写真の上限枚数', unit: '枚', kind: 'int', hint: '1〜3' },
  'retention.record_years': { label: '記録の保持年数', unit: '年', kind: 'int', hint: '1〜30' },
  'retention.attachment_years': { label: '添付ファイルの保持年数', unit: '年', kind: 'int', hint: '1〜30' },
  'approval.warn_days': { label: '承認待ちの滞留を示す日数', unit: '日', kind: 'int', hint: '1〜30' },
  'paging.diary_per_page': { label: '日誌一覧の1ページの件数', unit: '件', kind: 'int', hint: '10〜200' },
  'paging.nap_search_per_page': { label: '午睡記録検索の1ページの件数', unit: '件', kind: 'int', hint: '10〜200' },
  'paging.operation_log_per_page': { label: '操作ログの1ページの件数', unit: '件', kind: 'int', hint: '10〜500' },
  'paging.physical_history_count': { label: '過去の測定値の表示件数', unit: '件', kind: 'int', hint: '6〜50' },
};

/** 画面から変えないもの（読むだけの行）の名前と理由。【仮置き】理由の文（web/仮置き値.md） */
export const READ_ONLY_SETTINGS: Record<string, { label: string; reason: string }> = {
  'attachment.allowed_types': { label: '添付の対応形式', reason: '動画を認めない決まりと、送るときの検査がこの値によるため、画面からは変えません。' },
  'handout.allowed_types': { label: '配布物の対応形式', reason: '送るときの検査がこの値によるため、画面からは変えません。' },
  'retention.contact_years': { label: '連絡帳の保持年数', reason: '決まるまでは、記録の保持年数と同じ値で扱います。' },
  'growth.share_physical': { label: '身体測定を成長の記録に出すか', reason: '共有範囲の設定の画面で変えます。' },
  'nap.temperature_required': { label: '午睡で体温を求める時点', reason: '選べるのは「入眠時」だけです。' },
};

/** 保護者へ出すきょうのようすの項目（contact.show_items）の並びと名前 */
export const SHOW_ITEMS: [string, string][] = [
  ['nap', '午睡'], ['meal', '食事'], ['toilet', '排せつ'], ['temperature', '体温'],
  ['comment', '活動のひとこと'], ['photo', '写真'], ['class', 'クラスのようす'],
];

/** 「家庭から」の項目（contact.home_items）の並びと名前 */
export const HOME_ITEMS: [string, string][] = [
  ['temperature', '体温'], ['night_sleep', '夜の睡眠'], ['breakfast', '朝ごはん'],
  ['mood', 'きげん'], ['pickup', 'お迎え'], ['message', '連絡事項'],
];

/** 確認の窓に並べる、キーごとの名前と値の見せ方 */
export function describeSetting(key: string, value: string): { label: string; value: string } {
  const named = (items: [string, string][]) => value.split(',').filter(Boolean).map((v) => items.find((i) => i[0] === v)?.[1] ?? v).join('、') || '（なし）';
  switch (key) {
    case 'contact.show_items': return { label: '保護者へ出すきょうのようすの項目', value: named(SHOW_ITEMS) };
    case 'contact.home_items': return { label: '「家庭から」の項目', value: named(HOME_ITEMS) };
    case 'contact.toilet_choices': return { label: '排せつの選択肢', value };
    case 'contact.mood_choices': return { label: 'きげんの選択肢', value };
    case 'ai.enabled': return { label: 'AI の下書きを使う', value: value === '1' ? '使う' : '使わない' };
    case 'ai.daily_limit': return { label: '1日の上限回数', value };
    default: {
      const o = OTHER_SETTINGS[key];
      return { label: o?.label ?? key, value: value === '' ? '（空）' : `${value}${o?.unit ? ` ${o.unit}` : ''}` };
    }
  }
}
