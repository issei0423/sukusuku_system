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
  it('一時パスワードは「temp」＋4桁でなく、紛らわしい文字を除いた英数字 12 文字', async () => {
    const temp = await api.reissueTempPassword(admin, 3);
    expect(temp).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{12}$/);
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
