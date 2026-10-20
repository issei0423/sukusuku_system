// @vitest-environment jsdom
/*
 * 編集ロックの引き継ぎと、職員アカウント・招待コードの画面の確かめ（GitHub Issue #166 の 1、#167 の 1〜3）
 * 典拠：基本設計書.md「編集ロックの解除」(4-5)、要件定義書「管理者が1名になる操作（停止・削除・ロールの変更）に対して、
 *      システムは警告を表示する」、基本設計書「入力項目の制約値」(4-9)、図/画面詳細図.md「招待コード管理画面」(7-7) 項目10
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

function open(path: string, user: SessionUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function settled() {
  await waitFor(() => {
    expect(document.body.textContent).not.toContain('読み込んでいます');
  }, { timeout: 3000 });
}

afterEach(cleanup);

const lockOf = (diaryId: number) => db.diaryLocks.find((l) => l.diary_id === diaryId);

describe('日誌の編集ロックを確認画面へ引き継ぐ（GitHub Issue #166 の 1 の手順 B）', () => {
  it('確認画面にいる間もロックを持ち、離れると外す', async () => {
    const { unmount } = open('/staff/diary/1', teacher);
    const next = await screen.findByRole('button', { name: '確認へ進む' }, { timeout: 3000 });
    await waitFor(() => expect(next.matches(':disabled')).toBe(false), { timeout: 3000 });
    const token = lockOf(1)?.lock_token;
    expect(lockOf(1)?.locked_staff_id).toBe('S003');

    fireEvent.click(next);
    await screen.findByText('この内容で申請します');
    // 確認画面へ移っても外さない。ほかの職員が開くと「編集中」になる
    await new Promise((r) => setTimeout(r, 20));
    expect(lockOf(1)?.lock_token).toBe(token);

    unmount();
    await waitFor(() => expect(lockOf(1)).toBeUndefined(), { timeout: 3000 });
  });

  it('確認画面から戻っても編集を続けられ、申請するとロックが外れる', async () => {
    open('/staff/diary/1', teacher);
    const next = await screen.findByRole('button', { name: '確認へ進む' }, { timeout: 3000 });
    await waitFor(() => expect(next.matches(':disabled')).toBe(false), { timeout: 3000 });
    fireEvent.click(next);
    fireEvent.click(await screen.findByRole('button', { name: '戻る' }));

    // 戻った編集画面は、ロックを持ち直して先へ進める
    const again = await screen.findByRole('button', { name: '確認へ進む' }, { timeout: 3000 });
    await waitFor(() => expect(again.matches(':disabled')).toBe(false), { timeout: 3000 });
    expect(lockOf(1)?.locked_staff_id).toBe('S003');
    fireEvent.click(again);
    fireEvent.click(await screen.findByRole('button', { name: '申請する' }));

    await waitFor(() => expect(db.diaries.find((d) => d.diary_id === 1)?.status).toBe('2'), { timeout: 3000 });
    expect(screen.queryByText(/編集ロックが解除されました/)).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(lockOf(1)).toBeUndefined();
  });
});

describe('職員アカウント管理画面（GitHub Issue #167 の 1・2）', () => {
  it('管理者が2名のとき、片方を停止しようとすると「管理者が1名になります」と警告する', async () => {
    open('/staff/admin/staff-accounts', admin);
    await settled();
    const row = (await screen.findByText('上園 謙心')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: '停止' }));
    expect(await screen.findByText(/この停止で、管理者が1名になります/)).toBeTruthy();
  });

  it('ログインIDがメールアドレスの形でないときは、発行せずにダイアログの中で知らせる', async () => {
    open('/staff/admin/staff-accounts', admin);
    await settled();
    const before = db.staff.length;
    fireEvent.click(screen.getByRole('button', { name: '＋ アカウントを発行' }));
    fireEvent.change(screen.getByLabelText('氏名'), { target: { value: '形式 確認' } });
    fireEvent.change(screen.getByLabelText('ログインID（メールアドレス）'), { target: { value: 'abc2' } });
    fireEvent.click(screen.getByRole('button', { name: '発行する' }));
    expect(await screen.findByText(/ログインID（メールアドレス）の形式が正しくありません/)).toBeTruthy();
    expect(db.staff.length).toBe(before);
  });
});

describe('招待コード管理画面の一括発行（GitHub Issue #167 の 3）', () => {
  it('園児1名あたり 6 枚以上は発行できない', async () => {
    open('/staff/admin/invitations', admin);
    await settled();
    fireEvent.click(screen.getByRole('button', { name: '一括発行' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '園児1名あたりの枚数' }), { target: { value: '50' } });
    expect(await screen.findByText(/1名あたりの枚数は1〜5枚で指定してください/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '発行する' }).matches(':disabled')).toBe(true);
  });
});
