// @vitest-environment jsdom
/*
 * 連絡帳とダッシュボードの細部の画面（GitHub Issue #268）
 * 典拠：図/画面詳細図「連絡帳画面（保護者）」(8-3) 項目4・6、「連絡帳（園児）画面」(8-2) 項目6、「職員ダッシュボード」(2-6)
 *      詳細設計書「誰が直したかの表示」(4-7 (4))
 *
 * 画面はモック（api/mock.ts）が相手。時計は今日の 18:00（tests/setup-clock.ts）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';
import type { ContactPage } from '../src/api/shapes';
import { api } from '../src/api/client';
import { today } from '../src/api/util';
import HomeForm from '../src/screens/contact/HomeForm';
import TodayTimeline from '../src/screens/contact/TodayTimeline';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = { ...teacher, account_id: 1, role: '1', staff_id: 'S001', class_id: null, class_name: null, display_name: '西田 拓也' };
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

const rowOf = (text: string) => Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent?.includes(text));

describe('「夜に寝た時刻」は 18:00〜02:00 を 10 分刻みで選べる（23:10〜23:50 を含む）', () => {
  it('選択肢が 18:00 から 02:00 まで 49 個で、23 時台が 6 個そろう', () => {
    render(<HomeForm home={null} busy={false} error={null} onSubmit={() => undefined} />);
    const select = screen.getByLabelText('夜に寝た時刻') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(values.length).toBe(49);
    expect(values[0]).toBe('18:00');
    expect(values.at(-1)).toBe('02:00');
    for (const t of ['23:00', '23:10', '23:20', '23:30', '23:40', '23:50', '00:00', '00:10']) expect(values, t).toContain(t);
    // 重ならず、時刻の順（18:00 → 23:50 → 00:00 → 02:00）に並ぶ
    expect(new Set(values).size).toBe(values.length);
    expect(values.indexOf('23:50')).toBe(values.indexOf('00:00') - 1);
  });

  it('朝に起きた時刻は 04:00〜10:00 のまま', () => {
    render(<HomeForm home={null} busy={false} error={null} onSubmit={() => undefined} />);
    const select = screen.getByLabelText('朝に起きた時刻') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect([values[0], values.at(-1), values.length]).toEqual(['04:00', '10:00', 37]);
  });
});

describe('職員の連絡帳の行：「訂正しました（時刻 直した職員）」', () => {
  const page = (viewer: 'staff' | 'guardian'): ContactPage => ({
    child_id: 'C001', child_name: '西田 太郎', contact_date: today(), class_id: 1, home: null, facility: null, can_write_home: false,
    class_notes: [], sleeps: [],
    events: [{
      contact_event_id: 1, child_id: 'C001', contact_date: today(), event_type: '1', recorded_at: `${today()}T10:00:00`,
      meal_kind: '2', meal_amount: '3', toilet_label: null, temperature: null, body: null, contact_photo_id: null, keep_in_growth: false,
      corrected_at: `${today()}T10:55:00`, is_deleted: false,
      ...(viewer === 'staff' ? { staff_name: '鈴木 浩之', last_change: { staff_name: '西田 拓也', at: `${today()}T10:55:00` } } : {}),
    }],
  });

  it('職員の画面は、記録した職員はそのまま、括弧の中に直した職員を出す', () => {
    render(<TodayTimeline page={page('staff')} viewer="staff" />);
    const item = screen.getByRole('listitem');
    expect(item.textContent).toContain('訂正しました（10:55 西田 拓也）');
    expect(item.textContent).toContain('鈴木 浩之');
  });

  it('直した人が分からない行（操作ログの無い古いデータ）は時刻だけ。保護者の画面にも職員の名前を出さない', () => {
    const staffPage = page('staff');
    delete staffPage.events[0].last_change;
    const { unmount } = render(<TodayTimeline page={staffPage} viewer="staff" />);
    expect(screen.getByRole('listitem').textContent).toContain('訂正しました（10:55）');
    unmount();
    render(<TodayTimeline page={page('guardian')} viewer="guardian" />);
    const text = screen.getByRole('listitem').textContent!;
    expect(text).toContain('訂正しました（10:55）');
    expect(text).not.toContain('西田 拓也');
    expect(text).not.toContain('鈴木');
  });
});

describe('職員ダッシュボード（一般）', () => {
  it('見出しは「届けること」「園内のこと」、各項目に範囲、旧「未読のチャット」は無く、「よく使う」の先頭は連絡帳', async () => {
    open('/staff', teacher);
    await screen.findByRole('heading', { name: '園内のこと' }, { timeout: 3000 });
    expect(screen.getByRole('heading', { name: '届けること' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('未読のチャット');
    expect(document.body.textContent).not.toContain('承認待ち');
    expect(rowOf('差し戻された日誌')).toBeTruthy();
    for (const label of ['家庭からの連絡', '園からのひとことを送っていない園児', '午睡中の園児', '差し戻された日誌', '未対応の個人チャット',
      '発達チェックの未実施', 'ヒヤリハット未起票']) {
      expect(rowOf(label)?.textContent, label).toContain('（担当クラス）');
    }
    const common = screen.getByRole('heading', { name: 'よく使う' }).closest('section')!;
    expect(within(common).getAllByRole('link')[0].textContent).toBe('連絡帳');
    expect(within(common).getAllByRole('link')[0].getAttribute('href')).toBe('/staff/contact');
  });
});

describe('職員ダッシュボード（管理者）', () => {
  it('差し戻された日誌の行を出さず、承認待ちの日誌に「うち自分の申請 n件：ほかの管理者へ」を添える。範囲は全クラス', async () => {
    const own = await api.staffSummary(admin);
    // 管理者が申請した承認待ちを 1 件つくる（mockDb は同じファイルのテストで使い回すため、あとで戻す）
    const db = await import('../src/api/mockDb');
    const d = db.diaries.find((x) => !x.is_deleted && x.status === '2')!;
    const saved = d.applied_staff_id;
    d.applied_staff_id = 'S001';
    try {
      open('/staff', admin);
      await screen.findByRole('heading', { name: '園内のこと' }, { timeout: 3000 });
      await waitFor(() => expect(rowOf('承認待ちの日誌')).toBeTruthy(), { timeout: 3000 });
      expect(rowOf('差し戻された日誌')).toBeUndefined();
      const row = rowOf('承認待ちの日誌')!;
      expect(row.textContent).toMatch(/うち自分の申請 \d+件：ほかの管理者へ/);
      expect(row.textContent).toContain('（全クラス）');
      expect(own.pending).toBeGreaterThan(0);
      const link = within(row as HTMLElement).getByRole('link', { name: '開く' });
      expect(link.getAttribute('href')).toBe('/staff/admin/approval');
    } finally {
      d.applied_staff_id = saved;
    }
  });
});

describe('連絡帳画面（保護者）の月の一覧', () => {
  it('「月の一覧」を押すと同じ画面の中に1か月が出て、日を押すとその日のページに移る', async () => {
    open('/guardian/contact/C001', guardian);
    const button = await screen.findByRole('button', { name: '月の一覧' }, { timeout: 3000 });
    fireEvent.click(button);
    const region = await screen.findByRole('region', { name: '月の一覧' }, { timeout: 3000 });
    // 今月のうち今日までの日が、新しい日から並ぶ。次の月へは移れない
    await waitFor(() => expect(within(region).getAllByRole('button').length).toBeGreaterThan(3), { timeout: 3000 });
    expect((within(region).getByRole('button', { name: /次の月/ }) as HTMLButtonElement).disabled).toBe(true);
    const dayButtons = within(region).getAllByRole('button').filter((b) => /^\d+月\d+日/.test(b.textContent ?? ''));
    expect(dayButtons.length).toBeGreaterThan(0);
    // 今日の行には、デモの今日の記録（ようす n件）が出る
    expect(dayButtons[0].textContent).toMatch(/ようす \d+件|家庭から|園から|記録なし/);
    fireEvent.click(dayButtons.at(-1)!);
    await waitFor(() => expect(screen.queryByRole('region', { name: '月の一覧' })).toBeNull(), { timeout: 3000 });
  });
});
