// @vitest-environment jsdom
/*
 * 午睡チェック画面のクラス全体の状況と園児の行（受け入れテスト 04-013・04-018・04-001・04-021）
 * 典拠：図/画面詳細図「午睡チェック画面」(5-1) 項目5・7、詳細設計書「行の状態ごとの表示」(2-4 (2))・「午睡の園児」(3-4)
 *
 * クラス全体の状況には、ねた・おきた・対象外（理由ごと）の人数と、記録済み人数／対象人数を出す。
 * 実施の前も、終えたあとも、園児の行を1人1行で出す。押せるものは置かず、実施の後は最後に終えた実施の状態だけを出す。
 * 終えた実施を引く口（lastEndedSession。【仮置き】GET /api/nap/session の ended=1）の Go の同じ観点は
 * server/api_nap_test.go の TestLastEndedNapSession にある。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import type { SessionUser } from '../src/api/types';
import { addDays, today } from '../src/api/util';

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
const otherTeacher: SessionUser = { ...teacher, account_id: 5, staff_id: 'S005', class_id: 2, class_name: 'ひまわり組', display_name: '久保田 和也' };

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

function renderNap(who: SessionUser = teacher) {
  render(
    <MemoryRouter initialEntries={['/staff/nap']}>
      <SessionProvider initialUser={who}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const head = () => document.querySelector<HTMLElement>('.nap-page-head')!;
/** 園児の行（園児ごとの区画。名前は「（氏名）の午睡チェック」） */
const rowsOnScreen = () => Array.from(document.querySelectorAll<HTMLElement>('section[aria-label$="の午睡チェック"]'));
const rowOf = (name: string) => document.querySelector<HTMLElement>(`section[aria-label="${name}の午睡チェック"]`)!;
/** 行の記録の操作（ねた・おきた・もう一度ねた・対象外・戻す・直す・記録・体温）。実施の前と後の行には無い */
const rowButtons = (row: HTMLElement) => Array.from(row.querySelectorAll('button, input'));
const nameOf = async (childId: string) =>
  (await api.classState(teacher, 1, null)).find((r) => r.child.child_id === childId)!.child.child_name;

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

describe('午睡チェック画面：実施の前と実施の後の行（詳細設計書 (2-4 (2))）', () => {
  it('lastEndedSession は、その日に最後に終えた実施を返す。参照の範囲は実施中のものと同じ', async () => {
    const sessionId = await freshSession();
    await api.endSession(teacher, sessionId);
    expect((await api.lastEndedSession(1, today(), teacher))?.nap_session_id).toBe(sessionId);
    expect(await api.activeSession(1, today(), teacher)).toBeNull();
    expect(await api.lastEndedSession(1, addDays(today(), 1), teacher)).toBeNull();
    await expect(api.lastEndedSession(1, today(), otherTeacher)).rejects.toThrow('参照する権限がありません');
  });

  it('終えたあとは、行を状態の表示だけで出す（おきたの無いまま終わった組は「ねた（おきたが未記録）」）', async () => {
    const sessionId = await freshSession();
    await api.sleep(teacher, sessionId, 'C001');
    const second = await api.sleep(teacher, sessionId, 'C002');
    await api.wake(teacher, second.nap_sleep_id);
    await api.exclude(teacher, sessionId, 'C003', '1');
    await api.endSession(teacher, sessionId);
    const [taro, second2, third] = [await nameOf('C001'), await nameOf('C002'), await nameOf('C003')];

    renderNap();
    await waitFor(() => expect(rowOf(taro)?.textContent).toContain('13:30 ねた（おきたが未記録）'), { timeout: 3000 });
    expect(rowOf(second2).textContent).toMatch(/13:30〜13:30（0分）/);
    expect(rowOf(third).textContent).toContain('対象外（欠席）');
    expect(document.querySelector('main')!.textContent).toContain('きょうの午睡チェックは 13:30 に終了しました。');
    const rows = rowsOnScreen();
    expect(rows.length).toBe((await api.classState(teacher, 1, null)).length);
    for (const row of rows) {
      expect(row.textContent).toContain('午睡チェックを開始すると押せます');
      expect(rowButtons(row)).toEqual([]);
    }
    // 開始のボタンは今までどおり出す
    expect(Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('午睡チェックを開始する'))).toBe(true);
  });

  it('実施の前（その日に実施が無い）も行を出し、各行に「午睡チェックを開始すると押せます」を出す', async () => {
    // その日に実施の無い日にする（デモの実施は前の日になる）
    vi.setSystemTime(new Date(`${addDays(today(), 1)}T13:30:00+09:00`));
    renderNap();
    await waitFor(() => expect(rowsOnScreen().length).toBeGreaterThan(0), { timeout: 3000 });
    expect(document.querySelector('main')!.textContent).toContain('午睡チェックはまだ開始していません。');
    const rows = rowsOnScreen();
    expect(rows.length).toBe((await api.classState(teacher, 1, null)).length);
    for (const row of rows) {
      expect(row.textContent).toContain('午睡チェックを開始すると押せます');
      expect(rowButtons(row)).toEqual([]);
    }
  });
});
