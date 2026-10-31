// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DiaryConfirmScreen from '../src/screens/diary/DiaryConfirmScreen';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { addDays, today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = { ...teacher, account_id: 1, email: 'nishida@hoiku.example.jp', role: '1',
  display_name: '西田 拓也', staff_id: 'S001', class_id: null, class_name: null };
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
    const card = await screen.findByLabelText('西田 太郎の午睡チェック');
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
  const mine = () => screen.getByRole('checkbox', { name: '自分が作成したもの' }) as HTMLInputElement;
  expect((await screen.findByRole('checkbox', { name: '自分が作成したもの' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: '日誌' }));
  await waitFor(() => expect(mine().checked).toBe(false));
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

/*
 * 招待コードの配布用の出力に、登録の手順を載せる（要件定義書「招待コードの一括発行・配布用出力」(4-1-2)
 * 「配布用の一覧（園児名・コード・有効期限・登録手順）」。GitHub Issue #312 の 2）。園児ごとに切り分けて手渡すので、1枚ごとに載せる
 */
it('配布用の出力は、1枚ごとに登録の手順を載せる', async () => {
  openApp('/staff/admin/invitations', admin);
  fireEvent.click(await screen.findByRole('button', { name: '配布用に出力' }));
  const dialog = await screen.findByRole('dialog', { name: '配布用の出力' });
  // 出力の中身は読み込んだ一覧から作る。一覧が届く前に開くと0枚なので、届いて描き直されるのを待つ
  const count = () => dialog.textContent!.match(/お子さまのお名前/g)?.length ?? 0;
  await waitFor(() => expect(count()).toBeGreaterThan(0), { timeout: 3000 });
  const sheets = count();
  expect(dialog.textContent!.match(/登録の手順/g)?.length).toBe(sheets);
  expect(dialog.textContent).toContain('招待コードで新規登録');
  expect(dialog.textContent).toContain('コードを確認する');
  expect(dialog.textContent).toContain('登録する');
});

/*
 * 保護者アカウント管理に、手で停止・再開するボタンは置かない（図/画面詳細図「保護者アカウント管理画面」(7-8) 項目5「置かない」。
 * GitHub Issue #272 の 1）。止めるのは紐づけの解除、戻すのは「紐づけを戻す」
 */
it('保護者アカウント管理に「停止」「再開」のボタンは無く、「解除」と「紐づけを戻す」がある', async () => {
  openApp('/staff/admin/guardian-accounts', admin);
  await screen.findAllByRole('button', { name: '解除' });
  expect(screen.queryByRole('button', { name: /^(停止|再開)$/ })).toBeNull();
  expect(screen.getAllByRole('button', { name: '紐づけを戻す' }).length).toBeGreaterThan(0);
});

/*
 * 紐づけを戻すのは誤って解除したときに限り、戻すと解除していたあいだのやりとりも読める（基本設計書「保護者と園児の紐づけを戻す」(4-3)）。
 * 守りは運用だけなので、確認ダイアログでその縛りと読める範囲を示す。親権の変更・家庭の事情で解除したあとは「結び直す」へ案内する
 * （止まったアカウントの保護者は新しい招待コードを使えないため。頭役の決め）。開くだけで、戻す操作はしない
 */
it('「紐づけを戻す」の確認ダイアログは、誤って解除したときだけ使うことと、解除していたあいだのやりとりも読めることを示す', async () => {
  openApp('/staff/admin/guardian-accounts', admin);
  fireEvent.click((await screen.findAllByRole('button', { name: '紐づけを戻す' }))[0]);
  const dialog = await screen.findByRole('dialog', { name: '紐づけを戻す' });
  expect(dialog.textContent).toContain('誤って解除したときだけ');
  expect(dialog.textContent).toContain('戻さずに「結び直す」を使ってください');
  expect(dialog.textContent).not.toContain('新しい招待コードで紐づけてください');
  expect(dialog.textContent).toContain('解除していたあいだのやりとりも読めるようになります');
});

/*
 * 戻せる期間の内の紐づけ（デモの鈴木 浩之は解除から4日）には、「紐づけを戻す」と「結び直す」を並べる。
 * 結び直すは、親権の変更・家庭の事情で解除したあとに改めて結ぶときに使い、relink を添えて呼ぶ（頭役の決め。【仮置き】web/仮置き値.md）
 */
it('戻せる期間の内の紐づけには「紐づけを戻す」と「結び直す」を並べ、結び直すは relink を添えて呼ぶ', async () => {
  const restore = vi.spyOn(api, 'restoreGuardianLink').mockResolvedValue(undefined);
  try {
    openApp('/staff/admin/guardian-accounts', admin);
    const row = (await screen.findByText('鈴木 浩之')).closest('tr')!;
    expect(within(row).getByRole('button', { name: '紐づけを戻す' })).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: '結び直す' }));
    const dialog = await screen.findByRole('dialog', { name: '紐づけを結び直す' });
    expect(dialog.textContent).toContain('親権の変更や家庭の事情で解除したあとに改めて結ぶときに使います');
    expect(dialog.textContent).toContain('解除していたあいだのやりとりは読めません');
    expect(dialog.textContent).not.toContain('「紐づけを戻す」は使えません');
    fireEvent.click(within(dialog).getByRole('button', { name: '結び直す' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(expect.anything(), 'G003', 'C003', true));
  } finally {
    restore.mockRestore();
  }
});

/*
 * 戻せる期間（解除から RESTORE_LINK_DAYS 日。【仮置き】web/仮置き値.md）を過ぎた紐づけは、断らずに「結び直す」を出す。
 * 確認ダイアログで、解除していたあいだのやりとりは読めないことと、止まったアカウントの再開を示す（照合 c2b-3・c5-04 の推し）。
 * 開くだけで、結び直す操作はしない
 */
it('戻せる期間を過ぎた紐づけには「紐づけを戻す」でなく「結び直す」を出し、読めない範囲を示す', async () => {
  const link = db.guardianChildren.find((g) => g.guardian_id === 'G003' && g.child_id === 'C003')!;
  const saved = link.ended_at;
  link.ended_at = `${addDays(today(), -30)}T10:00:00`;
  try {
    openApp('/staff/admin/guardian-accounts', admin);
    const row = (await screen.findByText('鈴木 浩之')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: '紐づけを戻す' })).toBeNull();
    expect(row.textContent).not.toContain('戻せません');
    fireEvent.click(within(row).getByRole('button', { name: '結び直す' }));
    const dialog = await screen.findByRole('dialog', { name: '紐づけを結び直す' });
    expect(dialog.textContent).toContain('新しい招待コードで紐づけたときと同じ扱い');
    expect(dialog.textContent).toContain('解除していたあいだのやりとりは読めません');
    expect(dialog.textContent).toContain('結び直すと、あわせて再開されます');
  } finally {
    link.ended_at = saved;
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
