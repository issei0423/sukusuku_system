// @vitest-environment jsdom
/*
 * 日誌作成・編集画面のヒヤリハットの欄
 * 典拠：図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目9・18〜21・28、「日誌承認画面（管理者）」(3-5) 項目3、
 *      詳細設計書.md「日誌の画面（作り直し）」(2-13 (8))
 *
 * 保存の規則は web/tests/diaryIncident.test.ts（モック）と server/api_diary_incident_test.go（Go サーバ）が確かめる。
 * ここでは画面に欄が出て、入れた値が保存されることを確かめる。時計は tests/setup-clock.ts の 18:00 のまま使う。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { clearNotice } from '../src/components/feedback';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
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

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(() => { cleanup(); act(() => clearNotice()); });

describe('日誌作成・編集画面のヒヤリハットの欄', () => {
  it('ヒヤリハットを選ぶと、本文・雛形・定型文の代わりに発生日時・場所・状況・とった対応・保護者へ伝えたこと・今後の対策が出る', async () => {
    open('/staff/diary/new', teacher);
    await settled();
    expect(screen.getByLabelText('本文')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('ヒヤリハット'));

    expect(screen.queryByLabelText('本文')).toBeNull();
    expect(screen.queryByLabelText('雛形を呼び出す')).toBeNull();
    expect(screen.queryByLabelText('定型文を入れる')).toBeNull();
    for (const label of ['発生日時', '場所', '状況', 'とった対応', '今後の対策']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    // 今後の対策は任意。とった対応・保護者へ伝えたことの下に置く（画面詳細図 3-2 項目28）
    expect(screen.getByLabelText('今後の対策').getAttribute('aria-required')).toBeNull();
    const [response, countermeasure] = ['とった対応', '今後の対策'].map((l) => screen.getByLabelText(l));
    expect(response.compareDocumentPosition(countermeasure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 「伝えた」を選ぶと、日時・手段・相手の欄が出る
    expect(screen.queryByLabelText('伝えた手段')).toBeNull();
    fireEvent.click(screen.getByLabelText('伝えた'));
    expect(screen.getByLabelText('伝えた手段')).toBeTruthy();
    expect(screen.getByLabelText('伝えた相手')).toBeTruthy();
  });

  it('欄を埋めて下書き保存すると、今後の対策が【今後の対策】の見出しで本文に入り、発生日時と場所が列に入る', async () => {
    const before = db.diaries.length;
    open('/staff/diary/new', teacher);
    await settled();
    fireEvent.click(screen.getByLabelText('ヒヤリハット'));
    fireEvent.change(screen.getByLabelText('対象の園児'), { target: { value: 'C001' } });
    const confirm = () => screen.getByRole('button', { name: '確認へ進む' }) as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);

    type('発生日時', `${today()}T10:30`);
    type('場所', '園庭');
    type('状況', 'すべり台の階段で足を踏み外しかけた。');
    type('とった対応', 'そばにいた職員が体を支えた。');
    type('今後の対策', '階段に順番の目印を付ける。');
    await waitFor(() => expect(confirm().disabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: '下書き保存' }));
    await waitFor(() => expect(db.diaries.length).toBe(before + 1), { timeout: 3000 });
    const saved = db.diaries[0];
    expect(saved.record_type).toBe('4');
    expect(saved.body).toBe('【状況】\nすべり台の階段で足を踏み外しかけた。\n\n【とった対応】\nそばにいた職員が体を支えた。\n\n【今後の対策】\n階段に順番の目印を付ける。');
    expect(saved.occurred_at).toBe(`${today()}T10:30:00`);
    expect(saved.place).toBe('園庭');
  });

  it('デモのヒヤリハット（diary_id 3）を開くと、本文を見出しで分けた欄に値が入っている', async () => {
    open('/staff/diary/3', teacher);
    await settled();
    await waitFor(() => expect((screen.getByLabelText('今後の対策') as HTMLTextAreaElement).value).toMatch(/^午睡の確認のたびに/));
    expect((screen.getByLabelText('状況') as HTMLTextAreaElement).value).toBe('午睡中にうつ伏せの体位を確認した。');
    expect((screen.getByLabelText('場所') as HTMLInputElement).value).toBe('保育室（さくら組）');
    expect((screen.getByLabelText('伝えた') as HTMLInputElement).checked).toBe(true);
  });
});

describe('日誌承認画面のヒヤリハット', () => {
  it('ヒヤリハットは本文の代わりに、発生日時・場所・状況・とった対応・保護者へ伝えたこと・今後の対策を示す', async () => {
    const d = db.diaries.find((x) => x.diary_id === 3)!;
    const saved = { status: d.status, applied_staff_id: d.applied_staff_id, applied_at: d.applied_at };
    d.status = '2'; d.applied_staff_id = 'S004'; d.applied_at = `${today()}T09:00:00`;
    try {
      open('/staff/admin/approval/3', admin);
      await settled();
      await waitFor(() => expect(document.body.textContent).toContain('今後の対策'));
      const text = document.body.textContent ?? '';
      for (const s of ['発生日時', '保育室（さくら組）', '午睡中にうつ伏せの体位を確認した。', 'お迎えのときに対面', '父（お迎え）', '午睡の確認のたびに']) {
        expect(text).toContain(s);
      }
      // 見出し付きの本文をそのまま出さない
      expect(text).not.toContain('【今後の対策】');
    } finally {
      Object.assign(d, saved);
    }
  });
});
