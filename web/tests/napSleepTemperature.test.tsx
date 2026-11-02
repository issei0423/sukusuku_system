// @vitest-environment jsdom
/*
 * 入眠時の体温（受け入れテスト 04-014）
 * 典拠：図/画面詳細図「午睡チェック画面」(5-1) 項目12・24、詳細設計書「行の状態ごとの表示」(2-4 (2))・「午睡（ねた・おきた・対象外）」(4-6) の (2)、
 *      基本設計書「ねた・おきた」(4-8)・「メッセージ一覧」(4-12) の体温の入力待ち・「ねた・おきた（t_nap_sleep）」(5-7)
 *
 * 「ねた」を先に保存し、設定（nap.temperature_required）が「入眠時」なら、体温が入るまで行に「体温を入れてください。」を出す。
 * 入眠時の体温は監査の層の値で保護者へ返さない（連絡帳の体温とは別の記録）。
 * Go の同じ観点は server/api_nap_sleep_temperature_test.go にある。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { MSG, TEXT } from '../src/messages';
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
const otherTeacher: SessionUser = { ...teacher, account_id: 5, staff_id: 'S005', class_id: 2, class_name: 'ひまわり組', display_name: '久保田 和也' };
/** 西田 太郎（C001）の父 */
const guardian: SessionUser = {
  account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
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

const childName = (id: string) => db.children.find((c) => c.child_id === id)!.child_name;

describe('入眠時の体温の規則（モック。詳細設計書 (4-6) の (2)）', () => {
  it('おひるね中の組に入れられる。ねたの時刻と訂正の印は変えず、保護者には返さない', async () => {
    const sessionId = await freshSession();
    const slept = await api.sleep(teacher, sessionId, 'C001');
    await expect(api.sleepTemperature(otherTeacher, slept.nap_sleep_id, 36.8)).rejects.toThrow(MSG.contactForbidden);
    await expect(api.sleepTemperature(teacher, slept.nap_sleep_id, 36.85)).rejects.toThrow(MSG.temperatureFormat);

    const got = await api.sleepTemperature(teacher, slept.nap_sleep_id, 36.8);
    expect([got.sleep_temperature, got.slept_at, got.corrected_at, got.woke_at]).toEqual([36.8, slept.slept_at, null, null]);
    const row = (await api.classState(teacher, 1, sessionId)).find((r) => r.child.child_id === 'C001')!;
    expect(row.sleeps.map((s) => s.sleep_temperature)).toEqual([36.8]);
    // 範囲の外も保存する（確かめは画面）
    expect((await api.sleepTemperature(teacher, slept.nap_sleep_id, 43.5)).sleep_temperature).toBe(43.5);
    // 保護者の連絡帳には出さない（監査の層）
    expect(JSON.stringify(await api.contactPage(guardian, 'C001'))).not.toContain('sleep_temperature');
    // 操作ログに元の値を残す
    expect(db.operationLogs.filter((l) => l.target_table === 't_nap_sleep' && l.target_id === slept.nap_sleep_id
      && (l.before_value ?? '').includes('sleep_temperature')).length).toBe(2);

    // おきたのあとは入れられない。終わった実施へは入れられない
    await api.wake(teacher, slept.nap_sleep_id);
    await expect(api.sleepTemperature(teacher, slept.nap_sleep_id, 36.9)).rejects.toThrow(MSG.sleepTempAfterWake);
    const second = await api.sleep(teacher, sessionId, 'C002');
    await api.endSession(teacher, sessionId);
    await expect(api.sleepTemperature(teacher, second.nap_sleep_id, 36.9)).rejects.toThrow(MSG.sessionEnded);
  });
});

describe('午睡チェック画面：入眠時の体温（04-014）', () => {
  it('「ねた」の直後から行に「体温を入れてください。」を出し、行の「体温」で入れると消える', async () => {
    const sessionId = await freshSession();
    const name = childName('C001');
    render(
      <MemoryRouter initialEntries={['/staff/nap']}>
        <SessionProvider initialUser={teacher}>
          <App />
        </SessionProvider>
      </MemoryRouter>,
    );
    const row = await screen.findByRole('region', { name: `${name}の午睡チェック` }, { timeout: 3000 });
    expect(row.textContent).not.toContain('体温を入れてください。');

    fireEvent.click(within(row).getByRole('button', { name: `${name}のねた` }));
    await waitFor(() => expect(row.textContent).toContain('体温を入れてください。'), { timeout: 3000 });
    expect(row.classList.contains('needs-temperature')).toBe(true);
    // 押した人には結果の表示で伝える（行の文は読み上げへ伝えない）
    await waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain('体温を入れてください。'));
    // 体温のボタンの説明にも「体温を入れてください。」
    const button = within(row).getByRole('button', { name: `${name}の体温 未測定` });
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe('体温を入れてください。');

    // 行の「体温」で入れる（選んだらすぐ入眠時の体温として記録する）
    fireEvent.click(button);
    const picker = await screen.findByRole('dialog', { name: `${name}の体温` });
    expect(picker.textContent).toContain('入眠時の体温として');
    fireEvent.click(within(picker).getByRole('button', { name: '36℃' }));
    fireEvent.click(within(picker).getByRole('button', { name: '.8' }));
    await waitFor(() => expect(row.textContent).not.toContain('体温を入れてください。'), { timeout: 3000 });
    expect(row.classList.contains('needs-temperature')).toBe(false);
    expect(row.textContent).toContain('入眠時の体温 36.8℃');
    const sleep = db.napSleeps.find((s) => s.nap_session_id === sessionId && s.child_id === 'C001' && !s.is_deleted)!;
    expect(sleep.sleep_temperature).toBe(36.8);
    // 5分ごとの確認の体温には入れていない
    expect(within(row).getByRole('button', { name: `${name}の体温 未測定` })).toBeTruthy();
    await api.endSession(teacher, sessionId);
  });
});

/*
 * 範囲（30.0〜43.0℃）の外の体温は、窓を開いたまま1度だけ確かめを促し、止めない（基本設計書「入力項目の制約値」(4-12)・
 * 「メッセージ一覧」(4-12) の範囲外の文。共通の部品 components/TemperaturePicker.tsx の outsideAck と同じ形）。
 * 前は窓が閉じてから行に「もう一度同じ値を入れてください」と出し、開き直して打ち直すことになった（PR #374 の自動レビュー）
 */
describe('午睡チェック画面：範囲の外の体温は、窓を開いたまま確かめる', () => {
  const renderNap = () => render(
    <MemoryRouter initialEntries={['/staff/nap']}>
      <SessionProvider initialUser={teacher}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
  /** 窓の「範囲外の値を入力」から値を入れて「設定」を押す */
  const typeOutside = (picker: HTMLElement, value: string) => {
    fireEvent.click(within(picker).getByRole('button', { name: '範囲外の値を入力' }));
    fireEvent.change(within(picker).getByLabelText('範囲外の体温'), { target: { value } });
    fireEvent.click(within(picker).getByRole('button', { name: '設定' }));
  };

  it('入眠時の体温：1回目は窓が開いたまま「このまま記録する」と範囲外の文、押すと記録する', async () => {
    const sessionId = await freshSession();
    const name = childName('C001');
    renderNap();
    const row = await screen.findByRole('region', { name: `${name}の午睡チェック` }, { timeout: 3000 });
    fireEvent.click(within(row).getByRole('button', { name: `${name}のねた` }));
    await waitFor(() => expect(row.classList.contains('needs-temperature')).toBe(true), { timeout: 3000 });

    fireEvent.click(within(row).getByRole('button', { name: `${name}の体温 未測定` }));
    const picker = await screen.findByRole('dialog', { name: `${name}の体温` });
    typeOutside(picker, '43.5');
    // 窓は開いたまま。範囲外の文を窓の中に出し、ボタンを「このまま記録する」に替える。まだ記録しない
    expect(screen.getByRole('dialog', { name: `${name}の体温` })).toBe(picker);
    expect(within(picker).getByRole('alert').textContent).toBe(TEXT.temperatureOutOfRange);
    const sleepOf = () => db.napSleeps.find((s) => s.nap_session_id === sessionId && s.child_id === 'C001' && !s.is_deleted)!;
    expect(sleepOf().sleep_temperature).toBeNull();
    // 行に「もう一度同じ値を入れてください」は出さない
    expect(row.textContent).not.toContain('もう一度同じ値');

    fireEvent.click(within(picker).getByRole('button', { name: 'このまま記録する' }));
    await waitFor(() => expect(row.textContent).toContain('入眠時の体温 43.5℃'), { timeout: 3000 });
    expect(screen.queryByRole('dialog', { name: `${name}の体温` })).toBeNull();
    expect(sleepOf().sleep_temperature).toBe(43.5);
    expect(row.classList.contains('needs-temperature')).toBe(false);
    await api.endSession(teacher, sessionId);
  });

  it('5分ごとの確認の体温：窓の中で1度だけ確かめ（「このまま設定する」）、「記録する」ではもう確かめない', async () => {
    const sessionId = await freshSession();
    const name = childName('C001');
    renderNap();
    const row = await screen.findByRole('region', { name: `${name}の午睡チェック` }, { timeout: 3000 });

    fireEvent.click(within(row).getByRole('button', { name: `${name}の体温 未測定` }));
    const picker = await screen.findByRole('dialog', { name: `${name}の体温` });
    typeOutside(picker, '29.5');
    expect(within(picker).getByRole('alert').textContent).toBe(TEXT.temperatureOutOfRange);
    // 値を打ち直すと、確かめは最初から（ボタンは「設定」に戻る）
    fireEvent.change(within(picker).getByLabelText('範囲外の体温'), { target: { value: '29.4' } });
    expect(within(picker).getByRole('button', { name: '設定' })).toBeTruthy();
    expect(within(picker).queryByRole('alert')).toBeNull();
    fireEvent.click(within(picker).getByRole('button', { name: '設定' }));
    fireEvent.click(within(picker).getByRole('button', { name: 'このまま設定する' }));
    expect(screen.queryByRole('dialog', { name: `${name}の体温` })).toBeNull();
    expect(within(row).getByRole('button', { name: `${name}の体温 29.4℃` })).toBeTruthy();

    // 体位・呼吸・顔色を選んで「記録する」を1回押せば記録する（行でもう一度確かめない）
    for (const field of ['position', 'breathing', 'complexion']) {
      fireEvent.click(row.querySelector<HTMLInputElement>(`input[name^="${field}-"][value="1"]`)!);
    }
    fireEvent.click(within(row).getByRole('button', { name: `${name}を記録する` }));
    await waitFor(() => expect(db.napRecords.some((r) => r.nap_session_id === sessionId && r.child_id === 'C001' && r.temperature === 29.4)).toBe(true), { timeout: 3000 });
    expect(row.textContent).not.toContain('の外です');
    await api.endSession(teacher, sessionId);
  });
});
