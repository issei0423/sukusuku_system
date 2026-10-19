/*
 * 午睡記録検索と帳票に、ねた・おきたと入眠時の体温を出す。ヒヤリハットを起票した異常時の記録は、
 * ヒヤリハット側の状況・とった対応を出して二重に数えない
 * 典拠：図/画面詳細図.md「午睡記録検索画面」(5-3) の項目6・9・10・11、基本設計書.md「帳票の出力」(4-8)、
 *      要件定義書.md「日誌システム」(4-3) の「午睡チェックの異常時の記録との関係」
 *
 * 帳票（api.napReport。サーバの GET /api/nap/report）は管理者だけが出せ、期間と件数はモック（サーバの代わり）が
 * 操作ログへ書く。Go サーバ側（server/api_nap_report_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { incidentSituationResponse } from '../src/api/mock';
import { NAP_ABNORMAL_HEADER, NAP_ABNORMAL_TITLE, NAP_REPORT_HEADER, NAP_REPORT_MSG } from '../src/api/napReport';
import type { NapSearchRow } from '../src/api/shapes';
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
const otherTeacher: SessionUser = {
  account_id: 5, email: 'kinjo@hoiku.example.jp', role: '2', display_name: '金城 宗一郎',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
  is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

/** デモの昨日の C001 の「ねた・おきた」（入眠時の体温 36.5。server/seed.sql と同じ） */
const demoSleep = () => db.napSleeps.find((s) => s.nap_sleep_id === 8)!;
const sessionDateOf = (id: number) => db.napSessions.find((s) => s.nap_session_id === id)!.session_date;
const hasSleep = (rows: NapSearchRow[], id: number) => rows.some((r) => r.nap_sleep_id === id);

describe('午睡記録検索に、ねた・おきたの行と入眠時の体温を出す', () => {
  it('ねたの行に押した時刻と入眠時の体温、おきたの行におきた時刻を出し、確認の値は持たない。新しい順に並ぶ', async () => {
    const s = demoSleep();
    const date = sessionDateOf(s.nap_session_id);
    const { rows } = await api.searchRecords(admin, { from: date, to: date, classId: 1 });

    const sleepIdx = rows.findIndex((r) => r.nap_sleep_id === 8 && r.kind === 'sleep');
    const wakeIdx = rows.findIndex((r) => r.nap_sleep_id === 8 && r.kind === 'wake');
    expect(sleepIdx).toBeGreaterThanOrEqual(0);
    expect(wakeIdx).toBeGreaterThanOrEqual(0);
    expect(wakeIdx).toBeLessThan(sleepIdx);

    const slept = rows[sleepIdx];
    expect(slept).toMatchObject({
      child_id: 'C001', checked_at: s.slept_at, sleep_temperature: 36.5, session_date: date,
      nap_record_id: null, saved_at: null, body_position: null, temperature: null,
    });
    expect(slept.staff_name).not.toBe('');
    expect(slept.class_name).not.toBe('');
    expect(rows[wakeIdx]).toMatchObject({ checked_at: s.woke_at, sleep_temperature: null });
    expect(rows[wakeIdx].staff_name).not.toBe('');

    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].checked_at >= rows[i].checked_at).toBe(true);
    // 内部の絞り込みの値（クラスの ID）は返さない
    expect(Object.keys(slept)).not.toContain('_class_id');
  });

  it('期間・クラス・園児名・参照範囲で絞り、取り消した「ねた」は出さない', async () => {
    expect(hasSleep((await api.searchRecords(admin, {})).rows, 8)).toBe(true);
    expect(hasSleep((await api.searchRecords(admin, { classId: 2 })).rows, 8)).toBe(false);
    expect(hasSleep((await api.searchRecords(admin, { childName: '存在しない名前' })).rows, 8)).toBe(false);
    expect(hasSleep((await api.searchRecords(otherTeacher, {})).rows, 8)).toBe(false);

    const s = demoSleep();
    s.is_deleted = true;
    try {
      expect(hasSleep((await api.searchRecords(admin, {})).rows, 8)).toBe(false);
    } finally {
      s.is_deleted = false;
    }
  });
});

describe('午睡記録検索に、きょうは対象外とその理由の行を出す（画面詳細図「午睡記録検索画面」(5-3) の項目6）', () => {
  it('押した時刻と理由を出し、確認・ねたの値は持たない。同じ時刻のねたより下。取り消したものは出さず、絞り込みと参照範囲はほかの行と同じ', async () => {
    // 昨日の実施 2 に足す（デモの今日の対象外は、時計によっては起動時に外れる）。上園 花子は「ねた」と同じ時刻にする。宮城 美咲は取り消したもの
    const s = demoSleep();
    const date = sessionDateOf(2);
    const added = [
      { nap_exclusion_id: 900101, nap_session_id: 2, child_id: 'C002', reason: '2' as const, staff_id: 'S003', is_deleted: false, created_at: s.slept_at },
      { nap_exclusion_id: 900102, nap_session_id: 2, child_id: 'C004', reason: '1' as const, staff_id: 'S003', is_deleted: true, created_at: `${date}T13:00:00` },
    ];
    db.napExclusions.push(...added);
    const exclusionOf = (rows: NapSearchRow[], childId: string) => rows.filter((r) => r.kind === 'exclusion' && r.child_id === childId);
    try {
      const { rows } = await api.searchRecords(admin, { from: date, to: date, classId: 1 });
      expect(exclusionOf(rows, 'C002')).toEqual([{
        kind: 'exclusion', nap_record_id: null, nap_sleep_id: null, nap_exclusion_id: 900101, exclusion_reason: '2',
        nap_session_id: 2, child_id: 'C002', checked_at: s.slept_at, saved_at: null,
        body_position: null, breathing: null, complexion: null, temperature: null, sleep_temperature: null,
        staff_id: 'S003', session_date: date, child_name: '上園 花子', class_name: 'さくら組', staff_name: '高梨 倫太朗',
        // 修正あり・直せるか は確認の行だけが持つ
        corrected_at: null, can_correct: false,
      }]);
      expect(exclusionOf(rows, 'C004')).toHaveLength(0);
      const sleepIdx = rows.findIndex((r) => r.kind === 'sleep' && r.nap_sleep_id === 8);
      const exclusionIdx = rows.findIndex((r) => r.nap_exclusion_id === 900101);
      expect(sleepIdx).toBeGreaterThanOrEqual(0);
      expect(sleepIdx).toBeLessThan(exclusionIdx);

      expect(exclusionOf((await api.searchRecords(admin, { classId: 2 })).rows, 'C002')).toHaveLength(0);
      expect(exclusionOf((await api.searchRecords(admin, { childName: '野原' })).rows, 'C002')).toHaveLength(0);
      expect(exclusionOf((await api.searchRecords(otherTeacher, {})).rows, 'C002')).toHaveLength(0);
      expect(exclusionOf((await api.searchRecords(teacher, {})).rows, 'C002')).toHaveLength(1);
    } finally {
      for (const e of added) db.napExclusions.splice(db.napExclusions.indexOf(e), 1);
    }
  });
});

/* ============ 帳票（api.napReport） ============ */

/** すべてのセルを " で囲んだ CSV を読む。セルの中の改行と "" を扱う */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') inQuote = false; else cell += c;
    } else if (c === '"') { inQuote = true; started = true; }
    else if (c === ',') { row.push(cell); cell = ''; started = true; }
    else if (c === '\n') {
      if (started) row.push(cell);
      rows.push(row); row = []; cell = ''; started = false;
    } else { cell += c; started = true; }
  }
  if (started) row.push(cell);
  rows.push(row);
  return rows;
}

/** 帳票を一覧の行と、同じ期間の異常時の記録の行に分ける（server/api_nap_report_test.go の napReportOf と同じ） */
function splitReport(text: string) {
  const records = parseCsv(text);
  const out = { header: records[0], rows: [] as string[][], abnormals: [] as string[][], hasTitle: false };
  let section = out.rows;
  for (let i = 1; i < records.length; i++) {
    if (records[i].length === 0) continue;
    if (records[i].length === 1 && records[i][0] === NAP_ABNORMAL_TITLE) {
      out.hasTitle = true;
      expect(records[i + 1]).toEqual(NAP_ABNORMAL_HEADER);
      section = out.abnormals;
      i++;
      continue;
    }
    section.push(records[i]);
  }
  return out;
}

const today = () => sessionDateOf(1);
const yesterday = () => sessionDateOf(2);
const twoDaysAgo = () => sessionDateOf(3);
const napExportLogs = () => db.operationLogs.filter((l) => l.function_type === '3' && l.operation_type === '5');

/**
 * 帳票の一覧の行が 実施の日 → クラス（番号の順）→ 園児（よみの順）→ 時刻 の古い順に並んでいるか
 * （server/api_nap_report_test.go の expectNapReportOrder と同じ）。クラスと園児は、帳票に出る名前から番号とよみを引く
 */
function expectReportOrder(rows: string[][]) {
  const keyOf = (r: string[]) => ({
    date: r[0], at: r[1],
    classId: Math.min(...db.classes.filter((c) => c.class_name === r[3]).map((c) => c.class_id)),
    kana: db.children.find((c) => c.child_name === r[2])!.child_name_kana,
  });
  for (let i = 1; i < rows.length; i++) {
    const p = keyOf(rows[i - 1]);
    const c = keyOf(rows[i]);
    const inOrder = p.date !== c.date ? p.date < c.date
      : p.classId !== c.classId ? p.classId < c.classId
        : p.kana !== c.kana ? p.kana.localeCompare(c.kana, 'ja') < 0
          : p.at <= c.at;
    expect(inOrder, `実施の日 → クラス → 園児 → 時刻 の古い順になっていません: ${rows[i - 1].join(',')} のあとに ${rows[i].join(',')}`)
      .toBe(true);
  }
}

describe('帳票（CSV）は管理者だけが出せる', () => {
  it('一般（保育士）と保護者は断り、操作ログにも残さない。管理者は見出しと行を受け取る', async () => {
    const before = napExportLogs().length;
    const f = { from: twoDaysAgo(), to: today(), format: 'csv' as const };
    await expect(api.napReport(teacher, f)).rejects.toThrow(NAP_REPORT_MSG.adminOnly);
    await expect(api.napReport(guardian, f)).rejects.toThrow(NAP_REPORT_MSG.adminOnly);
    expect(napExportLogs()).toHaveLength(before);

    const text = await api.napReport(admin, f);
    expect(text.charCodeAt(0)).not.toBe(0xfeff); // BOM は保存する画面が付ける
    const r = splitReport(text);
    expect(r.header).toEqual(NAP_REPORT_HEADER);
    expect(r.header.join(',')).toBe('日付,チェック時刻,園児,クラス,体位,呼吸,顔色,体温,記録者,保存時刻,修正あり');
    expect(r.rows.length).toBeGreaterThan(0);
  });
});

describe('帳票の中身', () => {
  it('確認の行・ねたの体温・対象外と理由・起票済みのヒヤリハット側の文を、それぞれ1行で出す', async () => {
    // きょうは対象外は昨日の実施 2 に足して確かめる（デモの今日の対象外は、時計によっては起動時に外れる）。取り消したものは出さない
    const added = [
      { nap_exclusion_id: 900001, nap_session_id: 2, child_id: 'C002', reason: '2' as const, staff_id: 'S003', is_deleted: false, created_at: `${yesterday()}T13:00:00` },
      { nap_exclusion_id: 900002, nap_session_id: 2, child_id: 'C004', reason: '1' as const, staff_id: 'S003', is_deleted: true, created_at: `${yesterday()}T13:00:00` },
    ];
    db.napExclusions.push(...added);
    try {
      const text = await api.napReport(admin, { from: twoDaysAgo(), to: today(), format: 'csv' });
      const r = splitReport(text);
      const find = (pred: (x: string[]) => boolean) => r.rows.filter(pred);

      // 確認の行：チェックした時刻と保存時刻の両方（デモの記録 1。今日の野原 太郎 13:20:00、保存 13:20:30）
      const checks = find((x) => x[2] === '野原 太郎' && x[1].endsWith('T13:20:00'));
      expect(checks).toEqual([
        [today(), `${today()}T13:20:00`, '野原 太郎', 'さくら組', '仰向け', 'あり', '通常', '36.6', '高梨 倫太朗', `${today()}T13:20:30`, ''],
      ]);

      // ねたの行：体温の列に入眠時の体温。おきたの行は体温を出さない
      const s = demoSleep();
      expect(find((x) => x[2] === '野原 太郎' && x[4] === '入眠（ねた）')).toEqual([
        [yesterday(), s.slept_at, '野原 太郎', 'さくら組', '入眠（ねた）', '', '', '36.5', '高梨 倫太朗', '', ''],
      ]);
      expect(find((x) => x[2] === '野原 太郎' && x[4] === '起床（おきた）')).toEqual([
        [yesterday(), s.woke_at!, '野原 太郎', 'さくら組', '起床（おきた）', '', '', '', '高梨 倫太朗', '', ''],
      ]);

      // きょうは対象外と理由
      expect(find((x) => x[2] === '上園 花子' && x[0] === yesterday())).toEqual([
        [yesterday(), `${yesterday()}T13:00:00`, '上園 花子', 'さくら組', 'きょうは対象外（午睡なし）', '', '', '', '高梨 倫太朗', '', ''],
      ]);
      expect(find((x) => x[2] === '宮城 美咲' && x[0] === yesterday())).toHaveLength(0);

      // 「修正あり」の列は置き、どの記録も修正していないあいだは空（修正したときは napCorrect.test.ts）。実施の日 → クラス → 園児 → 時刻 の古い順
      for (const x of r.rows) expect(x).toHaveLength(NAP_REPORT_HEADER.length);
      expect(r.rows.every((x) => x[10] === '')).toBe(true);
      expectReportOrder(r.rows);

      // 異常時の記録：起票済み（記録 1。高梨 健、日誌 3）はヒヤリハット側の文に印を付けて1行。記録そのものの文は出さない
      expect(r.hasTitle).toBe(true);
      expect(r.abnormals).toHaveLength(2);
      expect(r.abnormals.filter((x) => x[1] === '高梨 健')).toEqual([
        [`${twoDaysAgo()}T13:40:00`, '高梨 健', '午睡中にうつ伏せの体位を確認した。', '仰向けに直し、呼吸と顔色を確認した。', '宮城 蓮', '起票済み'],
      ]);
      expect(text).not.toContain('うつ伏せの体位で寝ているのを発見');
      // 起票していない記録 2（金城 陸。昨日）は記録そのものの文に「未起票」。実施の日の古い順で、2日前の高梨 健のあと
      expect(r.abnormals[0][1]).toBe('高梨 健');
      expect(r.abnormals[1]).toEqual([
        `${yesterday()}T14:10:00`, '金城 陸', '顔色がやや紅潮していた。体温37.4度。', '別室で休ませ、保護者へ連絡した。', '高梨 倫太朗', '未起票',
      ]);
    } finally {
      for (const e of added) db.napExclusions.splice(db.napExclusions.indexOf(e), 1);
    }
  });

  it('一覧は 実施の日 → クラス → 園児 → 時刻 の古い順。同じ時刻は、ねた・確認・おきた。画面の一覧は新しい順のまま', async () => {
    /*
     * server/api_nap_report_test.go の TestNapReportOrdersByDateClassChildTime と同じ。監査では、1人の子の確認が
     * 間隔どおりかを時刻の順に読む（2026-10-19、持ち主が任せて決めた）。
     * 昨日の実施 2（さくら組）に、野原 太郎（のはら）の確認を ねた（13:02）・おきた（14:35）と同じ時刻とその間に足し、
     * 伊藤 葵（いとう）の確認を野原 太郎のどの確認よりも後に足す。今日の実施 4（ひまわり組）に、井上 空の確認を
     * さくら組の確認（13:20〜）より前の時刻に足す
     */
    const rec = (id: number, session: number, child: string, at: string): (typeof db.napRecords)[number] => ({
      nap_record_id: id, nap_session_id: session, child_id: child, checked_at: at, saved_at: at,
      body_position: '1', breathing: '1', complexion: '1', temperature: null, staff_id: 'S003',
    });
    const added = [
      rec(900201, 2, 'C001', `${yesterday()}T14:35:00`),
      rec(900202, 2, 'C001', `${yesterday()}T13:20:00`),
      rec(900203, 2, 'C001', `${yesterday()}T13:02:00`),
      rec(900204, 2, 'C006', `${yesterday()}T14:50:00`),
      rec(900205, 4, 'C013', `${today()}T13:15:00`),
    ];
    db.napRecords.push(...added);
    try {
      const r = splitReport(await api.napReport(admin, { from: yesterday(), to: today(), format: 'csv' }));
      expectReportOrder(r.rows);

      const indexOf = (date: string, child: string) =>
        r.rows.flatMap((x, i) => (x[0] === date && x[2] === child ? [i] : []));
      // 同じ日・同じクラスでは、時刻が後でも、よみが先の園児（いとう）を先に出す
      const ito = indexOf(yesterday(), '伊藤 葵');
      const nohara = indexOf(yesterday(), '野原 太郎');
      expect(ito).toHaveLength(1);
      expect(ito[0]).toBeLessThan(nohara[0]);
      // 1人の子の行は時刻の古い順。同じ時刻は、ねた・確認・おきた
      expect(nohara.map((i) => `${r.rows[i][1].slice(11)} ${r.rows[i][4]}`)).toEqual([
        '13:02:00 入眠（ねた）', '13:02:00 仰向け', '13:20:00 仰向け', '14:35:00 仰向け', '14:35:00 起床（おきた）',
      ]);
      // 同じ日では、時刻が前でも、番号の後のクラス（ひまわり組）をさくら組のあとに出す
      expect(r.rows[r.rows.length - 1].slice(0, 4)).toEqual([today(), `${today()}T13:15:00`, '井上 空', 'ひまわり組']);
      expect(indexOf(today(), '野原 太郎').length).toBeGreaterThan(0);

      // 画面の一覧（午睡記録検索）は時刻の新しい順のまま
      const page = await api.searchRecords(admin, { from: yesterday(), to: today() });
      for (let i = 1; i < page.rows.length; i++) expect(page.rows[i - 1].checked_at >= page.rows[i].checked_at).toBe(true);
    } finally {
      for (const x of added) db.napRecords.splice(db.napRecords.indexOf(x), 1);
    }
  });

  it('同じ期間の異常時の記録の表も、実施の日 → クラス → 園児 → 発見時刻 の古い順。異常時の記録の一覧は新しい順のまま', async () => {
    /*
     * server/api_nap_report_test.go の TestNapReportOrdersAbnormalsByDateClassChildTime と同じ。監査では1つのファイルを
     * 時刻の順に読み、表ごとに向きが違うと読み違えるため（2026-10-19、持ち主が任せて決めた）。
     * デモ：記録 1（2日前・さくら組・高梨 健 13:40）、記録 2（昨日・さくら組・金城 陸 14:10）。昨日に金城 陸の 13:50 と、
     * よみが後（のはら）で発見時刻が前の野原 太郎の 13:30 を、今日にさくら組の伊藤 葵 13:45 と、発見時刻が前のひまわり組の
     * 井上 空 13:15 を足す
     */
    const ab = (id: number, session: number, child: string, at: string): (typeof db.napAbnormals)[number] => ({
      nap_abnormal_id: id, nap_session_id: session, child_id: child, found_at: at, recorded_at: at,
      situation: '状況', response: '対応', staff_id: 'S003', diary_id: null,
    });
    const added = [
      ab(900301, 2, 'C005', `${yesterday()}T13:50:00`),
      ab(900302, 2, 'C001', `${yesterday()}T13:30:00`),
      ab(900303, 1, 'C006', `${today()}T13:45:00`),
      ab(900304, 4, 'C013', `${today()}T13:15:00`),
    ];
    db.napAbnormals.push(...added);
    try {
      const r = splitReport(await api.napReport(admin, { from: twoDaysAgo(), to: today(), format: 'csv' }));
      expect(r.abnormals.map((x) => `${x[0]} ${x[1]}`)).toEqual([
        `${twoDaysAgo()}T13:40:00 高梨 健`,
        `${yesterday()}T13:50:00 金城 陸`, `${yesterday()}T14:10:00 金城 陸`,
        `${yesterday()}T13:30:00 野原 太郎`,
        `${today()}T13:45:00 伊藤 葵`,
        `${today()}T13:15:00 井上 空`,
      ]);

      // 異常時記録画面の一覧は発見時刻の新しい順のまま
      const list = await api.abnormals(admin);
      for (let i = 1; i < list.length; i++) expect(list[i - 1].found_at >= list[i].found_at).toBe(true);
    } finally {
      for (const x of added) db.napAbnormals.splice(db.napAbnormals.indexOf(x), 1);
    }
  });

  it('期間（実施の日）とクラスで絞る', async () => {
    const r = splitReport(await api.napReport(admin, { from: yesterday(), to: yesterday(), format: 'csv' }));
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => x[0] === yesterday())).toBe(true);
    expect(r.abnormals.map((x) => x[1])).toEqual(['金城 陸']);

    const himawari = splitReport(await api.napReport(admin, { from: yesterday(), to: today(), classId: 2, format: 'csv' }));
    expect(himawari.rows.every((x) => x[3] === 'ひまわり組')).toBe(true);
    expect(himawari.hasTitle).toBe(false);
    expect(himawari.abnormals).toHaveLength(0);
  });

  it('出力したことと、期間・件数（モックが数えた行の数）を操作ログに残す', async () => {
    const r = splitReport(await api.napReport(admin, { from: twoDaysAgo(), to: today(), format: 'csv' }));
    const count = r.rows.length + r.abnormals.length;
    expect(count).toBeGreaterThanOrEqual(10);
    // 操作ログは新しいものを先頭に持つ
    expect(napExportLogs()[0]).toMatchObject({
      account_id: 1, target_table: 't_nap_record',
      after_value: `午睡記録をCSV出力（期間 ${twoDaysAgo()}〜${today()}・すべてのクラス・${count} 件）`,
    });

    const sakura = splitReport(await api.napReport(admin, { from: today(), to: today(), classId: 1, format: 'csv' }));
    expect(napExportLogs()[0].after_value)
      .toBe(`午睡記録をCSV出力（期間 ${today()}〜${today()}・さくら組・${sakura.rows.length + sakura.abnormals.length} 件）`);
  });

  it('PDF・知らない形式・期間の誤りは断り、操作ログに残さない', async () => {
    const before = napExportLogs().length;
    // 【仮置き】PDF は作らない（PDF のライブラリと日本語の字体を入れるかを持ち主が決める）
    await expect(api.napReport(admin, { from: twoDaysAgo(), to: today(), format: 'pdf' })).rejects.toThrow(NAP_REPORT_MSG.pdf);
    await expect(api.napReport(admin, { from: twoDaysAgo(), to: today(), format: 'xlsx' as 'csv' })).rejects.toThrow(NAP_REPORT_MSG.format);
    await expect(api.napReport(admin, { from: '', to: today(), format: 'csv' })).rejects.toThrow(NAP_REPORT_MSG.period);
    await expect(api.napReport(admin, { from: '2026-9-1', to: today(), format: 'csv' })).rejects.toThrow(NAP_REPORT_MSG.period);
    await expect(api.napReport(admin, { from: today(), to: twoDaysAgo(), format: 'csv' })).rejects.toThrow(NAP_REPORT_MSG.range);
    expect(napExportLogs()).toHaveLength(before);
  });

  it('ヒヤリハットを直せば直したあとを出し、日誌が無ければ記録そのものを出す。式の始まりのセルは逃がす', async () => {
    const diary = db.diaries.find((d) => d.diary_id === 3)!;
    const abnormal = db.napAbnormals.find((a) => a.nap_abnormal_id === 2)!;
    const before = { body: diary.body, is_deleted: diary.is_deleted, situation: abnormal.situation, response: abnormal.response };
    const raisedRow = async () => splitReport(await api.napReport(admin, { from: twoDaysAgo(), to: today(), format: 'csv' }))
      .abnormals.find((x) => x[1] === '高梨 健')!;
    try {
      diary.body = '【発生日時】\r\n13時40分\r\n\r\n【発生場所】\r\nさくら組の午睡室\r\n\r\n【状況】\r\n直した状況。\r\n2行目。\r\n\r\n【とった対応】\r\n直した対応。\r\n\r\n【今後の対策】\r\n5分ごとに確かめる。';
      expect((await raisedRow()).slice(2)).toEqual(['直した状況。\n2行目。', '直した対応。', '宮城 蓮', '起票済み']);

      diary.is_deleted = true;
      expect((await raisedRow()).slice(2)).toEqual([
        'うつ伏せの体位で寝ているのを発見。呼吸あり、顔色は通常。', '仰向けに直し、5分後に再度確認した。保護者へは降園時に口頭で伝えた。',
        '宮城 蓮', '起票済み',
      ]);

      // 式として開かれうるセル（= + - @ で始まる）は ' を付ける。" は二重にする（GitHub Issue #153 と同じ。サーバも同じ）
      abnormal.situation = '=HYPERLINK("http://example.invalid")';
      abnormal.response = '@SUM(1+1)';
      const text = await api.napReport(admin, { from: twoDaysAgo(), to: today(), format: 'csv' });
      expect(text).toContain('"\'=HYPERLINK(""http://example.invalid"")","\'@SUM(1+1)"');
    } finally {
      diary.body = before.body;
      diary.is_deleted = before.is_deleted;
      abnormal.situation = before.situation;
      abnormal.response = before.response;
    }
  });
});

describe('異常時の記録の一覧は、起票したヒヤリハットの文を返さない', () => {
  it('管理者にも一般（保育士）にも incident_situation・incident_response を返さず、日誌の本文も入れない', async () => {
    for (const user of [admin, teacher]) {
      const all = await api.abnormals(user);
      expect(all.length).toBeGreaterThan(0);
      for (const a of all) {
        expect(Object.keys(a)).not.toContain('incident_situation');
        expect(Object.keys(a)).not.toContain('incident_response');
      }
      expect(JSON.stringify(all)).not.toContain('午睡中にうつ伏せの体位を確認した。');
    }
  });

  it('本文の見出しで状況・とった対応を分ける（server/api_nap_report_test.go の TestIncidentSituationResponse と同じ）', () => {
    const cases: [string, string, string, string][] = [
      ['起票したままの本文', '【発生日時】\n2026-09-01 13:40:00\n\n【状況】\nうつ伏せ\n\n【とった対応】\n仰向けに直した\n\n【今後の対策】\n', 'うつ伏せ', '仰向けに直した'],
      ['雛形の見出し（発生場所）を挟む', '【発生日時】\n\n【発生場所】\n午睡室\n\n【状況】\nA\n\n【とった対応】\nB', 'A', 'B'],
      ['見出しが無い', '自由に書いた本文', '', ''],
      ['文の中の【】は見出しにしない', '【状況】\n【注意】のあと泣いた。\n【とった対応】\n抱いた', '【注意】のあと泣いた。', '抱いた'],
    ];
    for (const [name, body, situation, response] of cases) {
      expect(incidentSituationResponse(body), name).toEqual({ situation, response });
    }
  });
});
