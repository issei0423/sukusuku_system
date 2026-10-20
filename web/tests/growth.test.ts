/*
 * 成長の記録（モック）
 * 典拠：詳細設計書「成長の記録」(4-12 (1))・「成長の記録に届くもの」(3-7)・「テストの観点」(9-1)・「2か所の規則をそろえる」(9-2)
 *
 * Go の同じ観点は server/api_growth_test.go にある。判定の表（growthAccessCases）は同じ行にする。
 * mockDb の中身は同じファイルのテストどうしで使い回されるため、書き換えたものは各テストの終わりに戻す。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { addDays, ageInMonths, today } from '../src/api/util';
import { MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';
import type { ContactEventRecord } from '../src/api/types';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});

// デモデータの人物（mockDb.ts。server/seed.sql と同じ）
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const otherTeacher = user(5, '2', { staff_id: 'S005', class_id: 2, class_name: 'ひまわり組' });
const taroGuardian = user(6, '3', { guardian_id: 'G001' }); // 野原 太郎（C001）の父
const misakiGuardian = user(9, '3', { guardian_id: 'G004' }); // 宮城 美咲（C004）の父

/** server/api_growth_test.go の growthAccessCases と同じ行 */
const growthAccessCases: [name: string, who: SessionUser, child: string, ok: boolean][] = [
  ['保護者は紐づけた自児', taroGuardian, 'C001', true],
  ['保護者はほかの家庭の園児を読めない', taroGuardian, 'C004', false],
  ['ほかの家庭の保護者は野原 太郎を読めない', misakiGuardian, 'C001', false],
  ['保護者は無い園児を読めない', taroGuardian, 'C999', false],
  ['さくら組の担任は自クラスの園児', teacher, 'C001', true],
  ['ひまわり組の担任はさくら組の園児を読めない', otherTeacher, 'C001', false],
  ['管理者は全園児', admin, 'C013', true],
];

const day = (n: number) => addDays(today(), n);

/** テストの中で足した行を、終わったら外す */
function withRows<T>(rows: T[], added: T[], body: () => Promise<void>): Promise<void> {
  rows.push(...added);
  return body().finally(() => {
    for (const r of added) rows.splice(rows.indexOf(r), 1);
  });
}

function keptComment(id: number, d: string, body: string, v: Partial<ContactEventRecord> = {}): ContactEventRecord {
  const at = `${d}T09:00:00`;
  return {
    contact_event_id: id, child_id: 'C001', class_id: 1, contact_date: d, event_type: '4', recorded_at: at,
    meal_kind: null, meal_amount: null, toilet_label: null, temperature: null, body, contact_photo_id: null,
    keep_in_growth: true, staff_id: 'S003', corrected_at: null, is_deleted: false, created_at: at, updated_at: at, ...v,
  };
}

describe('成長の記録を読める人（詳細設計書 (4-12 (1))）', () => {
  it.each(growthAccessCases)('%s', async (_name, who, child, ok) => {
    const read = api.growthRecord(who, child);
    if (ok) await expect(read).resolves.toMatchObject({ child_id: child });
    else await expect(read).rejects.toThrow(MSG.growthForbidden);
  });

  it('形の崩れた before は断る', async () => {
    await expect(api.growthRecord(taroGuardian, 'C001', '2026-13-01')).rejects.toThrow('リクエストの内容を読み取れませんでした');
  });

  it('猶予中は読めて期限を返す。紐づけより前の記録も読める。紐づけを終えたら読めない', async () => {
    const link = db.guardianChildren.find((g) => g.guardian_id === 'G001' && g.child_id === 'C001')!;
    const saved = { ...link };
    try {
      Object.assign(link, { link_status: '3', grace_ends_on: day(20), linked_at: `${today()}T09:00:00` });
      const g = await api.growthRecord(taroGuardian, 'C001');
      expect(g.grace_ends_on).toBe(day(20));
      expect(g.measurements.length).toBeGreaterThan(0);
      expect(g.achievements.length).toBeGreaterThan(0);
      Object.assign(link, { link_status: '2' });
      await expect(api.growthRecord(taroGuardian, 'C001')).rejects.toThrow(MSG.growthForbidden);
    } finally {
      Object.assign(link, saved);
    }
  });
});

describe('届くもの（詳細設計書「成長の記録に届くもの」(3-7)）', () => {
  it('測った値は全件・新しい順。確定した「確認できた」のうち共有する項目とひとことだけ。所見・「一部」「未確認」・職員は返さない', async () => {
    const check = db.developmentChecks.find((c) => c.development_check_id === 1)!;
    const savedNote = check.note;
    try {
      check.note = '所見のひみつ';
      const g = await api.growthRecord(taroGuardian, 'C001');
      expect(g.child_name).toBe('野原 太郎');
      expect(g.share_physical).toBe(true);
      expect(g.disclaimer).toContain('判定・診断を行うものではありません');
      const dates = g.measurements.map((m) => m.measured_on);
      expect(dates).toHaveLength(3);
      expect(dates).toEqual([...dates].sort().reverse());
      // デモの今日の測定は「きょう」、前の測定は付かない
      expect(g.measurements[0].is_today).toBe(true);
      expect(g.measurements[1].is_today).toBe(false);
      const child = db.children.find((c) => c.child_id === 'C001')!;
      expect(g.measurements[0].age_in_months).toBe(ageInMonths(child.birth_date, g.measurements[0].measured_on));

      const dev = g.achievements.filter((e) => e.kind === 'development');
      expect(dev).toHaveLength(1);
      expect(dev[0].items).toEqual(['つかまり立ちをする', '伝い歩きをする']);
      expect(dev[0].message).toBe('ボールを転がすと、追いかけて両手でつかもうとしていました。');
      const text = JSON.stringify(g);
      for (const hidden of ['所見のひみつ', 'パパ', '自分でやりたい', 'note', 'staff', 'development_check_id', 'development_item_id', 'share_status', 'やせ', '標準', '遅れ']) {
        expect(text).not.toContain(hidden);
      }
    } finally {
      check.note = savedNote;
    }
  });

  it('項目を共有しないにすると次から出ない。下書きと、届くもの無しの確定は出ない。身体測定を共有しないと測った値は空', async () => {
    const share = db.shareSettings.find((s) => s.development_item_id === 142)!;
    const setting = db.settings.find((s) => s.setting_key === 'growth.share_physical')!;
    const draft = { development_check_id: 9901, child_id: 'C001', development_schedule_id: null, checked_on: day(-2), status: '1' as const,
      staff_id: 'S003', share_status: '1' as const, guardian_message: '下書きのひとこと' };
    const empty = { development_check_id: 9902, child_id: 'C001', development_schedule_id: null, checked_on: day(-3), status: '2' as const,
      staff_id: 'S003', share_status: '1' as const, finalized_at: `${day(-3)}T16:00:00` };
    await withRows(db.developmentChecks, [draft, empty], async () => {
      try {
        share.is_shareable = false;
        let g = await api.growthRecord(taroGuardian, 'C001');
        const dev = g.achievements.filter((e) => e.kind === 'development');
        expect(dev).toHaveLength(1);
        expect(dev[0].items).toEqual(['つかまり立ちをする']);
        expect(JSON.stringify(g)).not.toContain('下書きのひとこと');

        setting.setting_value = '0';
        g = await api.growthRecord(taroGuardian, 'C001');
        expect(g.share_physical).toBe(false);
        expect(g.measurements).toEqual([]);
      } finally {
        share.is_shareable = true;
        setting.setting_value = '1';
      }
    });
  });

  it('「成長の記録に残す」を付けた連絡帳の行。残していない・取り消した・出す項目から外した種類は出ない', async () => {
    const show = db.settings.find((s) => s.setting_key === 'contact.show_items')!;
    const savedShow = show.setting_value;
    const rows = [
      keptComment(9801, day(-1), '残したひとこと'),
      keptComment(9802, day(-1), '残していないひとこと', { keep_in_growth: false }),
      keptComment(9803, day(-1), '取り消したひとこと', { is_deleted: true }),
    ];
    await withRows(db.contactEvents, rows, async () => {
      try {
        let g = await api.growthRecord(taroGuardian, 'C001');
        const text = JSON.stringify(g);
        expect(text).toContain('残したひとこと');
        expect(text).not.toContain('残していないひとこと');
        expect(text).not.toContain('取り消したひとこと');
        const kept = g.achievements.find((e) => e.body === '残したひとこと')!;
        expect(kept).toMatchObject({ kind: 'contact', date: day(-1), is_today: false });

        show.setting_value = 'nap,meal,toilet,temperature,photo,class';
        g = await api.growthRecord(taroGuardian, 'C001');
        expect(JSON.stringify(g)).not.toContain('残したひとこと');
      } finally {
        show.setting_value = savedShow;
      }
    });
  });
});

describe('12件ずつ読む（詳細設計書 (4-12 (1))）', () => {
  it('next_before で続きを読み、重ならず漏れない。測った値は毎回全件', async () => {
    const demo = db.contactEvents.filter((e) => e.child_id === 'C001' && e.keep_in_growth);
    for (const e of demo) e.keep_in_growth = false;
    const rows = Array.from({ length: 14 }, (_, i) => keptComment(9700 + i, day(-(i + 1)), `ページの行${String(i + 1).padStart(2, '0')}`));
    try {
      await withRows(db.contactEvents, rows, async () => {
        // デモの発達チェック（1件）と合わせて 15 件
        const first = await api.growthRecord(taroGuardian, 'C001');
        expect(first.achievements).toHaveLength(12);
        expect(first.next_before).toBe(first.achievements[11].at);
        const ats = first.achievements.map((e) => e.at);
        expect(ats).toEqual([...ats].sort().reverse());
        const second = await api.growthRecord(taroGuardian, 'C001', first.next_before);
        expect(second.achievements).toHaveLength(3);
        expect(second.next_before).toBeNull();
        expect(second.measurements).toEqual(first.measurements);
        const all = [...first.achievements, ...second.achievements].map((e) => e.body ?? e.kind);
        expect(new Set(all).size).toBe(15);
      });
    } finally {
      for (const e of demo) e.keep_in_growth = true;
    }
  });
});

describe('確定した日時（詳細設計書「成長の記録に届くもの」(3-7)、決めたこと D-31）', () => {
  it('初めて確定したときだけ入れ、確定し直しても動かさない。下書きでは入らない', async () => {
    const checkedOn = day(-1);
    const save = (status: '1' | '2') => api.saveCheck(teacher, 'C002', checkedOn, [{ development_item_id: 151, result: '1' }], '', status);
    const find = () => db.developmentChecks.find((c) => c.child_id === 'C002' && c.checked_on === checkedOn)!;
    await save('1');
    expect(find().finalized_at ?? null).toBeNull();
    await save('2');
    expect(find().finalized_at).toBeTruthy();
    find().finalized_at = '2026-01-01T00:00:00';
    await save('2');
    expect(find().finalized_at).toBe('2026-01-01T00:00:00');
  });
});

describe('「成長の記録に残す」の付け外し（詳細設計書 (4-12 (3))、server/api_growth_test.go の TestKeepInGrowth と同じ観点）', () => {
  it('その日はクラスの担任が付け外しでき、corrected_at を変えず版を進める。古い版・読めない人・ひとこと以外・前の日の担任は断る', async () => {
    const todayRow = keptComment(9501, today(), 'きょう残すひとこと', { keep_in_growth: false, staff_id: 'S004' });
    const meal: ContactEventRecord = { ...keptComment(9502, today(), ''), event_type: '1', body: null, meal_kind: '1', meal_amount: '1', keep_in_growth: false };
    const oldRow = keptComment(9503, day(-1), 'きのうのひとこと', { keep_in_growth: false });
    const deleted = keptComment(9504, today(), '取り消したひとこと', { keep_in_growth: false, is_deleted: true });
    await withRows(db.contactEvents, [todayRow, meal, oldRow, deleted], async () => {
      const v = todayRow.updated_at;
      const saved = await api.keepInGrowth(teacher, 9501, true, v);
      expect(saved.keep_in_growth).toBe(true);
      expect(saved.corrected_at).toBeNull();
      expect(saved.updated_at).not.toBe(v);
      expect(JSON.stringify(await api.growthRecord(taroGuardian, 'C001'))).toContain('きょう残すひとこと');
      const lastLog = db.operationLogs[0]; // 新しいものが先頭
      expect(lastLog.after_value).toBe(JSON.stringify({ 成長の記録に残す: '残す' }));

      await expect(api.keepInGrowth(teacher, 9501, false, v)).rejects.toThrow(MSG.versionConflict);
      const same = await api.keepInGrowth(teacher, 9501, true, saved.updated_at!);
      expect(same.updated_at).toBe(saved.updated_at);
      await api.keepInGrowth(teacher, 9501, false, saved.updated_at!);
      expect(JSON.stringify(await api.growthRecord(taroGuardian, 'C001'))).not.toContain('きょう残すひとこと');

      await expect(api.keepInGrowth(otherTeacher, 9501, true, todayRow.updated_at)).rejects.toThrow(MSG.contactForbidden);
      await expect(api.keepInGrowth(taroGuardian, 9501, true, todayRow.updated_at)).rejects.toThrow(MSG.contactForbidden);
      await expect(api.keepInGrowth(teacher, 9502, true, meal.updated_at)).rejects.toThrow(MSG.badChoice);
      await expect(api.keepInGrowth(teacher, 9503, true, oldRow.updated_at)).rejects.toThrow(MSG.growthFixForbidden);
      await expect(api.keepInGrowth(admin, 9503, true, oldRow.updated_at)).resolves.toMatchObject({ keep_in_growth: true });
      await expect(api.keepInGrowth(admin, 9504, true, deleted.updated_at)).rejects.toThrow(MSG.contactForbidden);
    });
  });

  it('保護者の連絡帳の応答には出来事の版を入れない', async () => {
    const page = await api.contactPage(taroGuardian, 'C001');
    expect(page.events.every((e) => e.updated_at === undefined)).toBe(true);
    const staffPage = await api.contactPage(teacher, 'C001');
    expect(staffPage.events.every((e) => typeof e.updated_at === 'string')).toBe(true);
  });
});

describe('発達チェックの保護者へのひとこと（詳細設計書 (4-12 (2))、server/api_growth_test.go の TestDevelopmentGuardianMessage と同じ観点）', () => {
  it('下書きでは届かず、確定で届く。500文字を超えると断り、空白だけなら残さない。書けない職員は断る', async () => {
    const checkedOn = day(-1);
    const save = (status: '1' | '2', message: string | null, who: SessionUser = teacher) =>
      api.saveCheck(who, 'C001', checkedOn, [], '', status, message);
    const draft = await save('1', '  積み木を3つ積みました  ');
    expect(draft.guardian_message).toBe('積み木を3つ積みました');
    expect(draft.finalized_at ?? null).toBeNull();
    expect(JSON.stringify(await api.growthRecord(taroGuardian, 'C001'))).not.toContain('積み木を3つ積みました');
    await save('2', '積み木を3つ積みました');
    expect(JSON.stringify(await api.growthRecord(taroGuardian, 'C001'))).toContain('積み木を3つ積みました');
    await expect(save('2', 'あ'.repeat(501))).rejects.toThrow(MSG.guardianMessageTooLong);
    expect((await save('2', '   ')).guardian_message).toBeNull();
    await expect(save('1', null, otherTeacher)).rejects.toThrow('この園児を記録する権限がありません');
    const staff = db.classStaff.splice(db.classStaff.findIndex((s) => s.staff_id === 'S005'), 1);
    try {
      await expect(save('1', null, user(5, '2', { staff_id: 'S005', class_id: null }))).rejects.toThrow('この園児を記録する権限がありません');
    } finally {
      db.classStaff.push(...staff);
    }
  });
});

/*
 * 確定した保護者へのひとことの訂正（要件定義書「保護者へ届けるときの関所」(4-1-6) の (2)、詳細設計書 (2-12 (2))・(4-12 (2))、
 * 決めたこと D-51。PR #216 で決まった設計）。server/api_growth_test.go の TestDevelopmentGuardianMessageCorrection と同じ流れ
 */
describe('確定した保護者へのひとことの訂正（D-51）', () => {
  it('確定した日は担任、翌日以降は管理者だけが変えられ、書き換えたときだけ「訂正しました」の印を付ける', async () => {
    // 実施日は前の日。確定した日（今日）で担任が直せるかが決まり、実施日では決まらないことも見る
    const checkedOn = day(-2);
    const save = (who: SessionUser, message: string | null, note = '') =>
      api.saveCheck(who, 'C001', checkedOn, [], note, '2', message);
    const find = () => db.developmentChecks.find((c) => c.child_id === 'C001' && c.checked_on === checkedOn)!;
    const entry = async () => (await api.growthRecord(taroGuardian, 'C001')).achievements
      .find((e) => e.kind === 'development' && e.message?.startsWith('ひとこと'));
    try {
      // 確定した日：担任が書き換えると印が付き、成長の記録に「訂正しました」の時刻が出る
      await save(teacher, 'ひとこと1');
      expect(find().guardian_message_corrected_at ?? null).toBeNull();
      expect((await entry())?.message_corrected_at ?? null).toBeNull();
      await save(teacher, 'ひとこと2');
      expect(find().guardian_message).toBe('ひとこと2');
      const corrected = find().guardian_message_corrected_at;
      expect(corrected).toBeTruthy();
      expect(await entry()).toMatchObject({ message: 'ひとこと2', message_corrected_at: corrected });
      // 操作ログは新しい順に並ぶ（mock.ts の log は先頭に足す）
      const fix = db.operationLogs.find((l) => l.target_table === 't_development_check' && l.before_value);
      expect([fix?.before_value, fix?.after_value]).toEqual(['{"保護者へのひとこと":"ひとこと1"}', '{"保護者へのひとこと":"ひとこと2"}']);
      // 所見だけを直しても印は動かない
      find().guardian_message_corrected_at = '2026-01-01T00:00:00';
      await save(teacher, 'ひとこと2', '所見だけ');
      expect(find().guardian_message_corrected_at).toBe('2026-01-01T00:00:00');

      // 翌日以降：担任はひとことを変えられない（書き換え・空にする）。結果・所見だけなら直せる
      find().finalized_at = `${checkedOn}T16:00:00`;
      await expect(save(teacher, 'ひとこと3')).rejects.toThrow(MSG.guardianMessageFixForbidden);
      await expect(save(teacher, null)).rejects.toThrow(MSG.guardianMessageFixForbidden);
      await save(teacher, 'ひとこと2', '翌日に所見を直す');
      expect(find().guardian_message).toBe('ひとこと2');
      // 管理者は翌日以降も書き換えられ、印が付く
      await save(admin, 'ひとこと4');
      expect(find().guardian_message).toBe('ひとこと4');
      expect(find().guardian_message_corrected_at).not.toBe('2026-01-01T00:00:00');
      expect(find().guardian_message_corrected_at).toBeTruthy();
      // 空にすると取り消し：ひとことは成長の記録から消え、印も消す
      await save(admin, null);
      expect(find().guardian_message ?? null).toBeNull();
      expect(find().guardian_message_corrected_at ?? null).toBeNull();
      expect(await entry()).toBeUndefined();
      // 空から書き足すのも翌日以降は管理者だけ。書き足しは初めて届くため印を付けない
      await expect(save(teacher, 'ひとこと5')).rejects.toThrow(MSG.guardianMessageFixForbidden);
      await save(admin, 'ひとこと5');
      expect(find().guardian_message_corrected_at ?? null).toBeNull();
      expect((await entry())?.message_corrected_at ?? null).toBeNull();
    } finally {
      // 同じファイルのほかのテストのために、足した記録を消す
      const i = db.developmentChecks.findIndex((c) => c.child_id === 'C001' && c.checked_on === checkedOn);
      if (i >= 0) db.developmentChecks.splice(i, 1);
    }
  });
});
