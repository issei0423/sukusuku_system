/*
 * 画面が思っている利用者を要求に添え、サーバに食い違いを知らされたら画面へ知らせる（api/http.ts・api/sessionAccount.ts）
 *
 * 同じブラウザのタブは Cookie を共有する。保護者のタブを開いたまま、別のタブでログアウトして職員でログインし直すと、
 * 保護者のタブから送ったメッセージが職員の送信として残り、自分の送信を編集・取消できなくなっていた。
 * サーバ側（server/api_session_account_test.go）は、添えた利用者が Cookie のセッションと違えば 409（account_changed）で止める。
 * ここでは、画面が添えること、409 を受けて知らせること（セッション切れとは扱わないこと）を確かめる。
 * 知らせを受けた App.tsx がいまのアカウントへ切り替える流れは、実際のサーバとブラウザで確かめた（PR に書いた）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { onSessionEnded } from '../src/api/client';
import { onAccountChanged, setSessionAccount, ACCOUNT_HEADER } from '../src/api/sessionAccount';
import type { SessionUser } from '../src/api/types';

const guardian: SessionUser = {
  account_id: 6, email: 'nishida.t@example.jp', role: '3', display_name: '西田 拓也',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const headerOf = (call: unknown[]) => new Headers((call[1] as RequestInit | undefined)?.headers).get(ACCOUNT_HEADER);

afterEach(() => {
  setSessionAccount(null);
  vi.unstubAllGlobals();
});

describe('要求に、画面が思っている利用者を添える', () => {
  it('ログイン中は、読み書きのどちらにも account_id を添える', async () => {
    const http = await import('../src/api/http');
    const fetch = vi.fn(async () => json([]));
    vi.stubGlobal('fetch', fetch);
    setSessionAccount(6);

    await http.api.rooms(guardian);
    await http.api.send(guardian, 4, '明日は祖母がお迎えに伺います').catch(() => {});
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of fetch.mock.calls) expect(headerOf(call)).toBe('6');
  });

  it('ページを開き直したときのセッションの読み直し（bootstrap）は添えない。いまの Cookie の利用者を知るためのもの', async () => {
    const http = await import('../src/api/http');
    const fetch = vi.fn(async () => json({ message: 'ログインしていません' }, 401));
    vi.stubGlobal('fetch', fetch);
    setSessionAccount(6);

    await http.api.bootstrap();
    const me = fetch.mock.calls.find((c) => String(c[0]) === '/api/me')!;
    expect(headerOf(me)).toBeNull();
  });
});

describe('サーバが食い違いを知らせたら（409 account_changed）', () => {
  it('画面へ知らせ、送ろうとした操作は失敗として返す。セッションが切れたとは扱わない', async () => {
    const http = await import('../src/api/http');
    vi.stubGlobal('fetch', vi.fn(async () => json({
      kind: 'account_changed', message: '別のタブで、別のアカウントにログインし直されています。この操作は行いませんでした。',
    }, 409)));
    setSessionAccount(6);
    const changed = vi.fn();
    const ended = vi.fn();
    const stopChanged = onAccountChanged(changed);
    const stopEnded = onSessionEnded(ended);

    await expect(http.api.send(guardian, 4, '明日は祖母がお迎えに伺います'))
      .rejects.toThrow('別のタブで、別のアカウントにログインし直されています');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
    stopChanged();
    stopEnded();
  });
});
