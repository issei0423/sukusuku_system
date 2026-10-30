// @vitest-environment jsdom
/*
 * アイコン（src/components/icons.tsx）
 * 【仮置き】付け方の決まり：アイコンは文字に添えるだけ。読み上げの名前（accessible name）は文字のままで変えない
 * （web/仮置き値.md「1 画面の見た目」の「アイコン」、図/デザインアーキテクチャ案.md「形・文字・アイコン」）
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentType } from 'react';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as icons from '../src/components/icons';
import { BellIcon } from '../src/components/ui';
import type { SessionUser } from '../src/api/types';

afterEach(cleanup);

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null, is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null, is_temp_password: false, terms_agreed: true,
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

/** 名前の付いたものから、文字を持たない絵（svg）が読み上げに出ていないこと */
function expectIconsHidden(root: HTMLElement) {
  const svgs = Array.from(root.querySelectorAll('svg.icon'));
  expect(svgs.length).toBeGreaterThan(0);
  for (const svg of svgs) {
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
  }
}

const entries = Object.entries(icons) as [string, ComponentType][];

describe('アイコンの部品', () => {
  it('どれも、読み上げに出ない絵（aria-hidden）で、Material Symbols の枠（0 -960 960 960）と文字の色で描く', () => {
    expect(entries.length).toBeGreaterThanOrEqual(50);
    for (const [name, Icon] of entries) {
      const { container, unmount } = render(<Icon />);
      const svg = container.querySelector('svg');
      expect(svg, name).not.toBeNull();
      expect(svg!.getAttribute('aria-hidden'), name).toBe('true');
      expect(svg!.getAttribute('focusable'), name).toBe('false');
      expect(svg!.getAttribute('class'), name).toBe('icon');
      expect(svg!.getAttribute('viewBox'), name).toBe('0 -960 960 960');
      expect(svg!.getAttribute('fill'), name).toBe('currentColor');
      // 絵だけで、文字（title など）は持たない。名前は添えた文字が持つ
      expect(svg!.textContent, name).toBe('');
      expect(svg!.querySelectorAll('path'), name).toHaveLength(1);
      expect(svg!.querySelector('path')!.getAttribute('d'), name).toMatch(/^[Mm][-\d]/);
      unmount();
    }
  });

  it('文字の前に置いても、ボタン・リンクの名前は文字のまま', () => {
    render(
      <MemoryRouter>
        <button type="button"><icons.SaveIcon />保存する</button>
        <a href="/x"><icons.DiaryIcon />日誌</a>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: '保存する' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '日誌' })).toBeTruthy();
  });

  it('ヘッダの通知のベル（BellIcon）も同じ部品で描く', () => {
    const { container } = render(<BellIcon />);
    expect(container.innerHTML).toBe(render(<icons.NotificationIcon />).container.innerHTML);
  });
});

describe('職員の共通レイアウト', () => {
  it('左メニューの項目とログアウトの名前は、アイコンを添えても文字のまま', async () => {
    open('/staff', admin);
    const nav = await screen.findByRole('navigation', { name: '職員メニュー' });
    const names = within(nav).getAllByRole('link').map((a) => a.textContent);
    expect(names).toEqual([
      'ダッシュボード', '日誌', 'チャット', '午睡チェック', '連絡帳', '発達・身体', '園児',
      '承認待ち', '職員アカウント', '招待コード', '保護者アカウント', '年度更新', '操作ログ', '誤送信対応', '設定',
      'パスワードの変更', '利用規約',
    ]);
    for (const name of names) expect(within(nav).getByRole('link', { name: name! })).toBeTruthy();
    // 項目ごとに絵が1つ
    for (const link of within(nav).getAllByRole('link')) expect(link.querySelectorAll('svg.icon')).toHaveLength(1);
    expectIconsHidden(nav);

    const header = screen.getByRole('banner');
    expect(within(header).getByRole('button', { name: 'ログアウト' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: /^通知 \d+件$/ })).toBeTruthy();
    expectIconsHidden(header);
  });
});

describe('保護者の共通レイアウト', () => {
  it('メニューを開く・閉じる、メニューの項目、ログアウトの名前は、アイコンを添えても変わらない', async () => {
    open('/guardian', guardian);
    const header = screen.getByRole('banner');
    const menuButton = within(header).getByRole('button', { name: 'メニューを開く' });
    expectIconsHidden(header);

    fireEvent.click(menuButton);
    const drawer = await screen.findByRole('dialog', { name: 'メニュー' });
    expect(within(drawer).getByRole('button', { name: 'メニューを閉じる' })).toBeTruthy();
    await waitFor(() => expect(within(drawer).getByRole('link', { name: /の成長の記録$/ })).toBeTruthy());
    for (const name of ['ホーム', 'チャット・お知らせ', '園からの日誌', 'パスワードの変更', '利用規約']) {
      expect(within(drawer).getByRole('link', { name })).toBeTruthy();
    }
    expect(within(drawer).getByRole('button', { name: 'お子さまの追加' })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'ログアウト' })).toBeTruthy();
    expectIconsHidden(drawer);

    // PC の幅で常に出すメニュー（jsdom では CSS で隠れないので、そのまま読める）
    const sidebar = screen.getByRole('navigation', { name: 'メニュー' });
    for (const name of ['ホーム', 'チャット・お知らせ', '園からの日誌', 'パスワードの変更', '利用規約']) {
      expect(within(sidebar).getByRole('link', { name })).toBeTruthy();
    }
    expect(within(sidebar).getByRole('button', { name: 'ログアウト' })).toBeTruthy();
    expectIconsHidden(sidebar);
  });
});
