/*
 * ヒヤリハットの欄（発生日時・場所・状況・とった対応・今後の対策・保護者へ伝えたこと）の保存と読み出し（モック）
 * 典拠：詳細設計書.md「日誌の画面（作り直し）」(2-13 (8))・「日誌」(4-13 (1)・(6))・決めたこと D-33、
 *      基本設計書.md「ヒヤリハットの記録」(4-6)
 *
 * ここで確かめる規則は、Go サーバ（server/api_diary_incident_test.go）にも同じものがある。片方だけを直すと食い違う。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import type { DiaryInput, DiaryIncidentInput } from '../src/api/client';
import { splitIncidentBody } from '../src/api/mock';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

const baseIncident = (): DiaryIncidentInput => ({
  occurred_at: `${today()}T00:00:00`,
  place: '園庭',
  situation: 'すべり台の階段で足を踏み外しかけた。',
  response: 'そばにいた職員が体を支え、けががないことを確かめた。',
});

/** ヒヤリハットの保存の入力。ヒヤリハットでは本文を送っても使わない（モックが欄から作る） */
const incidentInput = (patch: Partial<DiaryIncidentInput> = {}, extra: Partial<DiaryInput> = {}): DiaryInput => ({
  record_type: '4', child_id: 'C001', class_id: 1, diary_date: today(), body: '送った本文',
  incident: { ...baseIncident(), ...patch }, ...extra,
});

async function lockOf(user: SessionUser, diaryId: number): Promise<string> {
  const lock = await api.acquireLock(user, diaryId);
  if (!('token' in lock)) throw new Error(`ロックを取れませんでした（${lock.heldBy}さんが編集中）`);
  return lock.token;
}

const rowOf = (id: number) => db.diaries.find((d) => d.diary_id === id)!;

describe('ヒヤリハットの欄を保存し、読むときは分けて返す', () => {
  it('状況・とった対応・今後の対策を見出しでつないで本文に持ち、読むときは incident に分けて返す', async () => {
    const saved = await api.saveDiary(teacher, incidentInput({
      countermeasure: 'すべり台の階段に、上り下りの順番の目印を付ける。',
      guardian_notice: '1', guardian_noticed_at: `${today()}T00:00:00`,
      guardian_notice_method: '2', guardian_notice_person: '母（お迎え）',
    }), '1');
    const row = rowOf(saved.diary_id);
    expect(row.body).toBe('【状況】\nすべり台の階段で足を踏み外しかけた。\n\n【とった対応】\nそばにいた職員が体を支え、けががないことを確かめた。'
      + '\n\n【今後の対策】\nすべり台の階段に、上り下りの順番の目印を付ける。');
    expect(row.occurred_at).toBe(`${today()}T00:00:00`);
    expect(row.place).toBe('園庭');
    expect([row.guardian_notice, row.guardian_notice_method, row.guardian_notice_person]).toEqual(['1', '2', '母（お迎え）']);

    const got = await api.getDiary(teacher, saved.diary_id);
    expect(got.incident).toMatchObject({
      occurred_at: `${today()}T00:00:00`, place: '園庭',
      situation: 'すべり台の階段で足を踏み外しかけた。',
      response: 'そばにいた職員が体を支え、けががないことを確かめた。',
      countermeasure: 'すべり台の階段に、上り下りの順番の目印を付ける。',
      guardian_notice: '1', guardian_notice_method: '2', guardian_notice_person: '母（お迎え）',
    });
  });

  it('今後の対策が無いときは見出しも付けず、countermeasure は空で返す。保護者へ伝えたことは未記入で持たない', async () => {
    const saved = await api.saveDiary(teacher, incidentInput(), '1');
    const row = rowOf(saved.diary_id);
    expect(row.body).not.toContain('【今後の対策】');
    expect(saved.incident?.countermeasure).toBe('');
    expect([row.guardian_notice, row.guardian_noticed_at, row.guardian_notice_method, row.guardian_notice_person])
      .toEqual([null, null, null, null]);
  });

  it('ヒヤリハットでない日誌は incident を返さない', async () => {
    expect((await api.getDiary(teacher, 1)).incident).toBeNull();
  });
});

describe('ヒヤリハットの欄の検査（Go の TestIncidentFieldsAreValidated と同じ）', () => {
  const told = { guardian_notice: '1' as const, guardian_noticed_at: `${today()}T00:00:00`, guardian_notice_person: '母' };
  const cases: [string, Partial<DiaryIncidentInput>, string][] = [
    ['発生日時が空', { occurred_at: '' }, '発生日時を入力してください'],
    ['発生日時の形が崩れている', { occurred_at: '2026-02-30T10:00:00' }, '発生日時の形式が正しくありません'],
    ['発生日時が未来', { occurred_at: '2999-01-01T09:00:00' }, '発生日時に未来の日時は指定できません。'],
    ['場所が空白だけ', { place: '　 ' }, '場所を入力してください。'],
    ['場所が101文字', { place: 'あ'.repeat(101) }, '場所は100文字以内で入力してください。'],
    ['状況が空', { situation: '' }, '状況を入力してください。'],
    ['とった対応が空', { response: ' ' }, 'とった対応を入力してください'],
    ['状況が1,001文字', { situation: 'あ'.repeat(1001) }, '状況・とった対応は1,000文字以内で入力してください。'],
    ['とった対応が1,001文字', { response: 'あ'.repeat(1001) }, '状況・とった対応は1,000文字以内で入力してください。'],
    ['今後の対策が1,001文字', { countermeasure: 'あ'.repeat(1001) }, '今後の対策は1,000文字以内で入力してください。'],
    ['状況に【今後の対策】だけの行', { situation: '転びかけた。\n【今後の対策】\n目印を付ける' }, '「【状況】」「【とった対応】」「【今後の対策】」だけの行は書けません。'],
    ['とった対応に前後に空白のある【状況】の行', { response: '支えた。\n 【状況】 ' }, '「【状況】」「【とった対応】」「【今後の対策】」だけの行は書けません。'],
    ['今後の対策に【とった対応】だけの行', { countermeasure: '【とった対応】\n見直す' }, '「【状況】」「【とった対応】」「【今後の対策】」だけの行は書けません。'],
    ['伝えたのに手段が無い', { ...told }, '保護者へ伝えた日時・手段・相手を入れてください。'],
    ['伝えたのに日時が未来', { ...told, guardian_noticed_at: '2999-01-01T09:00:00', guardian_notice_method: '1' }, '保護者へ伝えた日時・手段・相手を入れてください。'],
    ['伝えた相手が51文字', { ...told, guardian_notice_method: '1', guardian_notice_person: 'あ'.repeat(51) }, '保護者へ伝えた日時・手段・相手を入れてください。'],
    ['伝えた手段が 4', { ...told, guardian_notice_method: '4' as '1' }, '保護者へ伝えた日時・手段・相手を入れてください。'],
    ['伝えたかの値が 3', { guardian_notice: '3' as '1' }, '保護者へ伝えたかの指定が正しくありません'],
  ];
  it.each(cases)('%s は断る', async (_name, patch, message) => {
    const before = db.diaries.length;
    await expect(api.saveDiary(teacher, incidentInput(patch), '1')).rejects.toThrow(message);
    expect(db.diaries.length).toBe(before);
  });

  it('欄を送らないヒヤリハットは、本文があっても断る', async () => {
    await expect(api.saveDiary(teacher, {
      record_type: '4', child_id: 'C001', class_id: 1, diary_date: today(), body: '【状況】本文だけ',
    }, '1')).rejects.toThrow('発生日時を入力してください');
  });

  it('上限ちょうど（場所100文字・状況・とった対応・今後の対策 1,000文字・相手50文字）は通る', async () => {
    await expect(api.saveDiary(teacher, incidentInput({
      place: 'あ'.repeat(100), situation: 'い'.repeat(1000), response: 'う'.repeat(1000), countermeasure: 'え'.repeat(1000),
      guardian_notice: '1', guardian_noticed_at: `${today()}T00:00:00`, guardian_notice_method: '9',
      guardian_notice_person: 'お'.repeat(50),
    }), '1')).resolves.toMatchObject({ record_type: '4' });
  });
});

describe('デモのヒヤリハットと、異常時の記録からの起票', () => {
  it('デモのヒヤリハット（diary_id 3）を開くと欄が分かれて返り、今後の対策と保護者へ伝えたことを直せる', async () => {
    const got = await api.getDiary(teacher, 3);
    expect(got.incident?.situation).toBe('午睡中にうつ伏せの体位を確認した。');
    expect(got.incident?.countermeasure).toMatch(/^午睡の確認のたびに/);
    expect(got.incident?.place).toBe('保育室（さくら組）');

    // デモでは村田が編集ロックを持っている（mockDb.ts）。外してから鈴木が取る
    db.diaryLocks.splice(db.diaryLocks.findIndex((l) => l.diary_id === 3), 1);
    const token = await lockOf(teacher, 3);
    await api.saveDiary(teacher, incidentInput({
      occurred_at: got.incident!.occurred_at, place: '保育室（さくら組）', situation: got.incident!.situation,
      response: '仰向けに直し、呼吸と顔色を確認した。呼吸あり、顔色は通常。',
      countermeasure: '午睡の確認の表に、体位の欄を足す。', guardian_notice: '2',
    }, { diary_id: 3, child_id: 'C003', diary_date: got.diary_date, lock_token: token }), '1');
    const row = rowOf(3);
    expect(row.body.endsWith('【今後の対策】\n午睡の確認の表に、体位の欄を足す。')).toBe(true);
    // 「伝えていない」に変えたら、伝えた日時・手段・相手を残さない
    expect([row.guardian_notice, row.guardian_noticed_at, row.guardian_notice_method, row.guardian_notice_person])
      .toEqual(['2', null, null, null]);
  });

  it('異常時の記録から起票すると、発生日時（発見時刻）・状況・とった対応を引き継ぎ、場所は空で始まる', async () => {
    const a = db.napAbnormals.find((x) => x.nap_abnormal_id === 2)!;
    const d = await api.raiseIncidentDiary(teacher, 2);
    const row = rowOf(d.diary_id);
    expect(row.body).toBe(`【状況】\n${a.situation}\n\n【とった対応】\n${a.response}`);
    expect(row.occurred_at).toBe(a.found_at);
    expect(row.place).toBe('');
    expect(d.incident).toMatchObject({ situation: a.situation, response: a.response, countermeasure: '' });

    // 場所を入れないまま保存しようとすると断られる（作成者が画面で入れる）
    const token = await lockOf(teacher, d.diary_id);
    await expect(api.saveDiary(teacher, incidentInput({
      occurred_at: a.found_at, place: '', situation: a.situation, response: a.response,
    }, { diary_id: d.diary_id, child_id: a.child_id, diary_date: d.diary_date, lock_token: token }), '1'))
      .rejects.toThrow('場所を入力してください。');
  });
});

describe('本文を見出しで分ける（Go の TestSplitIncidentBody と同じ）', () => {
  it.each([
    ['3つの見出し', '【状況】\nA\n\n【とった対応】\nB\n\n【今後の対策】\nC', 'A', 'B', 'C'],
    ['今後の対策なし', '【状況】\nA\nA2\n\n【とった対応】\nB', 'A\nA2', 'B', ''],
    // 【仮置き】見出しより前の文（以前の形式の記録の【発生日時】など）は状況の頭に入れ、捨てない
    ['見出しより前の文', '【発生日時】\n午睡中の13時40分ごろ\n\n【状況】\nA\n\n【とった対応】\nB', '【発生日時】\n午睡中の13時40分ごろ\n\nA', 'B', ''],
    ['見出しが無い本文', '自由に書いた本文', '自由に書いた本文', '', ''],
  ])('%s', (_name, body, situation, response, countermeasure) => {
    expect(splitIncidentBody(body)).toEqual({ situation, response, countermeasure });
  });
});
