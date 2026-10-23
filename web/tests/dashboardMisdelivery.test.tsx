// @vitest-environment jsdom
/*
 * 管理者のダッシュボードの「対応の記録がない取り消し」（GitHub Issue #141 の 3）
 * 典拠：図/画面詳細図.md「誤送信対応記録画面（管理者）」(4-4) 項目9・「この記録は管理者が行う」、
 *      基本設計書「誤送信への対応」(4-6)
 * 【仮置き】行の名前と並び（web/仮置き値.md「職員ダッシュボードの『対応の記録がない取り消し』」）。
 *
 * 職員が取り消したメッセージは、管理者が誤送信対応の画面を自分から開かないと気づけなかった。
 * 管理者のダッシュボードにだけ件数を出し、数える範囲は同じ画面の「対応の記録がない取り消し」の一覧とそろえる。
 * ここで確かめる規則は、Go サーバ（server/api_dashboard.go の handleStaffSummary）にも同じものがある。
 * server/api_dashboard_misdelivery_test.go が同じ観点を確かめている。片方だけを直すと食い違う。
 *
 * mockDb はこのファイルのテストどうしで使い回す。件数は決め打ちせず、前後の差と一覧の件数で確かめる。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: '1' | '2' | '3', email: string, extra: Partial<SessionUser> = {}): SessionUser => ({
  account_id, email, role, display_name: email, staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', 'nishida@hoiku.example.jp', { staff_id: 'S001', display_name: '西田 拓也' });
const teacher = user(3, '2', 'suzuki@hoiku.example.jp', { staff_id: 'S003', class_id: 1, class_name: 'さくら組', display_name: '鈴木 浩之' });
const murata = user(9, '3', 'murata.s@example.jp', { guardian_id: 'G004' });

const LABEL = '対応の記録がない取り消し';
const count = async (u: SessionUser) => (await api.staffSummary(u)).misdeliveryUnrecorded;
/** 管理者のダッシュボードの件数が、誤送信対応の一覧の件数と同じであること */
const expectCount = async (want: number) => {
  expect(await count(admin)).toBe(want);
  expect((await api.retractedWithoutRecord(admin)).length).toBe(want);
};

afterEach(cleanup);

describe('管理者のダッシュボードの「対応の記録がない取り消し」（モックの規則）', () => {
  it('職員の取り消しを数え、保護者の取り消し・配布物の取り下げは数えず、対応を記録すると減る。一般の職員には数えない', async () => {
    const before = await count(admin);
    await expectCount(before);

    // 担任（一般の職員）が個人チャットへ送ったメッセージを取り消すと、管理者の件数が増える
    const byStaff = await api.send(teacher, 8, '（誤送信）西田 太郎くんの発熱の記録');
    await api.retract(teacher, byStaff.chat_message_id);
    await expectCount(before + 1);

    // 一般の職員には数えない（記録するのは管理者。取り消した本人であっても 0）
    expect(await count(teacher)).toBe(0);

    // 保護者が自分で取り消したものは数えない
    const byGuardian = await api.send(murata, 8, '明日はお休みします（打ちまちがい）');
    await api.retract(murata, byGuardian.chat_message_id);
    await expectCount(before + 1);

    // 配布物の取り下げで取り消された掲載の知らせは数えない
    const posted = await api.postHandout(admin, {
      handout_type: '4', title: 'さくら組だより', target_month: '2026-10', class_id: 1,
      file_name: 'sakura.pdf', file_type: 'application/pdf', file_size: 1000,
    });
    await api.withdrawHandout(admin, posted.handout_id);
    await expectCount(before + 1);

    // 対応を記録すると、数が減る
    await api.addMisdeliveryRecord(admin, {
      chat_message_id: byStaff.chat_message_id, occurred_at: '2026-10-17T15:10:00', was_read: false,
      response: '送信者へ取り消しを依頼した',
    });
    await expectCount(before);
  });
});

function open(path: string, u: SessionUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={u}>
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
const findRow = () => Array.from(document.querySelectorAll<HTMLTableRowElement>('tr'))
  .find((tr) => tr.textContent?.includes(LABEL));

describe('管理者のダッシュボードの「対応の記録がない取り消し」（画面）', () => {
  it('管理者には件数の行を出し、「開く」で誤送信対応の記録の画面へ移る', async () => {
    const sent = await api.send(teacher, 8, '（誤送信）明日の持ち物');
    await api.retract(teacher, sent.chat_message_id);
    const n = await count(admin);
    expect(n).toBeGreaterThan(0);

    open('/staff', admin);
    await settled();
    let row: HTMLTableRowElement | undefined;
    await waitFor(() => {
      row = findRow();
      expect(row).toBeTruthy();
    }, { timeout: 3000 });
    expect(row!.textContent).toContain(`${n} 件`);

    const link = within(row!).getByRole('link', { name: '開く' });
    expect(link.getAttribute('href')).toBe('/staff/admin/misdelivery');
    fireEvent.click(link);
    await waitFor(() => {
      expect(document.querySelector('h1')?.textContent).toBe('誤送信対応の記録');
    }, { timeout: 3000 });
  });

  it('一般の職員には行を出さない', async () => {
    open('/staff', teacher);
    await settled();
    // ほかの「未対応」の行が出るまで待ってから、行が無いことを確かめる
    await waitFor(() => {
      expect(document.body.textContent).toContain('未読のチャット');
    }, { timeout: 3000 });
    expect(findRow()).toBeUndefined();
  });
});
