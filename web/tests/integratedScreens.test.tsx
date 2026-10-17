// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DiaryConfirmScreen from '../src/screens/diary/DiaryConfirmScreen';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { addDays, today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = { ...teacher, account_id: 1, email: 'nohara@hoiku.example.jp', role: '1',
  display_name: '野原 一誠', staff_id: 'S001', class_id: null, class_name: null };
const openApp = (path: string, user: SessionUser) => render(<MemoryRouter initialEntries={[path]}>
  <SessionProvider initialUser={user}><App /></SessionProvider>
</MemoryRouter>);

afterEach(cleanup);

it('日誌確認画面を読み込み直した後も、ロックを取り直して申請できる', async () => {
  const original = db.diaries.find((d) => d.diary_id === 1)!;
  const lock = await api.acquireLock(teacher, 1);
  if (!('token' in lock)) throw new Error('下書きのロックを取得できません');
  const state = { recordType: original.record_type, childId: original.child_id, classId: original.class_id,
    date: today(), body: '再読み込み後の申請', diaryId: 1, lockToken: lock.token, photos: [] };
  const open = () => render(<MemoryRouter initialEntries={[{ pathname: '/staff/diary/confirm', state }]}>
    <SessionProvider initialUser={teacher}>
      <Routes><Route path="/staff/diary/confirm" element={<DiaryConfirmScreen />} /><Route path="/staff/diary" element={<h1>日誌</h1>} /></Routes>
    </SessionProvider>
  </MemoryRouter>);
  const first = open();
  await waitFor(() => expect((screen.getByRole('button', { name: '申請する' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent(window, new Event('pagehide'));
  await waitFor(() => expect(db.diaryLocks.some((l) => l.diary_id === 1)).toBe(false));
  first.unmount();
  open();
  await waitFor(() => expect((screen.getByRole('button', { name: '申請する' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '申請する' }));
  await screen.findByRole('heading', { name: '日誌' });
  expect(db.diaries.find((d) => d.diary_id === 1)?.status).toBe('2');
});

it('招待コード欄はスマートフォンで確認ボタンの下へ折り返せる', () => {
  render(<MemoryRouter initialEntries={['/signup']}><SessionProvider><App /></SessionProvider></MemoryRouter>);
  const input = screen.getByPlaceholderText('ABCD-1234-EFGH');
  const row = input.closest('.row') as HTMLElement;
  expect(row.style.flexWrap).toBe('wrap');
  expect(row.firstElementChild?.getAttribute('style')).toContain('210px');
});

it('発見が午睡のチェックより前でも、保存後は再記録を促さない', async () => {
  vi.setSystemTime(new Date(`${today()}T14:00:00+09:00`));
  const record = db.napRecords.find((r) => r.nap_session_id === 1 && r.child_id === 'C001')!;
  const old = { ...record };
  record.breathing = '2'; record.checked_at = `${today()}T13:50:00`;
  const abnormal = { nap_abnormal_id: 9999, nap_session_id: 1, child_id: 'C001',
    found_at: `${today()}T13:45:00`, recorded_at: `${today()}T13:55:00`,
    situation: '呼吸を確認できず', response: '再確認した', staff_id: 'S003', diary_id: null };
  db.napAbnormals.push(abnormal);
  try {
    openApp('/staff/nap', teacher);
    const card = await screen.findByLabelText('野原 太郎の午睡チェック');
    await waitFor(() => expect(card.textContent).toContain('異常時の記録あり'));
    expect(card.textContent).not.toContain('異常時の記録を残してください');
  } finally {
    Object.assign(record, old);
    db.napAbnormals.splice(db.napAbnormals.indexOf(abnormal), 1);
    vi.setSystemTime(new Date(`${today()}T18:00:00+09:00`));
  }
});

it('停止中の保護者との個人チャットには、再開後に読めることを示す', async () => {
  const account = db.accounts.find((a) => a.account_id === 6)!;
  const old = account.status;
  account.status = '2';
  try {
    openApp('/staff/chat?room=6', teacher);
    expect(await screen.findByText(/停止中の保護者が再開すると/)).toBeTruthy();
    expect(screen.queryByText('このチャンネルは職員だけが読みます。')).toBeNull();
  } finally { account.status = old; }
});

it('管理者のサイドナビにスクロール案内がある', () => {
  openApp('/staff', admin);
  expect(screen.getByText('↕ メニューはスクロールできます')).toBeTruthy();
});

it('サイドナビから日誌へ戻ると、ダッシュボード由来の条件が外れる', async () => {
  openApp('/staff/diary?status=4&mine=1', teacher);
  expect(await screen.findByText('自分が書いた日誌に絞っています。')).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: '日誌' }));
  await waitFor(() => expect(screen.queryByText('自分が書いた日誌に絞っています。')).toBeNull());
  expect((screen.getByLabelText('状態') as HTMLSelectElement).value).toBe('');
});

it('同姓同名の別の園児は、招待コード一覧・発行・配布用出力で区別できる', async () => {
  const base = db.children.find((c) => c.child_id === 'C001')!;
  const second = { ...base, child_id: 'C023', birth_date: '2025-04-02' };
  const code = { ...db.invitationCodes[0], invitation_code_id: 9999, child_id: 'C023', code: 'TEST-1234-ABCD' };
  db.children.push(second);
  db.classChildren.push({ ...db.classChildren.find((x) => x.child_id === 'C001')!, child_id: 'C023' });
  db.invitationCodes.push(code);
  try {
    openApp('/staff/admin/invitations', admin);
    await waitFor(() => expect(screen.getByText(/C023・2025-04-02/)).toBeTruthy());
    expect(screen.getByText(/C001・/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1枚発行' }));
    await waitFor(() => expect(screen.getByRole('option', { name: /C023・2025-04-02/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    fireEvent.click(screen.getByRole('button', { name: '配布用に出力' }));
    expect(screen.getAllByText(/C023・2025-04-02/).length).toBeGreaterThan(1);
  } finally {
    db.children.splice(db.children.indexOf(second), 1);
    db.classChildren.splice(db.classChildren.findIndex((x) => x.child_id === 'C023'), 1);
    db.invitationCodes.splice(db.invitationCodes.indexOf(code), 1);
  }
});

it('操作ログ CSV は適用済みの期間で全ページを出力する', async () => {
  const firstId = Math.max(...db.operationLogs.map((x) => x.operation_log_id)) + 100000;
  const added = Array.from({ length: 110 }, (_, i) => ({ ...db.operationLogs[0],
    operation_log_id: firstId + i, operated_at: `${today()}T12:00:00` }));
  db.operationLogs.push(...added);
  const expectedCount = db.operationLogs.filter((x) => x.operated_at.slice(0, 10) >= addDays(today(), -30)
    && x.operated_at.slice(0, 10) <= today()).length;
  const exportSpy = vi.spyOn(api, 'recordExport');
  const listSpy = vi.spyOn(api, 'operationLogs');
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    openApp('/staff/admin/logs', admin);
    await waitFor(() => expect((screen.getByRole('button', { name: 'CSV出力' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('期間（開始）'), { target: { value: '2026-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'CSV出力' }));
    await waitFor(() => expect(exportSpy).toHaveBeenCalled());
    expect(exportSpy.mock.lastCall?.slice(1)).toEqual(['operation_log', addDays(today(), -30), today(), expectedCount]);
    expect(listSpy.mock.calls.some(([, f]) => f?.page === 2)).toBe(true);
  } finally {
    db.operationLogs.splice(db.operationLogs.indexOf(added[0]), added.length);
    exportSpy.mockRestore(); listSpy.mockRestore(); click.mockRestore();
  }
});
