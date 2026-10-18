/*
 * 園からのひとこと・活動のひとこと（段2）・定型文・宛先・ダッシュボードの「園から未送信」（モック）
 * 典拠：詳細設計書「園からのひとことと他児の名前」(4-5)・「きょうのようす」(4-4 (1))・「ダッシュボード」(4-8 (2))・「テストの観点」(9-1)
 *
 * Go の同じ観点は server/api_contact_facility_test.go にある。web のテストの時計は今日の 18:00。
 * mockDb はこのファイルのテストで使い回す（前のテストの書き込みを当てにしない）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { api, connectLive } from '../src/api/client';
import { subscribeLive } from '../src/live';
import type { LiveSignal } from '../src/live';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import { MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const otherTeacher = user(5, '2', { staff_id: 'S005', class_id: 2, class_name: 'ひまわり組' });
const taroGuardian = user(6, '3', { guardian_id: 'G001' });
const misakiGuardian = user(9, '3', { guardian_id: 'G004' });

const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach((s) => s()); });
function watch(viewer: SessionUser): LiveSignal[] {
  const got: LiveSignal[] = [];
  stops.push(connectLive(viewer.account_id));
  stops.push(subscribeLive((s) => got.push(s)));
  return got;
}

/** その子の今日の園からを外しておく（ファイルの中で使い回すため） */
function clearFacility(child: string): void {
  for (const f of db.contactFacilities) if (f.child_id === child && f.contact_date === today()) f.is_deleted = true;
}

type Rejected = Error & { kind?: string; names?: string[]; matches?: { start: number; end: number }[] };
async function rejection(p: Promise<unknown>): Promise<Rejected> {
  try { await p; } catch (e) { return e as Rejected; }
  throw new Error('拒まれなかった');
}

describe('園からのひとこと（詳細設計書 (4-5 (1))）', () => {
  it('検査と権限。他児の名前が入っていれば注意を返し、承諾を付けると保存されて保護者に届く。二重は拒む', async () => {
    clearFacility('C001');
    await expect(api.sendFacility(teacher, 'C001', '   ')).rejects.toThrow(MSG.facilityEmpty);
    await expect(api.sendFacility(teacher, 'C001', 'あ'.repeat(501))).rejects.toThrow(MSG.facilityTooLong);
    await expect(api.sendFacility(otherTeacher, 'C001', 'ありがとうございました。')).rejects.toThrow(MSG.contactForbidden);
    await expect(api.sendFacility(taroGuardian, 'C001', 'ありがとうございました。')).rejects.toThrow();

    const body = 'あおちゃんとしゃぼん玉を追いかけていました。たっくんは最後まで走っていました。';
    const misaki = watch(misakiGuardian);
    const e = await rejection(api.sendFacility(teacher, 'C001', body));
    expect([e.kind, e.names, e.message]).toEqual(['other_child_names', ['伊藤 葵'], 'ほかのお子さんの名前（伊藤 葵）が入っています。このまま送りますか。']);
    expect(e.matches?.map((m) => [m.start, m.end])).toEqual([[0, 5]]);
    const sent = await api.sendFacility(teacher, 'C001', body, ['伊藤 葵']);
    expect([sent.body, sent.staff_name]).toEqual([body, '高梨 倫太朗']);
    expect(misaki).toEqual([]);
    const page = await api.contactPage(taroGuardian, 'C001');
    expect(page.facility?.body).toBe(body);
    expect(JSON.stringify(page)).not.toMatch(/staff_name|高梨|recipient/);
    const twice = await rejection(api.sendFacility(teacher, 'C001', 'もう一度送ります。'));
    expect([twice.kind, twice.message]).toEqual(['already_exists', MSG.facilitySent]);
  });

  it('直すときも照合を通る。読んだ版が古ければ拒む。取り消すと未送信に戻り、送り直せる', async () => {
    clearFacility('C001');
    const sent = await api.sendFacility(teacher, 'C001', '砂場で遊びました。');
    expect((await rejection(api.correctFacility(teacher, sent.contact_facility_id, { body: '空くんと遊びました。', updated_at: sent.updated_at! }))).names)
      .toEqual(['井上 空']);
    await expect(api.correctFacility(teacher, sent.contact_facility_id, { body: '園庭で遊びました。', updated_at: '2000-01-01T00:00:00' }))
      .rejects.toThrow(MSG.fixConflict);
    await expect(api.correctFacility(otherTeacher, sent.contact_facility_id, { body: '園庭で遊びました。', updated_at: sent.updated_at! }))
      .rejects.toThrow(MSG.contactForbidden);
    const fixed = await api.correctFacility(teacher, sent.contact_facility_id, { body: '園庭で遊びました。', updated_at: sent.updated_at! });
    expect([fixed.body, fixed.corrected_at !== null]).toEqual(['園庭で遊びました。', true]);
    expect((await api.contactPage(taroGuardian, 'C001')).facility?.corrected_at).not.toBeNull();
    expect(await api.facilityReaders(teacher, sent.contact_facility_id)).toEqual({ family_count: 0, guardian_count: 0 });
    expect((await api.cancelFacility(teacher, sent.contact_facility_id)).ok).toBe(true);
    expect((await api.contactPage(taroGuardian, 'C001')).facility).toBeNull();
    await expect(api.sendFacility(teacher, 'C001', '明日もよろしくお願いします。')).resolves.toBeTruthy();
    await expect(api.cancelFacility(teacher, sent.contact_facility_id)).rejects.toThrow(MSG.contactForbidden);
  });
});

describe('活動のひとこと（詳細設計書 (4-4 (1))）', () => {
  it('文を検査し、他児の名前の注意を通して保存する。直すときも照合する', async () => {
    await expect(api.recordEvents(teacher, [{ child_id: 'C001', event_type: '4', body: 'あ'.repeat(201) }])).rejects.toThrow(MSG.commentTooLong);
    await expect(api.recordEvents(teacher, [{ child_id: 'C001', event_type: '4', body: '  ' }])).rejects.toThrow(MSG.badChoice);
    const e = await rejection(api.recordEvents(teacher, [{ child_id: 'C001', event_type: '4', body: '空くんと積み木をしていました。' }]));
    expect([e.kind, e.names]).toEqual(['other_child_names', ['井上 空']]);
    const { events: [comment] } = await api.recordEvents(teacher, [{ child_id: 'C001', event_type: '4', body: '空くんと積み木をしていました。' }], ['井上 空']);
    expect((await api.contactPage(taroGuardian, 'C001')).events.some((x) => x.body === '空くんと積み木をしていました。')).toBe(true);
    expect((await rejection(api.correctEvent(teacher, comment.contact_event_id, { body: 'あおちゃんと積み木をしていました。', updated_at: comment.updated_at! }))).names)
      .toEqual(['伊藤 葵']);
    const fixed = await api.correctEvent(teacher, comment.contact_event_id, { body: '積み木を高く積んでいました。', updated_at: comment.updated_at! });
    expect([fixed.body, fixed.corrected_at !== null]).toEqual(['積み木を高く積んでいました。', true]);
  });
});

describe('定型文・宛先・照合の経路・ダッシュボード', () => {
  it('定型文は職員だけが使う場所ごとに引ける。評価の言葉を入れない', async () => {
    const list = await api.contactPhrases(teacher, '1');
    expect(list.map((p) => p.body)).toEqual(['今日も一日ありがとうございました。', 'お迎えのときに、くわしくお話しします。',
      'おうちでも、今日のことを聞いてみてください。', '明日もよろしくお願いします。']);
    expect((await api.contactPhrases(teacher, '4')).length).toBe(5);
    await expect(api.contactPhrases(taroGuardian, '1')).rejects.toThrow();
    for (const p of db.phrases) expect(p.body).not.toMatch(/元気|順調|問題|異常|健康/);
  });

  it('宛先は職員の応答だけに入る。保護者が未登録の園児は続柄が空', async () => {
    expect((await api.contactPage(teacher, 'C001')).recipient).toEqual({ child_id: 'C001', child_name: '野原 太郎', has_face_photo: false, relationships: ['父'] });
    expect((await api.contactPage(teacher, 'C003')).recipient?.relationships).toEqual([]);
    expect((await api.contactPage(taroGuardian, 'C001')).recipient).toBeUndefined();
    expect((await api.contactClass(teacher, 1)).rows.every((r) => r.recipient.child_id === r.child.child_id)).toBe(true);
  });

  it('照合の経路は書ける園児・クラスだけを宛先にできる', async () => {
    expect((await api.nameCheck(teacher, { child_ids: ['C001'], text: 'たっくんとあおちゃん' })).names).toEqual(['伊藤 葵']);
    expect((await api.nameCheck(teacher, { class_id: 1, text: 'たっくんとあおちゃん' })).names).toHaveLength(2);
    await expect(api.nameCheck(otherTeacher, { child_ids: ['C001'], text: 'たっくん' })).rejects.toThrow(MSG.contactForbidden);
    await expect(api.nameCheck(otherTeacher, { class_id: 1, text: 'たっくん' })).rejects.toThrow();
    await expect(api.nameCheck(teacher, { child_ids: ['C001'], text: 'あ'.repeat(1001) })).rejects.toThrow(MSG.badRequest);
  });

  it('照合の経路も、写っている2人なら家庭ごとに照合し、クラス名と「〇〇先生」を除く（server/namecheck_family_test.go と同じ）', async () => {
    expect((await api.nameCheck(teacher, { child_ids: ['C001', 'C006'], text: 'たっくんとあおちゃん' })).names).toHaveLength(2);
    expect((await api.nameCheck(teacher, { child_ids: ['C001'], text: 'さくら組の高梨先生' })).names).toEqual([]);
  });

  it('ダッシュボードの園から未送信：送ると減り、今日の午睡で欠席にした子は数えない', async () => {
    clearFacility('C002');
    const n0 = (await api.staffSummary(teacher)).facilityUnsent;
    await api.sendFacility(teacher, 'C002', '今日も一日ありがとうございました。');
    expect((await api.staffSummary(teacher)).facilityUnsent).toBe(n0 - 1);
    const active = await api.activeSession(1, today(), teacher);
    const session = active ?? await api.startSession(teacher, 1, today());
    for (const x of db.napExclusions) if (['C011', 'C012'].includes(x.child_id)) x.is_deleted = true;
    clearFacility('C011'); clearFacility('C012');
    const n1 = (await api.staffSummary(teacher)).facilityUnsent;
    if (session.ended_at) return; // 18:00 には実施が終わっていて対象外にできないことがある
    await api.exclude(teacher, session.nap_session_id, 'C011', '2');
    expect((await api.staffSummary(teacher)).facilityUnsent).toBe(n1);
    await api.exclude(teacher, session.nap_session_id, 'C012', '1');
    expect((await api.staffSummary(teacher)).facilityUnsent).toBe(n1 - 1);
  });
});
