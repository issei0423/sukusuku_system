// @vitest-environment jsdom
/*
 * 午睡記録検索画面：ねた・おきたの行と入眠時の体温、CSV の異常時の記録（ヒヤリハット側を正とし、二重に数えない）
 * 典拠：図/画面詳細図.md「午睡記録検索画面」(5-3) の項目6・9・10・11、基本設計書.md「帳票の出力」(4-8)
 *
 * API の規則は web/tests/napReport.test.ts が確かめる。ここでは画面に出ることと、CSV 出力が管理者にだけ出て
 * サーバで作る帳票（api.napReport）を保存することを確かめる。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { addDays, today } from '../src/api/util';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
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

  it('きょうは対象外とその理由の行を出し、期間の初期値は直近1か月（当日の30日前〜当日）', async () => {
    // 昨日の実施 2 に足す（デモの今日の対象外は、時計によっては起動時に外れる）
    const yesterday = db.napSessions.find((s) => s.nap_session_id === 2)!.session_date;
    const added = { nap_exclusion_id: 900201, nap_session_id: 2, child_id: 'C002', reason: '2' as const, staff_id: 'S003', is_deleted: false, created_at: `${yesterday}T13:00:00` };
    db.napExclusions.push(added);
    try {
      open('/staff/nap/search', teacher);
      await settled();
      await waitFor(() => expect(document.querySelector('table.list tbody tr')).toBeTruthy(), { timeout: 3000 });

      // 画面詳細図「午睡記録検索画面」(5-3) の項目1「開始＝当日の30日前、終了＝本日」
      const [fromInput, toInput] = Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
      expect(fromInput.value).toBe(addDays(today(), -30));
      expect(toInput.value).toBe(today());

      // 体位・呼吸・顔色の3列をまとめて「きょうは対象外（理由）」。体温と保存時刻は「―」
      const row = listRow('上園 花子', 'きょうは対象外（午睡なし）');
      expect(row.textContent).toContain('13:00');
      expect(row.textContent).toContain('高梨 倫太朗');
      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells.find((td) => td.textContent === 'きょうは対象外（午睡なし）')?.getAttribute('colspan')).toBe('3');
      // 保存時刻は「―」。最後の列（修正）は確認の行だけが使い、対象外の行は空
      expect(cells[cells.length - 2].textContent).toBe('―');
      expect(cells[cells.length - 1].textContent).toBe('');
    } finally {
      db.napExclusions.splice(db.napExclusions.indexOf(added), 1);
    }
  });

  it('管理者の CSV は、サーバで作る帳票（ねたの体温・起票済みはヒヤリハット側の1行）を BOM を付けて保存する', async () => {
    let blob: Blob | null = null;
    let fileName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      fileName = this.download;
    });
    URL.createObjectURL = vi.fn((b: Blob) => { blob = b; return 'blob:test'; });
    URL.revokeObjectURL = vi.fn();
    const reportSpy = vi.spyOn(api, 'napReport');
    const recordSpy = vi.spyOn(api, 'recordExport');

    open('/staff/nap/search', admin);
    await settled();
    await waitFor(() => expect((screen.getByText('CSV出力') as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    // 帳票は画面の一覧（新しい順）と並びが違うので、注記で知らせる（【仮置き】web/仮置き値.md「午睡の帳票」）
    expect(document.body.textContent).toContain('CSV は、日付・クラス・園児ごとに時刻の古い順に並べます（この画面の一覧は新しい順です）。');
    const logsBefore = db.operationLogs.filter((l) => (l.after_value ?? '').startsWith('午睡記録をCSV出力')).length;
    fireEvent.click(screen.getByText('CSV出力'));
    await waitFor(() => expect(blob).not.toBeNull());

    // 「絞り込む」を押した時点の期間・クラス（管理者の初期値は「すべて」）で帳票を求める。画面が申告する件数の記録は呼ばない
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0][1]).toEqual({ from: addDays(today(), -30), to: today(), classId: '', format: 'csv' });
    expect(recordSpy).not.toHaveBeenCalled();
    expect(fileName).toBe(`午睡記録_${addDays(today(), -30)}_${today()}.csv`);

    // Excel で文字化けしないよう BOM（EF BB BF）を付ける。Blob の text() は BOM を外して読むため、バイトで確かめる
    const bytes = new Uint8Array(await blob!.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.slice(3));
    expect(raw).toBe(await reportSpy.mock.results[0].value); // 帳票の本文をそのまま保存する
    const lines = raw.split('\n');
    expect(lines[0]).toContain('"修正あり"');
    expect(lines.some((l) => l.includes('"野原 太郎"') && l.includes('"入眠（ねた）"') && l.includes('"36.5"'))).toBe(true);
    // デモの異常時の記録 1（高梨 健）はヒヤリハット（日誌 3）を起票済み。日誌に書いた状況・対応を出し、記録そのものの文は出さない
    const raised = lines.filter((l) => l.includes('"高梨 健"') && l.includes('"起票済み"'));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toContain('"午睡中にうつ伏せの体位を確認した。"');
    expect(raw).not.toContain('うつ伏せの体位で寝ているのを発見');

    // 出力したことはモック（サーバの代わり）が操作ログに残す
    const logged = db.operationLogs.filter((l) => (l.after_value ?? '').startsWith('午睡記録をCSV出力'));
    expect(logged.length).toBe(logsBefore + 1);
  });

  it('一般（保育士）には CSV 出力のボタンと、出力の範囲の注記を出さない', async () => {
    open('/staff/nap/search', teacher);
    await settled();
    await waitFor(() => expect(document.querySelector('table.list tbody tr')).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByText('CSV出力')).toBeNull();
    expect(document.body.textContent).not.toContain('CSV 出力は');
    expect(document.body.textContent).not.toContain('時刻の古い順に並べます');
    // 閲覧はできる（画面詳細図「午睡記録検索画面」(5-3)「一般は閲覧と修正ができるが、帳票・CSV の出力はできない」）
    expect(listRow('野原 太郎', '入眠（ねた）').textContent).toContain('36.5');
  });
});
