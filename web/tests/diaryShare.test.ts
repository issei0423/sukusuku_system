/*
 * 日誌の保護者への共有（モック）
 * 保育士が申請するときに「保護者へ共有する」を選び、管理者が承認すると、その園児の保護者が読める。
 * 2026-10-29 に持ち主が決めた（既定は共有しない。対象は個人日誌だけ）。
 * サーバ側は server/api_diary_share_test.go が同じ観点で確かめる。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import type { DiaryInput, SessionUser } from '../src/api/types';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: '', role, display_name: '', staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const nishida = user(6, '3', { guardian_id: 'G001' }); // 西田 太郎（C001）の保護者
const murata = user(9, '3', { guardian_id: 'G004' }); // 村田 美咲（C004）の保護者

const personal = (body: string, over: Partial<DiaryInput> = {}): DiaryInput => ({
  record_type: '1', child_id: 'C001', class_id: 1, diary_date: today(), body, ...over,
});
const sharedBodies = async (u: SessionUser) => (await api.guardianDiaries(u)).map((d) => d.body);

describe('日誌の保護者への共有（保育士の申請と管理者の承認がそろって届く）', () => {
  it('共有を選んで申請し、管理者が承認すると、自児の保護者にだけ届く。承認を取り消すと見えなくなる', async () => {
    const d = { ...(await api.saveDiary(teacher, personal('共有する日誌の本文', { share_to_guardian: true }), '2')) };
    expect(d.share_to_guardian).toBe(true);
    // 申請しただけでは届かない
    expect(await sharedBodies(nishida)).not.toContain('共有する日誌の本文');

    const approved = { ...(await api.approveDiary(admin, d.diary_id)) };
    const got = (await api.guardianDiaries(nishida)).find((x) => x.diary_id === d.diary_id);
    expect(got).toMatchObject({ child_id: 'C001', body: '共有する日誌の本文', diary_date: today() });
    expect(got!.child_name).toBeTruthy();
    expect(got!.shared_at).toBeTruthy();
    // 保護者に見せる項目だけを返す
    expect(Object.keys(got!).sort()).toEqual(['body', 'child_id', 'child_name', 'diary_date', 'diary_id', 'shared_at']);
    // 他児の保護者には届かない
    expect(await sharedBodies(murata)).not.toContain('共有する日誌の本文');
    // 操作ログに、共有して承認したことを残す
    expect(db.operationLogs.find((l) => l.target_table === 't_diary' && l.target_id === d.diary_id)!.after_value)
      .toBe('承認済み（保護者へ共有）');

    await api.revokeDiaryApproval(admin, d.diary_id, '書き直してください', approved.updated_at);
    expect(await sharedBodies(nishida)).not.toContain('共有する日誌の本文');
  });

  it('既定は共有しない。共有を選ばずに申請した日誌は、承認しても届かない', async () => {
    const d = await api.saveDiary(teacher, personal('共有を選ばない日誌'), '2');
    expect(d.share_to_guardian).toBe(false);
    await api.approveDiary(admin, d.diary_id);
    expect(await sharedBodies(nishida)).not.toContain('共有を選ばない日誌');
  });

  it('共有できるのは個人日誌だけ。クラス日誌に共有を選んで送っても、共有の印は付かない', async () => {
    const d = await api.saveDiary(teacher,
      { record_type: '2', child_id: null, class_id: 1, diary_date: today(), body: 'クラスの活動', share_to_guardian: true }, '2');
    expect(d.share_to_guardian).toBe(false);
  });

  it('共有された日誌は保護者だけが読む。職員には断る', async () => {
    for (const u of [admin, teacher]) {
      await expect(api.guardianDiaries(u)).rejects.toThrow('共有された日誌は保護者のみが利用できます');
    }
  });
});
