// @vitest-environment jsdom
/*
 * 日誌の申請・承認・一覧の画面（GitHub Issue #174・#139）
 * 典拠：基本設計書.md「日誌の作成から保護者への共有」(4-5)・「日誌（t_diary）」(5-4)
 *      図/画面詳細図.md「職員ダッシュボード」(2-6)・「日誌一覧画面」(3-1)・「日誌作成・編集画面」(3-2)・
 *      「日誌確認画面」(3-3)・「日誌承認画面（管理者）」(3-5)
 *
 * API の規則は web/tests/diaryFlow.test.ts（モック）と server/api_diary_flow_test.go（Go サーバ）が確かめる。
 * ここでは画面の出し分けと操作を確かめる。時計は tests/setup-clock.ts の 18:00 のまま使う。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import type { SessionUser } from '../src/api/types';
import { addDays, today } from '../src/api/util';

const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const admin2: SessionUser = {
  account_id: 2, email: 'uezono@hoiku.example.jp', role: '1', display_name: '上園 謙心',
  staff_id: 'S002', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
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

async function settled() {
  await waitFor(() => {
    expect(document.body.textContent).not.toContain('読み込んでいます');
  }, { timeout: 3000 });
}

afterEach(cleanup);

const classSelect = () => screen.getByLabelText('対象のクラス') as HTMLSelectElement;
const openLinks = () => screen.getAllByRole('link', { name: '開く' }).map((a) => a.getAttribute('href'));

describe('日誌承認画面（#174 の 1・4）', () => {
  it('書き直して申請した管理者には承認できない旨を出し、承認のボタンを押せなくする。前回の差し戻しの理由を出す', async () => {
    // 日誌 7 は宮城（S004）が書いた申請中の個人日誌（C004・さくら組）。上園が差し戻し、園長が書き直して申請する
    await api.returnDiary(admin2, 7, '午睡の様子を書き足してください');
    await api.saveDiary(admin, {
      diary_id: 7, record_type: '1', child_id: 'C004', class_id: 1, diary_date: today(), body: '園長が書き直した本文です。',
    }, '2');

    open('/staff/admin/approval/7', admin);
    await settled();
    expect(document.body.textContent).toContain('自分が申請した日誌は承認できません');
    expect((screen.getByText('承認する') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('申請者 野原 一誠');
    // 差し戻す理由は承認されるまで残す。承認者が前回の指摘を見ながら確かめられるようにする（基本設計書 5-4）
    expect(document.body.textContent).toContain('午睡の様子を書き足してください');
    cleanup();

    open('/staff/admin/approval/7', admin2);
    await settled();
    expect(document.body.textContent).not.toContain('自分が申請した日誌は承認できません');
    await waitFor(() => expect((screen.getByText('承認する') as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('ダッシュボードの「差し戻された日誌」から開く日誌一覧（#174 の 3）', () => {
  it('自分が書いた差し戻しに絞り、期間を問わずに開く。絞り込みは外せる', async () => {
    const old = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C004', class_id: 1, diary_date: addDays(today(), -40), body: '40日前の記録',
    }, '2');
    await api.returnDiary(admin, old.diary_id, '書き足してください');

    open('/staff', teacher);
    await settled();
    const row = screen.getAllByText('差し戻された日誌').map((el) => el.closest('tr')).find(Boolean)!;
    fireEvent.click(within(row).getByText('開く'));
    await screen.findByText(/自分が書いた日誌に絞っています/);
    await settled();

    const dates = Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    expect(dates.map((d) => d.value)).toEqual(['', '']);
    expect(openLinks()).toContain(`/staff/diary/${old.diary_id}`);
    expect(openLinks()).not.toContain('/staff/diary/3'); // 宮城のヒヤリハット（差し戻し）は自分が書いたものではない

    fireEvent.click(screen.getByText('作成者で絞らない'));
    await waitFor(() => expect(openLinks()).toContain('/staff/diary/3'));
    expect(screen.queryByText(/自分が書いた日誌に絞っています/)).toBeNull();
  });
});

describe('日誌作成・編集画面（#174 の 2・5）', () => {
  it('一般は、対象のクラスの初期値が担当クラスで、「指定しない」は選べない', async () => {
    open('/staff/diary/new', teacher);
    await settled();
    expect(classSelect().value).toBe('1');
    expect(Array.from(classSelect().options).map((o) => o.textContent)).not.toContain('指定しない');
  });

  it('クラスを持たない管理者は、園児を選ぶとその園児のクラスが入る。クラスが空のうちは確認へ進めない', async () => {
    open('/staff/diary/new', admin);
    await settled();
    expect(classSelect().value).toBe('');
    expect(Array.from(classSelect().options).map((o) => o.textContent)).not.toContain('指定しない');

    fireEvent.change(document.querySelector('textarea')!, { target: { value: 'クラス日誌の本文' } });
    fireEvent.click(screen.getByLabelText('クラス日誌'));
    expect((screen.getByText('確認へ進む') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('対象のクラスを選ぶと、確認へ進めます。')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('個人日誌'));
    fireEvent.change(screen.getByLabelText('対象の園児'), { target: { value: 'C013' } }); // ひまわり組
    await waitFor(() => expect(classSelect().value).toBe('2'));
    expect((screen.getByText('確認へ進む') as HTMLButtonElement).disabled).toBe(false);
  });

  it('記録日に未来の日付を打ち込むと、確認へ進まずに理由を出す', async () => {
    open('/staff/diary/new', teacher);
    await settled();
    fireEvent.change(screen.getByLabelText('対象の園児'), { target: { value: 'C004' } });
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '午前は園庭で遊んだ。' } });
    fireEvent.change(screen.getByLabelText('記録日'), { target: { value: addDays(today(), 7) } });
    fireEvent.click(screen.getByText('確認へ進む'));
    expect(await screen.findByText(/記録日に未来日は指定できません/)).toBeTruthy();
    expect(screen.queryByText('この内容で申請します')).toBeNull();
  });
});

describe('日誌確認画面（#139 の 2）', () => {
  it('下書き保存の知らせを、確認画面へ持ち越さない', async () => {
    open('/staff/diary/new', teacher);
    await settled();
    fireEvent.change(screen.getByLabelText('対象の園児'), { target: { value: 'C004' } });
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '下書きの本文' } });
    fireEvent.click(screen.getByText('下書き保存'));
    await screen.findByText('下書きを保存しました');
    await waitFor(() => expect(screen.getByText('日誌の編集')).toBeTruthy());
    await settled();

    await waitFor(() => expect((screen.getByText('確認へ進む') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('確認へ進む'));
    await screen.findByText('この内容で申請します');
    expect(screen.queryByText('下書きを保存しました')).toBeNull();
  });
});
