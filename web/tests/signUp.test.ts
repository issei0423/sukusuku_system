/*
 * 保護者の新規登録で受け取るもの（GitHub Issue #170 の 1・4）
 * 典拠：基本設計書.md「保護者アカウントの自己登録」(4-3)・「同意履歴（t_terms_agreement）」(5-2)・
 *      「入力項目の制約値」(4-9)・「アカウント（m_account）」(5-2)、図/画面詳細図.md「新規登録画面（保護者）」(2-3)
 *
 * サーバ（server/api_signup_test.go）と同じ規則であることを、同じ観点で確かめる。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

type SignUpInput = Parameters<typeof api.signUpGuardian>[0];

/** 既定の入力（いまの版の規約に同意したもの）に、overrides を重ねる。undefined にした項目は送らない */
function input(code: string, overrides: Record<string, unknown> = {}): SignUpInput {
  const base: Record<string, unknown> = {
    code, email: 'signup.test@example.jp', password: 'signup-5678',
    guardian_name: '検査 太郎', relationship: '母',
    terms_agreed: true, terms_version: db.CURRENT_TERMS_VERSION,
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) if (v === undefined) delete base[k];
  return base as unknown as SignUpInput;
}

const codeStatus = (code: string) => db.invitationCodes.find((c) => c.code === code)?.status;
const accountOf = (email: string) => db.accounts.find((a) => a.email === email);

describe('規約への同意を受け取らずに登録しない（GitHub Issue #170 の 1）', () => {
  it.each([
    ['同意の項目が無い', { terms_agreed: undefined, terms_version: undefined }],
    ['同意しない', { terms_agreed: false }],
    ['同意したが、どの版かが無い', { terms_version: undefined }],
    ['いまの版でない規約への同意', { terms_version: '0.9' }],
  ])('%s なら登録せず、招待コードも使わない', async (_name, overrides) => {
    const code = await api.issueOneInvitationCode(admin, 'C007', 30);
    await expect(api.signUpGuardian(input(code, overrides))).rejects.toThrow('利用規約');
    expect(accountOf('signup.test@example.jp')).toBeUndefined();
    expect(codeStatus(code)).toBe('1');
  });

  it('いまの版に同意すれば登録でき、その版への同意が履歴に残る', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C007', 30);
    const u = await api.signUpGuardian(input(code, { email: 'agreed@example.jp' }));
    expect(u.terms_agreed).toBe(true);
    const rows = db.termsAgreements.filter((x) => x.account_id === u.account_id);
    expect(rows).toHaveLength(1);
    expect(db.termsDocs.find((t) => t.terms_id === rows[0].terms_id)?.terms_version).toBe(db.CURRENT_TERMS_VERSION);
  });
});

describe('保護者の氏名・続柄・メールアドレスの検査（GitHub Issue #170 の 4）', () => {
  it.each([
    ['氏名が51文字', { guardian_name: 'あ'.repeat(51) }, '50文字以内'],
    ['続柄が選択肢にない', { relationship: 'おじ' }, '続柄'],
    ['続柄が空', { relationship: '' }, '続柄'],
    ['続柄が無い', { relationship: undefined }, '続柄'],
    ['大文字・小文字だけが違う既存のメールアドレス', { email: 'NISHIDA.T@EXAMPLE.JP' }, 'すでに登録されています'],
    ['大文字・小文字だけが違う職員のログインID', { email: 'Suzuki@Hoiku.Example.JP' }, 'すでに登録されています'],
  ])('%s なら登録せず、招待コードも使わない', async (_name, overrides, message) => {
    const code = await api.issueOneInvitationCode(admin, 'C006', 30);
    await expect(api.signUpGuardian(input(code, { email: 'fields@example.jp', ...overrides }))).rejects.toThrow(message);
    expect(codeStatus(code)).toBe('1');
  });

  it('氏名が50文字ちょうどで、選択肢の続柄なら登録できる。前後の空白は落として残す', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C006', 30);
    const name = 'い'.repeat(50);
    const u = await api.signUpGuardian(input(code, { email: 'fifty@example.jp', guardian_name: ` ${name} `, relationship: '祖父' }));
    const guardian = db.guardians.find((g) => g.guardian_id === u.guardian_id)!;
    expect(guardian.guardian_name).toBe(name);
    expect(db.guardianChildren.find((gc) => gc.guardian_id === u.guardian_id)?.relationship).toBe('祖父');
  });
});
