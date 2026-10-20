/*
 * 保護者のメニューの「お子さまの追加」（モック。POST /api/invitation/verify を広げたもの・POST /api/guardian/children にあたる
 * api.verifyInvitationCode・api.addChild）
 * 典拠：詳細設計書「お子さまの追加」(4-15 (1))・(2-15 (2))・決めたこと D-47・D-48、
 *      基本設計書「お子さまの追加（園児の追加紐づけ）」(4-3)・「操作ログ（t_operation_log）」(5-9)・「チャット」(5-6)
 *
 * Go の同じ観点は server/api_guardian_add_test.go にある。addChildRefusals は Go の同じ名前の表と同じ行にする。
 * mockDb は同じファイルのテストどうしで使い回されるため、書き換える表は beforeEach で写し、afterEach で戻す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api, connectLive } from '../src/api/client';
import { mockAddChildFault } from '../src/api/mock';
import * as db from '../src/api/mockDb';
import { now } from '../src/api/util';
import { subscribeLive } from '../src/live';
import type { LiveSignal } from '../src/live';
import { MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
// デモデータの人物（mockDb.ts。server/seed.sql と同じ）
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const taroGuardian = user(6, '3', { guardian_id: 'G001' }); // 野原 太郎（C001）の保護者。個人チャットは 6
const misakiGuardian = user(9, '3', { guardian_id: 'G004' }); // 宮城 美咲（C004）の保護者

// server/api_guardian_add_test.go と同じコード
const codeHanako = 'QRST-9012-UVWX'; // C002（上園 花子。さくら組・個人チャット 7。上園さんが連絡順 1 で紐づく）の未使用のコード
const codeTaro = 'ABCD-1234-EFGH'; // C001（野原 太郎）の未使用のコード
const codeUsed = 'IJKL-5678-MNOP';
const codeRevoked = 'YZAB-3456-CDEF';

const link = (g: string, c: string) => db.guardianChildren.find((x) => x.guardian_id === g && x.child_id === c);
const codeOf = (code: string) => db.invitationCodes.find((x) => x.code === code)!;
const codeUse = (code: string) => `${codeOf(code).status}/${codeOf(code).used_account_id ?? ''}`;
const member = (roomId: number, accountId: number) =>
  db.chatMembers.find((m) => m.chat_room_id === roomId && m.account_id === accountId);
const addChildLogs = (childId: string) => db.operationLogs.filter((l) => l.target_table === 't_guardian_child'
  && l.target_child_id === childId && (l.after_value ?? '').includes('お子さまを追加'));

// 書き換える表の写し
let saved: {
  links: typeof db.guardianChildren; codes: typeof db.invitationCodes; members: typeof db.chatMembers; logs: typeof db.operationLogs;
};
const stops: (() => void)[] = [];
beforeEach(() => {
  saved = {
    links: structuredClone(db.guardianChildren), codes: structuredClone(db.invitationCodes),
    members: structuredClone(db.chatMembers), logs: structuredClone(db.operationLogs),
  };
});
afterEach(() => {
  mockAddChildFault.at = null;
  stops.splice(0).forEach((s) => s());
  db.guardianChildren.splice(0, db.guardianChildren.length, ...saved.links);
  db.invitationCodes.splice(0, db.invitationCodes.length, ...saved.codes);
  db.chatMembers.splice(0, db.chatMembers.length, ...saved.members);
  db.operationLogs.splice(0, db.operationLogs.length, ...saved.logs);
});

/** viewer がこのタブでログインしているとして、届いた知らせを集める（tests/liveMock.test.ts と同じ） */
function watch(viewer: SessionUser): LiveSignal[] {
  const got: LiveSignal[] = [];
  stops.push(connectLive(viewer.account_id));
  stops.push(subscribeLive((s) => got.push(s)));
  return got;
}

describe('招待コードの確認：ログインしている保護者にだけ園児名を返す（決めたこと D-47）', () => {
  it('ログインしていない人・職員には返さず、保護者には園児名と最初に登録したときの続柄を返す', async () => {
    expect(await api.verifyInvitationCode(codeHanako)).toEqual({ ok: true });
    expect(await api.verifyInvitationCode(codeHanako, teacher)).toEqual({ ok: true });
    // 大文字小文字を区別せず、ハイフンは省いてよい（新規登録と同じ形）
    expect(await api.verifyInvitationCode('qrst9012uvwx', taroGuardian))
      .toEqual({ ok: true, child_name: '上園 花子', relationship: '父' });
    // 確かめるだけでは、コードを使わない
    expect(codeUse(codeHanako)).toBe('1/');
  });

  it('すでに紐づいている園児（有効・猶予中）は断り、終了した紐づけの園児は追加し直せる', async () => {
    await expect(api.verifyInvitationCode(codeTaro, taroGuardian)).rejects.toThrow(MSG.childAlreadyAdded);
    Object.assign(link('G001', 'C001')!, { link_status: '3', grace_ends_on: '2099-03-31' });
    await expect(api.verifyInvitationCode(codeTaro, taroGuardian)).rejects.toThrow(MSG.childAlreadyAdded);
    Object.assign(link('G001', 'C001')!, { link_status: '2', grace_ends_on: null, ended_at: '2026-08-20T10:00:00' });
    expect((await api.verifyInvitationCode(codeTaro, taroGuardian)).child_name).toBe('野原 太郎');
  });
});

type Refusal = {
  name: string; who: SessionUser; code: string; rel: string; message: string;
  setup?: () => void;
};
/** server/api_guardian_add_test.go の addChildRefusals と同じ行 */
const addChildRefusals: Refusal[] = [
  { name: '職員（担任）', who: teacher, code: codeHanako, rel: '母', message: MSG.guardianOnly },
  { name: '職員（管理者）', who: admin, code: codeHanako, rel: '母', message: MSG.guardianOnly },
  // 招待コードの4つの文言（基本設計書「メッセージ一覧」(4-12)。設計書の文と同じことは tests/invitationMessages.test.ts が確かめる）
  { name: '無いコード', who: taroGuardian, code: 'ZZZZ-0000-ZZZZ', rel: '母', message: MSG.invitationNotFound },
  { name: '使用済み', who: taroGuardian, code: codeUsed, rel: '母', message: MSG.invitationUsed },
  { name: '失効', who: taroGuardian, code: codeRevoked, rel: '母', message: MSG.invitationRevoked },
  { name: '期限切れ', who: taroGuardian, code: codeHanako, rel: '母', message: MSG.invitationExpired,
    setup: () => { codeOf(codeHanako).expires_on = '2000-01-01'; } },
  { name: 'もう追加済み（有効）', who: taroGuardian, code: codeTaro, rel: '父', message: MSG.childAlreadyAdded },
  { name: 'もう追加済み（猶予中）', who: taroGuardian, code: codeTaro, rel: '父', message: MSG.childAlreadyAdded,
    setup: () => { Object.assign(link('G001', 'C001')!, { link_status: '3', grace_ends_on: '2099-03-31' }); } },
  { name: '続柄が空', who: taroGuardian, code: codeHanako, rel: '  ', message: MSG.relationshipRequired },
  { name: '続柄が21文字', who: taroGuardian, code: codeHanako, rel: 'あ'.repeat(21), message: MSG.relationshipRequired },
];

describe('お子さまの追加：断る場合（4-15 (1)）', () => {
  it.each(addChildRefusals.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    c.setup?.();
    await expect(api.addChild(c.who, c.code, c.rel)).rejects.toThrow(c.message);
    // どれも書いていない
    expect(link('G001', 'C002')).toBeUndefined();
    expect(codeUse(codeHanako)).toBe('1/');
    expect(codeUse(codeTaro)).toBe('1/');
    expect(member(7, 6)).toBeUndefined();
    expect(addChildLogs('C002')).toHaveLength(0);
  });
});

describe('お子さまの追加：成功', () => {
  it('紐づけ・コードの使用済み・個人チャットへの参加を行い、保護者ホームに区画が増える。知らせは参加したルームへ', async () => {
    const got = watch(teacher);
    const sakuraBefore = { ...member(3, 6)! };
    expect(await api.addChild(taroGuardian, 'qrst-9012-uvwx', ' 母 ')).toEqual({ ok: true, child_id: 'C002' });

    // 続柄は前後の空白を落とす。連絡順は、上園さん（1）の次。AI の下書きは断っていない
    expect(link('G001', 'C002')).toMatchObject({ link_status: '1', relationship: '母', contact_order: 2, ai_opt_out: false, linked_at: now(), ended_at: null });
    expect(codeUse(codeHanako)).toBe('2/6');
    expect(codeOf(codeHanako).used_at).toBe(now());
    // 個人チャット（7）へ今の時刻で参加する。さくら組のクラスグループ（3）は参加済みのまま変えない
    expect(member(7, 6)).toMatchObject({ joined_at: now(), left_at: null });
    expect(member(3, 6)).toEqual(sakuraBefore);
    const logs = addChildLogs('C002');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      account_id: 6, function_type: '7', operation_type: '1', target_table: 't_guardian_child', target_id: 6,
      target_child_id: 'C002', after_value: '招待コードでお子さまを追加',
    });
    // 知らせは参加したルーム（個人チャット 7）の参加者へ。参加の変わらないクラスグループへは送らない
    expect(got).toEqual([{ type: 'chat', room_id: 7 }]);
    // 保護者ホームに、その園児の区画が増える
    expect((await api.guardianHome(taroGuardian)).map((r) => r.child.child_id).sort()).toEqual(['C001', 'C002']);
    // 同じコードは使えない
    await expect(api.addChild(taroGuardian, codeHanako, '母')).rejects.toThrow();
  });

  it('ほかの家庭には知らせない', async () => {
    const got = watch(misakiGuardian);
    await api.addChild(taroGuardian, codeHanako, '母');
    expect(got).toEqual([]);
  });

  it('ほかのクラスの子：いまのクラスのクラスグループへ参加する。個人チャットのルームが無い子は、個人チャットの参加を飛ばす', async () => {
    // 井上 空（C013。ひまわり組。クラスグループ 4、個人チャットのルームは無い）のコード
    db.invitationCodes.push({ invitation_code_id: 9001, code: 'TEST-0013-AAAA', child_id: 'C013', expires_on: '2099-12-31', status: '1',
      used_account_id: null, used_at: null, issued_staff_id: 'S001', created_at: now() });
    await api.addChild(taroGuardian, 'TEST-0013-AAAA', '祖父');
    expect(member(4, 6)).toMatchObject({ joined_at: now(), left_at: null });
    expect(link('G001', 'C013')).toMatchObject({ link_status: '1', contact_order: 1, relationship: '祖父' });
  });
});

describe('お子さまの追加：終了した紐づけ（決めたこと D-48）', () => {
  it('新しい行を作らずに有効へ戻し、個人チャットとクラスグループへは今の時刻で新しく参加する。外れていたあいだのやりとりは見せない', async () => {
    // 管理者が紐づけを解除したあと（AI の下書きは断っていた）
    Object.assign(link('G001', 'C001')!, { link_status: '2', ended_at: '2026-08-20T10:00:00', ai_opt_out: true });
    member(3, 6)!.left_at = '2026-08-20T10:00:00';
    member(6, 6)!.left_at = '2026-08-20T10:00:00';
    // 外れていたあいだに園が書いた連絡（時計を変えて回しても過去になる、決まった時刻で足す）
    db.chatMessages.push({ chat_message_id: 9001, chat_room_id: 6, sender_account_id: 3, body: '外れていたあいだの連絡', source_type: '1',
      source_id: null, sent_at: '2026-09-15T10:00:00', edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null });
    stops.push(() => { db.chatMessages.splice(db.chatMessages.findIndex((m) => m.chat_message_id === 9001), 1); });

    await api.addChild(taroGuardian, codeTaro, '母');
    expect(db.guardianChildren.filter((g) => g.guardian_id === 'G001' && g.child_id === 'C001')).toHaveLength(1);
    expect(link('G001', 'C001')).toMatchObject({ link_status: '1', ended_at: null, linked_at: now(), relationship: '母' });
    // 【仮置き】断っていたのは残す（web/仮置き値.md）
    expect(link('G001', 'C001')!.ai_opt_out).toBe(true);
    expect(member(6, 6)).toMatchObject({ joined_at: now(), left_at: null });
    expect(member(3, 6)).toMatchObject({ joined_at: now(), left_at: null });
    expect((await api.messages(taroGuardian, 6)).map((m) => m.body)).not.toContain('外れていたあいだの連絡');
    const logs = addChildLogs('C001');
    expect(logs).toHaveLength(1);
    expect(logs[0].after_value).toContain('戻した');
  });

  it('【仮置き】参加し直しても最初に参加した日時（first_joined_at）を残し、保護者がまだいなかった間の連絡は見せる（#198 の境。web/仮置き値.md）', async () => {
    const firstJoined = member(6, 6)!.joined_at;
    Object.assign(link('G001', 'C001')!, { link_status: '2', ended_at: '2026-08-20T10:00:00' });
    member(3, 6)!.left_at = '2026-08-20T10:00:00';
    member(6, 6)!.left_at = '2026-08-20T10:00:00';
    // 保護者がまだ1人も参加していなかった間の連絡（最初の参加より前）と、外れていたあいだの連絡
    const msg = (id: number, body: string, sentAt: string) => ({ chat_message_id: id, chat_room_id: 6, sender_account_id: 3, body,
      source_type: '1' as const, source_id: null, sent_at: sentAt, edited_at: null, is_deleted: false, deleted_at: null, deleted_account_id: null });
    db.chatMessages.push(msg(9002, '保護者がいなかった間の連絡', '2025-01-01T10:00:00'), msg(9003, '外れていたあいだの連絡', '2026-09-15T10:00:00'));
    stops.push(() => {
      for (const id of [9002, 9003]) db.chatMessages.splice(db.chatMessages.findIndex((m) => m.chat_message_id === id), 1);
    });

    await api.addChild(taroGuardian, codeTaro, '母');
    expect(member(6, 6)).toMatchObject({ first_joined_at: firstJoined, joined_at: now(), left_at: null });
    const bodies = (await api.messages(taroGuardian, 6)).map((m) => m.body);
    expect(bodies).toContain('保護者がいなかった間の連絡');
    expect(bodies).not.toContain('外れていたあいだの連絡');
  });
});

describe('お子さまの追加：途中で失敗したら全部を戻す', () => {
  it('チャットの参加で失敗すると、紐づけ・コードの使用済み・参加のどれも残さない。止めるのをやめれば追加できる', async () => {
    mockAddChildFault.at = 'join';
    await expect(api.addChild(taroGuardian, codeHanako, '母')).rejects.toThrow(MSG.addChildFailed);
    expect(link('G001', 'C002')).toBeUndefined();
    expect(codeUse(codeHanako)).toBe('1/');
    expect(codeOf(codeHanako).used_at).toBeNull();
    expect(member(7, 6)).toBeUndefined();
    expect(addChildLogs('C002')).toHaveLength(0);

    mockAddChildFault.at = null;
    await api.addChild(taroGuardian, codeHanako, '母');
    expect(link('G001', 'C002')?.link_status).toBe('1');
  });

  it('終了した紐づけを戻す途中で失敗しても、終了のまま', async () => {
    Object.assign(link('G001', 'C001')!, { link_status: '2', ended_at: '2026-08-20T10:00:00' });
    member(6, 6)!.left_at = '2026-08-20T10:00:00';
    const personalBefore = { ...member(6, 6)! };
    mockAddChildFault.at = 'join';
    await expect(api.addChild(taroGuardian, codeTaro, '母')).rejects.toThrow(MSG.addChildFailed);
    expect(link('G001', 'C001')).toMatchObject({ link_status: '2', ended_at: '2026-08-20T10:00:00', relationship: '父' });
    expect(codeUse(codeTaro)).toBe('1/');
    expect(member(6, 6)).toEqual(personalBefore);
    expect(addChildLogs('C001')).toHaveLength(0);
  });
});
