// @vitest-environment jsdom
/*
 * 担当クラスの無い一般（フリー）の日誌の画面（受け入れテスト 06-045）
 * 典拠：図/画面詳細図「職員（タブレット／PC）」(1-1) の注記「全クラスを閲覧のみ…記録の作成・編集のボタンは出さない」、
 *      基本設計書「権限と利用可能機能」(6-1) ※1、図/画面詳細図「日誌一覧画面」(3-1) 項目2・6、「日誌作成・編集画面」(3-2)
 *
 * 規則（読める範囲・書けないこと）は web/tests/diaryFreeStaff.test.ts（モック）と server/api_diary_free_test.go（Go サーバ）が確かめる。
 * ここでは、書くボタンを出さないこと、全クラスから選べること、開いたときに読み取り専用でロックを取らないことを確かめる。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
// フリー（担当クラスの無い一般）
const free: SessionUser = { ...teacher, account_id: 5, email: 'kubota@hoiku.example.jp', staff_id: 'S005', display_name: '久保田 和也', class_id: null, class_name: null };

function open(path: string, user: SessionUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function settled() {
  await waitFor(() => {
    expect(document.body.textContent).not.toContain('読み込んでいます');
  }, { timeout: 3000 });
}

const main = () => document.getElementById('staff-main') as HTMLElement;

afterEach(() => cleanup());

describe('フリーの職員には、日誌を書くボタンを出さない', () => {
  it('職員ダッシュボードの「よく使う」に「日誌を書く」が無い（担任には出る）', async () => {
    open('/staff', free);
    await screen.findByRole('heading', { level: 1, name: 'ダッシュボード' }, { timeout: 3000 });
    await settled();
    expect(screen.queryByRole('link', { name: '日誌を書く' })).toBeNull();
    // 「よく使う」はほかの項目を出したまま（連絡帳はサイドナビにもあるので、メインコンテンツの中で探す）
    expect(within(main()).getByRole('link', { name: '連絡帳' })).toBeTruthy();
    cleanup();

    open('/staff', teacher);
    await screen.findByRole('heading', { level: 1, name: 'ダッシュボード' }, { timeout: 3000 });
    await settled();
    expect(screen.getByRole('link', { name: '日誌を書く' })).toBeTruthy();
  });

  it('日誌一覧に「＋ 新しく書く」が無く、クラスは「すべて」から全クラスを選べる。ひまわり組の日誌も出る', async () => {
    open('/staff/diary', free);
    await screen.findByRole('heading', { level: 1, name: '日誌' }, { timeout: 3000 });
    await settled();
    expect(screen.queryByRole('link', { name: /新しく書く/ })).toBeNull();
    const cls = screen.getByRole('combobox', { name: 'クラス' }) as HTMLSelectElement;
    expect(cls.disabled).toBe(false);
    const options = Array.from(cls.options).map((o) => o.textContent);
    expect(options[0]).toBe('すべて');
    for (const c of ['さくら組', 'ひまわり組', 'もも組']) expect(options).toContain(c);
    // 担任向けの「担当するクラスの日誌のみ表示しています。」は出さない
    expect(main().textContent).not.toContain('担当するクラスの日誌のみ');
    // ひまわり組のクラス日誌（日誌 6）とさくら組の下書き（日誌 1）が出る
    await waitFor(() => expect(main().querySelector('a[href="/staff/diary/6"]')).toBeTruthy(), { timeout: 3000 });
    expect(main().querySelector('a[href="/staff/diary/1"]')).toBeTruthy();
  });

  it('担任の日誌一覧は今までどおり：「＋ 新しく書く」があり、クラスは自クラスに固定', async () => {
    open('/staff/diary', teacher);
    await screen.findByRole('heading', { level: 1, name: '日誌' }, { timeout: 3000 });
    await settled();
    expect(screen.getByRole('link', { name: /新しく書く/ })).toBeTruthy();
    const cls = screen.getByRole('combobox', { name: 'クラス' }) as HTMLSelectElement;
    expect(cls.disabled).toBe(true);
    expect(Array.from(cls.options).map((o) => o.textContent)).toEqual(['さくら組']);
  });
});

describe('フリーの職員が日誌を開くと、読み取り専用で開く', () => {
  it('下書きでも内容を変える部品を動かせず、「下書き保存」「確認へ進む」を出さず、ロックを取らない', async () => {
    open('/staff/diary/1', free);
    await screen.findByRole('heading', { level: 1, name: '日誌の編集' }, { timeout: 3000 });
    await settled();
    await waitFor(() => expect((document.querySelector('textarea') as HTMLTextAreaElement).value).not.toBe(''), { timeout: 3000 });
    expect((document.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^記録日/) as HTMLInputElement).disabled).toBe(true);
    for (const r of screen.getAllByRole('radio')) expect((r as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /下書き保存/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /確認へ進む/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /申請を取り下げる/ })).toBeNull();
    // 申請中・承認済みの文は出さない（下書きなので）
    expect(main().textContent).not.toMatch(/申請中のため|承認済みのため/);
    expect(db.diaryLocks.some((l) => l.locked_staff_id === 'S005')).toBe(false);
  });

  it('ほかの職員が編集中なら、その旨は出す（日誌 3 は村田 真一がロックを持っている）', async () => {
    open('/staff/diary/3', free);
    await screen.findByRole('heading', { level: 1, name: '日誌の編集' }, { timeout: 3000 });
    await waitFor(() => expect(main().textContent).toContain('村田 真一さんが編集中です。'), { timeout: 3000 });
    expect(db.diaryLocks.some((l) => l.locked_staff_id === 'S005')).toBe(false);
  });

  it('新しく書く画面をアドレスから開いたときは、日誌一覧へ戻す', async () => {
    open('/staff/diary/new', free);
    await screen.findByRole('heading', { level: 1, name: '日誌' }, { timeout: 3000 });
    expect(screen.queryByRole('heading', { level: 1, name: '日誌の作成' })).toBeNull();
  });
});
