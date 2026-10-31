// @vitest-environment jsdom
/*
 * 午睡チェック画面のクラス全体の状況と園児の行（受け入れテスト 04-013・04-018）
 * 典拠：図/画面詳細図「午睡チェック画面」(5-1) 項目5、詳細設計書「午睡の園児」(3-4)
 *
 * クラス全体の状況には、ねた・おきた・対象外（理由ごと）の人数と、記録済み人数／対象人数を出す。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
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

// 午睡の時間帯（13:00-15:00）の中に時計を固定する。実施が自動で解除されないようにするため（napWarnings.test.tsx と同じ）
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${today()}T13:30:00+09:00`));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

/** さくら組のその日の実施を新しく始める（デモの実施中の午睡は、終えてから始める） */
async function freshSession(): Promise<number> {
  const s = await api.activeSession(1, today(), admin);
  if (s) await api.endSession(admin, s.nap_session_id);
  return (await api.startSession(teacher, 1, today())).nap_session_id;
}

function renderNap() {
  render(
    <MemoryRouter initialEntries={['/staff/nap']}>
      <SessionProvider initialUser={teacher}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const head = () => document.querySelector<HTMLElement>('.nap-page-head')!;

describe('午睡チェック画面：クラス全体の状況（画面詳細図 5-1 項目5）', () => {
  it('ねた・おきた・対象外（理由ごと）の人数と、記録済み人数／対象人数を出す', async () => {
    const sessionId = await freshSession();
    const enrolled = (await api.classState(teacher, 1, sessionId)).length;
    await api.sleep(teacher, sessionId, 'C001');
    const second = await api.sleep(teacher, sessionId, 'C002');
    await api.wake(teacher, second.nap_sleep_id);
    await api.exclude(teacher, sessionId, 'C003', '1');
    await api.exclude(teacher, sessionId, 'C004', '2');

    renderNap();
    await waitFor(() => expect(head().textContent).toContain('ねた 1 名'), { timeout: 3000 });
    const text = head().textContent!;
    expect(text).toContain('おきた 1 名');
    expect(text).toContain('対象外 2 名（欠席 1・午睡なし 1）');
    // 対象外の2人は対象人数から外す（詳細設計書「タイマー」(2-4 (3))）
    expect(text).toContain(`記録済み 0 / ${enrolled - 2} 名`);
    await api.endSession(teacher, sessionId);
  });

  it('対象外が無い理由は添えない。だれも寝ていなければ 0 名と出す', async () => {
    const sessionId = await freshSession();
    await api.exclude(teacher, sessionId, 'C003', '1');

    renderNap();
    await waitFor(() => expect(head().textContent).toContain('対象外 1 名（欠席 1）'), { timeout: 3000 });
    const text = head().textContent!;
    expect(text).not.toContain('午睡なし');
    expect(text).toContain('ねた 0 名');
    expect(text).toContain('おきた 0 名');
    await api.endSession(teacher, sessionId);
  });
});
