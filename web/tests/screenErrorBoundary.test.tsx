// @vitest-environment jsdom
/*
 * 画面の描画で例外が起きても、画面全体を真っ白にしない
 *
 * 画面だけを新しくして Go サーバを古いまま動かすと、午睡チェックの園児の行に「ねた・おきた」（sleeps）と
 * 「きょうは対象外」（exclusion）が無く、午睡チェック画面を開いたところで例外になり、画面全体が真っ白になっていた。
 * 共通レイアウトの受け皿（ScreenErrorBoundary）が本文だけを知らせに差し替え、メニューから別の画面へ移れることを確かめる。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

const FAILED_TEXT = '画面を表示できませんでした。';

// 午睡の時間帯（13:00-15:00）の中に時計を固定する。デモの実施が自動で解除されないようにするため（napWarnings.test.tsx と同じ）
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${today()}T13:30:00+09:00`));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('画面の描画に失敗したときの受け皿', () => {
  it('古いサーバの午睡チェックの応答で例外になっても、メニューを残して知らせを出し、別の画面へ移れる', async () => {
    const classState = api.classState.bind(api);
    // 古い Go サーバの応答の形（園児の行に sleeps・exclusion が無い）
    vi.spyOn(api, 'classState').mockImplementation(async (...args: Parameters<typeof api.classState>) =>
      (await classState(...args)).map(({ sleeps: _s, exclusion: _e, ...rest }) => rest as typeof rest & { sleeps: never; exclusion: never }));
    // React と受け皿が開発者ツールへ書く例外の出力は、テストの出力から外す
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <MemoryRouter initialEntries={['/staff/nap']}>
        <SessionProvider initialUser={teacher}>
          <App />
        </SessionProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(FAILED_TEXT, { exact: false }, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: '読み込み直す' })).toBeTruthy();

    // メニューは残っており、別の画面へ移ると受け皿が作り直されて普通に出る
    fireEvent.click(screen.getByRole('link', { name: 'ダッシュボード' }));
    expect(await screen.findByText('午睡チェックが実施中です', { exact: false }, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText(FAILED_TEXT, { exact: false })).toBeNull();
  });
});
