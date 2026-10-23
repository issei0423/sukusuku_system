// @vitest-environment jsdom
/*
 * 異常時記録画面：異常時の記録の「修正」と「修正あり」
 * 典拠：図/画面詳細図.md「異常時記録画面」(5-2) の項目17、基本設計書.md「記録の修正と改ざん防止」(4-8)
 *
 * 規則（直せる人・理由・発見時刻の前後・操作ログ）は web/tests/napAbnormalCorrect.test.ts と
 * server/api_nap_abnormal_correct_test.go が確かめる。ここでは、直せる行にだけ「修正」が出ること、同じ画面の中で直せること、
 * 直した行に「修正あり」が出ること、断られた文言が出ること、閉じたらその行の「修正」へ戻ることを確かめる。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { formatMDHM, fromNowMinutes } from '../src/api/util';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

function open(user: SessionUser) {
  return render(
    <MemoryRouter initialEntries={['/staff/nap/abnormal']}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function listed() {
  await waitFor(() => expect(document.querySelector('table.list tbody tr')).toBeTruthy(), { timeout: 3000 });
}

/** 記録の一覧の行のうち、園児名を含む行 */
function listRow(childName: string): HTMLElement {
  const table = document.querySelector('table.list') as HTMLElement;
  const row = within(table).getAllByRole('row').find((tr) => tr.textContent?.includes(childName));
  if (!row) throw new Error(`${childName} の行がありません`);
  return row;
}

const abnormalOf = (id: number) => db.napAbnormals.find((a) => a.nap_abnormal_id === id)!;
const TODAY_ID = 900901;
let foundAt = '';
let saved: { abnormals: typeof db.napAbnormals; logs: typeof db.operationLogs };
beforeEach(() => {
  saved = { abnormals: db.napAbnormals.map((a) => ({ ...a })), logs: [...db.operationLogs] };
  // 今日の実施 1（さくら組）の、西田 太郎の異常時の記録を足す（デモの記録 1・2 は2日前と昨日）
  foundAt = `${fromNowMinutes(-40).slice(0, 16)}:00`;
  db.napAbnormals.push({
    nap_abnormal_id: TODAY_ID, nap_session_id: 1, child_id: 'C001', found_at: foundAt, recorded_at: fromNowMinutes(-30),
    situation: '寝返りでうつ伏せ', response: '仰向けに直した', staff_id: 'S004', diary_id: null,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  db.napAbnormals.splice(0, db.napAbnormals.length, ...saved.abnormals);
  db.operationLogs.splice(0, db.operationLogs.length, ...saved.logs);
});

const editName = () => `西田 太郎の${formatMDHM(foundAt)}の異常時の記録を修正`;

describe('異常時記録画面の「修正」', () => {
  it('担任には、その日の自クラスの記録にだけ「修正」を出す。前の日の記録には出さない', async () => {
    open(teacher);
    await listed();
    expect(screen.getByRole('button', { name: editName() })).toBeTruthy();
    // 昨日（久保田 陸）と2日前（鈴木 健）の記録には出さない
    expect(within(listRow('久保田 陸')).queryByRole('button', { name: /修正/ })).toBeNull();
    expect(within(listRow('鈴木 健')).queryByRole('button', { name: /修正/ })).toBeNull();
    // 直せる範囲を一般に知らせる
    expect(document.body.textContent).toContain('前の日までの記録は、管理者が修正します');
  });

  it('管理者には、前の日の記録にも「修正」を出す', async () => {
    open(admin);
    await listed();
    expect(within(listRow('久保田 陸')).getByRole('button', { name: /久保田 陸の.*の異常時の記録を修正/ })).toBeTruthy();
    expect(within(listRow('鈴木 健')).getByRole('button', { name: /鈴木 健の.*の異常時の記録を修正/ })).toBeTruthy();
    expect(document.body.textContent).not.toContain('管理者が修正します');
  });

  it('同じ画面の中で直す。理由が無ければ断られた文言を出し、入れれば行を書き換えて「修正あり」を出し、「修正」へ戻る', async () => {
    open(teacher);
    await listed();
    fireEvent.click(screen.getByRole('button', { name: editName() }));
    const form = await screen.findByRole('form', { name: /西田 太郎の.*の異常時の記録の修正/ });
    // 開いたら最初の項目（発見時刻）へ移る。いまの値が入っている
    const found = within(form).getByLabelText('発見時刻') as HTMLInputElement;
    expect(document.activeElement).toBe(found);
    expect(found.value).toBe(foundAt.slice(0, 16));
    expect((within(form).getByLabelText('発見時の状況') as HTMLTextAreaElement).value).toBe('寝返りでうつ伏せ');
    expect((within(form).getByLabelText('とった対応') as HTMLTextAreaElement).value).toBe('仰向けに直した');

    fireEvent.change(within(form).getByLabelText('発見時の状況'), { target: { value: '寝返りでうつ伏せになっていた' } });
    fireEvent.click(within(form).getByRole('button', { name: '修正する' }));
    await within(form).findByText('修正の理由を入力してください');
    expect(abnormalOf(TODAY_ID).situation).toBe('寝返りでうつ伏せ');

    fireEvent.change(within(form).getByLabelText('修正の理由'), { target: { value: '書き足した' } });
    fireEvent.click(within(form).getByRole('button', { name: '修正する' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: /異常時の記録の修正/ })).toBeNull());
    await waitFor(() => expect(listRow('西田 太郎').textContent).toContain('修正あり'));
    expect(listRow('西田 太郎').textContent).toContain('寝返りでうつ伏せになっていた');
    // 発見時刻は触っていないので送らない（変えない）
    expect(abnormalOf(TODAY_ID)).toMatchObject({ situation: '寝返りでうつ伏せになっていた', found_at: foundAt });
    // 閉じたら、その行の「修正」へ戻る
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe(editName()));
  });

  it('「やめる」は何も変えずに閉じ、その行の「修正」へ戻る', async () => {
    open(teacher);
    await listed();
    fireEvent.click(screen.getByRole('button', { name: editName() }));
    const form = await screen.findByRole('form', { name: /異常時の記録の修正/ });
    fireEvent.change(within(form).getByLabelText('とった対応'), { target: { value: '別のこと' } });
    fireEvent.click(within(form).getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('form', { name: /異常時の記録の修正/ })).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe(editName());
    expect(abnormalOf(TODAY_ID)).toMatchObject({ response: '仰向けに直した' });
    expect(listRow('西田 太郎').textContent).not.toContain('修正あり');
  });
});
