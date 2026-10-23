// @vitest-environment jsdom
/*
 * ログアウトの契約
 *
 * ログアウトは、サーバ側のセッションの破棄を待ってから完了しなければならない。
 * 待たずに画面を遷移すると、全画面の読み込みで通信が打ち切られ、
 * サーバ側のセッションが生き残る。その状態で再読み込みすると、
 * 前の利用者としてログインし直ってしまう。
 * 共有端末では担当の取り違えになる（基本設計書「画面基本構成」(3-5)）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { SessionProvider, useSession } from '../src/session';
import * as client from '../src/api/client';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

afterEach(cleanup);

describe('ログアウト', () => {
  it('サーバ側の破棄を待ってから完了する', async () => {
    let resolveLogout: () => void = () => {};
    const pending = new Promise<void>((r) => { resolveLogout = r; });
    const spy = vi.spyOn(client.api, 'logout').mockReturnValue(pending);

    let session: ReturnType<typeof useSession> | null = null;
    function Probe() {
      session = useSession();
      return <div>{session.user ? session.user.display_name : '未ログイン'}</div>;
    }

    const { container } = render(
      <SessionProvider initialUser={teacher}><Probe /></SessionProvider>,
    );
    expect(container.textContent).toBe('鈴木 浩之');

    let done = false;
    await act(async () => {
      void session!.logout().then(() => { done = true; });
    });

    // サーバ側の破棄が終わるまで完了しない
    expect(spy).toHaveBeenCalled();
    expect(done).toBe(false);

    await act(async () => { resolveLogout(); await pending; });
    expect(done).toBe(true);
    expect(container.textContent).toBe('未ログイン');

    spy.mockRestore();
  });

  it('サーバ側の破棄が失敗しても、画面側は必ずログアウトする', async () => {
    const spy = vi.spyOn(client.api, 'logout').mockRejectedValue(new Error('通信に失敗しました'));

    let session: ReturnType<typeof useSession> | null = null;
    function Probe() {
      session = useSession();
      return <div>{session.user ? session.user.display_name : '未ログイン'}</div>;
    }
    const { container } = render(
      <SessionProvider initialUser={teacher}><Probe /></SessionProvider>,
    );

    await act(async () => {
      await expect(session!.logout()).rejects.toThrow('通信に失敗しました');
    });
    // 通信が失敗しても、端末に前の利用者を残さない
    expect(container.textContent).toBe('未ログイン');

    spy.mockRestore();
  });
});
