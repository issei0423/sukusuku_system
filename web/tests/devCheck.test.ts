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
import { addDays, today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
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
    for (const [d, manual] of [['2026-10-1', true], ['abc', false], ['', false]] as const) {
      await expect(api.setSchedule(admin, 'C009', d, manual)).rejects.toThrow('形式が正しくありません');
    }
    expect(db.developmentSchedules.some((s) => s.child_id === 'C009')).toBe(false);
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
