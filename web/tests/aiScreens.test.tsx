// @vitest-environment jsdom
/*
 * 連絡帳（園児）画面の AI の下書きと、設定画面の AI の区画
 * 典拠：詳細設計書「画面」(8-9)・「キーが無い・無効・有効にしていないときの画面」(8-8)・「設定画面（管理者）」(2-14 (5))・
 *      「テストの観点」(9-1) の「AI 無しで動く」「AI の失敗」、基本設計書「文章の下書き（AI）」(4-11)
 *
 * 画面はモック（api/mock.ts）が相手で、外部へはつながない。時計は今日の 18:00。mockDb はこのファイルのテストで使い回す。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';
import { api } from '../src/api/client';
import { mockAi } from '../src/api/mock';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import { AI_TEXT, MSG } from '../src/messages';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 園長',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
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
const setSetting = (key: string, value: string) => { db.settings.find((s) => s.setting_key === key)!.setting_value = value; };
const facilitySection = () => document.getElementById('facility') as HTMLElement;
const recordAside = () => screen.getByRole('complementary', { name: '記録する' });
const clearFacility = (child: string) => {
  for (const f of db.contactFacilities) if (f.child_id === child && f.contact_date === today()) f.is_deleted = true;
};

beforeEach(() => {
  Object.assign(mockAi, { mode: 'ok', keyPresent: true, keyRejected: false, lastSent: null, calls: 0 });
  setSetting('ai.daily_limit', '300');
});
afterEach(() => {
  cleanup();
  setSetting('ai.enabled', '0');
  Object.assign(mockAi, { mode: 'ok', keyPresent: true, keyRejected: false });
});

describe('連絡帳（園児）画面：AI の下書き', () => {
  it('AI 無しで動く：園が有効にしていない（既定）・キーが無いときはボタンを出さず、定型文と手書きで送れる', async () => {
    clearFacility('C005');
    setSetting('ai.enabled', '0');
    open('/staff/contact/C005', teacher);
    await screen.findByRole('heading', { name: '金城 陸' }, { timeout: 3000 });
    await waitFor(() => expect(within(facilitySection()).getByRole('button', { name: '定型文' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: AI_TEXT.draftButton })).toBeNull();
    expect(screen.queryByRole('button', { name: AI_TEXT.rephraseButton })).toBeNull();
    cleanup();

    setSetting('ai.enabled', '1');
    mockAi.keyPresent = false;
    open('/staff/contact/C005', teacher);
    await screen.findByRole('heading', { name: '金城 陸' }, { timeout: 3000 });
    const box = within(facilitySection()).getByLabelText('園からのひとこと') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'お迎えのときに、くわしくお話しします。' } });
    fireEvent.click(within(facilitySection()).getByRole('button', { name: '送る' }));
    await waitFor(async () => expect((await api.contactPage(teacher, 'C005')).facility?.body).toBe('お迎えのときに、くわしくお話しします。'), { timeout: 3000 });
    expect(screen.queryByRole('button', { name: AI_TEXT.draftButton })).toBeNull();
    expect(mockAi.calls).toBe(0);
  });

  it('保護者がまだ同意していない子（上園）には、ボタンを出さない（理由も出さない）', async () => {
    clearFacility('C002');
    setSetting('ai.enabled', '1');
    open('/staff/contact/C002', teacher);
    await screen.findByRole('heading', { name: '上園 花子' }, { timeout: 3000 });
    await waitFor(() => expect(within(facilitySection()).getByRole('button', { name: '定型文' })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByRole('button', { name: AI_TEXT.draftButton })).toBeNull();
  });

  it('メモから下書きを作ると、空の欄にそのまま入り、確かめてから送る旨とほかの子の名前を置き換えた旨が出る。送るのは職員', async () => {
    clearFacility('C001');
    setSetting('ai.enabled', '1');
    open('/staff/contact/C001', teacher);
    await screen.findByRole('heading', { name: '野原 太郎' }, { timeout: 3000 });
    const section = facilitySection();
    fireEvent.click(await within(section).findByRole('button', { name: AI_TEXT.draftButton }, { timeout: 3000 }));
    expect(within(section).getByText(AI_TEXT.memoNote)).toBeTruthy();
    fireEvent.change(within(section).getByLabelText(/^メモ/), { target: { value: '美咲ちゃんとしゃぼん玉を追いかけた' } });
    fireEvent.click(within(section).getByRole('button', { name: AI_TEXT.makeDraft }));
    const box = within(section).getByLabelText('園からのひとこと') as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toMatch(/^たっくんの、きょうのようすをお伝えします。おともだちとしゃぼん玉を追いかけた。/), { timeout: 3000 });
    expect(within(section).getByText(AI_TEXT.checkBeforeSend)).toBeTruthy();
    expect(within(section).getByText(AI_TEXT.replacedOthers)).toBeTruthy();
    // 外部へ送った文に、宛先の名前もほかの子の名前も無い
    expect(mockAi.lastSent!.user).not.toMatch(/野原|太郎|たっくん|美咲|宮城/);
    // 勝手には送らない。保護者の連絡帳にはまだ無い
    expect((await api.contactPage(guardian, 'C001')).facility).toBeNull();
    const draft = box.value;
    fireEvent.click(within(section).getByRole('button', { name: '送る' }));
    await waitFor(async () => expect((await api.contactPage(guardian, 'C001')).facility?.body).toBe(draft), { timeout: 3000 });
  });

  it('欄に文があれば置き換えずに候補として出し、「この文を使う」で入れる。言い換え・続きは文があるときだけ押せる', async () => {
    setSetting('ai.enabled', '1');
    open('/staff/contact/C001', teacher);
    await screen.findByRole('heading', { name: '野原 太郎' }, { timeout: 3000 });
    const aside = recordAside();
    const rephrase = await within(aside).findByRole('button', { name: AI_TEXT.rephraseButton }, { timeout: 3000 }) as HTMLButtonElement;
    const cont = within(aside).getByRole('button', { name: AI_TEXT.continueButton }) as HTMLButtonElement;
    expect([rephrase.disabled, cont.disabled]).toEqual([true, true]);
    // 活動のひとことには「AI で下書き」を出さない（言い換え・続きだけ）
    expect(within(aside).queryByRole('button', { name: AI_TEXT.draftButton })).toBeNull();

    const box = within(aside).getByLabelText('活動のひとこと') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'たっくんは砂場で遊んでいました。スコップで型抜きをしました。' } });
    fireEvent.click(within(aside).getByRole('button', { name: AI_TEXT.rephraseButton }));
    const cards = await within(aside).findAllByRole('button', { name: AI_TEXT.useThis }, { timeout: 3000 });
    expect(cards).toHaveLength(3);
    // 置き換えずに候補として出す（欄の文はそのまま）
    expect(box.value).toBe('たっくんは砂場で遊んでいました。スコップで型抜きをしました。');
    fireEvent.click(cards[1]);
    expect(box.value).toBe('たっくんは砂場で遊んでいました。');
    expect(within(aside).getByText(AI_TEXT.checkBeforeSend)).toBeTruthy();

    // 続き：選ぶと欄の終わりに足す
    fireEvent.click(within(aside).getByRole('button', { name: AI_TEXT.continueButton }));
    const more = await within(aside).findAllByRole('button', { name: AI_TEXT.useThis }, { timeout: 3000 });
    fireEvent.click(more[0]);
    expect(box.value).toBe('たっくんは砂場で遊んでいました。おうちでも聞いてみてください。');
  });

  it('失敗したら応答の文をパネルに出し、入力欄の文は残す。上限に達したら上限の文を出す', async () => {
    setSetting('ai.enabled', '1');
    open('/staff/contact/C001', teacher);
    await screen.findByRole('heading', { name: '野原 太郎' }, { timeout: 3000 });
    const aside = recordAside();
    const box = within(aside).getByLabelText('活動のひとこと') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '砂場で遊びました。' } });
    mockAi.mode = 'fail';
    fireEvent.click(await within(aside).findByRole('button', { name: AI_TEXT.rephraseButton }, { timeout: 3000 }));
    await within(aside).findByText(MSG.aiFailed, undefined, { timeout: 3000 });
    expect(box.value).toBe('砂場で遊びました。');

    mockAi.mode = 'limit';
    fireEvent.click(within(aside).getByRole('button', { name: AI_TEXT.continueButton }));
    await within(aside).findByText(MSG.aiLimit, undefined, { timeout: 3000 });
    expect(box.value).toBe('砂場で遊びました。');
    // 上限に達してもボタンは出したまま（決めたこと D-9）
    expect(within(aside).getByRole('button', { name: AI_TEXT.rephraseButton })).toBeTruthy();
  });

  it('押せるものは 44px 以上の部品（contact-pick）で、作っている間は二度押しを止める', async () => {
    setSetting('ai.enabled', '1');
    open('/staff/contact/C001', teacher);
    await screen.findByRole('heading', { name: '野原 太郎' }, { timeout: 3000 });
    const aside = recordAside();
    const box = within(aside).getByLabelText('活動のひとこと') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '砂場で遊びました。' } });
    const rephrase = await within(aside).findByRole('button', { name: AI_TEXT.rephraseButton }, { timeout: 3000 }) as HTMLButtonElement;
    expect(rephrase.className).toContain('contact-pick');
    fireEvent.click(rephrase);
    expect(within(aside).getByRole('status').textContent).toContain(AI_TEXT.making);
    expect(rephrase.disabled).toBe(true);
    // 作っている間も入力欄は書ける
    expect(box.disabled).toBe(false);
    await within(aside).findAllByRole('button', { name: AI_TEXT.useThis }, { timeout: 3000 });
    expect(mockAi.calls).toBe(1);
  });
});

describe('設定画面：AI の区画', () => {
  it('キーの有無を示し、有効にするときは確認のダイアログに変更の前後と施行の注意を出して保存する', async () => {
    setSetting('ai.enabled', '0');
    mockAi.keyPresent = false;
    open('/staff/admin/settings', admin);
    await screen.findByRole('heading', { name: 'AI の下書き' }, { timeout: 3000 });
    expect(screen.getByText(AI_TEXT.noKey)).toBeTruthy();
    cleanup();

    mockAi.keyPresent = true;
    open('/staff/admin/settings', admin);
    await screen.findByRole('heading', { name: 'AI の下書き' }, { timeout: 3000 });
    expect(screen.queryByText(AI_TEXT.noKey)).toBeNull();
    const save = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '使う' }));
    fireEvent.change(screen.getByLabelText('1日の上限回数（園全体）'), { target: { value: '50' } });
    fireEvent.click(save);
    const dialog = await screen.findByRole('dialog', { name: '設定を保存しますか' });
    expect(dialog.textContent).toContain('AI の下書きを使う：使わない → 使う');
    expect(dialog.textContent).toContain('1日の上限回数：300 → 50');
    expect(dialog.textContent).toContain(AI_TEXT.enableConfirm);
    fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(screen.getAllByText(AI_TEXT.saved).length).toBeGreaterThan(0), { timeout: 3000 });
    expect(db.settings.find((s) => s.setting_key === 'ai.enabled')!.setting_value).toBe('1');
    expect(db.settings.find((s) => s.setting_key === 'ai.daily_limit')!.setting_value).toBe('50');
  });

  it('上限回数の誤りは入力欄の近くに出し、入れた値は残す', async () => {
    open('/staff/admin/settings', admin);
    await screen.findByRole('heading', { name: 'AI の下書き' }, { timeout: 3000 });
    const input = screen.getByLabelText('1日の上限回数（園全体）') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '保存する' }));
    await screen.findByText(MSG.settingAiDailyLimit, undefined, { timeout: 3000 });
    expect(input.value).toBe('0');
  });

  it('一般の職員がアドレスから開いても、設定画面は出ない', async () => {
    open('/staff/admin/settings', teacher);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'AI の下書き' })).toBeNull());
    await screen.findByText(/管理者/, undefined, { timeout: 3000 });
  });
});
