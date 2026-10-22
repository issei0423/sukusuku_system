// @vitest-environment jsdom
/*
 * 午睡チェック画面：「午睡チェックを終了」を押したあとに、フォーカスが body に落ちないこと
 * 典拠：WCAG 2.4.3 フォーカス順序、GitHub Issue #213。共通の決まりは src/focusAfter.ts
 *
 * 終了すると読み直しで「午睡チェックを終了」が消え、代わりに「午睡チェックを開始する」が出る。そこへ移す。
 * 確認の窓から終了したとき（記録していない園児がいる）と、窓を出さずに終了したとき（全員の記録が済んでいる）の両方を見る。
 *
 * 時計は日本時間の今日の 13:30 に置く（tests/screens.test.tsx と同じ。デモの午睡は 13:00 開始）。
 * 18:00 のまま職員の画面を開くと、午睡の時間帯を過ぎた実施が自動で終了するため、このファイルに分けている。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';
import { api } from '../src/api/client';
import { today } from '../src/api/util';
import { clearNotice } from '../src/components/feedback';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
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

/** キーボードで押したときと同じく、フォーカスを入れてから押す（jsdom はクリックでフォーカスを移さない） */
function press(el: HTMLElement) {
  act(() => el.focus());
  fireEvent.click(el);
}

beforeEach(() => {
  vi.setSystemTime(new Date(`${today()}T13:30:00+09:00`));
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => clearNotice());
  cleanup();
  document.body.innerHTML = '';
});

describe('午睡チェックを終了したあとのフォーカス（GitHub Issue #213）', () => {
  it('確認の窓から終了したら、代わりに出る「午睡チェックを開始する」へ移す', async () => {
    open('/staff/nap', teacher);
    const end = await screen.findByRole('button', { name: '午睡チェックを終了' }, { timeout: 3000 });
    // 記録していない園児がいる（デモデータ）ので、確かめの窓が開く
    press(end);
    const dialog = await screen.findByRole('dialog', undefined, { timeout: 3000 });
    press(within(dialog).getByRole('button', { name: 'このまま終了する' }));
    const start = await screen.findByRole('button', { name: '午睡チェックを開始する' }, { timeout: 3000 });
    expect(end.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(start));
  });

  it('窓を出さずに終了したとき（全員の記録が済んでいる）も、「午睡チェックを開始する」へ移す', async () => {
    // 記録の残りが無い形にする（園児の行を空にする）。終了の前の確かめの窓は出ない
    vi.spyOn(api, 'classState').mockResolvedValue([]);
    open('/staff/nap', teacher);
    const startFirst = await screen.findByRole('button', { name: '午睡チェックを開始する' }, { timeout: 3000 });
    fireEvent.click(startFirst);
    const end = await screen.findByRole('button', { name: '午睡チェックを終了' }, { timeout: 3000 });
    press(end);
    expect(screen.queryByRole('dialog')).toBeNull();
    const start = await screen.findByRole('button', { name: '午睡チェックを開始する' }, { timeout: 3000 });
    expect(end.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(start));
  });
});
