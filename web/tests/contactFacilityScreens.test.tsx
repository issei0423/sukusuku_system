// @vitest-environment jsdom
/*
 * 連絡帳（園児）画面で、園からのひとこと・活動のひとことを送る（段2の守り：宛先を大きく示す・他児の名前の注意・定型文）
 * 典拠：詳細設計書「園からのひとことを送る」(2-3 (3))・「きょうのようすを足す・直す」(2-3 (4))・「職員ダッシュボード」(2-1)・
 *      「テストの観点」(9-1)、図/画面詳細図「宛先の表示」(1-3 (1))・「他児の名前の注意」(1-3 (3))・「定型文の候補」(1-3 (5))
 *
 * 画面はモック（api/mock.ts）が相手。時計は今日の 18:00。mockDb はこのファイルのテストで使い回す。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
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
const facilitySection = () => document.getElementById('facility') as HTMLElement;

describe('連絡帳（園児）画面：園からのひとこと', () => {
  it('定型文 → 候補 → 送るの3タップで送れる。「送る」のすぐ上に宛先（園児名・クラス・届く続柄）を大きく示す', async () => {
    for (const f of db.contactFacilities) if (f.child_id === 'C001' && f.contact_date === today()) f.is_deleted = true;
    open('/staff/contact/C001', teacher);
    await screen.findByRole('heading', { name: '野原 太郎' }, { timeout: 3000 });
    const section = facilitySection();
    const badge = within(section).getByRole('note', { name: '宛先' });
    expect(badge.textContent).toContain('野原 太郎（さくら組）');
    expect(badge.textContent).toContain('父に届きます');
    // 宛先は「送る」と同じ領域の、すぐ上
    const send = within(section).getByRole('button', { name: '送る' });
    expect(badge.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((send as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(section).getByRole('button', { name: '定型文' })); // 1
    fireEvent.click(await screen.findByRole('button', { name: '今日も一日ありがとうございました。' }, { timeout: 3000 })); // 2
    expect((within(section).getByLabelText('園からのひとこと') as HTMLTextAreaElement).value).toBe('今日も一日ありがとうございました。');
    fireEvent.click(within(section).getByRole('button', { name: '送る' })); // 3
    await waitFor(() => expect(toast()?.textContent).toContain('野原 太郎さんの園から：送りました。保護者が見られる状態です。'), { timeout: 3000 });
    expect(within(toast() as HTMLElement).getByRole('button', { name: '取り消す' })).toBeTruthy();
    expect((await api.contactPage(guardian, 'C001')).facility?.body).toBe('今日も一日ありがとうございました。');
    // 送ったあとは、送った文と「直す」「取り消す」
    await within(facilitySection()).findByRole('button', { name: '直す' }, { timeout: 3000 });
    expect(facilitySection().textContent).toContain('送った');
  });

  it('直すと「直して送る」で訂正になり、取り消すと未送信に戻って書く欄が出る', async () => {
    open('/staff/contact/C001', teacher);
    const section = await screen.findByRole('region', { name: '園から' }, { timeout: 3000 });
    fireEvent.click(await within(section).findByRole('button', { name: '直す' }, { timeout: 3000 }));
    const box = within(facilitySection()).getByLabelText('園から（直して送る）') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '園庭で砂場あそびをしました。' } });
    fireEvent.click(within(facilitySection()).getByRole('button', { name: '直して送る' }));
    await waitFor(() => expect(toast()?.textContent).toContain('野原 太郎さんの園からを直しました。'), { timeout: 3000 });
    const fixed = (await api.contactPage(guardian, 'C001')).facility!;
    expect([fixed.body, fixed.corrected_at !== null]).toEqual(['園庭で砂場あそびをしました。', true]);

    fireEvent.click(await within(facilitySection()).findByRole('button', { name: '取り消す' }, { timeout: 3000 }));
    const confirm = screen.getByRole('dialog', { name: 'この記録を取り消しますか' });
    await within(confirm).findByText(/いま保護者 \d+ 家庭（\d+ 名）が読んでいます。/, undefined, { timeout: 3000 });
    fireEvent.click(within(confirm).getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(toast()?.textContent).toContain('取り消しました'), { timeout: 3000 });
    expect((await api.contactPage(guardian, 'C001')).facility).toBeNull();
    await within(facilitySection()).findByLabelText('園からのひとこと', undefined, { timeout: 3000 });
  });

  it('保護者がまだ登録していない園児には、そのことを宛先に示し、送ったあとも「登録すると読めます」と出す', async () => {
    open('/staff/contact/C003', teacher);
    await screen.findByRole('heading', { name: '高梨 健' }, { timeout: 3000 });
    const section = facilitySection();
    expect(within(section).getByRole('note', { name: '宛先' }).textContent).toContain('まだ保護者が登録していません（登録すると読めます）');
    fireEvent.change(within(section).getByLabelText('園からのひとこと'), { target: { value: 'お迎えのときに、くわしくお話しします。' } });
    fireEvent.click(within(section).getByRole('button', { name: '送る' }));
    await waitFor(() => expect(toast()?.textContent).toContain('高梨 健さんの園から：送りました。保護者が登録すると読めます。'), { timeout: 3000 });
  });
});

describe('連絡帳（園児）画面：活動のひとことと他児の名前の注意', () => {
  it('ほかの子の名前が入っていれば注意を出し、当たった語を強調する。「直す」で入力に戻り、「このまま送る」で送る', async () => {
    open('/staff/contact/C001', teacher);
    await screen.findByRole('heading', { name: '野原 太郎' }, { timeout: 3000 });
    const box = screen.getByLabelText('活動のひとこと') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'あおちゃんとしゃぼん玉を追いかけていました。' } });
    fireEvent.click(screen.getByRole('button', { name: 'ひとことを送る' }));
    const dialog = await screen.findByRole('dialog', { name: 'ほかのお子さんの名前の注意' }, { timeout: 3000 });
    expect(within(dialog).getByRole('alert').textContent).toBe('ほかのお子さんの名前（伊藤 葵）が入っています。このまま送りますか。');
    expect([...dialog.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['あおちゃん']);
    // 照合はサーバ（モック）が行う。園児の名前の一覧は画面へ配らない
    expect(dialog.textContent).not.toMatch(/小林|井上/);
    fireEvent.click(within(dialog).getByRole('button', { name: '直す' }));
    expect(screen.queryByRole('dialog', { name: 'ほかのお子さんの名前の注意' })).toBeNull();
    expect(box.value).toBe('あおちゃんとしゃぼん玉を追いかけていました。');

    fireEvent.click(screen.getByRole('button', { name: 'ひとことを送る' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'ほかのお子さんの名前の注意' }, { timeout: 3000 })).getByRole('button', { name: 'このまま送る' }));
    await waitFor(() => expect(toast()?.textContent).toContain('野原 太郎さんへのひとこと：送りました。保護者が見られる状態です。'), { timeout: 3000 });
    expect((await api.contactPage(guardian, 'C001')).events.some((e) => e.body === 'あおちゃんとしゃぼん玉を追いかけていました。')).toBe(true);
    expect(box.value).toBe('');
  });

  it('宛先の子の呼び名だけなら注意を出さずに送れる', async () => {
    open('/staff/contact/C001', teacher);
    await screen.findByRole('heading', { name: '野原 太郎' }, { timeout: 3000 });
    fireEvent.change(screen.getByLabelText('活動のひとこと'), { target: { value: 'たっくんは最後まで走っていました。' } });
    fireEvent.click(screen.getByRole('button', { name: 'ひとことを送る' }));
    await waitFor(() => expect(toast()?.textContent).toContain('野原 太郎さんへのひとこと：送りました。'), { timeout: 3000 });
    expect(screen.queryByRole('dialog', { name: 'ほかのお子さんの名前の注意' })).toBeNull();
  });
});

describe('職員ダッシュボードと連絡帳（クラス）画面の「園から」', () => {
  it('ダッシュボードに「園からのひとことを送っていない園児」を出し、押すと未送信の園児を上にした連絡帳（クラス）画面を開く', async () => {
    open('/staff', teacher);
    const row = (await screen.findByText('園からのひとことを送っていない園児', undefined, { timeout: 3000 })).closest('tr')!;
    expect(row.textContent).toMatch(/\d+ 名|ありません/);
    expect(within(row).getByRole('link', { name: '開く' }).getAttribute('href')).toBe('/staff/contact?sort=facility');
    cleanup();
    open('/staff/contact?sort=facility', teacher);
    // 読み上げの名前は「（氏名）の園から 未送信」のように、見えている文字を後ろに足している（WCAG 2.5.3）
    const links = await screen.findAllByRole('link', { name: /の園から (未送信|送った|欠席)/ }, { timeout: 3000 });
    const texts = links.map((l) => l.textContent ?? '');
    const firstSent = texts.findIndex((t) => !t.includes('未送信'));
    expect(texts.slice(firstSent).some((t) => t.includes('未送信'))).toBe(false);
    // 今日の午睡で欠席にした子（デモの高梨 健）は「欠席」
    if (db.napExclusions.some((x) => x.child_id === 'C003' && x.reason === '1' && !x.is_deleted)) {
      expect(screen.getByRole('link', { name: /^高梨 健の園から / }).textContent).toMatch(/欠席|送った/);
    }
  });
});
