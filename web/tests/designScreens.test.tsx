// @vitest-environment jsdom
/*
 * 設計と画面の食い違い（GitHub Issue #178 の 1・3〜8）
 * 典拠：図/画面遷移図.md「共通・認証」(2)、図/画面詳細図.md「全画面に共通する規定」(0-2)・「職員（タブレット／PC）」(1-1)・
 *      「パスワード変更画面」(2-4)・「利用規約同意画面」(2-5)・「職員ダッシュボード」(2-6)・
 *      「チャット画面（保護者・スマートフォン）」(4-2)・「誤送信対応記録画面（管理者）」(4-4)・
 *      「発達チェック入力画面」(6-2)・「スケジュール設定画面（管理者）」(6-3)
 *
 * 相手はモック（api/mock.ts）。デモデータはこのファイルの中で使い回すため、書き換えるテストは新しいデータを作って使う。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider, useSession } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: '1' | '2' | '3', email: string, display_name: string,
  extra: Partial<SessionUser> = {}): SessionUser => ({
  account_id, email, role, display_name, staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', 'nishida@hoiku.example.jp', '西田 拓也', { staff_id: 'S001' });
const teacher = user(3, '2', 'suzuki@hoiku.example.jp', '鈴木 浩之', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
// 一時パスワード中の職員（デモの 村田 真一。パスワードは temp0901）
const tempStaff = user(4, '2', 'murata@hoiku.example.jp', '村田 真一', { staff_id: 'S004', class_id: 1, class_name: 'さくら組', is_temp_password: true });
const kubota = user(5, '2', 'kubota@hoiku.example.jp', '久保田 和也', { staff_id: 'S005', class_id: 2, class_name: 'ひまわり組' });
const guardian = user(6, '3', 'nishida.t@example.jp', '西田 拓也', { guardian_id: 'G001' });
// 規約の再同意が要る保護者（デモの 遠藤 花子の保護者。同意した版が 0.9）
const reagree = user(7, '3', 'endo.n@example.jp', '遠藤 直人', { guardian_id: 'G002', terms_agreed: false });

/** いまの経路とログイン中の利用者を、画面の外から読めるように書き出す */
function Probe() {
  const { pathname } = useLocation();
  const { user: u } = useSession();
  return <div data-testid="probe" data-path={pathname} data-user={u ? String(u.account_id) : ''} hidden />;
}
const probe = () => screen.getByTestId('probe');

function open(path: string, u: SessionUser | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={u}>
        <App />
        <Probe />
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

describe('誤送信対応の「発生日時」は必須（GitHub Issue #178 の 1）', () => {
  it('発生日時を空にすると「記録する」を押せない。戻すと押せ、入れた発生日時で残る', async () => {
    const sent = await api.send(teacher, 3, '（誤送信）遠足の集合場所');
    await api.retract(teacher, sent.chat_message_id);
    open('/staff/admin/misdelivery', admin);
    await settled();
    const row = await waitFor(() => {
      const r = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent?.includes('さくら組')
        && tr.querySelector('button'));
      expect(r).toBeTruthy();
      return r!;
    }, { timeout: 3000 });
    fireEvent.click(within(row).getByRole('button', { name: '対応を記録する' }));

    const occurred = screen.getByLabelText('発生日時') as HTMLInputElement;
    // 初期値は対象メッセージの送信日時（画面詳細図 4-4 項目3）
    expect(occurred.value).toBe(sent.sent_at.slice(0, 16));
    fireEvent.click(screen.getByLabelText('既読は付いていなかった'));
    fireEvent.change(screen.getByLabelText('とった対応'), { target: { value: '送信者へ取り消しを依頼した' } });
    const record = screen.getByRole('button', { name: '記録する' }) as HTMLButtonElement;
    expect(record.disabled).toBe(false);

    fireEvent.change(occurred, { target: { value: '' } });
    expect(record.disabled).toBe(true);

    fireEvent.change(occurred, { target: { value: sent.sent_at.slice(0, 16) } });
    expect(record.disabled).toBe(false);
    fireEvent.click(record);
    await waitFor(() => expect(db.misdeliveryRecords.some((r) => r.chat_message_id === sent.chat_message_id)).toBe(true));
    const saved = db.misdeliveryRecords.find((r) => r.chat_message_id === sent.chat_message_id)!;
    expect(saved.occurred_at).toBe(`${sent.sent_at.slice(0, 16)}:00`);
  });
});

describe('職員のメニューに「パスワードの変更」「利用規約」を置く（GitHub Issue #178 の 3）', () => {
  it('サイドナビから、パスワード変更画面（任意）と利用規約の参照へ移れる', async () => {
    open('/staff', teacher);
    await settled();
    const nav = screen.getByRole('navigation', { name: '職員メニュー' });

    fireEvent.click(within(nav).getByRole('link', { name: 'パスワードの変更' }));
    await waitFor(() => expect(probe().dataset.path).toBe('/staff/password'));
    expect(screen.getByRole('heading', { name: 'パスワードの変更' })).toBeTruthy();
    // 任意の変更では、一時パスワードの案内を出さない（画面詳細図 2-4 項目1）
    expect(document.body.textContent).not.toContain('一時パスワードでログインしています');

    fireEvent.click(within(nav).getByRole('link', { name: '利用規約' }));
    await waitFor(() => expect(probe().dataset.path).toBe('/staff/terms'));
    expect(screen.getByRole('heading', { name: '利用規約' })).toBeTruthy();
  });
});

describe('強制のパスワード変更・規約への同意の経路（GitHub Issue #178 の 4）', () => {
  it('一時パスワードの画面に「変更せずログアウトする」を置き、押すと職員用トップへ戻る', async () => {
    open('/password-change', tempStaff);
    expect(screen.getByText(/一時パスワードでログインしています/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '変更せずログアウトする' }));
    await waitFor(() => expect(probe().dataset.path).toBe('/staff-top'));
    expect(probe().dataset.user).toBe('');
    expect(screen.getByText('職員用の入口')).toBeTruthy();
  });

  it('未ログインで開くと、白紙にせず入口へ送る', async () => {
    for (const path of ['/password-change', '/terms-agree']) {
      open(path, null);
      await waitFor(() => expect(probe().dataset.path).toBe('/'));
      expect(screen.getByText('保護者用の入口')).toBeTruthy();
      cleanup();
    }
  });

  it('一時パスワードでない職員が開くと、任意の変更の画面へ送り、強制の案内を出さない', async () => {
    open('/password-change', teacher);
    await waitFor(() => expect(probe().dataset.path).toBe('/staff/password'));
    expect(document.body.textContent).not.toContain('一時パスワードでログインしています');
    expect(screen.getByRole('navigation', { name: '職員メニュー' })).toBeTruthy();
  });

  it('同意済みの利用者が規約への同意を開くと、利用規約の参照へ送る', async () => {
    open('/terms-agree', guardian);
    await waitFor(() => expect(probe().dataset.path).toBe('/guardian/terms'));
    expect(screen.queryByRole('button', { name: '同意して進む' })).toBeNull();
  });

  it('一時パスワードから変更すると、任意の変更の画面ではなくダッシュボードへ進む', async () => {
    open('/password-change', tempStaff);
    fireEvent.change(screen.getByLabelText('現在のパスワード'), { target: { value: 'temp0901' } });
    fireEvent.change(screen.getByLabelText('新しいパスワード'), { target: { value: 'murata-5678' } });
    fireEvent.change(screen.getByLabelText('新しいパスワード（確認）'), { target: { value: 'murata-5678' } });
    fireEvent.click(screen.getByRole('button', { name: '変更する' }));
    await waitFor(() => expect(probe().dataset.path).toBe('/staff'), { timeout: 3000 });
    await settled();
    expect(screen.getByRole('heading', { name: 'ダッシュボード' })).toBeTruthy();
  });

  it('規約に同意すると、利用規約の参照ではなく保護者ホームへ進む', async () => {
    open('/terms-agree', reagree);
    await settled();
    fireEvent.click(screen.getByLabelText('利用規約に同意します'));
    fireEvent.click(screen.getByRole('button', { name: '同意して進む' }));
    await waitFor(() => expect(probe().dataset.path).toBe('/guardian'), { timeout: 3000 });
  });
});

describe('保護者のクラスのチャンネルに「園からのお知らせ」の文言を出さない（GitHub Issue #178 の 5）', () => {
  it('園からのお知らせには設計の文言、クラスのチャンネルにはクラスのお知らせである旨を出す', async () => {
    open('/guardian/chat', guardian);
    await settled();
    const roomButton = (label: string) => waitFor(() => {
      const b = Array.from(document.querySelectorAll<HTMLButtonElement>('button.guardian-room-link'))
        .find((x) => x.textContent?.includes(label));
      expect(b).toBeTruthy();
      return b!;
    }, { timeout: 3000 });

    fireEvent.click(await roomButton('さくら組'));
    await settled();
    expect(document.body.textContent).not.toContain('こちらは園からのお知らせです。');
    expect(document.body.textContent).toContain('こちらはクラスのお知らせです。返信はできません。');

    fireEvent.click(screen.getByRole('button', { name: '< もどる' }));
    fireEvent.click(await roomButton('園からのお知らせ'));
    await settled();
    expect(document.body.textContent).toContain('こちらは園からのお知らせです。返信はできません。');
  });
});

describe('職員ダッシュボードの園内のことは、0 件の行も出す（GitHub Issue #178 の 6）', () => {
  it('件数が 0 の項目も、ラベル・件数・「開く」を並べる', async () => {
    open('/staff', kubota);
    await settled();
    const table = screen.getByRole('heading', { name: '園内のこと' }).closest('section')!;
    // 異常時の記録の行は、下書きのままのヒヤリハットも数えるため名前を変えた（GitHub Issue #142 の 5。web/仮置き値.md）
    for (const label of ['差し戻された日誌', '未対応の個人チャット', '発達チェックの未実施（担当クラス）', 'ヒヤリハット未起票・下書きのままの異常時の記録']) {
      const row = Array.from(table.querySelectorAll('tr')).find((tr) => tr.textContent?.includes(label));
      expect(row, label).toBeTruthy();
      expect(within(row!).getByRole('link', { name: '開く' })).toBeTruthy();
    }
    // 久保田（ひまわり組）に差し戻された日誌は無い。0 件のまま行に出る
    const returned = Array.from(table.querySelectorAll('tr')).find((tr) => tr.textContent?.includes('差し戻された日誌'))!;
    expect(returned.textContent).toContain('0 件');
  });
});

describe('スケジュール設定の「上書きする」は、日付を変えるまで押せない（GitHub Issue #178 の 7）', () => {
  it('予定の無い園児でも、初めは押せない。日付を変えると押せる', async () => {
    // デモデータの在籍園児には、すべて予定がある（GitHub Issue #164 の 3）。第3.0版より前に登録した園児のように、
    // さくら組の最後の園児の予定を外して、予定の無い園児を作る
    const target = db.classChildren
      .filter((cc) => cc.class_id === 1)
      .map((cc) => db.children.find((c) => c.child_id === cc.child_id)!).at(-1)!;
    expect(target).toBeTruthy();
    for (let i = db.developmentSchedules.length - 1; i >= 0; i--) {
      if (db.developmentSchedules[i].child_id === target.child_id) db.developmentSchedules.splice(i, 1);
    }

    open('/staff/growth/schedule', admin);
    await settled();
    const input = await waitFor(() => screen.getByLabelText(`${target.child_name}の次回の予定日`) as HTMLInputElement,
      { timeout: 3000 });
    const button = within(input.closest('tr')!).getByRole('button', { name: '上書きする' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: '2099-01-15' } });
    expect(button.disabled).toBe(false);
  });
});

describe('スケジュール設定画面の「予定の無い園児に推奨を当てる」（GitHub Issue #164 の 3）', () => {
  it('確かめてから当て、予定の無かった園児の行に予定日が出る', async () => {
    // さくら組の 山本 陽翔（C011。確定した記録が無い）の予定を外して、予定の無い園児を作る（第3.0版より前に登録した園児）
    const target = db.children.find((c) => c.child_id === 'C011')!;
    for (let i = db.developmentSchedules.length - 1; i >= 0; i--) {
      if (db.developmentSchedules[i].child_id === target.child_id) db.developmentSchedules.splice(i, 1);
    }

    open('/staff/growth/schedule', admin);
    await settled();
    const row = await waitFor(() => screen.getByLabelText(`${target.child_name}の次回の予定日`).closest('tr')!,
      { timeout: 3000 });
    // 設定中の予定日は「―」
    expect(row.querySelectorAll('td')[4].textContent).toBe('―');

    fireEvent.click(screen.getByRole('button', { name: '予定の無い園児に推奨を当てる' }));
    const dialog = await screen.findByRole('dialog', { name: '予定の無い園児に推奨を当てる' });
    // 確かめるだけでは当てない
    expect(db.developmentSchedules.some((s) => s.child_id === target.child_id)).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: '当てる' }));

    await waitFor(() => expect(db.developmentSchedules.some((s) => s.child_id === target.child_id)).toBe(true));
    await waitFor(() => {
      const again = screen.getByLabelText(`${target.child_name}の次回の予定日`).closest('tr')!;
      expect(again.querySelectorAll('td')[4].textContent).not.toBe('―');
    }, { timeout: 3000 });
  });
});

describe('発達チェック入力の「所見」に、園内限定である旨を添える（GitHub Issue #178 の 8）', () => {
  it('所見の欄に、保護者へは共有しない旨が出る', async () => {
    open('/staff/growth/dev/C003', teacher);
    await settled();
    const note = await waitFor(() => screen.getByLabelText('所見'), { timeout: 3000 });
    const description = note.getAttribute('aria-describedby');
    expect(description).toBeTruthy();
    expect(document.getElementById(description!)?.textContent).toContain('園内限定');
    expect(document.getElementById(description!)?.textContent).toContain('保護者へは共有しません');
  });
});
