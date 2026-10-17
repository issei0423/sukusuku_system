// @vitest-environment jsdom
/*
 * 保護者の画面・新規登録（GitHub Issue #170）
 * 典拠：基本設計書.md「保護者アカウントの自己登録」(4-3)・「ログアウト」(4-3)、
 *      図/画面詳細図.md「新規登録画面（保護者）」(2-3)・「保護者ホーム」(2-7)
 *
 * 相手はモック（api/mock.ts）。規則そのものは tests/signUp.test.ts と server/api_signup_test.go で確かめる。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

function open(path: string, user: SessionUser | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 新規登録画面で、招待コードの確認と規約への同意を済ませる */
async function verifyAndAgree(code: string) {
  await screen.findByText(/本規約について/);
  fireEvent.change(screen.getByRole('textbox', { name: '招待コード' }), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: 'コードを確認する' }));
  await screen.findByText(/招待コードを確認しました/);
  fireEvent.click(screen.getByRole('checkbox', { name: '利用規約に同意します' }));
}

function fillAccount(email: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '保護者の氏名' }), { target: { value: '中村 一郎' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'メールアドレス' }), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('パスワード', { selector: 'input' }), { target: { value: 'nakamura-5678' } });
  fireEvent.change(screen.getByLabelText('パスワード（確認）'), { target: { value: 'nakamura-5678' } });
}

describe('新規登録画面：規約への同意を送る（#170 の 1）', () => {
  it('画面で同意した版を送り、その版への同意が履歴に残る', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C007', 30);
    open('/signup', null);
    await verifyAndAgree(code);
    fillAccount('nakamura.screen@example.jp');
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));

    // 登録後は保護者ホーム。紐づく園児が出る
    await screen.findByText('中村 蓮', {}, { timeout: 3000 });
    const account = db.accounts.find((a) => a.email === 'nakamura.screen@example.jp')!;
    const rows = db.termsAgreements.filter((x) => x.account_id === account.account_id);
    expect(rows).toHaveLength(1);
    expect(db.termsDocs.find((t) => t.terms_id === rows[0].terms_id)?.terms_version).toBe(db.CURRENT_TERMS_VERSION);
  });

  it('送るまでのあいだに規約が改定されていたら、改定後の本文を出し直し、同意をやり直させる', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C008', 30);
    open('/signup', null);
    await verifyAndAgree(code);
    fillAccount('kaitei@example.jp');

    // 改定後の規約に入れ替わったことにする（サーバは、画面に出していた版への同意を断る）
    vi.spyOn(api, 'signUpGuardian').mockRejectedValue(
      new Error('利用規約が改定されました。改定後の利用規約をお読みいただき、あらためて同意してください。'));
    vi.spyOn(api, 'currentTerms').mockResolvedValue({
      terms_id: 99, terms_version: '9.9', document_type: '1', body: '改定後の規約の本文', published_on: today(),
    } as Awaited<ReturnType<typeof api.currentTerms>>);
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));

    await screen.findByText(/利用規約が改定されました/);
    await screen.findByText('改定後の規約の本文');
    expect((screen.getByRole('checkbox', { name: '利用規約に同意します' }) as HTMLInputElement).checked).toBe(false);
    // 同意をやり直すまで、アカウント情報は操作できない
    expect(screen.getByRole('button', { name: /登録する/ }).matches(':disabled')).toBe(true);
  });
});

describe('新規登録画面：氏名の上限（#170 の 4）', () => {
  it('保護者の氏名は50文字まで。残りの文字数を示す', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C009', 30);
    open('/signup', null);
    await verifyAndAgree(code);
    const name = screen.getByRole('textbox', { name: '保護者の氏名' }) as HTMLInputElement;
    expect(name.maxLength).toBe(50);
    expect(screen.getByText('残り 50 文字')).toBeTruthy();
    fireEvent.change(name, { target: { value: 'あ'.repeat(48) } });
    expect(screen.getByText('残り 2 文字')).toBeTruthy();
  });
});

describe('保護者のログアウト：保存していない入力（#170 の 5）', () => {
  async function openPersonalChat() {
    open('/guardian/chat', guardian);
    fireEvent.click(await screen.findByRole('button', { name: /担任の先生とのやりとり/ }, { timeout: 3000 }));
    return await screen.findByRole('textbox', { name: 'メッセージを入力' });
  }
  const logoutFromMenu = () => {
    fireEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'メニュー' })).getByRole('button', { name: 'ログアウト' }));
  };

  it('書きかけのメッセージがあれば、破棄される旨を出して確かめる。やめれば入力は残る', async () => {
    const input = await openPersonalChat();
    fireEvent.change(input, { target: { value: '明日はお迎えが遅くなります' } });
    logoutFromMenu();

    const dialog = await screen.findByRole('dialog', { name: '保存していない入力があります' });
    expect(dialog.textContent).toContain('破棄');
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '保存していない入力があります' })).toBeNull());
    expect((screen.getByRole('textbox', { name: 'メッセージを入力' }) as HTMLInputElement).value)
      .toBe('明日はお迎えが遅くなります');
    expect(screen.queryByText('保護者用の入口')).toBeNull();
  });

  it('確かめたうえで「破棄してログアウトする」を押すと、ログアウトして保護者用トップへ戻る', async () => {
    const input = await openPersonalChat();
    fireEvent.change(input, { target: { value: '書きかけ' } });
    logoutFromMenu();
    const dialog = await screen.findByRole('dialog', { name: '保存していない入力があります' });
    fireEvent.click(within(dialog).getByRole('button', { name: '破棄してログアウトする' }));
    await screen.findByText('保護者用の入口', {}, { timeout: 3000 });
  });

  it('書きかけを残したまま一覧へ戻っても、ログアウトの前に確かめる（書きかけはチャンネルごとに残る。#172 の 2）', async () => {
    const input = await openPersonalChat();
    fireEvent.change(input, { target: { value: '一覧へ戻っても残る書きかけ' } });
    fireEvent.click(screen.getByText('< もどる'));
    await screen.findByRole('button', { name: /担任の先生とのやりとり/ });
    expect(screen.queryByRole('textbox', { name: 'メッセージを入力' })).toBeNull();
    logoutFromMenu();
    await screen.findByRole('dialog', { name: '保存していない入力があります' });
    expect(screen.queryByText('保護者用の入口')).toBeNull();
  });

  it('保存していない入力が無ければ、確かめずにログアウトする', async () => {
    await openPersonalChat();
    logoutFromMenu();
    await screen.findByText('保護者用の入口', {}, { timeout: 3000 });
    expect(screen.queryByRole('dialog', { name: '保存していない入力があります' })).toBeNull();
  });
});

describe('保護者ホーム：園からの配布物の「新しいもの」（#170 の 6）', () => {
  it('掲載したばかりの配布物は、対象の月が前の月でも先頭に出る', async () => {
    const [y, m] = today().split('-').map(Number);
    const old = new Date(Date.UTC(y, m - 3, 1));
    const oldMonth = `${old.getUTCFullYear()}-${String(old.getUTCMonth() + 1).padStart(2, '0')}`;
    await api.postHandout(admin, {
      handout_type: '1', title: '訂正版の園だより', target_month: oldMonth, class_id: null,
      file_name: 'teisei.pdf', file_type: 'application/pdf', file_size: 1000,
    });

    open('/guardian', guardian);
    const panel = (await screen.findByRole('heading', { name: '園からの配布物' }, { timeout: 3000 }))
      .closest('section')!;
    await waitFor(() => expect(panel.querySelectorAll('.guardian-record-list a').length).toBe(3));
    const titles = Array.from(panel.querySelectorAll('.guardian-record-list a .handout-title'))
      .map((e) => e.textContent ?? '');
    expect(titles[0]).toContain('訂正版の園だより');
  });
});
