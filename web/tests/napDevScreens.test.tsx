// @vitest-environment jsdom
/*
 * 異常時記録画面・発達チェック入力画面の操作（GitHub Issue #158・#164）
 * 典拠：基本設計書.md「午睡チェックの実施」(4-7) 処理内容 1・2（開始は「午睡チェックを開始する」を押したとき）、
 *      図/画面詳細図.md「異常時記録画面」(5-2) 項目3「発見時刻 入力：必須」、
 *      「発達チェック入力画面」(6-2)
 *
 * API の規則は web/tests/napScope.test.ts・devCheck.test.ts が確かめる。ここでは画面の操作を確かめる。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
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

// 午睡の時間帯（13:00-15:00）の中に時計を固定する。デモの実施が自動で解除されないようにするため（screens.test.tsx と同じ）
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${today()}T13:30:00+09:00`));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

/** 異常時記録画面の入力を埋める。発見時刻は画面の初期値（今の時刻）のまま */
function fillAbnormal(childId: string) {
  const childSelect = Array.from(document.querySelectorAll('select'))
    .find((s) => Array.from(s.options).some((o) => o.textContent === '選んでください'))!;
  fireEvent.change(childSelect, { target: { value: childId } });
  const [situation, response] = Array.from(document.querySelectorAll('textarea'));
  fireEvent.change(situation, { target: { value: '顔色がやや紅潮していた' } });
  fireEvent.change(response, { target: { value: '別室で休ませた' } });
}

const recordButton = () => screen.getByText('記録する') as HTMLButtonElement;

describe('異常時記録画面（GitHub Issue #158）', () => {
  it('発見時刻を空にすると「記録する」を押せない（画面詳細図 5-2 項目3「入力：必須」）', async () => {
    open('/staff/nap/abnormal', teacher);
    await settled();
    fillAbnormal('C006');
    expect(recordButton().disabled).toBe(false);

    fireEvent.change(document.querySelector('input[type="datetime-local"]')!, { target: { value: '' } });
    expect(recordButton().disabled).toBe(true);
  });

  it('実施中の午睡チェックが無いときは記録せず、午睡チェックも開始しない', async () => {
    const active = db.napSessions.filter((s) => s.class_id === 1 && s.ended_at === null);
    active.forEach((s) => { s.ended_at = `${today()}T13:20:00`; s.ended_staff_id = 'S003'; });
    const sessions = db.napSessions.length;
    const abnormals = db.napAbnormals.length;
    try {
      open('/staff/nap/abnormal', teacher);
      await settled();
      fillAbnormal('C006');
      fireEvent.click(recordButton());
      await waitFor(() => expect(document.body.textContent).toContain('実施中の午睡チェックがありません'));
      expect(db.napSessions.length).toBe(sessions);
      expect(db.napAbnormals.length).toBe(abnormals);
    } finally {
      active.forEach((s) => { s.ended_at = null; s.ended_staff_id = null; });
    }
  });

  it('管理者がほかのクラスの園児を記録すると、その園児のクラスの実施に付く', async () => {
    const himawari = await api.startSession(admin, 2, today()); // ひまわり組
    open('/staff/nap/abnormal', admin);
    await settled();
    fillAbnormal('C013'); // 井上 空（ひまわり組）
    fireEvent.click(recordButton());
    await waitFor(() => expect(db.napAbnormals.some((a) => a.child_id === 'C013'
      && a.situation === '顔色がやや紅潮していた')).toBe(true));
    const rec = db.napAbnormals.find((a) => a.child_id === 'C013' && a.situation === '顔色がやや紅潮していた')!;
    expect(rec.nap_session_id).toBe(himawari.nap_session_id);
  });
});

describe('発達チェック入力画面（GitHub Issue #164）', () => {
  it('確定した記録を開き直すと「下書き保存」を出さず、「確定する」で直せる', async () => {
    await api.saveCheck(teacher, 'C006', today(), [], '', '2'); // 伊藤 葵
    open('/staff/growth/dev/C006', teacher);
    await settled();
    await waitFor(() => expect(document.body.textContent).toContain('この日の記録は確定しています'));
    expect(screen.queryByText('下書き保存')).toBeNull();
    expect(screen.getByText('確定する')).toBeTruthy();
  });

  it('確定した記録を開き直すと、確定した職員と日時、「確定する」で書き換わることを出す（GitHub Issue #143）', async () => {
    await api.saveCheck(teacher, 'C007', today(), [], '', '2'); // 中村 蓮
    open('/staff/growth/dev/C007', teacher);
    await settled();
    await waitFor(() => expect(document.body.textContent).toContain('確定した職員：鈴木 浩之'));
    // 時計は 13:30 に止めてある（このファイルの beforeEach）
    expect(document.body.textContent).toContain('確定した日時：');
    expect(document.body.textContent).toContain('13:30');
    expect(document.body.textContent).toContain('この記録を書き換えます');
  });

  it('確定していない日は「下書き保存」を出す', async () => {
    open('/staff/growth/dev/C010', teacher);
    await settled();
    expect(screen.getByText('下書き保存')).toBeTruthy();
  });
});
