/*
 * 日誌を園内の記録にした作り直し：申請の取り下げ・承認の取り消し・承認と差し戻しの列・承認待ちの並び
 * 典拠：詳細設計書.md「日誌の状態（取り下げと承認の取り消しを含む）」(3-6)・「日誌」(4-13 (2)〜(5))、
 *      「日誌の画面（作り直し）」(2-13 (1)〜(3))
 *
 * Go サーバ側（server/api_diary_internal_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 * 保護者が日誌を読めないことは guardianScope.test.ts の「日誌は保護者に見せない」にある。
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
const admin = user(1, '1', { staff_id: 'S001' }); // 西田 拓也（日誌 4・5 を承認した管理者）
const admin2 = user(2, '1', { staff_id: 'S002' }); // 遠藤 直人（承認していない管理者）
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' }); // 鈴木（日誌 4・5 の作成者）
const murata = user(4, '2', { staff_id: 'S004', class_id: 1, class_name: 'さくら組' }); // 同じクラスの職員
const guardian = user(6, '3', { guardian_id: 'G001' }); // 西田 太郎（C001）の保護者

const personal = (over: Partial<DiaryInput> = {}): DiaryInput => ({
  record_type: '1', child_id: 'C001', class_id: 1, diary_date: today(), body: '取り下げを試す日誌', ...over,
});
const lockOf = async (u: SessionUser, diaryId: number) => {
  const r = await api.acquireLock(u, diaryId);
  if (!('token' in r)) throw new Error(`ロックを取れませんでした（${r.heldBy}さんが編集中）`);
  return r.token;
};
const rowOf = (id: number) => db.diaries.find((d) => d.diary_id === id)!;
/** 断られたときの文と種類（kind）。断られなければ落とす */
type Rejected = Error & { kind?: string };
async function rejection(p: Promise<unknown>): Promise<Rejected> {
  try { await p; } catch (e) { return e as Rejected; }
  throw new Error('断られなかった');
}
const VERSION_CONFLICT = '他の職員が更新しています。内容を再読み込みしてください。';
const lastLogOf = (id: number) => db.operationLogs.find((l) => l.target_table === 't_diary' && l.target_id === id)!;

describe('申請の取り下げ（申請した本人だけ・申請中だけ・読んだ版のときだけ）', () => {
  it('作って申請すると、申請した職員と日時が入る。本人でなければ断る', async () => {
    const d = await api.saveDiary(teacher, personal(), '2');
    expect(d).toMatchObject({ status: '2', applied_staff_id: 'S003' });
    expect(d.applied_at).toBeTruthy();
    for (const u of [admin, murata]) {
      await expect(api.withdrawDiary(u, d.diary_id, d.updated_at)).rejects.toThrow('申請を取り下げられるのは、申請した本人だけです。');
    }
    await expect(api.withdrawDiary(guardian, d.diary_id, d.updated_at)).rejects.toThrow('この日誌を参照する権限がありません');
    // 読んだ版が違う。種類 version_conflict を添える（server/api_diary_write.go の handleWithdrawDiary と同じ）
    const e = await rejection(api.withdrawDiary(teacher, d.diary_id, '2000-01-01T00:00:00'));
    expect([e.message, e.kind]).toEqual([VERSION_CONFLICT, 'version_conflict']);
    expect(rowOf(d.diary_id).status).toBe('2');
  });

  it('本人が取り下げると下書きに戻り、申請者が空になり、承認待ちから外れる。操作ログに申請者と申請日時が残る', async () => {
    // モックは保持している行そのものを返すため、比べる値は写しておく
    const d = { ...(await api.saveDiary(teacher, personal({ body: '取り下げる日誌' }), '2')) };
    const withdrawn = { ...(await api.withdrawDiary(teacher, d.diary_id, d.updated_at)) };
    expect(withdrawn).toMatchObject({ status: '1', applied_staff_id: null, applied_at: null });
    expect(withdrawn.updated_at > d.updated_at).toBe(true);
    expect((await api.pendingDiaries(admin)).some((x) => x.diary_id === d.diary_id)).toBe(false);
    const l = lastLogOf(d.diary_id);
    expect(l.after_value).toBe('取り下げ');
    expect(l.before_value).toContain('S003');
    expect(l.before_value).toContain(d.applied_at!);

    // 取り下げたあとに届いた承認・差し戻しは「取り下げられました」
    await expect(api.approveDiary(admin, d.diary_id, d.updated_at)).rejects.toThrow('この日誌は取り下げられました。');
    await expect(api.returnDiary(admin, d.diary_id, '直してください')).rejects.toThrow('この日誌は取り下げられました。');
    expect(rowOf(d.diary_id).status).toBe('1');

    // 下書きに戻った日誌は、ロックを取って直して申請し直せる。前の版では取り下げられない
    const again = await api.saveDiary(teacher, personal({
      diary_id: d.diary_id, body: '直して申請し直す', lock_token: await lockOf(teacher, d.diary_id),
    }), '2');
    expect(again).toMatchObject({ status: '2', applied_staff_id: 'S003' });
    expect(again.updated_at > withdrawn.updated_at).toBe(true);
    await expect(api.withdrawDiary(teacher, d.diary_id, withdrawn.updated_at)).rejects.toThrow('他の職員が更新しています');
  });

  it('承認・差し戻しが先に済んでいれば、取り下げは「すでに承認または差し戻しされたため…」で断る', async () => {
    const d = { ...(await api.saveDiary(teacher, personal({ body: '先に承認される日誌' }), '2')) };
    await api.approveDiary(admin, d.diary_id, d.updated_at);
    await expect(api.withdrawDiary(teacher, d.diary_id, d.updated_at))
      .rejects.toThrow('すでに承認または差し戻しされたため、取り下げられません。');
    expect(rowOf(d.diary_id).status).toBe('3');

    const r = { ...(await api.saveDiary(teacher, personal({ body: '先に差し戻される日誌' }), '2')) };
    await api.returnDiary(admin, r.diary_id, '書き足してください');
    await expect(api.withdrawDiary(teacher, r.diary_id, r.updated_at))
      .rejects.toThrow('すでに承認または差し戻しされたため、取り下げられません。');
  });
});

describe('承認の取り消し（管理者だけ・理由が必須・承認済みだけ・読んだ版のときだけ）', () => {
  it('管理者でなければ断る。理由が空・空白だけ・500文字を超えると断る。読んだ版が違えば断る', async () => {
    const d = rowOf(4);
    await expect(api.revokeDiaryApproval(teacher, 4, '確かめ直します', d.updated_at)).rejects.toThrow('承認の取り消しは管理者のみが行えます。');
    for (const reason of ['', '　 ']) {
      await expect(api.revokeDiaryApproval(admin, 4, reason, d.updated_at)).rejects.toThrow('承認を取り消す理由を入力してください。');
    }
    await expect(api.revokeDiaryApproval(admin, 4, 'あ'.repeat(501), d.updated_at))
      .rejects.toThrow('承認を取り消す理由は500文字以内で入力してください。');
    // 読んだ版が違う。種類 version_conflict を添える（server/api_diary_write.go の handleRevokeDiaryApproval と同じ）
    const e = await rejection(api.revokeDiaryApproval(admin, 4, '確かめ直します', '2000-01-01T00:00:00'));
    expect([e.message, e.kind]).toEqual([VERSION_CONFLICT, 'version_conflict']);
    expect(rowOf(4).status).toBe('3');
  });

  it('ほかの管理者が承認したものも取り消せる。差し戻しになり、承認者・承認日時が空になる。元の値は操作ログに残る', async () => {
    const before = { ...rowOf(4) };
    const got = await api.revokeDiaryApproval(admin2, 4, ' 本文を確かめ直してください ', before.updated_at);
    expect(got).toMatchObject({
      status: '4', approved_staff_id: null, approved_at: null, approved_staff_name: null, returned_reason: '本文を確かめ直してください',
    });
    const l = lastLogOf(4);
    expect(l.before_value).toContain('S001');
    expect(l.before_value).toContain(before.approved_at!);
    expect(l.after_value).toBe('承認の取り消し：本文を確かめ直してください');
    // 作成者の「差し戻された日誌」に出る
    expect((await api.listDiaries(teacher, { status: '4', mine: true })).rows.some((x) => x.diary_id === 4)).toBe(true);
    // もう承認済みではない
    await expect(api.revokeDiaryApproval(admin, 4, 'もう一度', rowOf(4).updated_at))
      .rejects.toThrow('承認済みの日誌ではありません。画面を読み込み直してください。');
  });

  it('自分が承認したものも取り消せる', async () => {
    await expect(api.revokeDiaryApproval(admin, 5, '確かめ直します', rowOf(5).updated_at)).resolves.toMatchObject({ status: '4' });
  });
});

describe('承認・差し戻しの列（詳細設計書「日誌の状態」(3-6)）', () => {
  it('作成者が管理者でも、ほかの職員が申請したものは承認できる。自分が申請したものは断る', async () => {
    const draft = await api.saveDiary(admin, personal({ body: '園長が書き始めた記録' }), '1');
    await api.saveDiary(teacher, personal({
      diary_id: draft.diary_id, body: '担任が書き足して申請', lock_token: await lockOf(teacher, draft.diary_id),
    }), '2');
    const approved = await api.approveDiary(admin, draft.diary_id, rowOf(draft.diary_id).updated_at);
    expect(approved).toMatchObject({ status: '3', approved_staff_id: 'S001', applied_staff_id: 'S003', applied_staff_name: '鈴木 浩之' });

    const mine = await api.saveDiary(admin2, personal({ body: '遠藤が書いて申請' }), '2');
    await expect(api.approveDiary(admin2, mine.diary_id, mine.updated_at)).rejects.toThrow('自分が申請した日誌は承認できません。ほかの管理者に依頼してください。');
    await expect(api.approveDiary(teacher, mine.diary_id, mine.updated_at)).rejects.toThrow('承認は管理者のみが行えます');
  });

  it('差し戻しは承認者の列を書かない。差し戻したものは承認できない', async () => {
    const got = await api.returnDiary(admin, 7, '書き足してください');
    expect(got).toMatchObject({ status: '4', approved_staff_id: null, approved_at: null });
    await expect(api.approveDiary(admin, 7, rowOf(7).updated_at)).rejects.toThrow('申請中の日誌のみ承認できます');
  });

  it('承認待ちは申請日時の古い順に並び、申請者を添える', async () => {
    rowOf(2).applied_at = '2026-01-02T09:00:00';
    rowOf(6).applied_at = '2026-01-01T09:00:00';
    const pending = await api.pendingDiaries(admin);
    const ids = pending.map((d) => d.diary_id);
    expect(ids.indexOf(6)).toBeLessThan(ids.indexOf(2));
    for (const d of pending) {
      expect(d.applied_staff_id).toBeTruthy();
      expect(d.applied_staff_name).toBeTruthy();
    }
    const sorted = [...pending].sort((a, b) => (a.applied_at ?? '').localeCompare(b.applied_at ?? ''));
    expect(pending.map((d) => d.applied_at)).toEqual(sorted.map((d) => d.applied_at));
  });
});
