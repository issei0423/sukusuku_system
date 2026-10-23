/*
 * 推奨スケジュールの作り方（GitHub Issue #164 の 3「予定の無い園児は『予定どおり』のまま」）
 * 典拠：基本設計書.md「推奨スケジュールの作り方」(4-9)
 *      「最初の予定日｜園児を登録した日（画面・CSV）を基準日とし、基準日の月齢の推奨頻度の日数を足した日」
 *      「健診の節目を優先｜基準日と上の日のあいだに乳幼児健診の節目（1歳6か月・3歳・5歳の応当日）があれば、節目の日を予定日にする」
 *      「予定の無い在籍園児（第3.0版より前に登録した園児）には、管理者が一括で規則を当てる操作を置く」
 *
 * Go サーバ側（server/dev_schedule_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import type { ChildInput } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { addDays, ageInMonths, today } from '../src/api/util';
import { monthAnniversary, parseMilestones, recommendedScheduleDate } from '../src/api/devSchedule';
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

/** デモデータと同じマスタ・設定の値（mockDb.ts の developmentFrequencies と dev.milestone_months） */
const FREQ = [
  { age_month_from: 0, age_month_to: 11, interval_days: 90 },
  { age_month_from: 12, age_month_to: 35, interval_days: 120 },
  { age_month_from: 36, age_month_to: 72, interval_days: 180 },
];
const MILESTONES = [18, 36, 60];

describe('応当日と予定日の規則', () => {
  it('応当日は、その日に月齢がちょうどその月数になる日。無い月は末日', () => {
    for (const [birth, months, want] of [
      ['2025-06-22', 18, '2026-12-22'], ['2025-01-31', 1, '2025-02-28'], ['2023-01-31', 13, '2024-02-29'],
      ['2023-08-31', 18, '2025-02-28'], ['2024-12-05', 36, '2027-12-05'],
    ] as const) {
      expect(monthAnniversary(birth, months), `${birth} + ${months}か月`).toBe(want);
      expect(ageInMonths(birth, want)).toBe(months);
    }
    expect(monthAnniversary('abc', 18)).toBe('');
  });

  it('基準日に推奨頻度の日数を足す。あいだに健診の節目があれば節目の日を先にする', () => {
    for (const [label, birth, base, want] of [
      ['0歳児は90日', '2025-09-09', '2026-09-01', '2026-11-30'],
      ['1〜2歳児は120日', '2024-05-14', '2026-09-01', '2026-12-30'],
      ['3歳以上は180日', '2023-03-01', '2026-09-01', '2027-02-28'],
      ['あいだに1歳6か月', '2025-06-22', '2026-09-01', '2026-12-22'],
      ['あいだに3歳', '2023-11-15', '2026-09-01', '2026-11-15'],
      ['基準日ちょうどの節目は予定日にしない', '2025-03-01', '2026-09-01', '2026-12-30'],
      ['推奨頻度の日のあとの節目は使わない', '2025-07-15', '2026-09-01', '2026-12-30'],
      ['推奨頻度がマスタに無い月齢では作らない', '2019-01-01', '2026-09-01', null],
    ] as const) {
      expect(recommendedScheduleDate(birth, base, FREQ, MILESTONES), label).toBe(want);
    }
  });

  it('節目の設定が読めなければ既定値に戻す', () => {
    expect(parseMilestones(['36', '18'])).toEqual([18, 36]);
    expect(parseMilestones(['18', 'abc'])).toEqual([18, 36, 60]);
  });
});

/** 今日から days 日後（以降で日が 28 以下の最初の日）に 1歳6か月を迎える生年月日と、その節目の日 */
function birthForMilestoneIn(days: number): { birth: string; milestone: string } {
  let milestone = addDays(today(), days);
  while (Number(milestone.slice(8, 10)) > 28) milestone = addDays(milestone, 1);
  const [y, m] = milestone.split('-').map(Number);
  const total = y * 12 + (m - 1) - 18;
  const birth = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-${milestone.slice(8, 10)}`;
  return { birth, milestone };
}

const schedulesOf = (childId: string) => db.developmentSchedules.filter((s) => s.child_id === childId);

const newChild = (childId: string, birthDate: string): ChildInput => ({
  child_id: childId, child_name: '予定 太郎', child_name_kana: 'よてい たろう', birth_date: birthDate,
  sex: '1', normal_temperature: null, photo_consent_level: '2', class_id: 1, allergies: [], medical_histories: [],
});

describe('園児の登録（画面・CSV）で、最初の予定日が入る', () => {
  const baby = addDays(today(), -200); // 0歳6か月ごろ。節目は遠い
  const { birth: milestoneBirth, milestone } = birthForMilestoneIn(10);

  it('画面の登録：登録日に推奨頻度の日数を足した日。一覧に出て、予定どおり', async () => {
    await api.saveChild(admin, newChild('C701', baby), 'create');
    const rows = schedulesOf('C701');
    expect(rows).toHaveLength(1);
    expect(rows[0].scheduled_on).toBe(addDays(today(), 90));
    expect(rows[0].is_manual_override).toBe(false);
    const row = (await api.list(teacher, 1)).find((r) => r.child.child_id === 'C701')!;
    expect(row.scheduledOn).toBe(addDays(today(), 90));
    expect(row.overdue).toBe(false);
  });

  it('画面の登録：あいだに健診の節目があれば、節目の日を先にする', async () => {
    await api.saveChild(admin, newChild('C702', milestoneBirth), 'create');
    expect(schedulesOf('C702').map((s) => s.scheduled_on)).toEqual([milestone]);
  });

  it('編集では予定を足さない', async () => {
    await api.saveChild(admin, newChild('C701', baby), 'edit');
    expect(schedulesOf('C701')).toHaveLength(1);
  });

  it('CSV 一括登録も、同じ規則で当てる', async () => {
    const text = '園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱\n'
      + `C711,一括 一郎,いっかつ いちろう,${baby},1,さくら組,\n`
      + `C712,一括 二郎,いっかつ じろう,${milestoneBirth},1,ひまわり組,\n`;
    await api.importChildCsv(admin, [], text);
    expect(schedulesOf('C711').map((s) => s.scheduled_on)).toEqual([addDays(today(), 90)]);
    expect(schedulesOf('C712').map((s) => s.scheduled_on)).toEqual([milestone]);
  });
});

describe('予定の無い在籍園児に、管理者が一括で推奨を当てる', () => {
  const lastChecked = addDays(today(), -200);

  /** 第3.0版より前に登録した園児のように、予定を外す */
  const dropSchedules = (childId: string) => {
    for (let i = db.developmentSchedules.length - 1; i >= 0; i--) {
      if (db.developmentSchedules[i].child_id === childId) db.developmentSchedules.splice(i, 1);
    }
  };
  const addCheck = (childId: string, checkedOn: string, status: '1' | '2') => {
    db.developmentChecks.push({
      development_check_id: 980_000 + db.developmentChecks.length, child_id: childId, development_schedule_id: null,
      checked_on: checkedOn, status, staff_id: 'S003', share_status: '1', note: null, guardian_message: null,
      finalized_at: status === '2' ? `${checkedOn}T10:00:00` : null,
    });
  };

  it('デモデータの在籍園児には、すべて予定がある', async () => {
    expect((await api.applyRecommendedSchedules(admin)).applied).toBe(0);
  });

  it('担任は当てられない', async () => {
    await expect(api.applyRecommendedSchedules(teacher)).rejects.toThrow('管理者のみ');
  });

  it('基準日は最後に確定した実施日。無ければ当てた日。下書きは基準にしない。予定のある園児と退園した園児は変えない', async () => {
    // C801：記録の無い 0歳児（下書きだけある）。C802：200日前に確定した記録がある 0歳児（下書きはもっと新しい日）。C803：退園
    await api.saveChild(admin, newChild('C801', addDays(today(), -200)), 'create');
    await api.saveChild(admin, newChild('C802', addDays(today(), -330)), 'create');
    await api.saveChild(admin, newChild('C803', addDays(today(), -200)), 'create');
    ['C801', 'C802', 'C803'].forEach(dropSchedules);
    addCheck('C802', lastChecked, '2');
    addCheck('C802', addDays(today(), -20), '1');
    addCheck('C801', addDays(today(), -20), '1');
    db.children.find((c) => c.child_id === 'C803')!.enrollment_status = '2';
    const c001Before = schedulesOf('C001').map((s) => s.scheduled_on);

    expect((await api.applyRecommendedSchedules(admin)).applied).toBe(2);
    expect(schedulesOf('C801').map((s) => s.scheduled_on)).toEqual([addDays(today(), 90)]);
    expect(schedulesOf('C802').map((s) => s.scheduled_on)).toEqual([addDays(lastChecked, 90)]);
    expect(schedulesOf('C803')).toHaveLength(0);
    expect(schedulesOf('C001').map((s) => s.scheduled_on)).toEqual(c001Before);
  });

  it('最後の実施日から数えて予定日を過ぎていれば「過ぎた」（未実施）になる', async () => {
    const rows = await api.list(teacher, 1);
    expect(rows.find((r) => r.child.child_id === 'C802')!.overdue).toBe(true);
    expect(rows.find((r) => r.child.child_id === 'C801')!.overdue).toBe(false);
  });

  it('当てた園児ごとに操作ログへ残す', () => {
    for (const [id, from] of [['C801', '当てた日から算出'], ['C802', '最後の実施日から算出']] as const) {
      const log = db.operationLogs.filter((l) => l.target_table === 't_development_schedule' && l.target_child_id === id).at(-1);
      expect(log?.after_value, id).toContain('推奨を一括で当てた');
      expect(log?.after_value, id).toContain(from);
    }
  });

  it('もう一度当てても、予定のある園児は変えない', async () => {
    expect((await api.applyRecommendedSchedules(admin)).applied).toBe(0);
  });
});

/** 基準日（2026-09-01）から今日までの日数。デモデータをずらした日数（mockDb.ts の末尾と同じ） */
function shiftedDays(): number {
  const [by, bm, bd] = db.DEMO_TODAY.split('-').map(Number);
  const [ty, tm, td] = today().split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

describe('デモデータの、予定の無かった園児（C009〜C022）', () => {
  it('予定日は、基準日に規則で当てた日と同じ（日付ずらしの前の日付で比べる）', () => {
    const offset = shiftedDays();
    for (let i = 9; i <= 22; i++) {
      const id = `C${String(i).padStart(3, '0')}`;
      const child = db.children.find((c) => c.child_id === id)!;
      const rows = schedulesOf(id);
      expect(rows, id).toHaveLength(1);
      expect(addDays(rows[0].scheduled_on, -offset), id).toBe(
        recommendedScheduleDate(addDays(child.birth_date, -offset), db.DEMO_TODAY, db.developmentFrequencies, MILESTONES));
    }
  });
});

/*
 * 確定したときの次の予定日も、実施日を基準日として同じ規則で作る（基本設計書「推奨スケジュールの作り方」(4-9)
 * 「次の予定日｜確定したとき、実施日を基準日として同じ規則で作る」）。あいだに節目があれば節目の日。
 * サーバ側は server/dev_schedule_test.go の TestConfirmedCheckNextScheduleFollowsRule
 */
describe('確定したときの次の予定日も、同じ規則で作る', () => {
  const { birth: milestoneBirth, milestone } = birthForMilestoneIn(10);
  const checkedOn = addDays(today(), -5);

  for (const [label, childId, birth, want] of [
    ['節目が遠ければ、実施日に推奨頻度の日数を足す', 'C901', addDays(today(), -200), addDays(checkedOn, 90)],
    ['あいだに1歳6か月があれば、節目の日にする', 'C902', milestoneBirth, milestone],
  ] as const) {
    it(label, async () => {
      await api.saveChild(admin, newChild(childId, birth), 'create');
      // 予定日が来て過ぎた園児として、予定を実施日より前に置く
      schedulesOf(childId).forEach((s) => { s.scheduled_on = addDays(today(), -10); });
      await api.saveCheck(teacher, childId, checkedOn, [], '', '2');
      const rows = schedulesOf(childId).sort((a, b) => b.scheduled_on.localeCompare(a.scheduled_on));
      expect(rows).toHaveLength(2);
      expect(rows[0].scheduled_on).toBe(want);
      const log = db.operationLogs.filter((l) => l.target_table === 't_development_schedule' && l.target_child_id === childId).at(-1);
      expect(log?.after_value).toBe(`次回予定日=${want}（実施日から算出）`);
    });
  }
});

/*
 * スケジュール設定画面の「システムの提案」は、予定の無い園児に一括で当てる日と同じ。
 * サーバ側は server/dev_schedule_test.go の TestSuggestedScheduleMatchesApply
 */
describe('スケジュール設定画面の「システムの提案」は、一括で当てる日と同じ', () => {
  it('記録の無い園児・節目のある園児・確定した記録のある園児', async () => {
    const { birth: milestoneBirth, milestone } = birthForMilestoneIn(10);
    const lastChecked = addDays(today(), -200);
    // C951：記録の無い 0歳児。C952：あいだに 1歳6か月がある。C953：200日前に確定した記録がある 0歳児
    await api.saveChild(admin, newChild('C951', addDays(today(), -200)), 'create');
    await api.saveChild(admin, newChild('C952', milestoneBirth), 'create');
    await api.saveChild(admin, newChild('C953', addDays(today(), -330)), 'create');
    for (let i = db.developmentSchedules.length - 1; i >= 0; i--) {
      if (['C951', 'C952', 'C953'].includes(db.developmentSchedules[i].child_id)) db.developmentSchedules.splice(i, 1);
    }
    db.developmentChecks.push({
      development_check_id: 990_000 + db.developmentChecks.length, child_id: 'C953', development_schedule_id: null,
      checked_on: lastChecked, status: '2', staff_id: 'S003', share_status: '1', note: null, guardian_message: null,
      finalized_at: `${lastChecked}T10:00:00`,
    });

    const want: Record<string, string> = { C951: addDays(today(), 90), C952: milestone, C953: addDays(lastChecked, 90) };
    const rows = await api.schedules(admin, 1);
    for (const [id, w] of Object.entries(want)) {
      expect(rows.find((r) => r.child.child_id === id)?.suggested, id).toBe(w);
    }
    await api.applyRecommendedSchedules(admin);
    for (const [id, w] of Object.entries(want)) {
      expect(schedulesOf(id).map((s) => s.scheduled_on), id).toEqual([w]);
    }
  });
});
