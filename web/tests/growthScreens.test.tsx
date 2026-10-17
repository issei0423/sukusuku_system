// @vitest-environment jsdom
/*
 * 成長の記録画面（保護者）と、保護者ホーム・メニューからの入口
 * 典拠：詳細設計書「成長の記録画面（保護者）」(2-11)・「テストの観点」(9-1) の成長の記録の行（応答と画面に判定の言葉が無い）、
 *      図/画面詳細図「成長の記録画面（保護者・スマートフォン）」(6-6)
 *
 * 画面はモック（api/mock.ts）が相手。時計は今日の 18:00（tests/setup-clock.ts）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { ContactEventRecord, SessionUser } from '../src/api/types';
import * as db from '../src/api/mockDb';
import { addDays, today } from '../src/api/util';

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

describe('成長の記録画面（保護者）', () => {
  it('園児名・身長と体重（グラフと測った値）・できたこと・免責を出す。所見・「一部」「未確認」・判定の言葉は出さない', async () => {
    open('/guardian/growth/C001', guardian);
    await screen.findByRole('heading', { name: '野原 太郎の成長の記録' }, { timeout: 3000 });
    // 身長・体重：切り替えとグラフ。測った値は新しい順で、体重は小数第2位まで
    expect(screen.getByRole('button', { name: '身長' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('svg.growth-chart')).toBeTruthy();
    const rows = Array.from(document.querySelectorAll('.growth-measurements tbody tr'));
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('9.80kg');
    expect(rows[0].textContent).toContain('きょう');
    fireEvent.click(screen.getByRole('button', { name: '体重' }));
    expect(screen.getByRole('button', { name: '体重' }).getAttribute('aria-pressed')).toBe('true');

    // できたこと：発達チェック（確認できた項目と先生から）と、連絡帳から残したひとこと
    const done = screen.getByRole('region', { name: 'できたこと' });
    expect(within(done).getByText('つかまり立ちをする')).toBeTruthy();
    expect(within(done).getByText('伝い歩きをする')).toBeTruthy();
    expect(within(done).getByText('先生から')).toBeTruthy();
    expect(within(done).getByText('ボールを転がすと、追いかけて両手でつかもうとしていました。')).toBeTruthy();
    // 今日の 10:15 のひとことは、時計がそれより前だとデモデータに入らない（詳細設計書「時計」(9-3)）
    if (new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16) >= '10:15') {
      expect(within(done).getByText(/スコップの型抜き/)).toBeTruthy();
    }

    // 免責は常に出す。顔写真・判定の言葉・「一部」「未確認」の項目・職員の名前は出さない
    expect(document.querySelector('.disclaimer')?.textContent).toContain('発育の判定・診断を行うものではありません。');
    const text = document.querySelector('.growth-page')!.textContent ?? '';
    expect(text).not.toMatch(/やせ|肥満|標準|順調|遅れ|異常|良好|未確認|一部|パパ|自分でやりたい|高梨/);
    expect(document.querySelector('.growth-page img')).toBeNull();
  });

  it('ほかの家庭の園児は開けない', async () => {
    open('/guardian/growth/C004', guardian);
    expect(await screen.findByText('この園児の成長の記録は開けません。', undefined, { timeout: 3000 })).toBeTruthy();
  });

  it('身体測定を共有しないときは身長・体重の区画ごと出さず、免責は出す。届いたものが無ければ空の文', async () => {
    const setting = db.settings.find((s) => s.setting_key === 'growth.share_physical')!;
    setting.setting_value = '0';
    try {
      // C002（上園 花子）の保護者。ひとことの無い確定（確認できた項目あり）だけがある
      const other: SessionUser = { ...guardian, account_id: 7, guardian_id: 'G002', email: 'uezono.k@example.jp' };
      open('/guardian/growth/C002', other);
      await screen.findByRole('heading', { name: '上園 花子の成長の記録' }, { timeout: 3000 });
      expect(screen.queryByRole('region', { name: '身長・体重' })).toBeNull();
      expect(document.querySelector('.disclaimer')).toBeTruthy();
    } finally {
      setting.setting_value = '1';
    }
  });

  it('12件を超えると「さらに読み込む」で下に足し、続きが無くなると消える', async () => {
    const rows: ContactEventRecord[] = Array.from({ length: 13 }, (_, i) => {
      const d = addDays(today(), -(i + 1));
      const at = `${d}T09:00:00`;
      return {
        contact_event_id: 9600 + i, child_id: 'C001', class_id: 1, contact_date: d, event_type: '4', recorded_at: at,
        meal_kind: null, meal_amount: null, toilet_label: null, temperature: null, body: `読み足しの行${i + 1}`, contact_photo_id: null,
        keep_in_growth: true, staff_id: 'S003', corrected_at: null, is_deleted: false, created_at: at, updated_at: at,
      };
    });
    db.contactEvents.push(...rows);
    try {
      open('/guardian/growth/C001', guardian);
      const more = await screen.findByRole('button', { name: 'さらに読み込む' }, { timeout: 3000 });
      expect(document.querySelectorAll('.growth-entry')).toHaveLength(12);
      fireEvent.click(more);
      await screen.findByText('読み足しの行13', undefined, { timeout: 3000 });
      expect(document.querySelectorAll('.growth-entry').length).toBeGreaterThan(12);
      expect(screen.queryByRole('button', { name: 'さらに読み込む' })).toBeNull();
    } finally {
      for (const r of rows) db.contactEvents.splice(db.contactEvents.indexOf(r), 1);
    }
  });
});

describe('入口（保護者ホームの区画・メニュー）', () => {
  it('区画に「成長の記録」、メニューに「〇〇の成長の記録」を出す。きょう測ったものがあれば「新しい記録があります」', async () => {
    open('/guardian', guardian);
    const card = await screen.findByRole('region', { name: '野原 太郎さんのきょう' }, { timeout: 3000 });
    const link = within(card).getByRole('link', { name: /成長の記録/ });
    expect(link.getAttribute('href')).toBe('/guardian/growth/C001');
    // デモの今日の身体測定（野原 太郎）がある
    expect(link.textContent).toContain('新しい記録があります');
    fireEvent.click(screen.getByRole('button', { name: 'メニューを開く' }));
    const menu = screen.getByRole('dialog', { name: 'メニュー' });
    expect(within(menu).getByRole('link', { name: '野原 太郎の成長の記録' }).getAttribute('href')).toBe('/guardian/growth/C001');
  });
});
