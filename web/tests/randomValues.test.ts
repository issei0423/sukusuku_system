/*
 * 推測されてはならない値（一時パスワード・招待コード）の作り方（GitHub Issue #236 の 1・2）
 * サーバ側（server/security_test.go の TestTempPasswordIsHardToGuess・TestInvitationCodeShape）と同じ形であることを確かめる
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

describe('推測されてはならない値', () => {
  it('一時パスワードは「temp」＋4桁でなく、紛らわしい文字を除いた英小文字と数字を 4 文字ずつ 3 組', async () => {
    const temp = await api.reissueTempPassword(admin, 3);
    expect(temp).toMatch(/^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
    // 発行した一時パスワードでログインできる
    const u = await api.login('takanashi@hoiku.example.jp', temp, 'staff');
    expect(u.is_temp_password).toBe(true);
  });

  it('招待コードは紛らわしい文字を除いた 4 文字 × 3 で、重ならない', async () => {
    const codes = new Set<string>();
    for (const childId of ['C008', 'C009', 'C010']) {
      const code = await api.issueOneInvitationCode(admin, childId, 30);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      codes.add(code);
    }
    expect(codes.size).toBe(3);
  });
});

/*
 * 存在しないログインIDも、残りの回数とロックが実在のアカウントと同じに進む（GitHub Issue #159 の 5）。
 * サーバ側（server/security_test.go の TestUnknownLoginIDCountsDownLikeRealAccount）と同じ観点
 */
describe('存在しないログインID', () => {
  const outcomes = async (email: string) => {
    const out: (number | string)[] = [];
    for (let i = 0; i < 6; i++) {
      try {
        await api.login(email, 'wrong-pass', 'staff');
        out.push('ok');
      } catch (e) {
        const err = JSON.parse((e as Error).message) as { kind: string; remaining?: number };
        out.push(err.kind === 'credential' ? err.remaining ?? -1 : err.kind);
      }
    }
    return out;
  };

  it('残りの回数が減り、同じ回数でロックになる（実在のアカウントと見分けられない）', async () => {
    const want = [4, 3, 2, 1, 'locked', 'locked'];
    expect(await outcomes('kinjo@hoiku.example.jp')).toEqual(want);
    expect(await outcomes('nobody@hoiku.example.jp')).toEqual(want);
  });
});
