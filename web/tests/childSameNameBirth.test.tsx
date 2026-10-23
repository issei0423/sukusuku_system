// @vitest-environment jsdom
/*
 * 同じ氏名・同じ生年月日の園児を重ねて登録しようとしたときの知らせ（GitHub Issue #144 の 2）
 *
 * 園児IDは使われている番号の次が自動で入るため、同じ子を二重に登録するまちがいは ID の重複では防げない。
 * 登録の確認画面と CSV 一括登録の取込内容で知らせる。止めはしない（同じ氏名・生年月日の別の子もありうる）。
 * 【仮置き】設計に定めが無い（web/仮置き値.md「同じ氏名・生年月日の園児の知らせ」）。
 *
 * Go サーバ側（server/api_child_same_test.go）と同じ観点を、モック（api/mock.ts の findSameNameBirthChildren）に対して確かめる。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

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

const head = '園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱\n';
// デモの生年月日は起動日へずらしてあるため、いまの値を引く
const birthOf = (childId: string) => db.children.find((c) => c.child_id === childId)!.birth_date;
const ids = (rows: { child_id: string }[]) => rows.map((c) => c.child_id);

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

describe('同じ氏名・生年月日の園児を探す', () => {
  it('同じ氏名・生年月日の園児を返す。氏名の空白の違いは問わない', async () => {
    for (const name of ['西田 太郎', '西田　太郎', '西田太郎', ' 西田 太郎 ']) {
      expect(ids(await api.sameNameBirthChildren(admin, name, birthOf('C001'))), name).toEqual(['C001']);
    }
  });

  it('氏名か生年月日が違えば返さない', async () => {
    expect(await api.sameNameBirthChildren(admin, '西田 次郎', birthOf('C001'))).toEqual([]);
    expect(await api.sameNameBirthChildren(admin, '西田 太郎', '2020-01-01')).toEqual([]);
  });

  it('取り消した園児（誤登録）は比べない', async () => {
    await api.saveChild(admin, {
      child_id: 'C960', child_name: '取消 一', child_name_kana: 'とりけし いち', birth_date: '2025-05-05',
      sex: '1', normal_temperature: null, photo_consent_level: '2', class_id: 1, allergies: [], medical_histories: [],
    }, 'create');
    expect(ids(await api.sameNameBirthChildren(admin, '取消 一', '2025-05-05'))).toEqual(['C960']);
    await api.removeChild(admin, 'C960');
    expect(await api.sameNameBirthChildren(admin, '取消 一', '2025-05-05')).toEqual([]);
  });

  it('退園・卒園した園児は比べる', async () => {
    await api.saveChild(admin, {
      child_id: 'C961', child_name: '退園 一', child_name_kana: 'たいえん いち', birth_date: '2024-06-06',
      sex: '2', normal_temperature: null, photo_consent_level: '2', class_id: 2, allergies: [], medical_histories: [],
    }, 'create');
    db.children.find((c) => c.child_id === 'C961')!.enrollment_status = '2';
    expect(ids(await api.sameNameBirthChildren(admin, '退園一', '2024-06-06'))).toEqual(['C961']);
  });

  it('管理者のみ。園児の登録は管理者の操作である', async () => {
    await expect(api.sameNameBirthChildren(teacher, '西田 太郎', birthOf('C001'))).rejects.toThrow('管理者のみ');
  });
});

describe('CSV 一括登録でも、同じ氏名・生年月日の行は確認を促す', () => {
  it('登録済みの園児と同じ氏名・生年月日の行は、誤りにせず確認を促す', async () => {
    const { rows } = await api.parseChildCsv(`${head}C501,西田　太郎,にしだ たろう,${birthOf('C001')},1,さくら組,36.5`);
    expect(rows[0].error).toBeNull();
    expect(rows[0].warning).toContain('同じ氏名・生年月日の園児がいます');
    expect(rows[0].warning).toContain('C001');
  });

  it('同じファイルの中で同じ氏名・生年月日の行が重なれば、後の行で確認を促す', async () => {
    const { rows } = await api.parseChildCsv(head
      + 'C501,重複 一,ちょうふく いち,2025-04-01,1,さくら組,36.5\n'
      + 'C502,重複 一,ちょうふく いち,2025-04-01,1,さくら組,36.5\n'
      + 'C503,重複 二,ちょうふく に,2025-04-01,1,さくら組,36.5');
    expect(rows[0].warning).toBeNull();
    expect(rows[2].warning).toBeNull();
    expect(rows[1].error).toBeNull();
    expect(rows[1].warning).toContain('このファイル内');
    expect(rows[1].warning).toContain('1 行目');
  });

  it('範囲の外の平熱と重なっても、両方を示す', async () => {
    const { rows } = await api.parseChildCsv(`${head}C501,西田 太郎,にしだ たろう,${birthOf('C001')},1,さくら組,45.0`);
    expect(rows[0].warning).toContain('平熱');
    expect(rows[0].warning).toContain('C001');
  });
});

describe('園児情報の登録の確認画面で知らせる', () => {
  async function fillAndConfirm(name: string, kana: string, birth: string) {
    open('/staff/children/new', admin);
    // 園児IDに次の番号が入るのを待つ
    await waitFor(() => expect((screen.getByLabelText('園児ID') as HTMLInputElement).value).toMatch(/^C\d+$/),
      { timeout: 3000 });
    fireEvent.change(screen.getByLabelText('氏名'), { target: { value: name } });
    fireEvent.change(screen.getByLabelText('よみ'), { target: { value: kana } });
    fireEvent.change(screen.getByLabelText('生年月日'), { target: { value: birth } });
    fireEvent.click(screen.getByRole('button', { name: '確認へ進む' }));
    await screen.findByText('この内容で登録します', undefined, { timeout: 3000 });
  }

  it('同じ氏名・生年月日の園児がいれば知らせる。登録は止めない', async () => {
    await fillAndConfirm('西田　太郎', 'にしだ たろう', birthOf('C001'));
    const notice = await screen.findByText(/同じ氏名・生年月日の園児がいます/, undefined, { timeout: 3000 });
    expect(notice.textContent).toContain('C001');
    expect((screen.getByRole('button', { name: '登録する' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('在籍でない園児は、状態を添えて知らせる', async () => {
    await api.saveChild(admin, {
      child_id: 'C962', child_name: '卒園 一', child_name_kana: 'そつえん いち', birth_date: '2020-06-06',
      sex: '2', normal_temperature: null, photo_consent_level: '2', class_id: 2, allergies: [], medical_histories: [],
    }, 'create');
    db.children.find((c) => c.child_id === 'C962')!.enrollment_status = '3';
    await fillAndConfirm('卒園 一', 'そつえん いち', '2020-06-06');
    const notice = await screen.findByText(/同じ氏名・生年月日の園児がいます/, undefined, { timeout: 3000 });
    expect(notice.textContent).toContain('C962 卒園 一・卒園');
  });

  it('いなければ知らせない', async () => {
    await fillAndConfirm('新規 一', 'しんき いち', '2025-04-01');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/同じ氏名・生年月日の園児がいます/)).toBeNull();
  });
});
