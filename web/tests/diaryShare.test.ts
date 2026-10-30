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

    const approved = { ...(await api.approveDiary(admin, d.diary_id, d.updated_at)) };
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
    await api.approveDiary(admin, d.diary_id, d.updated_at);
    expect(await sharedBodies(nishida)).not.toContain('共有を選ばない日誌');
  });

  /*
   * 承認は、管理者が承認画面で読んだ版のときだけ通る（取り下げ・承認の取り消しと同じ。詳細設計書「日誌の状態」(3-6)）。
   * 承認画面を開いているあいだに、取り下げて本文・園児・「保護者へ共有する」を変えて申請し直すと、状態は申請中に戻る。
   * 古い画面のまま承認しても断り、管理者が読んでいない本文を保護者へ届けない。server/api_diary_share_test.go と同じ観点
   */
  it('承認画面を開いたあとに申請し直されたら、古い版の承認は断り、保護者に届かない。読み直した版なら承認できる', async () => {
    // 1. 共有せずに申請した西田 太郎の日誌を、管理者が承認画面で開く（読んだ版）
    const d = { ...(await api.saveDiary(teacher, personal('園内で確かめる本文'), '2')) };
    const read = { ...(await api.getDiary(admin, d.diary_id)) };

    // 2. 取り下げ、本文・園児（村田 美咲）・「保護者へ共有する」を変えて申請し直す
    await api.withdrawDiary(teacher, d.diary_id, d.updated_at);
    const lock = await api.acquireLock(teacher, d.diary_id);
    if (!('token' in lock)) throw new Error(`ロックを取れませんでした（${lock.heldBy}さんが編集中）`);
    const again = { ...(await api.saveDiary(teacher, personal('管理者が読んでいない本文', {
      diary_id: d.diary_id, child_id: 'C004', share_to_guardian: true, lock_token: lock.token,
    }), '2')) };
    expect(again).toMatchObject({ status: '2', child_id: 'C004', share_to_guardian: true });

    // 3. 古い画面の版で承認すると断る。申請中のまま、どちらの保護者にも届かず、承認の操作ログも残らない
    await expect(api.approveDiary(admin, d.diary_id, read.updated_at))
      .rejects.toThrow('他の職員が更新しています。内容を再読み込みしてください。');
    expect(db.diaries.find((x) => x.diary_id === d.diary_id)!.status).toBe('2');
    for (const g of [nishida, murata]) expect(await sharedBodies(g)).not.toContain('管理者が読んでいない本文');
    expect(db.operationLogs.some((l) => l.target_table === 't_diary' && l.target_id === d.diary_id && l.operation_type === '3'))
      .toBe(false);

    // 4. 読み直した版なら承認でき、申請し直した園児の保護者に届く
    const cur = { ...(await api.getDiary(admin, d.diary_id)) };
    await expect(api.approveDiary(admin, d.diary_id, cur.updated_at)).resolves.toMatchObject({ status: '3' });
    expect(await sharedBodies(murata)).toContain('管理者が読んでいない本文');
    expect(await sharedBodies(nishida)).not.toContain('管理者が読んでいない本文');
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
