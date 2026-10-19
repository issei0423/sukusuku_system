// @vitest-environment jsdom
/*
 * 午睡記録検索画面：午睡チェックの記録の「修正」と「修正あり」
 * 典拠：図/画面詳細図.md「午睡記録検索画面」(5-3) の項目6・12、基本設計書.md「記録の修正と改ざん防止」(4-8)
 *
 * 規則（直せる人・理由・操作ログ）は web/tests/napCorrect.test.ts と server/api_nap_correct_test.go が確かめる。
 * ここでは、直せる行にだけ「修正」が出ること、同じ画面の中で直せること、直した行に「修正あり」が出ること、
 * 断られた文言が出ること、閉じたらその行の「修正」へ戻ることを確かめる。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { now } from '../src/api/util';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

function open(user: SessionUser) {
  return render(
    <MemoryRouter initialEntries={['/staff/nap/search']}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function listed() {
  await waitFor(() => expect(document.querySelector('table.list tbody tr')).toBeTruthy(), { timeout: 3000 });
}

/** 一覧（最初の表）の行のうち、園児名と、日付か時刻を含む行 */
function listRow(childName: string, text: string): HTMLElement {
  const table = document.querySelector('table.list') as HTMLElement;
  const row = within(table).getAllByRole('row').find((tr) => tr.textContent?.includes(childName) && tr.textContent.includes(text));
  if (!row) throw new Error(`${childName} の ${text} の行がありません`);
  return row;
}

const sessionDateOf = (id: number) => db.napSessions.find((s) => s.nap_session_id === id)!.session_date;
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

let saved: { records: typeof db.napRecords; abnormals: typeof db.napAbnormals; logs: typeof db.operationLogs };
beforeEach(() => {
  saved = { records: db.napRecords.map((r) => ({ ...r })), abnormals: db.napAbnormals.map((a) => ({ ...a })), logs: [...db.operationLogs] };
  // 昨日の実施 2（さくら組）の野原 太郎の記録と、今日の実施 1 の上園 花子の異常時の記録を足す
  db.napRecords.push({
    nap_record_id: 900701, nap_session_id: 2, child_id: 'C001', checked_at: `${sessionDateOf(2)}T13:40:00`,
    saved_at: `${sessionDateOf(2)}T13:40:10`, body_position: '1', breathing: '1', complexion: '1', temperature: null, staff_id: 'S003',
  });
  db.napAbnormals.push({
    nap_abnormal_id: 900702, nap_session_id: 1, child_id: 'C002', found_at: now(), recorded_at: now(),
    situation: '状況', response: '対応', staff_id: 'S003', diary_id: null,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  db.napRecords.splice(0, db.napRecords.length, ...saved.records);
  db.napAbnormals.splice(0, db.napAbnormals.length, ...saved.abnormals);
  db.operationLogs.splice(0, db.operationLogs.length, ...saved.logs);
});

describe('午睡記録検索画面の「修正」', () => {
  it('担任には、その日の自クラスの、異常時の記録が無い子の行にだけ「修正」を出す', async () => {
    open(teacher);
    await listed();
    expect(screen.getByRole('button', { name: '野原 太郎の13:20の記録を修正' })).toBeTruthy();
    // 異常時の記録がある子（上園 花子）と、昨日の記録には出さない
    expect(screen.queryByRole('button', { name: '上園 花子の13:20の記録を修正' })).toBeNull();
    expect(within(listRow('野原 太郎', '13:40')).queryByRole('button')).toBeNull();
    // ねた・おきた・対象外の行には出さない
    for (const tr of within(document.querySelector('table.list') as HTMLElement).getAllByRole('row')) {
      if (/入眠（ねた）|起床（おきた）|きょうは対象外/.test(tr.textContent ?? '')) expect(within(tr).queryByRole('button')).toBeNull();
    }
    // 直せる範囲を一般に知らせる
    expect(document.body.textContent).toContain('前の日までの記録と、異常時の記録がある子の記録は、管理者が修正します');
  });

  it('管理者には、昨日の記録にも、異常時の記録がある子の行にも「修正」を出す', async () => {
    open(admin);
    await listed();
    expect(screen.getByRole('button', { name: '上園 花子の13:20の記録を修正' })).toBeTruthy();
    expect(within(listRow('野原 太郎', '13:40')).getByRole('button', { name: '野原 太郎の13:40の記録を修正' })).toBeTruthy();
    expect(listRow('野原 太郎', '13:40').textContent).toContain(md(sessionDateOf(2)));
    expect(document.body.textContent).not.toContain('管理者が修正します');
  });

  it('同じ画面の中で直す。理由が無ければ断られた文言を出し、入れれば行を書き換えて「修正あり」を出し、「修正」へ戻る', async () => {
    open(teacher);
    await listed();
    fireEvent.click(screen.getByRole('button', { name: '野原 太郎の13:20の記録を修正' }));
    const form = await screen.findByRole('form', { name: /野原 太郎の.*13:20の記録の修正/ });
    // 開いたら最初の項目（体位）へ移る。いまの値が入っている
    const position = within(form).getByLabelText('体位') as HTMLSelectElement;
    expect(document.activeElement).toBe(position);
    expect(position.value).toBe('1');
    expect((within(form).getByLabelText('体温（℃）') as HTMLInputElement).value).toBe('36.6');

    fireEvent.change(position, { target: { value: '2' } });
    fireEvent.click(within(form).getByRole('button', { name: '修正する' }));
    await within(form).findByText('修正の理由を入力してください');
    expect(db.napRecords.find((r) => r.nap_record_id === 1)!.body_position).toBe('1');

    fireEvent.change(within(form).getByLabelText('修正の理由'), { target: { value: '押し間違えた' } });
    fireEvent.click(within(form).getByRole('button', { name: '修正する' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: /記録の修正/ })).toBeNull());
    await waitFor(() => expect(listRow('野原 太郎', '13:20').textContent).toContain('修正あり'));
    expect(listRow('野原 太郎', '13:20').textContent).toContain('うつ伏せ');
    expect(db.napRecords.find((r) => r.nap_record_id === 1)).toMatchObject({ body_position: '2' });
    // 閉じたら、その行の「修正」へ戻る
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('野原 太郎の13:20の記録を修正'));
  });

  it('「やめる」は何も変えずに閉じ、その行の「修正」へ戻る', async () => {
    open(teacher);
    await listed();
    fireEvent.click(screen.getByRole('button', { name: '野原 太郎の13:20の記録を修正' }));
    const form = await screen.findByRole('form', { name: /記録の修正/ });
    fireEvent.change(within(form).getByLabelText('体位'), { target: { value: '3' } });
    fireEvent.click(within(form).getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('form', { name: /記録の修正/ })).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('野原 太郎の13:20の記録を修正');
    expect(db.napRecords.find((r) => r.nap_record_id === 1)).toMatchObject({ body_position: '1' });
    expect(listRow('野原 太郎', '13:20').textContent).not.toContain('修正あり');
  });
});
