// @vitest-environment jsdom
/*
 * デモの隠しログイン（src/screens/auth/QuickLogin.tsx）
 * ログイン画面の左上 → 右上の順に押すと、入口に合わせた西田 拓也でログインする。
 * TopScreen はデモ用のビルド（VITE_DEMO_QUICK_LOGIN=1）でだけ描く。ここでは部品を直に描いて確かめる
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import QuickLogin, { QUICK_LOGIN_WINDOW_MS } from '../src/screens/auth/QuickLogin';
import { QUICK_LOGIN_ACCOUNTS } from '../src/screens/auth/quickLoginAccounts';
import { accounts, staff, guardians } from '../src/api/mockDb';

afterEach(() => cleanup());

function open(entrance: 'staff' | 'guardian') {
  const onLogin = vi.fn();
  render(<QuickLogin entrance={entrance} onLogin={onLogin} />);
  return {
    onLogin,
    first: () => fireEvent.click(screen.getByTestId('quick-login-1')),
    second: () => fireEvent.click(screen.getByTestId('quick-login-2')),
  };
}

describe('デモの隠しログイン', () => {
  it('職員の入口で左上 → 右上の順に押すと、職員の西田 拓也で入る', () => {
    const t = open('staff');
    t.first(); t.second();
    expect(t.onLogin).toHaveBeenCalledWith(QUICK_LOGIN_ACCOUNTS.staff.email, QUICK_LOGIN_ACCOUNTS.staff.password);
  });

  it('保護者の入口では、保護者の西田 拓也で入る', () => {
    const t = open('guardian');
    t.first(); t.second();
    expect(t.onLogin).toHaveBeenCalledWith(QUICK_LOGIN_ACCOUNTS.guardian.email, QUICK_LOGIN_ACCOUNTS.guardian.password);
  });

  it('右上だけ・右上 → 左上の順では入らない。右上を押したら、はじめからやり直し', () => {
    const t = open('staff');
    t.second();
    t.second(); t.first();
    expect(t.onLogin).not.toHaveBeenCalled();
    t.second();
    expect(t.onLogin).toHaveBeenCalledTimes(1);
    t.second();
    expect(t.onLogin).toHaveBeenCalledTimes(1);
  });

  it('左上から右上まで間があきすぎると入らない', () => {
    const t = open('staff');
    t.first();
    vi.advanceTimersByTime(QUICK_LOGIN_WINDOW_MS + 1);
    t.second();
    expect(t.onLogin).not.toHaveBeenCalled();
  });

  it('押し場所は読み上げの対象にしない', () => {
    open('staff');
    expect(screen.getByTestId('quick-login-1').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('quick-login-2').getAttribute('aria-hidden')).toBe('true');
  });

  it('入るアカウントは、デモデータの西田 拓也（職員は管理者、保護者は西田 太郎の保護者）', () => {
    const acc = (email: string) => accounts.find((a) => a.email === email);
    const s = acc(QUICK_LOGIN_ACCOUNTS.staff.email);
    const g = acc(QUICK_LOGIN_ACCOUNTS.guardian.email);
    expect(s?.password_hash).toBe(QUICK_LOGIN_ACCOUNTS.staff.password);
    expect(g?.password_hash).toBe(QUICK_LOGIN_ACCOUNTS.guardian.password);
    expect(staff.find((x) => x.account_id === s?.account_id)?.staff_name).toBe('西田 拓也');
    expect(guardians.find((x) => x.account_id === g?.account_id)?.guardian_name).toBe('西田 拓也');
  });
});
