// @vitest-environment jsdom
/*
 * 職員用トップ・保護者用トップの「演習用：デモアカウント」
 * 手元の開発サーバでだけ出す（src/screens/auth/DemoAccounts.tsx）。本番のビルドに入らないことは
 * build/keepMockOutOfBuild.ts の見張りが確かめる。vitest は import.meta.env.DEV が真なので、欄が出る
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TopScreen from '../src/screens/auth/TopScreen';
import { SessionProvider } from '../src/session';

afterEach(() => cleanup());

function open(entrance: 'staff' | 'guardian') {
  render(
    <MemoryRouter>
      <SessionProvider>
        <TopScreen entrance={entrance} />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const loginIdInput = () => screen.getByLabelText(/ログインID/) as HTMLInputElement;
const passwordInput = () => screen.getByLabelText(/パスワード/) as HTMLInputElement;

describe('演習用：デモアカウント', () => {
  it('職員用トップの下に職員のアカウントが並び、押すとログインIDとパスワードが入る', async () => {
    open('staff');
    await waitFor(() => expect(screen.getByText('演習用：デモアカウント')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /西田 太郎の保護者/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '西田 拓也（管理者・園長）' }));
    expect(loginIdInput().value).toBe('nishida@hoiku.example.jp');
    expect(passwordInput().value).toBe('pass1234');

    // 一時パスワード中のアカウントだけ、パスワードが違う
    fireEvent.click(screen.getByRole('button', { name: '村田 真一（一時パスワード中）' }));
    expect(loginIdInput().value).toBe('murata@hoiku.example.jp');
    expect(passwordInput().value).toBe('temp0901');
  });

  it('保護者用トップには保護者のアカウントだけが並ぶ', async () => {
    open('guardian');
    await waitFor(() => expect(screen.getByText('演習用：デモアカウント')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /管理者・園長/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '西田 拓也（西田 太郎の保護者）' }));
    expect(loginIdInput().value).toBe('nishida.t@example.jp');
    expect(passwordInput().value).toBe('pass1234');
  });
});
