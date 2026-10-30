// @vitest-environment jsdom
/*
 * 保存した設定が、次に開いた画面に効くこと（Issue #302 の段14a の続き）
 *   - dev.notice_days_before：発達チェックの予定日が「近い」とする日数（発達チェック一覧・職員ダッシュボード）
 *   - approval.warn_days：承認待ちの滞留の印を付ける日数（承認待ち一覧）
 * 典拠：基本設計書「設定マスタ」(5-9)・「推奨スケジュールの作り方」(4-9)、
 *      図/画面詳細図.md「発達チェック一覧画面」(6-1) 項目13・「承認待ち一覧画面」(3-4) 項目5・「職員ダッシュボード」(2-6) 項目4
 *
 * ここで確かめる規則は、Go サーバ（server/api_dev.go の devNear、server/api_diary_write.go の handlePendingDiaries）にも
 * 同じものがある。server/api_settings_effect_test.go が同じ観点を確かめている。片方だけを直すと食い違う。
 *
 * mockDb はこのファイルのテストどうしで使い回す。件数は決め打ちせず、前後の差と一覧の件数で確かめる。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { addDays, today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: '1' | '2', email: string, extra: Partial<SessionUser> = {}): SessionUser => ({
  account_id, email, role, display_name: email, staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', 'nishida@hoiku.example.jp', { staff_id: 'S001', display_name: '西田 拓也' });
const teacher = user(3, '2', 'suzuki@hoiku.example.jp', { staff_id: 'S003', class_id: 1, class_name: 'さくら組', display_name: '鈴木 浩之' });

/** 設定画面と同じ道（saveSettings）で1つの設定を変える */
async function saveSetting(key: string, value: string) {
  const v = await api.settings(admin);
  await api.saveSettings(admin, { [key]: value }, v.read_at);
}

/** 園児の予定を指定の1件にし、確定した記録を消す */
function resetChild(childId: string, scheduledOn: string, id: number) {
  const keep = db.developmentSchedules.filter((s) => s.child_id !== childId);
  db.developmentSchedules.splice(0, db.developmentSchedules.length, ...keep,
    { development_schedule_id: id, child_id: childId, scheduled_on: scheduledOn, is_manual_override: false, created_staff_id: 'S001' });
  const checks = db.developmentChecks.filter((c) => c.child_id !== childId);
  db.developmentChecks.splice(0, db.developmentChecks.length, ...checks);
}

afterEach(cleanup);

describe('dev.notice_days_before（モックの規則）', () => {
  it('予定日が近い園児を設定の日数で決め、一覧とダッシュボードが同じ数を出す。過ぎたとは重ならない', async () => {
    // C009 の予定を、今日から 10 日後の1件だけにする
    resetChild('C009', addDays(today(), 10), 990101);
    const row = async () => (await api.list(teacher, 1)).find((r) => r.child.child_id === 'C009')!;
    const nearInAll = async () => {
      let n = 0;
      for (const c of db.classes) n += (await api.list(admin, c.class_id)).filter((r) => r.near).length;
      return n;
    };

    // 既定の 7 日では、10 日後は近くない
    expect(await row()).toMatchObject({ near: false, overdue: false });
    const base = (await api.staffSummary(admin)).devNear;
    expect(base).toBe(await nearInAll());

    // 10 日に変えると、次に開いた一覧とダッシュボードで近いになる
    await saveSetting('dev.notice_days_before', '10');
    expect(await row()).toMatchObject({ near: true, overdue: false });
    const after = (await api.staffSummary(admin)).devNear;
    expect(after).toBeGreaterThanOrEqual(base + 1);
    expect(after).toBe(await nearInAll());

    // 9 日にすると、また近くない
    await saveSetting('dev.notice_days_before', '9');
    expect((await row()).near).toBe(false);
    expect((await api.staffSummary(admin)).devNear).toBe(await nearInAll());
    await saveSetting('dev.notice_days_before', '7');
  });

  it('当日と、ちょうど設定の日数あとは近い。昨日は過ぎた（近いではない）。確定すると次の予定日は遠い', async () => {
    const rowFor = async (on: string) => {
      resetChild('C010', on, 990102);
      return (await api.list(teacher, 1)).find((r) => r.child.child_id === 'C010')!;
    };
    expect(await rowFor(today())).toMatchObject({ near: true, overdue: false });
    expect(await rowFor(addDays(today(), 7))).toMatchObject({ near: true, overdue: false });
    expect(await rowFor(addDays(today(), 8))).toMatchObject({ near: false, overdue: false });
    expect(await rowFor(addDays(today(), -1))).toMatchObject({ near: false, overdue: true });
    await rowFor(today());
    await api.saveCheck(teacher, 'C010', today(), [], '', '2');
    expect((await api.list(teacher, 1)).find((r) => r.child.child_id === 'C010')!.near).toBe(false);
  });
});

describe('approval.warn_days（モックの規則）', () => {
  it('申請からの日数が設定を越えたら滞留。ちょうどの日数は越えていない。設定を変えると次の一覧から効く', async () => {
    const [first] = await api.pendingDiaries(admin);
    expect(first).toBeTruthy();
    const d = db.diaries.find((x) => x.diary_id === first.diary_id)!;
    d.applied_at = `${addDays(today(), -5)}T09:00:00`;
    const find = async () => (await api.pendingDiaries(admin)).find((x) => x.diary_id === d.diary_id)!;

    expect(await find()).toMatchObject({ elapsed_days: 5, warn_days: 3, stale: true });
    await saveSetting('approval.warn_days', '5');
    expect(await find()).toMatchObject({ elapsed_days: 5, warn_days: 5, stale: false });
    await saveSetting('approval.warn_days', '4');
    expect(await find()).toMatchObject({ warn_days: 4, stale: true });

    // 申請した日と同じ日は 0 日。滞留にしない
    d.applied_at = `${today()}T00:00:00`;
    expect(await find()).toMatchObject({ elapsed_days: 0, stale: false });
    await saveSetting('approval.warn_days', '3');
  });

  it('管理者だけが見られる', async () => {
    // 一覧の取得は承認ではないので、承認の文ではなく管理者だけの経路の文で断る（server/session.go の requireAdmin と同じ）
    await expect(api.pendingDiaries(teacher)).rejects.toThrow('この操作は管理者のみが行えます');
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
const staleTags = () => Array.from(document.querySelectorAll('table.list .tag-returned'))
  .filter((e) => e.textContent === '滞留');

describe('画面', () => {
  it('承認待ち一覧：滞留は色に加えて「滞留」の文字を出し、設定を変えると次に開いたときに消える', async () => {
    const [first] = await api.pendingDiaries(admin);
    const d = db.diaries.find((x) => x.diary_id === first.diary_id)!;
    d.applied_at = `${addDays(today(), -5)}T09:00:00`;
    await saveSetting('approval.warn_days', '3');

    open('/staff/admin/approval', admin);
    await waitFor(() => expect(document.querySelector('table.list')).toBeTruthy(), { timeout: 3000 });
    expect(document.body.textContent).toContain('5 日');
    expect(staleTags().length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('3 日を超えたものに');
    cleanup();

    await saveSetting('approval.warn_days', '5');
    open('/staff/admin/approval', admin);
    await waitFor(() => expect(document.querySelector('table.list')).toBeTruthy(), { timeout: 3000 });
    expect(staleTags().length).toBe(0);
    expect(document.body.textContent).toContain('5 日を超えたものに');
    await saveSetting('approval.warn_days', '3');
  });

  it('発達チェック一覧：近い園児を知らせ、状態に「予定日が近い」を出す。設定を変えると次に開いたときに消える', async () => {
    resetChild('C009', addDays(today(), 5), 990103);
    await saveSetting('dev.notice_days_before', '7');

    open('/staff/growth', teacher);
    await waitFor(() => expect(document.body.textContent).toContain('予定日が近い園児が'), { timeout: 3000 });
    await settled();
    const tr = Array.from(document.querySelectorAll('tr')).find((r) => r.textContent?.includes('加藤 大和'));
    expect(tr?.textContent).toContain('予定日が近い');
    cleanup();

    await saveSetting('dev.notice_days_before', '3');
    open('/staff/growth', teacher);
    await waitFor(() => expect(document.querySelector('table.list')).toBeTruthy(), { timeout: 3000 });
    const tr2 = Array.from(document.querySelectorAll('tr')).find((r) => r.textContent?.includes('加藤 大和'));
    expect(tr2?.textContent).not.toContain('予定日が近い');
    await saveSetting('dev.notice_days_before', '7');
  });

  it('職員ダッシュボード：「発達チェックの予定日が近い」の行を、未実施とは別に出す', async () => {
    open('/staff', teacher);
    await settled();
    await waitFor(() => {
      expect(document.body.textContent).toContain('発達チェックの予定日が近い');
      expect(document.body.textContent).toContain('発達チェックの未実施');
    }, { timeout: 3000 });
  });
});
