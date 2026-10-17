// @vitest-environment jsdom
/*
 * 連絡帳の画面（保護者ホームの「きょう」・連絡帳画面（保護者）・連絡帳（クラス）画面・午睡チェックの行の「ねた・おきた」）
 * 典拠：詳細設計書「保護者ホーム」(2-5)・「連絡帳画面（保護者）」(2-6)・「連絡帳（クラス）画面」(2-2)・
 *      「午睡チェック画面」(2-4)・「テストの観点」(9-1)（楽観的更新をしない・判断しないこと）・「時計」(9-3)
 *
 * 画面はモック（api/mock.ts）が相手。時計は今日の 18:00（tests/setup-clock.ts）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';
import { api } from '../src/api/client';
import { today } from '../src/api/util';

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

describe('保護者ホームの「きょう」', () => {
  it('園児ごとの区画に、家庭からの入口・きょうのようす（新しい3件）・連絡帳への入口を出す。判定の言葉は出さない', async () => {
    open('/guardian', guardian);
    const card = await screen.findByRole('region', { name: '野原 太郎さんのきょう' }, { timeout: 3000 });
    expect(within(card).getByRole('link', { name: '家庭からを書く' })).toBeTruthy();
    expect(within(card).getByRole('link', { name: /連絡帳を開く/ })).toBeTruthy();
    expect(card.querySelectorAll('.contact-latest li').length).toBeLessThanOrEqual(3);
    // 顔写真・判定の言葉を出さない（要件定義書「判断を行わないことの担保」(7-1 No.5)）
    expect(card.querySelector('img')).toBeNull();
    expect(card.textContent).not.toMatch(/元気|順調|異常|良好|発熱/);
    // 朝の早い時刻（最初の記録 9:40 より前）は、今日の連絡帳が空（詳細設計書「時計」(9-3)）
    if (new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16) < '09:40') {
      expect(card.textContent).toContain('まだきょうの記録はありません');
    }
  });
});

describe('連絡帳画面（保護者）：家庭から', () => {
  it('朝ごはん・きげん・送るの3タップで送れ、確認の前は「急ぎはお電話で」、園が確認すると時刻が出る', async () => {
    open('/guardian/contact/C001', guardian);
    await screen.findByText('野原 太郎の連絡帳', undefined, { timeout: 3000 });
    const form = document.querySelector<HTMLFormElement>('.contact-home-form')!;
    expect(form).toBeTruthy();
    // 何も選ばずに送ると、何が足りないかを、押した場所の近くと結果の表示に出す（入力は残る）
    fireEvent.click(within(form).getByRole('button', { name: '家庭からを送る' }));
    await waitFor(() => expect(within(form).getByRole('alert').textContent).toBe('1つ以上の項目を入れてください。'), { timeout: 3000 });

    fireEvent.click(within(form).getByRole('radio', { name: 'ぜんぶ' })); // 1
    fireEvent.click(within(form).getByRole('radio', { name: 'ごきげん' })); // 2
    fireEvent.click(within(form).getByRole('button', { name: '家庭からを送る' })); // 3
    // 押したら応答を待ってから結果を出す（楽観的更新をしない）
    await waitFor(() => expect(document.body.textContent).toContain('急ぎはお電話でお願いします。'), { timeout: 3000 });
    expect(document.querySelector('.contact-home-form')).toBeNull();

    const page = await api.contactPage(teacher, 'C001');
    await api.confirmHome(teacher, page.home!.contact_home_id, page.home!.updated_at);
    // 知らせ（contact）を受けて読み直し、職員の名前は出さずに確認の時刻を出す
    await waitFor(() => expect(document.body.textContent).toMatch(/園が確認しました（\d{2}:\d{2}）/), { timeout: 6000 });
    expect(document.body.textContent).not.toContain('高梨');
  });

  it('前の日のページは家庭からを書けない', async () => {
    open('/guardian/contact/C001?date=' + new Date(Date.now() - 86_400_000 + 9 * 3600_000).toISOString().slice(0, 10), guardian);
    await screen.findByText('前の日の連絡は直せません。急ぎはお電話でお願いします。', undefined, { timeout: 3000 });
    expect(document.querySelector('.contact-home-form')).toBeNull();
    expect(screen.queryByRole('button', { name: '直す' })).toBeNull();
  });
});

describe('連絡帳（クラス）画面', () => {
  it('家庭からの内容の全部をセルに出し、「確認しました」で確認済みになる。体温に判定の色や言葉を付けない', async () => {
    // 金城 陸（C005）の家庭から。デモデータ（7:45）は時計が早いと入らないため、無ければ父として送っておく
    if (!(await api.contactPage(teacher, 'C005')).home) {
      const father: SessionUser = { ...guardian, account_id: 10, guardian_id: 'G005' };
      await api.saveHome(father, 'C005', {
        temperature: 36.7, night_sleep_from: null, night_sleep_to: null, breakfast: '2', mood_label: 'ふつう',
        pickup_type: '2', pickup_person: '祖母', pickup_time: '17:00', message: 'きょうは祖母が迎えに行きます。', updated_at: null,
      });
    }
    open('/staff/contact?sort=home', teacher);
    const button = await screen.findByRole('button', { name: '金城 陸の家庭からを確認しました' }, { timeout: 3000 });
    const cell = button.closest('.contact-home-cell')!;
    expect(cell.textContent).toContain('変更あり 祖母 17:00');
    expect(cell.textContent).toContain('きょうは祖母が迎えに行きます。');
    expect(cell.textContent).toContain('36.7℃');
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('button', { name: '金城 陸の家庭からを確認しました' })).toBeNull(), { timeout: 3000 });
    expect(document.body.textContent).toMatch(/園が確認しました \d{2}:\d{2} 高梨 倫太朗/);
    expect(document.body.textContent).not.toMatch(/発熱|高い|低い|異常/);
  });

  it('保護者は開けない（職員の画面）', async () => {
    await expect(api.contactClass(guardian as never, 1)).rejects.toThrow();
  });
});

describe('午睡チェック画面：ねた・おきた', () => {
  it('5分ごとの確認と同じ行で「ねた」「おきた」を押せ、行に状態が出る。5分ごとの確認の欄はそのまま', async () => {
    // デモの実施（13:00 開始）は 18:00 には自動で終わっている。新しく始める
    const active = await api.activeSession(1, today(), admin);
    if (active) await api.endSession(admin, active.nap_session_id);
    await api.startSession(teacher, 1, today());
    open('/staff/nap', teacher);
    const sleep = await screen.findByRole('button', { name: '野原 太郎のねた' }, { timeout: 3000 });
    const row = sleep.closest('.nap-record-row') as HTMLElement;
    expect(row.querySelectorAll('input[type="radio"]').length).toBe(10);
    fireEvent.click(sleep);
    const wake = await within(row).findByRole('button', { name: '野原 太郎のおきた' }, { timeout: 3000 });
    expect(row.textContent).toMatch(/\d{2}:\d{2} ねた/);
    fireEvent.click(wake);
    await within(row).findByRole('button', { name: '野原 太郎のもう一度ねた' }, { timeout: 3000 });
    expect(row.textContent).toMatch(/\d{2}:\d{2}〜\d{2}:\d{2}（\d+分）/);
    // 保護者の連絡帳には、記録した時点で「ねた」「おきた」が入る
    const page = await api.contactPage(guardian, 'C001');
    expect(page.sleeps.at(-1)?.woke_at).toBeTruthy();
  });
});
