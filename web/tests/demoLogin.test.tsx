// @vitest-environment jsdom
/*
 * 演習用：合言葉つきの URL での入口（src/screens/auth/DemoLoginScreen.tsx）
 * 【仮置き】設計書に定めが無い。合言葉の判定はサーバだけが行う（server/api_demo_login_test.go）。
 * ここでは画面の動きだけを確かめる。http の層（api/client.ts）は差し替え、実サーバにはつながない。
 * 合言葉はテスト用の値で、本物ではない
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SessionUser } from '../src/api/types';

const h = vi.hoisted(() => ({
  backend: 'http' as 'http' | 'mock',
  demoLogin: undefined as unknown as ReturnType<typeof import('vitest').vi.fn>,
}));
h.demoLogin = vi.fn();

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
    get backend() { return h.backend; },
    api: { ...actual.api, demoLogin: (...args: unknown[]) => h.demoLogin(...args) },
  };
});

import DemoLoginScreen from '../src/screens/auth/DemoLoginScreen';
import { SessionProvider } from '../src/session';

const KEY = 'test-demo-login-key-0123456789-abcdefghij';

function userOf(over: Partial<SessionUser>): SessionUser {
  return {
    account_id: 1, role: '1', is_temp_password: false, terms_agreed: true,
    ...over,
  } as SessionUser;
}

function open(search: string) {
  window.history.replaceState({ usr: 'keep' }, '', `/demo-login${search}`);
  return render(
    <MemoryRouter initialEntries={['/demo-login']}>
      <SessionProvider>
        <Routes>
          <Route path="/demo-login" element={<DemoLoginScreen />} />
          <Route path="/staff" element={<div>職員のホーム</div>} />
          <Route path="/guardian" element={<div>保護者のホーム</div>} />
          <Route path="/password-change" element={<div>パスワードの変更</div>} />
          <Route path="/terms-agree" element={<div>規約への同意</div>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  h.backend = 'http';
  h.demoLogin.mockReset();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('演習用：合言葉つきの URL での入口', () => {
  it('k を読んだらすぐ URL から消し、画面にも出さない（ほかのクエリと遷移の印は残す）', async () => {
    open(`?k=${KEY}&x=1`);
    await screen.findByRole('button', { name: /保育士として入る/ });
    expect(window.location.search).toBe('?x=1');
    expect(window.location.href).not.toContain(KEY);
    expect(window.history.state).toEqual({ usr: 'keep' });
    expect(document.body.textContent).not.toContain(KEY);
    expect(h.demoLogin).not.toHaveBeenCalled();
  });

  it('「保育士として入る」を押すと、合言葉と as=staff で api を呼び、職員のホームへ進む', async () => {
    h.demoLogin.mockResolvedValue(userOf({ role: '1' }));
    open(`?k=${KEY}`);
    fireEvent.click(await screen.findByRole('button', { name: /保育士として入る/ }));
    await waitFor(() => expect(screen.getByText('職員のホーム')).toBeTruthy());
    expect(h.demoLogin).toHaveBeenCalledTimes(1);
    expect(h.demoLogin).toHaveBeenCalledWith(KEY, 'staff');
  });

  it('「保護者として入る」を押すと、as=guardian で api を呼び、保護者のホームへ進む', async () => {
    h.demoLogin.mockResolvedValue(userOf({ role: '3', account_id: 6 }));
    open(`?k=${KEY}`);
    fireEvent.click(await screen.findByRole('button', { name: /保護者として入る/ }));
    await waitFor(() => expect(screen.getByText('保護者のホーム')).toBeTruthy());
    expect(h.demoLogin).toHaveBeenCalledWith(KEY, 'guardian');
  });

  it('一時パスワード中・規約の再同意が要るときは、通常のログインと同じ画面へ進む', async () => {
    h.demoLogin.mockResolvedValue(userOf({ is_temp_password: true }));
    open(`?k=${KEY}`);
    fireEvent.click(await screen.findByRole('button', { name: /保育士として入る/ }));
    await waitFor(() => expect(screen.getByText('パスワードの変更')).toBeTruthy());
    cleanup();

    h.demoLogin.mockResolvedValue(userOf({ terms_agreed: false }));
    open(`?k=${KEY}`);
    fireEvent.click(await screen.findByRole('button', { name: /保育士として入る/ }));
    await waitFor(() => expect(screen.getByText('規約への同意')).toBeTruthy());
  });

  it('api が失敗したら「このURLでは入れません」とだけ出し、ボタンを消す', async () => {
    h.demoLogin.mockRejectedValue(new Error('見つかりません'));
    open(`?k=${KEY}`);
    fireEvent.click(await screen.findByRole('button', { name: /保育士として入る/ }));
    await waitFor(() => expect(screen.getByText('このURLでは入れません')).toBeTruthy());
    expect(screen.queryByRole('button')).toBeNull();
    // サーバが返した文はそのまま見せない
    expect(document.body.textContent).not.toContain('見つかりません');
  });

  it('k が無い・空のときは、同じ文を出し、api を呼ばない', async () => {
    open('');
    await waitFor(() => expect(screen.getByText('このURLでは入れません')).toBeTruthy());
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();

    open('?k=');
    await waitFor(() => expect(screen.getByText('このURLでは入れません')).toBeTruthy());
    expect(window.location.search).toBe('');
    expect(h.demoLogin).not.toHaveBeenCalled();
  });

  it('モックでは「この環境では使えません」とだけ出し、api を呼ばない', async () => {
    h.backend = 'mock';
    open(`?k=${KEY}`);
    await waitFor(() => expect(screen.getByText('この環境では使えません')).toBeTruthy());
    expect(screen.queryByRole('button')).toBeNull();
    expect(h.demoLogin).not.toHaveBeenCalled();
  });
});
