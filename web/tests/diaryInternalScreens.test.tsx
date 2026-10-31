// @vitest-environment jsdom
/*
 * 日誌を園内の記録にした作り直しの画面：申請の取り下げ・承認の取り消し・承認待ち一覧の列と並び・承認画面
 * 典拠：詳細設計書.md「日誌の画面（作り直し）」(2-13 (1)〜(3))
 *
 * API の規則は web/tests/diaryInternal.test.ts（モック）と server/api_diary_internal_test.go（Go サーバ）が確かめる。
 * ここでは画面の出し分けと操作を確かめる。時計は tests/setup-clock.ts の 18:00 のまま使う。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const admin2: SessionUser = {
  account_id: 2, email: 'endo@hoiku.example.jp', role: '1', display_name: '遠藤 直人',
  staff_id: 'S002', guardian_id: null, class_id: null, class_name: null,
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

afterEach(cleanup);

const statusOf = (id: number) => db.diaries.find((d) => d.diary_id === id)?.status;
const button = (name: string) => screen.queryByRole('button', { name }) as HTMLButtonElement | null;

describe('日誌一覧画面：申請の取り下げ（2-13 (2)）', () => {
  it('自分が申請した申請中の行にだけ「申請を取り下げる」を出し、確かめてから下書きに戻す', async () => {
    // 日誌 2 は鈴木が申請したさくら組のクラス日誌、日誌 7 は村田が申請した個人日誌（どちらも申請中）
    open('/staff/diary', teacher);
    await settled();
    await waitFor(() => expect(screen.getAllByRole('link', { name: '開く' }).length).toBeGreaterThan(0));
    const rowOf = (id: number) => screen.getAllByRole('link', { name: '開く' })
      .find((a) => a.getAttribute('href') === `/staff/diary/${id}`)!.closest('tr')!;
    expect(within(rowOf(7)).queryByRole('button', { name: '申請を取り下げる' })).toBeNull();
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: '申請を取り下げる' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('申請を取り下げますか。下書きに戻り、承認待ちから外れます。');
    fireEvent.click(within(dialog).getByRole('button', { name: '取り下げる' }));
    await waitFor(() => expect(document.body.textContent).toContain('申請を取り下げました。下書きに戻っています'));
    expect(statusOf(2)).toBe('1');
    await waitFor(() => expect(within(rowOf(2)).queryByRole('button', { name: '申請を取り下げる' })).toBeNull());
  });
});

describe('日誌作成・編集画面：申請の取り下げ（2-13 (2)）', () => {
  it('申請した本人が取り下げると、下書きとしてロックを取って開き直し、編集できる', async () => {
    const d = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C001', class_id: 1, diary_date: today(), body: '取り下げてから直す日誌',
    }, '2');
    open(`/staff/diary/${d.diary_id}`, teacher);
    await settled();
    expect(document.body.textContent).toContain('申請中のため編集できません。');
    expect(document.body.textContent).toContain('申請：鈴木 浩之');
    fireEvent.click(button('申請を取り下げる')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '取り下げる' }));

    await waitFor(() => expect(statusOf(d.diary_id)).toBe('1'));
    await waitFor(() => expect(button('下書き保存')?.disabled).toBe(false));
    expect((screen.getByLabelText(/本文/) as HTMLTextAreaElement).disabled).toBe(false);
    expect(button('申請を取り下げる')).toBeNull();
    expect(db.diaryLocks.find((l) => l.diary_id === d.diary_id)?.locked_staff_id).toBe('S003');
  });

  it('申請した本人でなければ「申請を取り下げる」を出さない', async () => {
    // 日誌 7 は村田が申請中
    open('/staff/diary/7', teacher);
    await settled();
    expect(document.body.textContent).toContain('申請中のため編集できません。');
    expect(button('申請を取り下げる')).toBeNull();
  });
});

describe('日誌作成・編集画面：承認の取り消し（2-13 (3)）', () => {
  it('管理者は承認済みの日誌の下端で、理由を書いてから取り消して差し戻す', async () => {
    // 日誌 5 は西田 拓也が承認した、西田 太郎の個人日誌
    open('/staff/diary/5', admin2);
    await settled();
    expect(document.body.textContent).toContain('承認済みのため編集できません。');
    expect(document.body.textContent).toContain('承認：西田 拓也');
    fireEvent.click(button('承認を取り消して差し戻す')!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('承認を取り消して差し戻します。作成者の一覧に差し戻しとして出ます。保護者へは何も届いていません。');
    const confirm = within(dialog).getByRole('button', { name: '取り消して差し戻す' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/承認を取り消す理由/), { target: { value: '午睡の記録を確かめ直してください' } });
    expect(dialog.textContent).toContain(`残り ${500 - '午睡の記録を確かめ直してください'.length} 文字`);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(document.body.textContent).toContain('承認を取り消し、差し戻しました。'));
    expect(statusOf(5)).toBe('4');
    await waitFor(() => expect(document.body.textContent).toContain('差し戻されています：午睡の記録を確かめ直してください'));
  });

  it('一般の職員には承認の取り消しを出さない', async () => {
    // 日誌 4 は承認済み（さくら組）
    open('/staff/diary/4', teacher);
    await settled();
    expect(document.body.textContent).toContain('承認済みのため編集できません。');
    expect(button('承認を取り消して差し戻す')).toBeNull();
  });
});

describe('承認待ち一覧画面と日誌承認画面（2-13 (1)）', () => {
  it('列名は「申請者」で、自分が申請したものに「ほかの管理者へ」を出す', async () => {
    await api.saveDiary(admin, {
      record_type: '2', child_id: null, class_id: 2, diary_date: today(), body: '園長が申請したクラス日誌',
    }, '2');
    open('/staff/admin/approval', admin);
    await settled();
    await waitFor(() => expect(screen.getByRole('columnheader', { name: '申請者' })).toBeTruthy());
    expect(screen.queryByRole('columnheader', { name: '作成者' })).toBeNull();
    expect(document.body.textContent).toContain('ほかの管理者へ');
  });

  it('承認画面は保護者への共有を置かず、開いたあとに取り下げられたら「取り下げられました」を出して押せなくする', async () => {
    const d = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C001', class_id: 1, diary_date: today(), body: '承認の前に取り下げる日誌',
    }, '2');
    open(`/staff/admin/approval/${d.diary_id}`, admin);
    await settled();
    expect(document.body.textContent).toContain('申請者 鈴木 浩之');
    expect(document.body.textContent).not.toContain('保護者への共有');
    // 画面を開いたあとに、申請した本人が取り下げた
    await api.withdrawDiary(teacher, d.diary_id, d.updated_at);
    fireEvent.click(button('承認する')!);
    await waitFor(() => expect(document.body.textContent).toContain('この日誌は取り下げられました。'));
    await waitFor(() => expect(button('承認する')?.disabled).toBe(true));
    expect(button('差し戻す')?.disabled).toBe(true);
    expect(statusOf(d.diary_id)).toBe('1');
  });

  /*
   * 断ったあとは、日誌と写真の両方を読み直し、読み直したことを伝える文を出す（照合 c5-10。文は【仮置き】web/仮置き値.md）。
   * 申請し直しでは写真も差し替えられる（server/api_diary_write.go の replaceDiaryAttachments）
   */
  it('開いたあとに取り下げて本文と共有を変えて申請し直されたら、古い画面の承認は断って文を出し、読み直した本文と写真で承認できる', async () => {
    const d = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C001', class_id: 1, diary_date: today(), body: '管理者が読んだ本文',
    }, '2');
    open(`/staff/admin/approval/${d.diary_id}`, admin);
    await settled();
    expect(document.body.textContent).toContain('管理者が読んだ本文');
    const photos = () => document.querySelectorAll('.card .row .tag-plain').length;
    expect(photos()).toBe(0);
    // 画面を開いたあとに、申請した本人が取り下げ、本文と「保護者へ共有する」と写真を変えて申請し直した
    await api.withdrawDiary(teacher, d.diary_id, d.updated_at);
    const lock = await api.acquireLock(teacher, d.diary_id);
    if (!('token' in lock)) throw new Error(`ロックを取れませんでした（${lock.heldBy}さんが編集中）`);
    await api.saveDiary(teacher, {
      diary_id: d.diary_id, record_type: '1', child_id: 'C001', class_id: 1, diary_date: today(),
      body: '書き換えた本文', share_to_guardian: true, lock_token: lock.token,
      attachments: [{ file_path: 'diary/a.jpg', file_type: 'image/jpeg' }, { file_path: 'diary/b.jpg', file_type: 'image/jpeg' }],
    }, '2');

    // 古い画面のまま「承認する」を押すと断られ、日誌と写真を読み直して、読み直したことを伝える
    fireEvent.click(button('承認する')!);
    await waitFor(() => expect(document.body.textContent)
      .toContain('ほかの職員が日誌を更新したので、いまの内容を読み直しました。確かめてからもう一度押してください。'));
    expect(document.body.textContent).not.toContain('内容を再読み込みしてください');
    expect(statusOf(d.diary_id)).toBe('2');
    await waitFor(() => expect(document.body.textContent).toContain('書き換えた本文'));
    expect(document.body.textContent).not.toContain('管理者が読んだ本文');
    expect(document.body.textContent).toContain('保育士が保護者への共有を選んでいます。');
    await waitFor(() => expect(photos()).toBe(2));

    // 読み直した本文を見てから押すと承認できる
    fireEvent.click(button('承認して保護者へ共有する')!);
    await waitFor(() => expect(statusOf(d.diary_id)).toBe('3'));
  });
});

/*
 * 共有を選んだ個人日誌に、保護者の連絡帳に出していない項目（contact.show_items で外した項目）が、きょうのようすから入っていれば、
 * 項目の名前を挙げて注意する。判定して消すことはしない（照合 c2b-2 の推し。【仮置き】web/仮置き値.md）
 */
describe('日誌作成・編集画面と日誌承認画面：保護者の連絡帳に出していない項目の注意', () => {
  /** 西田 太郎（C001）のきょうの給食（11:40 少し）を置き、食事を保護者へ出さない設定にして fn を回す。終わったら戻す */
  async function withHiddenMeal(fn: () => Promise<void>) {
    const day = today();
    const at = `${day}T11:40:00`;
    const ev = {
      contact_event_id: 99001, child_id: 'C001', class_id: 1, contact_date: day, recorded_at: at, event_type: '1' as const,
      meal_kind: '1' as const, meal_amount: '3' as const, toilet_label: null, temperature: null, body: null, contact_photo_id: null,
      keep_in_growth: false, staff_id: 'S003', corrected_at: null, is_deleted: false, created_at: at, updated_at: at,
    };
    const setting = db.settings.find((s) => s.setting_key === 'contact.show_items')!;
    const saved = setting.setting_value;
    db.contactEvents.push(ev);
    setting.setting_value = 'nap,toilet,temperature,comment,photo,class';
    try {
      await fn();
    } finally {
      setting.setting_value = saved;
      db.contactEvents.splice(db.contactEvents.indexOf(ev), 1);
    }
  }
  const shared = (status: '1' | '2') => api.saveDiary(teacher, {
    record_type: '1', child_id: 'C001', class_id: 1, diary_date: today(), body: '11:40 給食 少し', share_to_guardian: true,
  }, status);

  it('承認画面：共有を選んだ日誌に、保護者の連絡帳に出していない項目が入っていれば、名前を挙げて注意する', async () => {
    await withHiddenMeal(async () => {
      const d = await shared('2');
      open(`/staff/admin/approval/${d.diary_id}`, admin);
      await settled();
      await waitFor(() => expect(document.body.textContent).toContain('保護者の連絡帳に出していない項目（食事）が、きょうのようすから本文に入っています。'));
      expect(document.body.textContent).toContain('承認すると、保護者がこの日誌で読みます。');
    });
  });

  it('作成・編集画面：共有を選んでいるあいだだけ、名前を挙げて注意する', async () => {
    await withHiddenMeal(async () => {
      const d = await shared('1');
      open(`/staff/diary/${d.diary_id}`, teacher);
      await settled();
      await waitFor(() => expect(document.body.textContent).toContain('保護者の連絡帳に出していない項目（食事）'));
      expect(document.body.textContent).toContain('共有すると、保護者がこの日誌で読みます。');
      fireEvent.click(screen.getByRole('checkbox', { name: /保護者へ共有する/ }));
      expect(document.body.textContent).not.toContain('保護者の連絡帳に出していない項目');
    });
  });
});
