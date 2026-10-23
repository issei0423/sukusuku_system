/*
 * 異常時の記録の修正（api.correctNapAbnormal。サーバの POST /api/nap/abnormals/{id}/correct）
 * 典拠：基本設計書.md「記録の修正と改ざん防止」「帳票の出力」(4-8)・「入力項目の制約値」(4-12)・「操作ログ（t_operation_log）」(5-9)、
 *      詳細設計書.md「訂正・取り消しのまとめ」(3-5)、図/画面詳細図.md「異常時記録画面」(5-2) の項目17、図/インタフェース一覧.md
 *
 * Go サーバ側（server/api_nap_abnormal_correct_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 * デモ：異常時の記録 1（鈴木 健、2日前の実施 3、ヒヤリハット起票済み）と記録 2（久保田 陸、昨日の実施 2、未起票）。
 * どちらもさくら組。今日の実施 1（さくら組）に記録は無いので、テストが足す
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { NAP_ABNORMAL_CORRECT_MSG, NAP_CORRECT_MSG } from '../src/api/napCorrect';
import { NAP_ABNORMAL_HEADER, NAP_ABNORMAL_TITLE, NAP_HISTORY_HEADER, NAP_HISTORY_TITLE } from '../src/api/napReport';
import type { NapAbnormal, SessionUser } from '../src/api/types';
import { fromNowMinutes } from '../src/api/util';

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
const abnormalOf = (id: number) => db.napAbnormals.find((a) => a.nap_abnormal_id === id)!;
/** 異常時の記録の修正の操作ログ（午睡 3・変更 2・t_nap_abnormal）を古い順に */
const correctLogs = () => db.operationLogs
  .filter((l) => l.function_type === '3' && l.operation_type === '2' && l.target_table === 't_nap_abnormal')
  .slice().reverse();
/** 分までにそろえた日時（画面の datetime-local は分まで送る） */
const minute = (v: string) => `${v.slice(0, 16)}:00`;

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

/**
 * 今日の実施 1（さくら組）に、西田 太郎（C001）の異常時の記録を足す。記録した職員は S004（さくら組のもう1人の担任）。
 * noticedAt があれば、保護者へ「した」（電話・母）として連絡した日時を入れる（server/api_nap_abnormal_correct_test.go の addTodayAbnormal）
 */
function addTodayAbnormal(id: number, foundAt: string, recordedAt: string, noticedAt?: string): NapAbnormal {
  const a: NapAbnormal = {
    nap_abnormal_id: id, nap_session_id: 1, child_id: 'C001', found_at: foundAt, recorded_at: recordedAt,
    situation: '寝返りでうつ伏せ', response: '仰向けに直した', staff_id: 'S004', diary_id: null,
  };
  if (noticedAt) {
    Object.assign(a, { guardian_notice: '1', guardian_noticed_at: noticedAt, guardian_notice_method: '1', guardian_notice_person: '母' });
  }
  db.napAbnormals.push(a);
  return a;
}

describe('異常時の記録の修正', () => {
  it('その園児のクラスの担任は実施の日のうちに直せる。行を書き換え、変わった項目だけを修正前・修正後と理由で操作ログへ残す', async () => {
    const foundAt = fromNowMinutes(-40);
    const recordedAt = fromNowMinutes(-30);
    addTodayAbnormal(900801, foundAt, recordedAt);
    const newFound = minute(fromNowMinutes(-45));

    const got = await api.correctNapAbnormal(teacher, 900801, {
      found_at: newFound, situation: '寝返りでうつ伏せになっていた', response: '仰向けに直した', reason: '  発見した時刻を見直した  ',
    });
    expect(got).toMatchObject({
      found_at: newFound, situation: '寝返りでうつ伏せになっていた', response: '仰向けに直した', can_correct: true,
      // 保存時刻・記録した職員は変えない
      recorded_at: recordedAt, staff_id: 'S004', child_id: 'C001', child_name: '西田 太郎',
    });
    expect(got.corrected_at).toBeTruthy();
    expect(abnormalOf(900801)).toMatchObject({ found_at: newFound, situation: '寝返りでうつ伏せになっていた' });
    expect(abnormalOf(900801).corrected_at).toBeTruthy();

    // とった対応は同じ値を送ったので入れない。理由は前後の空白を除く（server/api_nap_abnormal_correct_test.go と同じ JSON）
    expect(correctLogs().map((l) => [l.account_id, l.target_id, l.target_child_id, l.before_value, l.after_value])).toEqual([
      [3, 900801, 'C001', `{"発見時刻":"${foundAt}","状況":"寝返りでうつ伏せ"}`,
        `{"発見時刻":"${newFound}","状況":"寝返りでうつ伏せになっていた","理由":"発見した時刻を見直した"}`],
    ]);
    // 午睡チェックの記録の修正の操作ログには入れない
    expect(db.operationLogs.some((l) => l.function_type === '3' && l.operation_type === '2' && l.target_table === 't_nap_record')).toBe(false);
  });

  it('理由は必須（1〜500文字）。値の誤り・発見時刻の未来と保存時刻より後・変わらない修正・無い記録も断り、行も操作ログも変えない', async () => {
    const recordedAt = fromNowMinutes(-30);
    addTodayAbnormal(900811, fromNowMinutes(-40), recordedAt);
    // 保護者へ電話した記録（発見 -40 分、連絡 -36 分、保存 -30 分）
    const noticedAt = fromNowMinutes(-36);
    addTodayAbnormal(900812, fromNowMinutes(-40), recordedAt, noticedAt);
    const cases: [string, number, Parameters<typeof api.correctNapAbnormal>[2], string][] = [
      ['理由が空', 900811, { situation: 'x', reason: '' }, NAP_CORRECT_MSG.reason],
      ['理由が空白だけ', 900811, { situation: 'x', reason: '　 ' }, NAP_CORRECT_MSG.reason],
      ['理由が501文字', 900811, { situation: 'x', reason: 'あ'.repeat(501) }, NAP_CORRECT_MSG.reasonLong],
      ['状況が空', 900811, { situation: '  ', reason: 'x' }, '発見時の状況を入力してください'],
      ['対応が空', 900811, { response: '', reason: 'x' }, 'とった対応を入力してください'],
      ['状況が1001文字', 900811, { situation: 'あ'.repeat(1001), reason: 'x' }, '発見時の状況と、とった対応は、それぞれ1,000文字以内で入力してください'],
      ['発見時刻の形式', 900811, { found_at: '2026/10/22 13:00', reason: 'x' }, '発見時刻の形式が正しくありません'],
      ['発見時刻が未来', 900811, { found_at: minute(fromNowMinutes(5)), reason: 'x' }, '発見時刻に未来の日時は指定できません'],
      ['発見時刻が保存時刻より後', 900811, { found_at: minute(fromNowMinutes(-20)), reason: 'x' }, NAP_ABNORMAL_CORRECT_MSG.afterRecorded],
      ['発見時刻が保護者へ連絡した日時より後', 900812, { found_at: minute(fromNowMinutes(-33)), reason: 'x' }, NAP_ABNORMAL_CORRECT_MSG.afterNotice],
      ['変わらない', 900811, { situation: '寝返りでうつ伏せ', response: '仰向けに直した', reason: 'x' }, NAP_CORRECT_MSG.noChange],
      ['直す項目が無い', 900811, { reason: 'x' }, NAP_CORRECT_MSG.noChange],
      ['無い記録', 999999, { situation: 'x', reason: 'x' }, NAP_ABNORMAL_CORRECT_MSG.notFound],
    ];
    for (const [name, id, input, message] of cases) {
      await expect(api.correctNapAbnormal(admin, id, input), name).rejects.toThrow(message);
    }
    expect(correctLogs()).toHaveLength(0);
    expect(abnormalOf(900811).corrected_at ?? null).toBeNull();
    expect(abnormalOf(900812).corrected_at ?? null).toBeNull();

    // 500文字ちょうどの理由と、保存時刻と同じ分の発見時刻は受け付ける。連絡した日時と同じ分も受け付ける
    await api.correctNapAbnormal(admin, 900811, { found_at: minute(recordedAt), reason: 'あ'.repeat(500) });
    await api.correctNapAbnormal(admin, 900812, { found_at: minute(noticedAt), reason: '連絡の直前に見つけた' });
    expect(correctLogs()).toHaveLength(2);
  });

  it('一般は実施の日のうちだけ。翌日以降と、ほかのクラスとフリーの職員は断る。管理者はいつでも直せる', async () => {
    addTodayAbnormal(900821, fromNowMinutes(-40), fromNowMinutes(-30));
    const input = { response: '仰向けに直し、5分後にも確かめた', reason: '書き足した' };

    await expect(api.correctNapAbnormal(guardian, 900821, input)).rejects.toThrow('職員のみが行えます');
    await expect(api.correctNapAbnormal(otherTeacher, 900821, input)).rejects.toThrow(NAP_CORRECT_MSG.forbidden); // ほかのクラスの担任
    await expect(api.correctNapAbnormal(teacher, 2, input)).rejects.toThrow(NAP_CORRECT_MSG.pastDay); // 昨日の記録
    await expect(api.correctNapAbnormal(teacher, 1, input)).rejects.toThrow(NAP_CORRECT_MSG.pastDay); // 2日前の記録
    expect(correctLogs()).toHaveLength(0);

    // フリーの職員（今年度の担任クラスが無い一般）は読めるが直せない
    db.classStaff.splice(0, db.classStaff.length, ...db.classStaff.filter((c) => c.staff_id !== 'S005'));
    await expect(api.correctNapAbnormal(otherTeacher, 900821, input)).rejects.toThrow(NAP_CORRECT_MSG.forbidden);

    // 管理者は翌日以降も直せる（ヒヤリハットを起票した記録も）。担任は、その日のうちなら直せる（記録した職員でなくてもよい）
    await api.correctNapAbnormal(admin, 2, input);
    await api.correctNapAbnormal(admin, 1, input);
    await api.correctNapAbnormal(teacher, 900821, input);
    expect(correctLogs().map((l) => [l.account_id, l.target_id, l.target_child_id])).toEqual([[1, 2, 'C005'], [1, 1, 'C003'], [3, 900821, 'C001']]);
  });

  it('異常時の記録の一覧に、修正あり（corrected_at）と、その利用者が直せるか（can_correct）を返す', async () => {
    addTodayAbnormal(900831, fromNowMinutes(-40), fromNowMinutes(-30));
    await api.correctNapAbnormal(teacher, 900831, { situation: '寝返りでうつ伏せになっていた', reason: '書き足した' });

    const rows = await api.abnormals(teacher);
    const row = (id: number) => rows.find((r) => r.nap_abnormal_id === id)!;
    expect(row(900831)).toMatchObject({ can_correct: true, situation: '寝返りでうつ伏せになっていた' });
    expect(row(900831).corrected_at).toBeTruthy();
    for (const id of [1, 2]) expect(row(id)).toMatchObject({ corrected_at: null, can_correct: false }); // 前の日の記録
    expect((await api.abnormals(admin)).every((r) => r.can_correct)).toBe(true);
  });
});

/* ============ 帳票の「修正あり」と「修正の履歴」 ============ */

/** すべてのセルを " で囲んだ CSV を読む。セルの中の改行と "" を扱う（napCorrect.test.ts と同じ） */
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
    if (records[i].length === 1 && records[i][0] === NAP_ABNORMAL_TITLE) {
      expect(records[i + 1]).toEqual(NAP_ABNORMAL_HEADER);
      section = out.abnormals; i++; continue;
    }
    if (records[i].length === 1 && records[i][0] === NAP_HISTORY_TITLE) {
      expect(records[i + 1]).toEqual(NAP_HISTORY_HEADER);
      out.hasHistory = true; section = out.histories; i++; continue;
    }
    section.push(records[i]);
  }
  return out;
}

describe('帳票の異常時の記録の修正あり・修正の履歴', () => {
  it('修正した異常時の記録に「修正あり」を付け、末尾の「修正の履歴」に午睡チェックの記録の修正と一緒に1回1行で出す', async () => {
    const report = async (classId?: number) =>
      splitReport(await api.napReport(admin, { from: twoDaysAgo(), to: today(), classId, format: 'csv' }));
    // 修正の前は、異常時の記録の「修正あり」は空で、履歴の表も出さない
    const before = await report();
    expect(before.abnormals.every((r) => r.length === NAP_ABNORMAL_HEADER.length && r[6] === '')).toBe(true);
    expect(before.hasHistory).toBe(false);

    // 記録 2（久保田 陸、未起票）の発見時刻と状況、記録 1（鈴木 健、起票済み）のとった対応、今日の午睡チェックの記録 1 を直す
    await api.correctNapAbnormal(admin, 2, {
      found_at: `${yesterday()}T14:05:00`, situation: '顔色が紅潮していた。体温37.4度。', reason: '時刻を見直した',
    });
    await api.correctNapAbnormal(admin, 1, { response: '仰向けに直した。', reason: '書き足した' });
    await api.correctNapRecord(teacher, 1, { body_position: '2', reason: '押し間違い' });

    const f = await report();
    // 起票済みの記録は、ヒヤリハット側の文のまま「修正あり」を付ける。未起票の記録は、直したあとの発見時刻と状況で出す
    expect(f.abnormals.map((r) => [r[0], r[1], r[2], r[5], r[6]])).toEqual([
      [`${twoDaysAgo()}T13:40:00`, '鈴木 健', '午睡中にうつ伏せの体位を確認した。', '起票済み', '修正あり'],
      [`${yesterday()}T14:05:00`, '久保田 陸', '顔色が紅潮していた。体温37.4度。', '未起票', '修正あり'],
    ]);

    // 修正の履歴：一覧と同じ向き（実施の日の古い順）で、異常時の記録と午睡チェックの記録を1つの表に並べる
    expect(f.histories.map((h) => [h[0], h[2], h[3], h[4], h[5]])).toEqual([
      [`異常時の記録（鈴木 健・${twoDaysAgo()}T13:40:00）`, '西田 拓也',
        'とった対応=仰向けに直し、5分後に再度確認した。保護者へは降園時に口頭で伝えた。', 'とった対応=仰向けに直した。', '書き足した'],
      [`異常時の記録（久保田 陸・${yesterday()}T14:05:00）`, '西田 拓也',
        `発見時刻=${yesterday()}T14:10:00、状況=顔色がやや紅潮していた。体温37.4度。`,
        `発見時刻=${yesterday()}T14:05:00、状況=顔色が紅潮していた。体温37.4度。`, '時刻を見直した'],
      [`午睡チェックの記録（西田 太郎・${today()}T13:20:00）`, '鈴木 浩之', '体位=仰向け', '体位=うつ伏せ', '押し間違い'],
    ]);
    expect(f.histories.every((h) => h.length === NAP_HISTORY_HEADER.length && h[1] !== '')).toBe(true);

    // クラスの外の修正は出さない（ひまわり組だけ）
    const other = await report(2);
    expect(other.hasHistory).toBe(false);
    expect(other.abnormals).toHaveLength(0);
  });
});
