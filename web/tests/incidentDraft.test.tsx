// @vitest-environment jsdom
/*
 * 異常時の記録から起票したヒヤリハットが下書きのままのとき（GitHub Issue #142 の 5）
 * 典拠：図/画面詳細図.md「異常時記録画面」(5-2) 項目9・12（起票は下書きを作ること）、
 *      「職員ダッシュボード」(2-6) 項目9、基本設計書.md「帳票の出力」(4-8)（二重に数えない）。
 * 【仮置き】下書きの扱い（web/仮置き値.md「ヒヤリハットが下書きのままの異常時の記録」）。
 * サーバ側は server/api_nap_incident_draft_test.go で同じ観点を確かめる。
 *
 * mockDb はこのファイルのテストどうしで使い回す。最初のテストが記録 2 から起票した下書きを、あとのテストが使う。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
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

const ABNORMAL_ID = 2; // さくら組・久保田 陸（C005）の記録。未起票（server/seed.sql と同じ）
const twoDaysAgo = () => db.napSessions.find((s) => s.nap_session_id === 3)!.session_date;

const abnormal = async () => (await api.abnormals(admin)).find((a) => a.nap_abnormal_id === ABNORMAL_ID)!;
const withoutDiary = async (u: SessionUser = admin) => (await api.staffSummary(u)).abnormalWithoutDiary;
/** 帳票（CSV）の、久保田 陸の異常時の記録の行 */
const reportLine = async () => {
  const text = await api.napReport(admin, { from: twoDaysAgo(), to: today(), format: 'csv' });
  const line = text.split(/\r?\n/).find((l) => l.includes('久保田 陸') && l.includes('顔色がやや紅潮していた'));
  expect(line, '帳票に久保田 陸の異常時の記録がありません').toBeTruthy();
  return line!;
};
const setDiaryStatus = (diaryId: number, status: '1' | '2') => {
  const d = db.diaries.find((x) => x.diary_id === diaryId)!;
  d.status = status;
  d.applied_staff_id = status === '2' ? 'S003' : null;
  d.applied_at = status === '2' ? `${today()}T17:00:00` : null;
};

afterEach(cleanup);

describe('ヒヤリハットの下書きのままの異常時の記録（モックの規則）', () => {
  it('「起票する」を押しただけでは「起票済み」にせず、申請すると一覧・ダッシュボード・帳票が変わる', async () => {
    // 起票する前：未起票として数える
    const before = await withoutDiary();
    expect(await abnormal()).toMatchObject({ diary_id: null, diary_draft: false });
    expect(await reportLine()).toContain('未起票');

    // 「起票する」を押しただけ（下書き）：一覧は下書きと分かり、ダッシュボードの数は減らない
    const d = await api.raiseIncidentDiary(teacher, ABNORMAL_ID);
    expect(d.status).toBe('1');
    expect(await abnormal()).toMatchObject({ diary_id: d.diary_id, diary_draft: true });
    expect(await withoutDiary()).toBe(before);
    expect(await reportLine()).toContain('起票済み（下書き）');

    // 申請する：「起票済み」になり、ダッシュボードの数が1つ減る
    setDiaryStatus(d.diary_id, '2');
    expect(await abnormal()).toMatchObject({ diary_id: d.diary_id, diary_draft: false });
    expect(await withoutDiary()).toBe(before - 1);
    const applied = await reportLine();
    expect(applied).toContain('起票済み');
    expect(applied).not.toContain('起票済み（下書き）');

    // 取り下げて下書きに戻すと、また下書きとして数える（あとのテストはこの下書きを使う）
    setDiaryStatus(d.diary_id, '1');
    expect(await abnormal()).toMatchObject({ diary_draft: true });
    expect(await withoutDiary()).toBe(before);
  });

  it('差し戻し（申請まで進んだもの）は「起票済み」。デモの記録 1（日誌 3）は差し戻し', async () => {
    const one = (await api.abnormals(admin)).find((a) => a.nap_abnormal_id === 1)!;
    expect(db.diaries.find((x) => x.diary_id === one.diary_id)!.status).toBe('4');
    expect(one.diary_draft).toBe(false);
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
/** 表の中の、久保田 陸の異常時の記録の行 */
async function kubotaRow() {
  let row: HTMLTableRowElement | undefined;
  await waitFor(() => {
    row = Array.from(document.querySelectorAll<HTMLTableRowElement>('table.list tbody tr'))
      .find((tr) => tr.textContent?.includes('久保田 陸') && tr.textContent.includes('顔色がやや紅潮していた'));
    expect(row).toBeTruthy();
  }, { timeout: 3000 });
  return row!;
}
const draftDiaryId = () => db.napAbnormals.find((a) => a.nap_abnormal_id === ABNORMAL_ID)!.diary_id!;

describe('ヒヤリハットの下書きのままの異常時の記録（画面）', () => {
  it('異常時記録画面：下書きのあいだは「起票済み（下書き・開く）」、申請すると「起票済み（開く）」', async () => {
    open('/staff/nap/abnormal', teacher);
    await settled();
    expect(within(await kubotaRow()).getByRole('link', { name: '起票済み（下書き・開く）' })).toBeTruthy();
    cleanup();

    setDiaryStatus(draftDiaryId(), '2');
    try {
      open('/staff/nap/abnormal', teacher);
      await settled();
      expect(within(await kubotaRow()).getByRole('link', { name: '起票済み（開く）' })).toBeTruthy();
    } finally {
      setDiaryStatus(draftDiaryId(), '1');
    }
  });

  it('午睡記録検索画面の「同じ期間の異常時の記録」：下書きのあいだは「起票済み（下書き）」、申請すると「起票済み」', async () => {
    open('/staff/nap/search', teacher);
    await settled();
    expect(within(await kubotaRow()).getByText('起票済み（下書き）')).toBeTruthy();
    cleanup();

    setDiaryStatus(draftDiaryId(), '2');
    try {
      open('/staff/nap/search', teacher);
      await settled();
      expect(within(await kubotaRow()).getByText('起票済み')).toBeTruthy();
    } finally {
      setDiaryStatus(draftDiaryId(), '1');
    }
  });

  it('職員ダッシュボード：下書きのままのものも「ヒヤリハット未起票・下書きのままの異常時の記録」に数え、申請すると減る', async () => {
    const label = 'ヒヤリハット未起票・下書きのままの異常時の記録';
    const rowText = async () => {
      let text = '';
      await waitFor(() => {
        const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent?.includes(label));
        expect(row).toBeTruthy();
        text = row!.textContent ?? '';
      }, { timeout: 3000 });
      return text;
    };
    // 担任（さくら組）は久保田 陸の記録を数える。下書きのままなので、記録 2 も数に入っている
    const draftCount = await withoutDiary(teacher);
    expect(draftCount).toBeGreaterThan(0);
    open('/staff', teacher);
    await settled();
    expect(await rowText()).toContain(`${draftCount} 件`);
    cleanup();

    setDiaryStatus(draftDiaryId(), '2');
    try {
      expect(await withoutDiary(teacher)).toBe(draftCount - 1);
      open('/staff', teacher);
      await settled();
      expect(await rowText()).toContain(`${draftCount - 1} 件`);
    } finally {
      setDiaryStatus(draftDiaryId(), '1');
    }
  });
});
