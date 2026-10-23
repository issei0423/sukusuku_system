// @vitest-environment jsdom
/*
 * 開いたままの画面の読み直し（自動更新）と、職員ダッシュボードの「未対応の個人チャット」
 * 典拠：web/仮置き値.md「開いたままの画面の読み直し（自動更新）」、要件定義書「チャットツール」(4-3)
 *
 * 保育士と保護者の画面を並べたとき、相手の操作が数秒で表れることを確かめる。
 * 読み直しのたびに読み込み中の表示を出さないこと、入力中の文字を消さないこと、
 * タブが隠れている間は止めること、失敗しても表示を残すことをあわせて確かめる。
 *
 * 間隔のタイマー（setInterval）だけを偽物にし、時間を進めて読み直しを起こす。
 * モックの応答（api/mock.ts の setTimeout）と、画面の変化を待つ仕組みは本物の時計で動かす。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import { useAsync, AUTO_REFRESH_MS } from '../src/hooks';
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
// ひまわり組の担任。さくら組の個人チャットには参加していない
const otherTeacher: SessionUser = {
  account_id: 5, email: 'kubota@hoiku.example.jp', role: '2', display_name: '久保田 翔',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
  is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

/** 西田 太郎の保護者との個人チャット（デモデータでは未対応から始まる） */
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

async function settled() {
  await waitFor(() => {
    expect(document.body.textContent).not.toContain('読み込んでいます');
  }, { timeout: 3000 });
}

/** 間隔ぶん時間を進め、裏の読み直しを1回起こす */
async function tickRefresh() {
  await act(async () => { vi.advanceTimersByTime(AUTO_REFRESH_MS); });
}

/** 読み込み中の表示が出たかを見張る。読み直しのたびに出ると、画面がちらつく */
function watchLoading() {
  let seen = false;
  const observer = new MutationObserver(() => {
    if (document.body.textContent?.includes('読み込んでいます')) seen = true;
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { seen: () => seen, stop: () => observer.disconnect() };
}

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setHidden(value: boolean) {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
}

/* ============ 共通の取得の仕組み（hooks.ts） ============ */

describe('useAsync の裏の読み直し', () => {
  /** 読み込んだ値と、描いた回数を出す */
  function Probe({ load, refreshMs, renders }: {
    load: () => Promise<string>; refreshMs?: number; renders: { n: number };
  }) {
    const { data, error, loading } = useAsync(load, [], { refreshMs });
    renders.n += 1;
    return <div data-testid="probe">{loading ? '読み込み中' : error ? `失敗：${error}` : data}</div>;
  }

  it('間隔ごとに読み直し、読み込み中の表示を出さずに新しい値へ替える', async () => {
    let value = 'はじめ';
    const load = vi.fn(async () => value);
    render(<Probe load={load} refreshMs={AUTO_REFRESH_MS} renders={{ n: 0 }} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('はじめ'));

    value = 'つぎ';
    const watch = watchLoading();
    await tickRefresh();
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('つぎ'));
    watch.stop();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('probe').textContent).not.toBe('読み込み中');
  });

  it('中身が変わっていなければ描き直さない', async () => {
    const renders = { n: 0 };
    render(<Probe load={async () => '同じ'} refreshMs={AUTO_REFRESH_MS} renders={renders} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('同じ'));
    const before = renders.n;
    await tickRefresh();
    await tickRefresh();
    expect(renders.n).toBe(before);
  });

  it('タブが隠れている間は読み直さず、戻ったときに待たずに1回読む', async () => {
    let value = 'はじめ';
    const load = vi.fn(async () => value);
    render(<Probe load={load} refreshMs={AUTO_REFRESH_MS} renders={{ n: 0 }} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('はじめ'));

    act(() => setHidden(true));
    value = 'かくれている間に変わった';
    await tickRefresh();
    await tickRefresh();
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => setHidden(false));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('かくれている間に変わった'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('読み直しに失敗しても、いまの表示を残す', async () => {
    let fail = false;
    const load = vi.fn(async () => {
      if (fail) throw new Error('通信に失敗しました');
      return 'のこる';
    });
    render(<Probe load={load} refreshMs={AUTO_REFRESH_MS} renders={{ n: 0 }} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('のこる'));

    fail = true;
    await tickRefresh();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('probe').textContent).toBe('のこる');
  });

  it('最初の読み込みに失敗した画面も、読み直しに成功したら元に戻る', async () => {
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error('通信に失敗しました');
      return 'もどった';
    });
    render(<Probe load={load} refreshMs={AUTO_REFRESH_MS} renders={{ n: 0 }} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('失敗：通信に失敗しました'));

    fail = false;
    await tickRefresh();
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('もどった'));
  });

  it('間隔を渡さなければ読み直さない（これまでの画面の動きは変わらない）', async () => {
    const load = vi.fn(async () => 'そのまま');
    render(<Probe load={load} renders={{ n: 0 }} />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('そのまま'));
    await tickRefresh();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

/* ============ 職員ダッシュボードの「未対応の個人チャット」 ============ */

describe('未対応の個人チャットの集計（モック。server/api_dashboard.go と同じ規則）', () => {
  it('参加している個人チャットのうち、未対応のものを数え、先頭のチャンネルを返す', async () => {
    const s = await api.staffSummary(teacher);
    expect(s.unhandledChat).toBe(1);
    expect(s.unhandledChatRoom).toEqual({ chat_room_id: personalRoom, room_name: '西田 太郎の保護者' });
    // 管理者もデモデータでは参加している
    expect((await api.staffSummary(admin)).unhandledChat).toBe(1);
  });

  it('参加していない個人チャットは数えない', async () => {
    const s = await api.staffSummary(otherTeacher);
    expect(s.unhandledChat).toBe(0);
    expect(s.unhandledChatRoom).toBeNull();
  });

  it('対応済みにすると減り、保護者から届くと未対応へ戻って増える', async () => {
    await api.setThreadStatus(teacher, personalRoom, '2');
    expect((await api.staffSummary(teacher)).unhandledChat).toBe(0);
    await api.send(guardian, personalRoom, '昨夜37.4℃ありました。');
    expect((await api.staffSummary(teacher)).unhandledChat).toBe(1);
  });
});

/* ============ 画面 ============ */

describe('保育士と保護者の画面を並べたとき', () => {
  it('ダッシュボード：未対応の個人チャットを件数と導線で出し、開いたままでも増減が表れる', async () => {
    await api.setThreadStatus(teacher, personalRoom, '1');
    open('/staff', teacher);
    await settled();
    expect(screen.getByText('未対応の個人チャット')).toBeTruthy();
    expect(screen.getByText('西田 太郎の保護者')).toBeTruthy();
    const link = screen.getByText('未対応の個人チャット').closest('tr')!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(`/staff/chat?room=${personalRoom}`);

    // 0 件になっても行は消さない（画面詳細図「職員ダッシュボード」(2-6)。GitHub Issue #178 の 6）
    const countOf = () => screen.getByText('未対応の個人チャット').closest('tr')!.querySelector('td.num')!.textContent;
    const watch = watchLoading();
    // 別の画面（保育士の別の窓）で対応済みにする → 開いたままのダッシュボードで 0 件になる
    await api.setThreadStatus(teacher, personalRoom, '2');
    await tickRefresh();
    await waitFor(() => expect(countOf()).toBe('0 件'));
    expect(screen.queryByText('西田 太郎の保護者')).toBeNull();

    // 保護者が送る → 未対応へ戻り、ダッシュボードの件数に出る
    await api.send(guardian, personalRoom, '昨夜37.4℃ありました。今朝は36.8℃です。');
    await tickRefresh();
    await waitFor(() => expect(countOf()).toBe('1 件'));
    expect(screen.getByText('西田 太郎の保護者')).toBeTruthy();
    watch.stop();
    expect(watch.seen()).toBe(false);
  });

  it('チャット（職員）：導線から開くとそのチャンネルを選んでおり、保護者の送信が入力中の文字を消さずに表れる', async () => {
    open(`/staff/chat?room=${personalRoom}`, teacher);
    await settled();
    await waitFor(() => expect(document.querySelector('.channel.current')?.textContent).toContain('西田 太郎の園とのやりとり'));

    // 返信を書きかけておく
    const box = screen.getByPlaceholderText('メッセージを入力') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '書きかけの返信' } });

    const watch = watchLoading();
    await api.send(guardian, personalRoom, '熱は下がりましたが、念のため様子を見てください。');
    await tickRefresh();
    await waitFor(() => expect(screen.getByText('熱は下がりましたが、念のため様子を見てください。')).toBeTruthy());
    watch.stop();
    expect(watch.seen()).toBe(false);
    expect((screen.getByPlaceholderText('メッセージを入力') as HTMLTextAreaElement).value).toBe('書きかけの返信');
    // 保護者から届いたので未対応の印が付いている
    expect(document.querySelector('.channel.current')?.textContent).toContain('未対応');
  });

  it('チャット（職員）：保護者が読むと、自分のメッセージの既読の人数が増える', async () => {
    open(`/staff/chat?room=${personalRoom}`, teacher);
    await settled();
    const box = await screen.findByPlaceholderText('メッセージを入力');
    fireEvent.change(box, { target: { value: '承知しました。お大事になさってください。' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    // 書きかけの入力欄も同じ文字を持つため、吹き出しに絞って探す
    const mine = await screen.findByText('承知しました。お大事になさってください。', { selector: '.bubble' });
    const row = mine.closest('.msg')!;
    await waitFor(() => expect(row.querySelector('.read')?.textContent).toBe('既読 0'));

    await api.markRead(guardian, personalRoom);
    await tickRefresh();
    await waitFor(() => expect(row.querySelector('.read')?.textContent).toBe('既読 1'));
  });

  it('チャット（保護者）：園からの返信が、入力中の文字を消さずに表れる', async () => {
    open('/guardian/chat', guardian);
    await settled();
    fireEvent.click(await screen.findByText('担任の先生とのやりとり'));
    const input = await screen.findByRole('textbox', { name: 'メッセージを入力' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ありがとうございま' } });

    const watch = watchLoading();
    await api.send(teacher, personalRoom, '本日の様子を日誌で共有しました。');
    await tickRefresh();
    await waitFor(() => expect(screen.getByText('本日の様子を日誌で共有しました。')).toBeTruthy());
    watch.stop();
    expect(watch.seen()).toBe(false);
    expect((screen.getByRole('textbox', { name: 'メッセージを入力' }) as HTMLInputElement).value).toBe('ありがとうございま');
  });
});
