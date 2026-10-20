// @vitest-environment jsdom
/*
 * サーバからの知らせ（Server-Sent Events）を受けて読み直すこと
 * 典拠：ナレッジ/決定事項.md 2026-10-15「相手の画面への反映は、SSE で即時にする。5秒ごとの読み直しは、
 *      接続が切れたときの保険として残す」、web/仮置き値.md「開いたままの画面の読み直し（自動更新）」、
 *      src/live.ts、server/events.go
 *
 * EventSource は偽物に差し替え、テストから「つながった」「知らせが届いた」「切れた」「断られた」を起こす。
 * 知らせを受けたら待たずに読み直すこと、関係のない知らせでは読み直さないこと、
 * つながっている間は間隔を30秒に延ばし、切れたら5秒に戻すこと、職員のヘッダの表示を確かめる。
 * サーバ側の送り分け（誰に届くか）は server/events_test.go、モックの送り分けは liveMock.test.ts が確かめる。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { useAsync, AUTO_REFRESH_MS } from '../src/hooks';
import {
  startLive, isLiveConnected, liveStatus, onLive, onRoom, onNapClass, LIVE_REFRESH_MS, RECONNECT_MIN_MS,
} from '../src/live';
import type { LiveEvent } from '../src/live';
import LiveIndicator from '../src/components/LiveIndicator';
import type { SessionUser } from '../src/api/types';

/** EventSource の偽物。テストから open・send・drop・fail を呼んで、サーバ側の出来事を起こす */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
    this.closed = true;
  }

  /** つながった */
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  /** 知らせが届いた */
  send(data: LiveEvent) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  /** 通信が切れた。EventSource は自分でつなぎ直そうとする（CONNECTING のまま） */
  drop() {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.(new Event('error'));
  }

  /** 200 以外が返った（401・502 など）。EventSource はあきらめる（CLOSED） */
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
}

const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

let hidden = false;
function setHidden(value: boolean) {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
}

const stops: (() => void)[] = [];
function connect() {
  stops.push(startLive());
  return latest();
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
});
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 応答と描画が落ち着くのを待つ（読み込みの応答は本物の時計で動く） */
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function advance(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await flush();
}

/** 読み込んだ回数を出す。読むたびに中身が変わるため、読み直すと必ず描き直される。refreshMs が null なら間隔の読み直しをしない */
function Probe({ load, live, refreshMs }: {
  load: () => Promise<string>; live: (e: LiveEvent) => boolean; refreshMs: number | null;
}) {
  const { data } = useAsync(load, [], { refreshMs: refreshMs ?? undefined, live });
  return <div data-testid="probe">{data ?? '読み込み中'}</div>;
}

function counter() {
  let n = 0;
  return vi.fn(async () => `${++n}回目`);
}

async function renderProbe(live: (e: LiveEvent) => boolean, refreshMs: number | null = AUTO_REFRESH_MS) {
  const load = counter();
  render(<Probe load={load} live={live} refreshMs={refreshMs} />);
  await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('1回目'));
  return load;
}

describe('知らせを受けて読み直す', () => {
  it('つながったときに1回読み直し、選んだ種類の知らせが届くと待たずに読み直す', async () => {
    const es = connect();
    const load = await renderProbe(onLive('chat', 'diary'));

    // つながるまでの間に起きた変化は知らせが届いていない。取りこぼしに備えて1回読む
    act(() => es.open());
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('2回目'));

    act(() => es.send({ type: 'chat', room_id: 6 }));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('3回目'));
    act(() => es.send({ type: 'diary', diary_id: 7 }));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('4回目'));
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('関係のない種類の知らせでは読み直さない', async () => {
    const es = connect();
    const load = await renderProbe(onLive('handout'));
    act(() => es.open());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    act(() => es.send({ type: 'chat', room_id: 6 }));
    act(() => es.send({ type: 'nap', class_id: 1 }));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('チャンネルの知らせは、開いているチャンネルのものだけで読み直す', async () => {
    const es = connect();
    const load = await renderProbe(onRoom(6));
    act(() => es.open());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    act(() => es.send({ type: 'chat', room_id: 7 }));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);

    act(() => es.send({ type: 'chat', room_id: 6 }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  });

  it('午睡チェックの知らせは、開いているクラスのものだけで読み直す', async () => {
    const es = connect();
    const load = await renderProbe(onNapClass(1), null);
    act(() => es.open());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    act(() => es.send({ type: 'nap', class_id: 2, child_id: 'C013' }));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);

    act(() => es.send({ type: 'nap', class_id: 1, child_id: 'C001' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  });

  it('タブが隠れている間に届いた知らせでは読み直さず、戻ったときに1回読む', async () => {
    const es = connect();
    const load = await renderProbe(onLive('chat'));
    act(() => es.open());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    act(() => setHidden(true));
    act(() => es.send({ type: 'chat', room_id: 6 }));
    await flush();
    // 見ていない画面で読み直すと、チャットでは届いたメッセージが既読になってしまう
    expect(load).toHaveBeenCalledTimes(2);

    act(() => setHidden(false));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('知らせだけで読み直す画面（間隔の読み直しが無い画面）も、隠れている間に届いたぶんを戻ったときに読む', async () => {
    const es = connect();
    const load = await renderProbe(onLive('handout'), null);
    act(() => es.open());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    act(() => setHidden(true));
    act(() => setHidden(false));
    await flush();
    // 隠れている間に何も届いていなければ読まない
    expect(load).toHaveBeenCalledTimes(2);

    act(() => setHidden(true));
    act(() => es.send({ type: 'handout', handout_id: 3 }));
    act(() => setHidden(false));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  });
});

describe('つながっている間と切れている間の読み直しの間隔', () => {
  it('つながっている間は30秒ごと、切れたら5秒ごとに戻り、つなぎ直したら1回読んで30秒に戻る', async () => {
    const es = connect();
    const load = await renderProbe(onLive('chat'));
    act(() => es.open());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(isLiveConnected()).toBe(true);

    // つながっている間は、5秒では読み直さない。30秒で読み直す（保険）
    await advance(AUTO_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(2);
    await advance(LIVE_REFRESH_MS - AUTO_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(3);

    // 切れた。EventSource がつなぎ直すまでの間は、5秒ごとに読み直す
    act(() => es.drop());
    expect(isLiveConnected()).toBe(false);
    await advance(AUTO_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(4);
    await advance(AUTO_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(5);

    // つなぎ直した。切れていた間の変化を拾うため1回読み、また30秒ごとに戻る
    act(() => es.open());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(6));
    await advance(AUTO_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(6);
  });

  it('つないでいなければ（モックなど）、これまでどおり5秒ごとに読み直す', async () => {
    const load = await renderProbe(onLive('chat'));
    expect(FakeEventSource.instances).toHaveLength(0);
    await advance(AUTO_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('接続の扱い', () => {
  it('EventSource があきらめたとき（401・502 など）は、1回読み直させ、待ってからつなぎ直す。待ちは倍々に延ばす', async () => {
    const es = connect();
    const load = await renderProbe(onLive('chat'));
    act(() => es.open());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    // セッションが切られていれば、この読み直しが 401 になり、画面は入口へ戻る（api/procedure.ts の onSessionEnded）
    act(() => es.fail());
    expect(isLiveConnected()).toBe(false);
    expect(es.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(RECONNECT_MIN_MS);
    expect(FakeEventSource.instances).toHaveLength(2);

    latest().fail();
    vi.advanceTimersByTime(RECONNECT_MIN_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(RECONNECT_MIN_MS);
    expect(FakeEventSource.instances).toHaveLength(3);

    latest().open();
    expect(isLiveConnected()).toBe(true);
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // 断られたときに1回、つなぎ直したときに1回読み直した
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThanOrEqual(4));
  });

  it('通信が切れただけのときは、EventSource のつなぎ直しに任せる（新しく作らない）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const es = connect();
    es.open();
    es.drop();
    vi.advanceTimersByTime(RECONNECT_MIN_MS * 10);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(es.closed).toBe(false);
  });

  it('止めると（ログアウト）接続を閉じ、使っていない扱いに戻る', () => {
    const es = connect();
    es.open();
    expect(isLiveConnected()).toBe(true);
    stops.splice(0).forEach((stop) => stop());
    expect(es.closed).toBe(true);
    expect(liveStatus()).toBe('off');
  });

  it('モック（npm run dev:mock・テスト）で動かすときはサーバにつながない', async () => {
    const guardian: SessionUser = {
      account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
      staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
      is_temp_password: false, terms_agreed: true,
    };
    render(
      <MemoryRouter initialEntries={['/guardian']}>
        <SessionProvider initialUser={guardian}>
          <App />
        </SessionProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(document.body.textContent).toContain('共有された記録'), { timeout: 3000 });
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(liveStatus()).toBe('off');
  });
});

describe('職員のヘッダの表示', () => {
  it('つながっている間は「すぐに反映」、切れている間は「自動で読み直しています」と出し、使っていなければ出さない', () => {
    render(<LiveIndicator />);
    expect(screen.queryByRole('status')).toBeNull();

    let es: FakeEventSource | undefined;
    act(() => { es = connect(); });
    expect(screen.getByRole('status').textContent).toBe('自動で読み直しています');
    act(() => es!.open());
    expect(screen.getByRole('status').textContent).toBe('すぐに反映');
    act(() => es!.drop());
    expect(screen.getByRole('status').textContent).toBe('自動で読み直しています');

    act(() => stops.splice(0).forEach((stop) => stop()));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('モックの職員の画面には出さない（サーバにつないでいないため）', async () => {
    const teacher: SessionUser = {
      account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
      staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
      is_temp_password: false, terms_agreed: true,
    };
    render(
      <MemoryRouter initialEntries={['/staff']}>
        <SessionProvider initialUser={teacher}>
          <App />
        </SessionProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(document.body.textContent).toContain('ログアウト'), { timeout: 3000 });
    expect(document.querySelector('.live-indicator')).toBeNull();
  });
});
