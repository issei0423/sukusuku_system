/*
 * 設定画面の全キー（詳細設計書「設定」(4-10 (1)〜(3))、基本設計書「設定マスタ（m_setting）」(5-9) の既定値）
 * モックの settingsApi。Go の同じ観点は server/api_settings_keys_test.go（キーごとの入る値・入らない値は同じ表）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { settingNumber } from '../src/api/mock';
import { SETTING_ORDER, SETTING_SPECS } from '../src/api/settingSpecs';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser> = {}): SessionUser => ({
  account_id, email: `u${account_id}@example.jp`, role, display_name: 'テスト', staff_id: null, guardian_id: null,
  class_id: null, class_name: null, is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const guardian = user(6, '3', { guardian_id: 'G001' });

const valueOf = (key: string) => db.settings.find((s) => s.setting_key === key)?.setting_value;
const save = async (changes: Record<string, string>) => api.saveSettings(admin, changes, (await api.settings(admin)).read_at);
const rejected = async (changes: Record<string, string>) => {
  try { await save(changes); } catch (e) { return e as Error & { field?: string }; }
  return null;
};

const cases: [string, string[], string[]][] = [
  ['contact.show_items', ['nap,nap', 'nap,hoge', 'nap, meal'], ['', 'nap', 'nap,meal,toilet,temperature,comment,photo,class']],
  ['contact.home_items', ['', 'mood,mood', 'nap'], ['mood', 'temperature,message']],
  ['contact.toilet_choices', ['', 'a,,b', 'a,a', 'あ'.repeat(21), 'a\nb', ' a'], ['おしっこ', 'おしっこ,うんち', 'あ'.repeat(20)]],
  ['contact.mood_choices', ['', 'x,x'], ['ごきげん,ふつう']],
  ['push.quiet_hours', ['21:00-21:00', '21:03-07:00', '25:00-07:00', '21:00', '9:00-10:00'], ['21:00-07:00', '00:00-23:55', '22:30-06:15']],
  ['ai.daily_limit', ['0', '10001', '05', ' 5'], ['1', '10000']],
  ['facility.name', ['', '  ', '園'.repeat(51)], ['あ', '園'.repeat(50)]],
  ['facility.phone_number', ['03-0000-000a', '０３-0000', '1'.repeat(21)], ['', '03-1234-5678', '1'.repeat(20)]],
  ['nap.interval_minutes.age0', ['0', '16', '5.5', ''], ['1', '15']],
  ['nap.interval_minutes.age1', ['0', '16'], ['15']],
  ['nap.interval_minutes.age2', ['0', '16'], ['1']],
  ['nap.time_range', ['15:00-13:00', '13:00-13:00', '13:00', '24:00-25:00'], ['12:30-15:30', '00:00-23:59']],
  ['auth.max_failed_login', ['2', '11'], ['3', '10']],
  ['auth.lock_minutes', ['0', '1441'], ['1', '1440']],
  ['auth.remember_days', ['0', '91'], ['1', '90']],
  ['auth.temp_password_hours', ['0', '169'], ['1', '168']],
  ['ui.auto_logout_minutes', ['4', '121'], ['5', '120']],
  ['ui.diary_lock_minutes', ['4', '61'], ['5', '60']],
  ['scope.handover_grace_days', ['0', '91'], ['1', '90']],
  ['scope.guardian_grace_days', ['0', '91'], ['1', '90']],
  ['scope.fiscal_year_update_date', ['02-29', '13-01', '4-1', '04-31', '00-10'], ['04-01', '02-28', '12-31']],
  ['physical.measure_months', ['', '0', '13', '4,4', '4,'], ['4', '4,8,12', '1,2,3,4,5,6,7,8,9,10,11,12']],
  ['physical.height_min', ['19.9', '200.1', '40.55', 'abc', '40.'], ['20', '20.0', '40.5']],
  ['physical.height_max', ['19.9', '200.1', '140.55'], ['200', '141.5']],
  ['physical.weight_min', ['0.49', '100.01', '2.555'], ['0.5', '0.50', '2.25']],
  ['physical.weight_max', ['0.49', '100.01'], ['100', '40.25']],
  ['dev.milestone_months', ['', '0', '73', '18,18'], ['1', '18,36,60', '72']],
  ['dev.notice_days_before', ['0', '61', '-1', '7.5'], ['1', '60']],
  ['attachment.max_size_mb', ['0', '21'], ['1', '20']],
  ['attachment.max_count_diary', ['0', '4'], ['1', '3']],
  ['retention.record_years', ['0', '31'], ['1', '30']],
  ['retention.attachment_years', ['0', '31'], ['1', '30']],
  ['approval.warn_days', ['0', '31'], ['1', '30']],
  ['paging.diary_per_page', ['9', '201'], ['10', '200']],
  ['paging.nap_search_per_page', ['9', '201'], ['10', '200']],
  ['paging.operation_log_per_page', ['9', '501'], ['10', '500']],
  ['paging.physical_history_count', ['5', '51'], ['6', '50']],
];

describe('設定画面の全キー（モック。server/api_settings_keys_test.go と同じ観点）', () => {
  // テストごとに、設定とログを元へ戻す（mockDb は同じファイルのテストで使い回されるため）
  let snapshot: typeof db.settings;
  let logCount: number;
  beforeEach(() => { snapshot = structuredClone(db.settings); logCount = db.operationLogs.length; });
  afterEach(() => { db.settings.splice(0, db.settings.length, ...snapshot); db.operationLogs.splice(0, db.operationLogs.length - logCount); });

  it('表のキーだけを、区画・既定値・変えられるかを添えて返す。古いキーは返さない。管理者だけ', async () => {
    await expect(api.settings(teacher)).rejects.toThrow('この操作は管理者のみが行えます');
    await expect(api.settings(guardian)).rejects.toThrow('この操作は管理者のみが行えます');
    const v = await api.settings(admin);
    expect(v.settings.map((s) => s.setting_key)).toEqual(SETTING_ORDER);
    expect(v.settings.map((s) => s.setting_key)).not.toContain('nap.temperature_required_at_start');
    const by = Object.fromEntries(v.settings.map((s) => [s.setting_key, s]));
    expect([by['contact.show_items'].group, by['push.quiet_hours'].group, by['ai.enabled'].group, by['dev.notice_days_before'].group])
      .toEqual(['contact', 'notify', 'ai', 'other']);
    expect([by['dev.notice_days_before'].default_value, by['approval.warn_days'].default_value, by['scope.handover_grace_days'].default_value]).toEqual(['7', '3', '30']);
    for (const k of ['attachment.allowed_types', 'handout.allowed_types', 'retention.contact_years', 'growth.share_physical', 'nap.temperature_required']) {
      expect(by[k].editable, k).toBe(false);
    }
    // デモデータは、表のキーをすべて持つ
    for (const k of SETTING_ORDER) expect(db.settings.filter((s) => s.setting_key === k), k).toHaveLength(1);
    expect(v.push_available).toBe(false);
  });

  it('キーごとの検査：入らない値は field つきの文言で断り、書かない。入る値は入る', async () => {
    for (const [key, bad, good] of cases) {
      const before = valueOf(key);
      for (const value of bad) {
        const e = await rejected({ [key]: value });
        expect([key, value, e?.field]).toEqual([key, value, key]);
        expect(valueOf(key), `${key}=${value}`).toBe(before);
      }
      for (const value of good) expect(await rejected({ [key]: value }), `${key}=${value}`).toBeNull();
    }
    expect((await rejected({ 'dev.notice_days_before': '0' }))?.message).toBe('発達チェックの予定日が近いとする日数は1〜60の整数で入力してください。');
    expect((await rejected({ 'push.quiet_hours': '21:00-21:00' }))?.message).toBe('開始と終了は違う時刻にしてください。');
  }, 60_000);

  it('読むだけのキーと表に無いキーは、画面から変えられない', async () => {
    for (const key of ['retention.contact_years', 'growth.share_physical', 'attachment.allowed_types', 'nap.temperature_required_at_start']) {
      const e = await rejected({ [key]: '1' });
      expect([e?.message, e?.field]).toEqual(['この設定は画面から変えられません。', key]);
    }
    expect(Object.values(SETTING_SPECS).filter((s) => !s.editable)).toHaveLength(5);
  });

  it('身長・体重のしきい値は、変えたあとの値で下限 < 上限', async () => {
    const cases2: [Record<string, string>, string, string][] = [
      [{ 'physical.height_min': '140' }, '身長の下限は上限より小さくしてください。', 'physical.height_min'],
      [{ 'physical.height_max': '40' }, '身長の下限は上限より小さくしてください。', 'physical.height_min'],
      [{ 'physical.weight_min': '40' }, '体重の下限は上限より小さくしてください。', 'physical.weight_min'],
      [{ 'physical.weight_max': '1.5' }, '体重の下限は上限より小さくしてください。', 'physical.weight_min'],
      [{ 'physical.height_min': '150', 'physical.height_max': '100' }, '身長の下限は上限より小さくしてください。', 'physical.height_min'],
    ];
    for (const [changes, message, field] of cases2) {
      const e = await rejected(changes);
      expect([e?.message, e?.field]).toEqual([message, field]);
    }
    expect(valueOf('physical.height_min')).toBe('40');
    expect(await rejected({ 'physical.height_min': '100.5', 'physical.height_max': '120' })).toBeNull();
  });

  it('保存すると、その値を読む処理にすぐ効き、変えた分だけ操作ログに残る。管理者のほかは変えられない', async () => {
    const v = await api.settings(admin);
    await expect(api.saveSettings(teacher, { 'dev.notice_days_before': '14' }, v.read_at)).rejects.toThrow('この操作は管理者のみが行えます');
    expect(valueOf('dev.notice_days_before')).toBe('7');
    const logsBefore = db.operationLogs.length;
    await save({ 'dev.notice_days_before': '14', 'paging.operation_log_per_page': '10', 'physical.height_min': '40.5', 'approval.warn_days': '3' });
    expect(settingNumber('dev.notice_days_before', 0)).toBe(14);
    expect(settingNumber('paging.operation_log_per_page', 0)).toBe(10);
    expect(settingNumber('physical.height_min', 0)).toBe(40.5);
    const logs = db.operationLogs.slice(0, db.operationLogs.length - logsBefore).filter((l) => l.function_type === '9' && l.target_table === 'm_setting');
    // 値が同じ approval.warn_days は残さない
    expect(logs.map((l) => `${l.before_value}→${l.after_value}`).sort()).toEqual([
      '{"dev.notice_days_before":"7"}→{"dev.notice_days_before":"14"}',
      '{"paging.operation_log_per_page":"100"}→{"paging.operation_log_per_page":"10"}',
      '{"physical.height_min":"40"}→{"physical.height_min":"40.5"}',
    ].sort());
  });
});
