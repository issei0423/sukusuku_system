// @vitest-environment jsdom
/*
 * 連絡帳の層の、入力欄の近くに常に出す固定の文（設計の直し PR #216 の 直-12・25・27）
 * 典拠：図/画面詳細図「連絡帳（クラス）画面」(8-1) 項目13・「連絡帳（園児）画面」(8-2) 項目10・「連絡帳画面」(8-3) 項目10、
 *      基本設計書「排せつ・体温の記録」(4-5)、要件定義書「家庭から」(4-2-2)。文はどれも【仮置き】（web/仮置き値.md）
 *
 * 画面はモック（api/mock.ts）が相手。時計は今日の 18:00（tests/setup-clock.ts）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
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

afterEach(cleanup);

const CALL_FIRST = '記録すると保護者に数字が出ます。お電話するときは、先にお電話を';
const WRITTEN_REQUEST = 'お薬・食事の除去のご依頼は、書面で担任へお渡しください';

describe('職員の体温の入力欄の近くの固定の文（直-12・25）', () => {
  it('連絡帳（クラス）画面：「＋体温」で開く体温の一覧に出す', async () => {
    open('/staff/contact', teacher);
    fireEvent.click(await screen.findByRole('button', { name: '上園 花子の体温を記録する' }, { timeout: 3000 }));
    const dialog = screen.getByRole('dialog', { name: '上園 花子の体温' });
    expect(within(dialog).getByText(CALL_FIRST)).toBeTruthy();
  });

  it('連絡帳（園児）画面：「体温を記録する」で開く体温の一覧に出す', async () => {
    open('/staff/contact/C001', teacher);
    fireEvent.click(await screen.findByRole('button', { name: '体温を記録する' }, { timeout: 3000 }));
    const dialog = screen.getByRole('dialog', { name: '野原 太郎の体温' });
    expect(within(dialog).getByText(CALL_FIRST)).toBeTruthy();
  });
});

describe('保護者の連絡事項の近くの文（直-27）', () => {
  it('家庭からの連絡事項の欄の近くに常に出し、欄の説明にする。保護者の体温の一覧には職員向けの文を出さない', async () => {
    open('/guardian/contact/C001', guardian);
    await screen.findByText('野原 太郎の連絡帳', undefined, { timeout: 3000 });
    const form = document.querySelector<HTMLFormElement>('.contact-home-form')!;
    // 何も書いていなくても出ている（入力の有無で出し分けない）
    const textarea = within(form).getByRole('textbox', { name: /連絡事項/ }) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    const note = document.getElementById(textarea.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toBe(WRITTEN_REQUEST);
    expect(form.contains(note)).toBe(true);

    fireEvent.click(within(form).getByRole('button', { name: '体温を入れる' }));
    const dialog = screen.getByRole('dialog', { name: '体温' });
    expect(within(dialog).queryByText(CALL_FIRST)).toBeNull();
  });
});
