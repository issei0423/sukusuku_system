// @vitest-environment jsdom
/*
 * 異常時記録画面：記録の行の「この園児の連絡帳」「この園児の個人チャット」（受け入れテスト 04-034）
 * 典拠：図/画面詳細図「異常時記録画面」(5-2) 項目15「連絡帳（園児）画面 (8-2) のその園児・その日へ遷移する」・
 *      項目16「チャット画面（職員） (4-1) を、その園児の個人チャットを開いた状態で表示する」、基本設計書「異常時の記録」(4-8)
 *
 * 個人チャットは、部屋の応答の child_id（server/api_chat.go の ChatRoom.ChildID、server/api_child_room_test.go）で園児から引く。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
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

function open(path: string, user: SessionUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

/** 記録の一覧の行のうち、園児名を含む行 */
async function listRow(childName: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('table.list tbody tr')).toBeTruthy(), { timeout: 3000 });
  const table = document.querySelector('table.list') as HTMLElement;
  const row = within(table).getAllByRole('row').find((tr) => tr.textContent?.includes(childName));
  if (!row) throw new Error(`${childName} の行がありません`);
  return row;
}

afterEach(() => cleanup());

describe('異常時記録画面の行から、この園児の連絡帳・個人チャットへ', () => {
  it('行ごとに「この園児の連絡帳」（発見した日のページ）と「この園児の個人チャット」を置く。読み上げでは園児名を添える', async () => {
    open('/staff/nap/abnormal', teacher);
    const a = db.napAbnormals[0];
    const name = db.children.find((c) => c.child_id === a.child_id)!.child_name;
    const row = await listRow(name);
    const contact = within(row).getByRole('link', { name: `この園児の連絡帳（${name}）` });
    expect(contact.textContent).toBe('この園児の連絡帳');
    // デモの記録は前の日なので、その日のページを開く
    expect(contact.getAttribute('href')).toBe(`/staff/contact/${a.child_id}?date=${a.found_at.slice(0, 10)}`);
    const chat = within(row).getByRole('link', { name: `この園児の個人チャット（${name}）` });
    expect(chat.textContent).toBe('この園児の個人チャット');
    expect(chat.getAttribute('href')).toBe(`/staff/chat?child=${a.child_id}`);
  });

  it('「この園児の個人チャット」は、その園児の個人チャットを開いた状態でチャット画面を出す', async () => {
    // 村田 美咲（C004）の個人チャットは部屋 8
    open('/staff/chat?child=C004', teacher);
    await waitFor(() => expect(document.querySelector('.channel.current')?.textContent).toContain('村田 美咲の園とのやりとり'), { timeout: 3000 });
    cleanup();
    // 部屋の番号の指定（?room=）は今までどおり
    open('/staff/chat?room=6', teacher);
    await waitFor(() => expect(document.querySelector('.channel.current')?.textContent).toContain('西田 太郎の園とのやりとり'), { timeout: 3000 });
  });

  it('その園児の個人チャットが一覧に無いときは、別のチャンネルを黙って開かず、その旨を出す（ほかの家庭へ書き込まないように）', async () => {
    // C999 の園児はいない（部屋も無い）
    open('/staff/chat?child=C999', teacher);
    await waitFor(() => expect(screen.getByText(/この園児の個人チャットは、チャンネルの一覧にありません。/)).toBeTruthy(), { timeout: 3000 });
    expect(document.querySelector('.channel')).toBeTruthy();
    expect(document.querySelector('.channel.current')).toBeNull();
    expect(screen.getByRole('heading', { name: 'チャンネルを選んでください' })).toBeTruthy();
  });

  it('「この園児の連絡帳」を押すと、連絡帳（園児）画面でその園児のページを開く', async () => {
    open('/staff/nap/abnormal', teacher);
    const a = db.napAbnormals[0];
    const name = db.children.find((c) => c.child_id === a.child_id)!.child_name;
    const row = await listRow(name);
    fireEvent.click(within(row).getByRole('link', { name: `この園児の連絡帳（${name}）` }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(name), { timeout: 3000 });
  });
});
