// @vitest-environment jsdom
/*
 * 保護者のメニューの「お子さまの追加」（画面）
 * 典拠：詳細設計書「メニューの項目」(2-15 (1))・「お子さまの追加」(2-15 (2))、
 *      図/画面詳細図「保護者（スマートフォン）」(1-2) の項目15・「お子さまの追加（保護者のメニュー）」(1-3 (7))
 *
 * 相手はモック（api/mock.ts）。規則そのものは tests/guardianAddChild.test.ts と server/api_guardian_add_test.go で確かめる。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as db from '../src/api/mockDb';
import { ADD_CHILD_TEXT, MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';

const guardian: SessionUser = {
  account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

const link = (g: string, c: string) => db.guardianChildren.find((x) => x.guardian_id === g && x.child_id === c);

// 書き換える表の写し（mockDb は同じファイルのテストどうしで使い回される）
let saved: { links: typeof db.guardianChildren; codes: typeof db.invitationCodes; members: typeof db.chatMembers };
beforeEach(() => {
  saved = {
    links: structuredClone(db.guardianChildren), codes: structuredClone(db.invitationCodes), members: structuredClone(db.chatMembers),
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  db.guardianChildren.splice(0, db.guardianChildren.length, ...saved.links);
  db.invitationCodes.splice(0, db.invitationCodes.length, ...saved.codes);
  db.chatMembers.splice(0, db.chatMembers.length, ...saved.members);
});

function openHome() {
  return render(
    <MemoryRouter initialEntries={['/guardian']}>
      <SessionProvider initialUser={guardian}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

/** メニューを開き、「お子さまの追加」のダイアログを開く */
async function openDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'メニューを開く' }));
  const menu = screen.getByRole('dialog', { name: 'メニュー' });
  await within(menu).findAllByText(/西田 太郎/, {}, { timeout: 3000 });
  fireEvent.click(within(menu).getByRole('button', { name: ADD_CHILD_TEXT.title }));
  return screen.findByRole('dialog', { name: ADD_CHILD_TEXT.title });
}

/** 招待コードを入れて確かめる */
function verify(dialog: HTMLElement, code: string) {
  fireEvent.change(within(dialog).getByRole('textbox', { name: ADD_CHILD_TEXT.codeLabel }), { target: { value: code } });
  fireEvent.click(within(dialog).getByRole('button', { name: ADD_CHILD_TEXT.verify }));
}

describe('保護者のメニュー：お子さまの追加', () => {
  it('メニューに常に置き、コードを確かめると園児名と続柄（最初に登録したときの続柄）を出す。追加すると保護者ホームに区画が増える', async () => {
    openHome();
    expect(await screen.findByRole('region', { name: '西田 太郎さんの情報' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: '遠藤 花子さんの情報' })).toBeNull();
    const dialog = await openDialog();

    verify(dialog, 'qrst9012uvwx');
    expect(await within(dialog).findByText(ADD_CHILD_TEXT.confirm('遠藤 花子'))).toBeTruthy();
    const select = within(dialog).getByRole('combobox', { name: ADD_CHILD_TEXT.relationshipLabel }) as HTMLSelectElement;
    expect(select.value).toBe('父');

    fireEvent.change(select, { target: { value: '母' } });
    fireEvent.click(within(dialog).getByRole('button', { name: ADD_CHILD_TEXT.submit }));
    expect(await screen.findByText(ADD_CHILD_TEXT.added('遠藤 花子'))).toBeTruthy();
    // ダイアログを閉じ、保護者ホームを読み直す（その園児の区画が増える）
    await waitFor(() => expect(screen.queryByRole('dialog', { name: ADD_CHILD_TEXT.title })).toBeNull());
    expect(await screen.findByRole('region', { name: '遠藤 花子さんの情報' }, { timeout: 3000 })).toBeTruthy();
    expect(link('G001', 'C002')).toMatchObject({ link_status: '1', relationship: '母' });
  });

  it('誤り（すでに追加した園児・使用済みのコード）はダイアログの中に出し、追加の操作を出さない', async () => {
    openHome();
    const dialog = await openDialog();

    verify(dialog, 'ABCD-1234-EFGH');
    expect((await within(dialog).findByRole('alert')).textContent).toBe(MSG.childAlreadyAdded);
    expect(within(dialog).queryByRole('button', { name: ADD_CHILD_TEXT.submit })).toBeNull();

    verify(dialog, 'IJKL-5678-MNOP');
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(MSG.invitationUsed));
    expect(within(dialog).queryByRole('button', { name: ADD_CHILD_TEXT.submit })).toBeNull();
    expect(link('G001', 'C002')).toBeUndefined();
  });

  it('「その他」を選ぶと文字で20文字まで入れられ、その文字を続柄として送る', async () => {
    openHome();
    const dialog = await openDialog();
    verify(dialog, 'QRST-9012-UVWX');
    const select = await within(dialog).findByRole('combobox', { name: ADD_CHILD_TEXT.relationshipLabel });
    fireEvent.change(select, { target: { value: 'その他' } });
    const other = within(dialog).getByRole('textbox', { name: ADD_CHILD_TEXT.otherLabel }) as HTMLInputElement;
    expect(other.maxLength).toBe(20);
    fireEvent.change(other, { target: { value: 'おじ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: ADD_CHILD_TEXT.submit }));
    expect(await screen.findByText(ADD_CHILD_TEXT.added('遠藤 花子'))).toBeTruthy();
    expect(link('G001', 'C002')?.relationship).toBe('おじ');
  });

  it('最初に登録したときの続柄が選択肢に無いときは、「その他」とその文字を初期値にする', async () => {
    link('G001', 'C001')!.relationship = '叔母';
    openHome();
    const dialog = await openDialog();
    verify(dialog, 'QRST-9012-UVWX');
    const select = await within(dialog).findByRole('combobox', { name: ADD_CHILD_TEXT.relationshipLabel }) as HTMLSelectElement;
    expect(select.value).toBe('その他');
    expect((within(dialog).getByRole('textbox', { name: ADD_CHILD_TEXT.otherLabel }) as HTMLInputElement).value).toBe('叔母');
  });

  it('「やめる」で閉じ、何も追加しない', async () => {
    openHome();
    const dialog = await openDialog();
    verify(dialog, 'QRST-9012-UVWX');
    fireEvent.click(await within(dialog).findByRole('button', { name: ADD_CHILD_TEXT.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: ADD_CHILD_TEXT.title })).toBeNull());
    expect(link('G001', 'C002')).toBeUndefined();
    expect(db.invitationCodes.find((c) => c.code === 'QRST-9012-UVWX')?.status).toBe('1');
  });
});
