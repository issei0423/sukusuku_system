// @vitest-environment jsdom
/*
 * 相手の操作で画面が書き換わったときの読み上げ（WCAG 4.1.3 ステータスメッセージ、GitHub Issue #209）
 * 典拠：詳細設計書「全画面に共通する部品と決まり」(2-0) の (6)「読み上げの範囲」（決めたこと D-57）
 *
 * 読み上げへ伝えるのは次の3つだけ。届いたことを知る必要がある場面に絞る（2026-10-19 に決めた）。
 *   ① チャット画面（職員・保護者）：相手から届いた新しいメッセージ（role="log"。自分が送ったものは足さない）
 *   ② 連絡帳（クラス）画面・連絡帳（園児）画面：「家庭から」が増えたときだけ「家庭からが1件届きました（〇〇さん）」
 *   ③ 午睡チェック画面：確認の時刻を過ぎた子を「未確認 n 名」とまとめて1回（園児の行ごとの role="status" は外す）
 * ヘッダの通知の件数・ダッシュボード・保護者ホームの件数と「きょう」は読ませない。
 *
 * 相手はモック（api/mock.ts）。モックは同じタブの書き込みで知らせ（live.ts）を出すので、開いている画面はすぐ読み直す。
 * mockDb はこのファイルのテストで使い回す。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';
import type { ContactHomeInput } from '../src/api/shapes';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const admin: SessionUser = { ...teacher, account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', staff_id: 'S001', class_id: null, class_name: null, display_name: '野原 一誠' };
/** 野原 太郎（C001）の父 */
const guardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
/** 野原 太郎の保護者との個人チャット */
const personalRoom = 6;

function open(path: string, user: SessionUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

const startedAt = Date.now();
afterEach(() => {
  cleanup();
  vi.setSystemTime(startedAt);
});

const logText = () => screen.getByRole('log').textContent ?? '';

/** デモの実施（13:00 開始）は 18:00 には自動で終わっている。新しく始める */
async function startNap() {
  const active = await api.activeSession(1, today(), admin);
  if (active) await api.endSession(admin, active.nap_session_id);
  return api.startSession(teacher, 1, today());
}

describe('① チャット画面：相手から届いたメッセージだけを role="log" で読む', () => {
  it('保護者：園から届いたものを足し、開いたときに並んでいたもの・自分が送ったものは足さない', async () => {
    open('/guardian/chat', guardian);
    fireEvent.click(await screen.findByText('担任の先生とのやりとり', undefined, { timeout: 3000 }));
    await screen.findByRole('textbox', { name: 'メッセージを入力' }, { timeout: 3000 });
    // 開いたときに並んでいたメッセージは読まない
    await waitFor(() => expect(document.querySelectorAll('.msg').length).toBeGreaterThan(0), { timeout: 3000 });
    expect(logText()).toBe('');

    await api.send(teacher, personalRoom, 'L1 お迎えの時間を教えてください。');
    await screen.findByText('L1 お迎えの時間を教えてください。', { selector: '.bubble' }, { timeout: 3000 });
    await waitFor(() => expect(logText()).toContain('高梨 倫太朗（職員）から：L1 お迎えの時間を教えてください。'), { timeout: 3000 });

    // 自分が送ったものは、今の role="status"（「メッセージを送信しました」）で読むので、log には足さない
    fireEvent.change(screen.getByRole('textbox', { name: 'メッセージを入力' }), { target: { value: 'L2 17時に伺います。' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('L2 17時に伺います。', { selector: '.bubble' }, { timeout: 3000 });
    await waitFor(() => expect(document.querySelector('.guardian-message-compose [role="status"]')?.textContent).toBe('メッセージを送信しました'));
    expect(logText()).not.toContain('L2');
  });

  it('職員：保護者から届いたものを足し、自分が送ったものは足さない', async () => {
    open(`/staff/chat?room=${personalRoom}`, teacher);
    await waitFor(() => expect(document.querySelector('.channel.current')?.textContent).toContain('野原 太郎の保護者'), { timeout: 3000 });
    await waitFor(() => expect(document.querySelectorAll('.msg').length).toBeGreaterThan(0), { timeout: 3000 });
    expect(logText()).toBe('');

    await api.send(guardian, personalRoom, 'L3 熱は下がりました。');
    await screen.findByText('L3 熱は下がりました。', { selector: '.bubble' }, { timeout: 3000 });
    await waitFor(() => expect(logText()).toContain('野原 一誠（保護者）から：L3 熱は下がりました。'), { timeout: 3000 });

    fireEvent.change(screen.getByPlaceholderText('メッセージを入力'), { target: { value: 'L4 承知しました。' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('L4 承知しました。', { selector: '.bubble' }, { timeout: 3000 });
    expect(logText()).not.toContain('L4');
  });
});

const home: ContactHomeInput = {
  temperature: 36.6, night_sleep_from: null, night_sleep_to: null, breakfast: '1', mood_label: 'ごきげん',
  pickup_type: '1', pickup_person: null, pickup_time: null, message: null, updated_at: null,
};
/** 野原 太郎の今日の家庭からを消す（このファイルの前のテストで送ったもの） */
function clearHome() {
  for (let i = db.contactHomes.length - 1; i >= 0; i--) {
    if (db.contactHomes[i].child_id === 'C001' && db.contactHomes[i].contact_date === today()) db.contactHomes.splice(i, 1);
  }
}
/** 画面に1つだけ置く「家庭からが届いた」の欄 */
const arrival = () => document.querySelectorAll<HTMLElement>('[data-home-arrival][role="status"]');

describe('② 連絡帳の画面：「家庭から」が増えたときだけ、画面に1つの role="status" で読む', () => {
  it('連絡帳（クラス）画面：開いたとき・読み直しただけでは読まず、届いたら「家庭からが1件届きました（〇〇さん）」', async () => {
    clearHome();
    open('/staff/contact', teacher);
    await screen.findByRole('rowheader', { name: '野原 太郎' }, { timeout: 3000 });
    expect(arrival()).toHaveLength(1);
    expect(arrival()[0].textContent).toBe('');

    // ほかの職員の記録で読み直しても、家庭からは増えていないので読まない
    await api.recordEvents(teacher, [{ child_id: 'C002', event_type: '2', toilet_label: 'おしっこ' }]);
    await screen.findByRole('button', { name: /^上園 花子の排せつ .+ を直す・取り消す$/ }, { timeout: 3000 });
    expect(arrival()[0].textContent).toBe('');

    await api.saveHome(guardian, 'C001', home);
    await waitFor(() => expect(arrival()[0].textContent).toBe('家庭からが1件届きました（野原 太郎さん）'), { timeout: 3000 });
    expect(arrival()).toHaveLength(1);
  });

  it('連絡帳（園児）画面：開いたときは読まず、その子の家庭からが届いたら読む', async () => {
    clearHome();
    open('/staff/contact/C001', teacher);
    await screen.findByRole('heading', { name: '野原 太郎' }, { timeout: 3000 });
    expect(arrival()).toHaveLength(1);
    expect(arrival()[0].textContent).toBe('');

    await api.saveHome(guardian, 'C001', home);
    await waitFor(() => expect(arrival()[0].textContent).toBe('家庭からが1件届きました（野原 太郎さん）'), { timeout: 3000 });
  });
});

describe('③ 午睡チェック画面：確認の時刻を過ぎた子を、タイマーの欄で「未確認 n 名」とまとめて1回読む', () => {
  const timerStatus = () => document.querySelectorAll<HTMLElement>('.nap-timer [role="status"]');

  it('園児の行には role="status" を置かず、時刻を過ぎたら1回読み、記録して減っても読み直さない', async () => {
    const session = await startNap();
    open('/staff/nap', teacher);
    await screen.findByRole('region', { name: '野原 太郎の午睡チェック' }, { timeout: 3000 });
    // 園児の行ごとの読み上げは外す（時刻を過ぎると全員の行が同時に変わり、続けて何度も読むため）
    expect(document.querySelectorAll('.nap-grid [role="status"], .nap-grid [aria-live]')).toHaveLength(0);
    expect(timerStatus()).toHaveLength(1);
    expect(timerStatus()[0].textContent).toBe('');

    // 確認の時刻を過ぎる（タイマーは1秒ごとに描き直す）
    const rows = (await api.classState(teacher, 1, session.nap_session_id)).filter((r) => !r.exclusion);
    vi.setSystemTime(Date.now() + api.intervalMinutesFor(1) * 60_000 + 1000);
    const announced = `チェックの時刻を過ぎています（未確認 ${rows.length} 名）`;
    await waitFor(() => expect(timerStatus()[0].textContent).toBe(announced), { timeout: 3000 });

    // ほかの職員が1人を記録した。見えている数は減るが、読み上げの欄は書き換えない（数を読み続けない）
    await api.record(teacher, session.nap_session_id, { child_id: 'C001', body_position: '1', breathing: '1', complexion: '1', temperature: null });
    await waitFor(() => expect(document.querySelector('.nap-timer')?.textContent).toContain(`未確認 ${rows.length - 1} 名`), { timeout: 3000 });
    expect(timerStatus()[0].textContent).toBe(announced);
  });

  it('自分で記録したときは、結果の表示（notify）で読む', async () => {
    await startNap();
    open('/staff/nap', teacher);
    const row = await screen.findByRole('region', { name: '加藤 大和の午睡チェック' }, { timeout: 3000 });
    for (const [group, label] of [['体位', '仰向け'], ['呼吸', 'あり'], ['顔色', '通常']] as const) {
      fireEvent.click(within(within(row).getByRole('group', { name: group })).getByRole('radio', { name: label }));
    }
    fireEvent.click(within(row).getByRole('button', { name: 'この子を記録' }));
    await waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain('加藤 大和さんの午睡チェックを記録しました。'), { timeout: 3000 });
  });
});

describe('読まないもの：ヘッダの通知の件数・保護者ホームの「きょう」・保護者の連絡帳の確認の状態', () => {
  it('保護者ホームの「きょう」の午睡と、保護者の連絡帳の「急ぎはお電話で」「園が確認しました」は role="status" にしない', async () => {
    clearHome();
    await api.saveHome(guardian, 'C001', home);
    // 「きょう」に午睡の行（「13:05 おひるね中」など）が出るよう、ねたを記録しておく。職員が記録すると書き換わる
    const session = await startNap();
    await api.sleep(teacher, session.nap_session_id, 'C001');
    open('/guardian', guardian);
    const card = await screen.findByRole('region', { name: '野原 太郎さんのきょう' }, { timeout: 3000 });
    await waitFor(() => expect(card.querySelector('.contact-nap')).not.toBeNull(), { timeout: 3000 });
    expect(card.querySelectorAll('[role="status"], [role="log"], [aria-live]')).toHaveLength(0);
    expect(document.querySelector('.notify-btn')?.closest('[role="status"], [role="log"], [aria-live]')).toBeNull();
    cleanup();

    open('/guardian/contact/C001', guardian);
    await screen.findByText('急ぎはお電話でお願いします。', undefined, { timeout: 3000 });
    const section = screen.getByRole('region', { name: '家庭から' });
    expect(section.querySelectorAll('[role="status"], [role="log"], [aria-live]')).toHaveLength(0);
  });
});
