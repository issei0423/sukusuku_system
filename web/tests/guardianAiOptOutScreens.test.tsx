// @vitest-environment jsdom
/*
 * 保護者のメニューの「AI の下書きの利用」（画面）
 * 典拠：詳細設計書「メニューの項目」(2-15 (1))・「AI の下書きの利用」(2-15 (4))、
 *      図/画面詳細図「保護者（スマートフォン）」(1-2) の項目18・「AI の下書きの利用（保護者のメニュー）」(1-3 (10))
 *
 * 相手はモック（api/mock.ts）。規則そのものは tests/guardianAiOptOut.test.ts と server/api_guardian_ai_test.go で確かめる。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as db from '../src/api/mockDb';
import { AI_OPT_OUT_TEXT } from '../src/messages';
import type { SessionUser } from '../src/api/types';

const guardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

const setSetting = (key: string, value: string) => {
  db.settings.find((s) => s.setting_key === key)!.setting_value = value;
};
const link = (g: string, c: string) => db.guardianChildren.find((x) => x.guardian_id === g && x.child_id === c);
const removeLink = (g: string, c: string) => {
  const i = db.guardianChildren.findIndex((x) => x.guardian_id === g && x.child_id === c);
  if (i >= 0) db.guardianChildren.splice(i, 1);
};

function openHome() {
  return render(
    <MemoryRouter initialEntries={['/guardian']}>
      <SessionProvider initialUser={guardian}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

/** メニューを開き、区画を読み終えるまで待つ（利用者名に園児名が出る） */
async function openMenu() {
  fireEvent.click(await screen.findByRole('button', { name: 'メニューを開く' }));
  const menu = screen.getByRole('dialog', { name: 'メニュー' });
  await within(menu).findByText(/野原 太郎/, {}, { timeout: 3000 });
  return menu;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setSetting('ai.enabled', '0');
  Object.assign(link('G001', 'C001')!, { ai_opt_out: false });
  removeLink('G001', 'C006');
  removeLink('G001', 'C007');
});

describe('保護者のメニュー：AI の下書きの利用', () => {
  it('園が AI を有効にしていないときは、メニューに置かない', async () => {
    setSetting('ai.enabled', '0');
    openHome();
    const menu = await openMenu();
    expect(within(menu).queryByRole('button', { name: AI_OPT_OUT_TEXT.title })).toBeNull();
  });

  it('有効なら置き、押すとダイアログ。確認を挟まずに切り替えて保存し、結果を出す。押し直せば戻る', async () => {
    setSetting('ai.enabled', '1');
    openHome();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('button', { name: AI_OPT_OUT_TEXT.title }));

    const dialog = await screen.findByRole('dialog', { name: AI_OPT_OUT_TEXT.title });
    expect(dialog.textContent).toContain(AI_OPT_OUT_TEXT.explain);
    const box = within(dialog).getByRole('checkbox', { name: AI_OPT_OUT_TEXT.label('野原 太郎') }) as HTMLInputElement;
    expect(box.checked).toBe(false);

    fireEvent.click(box);
    expect(await screen.findByText(AI_OPT_OUT_TEXT.optedOut('野原 太郎'))).toBeTruthy();
    expect(link('G001', 'C001')!.ai_opt_out).toBe(true);
    await waitFor(() => expect(box.checked).toBe(true));
    // 確認のダイアログは出さない（2-15 (4)）
    expect(screen.queryByRole('button', { name: 'やめる' })).toBeNull();

    fireEvent.click(box);
    expect(await screen.findByText(AI_OPT_OUT_TEXT.optedIn)).toBeTruthy();
    expect(link('G001', 'C001')!.ai_opt_out).toBe(false);
    await waitFor(() => expect(box.checked).toBe(false));
  });

  it('きょうだいは園児ごとに並べ、紐づけが有効な子だけ。初期値は自分の紐づけの値', async () => {
    setSetting('ai.enabled', '1');
    link('G001', 'C001')!.ai_opt_out = true;
    // 有効なきょうだい（伊藤 葵）と、猶予中のきょうだい（中村 蓮）
    db.guardianChildren.push({ guardian_id: 'G001', child_id: 'C006', relationship: '父', link_status: '1', linked_at: '2026-04-01T09:00:00', ended_at: null });
    db.guardianChildren.push({ guardian_id: 'G001', child_id: 'C007', relationship: '父', link_status: '3', linked_at: '2026-04-01T09:00:00', ended_at: null, grace_ends_on: '2099-03-31' });
    openHome();
    const menu = await openMenu();
    await within(menu).findByText(/中村 蓮/);
    fireEvent.click(within(menu).getByRole('button', { name: AI_OPT_OUT_TEXT.title }));

    const dialog = await screen.findByRole('dialog', { name: AI_OPT_OUT_TEXT.title });
    const boxes = within(dialog).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.closest('label')?.textContent)).toEqual([
      AI_OPT_OUT_TEXT.label('伊藤 葵'), AI_OPT_OUT_TEXT.label('野原 太郎'),
    ]);
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);

    // 片方だけ断る
    fireEvent.click(boxes[0]);
    expect(await screen.findByText(AI_OPT_OUT_TEXT.optedOut('伊藤 葵'))).toBeTruthy();
    expect(link('G001', 'C006')!.ai_opt_out).toBe(true);
    expect(link('G001', 'C001')!.ai_opt_out).toBe(true);
  });
});
