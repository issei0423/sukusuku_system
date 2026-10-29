// @vitest-environment jsdom
/*
 * 職員のログアウト：保存していない入力（GitHub Issue #304）
 * 典拠：図/画面詳細図「全画面に共通する規定」(0-2) のログアウト「保存していない入力があれば、破棄される旨を確認する」、
 *      基本設計書「ログアウト」(4-3)、要件定義書「アプリのログイン」(4-1-1)
 *
 * 保護者の側は guardianScreens.test.tsx（#170 の 5）。ここでは職員の共通レイアウトのログアウトと、
 * パスワード変更画面で変えたあとに入力が残らないこと（#304 の 2。職員・保護者とも）を見る。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
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

const accountOf = (id: number) => db.accounts.find((a) => a.account_id === id)!;
const savedPasswords = new Map([teacher, guardian].map((u) => [u.account_id, accountOf(u.account_id).password_hash]));

afterEach(() => {
  cleanup();
  // パスワードを変えたテストのあとも、ほかのテストがデモのパスワードで動くように戻す
  for (const [id, password] of savedPasswords) accountOf(id).password_hash = password;
});

const DIALOG = '保存していない入力があります';
const logoutFromHeader = () => fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'ログアウト' }));

async function openNewDiary() {
  open('/staff/diary/new', teacher);
  return await screen.findByRole('textbox', { name: /本文/ }, { timeout: 3000 }) as HTMLTextAreaElement;
}

describe('職員のログアウト：保存していない入力（#304 の 1）', () => {
  it('日誌に書きかけがあれば、破棄される旨を出して確かめる。やめれば入力は残る', async () => {
    const body = await openNewDiary();
    fireEvent.change(body, { target: { value: '砂場で山を作りました。' } });
    logoutFromHeader();

    const dialog = await screen.findByRole('dialog', { name: DIALOG });
    expect(dialog.textContent).toContain('破棄');
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: DIALOG })).toBeNull());
    expect((screen.getByRole('textbox', { name: /本文/ }) as HTMLTextAreaElement).value).toBe('砂場で山を作りました。');
    expect(screen.queryByText('職員用の入口')).toBeNull();
  });

  it('確かめたうえで「破棄してログアウトする」を押すと、ログアウトして職員用トップへ戻る', async () => {
    const body = await openNewDiary();
    fireEvent.change(body, { target: { value: '書きかけ' } });
    logoutFromHeader();
    const dialog = await screen.findByRole('dialog', { name: DIALOG });
    fireEvent.click(within(dialog).getByRole('button', { name: '破棄してログアウトする' }));
    await screen.findByText('職員用の入口', {}, { timeout: 3000 });
  });

  it('保存していない入力が無ければ、確かめずにログアウトする', async () => {
    await openNewDiary();
    logoutFromHeader();
    await screen.findByText('職員用の入口', {}, { timeout: 3000 });
    expect(screen.queryByRole('dialog', { name: DIALOG })).toBeNull();
  });

  it('チャットの書きかけがあれば、確かめる', async () => {
    open(`/staff/chat?room=${personalRoom}`, teacher);
    const input = await screen.findByPlaceholderText('メッセージを入力', undefined, { timeout: 3000 });
    fireEvent.change(input, { target: { value: 'お迎えの時間について' } });
    logoutFromHeader();
    await screen.findByRole('dialog', { name: DIALOG });
    expect(screen.queryByText('職員用の入口')).toBeNull();
  });

  it('パスワード変更画面に入れた値があれば、確かめる', async () => {
    open('/staff/password', teacher);
    fireEvent.change(await screen.findByLabelText('新しいパスワード', undefined, { timeout: 3000 }), { target: { value: 'suzuki-5678' } });
    logoutFromHeader();
    await screen.findByRole('dialog', { name: DIALOG });
  });
});

describe('パスワードを変えたあとは、欄を空にし、ログアウトで確かめない（#304 の 2）', () => {
  async function change(current: string, next: string) {
    fireEvent.change(await screen.findByLabelText('現在のパスワード', undefined, { timeout: 3000 }), { target: { value: current } });
    fireEvent.change(screen.getByLabelText('新しいパスワード'), { target: { value: next } });
    fireEvent.change(screen.getByLabelText('新しいパスワード（確認）'), { target: { value: next } });
    fireEvent.click(screen.getByRole('button', { name: '変更する' }));
    await screen.findByText('パスワードを変更しました。', undefined, { timeout: 3000 });
    for (const label of ['現在のパスワード', '新しいパスワード', '新しいパスワード（確認）']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
    }
  }

  it('職員', async () => {
    open('/staff/password', teacher);
    await change(accountOf(teacher.account_id).password_hash, 'suzuki-5678');
    logoutFromHeader();
    await screen.findByText('職員用の入口', {}, { timeout: 3000 });
    expect(screen.queryByRole('dialog', { name: DIALOG })).toBeNull();
  });

  it('保護者', async () => {
    open('/guardian/password', guardian);
    await change(accountOf(guardian.account_id).password_hash, 'nishida-5678');
    fireEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'メニュー' })).getByRole('button', { name: 'ログアウト' }));
    await screen.findByText('保護者用の入口', {}, { timeout: 3000 });
    expect(screen.queryByRole('dialog', { name: DIALOG })).toBeNull();
  });
});
