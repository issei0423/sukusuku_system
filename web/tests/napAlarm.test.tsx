// @vitest-environment jsdom
/*
 * 午睡チェック画面：確認の時刻を過ぎたら通知音を鳴らし、過ぎた行の色をその時刻で変える（GitHub Issue #298）
 * 典拠：基本設計書「午睡チェックの実施」(4-8) の処理 4、要件定義書「通知音を伴う例外」・「タイマー・アラームの実現方式と運用前提」、
 *   図/画面詳細図「午睡チェック画面」(5-1) の項目3（時刻になったら通知音を伴って知らせる）・項目7（過ぎた園児は行を警告色にする）・項目20
 *
 * 相手はモック（api/mock.ts）。音は Web Audio の偽物に差し替え、鳴らした音の数を数える。
 * 通知音と行の色は画面の規則で、Go サーバの規則ではない（サーバ側に対応する規則は無い）。
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import { today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = { ...teacher, account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', staff_id: 'S001', class_id: null, class_name: null, display_name: '西田 拓也' };

/** Web Audio の偽物。start された音（OscillatorNode）の数と、止められたままか（ブラウザが操作を待っている）を持つ */
const audio = { started: 0, allow: true, ctx: null as null | { state: string; onstatechange: (() => void) | null } };

class FakeAudioContext {
  state = 'suspended';
  currentTime = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  constructor() { audio.ctx = this; }
  resume() {
    if (audio.allow) { this.state = 'running'; this.onstatechange?.(); }
    return Promise.resolve();
  }
  createGain() {
    const param = { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, value: 0 };
    return { gain: param, connect: (next: unknown) => next };
  }
  createOscillator() {
    return {
      type: '', frequency: { value: 0 },
      connect: (next: unknown) => next,
      start: () => { audio.started += 1; },
      stop: () => undefined,
    };
  }
}

beforeAll(() => {
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

function open(path: string, user: SessionUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const startedAt = Date.now();
afterEach(() => {
  cleanup();
  vi.setSystemTime(startedAt);
});

/** デモの実施（13:00 開始）は 18:00 には自動で終わっている。新しく始める */
async function startNap() {
  const active = await api.activeSession(1, today(), admin);
  if (active) await api.endSession(admin, active.nap_session_id);
  return api.startSession(teacher, 1, today());
}

/** 1回の知らせで鳴らす音の数（napSound.ts の BEEPS） */
const ONE_ALARM = 3;
const rowOf = (name: string) => screen.findByRole('region', { name: `${name}の午睡チェック` }, { timeout: 3000 });

describe('午睡チェック画面：確認の時刻の通知音と、過ぎた行の色（Issue #298）', () => {
  it('確認の時刻になるまでは鳴らさず、行も警告色にしない。時刻を過ぎたら、その時刻に1回鳴らし、行を警告色にする', async () => {
    audio.allow = true;
    const session = await startNap();
    open('/staff/nap', teacher);
    const row = await rowOf('西田 太郎');
    const before = audio.started;
    // 記録の無い行でも、時刻の前は警告色にしない。文では「未記録」とだけ伝える
    expect(row.className).not.toContain('is-due');
    expect(within(row).getByText('未記録')).toBeTruthy();

    // 間隔の手前では鳴らない
    vi.setSystemTime(Date.now() + (api.intervalMinutesFor(1) - 1) * 60_000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(audio.started).toBe(before);
    expect(row.className).not.toContain('is-due');

    // 確認の時刻を過ぎる（画面の時計は1秒ごとに進む。60秒の読み直しを待たずに変わる）
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await waitFor(() => expect(row.className).toContain('is-due'), { timeout: 3000 });
    expect(within(row).getByText('未記録（チェック時刻を過ぎています）')).toBeTruthy();
    expect(audio.started).toBe(before + ONE_ALARM);

    // 過ぎたままの間は、鳴らし直さない（読み上げと同じく、増えたときだけ）
    await new Promise((r) => setTimeout(r, 2500));
    expect(audio.started).toBe(before + ONE_ALARM);

    // 記録して数が減っても鳴らさない。記録した行は警告色から戻る
    await api.record(teacher, session.nap_session_id, { child_id: 'C001', body_position: '1', breathing: '1', complexion: '1', temperature: null });
    await waitFor(() => expect(row.className).not.toContain('is-due'), { timeout: 3000 });
    expect(audio.started).toBe(before + ONE_ALARM);
  });

  it('画面を開いたとき、すでに時刻を過ぎている子がいても、開いたことでは鳴らさない（読み上げと同じ起点）', async () => {
    audio.allow = true;
    await startNap();
    vi.setSystemTime(Date.now() + (api.intervalMinutesFor(1) + 1) * 60_000);
    const before = audio.started;
    open('/staff/nap', teacher);
    const row = await rowOf('西田 太郎');
    await waitFor(() => expect(row.className).toContain('is-due'), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(audio.started).toBe(before);
  });

  it('音を出せる状態でないあいだは、タイマーの欄で触るよう文で伝え、触れて出せるようになったら消す', async () => {
    audio.allow = false;
    if (audio.ctx) audio.ctx.state = 'suspended';
    await startNap();
    open('/staff/nap', teacher);
    await rowOf('西田 太郎');
    const timer = () => document.querySelector('.nap-timer')!;
    await waitFor(() => expect(timer().textContent).toContain('通知音が出る状態になっていません。画面を一度さわってください。'), { timeout: 3000 });

    // 止められたままでは鳴らせない（鳴らせたふりをしない）。触れたあとは出せる
    audio.allow = true;
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(timer().textContent).not.toContain('通知音が出る状態になっていません'), { timeout: 3000 });
  });

  it('時刻を過ぎたことを伝える読み上げは今までどおり1回で、行の状態の文は読み上げへ入れない', async () => {
    audio.allow = true;
    await startNap();
    open('/staff/nap', teacher);
    const row = await rowOf('西田 太郎');
    vi.setSystemTime(Date.now() + (api.intervalMinutesFor(1) + 1) * 60_000);
    await waitFor(() => expect(row.className).toContain('is-due'), { timeout: 3000 });
    const said = [...document.querySelectorAll('.nap-grid [role="status"], .nap-grid [aria-live]')]
      .map((el) => el.textContent ?? '').filter((t) => t !== '');
    expect(said).toEqual([]);
    expect(document.querySelectorAll('.nap-timer [role="status"]')).toHaveLength(1);
  });
});
