/*
 * 発達チェックの実施日・確定・未実施の判定（GitHub Issue #164）
 * 典拠：基本設計書.md「入力項目の制約値」(4-9)「記録日・測定日 未来日は認めない（当日まで）」、
 *      「発達チェックの実施」(4-8)「実施予定日を過ぎて未入力の項目・園児をチェック漏れとして強調表示」、
 *      図/画面詳細図.md「発達チェック入力画面」(6-2) 項目3「実施日 制限：未来日は選べない」
 *
 * Go サーバ側（server/api_dev_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { addDays, ageInMonths, today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

describe('実施日は、形の崩れた値と未来日を断る', () => {
  it('下書きでも確定でも断り、記録を作らない', async () => {
    for (const d of [addDays(today(), 1), '2027-03-01', '2026-10-1', 'abc', '2026-02-30', `${today()}T10:00:00`]) {
      for (const status of ['1', '2'] as const) {
        await expect(api.saveCheck(teacher, 'C010', d, [], '', status)).rejects.toThrow('実施日');
      }
    }
    expect(db.developmentChecks.some((c) => c.child_id === 'C010')).toBe(false);
    await expect(api.saveCheck(teacher, 'C010', today(), [], '', '2')).resolves.toBeTruthy();
  });

  it('管理者の予定日の上書きも、形の崩れた日付を断る', async () => {
    // デモデータの加藤 大和（C009）には、推奨で当てた予定が 1 件ある（mockDb.ts。GitHub Issue #164 の 3）。断った要求で変わらないことを見る
    const before = JSON.stringify(db.developmentSchedules.filter((s) => s.child_id === 'C009'));
    for (const [d, manual] of [['2026-10-1', true], ['abc', false], ['', false]] as const) {
      await expect(api.setSchedule(admin, 'C009', d, manual)).rejects.toThrow('形式が正しくありません');
    }
    expect(JSON.stringify(db.developmentSchedules.filter((s) => s.child_id === 'C009'))).toBe(before);
  });
});

describe('確定した発達チェックは、下書きに戻さない', () => {
  it('下書き保存を断り、確定のまま直すことはできる', async () => {
    await api.saveCheck(teacher, 'C011', today(), [], '', '2');
    await expect(api.saveCheck(teacher, 'C011', today(), [], '', '1')).rejects.toThrow('下書きに戻せません');
    expect(db.developmentChecks.find((c) => c.child_id === 'C011' && c.checked_on === today())!.status).toBe('2');
    await expect(api.saveCheck(teacher, 'C011', today(), [], '直した所見', '2')).resolves.toBeTruthy();
  });
});

describe('「未実施」は予定日を過ぎてから。一覧とダッシュボードは同じ数を出す', () => {
  it('予定日の当日は、まだ未実施にしない', async () => {
    await api.setSchedule(admin, 'C009', today(), true);
    const row = (await api.list(teacher, 1)).find((r) => r.child.child_id === 'C009')!;
    expect(row.scheduledOn).toBe(today());
    expect(row.overdue).toBe(false);
  });

  it('過去の予定が複数あっても、ダッシュボードは園児ごとに数え、一覧と同じ数になる', async () => {
    db.developmentSchedules.push(
      { development_schedule_id: 990001, child_id: 'C009', scheduled_on: addDays(today(), -30), is_manual_override: false, created_staff_id: 'S001' },
      { development_schedule_id: 990002, child_id: 'C003', scheduled_on: addDays(today(), -200), is_manual_override: false, created_staff_id: 'S001' },
    );
    const listed = (await api.list(teacher, 1)).filter((r) => r.overdue).length;
    expect((await api.staffSummary(teacher)).devOverdue).toBe(listed);
  });
});

/** 基準日（2026-09-01）から今日までの日数。デモデータをずらした日数（mockDb.ts の末尾と同じ） */
function shiftedDays(): number {
  const [by, bm, bd] = db.DEMO_TODAY.split('-').map(Number);
  const [ty, tm, td] = today().split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

/*
 * デモデータの確定した発達チェックは、実施日の月齢の区分の項目で入れてある。
 * 生年月日も記録と同じ日数だけずらすので、起動した日が進んでも区分が変わらず、一覧に「未入力」が出ない
 * （GitHub Issue #143 の 1・#164 の追記「月齢の区分がずれる」）。Go 側は server/api_dev_test.go
 */
describe('デモデータの発達チェックは、日付ずらしで区分が変わらない', () => {
  it('園児の生年月日も、記録と同じ日数だけずらす', () => {
    const offset = shiftedDays();
    expect(db.children.find((c) => c.child_id === 'C001')!.birth_date).toBe(addDays('2025-06-01', offset));
    expect(db.children.find((c) => c.child_id === 'C008')!.birth_date).toBe(addDays('2025-01-31', offset));
    expect(db.developmentChecks.find((c) => c.development_check_id === 1)!.checked_on).toBe(addDays('2026-05-15', offset));
  });

  it('確定した記録の結果は、実施日の月齢の区分の項目に揃っている。さらに先の起動日でも同じ', () => {
    const seedChecks = db.developmentChecks.filter((c) => [1, 2, 3].includes(c.development_check_id));
    expect(seedChecks).toHaveLength(3);
    // 0 は今日のまま。ほかは、さらに先の起動日を想定する（2028-02-29 をまたぐ日を含む）
    for (const extra of [0, 30, 91, 200, 365, 700]) {
      for (const check of seedChecks) {
        const child = db.children.find((c) => c.child_id === check.child_id)!;
        const cat = api.categoryFor(ageInMonths(addDays(child.birth_date, extra), addDays(check.checked_on, extra)));
        const itemIds = db.developmentItems
          .filter((i) => i.development_category_id === cat?.development_category_id)
          .map((i) => i.development_item_id)
          .sort();
        const recorded = db.developmentResults
          .filter((r) => r.development_check_id === check.development_check_id)
          .map((r) => r.development_item_id)
          .sort();
        expect(recorded, `さらに ${extra} 日：${child.child_name}（${check.checked_on}）`).toEqual(itemIds);
      }
    }
  });

  it('一覧に、デモデータの前回の記録の「未入力」が出ない', async () => {
    // 前回の記録があるのは 西田 太郎・遠藤 花子・村田 美咲（ほかの園児は、このファイルの前のテストで記録が増えている）
    const rows = (await api.list(teacher, 1)).filter((r) => ['C001', 'C002', 'C004'].includes(r.child.child_id));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.lastCheckedOn, r.child.child_name).not.toBeNull();
      expect(r.unfilled, r.child.child_name).toBe(0);
    }
  });
});

/*
 * 一覧の「未入力 n 件」は、下書きも含めた最新の記録で数える。入力画面の「未入力の項目」と食い違わない（GitHub Issue #143 の 1）。
 * 典拠：要件定義書「チェック漏れの強調」(4-5-2)「下書き保存された記録は、保存されていない項目を未入力として扱う」
 */
describe('一覧の「未入力」は、下書きも含めた最新の記録で数える', () => {
  it('下書きに保存した項目は入力済み、保存していない項目は未入力。下書きは実施にならない', async () => {
    const child = db.children.find((c) => c.child_id === 'C001')!; // 西田 太郎。前回の確定した記録がある
    const items = await api.itemsFor(ageInMonths(child.birth_date, today()));
    const rowOf = async () => (await api.list(teacher, 1)).find((r) => r.child.child_id === 'C001')!;

    // 1 項目だけ「未確認」を選んで下書き保存すると、残りが未入力（未確認は入力済み）
    await api.saveCheck(teacher, 'C001', today(),
      items.map((it, i) => ({ development_item_id: it.development_item_id, result: i === 0 ? '3' as const : null })), '', '1');
    expect((await rowOf()).unfilled).toBe(items.length - 1);

    // すべて選んで下書き保存すると、未入力は 0（#143 の再現：入力画面は 0 件、一覧は 3 件と出ていた）
    await api.saveCheck(teacher, 'C001', today(),
      items.map((it) => ({ development_item_id: it.development_item_id, result: '1' as const })), '', '1');
    const row = await rowOf();
    expect(row.unfilled).toBe(0);
    expect(row.lastCheckedOn).not.toBe(today());
  });
});

/*
 * 確定した記録を開き直したとき、いつ確定したかを返す（GitHub Issue #143 の 2）。
 * 日時は操作ログの「確定」から引く。下書きのあいだは返さない。Go 側は server/api_dev.go の confirmedAt
 */
describe('確定した記録は、いつ確定したかを返す', () => {
  it('下書きのあいだは null、確定すると操作ログの日時', async () => {
    await api.saveCheck(teacher, 'C012', today(), [], '', '1'); // 松本 咲良
    expect((await api.draftFor(teacher, 'C012', today()))!.confirmedAt).toBeNull();
    await api.saveCheck(teacher, 'C012', today(), [], '', '2');
    const v = (await api.draftFor(teacher, 'C012', today()))!;
    expect(v.check.status).toBe('2');
    expect(v.check.staff_id).toBe('S003');
    expect(v.confirmedAt?.slice(0, 10)).toBe(today());
  });
});
