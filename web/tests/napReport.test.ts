/*
 * 午睡記録検索と帳票に、ねた・おきたと入眠時の体温を出す。ヒヤリハットを起票した異常時の記録は、
 * ヒヤリハット側の状況・とった対応を出して二重に数えない
 * 典拠：図/画面詳細図.md「午睡記録検索画面」(5-3) の項目6・9・11、基本設計書.md「帳票の出力」(4-8)、
 *      要件定義書.md「日誌システム」(4-3) の「午睡チェックの異常時の記録との関係」
 *
 * Go サーバ側（server/api_nap_report_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { incidentSituationResponse } from '../src/api/mock';
import type { NapAbnormalRow, NapSearchRow } from '../src/api/shapes';
import type { SessionUser } from '../src/api/types';
import { NAP_ABNORMAL_HEADER, napReportRows } from '../src/screens/nap/napReport';

const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const otherTeacher: SessionUser = {
  account_id: 5, email: 'kinjo@hoiku.example.jp', role: '2', display_name: '金城 宗一郎',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
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

describe('異常時の記録に、起票したヒヤリハットの側の状況・とった対応を添える', () => {
  const byId = async (id: number) => (await api.abnormals(admin)).find((a) => a.nap_abnormal_id === id)!;

  it('起票済みの記録は日誌の側を返し、記録そのものは書き換えない。起票していない記録は null', async () => {
    const raised = await byId(1);
    expect(raised.incident_situation).toBe('午睡中にうつ伏せの体位を確認した。');
    expect(raised.incident_response).toBe('仰向けに直し、呼吸と顔色を確認した。');
    expect(raised.situation).toBe('うつ伏せの体位で寝ているのを発見。呼吸あり、顔色は通常。');

    const notRaised = await byId(2);
    expect(notRaised.diary_id).toBeNull();
    expect(notRaised.incident_situation).toBeNull();
    expect(notRaised.incident_response).toBeNull();
  });

  it('ヒヤリハットの本文を直せば直したあとを返し、日誌が削除されていれば返さない', async () => {
    const diary = db.diaries.find((d) => d.diary_id === 3)!;
    const before = { body: diary.body, is_deleted: diary.is_deleted };
    try {
      diary.body = '【発生日時】\r\n13時40分\r\n\r\n【発生場所】\r\nさくら組の午睡室\r\n\r\n【状況】\r\n直した状況。\r\n2行目。\r\n\r\n【とった対応】\r\n直した対応。\r\n\r\n【今後の対策】\r\n5分ごとに確かめる。';
      const edited = await byId(1);
      expect(edited.incident_situation).toBe('直した状況。\n2行目。');
      expect(edited.incident_response).toBe('直した対応。');

      diary.is_deleted = true;
      const gone = await byId(1);
      expect(gone.incident_situation).toBeNull();
      expect(gone.incident_response).toBeNull();
    } finally {
      diary.body = before.body;
      diary.is_deleted = before.is_deleted;
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

describe('帳票（CSV）の行', () => {
  const searchRow = (v: Partial<NapSearchRow>): NapSearchRow => ({
    kind: 'check', nap_record_id: 1, nap_sleep_id: null, nap_session_id: 1, child_id: 'C001',
    checked_at: '2026-09-01T13:20:00', saved_at: '2026-09-01T13:20:30', body_position: '1', breathing: '1', complexion: '1',
    temperature: 36.6, sleep_temperature: null, staff_id: 'S003', session_date: '2026-09-01',
    child_name: '野原 太郎', class_name: 'さくら組', staff_name: '高梨 倫太朗', ...v,
  });
  const abnormalRow = (v: Partial<NapAbnormalRow>): NapAbnormalRow => ({
    nap_abnormal_id: 1, nap_session_id: 3, child_id: 'C003', found_at: '2026-08-30T13:40:00',
    situation: '記録そのものの状況', response: '記録そのものの対応', staff_id: 'S004', diary_id: null,
    child_name: '高梨 健', staff_name: '職員', incident_situation: null, incident_response: null, ...v,
  });

  it('ねたの行は体温の列に入眠時の体温を出し、おきたの行は体温を出さない', () => {
    const rows = napReportRows([
      searchRow({ kind: 'wake', nap_record_id: null, nap_sleep_id: 8, checked_at: '2026-08-31T14:35:00', saved_at: null, body_position: null, breathing: null, complexion: null, temperature: null }),
      searchRow({}),
      searchRow({ kind: 'sleep', nap_record_id: null, nap_sleep_id: 8, checked_at: '2026-08-31T13:02:00', saved_at: null, body_position: null, breathing: null, complexion: null, temperature: null, sleep_temperature: 36.5 }),
    ], []);
    expect(rows).toEqual([
      ['2026-09-01', '2026-08-31T14:35:00', '野原 太郎', 'さくら組', '起床（おきた）', '', '', '', '高梨 倫太朗', ''],
      ['2026-09-01', '2026-09-01T13:20:00', '野原 太郎', 'さくら組', '仰向け', 'あり', '通常', 36.6, '高梨 倫太朗', '2026-09-01T13:20:30'],
      ['2026-09-01', '2026-08-31T13:02:00', '野原 太郎', 'さくら組', '入眠（ねた）', '', '', 36.5, '高梨 倫太朗', ''],
    ]);
  });

  it('異常時の記録を下に続け、起票済みはヒヤリハット側の状況・対応を1行だけ出す（二重に数えない）', () => {
    const rows = napReportRows([searchRow({})], [
      abnormalRow({ nap_abnormal_id: 1, diary_id: 3, incident_situation: 'ヒヤリハットの状況', incident_response: 'ヒヤリハットの対応' }),
      abnormalRow({ nap_abnormal_id: 2 }),
    ]);
    expect(rows.slice(1)).toEqual([
      [],
      ['同じ期間の異常時の記録'],
      NAP_ABNORMAL_HEADER,
      ['2026-08-30T13:40:00', '高梨 健', 'ヒヤリハットの状況', 'ヒヤリハットの対応', '職員', '起票済み'],
      ['2026-08-30T13:40:00', '高梨 健', '記録そのものの状況', '記録そのものの対応', '職員', '未起票'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('記録そのものの状況","記録そのものの対応","職員","起票済み');
  });

  it('異常時の記録が無ければ、一覧の行だけを出す', () => {
    expect(napReportRows([searchRow({})], [])).toHaveLength(1);
  });
});
