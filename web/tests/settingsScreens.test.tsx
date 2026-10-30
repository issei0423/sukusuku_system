// @vitest-environment jsdom
/*
 * 設定画面の連絡帳の区画と「そのほかの設定値」の区画
 * 典拠：詳細設計書「設定画面（管理者）」(2-14 (1)(2)(4)(7))・「設定」(4-10)、決めたこと D-42・D-46
 *
 * 画面はモック（api/mock.ts）が相手。時計は今日の 18:00。mockDb はこのファイルのテストで使い回すので、テストごとに設定を元へ戻す。
 * AI の区画は aiScreens.test.tsx。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';
import * as db from '../src/api/mockDb';
import { SETTINGS_TEXT } from '../src/messages';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 園長',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

function open() {
  return render(
    <MemoryRouter initialEntries={['/staff/admin/settings']}>
      <SessionProvider initialUser={admin}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}
const valueOf = (key: string) => db.settings.find((s) => s.setting_key === key)!.setting_value;

let snapshot: typeof db.settings;
beforeEach(() => { snapshot = structuredClone(db.settings); });
afterEach(() => {
  cleanup();
  db.settings.splice(0, db.settings.length, ...snapshot);
});

const loaded = () => screen.findByRole('heading', { name: '連絡帳', level: 2 }, { timeout: 3000 });
const saveButton = () => screen.getByRole('button', { name: '保存する' });
async function confirmSave() {
  fireEvent.click(saveButton());
  const dialog = await screen.findByRole('dialog', { name: '設定を保存しますか' });
  return dialog;
}

describe('設定画面：連絡帳・AI・そのほかの設定値が1つの画面に並び、「保存する」は1つ', () => {
  it('区画と、連絡帳の項目・選択肢・そのほかの欄が出る。通知の区画は出さない（Web Push を作らないあいだ）', async () => {
    open();
    await loaded();
    for (const name of ['AI の下書き', 'そのほかの設定値']) expect(screen.getByRole('heading', { name, level: 2 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /通知/, level: 2 })).toBeNull();
    expect(screen.getAllByRole('button', { name: '保存する' })).toHaveLength(1);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    for (const name of ['午睡', '食事', '排せつ', '体温', '活動のひとこと', '写真', 'クラスのようす']) {
      expect((screen.getAllByRole('checkbox', { name, exact: true })[0] as HTMLInputElement).checked, name).toBe(true);
    }
    expect((screen.getByRole('textbox', { name: '排せつの選択肢 1' }) as HTMLInputElement).value).toBe('おしっこ');
    expect((screen.getByRole('spinbutton', { name: '発達チェックの予定日が近いとする日数' }) as HTMLInputElement).value).toBe('7');
    expect((screen.getByRole('spinbutton', { name: '午睡のチェック間隔（0歳児）' }) as HTMLInputElement).value).toBe('5');
    // 読むだけの行には、変える欄が無く、理由が添う
    expect(screen.queryByRole('textbox', { name: '添付の対応形式' })).toBeNull();
    expect(screen.getByText('共有範囲の設定の画面で変えます。')).toBeTruthy();
  });

  it('連絡帳：保護者へ出す項目を外して保存すると、確認の窓に前後が並び、保存される（0個でもよい）', async () => {
    open();
    await loaded();
    fireEvent.click(screen.getAllByRole('checkbox', { name: '写真', exact: true })[0]);
    const dialog = await confirmSave();
    expect(dialog.textContent).toContain('保護者へ出すきょうのようすの項目：午睡、食事、排せつ、体温、活動のひとこと、写真、クラスのようす → 午睡、食事、排せつ、体温、活動のひとこと、クラスのようす');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(valueOf('contact.show_items')).toBe('nap,meal,toilet,temperature,comment,class'));
    // 画面の「保存しました。」（settings-saved）と通知の 2 か所に出る
    expect((await screen.findAllByText('保存しました。', undefined, { timeout: 3000 })).length).toBeGreaterThanOrEqual(1);
  });

  it('連絡帳：「家庭から」の項目を全部外すと断られ、入力は残る。選択肢は足す・上へ・消すができる', async () => {
    open();
    await loaded();
    const home = screen.getByRole('group', { name: '「家庭から」の項目' });
    for (const box of within(home).getAllByRole('checkbox')) fireEvent.click(box);
    let dialog = await confirmSave();
    fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }));
    await screen.findByText('「家庭から」の項目は、1つ以上選んでください。', undefined, { timeout: 3000 });
    expect(valueOf('contact.home_items')).toBe('temperature,night_sleep,breakfast,mood,pickup,message');
    expect(within(home).getAllByRole('checkbox').every((b) => !(b as HTMLInputElement).checked)).toBe(true);
    // 戻して、排せつの選択肢を直す
    fireEvent.click(within(home).getByRole('checkbox', { name: '連絡事項' }));
    fireEvent.click(screen.getByRole('button', { name: '排せつの選択肢 4 を消す' }));
    fireEvent.click(screen.getByRole('button', { name: '排せつの選択肢 2 を上へ' }));
    fireEvent.click(screen.getAllByRole('button', { name: '＋ 足す' })[0]);
    fireEvent.change(screen.getByRole('textbox', { name: '排せつの選択肢 4' }), { target: { value: 'ほか,と' } });
    dialog = await confirmSave();
    fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(valueOf('contact.toilet_choices')).toBe('うんち,おしっこ,おむつ交換,ほかと'));
    expect(valueOf('contact.home_items')).toBe('message');
  });

  it('そのほか：午睡のチェック間隔を既定より長くすると、確認の窓に注意が出るが止めない', async () => {
    open();
    await loaded();
    fireEvent.change(screen.getByRole('spinbutton', { name: '午睡のチェック間隔（0歳児）' }), { target: { value: '15' } });
    const dialog = await confirmSave();
    expect(dialog.textContent).toContain(SETTINGS_TEXT.longInterval);
    expect(dialog.textContent).toContain('午睡のチェック間隔（0歳児）：5 分 → 15 分');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(valueOf('nap.interval_minutes.age0')).toBe('15'));
  });

  it('そのほか：範囲の外は行の近くに「〇〇は△△で入力してください。」を出して書かない。短い間隔には注意を出さない', async () => {
    open();
    await loaded();
    fireEvent.change(screen.getByRole('spinbutton', { name: '午睡のチェック間隔（0歳児）' }), { target: { value: '16' } });
    fireEvent.change(screen.getByRole('textbox', { name: '午睡の時間帯' }), { target: { value: '15:00-13:00' } });
    const dialog = await confirmSave();
    fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }));
    await screen.findByText('午睡のチェック間隔（0歳児）は1〜15の整数で入力してください。', undefined, { timeout: 3000 });
    expect(valueOf('nap.interval_minutes.age0')).toBe('5');
    expect(valueOf('nap.time_range')).toBe('13:00-15:00');
    expect((screen.getByRole('textbox', { name: '午睡の時間帯' }) as HTMLInputElement).value).toBe('15:00-13:00');
    // 直して送り直す。既定より短い間隔なら、注意は出ない
    fireEvent.change(screen.getByRole('spinbutton', { name: '午睡のチェック間隔（0歳児）' }), { target: { value: '3' } });
    fireEvent.change(screen.getByRole('textbox', { name: '午睡の時間帯' }), { target: { value: '12:30-15:00' } });
    const again = await confirmSave();
    expect(again.textContent).not.toContain(SETTINGS_TEXT.longInterval);
    fireEvent.click(within(again).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(valueOf('nap.interval_minutes.age0')).toBe('3'));
    expect(valueOf('nap.time_range')).toBe('12:30-15:00');
  });
});
