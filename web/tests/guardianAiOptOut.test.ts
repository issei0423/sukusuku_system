/*
 * 保護者のメニューの「AI の下書きの利用」（モック。POST /api/guardian/children/{childID}/ai-opt-out にあたる api.aiOptOut）
 * 典拠：詳細設計書「AI の下書きの利用」(4-15 (3))・「保護者のメニュー」(2-15 (4))・決めたこと D-49、
 *      基本設計書「園の有効化と保護者の拒否」(4-11)・「権限チェックの実装方針」(6-2)
 *
 * Go の同じ観点は server/api_guardian_ai_test.go にある。aiOptOutRefusals は Go の同じ名前の表と同じ行にする。
 * mockDb は同じファイルのテストどうしで使い回されるため、書き換えたものは afterEach で戻す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from '../src/api/client';
import { aiAvailableFor, mockAi } from '../src/api/mock';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import { MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const taroGuardian = user(6, '3', { guardian_id: 'G001' });

const setSetting = (key: string, value: string) => {
  db.settings.find((s) => s.setting_key === key)!.setting_value = value;
};
const link = (g: string, c: string) => db.guardianChildren.find((x) => x.guardian_id === g && x.child_id === c);
const removeLink = (g: string, c: string) => {
  const i = db.guardianChildren.findIndex((x) => x.guardian_id === g && x.child_id === c);
  if (i >= 0) db.guardianChildren.splice(i, 1);
};
const optOutLogs = (childId: string) => db.operationLogs.filter((l) => l.target_table === 't_guardian_child'
  && l.target_child_id === childId && (l.after_value ?? '').includes('AI の下書き'));
const homeOptOut = async (u: SessionUser) =>
  Object.fromEntries((await api.guardianHome(u)).map((r) => [r.today.child_id, r.today.ai_opt_out]));

beforeEach(() => {
  setSetting('ai.enabled', '1');
  Object.assign(mockAi, { mode: 'ok', keyPresent: true, keyRejected: false, lastSent: null, calls: 0 });
});
afterEach(() => {
  setSetting('ai.enabled', '0');
  Object.assign(link('G001', 'C001')!, { link_status: '1', ended_at: null, grace_ends_on: null, ai_opt_out: false });
  link('G004', 'C004')!.ai_opt_out = false;
  removeLink('G001', 'C006');
  removeLink('G004', 'C001');
});

type Refusal = {
  name: string; who: SessionUser; child: string; optOut: unknown; message: string;
  setup?: () => void; undo?: () => void;
};
/** server/api_guardian_ai_test.go の aiOptOutRefusals と同じ行 */
const aiOptOutRefusals: Refusal[] = [
  { name: '職員（担任）', who: teacher, child: 'C001', optOut: true, message: MSG.guardianOnly },
  { name: '職員（管理者）', who: admin, child: 'C001', optOut: true, message: MSG.guardianOnly },
  { name: '他児（紐づけが無い）', who: taroGuardian, child: 'C004', optOut: true, message: MSG.contactForbidden },
  { name: '無い園児', who: taroGuardian, child: 'C999', optOut: true, message: MSG.contactForbidden },
  { name: '紐づけが終了', who: taroGuardian, child: 'C001', optOut: true, message: MSG.contactForbidden,
    setup: () => { Object.assign(link('G001', 'C001')!, { link_status: '2', ended_at: '2026-08-20T10:00:00' }); },
    undo: () => { Object.assign(link('G001', 'C001')!, { link_status: '1', ended_at: null }); } },
  { name: '猶予中', who: taroGuardian, child: 'C001', optOut: true, message: MSG.guardianSettingGrace,
    setup: () => { Object.assign(link('G001', 'C001')!, { link_status: '3', grace_ends_on: '2099-03-31' }); },
    undo: () => { Object.assign(link('G001', 'C001')!, { link_status: '1', grace_ends_on: null }); } },
  { name: '園が AI を有効にしていない', who: taroGuardian, child: 'C001', optOut: true, message: MSG.aiNotEnabled,
    setup: () => setSetting('ai.enabled', '0'), undo: () => setSetting('ai.enabled', '1') },
  { name: 'opt_out が無い', who: taroGuardian, child: 'C001', optOut: undefined, message: MSG.badRequest },
  { name: 'opt_out が真偽でない', who: taroGuardian, child: 'C001', optOut: '1', message: MSG.badRequest },
];

describe('AI の下書きの利用：断る場合（4-15 (3)）', () => {
  it.each(aiOptOutRefusals.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    c.setup?.();
    try {
      await expect(api.aiOptOut(c.who, c.child, c.optOut as boolean)).rejects.toThrow(c.message);
    } finally {
      c.undo?.();
    }
    expect(link('G001', 'C001')!.ai_opt_out ?? false).toBe(false);
    expect(link('G004', 'C004')!.ai_opt_out ?? false).toBe(false);
    expect(optOutLogs('C001')).toHaveLength(0);
  });
});

describe('AI の下書きの利用：断ったら、その子には AI の下書きが作られない', () => {
  it('断ると status が偽になり、下書きは作られず AI を呼ばない。押し直せば戻る。操作ログは変わったときだけ', async () => {
    const draft = { purpose: 'facility_note' as const, child_id: 'C001', date: today() };
    expect((await api.aiStatus(teacher, { child_id: 'C001' })).available).toBe(true);

    expect(await api.aiOptOut(taroGuardian, 'C001', true)).toEqual({ ok: true });
    expect(link('G001', 'C001')!.ai_opt_out).toBe(true);
    expect((await api.aiStatus(teacher, { child_id: 'C001' })).available).toBe(false);
    await expect(api.aiDrafts(teacher, draft)).rejects.toThrow(MSG.aiUnavailableForTarget);
    expect(mockAi.calls).toBe(0);
    const logs = optOutLogs('C001');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      account_id: 6, function_type: '7', operation_type: '2', target_table: 't_guardian_child', target_id: 6, target_child_id: 'C001',
      before_value: '{"AI の下書きを使わない":"使う"}', after_value: '{"AI の下書きを使わない":"使わない"}',
    });

    // 同じ値をもう一度送っても、変わっていないので操作ログを足さない
    await api.aiOptOut(taroGuardian, 'C001', true);
    expect(optOutLogs('C001')).toHaveLength(1);

    // 外せば戻る
    await api.aiOptOut(taroGuardian, 'C001', false);
    expect((await api.aiStatus(teacher, { child_id: 'C001' })).available).toBe(true);
    await api.aiDrafts(teacher, draft);
    expect(mockAi.calls).toBe(1);
    const after = optOutLogs('C001');
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ before_value: '{"AI の下書きを使わない":"使わない"}', after_value: '{"AI の下書きを使わない":"使う"}' });
  });

  it('きょうだいは園児ごと。片方だけ断ったとき、もう片方は使える', async () => {
    // 野原さん（G001）に、きょうだいとして C006（さくら組。ほかに保護者はいない）を紐づける
    db.guardianChildren.push({ guardian_id: 'G001', child_id: 'C006', relationship: '父', link_status: '1', linked_at: '2026-04-01T09:00:00', ended_at: null });
    expect(aiAvailableFor(teacher, { child_id: 'C001' })).toBe(true);
    expect(aiAvailableFor(teacher, { child_id: 'C006' })).toBe(true);

    await api.aiOptOut(taroGuardian, 'C006', true);
    expect(aiAvailableFor(teacher, { child_id: 'C006' })).toBe(false);
    expect(aiAvailableFor(teacher, { child_id: 'C001' })).toBe(true);
    expect(await homeOptOut(taroGuardian)).toMatchObject({ C001: false, C006: true });
  });

  it('自分の紐づけの値だけを変える。ほかの家族の値は変えない・見せない（決めたこと D-49）', async () => {
    // C001 に、もう1人の家族（G004）が紐づいていて、その人は断っている
    db.guardianChildren.push({ guardian_id: 'G004', child_id: 'C001', relationship: '母', link_status: '1', linked_at: '2026-04-01T09:00:00', ended_at: null, ai_opt_out: true });
    expect((await homeOptOut(taroGuardian)).C001).toBe(false);

    await api.aiOptOut(taroGuardian, 'C001', true);
    await api.aiOptOut(taroGuardian, 'C001', false);
    expect(link('G004', 'C001')!.ai_opt_out).toBe(true);
    expect(link('G001', 'C001')!.ai_opt_out).toBe(false);
    expect(aiAvailableFor(teacher, { child_id: 'C001' })).toBe(false);
  });
});
