// @vitest-environment jsdom
/*
 * 午睡記録検索画面：ねた・おきたの行と入眠時の体温、CSV の異常時の記録（ヒヤリハット側を正とし、二重に数えない）
 * 典拠：図/画面詳細図.md「午睡記録検索画面」(5-3) の項目6・9・11、基本設計書.md「帳票の出力」(4-8)
 *
 * API の規則は web/tests/napReport.test.ts が確かめる。ここでは画面に出ることと、出力する CSV の中身を確かめる。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

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

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** 一覧（最初の表）の行のうち、園児名と種類の名前を含む行 */
function listRow(childName: string, label: string): HTMLElement {
  const table = document.querySelector('table.list') as HTMLElement;
  const row = within(table).getAllByRole('row').find((tr) =>
    tr.textContent?.includes(childName) && tr.textContent.includes(label));
  if (!row) throw new Error(`${childName} の ${label} の行がありません`);
  return row;
}

describe('午睡記録検索画面に、ねた・おきたの行と入眠時の体温を出す', () => {
  it('ねたの行に入眠時の体温を、おきたの行におきた時刻を出す（デモの昨日の野原 太郎）', async () => {
    open('/staff/nap/search', teacher);
    await settled();
    await waitFor(() => expect(document.querySelector('table.list tbody tr')).toBeTruthy(), { timeout: 3000 });

    const slept = listRow('野原 太郎', '入眠（ねた）');
    expect(slept.textContent).toContain('36.5');
    expect(slept.textContent).toContain('13:02');
    const woke = listRow('野原 太郎', '起床（おきた）');
    expect(woke.textContent).toContain('14:35');
    expect(woke.textContent).not.toContain('36.5');
  });

  it('CSV に、ねたの行の入眠時の体温と、異常時の記録（起票済みはヒヤリハット側の状況・対応を1行）を出す', async () => {
    let blob: Blob | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL = vi.fn((b: Blob) => { blob = b; return 'blob:test'; });
    URL.revokeObjectURL = vi.fn();

    open('/staff/nap/search', teacher);
    await settled();
    await waitFor(() => expect((screen.getByText('CSV出力') as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    const logsBefore = db.operationLogs.filter((l) => (l.after_value ?? '').startsWith('午睡記録をCSV出力')).length;
    fireEvent.click(screen.getByText('CSV出力'));
    await waitFor(() => expect(blob).not.toBeNull());

    const lines = (await blob!.text()).replace(/^﻿/, '').split('\n');
    expect(lines.some((l) => l.includes('"野原 太郎"') && l.includes('"入眠（ねた）"') && l.includes('"36.5"'))).toBe(true);
    expect(lines.some((l) => l.includes('"野原 太郎"') && l.includes('"起床（おきた）"'))).toBe(true);

    // デモの異常時の記録 1（高梨 健）はヒヤリハット（日誌 3）を起票済み。日誌に書いた状況・対応を出し、記録そのものの文は出さない
    const header = lines.findIndex((l) => l.includes('"同じ期間の異常時の記録"'));
    expect(header).toBeGreaterThan(0);
    const abnormalLines = lines.slice(header + 2);
    const raised = abnormalLines.filter((l) => l.includes('"高梨 健"'));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toContain('"午睡中にうつ伏せの体位を確認した。"');
    expect(raised[0]).toContain('"仰向けに直し、呼吸と顔色を確認した。"');
    expect(raised[0]).toContain('"起票済み"');
    expect(lines.join('\n')).not.toContain('うつ伏せの体位で寝ているのを発見');
    // 起票していない記録 2（金城 陸）は記録そのものの文を出す
    expect(abnormalLines.some((l) => l.includes('顔色がやや紅潮していた。体温37.4度。') && l.includes('"未起票"'))).toBe(true);

    // 出力したことを操作ログに残す。件数は一覧の行と異常時の記録の合計
    const listCount = header - 2; // 1行目は見出し、異常時の記録の見出しの前は空の行
    const logged = db.operationLogs.filter((l) => (l.after_value ?? '').startsWith('午睡記録をCSV出力'));
    expect(logged.length).toBeGreaterThan(logsBefore);
    expect(logged[logged.length - 1].after_value).toContain(`・${listCount + abnormalLines.length} 件`);
  });
});
