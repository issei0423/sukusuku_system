// @vitest-environment jsdom
/*
 * 裏の読み直しの印（GitHub Issue #210）
 * 典拠：基本設計書.md「ログイン」(4-3)「自動ログアウトは職員の画面に限る。最後の操作から時間を数える」
 *
 * 職員の自動ログアウトは、最後の操作から数える。開いたままの画面が裏で読み直す要求は操作ではないので、
 * 画面は印の見出しを付けて送り、サーバ（server/session.go の countsAsOperation）は期限を延ばさない。
 * 期限の判定そのものはサーバにだけある（モックにはセッションの期限が無い）。サーバ側は
 * server/api_session_idle_test.go で確かめる。ここでは、画面が印を付ける範囲を確かめる。
 *
 *   - useAsync の最初の読み込み（画面を開いた・条件を変えた）は操作。印を付けない
 *   - 間隔の読み直し、タブを前に戻したときの読み直しは、印を付ける
 *   - api/http.ts は、印の中で始めた要求にだけ見出しを付ける
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { useAsync, AUTO_REFRESH_MS } from '../src/hooks';
import { asAutomatic, isAutomatic, AUTO_REFRESH_HEADER } from '../src/api/automatic';
import { api } from '../src/api/http';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

describe('useAsync が印を付ける範囲', () => {
  let hidden = false;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  /** 読み込みの関数が呼ばれたときに、印の中だったかを順に残す */
  function Probe({ calls }: { calls: boolean[] }) {
    const { data } = useAsync(async () => {
      calls.push(isAutomatic());
      return `読んだ回数 ${calls.length}`;
    }, [], { refreshMs: AUTO_REFRESH_MS });
    return <div data-testid="probe">{data}</div>;
  }

  it('最初の読み込みには付けず、間隔の読み直しとタブを戻したときの読み直しに付ける', async () => {
    const calls: boolean[] = [];
    render(<Probe calls={calls} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('読んだ回数 1'));

    await act(async () => { vi.advanceTimersByTime(AUTO_REFRESH_MS); });
    await waitFor(() => expect(calls).toHaveLength(2));

    act(() => {
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(calls).toHaveLength(3));

    expect(calls).toEqual([false, true, true]);
  });
});

describe('api/http.ts が付ける見出し', () => {
  const real = globalThis.fetch;
  let sent: Headers[] = [];
  beforeEach(() => {
    sent = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return new Response('[]', { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = real; });

  it('印の中で始めた要求にだけ付ける。印の外の要求（利用者の操作）には付けない', async () => {
    await asAutomatic(() => api.rooms(teacher));
    await api.rooms(teacher);
    await asAutomatic(() => api.markRead(teacher, 6));

    expect(sent).toHaveLength(3);
    expect(sent[0].get(AUTO_REFRESH_HEADER)).toBe('1');
    expect(sent[1].get(AUTO_REFRESH_HEADER)).toBeNull();
    // 本文のある要求でも、本文の形の見出しと並べて付ける
    expect(sent[2].get(AUTO_REFRESH_HEADER)).toBe('1');
    expect(sent[2].get('Content-Type')).toBe('application/json');
  });

  it('印の外へ出たら、次の要求には付けない（読み直しの関数が失敗しても戻る）', async () => {
    expect(() => asAutomatic(() => { throw new Error('読み直しに失敗'); })).toThrow('読み直しに失敗');
    expect(isAutomatic()).toBe(false);
    await api.rooms(teacher);
    expect(sent[0].get(AUTO_REFRESH_HEADER)).toBeNull();
  });
});
