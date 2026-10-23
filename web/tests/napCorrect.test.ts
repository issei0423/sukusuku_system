/*
 * 午睡チェックの記録の修正（api.correctNapRecord。サーバの POST /api/nap/records/{id}/correct）
 * 典拠：基本設計書.md「記録の修正と改ざん防止」「帳票の出力」(4-8)・「入力項目の制約値」(4-12)・「操作ログ（t_operation_log）」(5-9)、
 *      詳細設計書.md「訂正・取り消しのまとめ」(3-5)、図/画面詳細図.md「午睡記録検索画面」(5-3) の項目10・12
 *
 * Go サーバ側（server/api_nap_correct_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 * デモ：今日の実施 1（さくら組）に記録 1（西田 太郎 13:20、仰向け・あり・通常・36.6）と記録 2（遠藤 花子 13:20、右向き・36.8）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { NAP_CORRECT_MSG } from '../src/api/napCorrect';
import { NAP_ABNORMAL_TITLE, NAP_HISTORY_HEADER, NAP_HISTORY_TITLE } from '../src/api/napReport';
import type { SessionUser } from '../src/api/types';
import { now } from '../src/api/util';

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
const otherTeacher: SessionUser = {
  account_id: 5, email: 'kubota@hoiku.example.jp', role: '2', display_name: '久保田 和也',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
  is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

const sessionDateOf = (id: number) => db.napSessions.find((s) => s.nap_session_id === id)!.session_date;
const today = () => sessionDateOf(1);
const yesterday = () => sessionDateOf(2);
const twoDaysAgo = () => sessionDateOf(3);
const recordOf = (id: number) => db.napRecords.find((r) => r.nap_record_id === id)!;
/** 午睡チェックの記録の修正の操作ログ（午睡 3・変更 2・t_nap_record）を古い順に */
const correctLogs = () => db.operationLogs
  .filter((l) => l.function_type === '3' && l.operation_type === '2' && l.target_table === 't_nap_record')
  .slice().reverse();

/*
 * mockDb の中身は同じファイルのテストどうしで使い回されるため、書き換える表を毎回もとへ戻す
 */
let saved: {
  records: typeof db.napRecords; abnormals: typeof db.napAbnormals; classStaff: typeof db.classStaff; logs: typeof db.operationLogs;
};
beforeEach(() => {
  saved = {
    records: db.napRecords.map((r) => ({ ...r })), abnormals: db.napAbnormals.map((a) => ({ ...a })),
    classStaff: db.classStaff.map((c) => ({ ...c })), logs: [...db.operationLogs],
  };
});
afterEach(() => {
  db.napRecords.splice(0, db.napRecords.length, ...saved.records);
  db.napAbnormals.splice(0, db.napAbnormals.length, ...saved.abnormals);
  db.classStaff.splice(0, db.classStaff.length, ...saved.classStaff);
  db.operationLogs.splice(0, db.operationLogs.length, ...saved.logs);
});

/** 昨日の実施 2（さくら組）に、西田 太郎の確認の記録を足す */
function addYesterdayRecord(): number {
  const id = 900501;
  db.napRecords.push({
    nap_record_id: id, nap_session_id: 2, child_id: 'C001', checked_at: `${yesterday()}T13:20:00`, saved_at: `${yesterday()}T13:20:10`,
    body_position: '1', breathing: '1', complexion: '1', temperature: null, staff_id: 'S003',
  });
  return id;
}

/** 今日の実施 1 で、遠藤 花子（記録 2）に異常時の記録を足す */
function addTodayAbnormalForC002(): void {
  db.napAbnormals.push({
    nap_abnormal_id: 900601, nap_session_id: 1, child_id: 'C002', found_at: now(), recorded_at: now(),
    situation: '状況', response: '対応', staff_id: 'S003', diary_id: null,
  });
}

describe('午睡チェックの記録の修正', () => {
  it('その園児のクラスの担任は実施の日のうちに直せる。行を書き換え、変わった項目だけを修正前・修正後と理由で操作ログへ残す', async () => {
    const before = { ...recordOf(1) };
    const got = await api.correctNapRecord(teacher, 1, {
      body_position: '2', temperature: 36.9, breathing: '1', reason: '  体位を押し間違えた  ',
    });
    expect(got).toMatchObject({ body_position: '2', temperature: 36.9, breathing: '1', child_id: 'C001' });
    expect(got.corrected_at).toBeTruthy();
    // チェックした時刻・保存時刻・記録した職員は変えない
    expect([got.checked_at, got.saved_at, got.staff_id]).toEqual([before.checked_at, before.saved_at, before.staff_id]);
    expect(recordOf(1)).toMatchObject({ body_position: '2', temperature: 36.9 });

    // 呼吸は同じ値を送ったので入れない。理由は前後の空白を除く（server/api_nap_correct_test.go と同じ JSON）
    expect(correctLogs().map((l) => [l.account_id, l.target_id, l.target_child_id, l.before_value, l.after_value])).toEqual([
      [3, 1, 'C001', '{"体位":"仰向け","体温":36.6}', '{"体位":"うつ伏せ","体温":36.9,"理由":"体位を押し間違えた"}'],
    ]);

    // 体温は null で消せる
    expect((await api.correctNapRecord(teacher, 1, { temperature: null, reason: '体温は測っていなかった' })).temperature).toBeNull();
    expect(correctLogs()[1]).toMatchObject({ before_value: '{"体温":36.9}', after_value: '{"体温":null,"理由":"体温は測っていなかった"}' });
  });

  it('理由は必須（1〜500文字）。値の誤り・変わらない修正・無い記録も断り、行も操作ログも変えない', async () => {
    const cases: [string, Parameters<typeof api.correctNapRecord>[2], number, string][] = [
      ['理由が空', { body_position: '2', reason: '' }, 1, NAP_CORRECT_MSG.reason],
      ['理由が空白だけ', { body_position: '2', reason: '　 ' }, 1, NAP_CORRECT_MSG.reason],
      ['理由が501文字', { body_position: '2', reason: 'あ'.repeat(501) }, 1, NAP_CORRECT_MSG.reasonLong],
      ['体位の値が無い', { body_position: '9' as '1', reason: 'x' }, 1, '体位を選んでください'],
      ['呼吸の値が無い', { breathing: '' as '1', reason: 'x' }, 1, '呼吸を選んでください'],
      ['顔色の値が無い', { complexion: '5' as '1', reason: 'x' }, 1, '顔色を選んでください'],
      ['体温が小数第2位', { temperature: 36.65, reason: 'x' }, 1, '体温は小数第1位までで入力してください'],
      ['変わらない', { body_position: '1', temperature: 36.6, reason: 'x' }, 1, NAP_CORRECT_MSG.noChange],
      ['直す項目が無い', { reason: 'x' }, 1, NAP_CORRECT_MSG.noChange],
      ['無い記録', { body_position: '2', reason: 'x' }, 999999, NAP_CORRECT_MSG.notFound],
    ];
    for (const [name, input, id, message] of cases) {
      await expect(api.correctNapRecord(admin, id, input), name).rejects.toThrow(message);
    }
    expect(correctLogs()).toHaveLength(0);
    expect(recordOf(1).corrected_at ?? null).toBeNull();
    // 500文字ちょうどは受け付ける
    await api.correctNapRecord(admin, 1, { body_position: '3', reason: 'あ'.repeat(500) });
    expect(correctLogs()).toHaveLength(1);
  });

  it('一般は実施の日のうちだけ。翌日以降と、その実施で異常時の記録がある子と、ほかのクラスとフリーの職員は断る。管理者はいつでも直せる', async () => {
    const yesterdayId = addYesterdayRecord();
    addTodayAbnormalForC002();
    const input = { complexion: '3' as const, reason: '顔色を見直した' };

    await expect(api.correctNapRecord(guardian, 1, input)).rejects.toThrow('職員のみが行えます');
    await expect(api.correctNapRecord(otherTeacher, 1, input)).rejects.toThrow(NAP_CORRECT_MSG.forbidden); // ほかのクラスの担任
    await expect(api.correctNapRecord(teacher, yesterdayId, input)).rejects.toThrow(NAP_CORRECT_MSG.pastDay); // 翌日以降の一般
    await expect(api.correctNapRecord(teacher, 2, input)).rejects.toThrow(NAP_CORRECT_MSG.abnormal); // 異常時の記録がある子
    expect(correctLogs()).toHaveLength(0);

    // フリーの職員（今年度の担任クラスが無い一般）は読めるが直せない
    db.classStaff.splice(0, db.classStaff.length, ...db.classStaff.filter((c) => c.staff_id !== 'S005'));
    await expect(api.correctNapRecord(otherTeacher, 1, input)).rejects.toThrow(NAP_CORRECT_MSG.forbidden);

    // 管理者は翌日以降も、異常時の記録がある子も直せる。担任はその日のうちなら直せる（記録した職員でなくてもよい）
    await api.correctNapRecord(admin, yesterdayId, input);
    await api.correctNapRecord(admin, 2, input);
    await api.correctNapRecord(teacher, 1, input);
    expect(correctLogs().map((l) => [l.account_id, l.target_id])).toEqual([[1, yesterdayId], [1, 2], [3, 1]]);
  });

  it('午睡記録検索の確認の行に、修正あり（corrected_at）と、その利用者が直せるか（can_correct）を返す', async () => {
    addYesterdayRecord();
    addTodayAbnormalForC002();
    await api.correctNapRecord(teacher, 1, { body_position: '3', reason: '左向きだった' });

    const rowsOf = async (user: SessionUser) => (await api.searchRecords(user, { from: yesterday(), to: today(), classId: 1 })).rows;
    const rows = await rowsOf(teacher);
    const record = (id: number) => rows.find((r) => r.nap_record_id === id)!;
    expect(record(1)).toMatchObject({ can_correct: true });
    expect(record(1).corrected_at).toBeTruthy();
    expect(record(2)).toMatchObject({ corrected_at: null, can_correct: false }); // 異常時の記録がある子
    expect(rows.find((r) => r.kind === 'check' && r.session_date === yesterday())?.can_correct).toBe(false); // 昨日
    expect(rows.filter((r) => r.kind !== 'check').every((r) => !r.can_correct && r.corrected_at === null)).toBe(true);
    expect((await rowsOf(admin)).filter((r) => r.kind === 'check').every((r) => r.can_correct)).toBe(true);
  });
});

/* ============ 帳票の「修正あり」と「修正の履歴」 ============ */

/** すべてのセルを " で囲んだ CSV を読む。セルの中の改行と "" を扱う（napReport.test.ts と同じ） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') { quoted = true; started = true; } else if (c === ',') { row.push(cell); cell = ''; started = true; } else if (c === '\n') {
      if (started) row.push(cell);
      rows.push(row); row = []; cell = ''; started = false;
    } else { cell += c; started = true; }
  }
  if (started) row.push(cell);
  rows.push(row);
  return rows;
}

/** 帳票を、一覧・異常時の記録・修正の履歴に分ける（server/api_nap_report_test.go の napReportOf と同じ） */
function splitReport(text: string) {
  const records = parseCsv(text);
  const out = { rows: [] as string[][], abnormals: [] as string[][], histories: [] as string[][], hasHistory: false };
  let section = out.rows;
  for (let i = 1; i < records.length; i++) {
    if (records[i].length === 0) continue;
    if (records[i].length === 1 && records[i][0] === NAP_ABNORMAL_TITLE) { section = out.abnormals; i++; continue; }
    if (records[i].length === 1 && records[i][0] === NAP_HISTORY_TITLE) {
      expect(records[i + 1]).toEqual(NAP_HISTORY_HEADER);
      out.hasHistory = true; section = out.histories; i++; continue;
    }
    section.push(records[i]);
  }
  return out;
}

describe('帳票の修正あり・修正の履歴', () => {
  it('修正した記録に「修正あり」を付け、末尾に「修正の履歴」（1回の修正で1行）を続ける。件数に履歴の行も入れる', async () => {
    const report = async (classId?: number) =>
      splitReport(await api.napReport(admin, { from: twoDaysAgo(), to: today(), classId, format: 'csv' }));
    // 修正の前は、履歴の表を出さない
    expect((await report()).hasHistory).toBe(false);

    await api.correctNapRecord(teacher, 1, { body_position: '2', temperature: 36.9, reason: '押し間違い' });
    await api.correctNapRecord(admin, 1, { temperature: null, reason: '=未計測' });
    await api.correctNapRecord(admin, 2, { breathing: '2', reason: '見直した' });

    const f = await report();
    const isFixed = (r: string[]) => r[0] === today() && r[1].endsWith('T13:20:00') && r[5] !== '' && ['西田 太郎', '遠藤 花子'].includes(r[2]);
    expect(f.rows.filter(isFixed).map((r) => [r[2], r[10]]).sort()).toEqual([['西田 太郎', '修正あり'], ['遠藤 花子', '修正あり']]);
    expect(f.rows.filter((r) => !isFixed(r)).every((r) => r[10] === '')).toBe(true);
    // 一覧の値は直したあとの値
    expect(f.rows.find((r) => isFixed(r) && r[2] === '西田 太郎')!.slice(4, 8)).toEqual(['うつ伏せ', 'あり', '通常', '']);

    // 修正の履歴：並びは 園児（よみ：えんどう → にしだ）→ 修正日時。式の始まりのセルは逃がす（' を付けて出す）
    expect(f.histories.map((h) => [h[0], h[2], h[3], h[4], h[5]])).toEqual([
      [`午睡チェックの記録（遠藤 花子・${today()}T13:20:00）`, '西田 拓也', '呼吸=あり', '呼吸=確認できず', '見直した'],
      [`午睡チェックの記録（西田 太郎・${today()}T13:20:00）`, '鈴木 浩之', '体位=仰向け、体温=36.6', '体位=うつ伏せ、体温=36.9', '押し間違い'],
      [`午睡チェックの記録（西田 太郎・${today()}T13:20:00）`, '西田 拓也', '体温=36.9', '体温=なし', '\'=未計測'],
    ]);
    expect(f.histories.every((h) => h.length === NAP_HISTORY_HEADER.length && h[1] !== '')).toBe(true);

    // 件数は、一覧・異常時の記録・修正の履歴の行の合計
    const exportLog = db.operationLogs.find((l) => l.function_type === '3' && l.operation_type === '5')!;
    expect(exportLog.after_value).toMatch(new RegExp(`・${f.rows.length + f.abnormals.length + f.histories.length} 件）$`));

    // クラスの外の修正は出さない（ひまわり組だけ）
    expect((await report(2)).hasHistory).toBe(false);
  });
});
