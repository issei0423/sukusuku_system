/*
 * 決定の反映のテスト（GitHub Issue #69・#115・#126）
 * 典拠：基本設計書「成長曲線基準値」(5-7)・「共通基盤：ログインとアカウント」(4-3)
 *
 * 成長曲線の基準値は、厚生労働省「平成22年乳幼児身体発育調査」表1（体重）・表2（身長）の公表値。
 * ここに書いた期待値は、公表資料の行を目で見て打ったものである（生成したデータとは別に用意した）。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'takahashi@hoiku.example.jp', role: '1', display_name: '高橋 美咲',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

/** その性別・月齢・項目の、3〜97 パーセンタイルの7値 */
function band(sex: '1' | '2', month: number, measure: '1' | '2'): number[] {
  return db.growthStandards
    .filter((g) => g.sex === sex && g.age_in_months === month && g.measure_type === measure)
    .sort((a, b) => a.percentile - b.percentile)
    .map((g) => g.standard_value);
}

describe('成長曲線の基準値（GitHub Issue #69）', () => {
  it('男女 × 0〜72か月 × 身長・体重 × 7パーセンタイルの 2,044 行がある', () => {
    expect(db.growthStandards).toHaveLength(2 * 73 * 2 * 7);
    const keys = new Set(db.growthStandards.map((g) => `${g.sex}/${g.age_in_months}/${g.measure_type}/${g.percentile}`));
    expect(keys.size).toBe(db.growthStandards.length);
    expect(db.growthStandards.some((g) => g.source_version.includes('仮置き'))).toBe(false);
  });

  it('出生時の値を、満月齢0か月に当てる', () => {
    // 表1 体重 出生時
    expect(band('1', 0, '2')).toEqual([2.10, 2.45, 2.72, 3.00, 3.27, 3.50, 3.76]);
    expect(band('2', 0, '2')).toEqual([2.13, 2.41, 2.66, 2.94, 3.18, 3.41, 3.67]);
    // 表2 身長 出生時
    expect(band('1', 0, '1')).toEqual([44.0, 46.0, 47.4, 49.0, 50.2, 51.5, 52.6]);
    expect(band('2', 0, '1')).toEqual([44.0, 45.5, 47.0, 48.5, 50.0, 51.0, 52.0]);
  });

  it('「N～N+1月未満」の値を、満月齢Nか月に当てる', () => {
    // 表1 体重 0年1～2月未満
    expect(band('1', 1, '2')).toEqual([3.53, 3.94, 4.35, 4.79, 5.22, 5.59, 5.96]);
    // 表1 体重 0年11～12月
    expect(band('2', 11, '2')).toEqual([7.02, 7.46, 7.95, 8.51, 9.11, 9.68, 10.27]);
    // 表1 体重 1年0～1月未満
    expect(band('1', 12, '2')).toEqual([7.68, 8.15, 8.65, 9.24, 9.86, 10.44, 11.04]);
    // 表1 体重 1年11～12月
    expect(band('2', 23, '2')).toEqual([8.78, 9.34, 9.93, 10.64, 11.40, 12.13, 12.90]);
    // 表2 身長 0年2～3月・3～4月
    expect(band('1', 2, '1')).toEqual([54.5, 56.1, 57.5, 59.1, 60.6, 62.0, 63.2]);
    expect(band('2', 3, '1')).toEqual([56.0, 57.6, 59.1, 60.7, 62.1, 63.4, 64.5]);
  });

  it('公表値そのものの月齢と、補間で求めた月齢を、出典の名前で見分けられる', () => {
    const sourceOf = (month: number) => new Set(db.growthStandards.filter((g) => g.age_in_months === month).map((g) => g.source_version));
    for (let m = 0; m <= 23; m++) expect([...sourceOf(m)]).toEqual(['厚労省2010']);
    for (let m = 24; m <= 72; m++) expect([...sourceOf(m)]).toEqual(['厚労省2010（補間）']);
  });

  it('2歳以上は、6か月ごとの公表値のあいだを補間する', () => {
    // 表1 体重 男子：1年11～12月の中央値 11.28、2年0～6月未満 11.93、2年6～12月 12.99
    const median = (month: number) => band('1', month, '2')[3];
    expect(median(24)).toBeGreaterThan(11.28);
    expect(median(24)).toBeLessThan(11.93);
    // 2年0～6月未満の階級（24〜29か月）の中央は、26か月と27か月のあいだにある
    expect(median(26)).toBeLessThan(11.93);
    expect(median(27)).toBeGreaterThan(11.93);
    // 6年0～6月未満の中央値 19.91 は、72か月より先（階級の中央）の値。72か月はその手前
    expect(median(72)).toBeGreaterThan(18.63);
    expect(median(72)).toBeLessThan(19.91);
  });

  it('どの月齢でもパーセンタイルは昇順で、中央値は月齢とともに増える', () => {
    for (const sex of ['1', '2'] as const) {
      for (const measure of ['1', '2'] as const) {
        let previous = 0;
        for (let m = 0; m <= 72; m++) {
          const v = band(sex, m, measure);
          expect(v).toHaveLength(7);
          for (let i = 0; i < 6; i++) expect(v[i]).toBeLessThan(v[i + 1]);
          expect(v[3]).toBeGreaterThan(previous);
          previous = v[3];
        }
      }
    }
  });

  it('成長曲線の帯として取得できる。性別が未回答の園児には返さない', async () => {
    const rows = await api.growthBand('1', '1');
    expect(rows).toHaveLength(73 * 7);
    expect(await api.growthBand('9', '1')).toBeNull();
  });
});

describe('ログインの記録（GitHub Issue #115）', () => {
  const failures = () => db.operationLogs.filter((l) => l.target_table === 'm_account' && l.target_id === 5
    && (l.after_value ?? '').startsWith('ログインに失敗'));

  it('ログインの失敗は操作ログに残る。成功は残らない', async () => {
    const before = db.operationLogs.length;
    await expect(api.login('tanaka@hoiku.example.jp', 'wrong-password', 'staff')).rejects.toThrow(/credential/);
    expect(failures()).toHaveLength(1);
    expect(failures()[0].after_value).toBe('ログインに失敗（続けて 1 回目）');

    await api.login('tanaka@hoiku.example.jp', 'pass1234', 'staff');
    await api.logout();
    // 成功とログアウトでは行が増えない
    expect(db.operationLogs.length).toBe(before + 1);
  });

  it('失敗が続いてロックされたことも残る。操作ログの「対象」から誰のアカウントかが分かる', async () => {
    const max = Number(db.settings.find((s) => s.setting_key === 'auth.max_failed_login')!.setting_value);
    for (let i = 0; i < max; i++) {
      await expect(api.login('tanaka@hoiku.example.jp', 'wrong-password', 'staff')).rejects.toThrow();
    }
    const last = failures()[0];
    expect(last.after_value).toBe(`ログインに失敗（続けて ${max} 回目）。失敗が続いたためロック`);

    const logs = await api.operationLogs(admin, {});
    expect(logs.rows.find((l) => l.operation_log_id === last.operation_log_id)?.target_label).toBe('田中 陽子');

    // 後始末：ロックを解除する
    await api.unlock(admin, 5);
  });

  it('存在しないログインIDへの試行は、残す先のアカウントが無いため残らない', async () => {
    const before = db.operationLogs.length;
    await expect(api.login('nobody@hoiku.example.jp', 'whatever', 'staff')).rejects.toThrow(/credential/);
    expect(db.operationLogs.length).toBe(before);
  });
});

describe('利用規約の本文（GitHub Issue #126）', () => {
  it('職員と保護者の双方に適用する旨と、職員のアカウントの発行を書いている', async () => {
    const terms = await api.currentTerms();
    expect(terms.body).toContain('職員および保護者の双方に適用します');
    expect(terms.body).toContain('職員のアカウントは、当園が発行します');
    expect(terms.body).toContain('保護者のアカウントは、当園が発行する招待コードによって登録します');
  });
});
