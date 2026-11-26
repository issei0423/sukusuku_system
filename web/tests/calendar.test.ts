/*
 * 行事カレンダー（モックの規則）
 * 典拠：設計書に定め無し。配布物の形に合わせた【仮置き】（web/仮置き値.md「行事カレンダーの動き」）
 *
 * Go サーバ（server/api_event_test.go）と同じ観点を、モック（api/mock.ts の calendarApi）に対して確かめる。
 * 業務の規則は2か所にあるため、片方だけ直すと食い違う（AGENTS.md）。
 * mockDb は同じファイルのテストどうしで使い回されるので、件数を決め打ちせず、題名と ID で探す。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import type { SessionUser, CalendarEventInput } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
// さくら組（クラス 1）の担任
const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
// ひまわり組（クラス 2）の担任
const otherTeacher: SessionUser = {
  account_id: 5, email: 'kubota@hoiku.example.jp', role: '2', display_name: '久保田 和也',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
  is_temp_password: false, terms_agreed: true,
};
// 担当クラスの無い一般職員（フリー）。見るだけ
const freeStaff: SessionUser = { ...teacher, class_id: null, class_name: null };
// 西田 太郎（C001・さくら組）の保護者
const guardian: SessionUser = {
  account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

const thisMonth = today().slice(0, 7);
const nextMonth = (() => {
  const [y, m] = thisMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
})();

const input = (over: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  event_date: `${thisMonth}-25`, start_time: null, end_time: null, title: '行事', note: '', class_id: null, ...over,
});
const titles = async (u: SessionUser, month = thisMonth) => (await api.calendarEvents(u, month)).events.map((e) => e.title);

describe('行事カレンダー：見られる範囲', () => {
  it('管理者は、園全体とすべてのクラスの予定を見られる', async () => {
    const t = await titles(admin);
    expect(t).toEqual(expect.arrayContaining(['運動会', '誕生会', '身体測定']));
    expect(await titles(admin, nextMonth)).toContain('遠足');
  });

  it('一般職員は、園全体と自クラスの予定だけを見られる（他クラスは見えない）', async () => {
    expect(await titles(teacher)).toEqual(expect.arrayContaining(['運動会', '身体測定']));
    expect(await titles(teacher, nextMonth)).not.toContain('遠足');
    expect(await titles(otherTeacher)).not.toContain('身体測定');
    expect(await titles(otherTeacher, nextMonth)).toContain('遠足');
  });

  it('保護者は、園全体と自分の子がいまいるクラスの予定だけを見られる', async () => {
    // G001 の子（C001）はさくら組。ひまわり組の「遠足」は見えない
    expect(await titles(guardian)).toEqual(expect.arrayContaining(['運動会', '誕生会', '身体測定']));
    expect(await titles(guardian, nextMonth)).not.toContain('遠足');
  });

  it('デモの予定：クラスの予定は、今年度でクラス ID が小さい順の1番目と2番目のクラスに置かれる', async () => {
    const ids = db.classes.filter((c) => c.fiscal_year === db.FISCAL_YEAR).map((c) => c.class_id).sort((a, b) => a - b);
    const all = [...(await api.calendarEvents(admin, thisMonth)).events, ...(await api.calendarEvents(admin, nextMonth)).events];
    expect(all.find((e) => e.title === '身体測定')).toMatchObject({ class_id: ids[0], start_time: null, end_time: null });
    expect(all.find((e) => e.title === '遠足')).toMatchObject({ class_id: ids[1], start_time: '09:00', end_time: '14:00' });
    expect(all.find((e) => e.title === '運動会')).toMatchObject({ class_id: null, class_name: null, start_time: '09:30', end_time: '12:00' });
  });

  it('並びは日付、開始の時刻（終日が先）、ID の順', async () => {
    const date = `${thisMonth}-27`;
    const b = await api.addCalendarEvent(admin, input({ event_date: date, start_time: '10:00', title: '並び B' }));
    const a = await api.addCalendarEvent(admin, input({ event_date: date, start_time: '09:00', title: '並び A' }));
    const allDay = await api.addCalendarEvent(admin, input({ event_date: date, title: '並び 終日' }));
    const day = (await api.calendarEvents(admin, thisMonth)).events.filter((e) => e.event_date === date).map((e) => e.event_id);
    expect(day).toEqual([allDay.event_id, a.event_id, b.event_id]);
  });
});

describe('行事カレンダー：書ける範囲', () => {
  it('書ける範囲を返す（管理者は全クラスと園全体、一般は自クラス、保護者・フリーは空）', async () => {
    const ids = db.classes.filter((c) => c.fiscal_year === db.FISCAL_YEAR).map((c) => c.class_id);
    const a = await api.calendarEvents(admin, thisMonth);
    expect(a.can_write_all).toBe(true);
    expect([...a.writable_class_ids].sort()).toEqual([...ids].sort());
    const t = await api.calendarEvents(teacher, thisMonth);
    expect(t).toMatchObject({ can_write_all: false, writable_class_ids: [1] });
    for (const u of [guardian, freeStaff]) {
      expect(await api.calendarEvents(u, thisMonth)).toMatchObject({ can_write_all: false, writable_class_ids: [] });
    }
  });

  it('保育士は自クラスに足せる。他クラスと園全体には足せない', async () => {
    const e = await api.addCalendarEvent(teacher, input({ title: '保育士が足した', class_id: 1 }));
    expect(e).toMatchObject({ class_id: 1, class_name: 'さくら組', can_edit: true });
    await expect(api.addCalendarEvent(teacher, input({ class_id: 2 }))).rejects.toThrow('この対象の予定は書けません');
    await expect(api.addCalendarEvent(teacher, input({ class_id: null }))).rejects.toThrow('この対象の予定は書けません');
    expect(await titles(teacher)).toContain('保育士が足した');
  });

  it('管理者は園全体にも足せる', async () => {
    const e = await api.addCalendarEvent(admin, input({ title: '管理者が足した園全体', class_id: null }));
    expect(e).toMatchObject({ class_id: null, class_name: null, can_edit: true });
    // 保護者にも見える
    expect(await titles(guardian)).toContain('管理者が足した園全体');
  });

  it('保護者と担当クラスの無い職員は足せない', async () => {
    await expect(api.addCalendarEvent(guardian, input({ class_id: 1 }))).rejects.toThrow('職員のみが行えます');
    await expect(api.addCalendarEvent(guardian, input({ class_id: null }))).rejects.toThrow('職員のみが行えます');
    await expect(api.addCalendarEvent(freeStaff, input({ class_id: 1 }))).rejects.toThrow('この対象の予定は書けません');
  });

  it('can_edit は、書ける予定だけ true', async () => {
    const mine = (await api.calendarEvents(teacher, thisMonth)).events;
    expect(mine.find((e) => e.title === '身体測定')!.can_edit).toBe(true);
    expect(mine.find((e) => e.title === '運動会')!.can_edit).toBe(false);
    expect((await api.calendarEvents(guardian, thisMonth)).events.every((e) => !e.can_edit)).toBe(true);
  });
});

describe('行事カレンダー：直す・消す', () => {
  it('直せる。元と新しいクラスの両方に権限が要る', async () => {
    const e = await api.addCalendarEvent(teacher, input({ title: '直す前', class_id: 1 }));
    const fixed = await api.updateCalendarEvent(teacher, e.event_id, input({ title: '直したあと', class_id: 1, start_time: '10:00' }));
    expect(fixed).toMatchObject({ event_id: e.event_id, title: '直したあと', start_time: '10:00' });
    // 新しいクラスに権限が無い（他クラス・園全体へは移せない）
    await expect(api.updateCalendarEvent(teacher, e.event_id, input({ class_id: 2 }))).rejects.toThrow('この対象の予定は書けません');
    await expect(api.updateCalendarEvent(teacher, e.event_id, input({ class_id: null }))).rejects.toThrow('この対象の予定は書けません');
    // 元のクラスに権限が無い
    await expect(api.updateCalendarEvent(otherTeacher, e.event_id, input({ class_id: 2 }))).rejects.toThrow('この予定は直せません');
    await expect(api.updateCalendarEvent(guardian, e.event_id, input({ class_id: 1 }))).rejects.toThrow('職員のみが行えます');
    // 管理者はクラスを移せる
    const moved = await api.updateCalendarEvent(admin, e.event_id, input({ title: '直したあと', class_id: 2 }));
    expect(moved.class_id).toBe(2);
    expect(await titles(teacher)).not.toContain('直したあと');
    expect(await titles(otherTeacher)).toContain('直したあと');
  });

  it('無い ID は見つからない', async () => {
    await expect(api.updateCalendarEvent(admin, 999_999, input())).rejects.toThrow('見つかりません');
    await expect(api.deleteCalendarEvent(admin, 999_999)).rejects.toThrow('見つかりません');
  });

  it('消すと一覧に出ない。二度消すと見つからない。権限が無い人は消せない', async () => {
    const e = await api.addCalendarEvent(teacher, input({ title: '消す予定', class_id: 1 }));
    await expect(api.deleteCalendarEvent(otherTeacher, e.event_id)).rejects.toThrow('この予定は消せません');
    await expect(api.deleteCalendarEvent(guardian, e.event_id)).rejects.toThrow('職員のみが行えます');
    await api.deleteCalendarEvent(teacher, e.event_id);
    for (const u of [teacher, admin, guardian]) expect(await titles(u)).not.toContain('消す予定');
    await expect(api.deleteCalendarEvent(teacher, e.event_id)).rejects.toThrow('見つかりません');
    await expect(api.updateCalendarEvent(teacher, e.event_id, input({ class_id: 1 }))).rejects.toThrow('見つかりません');
  });

  it('園全体の予定は、一般職員には直せず消せない', async () => {
    const e = (await api.calendarEvents(teacher, thisMonth)).events.find((x) => x.title === '運動会')!;
    await expect(api.updateCalendarEvent(teacher, e.event_id, input({ class_id: 1 }))).rejects.toThrow('この予定は直せません');
    await expect(api.deleteCalendarEvent(teacher, e.event_id)).rejects.toThrow('この予定は消せません');
  });
});

describe('行事カレンダー：入力の検証', () => {
  const bad = (over: Partial<CalendarEventInput>, message: string) =>
    expect(api.addCalendarEvent(admin, input(over))).rejects.toThrow(message);

  it('日付は実在する日付', async () => {
    await bad({ event_date: '2026-02-30' }, '日付');
    await bad({ event_date: '2026/11/05' }, '日付');
    await bad({ event_date: '' }, '日付');
  });

  it('時刻は「09:30」の形。終了だけは不可。開始は終了以前', async () => {
    await bad({ start_time: '9:00' }, '「09:30」の形');
    await bad({ start_time: '24:00' }, '「09:30」の形');
    await bad({ start_time: '09:00', end_time: '12:60' }, '「09:30」の形');
    await bad({ end_time: '12:00' }, '終了の時刻だけ');
    await bad({ start_time: '12:00', end_time: '11:59' }, '開始の時刻以降');
    // 同じ時刻はよい
    const same = await api.addCalendarEvent(admin, input({ title: '同じ時刻', start_time: '12:00', end_time: '12:00' }));
    expect(same.start_time).toBe('12:00');
  });

  it('題名は空白を除いて1〜50文字。前後の空白は除いて保存する', async () => {
    await bad({ title: '' }, '題名');
    await bad({ title: '   ' }, '題名');
    await bad({ title: 'あ'.repeat(51) }, '50文字');
    expect((await api.addCalendarEvent(admin, input({ title: 'あ'.repeat(50) }))).title).toBe('あ'.repeat(50));
    expect((await api.addCalendarEvent(admin, input({ title: '  前後の空白  ' }))).title).toBe('前後の空白');
  });

  it('内容は500文字以下', async () => {
    await bad({ note: 'あ'.repeat(501) }, '500文字');
    expect((await api.addCalendarEvent(admin, input({ title: '内容500', note: 'あ'.repeat(500) }))).note).toHaveLength(500);
  });

  it('直すときも同じ検証をする', async () => {
    const e = await api.addCalendarEvent(admin, input({ title: '検証用' }));
    await expect(api.updateCalendarEvent(admin, e.event_id, input({ title: '' }))).rejects.toThrow('題名');
    await expect(api.updateCalendarEvent(admin, e.event_id, input({ end_time: '10:00' }))).rejects.toThrow('終了の時刻だけ');
  });

  it('月の形が悪いと断る', async () => {
    for (const m of ['', '2026-13', '2026-1', '202611', '2026-11-01', 'abc']) {
      await expect(api.calendarEvents(admin, m)).rejects.toThrow('月を指定してください');
    }
  });
});

describe('行事カレンダー：判定の順（server/api_event.go と同じ）', () => {
  it('足す：職員だけ → 体の検証（400）→ 対象の権限（403）→ 対象のクラスの有無（400）', async () => {
    // 保護者は体が正しくても、体が誤っていても、職員のみの断り
    await expect(api.addCalendarEvent(guardian, input({ title: '' }))).rejects.toThrow('職員のみが行えます');
    // 権限の無い対象でも、体が誤っていれば先に検証で断る
    await expect(api.addCalendarEvent(teacher, input({ title: '', class_id: null }))).rejects.toThrow('題名を入力してください');
    await expect(api.addCalendarEvent(teacher, input({ class_id: null }))).rejects.toThrow('この対象の予定は書けません');
    // 管理者が指定したクラスが無ければ 400
    await expect(api.addCalendarEvent(admin, input({ class_id: 999 }))).rejects.toThrow('対象のクラスが見つかりません');
    // 一般職員が無いクラスを指定すると、権限の断りが先
    await expect(api.addCalendarEvent(teacher, input({ class_id: 999 }))).rejects.toThrow('この対象の予定は書けません');
  });

  it('直す：職員だけ → 元を読む（404）→ 元の権限（403）→ 体の検証（400）→ 新しい対象の権限（403）→ クラスの有無（400）', async () => {
    const e = await api.addCalendarEvent(teacher, input({ title: '順番の確認', class_id: 1 }));
    await expect(api.updateCalendarEvent(guardian, 999_999, input())).rejects.toThrow('職員のみが行えます');
    // 無い ID は、権限や体より先に 404
    await expect(api.updateCalendarEvent(teacher, 999_999, input({ title: '', class_id: null }))).rejects.toThrow('予定が見つかりません');
    // 元のクラスの権限は、体の検証より先
    await expect(api.updateCalendarEvent(otherTeacher, e.event_id, input({ title: '', class_id: 2 }))).rejects.toThrow('この予定は直せません');
    // 元の権限があれば、次は体の検証。新しい対象の権限より先
    await expect(api.updateCalendarEvent(teacher, e.event_id, input({ title: '', class_id: 2 }))).rejects.toThrow('題名を入力してください');
    await expect(api.updateCalendarEvent(teacher, e.event_id, input({ class_id: 2 }))).rejects.toThrow('この対象の予定は書けません');
    await expect(api.updateCalendarEvent(admin, e.event_id, input({ class_id: 999 }))).rejects.toThrow('対象のクラスが見つかりません');
  });

  it('消す：職員だけ → 元を読む（404）→ 元の権限（403）', async () => {
    await expect(api.deleteCalendarEvent(guardian, 999_999)).rejects.toThrow('職員のみが行えます');
    await expect(api.deleteCalendarEvent(otherTeacher, 999_999)).rejects.toThrow('予定が見つかりません');
  });
});

describe('行事カレンダー：操作ログ', () => {
  it('足す・直す・消すを t_event として残す（機能種別はチャットを流用）', async () => {
    const e = await api.addCalendarEvent(admin, input({ title: 'ログ確認' }));
    await api.updateCalendarEvent(admin, e.event_id, input({ title: 'ログ確認（直し）' }));
    await api.deleteCalendarEvent(admin, e.event_id);
    const logs = db.operationLogs.filter((l) => l.target_table === 't_event' && l.target_id === e.event_id);
    expect(logs.map((l) => l.operation_type).sort()).toEqual(['1', '2', '4']);
    expect(logs.every((l) => l.function_type === '2' && l.account_id === admin.account_id)).toBe(true);
  });
});
