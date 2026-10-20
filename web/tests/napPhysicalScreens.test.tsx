// @vitest-environment jsdom
/*
 * 午睡チェック画面・午睡記録検索画面・異常時記録画面・身体記録画面の操作（GitHub Issue #165・#142）
 * 典拠：基本設計書.md「身体測定の記録」(4-8)・「午睡チェックの実施」(4-7)・「異常時の記録」(4-7)、
 *      「入力項目の制約値」(4-9)、図/画面詳細図.md「午睡チェック画面」(5-1)・「異常時記録画面」(5-2)・
 *      「午睡記録検索画面」(5-3)・「身体記録画面」(6-4)、MOCKUP.md「日本標準時（JST）に固定している」
 *
 * API の規則は web/tests/napPhysical.test.ts が確かめる。ここでは画面の操作を確かめる。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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
// 午睡記録の CSV（帳票）は管理者だけが出せる（画面詳細図「午睡記録検索画面」(5-3) の項目9・10）
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

/** 先月の day 日（napPhysical.test.ts と同じ） */
function lastMonthDay(day: number): string {
  const [y, m] = today().split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 2, 1));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${first.getUTCFullYear()}-${p(first.getUTCMonth() + 1)}-${p(day)}`;
}

// 午睡の時間帯（13:00-15:00）の中に時計を固定する。デモの実施（13:00 開始）が自動で解除されないようにするため
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${today()}T13:30:00+09:00`));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** さくら組の実施中の実施（デモの実施 1。起動日へずれる） */
const activeSakura = () => db.napSessions.find((s) => s.class_id === 1 && s.session_date === today() && s.ended_at === null)!;
const cardOf = (name: string) => screen.getByRole('region', { name: `${name}の午睡チェック` });

describe('午睡チェック画面のタイマー（GitHub Issue #165 の 5）', () => {
  it('端末のタイムゾーンによらず、日本時間の開始時刻から数える（13:00 開始・間隔 10 分・いま 13:30 → 20 分過ぎ）', async () => {
    open('/staff/nap', teacher);
    await settled();
    await waitFor(() => expect(document.querySelector('.nap-timer')).toBeTruthy(), { timeout: 3000 });
    const timer = document.querySelector('.nap-timer')!;
    expect(timer.textContent).toContain('チェックの時刻を過ぎています');
    expect(timer.textContent).toContain('+20:00');
    // 経過は 0:30
    expect(timer.textContent).toContain('0:30');
  });
});

describe('午睡チェック画面の園児カード（GitHub Issue #142 の 3・4）', () => {
  it('呼吸が確認できない・顔色・体温の記録をカードに出し、その園児を選んだ状態で異常時の記録へ移れる', async () => {
    await api.record(teacher, activeSakura().nap_session_id, {
      child_id: 'C011', body_position: '2', breathing: '2', complexion: '2', temperature: 39.5,
    });
    open('/staff/nap', teacher);
    await settled();
    await waitFor(() => expect(cardOf('山本 陽翔').textContent).toContain('呼吸 確認できず'), { timeout: 3000 });
    const card = cardOf('山本 陽翔');
    expect(card.textContent).toContain('顔色 蒼白');
    expect(card.textContent).toContain('体温 39.5℃');

    fireEvent.click(within(card).getByRole('link', { name: '異常時の記録を残す' }));
    await settled();
    await waitFor(() => expect(screen.getByRole('heading', { name: '異常時の記録' })).toBeTruthy());
    const childSelect = Array.from(document.querySelectorAll('select'))
      .find((s) => Array.from(s.options).some((o) => o.textContent === '選んでください'))!;
    expect(childSelect.value).toBe('C011');
    // 状況の初期値は空のまま（画面詳細図 5-2 項目5）。午睡チェックで記録した内容は見えるように添える
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    expect(document.body.textContent).toContain('呼吸 確認できず');
  });

  it('呼吸に問題が無い記録は、これまでどおり時刻と体位だけを出し、異常時の記録への導線を出さない', async () => {
    open('/staff/nap', teacher);
    await settled();
    await waitFor(() => expect(cardOf('野原 太郎').textContent).toContain('前回 13:20 仰向け'), { timeout: 3000 });
    const card = cardOf('野原 太郎');
    // 「確認できず」は呼吸の選択肢にもあるため、記録の表示（「呼吸 確認できず」）で見る
    expect(card.textContent).not.toContain('呼吸 確認できず');
    expect(within(card).queryByRole('link', { name: '異常時の記録を残す' })).toBeNull();
  });

  it('この実施で異常時の記録がある園児は、カードで強調して示す（基本設計書「異常時の記録」(4-7) 処理内容 2）', async () => {
    await api.recordAbnormal(teacher, activeSakura().nap_session_id, {
      child_id: 'C012', found_at: `${today()}T13:25:00`, situation: '顔色がやや紅潮', response: '別室で休ませた',
    });
    open('/staff/nap', teacher);
    await settled();
    await waitFor(() => expect(cardOf('松本 咲良').textContent).toContain('異常時の記録あり 13:25'), { timeout: 3000 });
    expect(cardOf('野原 太郎').textContent).not.toContain('異常時の記録あり');
  });

  it('体温は小数第1位までしか設定できない（基本設計書「入力項目の制約値」(4-9)）', async () => {
    open('/staff/nap', teacher);
    await settled();
    await waitFor(() => expect(cardOf('金城 陸')).toBeTruthy(), { timeout: 3000 });
    fireEvent.click(within(cardOf('金城 陸')).getByRole('button', { name: /^金城 陸の体温/ }));
    fireEvent.click(screen.getByText('範囲外の値を入力'));
    const input = screen.getByLabelText('範囲外の体温');
    const setButton = screen.getByRole('button', { name: '設定' }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: '36.55' } });
    expect(setButton.disabled).toBe(true);
    expect(document.body.textContent).toContain('小数第1位まで');

    fireEvent.change(input, { target: { value: '34.9' } });
    expect(setButton.disabled).toBe(false);
    fireEvent.click(setButton);
    expect(within(cardOf('金城 陸')).getByRole('button', { name: /^金城 陸の体温/ }).textContent).toContain('34.9℃');
  });
});

describe('午睡記録検索画面の CSV 出力（GitHub Issue #165 の 3）', () => {
  it('期間を変えても「絞り込む」を押すまでは、出力・ファイル名・操作ログの期間を変えない', async () => {
    let fileName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      fileName = this.download;
    });
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();

    open('/staff/nap/search', admin);
    await settled();
    await waitFor(() => expect(document.querySelector('table.list tbody tr')).toBeTruthy(), { timeout: 3000 });
    // 期間の初期値は直近1か月（開始＝当日の30日前。画面詳細図「午睡記録検索画面」(5-3) の項目1）
    const applied = `${addDays(today(), -30)}〜${today()}`;

    const [fromInput] = Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    // 初期値と違う日に変える（日によっては先月の1日が30日前と同じになるため）
    const changed = lastMonthDay(1) === addDays(today(), -30) ? lastMonthDay(2) : lastMonthDay(1);
    fireEvent.change(fromInput, { target: { value: changed } });
    fireEvent.click(screen.getByText('CSV出力'));

    await waitFor(() => expect(fileName).not.toBe(''));
    expect(fileName).toBe(`午睡記録_${addDays(today(), -30)}_${today()}.csv`);
    // 操作ログは新しいものを先頭に持つ。期間はサーバ（モック）が帳票を作った期間を書く
    const logged = db.operationLogs.filter((l) => (l.after_value ?? '').startsWith('午睡記録をCSV出力'));
    expect(logged[0]?.after_value).toContain(`期間 ${applied}`);
  });
});

describe('身体記録画面の上書き・同じ月の記録（GitHub Issue #165 の 1・2）', () => {
  const heightInput = () => screen.getByLabelText('身長（cm）') as HTMLInputElement;
  const pick = (name: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
  const rowsOf = (childId: string) => db.physicalRecords.filter((r) => r.child_id === childId && !r.is_deleted);

  it('同じ測定日の記録があるときは「上書きしますか」と確かめ、承諾するまで書き換えない', async () => {
    await api.save(teacher, { child_id: 'C008', measured_on: today(), height_cm: 82.5, weight_kg: 10.8 });
    open('/staff/growth/physical', teacher);
    await settled();
    await waitFor(() => expect(screen.getByRole('button', { name: /小林 結衣/ })).toBeTruthy(), { timeout: 3000 });
    pick('小林 結衣');
    await waitFor(() => expect(heightInput().value).toBe('82.5'), { timeout: 3000 });

    fireEvent.change(heightInput(), { target: { value: '90.0' } });
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    await waitFor(() => expect(document.body.textContent).toContain('この測定日の記録は登録済みです。上書きしますか。'));
    expect(rowsOf('C008')[0].height_cm).toBe(82.5);

    fireEvent.click(screen.getByRole('button', { name: '上書きする' }));
    await waitFor(() => expect(rowsOf('C008')[0].height_cm).toBe(90));
    expect(rowsOf('C008')).toHaveLength(1);
  });

  it('範囲外の警告と上書きの確認は、それぞれ別に承諾させる（一括で承諾扱いにしない）', async () => {
    await api.save(teacher, { child_id: 'C009', measured_on: today(), height_cm: 80, weight_kg: 10 });
    open('/staff/growth/physical', teacher);
    await settled();
    await waitFor(() => expect(screen.getByRole('button', { name: /加藤 大和/ })).toBeTruthy(), { timeout: 3000 });
    pick('加藤 大和');
    await waitFor(() => expect(heightInput().value).toBe('80'), { timeout: 3000 });

    fireEvent.change(heightInput(), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    // 1 度目は範囲外の警告だけ。上書きの確認はまだ出さない
    expect(screen.getByRole('button', { name: 'このまま登録する' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('上書きしますか');

    fireEvent.click(screen.getByRole('button', { name: 'このまま登録する' }));
    await waitFor(() => expect(document.body.textContent).toContain('上書きしますか'));
    expect(rowsOf('C009')[0].height_cm).toBe(80);

    fireEvent.click(screen.getByRole('button', { name: '上書きする' }));
    await waitFor(() => expect(rowsOf('C009')[0].height_cm).toBe(200));
  });

  it('同じ年月の別の日に記録がある園児には入力済みの印を付け、別の記録として登録する前に確かめる', async () => {
    await api.save(teacher, { child_id: 'C010', measured_on: lastMonthDay(3), height_cm: 82.5, weight_kg: 10.8 });
    open('/staff/growth/physical', teacher);
    await settled();
    fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: lastMonthDay(10) } });
    await waitFor(() => expect(screen.getByRole('button', { name: /吉田 心春/ }).textContent).toContain('済'), { timeout: 3000 });

    pick('吉田 心春');
    await waitFor(() => expect(document.body.textContent).toContain('この月は'), { timeout: 3000 });
    fireEvent.change(heightInput(), { target: { value: '82.3' } });
    fireEvent.change(screen.getByLabelText('体重（kg）'), { target: { value: '10.7' } });
    fireEvent.click(screen.getByRole('button', { name: '登録する' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '別の記録として登録する' })).toBeTruthy());
    expect(rowsOf('C010')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '別の記録として登録する' }));
    await waitFor(() => expect(rowsOf('C010')).toHaveLength(2));
  });
});
