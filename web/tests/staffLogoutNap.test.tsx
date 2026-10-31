// @vitest-environment jsdom
/*
 * 職員のログアウト：午睡チェックの実施中（受け入れテスト 04-025）
 * 典拠：基本設計書「ログアウト」(4-3)「午睡チェックの実施中は、先に午睡チェックを終了してからログアウトする」、
 *      図/画面詳細図「全画面に共通する規定」(0-2) のログアウト・「職員（タブレット／PC）」(1-1) 項目4「示して止める」
 *
 * 自分が開始した午睡チェックが実施中なら、ログアウトせずに止め、先に終了するよう示す。実施中かは、自動ログアウトの
 * 対象外と同じ判定（sessionStatus の nap_exempt。担当は開始した職員）。保存していない入力の確かめは staffLogoutUnsaved.test.tsx。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

const admin: SessionUser = {
  account_id: 1, email: 'admin@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
// 同じさくら組のもう1人の担任（村田 真一）
const murata: SessionUser = { ...teacher, account_id: 4, email: 'murata@hoiku.example.jp', staff_id: 'S004', display_name: '村田 真一' };

// 午睡の時間帯（13:00-15:00）の中に時計を固定する。実施が自動で解除されないようにするため（napWarnings.test.tsx と同じ）
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${today()}T13:30:00+09:00`));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

/** さくら組のその日の実施を、who が新しく始める（デモの実施中の午睡は、終えてから始める） */
async function freshSession(who: SessionUser): Promise<number> {
  const s = await api.activeSession(1, today(), admin);
  if (s) await api.endSession(admin, s.nap_session_id);
  return (await api.startSession(who, 1, today())).nap_session_id;
}

function open(path: string, user: SessionUser) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const DIALOG = '午睡チェックの実施中です';
const logoutFromHeader = () => fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'ログアウト' }));

describe('職員のログアウト：午睡チェックの実施中（04-025）', () => {
  it('自分が開始した実施中は、ログアウトせずに止め、先に午睡チェックを終了するよう示す', async () => {
    const sessionId = await freshSession(teacher);
    open('/staff/nap', teacher);
    await screen.findByRole('button', { name: '午睡チェックを終了' }, { timeout: 3000 });
    logoutFromHeader();

    const dialog = await screen.findByRole('dialog', { name: DIALOG });
    expect(dialog.textContent).toContain('先に午睡チェックを終了してから、ログアウトしてください。');
    // 午睡チェック画面で押したときは、移る口を出さない（終了のボタンは後ろの画面にある）
    expect(within(dialog).queryByRole('button', { name: /午睡チェック画面へ/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: DIALOG })).toBeNull());
    // ログアウトしていない。実施中のまま
    expect(screen.queryByText('職員用の入口')).toBeNull();
    expect(screen.getByRole('button', { name: '午睡チェックを終了' })).toBeTruthy();
    expect((await api.activeSession(1, today(), teacher))?.nap_session_id).toBe(sessionId);

    // 終了したあとは、ログアウトできる
    await api.endSession(teacher, sessionId);
    logoutFromHeader();
    await screen.findByText('職員用の入口', {}, { timeout: 3000 });
  });

  it('午睡チェック画面の外で押したときは、午睡チェック画面へ移る口を添える', async () => {
    const sessionId = await freshSession(teacher);
    open('/staff', teacher);
    await screen.findByRole('navigation', { name: '職員メニュー' }, { timeout: 3000 });
    logoutFromHeader();
    const dialog = await screen.findByRole('dialog', { name: DIALOG });
    fireEvent.click(within(dialog).getByRole('button', { name: /午睡チェック画面へ/ }));
    await screen.findByRole('button', { name: '午睡チェックを終了' }, { timeout: 3000 });
    expect(screen.queryByRole('dialog', { name: DIALOG })).toBeNull();
    await api.endSession(teacher, sessionId);
  });

  it('同じクラスでも、ほかの職員が開始した実施ではログアウトを止めない（担当は開始した職員）', async () => {
    const sessionId = await freshSession(murata);
    open('/staff/nap', teacher);
    await screen.findByRole('button', { name: '午睡チェックを終了' }, { timeout: 3000 });
    logoutFromHeader();
    await screen.findByText('職員用の入口', {}, { timeout: 3000 });
    expect(screen.queryByRole('dialog', { name: DIALOG })).toBeNull();
    await api.endSession(murata, sessionId);
  });
});
