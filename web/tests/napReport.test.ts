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

      // 「修正あり」の列は置き、修正の機能が無いあいだは空。時刻の新しい順
      for (const x of r.rows) expect(x).toHaveLength(NAP_REPORT_HEADER.length);
      expect(r.rows.every((x) => x[10] === '')).toBe(true);
      for (let i = 1; i < r.rows.length; i++) expect(r.rows[i - 1][1] >= r.rows[i][1]).toBe(true);

      // 異常時の記録：起票済み（記録 1。高梨 健、日誌 3）はヒヤリハット側の文に印を付けて1行。記録そのものの文は出さない
      expect(r.hasTitle).toBe(true);
      expect(r.abnormals).toHaveLength(2);
      expect(r.abnormals.filter((x) => x[1] === '高梨 健')).toEqual([
        [`${twoDaysAgo()}T13:40:00`, '高梨 健', '午睡中にうつ伏せの体位を確認した。', '仰向けに直し、呼吸と顔色を確認した。', '宮城 蓮', '起票済み'],
      ]);
      expect(text).not.toContain('うつ伏せの体位で寝ているのを発見');
      // 起票していない記録 2（金城 陸）は記録そのものの文に「未起票」。発見時刻の新しい順で先頭
      expect(r.abnormals[0]).toEqual([
        `${yesterday()}T14:10:00`, '金城 陸', '顔色がやや紅潮していた。体温37.4度。', '別室で休ませ、保護者へ連絡した。', '高梨 倫太朗', '未起票',
      ]);
    } finally {
      for (const e of added) db.napExclusions.splice(db.napExclusions.indexOf(e), 1);
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
