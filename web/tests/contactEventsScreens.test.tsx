// @vitest-environment jsdom
/*
 * 連絡帳の画面で、食事・排せつ・体温を記録し、直す・取り消す
 * 典拠：詳細設計書「連絡帳（クラス）画面」(2-2)・「連絡帳（園児）画面」(2-3)・「押したときの処理の型」(2-0 (2))・
 *      「テストの観点」(9-1)（楽観的更新をしない・判断しないこと・状態の遷移）、図/画面詳細図「取り消し・削除の確認」(1-3 (4))
 *
 * 画面はモック（api/mock.ts）が相手。時計は今日の 18:00（tests/setup-clock.ts）。mockDb はこのファイルのテストで使い回す。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { addDays, today } from '../src/api/util';

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
const admin: SessionUser = { ...teacher, account_id: 1, role: '1', staff_id: 'S001', class_id: null, class_name: null, display_name: '野原 一誠' };

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

const toast = () => document.querySelector('.toast');

describe('連絡帳（クラス）画面：記録する', () => {
  it('排せつは行のボタン1タップで記録し、結果に「取り消す」を添える。保護者のページにその時点で入る', async () => {
    open('/staff/contact', teacher);
    const button = await screen.findByRole('button', { name: '野原 太郎の排せつ うんち' }, { timeout: 3000 });
    const before = (await api.contactPage(guardian, 'C001')).events.filter((e) => e.toilet_label === 'うんち').length;
    fireEvent.click(button); // 1
    // 押したら応答を待ってから結果を出す（楽観的更新をしない）
    await waitFor(() => expect(toast()?.textContent).toContain('野原 太郎さんの「うんち」を記録しました。保護者が見られる状態です。'), { timeout: 3000 });
    expect(within(toast() as HTMLElement).getByRole('button', { name: '取り消す' })).toBeTruthy();
    const after = (await api.contactPage(guardian, 'C001')).events.filter((e) => e.toilet_label === 'うんち').length;
    expect(after).toBe(before + 1);
    // 読み上げの名前に、見えている「n回／」も入れている（WCAG 2.5.3）
    await waitFor(() => expect(screen.getByRole('button', { name: /野原 太郎の排せつ \d+回／うんち \d{2}:\d{2} を直す・取り消す/ })).toBeTruthy(), { timeout: 3000 });

    // 結果の「取り消す」→ いま読んでいる家庭の数を確かめてから取り消す
    fireEvent.click(within(toast() as HTMLElement).getByRole('button', { name: '取り消す' }));
    const dialog = await screen.findByRole('dialog', { name: 'この記録を取り消しますか' });
    await within(dialog).findByText(/いま保護者 \d+ 家庭（\d+ 名）が読んでいます。取り消しても、読まれた内容は取り消せません。/, undefined, { timeout: 3000 });
    fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(toast()?.textContent).toContain('取り消しました'), { timeout: 3000 });
    expect((await api.contactPage(guardian, 'C001')).events.filter((e) => e.toilet_label === 'うんち').length).toBe(before);
  });

  it('体温は「＋体温」→ 値の2タップで記録する。値に判定の言葉や色を付けない', async () => {
    open('/staff/contact', teacher);
    fireEvent.click(await screen.findByRole('button', { name: '上園 花子の体温を記録する' }, { timeout: 3000 })); // 1
    const dialog = screen.getByRole('dialog', { name: '上園 花子の体温' });
    // 一覧は 35.0〜39.9。平熱（36.8）の位置から開く
    expect(within(dialog).getAllByRole('button').filter((b) => /^\d{2}\.\d$/.test(b.textContent ?? ''))).toHaveLength(50);
    expect(within(dialog).getByRole('button', { name: '36.8' }).classList.contains('is-origin')).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '38.5' })); // 2
    await waitFor(() => expect(toast()?.textContent).toContain('上園 花子さんの「38.5℃」を記録しました。'), { timeout: 3000 });
    const cell = (await screen.findByRole('button', { name: /上園 花子の体温 38\.5℃/ }, { timeout: 3000 })).closest('td')!;
    expect(cell.textContent).toContain('平熱 36.8');
    expect(cell.textContent).not.toMatch(/発熱|高い|低い|異常|注意/);
  });

  it('体温の「ほかの値」は範囲の外も確かめを促してから記録する（止めない）', async () => {
    open('/staff/contact', teacher);
    fireEvent.click(await screen.findByRole('button', { name: '高梨 健の体温を記録する' }, { timeout: 3000 }));
    const dialog = screen.getByRole('dialog', { name: '高梨 健の体温' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'ほかの値' }));
    fireEvent.change(within(dialog).getByLabelText('ほかの値（℃）'), { target: { value: '29.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('入力値が通常の範囲外です。測定値に誤りがないか確認してください。');
    fireEvent.click(within(dialog).getByRole('button', { name: 'このまま記録する' }));
    await waitFor(() => expect(toast()?.textContent).toContain('高梨 健さんの「29.5℃」を記録しました。'), { timeout: 3000 });
  });

  it('全員ぜんぶ：記録の無い行に「ぜんぶ」を仮に入れ、お休みの子を外し、違う子を直してから「記録する」。仮の値は保存しない', async () => {
    for (const e of db.contactEvents) if (e.contact_date === today() && e.meal_kind === '2') e.is_deleted = true;
    open('/staff/contact', teacher);
    fireEvent.click(await screen.findByRole('button', { name: 'おやつ' }, { timeout: 3000 }));
    fireEvent.click(screen.getByRole('button', { name: '全員ぜんぶ' })); // 1
    expect(document.querySelector('.contact-meal-tentative')?.textContent).toBe('12人に「ぜんぶ」が入っています。違う子・お休みの子を行で直してから「記録する」を押してください。');
    // 仮の値は保存していない（保護者に届かない）
    expect((await api.contactPage(guardian, 'C001')).events.some((e) => e.meal_kind === '2')).toBe(false);
    // お休みの子：仮の「ぜんぶ」をもう一度押すと外れる。違う子：別の量を押す
    fireEvent.click(screen.getByRole('button', { name: '高梨 健のおやつをぜんぶ（仮）' }));
    fireEvent.click(screen.getByRole('button', { name: '上園 花子のおやつを半分' }));
    expect(document.querySelector('.contact-meal-tentative')?.textContent).toContain('11人に「ぜんぶ」');
    // 区分を替えるときは、仮の値を捨ててよいかを確かめる
    fireEvent.click(screen.getByRole('button', { name: '給食' }));
    expect(screen.getByText(/仮に入れた「ぜんぶ」は保存していません。/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '戻る' }));
    fireEvent.click(screen.getByRole('button', { name: '記録する' })); // 2
    await waitFor(() => expect(toast()?.textContent).toContain('11人のおやつを記録しました。保護者が見られる状態です。'), { timeout: 3000 });
    const snacks = db.contactEvents.filter((e) => e.contact_date === today() && e.meal_kind === '2' && !e.is_deleted);
    expect(snacks.some((e) => e.child_id === 'C003')).toBe(false);
    expect(snacks.find((e) => e.child_id === 'C002')?.meal_amount).toBe('2');
    // 記録のある行で別の量を押すと訂正（1タップ）。保護者に「訂正しました」が出る
    fireEvent.click(await screen.findByRole('button', { name: '野原 太郎のおやつを少し' }, { timeout: 3000 }));
    await waitFor(() => expect(toast()?.textContent).toContain('野原 太郎さんのおやつを「少し」に直しました。'), { timeout: 3000 });
    const fixed = (await api.contactPage(guardian, 'C001')).events.find((e) => e.meal_kind === '2')!;
    expect([fixed.meal_amount, fixed.corrected_at !== null]).toEqual(['3', true]);
    // おやつの記録があると「おやつ（2回目）」が出る
    expect(screen.getByRole('button', { name: 'おやつ（2回目）' })).toBeTruthy();
  });

  it('記録した値を押すと「直す」「取り消す」。取り消すと、いま読んでいる家庭の数を確かめてから消す', async () => {
    await api.recordEvents(teacher, [{ child_id: 'C004', event_type: '2', toilet_label: 'おしっこ' }]);
    open('/staff/contact', teacher);
    fireEvent.click(await screen.findByRole('button', { name: /宮城 美咲の排せつ \d+回／おしっこ \d{2}:\d{2} を直す・取り消す/ }, { timeout: 3000 }));
    const dialog = screen.getByRole('dialog', { name: '記録を直す' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'トイレでできた' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '直す' }));
    await waitFor(() => expect(toast()?.textContent).toContain('直しました（宮城 美咲）'), { timeout: 3000 });
    const misaki: SessionUser = { ...guardian, account_id: 9, guardian_id: 'G004' };
    expect((await api.contactPage(misaki, 'C004')).events.some((e) => e.toilet_label === 'トイレでできた' && e.corrected_at)).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: /宮城 美咲の排せつ \d+回／トイレでできた \d{2}:\d{2} を直す・取り消す/ }, { timeout: 3000 }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '記録を直す' })).getByRole('button', { name: 'この記録を取り消す' }));
    const confirm = screen.getByRole('dialog', { name: 'この記録を取り消しますか' });
    await within(confirm).findByText('いま保護者 0 家庭（0 名）が読んでいます。取り消しても、読まれた内容は取り消せません。', undefined, { timeout: 3000 });
    fireEvent.click(within(confirm).getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(toast()?.textContent).toContain('取り消しました'), { timeout: 3000 });
    expect((await api.contactPage(misaki, 'C004')).events.some((e) => e.toilet_label === 'トイレでできた')).toBe(false);
  });

  it('前の日のページには記録の部品を出さない', async () => {
    open(`/staff/contact?date=${addDays(today(), -1)}`, teacher);
    await screen.findByText('前の日のページです。記録を足すことはできません。', undefined, { timeout: 3000 });
    expect(screen.queryByRole('button', { name: '全員ぜんぶ' })).toBeNull();
    expect(screen.queryByRole('button', { name: '野原 太郎の排せつ おしっこ' })).toBeNull();
  });
});

describe('連絡帳（園児）画面', () => {
  it('1日のページに記録した職員を出し、排せつを時刻を付けて記録できる（2タップ＋時刻）。行から直す・取り消す', async () => {
    open('/staff/contact/C001', teacher);
    await screen.findByRole('heading', { name: '野原 太郎' }, { timeout: 3000 });
    const time = screen.getByLabelText('時刻（排せつ・体温）');
    fireEvent.change(time, { target: { value: '00:05' } }); // ＋1（その日の0時からいままで）
    fireEvent.click(within(screen.getByRole('group', { name: '排せつ' })).getByRole('button', { name: 'おむつ交換' })); // 2
    await waitFor(() => expect(toast()?.textContent).toContain('野原 太郎さんの「おむつ交換」（00:05）を記録しました。保護者が見られる状態です。'), { timeout: 3000 });
    const row = await waitFor(() => {
      const found = [...document.querySelectorAll('.contact-timeline-text')].find((el) => (el.textContent ?? '').startsWith('おむつ交換'));
      if (!found) throw new Error('おむつ交換の行が無い');
      return found;
    }, { timeout: 3000 });
    expect(row.closest('li')?.textContent).toContain('高梨 倫太朗');
    fireEvent.click(within(row.closest('li')!).getByRole('button', { name: /を直す・取り消す/ }));
    expect(screen.getByRole('dialog', { name: '記録を直す' })).toBeTruthy();
  });

  it('ほかのクラスの担任は開けない。管理者は前の日も直せるが、前の日には記録を足せない', async () => {
    const kinjo: SessionUser = { ...teacher, account_id: 5, staff_id: 'S005', class_id: 2, class_name: 'ひまわり組', display_name: '金城 宗一郎' };
    open('/staff/contact/C001', kinjo);
    await screen.findByText('この園児の連絡帳は開けません。', undefined, { timeout: 3000 });
    cleanup();
    open(`/staff/contact/C001?date=${addDays(today(), -1)}`, admin);
    await screen.findByText('前の日のページには記録を足せません。', undefined, { timeout: 3000 });
    expect(screen.getAllByRole('button', { name: /を直す・取り消す/ }).length).toBeGreaterThan(0);
    cleanup();
    open(`/staff/contact/C001?date=${addDays(today(), -1)}`, teacher);
    await screen.findByText('翌日以降は管理者へご依頼ください', undefined, { timeout: 3000 });
    expect(screen.queryAllByRole('button', { name: /を直す・取り消す/ })).toHaveLength(0);
  });
});

describe('午睡チェック画面：ねた・おきたを直す', () => {
  it('行の「直す・取り消す」から、押し間違えた「ねた」を取り消すと、行が「まだ」に戻る', async () => {
    const active = await api.activeSession(1, today(), admin);
    if (active) await api.endSession(admin, active.nap_session_id);
    await api.startSession(teacher, 1, today());
    open('/staff/nap', teacher);
    const sleep = await screen.findByRole('button', { name: '吉田 心春のねた' }, { timeout: 3000 });
    const row = sleep.closest('.nap-record-row') as HTMLElement;
    fireEvent.click(sleep);
    await waitFor(() => expect(toast()?.textContent).toContain('吉田 心春さんの「ねた」'), { timeout: 3000 });
    expect(within(toast() as HTMLElement).getByRole('button', { name: '取り消す' })).toBeTruthy();
    fireEvent.click(await within(row).findByRole('button', { name: '吉田 心春のねた・おきたを直す・取り消す' }, { timeout: 3000 }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '記録を直す' })).getByRole('button', { name: 'この記録を取り消す' }));
    const confirm = screen.getByRole('dialog', { name: 'この記録を取り消しますか' });
    await within(confirm).findByText(/いま保護者 \d+ 家庭/, undefined, { timeout: 3000 });
    fireEvent.click(within(confirm).getByRole('button', { name: '取り消す' }));
    await within(row).findByRole('button', { name: '吉田 心春のねた' }, { timeout: 3000 });
  });
});
