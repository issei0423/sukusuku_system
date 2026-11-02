// @vitest-environment jsdom
/*
 * 午睡チェックの開始の二重押し（受け入れテスト 04-037 の (b)）
 * 典拠：授業の雛形「テスト仕様書 兼 成績書」1.5（二重送信の防止）、詳細設計書「押したときの処理の型」(2-0 (2))
 *      「押したボタンを aria-busy にして二度押しを止め」
 *
 * 送っている間は「午睡チェックを開始する」を押せず、続けて押しても1回だけ送る。同じクラス・同じ日の実施中は1つで、
 * 続けて開始しても同じ実施を返す（モック）。Go の同じ観点は server/api_nap_test.go の TestStartNapSessionTwiceAtOnce
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

// 午睡の時間帯（13:00-15:00）の中に時計を固定する（napWarnings.test.tsx と同じ）
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${today()}T13:30:00+09:00`));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** さくら組のその日の実施中を終えておく */
async function endRunning() {
  const s = await api.activeSession(1, today(), admin);
  if (s) await api.endSession(admin, s.nap_session_id);
}

const openOf = (classId: number) => db.napSessions.filter((s) => s.class_id === classId && s.session_date === today() && s.ended_at === null);

describe('午睡チェックの開始の二重押し（04-037）', () => {
  it('送っている間は「午睡チェックを開始する」を押せず、続けて押しても1回だけ送る', async () => {
    await endRunning();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const original = api.startSession.bind(api);
    const spy = vi.spyOn(api, 'startSession').mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    render(
      <MemoryRouter initialEntries={['/staff/nap']}>
        <SessionProvider initialUser={teacher}>
          <App />
        </SessionProvider>
      </MemoryRouter>,
    );
    const button = await screen.findByRole('button', { name: '午睡チェックを開始する' }, { timeout: 3000 }) as HTMLButtonElement;
    // 2回目は1回目の描き直しを待たずに届く
    fireEvent.click(button);
    fireEvent.click(button);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    release();
    await screen.findByRole('button', { name: '午睡チェックを終了' }, { timeout: 3000 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(openOf(1)).toHaveLength(1);
    await api.endSession(teacher, openOf(1)[0].nap_session_id);
  });

  it('同じクラス・同じ日に続けて開始しても、実施中は1つで、同じ実施を返す（モック）', async () => {
    await endRunning();
    const [a, b] = await Promise.all([api.startSession(teacher, 1, today()), api.startSession(admin, 1, today())]);
    expect(a.nap_session_id).toBe(b.nap_session_id);
    expect(openOf(1)).toHaveLength(1);
    await api.endSession(teacher, a.nap_session_id);
  });
});
