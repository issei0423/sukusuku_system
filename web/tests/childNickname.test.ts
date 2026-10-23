/*
 * 呼び名（m_child.nickname）を、園児情報入力（#198）と他児の名前の注意（#201）が同じ園児の行で共に使う（モック）
 * 典拠：詳細設計書「園児の登録と個人チャット」(4-9)・「他児の名前の照合」(4-5 (2))、インタフェース一覧「Child」
 * （呼び名は保護者の応答には含めない）
 *
 * Go の同じ観点は server/child_nickname_test.go にある。
 * mockDb はこのファイルのテストで使い回す（前のテストの書き込みを当てにしない）。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const taroGuardian = user(6, '3', { guardian_id: 'G001' });

describe('呼び名を園児情報入力と他児の名前の注意で共に使う', () => {
  it('園児情報入力で入れた呼び名が、他児の名前の注意に当たる。操作ログは呼び名だけを残す', async () => {
    const c = db.children.find((x) => x.child_id === 'C002')!;
    expect(c.nickname ?? '').toBe('');
    await api.saveChild(admin, {
      child_id: c.child_id, child_name: c.child_name, child_name_kana: c.child_name_kana, nickname: 'はなちゃん',
      birth_date: c.birth_date, sex: c.sex, normal_temperature: c.normal_temperature, photo_consent_level: c.photo_consent_level,
      class_id: 1, allergies: [], medical_histories: [],
    }, 'edit');

    expect((await api.nameCheck(teacher, { child_ids: ['C001'], text: 'はなちゃんと砂場で遊びました' })).names).toEqual(['遠藤 花子']);

    const log = db.operationLogs.filter((l) => l.target_table === 'm_child' && l.target_child_id === 'C002').at(-1)!;
    expect(JSON.parse(log.before_value ?? '{}')).toEqual({ 呼び名: '' });
    expect(JSON.parse(log.after_value ?? '{}')).toEqual({ 呼び名: 'はなちゃん' });
  });

  it('保護者の応答（保護者ホーム・園児の一覧）には呼び名を入れない。職員の応答と園児の行には残る', async () => {
    const home = await api.guardianHome(taroGuardian);
    expect(home.length).toBeGreaterThan(0);
    expect(home.every((h) => !('nickname' in h.child))).toBe(true);
    const mine = await api.listChildren(taroGuardian);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((c) => !('nickname' in c))).toBe(true);

    expect((await api.listChildren(admin)).find((c) => c.child_id === 'C001')?.nickname).toBe('たっくん');
    expect(db.children.find((c) => c.child_id === 'C001')?.nickname).toBe('たっくん');
    // 保護者の応答のあとでも、照合は園児の行の呼び名で当たる
    expect((await api.nameCheck(teacher, { child_ids: ['C006'], text: 'たっくんと遊びました' })).names).toEqual(['西田 太郎']);
  });
});
