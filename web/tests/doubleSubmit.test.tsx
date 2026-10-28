// @vitest-environment jsdom
/*
 * 二重送信の防止：チャットの送信・目的別グループの作成・招待コードの1枚発行（GitHub Issue #303）
 * 典拠：授業の雛形「テスト仕様書 兼 成績書」1.5（二重送信の防止）、
 *      詳細設計書「押したときの処理の型」(2-0 (2))「押したボタンを aria-busy にして二度押しを止め」
 *
 * 応答を止めておき、その間に続けて押す。サーバ（ここではモック）へ届くのは1回だけで、
 * 押したボタンは押せず aria-busy になり、応答のあとは戻ることを見る。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = { ...teacher, account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', staff_id: 'S001', class_id: null, class_name: null, display_name: '西田 拓也' };
/** 西田 太郎（C001）の父 */
const guardian: SessionUser = {
  account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
/** 西田 太郎の保護者との個人チャット */
const personalRoom = 6;

function open(path: string, user: SessionUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

/** 呼ばれても release() するまで応答を返さない。返すときは本来の処理（モック）に任せる */
function hold<K extends 'send' | 'createGroup' | 'issueOneInvitationCode'>(name: K) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const original = api[name].bind(api) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(api, name).mockImplementation((async (...args: unknown[]) => {
    await gate;
    return original(...args);
  }) as never);
  return { spy, release };
}

/** 続けて押す。2回目は1回目の描き直しを待たずに届く */
function pressTwice(button: HTMLElement) {
  fireEvent.click(button);
  fireEvent.click(button);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('二重送信の防止（Issue #303）', () => {
  it('職員のチャット：送っている間は「送信」を押せず、続けて押しても1回だけ送る', async () => {
    const { spy, release } = hold('send');
    open(`/staff/chat?room=${personalRoom}`, teacher);
    await waitFor(() => expect(document.querySelector('.channel.current')).toBeTruthy(), { timeout: 3000 });
    fireEvent.change(screen.getByPlaceholderText('メッセージを入力'), { target: { value: '二重送信 職員' } });
    const button = screen.getByRole('button', { name: '送信' }) as HTMLButtonElement;
    pressTwice(button);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    release();
    await screen.findByText('二重送信 職員', { selector: '.bubble' }, { timeout: 3000 });
    expect(spy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'));
  });

  it('保護者のチャット：送っている間は「送信」を押せず、続けて押しても1回だけ送る', async () => {
    const { spy, release } = hold('send');
    open('/guardian/chat', guardian);
    fireEvent.click(await screen.findByText('担任の先生とのやりとり', undefined, { timeout: 3000 }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'メッセージを入力' }, { timeout: 3000 }), { target: { value: '二重送信 保護者' } });
    const button = screen.getByRole('button', { name: '送信' }) as HTMLButtonElement;
    pressTwice(button);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    release();
    await screen.findByText('二重送信 保護者', { selector: '.bubble' }, { timeout: 3000 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('目的別グループ：作っている間は「作る」を押せず、続けて押しても1つだけ作る', async () => {
    const { spy, release } = hold('createGroup');
    open('/staff/chat/groups', teacher);
    fireEvent.click(await screen.findByRole('button', { name: /グループを作る/ }, { timeout: 3000 }));
    const dialog = screen.getByRole('dialog', { name: 'グループを作る' });
    fireEvent.change(within(dialog).getByPlaceholderText('運動会実行委員'), { target: { value: '二重送信 グループ' } });
    const button = within(dialog).getByRole('button', { name: '作る' }) as HTMLButtonElement;
    pressTwice(button);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    release();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'グループを作る' })).toBeNull(), { timeout: 3000 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('招待コードの1枚発行：発行している間は「発行する」を押せず、続けて押しても1枚だけ出す', async () => {
    const { spy, release } = hold('issueOneInvitationCode');
    open('/staff/admin/invitations', admin);
    fireEvent.click(await screen.findByRole('button', { name: '1枚発行' }, { timeout: 3000 }));
    const dialog = screen.getByRole('dialog', { name: /招待コードの発行/ });
    const child = within(dialog).getByRole('combobox', { name: /園児/ }) as HTMLSelectElement;
    await waitFor(() => expect(child.options.length).toBeGreaterThan(1), { timeout: 3000 });
    fireEvent.change(child, { target: { value: child.options[1].value } });
    const button = within(dialog).getByRole('button', { name: '発行する' }) as HTMLButtonElement;
    pressTwice(button);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    release();
    await screen.findByText(/の招待コードを1枚発行しました/, undefined, { timeout: 3000 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
