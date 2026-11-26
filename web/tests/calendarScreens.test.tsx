// @vitest-environment jsdom
/*
 * 行事カレンダーの画面（職員・保護者）
 * 典拠：設計書に定め無し。配布物の形に合わせた【仮置き】（web/仮置き値.md「行事カレンダーの動き」）
 *
 * 相手はモック（api/mock.ts）。規則そのものは tests/calendar.test.ts で確かめる。
 * テストの時計は日本時間の今日の 18:00 で止めてある（tests/setup-clock.ts）。mockDb は同じファイルのテストどうしで使い回される。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import { today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
// さくら組（クラス 1）の担任
const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
// 西田 太郎（C001・さくら組）の保護者
const guardian: SessionUser = {
  account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
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

const [thisY, thisM] = today().split('-').map(Number);
const nextDate = new Date(Date.UTC(thisY, thisM, 1));
const nextY = nextDate.getUTCFullYear();
const nextM = nextDate.getUTCMonth() + 1;
const monthText = (y: number, m: number) => `${y}年${m}月`;

/** 「11月10日（火）」で始まる名前の、日のボタン */
const dayButton = (m: number, d: number) => screen.getByRole('button', { name: new RegExp(`^${m}月${d}日`) });

describe('行事カレンダー：職員の画面', () => {
  it('予定を足すと、選んだ日の一覧に出る。対象の選択肢は、書ける範囲だけ', async () => {
    open('/staff/calendar', teacher);
    await screen.findByRole('heading', { level: 1, name: '行事カレンダー' });
    fireEvent.click(await screen.findByRole('button', { name: '予定を足す' }));

    const dialog = await screen.findByRole('dialog');
    // 一般職員は自クラスだけ。園全体は選べない
    const target = within(dialog).getByRole('combobox', { name: '対象' }) as HTMLSelectElement;
    expect([...target.options].map((o) => o.textContent)).toEqual(['さくら組']);

    fireEvent.change(within(dialog).getByRole('textbox', { name: '題名' }), { target: { value: '画面から足した予定' } });
    fireEvent.change(within(dialog).getByLabelText('開始の時刻'), { target: { value: '10:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '足す' }));

    // 日付の初期値は選んでいた日（今日）なので、今日の一覧に出る
    expect(await screen.findByText('画面から足した予定')).toBeTruthy();
    expect(screen.getByText('10:30 から')).toBeTruthy();
    const events = (await api.calendarEvents(teacher, today().slice(0, 7))).events;
    expect(events.find((e) => e.title === '画面から足した予定')).toMatchObject({ class_id: 1, event_date: today() });
  });

  it('管理者は対象に園全体を選べる。書けない人には「予定を足す」が出ない', async () => {
    open('/staff/calendar', admin);
    fireEvent.click(await screen.findByRole('button', { name: '予定を足す' }));
    const dialog = await screen.findByRole('dialog');
    const target = within(dialog).getByRole('combobox', { name: '対象' }) as HTMLSelectElement;
    expect(target.options[0].textContent).toBe('園全体');
    expect(target.options.length).toBeGreaterThan(1);
    cleanup();

    // 担当クラスの無い一般職員（フリー）は見るだけ
    open('/staff/calendar', { ...teacher, class_id: null, class_name: null });
    await screen.findByRole('heading', { level: 1, name: '行事カレンダー' });
    await screen.findByRole('button', { name: new RegExp(`^${thisM}月10日`) });
    expect(screen.queryByRole('button', { name: '予定を足す' })).toBeNull();
  });

  it('自分が書ける予定は、確認を挟んで消せる', async () => {
    await api.addCalendarEvent(teacher, {
      event_date: today(), start_time: null, end_time: null, title: '画面から消す予定', note: '内容', class_id: 1,
    });
    open('/staff/calendar', teacher);
    await screen.findByText('画面から消す予定');
    fireEvent.click(screen.getByRole('button', { name: '「画面から消す予定」を消す' }));

    // 確認の窓（画面の中）。やめるを押すと消えない
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('画面から消す予定')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '「画面から消す予定」を消す' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '消す' }));
    await waitFor(() => expect(screen.queryByText('画面から消す予定')).toBeNull());
  });

  it('月を移ると、その月の予定を選べる。「今月へ戻る」で戻る', async () => {
    open('/staff/calendar', admin);
    await screen.findByRole('button', { name: new RegExp(`^${thisM}月10日`) });
    expect(screen.getByText(monthText(thisY, thisM))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '次の月へ' }));
    await screen.findByText(monthText(nextY, nextM));
    // 月を移した直後は日が選ばれていない
    expect(screen.getByText('日を選ぶと、その日の予定が出ます。')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${nextM}月5日.*予定1件`) }));
    expect(await screen.findByText('遠足')).toBeTruthy();
    expect(screen.getByText('09:00〜14:00')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '前の月へ' }));
    await screen.findByText(monthText(thisY, thisM));
    // 今月へ戻るは、今月にいるあいだは押せない
    expect((screen.getByRole('button', { name: '今月へ戻る' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '次の月へ' }));
    fireEvent.click(await screen.findByRole('button', { name: '今月へ戻る' }));
    await screen.findByText(monthText(thisY, thisM));
  });

  it('日のボタンに曜日と予定の件数の名前が付き、今日が分かる', async () => {
    open('/staff/calendar', admin);
    const todayButton = await screen.findByRole('button', { name: new RegExp(`^${thisM}月${Number(today().slice(8))}日.*今日`) });
    expect(todayButton.getAttribute('aria-current')).toBe('date');
    expect(todayButton.getAttribute('aria-pressed')).toBe('true');
    // 曜日の見出し（日〜土の7列）
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['日', '月', '火', '水', '木', '金', '土']);
    // 予定のある日（身体測定）には件数が付く。読み込みが終わるのを待つ
    expect(await screen.findByRole('button', { name: new RegExp(`^${thisM}月15日.*予定[0-9]+件`) })).toBeTruthy();
  });
});

describe('行事カレンダー：保護者の画面', () => {
  it('園全体と自分の子のクラスの予定が見えて、足す・直す・消すのボタンは無い', async () => {
    open('/guardian/calendar', guardian);
    await screen.findByRole('heading', { level: 1, name: '行事カレンダー' });

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${thisM}月10日`) }));
    expect(await screen.findByText('運動会')).toBeTruthy();
    expect(screen.getByText('園全体')).toBeTruthy();
    expect(screen.getByText('09:30〜12:00')).toBeTruthy();
    expect(screen.getByText('体操服・水筒を持ってきてください')).toBeTruthy();

    fireEvent.click(dayButton(thisM, 15));
    expect(await screen.findByText('身体測定')).toBeTruthy();
    expect(screen.getByText('終日')).toBeTruthy();
    expect(screen.getByText('さくら組')).toBeTruthy();

    expect(screen.queryByRole('button', { name: '予定を足す' })).toBeNull();
    expect(screen.queryByRole('button', { name: /を直す$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /を消す$/ })).toBeNull();
  });

  it('ほかのクラスの予定は見えない', async () => {
    open('/guardian/calendar', guardian);
    await screen.findByRole('button', { name: new RegExp(`^${thisM}月10日`) });
    fireEvent.click(screen.getByRole('button', { name: '次の月へ' }));
    await screen.findByText(monthText(nextY, nextM));
    // ひまわり組の遠足（来月5日）は、さくら組の保護者には件数にも出ない
    expect(await screen.findByRole('button', { name: new RegExp(`^${nextM}月5日.*予定なし`) })).toBeTruthy();
  });
});
